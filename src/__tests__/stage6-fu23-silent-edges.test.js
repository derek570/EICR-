/**
 * F/U-2 + F/U-3 (marker-② follow-ups, 2026-07-19) — specific voice notices
 * for two successful-but-writeless dispatcher outcomes that previously fell
 * to the marker-② GENERIC apology:
 *
 *   F/U-2: `rename_circuit` with from_ref === circuit_ref and no meta is an
 *   idempotent noop — no circuitOp, no state-change TTS. The inspector who
 *   attempted a rename heard "that didn't give me anything to work with".
 *
 *   F/U-3: a calculator call whose EVERY selected circuit skipped
 *   `already_set` (meter wins, never overwrite) is a successful noop with
 *   zero computed writes — same generic apology, which reads as failure and
 *   invites a confused re-dictation.
 *
 * Mechanism under lock: dispatchers record `{text}` entries on the new
 * `perTurnWrites.voiceNotices` (they cannot stamp a generationId — an
 * unstamped pendingVoicePrompts entry counts as CURRENT generation and a
 * cancellation would leak it); the harness stamps + queues them BEFORE the
 * marker-② net evaluates, so the specific notice REPLACES the generic
 * apology (speech-intent), and the §A4 drain puts it on the wire
 * (field:null channel) the same turn.
 */

import { jest } from '@jest/globals';
import {
  dispatchRenameCircuit,
  dispatchCalculateZs,
  dispatchCalculateR1PlusR2,
} from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(circuits = {}) {
  return {
    sessionId: 'fu23-test',
    stateSnapshot: {
      circuits,
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

function ctx(session, perTurnWrites) {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0 };
}

describe('F/U-2 — rename-to-same noop records a specific voice notice', () => {
  test('from_ref === circuit_ref with no meta → notice + unchanged noop envelope', async () => {
    const session = makeSession({ 4: { circuit_designation: 'Cooker' } });
    const ptw = createPerTurnWrites();
    const res = await dispatchRenameCircuit(
      {
        tool_call_id: 'tu_r1',
        name: 'rename_circuit',
        input: { from_ref: 4, circuit_ref: 4 },
      },
      ctx(session, ptw)
    );
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ ok: true, noop: true, reason: 'rename_to_same' });
    expect(ptw.voiceNotices).toEqual([
      { text: "Circuit 4 is unchanged — I didn't catch a new name or number for it." },
    ]);
    expect(ptw.circuitOps).toEqual([]); // still no state-change op
  });

  test('a REAL rename (different refs) records NO notice — the state-change TTS owns that turn', async () => {
    const session = makeSession({ 4: { circuit_designation: 'Cooker' } });
    const ptw = createPerTurnWrites();
    const res = await dispatchRenameCircuit(
      {
        tool_call_id: 'tu_r2',
        name: 'rename_circuit',
        input: { from_ref: 4, circuit_ref: 5 },
      },
      ctx(session, ptw)
    );
    expect(res.is_error).toBe(false);
    expect(ptw.voiceNotices).toEqual([]);
    expect(ptw.circuitOps.some((op) => op.op === 'rename')).toBe(true);
  });

  test('rename-to-same WITH meta supplied records NO notice (the meta write speaks via its own path)', async () => {
    const session = makeSession({ 4: {} });
    const ptw = createPerTurnWrites();
    await dispatchRenameCircuit(
      {
        tool_call_id: 'tu_r3',
        name: 'rename_circuit',
        input: { from_ref: 4, circuit_ref: 4, designation: 'Cooker' },
      },
      ctx(session, ptw)
    );
    expect(ptw.voiceNotices).toEqual([]);
  });

  test('legacy accumulator without voiceNotices does not crash (guarded)', async () => {
    const session = makeSession({ 4: {} });
    const ptw = createPerTurnWrites();
    delete ptw.voiceNotices;
    const res = await dispatchRenameCircuit(
      { tool_call_id: 'tu_r4', name: 'rename_circuit', input: { from_ref: 4, circuit_ref: 4 } },
      ctx(session, ptw)
    );
    expect(res.is_error).toBe(false);
  });
});

describe('F/U-3 — wholly-already_set calculator calls record a specific notice', () => {
  const seeded = () =>
    makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { measured_zs_ohm: '1.10', r1_r2_ohm: '0.86' },
    });

  test('single circuit already_set → "Zs for circuit 4 is already recorded — say a new reading to replace it."', async () => {
    const session = seeded();
    const ptw = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_c1', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      ctx(session, ptw)
    );
    const body = JSON.parse(res.content);
    expect(body.computed).toEqual([]);
    expect(body.skipped).toEqual([{ circuit_ref: 4, reason: 'already_set' }]);
    expect(ptw.voiceNotices).toEqual([
      { text: 'Zs for circuit 4 is already recorded — say a new reading to replace it.' },
    ]);
  });

  test('multiple circuits (≤4) list refs; >4 collapses to "those circuits"', async () => {
    const many = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      1: { measured_zs_ohm: '1.0' },
      2: { measured_zs_ohm: '1.0' },
      3: { measured_zs_ohm: '1.0' },
    });
    const ptw = createPerTurnWrites();
    await dispatchCalculateZs(
      { tool_call_id: 'tu_c2', name: 'calculate_zs', input: { circuit_refs: [1, 2, 3] } },
      ctx(many, ptw)
    );
    expect(ptw.voiceNotices).toEqual([
      {
        text: 'Zs for circuits 1, 2 and 3 is already recorded — say new readings to replace them.',
      },
    ]);

    const lots = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, { measured_zs_ohm: '1.0' }])),
    });
    const ptw2 = createPerTurnWrites();
    await dispatchCalculateZs(
      { tool_call_id: 'tu_c3', name: 'calculate_zs', input: { circuit_refs: [1, 2, 3, 4, 5] } },
      ctx(lots, ptw2)
    );
    expect(ptw2.voiceNotices).toEqual([
      // Codex r1 — the >4 scope carries the COUNT so two different large
      // batches never produce byte-identical texts for the client's 30 s
      // text-keyed field-nil dedupe.
      { text: 'Zs for those 5 circuits is already recorded — say new readings to replace them.' },
    ]);
  });

  test('Codex r1 — wording ROTATES by turn (turnId-derived variant) so consecutive identical outcomes differ textually', async () => {
    const mk = async (turnId) => {
      const session = makeSession({
        0: { earth_loop_impedance_ze: '0.35' },
        4: { measured_zs_ohm: '1.10' },
      });
      const ptw = createPerTurnWrites();
      await dispatchCalculateZs(
        { tool_call_id: 'tu_rot', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
        { session, logger: mockLogger(), turnId, perTurnWrites: ptw, round: 0 }
      );
      return ptw.voiceNotices[0].text;
    };
    // djb2('t1') % 2 === 0, djb2('t2') % 2 === 1 — two adjacent turns pick
    // different variants, so a repeat within the client TTL still speaks.
    const a = await mk('t1');
    const b = await mk('t2');
    expect(a).toBe('Zs for circuit 4 is already recorded — say a new reading to replace it.');
    expect(b).toBe(
      "There's already a Zs recorded for circuit 4 — dictate a new value to replace it."
    );
    expect(a).not.toBe(b);

    // The rename notice rotates on the same mechanism.
    const renameText = async (turnId) => {
      const session = makeSession({ 4: {} });
      const ptw = createPerTurnWrites();
      await dispatchRenameCircuit(
        { tool_call_id: 'tu_rr', name: 'rename_circuit', input: { from_ref: 4, circuit_ref: 4 } },
        { session, logger: mockLogger(), turnId, perTurnWrites: ptw, round: 0 }
      );
      return ptw.voiceNotices[0].text;
    };
    expect(await renameText('t1')).toBe(
      "Circuit 4 is unchanged — I didn't catch a new name or number for it."
    );
    expect(await renameText('t2')).toBe(
      'Nothing changed for circuit 4 — say the new name or number again.'
    );
  });

  test('MIXED skip reasons (already_set + no_r1_r2) → NO notice (generic catch-all owns that turn)', async () => {
    const session = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { measured_zs_ohm: '1.10' },
      5: {}, // exists, no r1_r2
    });
    const ptw = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_c4', name: 'calculate_zs', input: { circuit_refs: [4, 5] } },
      ctx(session, ptw)
    );
    const body = JSON.parse(res.content);
    expect(body.skipped.map((s) => s.reason).sort()).toEqual(['already_set', 'no_r1_r2']);
    expect(ptw.voiceNotices).toEqual([]);
  });

  test('PARTIAL success (computed > 0 alongside already_set skips) → NO notice (the computed read-back speaks)', async () => {
    const session = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { measured_zs_ohm: '1.10' },
      5: { r1_r2_ohm: '0.50' },
    });
    const ptw = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_c5', name: 'calculate_zs', input: { circuit_refs: [4, 5] } },
      ctx(session, ptw)
    );
    const body = JSON.parse(res.content);
    expect(body.computed).toHaveLength(1);
    expect(ptw.voiceNotices).toEqual([]);
  });

  test('calculate_r1_plus_r2 speaks its own friendly name', async () => {
    const session = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { r1_r2_ohm: '0.86', measured_zs_ohm: '1.21' },
    });
    const ptw = createPerTurnWrites();
    await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu_c6',
        name: 'calculate_r1_plus_r2',
        input: { circuit_ref: 4, all: false, method: 'zs_minus_ze' },
      },
      ctx(session, ptw)
    );
    expect(ptw.voiceNotices).toEqual([
      { text: 'R1 plus R2 for circuit 4 is already recorded — say a new reading to replace it.' },
    ]);
  });
});
