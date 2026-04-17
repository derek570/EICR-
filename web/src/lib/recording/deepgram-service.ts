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
    this.setState('connecting');

    const url = this.buildURL();
    // Deepgram accepts subprotocol token auth; URL query params are blocked
    // on iOS Safari during the HTTP→WS upgrade (rules/mistakes.md).
    const ws = new WebSocket(url, ['token', apiKey]);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.setState('connected');
      this.startKeepAlive();
    };

    ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      this.setState('error');
      this.callbacks.onError?.(new Error('Deepgram WebSocket error'));
    };

    ws.onclose = (event) => {
      this.stopKeepAlive();
      this.ws = null;
      if (this.state !== 'error') {
        this.setState('disconnected');
      }
      if (event.code !== 1000 && event.code !== 1005) {
        this.callbacks.onError?.(new Error(`Deepgram WS closed (code=${event.code})`));
      }
    };

    this.ws = ws;
  }

  /** Send a Float32Array block (mic samples). Resamples to 16kHz if needed
   *  and converts to Int16 PCM before framing. No-op if not connected. */
  sendSamples(samples: Float32Array): void {
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

  /** Request a graceful stream close + tear the socket down. */
  disconnect(): void {
    this.stopKeepAlive();
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
