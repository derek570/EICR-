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
import { clientDiagnostic } from './client-diagnostic';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { RegexResultsWire } from './regex-match-result';

export type SonnetConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ExtractedReading {
  circuit: number;
  field: string;
  value: string | number | boolean;
  unit?: string | null;
  /**
   * Optional board id when the reading targets a specific board record
   * in a multi-board job. Sourced from the backend bundler's per-turn
   * `extracted_board_readings` fold + the shadow harness's circuit:0
   * propagation (`src/extraction/stage6-shadow-harness.js:331-339`).
   * iOS routes these readings to `job.boards[<index by id>]` via the
   * `boardIndex(for:)` helper (DeepgramRecordingViewModel.swift).
   *
   * On the PWA, `apply-extraction.ts mirrorReadingsToBoards` uses this
   * to write the reading onto the matching `boards[i]` record. Absent
   * for legacy single-board sessions — apply path falls back to
   * `boards[0]` (synthesised when the array is empty).
   */
  board_id?: string | null;
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
  /** Server-assigned stable UUID. Captured into `ObservationRow.server_id`
   *  so a follow-up `observation_update` (BPG4 refinement) can patch the
   *  exact row even after Sonnet rewords the text. Mirrors iOS
   *  Observation.serverId (DeepgramRecordingViewModel.swift). */
  observation_id?: string | null;
  code?: string;
  observation_text: string;
  item_location?: string | null;
  schedule_item?: string | null;
  regulation?: string | null;
  /** Canonical BS 7671 regulation wording (obs-#52 Fix B, 2026-06-23) —
   *  table-validated title/description looked up server-side from the
   *  cited regulation ref. Null on a table MISS (the COMMON case — the
   *  table is BS 7671:2018+A2:2022), in which case the model's
   *  `regulation` free-text stands alone. Mirrors iOS
   *  `Observation.regulationTitle/.regulationDescription`
   *  (Observation.swift:59). */
  regulation_title?: string | null;
  regulation_description?: string | null;
  /** One-clause "why this code" rationale (obs-#51). Rendered italic as
   *  "Because {rationale}" on the observation card, iOS parity. */
  rationale?: string | null;
  /** Multi-board attribution. Backend bundler propagates the active
   *  board_id onto Sonnet-created observations (Phase 6 multi-board
   *  sprint). PWA captures into `ObservationRow.board_id` so a
   *  multi-board PDF can group defects per-board. */
  board_id?: string | null;
}

/**
 * Refinement update for a previously-extracted observation. The server
 * emits this AFTER the initial extraction, once the BPG4 / regulation
 * refiner has produced the professional rewrite. Mirrors the iOS
 * `ObservationUpdate` Codable struct (ServerWebSocketService.swift:93).
 *
 * Wire shape:
 *   { type: 'observation_update', observation_id, observation_text,
 *     original_text, code, regulation, schedule_item, rationale, source }
 *
 * iOS handleObservationUpdate (DeepgramRecordingViewModel.swift:4954)
 * patches the matching row by:
 *   1. server_id (preferred — exact match)
 *   2. fuzzy text match on original_text (or observation_text for older
 *      servers): >70 % word-Set overlap
 *   3. CREATE-from-miss: if no row matches, append a new observation.
 */
export interface ObservationUpdate {
  observation_id?: string | null;
  observation_text: string;
  original_text?: string | null;
  code: string;
  regulation?: string | null;
  schedule_item?: string | null;
  rationale?: string | null;
  /** Canonical BS 7671 wording for the REFINED ref (obs-#52 Fix B). The
   *  server re-runs `lookupRegulation` on every observation_update path
   *  (rename / BPG4 refinement / RULE-6 edit) — null on a table MISS.
   *  Consumers apply these UNCONDITIONALLY (null CLEARS stale wording
   *  carried from a prior ref), mirroring iOS handleObservationUpdate. */
  regulation_title?: string | null;
  regulation_description?: string | null;
  source?: string | null;
}

/**
 * Stage 6 Phase 6+ wire messages — granular per-tool-call events
 * supplementing the legacy bundled `extraction`. iOS counterparts in
 * `Stage6Messages.swift` and the consumer wiring at
 * `DeepgramRecordingViewModel.serverDidReceive*`. Phase 7 may
 * eventually replace the bundled extraction with these as the primary
 * update channel; for now they're additive and the consumer can apply
 * eagerly (snappier UI) or just log.
 *
 * Forward-compat: every field beyond the required ones is optional.
 * Unknown wire fields are silently ignored — Phase 7+8 add fields
 * without requiring coordinated client releases.
 */
export interface Stage6ToolCallStarted {
  tool_call_id: string;
  tool_name: string;
  input_preview?: string | null;
}

export interface Stage6ToolCallCompleted {
  tool_call_id: string;
  tool_name: string;
  outcome: string;
  duration_ms?: number | null;
}

/** STI-05 — emitted when `clear_reading` dispatches. iOS clears the
 *  matching slot on the live grid so the inspector sees the previous
 *  value disappear before the next `record_reading` lands ms later. */
export interface Stage6FieldCorrected {
  circuit: number;
  field: string;
  previous_value?: string | null;
  reason?: string | null;
}

/** STI-06 — emitted when `create_circuit` dispatches. iOS appends to
 *  the live grid. */
export interface Stage6CircuitCreated {
  circuit_ref: number;
  designation?: string | null;
  rating_amps?: number | null;
}

/** STI-07 — emitted when `rename_circuit` dispatches. */
export interface Stage6CircuitUpdated {
  circuit_ref: number;
  designation?: string | null;
  rating_amps?: number | null;
}

/** STI-08 — emitted when `delete_observation` dispatches. */
export interface Stage6ObservationDeleted {
  observation_id: string;
  reason?: string | null;
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
  /** Vestigial — NOT populated from the current wire. The value is embedded
   *  in `text` via the backend's `buildConfirmationText`; dedupe uses `text`
   *  as the value discriminator (see confirmation-dedupe-key.ts). */
  value?: string | number | boolean;
  /** Multi-circuit roll-up — populated by the backend bundler only when a
   *  grouped broadcast covers 2+ circuit-level readings on the same
   *  (field, board_id, value). Mirrors iOS `ValueConfirmation.circuits`
   *  (ClaudeService.swift:324). */
  circuits?: number[] | null;
  /** Board scope — emitted when the reading targeted a specific board
   *  (Loaded Barrel Phase 1.B; omitted on single-board sessions). Mirrors
   *  iOS `ValueConfirmation.boardId`. */
  board_id?: string | null;
  /** field-feedback-2026-07-14 §A1a — backend-stamped operation identity
   *  for the five text-op confirmation fields (circuit_op, observation,
   *  observation_deletion, field_cleared, circuit_designation). When
   *  present AND the field is allowlisted, the dedupe key is
   *  `${field}_${dedupe_token}` (see confirmation-dedupe-key.ts). Absent
   *  on every measured-value confirmation. Mirrors iOS
   *  `ValueConfirmation.dedupeToken`. Confirmations pass through the
   *  extraction envelope raw (no per-field decode), so declaring the
   *  property here is the whole decode. */
  dedupe_token?: string | null;
}

/** Multi-board mutation op carried on the extraction envelope's
 *  `board_ops` channel (backend: `perTurnWrites.boardOps` →
 *  `bundleToolCallsIntoResult` → `result.board_ops`). Three op shapes
 *  emitted by `stage6-dispatchers-board.js`:
 *
 *    - `add_board`                 — Sonnet created a new BoardInfo.
 *    - `select_board`              — Sonnet flipped the active board.
 *    - `mark_distribution_circuit` — Sonnet flagged a parent-board
 *                                    circuit as feeding a sub-board.
 *
 *  iOS handles all three via `applyBoardOpsToJob`
 *  (`DeepgramRecordingViewModel.swift:5205`). The PWA wires the same
 *  apply via `applyBoardOpsToJob` in `apply-extraction.ts`.
 */
export type BoardOp =
  | {
      op: 'add_board';
      board_id: string;
      designation?: string | null;
      board_type?: string | null;
      parent_board_id?: string | null;
      feed_circuit_ref?: number | null;
    }
  | {
      op: 'select_board';
      board_id: string;
    }
  | {
      op: 'mark_distribution_circuit';
      circuit_ref: number;
      feeds_board_id: string;
      source_board_id?: string | null;
    };

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
  /** Multi-board mutation ops — Phase 6 wire channel. Decoded on the
   *  PWA via `apply-extraction.ts applyBoardOpsToJob`. */
  board_ops?: BoardOp[];
}

/** Unified `current_board_changed` broadcast — fired by the backend on
 *  every board switch regardless of source (iOS voice command, Sonnet
 *  add_board, Sonnet select_board). Wire emit point:
 *  `src/extraction/sonnet-stream.js:169 emitCurrentBoardChangedFromBoardOps`. */
export interface Stage6CurrentBoardChanged {
  board_id: string;
  designation: string | null;
  source: 'sonnet' | 'sonnet_add' | 'ios' | string;
}

/** Request/response envelope for an iOS-initiated `select_board`.
 *  Inspector-typed "switch to garage CU" sends `{type: 'select_board',
 *  board_id}` over the WS; backend echoes `select_board_ack` with the
 *  outcome. Web PWA isn't expected to emit `select_board` today —
 *  it's primarily a receive-side concern so the audit gap can close. */
export interface Stage6SelectBoardAck {
  ok: boolean;
  board_id?: string | null;
  designation?: string | null;
  error?: string | null;
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
  /**
   * Fires when a `session_resume` round-trip lands. `'resumed'` =
   * server rehydrated the prior session within the 5-min TTL.
   * `'context_expired'` = the server replied with a fresh-session
   * `session_ack { status: 'new' }` even though we sent a
   * `session_resume` — the Anthropic prompt cache has aged out and
   * the multi-turn context is gone. `'first_open'` = the initial
   * connect (not a resume). Mirrors iOS's distinction between
   * `serverDidConnect` (first) and a successful resume-round-trip.
   */
  onResumeOutcome?: (outcome: 'first_open' | 'resumed' | 'context_expired') => void;
  onExtraction?: (result: ExtractionResult) => void;
  onQuestion?: (q: SonnetQuestion) => void;
  /**
   * Fires when the server emits an `observation_update` — a refinement
   * of an existing observation's classification once the BPG4 /
   * BS 7671 lookup resolves. Caller patches the matching
   * `job.observations` row (matched by `observation_id`, with fuzzy
   * text fallback). Without this handler, observations that the
   * inspector saw populate from the initial extraction would never
   * pick up the lookup-resolved code/regulation refinement — same gap
   * the audit's Phase 6 P0 flagged.
   */
  onObservationUpdate?: (update: ObservationUpdate) => void;
  onVoiceCommandResponse?: (payload: VoiceCommandResponse) => void;
  onCostUpdate?: (update: CostUpdate) => void;
  /** Stage 6 Phase 6+ per-tool-call events. iOS counterparts at
   *  DeepgramRecordingViewModel.serverDidReceive*. Default is log-only;
   *  consumer can attach behaviour for the events that have UI
   *  semantics today (field_corrected, circuit_created, circuit_updated,
   *  observation_deleted). tool_call_started/completed are decode-only
   *  on iOS — Phase 7 will wire them to a progress UI. */
  onToolCallStarted?: (msg: Stage6ToolCallStarted) => void;
  onToolCallCompleted?: (msg: Stage6ToolCallCompleted) => void;
  onFieldCorrected?: (msg: Stage6FieldCorrected) => void;
  onCircuitCreated?: (msg: Stage6CircuitCreated) => void;
  onCircuitUpdated?: (msg: Stage6CircuitUpdated) => void;
  onObservationDeleted?: (msg: Stage6ObservationDeleted) => void;
  /**
   * Multi-board ops bundled into the extraction envelope (`result.
   * board_ops`). Fired AFTER `onExtraction` so the caller can apply
   * extraction readings first, then `applyBoardOpsToJob` to mutate
   * `job.boards` (add a sub-board, mark a distribution circuit).
   * `select_board` ops here are duplicated by the top-level
   * `current_board_changed` broadcast and intentionally inert — the
   * caller drives `currentBoardId` off that callback instead.
   */
  onBoardOps?: (ops: BoardOp[]) => void;
  /**
   * Unified `current_board_changed` broadcast — fires for any board
   * switch source (iOS voice command, Sonnet `add_board`, Sonnet
   * `select_board`). Wire emit point:
   * `src/extraction/sonnet-stream.js emitCurrentBoardChangedFromBoardOps`.
   * Web caller should flip `JobViewModel.currentBoardId` equivalent
   * state so the Board tab + Circuits tab filter to the active board.
   */
  onCurrentBoardChanged?: (msg: Stage6CurrentBoardChanged) => void;
  /**
   * Request/response acknowledgement for a client-initiated
   * `select_board` frame. PWA doesn't emit `select_board` today
   * (banner-driven flow only), but this hook is wired so the
   * receive-side is parity-clean for when the PWA adds a manual
   * board-switch affordance.
   */
  onSelectBoardAck?: (msg: Stage6SelectBoardAck) => void;
  /**
   * Chitchat-pause state-machine callbacks (iOS parity, 2026-05-06
   * slice 4). The backend (`src/extraction/sonnet-stream.js`) emits
   * `chitchat_paused` after 10 consecutive zero-engagement transcript
   * turns to stop burning Sonnet tokens on small-talk, and
   * `chitchat_resumed` once a wake trigger fires (wake word, regex
   * hit, manual Resume tap, or `session_resume` Deepgram-doze recovery).
   * Mirrors iOS `serverDidEnterChitchatPause` / `serverDidExitChitchatPause`
   * (DeepgramRecordingViewModel.swift:6849-6870).
   */
  onChitchatPaused?: () => void;
  onChitchatResumed?: (reason: string) => void;
  /**
   * Inbound `cancel_pending_tts` (parity with iOS Phase 6.3). The backend
   * emits `{ type: 'cancel_pending_tts', prefix }` on every
   * `*_script_cancelled` (`src/extraction/dialogue-engine/engine.js:1020-1024`,
   * prefix `srv-<script>-`) to silence a stale focused-mode script PROMPT (e.g.
   * "BS number?"). Its real target rides the DIRECT `speak()`/`deferredTtsRef`
   * path, so the consumer cancels THAT + clears the cancelled ask STATE and
   * (forward-looking, no-op today) purges the confirmation FIFO by prefix.
   * The decode passes an OBJECT; the recording-context helper takes the STRING.
   */
  onCancelPendingTts?: (msg: { prefix: string; sessionId?: string | null }) => void;
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
  /**
   * Override the 25-s ALB heartbeat interval. Production never sets
   * this; tests pass a tiny value (e.g. 50 ms) so the heartbeat-loop
   * regression can be observed without faking timers around the
   * jest-websocket-mock handshake (which itself needs real timers to
   * settle).
   */
  heartbeatIntervalMs?: number;
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
/**
 * Application-level heartbeat interval. Matches iOS
 * `ServerWebSocketService.pingInterval` exactly (25 s).
 *
 * Why an app-level JSON heartbeat AND not just WS ping frames: AWS ALB
 * idle_timeout tracks application data-frame traffic, not control
 * frames. iOS observed three consecutive sessions in 2026-04-22..24
 * (51A530BB / A02B018D / 0952EC64) where ALB closed the WS after ~88s
 * of doze silence despite WS PINGs flowing. Sending `{"type":
 * "heartbeat"}` over the same socket every 25 s resets ALB's idle
 * counter and keeps the Sonnet session (+ its 5-min Anthropic prompt
 * cache) alive through any silence. Server treats it as a no-op (see
 * `src/extraction/sonnet-stream.js` `case 'heartbeat'`).
 *
 * Audit Phase 6 P0 flagged web's missing heartbeat. iOS parity here
 * means a doze gap on web no longer reconnects mid-session and rebuilds
 * Sonnet context from scratch.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

const RECONNECT_BASE_MS = 500;
/** Hard cap in ms — later attempts plateau here rather than growing unbounded. */
const RECONNECT_CAP_MS = 10_000;
/**
 * Max attempts before we fire a terminal error and stop. iOS reconnects
 * indefinitely until manual stop (no cap, fresh token per attempt at
 * `ServerWebSocketService.swift:1187-1225`) because field inspectors on
 * flaky networks would otherwise lose their session after 5 mid-job
 * drops. Mirror that — but cap the backoff at 30 s
 * (RECONNECT_CAP_MS already does this) so battery drain is bounded.
 * The PWA's reconnect attempts share the iOS-canon `session_resume`
 * frame at `:642` so the backend's 5-minute TTL preserves context
 * across reconnections that fall inside that window; reconnections
 * after the TTL expires gracefully degrade to `session_start` with a
 * "context expired" warning surfaced via `onError(_, recoverable=true)`.
 *
 * 50 attempts at the 30 s plateau = ~25 minutes of retry headroom.
 * Long enough for an inspector to walk out of a basement and back into
 * coverage without losing the session; short enough that a hard-
 * killed laptop doesn't loop forever.
 */
const RECONNECT_MAX_ATTEMPTS = 50;
/**
 * Bound on the out-of-band diagnostic buffer. A full PWA recording session
 * generates ~5-15 client_diagnostic events per minute; 200 covers the
 * entire 5-minute reconnect TTL window with headroom. When the buffer is
 * full, FIFO drops keep the most-recent context (the lead-up to a death
 * carries the diagnostic signal; ancient events do not).
 */
const PENDING_DIAGNOSTICS_MAX = 200;

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

/**
 * The `capabilities.voice_latency.supports` list advertised in the
 * `session_start` payload. Exported as a constant so it is the single
 * source of truth for the payload AND assertable in tests without
 * standing up a websocket — mirroring iOS
 * `ServerWebSocketService.voiceLatencySupports` (:303). Each string MUST
 * match the backend source-of-truth list `VOICE_LATENCY_KNOWN_SUPPORTS`
 * (src/extraction/voice-latency-config.js:220) — a mismatch silently
 * disables the capability server-side.
 *
 * Wire shape matters: `parseVoiceLatencyCapabilities`
 * (voice-latency-config.js:174) accepts ONLY
 * `capabilities: { voice_latency: { version: 1, supports: [...] } }`.
 * A bare `capabilities: [...]` array parses as v0 and leaves every
 * capability DORMANT.
 *
 * - `low_conf_readback_v1`: rollout-sequencing gate for universal
 *   read-back (readback-correction-optionb §6, 2026-06-18). Advertised
 *   because the web apply path has NO local `reading.confidence < 0.5`
 *   drop filter (verified 2026-07-02: zero reading-confidence gating in
 *   `apply-extraction.ts` / `recording-context.tsx` — the only
 *   confidence plumbing client-side is Deepgram TRANSCRIPT confidence,
 *   which never gates a reading apply). Until a client advertises this,
 *   the backend dispatcher SKIPS applying `< 0.5` readings pre-apply, so
 *   web users silently lost low-confidence dictated values.
 *
 * iOS additionally advertises `regex_fast_v2` and
 * `client_playback_telemetry`. Web MUST NOT claim them until the
 * corresponding plumbing ships (fast-path TTS port / playback-ack
 * telemetry — parity-ledger rows name the follow-up owners): advertising
 * an unimplemented capability is worse than lagging.
 */
export const VOICE_LATENCY_SUPPORTS: readonly string[] = ['low_conf_readback_v1'];

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
  // Out-of-band diagnostic buffer — catches `client_diagnostic` envelopes
  // that fire while the WS is closed (or mid-handshake) so they ship to
  // CloudWatch on the next successful open. Designed to plug the visibility
  // gap exposed by sess_mp79tvcj_6prk (2026-05-15): when the WS died at
  // 18:50:03 UTC, the `sonnet_ws_close` diagnostic itself, plus every
  // subsequent `recording_pagehide` / `recording_visibility_change` / etc.,
  // was silently dropped because `sendClientDiagnostic` short-circuited
  // on `state !== 'connected'`. With this buffer the close event survives
  // to the next session_resume — even when reconnect is suppressed because
  // of a code-1005 misclassification (Flaw B in the post-mortem), the
  // FIRST event of the next WS lifetime carries the receipt of the
  // previous death. Capped at PENDING_DIAGNOSTICS_MAX to bound memory
  // during a long-running disconnect window; oldest events drop first.
  private pendingDiagnostics: Array<{
    category: string;
    payload: Record<string, unknown>;
    capturedAt: string;
  }> = [];
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
  // 25-s app-level heartbeat to defeat ALB idle_timeout. Started on
  // every successful open, cleared on disconnect AND on close (so a
  // mid-session dirty close doesn't keep firing into a dead socket).
  private heartbeatTimer: unknown = null;
  private heartbeatIntervalMs: number;
  // Diagnostic — last-seen timestamps + message types for both
  // directions on the WS, so a `sonnet_ws_close` row can show
  // "ms since last server message" / "last sent type". Critical
  // for diagnosing "WS died N ms after we sent X" patterns.
  private lastRecvMs: number | null = null;
  private lastRecvType: string | null = null;
  private lastSendMs: number | null = null;
  private lastSendType: string | null = null;

  constructor(callbacks: SonnetSessionCallbacks = {}, deps: SonnetSessionDeps = {}) {
    this.callbacks = callbacks;
    this.schedule = deps.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearSchedule =
      deps.clearScheduler ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
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
    if (this.ws && this.state !== 'disconnected') {
      pipelineLog('sonnet_connect_skipped_already_open', {
        state: this.state,
      });
      return;
    }
    pipelineLog('sonnet_connect_invoked', {
      jobId: options.jobId,
      certType: options.certificateType,
      hasJobState: options.jobState != null,
      hasPriorSessionId: typeof options.sessionId === 'string',
    });
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
      pipelineLog('sonnet_ws_no_token', {
        sessionId: this.sessionId,
        reconnectAttempt: this.reconnectAttempts,
      });
      this.callbacks.onError?.(new Error('Not authenticated — no token available'), false);
      return;
    }

    const url = this.buildURL(token);
    pipelineLog('sonnet_ws_connecting', {
      sessionId: this.sessionId,
      hasConnectedOnce: this.hasConnectedOnce,
      reconnectAttempt: this.reconnectAttempts,
      pendingMessages: this.pendingMessages.length,
    });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setState('error');
      pipelineLog('sonnet_ws_construct_throw', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)), false);
      return;
    }

    ws.onopen = () => {
      pipelineLog('sonnet_ws_open', {
        sessionId: this.sessionId,
        hasConnectedOnce: this.hasConnectedOnce,
        reconnectAttempt: this.reconnectAttempts,
      });
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
            // Voice-latency capability advertisement — session_start ONLY,
            // mirroring iOS (resume rehydrates the parsed capabilities
            // server-side within the TTL window). See the
            // VOICE_LATENCY_SUPPORTS doc comment for the wire-shape
            // contract and why only low_conf_readback_v1 is claimed.
            capabilities: {
              voice_latency: {
                version: 1,
                supports: [...VOICE_LATENCY_SUPPORTS],
              },
            },
          });
        }
      }

      this.hasConnectedOnce = true;
      this.startHeartbeat();

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

      // Drain client_diagnostic envelopes that fired during the dead-WS
      // window. Runs after the session_start / session_resume frame +
      // pendingMessages flush so the diagnostics land server-side with the
      // session-rebind already applied. See `drainPendingDiagnostics` for
      // the replay envelope shape.
      this.drainPendingDiagnostics();

      // Arm the app-layer heartbeat — iOS-parity ALB-idle-timeout defence.
      // Cleared in `ws.onclose` and `disconnect()`. Uses `setInterval`
      // directly (not the injected `this.schedule`) because the heartbeat
      // is recurring; `this.schedule` is single-fire. Tests can drive the
      // tick via `vi.useFakeTimers()` + `vi.advanceTimersByTime`. See the
      // HEARTBEAT_INTERVAL_MS docblock for the AWS-ALB rationale.
      this.startHeartbeat();
    };

    ws.onmessage = (event) => this.handleMessage(event.data);

    ws.onerror = () => {
      this.setState('error');
      pipelineLog('sonnet_ws_error', {
        sessionId: this.sessionId,
        reconnectAttempt: this.reconnectAttempts,
        msSinceLastRecv: this.lastRecvMs ? Date.now() - this.lastRecvMs : null,
        lastRecvType: this.lastRecvType,
      });
      this.callbacks.onError?.(new Error('Sonnet WebSocket error'), true);
    };

    ws.onclose = (event) => {
      this.ws = null;
      this.stopHeartbeat();
      if (this.state !== 'error') this.setState('disconnected');

      // Stop the app-layer heartbeat the moment the WS goes down.
      // Leaving it armed across reconnects would still work (sendRaw
      // is a no-op when this.ws is null) but the wasted timer ticks
      // would fire every 25s in the background. The next clean
      // ws.onopen re-arms it.
      this.stopHeartbeat();

      // Close-code policy
      //   1000 — peer initiated a graceful shutdown. Truly clean. Never reconnect.
      //   1005 — "no status received". RFC 6455 §7.1.5: the peer closed without
      //          sending a Close frame. iPad Safari fires this when the OS reaps
      //          a backgrounded tab's WS during audio playback / App Nap (the
      //          recurring failure mode in sess_mp79tvcj_6prk and 4 prior PWA
      //          sessions, 2026-05-15). Treating 1005 as clean — which the code
      //          did pre-this-commit — silently suppressed every reconnect on
      //          the death path most likely to need one. Re-classify as non-
      //          clean so the reconnect ladder fires; the 5-minute server-side
      //          TTL (sonnet-stream.js:1912) preserves the conversation context
      //          across the reopen.
      // !shouldReconnect — caller asked for shutdown (stop button, page unload
      //          via disconnect()). Honour the explicit intent; never resurrect.
      const isClean = event.code === 1000 || !this.shouldReconnect;
      const reconnectEnabled = isReconnectEnabled();
      const willReconnect =
        reconnectEnabled && !isClean && this.reconnectAttempts < RECONNECT_MAX_ATTEMPTS;
      pipelineLog('sonnet_ws_close', {
        sessionId: this.sessionId,
        code: event.code,
        reason: event.reason ?? '',
        wasClean: event.wasClean,
        shouldReconnect: this.shouldReconnect,
        willReconnect,
        reconnectAttempt: this.reconnectAttempts,
        msSinceLastRecv: this.lastRecvMs ? Date.now() - this.lastRecvMs : null,
        lastRecvType: this.lastRecvType,
        msSinceLastSend: this.lastSendMs ? Date.now() - this.lastSendMs : null,
        lastSendType: this.lastSendType,
      });

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
    pipelineLog('sonnet_reconnect_scheduled', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
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
   *  array when the inspector has the toggle on.
   *
   *  `regexResults` mirrors iOS `ServerWebSocketService.sendTranscript`
   *  (line 506-507): the array of pre-extracted field hints from the
   *  client-side TranscriptFieldMatcher. Backend reads it at
   *  `src/extraction/sonnet-stream.js:3416-3443` for the chitchat-pause
   *  wake gate, counter reset, and overtake classifier. Omitted (or
   *  empty) → backend falls through to its `entry.lastRegexResults`
   *  fallback (line 3434), so an absent field is wire-safe. Per-entry
   *  shape is `{field, value?}` matching iOS — see regex-match-result.ts. */
  sendTranscript(
    text: string,
    options?: {
      confirmationsEnabled?: boolean;
      utteranceId?: string;
      regexResults?: RegexResultsWire;
      /**
       * Preceding-TTS-question context. When a transcript arrives within
       * the post-TTS answer window, the client attaches the question text
       * + type (and optionally field/circuit) so backend
       * `src/extraction/sonnet-stream.js:3193-3243` can prepend
       * "CONTEXT: This is in response to the question '<Q>' (type: <T>)"
       * to Sonnet's user turn. Without this, bare replies like "yes",
       * "no", "code 2" lose attribution.
       *
       * iOS canon: ServerWebSocketService.swift:498-518. iOS only attaches
       * when the in-flight question slot is alive and within the 10s
       * stale window (DeepgramRecordingViewModel.swift:2840-2900).
       * Caller (recording-context.tsx) computes that.
       */
      inResponseTo?: {
        type: string;
        question: string;
        field?: string | null;
        circuit?: number | null;
      };
    }
  ): void {
    const trimmed = text?.trim();
    if (!trimmed) {
      pipelineLog('sonnet_send_transcript_skipped_empty', {});
      return;
    }
    const msg: Record<string, unknown> = {
      type: 'transcript',
      text: trimmed,
      // iOS canon: ServerWebSocketService.swift:504 always stamps an ISO
      // 8601 timestamp. Kept for parity even though the backend doesn't
      // load-bear on it today — a future server-side replay or audit pass
      // will use it, and the wire diff between platforms should be empty.
      timestamp: new Date().toISOString(),
    };
    // iOS-conditional: only emit `confirmations_enabled` when truthy.
    // ServerWebSocketService.swift:509-511 — `if confirmationsEnabled`.
    if (options?.confirmationsEnabled) {
      msg.confirmations_enabled = true;
    }
    if (options?.utteranceId) {
      msg.utterance_id = options.utteranceId;
    }
    if (options?.regexResults && options.regexResults.length > 0) {
      msg.regexResults = options.regexResults;
    }
    // iOS canon: ServerWebSocketService.swift:516-518 — only attach when
    // the payload is non-empty. The `question` key is the load-bearer
    // (backend at sonnet-stream.js:3202 short-circuits without it).
    if (options?.inResponseTo && options.inResponseTo.question) {
      msg.in_response_to = options.inResponseTo;
    }
    pipelineLog('sonnet_send_transcript', {
      textLength: trimmed.length,
      textPreview: trimmed.slice(0, 40),
      utteranceIdShort:
        typeof options?.utteranceId === 'string' ? options.utteranceId.slice(0, 11) : null,
      regexHints: options?.regexResults?.length ?? 0,
      confirmationsEnabled: options?.confirmationsEnabled ?? false,
      hasInResponseTo: Boolean(options?.inResponseTo?.question),
      state: this.state,
      willBuffer: this.state !== 'connected',
    });
    this.sendBuffered(msg);
  }

  /** Manual field correction — sent as a pseudo-transcript so Sonnet can
   *  update conversation state consistently. Buffered like transcript
   *  when disconnected so corrections aren't dropped through a
   *  reconnect window. */
  sendCorrection(field: string, circuit: number, value: string | number | boolean): void {
    pipelineLog('sonnet_send_correction', {
      field,
      circuit,
      valueType: typeof value,
      state: this.state,
    });
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
    if (!toolCallId || !userText) {
      pipelineLog('sonnet_send_ask_user_answered_skipped', {
        hasToolCallId: !!toolCallId,
        hasUserText: !!userText,
      });
      return;
    }
    const msg: Record<string, unknown> = {
      type: 'ask_user_answered',
      tool_call_id: toolCallId,
      user_text: userText,
    };
    if (consumedUtteranceId) {
      msg.consumed_utterance_id = consumedUtteranceId;
    }
    pipelineLog('sonnet_send_ask_user_answered', {
      toolCallIdShort: toolCallId.slice(0, 16),
      userTextLength: userText.length,
      userTextPreview: userText.slice(0, 40),
      consumedUtteranceIdShort: consumedUtteranceId?.slice(0, 11) ?? null,
    });
    this.sendBuffered(msg);
  }

  /**
   * Diagnostic envelope that lands on CloudWatch as `Client diagnostic`.
   * Mirrors iOS `ServerWebSocketService.sendClientDiagnostic`.
   *
   * Behaviour split by WS state:
   *   - connected → send immediately
   *   - any other state (connecting / disconnected / error) → push into
   *     `pendingDiagnostics` (capped at PENDING_DIAGNOSTICS_MAX, FIFO
   *     evicts oldest), drained on the next clean open. This is what
   *     lets `sonnet_ws_close` / `recording_pagehide` / etc. survive a
   *     dead-WS window: iOS doesn't need this path because its native
   *     reconnect always fires onclose first, but iPad-Safari-in-PWA-
   *     mode swallows close events under audio playback + power saving
   *     (see sess_mp79tvcj_6prk post-mortem, 2026-05-15).
   *
   * Envelope keys (`type`, `category`, `timestamp`) are written AFTER
   * the payload spread so a caller cannot accidentally hijack the WS
   * message type — same defence iOS added at ServerWebSocketService.swift:794.
   * `captured_at_iso` is stamped at buffer time so the server can tell a
   * replayed diagnostic apart from one fired live; without it the
   * `timestamp` on a drained envelope reflects drain time, not capture
   * time, and a 30-second-old close event would look real-time.
   */
  sendClientDiagnostic(category: string, payload: Record<string, unknown> = {}): void {
    const capturedAt = new Date().toISOString();
    if (!this.ws || this.state !== 'connected') {
      this.pendingDiagnostics.push({ category, payload, capturedAt });
      if (this.pendingDiagnostics.length > PENDING_DIAGNOSTICS_MAX) {
        // Drop oldest — newest events carry the live disconnect context.
        this.pendingDiagnostics.splice(0, this.pendingDiagnostics.length - PENDING_DIAGNOSTICS_MAX);
      }
      return;
    }
    const msg: Record<string, unknown> = { ...payload };
    msg.type = 'client_diagnostic';
    msg.category = category;
    msg.timestamp = capturedAt;
    this.sendRaw(msg);
  }

  /**
   * Drain `pendingDiagnostics` over a freshly-opened WS. Called from
   * `ws.onopen` AFTER session_start / session_resume + pendingMessages
   * flush, so the diagnostic stream lands in CloudWatch with the session
   * context already bound. Each replayed envelope carries:
   *   - `category` + payload as captured
   *   - `timestamp` = capture time (NOT drain time)
   *   - `replayed_from_pending: true` so an analyst can spot which logs
   *     came from a dead-WS window vs the live stream
   *   - `replay_delay_ms` since capture, for ballpark dead-WS-window
   *     duration in CloudWatch Insights without timestamp math
   */
  private drainPendingDiagnostics(): void {
    if (this.pendingDiagnostics.length === 0) return;
    const drained = this.pendingDiagnostics;
    this.pendingDiagnostics = [];
    const drainTime = Date.now();
    for (const entry of drained) {
      const msg: Record<string, unknown> = { ...entry.payload };
      msg.type = 'client_diagnostic';
      msg.category = entry.category;
      msg.timestamp = entry.capturedAt;
      msg.replayed_from_pending = true;
      const capturedMs = Date.parse(entry.capturedAt);
      if (Number.isFinite(capturedMs)) {
        msg.replay_delay_ms = drainTime - capturedMs;
      }
      this.sendRaw(msg);
    }
  }

  /**
   * Non-consuming read of the in-flight ask_user toolCallId. Used by
   * the barge-in path (`onFinalTranscript` in recording-context.tsx)
   * which needs to know an ask is pending but does NOT want to
   * mark-as-fired yet — the consume happens later in the same handler
   * AFTER the barge-in TTS cancel. Returns null if no ask is in
   * flight OR if it has already fired.
   */
  peekInFlightToolCallId(): string | null {
    const id = this.inFlightToolCallId;
    if (!id) return null;
    if (this.firedToolCallIds.has(id)) return null;
    return id;
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

  /**
   * Clear the in-flight ask_user toolCallId iff it starts with `prefix`.
   * Part of the `cancel_pending_tts` state-clear (parity with iOS Phase 6.3):
   * silencing the stale prompt's audio is necessary but not sufficient — the
   * cancelled ask's toolCallId must also be dropped here, or the next inspector
   * utterance resolves via `consumeInFlightToolCallId` against an ask the
   * backend already abandoned. No-op on an empty prefix or a non-match.
   */
  clearInFlightToolCallIdByPrefix(prefix: string): void {
    if (!prefix) return;
    if (this.inFlightToolCallId && this.inFlightToolCallId.startsWith(prefix)) {
      this.inFlightToolCallId = null;
    }
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

  /**
   * Tell the backend the inspector is talking OVER the currently-
   * playing TTS — mirrors iOS `notifyBargeInFired` at
   * `RecordingSessionCoordinator.swift:741-772` (the
   * `tts_cancelled_by_user` wire frame). Backend uses this signal
   * to attribute the next utterance to the SAME ask_user the TTS
   * was emitting, not to a fresh turn. `reason` distinguishes
   * `'amplitude'` (mic-level threshold) from `'vad'` (Silero
   * probability) so analytics can compare detector accuracy across
   * platforms.
   */
  sendBargeIn(reason: 'amplitude' | 'vad', vadProbability?: number): void {
    if (!this.ws || this.state !== 'connected') return;
    const msg: Record<string, unknown> = { type: 'tts_cancelled_by_user', reason };
    if (typeof vadProbability === 'number') msg.vad_probability = vadProbability;
    this.sendRaw(msg);
  }

  /**
   * Ask the backend to compact the Anthropic conversation cache before
   * the session goes idle. Mirrors iOS
   * `ServerWebSocketService.sendCompactRequest()` at
   * `ServerWebSocketService.swift:540` invoked from
   * `RecordingSessionCoordinator.swift:394` on enter-sleeping.
   *
   * Why: Anthropic's 5-minute prompt-cache TTL means that an inspector
   * pause longer than 5 minutes forces the next wake-turn to repay the
   * full prompt cost. A `session_compact` request collapses the
   * conversation history into a smaller summary that fits inside the
   * cache window. The backend has its own guard rails
   * (5-check compaction cost gate + 60k token threshold) so this is a
   * best-effort hint, not a guarantee — the server may decline.
   *
   * Fire-and-forget on the wire. No reply event is awaited; the
   * compact happens out-of-band on the backend before the next
   * session_resume.
   */
  sendCompactRequest(): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'session_compact' });
  }

  /** Inverse of pause() — re-enable extraction billing after wake. */
  resume(): void {
    if (!this.ws || this.state !== 'connected') return;
    this.sendRaw({ type: 'session_resume' });
  }

  /** Manual wake from the chitchat-pause banner's Resume button. iOS
   *  canon: `ServerWebSocketService.sendChitchatResume()` →
   *  `{type: "chitchat_resume"}`. The backend exits the paused state
   *  and emits `chitchat_resumed` over the WS, which flips the host's
   *  `chitchatPaused` flag back to false via the
   *  `onChitchatResumed` callback. */
  sendChitchatResume(): void {
    this.sendBuffered({ type: 'chitchat_resume' });
  }

  /** Graceful shutdown: send session_stop, let the server flush any
   *  buffered utterances, then close the socket. */
  disconnect(): void {
    pipelineLog('sonnet_disconnect_invoked', {
      state: this.state,
      hasWs: this.ws != null,
      readyState: this.ws?.readyState ?? null,
      bufferedAmount: this.ws?.bufferedAmount ?? null,
      pendingMessages: this.pendingMessages.length,
      inFlightToolCallId:
        typeof this.inFlightToolCallId === 'string' ? this.inFlightToolCallId.slice(0, 16) : null,
    });
    // Cancel any pending reconnect and latch the state machine off so
    // a late-firing timer doesn't resurrect the socket after we asked
    // it to shut down.
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      this.clearSchedule(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Stop the heartbeat timer too — pairs with `ws.onclose`'s stop
    // call so an explicit disconnect-before-close leaves no orphaned
    // setInterval running in the background.
    this.stopHeartbeat();
    // Drop any unsent buffered messages — the inspector explicitly
    // ended the session, so a late transcript that landed during the
    // 300ms close grace shouldn't fire as a new turn on the next
    // session. Mirrors iOS where `pendingMessages.removeAll()` runs
    // during teardown (ServerWebSocketService.swift:288).
    this.pendingMessages = [];
    // Same logic for pending diagnostics — once the inspector ended the
    // session, replaying old client_diagnostic envelopes on a NEW session
    // would muddy CloudWatch with stale categories carrying the wrong
    // session context. The local pipelineLog ring + /settings/diagnostics
    // export survives this drop, so nothing is lost — just unhitched from
    // a session that no longer exists.
    this.pendingDiagnostics = [];
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

  /**
   * Start the 25-s heartbeat loop. Idempotent — clears any previous
   * timer before scheduling. Uses `setInterval` directly because the
   * injected `schedule` is a one-shot `setTimeout` shape; the
   * heartbeat is a steady-state cadence and doesn't need
   * exp-backoff/jitter the way reconnect does. Tests can verify via
   * `getHeartbeatInterval()` debug accessor (see end of class).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Bail if the socket isn't actually open — interval can fire
      // between a clean close and the next open. Sending into a
      // closed socket would throw; gate to avoid the no-op overhead.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      } catch {
        // Send failures here are non-fatal — the socket will surface
        // its own onerror/onclose if it's actually broken.
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer as ReturnType<typeof setInterval>);
      this.heartbeatTimer = null;
    }
  }

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
    const type = typeof obj.type === 'string' ? obj.type : 'unknown';
    // CRITICAL: never pipelineLog `client_diagnostic` sends. pipelineLog
    // fans out to clientDiagnostic() which routes through sendClientDiagnostic()
    // which calls sendRaw() — logging that send would recurse infinitely.
    const isDiag = type === 'client_diagnostic';
    if (!this.ws) {
      if (!isDiag) {
        pipelineLog('sonnet_ws_send_dropped_no_ws', { type });
      }
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
      this.lastSendMs = Date.now();
      this.lastSendType = type;
      if (!isDiag) {
        pipelineLog('sonnet_ws_send', {
          type,
          readyState: this.ws.readyState,
          bufferedAmount: this.ws.bufferedAmount,
        });
      }
    } catch (err) {
      if (!isDiag) {
        pipelineLog('sonnet_ws_send_throw', {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    } catch (err) {
      pipelineLog('sonnet_ws_recv_parse_error', {
        error: err instanceof Error ? err.message : String(err),
        dataKind: typeof data,
      });
      return;
    }

    const type = json.type as string | undefined;
    this.lastRecvMs = Date.now();
    this.lastRecvType = type ?? 'unknown';
    pipelineLog('sonnet_ws_recv', { type: type ?? 'unknown' });
    switch (type) {
      case 'session_ack': {
        const status = (json.status as string) ?? 'unknown';
        const maybeId = json.sessionId;
        const incomingId = typeof maybeId === 'string' && maybeId.length > 0 ? maybeId : null;
        clientDiagnostic('session_ack_received', {
          status,
          hasSessionId: incomingId !== null,
          isFirstAck: this.sessionId === null,
          idChanged:
            incomingId !== null && this.sessionId !== null && this.sessionId !== incomingId,
          priorStatus: this.sessionStatus ?? 'none',
        });
        // Capture sessionId from the server so reconnect can echo it
        // back inside `session_resume`. The server started emitting this
        // field in Wave 4c.5 backend; older builds omit it, in which
        // case we simply keep the previously-known value (or null on a
        // fresh session) and reconnect will fall back to the original
        // `session_start` flow.
        if (incomingId !== null) {
          this.sessionId = incomingId;
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
        // Resume outcome event — audit #36 wiring. `prevStatus` is
        // the LAST observed session_status before this ack; we fire
        // the outcome BEFORE updating sessionStatus so the consumer
        // sees the transition arc.
        const prevStatus = this.sessionStatus;
        if (status === 'new' && prevStatus === null) {
          this.callbacks.onResumeOutcome?.('first_open');
        } else if (status === 'resumed') {
          this.callbacks.onResumeOutcome?.('resumed');
        } else if (status === 'new' && prevStatus === 'resumed') {
          this.callbacks.onResumeOutcome?.('context_expired');
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
          const readings = Array.isArray(result.readings) ? result.readings : [];
          const fieldClears = Array.isArray(result.field_clears) ? result.field_clears : [];
          const circuitUpdates = Array.isArray(result.circuit_updates)
            ? result.circuit_updates
            : [];
          const observations = Array.isArray(result.observations) ? result.observations : [];
          const validationAlerts = Array.isArray(result.validation_alerts)
            ? result.validation_alerts
            : [];
          const confirmations = Array.isArray(result.confirmations) ? result.confirmations : [];
          const boardOps = Array.isArray(result.board_ops) ? result.board_ops : [];
          const normalised: ExtractionResult = {
            readings,
            field_clears: fieldClears,
            circuit_updates: circuitUpdates,
            observations,
            validation_alerts: validationAlerts,
            confirmations,
            extraction_failed: result.extraction_failed,
            error_message: result.error_message,
            board_ops: boardOps,
          };
          // Wire-shape audit — log the actual keys present on each
          // circuit_update so we can SEE whether the backend is sending
          // {op, circuit_ref, meta} (iOS-flavoured) or {action, circuit,
          // designation} (PWA-flavoured). The mismatch is the prime
          // suspect for "circuit created without a name" in the
          // 2026-05-12 sess_mp2921h7_2dl4 incident.
          const circuitUpdateShapes = circuitUpdates.map((u) => {
            const obj = u as unknown as Record<string, unknown>;
            return {
              keys: Object.keys(obj),
              hasOp: 'op' in obj,
              hasAction: 'action' in obj,
              hasCircuit: 'circuit' in obj,
              hasCircuitRef: 'circuit_ref' in obj,
              hasDesignationTop: 'designation' in obj,
              hasMeta: 'meta' in obj,
              metaHasDesignation:
                typeof obj.meta === 'object' &&
                obj.meta != null &&
                'designation' in (obj.meta as Record<string, unknown>),
            };
          });
          pipelineLog('sonnet_extraction_decoded', {
            readings: readings.length,
            circuit_updates: circuitUpdates.length,
            field_clears: fieldClears.length,
            observations: observations.length,
            validation_alerts: validationAlerts.length,
            confirmations: confirmations.length,
            board_ops: boardOps.length,
            extraction_failed: !!normalised.extraction_failed,
            hasErrorMessage: typeof normalised.error_message === 'string',
            circuit_update_shapes: circuitUpdateShapes,
          });
          this.callbacks.onExtraction?.(normalised);
          // Fire onBoardOps AFTER onExtraction so the caller can apply
          // extraction readings (which may reference circuit refs
          // newly-tagged by an add_board / mark_distribution_circuit
          // op) before mutating boards[]. Empty arrays are still fired
          // so the consumer can no-op idempotently; cheaper than
          // re-checking the length at every call site.
          this.callbacks.onBoardOps?.(boardOps);
        } else {
          pipelineLog('sonnet_extraction_no_result', {});
        }
        break;
      }
      case 'current_board_changed': {
        // Unified broadcast — fires on iOS voice command, Sonnet
        // add_board, Sonnet select_board (`source` discriminator).
        const boardId = typeof json.board_id === 'string' ? json.board_id : '';
        if (!boardId) break;
        const msg: Stage6CurrentBoardChanged = {
          board_id: boardId,
          designation: typeof json.designation === 'string' ? json.designation : null,
          source: typeof json.source === 'string' ? json.source : 'unknown',
        };
        pipelineLog('sonnet_current_board_changed', {
          source: msg.source,
          designation_preview: msg.designation?.slice(0, 40) ?? null,
        });
        this.callbacks.onCurrentBoardChanged?.(msg);
        break;
      }
      case 'select_board_ack': {
        const msg: Stage6SelectBoardAck = {
          ok: Boolean(json.ok),
          board_id: typeof json.board_id === 'string' ? json.board_id : null,
          designation: typeof json.designation === 'string' ? json.designation : null,
          error: typeof json.error === 'string' ? json.error : null,
        };
        pipelineLog('sonnet_select_board_ack', {
          ok: msg.ok,
          hasError: !!msg.error,
        });
        this.callbacks.onSelectBoardAck?.(msg);
        break;
      }
      case 'question': {
        // The server renames Sonnet's `type` → `question_type` before
        // sending so we don't clobber the WS message type. Everything
        // else (question, field, circuit, context) is already flat.
        const { type: _t, ...rest } = json;
        void _t;
        const legacyQuestion = (rest as { question?: unknown }).question;
        clientDiagnostic('legacy_question_decoded', {
          questionLength: typeof legacyQuestion === 'string' ? legacyQuestion.length : 0,
          questionPreview: typeof legacyQuestion === 'string' ? legacyQuestion.slice(0, 80) : '',
          question_type:
            typeof (rest as { question_type?: unknown }).question_type === 'string'
              ? (rest as { question_type: string }).question_type
              : null,
        });
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
        // Diagnostic — log entry on every ask_user_started, before any
        // early-break, so a missing question OR a missing toolCallId is
        // visible from CloudWatch. Pinning the prod sess_moyo7wmd_mdpr
        // pipeline regression where the wire round-trip succeeded but
        // the question never reached the AlertCard / TTS proxy.
        clientDiagnostic('ask_user_started_decoded', {
          questionLength: question.length,
          questionPreview: question.slice(0, 80),
          hasToolCallId: typeof json.tool_call_id === 'string' && json.tool_call_id.length > 0,
          reason: typeof json.reason === 'string' ? json.reason : null,
        });
        if (!question) {
          clientDiagnostic('ask_user_started_dropped_empty_question', {});
          break;
        }
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
        clientDiagnostic('ask_user_started_dispatching_to_onQuestion', {
          hasOnQuestionCallback: typeof this.callbacks.onQuestion === 'function',
          inFlightLatched: this.inFlightToolCallId === toolCallId,
        });
        this.callbacks.onQuestion?.(mapped);
        break;
      }
      case 'observation_update': {
        // BPG4 / regulation refinement of a prior observation. iOS
        // applies this in handleObservationUpdate (DeepgramRecordingViewModel.
        // swift:4954). Server emits AFTER the initial extraction, once
        // the refiner has produced the professional rewrite + regulation
        // hits + schedule_item. Optional fields may be null on older
        // servers; the consumer handles absence cleanly.
        const update: ObservationUpdate = {
          observation_id: (json.observation_id as string | null | undefined) ?? null,
          observation_text: typeof json.observation_text === 'string' ? json.observation_text : '',
          original_text: (json.original_text as string | null | undefined) ?? null,
          code: typeof json.code === 'string' ? json.code : '',
          regulation: (json.regulation as string | null | undefined) ?? null,
          schedule_item: (json.schedule_item as string | null | undefined) ?? null,
          rationale: (json.rationale as string | null | undefined) ?? null,
          // obs-#52 Fix B — canonical wording rides EVERY update path;
          // null (table MISS) must survive decode so the apply layer can
          // CLEAR stale wording rather than keep it.
          regulation_title: (json.regulation_title as string | null | undefined) ?? null,
          regulation_description:
            (json.regulation_description as string | null | undefined) ?? null,
          source: (json.source as string | null | undefined) ?? null,
        };
        // Defensive: skip if the server somehow emitted an empty payload.
        if (!update.observation_text && !update.code) break;
        this.callbacks.onObservationUpdate?.(update);
        break;
      }
      case 'tool_call_started': {
        // Phase 6 stub on iOS too — decode + log. No UI surface yet.
        const tcId = typeof json.tool_call_id === 'string' ? json.tool_call_id : '';
        const tName = typeof json.tool_name === 'string' ? json.tool_name : '';
        if (!tcId || !tName) break;
        const msg: Stage6ToolCallStarted = {
          tool_call_id: tcId,
          tool_name: tName,
          input_preview: (json.input_preview as string | null | undefined) ?? null,
        };
        this.callbacks.onToolCallStarted?.(msg);
        break;
      }
      case 'tool_call_completed': {
        const tcId = typeof json.tool_call_id === 'string' ? json.tool_call_id : '';
        const tName = typeof json.tool_name === 'string' ? json.tool_name : '';
        const outcome = typeof json.outcome === 'string' ? json.outcome : '';
        if (!tcId || !tName) break;
        const msg: Stage6ToolCallCompleted = {
          tool_call_id: tcId,
          tool_name: tName,
          outcome,
          duration_ms: typeof json.duration_ms === 'number' ? json.duration_ms : null,
        };
        this.callbacks.onToolCallCompleted?.(msg);
        break;
      }
      case 'field_corrected': {
        // Stage 6 STI-05 — `clear_reading` dispatched server-side. iOS
        // mutates the underlying job model via Stage6FieldClearer (see
        // DeepgramRecordingViewModel.handleFieldCorrected). On the PWA
        // we route through the existing field_clears extraction path
        // (apply-extraction.ts) — same code that handles bundled
        // field_clears today, so the clear lands as a single mutation
        // and the LiveFillView flash fires identically.
        const circuit = typeof json.circuit === 'number' ? json.circuit : null;
        const field = typeof json.field === 'string' ? json.field : '';
        if (circuit == null || !field) break;
        const msg: Stage6FieldCorrected = {
          circuit,
          field,
          previous_value: (json.previous_value as string | null | undefined) ?? null,
          reason: (json.reason as string | null | undefined) ?? null,
        };
        this.callbacks.onFieldCorrected?.(msg);
        break;
      }
      case 'circuit_created': {
        const ref = typeof json.circuit_ref === 'number' ? json.circuit_ref : null;
        if (ref == null) break;
        const msg: Stage6CircuitCreated = {
          circuit_ref: ref,
          designation: (json.designation as string | null | undefined) ?? null,
          rating_amps: typeof json.rating_amps === 'number' ? json.rating_amps : null,
        };
        this.callbacks.onCircuitCreated?.(msg);
        break;
      }
      case 'circuit_updated': {
        const ref = typeof json.circuit_ref === 'number' ? json.circuit_ref : null;
        if (ref == null) break;
        const msg: Stage6CircuitUpdated = {
          circuit_ref: ref,
          designation: (json.designation as string | null | undefined) ?? null,
          rating_amps: typeof json.rating_amps === 'number' ? json.rating_amps : null,
        };
        this.callbacks.onCircuitUpdated?.(msg);
        break;
      }
      case 'observation_deleted': {
        const id = typeof json.observation_id === 'string' ? json.observation_id : '';
        if (!id) break;
        const msg: Stage6ObservationDeleted = {
          observation_id: id,
          reason: (json.reason as string | null | undefined) ?? null,
        };
        this.callbacks.onObservationDeleted?.(msg);
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
      case 'chitchat_paused': {
        // iOS canon: DeepgramRecordingViewModel.swift:6849. Backend
        // emits this after 10 consecutive zero-engagement turns.
        this.callbacks.onChitchatPaused?.();
        break;
      }
      case 'chitchat_resumed': {
        // iOS canon: DeepgramRecordingViewModel.swift:6855. The
        // `reason` field is informational (logged for diagnostics);
        // the UI just clears the banner.
        const reason = typeof json.reason === 'string' ? json.reason : '';
        this.callbacks.onChitchatResumed?.(reason);
        break;
      }
      case 'cancel_pending_tts': {
        // iOS Phase 6.3 parity. Backend emits this on every *_script_cancelled
        // (engine.js:1020-1024) to silence a stale focused-mode script prompt
        // by prefix `srv-<script>-`. Ignore an empty/missing prefix (nothing
        // to target). The consumer (recording-context handleCancelPendingTts)
        // cancels the DIRECT speak()/deferredTtsRef prompt + clears its ask
        // state; forward-looking, it also purges the confirmation FIFO by
        // prefix (no-op today — confirmations carry no cancelKey).
        const prefix = typeof json.prefix === 'string' ? json.prefix : '';
        const sessionId = typeof json.sessionId === 'string' ? (json.sessionId as string) : null;
        clientDiagnostic('cancel_pending_tts_decoded', {
          hasPrefix: prefix.length > 0,
          prefixPreview: prefix.slice(0, 24),
        });
        if (!prefix) break;
        this.callbacks.onCancelPendingTts?.({ prefix, sessionId });
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
