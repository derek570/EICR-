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
import { runToolLoop } from './stage6-tool-loop.js';
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
import { bundleToolCallsIntoResult, BUNDLER_PHASE } from './stage6-event-bundler.js';
import { compareSlots } from './stage6-slot-comparator.js';
import { TOOL_SCHEMAS } from './stage6-tool-schemas.js';

/**
 * Sonnet model literal used by shadow-mode tool loop. Mirrors the literal at
 * eicr-extraction-session.js:365,823. If the session ever takes a configurable
 * model, thread it through here.
 */
const SHADOW_MODEL = 'claude-sonnet-4-6';

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

  // Per-turn writes accumulator. Function-local — never stored on session
  // (Pitfall #2 — cross-turn leak prevention from shadow harness).
  const perTurnWrites = createPerTurnWrites();

  // Build the dispatcher session that the tool dispatchers mutate. In LIVE
  // mode we want mutations to land on the LIVE session, not a clone — there's
  // no comparison and iOS state IS the live state.
  const liveSession = {
    sessionId: session.sessionId,
    stateSnapshot: session.stateSnapshot,
    extractedObservations: session.extractedObservations,
    toolCallsMode: 'live',
  };

  // Phase 5 ask-gate composition (same as shadow mode, but reading from the
  // live session). Falls back to write-only dispatcher if the caller didn't
  // thread pendingAsks through (Phase 3/4 back-compat).
  const pendingAsks = options.pendingAsks ?? null;
  const ws = options.ws ?? null;
  const writes = createWriteDispatcher(liveSession, log, turnId, perTurnWrites);
  // 2026-04-27 — bug-1B fix. Hook the ask dispatcher's server-side resolution
  // path into the normal write infrastructure: when ask_user carries a
  // pending_write and the user's reply matches a circuit deterministically,
  // the ask dispatcher invokes this hook to dispatch the buffered write
  // through perTurnWrites + state snapshot + log rows in the same shape a
  // Sonnet-direct write would have. Closure captures liveSession so the
  // mutation lands on the same state Sonnet sees on the next turn.
  const liveAutoResolveWrite = createAutoResolveWriteHook(liveSession, log, turnId, perTurnWrites);
  let dispatcher;
  let sortRecords;
  let askGateForTurn = null;
  if (pendingAsks) {
    let asks = createAskDispatcher(liveSession, log, turnId, pendingAsks, ws, {
      fallbackToLegacy: options.fallbackToLegacy === true,
      autoResolveWrite: liveAutoResolveWrite,
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
  const result = bundleToolCallsIntoResult(perTurnWrites, null);

  // iOS Build 282 only knows about `extracted_readings`. Fold any board-level
  // readings (record_board_reading dispatches) into extracted_readings with
  // `circuit: 0` so they render in the existing iOS UI without a TestFlight
  // update. The separate `extracted_board_readings` slot stays for forward
  // compatibility — once iOS decodes it, this fold can be removed.
  if (Array.isArray(result.extracted_board_readings)) {
    for (const br of result.extracted_board_readings) {
      result.extracted_readings.push({
        field: br.field,
        circuit: 0,
        value: br.value,
        confidence: br.confidence,
        source: br.source,
      });
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
      // op shape: { op: 'create'|'rename', circuit_ref, from_ref?, meta? }
      const ref = op.circuit_ref;
      const meta = op.meta ?? {};
      for (const [metaKey, legacyField] of Object.entries(META_TO_LEGACY_FIELD)) {
        const v = meta[metaKey];
        if (v == null) continue; // designed-as-null skips emission
        result.extracted_readings.push({
          field: legacyField,
          circuit: ref,
          value: typeof v === 'number' ? String(v) : v,
          confidence: 1.0,
          source: 'tool_call',
        });
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
    session.costTracker.addSonnetUsage(toolLoopOut.usage);
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

  return result;
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
    session.costTracker.addSonnetUsage(toolLoopOut.usage);
  }

  // Step 5: bundle ONCE post-loop (Pitfall #3 — never mid-loop).
  const toolResult = bundleToolCallsIntoResult(perTurnWrites, legacy);

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
