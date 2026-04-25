#!/usr/bin/env node
/**
 * Stage 6 Phase 5 Plan 05-06 — over-ask exit-gate harness.
 *
 * WHAT: Offline replay harness that loads the 12 over-ask golden-session
 * fixtures (5 pre-existing dual-SSE fixtures + 7 new Phase 5 fixtures),
 * replays each through the FULLY-COMPOSED Phase 5 pipeline (the real
 * createAskGateWrapper + real createAskBudget + real createRestrainedMode +
 * real createFilledSlotsShadowLogger), captures per-session ask counts +
 * restrained-mode activations, and computes median / p95 / activation-rate.
 * Exits 0 if all three locked thresholds pass; exits 1 if any one breaches
 * (Open Question #6 lock — ANY breach = fail; the three metrics are
 * independent failure modes, so the gate is conjunctive).
 *
 * WHY this is the Phase 5 closure gate (ROADMAP §Phase 5 SC #8): every
 * Phase 5 plan (05-01..05-05) shipped with unit-test coverage of its own
 * surface; 05-06 is the integration test that exercises ALL FOUR gates
 * (gate wrapper / budget / restrained / shadow) end-to-end against the
 * over-ask failure modes Research §Q8 enumerated. The script's exit code
 * is the go/no-go signal for the Phase 5 Codex STG review + phase closure.
 *
 * ---------------------------------------------------------------------------
 * SCAFFOLDING SOURCE — CLONED, NEVER EDITED
 * ---------------------------------------------------------------------------
 * scripts/stage6-golden-divergence.js is r16+-owned per the Phase 5
 * forbidden-file lock. This script CLONES the structural conventions of
 * its older sibling:
 *   - module-level CLI detection via path.resolve(process.argv[1]) ===
 *     path.resolve(__filename)
 *   - parseArgs() returns a shape consumed by main()
 *   - JSON digest written to stdout (compact in --json mode, pretty
 *     otherwise) matching the <interfaces> contract documented in
 *     05-06-...-PLAN.md
 *   - process.exit(0|1|2) where 0=pass, 1=breach, 2=runtime error
 *
 * Codex STG grep proof: `git diff stage6-phase5-base --
 * scripts/stage6-golden-divergence.js` returns empty.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE COUNT — SCOPE-REDUCED FROM 20 TO 12 (Open Question #3 lock)
 * ---------------------------------------------------------------------------
 * The ROADMAP §Phase 5 SC #8 wording is "20-golden-session shadow run".
 * Per Plan 05-06's Open Question #3 lock + plan-check verdict, that
 * 20-session number becomes a PHASE 7 TARGET (real shadow-traffic
 * captures, scrubbed) — NOT a Phase 5 engineering gate. Plan 05-06
 * ships 12 hand-crafted fixtures: 5 pre-existing Phase 4 dual-SSE
 * fixtures (sample-01..05, treated as zero-ask in this harness because
 * dual-SSE fixtures don't exercise ask_user) + 7 new Phase 5 over-ask
 * fixtures (sample-06..12).
 *
 * Phase 7 absorbs the 20-session aggregate via STR-03 production-shadow
 * gate. The two gates are complementary: Phase 5 = synthetic + integration
 * (the gates are wired correctly); Phase 7 = real-traffic statistical (the
 * gates work on real model behaviour).
 *
 * ---------------------------------------------------------------------------
 * AGGREGATION — full set (Plan 05-07 r1-#2 closure)
 * ---------------------------------------------------------------------------
 * Every loaded fixture contributes to median / p95 / restrained_rate. The
 * pre-fix gate_fixture:true partition was dropped in r1-#2 because it
 * silently EXCLUDED the canonical over-ask scenarios (sample-07
 * restrained-mode trigger; sample-08 budget exhaustion) from breach
 * detection — the aggregate could never breach on the very fixtures
 * designed to demonstrate the wiring works.
 *
 * Threshold recalibration: with 1 deliberate activation canary in N=12
 * the floor on restrained_rate is 1/12 ≈ 8.3%. The original 0.02 target
 * (now scoped to Phase 7 STR-03 prod-shadow) was bumped to 0.10 — the
 * smallest sensible ceiling that admits the canary while still rejecting
 * a regression that adds a SECOND unintended activation (2/12 ≈ 16.6%).
 *
 * The fixtures' `gate_fixture` boolean is RETAINED on the per-fixture
 * digest entries as a diagnostic (so a fixture author can still see
 * which fixtures were historically considered "smoke-only"), but it is
 * NO LONGER consulted by the aggregate metric path.
 *
 * Phase 7's STR-03 prod-shadow gate operates on the 20-session prod pool
 * with the original 2% restrained_rate target — real prod traffic has
 * the natural distribution Phase 5 fixtures cannot reproduce with
 * hand-crafted seeds. The two-tier threshold (0.10 hand-crafted; 0.02
 * prod-shadow) is documented in 05-REVIEW.md + 05-07-SUMMARY.md.
 *
 * ---------------------------------------------------------------------------
 * INNER-DISPATCHER REPLAY SHAPE — minimal mock (Plan 05-06 Open Question)
 * ---------------------------------------------------------------------------
 * The harness composes the FOUR Phase 5 gates around a MINIMAL MOCK inner
 * dispatcher (NOT the real Plan 03-05 createAskDispatcher). The mock
 * accepts (call, ctx) and returns the fixture's hand-crafted `inner_outcome`
 * wrapped as {tool_use_id, content:JSON.stringify(inner_outcome), is_error}.
 *
 * Why minimal-mock over real-dispatcher:
 *   1. Faithfulness: the GATES are what we're testing. The inner dispatcher's
 *      behaviour (timeout / user_moved_on / shadow_mode / etc) is owned by
 *      Plan 03-05's own unit tests + the F21934D4 reproducer. Re-asserting
 *      it here would muddy the Phase 5 gate signal.
 *   2. Determinism: the real dispatcher needs a WS handle, a session
 *      ws.send shim, and the pendingAsks registry — all stateful surfaces
 *      this offline harness has no business pretending to wire.
 *   3. Speed: synchronous mock returns instantly; the real dispatcher
 *      awaits an iOS reply via deferred Promise.
 *
 * ---------------------------------------------------------------------------
 * 60-SECOND RESTRAINED-MODE RELEASE — Option A (nowFn DI hook)
 * ---------------------------------------------------------------------------
 * createRestrainedMode in Plan 05-04 exposes a `nowFn: () => number`
 * injectable wall-clock reader (per the 05-PLAN-CHECK Wave-2 prerequisite).
 * The harness threads `nowFn: () => syntheticTime` and increments
 * syntheticTime between asks based on the fixture's synthetic_time_ms
 * field. Within a single fixture replay the synthetic clock never crosses
 * the 60s boundary, so isActive() returns true for the whole fixture span
 * and downstream asks short-circuit as designed.
 *
 * (The setTimeout the state machine schedules for the actual onRelease
 * callback DOES use real timers, but with `releaseMs: 60000` and a
 * synchronous fixture replay, the Node event loop never reaches it —
 * destroy() is called on per-fixture teardown which clearTimeout's the
 * pending release. No 60s wait.)
 *
 * ---------------------------------------------------------------------------
 * DEBOUNCE TIMER — bypassed via delayMs: 0
 * ---------------------------------------------------------------------------
 * The gate wrapper closes over a 1500ms setTimeout (QUESTION_GATE_DELAY_MS)
 * to debounce same-key duplicate asks. With ~20 sequential asks across
 * 12 fixtures, the cumulative wait at the production tuning would push
 * the harness past Plan 05-06's 30s budget. The harness passes
 * `delayMs: 0` to createAskGateWrapper so each gateOrFire fires on the
 * next microtask. The 1500ms behaviour itself is locked by
 * stage6-ask-gate-wrapper.test.js Group 2 — Plan 05-06's harness is
 * about gate COMPOSITION + threshold metrics, not the debounce timing.
 *
 * ---------------------------------------------------------------------------
 * FORBIDDEN FILES (Plan 05-06's truth #2)
 * ---------------------------------------------------------------------------
 * This script MUST NOT modify ANY of:
 *   - scripts/stage6-golden-divergence.js (r16+ owned)
 *   - src/extraction/stage6-dispatcher-ask.js (Plan 03-05)
 *   - src/extraction/stage6-ask-gate-wrapper.js (Plan 05-01)
 *   - src/extraction/stage6-filled-slots-shadow.js (Plan 05-02)
 *   - src/extraction/stage6-ask-budget.js (Plan 05-03)
 *   - src/extraction/stage6-restrained-mode.js (Plan 05-04)
 *   - src/extraction/stage6-dispatcher-logger.js (Plan 05-05)
 *   - src/extraction/eicr-extraction-session.js
 *   - src/extraction/question-gate.js
 *   - src/extraction/filled-slots-filter.js
 *
 * The script imports them; it never edits them.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES
 * ---------------------------------------------------------------------------
 *   0  → all gate thresholds passed (and, in --smoke mode, all expected_*
 *        assertions matched).
 *   1  → at least one gate threshold breached (or, in --smoke mode, at
 *        least one expected_* mismatch).
 *   2  → runtime error (fixture parse failure, factory throw, etc).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAskGateWrapper,
  wrapAskDispatcherWithGates,
  isWrapperShortCircuitReason,
  isPreEmitNonFireReason,
} from '../src/extraction/stage6-ask-gate-wrapper.js';
import { createAskBudget } from '../src/extraction/stage6-ask-budget.js';
import { createRestrainedMode } from '../src/extraction/stage6-restrained-mode.js';
import { createFilledSlotsShadowLogger } from '../src/extraction/stage6-filled-slots-shadow.js';
import { validateAskUser } from '../src/extraction/stage6-dispatch-validation.js';

// Plan 05-07 r1-#1 + Plan 05-08 r2-#1 + Plan 05-10 r4-#2 — the
// harness's "exclude from askCount" predicate composes the wrapper's
// two predicates with the harness-local pair of synth reasons.
//
// Members:
//   - isWrapperShortCircuitReason(reason)  — gated / session_terminated /
//     dispatcher_error (the wrapper's own short-circuit synth reasons).
//   - 'restrained_mode' / 'ask_budget_exhausted' — wrapper-emitted
//     synth reasons that NEVER reach the wrapper's isRealFire
//     classifier (their code paths short-circuit BEFORE the post-
//     dispatch counter step). At the harness accounting layer
//     (envelopes only, no wrapper internals), they're "wrapper-
//     suppressed" all the same.
//   - isPreEmitNonFireReason(reason) — validation_error /
//     duplicate_tool_call_id / prompt_leak_blocked / shadow_mode.
//     Dispatcher-local pre-emit failures: the envelope carries one of
//     these reasons but the ask never registered with pendingAsks and
//     never emitted ask_user_started to iOS. The wrapper itself treats
//     these as non-fires (isRealFire gates on isPreEmitNonFireReason)
//     so askBudget + restrainedMode.recordAsk are not consumed. The
//     harness mirrors via the same predicate (single source of truth —
//     adding a member to the wrapper's private set automatically
//     tightens the harness too).
//
// Plan 05-10 r4-#2 background: the wrapper used to export the two
// underlying Sets directly. `Object.freeze(new Set([...]))` does NOT
// prevent `.add()` / `.delete()` on a Set, so any importer could
// silently mutate the budget classifier. r4-#2 replaced the Set
// exports with read-only predicates; the harness composes them here
// rather than spreading the (now private) Sets.
function isHarnessWrapperShortCircuitReason(reason) {
  return (
    isWrapperShortCircuitReason(reason) ||
    reason === 'restrained_mode' ||
    reason === 'ask_budget_exhausted' ||
    isPreEmitNonFireReason(reason)
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// LOCKED THRESHOLDS — Phase 5 hand-crafted 12-fixture aggregate calibration.
// Frozen so runtime drift requires a triple-update (ROADMAP + this script +
// 05-06-SUMMARY + 05-07-SUMMARY + 05-REVIEW).
// ============================================================================
//
// Plan 05-07 r1-#2 — restrainedRateMax bumped from 0.02 (Phase 7 prod-shadow
// target) to 0.10 (Phase 5 hand-crafted aggregate target).
//
// Why the bump:
//   - r1-#2 fix removed the gate_fixture:false partition; the aggregate now
//     spans EVERY loaded fixture (N=12). Sample-07 deliberately activates
//     restrained mode (proving the wiring works), so the floor on this set
//     is 1/12 ≈ 8.3%. The original 0.02 value would unconditionally breach
//     under r1-#2's full-set aggregation — masking real over-ask breaches
//     behind a gate that already failed on a healthy run.
//   - 0.10 is the smallest sensible ceiling that admits sample-07's
//     deliberate canary while still rejecting a regression that adds a
//     SECOND unintended activation (2/12 ≈ 16.6% > 10% breaches).
//
// Why the 0.02 target is preserved (NOT raised everywhere):
//   - Phase 7 STR-03 prod-shadow gate operates on REAL prod traffic where
//     hand-crafted activation canaries don't exist. The 2% target reflects
//     real prod tolerance, not Phase 5's synthetic distribution.
//   - 05-REVIEW.md + 05-07-SUMMARY.md + this header all document the
//     two-tier threshold (Phase 5 = 0.10 hand-crafted; Phase 7 = 0.02
//     prod-shadow) so Phase 7 STR-03 work inherits the correct value.
//
// medianMax + p95Max unchanged from Plan 05-06's calibration — those held
// up across the r1-#1 askCount semantic shift + the r1-#2 full-set
// aggregation move (current run: median=0, p95=3, comfortably under 1+4).
export const EXIT_GATE_THRESHOLDS = Object.freeze({
  medianMax: 1,
  p95Max: 4,
  restrainedRateMax: 0.1,
});

// Plan 05-06 ships Phase 5 over-ask fixtures in a DEDICATED sibling
// directory rather than co-locating with the Phase 4 dual-SSE fixtures.
// The Phase 4 divergence harness (scripts/stage6-golden-divergence.js,
// forbidden-file-locked) reads every *.json in stage6-golden-sessions
// and throws on any fixture missing both `sse_events_legacy` and
// `expected_slot_writes` (Plan 04-07 r1 anti-self-compare guard). Adding
// Phase 5 over-ask fixtures (which don't have that shape) into the same
// directory would break Phase 4 divergence — and editing the divergence
// script to skip them would violate the Phase 5 forbidden-file lock.
//
// Resolution: stage6-phase5-golden-sessions/ for the 7 new Phase 5 fixtures.
// The exit-gate harness aggregates BOTH directories — sample-01..05 from
// the Phase 4 dir contribute as zero-ask fixtures (per truth #6's
// backwards-compat default).
const PHASE5_FIXTURES_DIR = path.resolve(
  __dirname,
  '..',
  'src',
  '__tests__',
  'fixtures',
  'stage6-phase5-golden-sessions'
);
const PHASE4_DUAL_SSE_DIR = path.resolve(
  __dirname,
  '..',
  'src',
  '__tests__',
  'fixtures',
  'stage6-golden-sessions'
);
// Default fixtures pool = Phase 5 dir as the PRIMARY source. The Phase 4
// dual-SSE fixtures are pulled in additionally by runHarness when
// --fixtures-dir is NOT overridden, so the canonical run aggregates 12
// fixtures (5 legacy zero-ask + 7 new Phase 5).
const DEFAULT_FIXTURES_DIR = PHASE5_FIXTURES_DIR;

// ============================================================================
// FIXTURE LOADER
// ============================================================================

/**
 * Read every *.json file in `dir` (sorted) and parse. Throws on parse
 * failure — silent skipping would let a malformed fixture slip into a
 * 0% breach result. Mirrors the divergence-script convention.
 */
function loadFixtures(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`fixtures dir not found: ${dir}`);
  }
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      throw new Error(`fixture parse failed: ${fullPath}: ${err.message}`);
    }
    out.push({ filename: name, fullPath, fixture: parsed });
  }
  return out;
}

/**
 * Plan 05-07 r1-#4 — fixture schema validation gate.
 *
 * Every loaded Phase 5 over-ask fixture MUST carry ask_user_calls[].call.input
 * shapes that pass the production validateAskUser. The minimal mock inner
 * dispatcher in this harness does NOT run the validator (deliberately —
 * see module header), so without this gate an invalid fixture would replay
 * through the wrapper composition unchallenged and silently corrupt the
 * metric. Real Plan 03-05 dispatch rejects the same shapes at the validator
 * gate before any inner work runs; the harness mirrors that discipline.
 *
 * Skips Phase 4 dual-SSE fixtures (_fixture_shape !== 'phase5-over-ask')
 * because those fixtures don't carry ask_user_calls[] — they contribute
 * zero to the aggregate by design (Plan 05-06 truth #6).
 *
 * Throws on first invalid call. The CLI's catch block maps the throw to
 * process.exit(2); the message format includes the fixture filename and
 * the failed call index so an operator can find the offending fixture in
 * one click.
 *
 * @param {Array<{filename:string, fullPath:string, fixture:object}>} loaded
 * @throws {Error} on first invalid ask_user input
 */
function validateFixtureInputs(loaded) {
  for (const { filename, fixture } of loaded) {
    // Phase 4 dual-SSE fixtures never carry ask_user_calls[]; skip them.
    // The harness already treats them as zero-contribution via applyDefaults
    // → ask_user_calls = [] and the per-fixture replay loop iterates an
    // empty array.
    if (fixture._fixture_shape !== 'phase5-over-ask') continue;
    const calls = Array.isArray(fixture.ask_user_calls) ? fixture.ask_user_calls : [];
    for (let i = 0; i < calls.length; i += 1) {
      const input = calls[i]?.call?.input;
      const result = validateAskUser(input);
      if (result !== null) {
        throw new Error(
          `fixture invalid: ${filename}: ask_user_calls[${i}].call.input → ${result.code}:${result.field ?? '<no field>'}`
        );
      }
    }
  }
}

/**
 * Apply Phase 5 backwards-compat defaults. sample-01..05 are pre-existing
 * Phase 4 dual-SSE fixtures with no `_fixture_shape: 'phase5-over-ask'`
 * marker; they contribute zero asks + zero activations + zero shadow logs
 * to the aggregate (this is the gate-friendly null contribution
 * documented in Plan 05-06 truth #6).
 */
function applyDefaults(fx) {
  const isPhase5Shape = fx._fixture_shape === 'phase5-over-ask';
  return {
    ...fx,
    ask_user_calls: Array.isArray(fx.ask_user_calls) ? fx.ask_user_calls : [],
    expected_ask_user_count:
      typeof fx.expected_ask_user_count === 'number' ? fx.expected_ask_user_count : 0,
    expected_restrained_activations:
      typeof fx.expected_restrained_activations === 'number'
        ? fx.expected_restrained_activations
        : 0,
    expected_outcome_distribution: fx.expected_outcome_distribution ?? {},
    expected_filled_slots_shadow_logs:
      typeof fx.expected_filled_slots_shadow_logs === 'number'
        ? fx.expected_filled_slots_shadow_logs
        : 0,
    pre_seeded_circuits: fx.pre_seeded_circuits ?? {},
    // Default gate_fixture: legacy fixtures without the marker are gate
    // contributors (zero everything is benign). Phase 5 fixtures that
    // deliberately demonstrate breach/short-circuit set this to false.
    gate_fixture: typeof fx.gate_fixture === 'boolean' ? fx.gate_fixture : !isPhase5Shape,
  };
}

// ============================================================================
// PER-FIXTURE REPLAY HARNESS
// ============================================================================

/**
 * No-op logger interface; the gate wrapper, budget, restrained-mode and
 * shadow modules all accept any shape with .info / .warn. The harness
 * captures rows by name into in-memory arrays for post-replay assertion.
 */
function createCapturingLogger() {
  const rows = [];
  return {
    rows,
    info(name, payload) {
      rows.push({ level: 'info', name, payload });
    },
    warn(name, payload) {
      rows.push({ level: 'warn', name, payload });
    },
    error(name, payload) {
      rows.push({ level: 'error', name, payload });
    },
  };
}

/**
 * Build a minimal mock inner dispatcher. Returns a `(call, ctx) => Promise<envelope>`
 * function that synthesises the {tool_use_id, content, is_error} shape from a
 * lookup table keyed by call.id. The lookup table is provided per fixture so
 * each call's hand-crafted inner_outcome is wired to its corresponding
 * tool_call_id.
 *
 * Why a Map rather than a plain object: tool_call_ids could in theory collide
 * with Object.prototype property names. Map gives clean key namespace.
 */
function createInnerDispatcher(outcomesById) {
  return async function innerDispatcher(call, _ctx) {
    const outcome = outcomesById.get(call.id) ?? { answered: false, reason: 'no_outcome_in_fixture' };
    return {
      tool_use_id: call.id,
      content: JSON.stringify(outcome),
      is_error: false,
    };
  };
}

/**
 * Replay a single fixture through a freshly-constructed Phase 5 pipeline.
 * Returns observed metrics + a list of envelopes (one per ask emitted) for
 * smoke-mode assertion.
 *
 * Pipeline assembly mirrors Plan 05-01's wrapAskDispatcherWithGates contract
 * exactly — every gate the wrapper closes over is a real Phase 5 module.
 */
async function replayFixture(fx) {
  const logger = createCapturingLogger();
  const sessionId = fx.session?.jobId ?? fx.id ?? 'unknown';

  // Synthetic clock — increments per-ask via fx.ask_user_calls[i].synthetic_time_ms.
  // Initialised at 1ms (NOT 0) so isActive()'s `activeUntilMs > 0` guard does
  // not false-positive on the very first activate() — activeUntilMs is set to
  // `nowFn() + releaseMs`, and nowFn=0 → activeUntilMs=releaseMs which is >0
  // anyway, but keeping the synthetic clock at a positive baseline avoids any
  // implicit-zero edge case.
  let syntheticTime = 1;

  // Per-fixture gate instances — fresh state per fixture mirrors production
  // per-session isolation (each session in sonnet-stream.js gets its own
  // askBudget + restrainedMode in activeSessions.set).
  const askBudget = createAskBudget();
  let activationCount = 0;
  const restrainedMode = createRestrainedMode({
    onActivate: () => {
      activationCount += 1;
    },
    nowFn: () => syntheticTime,
    // releaseMs left at default 60000ms — synthetic clock never advances
    // far enough within a fixture replay to cross it, so isActive() stays
    // true post-activation as designed.
  });

  // Build the stateSnapshot the filled-slots-shadow logger reads. Plan 05-02
  // expects { sessionId, stateSnapshot: { circuits: {...} } } from
  // sessionGetter.
  const stateSnapshot = { circuits: { ...fx.pre_seeded_circuits } };
  const filledSlotsShadow = createFilledSlotsShadowLogger({
    sessionGetter: () => ({ sessionId, stateSnapshot }),
    logger,
  });

  // delayMs: 0 — bypass the 1500ms debounce. See module header section
  // "DEBOUNCE TIMER — bypassed via delayMs: 0".
  const gate = createAskGateWrapper({ delayMs: 0, logger, sessionId });

  const outcomesById = new Map();
  for (const entry of fx.ask_user_calls) {
    outcomesById.set(entry.call.id, entry.inner_outcome);
  }
  const innerDispatcher = createInnerDispatcher(outcomesById);

  const wrappedDispatcher = wrapAskDispatcherWithGates(innerDispatcher, {
    askBudget,
    restrainedMode,
    gate,
    filledSlotsShadow,
    logger,
    sessionId,
  });

  // Replay each call sequentially. The harness ADVANCES synthetic time
  // BEFORE the call (so the wrapper's restrainedMode.isActive() check
  // sees the new clock) and uses the call's turnId as the recordAsk
  // parser input.
  const observedEnvelopes = [];
  for (const entry of fx.ask_user_calls) {
    syntheticTime += Number.isFinite(entry.synthetic_time_ms) ? entry.synthetic_time_ms : 0;
    const envelope = await wrappedDispatcher(entry.call, {
      sessionId,
      turnId: entry.turnId,
    });
    observedEnvelopes.push({ entry, envelope });
  }

  // Tear down the per-fixture gate state (Plan 05-04's Pitfall 5 — destroy
  // clears the pending release timer; matters for Node exit cleanliness on
  // a long-running CI).
  gate.destroy();
  restrainedMode.destroy();
  askBudget.destroy();

  // Compute observed metrics from envelopes + logger.rows.
  //
  // Plan 05-07 r1-#1 + Plan 05-10 r4-#2 — askCount mirrors the wrapper's
  // real-fire semantics via the harness's
  // `isHarnessWrapperShortCircuitReason` predicate (composed from the
  // wrapper's two read-only predicates plus the harness-local pair of
  // synth reasons). Every dispatched ask_user counts EXCEPT those whose
  // envelope reason is wrapper-suppressed (gated / session_terminated /
  // dispatcher_error / restrained_mode / ask_budget_exhausted /
  // validation_error / duplicate_tool_call_id / prompt_leak_blocked /
  // shadow_mode). Pre-fix the metric counted only `body.answered === true`
  // which underclassified user_moved_on / timeout / etc — the wrapper
  // itself increments budget for those (because they ARE real asks
  // Sonnet emitted to the user; the user just didn't engage with them).
  // The aggregate metric must match the wrapper's accounting or the SC #8
  // gate diverges from the production gate semantics.
  const outcomeDistribution = {
    answered: 0,
    gated: 0,
    ask_budget_exhausted: 0,
    restrained_mode: 0,
    user_moved_on: 0,
    timeout: 0,
  };
  let firedAskCount = 0;
  for (const { envelope } of observedEnvelopes) {
    let body;
    try {
      body = JSON.parse(envelope.content);
    } catch {
      continue;
    }
    if (body.answered === true) {
      outcomeDistribution.answered += 1;
      firedAskCount += 1;
    } else if (typeof body.reason === 'string') {
      // Bucket the reason for the smoke-mode distribution check.
      if (body.reason in outcomeDistribution) {
        outcomeDistribution[body.reason] += 1;
      } else {
        outcomeDistribution[body.reason] = (outcomeDistribution[body.reason] ?? 0) + 1;
      }
      // Plan 05-07 r1-#1 + Plan 05-10 r4-#2 — count this envelope toward
      // askCount UNLESS it's a wrapper-internal short-circuit. Inner-
      // dispatcher reasons (user_moved_on, timeout, transcript_already_
      // extracted, etc) all count as fires; only wrapper-suppressed asks
      // are excluded. The predicate composes the wrapper's two
      // read-only predicates with the harness-local pair of synth
      // reasons (single source of truth — the underlying Sets are
      // module-private inside the wrapper).
      if (!isHarnessWrapperShortCircuitReason(body.reason)) {
        firedAskCount += 1;
      }
    }
  }

  const filledSlotsShadowLogCount = logger.rows.filter(
    (r) => r.name === 'stage6.filled_slots_would_suppress'
  ).length;

  return {
    fixtureId: fx.id ?? sessionId,
    askCount: firedAskCount,
    activationCount,
    outcomeDistribution,
    filledSlotsShadowLogCount,
    isGateFixture: fx.gate_fixture !== false,
  };
}

// ============================================================================
// METRIC COMPUTATION
// ============================================================================

/**
 * Sort-based percentile. For N=12 the cost is trivial; the simpler
 * implementation is preferred over a quickselect for readability.
 *
 * Uses the "nearest-rank" method: idx = ceil(p/100 * N) - 1, clamped to
 * [0, N-1]. This matches CloudWatch Insights' default percentile semantics
 * (Phase 8 dashboards consume the same metric, so the offline harness and
 * the production metric must agree on the percentile definition).
 */
export function percentile(arr, p) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * Compute the breach set from observed metrics + locked thresholds.
 * Returns an array of breach names (empty if all pass). Strict `>`
 * comparison — at-threshold is at-limit, not a breach.
 */
export function computeBreaches({ median, p95, restrainedRate }) {
  const breaches = [];
  if (median > EXIT_GATE_THRESHOLDS.medianMax) breaches.push('median');
  if (p95 > EXIT_GATE_THRESHOLDS.p95Max) breaches.push('p95');
  if (restrainedRate > EXIT_GATE_THRESHOLDS.restrainedRateMax) breaches.push('restrained_rate');
  return breaches;
}

// ============================================================================
// SMOKE-MODE ASSERTION
// ============================================================================

/**
 * In --smoke mode every fixture is expected to match its expected_*
 * fields exactly. Returns an array of mismatch records (empty on full
 * match). Caller wraps this in exit-code logic.
 */
function assertSmoke(fx, observed) {
  const mismatches = [];
  if (observed.askCount !== fx.expected_ask_user_count) {
    mismatches.push(
      `${fx.id ?? fx.filename}: ask_user_count expected=${fx.expected_ask_user_count} observed=${observed.askCount}`
    );
  }
  if (observed.activationCount !== fx.expected_restrained_activations) {
    mismatches.push(
      `${fx.id ?? fx.filename}: restrained_activations expected=${fx.expected_restrained_activations} observed=${observed.activationCount}`
    );
  }
  if (observed.filledSlotsShadowLogCount !== fx.expected_filled_slots_shadow_logs) {
    mismatches.push(
      `${fx.id ?? fx.filename}: filled_slots_shadow_logs expected=${fx.expected_filled_slots_shadow_logs} observed=${observed.filledSlotsShadowLogCount}`
    );
  }
  // expected_outcome_distribution: only assert keys the fixture explicitly
  // listed (additive). Extra observed keys are diagnostic, not a mismatch.
  for (const [key, expectedValue] of Object.entries(fx.expected_outcome_distribution ?? {})) {
    const observedValue = observed.outcomeDistribution[key] ?? 0;
    if (observedValue !== expectedValue) {
      mismatches.push(
        `${fx.id ?? fx.filename}: outcome_distribution.${key} expected=${expectedValue} observed=${observedValue}`
      );
    }
  }
  return mismatches;
}

// ============================================================================
// MAIN
// ============================================================================

/**
 * Run the full harness over `fixturesDir`. Returns the JSON digest.
 * Pure async — caller decides how to surface the digest + exit code.
 */
export async function runHarness({ fixturesDir, smoke = false } = {}) {
  // CANONICAL PHASE 5 RUN: --fixtures-dir omitted → aggregate the Phase 5
  // dir + the Phase 4 dual-SSE dir. Plan 05-06 truth #4: 5 EXISTING +
  // 7 NEW = 12 total.
  //
  // OVERRIDE PATH: --fixtures-dir <path> → load ONLY that directory. Used
  // by the smoke test for synthetic-breach replay; future Phase 7 prod-
  // shadow flows can also point at a captured-fixtures dir.
  let loaded;
  if (fixturesDir) {
    loaded = loadFixtures(fixturesDir);
    if (loaded.length === 0) {
      throw new Error(`no fixtures found in ${fixturesDir}`);
    }
  } else {
    const phase5 = loadFixtures(PHASE5_FIXTURES_DIR);
    const phase4 = loadFixtures(PHASE4_DUAL_SSE_DIR);
    loaded = [...phase4, ...phase5];
    if (loaded.length === 0) {
      throw new Error(
        `no fixtures found across phase4=${PHASE4_DUAL_SSE_DIR} or phase5=${PHASE5_FIXTURES_DIR}`,
      );
    }
  }

  // Plan 05-07 r1-#4 — schema-validate every Phase 5 fixture's ask_user
  // inputs against the production validateAskUser before any replay starts.
  // Throws on first invalid input; the CLI catch maps to exit code 2.
  validateFixtureInputs(loaded);

  const allObserved = [];
  const smokeMismatches = [];
  for (const { filename, fixture } of loaded) {
    const fx = applyDefaults({ ...fixture, filename });
    const observed = await replayFixture(fx);
    allObserved.push({ fx, observed });
    if (smoke) {
      smokeMismatches.push(...assertSmoke(fx, observed));
    }
  }

  // Plan 05-07 r1-#2 — aggregate over the FULL fixture set. Pre-fix
  // filtered to gate_fixture:true subset, which excluded the canonical
  // over-ask scenarios (sample-07 + sample-08) from breach detection.
  // Post-fix every loaded fixture contributes; the aggregate IS the gate.
  // The gate_fixture flag is kept on per-fixture digest entries as a
  // diagnostic but NO LONGER consulted by the metric path.
  const askCountsPerSession = allObserved.map((o) => o.observed.askCount);
  const totalActivations = allObserved.reduce((sum, o) => sum + o.observed.activationCount, 0);
  const restrainedRate = allObserved.length === 0 ? 0 : totalActivations / allObserved.length;
  const median = percentile(askCountsPerSession, 50);
  const p95 = percentile(askCountsPerSession, 95);
  const breaches = computeBreaches({ median, p95, restrainedRate });

  // Smoke-mode: any expected_* mismatch counts as a breach. Append a
  // sentinel so exit-code logic stays single-source.
  if (smoke && smokeMismatches.length > 0) {
    breaches.push('smoke_mismatch');
  }

  const exitCode = breaches.length > 0 ? 1 : 0;

  return {
    fixture_count: loaded.length,
    // Plan 05-07 r1-#2 — replaces gate_fixture_count. With the partition
    // gone, aggregate_fixture_count always equals fixture_count. Kept as
    // a separate field for forward-compat with downstream consumers that
    // may want to assert "aggregate covers every loaded fixture".
    aggregate_fixture_count: allObserved.length,
    smoke_mode: smoke,
    smoke_mismatches: smokeMismatches,
    ask_counts_per_session: askCountsPerSession,
    median,
    p95,
    restrained_activation_count: totalActivations,
    restrained_rate: restrainedRate,
    breaches,
    exit_code: exitCode,
    thresholds: EXIT_GATE_THRESHOLDS,
    // Per-fixture detail for debugging — kept terse so --json output is
    // still grep-able. gate_fixture is now ADVISORY (no longer consulted
    // by the metric path) but retained for fixture-author diagnostics
    // explaining the historical partition.
    sessions: allObserved.map((o) => ({
      id: o.fx.id ?? o.fx.filename,
      gate_fixture: o.observed.isGateFixture,
      askCount: o.observed.askCount,
      activationCount: o.observed.activationCount,
      filledSlotsShadowLogCount: o.observed.filledSlotsShadowLogCount,
      outcomeDistribution: o.observed.outcomeDistribution,
    })),
  };
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv) {
  // fixturesDir defaults to undefined — runHarness's "no override" branch
  // then aggregates Phase 4 + Phase 5 dirs. Passing --fixtures-dir <path>
  // pivots to single-dir mode (used by the smoke test for synthetic-breach).
  const out = { fixturesDir: undefined, smoke: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--smoke') {
      out.smoke = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--fixtures-dir' || a === '--dir') {
      out.fixturesDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--fixtures-dir=')) {
      out.fixturesDir = path.resolve(a.slice('--fixtures-dir='.length));
    }
  }
  return out;
}

function printProgressDigest(digest) {
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(4).replace(/0+$/, '0') : String(n));
  const lines = [
    `Plan 05-06 — exit-gate replay`,
    `  fixtures loaded:   ${digest.fixture_count}`,
    `  aggregate:         ${digest.aggregate_fixture_count} (full set, no gate_fixture partition)`,
    `  smoke mode:        ${digest.smoke_mode}`,
    `  median asks:       ${fmt(digest.median)}  (threshold ≤ ${digest.thresholds.medianMax})`,
    `  p95 asks:          ${fmt(digest.p95)}  (threshold ≤ ${digest.thresholds.p95Max})`,
    `  restrained_rate:   ${fmt(digest.restrained_rate)}  (threshold ≤ ${digest.thresholds.restrainedRateMax})`,
    `  breaches:          ${digest.breaches.length === 0 ? '(none)' : digest.breaches.join(', ')}`,
    `  exit code:         ${digest.exit_code}`,
  ];
  if (digest.smoke_mismatches?.length) {
    lines.push(`  smoke mismatches:`);
    for (const m of digest.smoke_mismatches) lines.push(`    - ${m}`);
  }
  console.log(lines.join('\n'));
}

const invokedAsScript = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  const args = parseArgs(process.argv.slice(2));
  runHarness({ fixturesDir: args.fixturesDir, smoke: args.smoke })
    .then((digest) => {
      if (args.json) {
        // Compact JSON ONLY on stdout — no progress lines. Test consumes via JSON.parse.
        console.log(JSON.stringify(digest));
      } else {
        printProgressDigest(digest);
      }
      process.exit(digest.exit_code);
    })
    .catch((err) => {
      console.error(`stage6-over-ask-exit-gate runtime error: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
