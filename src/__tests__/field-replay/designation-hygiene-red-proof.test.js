/**
 * designation-hygiene-red-proof.test.js — PLAN-B (ids 128+131, 2026-08-23):
 * the PRE-FIX RED proof for the committed corpus fixture frc_6600a62a…,
 * simulated IN-PROCESS.
 *
 * The fixture is registered `required_green` (fix-lands-first contingency:
 * PLAN-B's B1 canonicalisation ships in the SAME branch, so an on-disk
 * expected_red would fail the merge-blocking gate — exactly what the corpus
 * state machine's dual-proof required_green admission exists for). Its
 * `red_proof_failure_id` documents what fails on pre-fix code; this suite
 * EXECUTES that claim without touching the working tree: the designation
 * canonicaliser module is mocked to its pre-PLAN-B semantics (identity strip,
 * nothing canonicalises to empty, repair is a no-op) via
 * `jest.unstable_mockModule`, the REAL dispatcher graph is then dynamically
 * imported on top of the mock, and the committed fixture is replayed through
 * the REAL harness. Assertion: the run fails with EXACTLY
 * `designation_hygiene.op_desig_cc` — one id, FAIL outcome (never
 * infrastructure) — the corpus's exact-expected_failure_id contract that the
 * atomic joint oracle exists to satisfy (a naive per-concern decomposition
 * produced a multi-id baseline here).
 *
 * This file's module graph REQUIRES unstable_mockModule + all-dynamic
 * imports, which cannot coexist with the sibling suite's static imports —
 * same split as voice-latency-fast-tts-impedance-clamp.test.js.
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// PRE-FIX semantics: no strip, nothing banned-only, persistence repair no-op.
jest.unstable_mockModule('../../extraction/designation-canonicaliser.js', () => ({
  canonicaliseCircuitDesignation: (d) => d,
  designationCanonicalisesToEmpty: () => false,
  repairCircuitDesignation: (d) => d,
}));

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/field-replay-corpus/frc_6600a62a7807c94766e10288526f733d/fixture.yaml'
);

test('pre-fix tree REDs with EXACTLY red_proof_failure_id designation_hygiene.op_desig_cc', async () => {
  const { runFixture } = await import('../../../scripts/field-replay/lib/replay-runner-core.mjs');
  const { evaluateGateState, OUTCOME } =
    await import('../../../scripts/field-replay/lib/replay-assertions.mjs');
  const [
    { EICRExtractionSession },
    { activeSessions },
    { createPendingAsksRegistry },
    { createAskBudget },
    vlc,
    { createFilledSlotsShadowLogger },
    { runShadowHarness },
    { getCircuitBucket },
  ] = await Promise.all([
    import('../../extraction/eicr-extraction-session.js'),
    import('../../extraction/active-sessions.js'),
    import('../../extraction/stage6-pending-asks-registry.js'),
    import('../../extraction/stage6-ask-budget.js'),
    import('../../extraction/voice-latency-config.js'),
    import('../../extraction/stage6-filled-slots-shadow.js'),
    import('../../extraction/stage6-shadow-harness.js'),
    import('../../extraction/stage6-multi-board-shape.js'),
  ]);
  const modules = {
    EICRExtractionSession,
    activeSessions,
    createPendingAsksRegistry,
    createAskBudget,
    snapshotFlagsForSession: vlc.snapshotFlagsForSession,
    parseVoiceLatencyCapabilities: vlc.parseVoiceLatencyCapabilities,
    createFilledSlotsShadowLogger,
    runShadowHarness,
    readCircuitDesignation: (session, circuitRef, boardId) => {
      const bucket = getCircuitBucket(session?.stateSnapshot, Number(circuitRef), boardId ?? null);
      const v = bucket?.circuit_designation ?? bucket?.designation ?? null;
      return typeof v === 'string' ? v : null;
    },
  };

  const fixture = yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });

  // EXACTLY the documented red_proof id — one distinct id, clean FAILs (an
  // infrastructure outcome could never RED-prove anything).
  const ids = [...new Set(run.allFailures.map((f) => f.id))];
  expect(ids).toEqual([fixture.red_proof_failure_id]);
  expect(fixture.red_proof_failure_id).toBe('designation_hygiene.op_desig_cc');
  expect(run.allFailures.every((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
  // The joint message names the dirty write's every symptom.
  const msg = run.allFailures[0].message;
  expect(msg).toMatch(/Upstairs lighting circuit/);
  expect(msg).toMatch(/stored designation/);
  expect(msg).toMatch(/confirmation text/);

  // As registered (required_green) this pre-fix run FAILS the gate…
  expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('fail');
  // …and had it been registered expected_red, the same run would have been
  // the RED confirmation — the dual-proof pair the state machine demands.
  const asRed = {
    ...fixture,
    gate_state: 'expected_red',
    expected_failure_id: fixture.red_proof_failure_id,
  };
  expect(evaluateGateState(asRed, run.allFailures).verdict).toBe('pass');

  for (const [id] of activeSessions) {
    if (String(id).startsWith('frsess_')) activeSessions.delete(id);
  }
});
