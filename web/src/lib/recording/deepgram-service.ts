/**
 * Direct-to-Deepgram Nova-3 WebSocket client.
 *
 * Mirrors the iOS `DeepgramService.swift` protocol so the two clients
 * behave identically — same URL parameters (nova-3 / linear16 / 16kHz /
 * en-GB / interim_results / endpointing=300 / utterance_end_ms=2000 /
 * vad_events=true) and the same subprotocol auth (`['token', apiKey]`).
 *
 * Pause/resume + auto-reconnect are deferred to Phase 4e where the
 * SleepDetector lands — until then this service offers the minimum
 * viable surface needed to deliver interim + final transcripts to the
 * RecordingContext: `connect`, `sendSamples`, `disconnect`.
 *
 * Apart from the different runtime, the URL and message shapes are
 * identical to transcript-standalone — keep in sync if Deepgram params
 * change there.
 */

export type DeepgramConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

export interface DeepgramCallbacks {
  onInterimTranscript: (text: string, confidence: number) => void;
  onFinalTranscript: (text: string, confidence: number, words: DeepgramWord[]) => void;
  onUtteranceEnd?: () => void;
  onSpeechStarted?: () => void;
  onStateChange?: (state: DeepgramConnectionState) => void;
  onError?: (err: Error) => void;
}

export class DeepgramService {
  private ws: WebSocket | null = null;
  private state: DeepgramConnectionState = 'disconnected';
  private callbacks: DeepgramCallbacks;
  private sourceSampleRate = 16000;
  // Tracked so the KeepAlive loop only fires during extended silence.
  private lastAudioSendMs = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  // Phase 4e — when paused, `sendSamples` silently drops incoming audio
  // but the WS stays open via the KeepAlive loop. Lets the SleepManager
  // re-wake in <100ms without a full reconnect.
  private paused = false;
  // WebSocket fires BOTH `onerror` and `onclose` for most failure modes
  // (spec says either can fire standalone but Chrome/Safari currently
  // fire both). Without a guard the upstream recording-context would
  // see two `onError` callbacks for a single close and trigger two
  // reconnects — doubling Deepgram connect-storm billing on flaky links.
  // This flag is reset every `connect()`.
  private errorEmitted = false;

  constructor(callbacks: DeepgramCallbacks) {
    this.callbacks = callbacks;
  }

  get connectionState(): DeepgramConnectionState {
    return this.state;
  }

  /**
   * Open a fresh WebSocket. Does not auto-reconnect — callers should
   * reopen on close themselves (Phase 4e SleepDetector handles this).
   */
  connect(apiKey: string, sourceSampleRate = 16000): void {
    if (this.ws && this.state !== 'disconnected') {
      // Already connecting/connected — caller mis-wired. No-op.
      return;
    }
    this.sourceSampleRate = sourceSampleRate;
    this.errorEmitted = false;
    this.setState('connecting');

    const url = this.buildURL();
    // Deepgram accepts subprotocol token auth; URL query params are blocked
    // on iOS Safari during the HTTP→WS upgrade (rules/mistakes.md). The
    // ['token', apiKey] two-element array is the format Deepgram expects
    // — a single "token, key" string (comma-space) is rejected by newer
    // Deepgram validation.
    const ws = new WebSocket(url, ['token', apiKey]);
    ws.binaryType = 'arraybuffer';

    const emitError = (err: Error) => {
      if (this.errorEmitted) return;
      this.errorEmitted = true;
      this.callbacks.onError?.(err);
    };

    ws.onopen = () => {
      this.setState('connected');
      this.startKeepAlive();
    };

    ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      this.setState('error');
      emitError(new Error('Deepgram WebSocket error'));
    };

    ws.onclose = (event) => {
      this.stopKeepAlive();
      this.ws = null;
      if (this.state !== 'error') {
        this.setState('disconnected');
      }
      if (event.code !== 1000 && event.code !== 1005) {
        emitError(new Error(`Deepgram WS closed (code=${event.code})`));
      }
    };

    this.ws = ws;
  }

  /** Send a Float32Array block (mic samples). Resamples to 16kHz if needed
   *  and converts to Int16 PCM before framing. No-op if not connected or
   *  if the service has been paused by the SleepManager. */
  sendSamples(samples: Float32Array): void {
    if (this.paused) return;
    if (!this.ws || this.state !== 'connected' || samples.length === 0) return;

    const resampled = this.sourceSampleRate === 16000 ? samples : this.resampleTo16k(samples);

    const int16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const clamped = Math.max(-1, Math.min(1, resampled[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.lastAudioSendMs = performance.now();

    try {
      this.ws.send(int16.buffer);
    } catch {
      // WS buffer full — drop the block. Rare; surfaces as minor gap.
    }
  }

  /** Drop a pre-recorded Int16 PCM block straight into the WS. Used by
   *  the SleepManager to replay the 3-second AudioRingBuffer on wake so
   *  Deepgram can transcribe the words spoken _just before_ VAD fired. */
  sendInt16PCM(samples: Int16Array): void {
    if (!this.ws || this.state !== 'connected' || samples.length === 0) return;
    this.lastAudioSendMs = performance.now();
    try {
      // Copy into a fresh ArrayBuffer so we send only the valid range
      // (the caller may hand us a subarray view).
      const copy = new Int16Array(samples.length);
      copy.set(samples);
      this.ws.send(copy.buffer);
    } catch {
      // Rare: WS backpressure. Drop the replay; live audio will follow.
    }
  }

  /** Freeze live sample forwarding without closing the socket. The
   *  KeepAlive loop continues so the Deepgram session stays alive;
   *  calling `resume()` un-freezes with negligible latency. Pair with
   *  `AudioRingBuffer.writeFloat32()` during pause so `sendInt16PCM()`
   *  on resume can catch Deepgram up to the wake moment. */
  pause(): void {
    this.paused = true;
  }

  /** Inverse of `pause()`. Optionally drain a caller-supplied replay
   *  buffer (typically the 3-second AudioRingBuffer) before live
   *  samples resume flowing — matches the iOS wake path. */
  resume(replay?: Int16Array): void {
    this.paused = false;
    if (replay && replay.length > 0) {
      this.sendInt16PCM(replay);
    }
  }

  /** Request a graceful stream close + tear the socket down. */
  disconnect(): void {
    this.stopKeepAlive();
    this.paused = false;
    const ws = this.ws;
    if (!ws) {
      this.setState('disconnected');
      return;
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      // ignore
    }
    // Give Deepgram ~300ms to flush any outstanding finals before we yank
    // the socket — matches iOS behaviour.
    setTimeout(() => {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      this.ws = null;
      this.setState('disconnected');
    }, 300);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setState(next: DeepgramConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private buildURL(): string {
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      numerals: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      language: 'en-GB',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '2000',
      vad_events: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  private resampleTo16k(samples: Float32Array): Float32Array {
    const ratio = this.sourceSampleRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
    }
    return out;
  }

  /** Keep Deepgram's idle timeout from closing the stream during silence
   *  (default is 10s). Send KeepAlive JSON + 500ms of silent PCM every 10s
   *  when no real audio has been sent in the last 8s. Matches iOS. */
  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || this.state !== 'connected') return;
      const idleMs = this.lastAudioSendMs ? performance.now() - this.lastAudioSendMs : Infinity;
      if (idleMs < 8000) return;
      try {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        this.ws.send(new Int16Array(8000).buffer); // 500ms silence @16k
      } catch {
        // ignore
      }
    }, 10000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleMessage(data: unknown): void {
    let json: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = json.type as string | undefined;
    switch (type) {
      case 'Results': {
        const channel = json.channel as Record<string, unknown> | undefined;
        const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
        const first = alternatives?.[0];
        if (!first) return;
        const transcript = (first.transcript as string | undefined) ?? '';
        if (!transcript) return;
        const confidence = (first.confidence as number | undefined) ?? 0;
        const isFinal = (json.is_final as boolean | undefined) ?? false;

        const words: DeepgramWord[] = [];
        const rawWords = first.words as Array<Record<string, unknown>> | undefined;
        if (rawWords) {
          for (const w of rawWords) {
            if (
              typeof w.word === 'string' &&
              typeof w.start === 'number' &&
              typeof w.end === 'number' &&
              typeof w.confidence === 'number'
            ) {
              words.push({
                word: w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
                punctuated_word: w.punctuated_word as string | undefined,
              });
            }
          }
        }

        if (isFinal) {
          this.callbacks.onFinalTranscript(transcript, confidence, words);
        } else {
          this.callbacks.onInterimTranscript(transcript, confidence);
        }
        break;
      }
      case 'SpeechStarted':
        this.callbacks.onSpeechStarted?.();
        break;
      case 'UtteranceEnd':
        this.callbacks.onUtteranceEnd?.();
        break;
      case 'Error': {
        const msg = (json.message as string | undefined) ?? 'Unknown Deepgram error';
        this.callbacks.onError?.(new Error(msg));
        break;
      }
      default:
      // Metadata + other housekeeping — ignored.
    }
  }
}
