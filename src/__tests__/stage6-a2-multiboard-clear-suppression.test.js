/**
 * A2-multiboard (2026-07-28) — the #31 "same-turn write suppresses the clear
 * read-back" test is keyed on the EFFECTIVE CIRCUIT SLOT, not `field|circuit`.
 *
 * #31 exists to stop a value REPLACEMENT double-confirming: when one turn both
 * clears and rewrites a slot, the write's read-back is the confirmation and the
 * standalone "<field> cleared" would be a second one. That is correct — but its
 * key was board-AMBIGUOUS. `record_reading` and `clear_reading` both omit
 * `board_id` in the common case, so the bare string `measured_zs_ohm|1` matched
 * ANY board's circuit 1.
 *
 * Consequence: write Zs c1 on main, `select_board garage`, clear Zs c1 on
 * garage. The two operations occupy DIFFERENT effective slots, so P5's
 * clear→write collapse correctly keeps both and the clear reaches
 * `field_corrections` — but main's write then ate garage's "Zs cleared". The
 * garage clear is applied on the server AND on the client, and the inspector
 * never hears it. Written-but-not-spoken: Audio-First #1.
 *
 * Plan A1a fixed the BOARD half of this exact defect a day earlier (its comment
 * records "the bare string 'manufacturer' from A's write ate B's clear
 * read-back"); this is the untouched circuit twin. Found by the Codex pre-merge
 * diff review, cycle 3.
 */

import { jest } from '@jest/globals';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
} from '../extraction/stage6-dispatchers-circuit.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'garage', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function session(boards, currentBoardId) {
  return {
    sessionId: 'a2mb-clear-suppression',
    stateSnapshot: {
      // Circuit 1 on BOTH boards — legacy bare-numeric key is main's, the
      // composite key is the sub-board's (the dual-shape convention).
      circuits: {
        1: { measured_zs_ohm: '0.99' },
        'garage::1': { board_id: 'garage', circuit: 1, measured_zs_ohm: '0.71' },
      },
      boards,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

function ctx(s, p, callId) {
  return { session: s, logger: mockLogger(), turnId: 't1', perTurnWrites: p, round: 0, callId };
}

/** A write with `board_id` OMITTED — the shape the model actually emits. */
function write(s, p, callId, value) {
  return dispatchRecordReading(
    {
      tool_call_id: callId,
      name: 'record_reading',
      input: {
        field: 'measured_zs_ohm',
        circuit: 1,
        value,
        confidence: 0.9,
        source_turn_id: 't1',
      },
    },
    ctx(s, p, callId)
  );
}

/** A clear with `board_id` OMITTED — likewise. */
function clear(s, p, callId) {
  return dispatchClearReading(
    {
      tool_call_id: callId,
      name: 'clear_reading',
      input: { field: 'measured_zs_ohm', circuit: 1, reason: 'user_correction' },
    },
    ctx(s, p, callId)
  );
}

const bundle = (p) =>
  bundleToolCallsIntoResult(p, { questions: [] }, { confirmationsEnabled: true, turnId: 'turn-9' });

const clearedOf = (r) => r.confirmations.filter((c) => c.field === 'field_cleared');

describe('A2-multiboard — #31 clear suppression is per EFFECTIVE circuit slot', () => {
  test('DISCRIMINATING: a main-board write does not silence a garage-board clear', async () => {
    const s = session(MULTI_BOARD, 'main');
    const p = createPerTurnWrites();

    await write(s, p, 'w1', '0.42');
    // `select_board garage` — the dispatcher mutates `currentBoardId`, the only
    // input to the following call's effective-board resolution.
    s.stateSnapshot.currentBoardId = 'garage';
    await clear(s, p, 'c1');

    const res = bundle(p);
    // Both operations survive projection — the effective slots differ, so P5's
    // clear→write collapse has nothing to collapse.
    expect(res.extracted_readings.filter((r) => r.field === 'measured_zs_ohm')).toHaveLength(1);
    expect(res.field_corrections.filter((f) => f.reason === 'clear_reading')).toHaveLength(1);

    // Pre-fix this was length 0: main's write contributed the bare
    // `measured_zs_ohm|1` and swallowed garage's spoken clear entirely.
    expect(clearedOf(res)).toHaveLength(1);
  });

  test('a single-board replacement is still suppressed — #31 intact', async () => {
    // Same field, same ref, same board: the clear IS redundant with the write's
    // read-back, which is the whole point of #31. Nothing here may change.
    const s = session([MULTI_BOARD[0]], 'main');
    const p = createPerTurnWrites();

    await clear(s, p, 'c1');
    await write(s, p, 'w1', '0.42');

    const res = bundle(p);
    expect(res.extracted_readings.filter((r) => r.field === 'measured_zs_ohm')).toHaveLength(1);
    expect(clearedOf(res)).toHaveLength(0);
  });

  test('a standalone clear with no same-turn write still speaks', async () => {
    const s = session([MULTI_BOARD[0]], 'main');
    const p = createPerTurnWrites();

    await clear(s, p, 'c1');

    expect(clearedOf(bundle(p))).toHaveLength(1);
  });

  test('an UNSEQUENCED legacy write keeps today s bare-field suppression', async () => {
    // Direct `.set` call sites and older hand-built fixtures never touch the
    // journal and carry no EFFECTIVE_CIRCUIT_SLOT stamp. Both sides then fall
    // back to the stable null-board sentinel key, so their behaviour is
    // byte-identical to pre-A2 — the guarantee that lets this ship without
    // re-authoring the legacy fixture corpus.
    const p = createPerTurnWrites();

    p.readings.set(encodeReadingKey('measured_zs_ohm', 1, undefined), {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.42',
      confidence: 0.9,
    });
    p.fieldCorrections.push({
      type: 'field_corrected',
      circuit: 1,
      field: 'measured_zs_ohm',
      previous_value: '0.99',
      reason: 'clear_reading',
      board_id: null,
    });

    expect(clearedOf(bundle(p))).toHaveLength(0);
  });
});
