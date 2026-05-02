/**
 * Integration tests for the dialogue script engine. These run the same
 * ring + IR scenarios that would have driven the legacy scripts and
 * assert byte-identical wire output.
 *
 * The 190 unit tests in ring-continuity-script.test.js and
 * insulation-resistance-script.test.js continue to validate the legacy
 * scripts directly until the call site cuts over and the legacy files
 * are deleted (follow-up commit).
 */

import {
  processRingContinuityTurn,
  processInsulationResistanceTurn,
  processDialogueTurn,
  tryResumePausedScript,
  ringContinuitySchema,
  insulationResistanceSchema,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_test';

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
    stateSnapshot: { circuits },
  };
}

describe('engine — ring continuity', () => {
  test('entry with circuit number asks for first missing slot', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      tool_call_id: 'srv-rcs-sess_test-13-ring_r1_ohm-1000',
      question: 'What are the lives?',
      reason: 'missing_value',
      context_field: 'ring_r1_ohm',
      context_circuit: 13,
      expected_answer_shape: 'value',
    });
  });

  test('entry with designation match resolves circuit and asks lives', () => {
    const ws = new FakeWS();
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Upstairs Sockets' },
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for upstairs sockets.',
      logger: null,
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent[0].question).toBe('What are the lives?');
    expect(ws.sent[0].context_circuit).toBe(2);
  });

  test('Chucklesville repro: existing R1+Rn skipped, asks for CPC', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: {
        circuit_designation: 'Upstairs Sockets',
        ring_r1_ohm: '0.83',
        ring_rn_ohm: '0.82',
      },
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for upstairs sockets.',
      logger: null,
      now: 3000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent[0].question).toBe("What's the CPC?");
    expect(ws.sent[0].context_field).toBe('ring_r2_ohm');
  });

  test('values dictated upfront with circuit are written and next-missing asked', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives are 0.43.',
      logger: null,
      now: 4000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // 1) extraction wire emit for R1=0.43
    expect(ws.sent[0]).toMatchObject({
      type: 'extraction',
      result: {
        readings: [{ field: 'ring_r1_ohm', circuit: 13, value: '0.43', source: 'ring_script' }],
      },
    });
    // 2) ask for neutrals
    expect(ws.sent[1].question).toBe('What are the neutrals?');
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
    // Snapshot received the write
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
  });

  test('full walkthrough: lives → neutrals → CPC → finished', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    let out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    expect(ws.sent.at(-1).question).toBe('What are the lives?');

    out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.43',
      now: 2000,
    });
    expect(ws.sent.at(-1).question).toBe('What are the neutrals?');

    out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Neutrals are 0.43.',
      now: 3000,
    });
    expect(ws.sent.at(-1).question).toBe("What's the CPC?");

    out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.78',
      now: 4000,
    });
    // Last emit is the completion info
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      question: 'Got it. R1 0.43, Rn 0.43, R2 0.78.',
      expected_answer_shape: 'none',
    });
    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ring_r1_ohm: '0.43',
      ring_rn_ohm: '0.43',
      ring_r2_ohm: '0.78',
    });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('topic switch falls through to Sonnet with same transcript', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62.',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'Zs is 0.62.',
    });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('Silvertown repro — first unresolvable circuit answer re-asks instead of discarding R1', () => {
    // 2026-04-30 14 Silvertown Road (session 842A3289): inspector said
    // "Ring continuity lives are 0.32" → script entered, R1=0.32 queued,
    // asked "Which circuit?". Inspector answered "upstairs socket"
    // (Deepgram dropped the trailing 's'). Snapshot didn't yet have
    // circuit 4's designation set, so designation lookup returned null.
    // OLD behaviour: discarded R1=0.32 + fallthrough to Sonnet.
    // NEW behaviour: re-ask once with the user's text quoted back, keep
    //                R1=0.32 in pending_writes, keep script alive.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} }); // no designation on circuit 4 yet
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity lives are 0.32.',
      now: 1000,
    });
    // Sanity: entry asked "which circuit?" and queued R1.
    expect(ws.sent[0].question).toBe('Which circuit is the ring continuity for?');
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.32' },
    ]);
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(false);

    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'upstairs socket.',
      now: 2000,
    });

    // Engine stays alive — Sonnet stays muted.
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.dialogueScriptState).not.toBeNull();
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(true);
    expect(session.dialogueScriptState.last_designation_attempt).toBe('upstairs socket.');

    // R1 was NOT discarded — still queued for the resolved circuit.
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.32' },
    ]);

    // Re-ask quotes the user's text back so the second attempt is unambiguous.
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      reason: 'missing_context',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'value',
      question: "What's the circuit number for the upstairs socket.?",
    });
  });

  test('Silvertown repro — second answer with circuit number drains pending_writes', () => {
    // Continuation of the above. Inspector hears the re-ask "What's the
    // circuit number for the upstairs socket?" and answers "4". R1=0.32
    // must land on circuit 4 and the script must move on to ask R_n.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity lives are 0.32.',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'upstairs socket.',
      now: 2000,
    });

    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '4.',
      now: 3000,
    });

    expect(out).toEqual({ handled: true, fallthrough: false });
    // R1 wrote through to circuit 4 — no inspector re-dictation needed.
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.32');
    // Script moved on to next slot (Rn).
    expect(ws.sent.at(-1).question).toBe('What are the neutrals?');
    expect(ws.sent.at(-1).context_field).toBe('ring_rn_ohm');
    expect(ws.sent.at(-1).context_circuit).toBe(4);
  });

  test('second consecutive unresolvable answer falls through to Sonnet (current behaviour preserved)', () => {
    // The retry budget is one. If the second answer is also unresolvable,
    // fall through as before — Sonnet is the safety net. The log row
    // gets a `retry_attempted: true` field so CloudWatch can split first-
    // miss recoveries from genuine fallthroughs.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity lives are 0.32.',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'upstairs socket.',
      now: 2000,
    });

    // Logger spy to verify the discard log carries retry_attempted.
    const logged = [];
    const logger = {
      info: (event, payload) => logged.push({ event, payload }),
    };

    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'um, the cooker?',
      logger,
      now: 3000,
    });

    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'um, the cooker?',
    });
    expect(session.dialogueScriptState).toBeNull();
    const discardRow = logged.find(
      (r) => r.event === 'stage6.ring_continuity_script_unresolvable_circuit'
    );
    expect(discardRow).toBeDefined();
    expect(discardRow.payload.retry_attempted).toBe(true);
    expect(discardRow.payload.discarded_pending_writes).toEqual(['ring_r1_ohm']);
  });

  test('retry path also fires for IR (engine-shared, schema-agnostic)', () => {
    // Fix 1 lives in the engine, not in any schema, so every schema that
    // reaches the unresolvable-circuit branch benefits. This test pins
    // the IR analogue of the Silvertown repro.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance live to live 200.',
      now: 1000,
    });
    expect(session.dialogueScriptState.pending_writes.length).toBeGreaterThan(0);

    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'upstairs socket.',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.dialogueScriptState).not.toBeNull();
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(true);
    expect(ws.sent.at(-1).question).toBe("What's the circuit number for the upstairs socket.?");
  });

  test('cancel emits info and clears state, no fallthrough', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Lives are 0.43.',
      now: 2000,
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel that',
      now: 3000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent.at(-1).question).toBe('Ring continuity cancelled. 1 of 3 saved.');
    expect(session.dialogueScriptState).toBeNull();
    // R1 was preserved on the snapshot (cancel preserves writes).
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
  });
});

describe('engine — insulation resistance', () => {
  test('entry asks for first missing slot (L-L)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 13.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      tool_call_id: 'srv-irs-sess_test-13-ir_live_live_mohm-1000',
      question: "What's the live-to-live?",
      context_field: 'ir_live_live_mohm',
      context_circuit: 13,
    });
  });

  test('full walkthrough: L-L → L-E → voltage → finished', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 13.',
      now: 1000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ir_live_live_mohm');

    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '200',
      now: 2000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ir_live_earth_mohm');

    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'over 999',
      now: 3000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ir_test_voltage_v');

    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '500',
      now: 4000,
    });
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      question: 'Got it. L-L 200, L-E >999, voltage 500.',
    });
    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ir_live_live_mohm: '200',
      ir_live_earth_mohm: '>999',
      ir_test_voltage_v: '500',
    });
  });

  test('voltage phase silently finishes on unparseable reply', () => {
    const ws = new FakeWS();
    const session = buildSession({
      13: { ir_live_live_mohm: '200', ir_live_earth_mohm: '200' },
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 13.',
      now: 1000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ir_test_voltage_v');

    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'uhh come back later',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // The completion info still emits even though voltage didn't parse —
    // matching the legacy script's "we still finish" comment.
    expect(ws.sent.at(-1).reason).toBe('info');
    expect(ws.sent.at(-1).question).toBe('Got it. L-L 200, L-E 200.');
    expect(session.dialogueScriptState).toBeNull();
  });

  test('cancel during readings shows count of 2 (voltage excluded)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 13.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '200',
      now: 2000,
    });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel',
      now: 3000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent.at(-1).question).toBe('Insulation resistance cancelled. 1 of 2 saved.');
  });
});

describe('engine — IR bare-value capture at entry (session C3963EA1)', () => {
  test('captures "299 milligrams" when circuit_ref unresolved at entry', () => {
    const ws = new FakeWS();
    // Cooker circuit doesn't exist yet — repro of the field failure.
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 milligrams.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Engine asks which circuit (no circuit_ref bound).
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      question: 'Which circuit is the insulation resistance for?',
    });
    // Bare value is stashed for the resume path to consume.
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      circuit_ref: null,
      ambiguous_bare_value: { value: '299', source: 'megaohm' },
    });
  });

  test('accepts "megaohms" / "MΩ" / "megs" units', () => {
    for (const utterance of [
      'Insulation resistance for the kitchen is 200 megaohms.',
      'Insulation resistance for the kitchen is 200 MΩ.',
      'Insulation resistance for the kitchen is 200 megs.',
    ]) {
      const ws = new FakeWS();
      const session = buildSession({});
      processInsulationResistanceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: utterance,
        now: 1000,
      });
      expect(session.dialogueScriptState.ambiguous_bare_value).toEqual({
        value: '200',
        source: 'megaohm',
      });
    }
  });

  test('captures saturation sentinel "greater than 999 megaohms"', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is greater than 999 megaohms.',
      now: 1000,
    });
    expect(session.dialogueScriptState.ambiguous_bare_value).toEqual({
      value: '>999',
      source: 'megaohm',
    });
  });

  test('does NOT misinterpret "circuit 5" as 5 MΩ — unit suffix required', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      // No unit on the bare number; only "circuit 5" reference.
      transcriptText: 'Insulation resistance for circuit 5.',
      now: 1000,
    });
    // circuit_ref bound from the trigger regex; bare-value capture skipped
    // (resolved-circuit path doesn't capture, plus there's no megaohm unit).
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
  });

  test('does NOT capture when L-L tag is present (named extractor wins)', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker live to live 200 megaohms.',
      now: 1000,
    });
    // Named extraction queued L-L=200; bare capture should NOT also fire
    // (it gates on writes.length === 0).
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
    ]);
  });

  test('does NOT capture when circuit_ref resolves at entry', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 megaohms.',
      now: 1000,
    });
    // Resolved-circuit path runs the existing walk-through; bare capture
    // is gated on circuit_ref === null.
    expect(session.dialogueScriptState.circuit_ref).toBe(13);
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
  });
});

describe('engine — IR pause-on-second-miss for resume hook (session C3963EA1)', () => {
  test('second-miss with ambiguous_bare_value pauses (does NOT clear)', () => {
    const ws = new FakeWS();
    // No "cooker" circuit exists yet — the field-test repro.
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });

    // Turn 1: entry with bare 299, no circuit. Engine asks "which circuit?".
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 milligrams.',
      now: 1000,
    });
    expect(session.dialogueScriptState.ambiguous_bare_value).toEqual({
      value: '299',
      source: 'megaohm',
    });

    // Turn 2: user answers "bigger circuit" — unresolvable, retry fires.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'bigger circuit.',
      now: 2000,
    });
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(true);
    expect(session.dialogueScriptState.active).toBe(true);

    // Turn 3: second miss "cooker circuit" — under old behaviour state
    // would be cleared and 299 lost. New behaviour pauses the script
    // with the bare value preserved for the resume hook.
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cooker circuit',
      now: 3000,
    });
    expect(out).toEqual({ handled: true, fallthrough: true, transcriptText: 'cooker circuit' });
    expect(session.dialogueScriptState).toMatchObject({
      active: false,
      paused: true,
      paused_designation_hint: 'cooker circuit',
      paused_at: 3000,
      ambiguous_bare_value: { value: '299', source: 'megaohm' },
      schemaName: 'insulation_resistance',
    });
  });

  test('second-miss with NO resumable context falls through and clears (existing behaviour)', () => {
    const ws = new FakeWS();
    // No bare value in entry, no named values either — script is just
    // empty waiting for the inspector to name a circuit.
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      // Trigger only — no bare value, no L-L/L-E tag.
      transcriptText: 'Insulation resistance.',
      now: 1000,
    });
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
    expect(session.dialogueScriptState.pending_writes).toEqual([]);

    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'bigger circuit.',
      now: 2000,
    });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cooker circuit',
      now: 3000,
    });
    // Existing fallthrough behaviour preserved when there's nothing to resume.
    expect(out).toEqual({ handled: true, fallthrough: true, transcriptText: 'cooker circuit' });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('paused state survives a non-IR turn (engine returns handled:false)', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 megaohms.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something unresolvable',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something else unresolvable',
      now: 3000,
    });
    // Now paused. A subsequent off-topic utterance must NOT enter the
    // active path (active=false) and must not clear the paused state.
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'random off-topic chatter.',
      now: 4000,
    });
    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toMatchObject({
      paused: true,
      ambiguous_bare_value: { value: '299', source: 'megaohm' },
    });
  });

  test('paused state cleared after hardTimeoutMs sweep', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 megaohms.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something unresolvable',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something else unresolvable',
      now: 3000,
    });
    expect(session.dialogueScriptState.paused).toBe(true);

    // IR schema hardTimeoutMs is 180_000. Wait past that.
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'unrelated text long after the pause.',
      now: 3000 + 180_001,
    });
    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('fresh IR utterance after pause overwrites paused state with new entry', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { circuit_designation: 'Lights' } });
    // Pause with bare 299 for an unresolvable cooker.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 megaohms.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'unresolvable 1',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'unresolvable 2',
      now: 3000,
    });
    expect(session.dialogueScriptState.paused).toBe(true);

    // Inspector pivots to a different circuit — fresh IR entry overwrites
    // the paused state. (Old paused state is implicitly abandoned.)
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 5.',
      now: 4000,
    });
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      paused: false,
      circuit_ref: 5,
      ambiguous_bare_value: null,
    });
  });
});

describe('engine — tryResumePausedScript (post-Sonnet-turn hook)', () => {
  // Helper: pause an IR script for "cooker" with bare 299 captured.
  function pauseIrForCooker(session, ws) {
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 milligrams.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'bigger circuit.',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cooker circuit',
      now: 3000,
    });
    expect(session.dialogueScriptState.paused).toBe(true);
  }

  test('resumes when create_circuit produces a designation-matching circuit', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    pauseIrForCooker(session, ws);

    // Sonnet creates the cooker circuit (matching the paused hint).
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Cooker' };

    const wsAfter = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsAfter,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 2, meta: { designation: 'Cooker' } }],
      now: 4000,
    });

    expect(out).toEqual({ resumed: true, circuit_ref: 2 });
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      paused: false,
      paused_designation_hint: null,
      paused_at: null,
      circuit_ref: 2,
      ambiguous_bare_value: { value: '299', source: 'megaohm' },
    });
    // Engine asks the next missing slot — currently L-L (Commit 4 will
    // intercept here with a disambiguation question instead).
    expect(wsAfter.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-live?",
      context_circuit: 2,
      context_field: 'ir_live_live_mohm',
    });
  });

  test('resumes via rename_circuit op too', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    pauseIrForCooker(session, ws);

    // Sonnet renamed an existing circuit 7 to Cooker.
    session.stateSnapshot.circuits[7] = { circuit_designation: 'Cooker' };

    const wsAfter = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsAfter,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'rename', circuit_ref: 7, meta: { designation: 'Cooker' } }],
      now: 4000,
    });

    expect(out).toEqual({ resumed: true, circuit_ref: 7 });
    expect(session.dialogueScriptState.circuit_ref).toBe(7);
  });

  test('does NOT resume when the new circuit designation is unrelated', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    pauseIrForCooker(session, ws);

    // Sonnet created a circuit for something completely different.
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Garage' };

    const wsAfter = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsAfter,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 2, meta: { designation: 'Garage' } }],
      now: 4000,
    });

    expect(out).toEqual({ resumed: false, reason: 'no_designation_match' });
    expect(session.dialogueScriptState.paused).toBe(true);
    expect(wsAfter.sent).toEqual([]);
  });

  test("does NOT resume when matched ref isn't in this turn's circuit_updates", () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    pauseIrForCooker(session, ws);

    // After the pause, two circuits get added before the resume hook runs:
    //   - Sonnet (this turn) created circuit 5 (Garage)
    //   - A separate path (e.g. CCU import on a previous turn) added a Cooker
    //     to the snapshot
    // The hint matches Cooker (circuit 9), but the only op THIS turn was for
    // Garage (circuit 5). Guard fires so we don't claim Garage's create as
    // the resume trigger when the designation actually maps elsewhere.
    session.stateSnapshot.circuits[5] = { circuit_designation: 'Garage' };
    session.stateSnapshot.circuits[9] = { circuit_designation: 'Cooker' };

    const wsAfter = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsAfter,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 5, meta: { designation: 'Garage' } }],
      now: 4000,
    });

    // Designation match on circuit 9 (Cooker) — but op was for 5.
    // Guard fires: matched_ref_not_in_circuit_updates.
    expect(out).toEqual({ resumed: false, reason: 'matched_ref_not_in_circuit_updates' });
    expect(session.dialogueScriptState.paused).toBe(true);
  });

  test('does NOT resume when no paused script exists', () => {
    const session = buildSession({});
    const out = tryResumePausedScript({
      session,
      ws: new FakeWS(),
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 1, meta: { designation: 'Cooker' } }],
      now: 1000,
    });
    expect(out).toEqual({ resumed: false, reason: 'no_paused_script' });
  });

  test('does NOT resume when circuit_updates is empty', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    pauseIrForCooker(session, ws);

    const out = tryResumePausedScript({
      session,
      ws: new FakeWS(),
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [],
      now: 4000,
    });
    expect(out).toEqual({ resumed: false, reason: 'no_circuit_updates' });
    expect(session.dialogueScriptState.paused).toBe(true);
  });

  test('drains queued pending_writes onto the resumed circuit and emits extraction payload', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    // Pause path with a NAMED L-L value (not bare): "live to live 200" is queued
    // as pending_writes for ir_live_live_mohm. After the cooker circuit is
    // created, the resume hook should drain that write onto circuit 2.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker live to live 200 megaohms.',
      now: 1000,
    });
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
    ]);
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'unresolvable 1',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cooker circuit',
      now: 3000,
    });
    expect(session.dialogueScriptState.paused).toBe(true);
    expect(session.dialogueScriptState.pending_writes).toHaveLength(1);

    // Sonnet creates Cooker.
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Cooker' };

    const wsAfter = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsAfter,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 2, meta: { designation: 'Cooker' } }],
      now: 4000,
    });

    expect(out).toEqual({ resumed: true, circuit_ref: 2 });
    // Pending write drained onto circuit 2 in the snapshot.
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      circuit_designation: 'Cooker',
      ir_live_live_mohm: '200',
    });
    expect(session.dialogueScriptState.pending_writes).toEqual([]);
    // Extraction payload + next-slot ask emitted.
    expect(wsAfter.sent.find((m) => m.type === 'extraction')).toBeDefined();
    expect(wsAfter.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-earth?",
    });
  });

  test('does NOT resume after hardTimeoutMs has elapsed', () => {
    const ws = new FakeWS();
    const session = buildSession({});
    pauseIrForCooker(session, ws);
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Cooker' };

    // 180_001ms past the pause moment (3000) — over the IR hard timeout.
    const out = tryResumePausedScript({
      session,
      ws: new FakeWS(),
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 2, meta: { designation: 'Cooker' } }],
      now: 3000 + 180_001,
    });
    expect(out).toEqual({ resumed: false, reason: 'paused_timeout' });
    expect(session.dialogueScriptState).toBeNull();
  });
});

describe('engine — Deepgram garble tolerance (2026-04-30)', () => {
  test('"Bring continuity for upstairs sockets" enters ring (session 2801896A)', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Upstairs Sockets' },
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Bring continuity for upstairs sockets.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent[0].context_circuit).toBe(2);
    expect(ws.sent[0].question).toBe('What are the lives?');
  });

  test('"Wing continuity for upstairs sockets" enters ring (session BD8AB009)', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Upstairs Sockets' },
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Wing continuity for upstairs sockets.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent[0].context_circuit).toBe(2);
  });

  test('"R1 plus R2 is 47" mid-script is a topic switch (session BD8AB009)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { circuit_designation: 'Upstairs Sockets' } });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 2.',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Lives are 0.06.',
      now: 2000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.06',
      now: 3000,
    });
    // Now the engine has asked "What's the CPC?" — the user instead says
    // "R1 plus R2 is 47", which is the composite reading. Engine MUST
    // topic-switch out (not write "1" via bare-value parsing of "R1").
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'R1 plus R2 is 47',
      now: 4000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'R1 plus R2 is 47',
    });
    // The CPC slot must NOT have been written.
    expect(session.stateSnapshot.circuits[2].ring_r2_ohm).toBeUndefined();
    expect(session.dialogueScriptState).toBeNull();
  });

  test('"R1 + R2 is 47" with literal "+" still works (back-compat)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { circuit_designation: 'Upstairs Sockets' } });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 2.',
      now: 1000,
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'R1+R2 is 47',
      now: 2000,
    });
    expect(out.fallthrough).toBe(true);
  });
});

describe('engine — schema isolation', () => {
  test('ring active state is preserved when IR wrapper is invoked', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    const ringStateBefore = { ...session.dialogueScriptState };
    expect(ringStateBefore.schemaName).toBe('ring_continuity');

    // Invoking IR's wrapper while ring is active must NOT touch ring state.
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'irrelevant text',
      now: 2000,
    });
    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState.schemaName).toBe('ring_continuity');
  });
});
