/**
 * PLAN-A §A1 (feedback-2026-09-17) — the DEVICE-ABSENCE FENCE, and the
 * `survivingClears` extraction it rests on.
 *
 * Acceptance item 2's fence matrix. After a first-miss handoff the model owns
 * the circuit; "there is no RCD" makes it clear what the walk recorded, one
 * `clear_reading` per field, each with its own `field_cleared` read-back. Those
 * lines ARE the turn's spoken outcome, so an `answer_user` on that turn is
 * suppressed deterministically — Audio-First exactly-once holds per VALUE.
 *
 * The predicate is the load-bearing part, and each row of the matrix below is a
 * way of getting it wrong: `cleared.length` would fence a REPLACED clear (the
 * ordinary correction idiom), and session tombstones would fence an OLDER
 * circuit's clear.
 */

import {
  survivingClears,
  buildSurvivingWritePredicate,
  createPerTurnWrites,
  recordReadingWrite,
  encodeReadingKey,
  EFFECTIVE_CIRCUIT_SLOT,
} from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

function stampSlot(entry, field, circuit, boardId) {
  Object.defineProperty(entry, EFFECTIVE_CIRCUIT_SLOT, {
    value: { field, circuit, boardId },
    enumerable: false,
    configurable: true,
  });
  return entry;
}

function clearEntry(field, circuit, boardId = null) {
  return stampSlot({ field, circuit, board_id: boardId }, field, circuit, boardId);
}

function writeFor(perTurnWrites, field, circuit, boardId = null, value = 'x') {
  const v = stampSlot({ value, confidence: 1, source_turn_id: 't1' }, field, circuit, boardId);
  recordReadingWrite(perTurnWrites, encodeReadingKey(field, circuit, boardId), v);
  return v;
}

describe('survivingClears — the extracted P5 predicate', () => {
  test('a clear with NO surviving write survives; one with a same-turn write does not', () => {
    const w = createPerTurnWrites();
    w.cleared.push(clearEntry('rcd_type', 3));
    expect(survivingClears(w).map((c) => c.field)).toEqual(['rcd_type']);

    // The replacement idiom: same-turn clear then write on the SAME slot. The
    // clear is collapsed, so it does not survive — and must not fence.
    writeFor(w, 'rcd_type', 3);
    expect(survivingClears(w)).toEqual([]);
  });

  test('identity is the EFFECTIVE slot — a write on another circuit or board does not collapse it', () => {
    const w = createPerTurnWrites();
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    writeFor(w, 'rcd_type', 5, 'main');
    writeFor(w, 'rcd_type', 3, 'board-b');
    expect(survivingClears(w)).toHaveLength(1);
  });

  test('the predicate is pure and reusable — the bundler and the fence get the same answer', () => {
    const w = createPerTurnWrites();
    w.cleared.push(clearEntry('rcd_type', 3));
    writeFor(w, 'rcd_bs_en', 3);
    const pred = buildSurvivingWritePredicate(w);
    expect(pred(w.cleared[0])).toBe(false);
    expect(survivingClears(w)).toHaveLength(1);
  });

  test('extraction is byte-identical: the bundler still drops a collapsed clear', () => {
    const w = createPerTurnWrites();
    w.cleared.push(clearEntry('rcd_type', 3));
    writeFor(w, 'rcd_type', 3, null, 'AC');
    const result = bundleToolCallsIntoResult(w, null, {});
    // Collapsed: the key is OMITTED entirely, keeping the empty-slot
    // byte-identity the P5 tests pin.
    expect(result.cleared_readings).toBeUndefined();
  });

  test('…and still keeps a clear that has no replacement', () => {
    const w = createPerTurnWrites();
    w.cleared.push(clearEntry('rcd_type', 3));
    const result = bundleToolCallsIntoResult(w, null, {});
    expect(result.cleared_readings).toHaveLength(1);
    expect(result.cleared_readings[0].field).toBe('rcd_type');
  });
});

describe('the fence matrix — scope', () => {
  // The fence itself lives in the harness and is exercised end-to-end by the
  // harness suite. These assert the SCOPE rule it applies, which is where the
  // failure modes are: a clear on another circuit, an older handed-off
  // circuit, or the same ref on another board must never fence.
  const matches = (clear, handoff) => {
    const sym = clear[EFFECTIVE_CIRCUIT_SLOT];
    const circuit = sym ? sym.circuit : (clear.circuit ?? null);
    const boardId = sym ? (sym.boardId ?? null) : (clear.board_id ?? null);
    return circuit === handoff.circuit_ref && boardId === (handoff.boardId ?? null);
  };

  test('same circuit, same board → fences', () => {
    expect(matches(clearEntry('rcd_type', 3, 'main'), { circuit_ref: 3, boardId: 'main' })).toBe(
      true
    );
  });

  test('a surviving clear on ANOTHER circuit → no fence', () => {
    expect(matches(clearEntry('rcd_type', 5, 'main'), { circuit_ref: 3, boardId: 'main' })).toBe(
      false
    );
  });

  test('the same circuit_ref on ANOTHER board → no fence', () => {
    expect(
      matches(clearEntry('rcd_type', 3, 'board-b'), { circuit_ref: 3, boardId: 'main' })
    ).toBe(false);
  });
});
