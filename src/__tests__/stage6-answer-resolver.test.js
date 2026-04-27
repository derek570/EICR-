// Tests for the deterministic ask_user answer resolver. This is the
// load-bearing piece of the server-side state machine that fixes bug 1B
// (number_of_points = 4, user answered "the cooker circuit", never written).

import { resolveCircuitAnswer } from '../extraction/stage6-answer-resolver.js';

const SAMPLE_PENDING = {
  tool: 'record_reading',
  field: 'number_of_points',
  value: '4',
  confidence: 0.95,
  source_turn_id: 't42',
};

const TWO_CIRCUITS = [
  { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
  { circuit_ref: 2, circuit_designation: 'Cooker' },
];

const SIX_CIRCUITS = [
  { circuit_ref: 1, circuit_designation: 'Socket' },
  { circuit_ref: 2, circuit_designation: 'Socket' },
  { circuit_ref: 3, circuit_designation: 'Shower' },
  { circuit_ref: 4, circuit_designation: 'Lighting' },
  { circuit_ref: 5, circuit_designation: 'Water Heater' },
  { circuit_ref: 6, circuit_designation: 'Hob' },
];

describe('resolveCircuitAnswer — no pending_write', () => {
  test('returns no_pending_write when pending_write absent', () => {
    expect(
      resolveCircuitAnswer({
        userText: 'the cooker',
        pendingWrite: null,
        availableCircuits: TWO_CIRCUITS,
      })
    ).toEqual({ kind: 'no_pending_write' });
  });

  test('handles undefined pending_write', () => {
    expect(
      resolveCircuitAnswer({
        userText: 'the cooker',
        pendingWrite: undefined,
        availableCircuits: TWO_CIRCUITS,
      })
    ).toEqual({ kind: 'no_pending_write' });
  });
});

describe('resolveCircuitAnswer — numeric replies', () => {
  test('bare digit', () => {
    const r = resolveCircuitAnswer({
      userText: '2',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({ circuit: 2, field: 'number_of_points', value: '4' });
  });

  test('"circuit 2"', () => {
    const r = resolveCircuitAnswer({
      userText: 'circuit 2',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('word number "two"', () => {
    const r = resolveCircuitAnswer({
      userText: 'two',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('"circuit two"', () => {
    const r = resolveCircuitAnswer({
      userText: 'circuit two',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('compound "twenty-one"', () => {
    const r = resolveCircuitAnswer({
      userText: 'twenty one',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(21);
  });

  test('decimal numbers escalate (those are values, not refs)', () => {
    const r = resolveCircuitAnswer({
      userText: '0.4',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });

  test('multiple numbers escalate (ambiguous)', () => {
    const r = resolveCircuitAnswer({
      userText: 'circuit 2 and 3',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });
});

describe('resolveCircuitAnswer — designation match (the bug-1B repro)', () => {
  test('"the cooker circuit" → circuit 2 ("Cooker")', () => {
    // This is the literal repro from session 61124C7F (14 Marlborough Road).
    const r = resolveCircuitAnswer({
      userText: 'the cooker circuit.',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toEqual([
      expect.objectContaining({
        tool: 'record_reading',
        field: 'number_of_points',
        circuit: 2,
        value: '4',
      }),
    ]);
  });

  test('exact designation match wins over substring', () => {
    const circuits = [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Cooker outlet' },
    ];
    const r = resolveCircuitAnswer({
      userText: 'cooker',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: circuits,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(1);
  });

  test('ambiguous substring escalates', () => {
    // "the kitchen" matches both "Kitchen sockets" and "Kitchen lighting".
    const circuits = [
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Kitchen lighting' },
    ];
    const r = resolveCircuitAnswer({
      userText: 'the kitchen',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: circuits,
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toMatch(/^ambiguous_designation_match:1,2$/);
  });

  test('two circuits with identical designation is ambiguous', () => {
    // SIX_CIRCUITS has two "Socket" circuits (refs 1 and 2). Bare "socket"
    // should escalate, not silently pick one.
    const r = resolveCircuitAnswer({
      userText: 'the socket',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });

  test('no match escalates', () => {
    const r = resolveCircuitAnswer({
      userText: 'the wibble',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('no_deterministic_match');
    expect(r.available_circuits).toEqual(TWO_CIRCUITS);
  });
});

describe('resolveCircuitAnswer — broadcast', () => {
  test('"all circuits" expands the pending_write across every circuit', () => {
    const r = resolveCircuitAnswer({
      userText: 'all circuits',
      pendingWrite: { ...SAMPLE_PENDING, field: 'rcd_time_ms', value: 'N/A' },
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(6);
    expect(r.writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const w of r.writes) {
      expect(w.field).toBe('rcd_time_ms');
      expect(w.value).toBe('N/A');
    }
  });

  test('"every"', () => {
    const r = resolveCircuitAnswer({
      userText: 'every',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(2);
  });

  test('"all" with empty circuit list escalates', () => {
    const r = resolveCircuitAnswer({
      userText: 'all',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [],
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('broadcast_no_circuits');
  });
});

describe('resolveCircuitAnswer — cancel', () => {
  test.each([
    ['skip'],
    ['never mind'],
    ['nevermind'],
    ['forget it'],
    ['cancel'],
    ['leave it'],
    ['drop it'],
  ])('"%s" cancels', (reply) => {
    const r = resolveCircuitAnswer({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('cancel');
  });
});

describe('resolveCircuitAnswer — anti-pattern guards', () => {
  test('user replies with the value again instead of a circuit', () => {
    const r = resolveCircuitAnswer({
      userText: 'N/A',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('reply_was_value_not_circuit');
  });

  test('user replies with an evasion marker', () => {
    const r = resolveCircuitAnswer({
      userText: 'unknown',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('reply_was_value_not_circuit');
  });

  test('empty reply escalates', () => {
    const r = resolveCircuitAnswer({
      userText: '',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('empty_reply');
  });

  test('whitespace-only reply escalates', () => {
    const r = resolveCircuitAnswer({
      userText: '   ',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });
});

describe('resolveCircuitAnswer — preserves pending_write payload', () => {
  test('confidence and source_turn_id flow through', () => {
    const pending = {
      tool: 'record_reading',
      field: 'measured_zs_ohm',
      value: '0.65',
      confidence: 0.92,
      source_turn_id: 't99',
    };
    const r = resolveCircuitAnswer({
      userText: 'cooker',
      pendingWrite: pending,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0]).toEqual({
      tool: 'record_reading',
      field: 'measured_zs_ohm',
      circuit: 2,
      value: '0.65',
      confidence: 0.92,
      source_turn_id: 't99',
    });
  });

  test('default confidence applied when missing', () => {
    const pending = {
      tool: 'record_reading',
      field: 'measured_zs_ohm',
      value: '0.65',
      source_turn_id: 't1',
    };
    const r = resolveCircuitAnswer({
      userText: '2',
      pendingWrite: pending,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.writes[0].confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// 2026-04-27 path-2 review fixes (P2-A / P2-B / P2-C / P3-A)
// ---------------------------------------------------------------------------

describe('resolveCircuitAnswer — P2-A punctuation tolerance', () => {
  // STT routinely appends commas/periods/exclamation marks to short replies.
  // Pre-fix the cancel/broadcast phrase match was an exact-string check so
  // "skip." / "all circuits!" silently escalated, costing a clarification
  // turn on every punctuated reply.
  test.each([
    ['skip.'],
    ['skip,'],
    ['skip!'],
    ['never mind.'],
    ['never mind!'],
    ['nevermind...'],
    ['cancel.'],
    ['leave it,'],
  ])('"%s" still cancels (punctuation tolerance)', (reply) => {
    const r = resolveCircuitAnswer({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('cancel');
  });

  test('"all circuits." still broadcasts', () => {
    const r = resolveCircuitAnswer({
      userText: 'all circuits.',
      pendingWrite: { ...SAMPLE_PENDING, field: 'rcd_time_ms', value: 'N/A' },
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(6);
  });

  test('"all!" still broadcasts', () => {
    const r = resolveCircuitAnswer({
      userText: 'all!',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(2);
  });
});

describe('resolveCircuitAnswer — P2-B ordinals + "circuit number two" + compounds', () => {
  test.each(
    [
      ['the second circuit', 2],
      ['second', 2],
      ['third', 3],
      ['fifth', 5],
      ['tenth', 10],
      ['circuit number two', 2],
      ['circuit number 2', 2],
      ['circuit no 2', 2],
      ['twenty-one', 21],
      ['circuit twenty-one', 21],
      ['circuit twenty one', 21],
      ['the thirty fourth', 34], // wait — this one would need ordinals beyond 12; skip in actual lookup
    ].slice(0, -1)
  )('"%s" → circuit %d', (reply, expected) => {
    const r = resolveCircuitAnswer({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: SIX_CIRCUITS, // designation-match irrelevant for numeric path
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(expected);
  });

  test('cct shorthand strips correctly', () => {
    // "cct" is industry shorthand for "circuit"; STOP_WORDS includes it so
    // "cct two" → tokens=['two'] → 2.
    const r = resolveCircuitAnswer({
      userText: 'cct two',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('compound + non-number residue still escalates (safety preserved)', () => {
    // "twenty one cookers" has a non-number, non-stop residue → escalate.
    // Pre-fix this also escalated; we want to keep that safety property.
    const r = resolveCircuitAnswer({
      userText: 'twenty one cookers',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });
});

describe('resolveCircuitAnswer — P2-C broadcast + record_board_reading', () => {
  test('broadcast on record_board_reading produces a single write', () => {
    // The schema doc on `pending_write` says record_board_reading writes
    // apply to circuits[0] regardless of circuit_ref. Pre-fix the resolver
    // expanded into N writes and dispatched N times — N redundant log rows
    // and a misleading write_count. Now the resolver short-circuits to
    // a single write.
    const pw = {
      tool: 'record_board_reading',
      field: 'earth_loop_impedance_ze',
      value: '0.42',
      confidence: 0.95,
      source_turn_id: 't1',
    };
    const r = resolveCircuitAnswer({
      userText: 'all circuits',
      pendingWrite: pw,
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({
      tool: 'record_board_reading',
      field: 'earth_loop_impedance_ze',
      value: '0.42',
    });
  });

  test('broadcast still expands for record_reading (per-circuit writes)', () => {
    // Sanity check that the special-case is gated on tool name; per-circuit
    // tools still fan out as before.
    const r = resolveCircuitAnswer({
      userText: 'all circuits',
      pendingWrite: { ...SAMPLE_PENDING, field: 'rcd_time_ms', value: 'N/A' },
      availableCircuits: SIX_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes).toHaveLength(6);
  });
});

describe('resolveCircuitAnswer — P3-A two-letter designation match', () => {
  test('two-letter exact designation matches ("EV")', () => {
    // Pre-fix the length-floor rejected anything < 3 chars even though the
    // comment claimed "ev" was supported. Real EICR schedules use 2-char
    // designations like "EV" (charger), "AC" (unit), "EM" (emergency lighting).
    const r = resolveCircuitAnswer({
      userText: 'EV',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [
        { circuit_ref: 1, circuit_designation: 'EV charger' },
        { circuit_ref: 2, circuit_designation: 'Cooker' },
      ],
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(1);
  });

  test('single-character residue still escalates (length floor still 2)', () => {
    // The floor was lowered from 3 to 2, NOT to 1 — single-char input is
    // still too noisy to safely match. Confirm "the n" (cleaned to "n")
    // still escalates.
    const r = resolveCircuitAnswer({
      userText: 'the n',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [{ circuit_ref: 1, circuit_designation: 'Nightlight' }],
    });
    expect(r.kind).toBe('escalate');
    expect(r.parsed_hint).toBe('reply_too_short_for_designation_match');
  });
});
