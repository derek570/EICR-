/**
 * Microphone capture helper — opens an AudioContext + AudioWorklet and
 * streams raw Float32Array samples from the mic to callbacks on the
 * main thread.
 *
 * Used by `RecordingProvider` to drive the VU meter (Phase 4b) and the
 * Deepgram Nova-3 WebSocket (Phase 4c) + SleepDetector VAD (Phase 4e).
 *
 * Usage:
 *   const handle = await startMicCapture({ onSamples, onLevel });
 *   // …later
 *   handle.stop();
 *
 * Design notes:
 *   - Requests a 16kHz mono stream with echo cancellation + noise
 *     suppression (Deepgram's preferred input for Nova-3).
 *   - Uses `{ ideal: 16000 }` not a bare `16000` — iOS Safari throws
 *     OverconstrainedError on bare values.
 *   - Falls back to `ScriptProcessorNode` on browsers where
 *     `AudioWorklet.addModule` throws (older Edge, some corporate VPN
 *     browsers). The worklet path is preferred because it runs on the
 *     audio thread and survives main-thread jank.
 *   - Level is computed as RMS over each 128-sample block, smoothed
 *     with a 0.3 EMA so the VU meter doesn't flicker at high
 *     frequencies.
 *   - Caller owns stopping the handle. `stop()` is idempotent.
 */

export type MicCaptureHandle = {
  readonly sampleRate: number;
  stop: () => void;
};

export type MicCaptureOptions = {
  /** Called with every Float32Array block from the mic (typically 128 samples
   *  at 16kHz → ~8ms). Implementations should transfer / copy quickly; the
   *  underlying buffer is reused by the caller. */
  onSamples?: (samples: Float32Array) => void;
  /** Called ~60Hz with the current RMS level in [0, 1]. Safe to drive React
   *  state with this directly — level is already smoothed. */
  onLevel?: (level: number) => void;
  /** Called if the mic stream ends unexpectedly (user revoked permission,
   *  device unplugged, OS-level mute). */
  onError?: (err: Error) => void;
};

const WORKLET_URL = '/audio-worklet-processor.js';

export async function startMicCapture(opts: MicCaptureOptions): Promise<MicCaptureHandle> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not supported in this environment');
  }

  // 1. Request mic — use `ideal` per iOS Safari guidance in rules/mistakes.md.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: { ideal: 16000 },
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // 2. Build the audio graph.
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioCtx({ sampleRate: 16000 });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  const source = audioContext.createMediaStreamSource(stream);

  // 3. Try AudioWorklet; fall back to ScriptProcessor on failure.
  let workletNode: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;

  try {
    await audioContext.audioWorklet.addModule(WORKLET_URL);
    workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
    source.connect(workletNode);
  } catch {
    // Deprecated but broadly supported — sizes of 4096 at 16kHz ≈ 256ms.
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(scriptNode);
    // ScriptProcessorNode requires its output connected to destination to run.
    scriptNode.connect(audioContext.destination);
  }

  // 4. Level smoothing state. 0.3 EMA chosen empirically — low enough that
  //    attacks feel immediate but consecutive silent blocks decay in <200ms.
  let smoothedLevel = 0;
  const EMA = 0.3;

  const handleSamples = (samples: Float32Array) => {
    if (samples.length === 0) return;
    // RMS over the block.
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / samples.length);
    // Map 0…0.3 RMS → 0…1 with a mild curve so speech sits around 0.5-0.8.
    const mapped = Math.min(1, Math.pow(rms / 0.3, 0.7));
    smoothedLevel = smoothedLevel + (mapped - smoothedLevel) * EMA;
    opts.onLevel?.(smoothedLevel);
    opts.onSamples?.(samples);
  };

  if (workletNode) {
    workletNode.port.onmessage = (event: MessageEvent) => {
      const samples = (event.data as { samples: Float32Array }).samples;
      if (samples) handleSamples(samples);
    };
  } else if (scriptNode) {
    scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
      // Copy — the underlying AudioBuffer is aliased to a renderer-owned
      // region and mutates between callbacks.
      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      handleSamples(samples);
    };
  }

  // 5. Watch for the track ending (user revoked permission).
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      opts.onError?.(new Error('Microphone track ended'));
    });
  }

  const sampleRate = audioContext.sampleRate;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
  };

  return { sampleRate, stop };
}
