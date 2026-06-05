/**
 * Stage 6 Phase 2 Plan 02-06 — Shadow harness (REWIRED).
 *
 * Phase 1 canned-replay is REPLACED. Under SONNET_TOOL_CALLS=shadow, this
 * harness now drives the REAL multi-round tool loop (Plan 01-04 runToolLoop)
 * with the Wave-2 dispatcher table (Plans 02-02 + 02-03 + 02-04) and the
 * Wave-2 event bundler (Plan 02-05), then projects both the legacy result
 * and the bundled tool-call result through Plan 02-06's slot comparator and
 * logs `stage6_divergence` with the projection + divergence verdict.
 *
 * REQUIREMENTS: STT-03 (multi-round) + STT-09 (same-turn correction) +
 * STO-01 (per-turn divergence log).
 * RESEARCH: §Q11 (shadow comparator) + Pitfall #2 (per-turn state isolation)
 * + Pitfall #3 (bundler fires ONCE post-loop) + Pitfall #6 (shadow mode =
 * real API spend — cost logged per row for Phase 7 retrospective).
 *
 * ---------------------------------------------------------------------------
 * MODES
 * ---------------------------------------------------------------------------
 *   'off'    (default) — pure passthrough. legacy only. ZERO API overhead.
 *                        Phase-2 success criterion #6 (shadow-off idempotency)
 *                        holds: when the env flag is unset, calling this
 *                        harness is indistinguishable from calling
 *                        session.extractFromUtterance directly.
 *   'shadow' — run legacy FIRST (iOS gets legacy result, byte-identical),
 *              then run runToolLoop against the same transcript, bundle,
 *              compare, log. Returns LEGACY result. Any shadow failure
 *              is caught + logged at warn; legacy still returned.
 *   'live'   — Phase 7 gate. THROWS. Same as Phase 1's loud-failure guard.
 *              Prevents a mis-set env var from surprising production with
 *              authoritative tool-call dispatch before Phase 7 ships.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHY live MODE STILL THROWS (not "return legacy silently"):
 * ---------------------------------------------------------------------------
 * Phase 1 established this contract (stage6-shadow-harness.js pre-Phase-2
 * throw) and the tool-loop test suite asserts it. A silent bypass would
 * mask a deployment bug: someone set SONNET_TOOL_CALLS=live before Phase 7
 * landed. Loud failure here is a deliberate safety net. The MINOR-2 test
 * in stage6-tool-loop-e2e.test.js pins this behaviour.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * ANTHROPIC CLIENT SURFACE
 * ---------------------------------------------------------------------------
 * EICRExtractionSession exposes `session.client` (Anthropic SDK instance —
 * see eicr-extraction-session.js:164) and `session.systemPrompt` (per-cert-
 * type prompt — line 173). There is no `session.model` field; the session
 * uses the literal 'claude-sonnet-4-6' at call sites (line 365, 823). This
 * harness matches: SHADOW_MODEL = 'claude-sonnet-4-6'.
 *
 * NOTE on cache_control: runToolLoop forwards `system` opaquely to
 * client.messages.stream({system, ...}). Anthropic's prompt-caching
 * contract requires `system` as an array-of-blocks when cache_control is
 * applied. Plan 04-11 r5-#1 — the harness now delegates to
 * session.buildSystemBlocks() so shadow mode mirrors EXACTLY the same
 * two-block cached-prefix shape the live path ships (base prompt +
 * cached snapshot, both {type:'ephemeral', ttl:'5m'}). This keeps shadow
 * and live on the same cache key AND ensures shadow carries the cached
 * snapshot Phase 4 STQ-03 introduced — without which Phase 7 STR-03
 * divergence would be measuring "shadow-no-snapshot vs live-with-snapshot"
 * (contaminated baseline).
 * ---------------------------------------------------------------------------
 */

import logger from '../logger.js';
import { lookupPostcode } from '../postcode_lookup.js';
import { applyPostcodeLookupToSnapshot } from './postcode-snapshot-applier.js';
import { runToolLoop } from './stage6-tool-loop.js';
// Loaded Barrel Phase 2.B/2.C wire-up (plan v10 §C). Per-turn
// speculator instantiation in runLiveMode. Cache state is module-
// scoped so cross-turn entries survive without keeping the
// speculator object around.
import { createSpeculator } from './loaded-barrel-speculator.js';
import { getVoiceLatencyForSession, getActiveSessionEntry } from './active-sessions.js';
// Fix A 2026-06-02 — broadcast-intent skip for the speculator. Detection
// happens here (same place we mint turnId + resolve entry) so the per-turn
// broadcastIntentByTurn map is populated BEFORE runToolLoop wires the
// speculator hooks; otherwise a fast first record_reading from Sonnet
// could read the map before it's written.
import { detectBroadcastIntent } from './dialogue-engine/parsers/circuit-range.js';
// Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8).
import { emitTurnCoreSummary, startAudioFinalizer } from './voice-latency-turn-summary.js';
import { getElevenLabsKey } from '../services/secrets.js';
import {
  createWriteDispatcher,
  createToolDispatcher,
  createAutoResolveWriteHook,
  createSortRecordsAsksLast,
} from './stage6-dispatchers.js';
import { createAskDispatcher } from './stage6-dispatcher-ask.js';
// Stage 6 Phase 5 Plan 05-01 — higher-order composition of the four
// Phase 5 gates (filled-slots shadow / restrained-mode / per-key budget /
// 1500ms debounce) around the unmodified Plan 03-05 createAskDispatcher.
// The branch below activates ONLY when sonnet-stream.js threads
// options.askBudget AND options.restrainedMode through (Plans 05-03 +
// 05-04 wire the activeSessions entry); without both, runShadowHarness
// reverts to the Phase 3/4 dispatcher shape unchanged.
import { createAskGateWrapper, wrapAskDispatcherWithGates } from './stage6-ask-gate-wrapper.js';
import { createPerTurnWrites } from './stage6-per-turn-writes.js';
import {
  bundleToolCallsIntoResult,
  BUNDLER_PHASE,
  applyConfirmationDebounce,
} from './stage6-event-bundler.js';
import { compareSlots } from './stage6-slot-comparator.js';
import { TOOL_SCHEMAS } from './stage6-tool-schemas.js';
import {
  tryResumePausedScript,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
} from './dialogue-engine/index.js';
import { FIELD_CORRECTIONS } from './field-name-corrections.js';

/**
 * Sonnet model literal used by shadow-mode tool loop. Mirrors the literal at
 * eicr-extraction-session.js:365,823. If the session ever takes a configurable
 * model, thread it through here.
 */
// 2026-06-01 — harness-cost work: a single env var unifies the extraction
// model across keepalive (eicr-extraction-session.js:1681), main
// extraction (line 2273) and the stage6 tool loop here. Same default as
// production; harness runs set SONNET_EXTRACT_MODEL=claude-haiku-4-5 to
// drop costs ~10×. The keepalive at the other two sites uses the SAME
// env var on purpose — the prompt cache is keyed by model, so the three
// call sites MUST agree or the cache misses every turn.
const SHADOW_MODEL = (process.env.SONNET_EXTRACT_MODEL || 'claude-sonnet-4-6').trim();

/**
 * Bug-H fix (2026-04-28) — rewrite Stage 6 per-turn observations into the
 * legacy iOS-compatible wire shape. See the call site in `runShadowHarness`
 * for the full motivation; this function is exported so the unit test can
 * pin the exact key mapping without standing up the full harness graph.
 *
 * Stage 6 dispatcher emits      → iOS `SonnetObservation` decodes from
 *   id                          →   observation_id
 *   text                        →   observation_text   (REQUIRED on iOS)
 *   location                    →   item_location
 *   suggested_regulation        →   regulation
 *   code                        →   code               (unchanged)
 *
 * `circuit` is preserved (server-side `refineObservationsAsync` uses it; iOS
 * ignores unknown keys). `schedule_item` is iOS-known and now populated by
 * Stage 6 (2026-05-01 restoration) — passes through to iOS so the
 * `ObservationScheduleLinker` can auto-tick the matching Schedule of
 * Inspection row.
 */
export function renameObservationsForLegacyWire(observations) {
  if (!Array.isArray(observations)) return observations;
  return observations.map((obs) => {
    if (!obs || typeof obs !== 'object') return obs;
    const renamed = {
      observation_id: obs.observation_id ?? obs.id ?? null,
      code: obs.code ?? null,
      observation_text: obs.observation_text ?? obs.text ?? '',
      item_location: obs.item_location ?? obs.location ?? null,
      regulation: obs.regulation ?? obs.suggested_regulation ?? null,
      schedule_item: obs.schedule_item ?? null,
    };
    if (obs.circuit !== undefined) renamed.circuit = obs.circuit;
    return renamed;
  });
}

/**
 * Convert the projected slot shape (Map / Set) into a JSON-safe plain object
 * for structured logging. Phase 7 analyzer reads these from CloudWatch — they
 * must round-trip through JSON.stringify.
 */
function serialiseSlots(slots) {
  return {
    readings: Object.fromEntries(slots.readings),
    cleared: [...slots.cleared],
    observations: [...slots.observations],
    circuit_ops: [...slots.circuit_ops],
    observation_deletions: [...slots.observation_deletions],
  };
}

/**
 * Estimate shadow-mode cost from the tool-loop output's usage accumulator.
 *
 * Phase 2 contract: `runToolLoop` does NOT currently accumulate token usage
 * across rounds (its signature returns {stop_reason, rounds, tool_calls,
 * aborted, messages_final} — no `.usage`). We log `null` here and let the
 * Phase 7 analyzer estimate cost retrospectively from the stored message
 * lengths + model pricing constants. Adding a usage accumulator to
 * runToolLoop is deliberate scope creep; Phase 7 owns that.
 */
function estimateShadowCost(/* toolLoopOut */) {
  return null;
}

/**
 * 2026-04-26 (Bug-B pivot) — LIVE MODE handler.
 *
 * Drives the Stage 6 agentic tool loop directly with NO legacy fallback. iOS
 * receives the bundler's projected result as the authoritative extraction
 * payload. Trade-offs vs shadow mode:
 *   + No prompt-vs-parser mismatch possible (single path, single prompt).
 *   + Real problems surface immediately — no silent shadow divergence to
 *     mask iOS-visible breakage.
 *   - No legacy backup if Sonnet's tool calls fail. Fallback path is the
 *     env-var rollback (`SONNET_TOOL_CALLS=off`, 2-minute ECS redeploy).
 *
 * Differences from shadow mode:
 *   - Legacy `extractFromUtterance` is NOT called. The session.stateSnapshot
 *     is mutated DIRECTLY by the tool dispatchers (no clone/compare dance).
 *   - `stage6_divergence` is not logged (nothing to compare against).
 *   - The bundler's `extracted_board_readings` slot is folded INTO
 *     `extracted_readings` with `circuit: 0` so iOS Build 282 (which
 *     decodes `extracted_readings[].circuit === 0` as supply-scoped per the
 *     legacy contract — see DeepgramRecordingViewModel.swift:866) renders
 *     supply readings without an iOS update.
 *
 * @param {Object} session  Real EICRExtractionSession (live state mutates).
 * @param {string} transcriptText
 * @param {Array} regexResults
 * @param {Object} options
 * @param {Object} log  Logger.
 */
async function runLiveMode(session, transcriptText, regexResults, options, log) {
  const turnNum = (session.turnCount ?? 0) + 1;
  const turnId = `${session.sessionId}-turn-${turnNum}`;

  // ───────────────────────────────────────────────────────────────
  // Postcode lookup → snapshot apply. 2026-06-02 — Codex round 5
  // empirical finding (matrix harness vs prod 2026-06-01): commit
  // db85f825's county-drift fix was wired ONLY into
  // `_extractSingle` (eicr-extraction-session.js:1957-2005), which
  // is the legacy `extractFromUtterance` path. `runLiveMode` (the
  // production SONNET_TOOL_CALLS=live path) never called it, so the
  // structural override that should clamp town/county to the
  // postcodes.io canonical values when iOS's regex hint carries
  // `install.postcode` was effectively unwired in prod for every
  // session.
  //
  // Empirical confirmation from harness run 2026-06-01: address
  // transcripts in live mode wrote address/town/postcode but never
  // county. Sessions B95B2EE1 + D68ACD24 (2026-05-31 field tests)
  // landed county="South East" — exactly the regression
  // applyPostcodeLookupToSnapshot was designed to prevent, but the
  // applier never ran.
  //
  // Wiring identical to `_extractSingle` so the SAME policy applies
  // in both paths (lookup wins on empty OR on Sonnet drift to a UK
  // ITL1 region; manual edits preserved). Runs BEFORE
  // `runToolLoop` so the snapshot Sonnet reads via the cached
  // system prompt (`buildSystemBlocks`) reflects the canonical
  // values — Sonnet's same-value-skip then naturally avoids
  // re-writing town/county and the override sticks.
  //
  // Failure modes are absorbed: a postcodes.io 5xx / network timeout
  // logs a warn but never throws, exactly like the legacy path.
  // ───────────────────────────────────────────────────────────────
  let postcodeLookupResult = null;
  if (Array.isArray(regexResults) && regexResults.length > 0) {
    const postcodeEntry = regexResults.find((r) => r && r.field === 'install.postcode' && r.value);
    if (postcodeEntry) {
      try {
        const lookup = await lookupPostcode(postcodeEntry.value);
        if (lookup) {
          postcodeLookupResult = {
            postcode: lookup.postcode,
            town: lookup.town,
            county: lookup.county,
            valid: true,
          };
          log?.info?.(
            `Session ${session.sessionId} Postcode lookup (live): ${postcodeEntry.value} → ${lookup.town}, ${lookup.county}`
          );
        } else {
          postcodeLookupResult = { postcode: postcodeEntry.value, valid: false };
          log?.info?.(
            `Session ${session.sessionId} Postcode lookup (live): ${postcodeEntry.value} → not found`
          );
        }
      } catch (err) {
        log?.warn?.(`Session ${session.sessionId} Postcode lookup (live) failed: ${err.message}`);
      }
    }
  }
  applyPostcodeLookupToSnapshot(session.stateSnapshot, postcodeLookupResult, session.sessionId);

  // Per-turn writes accumulator. Function-local — never stored on session
  // (Pitfall #2 — cross-turn leak prevention from shadow harness).
  const perTurnWrites = createPerTurnWrites();

  // Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8.4) + Phase 1
  // (Pivot 9, 12.2). Resolve the activeSessions entry once at the top so
  // we can: (a) seed `fastPathCorrelationIdByTurn` from
  // `options.regexFastCorrelationId` so the audio finalizer's
  // pre-decrement drain has the right correlation set; (b) read the
  // VOICE_LATENCY_ROUND1_EARLY_TERMINATE snapshot flag to gate the new
  // Phase 2 predicate inside runToolLoop. Anything that mutates the
  // entry's per-turn maps below MUST be torn down in the `finally`
  // block below the main body — error paths would otherwise leak this
  // turn's entry forward and the speculator skip check would fire on a
  // stale slot.
  const entry = getActiveSessionEntry(session.sessionId);
  if (entry) {
    const rawCid = options?.regexFastCorrelationId;
    // Accept legacy single-string shape AND array shape; coerce both
    // into a Set so callers don't have to remember which is which.
    const cids = new Set();
    if (typeof rawCid === 'string' && rawCid) cids.add(rawCid);
    else if (Array.isArray(rawCid)) {
      for (const cid of rawCid) {
        if (typeof cid === 'string' && cid) cids.add(cid);
      }
    }
    if (cids.size > 0 && entry.fastPathCorrelationIdByTurn instanceof Map) {
      entry.fastPathCorrelationIdByTurn.set(turnId, cids);
    }
    // Fix A 2026-06-02 (handoff §A) — populate broadcastIntentByTurn so the
    // speculator's preflight can skip per-circuit synth on broadcast turns.
    // Write must happen BEFORE runToolLoop is invoked so the very first
    // streamed record_reading hook sees the flag — Sonnet can emit tool_use
    // blocks within tens of ms of the request, and the speculator reads the
    // map synchronously in _speculate. Detection is a single regex pass on
    // the transcript (BROADCAST_ALL/RANGE/LIST patterns) — same helper the
    // engine's processDialogueTurn pre-filter uses. Map.set is idempotent
    // on turnId; only `true` is stored (absent === false at read sites).
    if (entry.broadcastIntentByTurn instanceof Map) {
      if (detectBroadcastIntent(transcriptText)) {
        entry.broadcastIntentByTurn.set(turnId, true);
      }
    }
  }
  const vlFlags = entry?.voiceLatency?.flags ?? null;
  const earlyTerminateEnabled = vlFlags?.round1EarlyTerminate === true;

  // Phase 0 server-side audible-first-byte clock + counters.
  const runLiveStartNs = process.hrtime.bigint();

  // Stash this turn's raw transcript on the session so dispatchers
  // (notably dispatchStartDialogueScript) can read it without having to
  // thread the text down through ctx. Pre-fix: only the engine's regex
  // entry path saw the text and ran detectBroadcastIntent; Sonnet-
  // initiated start_dialogue_script had no visibility, so e.g.
  // "Insulation resistance for all circuits live to live is greater than
  // 299" would correctly bypass the regex entry — but Sonnet would then
  // call start_dialogue_script(ir) anyway and the IR walk-through would
  // ask "Which circuit?" with no broadcast guard. The finally below
  // clears the field so cross-turn reads are impossible.
  session.activeTurnTranscript = transcriptText;

  // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 12.2). Wrap the
  // body in try/finally so the per-turn entry maps are always torn down
  // even if the runToolLoop / bundler / observation refinement path
  // throws unexpectedly. The early-return on the runToolLoop catch
  // below also flows through this finally. Without it, error paths
  // would leak this turn's pendingFastTtsSlots / fastPathCorrelationIdByTurn
  // entries forward and the next turn's speculator preflight would skip
  // synth on a stale slot.
  try {
    // Build the dispatcher session that the tool dispatchers mutate. In LIVE
    // mode we want mutations to land on the LIVE session, not a clone — there's
    // no comparison and iOS state IS the live state.
    //
    // Field test 2026-05-01 session DFA7FDBF — a previous version of this block
    // built a fresh `{sessionId, stateSnapshot, extractedObservations,
    // toolCallsMode:'live'}` literal. `stateSnapshot` and `extractedObservations`
    // were reference-copied so mutations through them propagated, but a NEW
    // top-level property assignment — specifically `dialogueScriptState` set by
    // `enterScriptByName` from the `start_dialogue_script` tool — landed on the
    // per-turn literal and was thrown away when the turn ended. Next turn, the
    // engine read `entry.session.dialogueScriptState`, found undefined, and
    // returned handled:false. The walk-through asked "Which circuit?" once and
    // then the answer fell through to Sonnet because the active-state memory
    // was on a binned object. Aliasing `session` directly is the minimal fix —
    // matches what the comment above (and the pre-clone original) always
    // intended. Cross-turn regression coverage in
    // stage6-dialogue-script-state-persists.test.js.
    const liveSession = session;

    // Phase 5 ask-gate composition (same as shadow mode, but reading from the
    // live session). Falls back to write-only dispatcher if the caller didn't
    // thread pendingAsks through (Phase 3/4 back-compat).
    const pendingAsks = options.pendingAsks ?? null;
    const ws = options.ws ?? null;
    // Pass `ws` through createWriteDispatcher's extraCtx so the
    // start_dialogue_script dispatcher (added 2026-04-30 Silvertown
    // follow-up) can hand it to enterScriptByName for first-ask emission.
    // Other dispatchers in the table ignore it.
    const writes = createWriteDispatcher(liveSession, log, turnId, perTurnWrites, { ws });
    // 2026-04-27 — bug-1B fix. Hook the ask dispatcher's server-side resolution
    // path into the normal write infrastructure: when ask_user carries a
    // pending_write and the user's reply matches a circuit deterministically,
    // the ask dispatcher invokes this hook to dispatch the buffered write
    // through perTurnWrites + state snapshot + log rows in the same shape a
    // Sonnet-direct write would have. Closure captures liveSession so the
    // mutation lands on the same state Sonnet sees on the next turn.
    const liveAutoResolveWrite = createAutoResolveWriteHook(
      liveSession,
      log,
      turnId,
      perTurnWrites
    );
    let dispatcher;
    let sortRecords;
    let askGateForTurn = null;
    if (pendingAsks) {
      let asks = createAskDispatcher(liveSession, log, turnId, pendingAsks, ws, {
        fallbackToLegacy: options.fallbackToLegacy === true,
        autoResolveWrite: liveAutoResolveWrite,
        // 2026-05-26 — chitchat panic-ask streak notifier. Forwarded
        // verbatim from sonnet-stream.js's runShadowHarness call site;
        // closes over the WS-entry chitchatState that lives in
        // activeSessions. Optional — when omitted, the dispatcher
        // no-ops the notify step.
        chitchatNotifier: options.chitchatNotifier,
      });
      if (options.askBudget && options.restrainedMode) {
        askGateForTurn = createAskGateWrapper({
          logger: log,
          sessionId: liveSession.sessionId,
          mode: 'live',
        });
        asks = wrapAskDispatcherWithGates(asks, {
          askBudget: options.askBudget,
          restrainedMode: options.restrainedMode,
          gate: askGateForTurn,
          filledSlotsShadow: options.filledSlotsShadow ?? (() => {}),
          logger: log,
          sessionId: liveSession.sessionId,
          mode: 'live',
        });
      }
      dispatcher = createToolDispatcher(writes, asks);
      sortRecords = createSortRecordsAsksLast();
    } else {
      dispatcher = writes;
      sortRecords = undefined;
    }

    // Drive the tool loop. The agentic prompt + state snapshot live in the
    // cached prefix per buildAgenticSystemBlocks. iOS Build 282 doesn't yet
    // know about the new tool-call message types — for now we don't emit them
    // mid-loop; iOS sees ONE `extraction` message at the end of the turn,
    // built from the bundler.
    const systemBlocks = session.buildAgenticSystemBlocks
      ? session.buildAgenticSystemBlocks()
      : session.buildSystemBlocks();

    // Loaded Barrel wire-up (plan v10 §C). Speculator instantiated per
    // turn — the cache is module-scope so cross-turn state persists
    // there; per-turn cap counter resets per-instance which matches the
    // plan's semantics. Skip entirely when:
    //   - voiceLatency snapshot unavailable (older harness call sites)
    //   - flag VOICE_LATENCY_LOADED_BARREL is OFF (default in prod)
    //   - session.costTracker missing (defensive; cost ledger required)
    // 2026-05-28 mid-stream extraction emit (lever 1). Track slots whose
    // audio was preliminarily emitted via the speculator's onSlotAudioReady
    // hook so the canonical bundler emit at end-of-round can skip them
    // (avoids iOS double-receiving the same reading + double-playing the
    // confirmation). Per-turn — the Set is scoped to this runLiveMode call.
    const midStreamEmittedSlots = new Set();
    let speculator = null;
    try {
      const vl = getVoiceLatencyForSession(session.sessionId);
      if (vl?.flags?.loadedBarrel === true && session.costTracker) {
        speculator = createSpeculator({
          sessionId: session.sessionId,
          // apiKey via fn so a secret rotation survives without re-instantiation.
          apiKey: () => getElevenLabsKey(),
          costTracker: session.costTracker,
          logger: log,
          // 2026-05-28 mid-stream emit. Fires the moment the speculator's
          // ElevenLabs synth completes + the cache CAS confirms ready.
          // Pushes a preliminary `extraction` WS message with just this
          // slot's reading + confirmation so iOS can POST for the cached
          // audio ~500-720 ms BEFORE Sonnet's round-1 stream completes.
          // Production turn_core_summary timings (turn 11, session DFE90C4F)
          // showed loaded_barrel_fired at 07.300 vs canonical emit at
          // 07.822 — the wrap-up window we're cutting.
          //
          // Slot tracking: each emitted slot keyed by (field, circuit,
          // boardId) so the canonical end-of-round emit can filter them
          // out of `extracted_readings` / `confirmations`. iOS already
          // accumulates extractions idempotently (RollingExtractionResult),
          // but filtering avoids double-POSTing for the same audio.
          onSlotAudioReady: ws
            ? (slot) => {
                if (!slot || !ws || ws.readyState !== ws.OPEN) return;
                const slotKey = `${slot.field}::${slot.circuit ?? 0}::${slot.boardId ?? ''}`;
                if (midStreamEmittedSlots.has(slotKey)) return;
                midStreamEmittedSlots.add(slotKey);
                // Build a minimal extraction envelope mirroring the
                // bundler's wire shape. iOS's handleServerExtraction
                // applies extractedReadings + iterates confirmations
                // for TTS POSTs. Empty arrays for other channels keep
                // the decoder happy on legacy/strict builds.
                const reading = {
                  field: slot.field,
                  value: slot.value,
                  confidence: slot.confidence,
                  source: 'tool_call',
                };
                // Canonical bundler at stage6-event-bundler.js:177-180 emits
                // `circuit` as Int when parseable. iOS' ExtractedReading
                // (CertMateUnified/Sources/Services/ClaudeService.swift:54)
                // is typed `let circuit: Int`. The prior shape sent a
                // string here, which made iOS' Codable decoder reject the
                // entire preliminary frame and silently drop the reading
                // (it was caught by the catch-all at
                // ServerWebSocketService.swift:922). Aligning the
                // preliminary's circuit type with the canonical bundler
                // makes the speculator preview actually land in the UI.
                if (Number.isInteger(slot.circuit)) reading.circuit = slot.circuit;
                else reading.circuit = 0;
                if (slot.boardId != null) reading.board_id = slot.boardId;
                const confirmation = {
                  text: slot.text,
                  expanded_text: slot.expandedText,
                  field: slot.field,
                  circuit: Number.isInteger(slot.circuit) ? slot.circuit : null,
                };
                if (slot.boardId != null) confirmation.board_id = slot.boardId;
                const envelope = {
                  type: 'extraction',
                  result: {
                    readings: [reading],
                    confirmations: [confirmation],
                    observations: [],
                    cleared_readings: [],
                    circuit_updates: [],
                    board_ops: [],
                    validation_alerts: [],
                    questions: [],
                    turn_id: turnId,
                    mid_stream_preview: true,
                  },
                };
                try {
                  ws.send(JSON.stringify(envelope));
                  log?.info?.('voice_latency.mid_stream_emit', {
                    sessionId: session.sessionId,
                    turnId,
                    field: slot.field,
                    circuit: slot.circuit,
                    boardId: slot.boardId,
                    correlationId: slot.correlationId,
                    expanded_text: slot.expandedText,
                  });
                } catch (sendErr) {
                  log?.warn?.('voice_latency.mid_stream_emit_error', {
                    sessionId: session.sessionId,
                    turnId,
                    error: sendErr?.message,
                  });
                }
              }
            : null,
        });
      }
    } catch (specErr) {
      // Never let speculator-setup errors break the live tool loop.
      log?.warn?.('voice_latency.loaded_barrel.speculator_setup_error', {
        sessionId: session.sessionId,
        error: specErr?.message,
      });
      speculator = null;
    }

    let toolLoopOut;
    try {
      toolLoopOut = await runToolLoop({
        client: session.client,
        model: SHADOW_MODEL,
        system: systemBlocks,
        messages: [{ role: 'user', content: transcriptText }],
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: { sessionId: session.sessionId, turnId },
        logger: log,
        sortRecords,
        // Loaded Barrel hooks — onSnapshotPatch / onLoopComplete are
        // passed only when the speculator exists, so a flag-off prod
        // session has zero overhead. The wrapper checks function-ness
        // before calling.
        //
        // Single-round latency sprint Phase 2 (PLAN_v8 §A Pivot 1, Codex
        // round-3 I4 fix): perTurnWritesRef is now passed UNCONDITIONALLY,
        // independent of speculator state. The Phase 2 early-terminate
        // predicate needs to read perTurnWrites whether or not Loaded
        // Barrel is on. The runToolLoop wrapper still no-ops the function
        // when undefined (back-compat with tests that don't supply it).
        perTurnWritesRef: () => perTurnWrites,
        onSnapshotPatch: speculator?.onSnapshotPatch,
        onLoopComplete: speculator?.onLoopComplete,
        // Single-round latency sprint Phase 2 (PLAN_v8 §A Pivot 1).
        // Always pass earlyTerminateEnabled + earlyTerminateSession so
        // the predicate fires when the flag is on, regardless of LB
        // state. Predicate guards on session.stateSnapshot internally,
        // so passing the live session through is safe.
        earlyTerminateEnabled,
        earlyTerminateSession: earlyTerminateEnabled ? session : undefined,
        // Loaded Barrel Phase 2.D (2026-05-25) — streamed-tool hook. Fires
        // INSIDE the per-round stream loop as each tool_use's
        // content_block_stop arrives, so the speculator can begin
        // ElevenLabs pre-synth while Sonnet is still streaming subsequent
        // tool_use blocks. Multi-tool turns save ~hundreds of ms per
        // tool. Dedup via cachePeek inside _speculate ensures the
        // onSnapshotPatch fire that arrives later doesn't double-synth.
        onToolUseStreamed: speculator?.onToolUseStreamed,
        // 2026-05-26 voice-latency fix: force tool emission first on
        // round-1 so the streamed-speculation hook fires near the start
        // of Sonnet's response (not the end). See the `toolChoiceAnyOnRound1`
        // docstring in stage6-tool-loop.js for the repro (session 904344CD,
        // every bundler turn showed loaded_barrel_hit_pending because the
        // tool_use streamed at end-of-Sonnet, leaving ElevenLabs no time
        // to finish synth before iOS asked for the audio). Defaults ON so
        // the deploy realises the win without an out-of-band env-var step;
        // flip `VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1=false` on the task
        // def to disable in production without a code roll.
        toolChoiceAnyOnRound1: process.env.VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1 !== 'false',
      });
    } catch (err) {
      askGateForTurn?.destroy();
      try {
        log.error?.('stage6_live_error', {
          sessionId: session.sessionId,
          turnId,
          phase: 'live',
          error: err?.message ?? String(err),
        });
      } catch {
        // swallow logger failure — never break extraction
      }
      // No legacy fallback in live mode. Return an empty extraction so
      // iOS sees "no readings this turn" rather than crashing on undefined.
      // The error is in CloudWatch for diagnosis; rollback path is env-flip.
      return {
        extracted_readings: [],
        observations: [],
        questions: [],
      };
    }

    askGateForTurn?.destroy();

    // Bundle the per-turn writes into the legacy iOS shape. Pass null for
    // legacyResultShape — there's no legacy result; bundler will produce
    // `questions: []` from that.
    //
    // confirmationsEnabled flows from sonnet-stream.js (transcript message
    // `confirmations_enabled` flag, set by iOS when the user toggles the
    // Voice button ON) through options into the bundler's synthesis step
    // (stage6-event-bundler.js:9). Live mode has no legacy.confirmations
    // source so synthesis is the only path that populates result.confirmations.
    // 2026-05-29 — build the circuit-designation map for confirmation
    // TTS. Source priority: same-turn circuit_designation writes (Sonnet
    // just renamed circuit N) > existing snapshot value. Both keyed by
    // numeric circuit_ref; the bundler tolerates either number or string
    // keys via Map.get coercion.
    const circuitDesignations = new Map();
    const snapshotCircuits = session?.stateSnapshot?.circuits;
    if (snapshotCircuits && typeof snapshotCircuits === 'object') {
      for (const [key, circ] of Object.entries(snapshotCircuits)) {
        if (!circ || typeof circ !== 'object') continue;
        const refNum = Number(key);
        if (!Number.isInteger(refNum) || refNum <= 0) continue;
        const d = circ.circuit_designation;
        if (typeof d === 'string' && d.trim()) {
          circuitDesignations.set(refNum, d.trim());
        }
      }
    }
    // Overlay: same-turn circuit_designation writes win. Sonnet emitting
    // create_circuit + record_reading(designation) + record_reading(zs)
    // in one turn must hear "Cooker, Zs 0.62" — not "Circuit 4, Zs 0.62".
    for (const [key, entry] of perTurnWrites.readings ?? new Map()) {
      // Bundler's decodeReadingKey is what splits these in production;
      // here we just need the field + circuit prefix, so a string parse
      // suffices.
      const m = /^circuit_designation::(\d+)(?:\0|$)/.exec(key);
      if (!m) continue;
      const refNum = Number(m[1]);
      const valueStr = String(entry?.value ?? '').trim();
      if (Number.isInteger(refNum) && refNum > 0 && valueStr) {
        circuitDesignations.set(refNum, valueStr);
      }
    }

    // 2026-05-29 — board designations for state-change select_board TTS.
    // Built from session snapshot so "Switched to the kitchen sub-board"
    // resolves on a select_board op carrying only board_id. Inline same-
    // turn add_board designations win over the snapshot so a freshly-
    // added-then-selected board speaks with its new name.
    const boardDesignations = new Map();
    const snapshotBoards = session?.stateSnapshot?.boards;
    if (Array.isArray(snapshotBoards)) {
      for (const b of snapshotBoards) {
        if (
          b &&
          typeof b.id === 'string' &&
          typeof b.designation === 'string' &&
          b.designation.trim()
        ) {
          boardDesignations.set(b.id, b.designation.trim());
        }
      }
    }
    if (Array.isArray(perTurnWrites.boardOps)) {
      for (const op of perTurnWrites.boardOps) {
        if (
          op.op === 'add_board' &&
          op.board_id &&
          typeof op.designation === 'string' &&
          op.designation.trim()
        ) {
          boardDesignations.set(op.board_id, op.designation.trim());
        }
      }
    }

    // Count of distinct circuits on the CURRENT board (board scope
    // matters: a "for all circuits" broadcast on sub-board B should
    // measure against B's circuit count, not A+B combined). Falls
    // back to a board-agnostic count if no currentBoardId is set
    // (legacy single-board jobs).
    let totalCircuitsInJob = 0;
    if (snapshotCircuits && typeof snapshotCircuits === 'object') {
      const currentBoardId = session?.stateSnapshot?.currentBoardId ?? null;
      for (const [key, circ] of Object.entries(snapshotCircuits)) {
        if (!circ || typeof circ !== 'object') continue;
        const refNum = Number(key);
        if (!Number.isInteger(refNum) || refNum <= 0) continue;
        if (currentBoardId && circ.board_id && circ.board_id !== currentBoardId) continue;
        totalCircuitsInJob += 1;
      }
    }

    const result = bundleToolCallsIntoResult(perTurnWrites, null, {
      confirmationsEnabled: options.confirmationsEnabled === true,
      // Loaded Barrel Phase 4a — emit result.turn_id so iOS can round-
      // trip it on the /api/proxy/elevenlabs-tts POST body for cache
      // lookup. Omitted when undefined; legacy decoders ignore unknown
      // keys via Swift Codable's tolerant decode.
      turnId,
      // Voice-latency plan 2026-06-05 Phase 2.1 — thread iOS-minted
      // utterance_id of the inbound transcript so the bundler emits
      // result.utterance_id. iOS pairs it with pendingUtteranceEnds
      // (DeepgramRecordingViewModel.swift:8607-8628) to fire the
      // non-orphan voice-latency utterance-end POST. Live mode is a
      // single transcript per harness call so this is exactly the
      // consumedUtteranceId from the handleTranscript call site
      // (sonnet-stream.js threads it through options).
      utteranceId: options.utteranceId,
      circuitDesignations,
      boardDesignations,
      totalCircuitsInJob,
      // PLAN voice-feedback-2026-06-05 W1.4 — thread the session logger
      // through so the bundler can emit one `ios_send_attempt` row per
      // confirmation entry (with byte-equal-to-iOS expected_dedupe_key
      // + confidence). Omitted when the bundler is invoked outside the
      // harness (test fixtures); the emit is silently skipped there.
      logger: log,
      sessionId: session.sessionId,
    });

    // iOS Build 282 only knows about `extracted_readings`. Fold any board-level
    // readings (record_board_reading dispatches) into extracted_readings with
    // `circuit: 0` so they render in the existing iOS UI without a TestFlight
    // update. The separate `extracted_board_readings` slot stays for forward
    // compatibility — once iOS decodes it, this fold can be removed.
    //
    // "Work on Board" hotfix slice 1.1b (2026-05-08) — preserve board_id on
    // the synthesised circuit:0 reading so iOS's applySonnetReadings can
    // route board-level supply / installation writes (Ze, IPF, etc.) to the
    // BoardInfo of the right board via the boardIndex(for:) helper rather
    // than always pinning to boards[0]. Slice 1.1a populated br.board_id;
    // omit-when-undefined keeps single-board sessions byte-identical.
    if (Array.isArray(result.extracted_board_readings)) {
      for (const br of result.extracted_board_readings) {
        const synthesised = {
          field: br.field,
          circuit: 0,
          value: br.value,
          confidence: br.confidence,
          source: br.source,
        };
        if (br.board_id != null) synthesised.board_id = br.board_id;
        result.extracted_readings.push(synthesised);
      }
    }

    // Bug-F fix (2026-04-26): also fold `circuit_updates` (create_circuit /
    // rename_circuit ops) into `extracted_readings`. iOS Build 282 doesn't
    // decode the circuit_updates slot — under legacy, circuits were created
    // implicitly when a `circuit_designation` reading arrived for a new
    // circuit_ref. Mapping each create/rename op back to that legacy shape
    // means iOS auto-creates the row and populates the meta fields without
    // a protocol update. Field-name mapping mirrors the legacy KNOWN_FIELDS
    // set in sonnet-stream.js (and field_schema.json circuit_fields keys):
    //   designation       → circuit_designation
    //   phase             → phase
    //   rating_amps       → ocpd_rating
    //   cable_csa_mm2     → live_csa_mm2
    // Field test 2026-04-26 sessionId 4CDC9FC2 surfaced this — Sonnet was
    // calling create_circuit and rename_circuit successfully but iOS UI
    // showed nothing because the legacy contract didn't carry "circuit
    // created" as a first-class event.
    if (Array.isArray(result.circuit_updates)) {
      // Bug-G fix (2026-04-26): iOS Build 302's per-field dispatch in
      // DeepgramRecordingViewModel.swift:3559 (`case "circuit_description",
      // "designation":`) uses the LEGACY unprefixed field names, not the
      // field_schema.json keys. The legacy backend KNOWN_FIELDS set in
      // sonnet-stream.js:538-658 agrees. Schema-key names like
      // `circuit_designation` / `live_csa_mm2` warn-and-skip via
      // validateAndCorrectFields (logs `Unknown field name from Sonnet`)
      // and never reach the iOS UI. Mapping table below uses the legacy
      // names that BOTH the backend KNOWN_FIELDS and iOS dispatch agree
      // on. `phase` has no legacy handler — iOS Circuit model has the
      // field but the dispatch case doesn't exist, so dropping the fold
      // here is the right call until Phase 6 protocol cutover.
      const META_TO_LEGACY_FIELD = {
        designation: 'designation', // iOS DeepgramRecordingViewModel.swift:3559
        // phase: dropped — iOS has no per-field dispatch case. Sonnet still
        //   sets it on the snapshot, just doesn't surface to the UI.
        rating_amps: 'ocpd_rating', // iOS line 256
        cable_csa_mm2: 'cable_size', // iOS line 260, maps to circuit.cableSize → liveCsaMm2
      };
      for (const op of result.circuit_updates) {
        // op shape: { op: 'create'|'rename', circuit_ref, from_ref?, board_id?, meta? }
        const ref = op.circuit_ref;
        const meta = op.meta ?? {};
        for (const [metaKey, legacyField] of Object.entries(META_TO_LEGACY_FIELD)) {
          const v = meta[metaKey];
          if (v == null) continue; // designed-as-null skips emission
          // "Work on Board" hotfix slice 1.1b — propagate the op's board_id
          // onto the synthesised meta-as-reading entry. iOS's apply path then
          // lands the create/rename meta on the right board's circuit row
          // rather than always main's. Omit when nullish (single-board session
          // / pre-1.1a dispatcher write).
          const synthesised = {
            field: legacyField,
            circuit: ref,
            value: typeof v === 'number' ? String(v) : v,
            confidence: 1.0,
            source: 'tool_call',
          };
          if (op.board_id != null) synthesised.board_id = op.board_id;
          result.extracted_readings.push(synthesised);
        }
      }
    }

    // Resume any paused dialogue script that was waiting for Sonnet to
    // create / rename the circuit it was anchored to. Field repro:
    // session C3963EA1 — inspector said "Insulation resistance for the
    // cooker is 299 milligrams" before the cooker circuit existed.
    // Engine paused IR (commit 2) with ambiguous_bare_value=299 and
    // paused_designation_hint="cooker circuit". Sonnet then handled
    // circuit creation and produced circuit_updates=[{op:'create',
    // circuit_ref:2, meta:{designation:'Cooker'}}]. tryResumePausedScript
    // designation-matches against the hint, binds state.circuit_ref=2,
    // drains pending writes, and asks the next missing slot. Disambig
    // for the bare 299 (L-L vs L-E?) lands in the follow-up commit.
    //
    // CRITICAL ordering: must run BEFORE `delete result.circuit_updates`
    // below — the resume helper reads the array to confirm the matched
    // ref came from THIS turn's create/rename op (not an unrelated
    // pre-existing circuit). Errors in the resume path are caught and
    // logged so iOS still gets the result envelope.
    if (Array.isArray(result.circuit_updates) && result.circuit_updates.length > 0) {
      try {
        tryResumePausedScript({
          session,
          ws,
          schemas: ALL_DIALOGUE_SCHEMAS,
          circuitUpdates: result.circuit_updates,
          logger: log,
        });
      } catch (e) {
        log.warn('stage6.dialogue_resume_error', {
          sessionId: session.sessionId,
          error: e?.message ?? String(e),
        });
      }
    }

    // Handover-from-Sonnet entry. Symmetric to tryResumePausedScript:
    // when Sonnet writes a value that belongs to a dialogue schema's
    // slot list AND no script is currently active, enter the script
    // with the value pre-seeded so the inspector gets the remaining
    // slot walk-through they would have got on the regex-happy path.
    //
    // Field repro: session 87856B72 (2026-05-26). "RCD triptan for
    // upstairs lighting is 25 ms" — Deepgram garbled "trip time" →
    // "triptan", the RCD trigger /\bRCD\b/ matched but the entry
    // parser harvested nothing, and the engine asked the next slot
    // without the 25 ms ever being captured. runEntry now bails to
    // Sonnet when an utterance carries a number+unit but nothing
    // got harvested; Sonnet writes rcd_trip_time=25; this hook then
    // enters rcdSchema and asks rcd_bs_en. Same UX as the happy path.
    //
    // No-op when the script is already active (don't disturb mid-
    // walk-through) or when no extracted reading matches any
    // schema's slots — common case in non-protective-device turns.
    if (Array.isArray(result.extracted_readings) && result.extracted_readings.length > 0) {
      try {
        const entryResult = tryEnterScriptFromWrites({
          session,
          ws,
          schemas: ALL_DIALOGUE_SCHEMAS,
          readings: result.extracted_readings,
          // FIELD_CORRECTIONS lets the hook resolve Sonnet's canonical
          // names (e.g. `rcd_time_ms`) to schema slot names (e.g.
          // `rcd_trip_time`). validateAndCorrectFields rewrites the
          // wire field names later in sonnet-stream.js — too late for
          // this in-runLiveMode hook to use without the alias map.
          // See session 904344CD turn-10 (2026-05-26) repro.
          fieldAliases: FIELD_CORRECTIONS,
          logger: log,
        });
        // Audit-2026-06-02 Phase 2 — when the seed loop in
        // tryEnterScriptFromWrites fired a derivation mirror (RCBO
        // ocpd_bs_en ↔ rcd_bs_en, OCPD → ocpd_type='Rew', etc.), it
        // returns the resulting writes so we can append them to
        // result.extracted_readings BEFORE Sonnet's payload ships to
        // iOS. We DON'T safeSend a separate envelope from inside the
        // hook because sonnet-stream still hasn't emitted Sonnet's
        // originating extraction at this point — a supplemental emit
        // here would arrive on the wire before the originating writes
        // (wrong order from iOS's perspective). Folding onto the
        // same envelope means iOS sees both columns update on one
        // audible confirmation, same UX as the entry-time and
        // walk-through paths.
        //
        // Source tag 'rcbo_pivot_mirror' is informational only — iOS
        // doesn't currently key on it, but optimiser reports + the
        // shadow comparator can attribute mirrored writes back to the
        // seed path without ambiguity.
        if (Array.isArray(entryResult?.mirrorWrites) && entryResult.mirrorWrites.length > 0) {
          for (const mw of entryResult.mirrorWrites) {
            result.extracted_readings.push({
              field: mw.field,
              circuit: mw.circuit,
              value: mw.value,
              confidence: 1.0,
              source: 'rcbo_pivot_mirror',
              auto_resolved: true,
            });
          }
          log.info('stage6.dialogue_seed_mirrors_appended', {
            sessionId: session.sessionId,
            schema: entryResult.schemaName,
            circuit_ref: entryResult.circuit_ref,
            mirror_count: entryResult.mirrorWrites.length,
            mirror_fields: entryResult.mirrorWrites.map((m) => m.field),
          });
        }
      } catch (e) {
        log.warn('stage6.dialogue_enter_from_write_error', {
          sessionId: session.sessionId,
          error: e?.message ?? String(e),
        });
      }
    }

    // 2026-05-04 — delete_circuit translation. Stage 6's circuitOps shape for
    // a delete is `{op:'delete', circuit_ref}`. iOS's CircuitUpdate Codable
    // expects `{circuit, designation, action}` and will throw the entire
    // extraction message away on shape mismatch (same Bug-F class). Since the
    // create/rename path folds meta into extracted_readings and then strips
    // the array entirely, deletes have nowhere to land — extracted_readings
    // is for FIELD writes, not row removals.
    //
    // Collect the deletes BEFORE the strip below, then re-emit them as
    // legacy-shape entries AFTER the strip. designation:'' is a placeholder
    // (iOS ignores it for deletes — see applyCircuitUpdates handler).
    // Capturing first lets us preserve the strip's invariant ("no Stage 6
    // shape on the wire to iOS") while still surfacing the delete intent.
    const legacyShapeDeletes = [];
    if (Array.isArray(result.circuit_updates)) {
      for (const op of result.circuit_updates) {
        if (op && op.op === 'delete' && Number.isInteger(op.circuit_ref)) {
          // "Work on Board" hotfix slice 1.1b — board_id rides through to iOS
          // so the delete routes to the right board's bucket on apply.
          // Slice 1.2 extends iOS's CircuitUpdate Codable with the optional
          // boardId field; pre-fix iOS clients ignore it via decodeIfPresent.
          const projected = {
            circuit: op.circuit_ref,
            designation: '',
            action: 'delete',
          };
          if (op.board_id != null) projected.board_id = op.board_id;
          legacyShapeDeletes.push(projected);
        }
      }
    }

    // Bug-F fix part 2 (2026-04-26): strip slots iOS Build 302's Codable
    // decoder either rejects or doesn't recognise. iOS DOES decode
    // `circuit_updates` but expects shape {circuit, designation, action}; ours
    // is {op, circuit_ref, meta:{...}} (the canonical Stage 6 shape). The
    // Swift decoder throws on the type mismatch and the WHOLE extraction
    // message gets rejected — same symptom as "Sonnet not connected" because
    // no readings ever land. After folding the meta into extracted_readings
    // above, the original circuit_updates slot is no longer needed for iOS.
    // Strip it; same for the other Stage 6-only slots iOS doesn't recognise.
    // Once iOS decodes these natively (Phase 6 protocol cutover) this strip
    // can be lifted along with the folds above.
    delete result.circuit_updates;
    delete result.extracted_board_readings;
    delete result.cleared_readings;
    delete result.observation_deletions;

    // Re-emit deletes in the legacy iOS shape AFTER the strip so the iOS
    // CircuitUpdate decoder accepts them. Only set the slot if there are any —
    // an empty array would be benign for current iOS but pointlessly noisy
    // in session logs.
    if (legacyShapeDeletes.length > 0) {
      result.circuit_updates = legacyShapeDeletes;
    }

    // Bug-H fix (2026-04-28): same Codable-throw class as Bug-F, but for
    // observations. The bundler emits per-turn observations with the canonical
    // Stage 6 shape `{id, code, text, location, circuit, suggested_regulation}`
    // (see stage6-dispatchers-observation.js:210). iOS `SonnetObservation` in
    // ClaudeService.swift:140 declares `observation_text` as REQUIRED and uses
    // wire keys `observation_id / observation_text / item_location / regulation`
    // — none of which match the Stage 6 shape. Swift throws on the missing
    // required key, which fails the whole `RollingExtractionResult` decode at
    // ServerWebSocketService.swift:718, and the entire extraction message
    // (readings + observations + everything else) is dropped silently. iOS
    // logs `server_ws_decode_error: "Failed to decode extraction result"`;
    // server logs `Extraction result readings:N observations:N` so it looks
    // like everything worked. Repro session: A354882B 2026-04-28 — user said
    // "R2 for circuit 1, ring continuity was discontinuous", server emitted
    // 1 reading + 1 observation, iOS UI showed nothing.
    //
    // Same fix shape is also necessary for the BPG4 refinement path: it reads
    // `obs.observation_text` (sonnet-stream.js:306, 323, 365, 418, 785). With
    // the pre-fix `obs.text` shape, refinement fell back to empty string and
    // the web-search re-coding had nothing to feed on. Renaming once at the
    // bundle boundary fixes both consumers in one pass.
    result.observations = renameObservationsForLegacyWire(result.observations);

    // 2026-05-28 mid-stream extraction emit (lever 1) — filter slots that
    // were already emitted via onSlotAudioReady out of the canonical
    // extraction envelope. iOS's handleServerExtraction applies readings
    // idempotently (state writes are safe to repeat) but the confirmations
    // array drives separate /api/proxy/elevenlabs-tts POSTs — sending the
    // same slot twice would trigger a double-POST and (depending on iOS-
    // side dedup) a double audio play. Filtering at the bundle boundary
    // keeps the wire shape clean.
    //
    // Slot key matches the speculator's: (field, circuit, boardId). The
    // canonical bundler uses `circuit` as a string ("0" for board-level)
    // and the mid-stream key uses the same coercion (Integer ? String :
    // "0"). board_id matches verbatim (null/undefined → '').
    // 2026-05-29 field-test rollback: disabled by default. The mid-stream
    // emit path (Loaded Barrel onSlotAudioReady → preliminary WS extraction)
    // isn't reliably reaching iOS — field session 36602959 had Sonnet
    // record_reading succeed but the value never landed in the UI, because
    // this filter removed it from the canonical bundle assuming iOS already
    // had it from the mid-stream preliminary. Until the mid-stream channel
    // is verified end-to-end, ALWAYS emit canonical and let iOS dedupe via
    // RollingExtractionResult. Re-enable with VOICE_MID_STREAM_FILTER=true
    // when the mid-stream path is debugged.
    if (process.env.VOICE_MID_STREAM_FILTER === 'true' && midStreamEmittedSlots.size > 0) {
      const slotKeyOf = (r) => {
        // Bundler emits circuit as string (board-level = "0"); speculator
        // tracked numeric circuit. Coerce identically.
        const circ = r.circuit;
        const circStr =
          circ == null || circ === '' ? '0' : typeof circ === 'string' ? circ : String(circ);
        return `${r.field}::${circStr}::${r.board_id ?? ''}`;
      };
      if (Array.isArray(result.extracted_readings)) {
        const before = result.extracted_readings.length;
        result.extracted_readings = result.extracted_readings.filter(
          (r) => !midStreamEmittedSlots.has(slotKeyOf(r))
        );
        const filtered = before - result.extracted_readings.length;
        if (filtered > 0) {
          log?.info?.('voice_latency.mid_stream_canonical_filter', {
            sessionId: session.sessionId,
            turnId,
            readings_filtered: filtered,
            mid_stream_slot_count: midStreamEmittedSlots.size,
          });
        }
      }
      if (Array.isArray(result.confirmations)) {
        const confKeyOf = (c) => {
          const circ = c.circuit;
          const circStr = circ == null ? '0' : typeof circ === 'string' ? circ : String(circ);
          return `${c.field}::${circStr}::${c.board_id ?? ''}`;
        };
        result.confirmations = result.confirmations.filter(
          (c) => !midStreamEmittedSlots.has(confKeyOf(c))
        );
      }
    } else if (midStreamEmittedSlots.size > 0) {
      log?.info?.('voice_latency.mid_stream_canonical_filter_skipped', {
        sessionId: session.sessionId,
        turnId,
        mid_stream_slot_count: midStreamEmittedSlots.size,
        reason: 'flag_off',
      });
    }

    // PLAN-backend-final.md Phase 7.3 — backend confirmation debounce.
    // Cross-turn same-field-family suppression. Inspector hears one TTS
    // per burst instead of three when Sonnet rapid-fires record_reading
    // for the same field across consecutive turns. State lives on the
    // session entry so it survives across runLiveMode invocations;
    // initialised lazily on first use so older entries (or test
    // harnesses with partial sessions) don't trip over a missing field.
    // Runs AFTER the mid-stream-canonical filter so the debounce sees
    // the final set iOS would have played, and BEFORE the
    // bundlerEmittedCount calc lower down so the audio-finalizer arms
    // ACK expectations for the right (debounced) confirmation count.
    if (Array.isArray(result.confirmations) && result.confirmations.length > 0) {
      if (!session.confirmationDebounceState) {
        session.confirmationDebounceState = { lastEmittedAt: 0, lastField: null };
      }
      const before = result.confirmations.length;
      result.confirmations = applyConfirmationDebounce(
        result.confirmations,
        session.confirmationDebounceState
      );
      const suppressed = before - result.confirmations.length;
      if (suppressed > 0) {
        log?.info?.('voice_latency.confirmation_debounced', {
          sessionId: session.sessionId,
          turnId,
          suppressed,
          surviving: result.confirmations.length,
          window_ms: 1500,
        });
      }
    }

    // Increment turn count to match legacy's contract
    // (extractFromUtterance does this internally).
    session.turnCount = turnNum;

    // Cost tracking — wire the multi-round tool loop's summed usage into
    // the session's CostTracker so cost_summary.json populates the same
    // sonnet.{turns, cacheReads, cacheWrites, input, output, cost} fields
    // the optimiser's analyze-session.js reads at scripts/analyze-session.js
    // (line 322, ~costSummary.sonnet). Pre-fix this was a black hole: the
    // legacy off-mode `extract()` path called costTracker.addSonnetUsage()
    // at eicr-extraction-session.js:1614, but the Stage 6 live path never
    // reached that code, so the tool-loop's API calls were billed by
    // Anthropic but invisible to dashboards (toSessionSummary returned
    // sonnet.turns=0 / cost=0 even after 8+ extraction rounds). The
    // 47 Ashcroft Road session 2D391936 was the smoking-gun example.
    // One call per loop run preserves "turns === utterances" semantics
    // (matches legacy off-mode call site) — toolLoopOut.rounds is on the
    // return value if a future dashboard needs per-API-call granularity.
    // Defensive: skip if costTracker isn't on the session (test harnesses
    // sometimes pass partial sessions); skip if usage is all zeros (mock
    // streams without usage events) so test assertions on turn counts
    // stay stable when fixtures don't carry usage.
    if (
      session.costTracker &&
      typeof session.costTracker.addSonnetUsage === 'function' &&
      toolLoopOut.usage &&
      (toolLoopOut.usage.input_tokens > 0 ||
        toolLoopOut.usage.output_tokens > 0 ||
        toolLoopOut.usage.cache_read_input_tokens > 0 ||
        toolLoopOut.usage.cache_creation_input_tokens > 0)
    ) {
      session.costTracker.addSonnetUsage(toolLoopOut.usage, toolLoopOut.model);
    }

    // Mirror the legacy `this.extractedReadingsCount += result.extracted_readings.length`
    // at eicr-extraction-session.js:1474. Feeds cost_summary.extraction.readingsExtracted
    // (added by stopSession at eicr-extraction-session.js:1161). The optimiser
    // reads this at analyze-session.js:326 with a fallback to debug-log event
    // counts; populating it here makes the server-authoritative path the
    // primary signal in dashboards.
    if (typeof session.extractedReadingsCount === 'number' && result.extracted_readings) {
      session.extractedReadingsCount += result.extracted_readings.length;
    }

    log.info('stage6_live_extraction', {
      sessionId: session.sessionId,
      turnId,
      rounds: toolLoopOut.rounds,
      aborted: toolLoopOut.aborted ?? false,
      abort_reason: toolLoopOut.aborted && toolLoopOut.rounds >= 8 ? 'loop_cap' : null,
      readings: result.extracted_readings.length,
      observations: result.observations.length,
      // Token usage logged here for per-turn CloudWatch visibility (mirrors
      // the legacy off-mode "Turn cost" log at eicr-extraction-session.js:1618).
      // Cumulative session totals live on session.costTracker and ride out
      // via cost_summary.json at session end.
      usage_input: toolLoopOut.usage?.input_tokens ?? 0,
      usage_output: toolLoopOut.usage?.output_tokens ?? 0,
      usage_cache_read: toolLoopOut.usage?.cache_read_input_tokens ?? 0,
      usage_cache_write: toolLoopOut.usage?.cache_creation_input_tokens ?? 0,
    });

    // Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8).
    //
    // Emit the immutable `voice_latency.turn_core_summary` row carrying every
    // Sonnet + dispatch fact knowable at end-of-runLiveMode. The companion
    // `turn_audio_summary` is emitted by the delayed finalizer below (or
    // its 8s timeout) and shares `{sessionId, turnId}` keys for downstream
    // CloudWatch JOIN. Wrapped via the emitter's own try/catch so telemetry
    // failures never break extraction.
    try {
      // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: filter by
      // `expects_ios_ack` so the audio finalizer only arms for bundler
      // confirmations whose iOS speak site can actually fire a playback-
      // ack. Synthesised state-change / observation / cleared confirmations
      // set `expects_ios_ack: false` (see stage6-event-bundler.js) because
      // they route through iOS speakBriefConfirmation sites that lack a
      // per-confirmation turnId today. Canonical extracted-value
      // confirmations omit the field and default to ACK-eligible for
      // back-compat with pre-Tier-1.1 emit code.
      const bundlerEmittedCount = Array.isArray(result.confirmations)
        ? result.confirmations.filter((c) => c?.expects_ios_ack !== false).length
        : 0;
      const runLiveDurationMs = Number((process.hrtime.bigint() - runLiveStartNs) / 1000000n);
      emitTurnCoreSummary({
        sessionId: session.sessionId,
        turnId,
        rounds: toolLoopOut.rounds,
        // Phase 2 protocol-truth split: terminal_reason carries the
        // server-side classification (end_turn / tool_use_cap_hit /
        // early_terminated / aborted); actual_stop_reason_per_round
        // preserves Anthropic's stop_reason verbatim per round.
        terminal_reason: toolLoopOut.terminal_reason ?? null,
        early_terminated: toolLoopOut.early_terminated === true,
        actual_stop_reason_per_round: toolLoopOut.actual_stop_reason_per_round ?? [],
        tool_names_per_round: toolLoopOut.tool_names_per_round ?? [],
        tool_call_count_per_round: toolLoopOut.tool_call_count_per_round ?? [],
        tool_error_count_per_round: toolLoopOut.tool_error_count_per_round ?? [],
        round_timings: toolLoopOut.round_timings ?? [],
        run_live_duration_ms: runLiveDurationMs,
        bundler_emitted_count: bundlerEmittedCount,
        readings_count: result.extracted_readings.length,
        observations_count: result.observations.length,
        // Server-side audible-first-byte is null in this path — fast-path
        // audio is iOS-driven; the bundler emits text-only confirmations
        // here. The audio_summary row will carry the iOS-side timestamps.
        audible_first_byte_ms: null,
        audible_first_byte_source: null,
        // Path classification: defaults to 'bundler_only' unless iOS
        // attached a fast-path correlation, in which case 'fast_path_attempted'
        // is more informative for dashboards (the audio summary then
        // tells us whether the fast-path actually delivered audio).
        path_classification:
          (entry?.fastPathCorrelationIdByTurn?.get(turnId)?.size ?? 0) > 0
            ? 'fast_path_attempted'
            : 'bundler_only',
      });

      // Arm the audio finalizer. expected_acks =
      //   (bundler confirmations) + (fast-TTS POSTs attempted this turn)
      // minus any pre-finalizer decrements stashed by the fast-TTS route
      // when it 4xx'd before runLiveMode minted this turnId. The drain is
      // done inside startAudioFinalizer; we just supply the two counts.
      const attemptedFastTtsCount = entry?.fastPathCorrelationIdByTurn?.get(turnId)?.size ?? 0;
      startAudioFinalizer(session.sessionId, turnId, {
        bundlerEmittedCount,
        attemptedFastTtsCount,
      });
    } catch (telemetryErr) {
      log?.warn?.('voice_latency.turn_summary_emit_error', {
        sessionId: session.sessionId,
        turnId,
        stage: 'live_mode_emit',
        error: telemetryErr?.message || String(telemetryErr),
      });
    }

    return result;
  } finally {
    // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 12.2 + 8.4).
    // Tear down both per-turn maps so the next turn's speculator
    // preflight and audio finalizer start with a clean slate. .delete
    // is idempotent — safe whether the entry exists or not.
    if (entry) {
      entry.pendingFastTtsSlots?.delete(turnId);
      entry.fastPathCorrelationIdByTurn?.delete(turnId);
      // Fix A 2026-06-02 (handoff §A) — symmetric cleanup with the write at
      // the top of runLiveMode. .delete is idempotent so this is safe even
      // on turns where detectBroadcastIntent returned false (no entry was
      // written) and on the error path where runToolLoop threw before any
      // hook fired.
      entry.broadcastIntentByTurn?.delete(turnId);
    }
    // Drop the per-turn transcript pointer so a dispatcher firing on
    // the next turn can't accidentally reuse this turn's text.
    session.activeTurnTranscript = null;
  }
}

/**
 * Plan 06-06 r5-#3 (MINOR) — extracted helper that builds the cloned
 * shadowSession passed into createAskDispatcher (and the write dispatcher).
 *
 * Pre-fix the construction was inline at the harness body and pinned
 * `toolCallsMode: 'shadow'` regardless of input. That made the dispatcher's
 * `fallbackToLegacy` gate inside the LIVE branch (added in Plan 06-02
 * r1-#1) unreachable through the harness — the dispatcher's shadow
 * short-circuit at stage6-dispatcher-ask.js:233 fired first for every
 * harness call. Tests at the harness layer were therefore proving an
 * impossible state (live + fallbackToLegacy via harness was unreachable).
 *
 * Post-fix the clone reflects the input session's toolCallsMode. In
 * Phase 6 the harness's mode-guard at line 147 throws on
 * session.toolCallsMode === 'live' so the dispatcher's live-branch gate
 * is still unreachable through the harness today; once Phase 7 lifts
 * that guard, the gate becomes reachable for the first time. The change
 * is observable ONLY when the caller runs the harness against a live
 * session (a Phase 7 surface); for shadow runs the upstream env is
 * shadow, so session.toolCallsMode === 'shadow' and behaviour is
 * byte-identical to the old pin.
 *
 * The helper is exported for testability — see
 * `stage6-shadow-harness-toolcallsmode-threading.test.js` for the
 * structural assertions that lock this contract at CI time.
 *
 * @param {Object} session  Live session passed to runShadowHarness.
 *   Must expose: sessionId, toolCallsMode (optional — defaults 'shadow').
 * @param {Object} preLegacySnapshot  Pre-legacy clone of stateSnapshot
 *   (Codex Phase-2 BLOCK#1 round-2 fix — see Step 0 above).
 * @param {Array} preLegacyObservations  Pre-legacy clone of
 *   extractedObservations.
 * @returns {Object} A new object with sessionId, stateSnapshot,
 *   extractedObservations, and toolCallsMode preserved from the input.
 */
export function buildShadowSessionForDispatcher(session, preLegacySnapshot, preLegacyObservations) {
  return {
    sessionId: session.sessionId,
    stateSnapshot: preLegacySnapshot,
    extractedObservations: preLegacyObservations,
    // Plan 06-06 r5-#3 — preserve the input's toolCallsMode rather than
    // pinning 'shadow'. See JSDoc above for the WHY.
    //
    // Defaults to 'shadow' for back-compat with any caller (or test
    // stub) that omits the field — the existing Phase 2-5 tests use
    // bare session stubs that may not set toolCallsMode explicitly.
    toolCallsMode: session.toolCallsMode ?? 'shadow',
  };
}

/**
 * Shadow-harness entry point. Drop-in replacement for
 * `session.extractFromUtterance(...)` at the sonnet-stream.js seam.
 *
 * @param {Object} session  Must expose: sessionId, turnCount, client
 *   (Anthropic SDK), systemPrompt, toolCallsMode, extractFromUtterance.
 * @param {string} transcriptText
 * @param {Array} regexResults
 * @param {Object} [options] Forwarded to legacy. Optional .logger for DI.
 * @returns {Promise<any>} The LEGACY result verbatim — iOS wire unchanged
 *   across all modes.
 */
export async function runShadowHarness(session, transcriptText, regexResults, options = {}) {
  const log = options.logger ?? logger;
  const mode = session.toolCallsMode ?? 'off';

  // FAST PATH — zero observable difference from pre-stage-6 world.
  if (mode === 'off') {
    return session.extractFromUtterance(transcriptText, regexResults, options);
  }

  // 2026-04-26 (Bug-B pivot): solo-test live mode. SONNET_TOOL_CALLS=live runs
  // ONLY the agentic tool loop — no legacy authoritative call, no shadow
  // divergence comparison. The bundler's projected result is what iOS gets.
  // Rationale: dual-path shadow design carries the prompt-vs-parser pairing
  // bug (Bug B), Sonnet emitting hallucinated dotted field names that the
  // legacy KNOWN_FIELDS receiver dropped. Skipping the legacy path entirely
  // closes the bug structurally — there's only one path, so no mismatch is
  // possible. Cost of pivot: no fallback if Sonnet's tool calls fail; this
  // is acceptable for solo testing today, and `SONNET_TOOL_CALLS=off` is
  // still a 2-minute ECS rollback to legacy if anything blocks.
  if (mode === 'live') {
    return runLiveMode(session, transcriptText, regexResults, options, log);
  }

  if (mode !== 'shadow') {
    // Defensive: unknown mode string. Log once, fall back to legacy.
    try {
      log.warn?.('stage6_shadow_harness_unknown_mode', { mode });
    } catch {
      // swallow
    }
    return session.extractFromUtterance(transcriptText, regexResults, options);
  }

  // --- SHADOW MODE ---------------------------------------------------------
  //
  // Step 0 (Codex Phase-2 review BLOCK #1 round-2 fix): snapshot the mutable
  // session surfaces BEFORE legacy runs.
  //
  // The round-1 fix (clone after legacy + swap dispatcher onto the clone)
  // stopped shadow from CORRUPTING live state, but left a second bug: the
  // clone was taken from POST-legacy state. Shadow's tool loop therefore
  // replayed the same utterance against a state legacy had already mutated
  // — e.g. legacy created circuit 2 → shadow's create_circuit(2) hits the
  // "duplicate circuit_ref" validator and rejects spuriously. The resulting
  // `stage6_divergence` row says "extra_in_legacy" or "circuit_ops_diff"
  // when in fact both paths would have succeeded from the same starting
  // point. That's exactly the noise STO-01 promises to NOT emit.
  //
  // Correct sequencing:
  //   1. Clone pre-legacy state (this block).
  //   2. Run legacy against live state (it mutates live).
  //   3. Run shadow tool loop against the PRE-legacy clone.
  //   4. Compare results.
  //
  // structuredClone is JSON-safe here — stateSnapshot contains only plain
  // objects/arrays/primitives; extractedObservations is an array of plain
  // observation records.
  const preLegacySnapshot = structuredClone(session.stateSnapshot);
  const preLegacyObservations = Array.isArray(session.extractedObservations)
    ? structuredClone(session.extractedObservations)
    : [];

  // Plan 04-12 r6-#2 — capture the system-blocks array BEFORE legacy
  // mutates session.stateSnapshot. r5-#1 fixed the harness to use
  // session.buildSystemBlocks() but left the call at Step 4 (line 284
  // historically), which runs AFTER session.extractFromUtterance mutates
  // session.stateSnapshot at Step 1. Shadow's model-facing prompt then
  // carried legacy's current-turn writes — anti-re-ask logic saw the slot
  // as filled and suppressed shadow's divergence signal.
  //
  // Capturing here (pre-legacy) mirrors the real-production contract:
  // shadow and live both observe the SAME starting state at turn entry,
  // and any divergence between them is measured on equal footing. The
  // dispatcher-side `shadowSession` (built at Step 3b below) was already
  // correctly cloning pre-legacy state; this fix brings the PROMPT-SIDE
  // input into the same pre-legacy window.
  //
  // buildSystemBlocks returns the full system-blocks array the session
  // would send on the real path (see r5-#1 remediation). In off mode the
  // array is a single base-prompt block. In non-off mode it is either
  // a single base-prompt block (empty snapshot) or a two-block array
  // (base prompt + cached snapshot, both cache_control ephemeral 5m).
  const preLegacySystemBlocks = session.buildSystemBlocks();

  // Step 1: run legacy FIRST. If legacy throws, the error propagates — no
  // divergence log (no payload to compare).
  const legacy = await session.extractFromUtterance(transcriptText, regexResults, options);

  // Step 2: snapshot turn number AFTER the legacy await. extractFromUtterance
  // runs `this.turnCount++` internally (eicr-extraction-session.js:641) so
  // the POST-increment value describes the turn that just ran. Phase 1's
  // Codex review (MAJOR) locked this ordering: reading BEFORE the await
  // plus +1, OR AFTER the await unchanged — both give the same turnNum.
  // We use the AFTER-unchanged form here (slightly simpler) for the
  // divergence log; Phase 1's stage6-shadow-harness.test.js asserts the
  // BEFORE+1 form. The tests for this plan mirror the legacy pattern.
  const turnNum = session.turnCount ?? 0;
  const turnId = `${session.sessionId}-turn-${turnNum}`;

  // Step 3: per-turn writes accumulator. Function-local — NEVER stored on
  // session (Pitfall #2). New instance per call structurally prevents
  // cross-turn leaks.
  const perTurnWrites = createPerTurnWrites();

  // Step 3b (Codex Phase-2 review BLOCK #1): build the shadow dispatcher
  // session from the PRE-LEGACY snapshot captured in Step 0.
  //
  // Two invariants this enforces:
  //   (a) Shadow tool loop mutations NEVER reach the live session — dispatcher
  //       writes land on `shadowSession.*` only. `sessionId` is shared for
  //       log correlation on stage6_divergence / stage6.tool_call join keys.
  //   (b) Shadow sees the SAME starting state legacy did. If we built the
  //       wrapper from `session.stateSnapshot` post-legacy, the tool loop
  //       would replay the same utterance against mutated state and the
  //       divergence log would report spurious rejects (e.g. create_circuit
  //       duplicate on a circuit_ref legacy just added).
  //
  // structuredClone is JSON-safe here — stateSnapshot contains only plain
  // objects/arrays/primitives (circuits keyed by ref, pending_readings /
  // observations / validation_alerts as primitive-typed arrays). Deep-cloning
  // once above AND passing those clones directly (no second clone here) keeps
  // the cost at one clone per shadow turn.
  const shadowSession = buildShadowSessionForDispatcher(
    session,
    preLegacySnapshot,
    preLegacyObservations
  );

  // Phase 3 Plan 03-07: optional ask composition.
  //
  // `pendingAsks` + `ws` are SESSION-SCOPED resources owned by sonnet-stream.js
  // (Plan 03-08). The harness is stateless wrt those — it does NOT create,
  // destroy, or rejectAll. It only (a) reads `pendingAsks` to decide whether
  // to compose the ask dispatcher in the first place, and (b) threads both
  // objects into `createAskDispatcher` which will register/resolve entries
  // per-call.
  //
  // Fallback: when a caller (e.g. any Phase 2 call-site during the Plan
  // 03-08 rollout window) does NOT pass pendingAsks, the harness reverts to
  // Phase 2 shape — write-only dispatcher, identity sortRecords. This
  // preserves every existing Phase 2 shadow run unchanged until Plan 03-08
  // lands the per-session registry in sonnet-stream.js.
  const pendingAsks = options.pendingAsks ?? null;
  const ws = options.ws ?? null;
  const writes = createWriteDispatcher(shadowSession, log, turnId, perTurnWrites);
  // 2026-04-27 — auto-resolve hook is NOT threaded into shadow mode.
  //
  // The original 2026-04-27 path-2 wiring created a `shadowAutoResolveWrite`
  // hook against shadowSession and passed it into createAskDispatcher's opts.
  // Internal review found the hook never fires: createAskDispatcher
  // short-circuits `mode === 'shadow'` BEFORE the auto-resolve resolution
  // path, so the hook is dead code — and worse, live mode's auto-resolved
  // writes appear in perTurnWrites.readings (and downstream comparator
  // input) but shadow mode has no equivalent, so the slot comparator sees
  // them as `extra_in_tool` divergences. False positives every time
  // auto_resolve fires, polluting Phase 7 retirement analytics.
  //
  // Two-step fix:
  //  1) Drop the shadow hook (this comment block; previously a
  //     createAutoResolveWriteHook + autoResolveWrite opt).
  //  2) Slot comparator filters readings whose tool_call_id contains the
  //     '::auto::' synthetic-call namespace marker so live's auto-resolves
  //     don't show up as false-positive `extra_in_tool` divergences against
  //     shadow's empty equivalent. See stage6-slot-comparator.js for the
  //     filter.
  //
  // Shadow comparator never had perfect parity with live (it cannot see
  // ask_user round-trips at all, per the mode==='shadow' short-circuit in
  // createAskDispatcher). Adding a one-off filter is consistent with how
  // other shadow-only paths are handled and avoids the more invasive
  // option of rewriting buildResolvedBody to also run shadow-side.
  let dispatcher;
  let sortRecords;
  // Stage 6 Phase 5 Plan 05-01 — per-turn debounce gate. Lives only for the
  // duration of this harness invocation; destroyed in the finally below so
  // pending timers can never leak across turns. Held in a let-binding so
  // both the composition branch and the cleanup hook can see it.
  let askGateForTurn = null;
  if (pendingAsks) {
    // Plan 06-02 r1-#1 — thread the live activeSessions entry's
    // `fallbackToLegacy` flag (stamped by sonnet-stream.js handleSessionStart
    // when an iOS client connects in shadow mode without
    // protocol_version='stage6') through to the dispatcher so it can suppress
    // `ask_user_started` ws.send for those sessions. Default false keeps every
    // pre-Plan-06-02 caller byte-identical.
    let asks = createAskDispatcher(shadowSession, log, turnId, pendingAsks, ws, {
      fallbackToLegacy: options.fallbackToLegacy === true,
      // autoResolveWrite intentionally OMITTED for shadow mode — see the
      // comment block above the createWriteDispatcher call. The dispatcher
      // short-circuits `mode === 'shadow'` before the resolution path, so
      // any hook here would be dead code.
    });
    // Phase 5 — wrap with gates ONLY when the activeSessions entry threaded
    // both stateful resources through. Existing Phase 3/4 callers (and the
    // dispatcher's own unit tests) thread neither, so they keep the
    // Phase 3 dispatcher shape unchanged.
    if (options.askBudget && options.restrainedMode) {
      askGateForTurn = createAskGateWrapper({
        logger: log,
        sessionId: shadowSession.sessionId,
        // Plan 05-07 r1-#3 — pass the session's actual mode through so
        // wrapper-emitted `gated` / `session_terminated` / `dispatcher_error`
        // log rows tag with mode='shadow' instead of the hard-coded 'live'.
        // Phase 8 dashboards split by mode; corrupting that split for shadow
        // sessions was the r1-#3 finding.
        mode: 'shadow',
      });
      asks = wrapAskDispatcherWithGates(asks, {
        askBudget: options.askBudget,
        restrainedMode: options.restrainedMode,
        gate: askGateForTurn,
        // Plan 05-02 supplies the real adapter; until then a no-op keeps
        // the wrapper's pre-wrapper shadow-log step (Open Question #5)
        // a structural placeholder. The wrapper's own try/catch around
        // filledSlotsShadow keeps a thrown adapter from tearing down dispatch.
        filledSlotsShadow: options.filledSlotsShadow ?? (() => {}),
        logger: log,
        sessionId: shadowSession.sessionId,
        // Plan 05-07 r1-#3 — restrained_mode + ask_budget_exhausted rows
        // are emitted from synthResultWrapped on the wrapper-internal
        // short-circuit paths; thread the same shadow mode so they match.
        mode: 'shadow',
      });
    }
    dispatcher = createToolDispatcher(writes, asks);
    sortRecords = createSortRecordsAsksLast();
  } else {
    dispatcher = writes;
    sortRecords = undefined; // runToolLoop treats undefined as identity.
  }

  // Step 4: drive the real tool loop. Any thrown error is CAUGHT so shadow
  // failure NEVER breaks production — legacy return value is authoritative.
  let toolLoopOut;
  try {
    // Plan 04-11 r5-#1 — delegate to session.buildSystemBlocks() so the
    // harness mirrors EXACTLY what the real (non-shadow) path would ship:
    //   - off mode: 1 block [base prompt].
    //   - non-off mode: 1 block when the state snapshot is empty, 2 blocks
    //     when non-empty ([base prompt, state snapshot]). BOTH blocks carry
    //     cache_control:{type:'ephemeral', ttl:'5m'} per Plan 04-02 STQ-03.
    //
    // Plan 04-12 r6-#2 — the buildSystemBlocks CALL itself now lives at
    // Step 0b (before legacy's extractFromUtterance) so the captured
    // array reflects PRE-TURN state rather than post-legacy-mutation
    // state. `preLegacySystemBlocks` carries the captured array. Without
    // this move, shadow's model would see legacy's current-turn writes
    // in its cached snapshot block — anti-re-ask logic would then see
    // the slot as filled and suppress shadow's divergence signal.
    //
    // After r5+r6, both surfaces share the same buildSystemBlocks() method
    // AND observe the same pre-turn starting state — shadow differs from
    // live ONLY on dispatch semantics (tool-call vs prose-JSON parse),
    // never on prompt shape or state visibility.
    const systemBlocks = preLegacySystemBlocks;

    toolLoopOut = await runToolLoop({
      client: session.client,
      model: SHADOW_MODEL,
      system: systemBlocks,
      messages: [{ role: 'user', content: transcriptText }],
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: { sessionId: session.sessionId, turnId },
      logger: log,
      // Phase 3 Plan 03-07: pass sortRecords when ask composition is active.
      // Undefined falls back to runToolLoop's identity default (Phase 2
      // behaviour). When a composer is present, createSortRecordsAsksLast()
      // moves any Sonnet-emitted ask_user blocks to the END of the round so
      // write tools land BEFORE the blocking ask stalls dispatch — STA-02
      // defense-in-depth per Plan 03-06.
      sortRecords,
    });

    // Plan 04-29 r22-#2 — test-only shadow-path capture hook.
    //
    // WHY: r22-#2 re-review flagged that the r21-#3 end-to-end tests only
    // assert on ws emissions + logger + live-session state (the surface
    // channels). None of them inspect the internal shadow path — the
    // `shadowSession` clone (where the shadow dispatcher actually writes)
    // nor the `perTurnWrites` accumulator (where bundler would later read
    // leak content from, if the filter ever failed). A regression that
    // re-enabled writes-on-leak inside the shadow dispatcher while keeping
    // live-side surfaces unchanged would pass the existing tests silently.
    //
    // The hook fires AFTER the tool loop finishes, capturing the moment
    // before bundler/divergence post-processing runs. Production callers
    // never pass `_shadowCapture` — the underscore prefix flags this as
    // test-only (mirrors the Node convention for private-by-naming).
    //
    // Swallow-on-throw: a test-hook failure must NEVER break production
    // extraction. Any error in the hook is silently discarded — the shadow
    // harness continues to Step 5 (bundler) → Step 6 (comparator) → Step 7
    // (divergence log) → Step 8 (legacy return) unchanged.
    if (typeof options._shadowCapture === 'function') {
      try {
        options._shadowCapture({ shadowSession, perTurnWrites, toolLoopOut });
      } catch {
        // swallow — hook errors never propagate
      }
    }
  } catch (err) {
    try {
      log.warn?.('stage6_shadow_error', {
        sessionId: session.sessionId,
        turnId,
        phase: 2,
        error: err?.message ?? String(err),
      });
    } catch {
      // swallow logger failure — shadow must never break extraction
    }
    // Plan 05-01 — release per-turn gate timers before bailing. By the time
    // we reach this catch, every gateOrFire awaited in the tool loop has
    // already resolved (runToolLoop awaits each tool call), so destroy() is
    // primarily a defensive belt-and-braces hook in case a runtime quirk
    // strands a pending timer. Idempotent — calling on an empty pending Map
    // is a no-op.
    askGateForTurn?.destroy();
    return legacy;
  }

  // Plan 05-01 — release per-turn gate timers on the success path BEFORE
  // bundling/divergence-log. Same idempotency contract as the catch path.
  askGateForTurn?.destroy();

  // Cost tracking — shadow mode makes a real billable Anthropic call in
  // parallel to legacy extract(). Legacy already tracks itself at
  // eicr-extraction-session.js:1614; without this wiring the shadow leg
  // is invisible to dashboards even though it shows up on the Anthropic
  // bill. Same shape + defensive guards as runLiveMode (above). We do
  // NOT bump session.extractedReadingsCount here — shadow's readings
  // never reach iOS (Step 8 returns legacy), so they don't count toward
  // user-visible extraction throughput.
  if (
    session.costTracker &&
    typeof session.costTracker.addSonnetUsage === 'function' &&
    toolLoopOut.usage &&
    (toolLoopOut.usage.input_tokens > 0 ||
      toolLoopOut.usage.output_tokens > 0 ||
      toolLoopOut.usage.cache_read_input_tokens > 0 ||
      toolLoopOut.usage.cache_creation_input_tokens > 0)
  ) {
    session.costTracker.addSonnetUsage(toolLoopOut.usage, toolLoopOut.model);
  }

  // Step 5: bundle ONCE post-loop (Pitfall #3 — never mid-loop).
  // confirmationsEnabled: shadow mode prefers legacy.confirmations when
  // present (Sonnet prose-JSON emitted them) but still synthesises from
  // tool calls if the client opted in and legacy returned an empty array.
  const toolResult = bundleToolCallsIntoResult(perTurnWrites, legacy, {
    confirmationsEnabled: options.confirmationsEnabled === true,
  });

  // Step 6: slot-diff the two result shapes.
  const divergence = compareSlots(legacy, toolResult);

  // Step 7: emit single structured log row per turn. Phase 7 analyzer joins
  // these on (sessionId, turnId) with stage6.tool_call rows emitted by the
  // dispatchers themselves.
  try {
    log.info('stage6_divergence', {
      sessionId: session.sessionId,
      turnId,
      phase: 2,
      bundler_phase: BUNDLER_PHASE,
      legacy_slots: serialiseSlots(divergence.legacy_slots),
      tool_slots: serialiseSlots(divergence.tool_slots),
      divergent: divergence.any,
      reason: divergence.reason,
      details: divergence.details,
      aborted: toolLoopOut.aborted ?? false,
      abort_reason: toolLoopOut.aborted && toolLoopOut.rounds >= 8 ? 'loop_cap' : null,
      rounds: toolLoopOut.rounds,
      shadow_cost_usd: estimateShadowCost(toolLoopOut),
    });
  } catch {
    // Logging failure must NOT break extraction. Swallow and continue.
  }

  // Step 8: iOS ALWAYS gets legacy in Phase 2.
  return legacy;
}
