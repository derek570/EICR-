/**
 * Observation-prefix pre-filter for the dialogue engine.
 *
 * 2026-05-31 field repro: inspector says "Observation: the RCD cover is
 * cracked." intending to log a defect. The RCD schema's trigger regex
 * (rcd.js:107  `/\bRCD\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i`)
 * matches the bare RCD mention, runEntry captures the turn, and the
 * engine emits "What's the BS number? Or do you want to fill that in
 * later?" — robbing Sonnet of the chance to call `record_observation`.
 *
 * Fix: at the bottom of processDialogueTurn — after the active-script
 * block has already returned for any in-flight script — short-circuit
 * to {handled: false} when OBSERVATION_PATTERN (pre-llm-gate.js:147)
 * matches the utterance. Sonnet then takes the turn and the observation
 * tool runs.
 *
 * Scope:
 *   - Only applies on the ENTRY path (no active script). An already-
 *     active script keeps its existing topicSwitchTriggers contract.
 *   - Uses the SAME OBSERVATION_PATTERN the pre-LLM gate uses (single
 *     source of truth — adding a Deepgram garble in one place fixes
 *     both).
 */

import {
  processDialogueTurn,
  rcdSchema,
  ocpdSchema,
  rcboSchema,
  ringContinuitySchema,
  insulationResistanceSchema,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_obs_prefilter';

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

class RecordingLogger {
  constructor() {
    this.events = [];
  }
  info(name, payload) {
    this.events.push({ name, payload });
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

describe('observation-prefix pre-filter — entry-time bypass', () => {
  test("today's repro — 'Observation: the RCD cover is cracked' bypasses RCD entry", () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {}, 3: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Observation: the RCD cover is cracked.',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });

    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);

    const bypassed = logger.events.find((e) => e.name === 'dialogue_entry_bypassed_observation');
    expect(bypassed).toBeTruthy();
    expect(bypassed.payload).toMatchObject({
      sessionId: SESSION_ID,
      textPreview: expect.stringContaining('Observation'),
    });
    expect(logger.events.find((e) => e.name === 'stage6.rcd_script_entered')).toBeUndefined();
  });

  test.each([
    'Observation, MCB tripped at the main board.',
    'Make an observation about the RCD on circuit 5.',
    'Observations — the OCPD label is missing on circuit 7.',
    'Add observation: RCBO 30 mA front loose.',
    // Deepgram garbles covered by OBSERVATION_PATTERN.
    'obvashon: RCD cover cracked',
    'obs: ring final cable damaged on circuit 4',
  ])('observation-prefixed utterance does NOT enter any walk-through: %p', (transcriptText) => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 7: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });

    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);
    expect(
      logger.events.find((e) => e.name === 'dialogue_entry_bypassed_observation')
    ).toBeTruthy();
  });

  test.each([
    // Plain RCD entry — no observation prefix → must still enter the RCD script.
    'RCD on circuit 4',
    'RCD trip time for circuit 5 is 25 ms',
    // OCPD / RCBO entries — likewise unaffected.
    'breaker 60898 on circuit 3',
    'RCBO on circuit 2',
    // Ring continuity / IR — likewise.
    'ring continuity for circuit 6',
    'insulation resistance for circuit 8',
  ])('non-observation utterance still enters its schema normally: %p', (transcriptText) => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, 8: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });

    expect(
      logger.events.find((e) => e.name === 'dialogue_entry_bypassed_observation')
    ).toBeUndefined();
    // Some path took the turn — either runEntry handled it, or it
    // emitted a which-circuit ask. Either way, NOT a no-op bypass.
    expect(out.handled === true || session.dialogueScriptState != null).toBe(true);
  });
});
