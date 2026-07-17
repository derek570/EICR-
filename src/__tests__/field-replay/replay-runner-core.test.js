/**
 * replay-runner-core.test.js — the fixture driver + corpus orchestrator
 * through the REAL runShadowHarness (plan Item 2). Pins:
 *   - a GREEN reading fixture end-to-end (write + exactly-once audible
 *     confirmation claimed by its declared output);
 *   - the marker-①-shaped expected_red (chime-producing garbled turn with
 *     zero audible output) yielding EXACTLY its declared failure id —
 *     and XPASS/proof-state semantics;
 *   - strict round consumption (over- and under-consumption latch as
 *     infrastructure, which can never satisfy expected_red);
 *   - unclaimed audible outputs failing;
 *   - the corpus orchestrator: empty corpus PASS, unsupported_pending
 *     reported-not-executed, validation failures surfacing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFixture, runCorpus } from '../../../scripts/field-replay/lib/replay-runner-core.mjs';
import { evaluateGateState } from '../../../scripts/field-replay/lib/replay-assertions.mjs';

import { EICRExtractionSession } from '../../extraction/eicr-extraction-session.js';
import { activeSessions } from '../../extraction/active-sessions.js';
import { createPendingAsksRegistry } from '../../extraction/stage6-pending-asks-registry.js';
import { createAskBudget } from '../../extraction/stage6-ask-budget.js';
import {
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
} from '../../extraction/voice-latency-config.js';
import { createFilledSlotsShadowLogger } from '../../extraction/stage6-filled-slots-shadow.js';
import { runShadowHarness } from '../../extraction/stage6-shadow-harness.js';

const modules = {
  EICRExtractionSession,
  activeSessions,
  createPendingAsksRegistry,
  createAskBudget,
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
  createFilledSlotsShadowLogger,
  runShadowHarness,
};

const CID_GREEN = 'frc_00000000000000000000000000000001';
const CID_RED = 'frc_00000000000000000000000000000002';

function greenFixture() {
  return {
    schema_version: 1,
    corpus_id: CID_GREEN,
    purpose: 'triage',
    gate_state: 'required_green',
    owner: 'Derek Beckley',
    initial_state_fidelity: 'hand_authored',
    job_state: {
      certificateType: 'eicr',
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [{ number: 2 }],
    },
    client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
    fallback_to_legacy: { value: false, provenance: 'recorded_full' },
    turns: [
      {
        turn_index: 1,
        at_ms: 0,
        transcript: 'zed s nought point three five circuit two',
        regex_results: [],
        confirmations_enabled: { value: true, provenance: 'recorded_full' },
        in_response_to: { value: false, provenance: 'recorded_full' },
        ws_mode: 'open',
        chime_observed: true,
        model_rounds: [
          {
            stop_reason: 'tool_use',
            tool_calls: [
              {
                id: 'sym_tc_zs',
                name: 'record_reading',
                // Schema-faithful: record_reading REQUIRES source_turn_id (the
                // real model always emits it) — matchToolExpectations validates
                // the declared schema_expectation against the REAL tool schema.
                input: {
                  field: 'measured_zs_ohm',
                  circuit: 2,
                  value: '0.35',
                  confidence: 0.9,
                  source_turn_id: 'sym_turn_1',
                },
                schema_expectation: 'accept',
                dispatcher_expectation: 'accept',
              },
            ],
          },
          { stop_reason: 'end_turn', text: '' },
        ],
        expected_operations: [
          {
            operation_id: 'op_zs',
            kind: 'reading',
            tool: 'record_reading',
            field: 'measured_zs_ohm',
            circuit: 2,
            value: '0.35',
            audibility: 'exactly_once',
          },
        ],
        expected_audible_outputs: [
          {
            output_id: 'out_zs',
            kind: 'reading_confirmation',
            operation_ref: 'op_zs',
            count: 1,
            match: { field: 'measured_zs_ohm', circuit: 2 },
          },
        ],
      },
    ],
  };
}

function redFixture() {
  // A chime-producing ANSWER turn (in_response_to:true) where the model emits
  // NOTHING (end_turn only): the ask-resolution path was supposed to speak the
  // resolved answer and didn't, so the turn ends silent and the generic
  // audibility.turn assertion is the ONE expected failure.
  //
  // NB — this used to be a NON-answer no-op (the raw marker-① shape). The
  // marker-① no-op audibility net (stage6-shadow-harness.js, shipped 2026-07-17)
  // now HEALS that shape (emits a spoken apology → audible → no RED), so it can
  // no longer serve as a controlled RED. The net is deliberately gated on
  // `!isAnswerTurn` (answer turns are owned by the ask-resolution path), so a
  // chimed answer-turn no-op is STILL a real beep-then-silence and remains a
  // stable audibility.turn RED — a more faithful vehicle for the machinery
  // tests below. The frc_c55c996… on-disk keystone owns the real-capture,
  // now-required_green version of the original shape.
  return {
    schema_version: 1,
    corpus_id: CID_RED,
    purpose: 'regression',
    gate_state: 'expected_red',
    expected_failure_id: 'audibility.turn',
    red_proof_failure_id: 'audibility.turn',
    owner: 'Derek Beckley',
    introduced_at: '2026-01-10T00:00:00Z',
    fix_reference: 'fix_00000000000000000000000000000001',
    expires_at: '2099-01-01T00:00:00.000Z',
    initial_state_fidelity: 'hand_authored',
    job_state: {
      certificateType: 'eicr',
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [{ number: 2 }],
    },
    client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
    fallback_to_legacy: { value: false, provenance: 'recorded_full' },
    is_keystone: true,
    turns: [
      {
        turn_index: 1,
        at_ms: 0,
        transcript: 'the garbled thing by the whatsit needs doing over',
        regex_results: [],
        confirmations_enabled: { value: true, provenance: 'reconstructed_reviewed' },
        // Answer turn — the marker-① no-op net skips these (the ask-resolution
        // path owns answer turns), so this chimed no-op stays silent → RED.
        in_response_to: { value: true, provenance: 'reconstructed_reviewed' },
        ws_mode: 'open',
        chime_observed: true,
        model_rounds: [{ stop_reason: 'end_turn', text: '' }],
      },
    ],
  };
}

afterEach(() => {
  for (const [id] of activeSessions) {
    if (String(id).startsWith('frsess_')) activeSessions.delete(id);
  }
});

describe('runFixture through the REAL harness (no fake clock — fixtures avoid gated asks)', () => {
  test('GREEN reading fixture: write lands, exactly-once confirmation claimed, zero failures', async () => {
    const run = await runFixture({ fixture: greenFixture(), modules, wallClockNowMs: Date.now() });
    expect(run.allFailures).toEqual([]);
    const gate = evaluateGateState(greenFixture(), run.allFailures);
    expect(gate.verdict).toBe('pass');
  });

  test('marker-①-shaped expected_red: baseline yields EXACTLY the declared failure id', async () => {
    const fixture = redFixture();
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    const ids = [...new Set(run.allFailures.map((f) => f.id))];
    expect(ids).toEqual(['audibility.turn']);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('pass'); // RED confirmed
    // Proof mode (GREEN evidence at subject F) bypasses ONLY the XPASS
    // inversion — a still-failing assertion FAILS the proof run.
    expect(
      evaluateGateState(fixture, run.allFailures, { proofState: 'required_green' }).verdict
    ).toBe('fail');
  });

  test('XPASS fails the gate: an expected_red whose assertion passes cannot merge', async () => {
    const fixture = redFixture();
    // Same fixture but the model DOES speak (a confirmation-producing write).
    fixture.turns = greenFixture().turns;
    fixture.expected_failure_id = 'audibility.turn';
    fixture.red_proof_failure_id = 'audibility.turn';
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('xpass');
    // The evidence proof mode ACCEPTS the same run (the fixing PR's GREEN).
    expect(
      evaluateGateState(fixture, run.allFailures, { proofState: 'required_green' }).verdict
    ).toBe('pass');
  });

  test('an expired expected_red fails the gate (deliberate pipeline freeze)', async () => {
    const fixture = redFixture();
    fixture.expires_at = '2026-01-01T00:00:00.000Z';
    const run = await runFixture({
      fixture,
      modules,
      wallClockNowMs: Date.parse('2026-02-01T00:00:00Z'),
    });
    expect(run.verdict).toBe('fail');
    expect(run.detail).toMatch(/EXPIRED/);
  });

  test('under-consumption latches as infrastructure — which can NEVER satisfy expected_red', async () => {
    const fixture = redFixture();
    fixture.turns[0].model_rounds.push({ stop_reason: 'end_turn', text: 'never requested' });
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    expect(run.allFailures.some((f) => f.outcome === 'infrastructure_error')).toBe(true);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('infrastructure_error');
  });

  test('an unclaimed audible output fails a green fixture (exactly-once accounting)', async () => {
    const fixture = greenFixture();
    fixture.turns[0].expected_audible_outputs = []; // nothing declared → the real confirmation is unclaimed
    fixture.turns[0].chime_observed = false; // isolate the unclaimed check from audibility.turn
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    expect(run.allFailures.some((f) => f.id === 'audibility.unclaimed')).toBe(true);
  });
});

describe('runCorpus orchestration', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-corpus-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const loadFixture = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

  test('EMPTY corpus is a PASS with the explicit 0-fixtures summary (exit 0)', async () => {
    const summary = await runCorpus({
      corpusRoot: path.join(tmp, 'missing'),
      modules,
      loadFixture,
    });
    expect(summary.exitCode).toBe(0);
    expect(summary.discovered).toBe(0);
    expect(summary.message).toMatch(/0 fixtures discovered/);
  });

  test('a mixed corpus: green executes+passes, unsupported_pending is REPORTED not executed, red passes as expected_red', async () => {
    const g = path.join(tmp, CID_GREEN);
    const r = path.join(tmp, CID_RED);
    const u = path.join(tmp, 'frc_00000000000000000000000000000003');
    for (const d of [g, r, u]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(g, 'fixture.yaml'), JSON.stringify(greenFixture()));
    fs.writeFileSync(path.join(r, 'fixture.yaml'), JSON.stringify(redFixture()));
    fs.writeFileSync(
      path.join(u, 'fixture.yaml'),
      JSON.stringify({
        schema_version: 1,
        corpus_id: 'frc_00000000000000000000000000000003',
        purpose: 'regression',
        gate_state: 'unsupported_pending',
        owner: 'Derek Beckley',
        capability_exclusion: 'loaded_barrel',
        named_followup: 'field-replay-hardening-followups',
        sanitized_transcript: ['synthetic'],
        human_expectations: 'read back once when Loaded Barrel replay exists',
      })
    );
    const summary = await runCorpus({
      corpusRoot: tmp,
      modules,
      loadFixture,
      wallClockNowMs: Date.now(),
    });
    expect(summary.discovered).toBe(3);
    expect(summary.executed).toBe(2);
    expect(summary.unsupported).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.exitCode).toBe(0);
  });

  test('a validation-failing fixture fails the corpus', async () => {
    const d = path.join(tmp, 'frc_00000000000000000000000000000004');
    fs.mkdirSync(d, { recursive: true });
    const bad = greenFixture();
    bad.corpus_id = 'frc_00000000000000000000000000000004';
    bad.turns[0].regex_results = [{ field: 'install.postcode', value: 'ZZ99 9ZZ' }]; // v1 prohibition
    fs.writeFileSync(path.join(d, 'fixture.yaml'), JSON.stringify(bad));
    const summary = await runCorpus({
      corpusRoot: tmp,
      modules,
      loadFixture,
      wallClockNowMs: Date.now(),
    });
    expect(summary.failed).toBe(1);
    expect(summary.exitCode).toBe(1);
    expect(summary.results[0].detail).toMatch(/postcode_hint_forbidden/);
  });
});
