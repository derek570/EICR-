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
import { MUTATION_OBSERVER } from './plan00-semantic-capture.js';
import { randomUUID } from 'node:crypto';
import {
  buildPostcodeLookupNote,
  lookupResolvedPostcodeHint,
  resolvePostcodeHintState,
} from './postcode-hint.js';
import { copyAfddPremisesRequirement } from './regulation-lookup.js';
import {
  ADDRESS_MIRROR_DELIVERY,
  ADDRESS_MIRROR_DIRECT_FOLLOWUP,
} from './address-mirror-controller.js';
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
import {
  createAskGateWrapper,
  wrapAskDispatcherWithGates,
  createObsClarifyChainBroker,
  normaliseObsClarifyChainId,
} from './stage6-ask-gate-wrapper.js';
import {
  createPerTurnWrites,
  EFFECTIVE_BOARD_SLOT,
  boardSlotKey,
  EFFECTIVE_CIRCUIT_SLOT,
  FORCE_CONFIRMATIONS,
  circuitDesignationKey,
  decodeBoardReadingKey,
  decodeReadingKey,
  rawCircuitSlot,
  projectBoardReadingWinners,
  projectReadingWinners,
  readEffectiveOpBoard,
  readingSlotPartsOf,
} from './stage6-per-turn-writes.js';

/**
 * Turn-local pending-value terminals are provisional: the agent can recover in
 * a later model round and write the reading after the apology was queued. A
 * truthful read-back then supersedes the failure line. Values are compared as
 * trimmed, case-insensitive strings because dispatcher writes preserve numeric
 * strings (the production repro is "16" on both sides); null stays
 * non-comparable so an unrelated write can never erase a value-less failure.
 */
function pendingPromptComparableValue(value) {
  if (value == null) return null;
  const comparable = String(value).trim().toLowerCase();
  return comparable.length > 0 ? comparable : null;
}

function pendingValuePromptWasRecovered(prompt, perTurnWrites) {
  if (prompt?.promptKind !== 'pending_value_terminal') return false;
  const pendingValue = pendingPromptComparableValue(prompt.pendingValue);
  if (pendingValue == null) return false;

  const pendingField =
    typeof prompt.pendingField === 'string' && prompt.pendingField.trim()
      ? canonicalPartialFailureFieldIdentity(prompt.pendingField)
      : null;
  const pendingCircuit = Number.isInteger(prompt.pendingCircuit) ? prompt.pendingCircuit : null;
  const pendingBoardId = prompt.pendingBoardId ?? null;

  const matchesIdentity = ({ field, circuit = null, boardId = null, value }) => {
    if (pendingPromptComparableValue(value) !== pendingValue) return false;
    if (pendingField != null && canonicalPartialFailureFieldIdentity(field) !== pendingField) {
      return false;
    }
    if (pendingCircuit != null && circuit !== pendingCircuit) return false;
    if (pendingBoardId != null && boardId !== pendingBoardId) return false;
    return true;
  };

  for (const winner of projectReadingWinners(perTurnWrites)) {
    const slot = readingSlotPartsOf(winner.rawKey, winner.value);
    if (matchesIdentity({ ...slot, value: winner.value?.value })) return true;
  }
  for (const winner of projectBoardReadingWinners(perTurnWrites)) {
    const effective = winner.value?.[EFFECTIVE_BOARD_SLOT];
    const decoded = effective ?? decodeBoardReadingKey(String(winner.rawKey));
    if (
      matchesIdentity({
        field: decoded.field,
        circuit: null,
        boardId: decoded.boardId ?? null,
        value: winner.value?.value,
      })
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A2-multiboard item 3 — read the server-authoritative designation for a
 * circuit out of the (effective board, ref)-keyed map the harness builds
 * post-mutation. Pair FIRST, bare ref as the unscoped fallback, empty string
 * when genuinely nameless: the wire shape's `designation` is a non-optional
 * Swift `String`, so a projection must always produce one.
 */
function resolveHarnessDesignation(designations, boardId, circuitRef) {
  if (!(designations instanceof Map)) return '';
  if (boardId != null && boardId !== '') {
    // Board-scoped: the pair is the ONLY correct answer. Falling back to the
    // bare ref here would hand a sub-board circuit MAIN's name for the same
    // ref — the exact cross-board leak the pair key exists to close.
    const paired = designations.get(circuitDesignationKey(boardId, circuitRef));
    return typeof paired === 'string' && paired ? paired : '';
  }
  const bare = designations.get(circuitRef) ?? designations.get(String(circuitRef));
  return typeof bare === 'string' && bare ? bare : '';
}
// A2-multiboard — the designation map is keyed by (effective board, circuit
// ref), and the snapshot's circuit buckets are DUAL-SHAPE (main board under
// bare numeric keys, sub-boards under `${board_id}::${ref}` composites), so
// resolving the main board's id is required to key the legacy half correctly.
import { getMainBoardId } from './stage6-multi-board-shape.js';
// Plan A1a — the net-0 drain selects mandatory-notice text AT THE DRAIN
// (post-suppression) via the dispatcher module's exported selector, so the
// rotation cursor advances exactly once per emitted notice. Safe import:
// stage6-dispatchers-board.js is already in this module's graph via
// stage6-dispatchers.js.
// Plan B (honest-refusal, 2026-07-28) — the drain renders through the shared
// registry's ONE dispatch point (direct A1a rotation + terminals, B-staged
// per-slot pools + terminals); the unknown-tool staging callback is bound at
// both composition sites.
import {
  renderMandatoryNoticeText,
  stageUnknownToolRefusal,
  // Plan 2A (2026-07-30) §3.1 — the partial-failure drain, below.
  canonicalPartialFailureFieldIdentity,
  renderPartialFailureNoticeText,
  stagePartialFailureNotice,
} from './refusal-notices.js';
// Plan 2A channel 3 (2026-07-30) — the ask dispatcher's auto-resolved writes are
// dispatched through the CIRCUIT write dispatcher, so their partial-failure
// notices must key their board with the SAME formula those dispatchers use.
// Imported rather than re-derived here so there stays exactly ONE formula: a
// raw-vs-resolved key mismatch would make the drain's surviving-write
// subtraction miss and speak a FALSE "didn't save" over a value that DID land.
// Safe import — stage6-dispatchers-circuit.js is already in this module's graph
// via stage6-dispatchers.js, and it imports nothing from this file (no cycle).
import { resolveEffectiveBoardId } from './stage6-dispatchers-circuit.js';
// readback-correction-optionb §3.3a/b — rolling conversational window so the
// live model can resolve a bare "no" against the read-backs it spoke.
import {
  isReadingConfirmation,
  toReadbackEntry,
  dedupeReadbacks,
  pushReadbackTurn,
  buildReadbackWindowMessages,
} from './readback-window.js';
import {
  bundleToolCallsIntoResult,
  BUNDLER_PHASE,
  applyConfirmationDebounce,
  SAME_TURN_CLEAR_WRITE_COLLAPSED,
} from './stage6-event-bundler.js';
import { compareSlots } from './stage6-slot-comparator.js';
import { buildSessionTools } from './stage6-tool-schemas.js';
import {
  createAnswerDispatcher,
  createInspectDispatcher,
  createObservationClarificationTerminalDispatcher,
  ANSWER_FALLBACK_TEXT,
} from './stage6-dispatchers-answer.js';
import {
  tryResumePausedScript,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
} from './dialogue-engine/index.js';
import { extractNamedFieldValues, maskCircuitSpans } from './dialogue-engine/helpers/extraction.js';
// F7 Item 2 — the single dialogue-engine send choke point fires the ask
// emission observer attached to the live WS under this Symbol.
import { ASK_STARTED_OBSERVER } from './dialogue-engine/helpers/wire-emit.js';
// F7 Item 3 — shared fatal control-flow discriminator + cancellation guard.
import {
  isStage6FatalControlFlowError,
  throwIfStage6Cancelled,
} from './stage6-control-flow-errors.js';
import { OBSERVATION_PATTERN } from './pre-llm-gate.js';
import { providerForModel } from './model-provider.js';
import { FIELD_CORRECTIONS } from './field-name-corrections.js';
import { applyReadingFlagAware } from './stage6-snapshot-mutators.js';
import { buildConfirmationText } from './confirmation-text.js';
import { expandForTTS } from './tts-text-expander.js';
// id-100(b) — board-aware earthing for the speculator's impedance clamp and the
// orphan-recovery write (§4.4/§4.7); the SAME resolver the dispatchers use.
import { clampReadingForDispatch, resolveBoardAwareEarthing } from './impedance-clamp.js';
// §A1a (field-feedback-2026-07-14) — the ios_send_attempt telemetry loop
// moved here from stage6-event-bundler.js so it emits one row per SURVIVING
// wire confirmation (after the mid-stream-canonical filter AND the token-
// aware debounce), covering all five text-op fields plus every additional
// WIRE/CLIENT-enrolled field (PLAN-2C adds postcode).
import {
  buildPerCircuitDedupeKey,
  buildMultiCircuitDedupeKey,
  buildDegenerateDedupeKey,
} from './ios-dedupe-key.js';

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

function resolveSessionExtractionTarget(session, model) {
  if (typeof session?.resolveExtractionTarget === 'function') {
    return session.resolveExtractionTarget(model);
  }
  return {
    client: session?.client,
    model,
    provider: providerForModel(model),
  };
}

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
 *   rationale                   →   rationale          (Plan 06-23 obs-#51)
 *   regulation_title            →   regulation_title   (Plan 06-23 obs-#52 Fix B)
 *   regulation_description      →   regulation_description (Plan 06-23 obs-#52 Fix B)
 *
 * `circuit` is preserved (server-side `refineObservationsAsync` uses it; iOS
 * ignores unknown keys). `schedule_item` is iOS-known and now populated by
 * Stage 6 (2026-05-01 restoration) — passes through to iOS so the
 * `ObservationScheduleLinker` can auto-tick the matching Schedule of
 * Inspection row. `rationale` (obs-#51) carries the same key name as the
 * existing observation_update.rationale path so initial + refined are
 * consistent; without carrying it here the rationale is stored server-side
 * but never reaches the iOS observation card.
 *
 * `regulation_title` / `regulation_description` (obs-#52 Fix B) are the
 * canonical BS 7671 wording looked up from `config/bs7671-regulations.json`
 * by the `record_observation` dispatcher and stored on the observation. They
 * are carried here for the SAME reason as `rationale`: the dispatcher writes
 * them server-side, but without forwarding them through the legacy-wire rename
 * they never reach the iOS observation card, which would then only ever show
 * the model's `suggested_regulation` string and never the authoritative table
 * wording on a HIT. Null-fallback on a table MISS (the common case — the table
 * is BS 7671:2018+A2:2022 and most cited refs are absent).
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
      rationale: obs.rationale ?? null,
      regulation_title: obs.regulation_title ?? null,
      regulation_description: obs.regulation_description ?? null,
    };
    if (obs.circuit !== undefined) renamed.circuit = obs.circuit;
    return copyAfddPremisesRequirement(obs, renamed);
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
 * P5 (2026-07-23) — emit one `stage6.same_turn_clear_write_collapsed` INFO row
 * per collapsed circuit slot. The bundler stays pure and attaches the collapse
 * metadata non-enumerably under SAME_TURN_CLEAR_WRITE_COLLAPSED; this is the
 * single choke point that turns it into telemetry. board_id is server-derived
 * (effective slot) — no model-controlled string, so no leak-filter concern.
 */
function emitClearWriteCollapseTelemetry(log, session, turnId, result) {
  const collapsed = result?.[SAME_TURN_CLEAR_WRITE_COLLAPSED];
  if (!Array.isArray(collapsed) || collapsed.length === 0) return;
  for (const slot of collapsed) {
    try {
      log?.info?.('stage6.same_turn_clear_write_collapsed', {
        sessionId: session?.sessionId,
        turnId,
        field: slot.field,
        circuit: slot.circuit,
        board_id: slot.board_id ?? null,
        final_effect: slot.final_effect,
      });
    } catch {
      // Telemetry must never break extraction.
    }
  }
}

/*
 * A2-multiboard (2026-07-28) — `emitReplacesClearedAmbiguousTelemetry` lived
 * here, emitting one `stage6.replaces_cleared_ambiguous_projection` INFO row
 * per slot where the bundler DECLINED to stamp `replaces_cleared` because the
 * collapsed slot resolved to more than one candidate surviving reading. Both
 * the manifest Symbol and the branch that populated it are gone: the bundler
 * now projects last-write-wins per EFFECTIVE slot from the append-only write
 * journal, so two same-turn SPELLINGS of one slot resolve to exactly ONE
 * winner and the ambiguity is structurally unreachable. Removed rather than
 * left dormant — a telemetry row that can never fire reads as live
 * observability in a future review.
 */

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
// item #10 — clarifying prompts for the deterministic orphan net. Rotated by
// turn number so two consecutive orphans don't collide on iOS's text-hashed
// confirmation dedupe key (a fixed string would speak once per session and
// then be silently deduped). Phrasings are interchangeable; the rotation is
// purely to vary the dedupe key, and reads more naturally than a robotic
// repeat besides.
export const ORPHAN_PROMPTS = Object.freeze([
  "Sorry, I didn't catch what that reading was for. Could you say it again?",
  "I didn't quite get that — could you repeat the reading?",
  "Sorry, I'm not sure where that reading goes. Could you say it once more?",
]);

// M1 Defect B — spoken net for the all-tool-calls-rejected case. The action
// WAS understood (a tool call was made) but every call was rejected, so the
// turn would otherwise emit zero TTS. The inspector's strongest ask: "if it
// beeps for processing there should ALWAYS be a TTS — never silently dropped."
export const REJECTED_PROMPTS = Object.freeze([
  "Sorry, I couldn't action that — could you say it again?",
  "I wasn't able to apply that one. Could you repeat it?",
  "Sorry, that didn't go through. Could you say it once more?",
]);

// A3 (sessions F3 turn-16 / F9 turn-28) — observation-flavoured apology for
// the digit-less-observation silent-drop class ("observation that the water
// bond is not connected"). The reading nets above gate on /\d/, so a spoken
// observation with no number produced ZERO TTS when the model no-opped.
// Deliberately a SINGLE text distinct from every ORPHAN_/REJECTED_ phrasing:
// the iOS A1(b) apology dedupe keys on text, so sharing wording with the
// reading apology would cross-dedupe the two channels — and naming the
// "observation" channel tells the inspector WHICH kind of utterance was lost.
export const OBSERVATION_ORPHAN_PROMPT =
  'Sorry, I missed that observation — could you say it again?';

// Marker ① (frc_c55c996fa1014e088455af77216220d1) — the model-NO-OP audibility
// net. Field session 36731498 turn 4: "Circuit 2 is upstairs lights" was Flux-
// garbled to "Chuck it too is upstairs lights"; the live model treated the
// garble as a NO-OP (one end_turn round, zero tools) so NOTHING audible
// followed the chime (beep-then-silence). The reading/observation orphan
// branches above miss it: the garble carries no digit (carriesValue=false) and
// no observation lead-in (carriesObservation=false), so their content gate
// never fires. But a chime DID fire — and the backend gate-pass is coupled to
// the client chime (chime only if we will respond), so reaching extraction at
// all means the inspector heard a beep. The beep is a PROMISE (Audio-First #1 /
// F7 headline): a chimed turn that produces zero audible output must ALWAYS
// speak. This net closes the no-content case, gated on chimeObserved so the
// recorded lane (which bypasses the ingress gate) fires it only for turns whose
// fixture recorded a real chime. ROTATING wording (turnNum % len) like
// ORPHAN_PROMPTS so a second garble on a later turn is NOT client-deduped by
// the A1(b) 30 s field-nil TTL — a genuine repeat garble re-apologises rather
// than going silent. Distinct from every ORPHAN_/REJECTED_/OBSERVATION_ text so
// the two channels never cross-dedupe. Wording carries NO "reading" noun: we do
// not know the utterance was a reading, only that a beep went unanswered.
//
// FIVE phrasings (not three like ORPHAN_PROMPTS): the wording only wraps every
// 5 turns, so the collision that could re-silence a repeat (turnNum ≡ mod len
// within the 30 s text-keyed dedupe window) bites no earlier than the SIXTH
// consecutive no-op garble in 30 s — a shape no real session produces. Known,
// accepted limitation shared by every field-nil apology net (the F7 pre-emission
// net uses a single fixed text and collides on the 2nd repeat): a 30 s EXACT-
// wording repeat is swallowed; the rotation pushes that boundary far past any
// realistic garble burst. A fully collision-free guarantee would need the
// apology to bypass the dedupe entirely, which would spam "sorry" on a garble
// storm — deliberately not done.
export const NOOP_AUDIBILITY_PROMPTS = Object.freeze([
  "Sorry, I didn't catch that — could you say it again?",
  "I didn't quite get that — could you repeat it?",
  "Sorry, that didn't come through — could you say it once more?",
  'Sorry, I missed that one — could you say it again?',
  "I didn't get that — could you repeat that for me?",
]);

// F7 Item 2 (task #16) — the deterministic pre-emission audibility fallback.
// A fixed literal so tests, telemetry, and the client field-nil dedupe share
// one value. Rides the A4 field-nil confirmation channel (field:null,
// expects_ios_ack:false), governed on the client by the A1(b) 30 s field-nil
// TTL (the FIRST fallback per 30 s window speaks; an identical within-30 s
// repeat is swallowed — the accepted, Derek-approved design for this
// backend-only wave).
export const ASK_AUDIBILITY_FALLBACK_TEXT =
  "Sorry — I couldn't action that. Could you say it again?";

// P4 (ask-decline-ack-net 2026-07-23, feedback id 85 / session 2ACE7677) —
// the "answered-ask, silent continuation" acknowledgment families. THIS net's
// class: the assistant posed a clarify ask, the inspector ANSWERED it (a real
// reply — a decline "No. Don't worry." counts), and the continuation produced
// ZERO audible output. marker-② deliberately treats the earlier spoken ask as
// audibility evidence (its `emittedAskToolCallIds.size===0` term is correct for
// the spoken-but-UNanswered class), so an ANSWERED-then-silent turn slips every
// existing net. An answered turn that goes silent is a "chime is a promise"
// violation (Audio-First #1) exactly like a chimed no-op.
//
// TWO variants (Derek, round-1 walkthrough), because the ack must NOT read as a
// failure — the answer WAS understood (the F/U-2/3 lesson: an understood/noop
// outcome drawing a "didn't catch that" apology reads as failure):
//   - DECLINE family — for decline-shaped answers ("no", "don't worry",
//     "leave it", "skip it"): an affirmative "I'm leaving that one" ack.
//   - ANSWERED family — for any other silent-but-answered outcome: a plain
//     "Okay."-class ack.
// Both ROTATE turnNum % len (like NOOP_/CATCHALL_) so a burst of answered
// silences doesn't collide inside the client's 30 s text-keyed field-nil
// dedupe, AND so the recorded-lane fixture's `text_exact` oracle is
// deterministically computable. Wording is a DELIBERATELY DIFFERENT
// construction from EVERY existing apology family (no "Sorry" / "didn't catch"
// / "couldn't" / "Hmm" / "nothing came" stems) so the field-nil channels never
// cross-dedupe — pinned by the string-inequality assertion in
// stage6-ask-decline-ack-net.test.js.
// FIVE phrasings each (Codex r2), matching the NOOP_/CATCHALL_ burst margin:
// the wording wraps only every 5 turns, so a repeat cannot re-silence a burst
// (turnNum ≡ mod len inside the client's 30 s field-null TTL) before the SIXTH
// consecutive answered-silent turn in 30 s — a shape no real session produces.
// APPEND-ONLY (never reorder) so the recorded fixture's `text_exact` (decline
// index 1 = "No problem, moving on.") stays stable.
export const ASK_DECLINE_ACK_PROMPTS = Object.freeze([
  'Okay — leaving that one.',
  'No problem, moving on.',
  "Alright — I'll leave that as it is.",
  "That's fine — I'll leave it there.",
  'Sure — leaving that as it stands.',
]);
export const ASK_ANSWERED_ACK_PROMPTS = Object.freeze([
  'Okay, got it.',
  'Right, noted.',
  'Understood.',
  'Got that, thanks.',
  'Noted — carrying on.',
]);

// marker-② (numeric-gate-redesign 2026-07-18) — the FINAL catch-all audibility
// net's apology family. Fires when a chime was heard but the turn produced
// ZERO speech-intent of any kind — the "a tool ran, didn't error, but emitted
// nothing audible" class the earlier nets structurally miss (live prod repro:
// "Zs for circuit 4." → the model calls calculate_zs, which succeeds with
// computed:[] because the circuit has no R1+R2 — not producedNothing, not
// allRejected, no attempted ask → beep-then-silence, 8/8 reproducible).
// ROTATING (turnNum % len) with FIVE phrasings for the same burst margin as
// NOOP_AUDIBILITY_PROMPTS. Wording is a deliberately DIFFERENT construction
// from every other apology family (ORPHAN_/REJECTED_/OBSERVATION_/NOOP_/
// ASK_AUDIBILITY_FALLBACK_TEXT/D2) so the client A1(b) text-keyed field-nil
// dedupe can never cross-dedupe the channels — pinned by the string-inequality
// assertion in stage6-catchall-audibility-net.test.js. No "reading" noun (we
// only know a beep went unanswered) and no "couldn't action / didn't catch /
// didn't get" stems (taken by the other families).
export const CATCHALL_AUDIBILITY_PROMPTS = Object.freeze([
  "Hmm, that didn't give me anything to work with — could you try it again?",
  'I heard you, but nothing came of that — could you give it to me again?',
  "That didn't produce anything I could use — mind trying it once more?",
  'Nothing came out of that one — could you run it past me again?',
  "I couldn't make anything of that — would you give it another go?",
]);

// item #10 — default ON (the inspector explicitly asked for a spoken ASK
// instead of a silent drop). Set VOICE_ORPHAN_PROMPT=false to disable
// without a code change if it over-asks on numeric chitchat in the field.
const ORPHAN_PROMPT_ENABLED = process.env.VOICE_ORPHAN_PROMPT !== 'false';

// #5a apply-complete guard — field report 2026-06-24 #4/#5. When the orphan
// net is about to fire on a turn that produced NOTHING but the transcript
// plainly carries a structurally-complete reading (the garble class — e.g. a
// Deepgram mishearing the dialogue-engine deterministic trigger missed), apply
// it instead of emitting a contentless clarifying prompt. Default ON; set
// IR_ORPHAN_APPLY_COMPLETE=false to fall back to the prompt without a redeploy
// (the flag is allowlisted in scripts/audit-env-var-source.sh and persisted to
// ecs/task-def-backend.json — infra-from-source). This is a SEPARATE flag from
// VOICE_ORPHAN_PROMPT; do NOT conflate them.
const ORPHAN_APPLY_COMPLETE_ENABLED = process.env.IR_ORPHAN_APPLY_COMPLETE !== 'false';

// Dialogue-engine schema SLOT field name → Stage 6 canonical extraction field
// name. extractNamedFieldValues returns the slot field (e.g. RCD uses the wire
// name `rcd_trip_time`); the Stage 6 path stores + ships the canonical
// `rcd_time_ms` (validateAndCorrectFields rewrites it to the iOS wire form
// downstream, exactly as for a Haiku-emitted reading). Explicit map — NOT an
// inverse of FIELD_CORRECTIONS, whose RHS collides (rcd_time_ms AND
// rcd_trip_time_ms both map to rcd_trip_time) and would be order-dependent. IR
// slots are already canonical so they pass through unchanged.
const ORPHAN_SLOT_TO_STAGE6_FIELD = Object.freeze({ rcd_trip_time: 'rcd_time_ms' });

/**
 * Deterministic re-parse for the #5a apply-complete guard. The orphan net fires
 * only when the turn `producedNothing`, so there is NO structured reading in
 * `result` to apply — the complete reading exists ONLY in `transcriptText`.
 * Re-parse it with the dialogue-engine schema extractors and return a single
 * complete `{slotField, circuit, value}` tuple, or null if there is not EXACTLY
 * one (zero, or ambiguous multiple → fall through to the clarifying prompt
 * rather than risk mis-placing a safety-critical reading). Circuit is taken
 * ONLY from the trigger's explicit digit capture — no fuzzy designation
 * resolution in the net.
 *
 * @param {string} transcriptText
 * @param {Array} schemas  dialogue-engine schemas (ALL_DIALOGUE_SCHEMAS)
 * @returns {{slotField: string, circuit: number, value: string}|null}
 */
export function reparseSingleCompleteReading(transcriptText, schemas) {
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  if (!text || !Array.isArray(schemas)) return null;
  const tuples = [];
  for (const schema of schemas) {
    let circuit = null;
    for (const pattern of schema.triggers ?? []) {
      const m = text.match(pattern);
      if (m && m[1]) {
        const ref = Number(m[1]);
        if (Number.isInteger(ref) && ref > 0) {
          circuit = ref;
          break;
        }
      }
    }
    if (circuit === null) continue;
    // Feedback id 109 wave (2026-07-29): mask `circuit N` spans
    // (length-preserving) BEFORE extraction. The ring slots' value-first
    // extractor arm is now live, and this call previously received the RAW
    // text — "ring continuity for circuit 13 on the lives" would bind the
    // circuit number 13 as the R1 VALUE ("13 [connector] the lives" matches
    // value-first). The circuit was already derived from the trigger's
    // explicit digit capture above, so masking loses nothing. Same canonical
    // maskCircuitSpans the engine's own extraction call sites use.
    const volunteered = extractNamedFieldValues(maskCircuitSpans(text), schema.slots);
    for (const v of volunteered) {
      if (v && v.field && v.value !== undefined && v.value !== null && v.value !== '') {
        tuples.push({ slotField: v.field, circuit, value: v.value });
      }
    }
  }
  return tuples.length === 1 ? tuples[0] : null;
}

/**
 * Apply a single complete reading recovered by the orphan-net re-parse:
 * persist to the backend snapshot (flag-aware, multi-board), push a wire
 * reading (canonical field name → validateAndCorrectFields rewrites it), and
 * push a content-bearing spoken read-back (audio-first invariant #1 — the
 * inspector verifies by ear). Returns the pushed reading.
 */
export function applyOrphanRecoveredReading({ session, result, tuple, turnId }) {
  const stage6Field = ORPHAN_SLOT_TO_STAGE6_FIELD[tuple.slotField] ?? tuple.slotField;
  // id-100(b) (2026-07-25) — the orphan net is an INDEPENDENT write path: it
  // reaches applyReadingFlagAware without passing through any Stage-6
  // dispatcher, so the dispatcher clamp does not cover it. An out-of-range
  // continuity value recovered here would be stored raw while the client
  // divided it — the same server/client split-brain as C06B9904, just via a
  // different door. Circuit-scoped with no board_id, so earthing resolves for
  // the main board (the same `null` the dispatchers pass for an unscoped write).
  const orphanClamp = clampReadingForDispatch({
    field: stage6Field,
    value: tuple.value,
    earthing: resolveBoardAwareEarthing(session.stateSnapshot, null),
  });
  const orphanValue = orphanClamp.value;
  // Plan 00B §B2 — the orphan net completes the model turn's inspector
  // utterance deterministically; its committed write is attributed to the
  // model path with a via-marker so expectations can distinguish it.
  const orphanObserver = session.stateSnapshot?.[MUTATION_OBSERVER] ?? null;
  if (orphanObserver) {
    orphanObserver.setOriginFrame({
      origin: 'model_direct',
      meta: { via: 'orphan_recovery', field: stage6Field },
    });
  }
  try {
    applyReadingFlagAware(session.stateSnapshot, {
      circuit: tuple.circuit,
      field: stage6Field,
      value: orphanValue,
    });
  } finally {
    if (orphanObserver) orphanObserver.clearOriginFrame();
  }
  if (!Array.isArray(result.extracted_readings)) result.extracted_readings = [];
  const reading = {
    field: stage6Field,
    circuit: tuple.circuit,
    value: orphanValue,
    confidence: 0.9,
    source_turn_id: turnId ?? null,
  };
  result.extracted_readings.push(reading);
  const designation = session.stateSnapshot?.circuits?.[tuple.circuit]?.circuit_designation ?? null;
  const text = buildConfirmationText(stage6Field, orphanValue, tuple.circuit, designation, {
    correction: orphanClamp.correction,
  });
  if (text) {
    if (!Array.isArray(result.confirmations)) result.confirmations = [];
    result.confirmations.push({
      text,
      expanded_text: expandForTTS(text),
      field: stage6Field,
      circuit: tuple.circuit,
      // Recovered out-of-band — it never went through the fast-path POST, so
      // the audio-finalizer must not expect a reconciling ACK for it.
      expects_ios_ack: false,
    });
  }
  return reading;
}

async function runLiveMode(session, transcriptText, regexResults, options, log) {
  const turnNum = (session.turnCount ?? 0) + 1;
  const turnId = `${session.sessionId}-turn-${turnNum}`;

  // PLAN-C P4c — response-epoch ownership. The epoch stamped on every OUTBOUND
  // speech frame must be the RESPONSE epoch — the id of the utterance that
  // PRODUCED the speech — NOT `options.utteranceId` (the id that OPENED this
  // tool loop). When an ask raised on utterance A is answered by chimed
  // utterance B, B's confirmations/pvr re-ask must carry B's id so the client
  // watchdog B's chime armed disarms on the speech it hears. Seed from the
  // inbound transcript; the ask dispatcher advances `.current` after each
  // await ONLY when the resolved outcome carries a non-empty epoch (see
  // stage6-dispatcher-ask.js). `bundleToolCallsIntoResult` snapshots `.current`
  // at frame-construction time instead of reading `options.utteranceId`.
  const responseEpochRef = {
    current: typeof options.utteranceId === 'string' ? options.utteranceId : null,
  };

  // Lookup is current-turn enrichment only. It must not mutate a site slot
  // before the authoritative postcode write chooses site versus client.
  const postcodeHintState = options.postcodeHintState ?? resolvePostcodeHintState({ regexResults });
  const postcodeLookupResult = await lookupResolvedPostcodeHint(postcodeHintState, {
    logger: log,
    sessionId: session.sessionId,
    lane: 'live',
  });
  // A blocking ask can be answered by a later transcript carrying its own
  // postcode hint. The mutable ref lets the answer dispatcher replace the
  // opening utterance's lookup before any resumed postcode write dispatches.
  const postcodeLookupRef = { current: postcodeLookupResult };
  const postcodeLookupNote = buildPostcodeLookupNote(postcodeLookupResult);

  // Per-turn writes accumulator. Function-local — never stored on session
  // (Pitfall #2 — cross-turn leak prevention from shadow harness).
  const perTurnWrites = createPerTurnWrites();

  // Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8.4) + Phase 1
  // (Pivot 9, 12.2). Resolve the activeSessions entry once at the top so
  // we can seed `fastPathCorrelationIdByTurn` from
  // `options.regexFastCorrelationId` so the audio finalizer's
  // pre-decrement drain has the right correlation set. Anything that
  // mutates the entry's per-turn maps below MUST be torn down in the
  // `finally` block below the main body — error paths would otherwise
  // leak this turn's entry forward and the speculator skip check would
  // fire on a stale slot.
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

  // PLAN-C P4d (row 1) — stash the LIVE response-epoch ref so the
  // start_dialogue_script dispatcher (dispatchStartDialogueScript) can stamp
  // its first ask_user_started with the current response epoch at emit time.
  // The ref (not a snapshotted value) is stashed because responseEpochRef
  // advances mid-turn as asks resolve; the dispatcher reads `.current` at the
  // moment enterScriptByName emits. Cleared in the finally below, same as
  // activeTurnTranscript, so a cross-turn read is impossible.
  session.activeResponseEpochRef = responseEpochRef;

  // F7 Item 2 — function-scoped mirrors of the live WS + its ask-emission
  // observer so the `finally` below can detach the observer (both `ws` and
  // `onAskUserStarted` are declared inside the try). Assigned once the
  // observer is attached; the finally only removes OUR own observer.
  let f7EmissionWs = null;
  let f7EmissionObserver = null;

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

    // ── F7 Item 2 — per-turn ask-emission audit ──────────────────────────
    // The pre-emission audibility net (below, before the A4 drain) must
    // distinguish "emitted then timed out" from "swallowed/closed send, ask
    // stayed registered, later reported timeout" — a post-loop parse of
    // outcome text CANNOT. So we capture POSITIVE emission at the SOURCE:
    // this Set holds the tool_call_id of every ask_user_started that actually
    // crossed the wire. onAskUserStarted is fired ONLY on a successful send
    // by (a) the initial ask dispatcher (source:'initial'), (b) registered
    // brokers (`pvr-*` source:'pvr', `mdr-*` source:'multi_description'), and
    // (c) the dialogue engine's single send choke point safeSend
    // (source:'dialogue_script', via the ws-attached observer below).
    // Best-effort OBSERVATION hook — it never alters registration,
    // questionEmitted, send classification, or the pending Promise.
    // generationId (minted in sonnet-stream, threaded via options) correlates
    // the emission/fallback/ios_send_attempt rows across the ship-gate join.
    const emittedAskToolCallIds = new Set();
    // Test-only seam (mirrors options._shadowCapture — underscore-prefixed,
    // never passed in production): a mocked-runToolLoop lane has no real
    // dispatcher / safeSend to populate emission evidence, so a test that
    // needs to simulate a SUCCESSFULLY-emitted ask (spoken over WS) declares
    // those tool_call_ids here. This keeps the emission-gated D2 + pre-emission
    // nets exercisable in the fast/mocked lanes.
    if (Array.isArray(options._seedEmittedAskToolCallIds)) {
      for (const id of options._seedEmittedAskToolCallIds) {
        if (id != null) emittedAskToolCallIds.add(id);
      }
    }
    const generationId = options.generationId ?? null;
    // marker-② hoist (numeric-gate-redesign 2026-07-18) — ONE definition of
    // the two audibility helpers, shared by the F7 pre-emission net, the
    // marker-② catch-all net, and the §A4 generation-owned drain (they were
    // previously re-declared block-scoped inside F7 and A4, so a net added
    // after them could not reference them).
    //   isAudibleText — trimmed-non-empty (web trims before speaking; a
    //   whitespace-only text is NOT audible).
    //   isCurrentGenPrompt — a queued prompt counts toward THIS turn's
    //   audibility only if it belongs to the current generation (or is
    //   untracked); a preserved OTHER-generation prompt must not suppress a
    //   fallback (else beep-then-silence recurs behind a stale prompt that
    //   also never drains).
    const isAudibleText = (t) => typeof t === 'string' && t.trim().length > 0;
    const isCurrentGenPrompt = (p) =>
      generationId == null || p?.generationId == null || p.generationId === generationId;
    // Plan 2A (2026-07-30) §3.1 — HOISTED out of the A3 orphan block (where it
    // was `const allRejected = …`, block-scoped) so the partial-failure drain
    // that runs LATER in this function can read it. The classification itself
    // is unchanged and still computed at its original site; only the
    // declaration moved.
    //
    // The default is FAIL-AUDIBLE. When the enclosing orphan block never runs
    // (no orphan tool calls at all — the ordinary success path), `allRejected`
    // stays false, which means the partial-failure drain rule (1) does NOT
    // drop the notices and a genuine partial failure still speaks. The
    // opposite default would silence exactly the class this plan exists to
    // remove.
    let allRejected = false;
    let addressMirrorDirectFollowup = null;
    // marker-② predicate-4 "already-spoken evidence": count of confirmations
    // PRODUCED this turn but suppressed by the backend applyConfirmationDebounce
    // (the inspector heard the same reading on a recent turn). Captured from
    // the debounce block's before/after lengths below; per-turn (NOT the
    // cumulative session lastSuppressedCount, which would falsely exempt later
    // silent turns). CLIENT-side dedupe is deliberately invisible here — that
    // case belongs to the PLAN-C client watchdog.
    let debouncedConfirmationCountThisTurn = 0;
    // ── P4 (ask-decline-ack-net) — per-turn ask-lifecycle ledger ──────────
    // The answered-ask net (after marker-②, below) needs to know, for THIS
    // turn: was the LAST ask the model/broker emitted actually ANSWERED by a
    // real user reply (a decline counts; a timeout / user_moved_on does NOT),
    // and did nothing audible follow it? None of the existing signals carry
    // that — the marker-② counters (result.confirmations / spoken_response /
    // debounce) are created only AFTER the blocking tool loop returns, so they
    // cannot be snapshotted at resolution; onAskRegistered/onAskUserStarted
    // fire PRE-answer with no outcome; the pending-asks registry is per-SESSION
    // not per-turn. So we keep a per-turn ledger keyed by tool_call_id,
    // populated by onAskUserStarted (emission) + the NEW onAskAnswered
    // resolution-time observer (answered flag + sanitized decline class). A
    // single monotonic counter stamps emission/resolution order so the net can
    // find the LAST emitted ask and test whether it was answered. `srv-*`
    // dialogue-engine asks enter via onAskUserStarted (ASK_STARTED_OBSERVER)
    // but NEVER receive an onAskAnswered call (they bypass pendingAsks and are
    // answered on a LATER transcript), so they stay `answered:false` and are
    // excluded from the answered set automatically.
    let askEventSeq = 0;
    const askLifecycleLedger = new Map();
    const recordAskEmission = (toolCallId, source) => {
      askEventSeq += 1;
      const existing = askLifecycleLedger.get(toolCallId);
      if (existing) {
        // A RE-EMISSION of the same id is a FRESH, not-yet-answered question:
        // clear the prior resolution + decline class so a stale answered:true /
        // decline family can never carry over (Codex mini-review NIT). The
        // resolutionSeq>emissionSeq guard already prevents firing until a new
        // resolution lands; resetting the class prevents a re-answered ask from
        // speaking the previous answer's wording.
        existing.emissionSeq = askEventSeq;
        existing.resolutionSeq = null;
        existing.answered = false;
        existing.declineClass = null;
        if (existing.source == null) existing.source = source ?? null;
      } else {
        askLifecycleLedger.set(toolCallId, {
          id: toolCallId,
          source: source ?? null,
          emissionSeq: askEventSeq,
          resolutionSeq: null,
          answered: false,
          declineClass: null,
        });
      }
    };
    const VALID_EMISSION_SOURCES = new Set([
      'initial',
      'pvr',
      'multi_description',
      'dialogue_script',
    ]);
    const onAskUserStarted = ({ toolCallId, source } = {}) => {
      if (toolCallId == null) return;
      // Record emission evidence FIRST so a logger throw below cannot erase
      // it — else an emitted question is misclassified silent and the
      // fallback double-speaks. The telemetry emit is a SEPARATE try/catch.
      emittedAskToolCallIds.add(toolCallId);
      // P4 — stamp emission order into the per-turn ask ledger (before the
      // telemetry try/catch so a logger throw cannot lose the ledger entry).
      recordAskEmission(toolCallId, source);
      try {
        log?.info?.('stage6.ask_user_started_emitted', {
          sessionId: session.sessionId,
          turnId,
          generationId,
          tool_call_id: toolCallId,
          // The three call sites always pass a valid source; guard defensively
          // so a future caller's typo surfaces as null rather than corrupting
          // the source split.
          source: VALID_EMISSION_SOURCES.has(source) ? source : null,
        });
      } catch {
        // never let a telemetry failure erase emission evidence
      }
    };
    // ── P4 — resolution-time observer (the ONLY hook carrying the answered
    // outcome). Fired from the ask dispatcher AFTER its blocking await AND from
    // the pvr broker inside buildResolvedBody/resolvePendingValueFlow, threaded
    // through options the same way onAskRegistered is. SWALLOWS all errors so a
    // failing observer can never deadlock or corrupt ask resolution. Only asks
    // that went through pendingAsks reach here, so `srv-*` engine asks are
    // excluded by construction.
    const onAskAnswered = ({ toolCallId, answered, declineClass, source } = {}) => {
      if (toolCallId == null) return;
      try {
        askEventSeq += 1;
        const existing = askLifecycleLedger.get(toolCallId);
        if (existing) {
          existing.resolutionSeq = askEventSeq;
          existing.answered = answered === true;
          // Assign UNCONDITIONALLY (Codex mini-review NIT): a null declineClass
          // (a non-decline answer) must OVERWRITE a prior decline class from an
          // earlier resolution of the same id, else a re-answered ask speaks the
          // stale decline family.
          existing.declineClass = declineClass ?? null;
          if (source != null && existing.source == null) existing.source = source;
        } else {
          // Resolution before a recorded emission is not a real path (asks
          // emit before they resolve), but record defensively so the ledger is
          // never lied to by an out-of-order call.
          askLifecycleLedger.set(toolCallId, {
            id: toolCallId,
            source: source ?? null,
            emissionSeq: null,
            resolutionSeq: askEventSeq,
            answered: answered === true,
            declineClass: declineClass ?? null,
          });
        }
      } catch {
        // resolution must never deadlock on an observer failure
      }
    };
    // Test-only seam (underscore-prefixed, never passed in production): a
    // mocked-runToolLoop lane has no real dispatcher to drive the ask
    // lifecycle, so a test replays ordered {event:'emitted'|'answered', ...}
    // records through the REAL observers above — exercising the ledger +
    // answered-ask net rather than a parallel path.
    if (Array.isArray(options._seedAskLifecycle)) {
      for (const ev of options._seedAskLifecycle) {
        if (!ev || ev.toolCallId == null) continue;
        if (ev.event === 'emitted')
          onAskUserStarted({ toolCallId: ev.toolCallId, source: ev.source });
        else if (ev.event === 'answered')
          onAskAnswered({
            toolCallId: ev.toolCallId,
            answered: ev.answered !== false,
            declineClass: ev.declineClass ?? null,
            source: ev.source,
          });
      }
    }
    // Attach to the live WS so the dialogue engine's safeSend choke point
    // reports its ask_user_started emissions through the same observer. Torn
    // down in the finally block so it never leaks across turns.
    if (ws) ws[ASK_STARTED_OBSERVER] = onAskUserStarted;
    f7EmissionWs = ws;
    f7EmissionObserver = onAskUserStarted;

    // Pass `ws` through createWriteDispatcher's extraCtx so the
    // start_dialogue_script dispatcher (added 2026-04-30 Silvertown
    // follow-up) can hand it to enterScriptByName for first-ask emission.
    // Other dispatchers in the table ignore it.
    // readback-correction-optionb §6 — thread the parsed capability so
    // dispatchRecordReading's PRE-APPLY gate can skip `< 0.5` readings
    // until the client advertises low_conf_readback_v1 (rollout safety).
    const hasLowConfReadbackV1 = entry?.voiceLatency?.capabilities?.hasLowConfReadbackV1 === true;
    // P3 Fix 8 — thread the LIM-ranged-write capability so the record_reading +
    // bulk dispatchers DENY a LIM on a capability-gated field until the client
    // advertises `lim_ranged_write_v1` (rollout safety: a pre-guard client would
    // silently overwrite the LIM via recomputeAll / render a false-green status).
    const hasLimRangedWriteV1 = entry?.voiceLatency?.capabilities?.hasLimRangedWriteV1 === true;
    // Plan A1a (2026-07-27) — thread the board-clear capability so
    // dispatchClearBoardReading's deny-first gate can distinguish a capable
    // client from the dark-state default. Parsed once at session_start
    // (sonnet-stream.js) into the active-session entry; the SHADOW lane
    // threads the SAME parsed value (see runShadowHarness) — a
    // lane-asymmetric capability would make live clear while shadow denies,
    // diverging the clone from live state and reporting spurious divergence
    // on every subsequent turn.
    const hasBoardClearV1 = entry?.voiceLatency?.capabilities?.hasBoardClearV1 === true;
    // Plan B §3.2 — the bound refusal-staging callback for BOTH unknown-tool
    // envelope routes (composer string-form + write-dispatcher object-form).
    // Bound here because createToolDispatcher carries no session/perTurnWrites
    // of its own; passed to createWriteDispatcher too so the two routes stage
    // identically.
    const onUnknownToolRefusal = (toolCallId) =>
      stageUnknownToolRefusal(perTurnWrites, liveSession, { turnId, toolCallId });
    const writes = createWriteDispatcher(liveSession, log, turnId, perTurnWrites, {
      ws,
      hasLowConfReadbackV1,
      hasLimRangedWriteV1,
      hasBoardClearV1,
      onUnknownToolRefusal,
      postcodeLookupResult,
      postcodeLookupRef,
    });
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
      perTurnWrites,
      // P3 Codex-r4 — a LIM/value answer to an ask_user / pending-value question
      // resolves through record_reading, so carry the same capability context.
      { hasLimRangedWriteV1 }
    );
    // A1 agentic-voice (2026-07-23) — the two read-only answer-feature
    // dispatchers. Constructed INDEPENDENTLY of pendingAsks (both composition
    // branches below receive them): a tool must never be advertised without a
    // dispatch route. Cheap closures — constructing them on flag-off turns is
    // harmless because the tools are then not advertised (buildSessionTools).
    const liveAgenticAnswersEnabled = liveSession?.agenticAnswersEnabled === true;
    const answers = createAnswerDispatcher(liveSession, log, turnId, perTurnWrites);
    const inspects = createInspectDispatcher(liveSession, log, turnId, perTurnWrites);
    const observationClarificationTerminals = createObservationClarificationTerminalDispatcher(
      liveSession,
      log,
      turnId
    );
    const addressMirrorTurnController = entry?.addressMirrorController
      ? {
          claimLiveAsk: (args) =>
            entry.addressMirrorController.claimLiveAsk({ ...args, perTurnWrites }),
          resolveLiveAnswer: (args) =>
            entry.addressMirrorController.resolveLiveAnswer({ ...args, perTurnWrites }),
        }
      : null;
    let dispatcher;
    let sortRecords;
    let askGateForTurn = null;
    if (pendingAsks) {
      let asks = createAskDispatcher(liveSession, log, turnId, pendingAsks, ws, {
        fallbackToLegacy: options.fallbackToLegacy === true,
        autoResolveWrite: liveAutoResolveWrite,
        addressMirrorController: addressMirrorTurnController,
        // F7 Item 2 — the emission audit hook (initial + pvr broker sends).
        onAskUserStarted,
        // P4 — the resolution-time hook (initial await + pvr broker) that
        // stamps the answered outcome + decline class into the per-turn ledger.
        onAskAnswered,
        // F7 Item 3 — the CONTROL hook (arms the watchdog latch on register)
        // + the per-generation abort signal so a ceiling-cancelled generation's
        // awaiting dispatcher throws (after each pending-ask await, before any
        // auto-resolve write / apology / new registration) instead of mutating
        // state; generationId stamps queued apologies for generation-owned drain.
        onAskRegistered: options.onAskRegistered,
        signal: options.signal ?? null,
        generationId,
        // PLAN-C P4c — the dispatcher advances this ref's `.current` after each
        // initial/pvr await when the resolved outcome carries a non-empty epoch
        // (direct-frame `utterance_id` OR transcript-origin `response_utterance_id`).
        responseEpochRef,
        postcodeLookupRef,
        // Plan 2A channel 3 (2026-07-30, feedback id 112) — STAGING callback for
        // an auto-resolved write that did not land. A callback rather than the
        // `perTurnWrites` accumulator itself: the ask dispatcher has never held
        // the accumulator, and handing it one just to reach a single array would
        // also hand it every other per-turn channel. Closed over THIS turn's
        // accumulator here. Circuit writes use the circuit dispatcher's
        // effective-board formula; board writes read the dispatcher-stamped
        // winner identity below, so the drain compares each notice with the
        // exact scope its sibling actually mutated.
        // The SHADOW composition site deliberately gets nothing — it supplies no
        // `autoResolveWrite`, so no auto-resolved write ever runs there.
        stagePartialFailureNotice: (spec) => {
          const requestedEffectiveBoardId =
            resolveEffectiveBoardId(liveSession, spec?.boardId) ?? null;
          let noticeBoardId = requestedEffectiveBoardId;

          // PLAN-2B §3.3 — a record_board_reading winner carries the
          // scope-CONDITIONED EFFECTIVE_BOARD_SLOT identity chosen by the
          // board dispatcher. In particular Ze/PFC are global and therefore
          // stamped with boardId:null even when the ask originated on "main"
          // or a selected sub-board. Re-resolving the raw ask id with the
          // circuit formula would stage the sibling notice under the selected
          // board and the drain would (correctly) suppress it as winnerless.
          // Prefer the exact scoped winner, then the global winner; never
          // borrow another concrete board's write for this notice.
          if (spec?.boardReading === true) {
            const canonicalField = canonicalPartialFailureFieldIdentity(spec?.field);
            const boardWinnerSlots = projectBoardReadingWinners(perTurnWrites)
              .map((winner) => winner?.value?.[EFFECTIVE_BOARD_SLOT] ?? null)
              .filter(
                (slot) =>
                  slot != null &&
                  canonicalPartialFailureFieldIdentity(slot.field) === canonicalField
              );
            const exactWinner = boardWinnerSlots.find(
              (slot) => (slot.boardId ?? null) === requestedEffectiveBoardId
            );
            const globalWinner = boardWinnerSlots.find((slot) => slot.boardId == null);
            const effectiveWinner = exactWinner ?? globalWinner ?? null;
            if (effectiveWinner) noticeBoardId = effectiveWinner.boardId ?? null;
          }

          stagePartialFailureNotice(perTurnWrites, {
            ...spec,
            boardId: noticeBoardId,
          });
        },
      });
      if (options.askBudget && options.restrainedMode) {
        askGateForTurn = createAskGateWrapper({
          logger: log,
          sessionId: liveSession.sessionId,
          mode: 'live',
        });
        // §D2 (field-feedback-2026-07-14) — per-session observation_clarify
        // chain broker. Lazy on the session (like confirmationDebounceState)
        // so chain ids survive across turns; the wrapper mints/stamps chain
        // ids and keys the ask budget per OBSERVATION instead of per scope.
        if (!liveSession.obsClarifyChains) {
          liveSession.obsClarifyChains = createObsClarifyChainBroker();
        }
        asks = wrapAskDispatcherWithGates(asks, {
          askBudget: options.askBudget,
          restrainedMode: options.restrainedMode,
          gate: askGateForTurn,
          filledSlotsShadow: options.filledSlotsShadow ?? (() => {}),
          logger: log,
          sessionId: liveSession.sessionId,
          mode: 'live',
          obsClarifyChains: liveSession.obsClarifyChains,
        });
      }
      dispatcher = createToolDispatcher(writes, asks, {
        answers,
        inspects,
        observationClarificationTerminals,
        onUnknownToolRefusal,
      });
      sortRecords = createSortRecordsAsksLast();
    } else {
      // A1: route through the composer even without pendingAsks so
      // answer_user/inspect_session_state always have a dispatch route;
      // ask_user falls back to `writes` inside the composer, reproducing the
      // pre-A1 unknown_tool behaviour byte-for-byte (plan B: plus the staged
      // model_contract refusal riding beside that envelope).
      dispatcher = createToolDispatcher(writes, null, {
        answers,
        inspects,
        observationClarificationTerminals,
        onUnknownToolRefusal,
      });
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
    //
    // Plan B (2026-06-17) B1a: the mid-stream advertisement is now SUPPRESSED
    // (onSlotAudioReady wired to null below), so this Set is never populated —
    // it stays empty and the gated VOICE_MID_STREAM_FILTER block further down
    // is a structural no-op. Kept (rather than ripped out) to avoid disturbing
    // the gated filter logic; the canonical confirmations flow unfiltered and
    // claim the parked MP3 post-validation.
    const midStreamEmittedSlots = new Set();
    // readback-correction-optionb §3.3a — per-turn accumulator of the read-backs
    // the inspector actually HEARD, sourced from BOTH the loaded-barrel mid-
    // stream path (onSlotAudioReady, below) AND the final post-debounce/post-
    // filter reading confirmations (after the debounce step). De-duped + pushed
    // onto session.readbackWindow at the end of the turn.
    const spokenReadbacks = [];
    let speculator = null;
    try {
      const vl = getVoiceLatencyForSession(session.sessionId);
      if (vl?.flags?.loadedBarrel === true && session.costTracker) {
        // Plan B (2026-06-17) B1b — seed the speculator with existing circuit
        // designations from the session snapshot so a reading on an ALREADY-
        // named circuit speculates "Cooker, Zs 0.62" (matching the bundler's
        // emitted text) instead of "Circuit 4, Zs 0.62" (a false MISS).
        // Snapshot-only here; same-turn circuit_designation writes are layered
        // on inside the speculator as its hooks observe them. Mirrors the
        // snapshot read the post-loop circuitDesignations build does (below).
        //
        // A2-multiboard item 3 — seeded in BOTH key spaces, mirroring the
        // post-loop circuitDesignations build below verbatim. The old
        // `Number(key)` filter dropped every composite `${board_id}::${ref}`
        // bucket, so a sub-board circuit's name never reached the SPECULATED
        // read-back — the speculator said "Circuit 4, Zs 0.62" while the
        // bundler said "Shed sockets, Zs 0.62", a guaranteed validate-time
        // MISS on exactly the multi-board turns the pre-synth exists to speed
        // up. The two builds must stay identical: a divergence is a serve of
        // the wrong circuit's name.
        const initialDesignations = new Map();
        const seedCircuits = session?.stateSnapshot?.circuits;
        const seedMainBoardId = getMainBoardId(session?.stateSnapshot);
        if (seedCircuits && typeof seedCircuits === 'object') {
          for (const [key, circ] of Object.entries(seedCircuits)) {
            if (!circ || typeof circ !== 'object') continue;
            const d = circ.circuit_designation;
            if (typeof d !== 'string' || !d.trim()) continue;
            const refNum = Number(key);
            if (Number.isInteger(refNum) && refNum > 0) {
              // Legacy bare-numeric key — the MAIN board's bucket namespace.
              initialDesignations.set(refNum, d.trim());
              initialDesignations.set(circuitDesignationKey(seedMainBoardId, refNum), d.trim());
              continue;
            }
            // Composite `${board_id}::${ref}` bucket — a SUB-board circuit,
            // keyed by its own board and NEVER claiming the bare ref.
            const subRef = Number.isInteger(circ.circuit) ? circ.circuit : null;
            if (subRef == null || subRef <= 0 || typeof circ.board_id !== 'string') continue;
            initialDesignations.set(circuitDesignationKey(circ.board_id, subRef), d.trim());
          }
        }
        speculator = createSpeculator({
          sessionId: session.sessionId,
          // apiKey via fn so a secret rotation survives without re-instantiation.
          apiKey: () => getElevenLabsKey(),
          costTracker: session.costTracker,
          logger: log,
          initialDesignations,
          // id-100(b) (2026-07-25) — board-aware earthing for the speculator's
          // impedance clamp. Passed as a closure over the live snapshot (NOT a
          // captured string) so it resolves through the exact same ladder the
          // dispatchers use; a divergence here would make the pre-synthesised
          // line differ from the emitted confirmation, which is a cache MISS at
          // best and a wrong spoken value at worst.
          resolveEarthing: (boardId) => resolveBoardAwareEarthing(session.stateSnapshot, boardId),
          // A2-multiboard item 3 — effective-board resolver for the DESIGNATION
          // lookup. Same closure-over-live-snapshot shape as resolveEarthing, and
          // for the same reason: the effective board is select_board state the
          // dispatchers mutate mid-turn, so a captured string would be wrong on
          // exactly the cross-board turns this exists for.
          //
          // Resolution chain mirrors getCircuitBucket / circuitExistsInSnapshot —
          // explicit board_id → currentBoardId → canonical main — so the
          // speculator scopes a designation to the same bucket the dispatcher
          // wrote it into.
          resolveEffectiveBoard: (boardId) => {
            if (typeof boardId === 'string' && boardId !== '') return boardId;
            const snap = session?.stateSnapshot;
            const current = snap?.currentBoardId;
            if (typeof current === 'string' && current !== '') return current;
            return getMainBoardId(snap);
          },
          // P3 Fix 8 — deny LIM pre-synthesis on capability-gated fields when the
          // client hasn't advertised `lim_ranged_write_v1` (the dispatcher will
          // SKIP the write, so a pre-synth confirmation would be a false
          // read-back for a write that never lands).
          hasLimRangedWriteV1: entry?.voiceLatency?.capabilities?.hasLimRangedWriteV1 === true,
          // Plan B (2026-06-17) B1a — SUPPRESS the mid-stream advertisement.
          //
          // PREVIOUSLY (2026-05-28 mid-stream emit, lever 1): the moment a
          // speculation's ElevenLabs synth completed + the cache CAS confirmed
          // ready, this callback pushed a preliminary `extraction` WS envelope
          // carrying `mid_stream_preview: true` so iOS could POST for the cached
          // audio ~500-720 ms before Sonnet's stream completed. That advertised
          // — and let iOS PLAY — speculative audio MID-TURN, BEFORE the loop
          // validated the turn. On a turn that then took a second tool call /
          // round 2 (a correction, a broadcast, a grouped confirmation), iOS had
          // already played the now-wrong per-slot confirmation. A post-hoc
          // invalidate cannot un-play served audio. This was the owner's
          // "speculation fires too early / serves wrong audio" complaint.
          //
          // NOW: do NOT advertise speculative audio mid-turn at all. The MP3 is
          // still synthesised + parked (markReady CAS, state==='ready') during
          // the stream via the content_block_stop streaming hook (B2), so the
          // latency win is preserved — the audio is *ready and waiting*, just not
          // advertised. iOS learns of it via the NORMAL canonical confirmation
          // POST, which arrives AFTER the loop validates (runLiveMode emits
          // result.confirmations post-runToolLoop) and claims the parked MP3 by
          // slot + expandedText (loaded-barrel-cache.buildCacheKey / keys.js:438).
          // B1b post-loop validate (validateAgainstConfirmations below) then
          // invalidates any parked entry whose text didn't survive to the final
          // emitted confirmation (correction / grouped line / dropped-by-confidence).
          //
          // We deliberately do NOT re-emit/flush the preview after validation:
          // the canonical confirmation already reaches iOS for the surviving
          // slot, so a late preview flush would double-POST/double-play the same
          // slot (the `midStreamEmittedSlots` dedup at the canonical filter has
          // already run by then). Suppress-and-rely-on-canonical is the contract.
          //
          // `onSlotAudioReady: null` ⇒ the speculator's fire path
          // (loaded-barrel-speculator.js:670) sees a non-function and skips, so
          // no preview envelope is ever built and `midStreamEmittedSlots` stays
          // empty (the gated VOICE_MID_STREAM_FILTER block below is now a no-op).
          onSlotAudioReady: null,
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

    // readback-correction-optionb §3.3b — inject the rolling window as fresh
    // PER-TURN messages BEFORE the current utterance (NOT into the cached
    // system blocks — that would invalidate the large cached prefix every
    // turn). Chronological user→assistant pairs put the most recent read-back
    // immediately before the current utterance, so a bare "no" sits adjacent to
    // the value it rejects. Empty window → [] → byte-identical to the old
    // single-message shape. The window holds PRIOR turns only (the current turn
    // is appended after this turn's read-backs are known, below).
    const readbackWindow = Array.isArray(session.readbackWindow) ? session.readbackWindow : [];
    const windowMessages = buildReadbackWindowMessages(readbackWindow);

    // item #10 context-carry (Derek's confirmed refinement). When the
    // previous turn was an orphan (a forwarded, digit-bearing utterance that
    // produced zero tool calls → emitted the "say it again" prompt below),
    // its raw transcript is stashed on session.orphanContext. The inspector's
    // repeat lands THIS turn — inject the prior unplaced utterance as a fresh
    // per-turn note immediately before the current transcript so the model
    // resolves placement from BOTH together (load-bearing when the repeat is
    // itself garbled). Only consume it for the IMMEDIATELY following turn;
    // otherwise it is stale and discarded (the inspector moved on).
    const orphanContext = session.orphanContext ?? null;
    session.orphanContext = null; // consume-or-discard: never carry >1 turn
    const orphanContextMessages =
      orphanContext && orphanContext.turnNum === turnNum - 1
        ? [
            {
              role: 'user',
              content: `[note] My previous words "${orphanContext.transcript}" weren't understood and nothing was recorded. I'm repeating that reading now — use both my previous words and what I say next to work out the field, circuit, and value.`,
            },
          ]
        : [];

    const liveMessages = [
      ...windowMessages,
      ...orphanContextMessages,
      {
        role: 'user',
        content: postcodeLookupNote
          ? `${transcriptText}\n\n[${postcodeLookupNote}]`
          : transcriptText,
      },
    ];

    // readback-correction-optionb §6 — round-1 tool_choice:any no-op allowance:
    // NO LONGER NEEDED. PR #60 (Plan B) removed the round-1 tool_choice:any
    // FORCE from the tool loop entirely (it was tied to the now-suppressed
    // mid-stream speculation timing), so round 1 already uses the default
    // (auto) tool_choice — a forwarded standalone negation with no applicable
    // read-back in the window can already emit ZERO tools and no-op. With no
    // force to disable, the bespoke negation gate is moot; the rolling-window
    // injection above is the load-bearing part of resolving a bare "no".

    // ── Observation-tier model routing (chunk C1) ────────────────────────
    // The live path historically ran EVERY turn — including observation
    // severity coding (C1/C2/C3/FI + BPG4 reasoning) — on SHADOW_MODEL
    // (= process.env.SONNET_EXTRACT_MODEL = Haiku in prod). The tiered router
    // in EICRExtractionSession.callWithRetry (eicr-extraction-session.js:2798)
    // that escalates observation turns to OBSERVATION_EXTRACT_MODEL (Sonnet)
    // is DEAD on this path — runLiveMode hard-coded model: SHADOW_MODEL.
    //
    // Ship DARK behind OBSERVATION_TIER_ROUTING (default OFF): flag off →
    // selectedModel === SHADOW_MODEL for every turn → the live path is
    // byte-identical to pre-C1. Flag on → an observation-shaped RAW utterance
    // routes the whole tool loop (incl. any blocking ask_user continuation)
    // to OBSERVATION_EXTRACT_MODEL. Rollback = flip the flag off (task-def
    // edit + CI redeploy), NOT an edit of OBSERVATION_EXTRACT_MODEL. Mirrors
    // A1 (VOICE_AGENTIC_ANSWERS) / WS4 (DEEPGRAM_STT_MODEL) dark-ship-then-flip.
    //
    // ⚠️ Classify on the RAW inspector text, NOT `transcriptText`. On an answer
    // turn sonnet-stream.js:3758 prepends "[In response to TTS question…]" to
    // transcriptText BEFORE runShadowHarness, so classifying it could match
    // OBSERVATION_PATTERN on the QUESTION context and wrongly escalate a bare
    // "yes" — violating server-context isolation. The prod ingress + the
    // replay/bench harness callers thread the untouched msg.text as
    // options.rawInspectorTranscript; classify ONLY that. (Non-live callers /
    // legacy tests omit it → '' → never matches → stays on the default model,
    // which under flag-off is SHADOW_MODEL anyway.)
    //
    // Coverage note (accepted, not a regression): OBSERVATION_PATTERN keys off
    // observation-shaped phrasing; a record_observation whose utterance did not
    // match it stays on the default model — a partial improvement, never a
    // regression. The fuller mapped-category classifier is a C2 (gate) concern.
    const observationTierFlagEnabled =
      (process.env.OBSERVATION_TIER_ROUTING || '').trim() === 'true';
    const observationModel = (process.env.OBSERVATION_EXTRACT_MODEL || '').trim();
    const rawInspectorTranscript =
      typeof options.rawInspectorTranscript === 'string' ? options.rawInspectorTranscript : '';
    // classifier_match is the RAW-text pattern result, independent of the flag
    // (telemetry distinguishes "matched" from "flag let it route").
    const observationClassifierMatch = OBSERVATION_PATTERN.test(rawInspectorTranscript);
    const routeToObservationTier =
      observationTierFlagEnabled && observationClassifierMatch && observationModel.length > 0;
    const selectedModel = routeToObservationTier ? observationModel : SHADOW_MODEL;
    const selectedTarget = resolveSessionExtractionTarget(session, selectedModel);
    const observationOpenAIServiceTier =
      routeToObservationTier && selectedTarget.provider === 'openai'
        ? (process.env.OPENAI_OBSERVATION_SERVICE_TIER || 'standard').trim()
        : undefined;
    const observationOpenAIReasoningEffort =
      routeToObservationTier && selectedTarget.provider === 'openai'
        ? (process.env.OPENAI_OBSERVATION_REASONING_EFFORT || 'low').trim()
        : undefined;
    // Observation-tier turns LOCK the model across every round (disable the
    // round-1 VOICE_LATENCY_ROUND1_MODEL Haiku override so the escalation isn't
    // undone on round 1); reading turns keep the latency override.
    const round1OverrideLocked = routeToObservationTier;
    // Routing telemetry — the formerly-dead seam has no built-in proof of which
    // model ran, so the post-flip P8 live probes could silently still be on
    // Haiku. Emit ONE PII-safe structured event (no transcript text) BEFORE the
    // tool loop; a routing test asserts it and the post-flip live-probe
    // checklist requires its presence as evidence the seam is active.
    // Payload is EXACTLY the plan-specified five routing-decision fields — no
    // transcript text (PII-safe) and no extra keys, so the event shape is a
    // stable, asserted contract (see the routing test's exact-shape check).
    log?.info?.('stage6.observation_tier_routing', {
      classifier_match: observationClassifierMatch,
      flag_enabled: observationTierFlagEnabled,
      selected_model: selectedModel,
      selected_provider: selectedTarget.provider,
      default_model: SHADOW_MODEL,
      round1_override_locked: round1OverrideLocked,
    });

    // F7 Item 3 — per-generation cancellation. `signal` fires when the
    // extraction watchdog's absolute ceiling (or a no-ask 30s deadline) aborts
    // this generation. `cancelled` is latched in the runToolLoop catch below so
    // the post-loop finalization runs its REDUCED, toolLoopOut-independent path
    // (bundler + designation maps + generation-owned drain + fallback +
    // ios_send_attempt) instead of crashing on an undefined toolLoopOut — every
    // applied write is still read back once and the queued apology still speaks.
    const signal = options.signal ?? null;
    let cancelled = false;
    let toolLoopOut;
    const loopInvocationId = `${session.sessionId}:${options.extractionTurnId}:${generationId ?? randomUUID()}`;
    let accountingStarted = false;
    let failedBillableUsage = null;
    let billableRoundUsage = [];
    try {
      // Do not enter the tool loop on a generation cancelled during the
      // pre-loop postcode await (guards the snapshot from post-abort mutation).
      throwIfStage6Cancelled(signal);
      accountingStarted = session.costTracker?.beginBillableInvocation?.(loopInvocationId) === true;
      toolLoopOut = await runToolLoop({
        client: selectedTarget.client,
        // Observation-tier routing (C1) — SHADOW_MODEL under flag-off /
        // reading turns; OBSERVATION_EXTRACT_MODEL for an observation-shaped
        // raw utterance when OBSERVATION_TIER_ROUTING is on. Computed once
        // above. (The mode==='shadow' comparison call ~:3470 stays on
        // SHADOW_MODEL — its contract is matching SHADOW_MODEL; do NOT change
        // that one.)
        model: selectedTarget.model,
        provider: selectedTarget.provider,
        openAIServiceTier: observationOpenAIServiceTier,
        openAIReasoningEffort: observationOpenAIReasoningEffort,
        // Lock the selected model across every round for observation-tier
        // turns (disable the round-1 latency override); reading turns keep it.
        allowRound1ModelOverride: !round1OverrideLocked,
        system: systemBlocks,
        messages: liveMessages,
        // A1: flag-filtered toolset — the session-latched master flag decides
        // whether answer_user/inspect_session_state are advertised.
        tools: buildSessionTools(liveAgenticAnswersEnabled),
        dispatcher,
        ctx: { sessionId: session.sessionId, turnId },
        billingIdentity: loopInvocationId,
        logger: log,
        sortRecords,
        // F7 Item 3 — thread the abort signal into the loop.
        signal,
        // Loaded Barrel hooks — onSnapshotPatch / onLoopComplete are
        // passed only when the speculator exists, so a flag-off prod
        // session has zero overhead. The wrapper checks function-ness
        // before calling.
        //
        // perTurnWritesRef is passed UNCONDITIONALLY: onLoopComplete reads
        // the finalised per-turn writes at end-of-loop for speculator drift
        // detection, so the ref must be available whether or not the
        // speculator hooks are wired this turn. The runToolLoop wrapper
        // still no-ops the function when undefined (back-compat with tests
        // that don't supply it).
        perTurnWritesRef: () => perTurnWrites,
        onSnapshotPatch: speculator?.onSnapshotPatch,
        onLoopComplete: speculator?.onLoopComplete,
        // Loaded Barrel Phase 2.D (2026-05-25) — streamed-tool hook. Fires
        // INSIDE the per-round stream loop as each tool_use's
        // content_block_stop arrives, so the speculator can begin
        // ElevenLabs pre-synth while Sonnet is still streaming subsequent
        // tool_use blocks. Multi-tool turns save ~hundreds of ms per
        // tool. Dedup via cachePeek inside _speculate ensures the
        // onSnapshotPatch fire that arrives later doesn't double-synth.
        onToolUseStreamed: speculator?.onToolUseStreamed,
      });
    } catch (err) {
      failedBillableUsage = err?.billableUsage ?? null;
      askGateForTurn?.destroy();
      // F7 Item 3 — a FATAL control-flow error (watchdog ceiling cancellation /
      // ask-registration hook) does NOT early-return an empty extraction: it
      // FALLS THROUGH to the post-loop finalization with `cancelled = true` so
      // writes already applied before the wedged ask are still read back and
      // the queued apology still speaks (Audio-First invariants a + c). Only
      // NEW model rounds / ask registrations / certificate mutations are
      // suppressed post-abort; toolLoopOut stays undefined and the
      // toolLoopOut-dependent blocks below are skipped.
      if (isStage6FatalControlFlowError(err)) {
        cancelled = true;
        try {
          log.info?.('stage6_live_cancelled', {
            sessionId: session.sessionId,
            turnId,
            generationId,
            reason: err?.name ?? 'ExtractionCancelledError',
          });
        } catch {
          // swallow logger failure — never break finalization
        }
        // fall through to the finalization below
      } else {
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
        // marker-② wave (Codex diff-review cycle 2) — a GENERIC live failure
        // (network/API/stream error) used to early-return an EMPTY extraction
        // HERE, before A3/D2/F7/marker-②/A4 ever ran: a forwarded, chimed
        // turn died beep-then-silence on any transport error. Route it
        // through the SAME reduced finalization the F7 Item-3 cancellation
        // path uses (toolLoopOut stays undefined; every deref below is
        // guarded): applied pre-crash writes are still read back once, and
        // the F7 cancellation-branch fallback ("nothing audible survived")
        // guarantees ONE spoken apology. iOS still receives a well-formed
        // (partial) result. The error stays in CloudWatch via the
        // stage6_live_error row above.
        cancelled = true;
        // fall through to the finalization below
      }
    } finally {
      billableRoundUsage = toolLoopOut?.round_usage ?? failedBillableUsage?.round_usage ?? [];
      session.costTracker?.ingestBillableUsage?.(
        loopInvocationId,
        billableRoundUsage,
        'inspector_live'
      );
      if (accountingStarted) {
        session.costTracker?.endBillableInvocation?.(loopInvocationId);
      }
    }

    askGateForTurn?.destroy();

    // ── A1 agentic-voice — turnAnswerState FINALIZATION (PLAN Item 4) ─────
    // Runs at the post-loop seam: AFTER the runToolLoop try/catch (BOTH the
    // normal return AND the cancelled fallthrough — perTurnWrites.answer is
    // dispatcher-fed, so it survives the throw) and BEFORE
    // bundleToolCallsIntoResult, whose projection turns the staged text into
    // result.spoken_response. The ANSWER FEATURE guarantees its OWN
    // audibility in both confirmation-toggle states: all apology nets below
    // are confirmationsEnabled-gated, so "the nets apologise" cannot cover a
    // confirmation-OFF failed answer. Stage the FIXED fallback when the
    // feature was attempted (ANY answer_user OR inspect_session_state call —
    // the prompt's inspect-then-answer flow makes inspect-then-silence a
    // reachable failure), nothing was staged, and the turn produced no
    // successful write and no emitted ask (a mixed inspect+write turn is
    // owned by the read-back / the documented opt-out — pinned NO-fallback).
    // Deliberately derived from turnAnswerState alone, never by re-parsing
    // toolLoopOut.tool_calls (undefined on cancelled turns); runs on
    // cancelled turns too (cancelled-turn policy).
    try {
      const answerState = perTurnWrites.answer;
      if (answerState?.featureTouched === true && answerState.stagedText == null) {
        const hadSuccessfulWrite =
          (perTurnWrites.readings?.size ?? 0) > 0 ||
          (perTurnWrites.boardReadings?.size ?? 0) > 0 ||
          (perTurnWrites.cleared?.length ?? 0) > 0 ||
          (perTurnWrites.observations?.length ?? 0) > 0 ||
          (perTurnWrites.deletedObservations?.length ?? 0) > 0 ||
          (perTurnWrites.circuitOps?.length ?? 0) > 0 ||
          (perTurnWrites.boardOps?.length ?? 0) > 0;
        const hadEmittedAsk = emittedAskToolCallIds.size > 0;
        if (!hadSuccessfulWrite && !hadEmittedAsk) {
          answerState.stagedText = ANSWER_FALLBACK_TEXT;
          answerState.stagedMeta = {
            fallback: true,
            truncated: false,
            chars: ANSWER_FALLBACK_TEXT.length,
          };
          log.info?.('stage6.answer_fallback_staged', {
            sessionId: session.sessionId,
            turnId,
            generationId,
            cancelled,
            outcomes: answerState.outcomes.map((o) => ({ tool: o.tool, code: o.code })),
          });
        }
      }
    } catch (answerFinalErr) {
      log.warn?.('stage6.answer_finalization_error', {
        sessionId: session.sessionId,
        turnId,
        error: answerFinalErr?.message ?? String(answerFinalErr),
      });
    }

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
    //
    // A2-multiboard (2026-07-28) — the map now carries TWO key spaces:
    //   * `circuitDesignationKey(effectiveBoardId, ref)` — the real identity.
    //     Circuit refs are PER BOARD, so ref alone is not an identity: a
    //     `select_board A → rename circuit 3 → select_board B → rename circuit
    //     3` turn used to leave ONE entry and both boards' read-backs spoke
    //     board B's name.
    //   * the bare numeric ref — retained for genuinely UNSCOPED lookups
    //     (legacy single-board traffic, and any reading that reaches the
    //     bundler with no board_id). The two key spaces cannot collide (the
    //     pair key is NUL-delimited), so single-board behaviour is unchanged.
    const circuitDesignations = new Map();
    const snapshotCircuits = session?.stateSnapshot?.circuits;
    const snapshotMainBoardId = getMainBoardId(session?.stateSnapshot);
    if (snapshotCircuits && typeof snapshotCircuits === 'object') {
      for (const [key, circ] of Object.entries(snapshotCircuits)) {
        if (!circ || typeof circ !== 'object') continue;
        const d = circ.circuit_designation;
        if (typeof d !== 'string' || !d.trim()) continue;
        const refNum = Number(key);
        if (Number.isInteger(refNum) && refNum > 0) {
          // Legacy bare-numeric key — the MAIN board's bucket namespace
          // (see stage6-multi-board-shape.js getCircuitBucket).
          circuitDesignations.set(refNum, d.trim());
          circuitDesignations.set(circuitDesignationKey(snapshotMainBoardId, refNum), d.trim());
          continue;
        }
        // Composite `${board_id}::${ref}` bucket — a SUB-board circuit. These
        // were skipped entirely before (the `Number(key)` parse yields NaN),
        // so a sub-board circuit's name never reached the spoken read-back at
        // all; key them by their own board.
        const subRef = Number.isInteger(circ.circuit) ? circ.circuit : null;
        if (subRef == null || subRef <= 0 || typeof circ.board_id !== 'string') continue;
        circuitDesignations.set(circuitDesignationKey(circ.board_id, subRef), d.trim());
      }
    }
    // Overlay: same-turn circuit_designation writes win. Sonnet emitting
    // create_circuit + record_reading(designation) + record_reading(zs)
    // in one turn must hear "Cooker, Zs 0.62" — not "Circuit 4, Zs 0.62".
    //
    // A2-multiboard — projected from the JOURNAL winners, not the raw Map, and
    // keyed by the EFFECTIVE board. The raw Map key is board-ambiguous
    // (`record_reading` omits `board_id` in the common case), so two boards'
    // same-ref designation writes collapsed onto one entry and the raw-Map
    // last-writer's name was spoken for BOTH. The winner projection is
    // last-write-wins per effective slot, so each board keeps its own.
    for (const { rawKey: key, value: entry } of projectReadingWinners(perTurnWrites)) {
      const decoded = decodeReadingKey(key);
      if (decoded.field !== 'circuit_designation') continue;
      const sym = entry?.[EFFECTIVE_CIRCUIT_SLOT];
      const refNum = Number(sym?.circuit ?? decoded.circuit);
      const valueStr = String(entry?.value ?? '').trim();
      if (!Number.isInteger(refNum) || refNum <= 0 || !valueStr) continue;
      const effectiveBoardId = sym ? (sym.boardId ?? null) : (decoded.boardId ?? null);
      if (effectiveBoardId != null) {
        circuitDesignations.set(circuitDesignationKey(effectiveBoardId, refNum), valueStr);
      }
      // The bare-ref entry is the unscoped-lookup fallback. Only a write on the
      // MAIN/unscoped board may claim it: letting a sub-board write own the
      // bare ref is exactly the cross-board leak this re-key closes.
      if (effectiveBoardId == null || effectiveBoardId === snapshotMainBoardId) {
        circuitDesignations.set(refNum, valueStr);
        if (effectiveBoardId == null) {
          circuitDesignations.set(circuitDesignationKey(snapshotMainBoardId, refNum), valueStr);
        }
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

    // Circuit populations feeding the "All circuits, …" fan-out phrasing.
    //
    // A2-multiboard item 8 (2026-07-28) — the scalar below is measured against
    // the SESSION'S currently-selected board, but a confirmation GROUP is not
    // necessarily about that board: the dispatcher resolves an effective board
    // per write, so one turn can fan out on the board the inspector just left,
    // or on two boards at once. Measuring every group against one session-wide
    // scalar is how "All circuits" comes to mean "all circuits on some OTHER
    // board" — an over-claim the hands-free inspector cannot see is wrong, on
    // the one phrasing whose whole job is to assert completeness.
    //
    // So we ALSO build a per-board census and let the bundler pick the count
    // that belongs to each group. Two key namespaces have to be folded in
    // (stage6-multi-board-shape.js): the legacy-namespace owner's circuits sit
    // under bare numeric keys, every other board's under `${board_id}::${ref}`.
    // The composite half was invisible to the scalar (`Number('garage::3')` is
    // NaN), which is precisely why a sub-board fan-out could never be counted.
    //
    // The scalar's own arithmetic is deliberately UNCHANGED — bare keys only,
    // same currentBoardId filter — because it is still the answer for a
    // single-board job, and the bundler now uses it ONLY there.
    let totalCircuitsInJob = 0;
    const totalCircuitsByBoard = new Map();
    if (snapshotCircuits && typeof snapshotCircuits === 'object') {
      const currentBoardId = session?.stateSnapshot?.currentBoardId ?? null;
      for (const [key, circ] of Object.entries(snapshotCircuits)) {
        if (!circ || typeof circ !== 'object') continue;
        // `lastIndexOf` rather than `indexOf`: board ids are barred from
        // containing '::' at write time, but splitting on the LAST separator
        // is the same defensive convention `decodeReadingKey` uses.
        const sep = key.lastIndexOf('::');
        const isComposite = sep > 0;
        const refNum = Number(isComposite ? key.slice(sep + 2) : key);
        if (!Number.isInteger(refNum) || refNum <= 0) continue;

        // Effective board, most-specific first: the bucket's own attribution
        // (what the dispatchers stamp) → the composite key's prefix → the
        // board that owns the legacy bare-numeric namespace (`getMainBoardId`,
        // already resolved above for the designation map).
        const effBoard =
          circ.board_id ?? (isComposite ? key.slice(0, sep) : null) ?? snapshotMainBoardId;
        if (typeof effBoard === 'string' && effBoard !== '') {
          totalCircuitsByBoard.set(effBoard, (totalCircuitsByBoard.get(effBoard) ?? 0) + 1);
        }

        if (isComposite) continue;
        if (currentBoardId && circ.board_id && circ.board_id !== currentBoardId) continue;
        totalCircuitsInJob += 1;
      }
    }

    if (entry?.addressMirrorController) {
      const successfulAddressFields = new Set(
        projectBoardReadingWinners(perTurnWrites)
          .filter((winner) => winner?.value?.derived !== true)
          .map((winner) => decodeBoardReadingKey(winner.rawKey).field)
      );
      const directFinal = await entry.addressMirrorController.finalizeDirectAfterWrites({
        successfulFields: successfulAddressFields,
        perTurnWrites,
        sourceAudible: options.confirmationsEnabled === true,
      });
      if (directFinal?.handled && typeof directFinal.question === 'string') {
        addressMirrorDirectFollowup = directFinal;
      }
    }

    const result = bundleToolCallsIntoResult(perTurnWrites, null, {
      confirmationsEnabled:
        options.confirmationsEnabled === true || perTurnWrites[FORCE_CONFIRMATIONS] === true,
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
      //
      // PLAN-C P4c — SNAPSHOT the response epoch at frame-construction time,
      // NOT `options.utteranceId`. When an in-flight ask was answered by a
      // LATER chimed utterance, the dispatcher advanced `responseEpochRef` to
      // that utterance's id; these confirmations belong to it, so the client
      // watchdog it armed disarms on them. Falls back to the seed
      // (options.utteranceId) when no ask advanced the epoch this turn.
      utteranceId: responseEpochRef.current,
      circuitDesignations,
      boardDesignations,
      totalCircuitsInJob,
      // A2-multiboard item 8 — the per-board census. The bundler resolves each
      // confirmation group's effective board and looks its population up here;
      // `totalCircuitsInJob` above stays the answer only for an unambiguous
      // single-board job (see resolveTotalForBoard in stage6-event-bundler.js).
      totalCircuitsByBoard,
      // PLAN voice-feedback-2026-06-05 W1.4 — thread the session logger
      // through so the bundler can emit one `ios_send_attempt` row per
      // confirmation entry (with byte-equal-to-iOS expected_dedupe_key
      // + confidence). Omitted when the bundler is invoked outside the
      // harness (test fixtures); the emit is silently skipped there.
      logger: log,
      sessionId: session.sessionId,
      // Plan A1a (round-8) — capability gate for the projected-write board
      // identity (extracted_board_readings[].board_id fill from the
      // EFFECTIVE_BOARD_SLOT stamp). Capability-absent sessions stay
      // byte-identical; the capability + classification boundary is the
      // wire-compat line.
      hasBoardClearV1,
    });
    if (addressMirrorDirectFollowup) {
      Object.defineProperty(result, ADDRESS_MIRROR_DIRECT_FOLLOWUP, {
        value: addressMirrorDirectFollowup,
        enumerable: false,
        configurable: false,
      });
    }
    if (perTurnWrites[ADDRESS_MIRROR_DELIVERY]) {
      Object.defineProperty(result, ADDRESS_MIRROR_DELIVERY, {
        value: perTurnWrites[ADDRESS_MIRROR_DELIVERY],
        enumerable: false,
        configurable: true,
      });
    }

    // P5 (2026-07-23) — emit clear→write collapse telemetry (live path).
    emitClearWriteCollapseTelemetry(log, session, turnId, result);

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
        // Preserve server-owned provenance across the legacy circuit:0 fold.
        // This additive flag lets clients suppress local correction speech for
        // automatic mirror/locality writes even when Voice confirmations are
        // disabled; dictated readings continue to omit it and remain audible.
        if (br.derived === true) synthesised.derived = true;
        // A2-multiboard item 7 (2026-07-28) — carry the collapse flag through
        // the fold. `extracted_board_readings` is STRIPPED below (the iOS
        // Codable decoder rejects the slot), so this synthesised circuit:0 copy
        // is the ONLY shape any client ever sees for a board write. Dropping
        // the flag here would leave a collapsed board replacement arriving as a
        // bare write against a still-populated cell — silently skipped by a
        // fill-only apply gate, spoken but never written.
        if (br.replaces_cleared === true) synthesised.replaces_cleared = true;
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
          //
          // A2-multiboard item 3 — the address is the EFFECTIVE board, not the
          // raw one. `create_circuit`'s `board_id` is optional and the common
          // model call omits it (scope comes from `select_board`), so a
          // `select_board B → create circuit 4 named "Cooker"` turn used to
          // send an UNSCOPED designation reading that both clients landed on
          // MAIN. The stamp is what the server actually mutated.
          const synthesised = {
            field: legacyField,
            circuit: ref,
            value: typeof v === 'number' ? String(v) : v,
            confidence: 1.0,
            source: 'tool_call',
          };
          const effBoard = readEffectiveOpBoard(op);
          if (effBoard != null) synthesised.board_id = effBoard;
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
    // F7 Item 3 — SKIP the dialogue-resume/entry hooks on a cancelled
    // generation: they can create NEW asks / mutations post-abort, which the
    // cancellation contract forbids.
    if (!cancelled && Array.isArray(result.circuit_updates) && result.circuit_updates.length > 0) {
      try {
        tryResumePausedScript({
          session,
          ws,
          schemas: ALL_DIALOGUE_SCHEMAS,
          circuitUpdates: result.circuit_updates,
          logger: log,
          // PLAN-C P4d (row 1) — the resume-time disambiguation / next-slot ask
          // is emitted in response to THIS turn's utterance; stamp it with the
          // current response epoch so the client chime watchdog disarms on it.
          responseEpoch: responseEpochRef.current,
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
    if (
      !cancelled &&
      Array.isArray(result.extracted_readings) &&
      result.extracted_readings.length > 0
    ) {
      try {
        const entryResult = tryEnterScriptFromWrites({
          session,
          ws,
          schemas: ALL_DIALOGUE_SCHEMAS,
          readings: result.extracted_readings,
          // PLAN-C P4d (row 1) — the first ask this Sonnet-write-triggered entry
          // emits is a response to THIS turn's utterance; stamp it with the
          // current response epoch (chime-watchdog disarm source).
          responseEpoch: responseEpochRef.current,
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
    //
    // A2-multiboard item 3 (2026-07-28) — the fold above is LOSSY, and this
    // block is now the lossless complement for the two shapes it cannot carry:
    //
    //   1. A metadata-free `create_circuit` (only `circuit_ref`). Every
    //      META_TO_LEGACY_FIELD value is null, so the fold emits NOTHING, and
    //      the strip below removes the only other carrier — the created row
    //      reached NEITHER client. The next dictated reading for it then had
    //      no row to land on.
    //   2. A `rename_circuit` that RENUMBERS (`from_ref !== circuit_ref`).
    //      The fold emits the new ref's meta but never `from_ref`, so a client
    //      could only ever ADD a row at the new ref and left the old one
    //      behind as a duplicate.
    //
    // Ops that the fold DOES represent (a create/rename carrying a
    // designation, same ref) are deliberately NOT duplicated here — the fold's
    // designation reading already creates/renames the row on both clients, and
    // a second carrier would risk a double read-back.
    //
    // `designation` is always a String because iOS's `CircuitUpdate` Codable
    // declares it non-optional and throws away the WHOLE extraction message on
    // a shape mismatch (the Bug-F class). It is sourced from the op's own meta
    // first, then the server-authoritative post-mutation designation map, so a
    // projection can never blank a name the server still holds.
    const legacyShapeCircuitOps = [];
    if (Array.isArray(result.circuit_updates)) {
      for (const op of result.circuit_updates) {
        if (!op || !Number.isInteger(op.circuit_ref) || op.circuit_ref <= 0) continue;
        // A2-multiboard item 3 — address every projected op to the board the
        // server actually mutated. `board_id` is optional on all three circuit
        // tools and the common model call omits it (scope comes from
        // `select_board`), so the raw key sent an unscoped op that both clients
        // resolved against MAIN — deleting or renumbering the wrong board's
        // circuit. Slice 1.2 extended iOS's CircuitUpdate Codable with the
        // optional boardId field; pre-fix clients ignore it via decodeIfPresent.
        const effBoard = readEffectiveOpBoard(op);
        const metaDesig =
          typeof op?.meta?.designation === 'string' && op.meta.designation.trim()
            ? op.meta.designation.trim()
            : null;

        if (op.op === 'delete') {
          // designation:'' is a placeholder — iOS ignores it for deletes (see
          // applyCircuitUpdates handler), and web's handler resolves the row by
          // (board_id, circuit) alone.
          const projected = { circuit: op.circuit_ref, designation: '', action: 'delete' };
          if (effBoard != null) projected.board_id = effBoard;
          legacyShapeCircuitOps.push(projected);
          continue;
        }

        const renumbering =
          op.op === 'rename' && Number.isInteger(op.from_ref) && op.from_ref !== op.circuit_ref;
        const unrepresentedByFold = op.op === 'create' && metaDesig == null;
        if (!renumbering && !unrepresentedByFold) continue;

        const projected = {
          circuit: op.circuit_ref,
          designation:
            metaDesig ?? resolveHarnessDesignation(circuitDesignations, effBoard, op.circuit_ref),
          action: op.op,
        };
        if (effBoard != null) projected.board_id = effBoard;
        if (renumbering) projected.from_ref = op.from_ref;
        legacyShapeCircuitOps.push(projected);
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

    // Re-emit the projected ops in the legacy iOS shape AFTER the strip so the
    // iOS CircuitUpdate decoder accepts them. Only set the slot if there are
    // any — an empty array would be benign for current iOS but pointlessly
    // noisy in session logs.
    if (legacyShapeCircuitOps.length > 0) {
      result.circuit_updates = legacyShapeCircuitOps;
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
      // marker-② — per-turn capture of the produced-then-debounced count
      // (already-spoken evidence for the catch-all audibility net below).
      debouncedConfirmationCountThisTurn = suppressed;
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

    // §A1a ios_send_attempt telemetry + `_confidence` strip: MOVED below
    // the A3 orphan net / D2 clarification fallback / A4 voice-prompt drain
    // (Codex r8-#2) — those appenders run later in this function and their
    // confirmations reach the wire too, so emitting here missed them.

    // readback-correction-optionb §3.3a — add the FINAL post-debounce/post-
    // filter READING confirmations to the per-turn accumulator (state-change /
    // observation / deletion / clear confirmations are excluded so a bare "no"
    // never binds a non-reading). Runs AFTER the mid-stream-filter + debounce
    // so the buffer reflects exactly what iOS will play. Combined with the
    // mid-stream entries pushed during the loop, then de-duped by slot identity
    // (a slot read back mid-stream AND finally appears ONCE).
    if (Array.isArray(result.confirmations)) {
      for (const c of result.confirmations) {
        if (isReadingConfirmation(c)) spokenReadbacks.push(toReadbackEntry(c));
      }
    }
    // Push this turn onto the rolling window (PRIOR turns were used for
    // injection above; the current turn becomes available to the NEXT turn).
    // Stored even when empty so read-backs age out by turn count (§7 staleness).
    session.readbackWindow = pushReadbackTurn(
      session.readbackWindow,
      transcriptText,
      dedupeReadbacks(spokenReadbacks)
    );

    // A2-multiboard item 4 — reconcile same-turn COLLAPSED clear→write
    // replacements before the drift validation runs.
    //
    // Ordering is load-bearing, and this is deliberately its OWN block rather
    // than a branch inside the validate guard below. The validate pass compares
    // expanded TEXT only, so a speculation parked under the null board (the
    // model omits `board_id` in the common case) whose text equals the emitted
    // confirmation is judged VALID and left servable for its whole TTL — even
    // though the surviving write reached the wire enriched with its effective
    // board. Reconciliation therefore gets first refusal on those entries;
    // whatever it does not terminate falls through to the ordinary drift check
    // unchanged. The separate-block shape also means a LOADED_BARREL-off
    // session, or an older speculator with no such method, is a silent no-op
    // rather than a throw.
    if (speculator && typeof speculator.reconcileCollapsedReplacements === 'function') {
      speculator.reconcileCollapsedReplacements(turnId, result, {
        // Same aborted expression the validate call computes below.
        aborted:
          cancelled ||
          toolLoopOut?.aborted === true ||
          toolLoopOut?.terminal_reason === 'tool_use_cap_hit',
      });
    }

    // Plan B (2026-06-17) B1b — post-loop speculation drift validation. Runs
    // on the FINAL emitted confirmation set (after the mid-stream-canonical
    // filter — a no-op post-B1a — AND applyConfirmationDebounce above), so a
    // speculation is only kept servable when its expandedText equals a
    // confirmation the backend actually emitted. Non-matching parked entries
    // (corrected value, dropped by confidence, subsumed into a grouped line) and
    // ALL entries on an aborted/cap-hit turn are invalidated so keys.js
    // synthesises fresh. Compares actual emitted text (no recompute). Wrapped in
    // the speculator's own try/catch; never throws.
    if (speculator && typeof speculator.validateAgainstConfirmations === 'function') {
      speculator.validateAgainstConfirmations(turnId, result.confirmations, {
        // F7 Item 3 — on cancellation there is no toolLoopOut; a cancelled turn
        // is aborted by definition (opts object, no toolLoopOut deref).
        aborted:
          cancelled ||
          toolLoopOut?.aborted === true ||
          toolLoopOut?.terminal_reason === 'tool_use_cap_hit',
      });
    }

    // ── item #10 / #4 / #6 — deterministic post-turn orphan net ──
    // A NEW, purely DETERMINISTIC (no second LLM round) safety net. When a
    // forwarded, digit-bearing utterance produces ZERO tool calls and ZERO
    // output — the silent-drop class behind #4 (split "Zs"…"for the sockets
    // is 0.86"), #6 (the dropped "reference method … is 101"), and #10 ("EFC
    // is 0.86") — emit exactly ONE NON-BLOCKING spoken prompt and stash the
    // unplaced transcript so the NEXT turn re-extracts the inspector's repeat
    // WITH this utterance as context (the §3.3b orphan-context injection
    // above). This converts a chimed-but-dropped value into an audible ASK,
    // satisfying invariant #2 ("a dropped reading is invisible to a hands-free
    // user").
    //
    // Why a confirmation, not an ask_user: a post-loop ask_user would register
    // focused-answer mode (pendingAsks) with no continuation to resolve it, so
    // the inspector's repeat would be swallowed as an unresolved ask-answer.
    // The prompt rides result.confirmations, which iOS speaks via the
    // non-blocking FIFO WITHOUT entering awaiting-response — the repeat then
    // arrives as a normal fresh transcript and is re-extracted.
    //
    // SCOPE NOTE: the plan's "deterministically placeable → synthetic write"
    // branch is intentionally NOT built here. The only safe deterministic
    // placement signal available server-side is the iOS regex hint, and those
    // values are ALREADY applied client-side by iOS's instant-fill tier (so
    // they are not silently dropped from the UI — only their read-back). The
    // utterances the plan cites as placeable (#4/#6) carried regex
    // fields_matched:0, so a regex-hint write would not fire for them anyway —
    // they are correctly recovered by this prompt + the context-carried repeat.
    // Building a fresh free-text field/scope/value resolver to write on the
    // first pass is unbounded scope and a silent-corruption risk (mis-placement
    // writes the wrong field); deferred deliberately. This net NEVER writes
    // data — zero corruption risk; worst case is a spurious prompt on numeric
    // chitchat (mitigated by VOICE_ORPHAN_PROMPT=false + chitchat-pause).
    // F7 Item 3 — SKIP the A3 orphan net on a cancelled generation (it derefs
    // toolLoopOut.tool_calls / .rounds and could stash orphanContext for a
    // turn that never completed). The cancellation-specific fallback below
    // covers the "nothing audible survived" case.
    if (!cancelled)
      try {
        const toolCalls = Array.isArray(toolLoopOut.tool_calls) ? toolLoopOut.tool_calls : [];
        const orphanToolCalls = toolCalls.length;
        // M1 Defect B (silent-drop hole): a turn whose tool calls were ALL
        // rejected (every dispatcher envelope is_error===true) ends with
        // zero readings/confirmations/questions and emits ZERO TTS — exactly
        // the "circuits 5,6,7,8 are spare" all-duplicate-rejected case
        // (field session 6674E8C5 turn-11). The existing orphan net gates on
        // orphanToolCalls===0 so it misses this. Broaden: ALSO fire when every
        // tool call this turn was rejected. is_error is the ONLY top-level
        // envelope signal — ok/error/reason live INSIDE the stringified
        // result.content, so do NOT check result.ok (no such field). A real
        // ask_user returns is_error:false (so the every() test already excludes
        // it — the inspector hears that question over WS via ask_user_started);
        // the explicit name guard is belt-and-suspenders against double-speak.
        // A1 agentic-voice (2026-07-23) — the two answer-feature tools join
        // the ask_user name-guard. A sole terminal-failed answer_user
        // (empty_answer, is_error:true) would otherwise read as an
        // all-rejected turn and push a REJECTED_PROMPTS apology IN ADDITION
        // to the Item-4 fixed fallback answer (double-speak). A turn that
        // touched the answer feature is owned by the fallback machinery.
        // Plan B (round-15) — an `ask_user`-named call whose result is the
        // HARD unknown_tool error envelope (createWriteDispatcher's
        // object-form when no ask dispatcher is composed) COUNTS as
        // rejected: excluding it by name alone would leave its staged
        // refusal notice draining while the rejection stayed invisible to
        // this net's coverage arbitration. Genuinely-emitted asks remain
        // excluded (is_error:false — the every() test already fails on
        // them; the name guard stays as belt-and-suspenders).
        const isHardUnknownToolResult = (c) => {
          if (c?.result?.is_error !== true) return false;
          try {
            const body = JSON.parse(c?.result?.content ?? 'null');
            return body?.error === 'unknown_tool' || body?.error?.code === 'unknown_tool';
          } catch {
            return false;
          }
        };
        // (declared at function scope — plan 2A hoist; see the comment there)
        allRejected =
          orphanToolCalls > 0 &&
          toolCalls.every((c) => c?.result?.is_error === true) &&
          !toolCalls.some(
            (c) =>
              (c?.name === 'ask_user' && !isHardUnknownToolResult(c)) ||
              c?.name === 'answer_user' ||
              c?.name === 'inspect_session_state'
          );
        // ── Plan B §3.3 — coverage arbitration (branches 2–3 of the A3 ×
        // coverage × recovery state machine). Placed BESIDE the
        // classification, deliberately OUTSIDE the ORPHAN_PROMPT_ENABLED
        // gate below (round-17: under VOICE_ORPHAN_PROMPT=false the
        // emission block is bypassed but partial coverage must STILL stamp
        // drain:false, so the drained refusal cannot suppress marker-②
        // while the uncovered rejection loses today's fallback).
        //
        //   FULL coverage (every rejected id ∈ the union of staged
        //   coveredToolCallIds) → `rejectedSetFullyCovered` suppresses the
        //   REJECTED_PROMPTS emission + the ENTIRE orphan branch below;
        //   the dispatcher-authored refusals drain at net-0 and ARE the
        //   turn's audible output.
        //   PARTIAL coverage → A3 owns the WHOLE rejected set: the covered
        //   subset's notices are stamped drain:false (one generic line,
        //   zero refusal lines — never both).
        //   NO coverage → today's behaviour byte-identically (fail-audible).
        let rejectedSetFullyCovered = false;
        // Stamps drain:false on every covered notice — branch 3's "one
        // generic line, zero refusal lines". TIMING (Codex diff-review
        // cycle 1): recovery runs FIRST, so on the flag-ON path the stamp is
        // DEFERRED into the emission block's `!recovered` branch — a
        // partially-covered turn whose reading IS recovered must keep its
        // covered refusals draining additively beside the read-back
        // (state-machine branch 1). Under flag-OFF the emission block (and
        // recovery) never runs, so the stamp applies immediately — that is
        // what preserves marker-②'s fallback for the uncovered rejection.
        const stampCoveredNoticesNonDraining = () => {
          const staged = Array.isArray(perTurnWrites?.mandatoryNotices)
            ? perTurnWrites.mandatoryNotices
            : [];
          for (const n of staged) {
            if (Array.isArray(n?.coveredToolCallIds) && n.coveredToolCallIds.length > 0) {
              n.drain = false;
            }
          }
        };
        let partialCoveragePending = false;
        if (allRejected) {
          const stagedNotices = Array.isArray(perTurnWrites?.mandatoryNotices)
            ? perTurnWrites.mandatoryNotices
            : [];
          const coveredUnion = new Set();
          for (const n of stagedNotices) {
            if (Array.isArray(n?.coveredToolCallIds)) {
              for (const id of n.coveredToolCallIds) coveredUnion.add(id);
            }
          }
          const rejectedIds = toolCalls
            .filter((c) => c?.result?.is_error === true)
            .map((c) => c?.tool_call_id);
          rejectedSetFullyCovered =
            rejectedIds.length > 0 && rejectedIds.every((id) => coveredUnion.has(id));
          if (coveredUnion.size > 0 && !rejectedSetFullyCovered) {
            partialCoveragePending = true;
          }
        }
        const producedNothing =
          (orphanToolCalls === 0 || allRejected) &&
          (result.extracted_readings?.length ?? 0) === 0 &&
          (result.observations?.length ?? 0) === 0 &&
          (result.confirmations?.length ?? 0) === 0 &&
          // A1 (belt-and-braces beside the name-guard): a staged spoken
          // answer — real or fixed fallback — is audible output, so the turn
          // did NOT produce nothing. NEW behaviour: the harness had zero
          // spoken_response references before A1.
          !isAudibleText(result.spoken_response);
        // An answer turn is owned by the ask-resolution path — never second-guess
        // it. (A tool call of ANY kind, including a real ask_user, also trips
        // orphanToolCalls > 0 and skips the net, covering the "Haiku asked but
        // wrote nothing" negative case.)
        const isAnswerTurn = options.inResponseTo === true || (options.pendingAsks?.size ?? 0) > 0;
        // Require a numeric value so a bare field-only fragment ("Zs") still
        // WAITS on the existing incomplete-reading path rather than prompting.
        const carriesValue = /\d/.test(transcriptText || '');
        // A3 — digit-less observations ("observation that the water bond is not
        // connected", F9 turn-28) carry no digit, so the /\d/ gate alone let
        // them vanish without ANY spoken response when the model no-opped.
        // OBSERVATION_PATTERN is the same fuzzy "observation"+garbles trigger
        // the pre-LLM gate uses to FORWARD these turns — so anything it
        // forwarded on that basis gets the same silent-drop protection here.
        const carriesObservation = OBSERVATION_PATTERN.test(transcriptText || '');
        // Marker ① — a chime fired but the utterance carried no digit and no
        // observation lead-in (a Flux garble the model no-opped on). The
        // reading/observation branches gate on content; this covers the
        // no-content case so a chimed no-op is never silent. chimeObserved is
        // TRUE for every production turn that reached extraction (gate-pass ⟺
        // chime) and, in the recorded lane, only for turns whose fixture
        // recorded chime_observed:true — so a fixture with no chime never
        // triggers a false apology.
        const chimeFired = options.chimeObserved === true;
        // Codex mini-review (cycle 1) — the partial-coverage drain:false
        // stamp defers ONLY when the recovery/emission block below is
        // actually eligible to run (recovery-first, branch 1). Any
        // ineligible combination — flag-off, answer turn, confirmations
        // off, content gate — stamps IMMEDIATELY: otherwise the covered
        // refusal would drain, count as speech-intent, and suppress
        // marker-② while the UNCOVERED rejection lost today's generic
        // fallback (the exact class branch 3 exists to prevent).
        const orphanEmissionEligible =
          ORPHAN_PROMPT_ENABLED &&
          options.confirmationsEnabled === true &&
          producedNothing &&
          !isAnswerTurn &&
          (carriesValue || carriesObservation || chimeFired);
        if (partialCoveragePending && !orphanEmissionEligible) {
          stampCoveredNoticesNonDraining();
          partialCoveragePending = false;
        }
        if (orphanEmissionEligible) {
          // #5a apply-complete guard (PR #68) — before emitting a contentless
          // clarifying prompt, try a deterministic re-parse of transcriptText
          // (result is EMPTY here by definition of producedNothing). If it yields
          // EXACTLY one complete (field, circuit, value), apply + read it back
          // instead of orphaning it. This removes BOTH #4's contentless local-apply
          // fallback and #5's next-turn duplicate at the source. Runs for the
          // all-rejected case too — recovering a real reading beats any prompt.
          let recovered = null;
          if (ORPHAN_APPLY_COMPLETE_ENABLED) {
            const tuple = reparseSingleCompleteReading(transcriptText, ALL_DIALOGUE_SCHEMAS);
            if (tuple) {
              recovered = applyOrphanRecoveredReading({ session, result, tuple, turnId });
              log.info?.('stage6.orphan_apply_complete', {
                sessionId: session.sessionId,
                turnId,
                field: recovered.field,
                circuit: recovered.circuit,
                value: recovered.value,
                textPreview: String(transcriptText || '').slice(0, 80),
              });
            }
          }
          // Codex diff-review cycle 1 — the DEFERRED branch-3 stamp: only a
          // turn whose recovery FAILED hands the whole rejected set to A3's
          // generic line; a recovered turn keeps its covered refusals
          // draining additively beside the read-back (branch 1).
          if (!recovered && partialCoveragePending) {
            stampCoveredNoticesNonDraining();
          }
          if (!recovered && allRejected && rejectedSetFullyCovered) {
            // Plan B §3.3 branch 2 — recovery failed but EVERY rejected call
            // is covered by a dispatcher-authored refusal notice: the
            // refusals drain at net-0 and ARE the turn's audible output.
            // Suppress the generic REJECTED_PROMPTS *and the entire orphan
            // branch* — no session.orphanContext (round-16: carrying the
            // honestly-refused transcript forward would reinject it into
            // the NEXT turn as words that "weren't understood" and tell the
            // model to retry, recreating the exact loop this plan kills)
            // and no stage6.orphan_prompt_emitted row. Recovery (branch 1)
            // already ran above — a structurally complete reading emitted
            // through a refused call was written + read back, and the
            // refusal notices still drain additively beside it.
            log.info?.('stage6.rejected_prompt_suppressed_by_refusals', {
              sessionId: session.sessionId,
              turnId,
              rejected_count: orphanToolCalls,
              textPreview: String(transcriptText || '').slice(0, 80),
            });
          } else if (!recovered) {
            // M1 Defect B: all-rejected turns get an "I couldn't action that"
            // message (the action WAS understood but rejected); the zero-tool-call
            // orphan case keeps the "didn't catch what that was for" wording.
            // A3: an observation-shaped zero-tool-call turn gets the observation
            // flavour instead — including the dual-match case where the
            // transcript ALSO carries a digit ("observation that socket on
            // circuit 3 is cracked"): the #5a re-parse above has already run and
            // recovered nothing, so the observation lead-in is the stronger
            // signal for what the utterance WAS. allRejected keeps precedence:
            // there the tool call happened and was rejected, and "couldn't
            // action that" is the accurate story regardless of shape.
            // Marker ① — a chimed no-op with NEITHER a digit NOR an observation
            // lead-in gets the generic "didn't catch that" wording (no "reading"
            // noun; we only know a beep went unanswered). The three specific
            // branches keep precedence: allRejected (a call happened + was
            // rejected), observation-shaped, then reading-shaped (carriesValue).
            const prompt = allRejected
              ? REJECTED_PROMPTS[turnNum % REJECTED_PROMPTS.length]
              : carriesObservation
                ? OBSERVATION_ORPHAN_PROMPT
                : carriesValue
                  ? ORPHAN_PROMPTS[turnNum % ORPHAN_PROMPTS.length]
                  : NOOP_AUDIBILITY_PROMPTS[turnNum % NOOP_AUDIBILITY_PROMPTS.length];
            if (!Array.isArray(result.confirmations)) result.confirmations = [];
            result.confirmations.push({
              text: prompt,
              field: null,
              circuit: null,
              // Keep out of the audio-finalizer expected-ACK accounting — this is
              // a clarifying prompt, not a value read-back to reconcile against a
              // fast-path POST.
              expects_ios_ack: false,
            });
            // Carry the raw transcript forward ONLY when we have positive
            // evidence it was a reading/observation/action (carriesValue,
            // carriesObservation, or a rejected tool call). The next-turn
            // injection (see :~898) tells the model "I'm repeating that reading
            // now — work out the field, circuit and value", which is only true
            // for those shapes. The pure chime-only marker-① case fires on a
            // garble we CANNOT classify (no digit, no observation lead-in, e.g.
            // "move to the next board please" that the model no-op'd), so
            // carrying it forward as "that reading" would mislabel a command and
            // risk a phantom write next turn — we apologise and let the inspector
            // re-dictate as a fresh turn instead. (Codex review, marker-① wave.)
            if (allRejected || carriesObservation || carriesValue) {
              session.orphanContext = { transcript: transcriptText, turnNum };
            }
            log.info?.('stage6.orphan_prompt_emitted', {
              sessionId: session.sessionId,
              turnId,
              rounds: toolLoopOut.rounds,
              // A3: the observation shape gets its own cause for forensics;
              // the two pre-existing reading causes are unchanged.
              cause: allRejected
                ? 'all_rejected'
                : carriesObservation
                  ? 'observation_no_tool_calls'
                  : carriesValue
                    ? 'zero_tool_calls'
                    : 'chimed_noop_no_content',
              textPreview: String(transcriptText || '').slice(0, 80),
            });
          }
        }
      } catch (orphanErr) {
        log.warn?.('stage6.orphan_net_error', {
          sessionId: session.sessionId,
          turnId,
          error: orphanErr?.message ?? String(orphanErr),
        });
      }

    // ── F7 Item 2 — shared post-loop ask-outcome classification ─────────
    // Both the §D2 net and the NEW pre-emission audibility net need to read a
    // tool call's answered/reason outcome and know which non-answer reasons
    // prove the question was actually SPOKEN. Hoisted here (was block-scoped
    // inside the D2 `if (anchorIdx >= 0)` block, so a net placed AFTER D2
    // could not reference it as written). Extraction only — the D2 logic is
    // byte-identical except the emission-check tightening noted below.
    const AUDIBLE_NON_ANSWER_REASONS = new Set([
      'timeout',
      'user_moved_on',
      'transcript_already_extracted',
      'session_stopped',
      'session_reconnected',
      'session_terminated',
    ]);
    const parseAskOutcome = (c) => {
      try {
        const body = JSON.parse(c?.result?.content ?? 'null');
        if (!body || typeof body !== 'object') return { answered: false, reason: null };
        return {
          answered: body.answered === true,
          reason: body.answered === false ? (body.reason ?? null) : null,
        };
      } catch {
        return { answered: false, reason: null };
      }
    };

    // ── §D2 (field-feedback-2026-07-14, mutation-to-chain correlation
    // 2026-07-15) — post-answer write-or-reask net for observation_clarify
    // chains. A D2 clarification ask that gets ANSWERED and is then followed
    // by a zero-tool (or unrelated-tool) model turn would go silent, and the
    // A3 orphan net CANNOT catch it (registry deleted the ask; the successful
    // ask_user makes producedNothing false). This net keys INDEPENDENTLY of
    // both.
    //
    // The 2026-07-15 rework fixes the multi-observation bug: the old net
    // evaluated only the globally-latest answered chain and let ANY later
    // successful record_observation qualify it, so in a turn with TWO answered
    // chains + ONE record_observation, the single write suppressed the whole
    // fallback even though one clarified observation was necessarily dropped —
    // and the earlier chain was never retired. Now we GROUP answered
    // observation_clarify asks by chain id, evaluate each chain once against
    // events after ITS anchor, correlate each successful record_observation to
    // the chain it clarifies (via the echoed clarification_chain_id), COLLAPSE
    // all unqualified chains into ONE count-aware fallback, and retire every
    // evaluated chain exactly once.
    //
    // Mutation-id resolution is LENIENT on both edge cases (Derek 2026-07-15)
    // for legacy/non-AFDD chains:
    // an id-less mutation (D-1a) or an unknown/invented non-null id (D-1b) on
    // a SUCCESSFUL record_observation qualifies EVERY evaluated chain whose
    // anchor precedes it — literally today's suppression outcome, so older /
    // id-omitting sessions cannot emit new (possibly misattributed) apologies,
    // and a garbled echo never triggers a false "I didn't record that" when
    // the write demonstrably succeeded (a false apology → re-dictation →
    // duplicate observation is the worse field failure). Only a NON-NULL id
    // that matches a DIFFERENT evaluated chain fails to qualify this one.
    // PLAN-3's declared AFDD chains are the deliberate exception: their
    // server-owned lifecycle requires an exact matched write or exact silent
    // terminal, so null/unknown mutations never qualify them.
    //
    // F7 Item 3 — SKIP on a cancelled generation (derefs toolLoopOut.tool_calls).
    if (!cancelled)
      try {
        const seq = Array.isArray(toolLoopOut.tool_calls) ? toolLoopOut.tool_calls : [];
        const parseAnswered = (c) => {
          try {
            const body = JSON.parse(c?.result?.content ?? 'null');
            return body && body.answered === true;
          } catch {
            return false;
          }
        };
        // §D2 Codex r2 — "successful" record_observation is is_error !== true
        // AND a parsed tool-result body with ok === true. A malformed/unparseable
        // body, a missing `ok`, or ok:false never qualifies. The parser catches
        // parse failures INTERNALLY and returns false — it must never throw into
        // the outer catch (which would emit only observation_clarify_net_error
        // and reproduce the exact silence path this net exists to close).
        const parseMutationSuccess = (c) => {
          if (c?.result?.is_error === true) return false;
          try {
            const body = JSON.parse(c?.result?.content ?? 'null');
            return !!(body && body.ok === true);
          } catch {
            return false;
          }
        };
        // AUDIBLE_NON_ANSWER_REASONS + parseAskOutcome are the shared hoisted
        // helpers above; parseReason is D2-local (it needs only the reason and
        // returns null on a non-answer without a reason, unlike parseAskOutcome).
        const parseReason = (c) => {
          try {
            const body = JSON.parse(c?.result?.content ?? 'null');
            return body && body.answered === false ? (body.reason ?? null) : null;
          } catch {
            return null;
          }
        };
        // Anchor tool_use_id extraction: real runToolLoop entries carry the id
        // at result.tool_use_id (cf. stage6-tool-loop.js); tolerate a synthetic
        // top-level tool_call_id for hand-authored fixtures.
        const anchorToolCallId = (c) => c?.result?.tool_use_id ?? c?.tool_call_id ?? null;

        // (1) GROUP answered observation_clarify asks by normalised chain id,
        // retaining the LATEST answered call index per chain (an answered initial
        // ask + an answered continuation in the same chain collapse to ONE
        // anchor — the continuation). Chain id is read from call.input
        // (the ask-gate wrapper stamps the server-minted id there); never parse
        // the tool_result body for it. A null/empty id groups under the legacy
        // null bucket (has no budget bucket → retirement is a no-op for it).
        const anchorByChain = new Map(); // cid(string|null) -> anchor index (latest)
        const declaredAfddChainIds = new Set();
        for (let i = 0; i < seq.length; i += 1) {
          const c = seq[i];
          if (
            c?.name === 'ask_user' &&
            c?.input?.context_field === 'observation_clarify' &&
            parseAnswered(c)
          ) {
            const cid = normaliseObsClarifyChainId(c?.input?.clarification_chain_id);
            anchorByChain.set(cid, i);
            if (
              cid !== null &&
              ['afdd_topic', 'afdd_applicability', 'afdd_premises'].includes(
                c?.input?.observation_clarification_kind
              )
            ) {
              declaredAfddChainIds.add(cid);
            }
          }
        }

        if (anchorByChain.size > 0) {
          // Evaluated chains in anchor-index order (telemetry contract).
          const evaluatedChains = [...anchorByChain.entries()]
            .map(([cid, aIdx]) => ({ cid, aIdx, isDeclaredAfdd: declaredAfddChainIds.has(cid) }))
            .sort((a, b) => a.aIdx - b.aIdx);
          const evaluatedCids = new Set(
            evaluatedChains.map((ch) => ch.cid).filter((cid) => cid !== null)
          );

          // (2) Build the successful-mutation list ONCE, in tool-call-index
          // order — exactly one record per successful record_observation. kind:
          //   'null'    → id-less (D-1a lenient)
          //   'unknown' → non-null id matching NO evaluated chain (D-1b lenient)
          //   'matched' → non-null id equal to an evaluated chain id
          const successfulMutations = [];
          for (let i = 0; i < seq.length; i += 1) {
            const c = seq[i];
            if (c?.name === 'record_observation' && parseMutationSuccess(c)) {
              const rawCid = normaliseObsClarifyChainId(c?.input?.clarification_chain_id);
              let kind;
              let matchedChainId = null;
              if (rawCid === null) {
                kind = 'null';
              } else if (evaluatedCids.has(rawCid)) {
                kind = 'matched';
                matchedChainId = rawCid;
              } else {
                kind = 'unknown';
              }
              successfulMutations.push({ index: i, kind, matchedChainId });
            }
          }

          // PLAN-3: successful silent AFDD no-write terminals qualify ONLY
          // their exact server-owned chain. Unlike legacy id-less observation
          // mutations, terminals get no lenient/unknown fallback: their sole
          // purpose is to prove that an answered clarification intentionally
          // ended without a certificate row.
          const successfulClarificationTerminals = [];
          for (let i = 0; i < seq.length; i += 1) {
            const c = seq[i];
            if (c?.name === 'resolve_observation_clarification' && parseMutationSuccess(c)) {
              const chainId = normaliseObsClarifyChainId(c?.input?.clarification_chain_id);
              if (chainId !== null && evaluatedCids.has(chainId)) {
                successfulClarificationTerminals.push({ index: i, chainId });
              }
            }
          }

          // For each chain find the EARLIEST qualifying event (a mutation or a
          // same-chain audibly-terminated continuation) strictly after its
          // anchor. Attributing to the earliest event keeps the lenient
          // telemetry rows honest ("newly qualified BY that mutation").
          const qualifiedInfo = new Map(); // cid -> { type:'mutation'|'terminal'|'continuation', mutation }
          for (const ch of evaluatedChains) {
            let bestIdx = Infinity;
            let bestType = null;
            let bestMutation = null;
            for (const m of successfulMutations) {
              if (m.index <= ch.aIdx) continue;
              // 'matched' qualifies ONLY its own chain. Null/unknown retain
              // the 2026-07-15 compatibility lane for legacy chains, but a
              // declared AFDD chain is exact-correlation-only.
              const qualifies =
                m.kind === 'matched' ? m.matchedChainId === ch.cid : ch.isDeclaredAfdd !== true;
              if (qualifies && m.index < bestIdx) {
                bestIdx = m.index;
                bestType = 'mutation';
                bestMutation = m;
              }
            }
            for (const terminal of successfulClarificationTerminals) {
              if (
                terminal.index > ch.aIdx &&
                terminal.chainId === ch.cid &&
                terminal.index < bestIdx
              ) {
                bestIdx = terminal.index;
                bestType = 'terminal';
                bestMutation = null;
              }
            }
            for (let i = ch.aIdx + 1; i < seq.length; i += 1) {
              const c = seq[i];
              if (
                c?.name === 'ask_user' &&
                c?.input?.context_field === 'observation_clarify' &&
                normaliseObsClarifyChainId(c?.input?.clarification_chain_id) === ch.cid &&
                !parseAnswered(c) &&
                AUDIBLE_NON_ANSWER_REASONS.has(parseReason(c)) &&
                // F7 Item 2 — the SAME swallowed-send hole D2 had: an audible
                // non-answer REASON alone is not proof of speech. A continuation
                // whose ws.send was swallowed (closed socket / throwing send)
                // stayed registered and later reported `timeout` ∈
                // AUDIBLE_NON_ANSWER_REASONS, but was never SPOKEN. Require the
                // continuation's id to be in emittedAskToolCallIds (an
                // ask_user_started that actually crossed the wire). Extract the
                // id with anchorToolCallId — real runToolLoop entries carry it
                // at result.tool_use_id (== rec.tool_call_id == the id
                // onAskUserStarted recorded), so a top-level-only check would
                // read undefined on live rows and never qualify.
                emittedAskToolCallIds.has(anchorToolCallId(c))
              ) {
                if (i < bestIdx) {
                  bestIdx = i;
                  bestType = 'continuation';
                  bestMutation = null;
                }
                break; // earliest same-chain continuation
              }
            }
            if (bestType) qualifiedInfo.set(ch.cid, { type: bestType, mutation: bestMutation });
          }

          const unqualifiedChains = evaluatedChains.filter((ch) => !qualifiedInfo.has(ch.cid));
          const qualifiedChainIds = evaluatedChains
            .filter((ch) => qualifiedInfo.has(ch.cid))
            .map((ch) => ch.cid);

          // (3) Emit ONE lenient_qualification INFO row PER successful lenient
          // mutation that NEWLY qualified >= 1 chain (a lenient mutation that
          // newly qualifies zero chains emits no row — its kind still lands in
          // dropped_net.mutation_id_kinds if a fallback fires). NEVER log the raw
          // model-controlled chain id — only the kind, plus the server-minted
          // chain ids it newly qualified.
          let anyLenientFired = false;
          for (const m of successfulMutations) {
            if (m.kind === 'matched') continue;
            const newlyQualified = evaluatedChains
              .filter(
                (ch) =>
                  qualifiedInfo.get(ch.cid)?.type === 'mutation' &&
                  qualifiedInfo.get(ch.cid)?.mutation === m
              )
              .map((ch) => ch.cid);
            if (newlyQualified.length === 0) continue;
            anyLenientFired = true;
            log.info?.('stage6.observation_clarify_lenient_qualification', {
              sessionId: session.sessionId,
              turnId,
              lenient_qualification: true,
              mutation_id_kind: m.kind, // 'null' | 'unknown' — never the raw id
              qualified_chain_ids: newlyQualified,
            });
          }

          // (4) Retire every evaluated chain exactly once — AFTER all
          // qualification decisions, so retirement can't affect same-turn
          // matching. Non-null ids only (the null legacy group has no bucket).
          if (session.obsClarifyChains?.retire) {
            for (const ch of evaluatedChains) {
              if (ch.cid !== null) session.obsClarifyChains.retire(ch.cid);
            }
          }

          // (5) COLLAPSED fallback — all unqualified chains this turn produce ONE
          // combined field-nil confirmation with count-aware wording. Per-chain
          // apologies with identical text would be client-swallowed by the A1(b)
          // 30s field-nil TTL (field:null is outside DEDUPE_TOKEN_FIELDS, so a
          // dedupe_token cannot rescue them) — reintroducing beep-then-silence.
          if (unqualifiedChains.length > 0) {
            if (!Array.isArray(result.confirmations)) result.confirmations = [];
            const plural = unqualifiedChains.length > 1;
            result.confirmations.push({
              text: plural
                ? "Sorry — I didn't record those observations. Could you give them to me again?"
                : "Sorry — I didn't record that observation. Could you give it to me again?",
              field: null,
              circuit: null,
              expects_ios_ack: false,
            });
            log.info?.('stage6.observation_clarify_dropped_net', {
              sessionId: session.sessionId,
              turnId,
              unqualified_chain_ids: unqualifiedChains.map((ch) => ch.cid),
              qualified_chain_ids: qualifiedChainIds,
              anchor_tool_call_ids: evaluatedChains.map((ch) => ({
                clarification_chain_id: ch.cid,
                anchor_tool_call_id: anchorToolCallId(seq[ch.aIdx]),
              })),
              lenient_qualification: anyLenientFired,
              mutation_id_kinds: successfulMutations.map((m) => m.kind),
              tool_calls: seq.length,
            });
          }
        }
      } catch (obsNetErr) {
        log.warn?.('stage6.observation_clarify_net_error', {
          sessionId: session.sessionId,
          turnId,
          error: obsNetErr?.message ?? String(obsNetErr),
        });
      }

    // ── Plan A1a (2026-07-27) §3.5a — net 0: MANDATORY notice drain ──────
    // The ADDITIVE audible channel for board-clear denial / kill-switch /
    // already-empty / EICR-refusal / unknown-scope outcomes. Deliberately
    // NOT voiceNotices: that channel is a turn-final FALLBACK drained only
    // inside `if (noSpeechIntent)`, which is correct for a stale notice an
    // operation superseded but WRONG here — a board-clear outcome is the
    // ONLY report the inspector will ever get about that operation, so a
    // mixed turn (denied clear + successful reading) must speak BOTH.
    //
    // PLACEMENT is load-bearing in both directions: AFTER the §D2 net (D2
    // keeps first crack at its observation-clarify class) and BEFORE the F7
    // pre-emission net — a turn with a soft-skipped board-clear outcome PLUS
    // a suppressed ask would otherwise let F7 queue its generic "couldn't
    // action that — say it again?" fallback before the mandatory notice
    // becomes visible, reintroducing the misleading repeat-request loop.
    // Draining first makes F7 (and marker-②) count the mandatory prompt as
    // surviving speech — a turn never carries both a notice and an apology.
    //
    // Same guard shape as marker-②: confirmationsEnabled (mode-off users
    // opted out of the spoken channel), chimeObserved, NOT cancelled (a
    // cancelled generation's accumulator dies with the turn; the F7
    // cancellation branch owns that apology). Entries are stamped with
    // generationId at the drain, per the voiceNotices precedent —
    // dispatchers cannot stamp (ctx carries no generationId, and an
    // unstamped pendingVoicePrompts entry counts as current-generation).
    try {
      if (options.confirmationsEnabled === true && options.chimeObserved === true && !cancelled) {
        // Plan B (round-3) — the drain gains a `notice.drain !== false` term:
        // A3's coverage arbitration (which runs BEFORE net-0) stamps
        // drain:false on the covered subset of a PARTIALLY-covered
        // all-rejected turn, so the turn speaks exactly one generic line and
        // zero refusal lines — never both. The old "net-0 drain unchanged"
        // claim is retired; a drain-level test pins both new terms.
        const staged = Array.isArray(perTurnWrites?.mandatoryNotices)
          ? perTurnWrites.mandatoryNotices.filter(
              (n) => n && typeof n.family === 'string' && n.drain !== false
            )
          : [];
        if (staged.length > 0) {
          // §3.5 narrow exception — same-slot suppression, ALREADY-EMPTY
          // family ONLY: when the same clear is retried and SUCCEEDS later
          // in the turn (a surviving same-slot clear correction), or a
          // same-slot write landed, the already-empty notice must not speak
          // alongside the operation's own read-back. Slot identity is the
          // shared boardSlotKey (global fields board-insensitive) — the same
          // helper the collapse and the #31 gate use. This is same-SLOT
          // suppression only; it must never generalise back into whole-turn
          // suppression (the round-11 defect this channel replaces).
          const survivingSlots = new Set();
          // Plan B — the CLEAR-only subset, for the wrong_tool_clear
          // reconciliation below: a bridge-staged misroute notice is
          // reconciled away ONLY by a surviving same-slot
          // clear_board_reading SUCCESS (or a same-slot already-empty
          // outcome), never by an unrelated same-slot write.
          const survivingClearSlots = new Set();
          // PLAN-2D recoverable structural route. A successful
          // mark_distribution_circuit writes the exact source-circuit slots
          // that a rejected record_reading could not safely mutate. Build the
          // same server-owned slot identity so either dispatch order
          // reconciles the wrong-tool notice away and the board-op read-back
          // speaks alone.
          const survivingDistributionSlots = new Set();
          if (Array.isArray(perTurnWrites?.boardOps)) {
            for (const op of perTurnWrites.boardOps) {
              if (op?.op === 'mark_distribution_circuit' && Number.isInteger(op.circuit_ref)) {
                survivingDistributionSlots.add(
                  rawCircuitSlot('distribution_link', op.circuit_ref, op.source_board_id ?? null)
                );
              }
            }
          }
          // A2-multiboard (2026-07-28) — the write side reads the PROJECTED
          // winners, never the raw `boardReadings` Map. `record_board_reading`
          // carries no schema `board_id`, so two boards' writes for the same
          // field collide on one raw key and `Map.set` keeps only the last:
          // `clear manufacturer on main (already blank) → record manufacturer
          // on main → select_board garage → record manufacturer on garage`
          // left main's write invisible here, so main's already-empty notice
          // was NOT suppressed and spoke alongside main's own write read-back —
          // a contradiction ("manufacturer already blank" + "manufacturer
          // recorded as Wylex") that this plan's own projection fix newly makes
          // audible, because main's write now survives to be read back at all.
          // The stamp-only guard is kept deliberately: a Symbol-less legacy
          // entry contributes nothing (as before), so the new set is a strict
          // SUPERSET of the old one and single-board turns are unchanged.
          for (const w of projectBoardReadingWinners(perTurnWrites)) {
            const bsym = w?.value?.[EFFECTIVE_BOARD_SLOT];
            if (bsym) survivingSlots.add(boardSlotKey(bsym.field, bsym.boardId));
          }
          if (Array.isArray(perTurnWrites?.fieldCorrections)) {
            for (const c of perTurnWrites.fieldCorrections) {
              const bsym = c?.[EFFECTIVE_BOARD_SLOT];
              if (bsym && c.reason === 'clear_reading') {
                survivingSlots.add(boardSlotKey(bsym.field, bsym.boardId));
                survivingClearSlots.add(boardSlotKey(bsym.field, bsym.boardId));
              }
            }
          }
          if (!Array.isArray(session.pendingVoicePrompts)) session.pendingVoicePrompts = [];
          for (const notice of staged) {
            if (
              notice.family === 'board_clear_already_empty' &&
              typeof notice.slotKey === 'string' &&
              survivingSlots.has(notice.slotKey)
            ) {
              continue;
            }
            // Plan B §3.2 — wrong_tool_clear same-slot reconciliation
            // (order-INDEPENDENT: the loop is multi-round and the model may
            // self-correct via clear_board_reading before OR after the
            // rejected clear_reading; perTurnWrites state at drain time is
            // identical either way). A surviving same-board-slot clear
            // SUCCESS or a same-slot already-empty outcome (round-8: a
            // corrected clear that finds the field already blank produces
            // NO success slot — without this term the turn would speak
            // "⟨label⟩ has NOT been cleared" beside "already blank", a
            // contradiction) means the user's intent WAS satisfied — the
            // success/already-empty read-back speaks alone.
            if (
              notice.family === 'wrong_tool_clear' &&
              typeof notice.slotKey === 'string' &&
              (survivingClearSlots.has(notice.slotKey) ||
                staged.some(
                  (n2) =>
                    n2 !== notice &&
                    n2.family === 'board_clear_already_empty' &&
                    n2.slotKey === notice.slotKey
                ))
            ) {
              continue;
            }
            if (
              notice.family === 'mark_distribution_required' &&
              typeof notice.slotKey === 'string' &&
              survivingDistributionSlots.has(notice.slotKey)
            ) {
              continue;
            }
            // Codex diff-review r1 — text SELECTION happens HERE, after the
            // within-turn dedupe (stage time) AND the same-slot suppression
            // above have both settled, so the per-session rotation cursor
            // advances EXACTLY once per notice actually emitted. Selecting
            // at stage time let a later-suppressed notice consume a variant
            // silently — after enough suppressed attempts the next audible
            // notice could wrap to the last HEARD byte string and be
            // swallowed by the clients' 30 s text dedupe.
            // Plan B — selection routes through the shared registry's ONE
            // dispatch point: DIRECT (A1a) notices keep the exact rotation
            // semantics for attempts 1–5 then the family's ordinal terminal
            // (the sanctioned wrap-silence fix); B-STAGED notices (coverage
            // present) select from the per-slot attempt count, never the
            // family cursor. Still drain-time-only, so a suppressed or
            // reconciled notice never consumes rotation state.
            const noticeText = renderMandatoryNoticeText(session, notice, notice.turnId ?? turnId);
            if (typeof noticeText !== 'string' || noticeText.trim().length === 0) continue;
            session.pendingVoicePrompts.push({ text: noticeText, generationId });
            // Distinct telemetry row — NEVER reuse dispatcher_voice_notice_
            // emitted; the two channels must be separable in CloudWatch.
            // Carries the §3.5a dimensions (family/field/board/reason) —
            // PII-safe: field names and board ids only, never values; the
            // preview is bounded at 80 chars. Plan B adds route +
            // covered_count (server-owned constants / a count — leak-safe).
            log.info?.('stage6.mandatory_notice_emitted', {
              sessionId: session.sessionId,
              turnId,
              generationId,
              family: notice.family ?? null,
              field: notice.field ?? null,
              board: notice.boardId ?? null,
              reason: notice.reason ?? notice.family ?? null,
              route: notice.route ?? 'direct',
              covered_count: Array.isArray(notice.coveredToolCallIds)
                ? notice.coveredToolCallIds.length
                : 0,
              textPreview: noticeText.slice(0, 80),
            });
          }
        }
      }
    } catch (mandatoryErr) {
      log.warn?.('stage6.mandatory_notice_net_error', {
        sessionId: session.sessionId,
        turnId,
        error: mandatoryErr?.message ?? String(mandatoryErr),
      });
    }

    // ── Plan 2A (2026-07-30) §3.1 — PARTIAL-FAILURE notice drain ──────────
    // Feedback id 112. THE DEFECT CLASS: a turn in which SOME targets landed
    // and others were rejected or silently skipped spoke only the successes.
    // "Zs for circuits 5 to 10 is 0.4" on a board where 7 and 8 do not exist
    // read back four values and said NOTHING about the two misses — the
    // inspector walks away believing six circuits were recorded. Audio-First
    // #1 in the zero-times direction, for the half of the turn that failed.
    //
    // WHY HERE, between plan B's net 0 and F7: this net must run AFTER the
    // coverage arbitration has settled (rule (1) below reads `allRejected`)
    // and BEFORE marker-② (`survivingPromptCount`, further down), because a
    // spoken partial-failure notice IS this turn's audible output for the
    // failed half and must suppress the generic catch-all apology — otherwise
    // a skip-only turn speaks both a specific notice and "I didn't catch
    // that", which contradict each other.
    //
    // NOT part of plan B's `mandatoryNotices`: see the accumulator comment in
    // stage6-per-turn-writes.js. The separation is what keeps an unclassed
    // partial notice out of `coveredUnion` / `stampCoveredNoticesNonDraining`.
    try {
      const stagedPartial = Array.isArray(perTurnWrites?.partialFailureNotices)
        ? perTurnWrites.partialFailureNotices
        : [];
      // PLAN-2B cancellation exception: the §3.3 description family is staged
      // only after a sibling write has landed, and that mutation survives the
      // reduced cancellation-finalization path. Let this one generation-local
      // obligation drain on cancellation so the inspector never hears only the
      // success and mistakes a partial application for a complete one. Every
      // other Plan-2A family keeps the shipped cancelled-generation suppression.
      const drainablePartial = cancelled
        ? stagedPartial.filter((notice) => notice?.requiresSurvivingSibling === true)
        : stagedPartial;
      if (
        drainablePartial.length > 0 &&
        options.confirmationsEnabled === true &&
        options.chimeObserved === true
      ) {
        // ── Drain rule (1) — allRejected ⇒ DROP EVERY partial notice.
        // A whole-turn rejection is plan B's / A3's to speak: it emits
        // exactly one line and every pre-2A byte of that path must be
        // preserved. A partial notice draining beside it would double-speak
        // the same failure in two different sentences.
        if (allRejected) {
          log.info?.('stage6.partial_failure_notices_suppressed_all_rejected', {
            sessionId: session.sessionId,
            turnId,
            generationId,
            aggregate_count: drainablePartial.length,
          });
        } else {
          // ── Drain rule (2) — subtract any READING target that has a
          // SURVIVING same-slot write at drain time.
          //
          // The turn "Zs on 7 is LIM" (capability-skipped) followed by "Zs on
          // 7 is 0.4" (accepted) must speak the read-back ONLY: the value IS
          // recorded, and a notice claiming otherwise would send the
          // inspector back to re-dictate a correct reading. A false negative
          // here is worse than the silence this whole plan removes.
          //
          // Survivor sources are the A2 write JOURNALS
          // (`projectReadingWinners` + `projectBoardReadingWinners`), NEVER
          // raw Map scans: post-A2 both raw Maps are board-AMBIGUOUS by
          // construction, so a Map scan could claim a garage write as the
          // sibling for a MAIN-board miss.
          //
          // Field identity is CANONICALISED on BOTH sides, so an
          // alias-spelled retry (`measured_zs_ohm` skipped, then `zs`
          // written) subtracts. Subtraction is REGARDLESS of `derived:true`:
          // a mirror-derived write still means the cell is populated, and
          // "not recorded" would be a lie about it.
          const survivingReadingSlots = new Set();
          for (const w of projectReadingWinners(perTurnWrites)) {
            const parts = readingSlotPartsOf(w?.rawKey, w?.value);
            if (parts?.field == null || parts?.circuit == null) continue;
            survivingReadingSlots.add(
              `${canonicalPartialFailureFieldIdentity(parts.field)}::${parts.circuit}::${
                parts.boardId ?? ''
              }`
            );
          }
          const survivingBoardReadingScopes = new Set();
          for (const w of projectBoardReadingWinners(perTurnWrites)) {
            const effectiveSlot = w?.value?.[EFFECTIVE_BOARD_SLOT];
            // Symbol-less legacy board writes have no safe board attribution.
            // They cannot prove a sibling for a scoped partial-success claim.
            if (!effectiveSlot || effectiveSlot.field == null) continue;
            survivingBoardReadingScopes.add(
              `${canonicalPartialFailureFieldIdentity(effectiveSlot.field)}::${
                effectiveSlot.boardId ?? ''
              }`
            );
          }
          for (const aggregate of drainablePartial) {
            // PLAN-2B §3.3 — an unmatched DESCRIPTION span is a partial
            // failure only while a sibling write for the same field + board
            // survives the turn. The dispatcher stages this family only after
            // an immediate sibling success; this drain-time guard closes the
            // later-clear/overwrite gap so a notice can never claim "part of
            // that landed" after its last successful sibling disappeared.
            if (aggregate?.requiresSurvivingSibling === true) {
              const prefix = `${aggregate.field}::`;
              const suffix = `::${aggregate.boardId ?? ''}`;
              const hasSurvivingSibling =
                [...survivingReadingSlots].some(
                  (slot) => slot.startsWith(prefix) && slot.endsWith(suffix)
                ) ||
                survivingBoardReadingScopes.has(`${aggregate.field}::${aggregate.boardId ?? ''}`);
              if (!hasSurvivingSibling) {
                log.info?.('stage6.partial_failure_notice_suppressed_no_sibling', {
                  sessionId: session.sessionId,
                  turnId,
                  generationId,
                  reason: aggregate?.reason ?? null,
                  field: aggregate?.field ?? null,
                  board: aggregate?.boardId ?? null,
                });
                continue;
              }
            }
            // A SCOPE target ("all circuits") can never acquire a per-circuit
            // write, so it always survives rule (2) and always speaks.
            const survivors = (Array.isArray(aggregate?.targets) ? aggregate.targets : []).filter(
              (t) => {
                if (t?.kind !== 'circuit') return true;
                return !survivingReadingSlots.has(
                  `${aggregate.field}::${t.ref}::${aggregate.boardId ?? ''}`
                );
              }
            );
            if (survivors.length === 0) {
              log.info?.('stage6.partial_failure_notice_subtracted', {
                sessionId: session.sessionId,
                turnId,
                generationId,
                reason: aggregate?.reason ?? null,
                field: aggregate?.field ?? null,
                board: aggregate?.boardId ?? null,
                staged_target_count: Array.isArray(aggregate?.targets)
                  ? aggregate.targets.length
                  : 0,
              });
              continue;
            }
            // ── Drain rule (3) — speak the residual, AGGREGATED. Rendering
            // (and therefore rotation-cursor advance) happens HERE, at the
            // drain, never at stage time: a notice dropped by rule (1) or (2)
            // must not consume a variant, or the next audible notice could
            // wrap to the last-HEARD byte string and be swallowed by the
            // clients' 30 s text dedupe.
            const partialText = renderPartialFailureNoticeText(session, aggregate, survivors);
            if (typeof partialText !== 'string' || partialText.trim().length === 0) continue;
            // Lazily materialise the FIFO exactly as every other net does. A
            // session that has queued no prompt yet carries no array at all,
            // and under the fail-open catch below a `push` on `undefined`
            // would swallow the notice in COMPLETE SILENCE — precisely the
            // defect this net exists to remove.
            if (!Array.isArray(session.pendingVoicePrompts)) session.pendingVoicePrompts = [];
            session.pendingVoicePrompts.push({ text: partialText, generationId });
            // Own telemetry row — never reuse mandatory_notice_emitted; the
            // three notice regimes must stay separable in CloudWatch.
            // PII-safe: server-owned constants, canonical field names, board
            // ids, integer refs and counts only — never a dictated value.
            log.info?.('stage6.partial_failure_notice_emitted', {
              sessionId: session.sessionId,
              turnId,
              generationId,
              reason: aggregate?.reason ?? null,
              field: aggregate?.field ?? null,
              board: aggregate?.boardId ?? null,
              producer: aggregate?.producer ?? null,
              staged_target_count: Array.isArray(aggregate?.targets) ? aggregate.targets.length : 0,
              spoken_target_count: survivors.length,
              spoken_refs: survivors
                .filter((t) => t?.kind === 'circuit')
                .map((t) => t.ref)
                .join(','),
              spoken_ordinals: survivors
                .filter((t) => t?.kind === 'ordinal')
                .map((t) => t.ordinal)
                .join(','),
              textPreview: partialText.slice(0, 80),
            });
          }
        }
      }
    } catch (partialErr) {
      // Same fail-open posture as plan B's net: a throw in the notice
      // machinery must never take down the turn's real output.
      log.warn?.('stage6.partial_failure_notice_net_error', {
        sessionId: session.sessionId,
        turnId,
        error: partialErr?.message ?? String(partialErr),
      });
    }

    // ── F7 Item 2 (task #16) — pre-emission ask-audibility net ───────────
    // Codex cycle-6 finding: A3/D2/A4 all MISS the case where Sonnet emitted
    // an ask_user that was SUPPRESSED before ask_user_started crossed the wire
    // (restrained_mode / ask_budget_exhausted / validation_error / prompt-leak
    // / dispatcher_error / closed-WS / throwing-send / fallbackToLegacy). A
    // transcript-gate chime is then followed by SILENCE. Decide audibility
    // from POSITIVELY recorded emission (emittedAskToolCallIds) plus surviving
    // SPOKEN outputs only — successful writes are UI state, not audible output,
    // and counting them would preserve the exact chime-then-silence defect.
    //
    // PLACEMENT: AFTER the D2 net and immediately BEFORE the A4 drain —
    // queueing after the drain defers the apology to the next turn
    // (reproducing the bug); queueing before it lets the existing A4 drain
    // move the apology into result.confirmations THIS turn. The
    // confirmationsEnabled gate mirrors A3 (a mode-off user opted out of the
    // whole spoken channel). Audible text is trimmed-non-empty EVERYWHERE.
    try {
      if (options.confirmationsEnabled === true) {
        // isAudibleText / isCurrentGenPrompt are the runLiveMode-scoped shared
        // helpers (hoisted for marker-② — see their declaration next to
        // generationId above).
        // toolLoopOut is undefined on a cancelled generation → no attempted
        // asks are recoverable; the cancellation predicate (below) does not
        // require any.
        const calls = Array.isArray(toolLoopOut?.tool_calls) ? toolLoopOut.tool_calls : [];
        const attemptedAskCalls = calls.filter((c) => c?.name === 'ask_user');
        const survivingConfCount = Array.isArray(result.confirmations)
          ? result.confirmations.filter((c) => isAudibleText(c?.text)).length
          : 0;
        const survivingPromptCount = Array.isArray(session.pendingVoicePrompts)
          ? session.pendingVoicePrompts.filter(
              (p) => isCurrentGenPrompt(p) && isAudibleText(p?.text)
            ).length
          : 0;
        // F7 Item 3 — the cancellation branch uses ONLY a "nothing audible
        // survived" predicate (a ceiling-cancelled generation may have no
        // tool_calls at all): fire the fallback whenever the generation ends
        // with no surviving confirmation/prompt and no positively-emitted ask,
        // so a wedged-then-cancelled turn is never silent. The normal branch
        // keeps the exact "ask ATTEMPTED but never emitted" predicate (no
        // vacuous firing on empty turns).
        // A1 agentic-voice — a staged answer (real or the Item-4 fallback) is
        // an audible SURVIVOR: neither the F7 apology nor the cancellation
        // apology may double-speak over it. Required false on BOTH branches.
        const survivingAnswer = isAudibleText(result.spoken_response);
        const shouldFire = cancelled
          ? survivingConfCount === 0 &&
            survivingPromptCount === 0 &&
            emittedAskToolCallIds.size === 0 &&
            !survivingAnswer
          : attemptedAskCalls.length > 0 &&
            emittedAskToolCallIds.size === 0 &&
            survivingConfCount === 0 &&
            survivingPromptCount === 0 &&
            !survivingAnswer;
        if (shouldFire) {
          if (!Array.isArray(session.pendingVoicePrompts)) session.pendingVoicePrompts = [];
          // Queue on the A4 FIFO channel; the drain below moves it onto the
          // wire this turn. `fallbackToLegacy` is pre-emission/non-audible in
          // live mode (no independent legacy emission signal), so it too
          // triggers this net when no other audible output survives.
          session.pendingVoicePrompts.push({
            text: ASK_AUDIBILITY_FALLBACK_TEXT,
            generationId,
          });
          log.info?.('stage6.ask_audibility_fallback_emitted', {
            sessionId: session.sessionId,
            turnId,
            generationId,
            attempted_ask_tool_call_ids: attemptedAskCalls.map((c) => c?.tool_call_id ?? null),
            attempted_ask_reasons: attemptedAskCalls.map((c) => parseAskOutcome(c).reason),
            emitted_ask_count: emittedAskToolCallIds.size,
            surviving_confirmation_count: survivingConfCount,
            surviving_prompt_count: survivingPromptCount,
          });
        }
      }
    } catch (fallbackErr) {
      log.warn?.('stage6.ask_audibility_net_error', {
        sessionId: session.sessionId,
        turnId,
        error: fallbackErr?.message ?? String(fallbackErr),
      });
    }

    // ── marker-② (numeric-gate-redesign 2026-07-18) — catch-all audibility
    // net. The FINAL net: fires when a chime fired and the turn produced ZERO
    // speech-intent of any kind, REGARDLESS of tool calls — the class the
    // earlier nets structurally miss ("a tool ran, didn't error, but emitted
    // nothing audible"; live prod repro "Zs for circuit 4." → calculate_zs
    // succeeds with computed:[] because the circuit has no R1+R2 → not
    // producedNothing, not allRejected, no attempted ask → beep-then-silence).
    // Placed AFTER A3/D2/F7 so those keep first crack with their class-specific
    // wording (their outputs land in result.confirmations or
    // session.pendingVoicePrompts, which predicate 4 counts — mutual exclusion
    // is structural), and BEFORE the §A4 drain so the apology reaches
    // result.confirmations THIS turn.
    //
    // Predicate — apologise only when ALL hold:
    //   1. confirmationsEnabled (mode-off users opted out of the spoken channel)
    //   2. chimeObserved (gate-pass ⟺ chime; recorded lane sets it from the
    //      fixture's chime_observed)
    //   3. NOT cancelled (the F7 Item-3 cancellation branch above owns that)
    //   4. zero SPEECH-INTENT survived: no audible confirmation, no emitted
    //      ask, no current-generation queued prompt, AND no produced-then-
    //      DEBOUNCED confirmation this turn (the inspector already heard that
    //      reading on a recent turn — apologising after a heard reading would
    //      invite a duplicate re-dictation). Readings/observations counts are
    //      deliberately NOT audibility — successful writes are UI state, not
    //      speech (counting them is exactly what preserved beep-then-silence).
    //
    // F/U-1 (2026-07-19) — the former predicate 5 (designed-silent exemption
    // for a FULLY-computed calculator success, with its outcome parser +
    // loop-ledger exhaustiveness guard) is REMOVED. It existed solely because
    // ::calc:: writes were read-back-exempt; the bundler now speaks every
    // calculator result ("calculated as" phrasing), so a clean computed turn
    // carries speech-intent and never reaches this net. Keeping the exemption
    // would MASK a calc read-back regression as designed silence — with it
    // gone, a computed turn whose confirmation is lost anywhere downstream
    // draws the apology instead of going silent (fail-audible, chime-is-a-
    // promise). A legitimately debounced calc read-back is predicate 4's
    // already-heard evidence, exactly like any other reading.
    try {
      if (options.confirmationsEnabled === true && options.chimeObserved === true && !cancelled) {
        const survivingConfCount = Array.isArray(result.confirmations)
          ? result.confirmations.filter((c) => isAudibleText(c?.text)).length
          : 0;
        const survivingPromptCount = Array.isArray(session.pendingVoicePrompts)
          ? session.pendingVoicePrompts.filter(
              (p) => isCurrentGenPrompt(p) && isAudibleText(p?.text)
            ).length
          : 0;
        const noSpeechIntent =
          survivingConfCount === 0 &&
          survivingPromptCount === 0 &&
          emittedAskToolCallIds.size === 0 &&
          debouncedConfirmationCountThisTurn === 0 &&
          // A1 agentic-voice — a staged spoken answer (real or fallback) IS
          // speech-intent: a chimed turn with an answer draws no apology
          // (mutual exclusion), exactly as audible confirmations, emitted
          // asks and queued prompts already count.
          !isAudibleText(result.spoken_response);
        if (noSpeechIntent) {
          if (!Array.isArray(session.pendingVoicePrompts)) session.pendingVoicePrompts = [];
          // F/U-2/3 (2026-07-19, Codex r1) — SPECIFIC-FIRST branch: when a
          // dispatcher recorded voice notices for this turn's successful-but-
          // writeless outcomes (rename-to-same noop, calculate wholly
          // already_set), speak THOSE instead of the generic apology. Notices
          // are turn-final FALLBACK candidates, not additive speech: a turn
          // that already produced ANY speech-intent (a corrected rename's
          // state-change TTS, an F/U-1 calc read-back for a sibling call, a
          // D2/F7 prompt, a debounced already-heard reading) never reaches
          // this branch, so a stale notice can never contradict or stack on
          // the operation that superseded it. Dispatchers cannot queue
          // prompts directly — an unstamped pendingVoicePrompts entry counts
          // as CURRENT-generation and a cancelled generation would leak it
          // onto the next turn; the accumulator dies with the turn instead.
          const notices = Array.isArray(perTurnWrites?.voiceNotices)
            ? perTurnWrites.voiceNotices.filter(
                (n) => n && typeof n.text === 'string' && n.text.trim().length > 0
              )
            : [];
          const calls = Array.isArray(toolLoopOut?.tool_calls) ? toolLoopOut.tool_calls : [];
          if (notices.length > 0) {
            for (const notice of notices) {
              session.pendingVoicePrompts.push({ text: notice.text, generationId });
            }
            log.info?.('stage6.dispatcher_voice_notice_emitted', {
              sessionId: session.sessionId,
              turnId,
              generationId,
              notice_count: notices.length,
              tool_names: calls.map((c) => c?.name ?? null),
              textPreview: notices[0].text.slice(0, 80),
            });
          } else {
            // Queue on the A4 FIFO channel (field-null / expects_ios_ack:false —
            // the drain below stamps those); the drain moves it onto the wire
            // THIS turn. generationId keeps it generation-owned.
            session.pendingVoicePrompts.push({
              text: CATCHALL_AUDIBILITY_PROMPTS[turnNum % CATCHALL_AUDIBILITY_PROMPTS.length],
              generationId,
            });
            log.info?.('stage6.catchall_audibility_fallback_emitted', {
              sessionId: session.sessionId,
              turnId,
              generationId,
              tool_names: calls.map((c) => c?.name ?? null),
              reason: 'no_speech_intent_survived',
            });
          }
        }
      }
    } catch (catchallErr) {
      log.warn?.('stage6.catchall_audibility_net_error', {
        sessionId: session.sessionId,
        turnId,
        error: catchallErr?.message ?? String(catchallErr),
      });
    }

    // ── P4 (ask-decline-ack-net 2026-07-23, feedback id 85) — answered-ask
    // silent-continuation net. Placed at the semantic seam AFTER the marker-②
    // catch block (its `emittedAskToolCallIds.size===0` term structurally
    // excludes any answered-ask turn — the earlier spoken ask permanently
    // satisfies marker-②'s audibility evidence) and BEFORE the §A4 drain (so
    // the ack reaches result.confirmations THIS turn, exactly like marker-②).
    //
    // Fires when ALL hold:
    //   1. confirmationsEnabled (a mode-off user opted out of the spoken
    //      channel). NOTE: NOT gated on chimeObserved — the answered-ask signal
    //      (a real user reply) is stronger proof of engagement than a chime,
    //      and the F7 ask net is likewise not chime-gated. Codex r1 DEVIATION
    //      from the plan's predicate-1 ("not cancelled"): the plan assumed the
    //      F7 Item-3 cancellation branch owns cancelled turns, but that branch
    //      fires ONLY when `emittedAskToolCallIds.size === 0` (a prior EMITTED
    //      ask counts as its audibility — the documented PLAN-C residual), so an
    //      ANSWERED ask on a cancelled turn (size>0) is covered by NEITHER F7
    //      (needs size 0), marker-② (!cancelled), nor a not-cancelled P4 →
    //      genuine silence, the exact feedback-85 class ("an answered turn MUST
    //      produce audible output"). P4 is uniquely positioned to close it — it
    //      knows the ask was ANSWERED, which F7 does not track. Firing on
    //      cancelled is mutually exclusive with the F7 cancellation branch
    //      (P4 requires an answered ask, size>0; F7 requires size===0) and the
    //      cancelled finalization builds result.confirmations + stages the A1
    //      answer, so a cancelled turn that DID read a value back / stage an
    //      answer still suppresses the ack via predicate 3.
    //   2. The LAST ask emitted this turn was ANSWERED by a real user reply
    //      (`answered===true`, source initial/pvr). A decline reply counts; a
    //      timeout / user_moved_on does NOT (those resolve `answered:false`, so
    //      the already-emitted question is the turn's last audio and no ack is
    //      owed). Keying on the LAST emitted ask makes this mutually exclusive
    //      with a "later emitted ask AFTER the answer" (a follow-up question is
    //      itself audible → the later ask becomes the last-emitted and, if IT
    //      timed out, `answered` is false → no ack; if IT was answered and
    //      silent, exactly ONE ack fires for it). `srv-*` engine asks never get
    //      an onAskAnswered call, so an srv-*-only turn has `answered:false` →
    //      no ack.
    //   3. Post-answer speech predicate == 0: no surviving audible confirmation,
    //      no current-generation queued prompt, AND !isAudibleText(spoken_response)
    //      — the A1 mutual-exclusion term (a `answer_user` spoken answer, real
    //      or the Item-4 fallback, is the audible response; the ack must not
    //      double-speak over it). DEBOUNCED confirmations are DELIBERATELY
    //      EXCLUDED: a debounced confirmation was removed BEFORE crossing an
    //      audible channel, so it is NOT post-answer audible output — letting
    //      `debouncedConfirmationCountThisTurn` suppress the ack would repeat
    //      the exact defect (answered utterance → silence). Only output that
    //      will ACTUALLY be spoken suppresses the ack.
    //
    // Two-variant wording (Derek): a decline-shaped answer draws the
    // affirmative DECLINE family; any other silent-but-answered outcome draws
    // the plain ANSWERED family. NEVER a "didn't catch that" apology — the
    // answer WAS understood (F/U-2/3 lesson).
    //
    // A1 backstop note: under VOICE_AGENTIC_ANSWERS the model may itself ANSWER
    // a declined/clarify ask via `answer_user` (→ spoken_response), which
    // predicate 3 treats as a survivor — so in production this net is a
    // BACKSTOP for the frozen-no-op path, not the primary channel.
    try {
      if (options.confirmationsEnabled === true) {
        // The plan's exact rule (Codex r3): find the LATEST ANSWERED blocking
        // ask (by resolutionSeq), then suppress ONLY if a NEW ask was emitted
        // AFTER that answer resolved. A prior "max-emissionSeq must be answered"
        // shortcut was NOT equivalent — an UNanswered ask emitted BEFORE the
        // latest answer resolved (e.g. an srv-* dialogue-script ask observed via
        // ASK_STARTED_OBSERVER while the initial ask awaited) would be the
        // max-emissionSeq record with answered:false and wrongly suppress the
        // ack, recreating answered-turn silence.
        //
        // `answered===true` + `resolutionSeq != null` + `resolutionSeq >
        // emissionSeq` selects a real reply whose resolution followed its
        // LATEST emission — this rejects a defensive out-of-order record AND a
        // same-id RE-EMISSION after an earlier resolution (a re-emitted ask
        // carries a stale answered:true but its new emissionSeq now exceeds its
        // resolutionSeq, so it is not "answered since re-emission"). `srv-*`
        // engine asks never receive an onAskAnswered call, so they stay
        // answered:false and are excluded.
        let latestAnswered = null;
        for (const rec of askLifecycleLedger.values()) {
          if (
            rec.answered === true &&
            rec.resolutionSeq != null &&
            rec.emissionSeq != null &&
            rec.resolutionSeq > rec.emissionSeq
          ) {
            if (latestAnswered == null || rec.resolutionSeq > latestAnswered.resolutionSeq) {
              latestAnswered = rec;
            }
          }
        }
        // A NEW ask emitted AFTER the latest answer resolved is itself audible
        // (a follow-up question), so the turn is not silent — decline the net.
        let laterAskEmitted = false;
        if (latestAnswered) {
          for (const rec of askLifecycleLedger.values()) {
            if (rec.emissionSeq != null && rec.emissionSeq > latestAnswered.resolutionSeq) {
              laterAskEmitted = true;
              break;
            }
          }
        }
        if (latestAnswered && !laterAskEmitted) {
          const survivingConfCount = Array.isArray(result.confirmations)
            ? result.confirmations.filter((c) => isAudibleText(c?.text)).length
            : 0;
          const survivingPromptCount = Array.isArray(session.pendingVoicePrompts)
            ? session.pendingVoicePrompts.filter(
                (p) => isCurrentGenPrompt(p) && isAudibleText(p?.text)
              ).length
            : 0;
          const survivingAnswer = isAudibleText(result.spoken_response);
          if (survivingConfCount === 0 && survivingPromptCount === 0 && !survivingAnswer) {
            if (!Array.isArray(session.pendingVoicePrompts)) session.pendingVoicePrompts = [];
            const isDecline = latestAnswered.declineClass === 'decline';
            const family = isDecline ? ASK_DECLINE_ACK_PROMPTS : ASK_ANSWERED_ACK_PROMPTS;
            const text = family[turnNum % family.length];
            session.pendingVoicePrompts.push({ text, generationId });
            log.info?.('stage6.answered_ask_ack_emitted', {
              sessionId: session.sessionId,
              turnId,
              generationId,
              ack_class: isDecline ? 'decline' : 'answered',
              answered_ask_source: latestAnswered.source ?? null,
            });
          }
        }
      }
    } catch (ackErr) {
      log.warn?.('stage6.answered_ask_ack_net_error', {
        sessionId: session.sessionId,
        turnId,
        error: ackErr?.message ?? String(ackErr),
      });
    }

    // §A4 (field-feedback-2026-07-14) — drain deterministic voice prompts
    // queued during the turn (the pending-value chain's terminal apology,
    // stage6-dispatcher-ask.js queuePendingValueApology, AND the F7 Item-2
    // pre-emission fallback queued just above). Same non-blocking FIFO channel
    // as the orphan net: field:null so the client's A1(b) 30 s field-nil TTL
    // (not the permanent set) governs its dedupe, and expects_ios_ack:false so
    // the audio finalizer never arms for it. Runs AFTER the orphan net so the
    // two nets stay independent (the orphan net can't fire on an ask-bearing
    // turn anyway — tool_calls > 0).
    if (Array.isArray(session.pendingVoicePrompts) && session.pendingVoicePrompts.length > 0) {
      // F7 Item 3 — drain ONLY the current generation's prompts (replacing the
      // blanket splice(0)); PRESERVE other generations' entries so a cancelled
      // generation's stale apology never leaks onto a later turn and a later
      // generation never speaks a prior generation's prompt. isCurrentGenPrompt
      // is the runLiveMode-scoped shared helper (marker-② hoist).
      const prompts = [];
      const preserved = [];
      for (const p of session.pendingVoicePrompts) {
        if (isCurrentGenPrompt(p)) prompts.push(p);
        else preserved.push(p);
      }
      session.pendingVoicePrompts = preserved;
      if (!Array.isArray(result.confirmations)) result.confirmations = [];
      for (const p of prompts) {
        // F7 Item 2 — trimmed-non-empty predicate (web trims before speaking):
        // a whitespace-only prompt must NOT reach the wire. Pre-fix this guard
        // only checked `!p.text`, so "   " slipped through.
        if (!p || typeof p.text !== 'string' || p.text.trim().length === 0) continue;
        // A pending-value terminal is queued at the point a bounded broker
        // attempt fails, but the model loop can continue. If a later round in
        // this SAME generation writes the matching value, the successful
        // read-back owns the turn and the provisional failure is no longer
        // true. Drop it before the wire; the metadata is server-owned and is
        // never exposed to either client. Other prompt families, value-less
        // failures, different values and other generations remain unchanged.
        if (pendingValuePromptWasRecovered(p, perTurnWrites)) {
          log.info?.('stage6.pending_value_apology_superseded', {
            sessionId: session.sessionId,
            turnId,
            pending_field: p.pendingField ?? null,
            pending_circuit: p.pendingCircuit ?? null,
            pending_board_id: p.pendingBoardId ?? null,
            pending_value: p.pendingValue ?? null,
          });
          continue;
        }
        result.confirmations.push({
          text: p.text,
          field: null,
          circuit: null,
          expects_ios_ack: false,
        });
        log.info?.('stage6.pending_value_apology_emitted', {
          sessionId: session.sessionId,
          turnId,
          textPreview: p.text.slice(0, 80),
        });
      }
    }

    // §A1a (field-feedback-2026-07-14) — ios_send_attempt telemetry, MOVED
    // here from the bundler. One row per confirmation that SURVIVED the
    // mid-stream-canonical filter + the token-aware debounce — i.e. exactly
    // the entries about to reach the wire. This closes the two holes in the
    // old bundler-internal placement: (1) stateChanges/obsAndClears merged
    // AFTER the loop, so circuit_op / observation / field_cleared
    // confirmations never got a row (the forensic contract this wave's
    // F2/F7/F10 diagnosis depended on was silently false for exactly those
    // ops); (2) a debounce-suppressed confirmation still produced a row.
    // Codex r8-#2 — the block sits AFTER the A3 orphan net, the D2
    // clarification fallback, and the A4 voice-prompt drain (the LAST
    // confirmation appenders), so their field-null prompts get rows too:
    // one telemetry row per surviving wire confirmation, no exceptions.
    // `expected_dedupe_key` is computed via the token-aware mirror using
    // the entry's stamped `dedupe_token` — byte-equal to what a token-aware
    // client computes (forward-looking during the backend→TestFlight/web
    // rollout window; see ios-dedupe-key.js).
    //
    // The `_confidence` strip runs UNCONDITIONALLY on every surviving entry
    // (NOT inside the debounce's length>0 guard) — reading entries carry
    // the transient sidecar from synthesiseConfirmations; state-change/obs/
    // clear entries have none and the telemetry row emits null confidence
    // for them. Strip AFTER telemetry so the row can read it, BEFORE the
    // wire so no WS frame ever carries `_confidence`.
    if (Array.isArray(result.confirmations)) {
      for (const entry of result.confirmations) {
        let expectedDedupeKey;
        // A2-multiboard item 10 — the circuit branches now fold the wire
        // `board_id` too (the degenerate branch always did). This row must stay
        // byte-truthful about what a client computes, so it passes the SAME
        // wire field the client sees; a confirmation with no `board_id` hashes
        // identically to before.
        if (Number.isInteger(entry.circuit)) {
          expectedDedupeKey = buildPerCircuitDedupeKey(
            entry.field,
            entry.circuit,
            entry.text,
            entry.dedupe_token,
            entry.board_id
          );
        } else if (Array.isArray(entry.circuits) && entry.circuits.length > 0) {
          expectedDedupeKey = buildMultiCircuitDedupeKey(
            entry.field,
            entry.circuits,
            entry.text,
            entry.dedupe_token,
            entry.board_id
          );
        } else {
          expectedDedupeKey = buildDegenerateDedupeKey(
            entry.field,
            entry.text,
            entry.board_id,
            entry.dedupe_token
          );
        }
        log?.info?.('ios_send_attempt', {
          sessionId: session.sessionId ?? null,
          turnId,
          // F7 Item 2 — the ship-gate join is on the EXACT triple
          // sessionId + turnId + generationId (turnId alone is not unique
          // after a watchdog cancellation; Item 3 composition tests require
          // this field).
          generationId,
          field: entry.field ?? null,
          circuit: Number.isInteger(entry.circuit) ? entry.circuit : null,
          circuits: Array.isArray(entry.circuits) ? entry.circuits : null,
          board_id: entry.board_id ?? null,
          confidence: typeof entry._confidence === 'number' ? entry._confidence : null,
          expected_dedupe_key: expectedDedupeKey,
        });
      }
      for (const entry of result.confirmations) {
        if ('_confidence' in entry) delete entry._confidence;
      }
    }

    // Increment turn count to match legacy's contract
    // (extractFromUtterance does this internally).
    session.turnCount = turnNum;

    // Caller-side ingestion above is the sole production billing authority.
    // Derive per-turn telemetry from those exact rows so mixed models/tiers,
    // attached failure usage and the session ledger cannot disagree. Narrow
    // partial test sessions without the Plan 00A authority simply omit cost
    // telemetry; they must not reactivate the superseded aggregate mutation.
    let turnCostEconomics = null;
    if (typeof session.costTracker?.estimateRoundUsageEconomics === 'function') {
      turnCostEconomics = session.costTracker.estimateRoundUsageEconomics(billableRoundUsage);
    }
    const billableUsageTotals = billableRoundUsage.reduce(
      (totals, row) => {
        totals.freshInput += row?.fresh_input_tokens ?? 0;
        totals.output += row?.output_tokens ?? 0;
        totals.cacheRead += row?.cache_read_input_tokens ?? 0;
        totals.cacheWrite += row?.cache_write_input_tokens ?? 0;
        return totals;
      },
      { freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    );

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
      // F7 Item 3 — null-safe: a cancelled generation has no toolLoopOut. The
      // cancellation is reflected by `cancelled: true`.
      cancelled,
      rounds: toolLoopOut?.rounds ?? 0,
      aborted: cancelled || (toolLoopOut?.aborted ?? false),
      abort_reason: toolLoopOut?.aborted && toolLoopOut?.rounds >= 8 ? 'loop_cap' : null,
      model: billableRoundUsage.at(-1)?.billing_model ?? null,
      service_tier: billableRoundUsage.at(-1)?.billing_tier ?? null,
      provider: billableRoundUsage.at(-1)?.provider ?? null,
      readings: result.extracted_readings.length,
      observations: result.observations.length,
      // Token usage logged here for per-turn CloudWatch visibility (mirrors
      // the legacy off-mode "Turn cost" log at eicr-extraction-session.js:1618).
      // Cumulative session totals live on session.costTracker and ride out
      // via cost_summary.json at session end.
      usage_input: billableUsageTotals.freshInput,
      usage_output: billableUsageTotals.output,
      usage_cache_read: billableUsageTotals.cacheRead,
      usage_cache_write: billableUsageTotals.cacheWrite,
      prompt_cache_rounds: billableRoundUsage,
      turn_cost_usd: turnCostEconomics?.actualCost ?? null,
      no_cache_cost_usd: turnCostEconomics?.noCacheCost ?? null,
      cache_net_savings_usd: turnCostEconomics?.netSavings ?? null,
    });

    // Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8).
    //
    // Emit the immutable `voice_latency.turn_core_summary` row carrying every
    // Sonnet + dispatch fact knowable at end-of-runLiveMode. The companion
    // `turn_audio_summary` is emitted by the delayed finalizer below (or
    // its 8s timeout) and shares `{sessionId, turnId}` keys for downstream
    // CloudWatch JOIN. Wrapped via the emitter's own try/catch so telemetry
    // failures never break extraction.
    //
    // F7 Item 3 — SKIP the entire core-summary + audio-finalizer block on a
    // cancelled generation: it derefs toolLoopOut.usage / .rounds /
    // .terminal_reason and reads runLiveStartNs for the perceived-latency
    // clock, none of which are meaningful for a wedged-then-cancelled turn.
    if (!cancelled)
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
        // Plan B (2026-06-17) B3 — turn_shape dimension. Classifies the turn so
        // dashboards can split Loaded Barrel HIT/MISS/drift + perceived latency by
        // shape (and verify the trade-off: single-call HIT rate stays high while
        // multi-call/round MISSes are expected & visible, not a silent regression).
        //   multi_round → the agentic loop ran >= 2 rounds (the Plan A restoration
        //                 in action — model reasoned/acted across rounds).
        //   multi_call  → one round but >= 2 tool calls (batch emit / broadcast).
        //   single_call → one round, <= 1 tool call (the clean fast path).
        // Correlate to loaded_barrel.* outcome rows via {sessionId, turnId}.
        const totalToolCalls = Array.isArray(toolLoopOut.tool_calls)
          ? toolLoopOut.tool_calls.length
          : 0;
        const turnShape =
          (toolLoopOut.rounds ?? 1) >= 2
            ? 'multi_round'
            : totalToolCalls >= 2
              ? 'multi_call'
              : 'single_call';
        emitTurnCoreSummary({
          sessionId: session.sessionId,
          turnId,
          rounds: toolLoopOut.rounds,
          turn_shape: turnShape,
          tool_call_count_total: totalToolCalls,
          // Phase 2 protocol-truth split: terminal_reason carries the
          // server-side classification (end_turn / tool_use_cap_hit /
          // aborted); actual_stop_reason_per_round preserves Anthropic's
          // stop_reason verbatim per round.
          terminal_reason: toolLoopOut.terminal_reason ?? null,
          actual_stop_reason_per_round: toolLoopOut.actual_stop_reason_per_round ?? [],
          tool_names_per_round: toolLoopOut.tool_names_per_round ?? [],
          tool_call_count_per_round: toolLoopOut.tool_call_count_per_round ?? [],
          tool_error_count_per_round: toolLoopOut.tool_error_count_per_round ?? [],
          round_timings: toolLoopOut.round_timings ?? [],
          round_usage: toolLoopOut.round_usage ?? [],
          turn_cost_usd: turnCostEconomics?.actualCost ?? null,
          no_cache_cost_usd: turnCostEconomics?.noCacheCost ?? null,
          cache_net_savings_usd: turnCostEconomics?.netSavings ?? null,
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
    // PLAN-C P4d (row 1) — drop the per-turn response-epoch ref pointer too, so
    // a later turn's dispatcher can't stamp an ask with a stale epoch ref.
    session.activeResponseEpochRef = null;
    // F7 Item 2 — detach the per-turn ask-emission observer so it never leaks
    // across turns (the ws is session-scoped). Only remove OUR observer.
    if (f7EmissionWs && f7EmissionWs[ASK_STARTED_OBSERVER] === f7EmissionObserver) {
      delete f7EmissionWs[ASK_STARTED_OBSERVER];
    }
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
    // A1 (Codex diff-review r1) — the inspect dispatcher reads BOTH off the
    // session it is bound to: certType drives the projected cert_type (an
    // EIC shadow session must not report EICR) and agenticAnswersEnabled
    // keeps the shadow lane's toolset derivation same-source as live.
    certType: session.certType,
    agenticAnswersEnabled: session.agenticAnswersEnabled === true,
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
  const extractionTurnId =
    typeof options.extractionTurnId === 'string' && options.extractionTurnId.length > 0
      ? options.extractionTurnId
      : typeof options.utteranceId === 'string' && options.utteranceId.length > 0
        ? options.utteranceId
        : randomUUID();
  options = { ...options, extractionTurnId };
  session.costTracker?.recordInspectorExtractionTurn?.(session.sessionId, extractionTurnId);
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
  // Plan A1a (2026-07-27) — the shadow lane resolves the SAME parsed
  // board-clear capability as live (from the active-session entry for this
  // session id). The shadow lane's mutations are confined to the
  // shadowSession CLONE by the existing boundary above — that is what makes
  // this safe, and it is a property of the LANE, not of the capability.
  // Denying here by construction (the round-4 error) would make live clear
  // while shadow denies: the two states diverge and every subsequent turn
  // reports spurious divergence — the exact failure the clone invariant
  // comment exists to prevent.
  const shadowCapEntry = getActiveSessionEntry(session.sessionId);
  // Plan B §3.2 — same bound refusal-staging callback as the live lane
  // (both unknown-tool routes stage identically on both lanes; the shadow
  // lane's notices land in the shadow perTurnWrites and never cross to live).
  const shadowOnUnknownToolRefusal = (toolCallId) =>
    stageUnknownToolRefusal(perTurnWrites, shadowSession, { turnId, toolCallId });
  const writes = createWriteDispatcher(shadowSession, log, turnId, perTurnWrites, {
    hasBoardClearV1: shadowCapEntry?.voiceLatency?.capabilities?.hasBoardClearV1 === true,
    onUnknownToolRefusal: shadowOnUnknownToolRefusal,
  });
  // A1 agentic-voice (2026-07-23) — same two dedicated answer-feature routes
  // as the live lane (a tool is never advertised on one lane only, and never
  // advertised without a dispatch route). Bound to shadowSession so the
  // inspect projector reads the shadow clone's snapshot, keeping the shadow
  // lane side-effect-free on live state.
  // A1 Codex r1 — derive from the shadowSession wrapper (which copies the
  // live session's latch) so the shadow dispatchers and the shadow toolset
  // are same-source.
  const shadowAgenticAnswersEnabled = shadowSession?.agenticAnswersEnabled === true;
  const shadowAnswers = createAnswerDispatcher(shadowSession, log, turnId, perTurnWrites);
  const shadowInspects = createInspectDispatcher(shadowSession, log, turnId, perTurnWrites);
  const shadowObservationClarificationTerminals = createObservationClarificationTerminalDispatcher(
    shadowSession,
    log,
    turnId
  );
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
    dispatcher = createToolDispatcher(writes, asks, {
      answers: shadowAnswers,
      inspects: shadowInspects,
      observationClarificationTerminals: shadowObservationClarificationTerminals,
      onUnknownToolRefusal: shadowOnUnknownToolRefusal,
    });
    sortRecords = createSortRecordsAsksLast();
  } else {
    // A1: composer even without pendingAsks — see the live-lane comment.
    dispatcher = createToolDispatcher(writes, null, {
      answers: shadowAnswers,
      inspects: shadowInspects,
      observationClarificationTerminals: shadowObservationClarificationTerminals,
      onUnknownToolRefusal: shadowOnUnknownToolRefusal,
    });
    sortRecords = undefined; // runToolLoop treats undefined as identity.
  }

  // Step 4: drive the real tool loop. Any thrown error is CAUGHT so shadow
  // failure NEVER breaks production — legacy return value is authoritative.
  let toolLoopOut;
  const shadowLoopInvocationId = `shadow-${randomUUID()}`;
  let shadowAccountingStarted = false;
  let shadowFailureUsage = null;
  let shadowRoundUsage = [];
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
    const shadowTarget = resolveSessionExtractionTarget(session, SHADOW_MODEL);

    shadowAccountingStarted =
      session.costTracker?.beginBillableInvocation?.(shadowLoopInvocationId) === true;
    toolLoopOut = await runToolLoop({
      client: shadowTarget.client,
      model: shadowTarget.model,
      provider: shadowTarget.provider,
      system: systemBlocks,
      messages: [{ role: 'user', content: transcriptText }],
      // A1: shadow lane advertises the SAME flag-filtered toolset as live.
      tools: buildSessionTools(shadowAgenticAnswersEnabled),
      dispatcher,
      ctx: { sessionId: session.sessionId, turnId },
      billingIdentity: shadowLoopInvocationId,
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
    shadowFailureUsage = err?.billableUsage ?? null;
    // F7 Item 3 — defence-in-depth: cancellation is live-mode only (shadow
    // threads no signal), but if a fatal control-flow error ever reaches the
    // shadow-mode catch, rethrow it unchanged rather than silently returning
    // the legacy result.
    if (isStage6FatalControlFlowError(err)) throw err;
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
  } finally {
    shadowRoundUsage = toolLoopOut?.round_usage ?? shadowFailureUsage?.round_usage ?? [];
    session.costTracker?.ingestBillableUsage?.(
      shadowLoopInvocationId,
      shadowRoundUsage,
      'inspector_shadow'
    );
    if (shadowAccountingStarted) {
      session.costTracker?.endBillableInvocation?.(shadowLoopInvocationId);
    }
  }

  // Plan 05-01 — release per-turn gate timers on the success path BEFORE
  // bundling/divergence-log. Same idempotency contract as the catch path.
  askGateForTurn?.destroy();

  // Cost tracking — shadow mode makes a real billable Anthropic call in
  // parallel to legacy extract(). Legacy already tracks itself at
  // eicr-extraction-session.js:1614; without this wiring the shadow leg
  // Step 5: bundle ONCE post-loop (Pitfall #3 — never mid-loop).
  // confirmationsEnabled: shadow mode prefers legacy.confirmations when
  // present (Sonnet prose-JSON emitted them) but still synthesises from
  // tool calls if the client opted in and legacy returned an empty array.
  const toolResult = bundleToolCallsIntoResult(perTurnWrites, legacy, {
    confirmationsEnabled: options.confirmationsEnabled === true,
  });

  // P5 (2026-07-23) — emit clear→write collapse telemetry (shadow path).
  emitClearWriteCollapseTelemetry(log, session, turnId, toolResult);

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
