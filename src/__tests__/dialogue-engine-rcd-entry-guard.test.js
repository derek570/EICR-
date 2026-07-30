/**
 * PLAN-backend-final.md Phase 6.4 — tests for the RCD entry guard +
 * cancel-drain WS emit.
 *
 * Repro context: session 60754E4D had the inspector say "please delete
 * RCD" / "why haven't you deleted the RCD trip time" six times in two
 * minutes. The RCD schema's `\bRCD\b` trigger matched each utterance,
 * runEntry captured the turn, and the script re-asked the deferred
 * `rcd_bs_en` slot — an unwanted re-entry loop.
 *
 * Phase 6.1 — when a transcript contains \bRCD\b AND a corrective
 *   imperative (delete/undo/cancel/fix/why/stop/remove/clear) OR a
 *   denial/complaint phrase (what are you / i didn't / that's wrong /
 *   that's not), the RCD schema's entry is SKIPPED. Sonnet's own
 *   tools (clear_reading / delete_circuit / record_reading) take the
 *   turn instead.
 *
 * Phase 6.3 — on *_script_cancelled, backend emits
 *   `cancel_pending_tts {prefix: "srv-{script}-"}` so iOS can purge
 *   queued TTS in the same script namespace. iOS slice 7.1 wires
 *   this to AlertManager.purge(prefix:).
 */

import { processDialogueTurn, ALL_DIALOGUE_SCHEMAS } from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_rcd_entry_guard';

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

describe('Phase 6.1 — RCD entry guard (imperative + denial cases)', () => {
  // Feedback id 113 (2026-07-29) — the intent-gated triggers changed the
  // ROUTE for guard-class utterances that carry no intent term and no
  // circuit clause: they no longer trigger-match at all, so the
  // `rcd_entry_guard_skipped` telemetry legitimately never fires — the
  // utterance falls through to Sonnet EARLIER, before the guard is
  // consulted. The invariant that matters (no script entry, model owns the
  // turn) is unchanged and still asserted for every row. Rows that DO carry
  // an intent term still trigger-match, still hit the P1 guard, and still
  // log — split below so the guard telemetry keeps a live pin.
  describe('positive — imperative phrases WITH test intent still hit the P1 guard (logged)', () => {
    test.each([
      "why haven't you deleted the RCD trip time",
      'please delete the RCD test reading',
      // Denial + intent term — the denial guard also still fires when the
      // gate lets the utterance trigger-match.
      "That's wrong, the RCD trip time is different",
    ])('does not enter RCD script for %p (guard fires + logs)', (transcriptText) => {
      const ws = new FakeWS();
      const logger = new RecordingLogger();
      const session = buildSession({ 1: {}, 2: {}, 3: {} });
      const out = processDialogueTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        schemas: ALL_DIALOGUE_SCHEMAS,
        logger,
        now: 1000,
      });

      // Falls through to Sonnet — no script state, no WS emit.
      expect(session.dialogueScriptState).toBeFalsy();
      // The guard fires (logged) and either returns handled:false
      // (no other schema matched) or it could pivot to a different
      // schema. Either way the RCD-specific guard log is present.
      const guarded = logger.events.find((e) => e.name === 'rcd_entry_guard_skipped');
      expect(guarded).toBeTruthy();
      expect(guarded.payload.sessionId).toBe(SESSION_ID);
      // The Sonnet hand-off is the only valid outcome here.
      expect(out.handled === false || out.fallthrough === true).toBe(true);
    });
  });

  describe('positive — imperative/denial phrases WITHOUT intent never enter (gate rejects pre-guard)', () => {
    test.each([
      'please delete RCD',
      'undo the RCD',
      'cancel the RCD entry',
      'fix the RCD reading',
      'stop asking about the RCD',
      'remove the RCD',
      'clear the RCD details',
      // C4 — the "ICD" garble alias composes with the gate exactly like
      // the clean spelling.
      'please delete the ICD',
      'What are you doing with the RCD?',
      "I didn't say RCD",
      "That's wrong, the RCD reading is different",
      "That's not the RCD I meant",
    ])('does not enter RCD script for %p', (transcriptText) => {
      const ws = new FakeWS();
      const logger = new RecordingLogger();
      const session = buildSession({ 1: {}, 2: {}, 3: {} });
      const out = processDialogueTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        schemas: ALL_DIALOGUE_SCHEMAS,
        logger,
        now: 1000,
      });

      // Falls through to Sonnet — no script state; the intent gate means
      // the trigger never matched, so no guard telemetry is expected.
      expect(session.dialogueScriptState).toBeFalsy();
      expect(out.handled === false || out.fallthrough === true).toBe(true);
    });
  });

  describe('negative — test-intent RCD utterances still enter the script', () => {
    test.each([
      'RCD on circuit 4',
      'RCD trip time for circuit 5 is 25 ms',
      'check the RCD on circuit 2',
      // C4 (field session 6B6FE011 F8) — "ICD" garble of "RCD" and the
      // "triptan" garble of "trip time" enter the schema like their
      // clean spellings (enumerated aliases in rcd.js).
      'ICD trip time for circuit 5 is 26 milliseconds',
      'RCD triptan for circuit 2 is 28 ms',
    ])('enters RCD script for %p (or surfaces an ask)', (transcriptText) => {
      const ws = new FakeWS();
      const logger = new RecordingLogger();
      const session = buildSession({ 2: {}, 4: {}, 5: {} });
      const out = processDialogueTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        schemas: ALL_DIALOGUE_SCHEMAS,
        logger,
        now: 1000,
      });

      // The guard must NOT have fired (none of the imperative or
      // denial words are present).
      expect(logger.events.find((e) => e.name === 'rcd_entry_guard_skipped')).toBeFalsy();
      // Some path took the turn — either runEntry handled it, or it
      // emitted a which-circuit / value ask. Either way: not a no-op
      // bypass. (The active script state being set OR an out.handled
      // is enough; some inputs may pivot to other schemas.)
      expect(out.handled === true || session.dialogueScriptState != null).toBe(true);
    });
  });

  describe('id 113 — descriptive RCD mentions no longer hijack the session (intent gate)', () => {
    // "the RCD is type A" moved here from the enters-script group above:
    // under the 2026-07-29 intent gate a bare descriptive mention (no
    // circuit clause, no enumerated intent term) fail-forwards to the
    // model, which owns record_reading for RCD fields and can ask —
    // instead of fail-hijacking into a mute script that discards the rest
    // of the sentence (Derek: "if you ever mention an RCD, it just enters
    // the RCD loop").
    test.each([
      'the RCD is type A',
      'There is an RCD in the consumer unit.',
      'The board has an RCD main switch.',
      'RCD tested fine.',
      'The RCD is a 30 milliamp type A.',
    ])('falls through to the model for %p', (transcriptText) => {
      const ws = new FakeWS();
      const logger = new RecordingLogger();
      const session = buildSession({ 1: {}, 2: {}, 3: {} });
      const out = processDialogueTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        schemas: ALL_DIALOGUE_SCHEMAS,
        logger,
        now: 1000,
      });

      expect(session.dialogueScriptState).toBeFalsy();
      expect(ws.sent.length).toBe(0);
      expect(out.handled === false || out.fallthrough === true).toBe(true);
    });
  });
});

describe('Phase 6.3 — cancel-drain emits cancel_pending_tts WS message', () => {
  test('cancel of an active RCD script emits cancel_pending_tts with the srv-rcd- prefix', () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 4: {} });

    // Step 1: enter the RCD script so there's something to cancel.
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 4',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });
    expect(session.dialogueScriptState?.active).toBe(true);

    // Step 2: send a cancel trigger.
    ws.sent.length = 0; // clear the entry-time ask
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'never mind',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 2000,
    });

    // State must be cleared.
    expect(session.dialogueScriptState).toBeFalsy();

    // Two WS frames should have been sent: the cancel script-info
    // (TTS confirmation) AND the new cancel_pending_tts envelope.
    const cancelPurge = ws.sent.find((m) => m.type === 'cancel_pending_tts');
    expect(cancelPurge).toBeTruthy();
    expect(cancelPurge.prefix).toBe('srv-rcd-');
    expect(cancelPurge.sessionId).toBe(SESSION_ID);

    // The existing cancelled telemetry row must also fire so the
    // optimizer still sees the cancellation event.
    expect(logger.events.find((e) => e.name === 'stage6.rcd_script_cancelled')).toBeTruthy();
  });

  test('the existing RCD-cancelled log row still fires (regression-locks the original event)', () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 5: {} });
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'forget it',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 2000,
    });
    expect(logger.events.find((e) => e.name === 'stage6.rcd_script_cancelled')).toBeTruthy();
  });
});
