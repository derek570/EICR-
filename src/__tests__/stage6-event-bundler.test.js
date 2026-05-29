/**
 * Stage 6 Phase 2 Plan 02-05 — Event bundler unit tests.
 *
 * REQUIREMENTS: STD-09 + STI-02.
 *
 * Locks three invariants the bundler cannot drift from:
 *   1. Empty perTurnWrites → legacy-only keys (iOS regression guard).
 *   2. Reading entries carry exactly 5 keys (field/circuit/value/confidence/source).
 *   3. Confidence is passed VERBATIM from perTurnWrites (dispatcher owns the
 *      default; bundler must never overwrite).
 */

import { bundleToolCallsIntoResult, BUNDLER_PHASE } from '../extraction/stage6-event-bundler.js';
import { encodeReadingKey, encodeBoardReadingKey } from '../extraction/stage6-per-turn-writes.js';

function makePerTurnWrites(overrides = {}) {
  return {
    readings: overrides.readings ?? new Map(),
    cleared: overrides.cleared ?? [],
    observations: overrides.observations ?? [],
    deletedObservations: overrides.deletedObservations ?? [],
    circuitOps: overrides.circuitOps ?? [],
    boardOps: overrides.boardOps ?? [],
  };
}

describe('bundleToolCallsIntoResult — iOS parity (empty input)', () => {
  test('empty input produces legacy-only keys (iOS regression guard)', () => {
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), { questions: [] });
    expect(Object.keys(r).sort()).toEqual(['extracted_readings', 'observations', 'questions']);
    expect('cleared_readings' in r).toBe(false);
    expect('circuit_updates' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
    expect(r.extracted_readings).toEqual([]);
    expect(r.observations).toEqual([]);
    expect(r.questions).toEqual([]);
  });

  test('pre-populated questions on legacyResultShape are preserved verbatim (deep-equal)', () => {
    const legacyQuestions = [
      { id: 'q1', text: 'What circuit?', priority: 'high' },
      { id: 'q2', text: 'Which board?', priority: 'low' },
    ];
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), { questions: legacyQuestions });
    expect(r.questions).toEqual(legacyQuestions);
  });
});

describe('bundleToolCallsIntoResult — Reading Map projection', () => {
  test('single reading produces one extracted_readings entry with exactly 5 keys', () => {
    const readings = new Map([
      ['volts::C1', { value: 230, confidence: 0.95, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(Object.keys(r.extracted_readings[0]).sort()).toEqual([
      'circuit',
      'confidence',
      'field',
      'source',
      'value',
    ]);
    expect(r.extracted_readings[0]).toEqual({
      field: 'volts',
      circuit: 'C1',
      value: 230,
      confidence: 0.95,
      source: 'tool_call',
    });
  });

  test('multiple readings preserve Map insertion order', () => {
    const readings = new Map();
    readings.set('ze::main', { value: 0.25, confidence: 1.0 });
    readings.set('pfc::main', { value: 1.5, confidence: 1.0 });
    readings.set('volts::C3', { value: 232, confidence: 0.9 });
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings.map((e) => `${e.field}::${e.circuit}`)).toEqual([
      'ze::main',
      'pfc::main',
      'volts::C3',
    ]);
  });

  test('numeric circuit (integer from tool schema) round-trips as integer, not string', () => {
    // Codex Phase-2 review MAJOR #2 fix: the Map key is `${field}::${input.circuit}`
    // so integer circuit_refs get coerced to numeric strings at write time.
    // The bundler must parse the suffix back to an integer when it round-trips
    // cleanly so the wire shape matches legacy (`extracted_readings[].circuit`
    // is typed as integer at eicr-extraction-session.js:992).
    const readings = new Map([
      ['measured_zs_ohm::1', { value: 0.32, confidence: 0.98 }],
      ['measured_zs_ohm::0', { value: 0.28, confidence: 1.0 }], // supply
      ['measured_zs_ohm::-1', { value: 0.41, confidence: 0.9 }], // unassigned
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(3);
    expect(r.extracted_readings[0].circuit).toBe(1);
    expect(typeof r.extracted_readings[0].circuit).toBe('number');
    expect(r.extracted_readings[1].circuit).toBe(0);
    expect(r.extracted_readings[2].circuit).toBe(-1);
  });

  test('non-integer circuit string (future-proof) stays as string', () => {
    // Today the tool schema declares circuit as `integer`, but a future schema
    // that allows lettered refs (e.g. "C1", "MCB-A") must still round-trip
    // losslessly. The parse-guard requires a clean integer round-trip, so
    // non-numeric tails stay string.
    const readings = new Map([
      ['volts::C1', { value: 230, confidence: 1.0 }],
      ['volts::MCB-A', { value: 232, confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings[0].circuit).toBe('C1');
    expect(r.extracted_readings[1].circuit).toBe('MCB-A');
  });

  test('same-turn correction: dispatcher-overwritten Map entry yields verbatim confidence (NOT overwritten to 1.0)', () => {
    // Dispatcher collapsed two writes for volts::C1 into one entry with the LATEST value + confidence.
    const readings = new Map([
      ['volts::C1', { value: 240, confidence: 0.9, source_turn_id: 't2' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].value).toBe(240);
    expect(r.extracted_readings[0].confidence).toBe(0.9); // VERBATIM, not 1.0
  });
});

describe('bundleToolCallsIntoResult — Slot inclusion (per-new-slot tests)', () => {
  test('non-empty cleared → cleared_readings present; other new slots absent', () => {
    const cleared = [{ field: 'volts', circuit: 'C1', reason: 'user_retracted' }];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ cleared }), { questions: [] });
    expect(r.cleared_readings).toEqual(cleared);
    expect('circuit_updates' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
  });

  test('non-empty circuitOps → circuit_updates present; cleared_readings absent', () => {
    const circuitOps = [{ op: 'rename', circuit_ref: 'C2', from_ref: 'C1' }];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ circuitOps }), { questions: [] });
    expect(r.circuit_updates).toEqual(circuitOps);
    expect('cleared_readings' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
  });

  test('non-empty deletedObservations → observation_deletions present; cleared_readings absent', () => {
    const deletedObservations = [{ id: 'obs-1', reason: 'duplicate' }];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ deletedObservations }), {
      questions: [],
    });
    expect(r.observation_deletions).toEqual(deletedObservations);
    expect('cleared_readings' in r).toBe(false);
    expect('circuit_updates' in r).toBe(false);
  });

  // Phase 6.0 — board_ops wire channel slot.
  test('non-empty boardOps → board_ops present; other new slots absent', () => {
    const boardOps = [
      { op: 'add_board', board_id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' },
    ];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ boardOps }), { questions: [] });
    expect(r.board_ops).toEqual(boardOps);
    expect('cleared_readings' in r).toBe(false);
    expect('circuit_updates' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
  });

  test('boardOps preserves discriminated-union shape — add_board / select_board / mark_distribution_circuit pass through verbatim', () => {
    const boardOps = [
      { op: 'add_board', board_id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' },
      { op: 'select_board', board_id: 'sub-1' },
      { op: 'mark_distribution_circuit', circuit_ref: 4, feeds_board_id: 'sub-1' },
    ];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ boardOps }), { questions: [] });
    expect(r.board_ops).toHaveLength(3);
    expect(r.board_ops[0]).toEqual(boardOps[0]);
    expect(r.board_ops[1]).toEqual(boardOps[1]);
    expect(r.board_ops[2]).toEqual(boardOps[2]);
    // Each entry carries an `op` discriminator — locked here so future
    // Phase 6 tools added to the channel must include it.
    for (const entry of r.board_ops) {
      expect(typeof entry.op).toBe('string');
      expect(entry.op).not.toBe('');
    }
  });

  test('boardOps array is a defensive shallow copy — mutating perTurnWrites after bundling does not retroactively alter result', () => {
    const boardOps = [{ op: 'add_board', board_id: 'sub-1', designation: 'DB-2' }];
    const writes = makePerTurnWrites({ boardOps });
    const r = bundleToolCallsIntoResult(writes, { questions: [] });
    // Mutate the source after bundling.
    writes.boardOps.push({ op: 'select_board', board_id: 'sub-1' });
    writes.boardOps[0].designation = 'TAMPERED';
    expect(r.board_ops).toHaveLength(1);
    expect(r.board_ops[0].designation).toBe('DB-2');
  });

  test('omits boardOps slot when accumulator field is missing entirely (older test fixture compat)', () => {
    // Older fixtures may build the accumulator without a boardOps key.
    // The bundler must NOT crash on undefined and must NOT emit the slot.
    const writesNoBoardOps = {
      readings: new Map(),
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
    };
    const r = bundleToolCallsIntoResult(writesNoBoardOps, { questions: [] });
    expect('board_ops' in r).toBe(false);
  });
});

describe('bundleToolCallsIntoResult — iOS compatibility JSON shape regression', () => {
  test('empty perTurnWrites produces key-set equal to legacy (three keys, sorted)', () => {
    const legacy = {
      extracted_readings: [{ field: 'x', circuit: 'C1', value: 1, confidence: 1 }],
      observations: [],
      questions: [],
    };
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), legacy);
    expect(Object.keys(r).sort()).toEqual(['extracted_readings', 'observations', 'questions']);
  });
});

describe('bundleToolCallsIntoResult — Defensive guards', () => {
  test('readings as array (not Map) throws TypeError; missing legacyResultShape defaults questions', () => {
    expect(() =>
      bundleToolCallsIntoResult(
        { readings: [], cleared: [], observations: [], deletedObservations: [], circuitOps: [] },
        { questions: [] }
      )
    ).toThrow(/must be a Map/);

    const r = bundleToolCallsIntoResult(makePerTurnWrites(), undefined);
    expect(r.questions).toEqual([]);

    const r2 = bundleToolCallsIntoResult(makePerTurnWrites(), null);
    expect(r2.questions).toEqual([]);
  });
});

describe('bundleToolCallsIntoResult — sanity', () => {
  test('BUNDLER_PHASE is 2', () => {
    expect(BUNDLER_PHASE).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// "Work on Board" hotfix slice 1.5 — board_id wire emission tests
// (slice 1.1a + 1.1c — bundler reads entry.boardId for the wire-shape and
// decodes Map keys via decodeReadingKey for field/circuit reconstruction).
// ---------------------------------------------------------------------------

describe('bundleToolCallsIntoResult — board_id emission (hotfix slice 1.1a)', () => {
  test('extracted_readings entries carry board_id when dispatcher wrote with explicit boardId', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1, 'sub-1'),
        {
          value: '1.08',
          confidence: 1.0,
          source_turn_id: 't1',
          boardId: 'sub-1',
        },
      ],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0]).toMatchObject({
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '1.08',
      board_id: 'sub-1',
    });
  });

  test('extracted_readings.board_id is omitted when boardId was null/undefined (single-board session, byte-identical to pre-hotfix)', () => {
    const readings = new Map([
      [encodeReadingKey('Ze_ohms', 1), { value: '0.35', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings[0]).not.toHaveProperty('board_id');
  });

  test('extracted_board_readings carries board_id', () => {
    const writes = makePerTurnWrites();
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('earth_loop_impedance_ze', 'sub-1'),
        {
          value: '0.91',
          confidence: 0.95,
          source_turn_id: 't1',
          boardId: 'sub-1',
        },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] });
    expect(r.extracted_board_readings).toHaveLength(1);
    expect(r.extracted_board_readings[0]).toMatchObject({
      field: 'earth_loop_impedance_ze',
      value: '0.91',
      board_id: 'sub-1',
    });
  });

  test('circuit_updates passes board_id through verbatim from circuitOps', () => {
    const writes = makePerTurnWrites({
      circuitOps: [
        { op: 'create', circuit_ref: 5, board_id: 'sub-1', meta: { designation: 'Garage' } },
        { op: 'delete', circuit_ref: 3, board_id: 'sub-1' },
      ],
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] });
    expect(r.circuit_updates).toEqual([
      { op: 'create', circuit_ref: 5, board_id: 'sub-1', meta: { designation: 'Garage' } },
      { op: 'delete', circuit_ref: 3, board_id: 'sub-1' },
    ]);
  });

  test('per-turn collision regression: same circuit ref, same field, written on main AND sub-1 — both survive into extracted_readings', () => {
    // The BLOCKER #1 1.1c regression. Pre-hotfix: Map key was
    // `${field}::${circuit}` so the second write clobbered the first.
    // Post-hotfix: encodeReadingKey embeds boardId so each (board,
    // field, circuit) tuple gets its own slot AND the bundler emits
    // both rows on the wire with distinct board_id.
    const readings = new Map();
    readings.set(encodeReadingKey('Ze_ohms', 1, 'main'), {
      value: '0.35',
      confidence: 1.0,
      source_turn_id: 't1',
      boardId: 'main',
    });
    readings.set(encodeReadingKey('Ze_ohms', 1, 'sub-1'), {
      value: '0.42',
      confidence: 1.0,
      source_turn_id: 't1',
      boardId: 'sub-1',
    });
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(2);
    const byBoard = Object.fromEntries(r.extracted_readings.map((e) => [e.board_id, e.value]));
    expect(byBoard).toEqual({ main: '0.35', 'sub-1': '0.42' });
  });

  test('legacy 2-part key fixture decodes cleanly (pre-hotfix accumulators / older fixtures)', () => {
    // Hand-built Map with the bare-string key (no encodeReadingKey).
    // The decoder must tolerate it and emit a reading WITHOUT board_id.
    const readings = new Map([
      ['Ze_ohms::3', { value: '0.35', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0]).toMatchObject({ field: 'Ze_ohms', circuit: 3, value: '0.35' });
    expect(r.extracted_readings[0]).not.toHaveProperty('board_id');
  });
});

describe('bundleToolCallsIntoResult — confirmations synthesis (Voice toggle)', () => {
  test('opt-out: omits confirmations slot entirely when options absent (byte-identical pre-feature)', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r).not.toHaveProperty('confirmations');
  });

  test('opt-out: omits confirmations slot when options.confirmationsEnabled === false', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: false }
    );
    expect(r).not.toHaveProperty('confirmations');
  });

  test('opt-in: synthesises one confirmation per circuit reading with Circuit N prefix', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
      [encodeReadingKey('r1_r2_ohm', 2), { value: '0.6', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, Zs 0.62',
        expanded_text: 'Circuit 1, zed S zero point six two',
        field: 'measured_zs_ohm',
        circuit: 1,
      },
      {
        text: 'Circuit 2, R1 plus R2 0.6',
        expanded_text: 'Circuit 2, R 1 plus R 2 zero point six',
        field: 'r1_r2_ohm',
        circuit: 2,
      },
    ]);
  });

  test('opt-in: board-level readings (extracted_board_readings) emit without Circuit prefix', () => {
    const writes = makePerTurnWrites();
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('earth_loop_impedance_ze'),
        { value: '0.25', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeBoardReadingKey('prospective_fault_current'),
        { value: '1.5', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations).toEqual([
      {
        text: 'Ze 0.25',
        expanded_text: 'zed E zero point two five',
        field: 'earth_loop_impedance_ze',
        circuit: null,
      },
      {
        text: 'PFC 1.5',
        expanded_text: 'PFC one point five',
        field: 'prospective_fault_current',
        circuit: null,
      },
    ]);
  });

  test('2026-05-29: circuit_designation + ocpd_bs_en now opted into TTS; address/postcode stay suppressed', () => {
    // Field test 2026-05-29: inspector requested TTS feedback on
    // "everything entered" so they can walk away during dictation.
    // circuit_designation, ocpd_bs_en, and the rest of the inspection
    // fields were added to the friendly-name table; address/postcode
    // /PII stay suppressed. This test now verifies the partition rather
    // than the previous "everything outside the core set is filtered".
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 1),
        { value: 'Cooker', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('ocpd_bs_en', 1),
        { value: 'BS EN 60898', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('address'),
        { value: '1 Tilehurst Road', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeBoardReadingKey('postcode'),
        { value: 'RG30 4XW', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    // Two confirmations land — designation + BS-EN — but address/postcode
    // do NOT (still PII-suppressed).
    expect(r.confirmations).toHaveLength(2);
    const fields = new Set(r.confirmations.map((c) => c.field));
    expect(fields).toEqual(new Set(['circuit_designation', 'ocpd_bs_en']));
    expect(fields.has('address')).toBe(false);
    expect(fields.has('postcode')).toBe(false);
  });

  test('opt-in: low-confidence readings (<0.8) are skipped, mirroring legacy prompt gate', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
      [encodeReadingKey('r1_r2_ohm', 2), { value: '0.6', confidence: 0.5, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, Zs 0.62',
        expanded_text: 'Circuit 1, zed S zero point six two',
        field: 'measured_zs_ohm',
        circuit: 1,
      },
    ]);
  });

  test('opt-in: polarity_confirmed=true reads back, polarity_confirmed=false suppresses', () => {
    const readingsTrue = new Map([
      [
        encodeReadingKey('polarity_confirmed', 1),
        { value: 'true', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r1 = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings: readingsTrue }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r1.confirmations).toEqual([
      {
        text: 'Circuit 1, polarity confirmed',
        expanded_text: 'Circuit 1, polarity confirmed',
        field: 'polarity_confirmed',
        circuit: 1,
      },
    ]);

    const readingsFalse = new Map([
      [
        encodeReadingKey('polarity_confirmed', 1),
        { value: 'false', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r2 = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings: readingsFalse }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r2).not.toHaveProperty('confirmations');
  });

  test('legacy passthrough: when legacyResultShape already has confirmations, synthesis is bypassed', () => {
    // Shadow mode invariant — Sonnet prose-JSON already populated the array
    // server-side; the bundler must NOT double-emit by also synthesising.
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const legacy = {
      questions: [],
      confirmations: [{ text: 'Sonnet said this', field: 'measured_zs_ohm', circuit: 1 }],
    };
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), legacy, {
      confirmationsEnabled: true,
    });
    expect(r.confirmations).toEqual([
      { text: 'Sonnet said this', field: 'measured_zs_ohm', circuit: 1 },
    ]);
  });

  test('legacy passthrough: empty legacy.confirmations array still triggers synthesis (fall-through)', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [], confirmations: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, Zs 0.62',
        expanded_text: 'Circuit 1, zed S zero point six two',
        field: 'measured_zs_ohm',
        circuit: 1,
      },
    ]);
  });

  test('legacy passthrough: defensive copy — mutating legacy.confirmations after bundle does not alter result', () => {
    const legacyConfirmations = [{ text: 'original', field: 'measured_zs_ohm', circuit: 1 }];
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [], confirmations: legacyConfirmations },
      { confirmationsEnabled: true }
    );
    legacyConfirmations[0].text = 'mutated';
    expect(r.confirmations[0].text).toBe('original');
  });

  test('Loaded Barrel 1.B: board_id propagates from circuit reading entry to confirmation', () => {
    // Multi-board session: dispatcher set entry.boardId on the per-turn
    // accumulator, decodeReadingKey routes it into extracted_readings as
    // board_id, synthesise should carry it onto the confirmation entry
    // so the iOS cache lookup tuple has the right slot identity.
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1, 'sub-1'),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1', boardId: 'sub-1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, Zs 0.62',
        expanded_text: 'Circuit 1, zed S zero point six two',
        field: 'measured_zs_ohm',
        circuit: 1,
        board_id: 'sub-1',
      },
    ]);
  });

  test('Loaded Barrel 1.B: board_id propagates from board reading entry', () => {
    const writes = makePerTurnWrites();
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('earth_loop_impedance_ze', 'sub-2'),
        { value: '0.25', confidence: 1.0, source_turn_id: 't1', boardId: 'sub-2' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations).toEqual([
      {
        text: 'Ze 0.25',
        expanded_text: 'zed E zero point two five',
        field: 'earth_loop_impedance_ze',
        circuit: null,
        board_id: 'sub-2',
      },
    ]);
  });

  test('Loaded Barrel 4a: result.turn_id emitted when options.turnId supplied', () => {
    const readings = new Map([
      [encodeReadingKey('measured_zs_ohm', 1), { value: '0.62', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'sess-foo-turn-3' }
    );
    expect(r.turn_id).toBe('sess-foo-turn-3');
  });

  test('Loaded Barrel 4a: result.turn_id omitted when options.turnId absent (back-compat)', () => {
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r).not.toHaveProperty('turn_id');
  });

  test('Loaded Barrel 1.B: board_id absent → field omitted (single-board byte-identical)', () => {
    // Pre-hotfix single-board sessions never set entry.boardId. After
    // 1.B the confirmation must NOT carry an empty board_id field, so
    // single-board wire shape stays identical to today.
    const readings = new Map([
      [encodeReadingKey('measured_zs_ohm', 1), { value: '0.62', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations[0]).not.toHaveProperty('board_id');
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, Zs 0.62',
        expanded_text: 'Circuit 1, zed S zero point six two',
        field: 'measured_zs_ohm',
        circuit: 1,
      },
    ]);
  });

  // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 3). New
  // regression test pinning the contract that every emitted confirmation
  // carries `expanded_text`. iOS's `playFastPathAudio` (P1.8) and the
  // bundler-confirmation TTS path will both consume this field verbatim
  // when `regex_fast_v2` is advertised — see Sources/Recording/AlertManager.swift.
  test('Single-round latency P1.3: every confirmation carries expanded_text alongside text', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('earth_loop_impedance_ze'),
        { value: '0.25', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations).toHaveLength(2);
    for (const c of r.confirmations) {
      expect(typeof c.text).toBe('string');
      expect(typeof c.expanded_text).toBe('string');
      expect(c.expanded_text.length).toBeGreaterThan(0);
    }
  });
});
