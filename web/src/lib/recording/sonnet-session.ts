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
 *  `question_type` is the renamed `type` field (unclear/orphaned/out_of_range).
 *
 *  `tool_call_id` is populated only by the Stage 6 `ask_user_started`
 *  path. When present the consumer (recording-context.tsx) MUST
 *  surface it back to the SonnetSession before forwarding the next
 *  inspector utterance so the wire emit reaches `ask_user_answered`
 *  with `consumed_utterance_id` and the backend's fast-path dedupe
 *  hits. Legacy `questions_for_user` JSON questions never carry it —
 *  those resolve via the in_response_to / overtake-classifier path,
 *  not the explicit answer wire. */
export interface SonnetQuestion {
  question_type?: 'unclear' | 'orphaned' | 'out_of_range' | string;
  question: string;
  context?: string;
  field?: string | null;
  circuit?: number | null;
  tool_call_id?: string | null;
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

/**
 * Stage 6 protocol capability advertisement.
 *
 * Backend `sonnet-stream.js` (handleSessionStart, line ~1562) reads this
 * field on the inbound `session_start` / `session_resume` frame. When it's
 * `'stage6'` AND the server is in `live` mode (production default since
 * commit c3023dd, 2026-05-02), the per-tool-call WS events (notably
 * `ask_user_started`) are emitted on the wire. When absent, the server sets
 * `fallbackToLegacy=true` and SUPPRESSES those events — which silently
 * stalled the Farm Close prod session (sess_moqvdgjl_fo6w, 2026-05-04):
 * Sonnet asked "Should I create circuit 1?" but the question never reached
 * the UI, so the inspector stared at a quiet recorder for 24s before giving
 * up. iOS advertises the same value (ServerWebSocketService.swift:396).
 *
 * Bumping this requires a coordinated backend release — see the iOS source
 * comment for the additive scope at this protocol version.
 */
const STAGE6_PROTOCOL_VERSION = 'stage6';

export class SonnetSession {
  private ws: WebSocket | null = null;
  private state: SonnetConnectionState = 'disconnected';
  private callbacks: SonnetSessionCallbacks;
  private startOptions: SessionStartOptions | null = null;
  // Buffer for transcript / correction / ask_user_answered frames that
  // are sent while the socket is connecting or after a dirty close.
  // Mirrors iOS `ServerWebSocketService.pendingMessages`
  // (ServerWebSocketService.swift:182). On reopen the buffer flushes
  // through `reorderPendingForReplay` so each `ask_user_answered`
  // emits IMMEDIATELY after its matching transcript (matched by
  // utterance_id ↔ consumed_utterance_id), pre-stamping the backend's
  // `seenTranscriptUtterances` Set so the fast-path dedupe at
  // sonnet-stream.js:1013 hits before the fuzzy text fallback at
  // line 1042. See `reorderPendingForReplay` for the full algorithm.
  //
  // Membership is restricted to the three types iOS buffers: any
  // session-control / heartbeat / job_state_update frame is dropped
  // when disconnected because either it carries no inspector data
  // (heartbeat) or its content will be re-emitted by the server-side
  // session_resume rehydrate (job_state, session_pause/resume).
  private pendingMessages: Array<Record<string, unknown>> = [];
  // Stage 6 STI-04 — toolCallId of the most-recent `ask_user_started`
  // that hasn't yet been answered. Captured here (rather than in the
  // consumer) so the SonnetSession remains the single source of truth
  // for the wire protocol; recording-context.tsx asks via
  // `consumeInFlightToolCallId()` when it routes a final transcript.
  // Cleared on consume — and forced-cleared on `disconnect()` so a
  // late-arriving final after stop doesn't fire a stale answer.
  private inFlightToolCallId: string | null = null;
  // Idempotency Set so a Deepgram-split hesitation reply ("uh ...
  // cooker" → two finals) doesn't fire `ask_user_answered` twice for
  // the same toolCallId. Mirrors iOS `firedAskUserAnsweredToolCallIds`
  // (DeepgramRecordingViewModel.swift:1799). Persisted across
  // reconnect on the same SonnetSession instance — a session_resume
  // rehydrates context, but the dedupe Set must stay populated so a
  // buffered `ask_user_answered` that flushes on reopen can't
  // double-emit if the inspector also speaks the answer again
  // mid-reconnect. Cleared on `disconnect()` (the user explicitly
  // ending the session) but never on a dirty close.
  private firedToolCallIds = new Set<string>();
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
        // Advertise the Stage 6 capability on resume too — the backend
        // re-applies the same protocol_version policy on rehydrate as on
        // start (see sonnet-stream.js handleSessionResumeRehydrate, Plan
        // 06-06 r5-#1). Without it, a resume frame would silently downgrade
        // the entry to fallbackToLegacy=true, suppressing ask_user_started
        // and other per-tool-call WS events.
        this.sendRaw({
          type: 'session_resume',
          sessionId: this.sessionId,
          protocol_version: STAGE6_PROTOCOL_VERSION,
        });
      } else {
        const options = this.startOptions;
        if (options) {
          this.sendRaw({
            type: 'session_start',
            sessionId: options.sessionId,
            jobId: options.jobId,
            certificateType: options.certificateType,
            jobState: options.jobState,
            // iOS advertises the same value (ServerWebSocketService.swift:396).
            // Without this field the backend treats us as a pre-Stage 6 client
            // and sets fallbackToLegacy=true, which suppresses
            // ask_user_started events — leaving the user staring at a quiet
            // UI while Sonnet waits for an answer that never arrives. See
            // Farm Close prod incident, sess_moqvdgjl_fo6w, 2026-05-04.
            protocol_version: STAGE6_PROTOCOL_VERSION,
          });
        }
      }

      this.hasConnectedOnce = true;

      // Flush buffered transcript / correction / ask_user_answered
      // frames. Reorder runs paired-replay so each ask_user_answered
      // emits immediately after its matching transcript (by utterance_id
      // ↔ consumed_utterance_id) — see `reorderPendingForReplay` for
      // the algorithm and the wire-ordering invariant it preserves.
      // Frames sent during the initial connecting window also flow
      // through here (they were buffered the same way), replacing the
      // old preConnectQueue for transcripts only.
      if (this.pendingMessages.length > 0) {
        const ordered = SonnetSession.reorderPendingForReplay(this.pendingMessages);
        this.pendingMessages = [];
        for (const msg of ordered) {
          this.sendRaw(msg);
        }
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
   *  the text is empty. While disconnected (initial handshake or after
   *  a dirty close) the message is buffered through pendingMessages so
   *  it flushes on reopen via paired-replay reorder.
   *
   *  `utteranceId` is the dedupe anchor consumed at sonnet-stream.js:
   *  2092-2093 (`entry.seenTranscriptUtterances.add(msg.utterance_id)`).
   *  Stamping with the SAME UUID later sent as `consumed_utterance_id`
   *  on a paired ask_user_answered lets the backend's fast-path Set
   *  lookup hit before the fuzzy content-anchor fallback. Optional;
   *  callers without an in-flight Stage 6 ask can omit it.
   *
   *  `confirmationsEnabled` mirrors iOS — sent as the `confirmations_
   *  enabled` wire flag so Sonnet only generates a confirmations[]
   *  array when the inspector has the toggle on. */
  sendTranscript(
    text: string,
    options?: { confirmationsEnabled?: boolean; utteranceId?: string }
  ): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const msg: Record<string, unknown> = {
      type: 'transcript',
      text: trimmed,
      confirmations_enabled: options?.confirmationsEnabled ?? false,
    };
    if (options?.utteranceId) {
      msg.utterance_id = options.utteranceId;
    }
    this.sendBuffered(msg);
  }

  /** Manual field correction — sent as a pseudo-transcript so Sonnet can
   *  update conversation state consistently. Buffered like transcript
   *  when disconnected so corrections aren't dropped through a
   *  reconnect window. */
  sendCorrection(field: string, circuit: number, value: string | number | boolean): void {
    this.sendBuffered({ type: 'correction', field, circuit, value });
  }

  /**
   * Stage 6 STI-04 — emit `ask_user_answered` to resolve a backend
   * blocking ask_user tool call (sonnet-stream.js:1135). Mirrors iOS
   * `ServerWebSocketService.sendAskUserAnswered`
   * (ServerWebSocketService.swift:470). The recording-context layer
   * MUST send the matching transcript first so the wire ordering is
   *
   *   transcript(utterance_id=X) → ask_user_answered(consumed_
   *                                                  utterance_id=X)
   *
   * That way the backend's `seenTranscriptUtterances` Set is populated
   * by the time the ask's fast-path lookup runs at sonnet-stream.js:
   * 1013, side-stepping the fuzzy text fallback at line 1042 that
   * collides on repeated short answers ("yes", "circuit 3").
   *
   * Idempotency: the recording-context guards on `firedToolCallIds`
   * BEFORE calling this, so a Deepgram-split hesitation reply
   * ("uh" → "cooker" as two finals) only fires once per toolCallId.
   * The Set persists across reconnect on the same session instance —
   * see field comment.
   */
  sendAskUserAnswered(toolCallId: string, userText: string, consumedUtteranceId?: string): void {
    if (!toolCallId || !userText) return;
    const msg: Record<string, unknown> = {
      type: 'ask_user_answered',
      tool_call_id: toolCallId,
      user_text: userText,
    };
    if (consumedUtteranceId) {
      msg.consumed_utterance_id = consumedUtteranceId;
    }
    this.sendBuffered(msg);
  }

  /**
   * Read the in-flight ask_user toolCallId AND clear it in one call.
   * Returns null if no Stage 6 ask is currently in flight, OR if the
   * toolCallId has already been answered (idempotency Set check).
   *
   * Consume-and-clear semantics so the recording-context's transcript
   * handler can branch atomically: a non-null result means "this
   * transcript IS an answer — emit transcript then ask_user_answered";
   * a null result means "this transcript is just a normal turn —
   * emit transcript only".
   */
  consumeInFlightToolCallId(): string | null {
    const id = this.inFlightToolCallId;
    if (!id) return null;
    if (this.firedToolCallIds.has(id)) {
      // The id is set but we've already fired for it — clear lazily and
      // tell the caller there's nothing in flight.
      this.inFlightToolCallId = null;
      return null;
    }
    // Mark BEFORE clearing the in-flight slot so re-entry on the same
    // boundary (a synchronous second final from the same audio chunk)
    // dedupes via the Set on its second pass.
    this.firedToolCallIds.add(id);
    this.inFlightToolCallId = null;
    return id;
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
    // Drop any unsent buffered messages — the inspector explicitly
    // ended the session, so a late transcript that landed during the
    // 300ms close grace shouldn't fire as a new turn on the next
    // session. Mirrors iOS where `pendingMessages.removeAll()` runs
    // during teardown (ServerWebSocketService.swift:288).
    this.pendingMessages = [];
    // Reset Stage 6 state: a fresh recording session starts with no
    // in-flight ask and no fired ids. firedToolCallIds is cleared
    // here (only) so a brand new session can't be polluted by ids
    // from a prior run, while a dirty close + reconnect within the
    // same session preserves the Set so a buffered ask_user_answered
    // can't double-fire on flush.
    this.inFlightToolCallId = null;
    this.firedToolCallIds.clear();
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

  /**
   * Buffer transcript / correction / ask_user_answered while the
   * socket isn't open; otherwise send immediately. Mirrors iOS
   * `ServerWebSocketService.send(_:)` (ServerWebSocketService.swift:
   * 315–348) which uses the same membership table + drop-other-
   * frames-when-disconnected policy. Session-control / heartbeat /
   * job_state_update frames are NOT buffered here — they're either
   * stateless (heartbeat) or re-emitted by the server-side rehydrate
   * on session_resume.
   */
  private sendBuffered(msg: Record<string, unknown>): void {
    if (this.state === 'connected' && this.ws) {
      this.sendRaw(msg);
      return;
    }
    const type = msg.type as string | undefined;
    if (type === 'transcript' || type === 'correction' || type === 'ask_user_answered') {
      this.pendingMessages.push(msg);
    }
    // Other types disconnected = drop. Mirrors iOS SEND_DROPPED branch.
  }

  /**
   * Pure helper — paired-replay of buffered messages. Mirrors iOS
   * `ServerWebSocketService.reorderPendingForReplay`
   * (ServerWebSocketService.swift:592–...).
   *
   * Algorithm:
   *
   * - For each `ask_user_answered` with `consumed_utterance_id = X`,
   *   find the buffered transcript with `utterance_id = X` (anywhere
   *   in the input) and emit them as a PAIR in order
   *   `transcript(X)` → `ask(X)` at the ask's original FIFO position.
   *   The transcript is then NOT re-emitted at its own position.
   *
   * - An ask without a matching buffered transcript stays in place
   *   (its matching transcript was sent pre-disconnect — the
   *   backend's `seenTranscriptUtterances` Set already has the id).
   *
   * - All other frames stay in their original FIFO position. Output
   *   count equals input count exactly.
   *
   * Why paired (not "asks first" partition): the backend's fast-path
   * dedupe at sonnet-stream.js:1013 reads `consumed_utterance_id` and
   * looks it up in the Set populated by `entry.seenTranscript
   * Utterances.add(msg.utterance_id)` (line 2092). The transcript MUST
   * arrive BEFORE the matching ask or the Set is empty at lookup time
   * and we fall through to the fuzzy `normaliseForAskMatch` fallback
   * at line 1042.
   */
  static reorderPendingForReplay(
    buffered: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    if (buffered.length === 0) return [];
    // Index transcripts by utterance_id for O(1) lookup. UUIDs are
    // minted per Deepgram-final so collisions shouldn't happen, but if
    // they do the FIRST wins — preserves intra-class FIFO.
    const transcriptByUtteranceId = new Map<string, number>();
    for (let i = 0; i < buffered.length; i++) {
      const msg = buffered[i];
      if (msg.type !== 'transcript') continue;
      const id = msg.utterance_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (!transcriptByUtteranceId.has(id)) transcriptByUtteranceId.set(id, i);
    }
    const emitted = new Array<boolean>(buffered.length).fill(false);
    const output: Array<Record<string, unknown>> = [];
    for (let i = 0; i < buffered.length; i++) {
      if (emitted[i]) continue;
      const msg = buffered[i];
      if (msg.type === 'ask_user_answered') {
        const consumed = msg.consumed_utterance_id;
        if (typeof consumed === 'string' && consumed.length > 0) {
          const tIdx = transcriptByUtteranceId.get(consumed);
          if (tIdx != null && !emitted[tIdx]) {
            // Paired emit: transcript THEN ask. The transcript may be
            // hoisted later (ask buffered before transcript) or earlier
            // (ask after transcript) than its original FIFO slot — the
            // wire-ordering invariant trumps strict FIFO.
            output.push(buffered[tIdx]);
            emitted[tIdx] = true;
            output.push(msg);
            emitted[i] = true;
            continue;
          }
        }
      }
      // Un-paired frame: emit in place (transcript without matching
      // ask, ask without matching buffered transcript, correction, …).
      output.push(msg);
      emitted[i] = true;
    }
    return output;
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
      case 'ask_user_started': {
        // Stage 6 per-tool-call ask. iOS handles this in its own delegate
        // pathway (ServerWebSocketService.swift:802); on web we map it onto
        // the same SonnetQuestion shape that `question` uses so
        // recording-context.tsx's existing onQuestion path renders it
        // identically (TTS + alert card stack). The server does NOT also
        // emit a legacy `question` for this ask — pre-Stage 6 sessions
        // received the question via `questions_for_user`, which the tool-
        // call path leaves empty. Without this case the question is lost
        // and the inspector waits in silence (Farm Close prod incident,
        // 2026-05-04, sess_moqvdgjl_fo6w).
        const question = (json.question as string) ?? '';
        if (!question) break;
        const toolCallId =
          typeof json.tool_call_id === 'string' && json.tool_call_id.length > 0
            ? (json.tool_call_id as string)
            : null;
        // Latch the in-flight toolCallId so the next inspector
        // utterance can resolve via the explicit ask_user_answered
        // wire (Stage 6 STI-04). Skipped if we've already fired for
        // this id — the server can re-emit ask_user_started under
        // certain race conditions (e.g. session_resume rehydrate),
        // and we don't want to re-arm something already answered.
        // Last-ask-wins semantics if a fresh id arrives while another
        // is in flight; matches iOS where the AlertManager FIFO
        // displays the new question and the prior in-flight slot is
        // overwritten on the new TTS-start anchor.
        if (toolCallId && !this.firedToolCallIds.has(toolCallId)) {
          this.inFlightToolCallId = toolCallId;
        }
        const mapped: SonnetQuestion = {
          question_type: (json.reason as string) || 'ask_user',
          question,
          field: (json.context_field as string | null | undefined) ?? null,
          circuit:
            typeof json.context_circuit === 'number' ? (json.context_circuit as number) : null,
          tool_call_id: toolCallId,
        };
        this.callbacks.onQuestion?.(mapped);
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
