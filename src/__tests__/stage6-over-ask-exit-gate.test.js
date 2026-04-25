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
    expect(digest.thresholds).toEqual({
      medianMax: 1,
      p95Max: 4,
      restrainedRateMax: 0.02,
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
