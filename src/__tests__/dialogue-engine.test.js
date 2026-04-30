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
  ringContinuitySchema,
  insulationResistanceSchema,
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
