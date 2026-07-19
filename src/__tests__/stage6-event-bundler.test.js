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
        _confidence: 1,
      },
      {
        text: 'Circuit 2, R1 plus R2 0.6',
        expanded_text: 'Circuit 2, R 1 plus R 2 zero point six',
        field: 'r1_r2_ohm',
        circuit: 2,
        _confidence: 1,
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
        _confidence: 1,
      },
      {
        text: 'PFC 1.5',
        expanded_text: 'PFC one point five',
        field: 'prospective_fault_current',
        circuit: null,
        _confidence: 1,
      },
    ]);
  });

  test('2026-05-29 v2: deny-list — circuit_designation + ocpd_bs_en + address + postcode ALL speak', () => {
    // Field test 2026-05-29 (v2): inspector requested TTS on
    // "absolutely everything that lands in the UI" — addresses too.
    // Policy flipped to deny-list (suppress only internal IDs and
    // metadata). Every UI write now produces TTS.
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
    expect(r.confirmations).toHaveLength(4);
    const fields = new Set(r.confirmations.map((c) => c.field));
    expect(fields).toEqual(new Set(['circuit_designation', 'ocpd_bs_en', 'address', 'postcode']));
  });

  test('audio-first (2026-06-18): low-confidence readings are READ BACK, not skipped', () => {
    // Supersedes the old "low-confidence (<0.8) skipped, mirroring legacy
    // prompt gate" behaviour. A hands-free inspector verifies by ear, so
    // every APPLIED reading is read back regardless of the model's
    // self-reported confidence (the `< 0.5` rollout gate now lives
    // pre-apply in dispatchRecordReading — an un-applied reading never
    // reaches this bundler list). Both readings here are applied, so both
    // are spoken.
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
        _confidence: 1,
      },
      {
        text: 'Circuit 2, R1 plus R2 0.6',
        expanded_text: 'Circuit 2, R 1 plus R 2 zero point six',
        field: 'r1_r2_ohm',
        circuit: 2,
        _confidence: 0.5,
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
        _confidence: 1,
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

  test('audio-first: mirror derivations stay silent; calc writes SPEAK with "calculated as" (F/U-1); all ride the wire', () => {
    // Audio-First invariant 1 exception NARROWED by F/U-1 (2026-07-19):
    // mirror/polarity derivations (derived: true) remain unspoken computed
    // consequences, but calculator writes (::calc::) are explicitly-requested
    // results (the Phase-4 steer reserves the calc tools for explicit compute
    // intent) and now read back with distinct "calculated as" phrasing.
    // Everything still rides extracted_readings / extracted_board_readings
    // so iOS lands the values.
    const readings = new Map([
      // A genuine dictated reading → read back with standard phrasing.
      [encodeReadingKey('r1_r2_ohm', 1), { value: '0.30', confidence: 1.0, source_turn_id: 't1' }],
      // A calc-derived Zs (source_turn_id ::calc::) → read back as calculated.
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.55', confidence: 1.0, source_turn_id: '::calc::calculate_zs' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.boardReadings = new Map([
      // A mirror-derived board reading (derived: true) → NOT read back.
      [
        encodeBoardReadingKey('bonding_conductor_continuity'),
        { value: 'PASS', confidence: 1.0, source_turn_id: 't1', derived: true },
      ],
    ]);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    // All three writes are on the wire.
    const wireFields = new Set(r.extracted_readings.map((e) => e.field));
    expect(wireFields).toEqual(new Set(['r1_r2_ohm', 'measured_zs_ohm']));
    expect(r.extracted_board_readings.map((e) => e.field)).toEqual([
      'bonding_conductor_continuity',
    ]);
    // The dictated reading AND the calc write are read back; the mirror is not.
    expect(r.confirmations).toEqual([
      {
        text: 'Circuit 1, R1 plus R2 0.30',
        expanded_text: 'Circuit 1, R 1 plus R 2 zero point three zero',
        field: 'r1_r2_ohm',
        circuit: 1,
        _confidence: 1,
      },
      {
        text: 'Circuit 1, Zs calculated as 0.55',
        expanded_text: 'Circuit 1, zed S calculated as zero point five five',
        field: 'measured_zs_ohm',
        circuit: 1,
        _confidence: 1,
      },
    ]);
  });

  test('F/U-1: a calculated and a dictated same-field same-value reading do NOT group into one line', () => {
    // Calc-ness is a grouping dimension — a derived value and a meter
    // reading that happen to share a value are different evidentiary claims
    // and must speak separately (with different phrasing).
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.55', confidence: 1.0, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('measured_zs_ohm', 2),
        { value: '0.55', confidence: 1.0, source_turn_id: '::calc::calculate_zs' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations.map((c) => c.text)).toEqual([
      'Circuit 1, Zs 0.55',
      'Circuit 2, Zs calculated as 0.55',
    ]);
  });

  test('F/U-1: a multi-circuit calc fan-out with one shared value groups into ONE calculated line', () => {
    const readings = new Map(
      [1, 2, 3].map((c) => [
        encodeReadingKey('measured_zs_ohm', c),
        { value: '0.55', confidence: 1.0, source_turn_id: '::calc::calculate_zs' },
      ])
    );
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations.map((c) => c.text)).toEqual(['Circuits 1 to 3, Zs calculated as 0.55']);
    expect(r.confirmations[0].circuits).toEqual([1, 2, 3]);
  });

  test('F/U-1: calculate_r1_plus_r2 results speak with the R1 plus R2 friendly name', () => {
    const readings = new Map([
      [
        encodeReadingKey('r1_r2_ohm', 3),
        { value: '0.42', confidence: 1.0, source_turn_id: '::calc::calculate_r1_plus_r2' },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations.map((c) => c.text)).toEqual([
      'Circuit 3, R1 plus R2 calculated as 0.42',
    ]);
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
        _confidence: 1,
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
        _confidence: 1,
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
        _confidence: 1,
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
        _confidence: 1,
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

  test('§A1a (field-feedback-2026-07-14) — telemetry MOVED to the harness: bundler emits NO ios_send_attempt and keeps the _confidence sidecar intact on reading entries', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 0.92, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('spd_bs_en'),
        { value: '1361', confidence: 0.95, source_turn_id: 't1' },
      ],
    ]);
    const infoCalls = [];
    const logger = {
      info: (name, payload) => {
        infoCalls.push([name, payload]);
      },
    };
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      {
        confirmationsEnabled: true,
        turnId: 'sess-X-turn-1',
        sessionId: 'sess-X',
        logger,
      }
    );

    // The bundler is once again a pure projection: even WITH a logger in
    // options, no telemetry rows are emitted here. The harness owns the
    // ios_send_attempt loop (post-filter, post-debounce — see
    // stage6-shadow-harness.js) so rows cover the SURVIVING wire list
    // including circuit_op / observation / field_cleared entries.
    const attempts = infoCalls.filter((c) => c[0] === 'ios_send_attempt');
    expect(attempts).toHaveLength(0);

    // The transient _confidence sidecar stays INTACT on reading entries so
    // the harness telemetry can read it; the harness strips it before the
    // wire (pinned in stage6-shadow-harness-telemetry tests).
    expect(r.confirmations.length).toBeGreaterThan(0);
    const zs = r.confirmations.find((c) => c.field === 'measured_zs_ohm');
    expect(zs._confidence).toBe(0.92);
    const spd = r.confirmations.find((c) => c.field === 'spd_bs_en');
    expect(spd._confidence).toBe(0.95);
  });

  test('§A1a — dedupe_token stamped on the five allowlisted text-op confirmations, absent on measured-value ones', () => {
    const readings = new Map([
      [
        encodeReadingKey('measured_zs_ohm', 1),
        { value: '0.62', confidence: 0.92, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('circuit_designation', 2),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.circuitOps = [
      { op: 'rename', circuit_ref: 4, from_ref: 3, meta: { designation: 'Lights' } },
    ];
    writes.observations = [
      { id: 'obs-1', code: 'C2', text: 'Cracked socket front upstairs bedroom', circuit: 3 },
      { id: 'obs-2', code: 'C3', text: 'Water bond requires re-termination', circuit: null },
    ];
    writes.deletedObservations = [
      { id: 'obs-old-1', reason: 'user_request' },
      { id: 'obs-old-2', reason: 'user_request' },
    ];
    writes.cleared = [{ field: 'r1_r2_ohm', circuit: '3', reason: 'clear_reading' }];
    writes.fieldCorrections = [
      { field: 'r1_r2_ohm', circuit: 3, previous_value: '0.86', reason: 'clear_reading' },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9', sessionId: 'sess-X' }
    );

    // circuit_op → turn + operation identity.
    const opConf = r.confirmations.find((c) => c.field === 'circuit_op');
    expect(opConf.dedupe_token).toBe('circop_turn-9_0_rename_4');

    // observation → observation ID.
    const obs1 = r.confirmations.find((c) => c.field === 'observation' && c.circuit === 3);
    expect(obs1.dedupe_token).toBe('obs_obs-1');

    // Two same-text deletions in one turn → DISTINCT tokens (obs IDs).
    const dels = r.confirmations.filter((c) => c.field === 'observation_deletion');
    expect(dels).toHaveLength(2);
    expect(dels[0].dedupe_token).toBe('obsdel_obs-old-1');
    expect(dels[1].dedupe_token).toBe('obsdel_obs-old-2');
    expect(dels[0].text).toBe(dels[1].text); // identical text — the collision the token fixes

    // field_cleared → {field, circuit, turn}.
    const clr = r.confirmations.find((c) => c.field === 'field_cleared');
    expect(clr.dedupe_token).toBe('clear_r1_r2_ohm_3_turn-9_ord0');

    // circuit_designation → turn + operation identity (stamped in the bundle
    // function — it arrives via synthesiseConfirmations, not the state-change
    // synthesiser).
    const desig = r.confirmations.find((c) => c.field === 'circuit_designation');
    expect(desig.dedupe_token).toBe('desig_2_turn-9');

    // NEGATIVE: measured-value reading confirmations carry NO token.
    const zs = r.confirmations.find((c) => c.field === 'measured_zs_ohm');
    expect(zs).not.toHaveProperty('dedupe_token');
  });

  test('§A2 — outbound field_corrected wire copy is canonicalised (r1_r2_ohm → r1_plus_r2) while perTurnWrites stays RAW', () => {
    const writes = makePerTurnWrites();
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 3,
        field: 'r1_r2_ohm',
        previous_value: '0.86',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-5' }
    );
    // Wire copy speaks the record-APPLY dialect the iOS/web clients map.
    expect(r.field_corrections[0].field).toBe('r1_plus_r2');
    // NEW objects — the internal accumulator keeps the raw dispatcher key
    // (consumed by the same-turn clear+write suppression compare below).
    expect(writes.fieldCorrections[0].field).toBe('r1_r2_ohm');
  });

  test('§A2 — CLEAR_WIRE_EXEMPT: r2_ohm stays RAW on the wire (canonical r2 would mis-clear R1+R2 on build-418)', () => {
    const writes = makePerTurnWrites();
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 2,
        field: 'r2_ohm',
        previous_value: '0.41',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.field_corrections[0].field).toBe('r2_ohm');
  });

  test('§A2 — same-turn clear+record of the same slot still emits ONLY the replacement read-back (suppression regression)', () => {
    // The wire canonicalisation must not break the raw-key suppression
    // compare in synthesiseObservationAndClearedConfirmations: a value
    // REPLACEMENT (clear + record in one turn) speaks the new value once,
    // never "<field> cleared" on top (exactly-once invariant, #31).
    const readings = new Map([
      [encodeReadingKey('r1_r2_ohm', 3), { value: '0.30', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 3,
        field: 'r1_r2_ohm',
        previous_value: '0.86',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-6' }
    );
    const cleared = r.confirmations.filter((c) => c.field === 'field_cleared');
    expect(cleared).toHaveLength(0); // suppressed — the write speaks instead
    const replacement = r.confirmations.filter((c) => c.field === 'r1_r2_ohm');
    expect(replacement).toHaveLength(1);
    // The wire copy is still canonicalised even when the TTS is suppressed.
    expect(r.field_corrections[0].field).toBe('r1_plus_r2');
  });

  test('§A1a Codex r3-#2 — two DISTINCT same-turn designation ops BOTH speak, with distinct ordinal tokens', () => {
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 2),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.designationOps = [
      { circuit: 2, boardId: null, value: 'Lights', confidence: 0.9 },
      { circuit: 2, boardId: null, value: 'Sockets', confidence: 0.95 },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9' }
    );
    const desigs = r.confirmations.filter((c) => c.field === 'circuit_designation');
    expect(desigs).toHaveLength(2);
    expect(desigs[0].dedupe_token).toBe('desig_2_turn-9_ord0');
    expect(desigs[1].dedupe_token).toBe('desig_2_turn-9_ord1');
    expect(desigs[0].text).not.toBe(desigs[1].text);
    // Wire state stays last-write-wins — only the read-backs expand.
    expect(r.extracted_readings.filter((e) => e.field === 'circuit_designation')).toHaveLength(1);
  });

  test('§A1a Codex r5-#2 — same circuit ref on TWO boards: distinct board-scoped tokens, both speak', () => {
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 1, 'board-A'),
        { value: 'Kitchen', confidence: 0.9, source_turn_id: 't1', boardId: 'board-A' },
      ],
      [
        encodeReadingKey('circuit_designation', 1, 'board-B'),
        { value: 'Garage', confidence: 0.9, source_turn_id: 't1', boardId: 'board-B' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.designationOps = [
      { circuit: 1, boardId: 'board-A', value: 'Kitchen', confidence: 0.9 },
      { circuit: 1, boardId: 'board-B', value: 'Garage', confidence: 0.9 },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9' }
    );
    const desigs = r.confirmations.filter((c) => c.field === 'circuit_designation');
    expect(desigs).toHaveLength(2);
    const tokens = desigs.map((c) => c.dedupe_token).sort();
    // Board discriminator in the token — identical tokens here meant the
    // client debounce swallowed the second board's read-back.
    expect(tokens).toEqual(['desig_1_board-A_turn-9', 'desig_1_board-B_turn-9']);
  });

  test('§A1a Codex r5-#2 — repeated writes on ONLY board B: board A single entry intact, B expands per-op', () => {
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 1, 'board-A'),
        { value: 'Kitchen', confidence: 0.9, source_turn_id: 't1', boardId: 'board-A' },
      ],
      [
        encodeReadingKey('circuit_designation', 1, 'board-B'),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1', boardId: 'board-B' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.designationOps = [
      { circuit: 1, boardId: 'board-A', value: 'Kitchen', confidence: 0.9 },
      { circuit: 1, boardId: 'board-B', value: 'Lights', confidence: 0.9 },
      { circuit: 1, boardId: 'board-B', value: 'Sockets', confidence: 0.95 },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9' }
    );
    const desigs = r.confirmations.filter((c) => c.field === 'circuit_designation');
    expect(desigs).toHaveLength(3);
    // Board A's Map-derived entry survives untouched — the board-matched
    // findIndex must NOT let board B's expansion replace it.
    const boardA = desigs.filter((c) => c.board_id === 'board-A');
    expect(boardA).toHaveLength(1);
    expect(boardA[0].dedupe_token).toBe('desig_1_board-A_turn-9');
    // Board B expands to one entry per op with board-scoped ordinal tokens.
    const boardB = desigs.filter((c) => c.board_id === 'board-B');
    expect(boardB.map((c) => c.dedupe_token)).toEqual([
      'desig_1_board-B_turn-9_ord0',
      'desig_1_board-B_turn-9_ord1',
    ]);
  });

  test('§A1a Codex r5-#3 — designation value colliding with another circuit does NOT group: per-circuit entries survive, no __DESIGNATION__ leak', () => {
    // Circuit 1 rewritten Kitchen → Sockets while circuit 2 is also written
    // "Sockets" this turn. Grouping would collapse the two final "Sockets"
    // into a circuit:null roll-up (breaking the per-op expansion lookup so
    // Kitchen never speaks) whose text leaks the '__DESIGNATION__' sentinel.
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 1),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1' },
      ],
      [
        encodeReadingKey('circuit_designation', 2),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.designationOps = [
      { circuit: 1, boardId: null, value: 'Kitchen', confidence: 0.9 },
      { circuit: 1, boardId: null, value: 'Sockets', confidence: 0.95 },
      { circuit: 2, boardId: null, value: 'Sockets', confidence: 0.95 },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9' }
    );
    const desigs = r.confirmations.filter((c) => c.field === 'circuit_designation');
    // Never a grouped circuit:null roll-up for designations.
    expect(desigs.every((c) => Number.isInteger(c.circuit))).toBe(true);
    expect(desigs).toHaveLength(3);
    const c1 = desigs.filter((c) => c.circuit === 1);
    expect(c1.map((c) => c.dedupe_token)).toEqual(['desig_1_turn-9_ord0', 'desig_1_turn-9_ord1']);
    expect(c1[0].text).toContain('Kitchen'); // the overwritten op still speaks
    const c2 = desigs.filter((c) => c.circuit === 2);
    expect(c2).toHaveLength(1);
    expect(c2[0].dedupe_token).toBe('desig_2_turn-9');
    for (const c of r.confirmations) {
      expect(c.text).not.toContain('__DESIGNATION__');
      expect(c.expanded_text ?? '').not.toContain('__DESIGNATION__');
    }
  });

  test('§A1a Codex r1-#5 — two DISTINCT same-slot clears in ONE turn get DISTINCT tokens (turn AND ordinal)', () => {
    const writes = makePerTurnWrites();
    writes.fieldCorrections = [
      { field: 'r1_r2_ohm', circuit: 3, previous_value: '0.86', reason: 'clear_reading' },
      { field: 'r1_r2_ohm', circuit: 3, previous_value: '0.90', reason: 'clear_reading' },
    ];
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-9' }
    );
    const clears = r.confirmations.filter((c) => c.field === 'field_cleared');
    expect(clears).toHaveLength(2);
    expect(clears[0].dedupe_token).toBe('clear_r1_r2_ohm_3_turn-9_ord0');
    expect(clears[1].dedupe_token).toBe('clear_r1_r2_ohm_3_turn-9_ord1');
    expect(clears[0].dedupe_token).not.toBe(clears[1].dedupe_token);
  });

  test('§A1a — no turnId (legacy caller): designation gets NO token; ops/clears fall back to ordinal identity', () => {
    const readings = new Map([
      [
        encodeReadingKey('circuit_designation', 2),
        { value: 'Sockets', confidence: 0.95, source_turn_id: 't1' },
      ],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.fieldCorrections = [
      { field: 'measured_zs_ohm', circuit: 1, previous_value: '0.6', reason: 'clear_reading' },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const desig = r.confirmations.find((c) => c.field === 'circuit_designation');
    // No stable turn identity → no token; clients fall back to the bare key.
    expect(desig).not.toHaveProperty('dedupe_token');
    const clr = r.confirmations.find((c) => c.field === 'field_cleared');
    expect(clr.dedupe_token).toBe('clear_measured_zs_ohm_1_legacy_ord0');
  });
});

describe('bundleToolCallsIntoResult — utterance_id echo (Voice-latency plan 2026-06-05 Phase 2.1)', () => {
  test('options.utteranceId = "abc" → result.utterance_id = "abc"', () => {
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { utteranceId: 'abc' }
    );
    expect(r.utterance_id).toBe('abc');
  });

  test('options.utteranceId omitted → result has no utterance_id key (backwards-compat)', () => {
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), { questions: [] }, {});
    expect('utterance_id' in r).toBe(false);
  });

  test('options.utteranceId = null → result has no utterance_id key (defensive nil)', () => {
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { utteranceId: null }
    );
    expect('utterance_id' in r).toBe(false);
  });

  test('options.utteranceId = "" → result has no utterance_id key (empty-string treated as absent)', () => {
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { utteranceId: '' }
    );
    expect('utterance_id' in r).toBe(false);
  });

  test('utterance_id coexists with turn_id without affecting any other slot', () => {
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({
        readings: new Map([['volts::1', { value: 230, confidence: 0.95, source_turn_id: 't1' }]]),
      }),
      { questions: [] },
      { turnId: 'turn-42', utteranceId: 'utt-abc' }
    );
    expect(r.turn_id).toBe('turn-42');
    expect(r.utterance_id).toBe('utt-abc');
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].value).toBe(230);
  });

  test('non-string utteranceId (number, object) is rejected (defensive — never coerced)', () => {
    const r1 = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { utteranceId: 12345 }
    );
    expect('utterance_id' in r1).toBe(false);
    const r2 = bundleToolCallsIntoResult(
      makePerTurnWrites(),
      { questions: [] },
      { utteranceId: { foo: 'bar' } }
    );
    expect('utterance_id' in r2).toBe(false);
  });
});

// #31 (2026-06-19, session AD0AE9FA, build 404 field test): a value
// *replacement* dictated as a correction ("customer name is Charles Henry")
// is modelled by Sonnet as clear_reading{slot} + record_reading{slot} in ONE
// turn. The clear used to emit a standalone "<field> cleared" confirmation in
// addition to the new value's read-back → the inspector heard the slot
// confirmed twice. Audio-first invariant: every dictated reading read back
// EXACTLY once. The bundler now suppresses the field_cleared confirmation when
// the same turn also WRITES the same field+scope; the new value's read-back is
// the confirmation. A clear with NO same-turn write still speaks "cleared".
describe('bundleToolCallsIntoResult — #31 same-turn clear+write suppression', () => {
  test('board-level replacement: clear client_name + record_board_reading{client_name} in one turn → only the new value spoken, no "customer name cleared"', () => {
    const writes = makePerTurnWrites();
    writes.boardReadings = new Map([
      [
        encodeBoardReadingKey('client_name'),
        { value: 'Charles Henry', confidence: 1.0, source_turn_id: 't1' },
      ],
    ]);
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 0,
        field: 'client_name',
        previous_value: 'Charlie Henry',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    // The new value is read back …
    const clientNameConfirm = r.confirmations.find((c) => c.field === 'client_name');
    expect(clientNameConfirm).toBeDefined();
    expect(clientNameConfirm.text).toContain('Charles Henry');
    // … and the redundant "field_cleared" confirmation is suppressed.
    expect(r.confirmations.some((c) => c.field === 'field_cleared')).toBe(false);
  });

  test('clear WITHOUT a same-turn write still speaks "<field> cleared" (normal clear path unchanged)', () => {
    const writes = makePerTurnWrites();
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 0,
        field: 'client_name',
        previous_value: 'Charlie Henry',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const cleared = r.confirmations.find((c) => c.field === 'field_cleared');
    expect(cleared).toBeDefined();
    expect(cleared.text.toLowerCase()).toContain('cleared');
  });

  test('circuit-scoped: clear r2_ohm c5 + record r2_ohm c5 same turn → cleared suppressed', () => {
    const readings = new Map([
      [encodeReadingKey('r2_ohm', 5), { value: '0.30', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 5,
        field: 'r2_ohm',
        previous_value: '0.40',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations.some((c) => c.field === 'field_cleared')).toBe(false);
  });

  test('scope precision: clear r2_ohm c5 but write r2_ohm c6 → cleared still spoken (different circuit)', () => {
    const readings = new Map([
      [encodeReadingKey('r2_ohm', 6), { value: '0.30', confidence: 1.0, source_turn_id: 't1' }],
    ]);
    const writes = makePerTurnWrites({ readings });
    writes.fieldCorrections = [
      {
        type: 'field_corrected',
        circuit: 5,
        field: 'r2_ohm',
        previous_value: '0.40',
        reason: 'clear_reading',
        board_id: null,
      },
    ];
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations.some((c) => c.field === 'field_cleared')).toBe(true);
  });
});

// Field report 2026-06-24 #6 — the observation read-back was capped at 50 chars
// before TTS synthesis, cutting "…combustible material" to "…combustible m"
// mid-word. Resolved decision #6: speak the FULL body, no cap / no guard.
describe('bundleToolCallsIntoResult — observation TTS speaks the full body (#6)', () => {
  const LONG_BODY =
    'Consumer unit enclosure is made from combustible material and requires upgrade to a non-combustible enclosure';

  test('observation confirmation contains the full body and NO ellipsis (code + text)', () => {
    const writes = makePerTurnWrites({
      observations: [{ code: 'C3', text: LONG_BODY }],
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const obs = r.confirmations.find((c) => c.field === 'observation');
    expect(obs).toBeTruthy();
    // Full body present verbatim …
    expect(obs.text).toBe(`Observation C3 — ${LONG_BODY}`);
    // … and nothing was truncated.
    expect(obs.text.includes('…')).toBe(false);
    expect(obs.text.length).toBeGreaterThan(50 + 'Observation C3 — '.length);
  });

  test('observation confirmation contains the full body and NO ellipsis (text only, no code)', () => {
    const writes = makePerTurnWrites({
      observations: [{ text: LONG_BODY }],
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const obs = r.confirmations.find((c) => c.field === 'observation');
    expect(obs).toBeTruthy();
    expect(obs.text).toBe(`Observation — ${LONG_BODY}`);
    expect(obs.text.includes('…')).toBe(false);
  });
});
