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
const IR_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/field-replay-corpus/frc_db9ad2a81993be17a38cc196c7ac8ec5/fixture.yaml'
);

/** Build the full modules set over the MOCKED canonicaliser graph (all
 *  dynamic imports resolve after the unstable_mockModule registration). */
async function buildModules() {
  // SEQUENTIAL imports, deliberately NOT Promise.all: under
  // unstable_mockModule, concurrently linking overlapping ESM graphs races
  // jest's linker ("request for './value-normalise.js' can not be resolved
  // on module ... that is not linked") — the race surfaced when a second
  // consumer of the mocked canonicaliser (circuit-resolution.js) joined the
  // shared graph. One await per graph links each module tree fully before
  // the next import starts; behaviour and assertions are unchanged.
  const { EICRExtractionSession } = await import('../../extraction/eicr-extraction-session.js');
  const { activeSessions } = await import('../../extraction/active-sessions.js');
  const { createPendingAsksRegistry } =
    await import('../../extraction/stage6-pending-asks-registry.js');
  const vlc = await import('../../extraction/voice-latency-config.js');
  const { createFilledSlotsShadowLogger } =
    await import('../../extraction/stage6-filled-slots-shadow.js');
  const { runShadowHarness } = await import('../../extraction/stage6-shadow-harness.js');
  const { getCircuitBucket } = await import('../../extraction/stage6-multi-board-shape.js');
  const { processInsulationResistanceTurn } =
    await import('../../extraction/dialogue-engine/index.js');
  const { FIELD_CORRECTIONS } = await import('../../extraction/field-name-corrections.js');
  return {
    activeSessions,
    modules: {
      EICRExtractionSession,
      activeSessions,
      createPendingAsksRegistry,
      snapshotFlagsForSession: vlc.snapshotFlagsForSession,
      parseVoiceLatencyCapabilities: vlc.parseVoiceLatencyCapabilities,
      createFilledSlotsShadowLogger,
      runShadowHarness,
      readCircuitDesignation: (session, circuitRef, boardId) => {
        const bucket = getCircuitBucket(
          session?.stateSnapshot,
          Number(circuitRef),
          boardId ?? null
        );
        const v = bucket?.circuit_designation ?? bucket?.designation ?? null;
        return typeof v === 'string' ? v : null;
      },
      readCircuitField: (session, circuitRef, boardId, field) => {
        const bucket = getCircuitBucket(
          session?.stateSnapshot,
          Number(circuitRef),
          boardId ?? null
        );
        const v = bucket?.[field];
        return v == null ? null : String(v);
      },
      toReadingWireField: (raw) => FIELD_CORRECTIONS[raw] ?? raw,
      dialogueScriptIngress: { insulation_resistance: processInsulationResistanceTurn },
    },
  };
}

test('pre-fix tree REDs with EXACTLY red_proof_failure_id designation_hygiene.op_desig_cc', async () => {
  const { runFixture } = await import('../../../scripts/field-replay/lib/replay-runner-core.mjs');
  const { evaluateGateState, OUTCOME } =
    await import('../../../scripts/field-replay/lib/replay-assertions.mjs');
  const { modules, activeSessions } = await buildModules();

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

test('pre-fix tree REDs the id-131 ingress fixture with EXACTLY script_entry_resolution.op_ir_entry', async () => {
  // The identity-mock reverts the shared canonicaliser, which is what B3's
  // matcher tolerance is built on — findCircuitsByDesignation's canonical
  // pass collapses to the raw pre-fix comparison, so the seeded dirty
  // "Upstairs lighting circuit" defeats entry matching exactly as in the
  // field: circuit_ref null, LIM queued not written, and the which-circuit
  // ask fires. Every leg of the joint oracle fails under the ONE id — the
  // executed RED half of the dual-proof required_green registration, run
  // through the REAL processInsulationResistanceTurn via the ingress lane.
  const { runFixture } = await import('../../../scripts/field-replay/lib/replay-runner-core.mjs');
  const { evaluateGateState, OUTCOME } =
    await import('../../../scripts/field-replay/lib/replay-assertions.mjs');
  const { modules, activeSessions } = await buildModules();

  const fixture = yaml.load(fs.readFileSync(IR_FIXTURE_PATH, 'utf8'));
  const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });

  const ids = [...new Set(run.allFailures.map((f) => f.id))];
  expect(ids).toEqual([fixture.red_proof_failure_id]);
  expect(fixture.red_proof_failure_id).toBe('script_entry_resolution.op_ir_entry');
  expect(run.allFailures.every((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
  // The joint message names the defect's every symptom: unresolved entry,
  // unwritten value, missing wire emission, and the which-circuit ask.
  const msg = run.allFailures.map((f) => f.message).join('; ');
  expect(msg).toMatch(/entry resolved circuit_ref|entry_designation_matched/);
  expect(msg).toMatch(/stored ir_live_live_mohm/);
  expect(msg).toMatch(/wire extraction/);
  expect(msg).toMatch(/which-circuit ask/);

  expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('fail');
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
