/**
 * P5 (2026-07-23) — same-turn clear→write ordering-wipe collapse.
 *
 * Feedback ids 80(B) + 81 (session 36731498, replay marker T10): a value was
 * read back aloud AND written server-side, then silently un-written on the
 * client because the turn carried both a clear_reading and a write for the SAME
 * field and the stale clear frame landed after the write. These tests drive the
 * REAL dispatchers through the REAL bundler and assert the net wire + spoken +
 * telemetry effect for every ordering and producer the plan enumerates.
 */

import { jest } from '@jest/globals';
import {
  dispatchRecordReading,
  dispatchClearReading,
  dispatchCalculateZs,
  dispatchSetFieldForAllCircuits,
} from '../extraction/stage6-dispatchers-circuit.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';
import {
  bundleToolCallsIntoResult,
  SAME_TURN_CLEAR_WRITE_COLLAPSED,
} from '../extraction/stage6-event-bundler.js';
import {
  createPerTurnWrites,
  encodeReadingKey,
  encodeBoardReadingKey,
  attachEffectiveSlot,
} from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(circuits = {}, extra = {}) {
  return {
    sessionId: 'p5-test',
    stateSnapshot: {
      circuits,
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      ...extra,
    },
  };
}

function ctx(session, perTurnWrites, callId = 'tc1') {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0, callId };
}

function recordCall(input, tool_call_id = 'w1') {
  return { tool_call_id, name: 'record_reading', input };
}
function clearCall(input, tool_call_id = 'c1') {
  return { tool_call_id, name: 'clear_reading', input };
}

function bundle(perTurnWrites) {
  return bundleToolCallsIntoResult(perTurnWrites, null, {
    confirmationsEnabled: true,
    turnId: 't1',
  });
}

const clearedConfirmations = (r) => (r.confirmations ?? []).filter((c) => c.field === 'field_cleared');
const fieldConfirmations = (r, field) => (r.confirmations ?? []).filter((c) => c.field === field);

// ---------------------------------------------------------------------------
// 1. clear→write collapse (the T10 wipe) — write survives, clear dropped, one read-back
// ---------------------------------------------------------------------------

describe('P5 — clear→write collapse (circuit slot)', () => {
  test('clear then write same slot: write survives, ZERO same-slot field_corrections, ONE spoken read-back', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'user_correction' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);

    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].value).toBe('100');
    expect('field_corrections' in r).toBe(false); // stale clear collapsed
    expect('cleared_readings' in r).toBe(false);
    // Exactly one read-back (the write); never "<field> cleared" on top.
    expect(clearedConfirmations(r)).toHaveLength(0);
    expect(fieldConfirmations(r, 'ir_live_live_mohm')).toHaveLength(1);
    // Telemetry records the collapse under the effective board.
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toEqual([
      { field: 'ir_live_live_mohm', circuit: 3, board_id: 'main', final_effect: 'write' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. write→clear regression guards (incl. mixed-spelling)
// ---------------------------------------------------------------------------

describe('P5 — write→clear stays clear-only (circuit slot)', () => {
  test('write then clear same slot: readings emptied, clear survives, cleared confirmation speaks', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'user_correction' }),
      ctx(session, p)
    );
    const r = bundle(p);

    expect(r.extracted_readings).toHaveLength(0);
    expect(Array.isArray(r.field_corrections)).toBe(true);
    expect(r.field_corrections).toHaveLength(1);
    expect(Array.isArray(r.cleared_readings)).toBe(true);
    expect(r.cleared_readings).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
    // The cleared confirmation speaks (no surviving write to suppress it).
    expect(clearedConfirmations(r).length).toBeGreaterThanOrEqual(1);
  });

  test('mixed spelling: write(explicit current board)→clear(omitted board) yields clear-only', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1', board_id: 'main' }),
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }), // board_id omitted
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(0); // effective-aware delete removed the write
    expect(r.field_corrections).toHaveLength(1);
    expect(r.cleared_readings).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('mixed spelling INVERSE: write(omitted board)→clear(explicit current board) yields clear-only', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }), // omitted
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x', board_id: 'main' }), // explicit current
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(0);
    expect(r.field_corrections).toHaveLength(1);
    expect(r.cleared_readings).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. board-slot write→clear: the clear is NOT dropped (boardReadings exclusion)
// ---------------------------------------------------------------------------

describe('P5 — board-slot exclusion', () => {
  test('a board write (boardReadings) co-present with a clear does NOT collapse — clear survives', () => {
    // Hand-built: a board-level write lives in boardReadings (not readings),
    // which the collapse deliberately excludes. So a clear for that field is
    // NEVER dropped — proving a board write→clear keeps its clear.
    const p = createPerTurnWrites();
    p.boardReadings.set(encodeBoardReadingKey('earth_loop_impedance_ze', null), {
      value: '0.35',
      confidence: 1,
      source_turn_id: 't1',
    });
    p.cleared.push(
      attachEffectiveSlot(
        { field: 'earth_loop_impedance_ze', circuit: 0, reason: 'x' },
        'earth_loop_impedance_ze',
        0,
        'main'
      )
    );
    p.fieldCorrections.push(
      attachEffectiveSlot(
        {
          type: 'field_corrected',
          circuit: 0,
          field: 'earth_loop_impedance_ze',
          previous_value: '0.35',
          reason: 'clear_reading',
          board_id: null,
        },
        'earth_loop_impedance_ze',
        0,
        'main'
      )
    );
    const r = bundle(p);
    expect(Array.isArray(r.field_corrections)).toBe(true);
    expect(r.field_corrections).toHaveLength(1); // clear survives — not collapsed
    expect(r.cleared_readings).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. effective_board_id identity — omitted + explicit-current DO collapse
// ---------------------------------------------------------------------------

describe('P5 — effective board identity (clear→write mixed spelling collapses)', () => {
  test('clear(omitted board)→write(explicit current board) collapses', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1', board_id: 'main' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1);
    expect('field_corrections' in r).toBe(false);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
  });

  test('clear(explicit current board)→write(omitted board) collapses', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x', board_id: 'main' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1);
    expect('field_corrections' in r).toBe(false);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. all FOUR readings.set producers participate in the collapse
// ---------------------------------------------------------------------------

describe('P5 — every readings.set producer carries the effective key', () => {
  test('clear → set_field_for_all_circuits write collapses', async () => {
    const session = makeSession({
      0: {},
      1: { circuit_designation: 'Ckt 1', rcd_type: 'AC' },
      2: { circuit_designation: 'Ckt 2', rcd_type: 'AC' },
    });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'rcd_type', circuit: 1, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'sf1',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_type', value: 'A', scope: 'non_spare', source_turn_id: 't1', confidence: 1 },
      },
      ctx(session, p)
    );
    const r = bundle(p);
    // Circuit 1's clear collapsed against its bulk write; circuit 2 wrote too.
    const c1 = (r.field_corrections ?? []).filter((c) => c.circuit === 1 && c.reason === 'clear_reading');
    expect(c1).toHaveLength(0);
    expect(r.extracted_readings.some((x) => x.circuit === 1 && x.value === 'A')).toBe(true);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toEqual([
      { field: 'rcd_type', circuit: 1, board_id: 'main', final_effect: 'write' },
    ]);
  });

  test('clear → auto-resolve write (::auto:: tool_call_id) collapses', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        { field: 'measured_zs_ohm', circuit: 3, value: '0.42', confidence: 0.9, source_turn_id: 't1' },
        'tc::auto::resolve'
      ),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].auto_resolved).toBe(true);
    expect('field_corrections' in r).toBe(false);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
  });

  test('clear → calculate_zs computed write collapses', async () => {
    const session = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { measured_zs_ohm: '1.10', r1_r2_ohm: '0.86' },
    });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 4, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchCalculateZs(
      { tool_call_id: 'cz1', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      ctx(session, p)
    );
    const r = bundle(p);
    // Zs recomputed to 1.21 and the stale clear collapsed.
    expect(r.extracted_readings.some((x) => x.circuit === 4 && x.value === '1.21')).toBe(true);
    expect('field_corrections' in r).toBe(false);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toEqual([
      { field: 'measured_zs_ohm', circuit: 4, board_id: 'main', final_effect: 'write' },
    ]);
  });

  test('clear → start_dialogue_script seeded write collapses; script write→clear yields clear-only', async () => {
    // clear then script-seeded write of the SAME slot → collapse.
    {
      const session = makeSession({ 4: { ring_r1_ohm: '0.83', circuit_designation: 'Ring' } });
      const p = createPerTurnWrites();
      await dispatchClearReading(
        clearCall({ field: 'ring_r1_ohm', circuit: 4, reason: 'x' }),
        ctx(session, p)
      );
      await dispatchStartDialogueScript(
        {
          tool_call_id: 'sd1',
          name: 'start_dialogue_script',
          input: {
            schema: 'ring_continuity',
            circuit: 4,
            pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
            source_turn_id: 't1',
            reason: 'garble',
          },
        },
        { ...ctx(session, p), ws: { send() {}, readyState: 1 } }
      );
      const r = bundle(p);
      expect(r.extracted_readings.some((x) => x.circuit === 4 && x.value === '0.32')).toBe(true);
      const c4 = (r.field_corrections ?? []).filter((c) => c.circuit === 4 && c.reason === 'clear_reading');
      expect(c4).toHaveLength(0);
      expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
    }
    // script-seeded write then clear of the SAME slot → clear-only (effective delete covers it).
    {
      const session = makeSession({ 4: { circuit_designation: 'Ring' } });
      const p = createPerTurnWrites();
      await dispatchStartDialogueScript(
        {
          tool_call_id: 'sd2',
          name: 'start_dialogue_script',
          input: {
            schema: 'ring_continuity',
            circuit: 4,
            pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
            source_turn_id: 't1',
            reason: 'garble',
          },
        },
        { ...ctx(session, p), ws: { send() {}, readyState: 1 } }
      );
      await dispatchClearReading(
        clearCall({ field: 'ring_r1_ohm', circuit: 4, reason: 'x' }, 'c2'),
        ctx(session, p)
      );
      const r = bundle(p);
      expect(r.extracted_readings.some((x) => x.circuit === 4 && x.field === 'ring_r1_ohm')).toBe(false);
      expect((r.field_corrections ?? []).length).toBeGreaterThanOrEqual(1);
      expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. multi-board '*' broadcast — clear on board A collapses ONLY against board A
// ---------------------------------------------------------------------------

describe("P5 — set_field_for_all_circuits '*' broadcast", () => {
  test("clear on board A collapses ONLY against board A's generated write; board B retains its distinct identity", async () => {
    const session = makeSession(
      {
        0: {},
        1: { circuit_designation: 'Main Ckt 1', rcd_type: 'AC' },
        'sub-1::1': { board_id: 'sub-1', circuit: 1, circuit_designation: 'Sub Ckt 1', rcd_type: 'AC' },
      },
      {
        boards: [
          { id: 'main', board_type: 'main', designation: 'DB-1' },
          { id: 'sub-1', board_type: 'sub', designation: 'DB-2' },
        ],
      }
    );
    const p = createPerTurnWrites();
    // Clear rcd_type on board A (main) circuit 1 FIRST…
    await dispatchClearReading(
      clearCall({ field: 'rcd_type', circuit: 1, reason: 'x', board_id: 'main' }),
      ctx(session, p)
    );
    // …then broadcast a new rcd_type across BOTH boards.
    await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'sf2',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_type', value: 'A', scope: 'non_spare', source_turn_id: 't1', confidence: 1, board_id: '*' },
      },
      ctx(session, p)
    );
    const r = bundle(p);
    // Board A's clear collapsed; board B's write is untouched (no clear).
    expect('field_corrections' in r).toBe(false);
    // Both boards got their write.
    expect(r.extracted_readings.some((x) => x.circuit === 1 && x.board_id === 'main' && x.value === 'A')).toBe(true);
    expect(r.extracted_readings.some((x) => x.circuit === 1 && x.board_id === 'sub-1' && x.value === 'A')).toBe(true);
    // Telemetry: exactly ONE collapse, for board 'main' (never the '*' sentinel).
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toEqual([
      { field: 'rcd_type', circuit: 1, board_id: 'main', final_effect: 'write' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. non-collapse cases: cross-field, different-circuit, different-board
// ---------------------------------------------------------------------------

describe('P5 — non-collapse guards', () => {
  test('cross-field: clear A + write B both survive', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM', ir_live_earth_mohm: '50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_earth_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1); // the LL write
    expect(r.field_corrections).toHaveLength(1); // the LE clear survives
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('different-circuit: clear c3 + write c4 both survive', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.0' }, 4: {} });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'measured_zs_ohm', circuit: 4, value: '0.42', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.field_corrections).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('same field+circuit on DIFFERENT boards does NOT collapse (assert WIRE projection only)', () => {
    // Hand-built: a clear on board A + a write on board B, same field+circuit.
    // The effective identities differ, so the clear survives on the wire.
    const p = createPerTurnWrites();
    p.readings.set(
      encodeReadingKey('measured_zs_ohm', 1, 'sub-1'),
      attachEffectiveSlot(
        { value: '0.42', confidence: 1, source_turn_id: 't1', boardId: 'sub-1' },
        'measured_zs_ohm',
        1,
        'sub-1'
      )
    );
    p.fieldCorrections.push(
      attachEffectiveSlot(
        { type: 'field_corrected', circuit: 1, field: 'measured_zs_ohm', previous_value: '1.0', reason: 'clear_reading', board_id: 'main' },
        'measured_zs_ohm',
        1,
        'main'
      )
    );
    const r = bundle(p);
    expect(Array.isArray(r.field_corrections)).toBe(true);
    expect(r.field_corrections).toHaveLength(1); // clear (board A) survives
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
    // NB: we deliberately do NOT assert the cleared confirmation speaks — the
    // pre-existing #31 suppression key omits board_id (documented Fix spec 5
    // limitation, NOT changed by P5).
  });
});

// ---------------------------------------------------------------------------
// Slot-identity defensive contract: the Map key is authoritative over
// value.boardId, and a one-sided-Symbol pair NEVER infers ordering (Fix spec 2)
// ---------------------------------------------------------------------------

describe('P5 — slot-identity fallback contract', () => {
  test('Symbol-less raw fallback: the decoded Map key is authoritative, NOT value.boardId', () => {
    // A Symbol-less readings entry whose Map key encodes board A but whose
    // enumerable value.boardId is board B. Both compared sides lack the Symbol,
    // so the raw fallback runs — and it must derive the readings identity from
    // decodeReadingKey(mapKey) (board A), NEVER value.boardId (board B).
    const makeWrites = (clearBoard) => {
      const p = createPerTurnWrites();
      // key board = 'boardA'; value.boardId = 'boardB' (deliberate mismatch); no Symbol.
      p.readings.set(encodeReadingKey('measured_zs_ohm', 1, 'boardA'), {
        value: '0.42',
        confidence: 1,
        source_turn_id: 't1',
        boardId: 'boardB',
      });
      // Symbol-less clear (raw board_id only).
      p.fieldCorrections.push({
        type: 'field_corrected',
        circuit: 1,
        field: 'measured_zs_ohm',
        previous_value: '1.0',
        reason: 'clear_reading',
        board_id: clearBoard,
      });
      return p;
    };
    // clear on the KEY board (A) → collapses (proves the key controls matching).
    const rA = bundle(makeWrites('boardA'));
    expect('field_corrections' in rA).toBe(false);
    expect(rA[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
    // clear on the VALUE board (B) → does NOT collapse (value.boardId is ignored).
    const rB = bundle(makeWrites('boardB'));
    expect(rB.field_corrections).toHaveLength(1);
    expect(rB[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('Symbol-less raw fallback: omitted-board write + board_id-less clear collapse (undefined/absent both normalise to null)', () => {
    const p = createPerTurnWrites();
    // Write keyed with undefined board (no Symbol); clear with NO board_id
    // property at all. rawCircuitSlot must normalise both to the null board so
    // they still match.
    p.readings.set(encodeReadingKey('measured_zs_ohm', 1, undefined), {
      value: '0.42',
      confidence: 1,
      source_turn_id: 't1',
    });
    p.fieldCorrections.push({
      type: 'field_corrected',
      circuit: 1,
      field: 'measured_zs_ohm',
      previous_value: '1.0',
      reason: 'clear_reading',
      // board_id deliberately OMITTED
    });
    const r = bundle(p);
    expect('field_corrections' in r).toBe(false); // collapsed
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toEqual([
      { field: 'measured_zs_ohm', circuit: 1, board_id: null, final_effect: 'write' },
    ]);
  });

  test('one-sided Symbol (marked write + Symbol-less clear) → no collapse', () => {
    const p = createPerTurnWrites();
    // Marked write (effective set), Symbol-less clear (raw set) → the sets never
    // intersect, so no ordering is inferred.
    p.readings.set(
      encodeReadingKey('measured_zs_ohm', 1, null),
      attachEffectiveSlot(
        { value: '0.42', confidence: 1, source_turn_id: 't1' },
        'measured_zs_ohm',
        1,
        'main'
      )
    );
    p.fieldCorrections.push({
      type: 'field_corrected',
      circuit: 1,
      field: 'measured_zs_ohm',
      previous_value: '1.0',
      reason: 'clear_reading',
      board_id: null,
    });
    const r = bundle(p);
    expect(r.field_corrections).toHaveLength(1); // clear survives
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('one-sided Symbol (Symbol-less write + marked clear) → no collapse', () => {
    const p = createPerTurnWrites();
    // Symbol-less write (raw set), marked clear (effective set) → no intersection.
    p.readings.set(encodeReadingKey('measured_zs_ohm', 1, null), {
      value: '0.42',
      confidence: 1,
      source_turn_id: 't1',
    });
    p.fieldCorrections.push(
      attachEffectiveSlot(
        {
          type: 'field_corrected',
          circuit: 1,
          field: 'measured_zs_ohm',
          previous_value: '1.0',
          reason: 'clear_reading',
          board_id: null,
        },
        'measured_zs_ohm',
        1,
        'main'
      )
    );
    const r = bundle(p);
    expect(r.field_corrections).toHaveLength(1); // clear survives
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. A2 wire-dialect: r2_ohm exemption + A2-mapped fields match on RAW keys
// ---------------------------------------------------------------------------

describe('P5 — A2 wire-dialect interaction', () => {
  test('r2_ohm retains its A2 exemption when its clear survives (write→clear)', async () => {
    const session = makeSession({ 2: { r2_ohm: '0.41' } });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({ field: 'r2_ohm', circuit: 2, value: '0.50', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'r2_ohm', circuit: 2, reason: 'x' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.field_corrections).toHaveLength(1);
    expect(r.field_corrections[0].field).toBe('r2_ohm'); // NOT canonical r2
  });

  test('A2-mapped field (r1_r2_ohm) matches on RAW keys before wire conversion → collapses', async () => {
    const session = makeSession({ 3: { r1_r2_ohm: '0.86' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'r1_r2_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'r1_r2_ohm', circuit: 3, value: '0.30', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(1);
    expect('field_corrections' in r).toBe(false); // matched pre-conversion, collapsed
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. reason same_turn_correction / replace_value are NEVER dropped
// ---------------------------------------------------------------------------

describe('P5 — non-clear corrections are never dropped', () => {
  test('a same_turn_correction / replace_value correction survives even with a surviving write', () => {
    const p = createPerTurnWrites();
    p.readings.set(
      encodeReadingKey('measured_zs_ohm', 3, null),
      attachEffectiveSlot(
        { value: '0.42', confidence: 1, source_turn_id: 't1' },
        'measured_zs_ohm',
        3,
        'main'
      )
    );
    for (const reason of ['same_turn_correction', 'replace_value']) {
      p.fieldCorrections.push(
        attachEffectiveSlot(
          { type: 'field_corrected', circuit: 3, field: 'measured_zs_ohm', previous_value: '1.0', reason, board_id: null },
          'measured_zs_ohm',
          3,
          'main'
        )
      );
    }
    const r = bundle(p);
    expect(r.field_corrections).toHaveLength(2); // neither dropped
    expect(r.field_corrections.map((c) => c.reason).sort()).toEqual(['replace_value', 'same_turn_correction']);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. purity — perTurnWrites append-only, unmutated by projection
// ---------------------------------------------------------------------------

describe('P5 — projection purity', () => {
  test('bundling a collapse turn does NOT mutate perTurnWrites (append-only / length-snapshot contract)', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const readingsSizeBefore = p.readings.size;
    const clearedLenBefore = p.cleared.length;
    const fcLenBefore = p.fieldCorrections.length;
    bundle(p);
    // The projection drops entries only from the RETURNED result, never the
    // accumulator (the Loaded Barrel append-only / length-snapshot contract).
    expect(p.readings.size).toBe(readingsSizeBefore);
    expect(p.cleared.length).toBe(clearedLenBefore);
    expect(p.fieldCorrections.length).toBe(fcLenBefore);
  });

  test('collapse metadata is non-enumerable and never enters JSON wire output', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1); // readable by the harness
    expect(Object.keys(r)).not.toContain('SAME_TURN_CLEAR_WRITE_COLLAPSED');
    const parsed = JSON.parse(JSON.stringify(r));
    expect(Object.getOwnPropertySymbols(parsed)).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain('final_effect');
  });
});

// ---------------------------------------------------------------------------
// 12. A1 regressions — answer projection preserved; hadSuccessfulWrite untouched
// ---------------------------------------------------------------------------

describe('P5 — A1 agentic-voice regressions', () => {
  test('collapse preserves the spoken_response (answer) projection', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    p.answer.stagedText = 'Circuit 3 is the downstairs sockets.';
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.spoken_response).toBe('Circuit 3 is the downstairs sockets.');
    expect(r.extracted_readings).toHaveLength(1); // collapse still happened
    expect('field_corrections' in r).toBe(false);
  });

  test('neither ordering stages ANSWER_FALLBACK_TEXT: the harness gate (verbatim expression) sees a successful write', async () => {
    // The A1 answer-fallback gate lives inline in stage6-shadow-harness.js
    // (runLiveMode post-loop finalization): when a turn TOUCHED the answer
    // feature (answer.featureTouched) but staged NOTHING (stagedText == null),
    // it stages ANSWER_FALLBACK_TEXT ONLY IF `!hadSuccessfulWrite && !hadEmittedAsk`.
    // `hadSuccessfulWrite` is a pure function of `perTurnWrites` (readings /
    // boardReadings / cleared / observations / deletedObservations / circuitOps
    // / boardOps sizes) — the accumulator the projection-time collapse NEVER
    // mutates (pinned by the purity test above). So the fix cannot flip the gate.
    // Mirror the EXACT gate expression against the REAL post-dispatch accumulator
    // for both orderings, with the gate's own precondition set, and prove the
    // fallback branch is not entered.
    for (const order of ['clear_then_write', 'write_then_clear']) {
      const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
      const p = createPerTurnWrites();
      // Precondition the gate requires: the answer feature was touched but
      // nothing was staged (an emptied/filtered answer_user this turn).
      p.answer.featureTouched = true;
      p.answer.stagedText = null;
      const doClear = () =>
        dispatchClearReading(clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }), ctx(session, p));
      const doWrite = () =>
        dispatchRecordReading(
          recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
          ctx(session, p)
        );
      if (order === 'clear_then_write') {
        await doClear();
        await doWrite();
      } else {
        await doWrite();
        await doClear();
      }
      // VERBATIM from stage6-shadow-harness.js (the gate expression under lock).
      const hadSuccessfulWrite =
        (p.readings?.size ?? 0) > 0 ||
        (p.boardReadings?.size ?? 0) > 0 ||
        (p.cleared?.length ?? 0) > 0 ||
        (p.observations?.length ?? 0) > 0 ||
        (p.deletedObservations?.length ?? 0) > 0 ||
        (p.circuitOps?.length ?? 0) > 0 ||
        (p.boardOps?.length ?? 0) > 0;
      const hadEmittedAsk = false; // no ask emitted in these frozen turns
      // The gate's fallback-staging branch: `!hadSuccessfulWrite && !hadEmittedAsk`.
      const wouldStageFallback =
        p.answer.featureTouched === true &&
        p.answer.stagedText == null &&
        !hadSuccessfulWrite &&
        !hadEmittedAsk;
      expect(hadSuccessfulWrite).toBe(true);
      expect(wouldStageFallback).toBe(false); // ANSWER_FALLBACK_TEXT never staged
    }
  });

  test('collapse never mutates the answer accumulator: bundling leaves answer state intact', async () => {
    // Belt-and-braces: prove the bundler (which projects spoken_response and is
    // where the collapse runs) does not touch perTurnWrites.answer — so the
    // downstream harness gate reads exactly what the dispatchers left.
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    p.answer.featureTouched = true;
    p.answer.stagedText = null;
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({ field: 'ir_live_live_mohm', circuit: 3, value: '100', confidence: 0.9, source_turn_id: 't1' }),
      ctx(session, p)
    );
    bundle(p);
    expect(p.answer.featureTouched).toBe(true);
    expect(p.answer.stagedText).toBeNull(); // bundler never staged a fallback
  });
});
