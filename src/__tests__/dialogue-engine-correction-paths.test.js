/**
 * Feedback-2026-07-27 wave, PLAN-1 (ids 105 / 109 / 110b / 113) — the
 * investigation's in-process probe suite PROMOTED to committed tests, plus
 * the plan's §6 matrices. Three fix groups:
 *
 *   A — ring `awaiting_confirmation` correction paths: bidirectional
 *       (value-first) extraction, the retained-value negation machine
 *       ("No. 0.85" → "R1" two-turn correction), and the 5g latch rule.
 *   B — RCD intent-gated entry pins that live beyond the decision table in
 *       dialogue-engine-rcd-entry-guard.test.js (group-1 capture, reparse
 *       recovery post-gate, the documented reparse/veto asymmetry).
 *   C — IR volunteer-both matrix rows (a)–(h): the voltage ask is never
 *       silently skipped and drained writes reach the wire exactly once on
 *       every exit.
 *
 * Everything here drives the REAL engine (processRingContinuityTurn /
 * processInsulationResistanceTurn / processDialogueTurn) with a fake WS —
 * the same harness the field investigation used to reproduce all four ids.
 */

import {
  processDialogueTurn,
  processRingContinuityTurn,
  processInsulationResistanceTurn,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { rcdSchema } from '../extraction/dialogue-engine/schemas/rcd.js';
import { reparseSingleCompleteReading } from '../extraction/stage6-shadow-harness.js';

const SESSION_ID = 'sess_correction_paths';

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

function extractionFrames(ws) {
  return ws.sent.filter((f) => f.type === 'extraction');
}

function askFrames(ws) {
  return ws.sent.filter((f) => f.type === 'ask_user_started');
}

function readingsOf(frame) {
  return frame?.result?.readings ?? [];
}

/** Drive the ring script to the "R1 0.43, Rn 0.43, R2 0.78. All correct?" confirmation. */
function enterRingConfirmation(ws, session, now = 1000) {
  processRingContinuityTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'Ring continuity for circuit 13. Lives 0.43, neutrals 0.43, CPC 0.78.',
    logger: null,
    now,
  });
  const confirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
  expect(confirm).toBeTruthy();
  expect(session.dialogueScriptState?.awaiting_confirmation).toBe(true);
  ws.sent = [];
}

function ringTurn(ws, session, text, now, raw = text) {
  return processRingContinuityTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: text,
    rawReplyText: raw,
    logger: null,
    now,
  });
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

// ---------------------------------------------------------------------------
// Group A — §2.1 probe table promoted (value-first amend paths)
// ---------------------------------------------------------------------------

describe('group A — ring awaiting_confirmation accepts value-first amends (ids 109/110b)', () => {
  test('pinned ✅: "R1 is 0.85" amends and re-reads', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    const out = ringTurn(ws, session, 'R1 is 0.85', 2000);
    expect(out.handled).toBe(true);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ circuit: 13, value: '0.85' })])
    );
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.85');
  });

  test('pinned ✅: "R1 0.85, Rn 0.86, R2 0.91" writes all three to the CORRECT slots post-widening', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'R1 0.85, Rn 0.86, R2 0.91', 2000);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.85, Rn 0.86, R2 0.91');
  });

  test.each(['0.85 on the lives', 'It was 0.85 for the lives', 'No, 0.85 on the lives'])(
    'flipped: %p amends R1 in ONE turn (was engine-silent fallthrough / 5e discard)',
    (text) => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      const out = ringTurn(ws, session, text, 2000);
      expect(out.handled).toBe(true);
      expect(out.fallthrough).toBeFalsy();
      const frames = extractionFrames(ws);
      expect(frames).toHaveLength(1);
      const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
      expect(reconfirm.question).toContain('R1 0.85');
    }
  );

  test('flipped (the id-109 repro): entry-shaped reply CARRYING a value amends at 5b, never 5g re-read', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'Ring continuity for circuit 13, 0.85 on the lives', 2000);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    // NEW value spoken — never "read out the existing ones".
    expect(reconfirm.question).toContain('R1 0.85');
    expect(reconfirm.question).not.toContain('R1 0.43');
  });

  test('pinned ✅ CONTROL: value-LESS re-entry re-reads the EXISTING values (designed 5g behaviour)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'Ring continuity for circuit 13.', 2000);
    expect(extractionFrames(ws)).toHaveLength(0);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.43');
  });

  test('§2.2.4 regression pin: no successfully-parsed named reply exits engine-silent during confirmation', () => {
    for (const text of ['0.85 on the lives', 'It was 0.85 for the lives']) {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      const out = ringTurn(ws, session, text, 2000);
      // Consumed by the engine with audible output — never {handled, fallthrough}.
      expect(out.fallthrough).toBeFalsy();
      expect(ws.sent.length).toBeGreaterThan(0);
    }
  });

  test('sentinel words parse to null and remain MODEL-bound (documented pre-existing limitation)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    const out = ringTurn(ws, session, 'infinite on the lives', 2000);
    // No ring write — the sentinel never parses on the live path.
    expect(extractionFrames(ws)).toHaveLength(0);
    expect(out.handled).toBe(true);
  });

  describe('adversarial cross-slot pins (the gap rule is length-driven, field-first ties)', () => {
    test('"0.85, R1 was fine" does NOT bind value-first (no connector)', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, '0.85, R1 was fine', 2000);
      expect(extractionFrames(ws)).toHaveLength(0);
    });

    test("twin's tested literal: R1=0.43, Rn=0.43 (value-first on proximity), R2=0.78", () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'lives 0.43, 0.43 on the neutrals, and CPC is 0.78.', 2000);
      const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
      expect(reconfirm.question).toContain('R1 0.43, Rn 0.43, R2 0.78');
    });

    test('discriminating SHORT form: "lives 0.43, 0.43 on the neutrals, CPC 0.78" binds Rn=0.78 (ffGap 6 ≤ vfGap 8)', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'lives 0.43, 0.43 on the neutrals, CPC 0.78', 2000);
      const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
      // Proves the comparison is LENGTH-driven, not direction-preferring: the
      // field-first filler ", CPC " (6 chars) beats " on the " (8 chars).
      expect(reconfirm.question).toContain('Rn 0.78');
    });
  });
});

// ---------------------------------------------------------------------------
// Group A — retained-value two-turn sequence + lifecycle clears (§2.2.2)
// ---------------------------------------------------------------------------

describe('group A — retained-value machine: "No. 0.85" → "R1" (id 110b)', () => {
  test('two-turn sequence: retained ask, then slot answer applies the value — one write, one frame', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);

    // Turn 1 — "No. 0.85": the existing negation re-ask, value RETAINED.
    const out1 = ringTurn(ws, session, 'No. 0.85', 2000);
    expect(out1.handled).toBe(true);
    expect(extractionFrames(ws)).toHaveLength(0);
    const reask = askFrames(ws).find((f) => (f.question ?? '').includes('Which value is wrong'));
    expect(reask).toBeTruthy();
    const state = session.dialogueScriptState;
    expect(state.confirmation_pending_value).toBe('0.85');
    expect(state.confirmation_negation_reask_emitted).toBe(true);
    expect(state.confirmation_no_progress).toBe(1);

    // Turn 2 — "R1": 5d consumes the retained value via the 5c write path.
    ws.sent = [];
    const out2 = ringTurn(ws, session, 'R1', 3000);
    expect(out2.handled).toBe(true);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ circuit: 13, value: '0.85' })])
    );
    expect(session.dialogueScriptState.confirmation_pending_value).toBeNull();
    // Re-confirms with the applied value — no "What should R1 be?" ask.
    const valueAsk = askFrames(ws).find((f) => (f.question ?? '').includes('What should'));
    expect(valueAsk).toBeFalsy();
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.85');
  });

  test('P1 counter contract: "No. 0.85" → bare "No." takes the CAP EXIT (no_progress already 1); retained value cleared with the state', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'No. 0.85', 2000);
    ws.sent = [];
    ringTurn(ws, session, 'No.', 3000);
    const cap = askFrames(ws).find((f) => (f.question ?? '').includes('leaving the ring readings'));
    expect(cap).toBeTruthy();
    // clearScriptState killed the whole state object — retained value gone.
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('5c consumes first: with a pending slot set, "No. 0.85" writes THAT slot (never the retained-value arm)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'R1', 2000); // "What should R1 be?" — pending slot set
    expect(session.dialogueScriptState.confirmation_pending_slot).toBe('ring_r1_ohm');
    ws.sent = [];
    ringTurn(ws, session, 'No. 0.85', 3000);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(session.dialogueScriptState.confirmation_pending_value).toBeFalsy();
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.85');
  });

  test('"No, infinite" stays arm 3 byte-identically (digits-only anchor)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'No, infinite', 2000);
    expect(session.dialogueScriptState.confirmation_pending_value).toBeNull();
    const reask = askFrames(ws).find((f) => (f.question ?? '').includes('Which value is wrong'));
    expect(reask).toBeTruthy();
  });

  test('bare "No." still reaches handleNegation byte-identically (no retained value)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'No.', 2000);
    expect(session.dialogueScriptState.confirmation_pending_value).toBeNull();
    const reask = askFrames(ws).find((f) => (f.question ?? '').includes('Which value is wrong'));
    expect(reask).toBeTruthy();
  });

  describe('lifecycle clears — a stale retained value never lands on an unpaired slot', () => {
    test('5b amend-after-retention clears: "No. 0.85" → "Actually R1 is 0.9" → "Rn" ASKS, no write', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'No. 0.85', 2000);
      ringTurn(ws, session, 'Actually R1 is 0.9', 3000); // 5b amend — genuine progress
      expect(session.dialogueScriptState.confirmation_pending_value).toBeNull();
      ws.sent = [];
      ringTurn(ws, session, 'Rn', 4000);
      expect(extractionFrames(ws)).toHaveLength(0);
      const ask = askFrames(ws).find((f) => (f.question ?? '').includes('What should Rn be?'));
      expect(ask).toBeTruthy();
    });

    test('value-less 5g re-entry clears: "No. 0.85" → "Ring continuity for circuit 13." → "Rn" ASKS, no write', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'No. 0.85', 2000);
      ringTurn(ws, session, 'Ring continuity for circuit 13.', 3000); // 5g re-entry
      expect(session.dialogueScriptState.confirmation_pending_value).toBeNull();
      ws.sent = [];
      ringTurn(ws, session, 'Rn', 4000);
      expect(extractionFrames(ws)).toHaveLength(0);
      const ask = askFrames(ws).find((f) => (f.question ?? '').includes('What should Rn be?'));
      expect(ask).toBeTruthy();
    });

    test('5g latch rule: "No. 0.85" → re-entry → "No." draws the DISTINCT alternate, never the byte-identical original re-ask', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'No. 0.85', 2000);
      ringTurn(ws, session, 'Ring continuity for circuit 13.', 3000);
      // 5g preserved the latch and reset the counter.
      expect(session.dialogueScriptState.confirmation_negation_reask_emitted).toBe(true);
      expect(session.dialogueScriptState.confirmation_no_progress).toBe(0);
      ws.sent = [];
      ringTurn(ws, session, 'No.', 4000);
      const asks = askFrames(ws);
      expect(asks.length).toBeGreaterThan(0);
      // The alternate — full-string distinct from the original negationReask.
      const alternate = asks.find((f) =>
        (f.question ?? '').includes('tell me which reading to change')
      );
      expect(alternate).toBeTruthy();
      expect(asks.some((f) => (f.question ?? '').includes('Which value is wrong'))).toBe(false);
    });

    test('negationReaskAlternate is reachable only on the progress-reset path (after a consumed retained value)', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: {} });
      enterRingConfirmation(ws, session);
      ringTurn(ws, session, 'No. 0.85', 2000); // latch set, counter 1
      ringTurn(ws, session, 'R1', 3000); // consumes retained value, counter reset, re-confirms
      expect(session.dialogueScriptState.confirmation_no_progress).toBe(0);
      ws.sent = [];
      ringTurn(ws, session, 'No.', 4000); // latch still set → alternate, not cap
      const alternate = askFrames(ws).find((f) =>
        (f.question ?? '').includes('tell me which reading to change')
      );
      expect(alternate).toBeTruthy();
      expect(session.dialogueScriptState).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Group A — call-site matrix beyond 5b (the extractor change reaches every consumer)
// ---------------------------------------------------------------------------

describe('group A — value-first extraction at every consumer (call-site matrix)', () => {
  test('known-circuit ENTRY: "Ring continuity for circuit 13. 0.85 on the lives." writes R1 and asks neutrals', () => {
    // Sentence-split form: the comma form ("circuit 13, 0.85 …") false-matches
    // the PRE-EXISTING broadcast pre-filter's `circuit N, <decimal>` list shape
    // at ENTRY (the falseListDecimalBypass is confirmation-only by design) —
    // untouched by this wave; the comma form's confirmation-time handling is
    // the id-109 amend test above.
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. 0.85 on the lives.',
      logger: null,
      now: 1000,
    });
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const r = readingsOf(frames[0]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ circuit: 13, value: '0.85' });
    const ask = askFrames(ws).find((f) => (f.question ?? '').includes('neutrals'));
    expect(ask).toBeTruthy();
  });

  test('unresolved ENTRY + circuit drain: value-first volunteer queues, digit answer drains onto the circuit', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity. 0.85 on the lives.',
      logger: null,
      now: 1000,
    });
    const whichCircuit = askFrames(ws).find((f) => (f.question ?? '').includes('Which circuit'));
    expect(whichCircuit).toBeTruthy();
    ws.sent = [];
    ringTurn(ws, session, '13', 2000);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ circuit: 13, value: '0.85' })])
    );
  });

  test('active MID-COLLECTION: "0.85 on the lives" fills the asked slot', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
    });
    ws.sent = [];
    ringTurn(ws, session, '0.85 on the lives', 2000);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0])[0]).toMatchObject({ circuit: 13, value: '0.85' });
  });

  test('conflict input: "Circuit 5, ring continuity for circuit 13. 0.85 on the lives." never captures a circuit number as a value', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {}, 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Circuit 5, ring continuity for circuit 13. 0.85 on the lives.',
      logger: null,
      now: 1000,
    });
    const whichCircuit = askFrames(ws).find((f) => (f.question ?? '').includes('Which circuit'));
    expect(whichCircuit).toBeTruthy();
    ws.sent = [];
    ringTurn(ws, session, 'circuit 13', 2000);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const values = readingsOf(frames[0]).map((r) => r.value);
    expect(values).toContain('0.85');
    expect(values).not.toContain('5');
    expect(values).not.toContain('13');
  });

  test('"circuit 13. Lives 0.43" never binds 13 value-first (mandatory connector + masking)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives 0.43',
      logger: null,
      now: 1000,
    });
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const r = readingsOf(frames[0]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ value: '0.43' });
  });

  describe('reparseSingleCompleteReading (the orphan-net consumer) masks circuit spans', () => {
    test('"ring continuity for circuit 13 on the lives" returns null — the circuit number is never a value', () => {
      expect(
        reparseSingleCompleteReading(
          'ring continuity for circuit 13 on the lives',
          ALL_DIALOGUE_SCHEMAS
        )
      ).toBeNull();
    });

    test('"ring continuity for circuit 13, 0.85 on the lives" recovers circuit 13 / R1=0.85', () => {
      expect(
        reparseSingleCompleteReading(
          'ring continuity for circuit 13, 0.85 on the lives',
          ALL_DIALOGUE_SCHEMAS
        )
      ).toEqual({ slotField: 'ring_r1_ohm', circuit: 13, value: '0.85' });
    });
  });
});

// ---------------------------------------------------------------------------
// Group B — RCD gate pins beyond the entry-guard decision table
// ---------------------------------------------------------------------------

describe('group B — RCD intent gate structural pins (id 113)', () => {
  test('group-1 capture: every trigger pattern that matches a circuit-bearing utterance yields the circuit at m[1]', () => {
    const rows = [
      ['RCD trip time for circuit 4 is 25 milliseconds', '4'],
      ['RCD circuit 6', '6'],
      ['test the RCD on circuit 3', '3'],
    ];
    for (const [utterance, circuit] of rows) {
      const captures = rcdSchema.triggers
        .map((t) => utterance.match(t))
        .filter((m) => m && m[1] !== undefined)
        .map((m) => m[1]);
      expect(captures).toContain(circuit);
    }
  });

  test('reparse recovery post-gate: "RCD trip time for circuit 4 is 25 milliseconds" still recovers through the orphan net', () => {
    expect(
      reparseSingleCompleteReading(
        'RCD trip time for circuit 4 is 25 milliseconds',
        ALL_DIALOGUE_SCHEMAS
      )
    ).toEqual({ slotField: 'rcd_trip_time', circuit: 4, value: '25' });
  });

  test('documented asymmetry: the narrative veto gates script ENTRY only — reparse consults triggers, not entryExclusionPattern', () => {
    // Pre-existing, unchanged by this wave: a veto-bearing COMPLETE tuple is
    // still recoverable by the orphan net. This pin documents the boundary so
    // a future widening is a deliberate decision, not drift.
    expect(
      reparseSingleCompleteReading(
        'No RCD protection, but the RCD trip time for circuit 4 is 25 milliseconds',
        ALL_DIALOGUE_SCHEMAS
      )
    ).toEqual({ slotField: 'rcd_trip_time', circuit: 4, value: '25' });
  });

  test('ICD alias parity: garble spelling enters and captures identically', () => {
    const m = 'ICD trip time for circuit 4 is 25 milliseconds';
    expect(rcdSchema.triggers.some((t) => t.test(m))).toBe(true);
    expect(rcdSchema.entryExclusionPattern.test('No ICD protection on circuit 4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group C — IR volunteer-both committed matrix (§6 rows a–h)
// ---------------------------------------------------------------------------

describe('group C — IR voltage ask + exactly-once wire emit (id 105)', () => {
  function volunteerBoth(ws, session, now = 1000) {
    irTurn(ws, session, 'Insulation resistance. Live to live 200, live to earth 200.', now);
    const whichCircuit = askFrames(ws).find((f) =>
      (f.question ?? '').includes('Which circuit is the insulation resistance for?')
    );
    expect(whichCircuit).toBeTruthy();
    ws.sent = [];
  }

  test('(a) circuit named at entry, values one per turn → voltage asked after slots fill', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    irTurn(ws, session, 'Insulation resistance for circuit 4.', 1000);
    irTurn(ws, session, '200', 2000);
    ws.sent = [];
    irTurn(ws, session, '200', 3000);
    const voltageAsk = askFrames(ws).find((f) => (f.question ?? '').includes('test voltage'));
    expect(voltageAsk).toBeTruthy();
  });

  test('(b) circuit + both readings in the ENTRY utterance → voltage asked', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    irTurn(
      ws,
      session,
      'Insulation resistance for circuit 4. Live to live 200, live to earth 200.',
      1000
    );
    const voltageAsk = askFrames(ws).find((f) => (f.question ?? '').includes('test voltage'));
    expect(voltageAsk).toBeTruthy();
  });

  test('(c) no circuit, no values; circuit answered → slots asked → voltage asked', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    irTurn(ws, session, 'Insulation resistance.', 1000);
    ws.sent = [];
    irTurn(ws, session, '4', 2000, '4');
    // Slot walk continues (L-L asked), NOT the voltage yet.
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(false);
    irTurn(ws, session, '200', 3000);
    ws.sent = [];
    irTurn(ws, session, '200', 4000);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(true);
  });

  test('(d) voltage already filled on the circuit → skipped by design, finish line includes it', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: { ir_test_voltage_v: '500' } });
    irTurn(
      ws,
      session,
      'Insulation resistance for circuit 4. Live to live 200, live to earth 200.',
      1000
    );
    const finish = askFrames(ws).find((f) => (f.question ?? '').startsWith('Got it.'));
    expect(finish).toBeTruthy();
    expect(finish.question).toContain('voltage 500');
  });

  test('(e) volunteer-both, circuit answer CARRIES the voltage → writeExclusiveAndFinish path byte-identical', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'It is circuit 4, tested at 500', 2000, 'It is circuit 4, tested at 500');
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const fields = readingsOf(frames[0]).map((r) => `${r.field}=${r.value}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        'insulation_resistance_l_l=200',
        'insulation_resistance_l_e=200',
        'ir_test_voltage=500',
      ])
    );
    const finish = askFrames(ws).find((f) => (f.question ?? '').startsWith('Got it.'));
    expect(finish).toBeTruthy();
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('(f) THE RED CASE: volunteer both BEFORE circuit, bare circuit answer → voltage ask + drained writes wire-emitted exactly once + 30 s machinery armed', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    volunteerBoth(ws, session);
    const out = irTurn(
      ws,
      session,
      '[In response to TTS question "Which circuit is the insulation resistance for?"] 4',
      2000,
      '4'
    );
    expect(out.handled).toBe(true);
    // Exactly ONE extraction frame, carrying BOTH drained readings on the
    // REAL wire shape (this closes the investigation's payload-key gap).
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const readings = readingsOf(frames[0]);
    expect(readings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'insulation_resistance_l_l', circuit: 4, value: '200' }),
        expect.objectContaining({ field: 'insulation_resistance_l_e', circuit: 4, value: '200' }),
      ])
    );
    // The voltage ask IS emitted — never a silent finish.
    const voltageAsk = askFrames(ws).find((f) => (f.question ?? '').includes('test voltage'));
    expect(voltageAsk).toBeTruthy();
    // Script stays active in the voltage phase with the re-ask machinery armed.
    expect(session.dialogueScriptState?.active).toBe(true);
    expect(session.dialogueScriptState?.voltage_phase_entered_at).toBe(2000);
    // A voltage answer on the next turn completes normally.
    ws.sent = [];
    irTurn(ws, session, '500', 3000, '500');
    const voltageFrames = extractionFrames(ws);
    expect(voltageFrames).toHaveLength(1);
    expect(readingsOf(voltageFrames[0])).toEqual([
      expect.objectContaining({ field: 'ir_test_voltage', circuit: 4, value: '500' }),
    ]);
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('(g) NON-standard voltage on the resolution turn: confirm prompt + drained LL/LE emitted once; confirm resolution writes ONLY the voltage', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'circuit 4 at 350', 2000, 'circuit 4 at 350');
    let frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(
      readingsOf(frames[0])
        .map((r) => r.field)
        .sort()
    ).toEqual(['insulation_resistance_l_e', 'insulation_resistance_l_l']);
    const confirm = askFrames(ws).find((f) =>
      (f.question ?? '').includes('Did you say 350 volts?')
    );
    expect(confirm).toBeTruthy();
    // Confirm resolution: only the voltage — never an LL/LE re-emit.
    ws.sent = [];
    irTurn(ws, session, 'yes', 3000, 'yes');
    frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    // 350 is a NUMBER here (pre-existing confirm-gate shape: slotPendingConfirm
    // holds Number(value) and the affirmative writes it as-is).
    expect(readingsOf(frames[0])).toEqual([
      expect.objectContaining({ field: 'ir_test_voltage', value: 350 }),
    ]);
  });

  test('(g2) confirm-gate bare-no re-ask: ZERO extraction frames (legitimately empty writes)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'circuit 4 at 350', 2000, 'circuit 4 at 350');
    ws.sent = [];
    irTurn(ws, session, 'no', 3000, 'no');
    expect(extractionFrames(ws)).toHaveLength(0);
    const reask = askFrames(ws).find((f) => (f.question ?? '').includes('test voltage'));
    expect(reask).toBeTruthy();
  });

  test('(h) bare "56" answering which_circuit on a 56-circuit board resolves the circuit and draws the voltage ask — never "Did you say 56 volts?"', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {}, 56: {} });
    volunteerBoth(ws, session);
    irTurn(ws, session, '56', 2000, '56');
    expect(session.dialogueScriptState?.circuit_ref).toBe(56);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('Did you say'))).toBe(false);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(true);
    // Drained writes landed on circuit 56 in one frame.
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0]).every((r) => r.circuit === 56)).toBe(true);
  });

  test('(h2) "circuit 56, tested at 500" → circuit 56 resolved AND voltage 500 written (only the resolution span masked)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 56: {} });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'circuit 56, tested at 500', 2000, 'circuit 56, tested at 500');
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    const fields = readingsOf(frames[0]).map((r) => `${r.field}=${r.value}`);
    expect(fields).toEqual(expect.arrayContaining(['ir_test_voltage=500']));
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('(h3) designation answer without a voltage → voltage ask; with a voltage → voltage written', () => {
    // Without.
    let ws = new FakeWS();
    let session = buildSession({ 7: { circuit_designation: 'Upstairs sockets' } });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'the upstairs sockets', 2000, 'the upstairs sockets');
    expect(session.dialogueScriptState?.circuit_ref).toBe(7);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(true);
    expect(extractionFrames(ws)).toHaveLength(1);
    // With.
    ws = new FakeWS();
    session = buildSession({ 7: { circuit_designation: 'Upstairs sockets' } });
    volunteerBoth(ws, session);
    irTurn(ws, session, 'upstairs sockets, tested at 500', 2000, 'upstairs sockets, tested at 500');
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0]).map((r) => `${r.field}=${r.value}`)).toEqual(
      expect.arrayContaining(['ir_test_voltage=500'])
    );
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('annotated-turn regression (round-6): resolution reads rawReplyText, not the annotated transcript', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    volunteerBoth(ws, session);
    irTurn(
      ws,
      session,
      '[In response to TTS question "Which circuit is the insulation resistance for?"] 56',
      2000,
      '56'
    );
    // The annotated transcript would defeat the whole-reply numeric parse;
    // rawReplyText resolves it. 56 is not on this board's snapshot but the
    // digit form resolves refs directly (existing behaviour).
    expect(session.dialogueScriptState?.circuit_ref).toBe(56);
  });

  test('never two extraction frames on any exclusive-branch exit', () => {
    // Exercise (e), (f), (g) shapes and count frames per turn.
    const shapes = [
      ['It is circuit 4, tested at 500', 1],
      ['4', 1],
      ['circuit 4 at 350', 1],
    ];
    for (const [answer, expected] of shapes) {
      const ws = new FakeWS();
      const session = buildSession({ 4: {} });
      volunteerBoth(ws, session);
      irTurn(ws, session, answer, 2000, answer);
      expect(extractionFrames(ws)).toHaveLength(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Risk pins (§8)
// ---------------------------------------------------------------------------

describe('schema-scan risk pins', () => {
  test('exclusive slots across ALL registered schemas == {ir_test_voltage_v}', () => {
    const exclusive = [];
    for (const schema of ALL_DIALOGUE_SCHEMAS) {
      for (const slot of schema.slots ?? []) {
        if (slot.exclusiveWhenExpected) exclusive.push(slot.field);
      }
    }
    // A future schema opting into exclusiveWhenExpected inherits the
    // resolution-turn classify-before-exclusive keying — make that a
    // deliberate, test-visible decision.
    expect(exclusive).toEqual(['ir_test_voltage_v']);
  });

  test('RCD schema carries no confirmation block (its 5g re-entry path is structurally unreachable; the veto gates entry via the composite pattern)', () => {
    expect(rcdSchema.confirmation).toBeUndefined();
  });

  test('non-exclusive RCD circuit resolution is unchanged: which-circuit answer proceeds to the slot walk', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger: null,
      now: 1000,
    });
    const whichCircuit = askFrames(ws).find((f) => (f.question ?? '').includes('Which circuit'));
    expect(whichCircuit).toBeTruthy();
    ws.sent = [];
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '4',
      rawReplyText: '4',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger: null,
      now: 2000,
    });
    expect(session.dialogueScriptState?.circuit_ref).toBe(4);
    // The slot walk continues (BS-number ask) — no voltage machinery.
    const bsAsk = askFrames(ws).find((f) => (f.question ?? '').includes('BS number'));
    expect(bsAsk).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Codex cycle-1 additions — the §6 rows the first commit omitted
// ---------------------------------------------------------------------------

describe('cycle 1 — connector positives + gap-rule orderings', () => {
  test.each([
    ['0.43 across the neutrals', 'Rn 0.43'],
    ['0.78 at the CPC', 'R2 0.78'],
    ['0.85 down the lives', 'R1 0.85'],
    ['0.86 onto the neutrals', 'Rn 0.86'],
    ['0.9 to the lives', 'R1 0.9'],
  ])('connector positive %p amends (%p spoken)', (utterance, expected) => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, utterance, 2000);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain(expected);
  });

  test('gap ordering "0.85 on the lives, lives 0.43": tie (8 vs 8) → field-first wins → R1 0.43', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, '0.85 on the lives, lives 0.43', 2000);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.43');
  });

  test('reverse ordering "lives 0.43, 0.85 on the lives": field-first gap 1 < value-first 8 → R1 0.43', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'lives 0.43, 0.85 on the lives', 2000);
    const reconfirm = askFrames(ws).find((f) => (f.question ?? '').includes('All correct?'));
    expect(reconfirm.question).toContain('R1 0.43');
  });
});

describe('cycle 1 — retained-value clearing on the remaining lifecycle exits', () => {
  function retainValue(ws, session) {
    enterRingConfirmation(ws, session);
    ringTurn(ws, session, 'No. 0.85', 2000);
    expect(session.dialogueScriptState.confirmation_pending_value).toBe('0.85');
    ws.sent = [];
  }

  test('circuit switch (5a seed) clears — the new episode never inherits the value', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {}, 13: {} });
    retainValue(ws, session);
    ringTurn(ws, session, 'Ring continuity for circuit 5, lives are 0.9', 3000);
    expect(session.dialogueScriptState?.confirmation_pending_value ?? null).toBeNull();
  });

  test('topic-switch fallthrough clears (whole state dies)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    retainValue(ws, session);
    ringTurn(ws, session, 'Zs is 0.62.', 3000);
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('cancel/reset clears (whole state dies)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    retainValue(ws, session);
    ringTurn(ws, session, 'never mind', 3000);
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('hard timeout clears (whole state dies)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    retainValue(ws, session);
    ringTurn(ws, session, 'hello there', 2000 + 180_001);
    expect(session.dialogueScriptState?.confirmation_pending_value ?? null).toBeNull();
  });
});

describe('cycle 1 — numeric-designation resolution masking (group C)', () => {
  test('shortened numeric designation "the 56" resolves + voltage ask — never "Did you say 56 volts?"', () => {
    const ws = new FakeWS();
    const session = buildSession({ 7: { circuit_designation: '56 sockets' } });
    irTurn(ws, session, 'Insulation resistance. Live to live 200, live to earth 200.', 1000);
    ws.sent = [];
    irTurn(ws, session, 'the 56', 2000, 'the 56');
    expect(session.dialogueScriptState?.circuit_ref).toBe(7);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('Did you say'))).toBe(false);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(true);
    // Drained writes emitted exactly once; the designation digits are NEVER a voltage write.
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0]).some((r) => r.field === 'ir_test_voltage')).toBe(false);
  });

  test('shortened numeric designation "500 volt" (stored "500 volt control supply") never silently writes voltage=500', () => {
    const ws = new FakeWS();
    const session = buildSession({ 7: { circuit_designation: '500 volt control supply' } });
    irTurn(ws, session, 'Insulation resistance. Live to live 200, live to earth 200.', 1000);
    ws.sent = [];
    irTurn(ws, session, '500 volt', 2000, '500 volt');
    expect(session.dialogueScriptState?.circuit_ref).toBe(7);
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0]).some((r) => r.field === 'ir_test_voltage')).toBe(false);
    expect(askFrames(ws).some((f) => (f.question ?? '').includes('test voltage'))).toBe(true);
    expect(session.dialogueScriptState?.active).toBe(true);
  });
});

describe('cycle 1 — classify-before-exclusive on the resolution turn (group C)', () => {
  test('"circuit 4, live to earth is 500" is a NAMED fresh reading — never written as test voltage', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    irTurn(ws, session, 'Insulation resistance. Live to live 200, live to earth 200.', 1000);
    ws.sent = [];
    const out = irTurn(
      ws,
      session,
      'circuit 4, live to earth is 500',
      2000,
      'circuit 4, live to earth is 500'
    );
    // Drained writes flushed exactly once; 500 is NEVER the voltage.
    const frames = extractionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(readingsOf(frames[0]).some((r) => r.field === 'ir_test_voltage')).toBe(false);
    // The M4 escape finished the prior episode audibly and handed the fresh
    // reading onward (reprocess found no entry → model owns it).
    const finish = askFrames(ws).find((f) => (f.question ?? '').startsWith('Got it.'));
    expect(finish).toBeTruthy();
    expect(out.handled === false || out.fallthrough === true).toBe(true);
  });
});

describe('cycle 1 — row (e) full ordered wire sequence (byte-level)', () => {
  test('volunteer-both → "It is circuit 4, tested at 500": exactly [extraction, finish-info], complete shapes', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    irTurn(ws, session, 'Insulation resistance. Live to live 200, live to earth 200.', 1000);
    ws.sent = [];
    irTurn(ws, session, 'It is circuit 4, tested at 500', 2000, 'It is circuit 4, tested at 500');
    expect(ws.sent).toEqual([
      {
        type: 'extraction',
        result: {
          readings: [
            {
              field: 'insulation_resistance_l_l',
              circuit: 4,
              value: '200',
              confidence: 1,
              source: 'ir_script',
            },
            {
              field: 'insulation_resistance_l_e',
              circuit: 4,
              value: '200',
              confidence: 1,
              source: 'ir_script',
            },
            {
              field: 'ir_test_voltage',
              circuit: 4,
              value: '500',
              confidence: 1,
              source: 'ir_script',
            },
          ],
          observations: [],
          questions: [],
        },
      },
      {
        type: 'ask_user_started',
        tool_call_id: 'srv-irs-sess_correction_paths-done-2000',
        question: 'Got it. L-L 200, L-E 200, voltage 500.',
        reason: 'info',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'none',
      },
    ]);
  });
});

describe('cycle 1 — RCD decision-table rows the entry-guard suite omitted', () => {
  test.each([
    'No RCD protection on circuit 4',
    'No RCD protection on the lighting circuits.',
    'I would say the general condition of the installation is satisfactory but there is no RCD protection.',
    'The RCD tripped.',
  ])('falls through to the model for %p', (transcriptText) => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger: null,
      now: 1000,
    });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent.length).toBe(0);
    expect(out.handled === false || out.fallthrough === true).toBe(true);
  });

  test('observation phrasing "Add an observation: no RCD protection…" stays with the model (pre-filter pinned)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Add an observation: no RCD protection on the lighting circuits.',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger: null,
      now: 1000,
    });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(out.handled === false || out.fallthrough === true).toBe(true);
  });
});
