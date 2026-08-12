/**
 * Feedback id 123 (2026-08-12) — value-first compound IR entry extractor.
 *
 * Field shape: "Installation resistance for the garage socket is greater
 * than 299 live to live and live to earth" — VALUE first, two conjunct
 * TRAILING labels. Neither slot namedExtractor (LABEL→bridge→VALUE) matches
 * it, so pre-fix the loop re-asked both legs and the re-answers lost the
 * `>` sentinel (cells held `299`, not `>299`).
 *
 * The extractor is LABEL-PAIR-FIRST with an exactly-one-IR-qualified-
 * candidate rule and a whole-span `\bcircuit\s*\d{1,3}\b` scope guard, and
 * is consulted by runEntry on the ordinary AND scope-conflict extraction
 * paths ONLY when extractNamedFieldValues returned neither IR slot —
 * with the RAW text (masking would erase the scope guard's evidence).
 */

import { processInsulationResistanceTurn } from '../extraction/dialogue-engine/index.js';
import { insulationResistanceSchema } from '../extraction/dialogue-engine/schemas/insulation-resistance.js';

const SESSION_ID = 'sess_compound_ir';
const extractor = insulationResistanceSchema.compoundEntryExtractor;

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

function irTurn(ws, session, text, now, raw = null) {
  return processInsulationResistanceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: text,
    ...(raw !== null ? { rawReplyText: raw } : {}),
    logger: null,
    now,
  });
}

function askFrames(ws) {
  return ws.sent.filter((f) => f.type === 'ask_user_started');
}

// ---------------------------------------------------------------------------
// Unit level — the extractor itself
// ---------------------------------------------------------------------------

describe('compoundEntryExtractor — positive shapes', () => {
  test('the verbatim id-123 utterance → both slots >299', () => {
    expect(
      extractor(
        'Installation resistance for the garage socket is greater than 299 live to live and live to earth'
      )
    ).toEqual([
      { field: 'ir_live_live_mohm', value: '>299' },
      { field: 'ir_live_earth_mohm', value: '>299' },
    ]);
  });

  test('reversed label order (L-E and L-L) accepted', () => {
    expect(extractor('IR is greater than 299 live to earth and live to live')).toEqual([
      { field: 'ir_live_live_mohm', value: '>299' },
      { field: 'ir_live_earth_mohm', value: '>299' },
    ]);
  });

  test('the "L-L and L-E" short form accepted', () => {
    expect(extractor('The garage socket is greater than 299 L-L and L-E')).toEqual([
      { field: 'ir_live_live_mohm', value: '>299' },
      { field: 'ir_live_earth_mohm', value: '>299' },
    ]);
  });

  test('"both readings" / "both tests" / end-of-clause "both" all accepted', () => {
    const expected = [
      { field: 'ir_live_live_mohm', value: '>299' },
      { field: 'ir_live_earth_mohm', value: '>299' },
    ];
    expect(extractor('IR is greater than 299 for both readings')).toEqual(expected);
    expect(extractor('IR is greater than 299 for both tests')).toEqual(expected);
    expect(extractor('IR is greater than 299 for both.')).toEqual(expected);
  });

  test('bare number with explicit megaohm unit qualifies (b)', () => {
    expect(
      extractor('The garage socket reads 250 megaohms live to live and live to earth')
    ).toEqual([
      { field: 'ir_live_live_mohm', value: '250' },
      { field: 'ir_live_earth_mohm', value: '250' },
    ]);
  });

  test('bare number joined by a closed connector qualifies (c)', () => {
    expect(extractor('IR for the garage socket is 299 live to live and live to earth')).toEqual([
      { field: 'ir_live_live_mohm', value: '299' },
      { field: 'ir_live_earth_mohm', value: '299' },
    ]);
  });
});

describe('compoundEntryExtractor — negative shapes → []', () => {
  const negatives = [
    // Value and label pair separated by a semicolon.
    'Insulation resistance for the garage socket is 299; live to live and live to earth',
    // By a newline.
    'Insulation resistance for the garage socket is 299\nlive to live and live to earth',
    // By a contrast clause (pair is also not trailing).
    'Insulation resistance is 299 but live to earth and live to live were not tested',
    // Scope-marker rejection — never captures the 2.
    'IR for circuit 2 is greater than 299 live to live and live to earth',
    'IR for circuit 2 is greater than 299 L-L and L-E',
    'greater than 299 for circuit 2 live to live and live to earth',
    // Numeric designation — a naked number can never certify.
    'Insulation resistance for the 56 socket 299 live to live and live to earth',
    // "both circuits" phrasing is NOT a label pair.
    'Insulation resistance for the garage socket is greater than 299 for both circuits',
    // Conflicting-unit rejection: one bare candidate, but it is volts.
    'Insulation resistance was tested at 500 volts, live to live and live to earth',
    // Non-IR value rejection (milliseconds).
    'trip time 27 ms, L-L and L-E',
    // Different per-label values — the per-label extractors own this shape
    // (structurally: pair regex requires the labels adjacent, and the
    // consultation gate means named extraction already matched anyway).
    'L-L 200 and L-E 150',
    // No qualified candidate at all.
    'live to live and live to earth',
  ];

  test.each(negatives)('%s → []', (text) => {
    expect(extractor(text)).toEqual([]);
  });

  test('non-string / empty input → []', () => {
    expect(extractor(null)).toEqual([]);
    expect(extractor('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Production ingress — ordinary entry path
// ---------------------------------------------------------------------------

describe('id 123 — ordinary entry path', () => {
  test('the verbatim utterance writes >299 to BOTH legs and asks the voltage', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { circuit_designation: 'Garage Socket' } });
    const out = irTurn(
      ws,
      session,
      'Installation resistance for the garage socket is greater than 299 live to live and live to earth',
      1000
    );
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.stateSnapshot.circuits[5].ir_live_live_mohm).toBe('>299');
    expect(session.stateSnapshot.circuits[5].ir_live_earth_mohm).toBe('>299');
    // No re-ask of either leg — the walk proceeds straight to the voltage.
    const questions = askFrames(ws).map((f) => f.question ?? '');
    expect(questions.some((q) => q.includes('test voltage'))).toBe(true);
    expect(questions.some((q) => q.includes('live-to-live'))).toBe(false);
    expect(questions.some((q) => q.includes('live-to-earth'))).toBe(false);
  });

  const ordinaryNegatives = [
    [
      'semicolon',
      'Insulation resistance for the garage socket is 299; live to live and live to earth',
    ],
    [
      'newline',
      'Insulation resistance for the garage socket is 299\nlive to live and live to earth',
    ],
    [
      'contrast clause',
      'Insulation resistance for the garage socket is 299 but live to earth and live to live were not tested',
    ],
    ['circuit scope marker', 'IR for circuit 2 is greater than 299 live to live and live to earth'],
    ['circuit scope marker, short form', 'IR for circuit 2 is greater than 299 L-L and L-E'],
    [
      'scope marker between value and labels',
      'Insulation resistance, greater than 299 for circuit 2 live to live and live to earth',
    ],
    [
      'both circuits',
      'Insulation resistance for the garage socket is greater than 299 for both circuits',
    ],
    [
      'conflicting unit (volts)',
      'Insulation resistance for the garage socket was tested at 500 volts, live to live and live to earth',
    ],
    [
      'non-IR value (ms)',
      'Insulation resistance for the garage socket, trip time 27 ms, L-L and L-E',
    ],
    [
      'numeric designation',
      'Insulation resistance for the 56 socket 299 live to live and live to earth',
    ],
  ];

  test.each(ordinaryNegatives)('ZERO writes: %s', (_label, text) => {
    const ws = new FakeWS();
    const session = buildSession({
      2: {},
      5: { circuit_designation: 'Garage Socket' },
      9: { circuit_designation: '56 Socket' },
    });
    irTurn(ws, session, text, 1000);
    for (const ref of [2, 5, 9]) {
      expect(session.stateSnapshot.circuits[ref].ir_live_live_mohm).toBeUndefined();
      expect(session.stateSnapshot.circuits[ref].ir_live_earth_mohm).toBeUndefined();
      expect(session.stateSnapshot.circuits[ref].ir_test_voltage_v).toBeUndefined();
    }
    // Nothing queued either (an unresolved-circuit entry queues pending
    // writes — the compound extractor must not have produced any).
    const pending = session.dialogueScriptState?.pending_writes ?? [];
    expect(pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Production ingress — scope-conflict entry path
// ---------------------------------------------------------------------------

describe('id 123 — scope-conflict entry path', () => {
  test('conflict + clean final clause: compound entries queue and drain onto the answered circuit', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {}, 7: {} });
    irTurn(
      ws,
      session,
      'Circuit 4, insulation resistance for circuit 7. Greater than 299 live to live and live to earth.',
      1000
    );
    // Conflict → which-circuit ask, both legs queued at >299.
    const state = session.dialogueScriptState;
    expect(state?.scope_conflict_origin).toBe(true);
    expect(state.pending_writes.map((w) => `${w.field}=${w.value}`).sort()).toEqual([
      'ir_live_earth_mohm=>299',
      'ir_live_live_mohm=>299',
    ]);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('Which circuit'))).toBe(true);
    // Resolve the conflict — the drain writes both legs to circuit 7.
    irTurn(ws, session, 'circuit 7', 2000, 'circuit 7');
    expect(session.stateSnapshot.circuits[7].ir_live_live_mohm).toBe('>299');
    expect(session.stateSnapshot.circuits[7].ir_live_earth_mohm).toBe('>299');
    expect(session.stateSnapshot.circuits[4].ir_live_live_mohm).toBeUndefined();
  });

  const conflictNegatives = [
    [
      'semicolon',
      'Circuit 4, insulation resistance for circuit 7 is 299; live to live and live to earth',
    ],
    [
      'same-clause circuit marker',
      'Circuit 4, insulation resistance for circuit 7 is greater than 299 live to live and live to earth',
    ],
    [
      'conflicting unit (volts)',
      'Circuit 4, insulation resistance for circuit 7. Tested at 500 volts, live to live and live to earth.',
    ],
  ];

  test.each(conflictNegatives)('ZERO queued writes: %s', (_label, text) => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {}, 7: {} });
    irTurn(ws, session, text, 1000);
    const state = session.dialogueScriptState;
    expect(state?.scope_conflict_origin).toBe(true);
    expect(state.pending_writes).toHaveLength(0);
    expect(session.stateSnapshot.circuits[4].ir_live_live_mohm).toBeUndefined();
    expect(session.stateSnapshot.circuits[7].ir_live_live_mohm).toBeUndefined();
  });
});
