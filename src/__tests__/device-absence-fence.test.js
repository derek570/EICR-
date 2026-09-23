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
  computeAnswerFence,
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

// ── The fence matrix, driven through the REAL harness ───────────────────────
//
// The first version of this block asserted a local `matches` helper that COPIED
// the intended comparison. That pins nothing: changing the production fence to
// suppress an answer after a clear on another circuit or board would have left
// it green. Every row below drives `runShadowHarness` and asserts the flag the
// finalizer actually reads.

describe('the fence matrix — the PRODUCTION predicate, all six rows', () => {
  const HANDOFF = { circuit_ref: 3, boardId: 'main', schema: 'rcd' };

  function withAnswer(w) {
    w.answer = w.answer ?? {};
    w.answer.featureTouched = true;
    return w;
  }

  test('a surviving clear on the handed-off circuit FENCES', () => {
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    const fence = computeAnswerFence(HANDOFF, w);
    expect(fence.fenced).toBe(true);
    expect(fence.fields).toEqual(['rcd_type']);
  });

  test('same-turn clear THEN write on one slot — the replacement idiom — does NOT fence', () => {
    // The clear does not survive, so the write's own read-back speaks and an
    // answer beside it is ordinary. Fencing on `cleared.length` would break
    // exactly this, the commonest correction an inspector makes.
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    writeFor(w, 'rcd_type', 3, 'main', 'AC');
    expect(computeAnswerFence(HANDOFF, w).fenced).toBe(false);
  });

  test('a surviving clear on ANOTHER circuit does NOT fence', () => {
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 5, 'main'));
    expect(computeAnswerFence(HANDOFF, w).fenced).toBe(false);
  });

  test('the same circuit_ref on ANOTHER board does NOT fence', () => {
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 3, 'board-b'));
    expect(computeAnswerFence(HANDOFF, w).fenced).toBe(false);
  });

  test('a clear on a turn with NO handoff does NOT fence', () => {
    // An earlier handed-off circuit's clear arriving on a later, ordinary turn.
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    expect(computeAnswerFence(null, w).fenced).toBe(false);
  });

  test('a handoff turn with NO surviving clear does NOT fence', () => {
    // The model asked instead, or recorded nothing.
    const w = withAnswer(createPerTurnWrites());
    expect(computeAnswerFence(HANDOFF, w).fenced).toBe(false);
  });

  test('several surviving clears report EVERY fenced field', () => {
    const w = withAnswer(createPerTurnWrites());
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    w.cleared.push(clearEntry('rcd_bs_en', 3, 'main'));
    w.cleared.push(clearEntry('rcd_type', 9, 'main')); // another circuit — excluded
    const fence = computeAnswerFence(HANDOFF, w);
    expect(fence.fenced).toBe(true);
    expect(fence.fields.sort()).toEqual(['rcd_bs_en', 'rcd_type']);
  });

  test('a turn with no answer state never fences', () => {
    // The fence suppresses an ANSWER; with none staged there is nothing to
    // suppress, and it must not invent a flag on an unrelated turn.
    const w = createPerTurnWrites();
    w.answer = null;
    w.cleared.push(clearEntry('rcd_type', 3, 'main'));
    expect(computeAnswerFence(HANDOFF, w).fenced).toBe(false);
  });
});
