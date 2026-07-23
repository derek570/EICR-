/**
 * Stage 6 Phase 2 Plan 02-02 — createPerTurnWrites() unit tests.
 *
 * WHAT: Locks the shape of the per-turn writes accumulator that all six write
 * dispatchers (record_reading, clear_reading, create_circuit, rename_circuit,
 * record_observation, delete_observation) share. Same-turn correction
 * semantics (STT-09) depend on the readings Map's last-write-wins behaviour;
 * the Phase 2 event bundler (Plan 02-05) depends on the exact field names
 * (readings / cleared / observations / deletedObservations / circuitOps).
 *
 * WHY this shape is locked here (MAJOR-1 from Phase 2 planning review):
 *   - `readings` is a Map<"${field}::${circuit}", {value, confidence, source_turn_id}>.
 *     The value object MUST NOT carry field/circuit — they're in the key. The
 *     bundler in Plan 02-05 reconstructs field+circuit by splitting on '::'.
 *     Duplicating them in the value creates drift risk (which truth wins?).
 *   - Reset-per-turn contract: every `runShadowHarness` invocation creates a
 *     fresh accumulator. Tests enforce that two calls return DIFFERENT objects
 *     so a bug that accidentally memoises the factory shows up in CI.
 */

import {
  createPerTurnWrites,
  encodeReadingKey,
  decodeReadingKey,
  encodeBoardReadingKey,
  decodeBoardReadingKey,
  EFFECTIVE_CIRCUIT_SLOT,
  rawCircuitSlot,
  attachEffectiveSlot,
} from '../extraction/stage6-per-turn-writes.js';

describe('createPerTurnWrites()', () => {
  test('returns an object with the seven expected fields all initially empty', () => {
    const w = createPerTurnWrites();
    expect(w.readings).toBeInstanceOf(Map);
    expect(w.readings.size).toBe(0);
    // boardReadings is the Phase 2 carryover slot for record_board_reading
    // (Bug C — 2026-04-26 production analysis). Same Map shape as readings,
    // keyed by field-only because every entry implicitly lives at circuits[0].
    expect(w.boardReadings).toBeInstanceOf(Map);
    expect(w.boardReadings.size).toBe(0);
    expect(Array.isArray(w.cleared)).toBe(true);
    expect(w.cleared).toHaveLength(0);
    expect(Array.isArray(w.observations)).toBe(true);
    expect(w.observations).toHaveLength(0);
    expect(Array.isArray(w.deletedObservations)).toBe(true);
    expect(w.deletedObservations).toHaveLength(0);
    expect(Array.isArray(w.circuitOps)).toBe(true);
    expect(w.circuitOps).toHaveLength(0);
    // boardOps is the Phase 6.0 wire channel for board mutations
    // (Codex deal-breaker #3). Inert until Phase 6 dispatchers populate it.
    expect(Array.isArray(w.boardOps)).toBe(true);
    expect(w.boardOps).toHaveLength(0);
  });

  test('each call returns a NEW object — no shared references across invocations (reset-per-turn contract)', () => {
    const a = createPerTurnWrites();
    const b = createPerTurnWrites();
    expect(a).not.toBe(b);
    expect(a.readings).not.toBe(b.readings);
    expect(a.boardReadings).not.toBe(b.boardReadings);
    expect(a.cleared).not.toBe(b.cleared);
    expect(a.observations).not.toBe(b.observations);
    expect(a.deletedObservations).not.toBe(b.deletedObservations);
    expect(a.circuitOps).not.toBe(b.circuitOps);
    expect(a.boardOps).not.toBe(b.boardOps);

    // Mutating one must not affect the other.
    a.readings.set('Ze_ohms::1', { value: '0.35', confidence: 1.0, source_turn_id: 't1' });
    a.boardReadings.set('earth_loop_impedance_ze', {
      value: '0.86',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    a.cleared.push({ field: 'Zs_ohms', circuit: 1, reason: 'user_correction' });
    a.boardOps.push({ op: 'add_board', board_id: 'sub-1', designation: 'DB-2' });
    expect(b.readings.size).toBe(0);
    expect(b.boardReadings.size).toBe(0);
    expect(b.cleared).toHaveLength(0);
    expect(b.boardOps).toHaveLength(0);
  });

  test('readings Map has last-write-wins semantics on the same `${field}::${circuit}` key (same-turn correction pathway)', () => {
    const w = createPerTurnWrites();
    w.readings.set('Ze_ohms::3', { value: '0.35', confidence: 1.0, source_turn_id: 't1' });
    w.readings.set('Ze_ohms::3', { value: '0.40', confidence: 1.0, source_turn_id: 't1' });
    expect(w.readings.size).toBe(1);
    expect(w.readings.get('Ze_ohms::3')).toEqual({
      value: '0.40',
      confidence: 1.0,
      source_turn_id: 't1',
    });
  });

  test('readings value shape lock (MAJOR-1): entries carry {value, confidence, source_turn_id} — NOT field/circuit', () => {
    const w = createPerTurnWrites();
    w.readings.set('R1_ohms::2', { value: '1.23', confidence: 0.95, source_turn_id: 't42' });
    const entry = w.readings.get('R1_ohms::2');
    expect(entry).toHaveProperty('value');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('source_turn_id');
    // Shape lock: value must NOT include field/circuit. The bundler in Plan 02-05
    // reconstructs those by splitting the key on '::'.
    expect(entry).not.toHaveProperty('field');
    expect(entry).not.toHaveProperty('circuit');
  });

  test('P5 EFFECTIVE_CIRCUIT_SLOT marker is NON-ENUMERABLE (enumerable shape unchanged)', () => {
    // P5 (2026-07-23) — attachEffectiveSlot stamps the slot-identity object as
    // a non-enumerable Symbol so the enumerable value shape, Object.keys,
    // JSON.stringify and the wire bytes stay byte-identical to pre-P5.
    const value = attachEffectiveSlot(
      { value: '1.23', confidence: 1, source_turn_id: 't1', boardId: 'sub-1' },
      'measured_zs_ohm',
      3,
      'sub-1'
    );
    // Present + readable by consumers that know the Symbol…
    expect(value[EFFECTIVE_CIRCUIT_SLOT]).toEqual({
      field: 'measured_zs_ohm',
      circuit: 3,
      boardId: 'sub-1',
    });
    // …but invisible to enumeration + serialisation (the shape lock).
    expect(Object.keys(value)).toEqual(['value', 'confidence', 'source_turn_id', 'boardId']);
    expect(Object.getOwnPropertyDescriptor(value, EFFECTIVE_CIRCUIT_SLOT).enumerable).toBe(false);
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      value: '1.23',
      confidence: 1,
      source_turn_id: 't1',
      boardId: 'sub-1',
    });
    // Spread (the answer-projection + defensive-copy sites) drops the marker.
    expect(Object.getOwnPropertySymbols({ ...value })).not.toContain(EFFECTIVE_CIRCUIT_SLOT);
  });

  test('P5 attachEffectiveSlot null-normalises the effective board', () => {
    const value = attachEffectiveSlot({ value: 'x' }, 'ir_live_live_mohm', 2, undefined);
    expect(value[EFFECTIVE_CIRCUIT_SLOT].boardId).toBeNull();
  });

  test('P5 rawCircuitSlot: null / "" / undefined board collapse to the same identity', () => {
    const a = rawCircuitSlot('measured_zs_ohm', 3, null);
    const b = rawCircuitSlot('measured_zs_ohm', 3, '');
    const c = rawCircuitSlot('measured_zs_ohm', 3, undefined);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // A different board is a different identity.
    expect(rawCircuitSlot('measured_zs_ohm', 3, 'sub-1')).not.toBe(a);
    // circuit is normalised to string so 3 and '3' match.
    expect(rawCircuitSlot('measured_zs_ohm', '3', null)).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// "Work on Board" hotfix slice 1.5 — encoder / decoder tests
// (slice 1.1c; PLAN.md "Tests in slice 1.5 must cover").
// ---------------------------------------------------------------------------

describe('encodeReadingKey / decodeReadingKey — boardId-bearing Map keys', () => {
  test('round-trips boardId === null', () => {
    const key = encodeReadingKey('Ze_ohms', 1, null);
    const { field, circuit, boardId } = decodeReadingKey(key);
    expect(field).toBe('Ze_ohms');
    expect(circuit).toBe('1');
    expect(boardId).toBeNull();
  });

  test('round-trips boardId === undefined (treated as null)', () => {
    const key = encodeReadingKey('Ze_ohms', 1);
    expect(decodeReadingKey(key)).toEqual({ field: 'Ze_ohms', circuit: '1', boardId: null });
  });

  test('round-trips boardId === "" (empty-string normalisation)', () => {
    const key = encodeReadingKey('Ze_ohms', 1, '');
    expect(decodeReadingKey(key)).toEqual({ field: 'Ze_ohms', circuit: '1', boardId: null });
  });

  test('round-trips boardId === "main"', () => {
    const key = encodeReadingKey('measured_zs_ohm', 5, 'main');
    expect(decodeReadingKey(key)).toEqual({
      field: 'measured_zs_ohm',
      circuit: '5',
      boardId: 'main',
    });
  });

  test('round-trips boardId === "sub-1"', () => {
    const key = encodeReadingKey('Ze_ohms', 1, 'sub-1');
    expect(decodeReadingKey(key)).toEqual({ field: 'Ze_ohms', circuit: '1', boardId: 'sub-1' });
  });

  test('round-trips a boardId of literal "__main__" (no collision with the historical sentinel)', () => {
    // Codex flagged in v2 review: a real board_id of literal "__main__"
    // would collide with a bare-sentinel design. The NUL-bracketed
    // ` __board__ ` separator eliminates the collision.
    const key = encodeReadingKey('Ze_ohms', 1, '__main__');
    expect(decodeReadingKey(key)).toEqual({ field: 'Ze_ohms', circuit: '1', boardId: '__main__' });
  });

  test('rejects boardId containing "::" with TypeError', () => {
    expect(() => encodeReadingKey('Ze_ohms', 1, 'a::b')).toThrow(TypeError);
    expect(() => encodeReadingKey('Ze_ohms', 1, 'kitchen::sub')).toThrow(TypeError);
  });

  test('rejects boardId containing NUL with TypeError', () => {
    expect(() => encodeReadingKey('Ze_ohms', 1, 'bad\u0000id')).toThrow(TypeError);
  });

  test('decodes a legacy 2-part key (no BOARD_TAG_SEP) with boardId=null', () => {
    // Pre-hotfix fixtures or older accumulators that hand-built the Map
    // with the bare `${field}::${circuit}` shape must still decode cleanly.
    const { field, circuit, boardId } = decodeReadingKey('Ze_ohms::3');
    expect(field).toBe('Ze_ohms');
    expect(circuit).toBe('3');
    expect(boardId).toBeNull();
  });

  test('two writes on different boards land in different Map slots (collision-safety regression)', () => {
    // The BLOCKER #1 1.1c regression: a single tool-loop turn writing
    // (field, circuit) on TWO boards must not clobber on Map.set
    // last-write-wins. With the new key shape, both writes survive.
    const w = createPerTurnWrites();
    w.readings.set(encodeReadingKey('Ze_ohms', 1, 'main'), {
      value: '0.35',
      confidence: 1.0,
      source_turn_id: 't1',
      boardId: 'main',
    });
    w.readings.set(encodeReadingKey('Ze_ohms', 1, 'sub-1'), {
      value: '0.42',
      confidence: 1.0,
      source_turn_id: 't1',
      boardId: 'sub-1',
    });
    expect(w.readings.size).toBe(2);
    expect(w.readings.get(encodeReadingKey('Ze_ohms', 1, 'main')).value).toBe('0.35');
    expect(w.readings.get(encodeReadingKey('Ze_ohms', 1, 'sub-1')).value).toBe('0.42');
  });
});

describe('encodeBoardReadingKey / decodeBoardReadingKey', () => {
  test('round-trips field-only keys with boardId === null', () => {
    expect(decodeBoardReadingKey(encodeBoardReadingKey('earth_loop_impedance_ze'))).toEqual({
      field: 'earth_loop_impedance_ze',
      boardId: null,
    });
  });

  test('round-trips field+boardId', () => {
    expect(
      decodeBoardReadingKey(encodeBoardReadingKey('earth_loop_impedance_ze', 'sub-1'))
    ).toEqual({ field: 'earth_loop_impedance_ze', boardId: 'sub-1' });
  });

  test('decodes a legacy field-only key (no separator) with boardId=null', () => {
    expect(decodeBoardReadingKey('earth_loop_impedance_ze')).toEqual({
      field: 'earth_loop_impedance_ze',
      boardId: null,
    });
  });

  test('rejects boardId containing "::"', () => {
    expect(() => encodeBoardReadingKey('field', 'a::b')).toThrow(TypeError);
  });
});
