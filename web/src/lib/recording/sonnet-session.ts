/**
 * Server-side Sonnet multi-turn extraction WebSocket client.
 *
 * Mirrors the iOS `ServerWebSocketService` surface — same message shapes,
 * same lifecycle: connect on session start, stream final Deepgram
 * transcripts in, receive structured `extraction` results, `question`
 * prompts, `voice_command_response` payloads, and `cost_update` snapshots
 * back out. Auth is JWT via the `?token=` query param because browsers
 * cannot set Authorization headers during the HTTP→WS upgrade (iOS
 * Safari strips them too — see rules/mistakes.md).
 *
 * Server protocol: src/extraction/sonnet-stream.js
 *   - inbound from client: session_start, transcript, job_state_update,
 *     correction, session_pause, session_resume, session_stop
 *   - outbound to client:  session_ack, extraction, question,
 *     voice_command_response, cost_update, error
 */

import { api } from '../api-client';
import { getToken } from '../auth';

export type SonnetConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ExtractedReading {
  circuit: number;
  field: string;
  value: string | number | boolean;
  unit?: string | null;
  confidence?: number;
}

export interface FieldClear {
  circuit: number;
  field: string;
}

export interface CircuitUpdate {
  circuit: number;
  designation: string;
  action: 'create' | 'rename';
}

export interface Observation {
  code?: string;
  observation_text: string;
  item_location?: string | null;
  schedule_item?: string | null;
  regulation?: string | null;
}

export interface ValidationAlert {
  type: string;
  severity: 'warning' | 'error' | 'info';
  message: string;
  suggested_action?: string | null;
  field?: string | null;
  circuit?: number | null;
}

export interface Confirmation {
  text: string;
  field?: string | null;
  circuit?: number | null;
  value?: string | number | boolean;
}

/** Shape of the `result` payload on `type: 'extraction'` messages. Note
 *  the server renames `extracted_readings` → `readings` before sending. */
export interface ExtractionResult {
  readings: ExtractedReading[];
  field_clears?: FieldClear[];
  circuit_updates?: CircuitUpdate[];
  observations?: Observation[];
  validation_alerts?: ValidationAlert[];
  confirmations?: Confirmation[];
  extraction_failed?: boolean;
  error_message?: string;
}

/** Sonnet-generated question, gated server-side through QuestionGate.
 *  `question_type` is the renamed `type` field (unclear/orphaned/out_of_range). */
export interface SonnetQuestion {
  question_type?: 'unclear' | 'orphaned' | 'out_of_range' | string;
  question: string;
  context?: string;
  field?: string | null;
  circuit?: number | null;
}

export interface VoiceCommandResponse {
  understood: boolean;
  spoken_response: string;
  action: { type?: string; [k: string]: unknown } | null;
}

export interface CostUpdate {
  type: 'cost_update';
  totalJobCost: number;
  sonnet?: {
    turns?: number;
    cacheReads?: number;
    cacheWrites?: number;
    input?: number;
    output?: number;
  };
  [key: string]: unknown;
}

export interface SonnetSessionCallbacks {
  onStateChange?: (state: SonnetConnectionState) => void;
  onSessionAck?: (status: string) => void;
  onExtraction?: (result: ExtractionResult) => void;
  onQuestion?: (q: SonnetQuestion) => void;
  onVoiceCommandResponse?: (payload: VoiceCommandResponse) => void;
  onCostUpdate?: (update: CostUpdate) => void;
  onError?: (err: Error, recoverable: boolean) => void;
}

export interface SessionStartOptions {
  sessionId: string;
  jobId: string;
  /** Snapshot of the current JobDetail — certificateType + any pre-filled
   *  fields. Sent so Sonnet has pre-populated CCU/manual data as context. */
  jobState?: unknown;
}

export class SonnetSession {
  private ws: WebSocket | null = null;
  private state: SonnetConnectionState = 'disconnected';
  private callbacks: SonnetSessionCallbacks;
  private startOptions: SessionStartOptions | null = null;
  // Transcripts that arrive before the socket finishes opening are queued
  // and flushed on `onopen` — otherwise the user loses anything said in
  // the first ~200ms while the WS handshakes.
  private preConnectQueue: string[] = [];

  constructor(callbacks: SonnetSessionCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get connectionState(): SonnetConnectionState {
    return this.state;
  }

  /** Open the WebSocket and send `session_start`. Safe to call once per
   *  recording session — callers should `disconnect()` before reopening. */
  connect(options: SessionStartOptions): void {
    if (this.ws && this.state !== 'disconnected') return;
    this.startOptions = options;
    this.setState('connecting');

    const token = getToken();
    if (!token) {
      this.setState('error');
      this.callbacks.onError?.(new Error('Not authenticated — no token available'), false);
      return;
    }

    const url = this.buildURL(token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setState('error');
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)), false);
      return;
    }

    ws.onopen = () => {
      this.setState('connected');
      // Fire session_start as soon as the socket is open. Server buffers
      // any transcript that arrives before it to match iOS parity.
      this.sendRaw({
        type: 'session_start',
        sessionId: options.sessionId,
        jobId: options.jobId,
        jobState: options.jobState,
      });
      // Flush anything queued while connecting.
      if (this.preConnectQueue.length > 0) {
        for (const text of this.preConnectQueue) {
          this.sendRaw({ type: 'transcript', text });
        }
        this.preConnectQueue = [];
      }
    };

    ws.onmessage = (event) => this.handleMessage(event.data);

    ws.onerror = () => {
      this.setState('error');
      this.callbacks.onError?.(new Error('Sonnet WebSocket error'), true);
    };

    ws.onclose = (event) => {
      this.ws = null;
      if (this.state !== 'error') this.setState('disconnected');
      // 1000 = normal, 1005 = no-status. Anything else is worth surfacing
      // so the caller can decide whether to reconnect.
      if (event.code !== 1000 && event.code !== 1005) {
        this.callbacks.onError?.(new Error(`Sonnet WS closed (code=${event.code})`), true);
      }
    };

    this.ws = ws;
  }

  /** Feed a final Deepgram transcript into the Sonnet session. No-op if
   *  the text is empty. Messages sent before `onopen` are queued. */
  sendTranscript(text: string, options?: { confirmationsEnabled?: boolean }): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    if (!this.ws || this.state === 'connecting') {
      this.preConnectQueue.push(trimmed);
      return;
    }
    if (this.state !== 'connected') return;
    this.sendRaw({
      type: 'transcript',
      text: trimmed,
      confirmations_enabled: options?.confirmationsEnabled ?? false,
    });
  }

  /** Manual field correction — sent as a pseudo-transcript so Sonnet can
   *  update conversation state consistently. */
  sendCorrection(field: string, circuit: number, value: string | number | boolean): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'correction', field, circuit, value });
  }

  /** Push the latest JobDetail snapshot to Sonnet mid-session. Used when
   *  the user types a field manually while recording — Sonnet then knows
   *  not to overwrite it. */
  sendJobStateUpdate(jobState: unknown): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'job_state_update', jobState });
  }

  /** Tell the server to pause billing + conversation turns. Matches the
   *  iOS doze/sleep entry hook (RecordingSessionCoordinator). */
  pause(): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'session_pause' });
  }

  /** Inverse of pause() — re-enable extraction billing after wake. */
  resume(): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'session_resume' });
  }

  /** Graceful shutdown: send session_stop, let the server flush any
   *  buffered utterances, then close the socket. */
  disconnect(): void {
    const ws = this.ws;
    if (!ws) {
      this.setState('disconnected');
      return;
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendRaw({ type: 'session_stop' });
      }
    } catch {
      // ignore
    }
    // 300ms grace so the server can flush pending extractions + the
    // final session_ack before we yank the socket. Matches the
    // Deepgram teardown pattern in deepgram-service.ts.
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

  private setState(next: SonnetConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private buildURL(token: string): string {
    // Derive ws(s) scheme from the HTTP API base. Dev defaults to
    // http://localhost:3000 → ws://localhost:3000/api/sonnet-stream.
    const base = api.baseUrl;
    const wsBase = base.replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`);
    const params = new URLSearchParams({ token });
    return `${wsBase}/api/sonnet-stream?${params.toString()}`;
  }

  private sendRaw(obj: Record<string, unknown>): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)), true);
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
      case 'session_ack': {
        const status = (json.status as string) ?? 'unknown';
        this.callbacks.onSessionAck?.(status);
        break;
      }
      case 'extraction': {
        const result = json.result as ExtractionResult | undefined;
        if (result) {
          // Normalise — server sometimes omits these when empty.
          const normalised: ExtractionResult = {
            readings: Array.isArray(result.readings) ? result.readings : [],
            field_clears: Array.isArray(result.field_clears) ? result.field_clears : [],
            circuit_updates: Array.isArray(result.circuit_updates) ? result.circuit_updates : [],
            observations: Array.isArray(result.observations) ? result.observations : [],
            validation_alerts: Array.isArray(result.validation_alerts)
              ? result.validation_alerts
              : [],
            confirmations: Array.isArray(result.confirmations) ? result.confirmations : [],
            extraction_failed: result.extraction_failed,
            error_message: result.error_message,
          };
          this.callbacks.onExtraction?.(normalised);
        }
        break;
      }
      case 'question': {
        // The server renames Sonnet's `type` → `question_type` before
        // sending so we don't clobber the WS message type. Everything
        // else (question, field, circuit, context) is already flat.
        const { type: _t, ...rest } = json;
        void _t;
        this.callbacks.onQuestion?.(rest as unknown as SonnetQuestion);
        break;
      }
      case 'voice_command_response': {
        this.callbacks.onVoiceCommandResponse?.({
          understood: Boolean(json.understood),
          spoken_response: (json.spoken_response as string) ?? '',
          action: (json.action as VoiceCommandResponse['action']) ?? null,
        });
        break;
      }
      case 'cost_update': {
        this.callbacks.onCostUpdate?.(json as unknown as CostUpdate);
        break;
      }
      case 'error': {
        const msg = (json.message as string) ?? 'Unknown server error';
        const recoverable = Boolean(json.recoverable);
        this.callbacks.onError?.(new Error(msg), recoverable);
        break;
      }
      default:
      // session_summary / unknown — ignored for Phase 4d.
    }
  }
}
