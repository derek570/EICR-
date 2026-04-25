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
