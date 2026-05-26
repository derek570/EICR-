/**
 * Handover-to-Sonnet behaviour for the dialogue engine.
 *
 * Pinned by session 87856B72 (2026-05-26): "RCD triptan for upstairs
 * lighting is 25 ms" — Deepgram garbled "trip time" → "triptan", the
 * RCD trigger /\bRCD\b/ matched on "RCD" alone, the named-extractor
 * `\btrip\s*time\b` missed the bare value, and the engine immediately
 * asked the next slot ("What's the BS number?") without ever
 * capturing the 25 ms. The inspector deferred ("later"), the script
 * shut down, and the 25 ms was lost.
 *
 * Fix shape (two-sided):
 *   - runEntry bails (`{handled:false}`) when the trigger matched but
 *     every entry-time signal was empty AND the utterance carries a
 *     number+unit pattern. The dialogue engine yields to Sonnet rather
 *     than swallowing the turn.
 *   - tryEnterScriptFromWrites enters the script post-dispatch once
 *     Sonnet writes a slot-owned value (e.g. record_reading on
 *     rcd_trip_time), seeding pre_existing from the snapshot so the
 *     walk-through resumes at the next missing slot — same UX the
 *     inspector would have got on the regex-happy path.
 *
 * These tests cover both halves plus the must-not-regress cases:
 * bare entry phrases without a value should still enter the script,
 * and an active script must not be disturbed by a post-dispatch hook
 * fire.
 */

import {
  processDialogueTurn,
  processProtectiveDeviceTurn,
  rcdSchema,
  ocpdSchema,
  rcboSchema,
  insulationResistanceSchema,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { __testing__ } from '../extraction/dialogue-engine/engine.js';

const { hasNumericValueWithUnit } = __testing__;

const SESSION_ID = 'sess_handover_test';

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

function makeLogger() {
  const events = [];
  const push = (name) => (payload) => events.push({ name, payload });
  return {
    events,
    info: (name, payload) => push(name)(payload),
    warn: (name, payload) => push(name)(payload),
  };
}

describe('hasNumericValueWithUnit', () => {
  test('matches the session 87856B72 transcript exactly', () => {
    expect(hasNumericValueWithUnit('RCD triptan for upstairs lighting is 25 ms.')).toBe(true);
  });

  test('matches common EICR units', () => {
    expect(hasNumericValueWithUnit('0.6 ohms')).toBe(true);
    expect(hasNumericValueWithUnit('299 megaohms')).toBe(true);
    expect(hasNumericValueWithUnit('30 mA')).toBe(true);
    expect(hasNumericValueWithUnit('6 kA')).toBe(true);
    expect(hasNumericValueWithUnit('230 volts')).toBe(true);
    expect(hasNumericValueWithUnit('32 amps')).toBe(true);
  });

  test('does NOT match bare digit (circuit number, not a value)', () => {
    expect(hasNumericValueWithUnit('RCD on circuit 2')).toBe(false);
    expect(hasNumericValueWithUnit('circuit 5')).toBe(false);
  });

  test('does NOT match digit followed by random word', () => {
    expect(hasNumericValueWithUnit('5 sockets')).toBe(false);
    expect(hasNumericValueWithUnit('2 bedrooms')).toBe(false);
  });

  test('rejects empty / non-string input', () => {
    expect(hasNumericValueWithUnit('')).toBe(false);
    expect(hasNumericValueWithUnit(null)).toBe(false);
    expect(hasNumericValueWithUnit(undefined)).toBe(false);
  });
});

describe('runEntry — handover-to-Sonnet bail', () => {
  test('garbled "RCD triptan… 25 ms" — engine bails so Sonnet sees the utterance', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { circuit_designation: 'Upstairs Lighting' } });
    const logger = makeLogger();

    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD triptan for upstairs lighting is 25 ms.',
      logger,
      now: 1000,
    });

    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);
    const handover = logger.events.find(
      (e) => e.name === 'stage6.rcd_script_entry_handover_to_sonnet'
    );
    expect(handover).toBeDefined();
    expect(handover.payload.circuit_ref).toBe(2);
    expect(handover.payload.textPreview).toBe('RCD triptan for upstairs lighting is 25 ms.');
  });

  test('bare entry without a value still enters the script (regression guard)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: {} });

    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 2.',
      now: 1000,
    });

    expect(out.handled).toBe(true);
    expect(out.fallthrough).toBe(false);
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      schemaName: 'rcd',
      circuit_ref: 2,
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
  });

  test('happy-path harvest still works ("RCD trip time… 25 ms" — no garble)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { circuit_designation: 'Upstairs Lighting' } });

    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for upstairs lighting is 25 ms.',
      now: 1000,
    });

    expect(out.handled).toBe(true);
    expect(session.stateSnapshot.circuits[2].rcd_trip_time).toBe('25');
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      schemaName: 'rcd',
      circuit_ref: 2,
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
  });

  test('snapshot has pre-existing slot values → enter so the walkthrough drains them', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: {
        circuit_designation: 'Upstairs Lighting',
        rcd_trip_time: '25',
      },
    });

    // Garble-with-number still present; but existing has rcd_trip_time
    // already, so the bail's "no snapshot context" precondition fails
    // and the script enters as before to ask the next missing slot.
    // Use the full designation in the text so findCircuitsByDesignation's
    // substring matcher resolves circuit_ref=2.
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD triptan upstairs lighting is 25 ms.',
      now: 1000,
    });

    expect(out.handled).toBe(true);
    expect(session.dialogueScriptState?.active).toBe(true);
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
  });
});

describe('tryEnterScriptFromWrites — post-Sonnet re-entry', () => {
  test('Sonnet wrote rcd_trip_time → enter RCD script and ask rcd_bs_en', () => {
    const ws = new FakeWS();
    // Simulate the state AFTER Sonnet's record_reading dispatch — the
    // snapshot already carries the 25, and no script is active.
    const session = buildSession({
      2: {
        circuit_designation: 'Upstairs Lighting',
        rcd_trip_time: '25',
      },
    });
    const logger = makeLogger();

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 2, value: '25', confidence: 1.0 }],
      logger,
      now: 2000,
    });

    expect(out).toMatchObject({ entered: true, schemaName: 'rcd', circuit_ref: 2 });
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      schemaName: 'rcd',
      circuit_ref: 2,
      values: { rcd_trip_time: '25' },
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
    expect(ws.sent.at(-1).question).toBe(
      "What's the BS number? Or do you want to fill that in later?"
    );
    const enteredLog = logger.events.find(
      (e) => e.name === 'stage6.rcd_script_entered_from_sonnet_write'
    );
    expect(enteredLog).toBeDefined();
    expect(enteredLog.payload.trigger_field).toBe('rcd_trip_time');
    expect(enteredLog.payload.next_slot).toBe('rcd_bs_en');
  });

  test('end-to-end repro: bail → simulate Sonnet write → re-entry', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { circuit_designation: 'Upstairs Lighting' } });

    // 1. Inspector says the garbled utterance. Engine bails to Sonnet.
    const entry = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD triptan for upstairs lighting is 25 ms.',
      now: 1000,
    });
    expect(entry).toEqual({ handled: false });
    expect(ws.sent).toHaveLength(0);

    // 2. Sonnet's record_reading dispatcher would have applied the
    // write to the snapshot AND added it to result.extracted_readings.
    // Simulate both here — the real path runs them via the
    // stage6-dispatchers-circuit pipeline + bundler.
    session.stateSnapshot.circuits[2].rcd_trip_time = '25';

    // 3. Post-dispatch hook fires.
    tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 2, value: '25' }],
      now: 2000,
    });

    // 4. Inspector now hears the next question — same as the happy path.
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
    expect(session.dialogueScriptState?.values).toEqual({ rcd_trip_time: '25' });
  });

  test('no-op when a script is already active (do not disturb)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: {} });
    // Enter RCD script first.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 2.',
      now: 1000,
    });
    const stateBefore = JSON.parse(JSON.stringify(session.dialogueScriptState));
    const sentBefore = ws.sent.length;

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 2, value: '25' }],
      now: 2000,
    });

    expect(out).toEqual({ entered: false, reason: 'script_already_active' });
    // Skipped sets are serialised differently — assert the load-bearing
    // fields didn't shift.
    expect(session.dialogueScriptState.schemaName).toBe(stateBefore.schemaName);
    expect(session.dialogueScriptState.circuit_ref).toBe(stateBefore.circuit_ref);
    expect(ws.sent.length).toBe(sentBefore);
  });

  test('no-op for writes not owned by any schema', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: { cable_size: '2.5' } });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'cable_size', circuit: 2, value: '2.5' }],
      now: 2000,
    });

    expect(out).toEqual({ entered: false, reason: 'no_matching_schema' });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);
  });

  test('no-op when every slot in the owning schema is already filled', () => {
    const ws = new FakeWS();
    const session = buildSession({
      2: {
        circuit_designation: 'Upstairs Lighting',
        rcd_trip_time: '25',
        rcd_bs_en: 'BS EN 61008',
        rcd_type: 'AC',
        rcd_operating_current_ma: '30',
      },
    });
    const logger = makeLogger();

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 2, value: '25' }],
      logger,
      now: 2000,
    });

    expect(out).toEqual({ entered: false, reason: 'no_matching_schema' });
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);
    const skipLog = logger.events.find(
      (e) => e.name === 'stage6.rcd_script_entry_from_write_skipped_all_filled'
    );
    expect(skipLog).toBeDefined();
  });

  test('resolves field aliases — Sonnet "rcd_time_ms" enters rcdSchema via FIELD_CORRECTIONS', () => {
    // Session 904344CD turn-10 repro (2026-05-26). Sonnet emitted
    // `record_reading {field: 'rcd_time_ms'}` for the "I'll see the
    // trip time for the downstairs lights is 25 ms" utterance. The
    // RCD schema slot is `rcd_trip_time`, not `rcd_time_ms`. Without
    // alias resolution the hook bailed; with FIELD_CORRECTIONS
    // (rcd_time_ms → rcd_trip_time) it enters the walk-through and
    // asks the next slot.
    const ws = new FakeWS();
    const session = buildSession({
      2: {
        circuit_designation: 'Downstairs Lights',
        // Simulate post-dispatch state: validateAndCorrectFields will
        // have rewritten the field name to rcd_trip_time on the wire,
        // but the snapshot was written via the canonical-name path
        // already so the slot is filled under rcd_trip_time.
        rcd_trip_time: '25',
      },
    });
    const logger = makeLogger();

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      // Sonnet's tool-call shape — field uses canonical Stage-6 name.
      readings: [{ field: 'rcd_time_ms', circuit: 2, value: '25' }],
      fieldAliases: { rcd_time_ms: 'rcd_trip_time' },
      logger,
      now: 2000,
    });

    expect(out).toMatchObject({ entered: true, schemaName: 'rcd', circuit_ref: 2 });
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');
    const enteredLog = logger.events.find(
      (e) => e.name === 'stage6.rcd_script_entered_from_sonnet_write'
    );
    expect(enteredLog).toBeDefined();
    expect(enteredLog.payload.trigger_field).toBe('rcd_time_ms');
    expect(enteredLog.payload.resolved_field).toBe('rcd_trip_time');
  });

  test('without fieldAliases, the canonical-name write still bails — preserves old behaviour', () => {
    // Regression guard: alias resolution is OPTIONAL. Callers that
    // don't supply fieldAliases get the pre-2026-05-26 behaviour
    // (raw field name vs slot list, no alias lookup).
    const ws = new FakeWS();
    const session = buildSession({
      2: { circuit_designation: 'Downstairs Lights', rcd_trip_time: '25' },
    });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_time_ms', circuit: 2, value: '25' }],
      // fieldAliases omitted
      now: 2000,
    });

    expect(out).toEqual({ entered: false, reason: 'no_matching_schema' });
  });

  test('no-op for writes on a circuit not in the snapshot', () => {
    const ws = new FakeWS();
    const session = buildSession({ 2: {} });

    const out = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 99, value: '25' }],
      now: 2000,
    });

    expect(out).toEqual({ entered: false, reason: 'no_matching_schema' });
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('input guards — empty / malformed inputs return reason codes', () => {
    expect(tryEnterScriptFromWrites({})).toEqual({ entered: false, reason: 'no_session' });
    expect(
      tryEnterScriptFromWrites({ session: buildSession(), schemas: [], readings: [] })
    ).toEqual({ entered: false, reason: 'no_schemas' });
    expect(
      tryEnterScriptFromWrites({
        session: buildSession(),
        schemas: ALL_DIALOGUE_SCHEMAS,
        readings: [],
      })
    ).toEqual({ entered: false, reason: 'no_readings' });
  });
});
