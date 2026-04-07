/**
 * AudioCapture — Web Audio API microphone capture
 *
 * Captures audio from getUserMedia, resamples to 16kHz mono Int16 PCM,
 * and delivers audio chunks to a callback for streaming to Deepgram.
 *
 * Uses AudioWorklet for low-latency processing when available,
 * falls back to ScriptProcessorNode.
 */

export interface AudioCaptureDelegate {
  onAudioData(pcmInt16: Int16Array): void;
  onError(error: Error): void;
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private delegate: AudioCaptureDelegate;
  private _isCapturing = false;

  constructor(delegate: AudioCaptureDelegate) {
    this.delegate = delegate;
  }

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  async start(): Promise<void> {
    if (this._isCapturing) return;

    try {
      // Request microphone with 16kHz preferred (browser may give different rate)
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      // On iOS Safari and mobile Chrome, AudioContext starts suspended even from a user gesture
      // when it flows through an async chain. Resume it explicitly so the AudioWorklet fires.
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

      // If the browser gave us a different sample rate, we need to resample
      const actualSampleRate = this.audioContext.sampleRate;

      try {
        // Try AudioWorklet first (lower latency)
        await this.setupWorklet(actualSampleRate);
      } catch {
        // Fall back to ScriptProcessorNode
        this.setupScriptProcessor(actualSampleRate);
      }

      this._isCapturing = true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.delegate.onError(err);
      // Re-throw so that `await ac.start()` rejects and callers don't enter recording state
      throw err;
    }
  }

  stop(): void {
    this._isCapturing = false;

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  private async setupWorklet(sourceSampleRate: number): Promise<void> {
    if (!this.audioContext || !this.sourceNode) return;

    // Create inline worklet processor
    const processorCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffer = [];
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const samples = input[0];
          // Convert Float32 to Int16
          const int16 = new Int16Array(samples.length);
          for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          this.port.postMessage(int16.buffer, [int16.buffer]);
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;

    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    await this.audioContext.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (!this._isCapturing) return;
      const int16 = new Int16Array(event.data);

      // Resample if needed
      if (sourceSampleRate !== 16000) {
        const resampled = this.resample(int16, sourceSampleRate, 16000);
        this.delegate.onAudioData(resampled);
      } else {
        this.delegate.onAudioData(int16);
      }
    };

    this.sourceNode.connect(this.workletNode);
    // Do NOT connect to destination — that would play captured audio through speakers (echo)
  }

  private setupScriptProcessor(sourceSampleRate: number): void {
    if (!this.audioContext || !this.sourceNode) return;

    const bufferSize = 4096;
    // eslint-disable-next-line deprecation/deprecation
    this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this._isCapturing) return;
      const inputData = event.inputBuffer.getChannelData(0);

      // Convert Float32 to Int16
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Resample if needed
      if (sourceSampleRate !== 16000) {
        const resampled = this.resample(int16, sourceSampleRate, 16000);
        this.delegate.onAudioData(resampled);
      } else {
        this.delegate.onAudioData(int16);
      }
    };

    this.sourceNode.connect(this.scriptNode);
    // Do NOT connect to destination — that would play captured audio through speakers (echo)
  }

  private resample(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, samples.length - 1);
      const frac = srcIndex - low;
      result[i] = Math.round(samples[low] * (1 - frac) + samples[high] * frac);
    }

    return result;
  }
}
