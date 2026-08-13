/**
 * Plan B (feedback ids 118/119) B1.3 — renderer-aligned echo stamping.
 *
 * `synthesiseConfirmations` (via `bundleToolCallsIntoResult`) stamps
 * `fast_correlation_id` on a confirmation ONLY when its OWN renderer-aligned
 * comparison text (designation=null, matching the fast route's own render)
 * is byte-identical to the accepted identity's comparisonText AND the
 * canonical value also matches — full (field, circuit, boardId) identity via
 * the slotKey join, plus text+value equality. A value/text mismatch (a
 * correction) NEVER stamps, so the canonical correction stays the one that
 * speaks. The SPOKEN text always carries the real designation, unaffected by
 * the stamp.
 *
 * Also covers the grouped-confirmation partition: a fast-matched
 * single-circuit reading is pulled OUT of a multi-circuit bucket before
 * grouping, so it gets its own stamped confirmation while the REMAINING
 * uncovered circuits still group.
 */

import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

function makePerTurnWrites(overrides = {}) {
  return {
    readings: overrides.readings ?? new Map(),
    boardReadings: overrides.boardReadings ?? new Map(),
    cleared: overrides.cleared ?? [],
    observations: overrides.observations ?? [],
    deletedObservations: overrides.deletedObservations ?? [],
    circuitOps: overrides.circuitOps ?? [],
    boardOps: overrides.boardOps ?? [],
  };
}

function accepted({ field, circuit, boardId = null, canonicalValue, comparisonText }) {
  return {
    correlationId: 'cid-1',
    field,
    circuit,
    boardId,
    canonicalValue,
    comparisonText,
  };
}

describe('bundleToolCallsIntoResult — B1.3 fast-attempt echo stamping', () => {
  test('full match (slotKey + comparison text + value) stamps fast_correlation_id; spoken text unaffected', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::1::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 1,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 1, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations).toHaveLength(1);
    expect(r.confirmations[0]).toMatchObject({
      text: 'Circuit 1, Zs 0.62',
      field: 'measured_zs_ohm',
      circuit: 1,
      fast_correlation_id: 'cid-1',
    });
  });

  test('a real designation still speaks (the stamp is purely additive, comparison text is designation=null internally)', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::1::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 1,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 1, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      {
        confirmationsEnabled: true,
        fastAttemptBySlotKey,
        circuitDesignations: new Map([[1, 'Cooker']]),
      }
    );
    expect(r.confirmations[0].text).toBe('Cooker, circuit 1, Zs 0.62');
    expect(r.confirmations[0].fast_correlation_id).toBe('cid-1');
  });

  test('value mismatch (the model corrected it) — NEVER stamps; canonical correction speaks', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.85', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::1::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 1,
          canonicalValue: '0.62', // stale — the fast clip spoke the wrong value
          comparisonText: 'Circuit 1, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations).toHaveLength(1);
    expect(r.confirmations[0].text).toBe('Circuit 1, Zs 0.85');
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('field mismatch (identity keyed on a different field) — no slotKey join, no stamp', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'r1_r2_ohm::1::',
        accepted({
          field: 'r1_r2_ohm',
          circuit: 1,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 1, R1 plus R2 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('circuit mismatch (identity keyed on a different circuit) — no slotKey join, no stamp', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::2::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 2,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 2, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('board mismatch (identity keyed on a different board) — no slotKey join, no stamp', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1, 'sub-1'),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1', boardId: 'sub-1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::1::main',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 1,
          boardId: 'main',
          canonicalValue: '0.62',
          comparisonText: 'Circuit 1, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('text mismatch despite value match (a calculator result on the SAME field/circuit/board/value) — NEVER stamps', () => {
    // The fast clip spoke a plain dictated "Zs 0.62"; the Sonnet round instead
    // resolved this as a CALCULATED 0.62 (calculate_zs) — same field/circuit/
    // board/value, but the phrasing differs ("Zs calculated as 0.62"), so the
    // renderer-aligned comparison text differs too. This must never stamp:
    // the calculated phrasing is the one that must be heard.
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: '::calc::calculate_zs' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::1::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 1,
          canonicalValue: '0.62',
          // The accepted identity's comparison text was rendered WITHOUT
          // "calculated as" (the fast route never knows about calculator
          // provenance) — so it mismatches the calculated reading's own
          // freshly-rendered comparison text ("Zs calculated as 0.62").
          comparisonText: 'Circuit 1, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations).toHaveLength(1);
    expect(r.confirmations[0].text).toBe('Circuit 1, Zs calculated as 0.62');
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('no fastAttemptBySlotKey (undefined) — byte-identical to pre-B1.3 behaviour', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations[0]).not.toHaveProperty('fast_correlation_id');
  });

  test('grouped-confirmation partition: a fast-matched circuit is pulled OUT of the multi-circuit bucket; the rest still group', () => {
    // Three circuits share the same field+value — WOULD group into one line
    // ("Circuits 1 to 3, Zs 0.62") — but circuit 2 was fast-attempted and
    // matches exactly. It must get its OWN stamped single confirmation, and
    // circuits 1 and 3 must STILL group together (not silenced, not
    // double-spoken).
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('measured_zs_ohm', 2),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('measured_zs_ohm', 3),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const fastAttemptBySlotKey = new Map([
      [
        'measured_zs_ohm::2::',
        accepted({
          field: 'measured_zs_ohm',
          circuit: 2,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 2, Zs 0.62',
        }),
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    expect(r.confirmations).toHaveLength(2);
    const single = r.confirmations.find((c) => c.circuit === 2);
    const grouped = r.confirmations.find((c) => c.circuit == null);
    expect(single).toBeDefined();
    expect(single.fast_correlation_id).toBe('cid-1');
    expect(single.text).toBe('Circuit 2, Zs 0.62');
    expect(grouped).toBeDefined();
    expect(grouped.circuits).toEqual([1, 3]);
    expect(grouped.text).toBe('Circuits 1, 3, Zs 0.62');
    expect(grouped).not.toHaveProperty('fast_correlation_id');
  });
});
