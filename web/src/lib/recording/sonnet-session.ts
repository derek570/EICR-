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
  /**
   * Fires on every `session_ack` frame. The optional `sessionId` is the
   * server-minted identifier that the client must echo back inside a
   * `session_resume` frame on a subsequent reconnect attempt so the
   * backend can rehydrate the multi-turn Sonnet context. `status` is
   * `'new'` for a freshly-allocated session or `'resumed'` for a
   * successful rehydrate of a prior session within the TTL window.
   */
  onSessionAck?: (status: string, sessionId?: string) => void;
  onExtraction?: (result: ExtractionResult) => void;
  onQuestion?: (q: SonnetQuestion) => void;
  onVoiceCommandResponse?: (payload: VoiceCommandResponse) => void;
  onCostUpdate?: (update: CostUpdate) => void;
  onError?: (err: Error, recoverable: boolean) => void;
}

/**
 * Injectable plumbing for the reconnect state machine. Production wires
 * the defaults (global `setTimeout`/`clearTimeout`); tests supply a
 * controllable scheduler so the reconnect tick fires at a known point
 * rather than depending on CI wallclock drift. The handle type is opaque
 * — whatever the scheduler returns is what gets passed back to
 * `clearScheduler`, mirroring the `setTimeout`/`clearTimeout` contract.
 */
export interface SonnetSessionDeps {
  scheduler?: (cb: () => void, ms: number) => unknown;
  clearScheduler?: (handle: unknown) => void;
}

export interface SessionStartOptions {
  sessionId: string;
  jobId: string;
  /**
   * Explicit certificate type for this session. Must match the job's
   * `certificate_type` — Sonnet routes against a different extraction
   * schema per type, so an EIC job sent as EICR silently drops the
   * design-section readings and writes them into the wrong fields.
   * Passed explicitly (not only inside `jobState`) so the server can
   * validate + branch before it unpacks the snapshot.
   */
  certificateType: 'EICR' | 'EIC';
  /** Snapshot of the current JobDetail — certificateType + any pre-filled
   *  fields. Sent so Sonnet has pre-populated CCU/manual data as context. */
  jobState?: unknown;
}

/**
 * Feature-flag resolver for the reconnect state machine.
 *
 * Default: OFF. Production will flip this post-backend-deploy by setting
 * `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true` in the web service's
 * runtime env. Tests can also set `globalThis.__RECONNECT_FLAG = true`
 * without touching the env — avoids module-evaluation-order races when
 * vitest imports this module before a test-local env rewrite runs.
 *
 * Exported so Commit A (unused today) and Commit B (consumer) stay in
 * the same file without the grep-hostile `process.env.NEXT_PUBLIC_…`
 * string inline at the call site.
 */
export function isReconnectEnabled(): boolean {
  // Test hook — wins over the env so suites can toggle per-test.
  const hook = (globalThis as unknown as { __RECONNECT_FLAG?: unknown }).__RECONNECT_FLAG;
  if (typeof hook === 'boolean') return hook;
  // Env (read at call time so vitest's beforeEach env mutation takes effect).
  const raw = process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
  return raw === 'true' || raw === '1';
}

/** Base backoff delay in ms — first reconnect attempt waits ~500ms. */
const RECONNECT_BASE_MS = 500;
/** Hard cap in ms — later attempts plateau here rather than growing unbounded. */
const RECONNECT_CAP_MS = 10_000;
/** Max attempts before we fire a terminal error and stop. */
const RECONNECT_MAX_ATTEMPTS = 5;

export class SonnetSession {
  private ws: WebSocket | null = null;
  private state: SonnetConnectionState = 'disconnected';
  private callbacks: SonnetSessionCallbacks;
  private startOptions: SessionStartOptions | null = null;
  // Transcripts that arrive before the socket finishes opening are queued
  // and flushed on `onopen` — otherwise the user loses anything said in
  // the first ~200ms while the WS handshakes.
  private preConnectQueue: string[] = [];
  // Server-minted session identifier from the most recent `session_ack`.
  // Unused on the first open (the server allocates it); on reconnect the
  // state machine echoes it back inside a `session_resume` frame so the
  // backend can rehydrate multi-turn context within the 5-minute TTL
  // window. Read-only externally for diagnostic purposes.
  private sessionId: string | null = null;
  // Tracks whether the most recent session_ack status was 'new' or
  // 'resumed'. Useful for surfacing "lost context" warnings on reconnect
  // when the server's TTL has expired (status flips from 'resumed' back
  // to 'new' mid-session).
  private sessionStatus: 'new' | 'resumed' | null = null;
  // Reconnect state machine fields — only consulted when the feature
  // flag is ON. Kept always-allocated to avoid a branch at every close.
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  // Injectable scheduler — defaults to global setTimeout/clearTimeout
  // in production. Tests inject a controllable scheduler so the reconnect
  // tick fires at a deterministic point (see SonnetSessionDeps).
  private schedule: (cb: () => void, ms: number) => unknown;
  private clearSchedule: (handle: unknown) => void;
  // Flipped to false by explicit disconnect() so an in-flight reconnect
  // timer knows to abort without opening a doomed-to-close socket.
  private shouldReconnect = true;
  // True after the first successful open of this SonnetSession instance.
  // Gates whether we send `session_start` (first open) or `session_resume`
  // (reconnect) on the new socket's onopen.
  private hasConnectedOnce = false;

  constructor(callbacks: SonnetSessionCallbacks = {}, deps: SonnetSessionDeps = {}) {
    this.callbacks = callbacks;
    this.schedule = deps.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearSchedule =
      deps.clearScheduler ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Compute a backoff delay for `attempt` (1-based) using
   * exponential-with-full-jitter, capped at `RECONNECT_CAP_MS`:
   *
   *     cap(base * 2^(attempt-1)) * rand()
   *
   * Static + rand() injectable so tests can assert the jitter never
   * produces a negative value without driving the full WS harness.
   */
  static computeBackoffDelay(attempt: number, rand: () => number = Math.random): number {
    const exp = RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(exp, RECONNECT_CAP_MS);
    // Full-jitter: sample in [0, capped]. This is the AWS "Exponential
    // Backoff And Jitter" recommendation — strictly non-negative, and
    // the max never exceeds the cap.
    return Math.max(0, Math.floor(capped * rand()));
  }

  get connectionState(): SonnetConnectionState {
    return this.state;
  }

  /** Open the WebSocket and send `session_start`. Safe to call once per
   *  recording session — callers should `disconnect()` before reopening.
   *  When the reconnect feature flag is ON, this method also seeds the
   *  reconnect state machine; dirty closes will schedule a re-open via
   *  `scheduleReconnect()` until the attempts ceiling is hit. */
  connect(options: SessionStartOptions): void {
    if (this.ws && this.state !== 'disconnected') return;
    this.startOptions = options;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.hasConnectedOnce = false;
    this.openSocket();
  }

  /**
   * Internal socket-open — used both by `connect()` (first open) and by
   * the reconnect state machine (subsequent opens). Handles token fetch,
   * URL build, and wires the four WS lifecycle handlers.
   *
   * Split out so the reconnect loop can re-invoke the same plumbing
   * without re-entering the public `connect()` (which resets counters
   * and the shouldReconnect latch).
   */
  private openSocket(): void {
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
      // Clean open — reset the attempt counter so future dirty-close
      // cycles get a fresh exponential ramp from attempt 1.
      this.reconnectAttempts = 0;

      // Reconnect branch: if this is NOT the first successful open on
      // this SonnetSession instance AND we captured a server-minted
      // `sessionId` from a prior `session_ack`, echo the id back inside
      // a `session_resume` frame BEFORE any other traffic. The backend
      // uses that frame to rehydrate the multi-turn Sonnet conversation
      // state within its 5-minute TTL window. Falls back to a fresh
      // `session_start` when we have no id (legacy backend that didn't
      // advertise one) — the server treats that exactly like a new
      // session, which is the pre-4c.5 behaviour.
      const isReconnect = this.hasConnectedOnce && this.sessionId != null;
      if (isReconnect) {
        this.sendRaw({ type: 'session_resume', sessionId: this.sessionId });
      } else {
        const options = this.startOptions;
        if (options) {
          this.sendRaw({
            type: 'session_start',
            sessionId: options.sessionId,
            jobId: options.jobId,
            certificateType: options.certificateType,
            jobState: options.jobState,
          });
        }
      }

      this.hasConnectedOnce = true;

      // Flush anything queued while connecting. On reconnect this also
      // drains anything the user said while the socket was down.
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

      const isClean = event.code === 1000 || event.code === 1005 || !this.shouldReconnect;
      const reconnectEnabled = isReconnectEnabled();
      const willReconnect =
        reconnectEnabled && !isClean && this.reconnectAttempts < RECONNECT_MAX_ATTEMPTS;

      // Close-code log — matches `deepgram-service.ts` format for
      // cross-stream grepping in ops tooling (see WAVE_3F_HANDOFF.md).
      // `attempt` is the attempt number that JUST failed (0 for the
      // initial open, 1..N for each reconnect cycle).
      console.info(
        `[sonnet] close code=${event.code} reason=${JSON.stringify(event.reason ?? '')} reconnect=${willReconnect} attempt=${this.reconnectAttempts}`
      );

      if (!reconnectEnabled) {
        // Flag OFF — preserve pre-4c.5 behaviour exactly: non-clean close
        // surfaces a recoverable onError and that's the end of it.
        if (event.code !== 1000 && event.code !== 1005) {
          this.callbacks.onError?.(new Error(`Sonnet WS closed (code=${event.code})`), true);
        }
        return;
      }

      if (isClean) return;

      if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        // Terminal failure — stop retrying and surface a non-recoverable
        // error so the UI can flip into the error overlay.
        this.callbacks.onError?.(
          new Error(
            `Sonnet reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts (last code=${event.code})`
          ),
          false
        );
        return;
      }

      this.scheduleReconnect();
    };

    this.ws = ws;
  }

  /** Schedule the next reconnect attempt with exponential backoff + jitter. */
  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = SonnetSession.computeBackoffDelay(this.reconnectAttempts);
    if (this.reconnectTimer) this.clearSchedule(this.reconnectTimer);
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      // Late-abort: disconnect() might have been called while we were
      // waiting. `shouldReconnect` is the source of truth.
      if (!this.shouldReconnect) return;
      this.openSocket();
    }, delay);
  }

  /** Feed a final Deepgram transcript into the Sonnet session. No-op if
   *  the text is empty. Messages sent before `onopen` are queued.
   *
   *  `regexHints`, when non-empty, attaches as `regex_fields` on the
   *  wire payload — the regex-tier hint protocol iOS has shipped since
   *  2026-02. The backend already understands this field; web just
   *  starts emitting it (no backend change needed). Hints tell Sonnet
   *  "the regex tier already filled these fields with high confidence;
   *  only overwrite if you have a strong disagreement". Empty array
   *  vs absent field is treated identically by the server schema, so
   *  we omit the key entirely when there are no hints to keep
   *  pre-existing test fixtures + wire snapshots stable. */
  sendTranscript(
    text: string,
    options?: {
      confirmationsEnabled?: boolean;
      regexHints?: ReadonlyArray<{ field: string; value?: string }>;
    }
  ): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    if (!this.ws || this.state === 'connecting') {
      this.preConnectQueue.push(trimmed);
      return;
    }
    if (this.state !== 'connected') return;
    const payload: Record<string, unknown> = {
      type: 'transcript',
      text: trimmed,
      confirmations_enabled: options?.confirmationsEnabled ?? false,
    };
    if (options?.regexHints && options.regexHints.length > 0) {
      payload.regex_fields = options.regexHints;
    }
    this.sendRaw(payload);
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
    // Cancel any pending reconnect and latch the state machine off so
    // a late-firing timer doesn't resurrect the socket after we asked
    // it to shut down.
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      this.clearSchedule(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
        // Capture sessionId from the server so reconnect can echo it
        // back inside `session_resume`. The server started emitting this
        // field in Wave 4c.5 backend; older builds omit it, in which
        // case we simply keep the previously-known value (or null on a
        // fresh session) and reconnect will fall back to the original
        // `session_start` flow.
        const maybeId = json.sessionId;
        if (typeof maybeId === 'string' && maybeId.length > 0) {
          this.sessionId = maybeId;
        }
        // TTL-expired rehydration: if the previous ack status was
        // 'resumed' and the server is now saying 'new', the 5-minute
        // context-retention window elapsed (or the id was never known
        // to the server). Surface a recoverable warning so the UI can
        // hint to the user — keep going with the fresh session so they
        // don't lose the recording, but flag the gap in field-fill
        // continuity until Sonnet rebuilds context from the next few
        // utterances.
        const wasResumeAck = this.sessionStatus === 'resumed' && status === 'new';
        if (wasResumeAck) {
          this.callbacks.onError?.(
            new Error('Sonnet session context expired — continuing with fresh session'),
            true
          );
        }
        if (status === 'new' || status === 'resumed') {
          this.sessionStatus = status;
        }
        this.callbacks.onSessionAck?.(status, this.sessionId ?? undefined);
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
