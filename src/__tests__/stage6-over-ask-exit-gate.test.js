/**
 * Stage 6 Phase 5 Plan 05-06 — exit-gate harness smoke test.
 *
 * WHAT: Spawns scripts/stage6-over-ask-exit-gate.js as a child process
 * and asserts (a) the script exits 0 on the main 12-fixture pool, (b)
 * the script exits 1 on the synthetic-breach fixture pool, (c) the
 * --smoke flag asserts every fixture's expected_* fields, and (d) the
 * JSON digest's shape matches the contract documented in the plan's
 * <interfaces> block.
 *
 * WHY child_process not direct import: the script's exit code is the
 * primary signal a CI gate consumes. Asserting via spawnSync exercises
 * the same code path CI uses (the script's `process.exit(...)` call,
 * the unhandled-rejection trap, the catch block). Importing functions
 * directly would bypass the exit-code path and we'd miss regressions
 * where the script does the right thing internally but exits with the
 * wrong code.
 *
 * WHY a synthetic breach fixture in a SEPARATE directory: the production
 * exit-gate replays every *.json in the main fixtures dir. A synthetic
 * breach in the main dir would corrupt the gate forever. The separate
 * subdir + --fixtures-dir override is the cleanest isolation.
 *
 * Requirements: STB-05 (no guard weakened — exit gate is the integration
 * test for every Phase 5 guard) + ROADMAP §Phase 5 SC #8 (the gate
 * thresholds — locked here as a contract).
 */

import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'stage6-over-ask-exit-gate.js');
const MAIN_FIXTURES_DIR = path.join(
  REPO_ROOT,
  'src',
  '__tests__',
  'fixtures',
  'stage6-golden-sessions'
);
const SYNTHETIC_BREACH_DIR = path.join(
  REPO_ROOT,
  'src',
  '__tests__',
  'fixtures',
  'stage6-golden-sessions-synthetic-breach'
);

/**
 * Spawn the exit-gate script with the given args. Returns { status, stdout,
 * stderr, digest } — digest parsed from stdout when it appears to be JSON
 * (starts with `{`), else null. Always passes --json so the smoke test
 * doesn't need to parse progress lines.
 */
function runGate(extraArgs = []) {
  const result = spawnSync('node', [SCRIPT_PATH, '--json', ...extraArgs], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  let digest = null;
  if (typeof result.stdout === 'string') {
    // The script emits a single-line JSON digest on stdout in --json mode,
    // but the legacy filterQuestionsAgainstFilledSlots backstop (imported
    // transitively via the filled-slots-shadow logger) emits Winston log
    // lines on stdout too when it observes a refill-style ask. Parse only
    // the LAST line that starts with `{` — the digest is always written
    // last by the script's CLI block.
    const lines = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));
    const lastJsonLine = lines[lines.length - 1];
    if (lastJsonLine) {
      try {
        digest = JSON.parse(lastJsonLine);
      } catch {
        digest = null;
      }
    }
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, digest };
}

describe('Plan 05-06 — exit-gate harness smoke test', () => {
  // 30s budget per Plan 05-06 — depends on createRestrainedMode's nowFn
  // DI hook (added in Plan 05-04 per the 05-PLAN-CHECK gap-fix) so the
  // 60s wall-clock release does NOT need to actually wait.
  jest.setTimeout(30000);

  test('default mode on the main fixtures dir exits 0 (all thresholds pass)', () => {
    const { status, digest, stderr } = runGate();
    if (status !== 0) {
      // Surface the digest + stderr in the assertion message so a future
      // regression points the reader straight at the breach reason.
      throw new Error(
        `expected exit_code=0; got status=${status}\n` +
          `digest=${JSON.stringify(digest, null, 2)}\n` +
          `stderr=${stderr}`
      );
    }
    expect(status).toBe(0);
    expect(digest).not.toBeNull();
    expect(digest.exit_code).toBe(0);
    expect(digest.breaches).toEqual([]);
  });

  test('--smoke on the main fixtures dir asserts all expected_* fields and exits 0', () => {
    const { status, digest, stderr } = runGate(['--smoke']);
    if (status !== 0) {
      throw new Error(
        `expected exit_code=0 on --smoke; got status=${status}\n` +
          `digest=${JSON.stringify(digest, null, 2)}\n` +
          `stderr=${stderr}`
      );
    }
    expect(status).toBe(0);
    expect(digest).not.toBeNull();
    expect(digest.exit_code).toBe(0);
    // Smoke mode must process all 12 fixtures (5 existing + 7 new).
    expect(digest.fixture_count).toBe(12);
  });

  test('default mode on the synthetic-breach dir exits 1 with non-empty breaches', () => {
    const { status, digest } = runGate(['--fixtures-dir', SYNTHETIC_BREACH_DIR]);
    expect(status).toBe(1);
    expect(digest).not.toBeNull();
    expect(digest.exit_code).toBe(1);
    expect(Array.isArray(digest.breaches)).toBe(true);
    expect(digest.breaches.length).toBeGreaterThan(0);
  });

  test('digest JSON conforms to the documented contract', () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    expect(digest).not.toBeNull();
    // Required keys per Plan 05-06 <interfaces> block.
    const requiredKeys = [
      'fixture_count',
      'ask_counts_per_session',
      'median',
      'p95',
      'restrained_activation_count',
      'restrained_rate',
      'breaches',
      'exit_code',
      'thresholds',
    ];
    for (const key of requiredKeys) {
      expect(digest).toHaveProperty(key);
    }
    // ask_counts_per_session length must equal the GATE-aggregated fixture
    // count, NOT the total fixture_count (gate_fixture:false fixtures are
    // smoke-only and excluded from the aggregate). Sanity-check it's at
    // least 1 entry per gate fixture.
    expect(Array.isArray(digest.ask_counts_per_session)).toBe(true);
    expect(digest.ask_counts_per_session.length).toBeGreaterThan(0);
    // Thresholds must be the locked Object.freeze contract.
    // Plan 05-07 r1-#2 bumped restrainedRateMax 0.02 → 0.10 so the
    // 12-fixture aggregate (with sample-07's deliberate 1/12 ≈ 8.3%
    // activation canary) admits the canary. The 2% target stays scoped
    // to Phase 7 STR-03 prod-shadow gate.
    expect(digest.thresholds).toEqual({
      medianMax: 1,
      p95Max: 4,
      restrainedRateMax: 0.1,
    });
  });

  test('paths are resolvable — main fixtures dir exists', () => {
    // Defensive sanity check — if a future refactor moves the fixtures
    // directory, this test surfaces the rename loudly rather than via
    // an opaque "0 fixtures loaded" digest.
    const stat = fs.statSync(MAIN_FIXTURES_DIR);
    expect(stat.isDirectory()).toBe(true);
  });
});

// =============================================================================
// Plan 05-07 r1-#2 — aggregate over the FULL fixture set
// =============================================================================
// Pre-fix: runHarness filtered out gate_fixture:false fixtures (sample-07 +
// sample-08) before computing median / p95 / restrained_rate. The canonical
// over-ask fixtures (the deliberate restrained-mode trigger + the budget-
// exhaustion canary) could never breach the gate.
//
// Post-fix: every loaded fixture contributes to the aggregate. The
// restrainedRateMax threshold is bumped from 0.02 (Phase 7 prod-shadow
// target) to 0.10 (the smallest sensible ceiling that admits sample-07's
// deliberate 1/12 ≈ 8.3% activation while still rejecting a regression
// that adds a SECOND unintended activation).
//
// The synthetic-breach fixture (5 asks, restrained_rate=1/1=1.00) MUST
// still breach with the new threshold (1.00 > 0.10).
// =============================================================================

describe('Plan 05-07 r1-#2 — aggregate over the FULL fixture set', () => {
  jest.setTimeout(30000);

  test('aggregate fixture count equals total fixture count (no gate_fixture partition)', () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    // Pre-fix: gate_fixture_count=10, fixture_count=12 (10/12 partition).
    // Post-fix: every fixture contributes — they MUST be equal.
    expect(digest.fixture_count).toBe(12);
    expect(digest.aggregate_fixture_count).toBe(12);
    // ask_counts_per_session length must match aggregate_fixture_count.
    expect(digest.ask_counts_per_session).toHaveLength(12);
  });

  test('sample-07 deliberate restrained-mode activation appears in aggregate restrained_activation_count', () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    // Sample-07 fires restrained mode at its 3rd ask; sample-08 + every
    // other fixture has 0 activations. Aggregate must surface the
    // deliberate canary.
    expect(digest.restrained_activation_count).toBe(1);
    // 1 activation across 12 fixtures = 1/12 ≈ 0.0833.
    expect(digest.restrained_rate).toBeCloseTo(1 / 12, 5);
  });

  test('restrainedRateMax threshold bumped to 0.10 (admits 1/12 canary; still rejects 2/12 regression)', () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    expect(digest.thresholds.restrainedRateMax).toBe(0.1);
    // Sanity — the other two thresholds are unchanged.
    expect(digest.thresholds.medianMax).toBe(1);
    expect(digest.thresholds.p95Max).toBe(4);
  });

  test('exit_code === 0 on the main fixtures dir under the new full-set aggregation', () => {
    const { status, digest, stderr } = runGate();
    if (status !== 0) {
      throw new Error(
        `expected exit_code=0 under full-set aggregation; got status=${status}\n` +
          `digest=${JSON.stringify(digest, null, 2)}\n` +
          `stderr=${stderr}`
      );
    }
    expect(digest.exit_code).toBe(0);
    expect(digest.breaches).toEqual([]);
  });

  test('synthetic-breach fixture STILL breaches under the new aggregation + threshold', () => {
    // Regression lock — sample-99 has 5 asks of which 3 fire and 2 are
    // wrapper-short-circuited as restrained_mode, with 1 activation in
    // the single-fixture pool → restrained_rate = 1/1 = 1.00. Even with
    // restrainedRateMax bumped to 0.10, this still breaches loudly.
    const { status, digest } = runGate(['--fixtures-dir', SYNTHETIC_BREACH_DIR]);
    expect(status).toBe(1);
    expect(digest.exit_code).toBe(1);
    expect(digest.breaches.length).toBeGreaterThan(0);
    // restrained_rate breach is the canonical breach signature on this
    // fixture; assert it fires (the aggregate may also breach p95 or
    // median, which is fine — the regression lock is "still breaches",
    // not "breaches exactly the same way").
    expect(digest.breaches).toContain('restrained_rate');
  });
});

// =============================================================================
// Plan 05-07 r1-#1 — askCount counts every non-wrapper-short-circuited fire
// =============================================================================
// The current replayFixture at scripts/stage6-over-ask-exit-gate.js:391 counts
// only `body.answered === true`. Inner-dispatcher reasons like user_moved_on,
// timeout, transcript_already_extracted, session_stopped are real fires that
// the wrapper's isRealFire classifier already counts (the budget + restrained
// counters increment for them). The harness must mirror that classification.
//
// Sample-11 carries 1 inner_outcome:{answered:false, reason:'user_moved_on'}
// — a real fire by the wrapper's accounting. Pre-fix askCount = 0 (because
// answered !== true). Post-fix askCount = 1. Sample-08's wrapper-internal
// short-circuit (ask_budget_exhausted) is excluded because it IS a wrapper
// short-circuit reason.
//
// This test reads digest.sessions (which the harness already exposes per
// fixture) and asserts the per-fixture askCount matches the wrapper's
// real-fire semantics.
// =============================================================================

describe('Plan 05-07 r1-#1 — askCount counts every non-wrapper-short-circuited fire', () => {
  jest.setTimeout(30000);

  test('sample-11 (user_moved_on) askCount === 1 (was 0 pre-fix)', () => {
    const { status, digest, stderr } = runGate();
    if (status !== 0) {
      throw new Error(
        `expected exit_code=0; got status=${status}\n` +
          `digest=${JSON.stringify(digest, null, 2)}\n` +
          `stderr=${stderr}`
      );
    }
    const sample11 = digest.sessions.find((s) => /sample-11|golden-11/.test(s.id));
    if (!sample11) {
      throw new Error(
        `sample-11 not found in digest.sessions; available ids: ${digest.sessions.map((s) => s.id).join(', ')}`
      );
    }
    expect(sample11.askCount).toBe(1);
  });

  test('sample-12 (legitimate deep flow, answered=true) askCount === 1', () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    const sample12 = digest.sessions.find((s) => /sample-12|golden-12/.test(s.id));
    expect(sample12).toBeDefined();
    expect(sample12.askCount).toBe(1);
  });

  test("sample-08 (budget-exhaustion) askCount === 2 (the 3rd ask short-circuits as 'ask_budget_exhausted' and is excluded)", () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    const sample08 = digest.sessions.find((s) => /sample-08|golden-08/.test(s.id));
    expect(sample08).toBeDefined();
    // 3 ask_user_calls, 2 fire (turns 1+2), 3rd is wrapper-short-circuited.
    expect(sample08.askCount).toBe(2);
  });

  test("sample-07 (restrained-mode-trigger) askCount === 3 (the 4th ask short-circuits as 'restrained_mode' and is excluded)", () => {
    const { status, digest } = runGate();
    expect(status).toBe(0);
    const sample07 = digest.sessions.find((s) => /sample-07|golden-07/.test(s.id));
    expect(sample07).toBeDefined();
    // 4 ask_user_calls, 3 fire (turns 1-3), 4th is wrapper-short-circuited.
    expect(sample07.askCount).toBe(3);
  });
});

// =============================================================================
// Plan 05-07 r1-#4 — fixture-load-time schema validation
// =============================================================================
// The minimal mock inner dispatcher accepts any payload shape, so an invalid
// ask_user fixture would replay through the gate stack unchallenged. Real
// Plan 03-05 dispatch would have rejected every fixture call at the
// validateAskUser gate. This block writes a temp fixture with an invalid
// expected_answer_shape, points the harness at it via --fixtures-dir, and
// asserts the script exits with the runtime-error code (2) and that stderr
// carries the validator's failure code so the operator can find the offending
// fixture quickly.
//
// WHY a temp dir: the production fixture pool is now scrubbed clean (Plan
// 05-07 Task 1 r1-#5 GREEN); we cannot point the harness at any real fixture
// to demonstrate the failure mode. A temp dir built per-test guarantees
// isolation from the production pool and from other tests' temp dirs.
// =============================================================================

describe('Plan 05-07 r1-#4 — exit-gate harness validates fixture inputs at load time', () => {
  jest.setTimeout(30000);

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, 'tmp-plan-05-07-r1-4-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('invalid expected_answer_shape in fixture → exit code 2 with informative stderr', () => {
    // Author a single-fixture pool with a bad expected_answer_shape value.
    // Every other field is valid (real validateAskUser semantics — the
    // first-failure short-circuit hits expected_answer_shape last in the
    // input order).
    const badFixture = {
      _doc: 'Plan 05-07 r1-#4 RED — invalid expected_answer_shape',
      _fixture_shape: 'phase5-over-ask',
      session: { jobId: 'temp-r1-4-bad-shape', certificateType: 'EICR' },
      ask_user_calls: [
        {
          turnId: 'temp-r1-4-bad-shape-turn-1',
          synthetic_time_ms: 0,
          call: {
            id: 'toolu_temp_a',
            name: 'ask_user',
            input: {
              question: 'Q?',
              reason: 'ambiguous_circuit',
              context_field: 'none',
              context_circuit: null,
              expected_answer_shape: 'invalid_shape_value',
            },
          },
          inner_outcome: { answered: true, user_text: 'whatever' },
        },
      ],
      expected_ask_user_count: 1,
      expected_restrained_activations: 0,
      expected_outcome_distribution: {},
      expected_filled_slots_shadow_logs: 0,
      gate_fixture: true,
    };
    fs.writeFileSync(path.join(tmpDir, 'sample-bad.json'), JSON.stringify(badFixture, null, 2));

    const result = spawnSync('node', [SCRIPT_PATH, '--json', '--fixtures-dir', tmpDir], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });

    // Runtime-error exit code per the harness CLI's catch block (process.exit(2))
    // — the schema failure is thrown from within loadFixtures-or-validate, so
    // the catch block is the natural exit path.
    expect(result.status).toBe(2);
    // The stderr message must surface the validator's failure code so an
    // operator finding this in CI can grep for "invalid_expected_answer_shape"
    // without reading the harness internals.
    expect(result.stderr).toMatch(/invalid_expected_answer_shape/);
    // The stderr should also include the offending fixture's filename so the
    // operator finds the file in one click.
    expect(result.stderr).toMatch(/sample-bad\.json/);
  });

  test('valid fixture → schema check passes and harness runs as normal', () => {
    // Sanity check — a fixture with all-valid inputs should NOT trigger the
    // schema gate; the harness behaves as it would on the production pool.
    const goodFixture = {
      _doc: 'Plan 05-07 r1-#4 sanity — valid fixture survives the schema gate',
      _fixture_shape: 'phase5-over-ask',
      session: { jobId: 'temp-r1-4-good-shape', certificateType: 'EICR' },
      ask_user_calls: [
        {
          turnId: 'temp-r1-4-good-shape-turn-1',
          synthetic_time_ms: 0,
          call: {
            id: 'toolu_temp_b',
            name: 'ask_user',
            input: {
              question: 'Q?',
              reason: 'ambiguous_circuit',
              context_field: 'none',
              context_circuit: null,
              expected_answer_shape: 'free_text',
            },
          },
          inner_outcome: { answered: true, user_text: 'ok' },
        },
      ],
      expected_ask_user_count: 1,
      expected_restrained_activations: 0,
      expected_outcome_distribution: { answered: 1 },
      expected_filled_slots_shadow_logs: 0,
      gate_fixture: true,
    };
    fs.writeFileSync(path.join(tmpDir, 'sample-good.json'), JSON.stringify(goodFixture, null, 2));

    const result = spawnSync('node', [SCRIPT_PATH, '--json', '--fixtures-dir', tmpDir], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });

    // The harness runs to completion. exit_code is 0 if the lone fixture
    // passes the gate metrics, 1 if it breaches — either way it is NOT 2
    // (which would mean the runtime-error path tripped, which is the bug
    // we are guarding against).
    expect(result.status).not.toBe(2);
    expect(result.stderr).not.toMatch(/invalid_expected_answer_shape/);
  });
});

// =============================================================================
// Plan 05-08 r2-#1 — harness askCount excludes pre-emit non-fire reasons
// =============================================================================
// The wrapper's PRE_EMIT_NON_FIRE_REASONS set captures three reasons whose
// envelopes signal "the ask never reached iOS / never registered with
// pendingAsks": validation_error, duplicate_tool_call_id, prompt_leak_blocked.
// HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS in scripts/stage6-over-ask-exit-gate.js
// must include these via the same `import` so the offline aggregate matches
// the runtime budget/restrained-window accounting.
//
// This block authors a temp 1-fixture pool whose inner_outcome is each of the
// three pre-emit reasons in turn. Asserts the digest's askCount = 0 in every
// case (the wrapper does not synthesise its own envelope for these — it
// returns the inner dispatcher's verbatim envelope; the harness counts that
// envelope at the post-dispatch `firedAskCount` step). Pre-fix the harness's
// HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS only excluded the wrapper's own short-
// circuits; the dispatcher's pre-emit envelopes were counted as fires which
// is wrong.
// =============================================================================

describe('Plan 05-08 r2-#1 — harness askCount excludes pre-emit non-fire reasons', () => {
  jest.setTimeout(30000);

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, 'tmp-plan-05-08-r2-1-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function buildPreEmitFixture(reason) {
    return {
      _doc: `Plan 05-08 r2-#1 RED — single ask with inner_outcome reason="${reason}"`,
      _fixture_shape: 'phase5-over-ask',
      session: { jobId: `temp-r2-1-${reason}`, certificateType: 'EICR' },
      ask_user_calls: [
        {
          turnId: `temp-r2-1-${reason}-turn-1`,
          synthetic_time_ms: 0,
          call: {
            id: 'toolu_temp_pre_emit',
            name: 'ask_user',
            input: {
              question: 'Q?',
              reason: 'ambiguous_circuit',
              context_field: 'none',
              context_circuit: null,
              expected_answer_shape: 'free_text',
            },
          },
          inner_outcome: { answered: false, reason },
        },
      ],
      expected_ask_user_count: 0,
      expected_restrained_activations: 0,
      expected_outcome_distribution: {},
      expected_filled_slots_shadow_logs: 0,
      gate_fixture: false,
    };
  }

  // Plan 05-09 r3-#1 — shadow_mode added as the FOURTH pre-emit non-fire.
  // The harness inherits this automatically via the
  // `...PRE_EMIT_NON_FIRE_REASONS` spread on
  // HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS (line 193 of the harness),
  // so this parametrised test goes GREEN as soon as the wrapper's set
  // adds 'shadow_mode'. Single source of truth — runtime budget AND
  // offline askCount share the classifier via the imported constant.
  test.each([
    ['validation_error'],
    ['duplicate_tool_call_id'],
    ['prompt_leak_blocked'],
    ['shadow_mode'],
  ])('%s — askCount === 0 (envelope is a pre-emit non-fire)', (reason) => {
    fs.writeFileSync(
      path.join(tmpDir, `sample-pre-emit-${reason}.json`),
      JSON.stringify(buildPreEmitFixture(reason), null, 2)
    );

    const result = spawnSync('node', [SCRIPT_PATH, '--json', '--fixtures-dir', tmpDir], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });

    let digest = null;
    if (typeof result.stdout === 'string') {
      const lines = result.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'));
      const lastJsonLine = lines[lines.length - 1];
      if (lastJsonLine) {
        try {
          digest = JSON.parse(lastJsonLine);
        } catch {
          digest = null;
        }
      }
    }

    if (!digest) {
      throw new Error(
        `failed to parse digest; status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
      );
    }

    const session = digest.sessions[0];
    expect(session).toBeDefined();
    expect(session.askCount).toBe(0);
  });
});

// =============================================================================
// Plan 05-11 r5-#3 — exit harness's debounce coverage gap.
// =============================================================================
// Codex r5 surfaced that scripts/stage6-over-ask-exit-gate.js uses
// `delayMs: 0` to bypass the production 1500ms QUESTION_GATE_DELAY_MS
// debounce window. STB-01 (the question-gate) is the gate Phase 5 is
// supposed to wire end-to-end, but the closure check never exercises
// it under production timing — duplicate same-key asks are eliminated
// by speed-of-the-loop ordering, not by the production debounce
// behaviour.
//
// The CLI script must keep `delayMs: 0` for runtime budget reasons
// (12 fixtures × ~3 calls × 1500ms = 54s minimum even before any
// other gate work — busts the 30s test budget). Instead, this
// in-test gate exercises the real 1500ms debounce via jest's
// fake-timer pattern (the standard `doNotFake: ['Promise',
// 'queueMicrotask', 'nextTick']` pattern that every other wrapper-
// touching test in the suite uses).
//
// The CLI digest measures aggregate threshold compliance; this
// in-test gate measures gate composition correctness under
// production timing. Together they cover the STB-01 contract end-
// to-end.
//
// Test scenarios:
//   1. Same-key calls within 1500ms — first resolves with reason
//      'gated', second fires after a fresh 1500ms.
//   2. Different-key calls each get their own 1500ms timer; both
//      fire after their respective windows.
//   3. Non-overlapping same-key calls (advance >1500ms between)
//      both fire independently — debounce window only catches
//      OVERLAPPING duplicates.
// =============================================================================

describe('Plan 05-11 r5-#3 — production 1500ms debounce coverage (fake timers)', () => {
  // Imports run at module load time; these are top-of-file imports
  // exposed via the harness's wrapper helpers. The real wrapper
  // module exports `createAskGateWrapper` + `wrapAskDispatcherWithGates`
  // and the question-gate exports `QUESTION_GATE_DELAY_MS`.
  // We exercise the wrapper directly here (not via spawn) because
  // jest fake timers cannot reach a child process.

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['Promise', 'queueMicrotask', 'nextTick'] });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function makeNoopLogger() {
    return {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  }

  function makeMockBudget() {
    return {
      isExhausted: jest.fn(() => false),
      increment: jest.fn(),
      getCount: jest.fn(() => 0),
    };
  }

  function makeMockRestrained() {
    return {
      isActive: jest.fn(() => false),
      recordAsk: jest.fn(),
      destroy: jest.fn(),
    };
  }

  function makeMockInner(outcome = { answered: true, user_text: 'ok' }) {
    return jest.fn(async (call /* , ctx */) => ({
      tool_use_id: call.id,
      content: JSON.stringify(outcome),
      is_error: false,
    }));
  }

  function makeAskCall(id, field, circuit) {
    return {
      id,
      name: 'ask_user',
      input: {
        question: 'Q?',
        reason: 'ambiguous_circuit',
        context_field: field,
        context_circuit: circuit,
        expected_answer_shape: 'free_text',
      },
    };
  }

  test('same-key calls within 1500ms: first resolves "gated"; second fires after fresh 1500ms', async () => {
    // Lazy-import to avoid pulling the wrapper module into the spawn-
    // based suites above (which run in a child process).
    const { createAskGateWrapper, wrapAskDispatcherWithGates } =
      await import('../extraction/stage6-ask-gate-wrapper.js');
    const { QUESTION_GATE_DELAY_MS } = await import('../extraction/question-gate.js');

    // Sanity-check we are running with the production 1500ms value
    // so this regression-lock asserts the contract (a refactor that
    // changed QUESTION_GATE_DELAY_MS to 0 or removed the import would
    // trip this).
    expect(QUESTION_GATE_DELAY_MS).toBe(1500);

    const logger = makeNoopLogger();
    // No `delayMs` opt — defaults to QUESTION_GATE_DELAY_MS (the
    // production value). This is the load-bearing claim of r5-#3:
    // exercise the gate at production timing.
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-r5-3' });
    const inner = makeMockInner();
    const askBudget = makeMockBudget();
    const restrainedMode = makeMockRestrained();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-r5-3',
    });

    const ctx = { sessionId: 'sess-r5-3', turnId: 'sess-r5-3-turn-1' };
    const call1 = makeAskCall('call-1', 'measured_zs_ohm', 7);
    const call2 = makeAskCall('call-2', 'measured_zs_ohm', 7); // same key

    const p1 = wrapped(call1, ctx);
    // Advance partway through the 1500ms window. Sub-1500ms tick
    // means the inner dispatcher hasn't fired yet.
    jest.advanceTimersByTime(800);
    const p2 = wrapped(call2, ctx);

    // First call's outer Promise resolves immediately with the
    // gated synthResult — the second call replaced it.
    const r1 = await p1;
    expect(JSON.parse(r1.content).reason).toBe('gated');
    expect(JSON.parse(r1.content).answered).toBe(false);

    // Inner has NOT been called yet; the 1500ms timer reset on
    // call 2's arrival.
    expect(inner).not.toHaveBeenCalled();

    // Advance through the FRESH 1500ms window for call 2.
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call2, ctx);
    expect(JSON.parse(r2.content).answered).toBe(true);

    gate.destroy();
  });

  test('different-key calls each get their own 1500ms timer; both fire', async () => {
    const { createAskGateWrapper, wrapAskDispatcherWithGates } =
      await import('../extraction/stage6-ask-gate-wrapper.js');
    const { QUESTION_GATE_DELAY_MS } = await import('../extraction/question-gate.js');

    const logger = makeNoopLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-r5-3-multi' });
    const inner = makeMockInner();
    const askBudget = makeMockBudget();
    const restrainedMode = makeMockRestrained();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-r5-3-multi',
    });

    const ctx = { sessionId: 'sess-r5-3-multi', turnId: 'sess-r5-3-multi-turn-1' };
    const call1 = makeAskCall('call-a', 'measured_zs_ohm', 4); // key 'measured_zs_ohm:4'
    const call2 = makeAskCall('call-b', 'measured_r1_plus_r2', 4); // key 'measured_r1_plus_r2:4' — distinct
    const call3 = makeAskCall('call-c', 'measured_zs_ohm', 9); // key 'measured_zs_ohm:9' — distinct

    const p1 = wrapped(call1, ctx);
    const p2 = wrapped(call2, ctx);
    const p3 = wrapped(call3, ctx);

    // Same 1500ms tick advances all three timers.
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(JSON.parse(r1.content).answered).toBe(true);
    expect(JSON.parse(r2.content).answered).toBe(true);
    expect(JSON.parse(r3.content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(3);

    gate.destroy();
  });

  test('non-overlapping same-key calls (gap > 1500ms) BOTH fire independently', async () => {
    // The debounce window only catches OVERLAPPING duplicates. After
    // the first call's timer fires (1500ms), the bucket is empty and
    // a fresh same-key call gets its own clean window.
    const { createAskGateWrapper, wrapAskDispatcherWithGates } =
      await import('../extraction/stage6-ask-gate-wrapper.js');
    const { QUESTION_GATE_DELAY_MS } = await import('../extraction/question-gate.js');

    const logger = makeNoopLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-r5-3-gap' });
    const inner = makeMockInner();
    const askBudget = makeMockBudget();
    const restrainedMode = makeMockRestrained();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-r5-3-gap',
    });

    const ctx = { sessionId: 'sess-r5-3-gap', turnId: 'sess-r5-3-gap-turn-1' };
    const call1 = makeAskCall('call-1', 'measured_zs_ohm', 3);
    const call2 = makeAskCall('call-2', 'measured_zs_ohm', 3); // same key

    const p1 = wrapped(call1, ctx);
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r1 = await p1;
    expect(JSON.parse(r1.content).answered).toBe(true);

    // Now the bucket is empty. A fresh same-key call gets a clean
    // 1500ms window and fires after it.
    const p2 = wrapped(call2, ctx);
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;
    expect(JSON.parse(r2.content).answered).toBe(true);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[0][0].id).toBe('call-1');
    expect(inner.mock.calls[1][0].id).toBe('call-2');

    gate.destroy();
  });
});

// =============================================================================
// Plan 05-13 r7-#2 — harness predicate composition for split dispatcher_error.
// REMOVED at Plan 05-14 r8-#3 — superseded by the real-harness regression
// lock added below.
// =============================================================================
// The r7-#2 tests called a local-helper that reproduced the harness's
// `isHarnessWrapperShortCircuitReason` composition shape. They never
// spawned the real harness or replayed a fixture — a regression that
// snapshotted the wrapper's classification at the harness side would
// still pass because the local helper continues to call the live
// predicates. r8-#3 closure replaces the inert tests with a real-
// harness fixture-replay assertion (using the subprocess pattern from
// Plan 05-08 r2-#1), which exercises the full `replayFixture` →
// `outcomesById` → `wrappedDispatcher` → envelope classification →
// `firedAskCount` → digest emission pipeline.
//
// The r7-#2 split-name coverage (`dispatcher_error_pre_emit` /
// `_post_emit`) is also moot post-r8-#2 — the closed-enum split was
// reverted, so those names no longer exist. The r8-#3 lock asserts
// the surviving wire-schema name `'dispatcher_error'` is correctly
// classified by the real harness as non-fire (askCount === 0).
// =============================================================================
