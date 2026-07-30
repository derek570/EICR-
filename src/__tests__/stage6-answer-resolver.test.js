// Tests for the deterministic ask_user answer resolver. This is the
// load-bearing piece of the server-side state machine that fixes bug 1B
// (number_of_points = 4, user answered "the cooker circuit", never written).

import {
  isMultiDescriptionAnswerText,
  resolveCircuitAnswer,
  resolveMultiDescriptionFollowup,
} from '../extraction/stage6-answer-resolver.js';

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

  // 2026-04-29 — STT routinely terminates short answers with a sentence
  // period ("circuit 2."). Pre-fix, the digit-match regex's decimal-rejection
  // lookahead `(?![\d.])` treated the trailing "." as a decimal separator
  // and rejected the whole match, escalating instead of auto-resolving.
  // Field-test session 17C4135E (job_1777459894020) lost a 299 MΩ live-to-
  // earth IR reading partly because of this gap (the classifier hit it
  // first on the same input, but the resolver had the same blind spot —
  // the user could have arrived here via a different route and lost the
  // answer the same way).
  test('"circuit 2." (trailing period) auto-resolves (2026-04-29 fix)', () => {
    const r = resolveCircuitAnswer({
      userText: 'circuit 2.',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('"2." (bare digit + period) auto-resolves', () => {
    const r = resolveCircuitAnswer({
      userText: '2.',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(2);
  });

  test('"0.4" still escalates after trailing-period fix (decimal guard intact)', () => {
    // Regression guard: the trailing-strip must NOT relax the decimal
    // rejection. "0.4" has the dot mid-string, not trailing — the strip
    // leaves it untouched and the digit regex's internal `(?![\d.])` /
    // `[^\d.]` guards still reject.
    const r = resolveCircuitAnswer({
      userText: '0.4',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: TWO_CIRCUITS,
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

// §C1 (field-feedback-2026-07-14, Derek Q1 decision: prompt + conservative
// fuzzy matcher) — length-aware Levenshtein pass in matchDesignation, exact +
// substring having both missed. Budget: d0 for normalised length <=3, d<=1 at
// length 4, d<=2 above 4 (BOTH sides constrain via the shorter length), plus
// a STRICT best-match margin (tie → no match). Ask-ANSWER path only.
describe('resolveCircuitAnswer — §C1 conservative fuzzy designation match', () => {
  const CIRCUITS = [
    { circuit_ref: 1, circuit_designation: 'Upstairs Lights' },
    { circuit_ref: 2, circuit_designation: 'Cooker' },
    { circuit_ref: 3, circuit_designation: 'Water Heater' },
  ];

  test('plural variant matches ("upstairs light" → Upstairs Lights)', () => {
    const r = resolveCircuitAnswer({
      userText: 'the upstairs light',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(1);
  });

  test('one-typo variant matches ("upstars lights")', () => {
    const r = resolveCircuitAnswer({
      userText: 'upstars lights',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: CIRCUITS,
    });
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(1);
  });

  test('NEGATIVE: unrelated short labels never cross-match (EV vs EM vs AC)', () => {
    const shortCircuits = [
      { circuit_ref: 1, circuit_designation: 'EV' },
      { circuit_ref: 2, circuit_designation: 'EM' },
      { circuit_ref: 3, circuit_designation: 'AC' },
    ];
    // "EM" must match ONLY circuit 2 (exact), never fuzzy onto EV/AC…
    const exact = resolveCircuitAnswer({
      userText: 'EM',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: shortCircuits,
    });
    expect(exact.kind).toBe('auto_resolve');
    expect(exact.writes[0].circuit).toBe(2);
    // …and a near-miss short token ("EB" — distance 1 from both EV and EM)
    // stays unmatched: length <=3 demands distance 0.
    const nearMiss = resolveCircuitAnswer({
      userText: 'EB',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: shortCircuits,
    });
    expect(nearMiss.kind).toBe('escalate');
  });

  test('phonetic garbles stay unresolvable ("auto feature" vs Water Heater) → escalate, never guess', () => {
    const r = resolveCircuitAnswer({
      userText: 'auto feature',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: CIRCUITS,
    });
    expect(r.kind).toBe('escalate');
  });

  test('margin rule: two designations equally close → no fuzzy match (tie loses)', () => {
    const r = resolveCircuitAnswer({
      userText: 'heater',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [
        { circuit_ref: 1, circuit_designation: 'Heaters' }, // d1 after normalise → d0… exact via plural
        { circuit_ref: 2, circuit_designation: 'Heated' },
      ],
    });
    // "heater" normalises; "Heaters" singularises to "heater" (d0) while
    // "Heated" is d1 — margin holds, best wins.
    expect(r.kind).toBe('auto_resolve');
    expect(r.writes[0].circuit).toBe(1);
    const tie = resolveCircuitAnswer({
      userText: 'heatex',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [
        { circuit_ref: 1, circuit_designation: 'Heater' },
        { circuit_ref: 2, circuit_designation: 'Heated' },
      ],
    });
    // "heatex" is d1 from BOTH → strict-margin fail → escalate.
    expect(tie.kind).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// PLAN-2B §3.3 — multi-description resolution (feedback id 104)
// ---------------------------------------------------------------------------

const MULTI_DESCRIPTION_CIRCUITS = [
  { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
  { circuit_ref: 2, circuit_designation: 'First floor lighting' },
  { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
  { circuit_ref: 4, circuit_designation: 'Kitchen and utility lights' },
  { circuit_ref: 5, circuit_designation: 'Upstairs Lights' },
];

function resolveMulti(reply, circuits = MULTI_DESCRIPTION_CIRCUITS) {
  return resolveCircuitAnswer({
    userText: reply,
    pendingWrite: {
      ...SAMPLE_PENDING,
      field: 'measured_zs_ohm',
      value: '0.42',
    },
    availableCircuits: circuits,
    contextBoardId: 'board-main',
  });
}

describe('resolveCircuitAnswer — PLAN-2B multi-description fan-out', () => {
  test.each([
    '2 lighting circuits and the smoke alarm',
    'the two lighting circuits and the smoke alarm',
    "I said it's for 2 lighting circuits and the smoke alarm",
  ])('verbatim id-104 shape "%s" resolves all three targets', (reply) => {
    const verdict = resolveMulti(reply);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [1, 2, 3],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
    expect(
      verdict.writes.every(
        (write) =>
          write.field === 'measured_zs_ohm' &&
          write.value === '0.42' &&
          write.board_id === 'board-main'
      )
    ).toBe(true);
  });

  test('a quantified circuit noun bounds maximum coverage before the following target', () => {
    const verdict = resolveMulti('2 lighting circuits and smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
      { circuit_ref: 2, circuit_designation: 'First floor lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
      { circuit_ref: 4, circuit_designation: 'Lighting and Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [1, 2, 3],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
  });

  test('a raw exact whole designation still owns a quantified-looking reply', () => {
    const verdict = resolveMulti('2 lighting circuits and smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
      { circuit_ref: 2, circuit_designation: 'First floor lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
      { circuit_ref: 9, circuit_designation: '2 Lighting Circuits and Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [9],
      unresolved: [],
    });
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 9 })]);
  });

  test('a designation containing "and" stays whole under maximum coverage', () => {
    const verdict = resolveMulti('Kitchen and utility lights');
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.selected_circuit_refs).toEqual([4]);
    expect(verdict.writes).toEqual([
      expect.objectContaining({
        circuit: 4,
        field: 'measured_zs_ohm',
        value: '0.42',
      }),
    ]);
  });

  test.each(['Cooker and Hob', 'Cooker plus Hob', 'Cooker, Hob', 'Cooker & Hob', 'Cooker + Hob'])(
    'whole designation separator variant "%s" resolves before component segmentation',
    (reply) => {
      const verdict = resolveMulti(reply, [
        { circuit_ref: 1, circuit_designation: 'Cooker' },
        { circuit_ref: 2, circuit_designation: 'Hob' },
        { circuit_ref: 3, circuit_designation: 'Cooker & Hob' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: [3],
        unresolved: [],
      });
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    }
  );

  test('a non-unique canonical whole designation asks before component segmentation', () => {
    const verdict = resolveMulti('Cooker plus Hob', [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Hob' },
      { circuit_ref: 3, circuit_designation: 'Cooker & Hob' },
      { circuit_ref: 4, circuit_designation: 'Cooker and Hob' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'ambiguous_designation_match:3,4',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test('an embedded composite designation is protected before resolving its sibling', () => {
    const verdict = resolveMulti('Cooker plus Hob and Smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Hob' },
      { circuit_ref: 3, circuit_designation: 'Cooker & Hob' },
      { circuit_ref: 4, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [3, 4],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([3, 4]);
  });

  test('a stored plus-symbol composite resolves inside a longer target list', () => {
    const verdict = resolveMulti('Cooker and Hob plus Smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Hob' },
      { circuit_ref: 3, circuit_designation: 'Cooker + Hob' },
      { circuit_ref: 4, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [3, 4],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([3, 4]);
  });

  test('an ambiguous embedded canonical composite stays whole and asks', () => {
    const verdict = resolveMulti('Cooker plus Hob and Smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Hob' },
      { circuit_ref: 3, circuit_designation: 'Cooker & Hob' },
      { circuit_ref: 4, circuit_designation: 'Cooker + Hob' },
      { circuit_ref: 5, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'ask',
        reason: 'ambiguous_match',
        candidates: [3, 4],
      }),
    ]);
  });

  test('separator words remain separate targets when no composite designation exists', () => {
    const verdict = resolveMulti('Cooker plus Hob and Smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Cooker' },
      { circuit_ref: 2, circuit_designation: 'Hob' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [1, 2, 3],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
  });

  test.each([
    'Kitchen and utility lights I think',
    'I think Kitchen and utility lights',
    'Kitchen and utility lights, thanks',
  ])('bounded wrappers in "%s" are removed before whole-designation matching', (reply) => {
    const verdict = resolveMulti(reply, [
      { circuit_ref: 1, circuit_designation: 'Kitchen' },
      { circuit_ref: 4, circuit_designation: 'Kitchen and utility lights' },
      { circuit_ref: 6, circuit_designation: 'Utility lights' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      unresolved: [],
    });
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 4 })]);
  });

  test.each([
    ['circuit 2, please', 2],
    ['circuit 3 and done', 3],
    ['circuit 2, I think', 2],
  ])('scalar filler in "%s" stays on the shipped scalar path', (reply, ref) => {
    const verdict = resolveMulti(reply);
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: ref })]);
    expect(verdict.match_status).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test('designation filler never becomes a false target', () => {
    const verdict = resolveMulti('the smoke alarm and yeah');
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      unresolved: [],
    });
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
  });

  test.each(['Right', 'OK', 'Done'])(
    'server-owned filler-like designation "%s" matches before filler removal',
    (designation) => {
      const verdict = resolveMulti(`Smoke Alarm and ${designation}`, [
        { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
        { circuit_ref: 6, circuit_designation: designation },
      ]);
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: [3, 6],
        unresolved: [],
      });
      expect(verdict.writes.map((write) => write.circuit)).toEqual([3, 6]);
    }
  );

  test.each(['right', 'ok', 'done'])(
    'true conversational filler "%s" remains ignored without a census owner',
    (filler) => {
      const verdict = resolveMulti(`Smoke Alarm and ${filler}`, [
        { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: [3],
        unresolved: [],
      });
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    }
  );

  test.each(["Kitchen sockets and that's all", 'Kitchen sockets and that is all'])(
    'terminal conversational filler in "%s" never becomes a no-match span',
    (reply) => {
      const verdict = resolveMulti(reply, [
        { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
        { circuit_ref: 2, circuit_designation: 'Cooker' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: [1],
        unresolved: [],
      });
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 1 })]);
    }
  );

  test.each([
    'it is Kitchen and utility lights',
    'I mean Kitchen and utility lights',
    "Sorry, I mean it's for Kitchen and utility lights",
  ])('the bounded lead-in in "%s" does not split an internal "and"', (reply) => {
    const verdict = resolveMulti(reply);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      unresolved: [],
    });
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 4 })]);
  });

  test('a whole designation cannot swallow a residual unmatched span', () => {
    const verdict = resolveMulti('Kitchen and utility lights and the attic circuit');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 4 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 2,
        span_kind: 'segment_ordinal',
        disposition: 'notice',
        reason: 'no_match',
      }),
    ]);
  });

  test('an explicit circuit ref can share a multi-target list with a designation', () => {
    const verdict = resolveMulti('circuit 2 and the smoke alarm');
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.match_status).toBe('full');
    expect(verdict.writes.map((write) => write.circuit)).toEqual([2, 3]);
  });

  test('digit-bearing prose is not reinterpreted as a mixed-list circuit ref', () => {
    const verdict = resolveMulti('Flat 2 sockets and Smoke Alarm', [
      { circuit_ref: 2, circuit_designation: 'First floor lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      selected_circuit_refs: [3],
      writes: [expect.objectContaining({ circuit: 3 })],
      unresolved: [
        expect.objectContaining({
          identity: 1,
          span_kind: 'segment_ordinal',
          disposition: 'notice',
          reason: 'no_match',
        }),
      ],
    });
    expect(verdict.writes).not.toContainEqual(expect.objectContaining({ circuit: 2 }));
  });

  test('an exact digit-bearing designation wins before the bounded list-ref grammar', () => {
    const verdict = resolveMulti('Bedroom 2 and Smoke Alarm', [
      { circuit_ref: 2, circuit_designation: 'First floor lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
      { circuit_ref: 7, circuit_designation: 'Bedroom 2' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [3, 7],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([7, 3]);
  });

  test('bare "circuit 2" remains on the shipped scalar path', () => {
    const verdict = resolveMulti('circuit 2');
    expect(verdict).toEqual({
      kind: 'auto_resolve',
      writes: [
        expect.objectContaining({
          circuit: 2,
          field: 'measured_zs_ohm',
          value: '0.42',
        }),
      ],
    });
  });

  test('a single numeric target with a negation qualifier remains on the scalar path', () => {
    const verdict = resolveMulti('circuit 3 without the RCD');
    expect(verdict).toEqual({
      kind: 'auto_resolve',
      writes: [
        expect.objectContaining({
          circuit: 3,
          field: 'measured_zs_ohm',
          value: '0.42',
        }),
      ],
    });
  });

  test.each([
    'not circuit 3',
    'do not use circuit 3',
    'except circuit 3',
    'except for circuit 3',
    'rather than circuit 3',
    'instead circuit 3',
    'instead of circuit 3',
    'exclude circuit 3',
    'excluding circuit 3',
    'without circuit 3',
    'leave out circuit 3',
    'no circuit 3',
    'wait, circuit 3',
    'not. circuit 3',
  ])('leading numeric-target correction "%s" fails closed', (reply) => {
    const verdict = resolveMulti(reply);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test.each(['not 3', 'without three'])(
    'leading correction with bare numeric target "%s" fails closed',
    (reply) => {
      const verdict = resolveMulti(reply);
      expect(verdict).toMatchObject({
        kind: 'escalate',
        parsed_hint: 'multi_description_correction_or_negation',
      });
      expect(verdict.writes).toBeUndefined();
      expect(verdict.unresolved).toBeUndefined();
    }
  );

  test.each([
    'I mean not circuit 3',
    'actually… except for 3',
    "it's for instead of three",
    'Sorry, wait, circuit 3',
  ])('wrapped leading correction "%s" still fails closed', (reply) => {
    const verdict = resolveMulti(reply);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test.each([
    "— maybe I didn't mean circuit 3 —",
    "“Perhaps — I don't want the cooker.”",
    '... probably — I do not use circuit 3 ...',
    '(sorry — I did not put the cooker)',
    '— I don’t pick circuit 3 —',
    'I said not circuit 3',
    'I said do not use circuit 3',
  ])(
    'outer punctuation, hedges, and negative auxiliary retraction in "%s" fail closed',
    (reply) => {
      const verdict = resolveMulti(reply, [
        { circuit_ref: 2, circuit_designation: 'Cooker' },
        { circuit_ref: 3, circuit_designation: 'Upstairs Lights' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'escalate',
        parsed_hint: 'multi_description_correction_or_negation',
      });
      expect(verdict.writes).toBeUndefined();
      expect(verdict.unresolved).toBeUndefined();
    }
  );

  test('a wrapped retraction is rejected before multi-description segmentation', () => {
    const verdict = resolveMulti("— maybe I didn't mean Kitchen sockets and the cooker —", [
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Cooker' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
    });
    expect(verdict.writes).toBeUndefined();
  });

  test('whole-reply C1 fuzzy still resolves one circuit', () => {
    const verdict = resolveMulti('upstars lights');
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 5 })]);
  });

  test('a near-spelling in a quantified span never fans out', () => {
    const verdict = resolveMulti('2 upstars lights circuits and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 5,
        span_kind: 'circuit_ref',
        disposition: 'ask',
        reason: 'fuzzy_match',
        candidates: [5],
      }),
    ]);
  });

  test('a quantified fuzzy ask preserves the spoken clarification capacity', () => {
    const verdict = resolveMulti('2 upstars lights circuits');
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      writes: [],
      unresolved: [
        expect.objectContaining({
          segment_ordinal: 1,
          disposition: 'ask',
          reason: 'fuzzy_match',
          candidates: [5],
          required_count: 2,
        }),
      ],
    });
  });

  test('quantifier count mismatch asks and never guesses', () => {
    const verdict = resolveMulti('3 lighting circuits and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'ask',
        reason: 'quantifier_count_mismatch',
        candidates: [1, 2],
      }),
    ]);
  });

  test('a matching count promotes every distinct substring match', () => {
    const verdict = resolveMulti('2 kitchen circuits and the smoke alarm', [
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Kitchen lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
  });

  test.each([
    'twenty one kitchen lighting circuits',
    'twenty-one kitchen lighting circuits',
    'all twenty one kitchen lighting circuits',
    'all twenty-one kitchen lighting circuits',
  ])('compound count in "%s" fans out to all 21 exact/substring candidates', (reply) => {
    const circuits = Array.from({ length: 21 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Kitchen lighting ${index + 1}`,
    }));
    const verdict = resolveMulti(reply, circuits);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: Array.from({ length: 21 }, (_, index) => index + 1),
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1)
    );
  });

  test('a hyphenated twenty-two quantifier fans out to 22 candidates', () => {
    const circuits = Array.from({ length: 22 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Kitchen lighting ${index + 1}`,
    }));
    const verdict = resolveMulti('twenty-two kitchen lighting circuits', circuits);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: Array.from({ length: 22 }, (_, index) => index + 1),
      unresolved: [],
    });
    expect(verdict.writes).toHaveLength(22);
  });

  test('all twenty-one asks for the missing candidate instead of accepting 20', () => {
    const circuits = Array.from({ length: 20 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Kitchen lighting ${index + 1}`,
    }));
    const verdict = resolveMulti('all twenty-one kitchen lighting circuits', circuits);
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      match_status: 'partial',
      writes: [],
      unresolved: [
        expect.objectContaining({
          disposition: 'ask',
          reason: 'quantifier_count_mismatch',
          candidates: Array.from({ length: 20 }, (_, index) => index + 1),
          required_count: 21,
        }),
      ],
    });
  });

  test.each(['twenty ten', 'twenty nineteen'])(
    'malformed compound count "%s" never becomes a fan-out count',
    (count) => {
      const circuits = Array.from({ length: 30 }, (_, index) => ({
        circuit_ref: index + 1,
        circuit_designation: `Kitchen lighting ${index + 1}`,
      }));
      const verdict = resolveMulti(`${count} kitchen lighting circuits`, circuits);
      expect(verdict.kind).toBe('escalate');
      expect(verdict.writes).toBeUndefined();
    }
  );

  test.each([
    'twenty ten kitchen lighting circuits',
    'twenty-ten kitchen lighting circuits',
    'twenty-10 kitchen lighting circuits',
    '2 3 kitchen lighting circuits',
    'one two kitchen lighting circuits',
    'all twenty nineteen kitchen lighting circuits',
    'all twenty-nineteen kitchen lighting circuits',
    'all twenty-10 kitchen lighting circuits',
  ])('malformed attached count in "%s" escalates before exact substring fallthrough', (reply) => {
    const verdict = resolveMulti(reply, [
      { circuit_ref: 1, circuit_designation: 'Kitchen lighting' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_malformed_quantifier',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test('a malformed count remains terminal across an internal designation separator', () => {
    for (const reply of [
      'twenty ten kitchen and utility lights circuits',
      'twenty-10 kitchen and utility lights circuits',
    ]) {
      const verdict = resolveMulti(reply, [
        { circuit_ref: 1, circuit_designation: 'Kitchen and utility lights' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'escalate',
        parsed_hint: 'multi_description_malformed_quantifier',
      });
      expect(verdict.writes).toBeUndefined();
      expect(verdict.unresolved).toBeUndefined();
    }
  });

  test('a malformed numeric follower cannot degrade into a standalone TENS fan-out', () => {
    const circuits = Array.from({ length: 20 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Ten kitchen lighting ${index + 1}`,
    }));
    const verdict = resolveMulti('twenty ten kitchen lighting circuits', circuits);
    expect(verdict.kind).toBe('escalate');
    expect(verdict.writes).toBeUndefined();
  });

  test('a standalone twenty quantifier remains a count of 20', () => {
    const circuits = Array.from({ length: 20 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Kitchen lighting ${index + 1}`,
    }));
    const verdict = resolveMulti('twenty kitchen lighting circuits', circuits);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: Array.from({ length: 20 }, (_, index) => index + 1),
      unresolved: [],
    });
    expect(verdict.writes).toHaveLength(20);
  });

  test.each([
    ['one circuit', 1],
    ['1 circuit', 1],
    ['two circuits', 2],
    ['twenty-one circuit', 21],
  ])('empty-residue attached count "%s" stays on the shipped scalar path', (reply, ref) => {
    const verdict = resolveMulti(reply);
    expect(verdict).toEqual({
      kind: 'auto_resolve',
      writes: [expect.objectContaining({ circuit: ref })],
    });
  });

  test.each(['all 3 circuits', 'all three circuits', 'both circuits'])(
    'broadcast-like empty-residue quantifier "%s" never collapses to one scalar circuit',
    (reply) => {
      const verdict = resolveMulti(reply);
      expect(verdict).toMatchObject({
        kind: 'escalate',
        match_status: 'all_unmatched',
      });
      expect(verdict.writes).toBeUndefined();
    }
  );

  test('a count with a real designation residue still fans out', () => {
    const verdict = resolveMulti('2 lighting circuits');
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [1, 2],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2]);
  });

  test.each(['Two Lighting Circuits', 'Twenty-One Lighting Circuits'])(
    'exact count-looking stored designation "%s" owns the raw reply',
    (designation) => {
      const verdict = resolveMulti(designation, [
        { circuit_ref: 7, circuit_designation: designation },
        { circuit_ref: 8, circuit_designation: 'Emergency Lighting' },
      ]);
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: [7],
        unresolved: [],
      });
      expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 7 })]);
    }
  );

  test('an exact count-looking span wins before quantifier stripping inside a list', () => {
    const verdict = resolveMulti('Two Lighting Circuits and Smoke Alarm', [
      { circuit_ref: 7, circuit_designation: 'Two Lighting Circuits' },
      { circuit_ref: 8, circuit_designation: 'Ground Floor Lighting' },
      { circuit_ref: 9, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [7, 9],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([7, 9]);
  });

  test('a shorter raw exact count-looking span outranks a longer stripped exact candidate', () => {
    const verdict = resolveMulti('Two Lighting Circuits and Smoke Alarm', [
      { circuit_ref: 7, circuit_designation: 'Two Lighting Circuits' },
      { circuit_ref: 8, circuit_designation: 'Lighting and Smoke Alarm' },
      { circuit_ref: 9, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [7, 9],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([7, 9]);
  });

  test('duplicate exact count-looking designations ask rather than fan out', () => {
    const verdict = resolveMulti('Two Lighting Circuits and Smoke Alarm', [
      { circuit_ref: 6, circuit_designation: 'Two Lighting Circuits' },
      { circuit_ref: 7, circuit_designation: 'Two Lighting Circuits' },
      { circuit_ref: 9, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      writes: [expect.objectContaining({ circuit: 9 })],
      unresolved: [
        expect.objectContaining({
          disposition: 'ask',
          reason: 'ambiguous_match',
          candidates: [6, 7],
        }),
      ],
    });
  });

  test.each([
    'all lighting circuits and the smoke alarm',
    '2 lighting circuits and the smoke alarm',
  ])('quantified exact-plus-substring census in "%s" fans out to the deduped union', (reply) => {
    const verdict = resolveMulti(reply, [
      { circuit_ref: 1, circuit_designation: 'Lighting' },
      { circuit_ref: 2, circuit_designation: 'Emergency lighting' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
  });

  test('scalar designation matching keeps exact precedence over substring candidates', () => {
    const verdict = resolveMulti('Lighting', [
      { circuit_ref: 1, circuit_designation: 'Lighting' },
      { circuit_ref: 2, circuit_designation: 'Emergency lighting' },
    ]);
    expect(verdict).toEqual({
      kind: 'auto_resolve',
      writes: [expect.objectContaining({ circuit: 1 })],
    });
  });

  test('unquantified multi-match asks while an exact sibling survives', () => {
    const verdict = resolveMulti('lighting and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'ask',
        reason: 'ambiguous_match',
        candidates: [1, 2],
      }),
    ]);
  });

  test('one unmatched description becomes a notice disposition beside a write', () => {
    const verdict = resolveMulti('the attic circuit and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.match_status).toBe('partial');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'notice',
        reason: 'no_match',
        scope: {
          tool: 'record_reading',
          field: 'measured_zs_ohm',
          board_id: 'board-main',
        },
      }),
    ]);
  });

  test('multiple unmatched descriptions retain stable one-based ordinals', () => {
    const verdict = resolveMulti('the attic circuit, the garage circuit, and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'notice',
      }),
      expect.objectContaining({
        identity: 2,
        span_kind: 'segment_ordinal',
        disposition: 'notice',
      }),
    ]);
  });

  test('all-unmatched escalates and does not claim partial success', () => {
    const verdict = resolveMulti('the attic circuit and the garage circuit');
    expect(verdict).toMatchObject({
      kind: 'escalate',
      match_status: 'all_unmatched',
      parsed_hint: 'multi_description_all_unmatched',
      unresolved: [
        expect.objectContaining({ disposition: 'notice', identity: 1 }),
        expect.objectContaining({ disposition: 'notice', identity: 2 }),
      ],
    });
    expect(verdict.writes).toBeUndefined();
  });

  test('mixed fuzzy and no-match retains ask/notice dispositions independently', () => {
    const verdict = resolveMulti('upstars lights and the attic circuit');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.writes).toEqual([]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        disposition: 'ask',
        reason: 'fuzzy_match',
        identity: 5,
      }),
      expect.objectContaining({
        disposition: 'notice',
        reason: 'no_match',
        identity: 2,
      }),
    ]);
  });

  test.each([
    'Kitchen sockets and not the cooker',
    'Kitchen sockets, no, cooker',
    'not the cooker',
    'scratch that',
    'forget that',
    'correction',
    'make that the cooker',
    'Actually scratch that',
    'Kitchen sockets and correction, the cooker',
    "don't use the cooker",
    'do not use the cooker',
    'exclude the cooker',
    'excluding the cooker',
    'without the cooker',
    'leave out the cooker',
  ])('corrective or negated answer "%s" explicitly escalates before scalar matching', (reply) => {
    const verdict = resolveMulti(reply, [
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Cooker' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test.each([
    'all circuits apart from the smoke alarm',
    'all circuits all but the smoke alarm',
    'Kitchen sockets and Cooker, apart from Cooker',
  ])('subtractive target phrase "%s" fails closed before fan-out', (reply) => {
    const verdict = resolveMulti(reply, [
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Cooker' },
      { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test('a negated designation fails closed even when it is the only census target', () => {
    const verdict = resolveMulti('not the cooker', [
      { circuit_ref: 2, circuit_designation: 'Cooker' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
      available_circuits: [{ circuit_ref: 2, circuit_designation: 'Cooker' }],
    });
    expect(verdict.writes).toBeUndefined();
  });

  test('an absent explicit ref uses the trusted segment ordinal, never the dictated ref', () => {
    const verdict = resolveMulti('circuit 99 and the smoke alarm');
    expect(verdict.kind).toBe('partial_resolve');
    expect(verdict.selected_circuit_refs).toEqual([3]);
    expect(verdict.writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(verdict.unresolved).toEqual([
      expect.objectContaining({
        identity: 1,
        span_kind: 'segment_ordinal',
        disposition: 'notice',
        reason: 'no_match',
      }),
    ]);
  });

  test.each(['circuits 1 and 2', 'both circuit 1 and circuit 2', 'two circuits 1 and 2'])(
    'explicit ref list "%s" keeps the shipped zero-write escalation contract',
    (reply) => {
      const verdict = resolveMulti(reply);
      expect(verdict).toMatchObject({ kind: 'escalate' });
      expect(verdict.writes).toBeUndefined();
      expect(verdict.unresolved).toBeUndefined();
    }
  );

  test('overlapping grouped asks retain segment identity and requested capacity', () => {
    const verdict = resolveMulti('3 lighting circuits and kitchen', [
      { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
      { circuit_ref: 2, circuit_designation: 'Kitchen lighting' },
      { circuit_ref: 5, circuit_designation: 'Kitchen sockets' },
    ]);
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      writes: [],
      unresolved: [
        expect.objectContaining({
          identity: 1,
          segment_ordinal: 1,
          disposition: 'ask',
          reason: 'quantifier_count_mismatch',
          candidates: [1, 2],
          required_count: 3,
        }),
        expect.objectContaining({
          identity: 2,
          segment_ordinal: 2,
          disposition: 'ask',
          reason: 'ambiguous_match',
          candidates: [2, 5],
          required_count: 1,
        }),
      ],
    });
  });

  test('the mdr-only follow-up accepts and census-validates a ref list', () => {
    const verdict = resolveMultiDescriptionFollowup({
      userText: 'circuits 1 and 2',
      pendingWrite: {
        ...SAMPLE_PENDING,
        field: 'measured_zs_ohm',
        value: '0.42',
      },
      availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
      contextBoardId: 'board-main',
    });
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [1, 2],
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual([1, 2]);
  });

  test.each([
    ['Smoke Alarm', 'an exact designation', 3],
    ['utility lights', 'a unique substring', 4],
    ['Right', 'an exact filler-like designation', 6],
  ])('the mdr-only follow-up resolves %s as %s', (reply, _label, expectedRef) => {
    const verdict = resolveMultiDescriptionFollowup({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [
        ...MULTI_DESCRIPTION_CIRCUITS,
        { circuit_ref: 6, circuit_designation: 'Right' },
      ],
      contextBoardId: 'board-main',
    });
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: [expectedRef],
      unresolved: [],
      writes: [expect.objectContaining({ circuit: expectedRef, board_id: 'board-main' })],
    });
  });

  test.each([
    ['lighting', 'multi_description_followup_ambiguous_designation:1,2'],
    ['upstars lights', 'multi_description_followup_fuzzy_designation:5'],
    ['attic circuit', 'multi_description_followup_no_designation_match'],
  ])('the mdr-only follow-up fails closed for designation reply "%s"', (reply, parsedHint) => {
    const verdict = resolveMultiDescriptionFollowup({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
    });
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: parsedHint,
      available_circuits: MULTI_DESCRIPTION_CIRCUITS,
    });
    expect(verdict.writes).toBeUndefined();
  });

  test.each([
    ['2', [2]],
    ['two', [2]],
    ['twenty-one', [21]],
    ['circuit 2', [2]],
    ['circuit number two', [2]],
    ['circuit no 2', [2]],
    ['number 2', [2]],
    ['the second circuit', [2]],
    ['thanks circuit 2', [2]],
    ['circuit 2 thanks', [2]],
    ['I think circuit 2', [2]],
    ['circuits 1 and 2', [1, 2]],
    ['numbers one and two', [1, 2]],
  ])('the mdr-only anchored ref grammar accepts "%s"', (reply, expectedRefs) => {
    const circuits = Array.from({ length: 21 }, (_, index) => ({
      circuit_ref: index + 1,
      circuit_designation: `Target ${index + 1}`,
    }));
    const verdict = resolveMultiDescriptionFollowup({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: circuits,
    });
    expect(verdict).toMatchObject({
      kind: 'auto_resolve',
      match_status: 'full',
      selected_circuit_refs: expectedRefs,
      unresolved: [],
    });
    expect(verdict.writes.map((write) => write.circuit)).toEqual(expectedRefs);
    expect(isMultiDescriptionAnswerText(reply, circuits)).toBe(true);
  });

  test.each(['give me 2 seconds', 'hold on for 2 minutes', 'just 2 secs', 'I need 2 minutes'])(
    'time-unit chatter "%s" is not an mdr circuit-ref answer',
    (reply) => {
      expect(
        resolveMultiDescriptionFollowup({
          userText: reply,
          pendingWrite: SAMPLE_PENDING,
          availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
        })
      ).toBeNull();
      expect(isMultiDescriptionAnswerText(reply, MULTI_DESCRIPTION_CIRCUITS)).toBe(false);
    }
  );

  test('the mdr-only follow-up represents absent refs by trusted ordinals', () => {
    const verdict = resolveMultiDescriptionFollowup({
      userText: 'circuits 1 and 99',
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
    });
    expect(verdict).toMatchObject({
      kind: 'partial_resolve',
      match_status: 'partial',
      selected_circuit_refs: [1],
      writes: [expect.objectContaining({ circuit: 1 })],
      unresolved: [
        expect.objectContaining({
          identity: 2,
          span_kind: 'segment_ordinal',
          disposition: 'notice',
        }),
      ],
    });
  });

  test.each([
    'circuit 1 and not circuit 2',
    "don't use circuit 1",
    'do not use circuit 1',
    'exclude circuit 1',
    'excluding circuit 1',
    'without circuit 1',
    'leave out circuit 1',
  ])('the mdr-only follow-up explicitly escalates negation in "%s"', (reply) => {
    const verdict = resolveMultiDescriptionFollowup({
      userText: reply,
      pendingWrite: SAMPLE_PENDING,
      availableCircuits: [{ circuit_ref: 1, circuit_designation: 'Only target' }],
    });
    expect(verdict).toMatchObject({
      kind: 'escalate',
      parsed_hint: 'multi_description_followup_correction_or_negation',
      available_circuits: [{ circuit_ref: 1, circuit_designation: 'Only target' }],
    });
    expect(verdict.writes).toBeUndefined();
    expect(verdict.unresolved).toBeUndefined();
  });

  test.each([
    ['initial multi-description scope', '2 lighting circuits and the smoke alarm', [1, 2, 3]],
    ['mdr ref follow-up', 'circuits 1 and 2', [1, 2]],
  ])(
    'record_board_reading collapses %s to one logical write while retaining selected refs',
    (label, reply, selectedRefs) => {
      const pendingWrite = {
        tool: 'record_board_reading',
        field: 'earth_loop_impedance_ze',
        value: '0.42',
        confidence: 0.95,
        source_turn_id: 't-board',
      };
      const verdict =
        label === 'initial multi-description scope'
          ? resolveCircuitAnswer({
              userText: reply,
              pendingWrite,
              availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
              contextBoardId: 'board-main',
            })
          : resolveMultiDescriptionFollowup({
              userText: reply,
              pendingWrite,
              availableCircuits: MULTI_DESCRIPTION_CIRCUITS,
              contextBoardId: 'board-main',
            });
      expect(verdict).toMatchObject({
        kind: 'auto_resolve',
        match_status: 'full',
        selected_circuit_refs: selectedRefs,
        unresolved: [],
      });
      expect(verdict.writes).toEqual([
        expect.objectContaining({
          tool: 'record_board_reading',
          field: 'earth_loop_impedance_ze',
          circuit: 0,
          board_id: 'board-main',
        }),
      ]);
    }
  );

  test('the transcript predicate accepts real targets and rejects filler', () => {
    expect(isMultiDescriptionAnswerText('circuits 1 and 2', MULTI_DESCRIPTION_CIRCUITS)).toBe(true);
    expect(isMultiDescriptionAnswerText('upstairs lights', MULTI_DESCRIPTION_CIRCUITS)).toBe(true);
    expect(isMultiDescriptionAnswerText('lighting', MULTI_DESCRIPTION_CIRCUITS)).toBe(true);
    expect(isMultiDescriptionAnswerText('upstars lights', MULTI_DESCRIPTION_CIRCUITS)).toBe(true);
    expect(isMultiDescriptionAnswerText('Actually scratch that', MULTI_DESCRIPTION_CIRCUITS)).toBe(
      true
    );
    expect(
      isMultiDescriptionAnswerText('circuit 1 and not circuit 2', MULTI_DESCRIPTION_CIRCUITS)
    ).toBe(true);
    expect(isMultiDescriptionAnswerText('not the smoke alarm', MULTI_DESCRIPTION_CIRCUITS)).toBe(
      true
    );
    for (const filler of [
      'hold on a second',
      'wait 2 minutes',
      'wait, 2 minutes',
      'no, I need 2 minutes',
      'not yet, give me 2 minutes',
    ]) {
      expect(isMultiDescriptionAnswerText(filler, MULTI_DESCRIPTION_CIRCUITS)).toBe(false);
    }
    expect(isMultiDescriptionAnswerText('skip', MULTI_DESCRIPTION_CIRCUITS)).toBe(true);
  });
});
