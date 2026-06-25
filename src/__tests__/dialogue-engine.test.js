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
import {
  findCircuitsByDesignation,
  stripDesignationFiller,
} from '../extraction/dialogue-engine/helpers/circuit-resolution.js';

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
    // 1) extraction wire emit for R1=0.43.
    //    Audit-2026-06-02 Phase 3: buildExtractionPayload applies
    //    FIELD_CORRECTIONS inline, so the wire carries the legacy
    //    `ring_continuity_r1` name (iOS already accepted both via
    //    dual-alias decoders; the probe now documents intent).
    expect(ws.sent[0]).toMatchObject({
      type: 'extraction',
      result: {
        readings: [
          { field: 'ring_continuity_r1', circuit: 13, value: '0.43', source: 'ring_script' },
        ],
      },
    });
    // 2) ask for neutrals. context_field on ask_user_started still
    //    carries the canonical slot name (buildScriptAsk is NOT in
    //    the Phase 3 rewrite path — context_field documents the
    //    server-side slot identity, not the on-wire field rename).
    expect(ws.sent[1].question).toBe('What are the neutrals?');
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
    // Snapshot received the write under canonical key (rewrite is
    // wire-side only — applyReadingToSnapshot uses the slot field).
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
    // 2026-05-26: all-three-filled emits the confirmation ask first
    // (so the inspector can amend a Deepgram-garbled reading). Used
    // to be the one-way "Got it." info; that now lands after the
    // positive-confirmation turn below.
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      reason: 'confirm_ring_continuity',
      question: 'R1 0.43, Rn 0.43, R2 0.78. All correct?',
      expected_answer_shape: 'value',
    });
    expect(session.dialogueScriptState.awaiting_confirmation).toBe(true);

    // Inspector confirms → real finishScript runs and clears state.
    out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'yes',
      now: 5000,
    });
    // #34 (2026-06-19): completion ack is now terse — the confirmation prompt
    // above already read R1/Rn/R2 aloud, so the finish must NOT re-read them.
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      question: 'Got it.',
      expected_answer_shape: 'none',
    });
    expect(ws.sent.at(-1).question).not.toMatch(/R1|Rn|R2/);
    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ring_r1_ohm: '0.43',
      ring_rn_ohm: '0.43',
      ring_r2_ohm: '0.78',
    });
    expect(session.dialogueScriptState).toBeNull();
  });

  // M3 (field session 6674E8C5): the loop read-back speaks "R1 …, Rn …, R2 …",
  // so inspectors correct using those abbreviations. Before the namedExtractor
  // aliases were added the amend gate matched nothing and the correction was
  // dropped ("Sorry, I didn't catch what that reading was for"), costing two
  // wasted Sonnet round-trips.
  function walkToConfirmation() {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({ ws, session, sessionId: SESSION_ID, transcriptText: 'Ring continuity for circuit 13.', now: 1000 });
    processRingContinuityTurn({ ws, session, sessionId: SESSION_ID, transcriptText: '0.43', now: 2000 });
    processRingContinuityTurn({ ws, session, sessionId: SESSION_ID, transcriptText: 'Neutrals are 0.43.', now: 3000 });
    processRingContinuityTurn({ ws, session, sessionId: SESSION_ID, transcriptText: '0.78', now: 4000 });
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: 'R1 0.43, Rn 0.43, R2 0.78. All correct?',
    });
    return { ws, session };
  }

  test('amend via "Rn" abbreviation ("Your RN is 1.35") overwrites slot + re-emits confirm (no orphan drop)', () => {
    const { ws, session } = walkToConfirmation();
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Your RN is 1.35.',
      now: 5000,
    });
    // Consumed by the script (NOT dropped to Sonnet / orphan net).
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Slot overwritten + confirm re-emitted with the corrected value.
    expect(session.stateSnapshot.circuits[13].ring_rn_ohm).toBe('1.35');
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: 'R1 0.43, Rn 1.35, R2 0.78. All correct?',
    });
    expect(session.dialogueScriptState.awaiting_confirmation).toBe(true);
  });

  test('amend via "R1 is 0.50" abbreviation overwrites lives slot', () => {
    const { ws, session } = walkToConfirmation();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'R1 is 0.50.',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.50');
    expect(ws.sent.at(-1).question).toBe('R1 0.50, Rn 0.43, R2 0.78. All correct?');
  });

  test('amend via "R2 0.60" abbreviation overwrites CPC slot', () => {
    const { ws, session } = walkToConfirmation();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'R2 0.60.',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[13].ring_r2_ohm).toBe('0.60');
    expect(ws.sent.at(-1).question).toBe('R1 0.43, Rn 0.43, R2 0.60. All correct?');
  });

  test('"R1 plus R2" still exits via topic-switch (NOT captured by the new r-alias amend)', () => {
    const { ws, session } = walkToConfirmation();
    const before = ws.sent.length;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'R1 plus R2 is 0.47.',
      now: 5000,
    });
    // Topic-switch (engine.js:931) runs BEFORE the confirmation amend gate, so
    // this falls through to Sonnet rather than being eaten by the r2 alias.
    expect(out.fallthrough).toBe(true);
    // The R2 slot must NOT have been overwritten to 0.47 by the alias.
    expect(session.stateSnapshot.circuits[13].ring_r2_ohm).toBe('0.78');
    expect(before).toBeGreaterThan(0);
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

  // C2 (2026-06-19, session AD0AE9FA #35): an observation lead-in arriving
  // while a ring loop is active must NOT be eaten by the script. It exits the
  // loop (state cleared) and the transcript falls through to Sonnet, which
  // records the observation per RULE 1a. Two exit paths cover this:
  //   - the NEW observation topicSwitchTrigger (this fix) for single-circuit /
  //     bare observation lead-ins → { handled:true, fallthrough:true };
  //   - the pre-existing broadcast-intent abort (engine.js:94) for the exact
  //     session phrase, which names "circuits 1 and 2" → { handled:false }.
  // Both clear dialogueScriptState and let Sonnet see the utterance — the
  // observation is never silently consumed by the loop.
  test('#35: bare "observation." exits an active ring loop via topic switch (this fix)', () => {
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
      transcriptText: 'Observation.',
      now: 2000,
    });
    expect(out.handled).toBe(true);
    expect(out.fallthrough).toBe(true);
    expect(session.dialogueScriptState).toBeNull();
  });

  test('#35: single-circuit "observation note …" exits an active ring loop via topic switch', () => {
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
      transcriptText: 'Observation note the RCD cover is cracked.',
      now: 2000,
    });
    expect(out.handled).toBe(true);
    expect(out.fallthrough).toBe(true);
    expect(out.transcriptText).toBe('Observation note the RCD cover is cracked.');
    expect(session.dialogueScriptState).toBeNull();
  });

  test('#35: exact session phrase "Observation note RCD protection for circuits 1 and 2." is not eaten (broadcast-intent abort)', () => {
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
      transcriptText: 'Observation note RCD protection for circuits 1 and 2.',
      now: 2000,
    });
    // Not consumed by the loop — script aborts and the turn falls through to
    // Sonnet (handled:false is the "fall through to Sonnet flow" contract).
    expect(out).toEqual({ handled: false });
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
    // F1AC26FB #3.2 — stored form is now filler/punctuation-stripped.
    expect(session.dialogueScriptState.last_designation_attempt).toBe('upstairs socket');

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
      // F1AC26FB #3.2 — echo now strips trailing punctuation.
      question: "What's the circuit number for the upstairs socket?",
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
    // F1AC26FB #3.2 — the echo now strips trailing punctuation (and leading
    // filler), so the re-ask reads cleanly without the raw "." carried in.
    expect(ws.sent.at(-1).question).toBe("What's the circuit number for the upstairs socket?");
    expect(session.dialogueScriptState.last_designation_attempt).toBe('upstairs socket');
  });

  // ------------------------------------------------------------------
  // Designation disambiguation — CCU-populated boards routinely stamp
  // multiple circuits with the same generic label ("Sockets" × 3, etc.)
  // because the printed sticker is short. Inspector says "ring continuity
  // for the kitchen sockets" — three circuits match. The pre-fix engine
  // returned null and asked the generic "Which circuit?", losing the
  // queued R1=0.32 if the inspector then stumbled over the digit. Repro:
  // session 2DCCD937 (2026-05-03, 14 The Farm Close Road) — see CloudWatch
  // for the production trace these tests pin.
  // ------------------------------------------------------------------
  test('disambiguation: 3 identical "Sockets" → "Which sockets — circuit 2, 4 or 7?"', () => {
    const ws = new FakeWS();
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
      4: { circuit_designation: 'Sockets' },
      7: { circuit_designation: 'Sockets' },
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for the kitchen sockets. The lives are 0.32.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Disambiguation prompt: quotes the shared label, lists the refs.
    expect(ws.sent.at(-1).question).toBe("Which 'sockets' — circuit 2, 4 or 7?");
    expect(ws.sent.at(-1).reason).toBe('missing_context');
    // Volunteered R1 is queued, not lost — drains on resolution.
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.32' },
    ]);
    expect(session.dialogueScriptState.pending_designation_candidates).toEqual([2, 4, 7]);
  });

  test('disambiguation: 2 identical labels emit "X or Y" (no oxford comma)', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Lighting' },
      5: { circuit_designation: 'Lighting' },
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for the upstairs lighting.',
      now: 1000,
    });
    expect(ws.sent.at(-1).question).toBe("Which 'lighting' — circuit 2 or 5?");
  });

  test('disambiguation: digit answer in candidate list resolves and drains queued R1', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Sockets' },
      4: { circuit_designation: 'Sockets' },
      7: { circuit_designation: 'Sockets' },
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for the kitchen sockets. The lives are 0.32.',
      now: 1000,
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '4.',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // R1=0.32 wrote through to the chosen circuit — no inspector
    // re-dictation needed (the bug from session 2DCCD937).
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.32');
    // Script moved on to next slot (Rn).
    expect(ws.sent.at(-1).question).toBe('What are the neutrals?');
    expect(ws.sent.at(-1).context_circuit).toBe(4);
    // Candidate set cleared.
    expect(session.dialogueScriptState.pending_designation_candidates).toBeNull();
  });

  test('disambiguation: digit answer outside candidate set is rejected and re-asked', () => {
    const ws = new FakeWS();
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
      4: { circuit_designation: 'Sockets' },
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for the sockets.',
      now: 1000,
    });
    expect(ws.sent.at(-1).question).toBe("Which 'sockets' — circuit 2 or 4?");

    // Inspector mis-speaks "1" — Cooker, NOT one of the offered options.
    const logged = [];
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '1.',
      logger: { info: (e, p) => logged.push({ event: e, payload: p }) },
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Re-ask still scoped to the same candidate set.
    expect(ws.sent.at(-1).question).toBe("Which 'sockets' — circuit 2 or 4?");
    // Candidate set still set.
    expect(session.dialogueScriptState.pending_designation_candidates).toEqual([2, 4]);
    // The retry flag flipped — a SECOND out-of-set will fall through.
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(true);
    // Out-of-set rejection is logged so CloudWatch can flag chronic mis-picks.
    expect(
      logged.some(
        (r) =>
          r.event === 'stage6.ring_continuity_script_designation_disambiguation_out_of_set' &&
          r.payload.rejected === 1 &&
          r.payload.offered.toString() === [2, 4].toString()
      )
    ).toBe(true);
  });

  test('disambiguation: free-text answer narrows via designation match restricted to candidates', () => {
    // Inspector mentions two distinct circuit names in one entry
    // ("ring continuity for the cooker and shower"). Both designations
    // are substrings of the utterance, so 2 candidates surface with
    // distinct labels → generic "Which one — circuit X or Y?". The
    // inspector then answers "the cooker", and the active-path
    // designation match (restricted to [2, 4]) finds a unique hit.
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Cooker' },
      4: { circuit_designation: 'Shower' },
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for the cooker and shower.',
      now: 1000,
    });
    // Distinct designations → generic form.
    expect(ws.sent.at(-1).question).toBe('Which one — circuit 2 or 4?');

    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'the cooker',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.dialogueScriptState.circuit_ref).toBe(2);
    expect(ws.sent.at(-1).question).toBe('What are the lives?');
    expect(ws.sent.at(-1).context_circuit).toBe(2);
  });

  test('disambiguation: unique designation pre-fix path still resolves immediately', () => {
    // Smoke-test that a SINGLE-match designation continues to resolve at
    // entry without entering the disambiguation branch (the existing
    // behaviour the test file asserted before this change).
    const ws = new FakeWS();
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Upstairs Sockets' },
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for upstairs sockets.',
      now: 1000,
    });
    expect(ws.sent.at(-1).question).toBe('What are the lives?');
    expect(ws.sent.at(-1).context_circuit).toBe(2);
    expect(session.dialogueScriptState.pending_designation_candidates).toBeNull();
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
    // Phase 6.3 — cancel now emits a trailing `cancel_pending_tts`
    // control frame (no `.question`), so look up the cancel TTS by
    // type rather than positional `at(-1)`.
    const cancelAsk = [...ws.sent].reverse().find((m) => m?.type === 'ask_user_started');
    expect(cancelAsk?.question).toBe('Ring continuity cancelled. 1 of 3 saved.');
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

  // Per-slot no-progress cap (F1AC26FB #4.3). Three consecutive
  // unparseable answers to the same slot: hint on the 2nd, skip + Sonnet
  // fall-through on the 3rd. Closes the IR-LIM-style infinite re-ask loop
  // for ANY garble.
  describe('no-progress cap', () => {
    const enter = (ws, session, now) =>
      processInsulationResistanceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: 'Insulation resistance for circuit 13.',
        now,
      });
    const answer = (ws, session, text, now) =>
      processInsulationResistanceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        now,
      });

    test('2nd consecutive miss emits a format hint; 3rd skips + falls through', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
      enter(ws, session, 1000);
      expect(ws.sent.at(-1).context_field).toBe('ir_live_live_mohm');

      // Miss 1 — re-ask, no hint.
      const o1 = answer(ws, session, 'the weather is nice', 2000);
      expect(o1).toEqual({ handled: true, fallthrough: false });
      expect(ws.sent.some((m) => /no_progress_hint/.test(m.tool_call_id ?? ''))).toBe(false);

      // Miss 2 — format hint emitted (then the slot is re-asked).
      const o2 = answer(ws, session, 'the weather is nice', 3000);
      expect(o2).toEqual({ handled: true, fallthrough: false });
      const hint = ws.sent.find((m) => /no_progress_hint/.test(m.tool_call_id ?? ''));
      expect(hint).toBeDefined();
      expect(hint.question).toMatch(/LIM/);

      // Miss 3 — skip the slot + fall through to Sonnet.
      const o3 = answer(ws, session, 'the weather is nice', 4000);
      expect(o3).toMatchObject({ handled: true, fallthrough: true });
      expect(session.dialogueScriptState.skipped_slots.has('ir_live_live_mohm')).toBe(true);
    });

    test('a successful answer resets the miss counter', () => {
      const ws = new FakeWS();
      const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
      enter(ws, session, 1000);
      answer(ws, session, 'the weather is nice', 2000); // miss 1
      answer(ws, session, 'the weather is nice', 3000); // miss 2 (hint)
      // Now a real reading lands — progress resets the counter.
      answer(ws, session, 'live to live 200', 4000);
      expect(session.stateSnapshot.circuits[13].ir_live_live_mohm).toBe('200');
      expect(session.dialogueScriptState.slot_no_progress).toBeNull();

      // A single subsequent miss on the NEXT slot must not immediately skip.
      const o = answer(ws, session, 'the weather is nice', 5000);
      expect(o).toEqual({ handled: true, fallthrough: false });
      expect(session.dialogueScriptState.skipped_slots.has('ir_live_earth_mohm')).toBe(false);
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
    // Phase 6.3 — same cancel_pending_tts trailer as the ring test
    // above; find the cancel TTS by type, not position.
    const cancelAsk = [...ws.sent].reverse().find((m) => m?.type === 'ask_user_started');
    expect(cancelAsk?.question).toBe('Insulation resistance cancelled. 1 of 2 saved.');
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

  test('resolved-circuit + bare value + missed named-extractor → bails to Sonnet (handover)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 megaohms.',
      now: 1000,
    });
    // 2026-05-26 handover-to-Sonnet fix (session 87856B72 lineage):
    // when the trigger matched and the named-extractor missed but the
    // utterance carries a number+unit, the engine bails so Sonnet can
    // rescue the value via record_reading. tryEnterScriptFromWrites
    // then re-enters IR with the value pre-seeded. Old behaviour
    // entered the script with circuit_ref=13 and silently dropped
    // 299 — same bug class as the RCD trip-time miss.
    //
    // bareEntryParser still only fires on the unresolved-circuit
    // path (see "captures saturation sentinel" test above) — that
    // contract is unchanged because the bail's bareParserWouldCapture
    // gate requires circuitRef === null.
    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('named extractor bridges connector phrase: "live to live is greater than 299" (session 8782CB67)', () => {
    // Field repro 2026-06-02, session 8782CB67-…-540F8A, circuit 3:
    // inspector said "Downstairs sockets, insulation resistance. Live to
    // live is greater than 299." Engine entered the IR script with
    // volunteered_writes:[] and immediately TTS'd "What's the live-to-live?"
    // The L-L slot value was sitting in the entry utterance but the
    // namedExtractor's gap regex was `[^\\d∞>a-z]{0,30}?` — the a-z
    // exclusion blocked any letter-bearing connective ("is", "is greater
    // than", "was", "of"). Gap relaxed to `[^\\d∞]{0,30}?` so MEGAOHMS_VALUE_GROUP's
    // `greater\s+(?:than|then)\s+\d+` branch wins at the right position
    // and captures ">299" verbatim. Mirror change applies to L-E.
    //
    // Resolved-circuit path: the entry-time named-extractor write is
    // applied directly to the circuit (extraction payload on the wire +
    // snapshot mutation), NOT queued in pending_writes. The user-facing
    // proof is that the next ask jumps straight to L-E.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Downstairs Sockets' } });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        'Downstairs sockets, insulation resistance. Live to live is greater than 299.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Snapshot mutated with the harvested L-L value — canonical field
    // name regardless of wire-emit rewrites that may happen downstream.
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('>299');
    // Engine progresses to L-E ask — proves the L-L re-ask loop is broken.
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-earth?",
      context_field: 'ir_live_earth_mohm',
    });
  });

  test('named extractor bridges connector phrase on L-E: "live to earth is greater than 299"', () => {
    // Mirror coverage for the L-E slot — same gap relaxation, same risk
    // class. Without this test a future regression that re-tightens only
    // one slot would slip through. Engine should skip the L-E ask (asks
    // L-L first because that's the canonical first slot, then would jump
    // past L-E to voltage on the next turn — but we only test the entry
    // turn here).
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Downstairs Sockets' } });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to earth is greater than 299.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.stateSnapshot.circuits[3].ir_live_earth_mohm).toBe('>299');
  });

  test('connector form "live to live was 50" captures 50 (no unit required)', () => {
    // Defence-in-depth for the gap relaxation: bare integer after a
    // connector word should land in L-L verbatim, not be silently dropped.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Downstairs Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live was 50.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('50');
  });

  // Codex-review-2026-06-02 P1 — false-positive guards for the connector
  // allowlist. These pin the bridge so a future "let me just allow anything"
  // relaxation can't slip past — each test below corresponds to a safety-
  // critical wrong-reading scenario in production EICRs.

  test('does NOT capture a circuit-number digit as L-L value (codex p1)', () => {
    // Repro: "live to live for circuit 3 is greater than 299"
    //   Pre-fix bug: gap consumed " for circuit ", value-group's bare-digit
    //   alternative matched "3", L-L was certified as 3 megaohms (wildly
    //   under the safe minimum) before "greater than 299" was ever reached.
    //   Fix: connector allowlist rejects "for" — overall no-match, so the
    //   engine falls back to asking the inspector for the L-L value.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance live to live for circuit 3 is greater than 299.',
      now: 1000,
    });
    // No volunteered L-L on this entry — the engine asks for L-L.
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-live?",
      context_field: 'ir_live_live_mohm',
    });
  });

  test('does NOT match `o\\s*l` saturation sentinel inside "voltage" (codex p1)', () => {
    // Repro: "live to live voltage 500"
    //   Pre-fix bug: gap consumed " v", value-group's `o\\s*l` saturation
    //   sentinel matched the "ol" inside "voltage" and L-L was certified
    //   as ">999" (max range). The inspector probably said "voltage 500"
    //   meaning the test voltage; L-L was unstated. Fix: connector
    //   allowlist rejects "voltage" — overall no-match.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live voltage 500.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
  });

  test('does NOT bridge through "earth was" to swap labels (codex p1 corollary)', () => {
    // Repro: "live to live earth was 50"
    //   Pre-fix bug: gap consumed " earth was ", bare-digit branch matched
    //   "50", L-L was certified as 50 megaohms when the inspector clearly
    //   intended LIVE-TO-EARTH. Fix: connector allowlist rejects "earth".
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live earth was 50.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
  });

  test('bare-form punctuation is still tolerated: "L-L: 200" → 200', () => {
    // Regression guard: the connector allowlist tightening must NOT break
    // punctuation-as-separator forms (colon, comma, equals-no-space).
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. L-L: 200.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('200');
  });

  test('saturation sentinels still parse: "Live to live infinite" → ">999"', () => {
    // Regression guard: bare-form sentinel words ("infinite", "OL", "off
    // scale", "out of range") must still match via the value group when
    // they sit immediately after the label.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live infinite.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('>999');
  });

  // Second-pass Codex review (2026-06-02 commit a40c3664) caught two
  // residual holes in the first P1 fix — the connector "is" wasn't
  // anchored at its END, so it matched the first 2 chars of "isolation"
  // and then let the value-group's `o\\s*l` saturation sentinel match
  // "ol" mid-word. Same class for "old wiring". The bare-form 3-char cap
  // was also too tight for inspectors who pause-and-space ("L-L:   200").
  // Both fixes (\\b end-anchor + cap bump to 6 + value-group `\\bo\\s*l\\b`)
  // are pinned below.

  test('does NOT match `ol` inside "isolation" via partial connector match', () => {
    // Repro: "live to live isolation 500"
    //   First-pass fix bug: connector "is" matched the leading 2 chars of
    //   "isolation" without a closing word boundary; value group then
    //   matched `o\\s*l` inside "olation"; L-L certified as ">999".
    //   Fix: \\b at end of every word connector + \\bo\\s*l\\b in the
    //   value group itself (defence in depth).
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live isolation 500.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
  });

  test('does NOT match `ol` inside "old" via bare-form bridge', () => {
    // Repro: "live to live old wiring 500"
    //   Same root cause class as "isolation" — value group's `o\\s*l`
    //   sentinel matched "ol" inside the word "old". Fix: value group's
    //   `\\bo\\s*l\\b` requires word boundaries on both sides.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. Live to live old wiring 500.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
  });

  test('bare-form cap 6 tolerates multi-space padding: "L-L:   200" → 200', () => {
    // Regression guard for the cap bump (3 → 6 chars). Three spaces after
    // a colon is a common dictation cadence when inspectors pause before
    // reading the number. The original cap of 3 chars would have made
    // ":   " (4 chars) exceed it and the regex would fail.
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'Sockets' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 3. L-L:   200.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('200');
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
      // Commit 4: bare value moved into awaiting_disambiguation; the
      // resume hook now asks "Was 299 L-L or L-E?" before continuing.
      // The L-L vs L-E disambiguation tests below cover the answer
      // routing.
      ambiguous_bare_value: null,
      awaiting_disambiguation: { value: '299', source: 'megaohm' },
    });
    expect(wsAfter.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: 'Was 299 megaohms live-to-live or live-to-earth?',
      context_circuit: 2,
      context_field: '_ir_disambiguate_bare',
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

describe('engine — IR L-L vs L-E disambiguation after resume (commit 4)', () => {
  function pauseIrForCookerAndResume({ session, snapshotForCooker = {} }, now = 4000) {
    const wsPause = new FakeWS();
    processInsulationResistanceTurn({
      ws: wsPause,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for the cooker is 299 milligrams.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws: wsPause,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'unresolvable 1',
      now: 2000,
    });
    processInsulationResistanceTurn({
      ws: wsPause,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cooker circuit',
      now: 3000,
    });
    expect(session.dialogueScriptState.paused).toBe(true);

    session.stateSnapshot.circuits[2] = {
      circuit_designation: 'Cooker',
      ...snapshotForCooker,
    };
    const wsResume = new FakeWS();
    const out = tryResumePausedScript({
      session,
      ws: wsResume,
      schemas: ALL_DIALOGUE_SCHEMAS,
      circuitUpdates: [{ op: 'create', circuit_ref: 2, meta: { designation: 'Cooker' } }],
      now,
    });
    expect(out).toEqual({ resumed: true, circuit_ref: 2 });
    return wsResume;
  }

  test('both L-L and L-E empty → asks disambiguation question', () => {
    const session = buildSession({ 1: { circuit_designation: 'Upstairs Sockets' } });
    const ws = pauseIrForCookerAndResume({ session });

    expect(session.dialogueScriptState.awaiting_disambiguation).toEqual({
      value: '299',
      source: 'megaohm',
    });
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: 'Was 299 megaohms live-to-live or live-to-earth?',
      context_circuit: 2,
      context_field: '_ir_disambiguate_bare',
    });
  });

  test('user answers "live to live" → 299 lands in ir_live_live_mohm, asks L-E next', () => {
    const session = buildSession({});
    pauseIrForCookerAndResume({ session });

    const ws2 = new FakeWS();
    const out = processInsulationResistanceTurn({
      ws: ws2,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'live to live',
      now: 5000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      circuit_designation: 'Cooker',
      ir_live_live_mohm: '299',
    });
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
    // After resolution, walk-through proceeds to the next missing slot.
    expect(ws2.sent.at(-1)).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-earth?",
      context_field: 'ir_live_earth_mohm',
      context_circuit: 2,
    });
  });

  test('user answers "L-E" → 299 lands in ir_live_earth_mohm, asks L-L next', () => {
    const session = buildSession({});
    pauseIrForCookerAndResume({ session });

    const ws2 = new FakeWS();
    processInsulationResistanceTurn({
      ws: ws2,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'L-E',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      ir_live_earth_mohm: '299',
    });
    expect(ws2.sent.at(-1)).toMatchObject({
      question: "What's the live-to-live?",
      context_field: 'ir_live_live_mohm',
    });
  });

  test('user answers "neither" → bare value discarded, asks L-L next', () => {
    const session = buildSession({});
    pauseIrForCookerAndResume({ session });

    const ws2 = new FakeWS();
    processInsulationResistanceTurn({
      ws: ws2,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'neither',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[2]).not.toHaveProperty('ir_live_live_mohm');
    expect(session.stateSnapshot.circuits[2]).not.toHaveProperty('ir_live_earth_mohm');
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
    expect(ws2.sent.at(-1)).toMatchObject({
      question: "What's the live-to-live?",
    });
  });

  test('unparseable answer → re-asks once, then drops on second unparseable', () => {
    const session = buildSession({});
    pauseIrForCookerAndResume({ session });

    const ws2 = new FakeWS();
    processInsulationResistanceTurn({
      ws: ws2,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'um, what?',
      now: 5000,
    });
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeTruthy();
    expect(session.dialogueScriptState.disambiguation_retry_attempted).toBe(true);
    expect(ws2.sent.at(-1).question).toBe('Was 299 megaohms live-to-live or live-to-earth?');

    const ws3 = new FakeWS();
    processInsulationResistanceTurn({
      ws: ws3,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'still nonsense',
      now: 6000,
    });
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
    // Walk-through continues — next missing slot is L-L (nothing was saved).
    expect(ws3.sent.at(-1)).toMatchObject({
      question: "What's the live-to-live?",
    });
  });

  test('L-L slot already filled → auto-assigns 299 to L-E without asking', () => {
    const session = buildSession({});
    const ws = pauseIrForCookerAndResume({
      session,
      snapshotForCooker: { ir_live_live_mohm: '500' },
    });
    // No question — auto-assigned.
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      ir_live_live_mohm: '500',
      ir_live_earth_mohm: '299',
    });
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
    // Last emit is the next-slot ask (voltage).
    expect(ws.sent.at(-1)).toMatchObject({
      question: 'What was the test voltage?',
    });
  });

  test('L-E slot already filled → auto-assigns 299 to L-L without asking', () => {
    const session = buildSession({});
    pauseIrForCookerAndResume({
      session,
      snapshotForCooker: { ir_live_earth_mohm: '888' },
    });
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      ir_live_earth_mohm: '888',
      ir_live_live_mohm: '299',
    });
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
  });

  test('both L-L and L-E already filled → bare value discarded silently', () => {
    const session = buildSession({});
    const ws = pauseIrForCookerAndResume({
      session,
      snapshotForCooker: { ir_live_live_mohm: '500', ir_live_earth_mohm: '600' },
    });
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      ir_live_live_mohm: '500',
      ir_live_earth_mohm: '600',
    });
    expect(session.dialogueScriptState.ambiguous_bare_value).toBeNull();
    expect(session.dialogueScriptState.awaiting_disambiguation).toBeNull();
    // Walk-through proceeds straight to voltage.
    expect(ws.sent.at(-1)).toMatchObject({
      question: 'What was the test voltage?',
    });
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

// ---------------------------------------------------------------------------
// Designation filler-strip + echo (F1AC26FB #3.1/#3.2)
// ---------------------------------------------------------------------------
describe('stripDesignationFiller', () => {
  test('strips leading "for the" and trailing period', () => {
    expect(stripDesignationFiller('For the sockets.')).toBe('sockets');
  });

  test('strips bare leading article + trailing punctuation', () => {
    expect(stripDesignationFiller('the upstairs lights?')).toBe('upstairs lights');
    expect(stripDesignationFiller('on the cooker')).toBe('cooker');
  });

  test('leaves a clean designation untouched', () => {
    expect(stripDesignationFiller('kitchen sockets')).toBe('kitchen sockets');
  });

  test('non-string / empty → ""', () => {
    expect(stripDesignationFiller(null)).toBe('');
    expect(stripDesignationFiller('   ')).toBe('');
  });
});

describe('findCircuitsByDesignation — filler-stripped user text resolves', () => {
  test('"For the sockets." matches circuit 2 designation "Sockets"', () => {
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
    });
    const r = findCircuitsByDesignation(session, 'For the sockets.');
    expect(r.matched).toBe(2);
  });

  test('returns no match when the designation is absent (the [contract] #3.4 server gap)', () => {
    // When create/rename churn left circuit 2 with an empty designation,
    // there is nothing to match — the strip fix only helps once the
    // designation is present. (#3.4 — making the designation reach the
    // server snapshot — is a deferred [contract] item, not done here.)
    const session = buildSession({ 1: { circuit_designation: 'Cooker' }, 2: {} });
    const r = findCircuitsByDesignation(session, 'For the sockets.');
    expect(r.matched).toBeNull();
  });
});

describe('engine — designation resolution + clean echo (F1AC26FB #3)', () => {
  test('IR queued readings drain onto circuit matched via "For the sockets."', () => {
    const ws = new FakeWS();
    const session = buildSession({
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
    });
    // Enter IR with an L-L reading volunteered but no circuit named.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance live to live 200.',
      now: 1000,
    });
    expect(session.dialogueScriptState.pending_writes.length).toBeGreaterThan(0);

    // Answer with filler-prefixed designation — resolves to circuit 2.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'For the sockets.',
      now: 2000,
    });
    expect(session.dialogueScriptState.circuit_ref).toBe(2);
    expect(session.stateSnapshot.circuits[2].ir_live_live_mohm).toBe('200');
  });

  test('unresolvable answer re-ask never echoes raw "for the" or trailing period', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: { circuit_designation: 'Cooker' } });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance live to live 200.',
      now: 1000,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'For the wibble.',
      now: 2000,
    });
    const q = ws.sent.at(-1).question;
    expect(q).not.toMatch(/for the for the/i);
    expect(q).toContain('wibble');
    expect(q).not.toContain('wibble.');
  });
});
