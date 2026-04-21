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
 * applied. The legacy path uses the array form at eicr-extraction-session.js
 * :370,815 with cache_control ephemeral. This harness mirrors that shape so
 * shadow mode shares the legacy cache key and does NOT double-bill the
 * system prompt.
 * ---------------------------------------------------------------------------
 */

import logger from '../logger.js';
import { runToolLoop } from './stage6-tool-loop.js';
import { createWriteDispatcher } from './stage6-dispatchers.js';
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

  if (mode === 'live') {
    // Phase-1 guard preserved. Phase 7 lifts this.
    throw new Error('SONNET_TOOL_CALLS=live not implemented until Phase 7');
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
  const dispatcher = createWriteDispatcher(session, log, turnId, perTurnWrites);

  // Step 4: drive the real tool loop. Any thrown error is CAUGHT so shadow
  // failure NEVER breaks production — legacy return value is authoritative.
  let toolLoopOut;
  try {
    // System block uses array-of-blocks form to match legacy's prompt-cache
    // shape (eicr-extraction-session.js:370,815 with cache_control:ephemeral).
    // This keeps shadow mode on the same cache key as legacy and avoids
    // doubling system-prompt billing per turn.
    const systemBlocks = [
      {
        type: 'text',
        text: session.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    toolLoopOut = await runToolLoop({
      client: session.client,
      model: SHADOW_MODEL,
      system: systemBlocks,
      messages: [{ role: 'user', content: transcriptText }],
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: { sessionId: session.sessionId, turnId },
      logger: log,
    });
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
    return legacy;
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
