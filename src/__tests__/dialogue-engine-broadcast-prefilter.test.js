/**
 * Broadcast-intent pre-filter for the dialogue engine.
 *
 * Session 27366AC6 (2026-05-25 13:35 UTC) — inspector said "circuit
 * breaker for all circuits is a 60898." The OCPD trigger matched
 * "breaker", the script entered with circuit_ref=null and asked
 * "Which circuit is the OCPD for?", and when the answer "all circuits"
 * failed both parseCircuitDigit and findCircuitsByDesignation the
 * retry path quoted the user's text back as "What's the circuit
 * number for the all circuit?".
 *
 * Fix: pre-filter at the top of processDialogueTurn. When the
 * utterance carries unambiguous broadcast intent ("for all circuits",
 * "every circuit", noun-anchored ranges/lists), bail out of script
 * entry so Sonnet's set_field_for_all_circuits tool handles it.
 *
 * Critical regression guard: the RCD post-completion bulk-apply
 * reply ("yes all" / "all of them") must still flow through the
 * existing handleBulkApplyReply path. The pre-filter checks
 * state.bulkApplyPending and leaves that turn alone.
 */

import {
  processDialogueTurn,
  processProtectiveDeviceTurn,
  ringContinuitySchema,
  insulationResistanceSchema,
  ocpdSchema,
  rcdSchema,
  rcboSchema,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { detectBroadcastIntent } from '../extraction/dialogue-engine/parsers/circuit-range.js';

const SESSION_ID = 'sess_prefilter';

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

class RecordingLogger {
  constructor() {
    this.events = [];
  }
  info(name, payload) {
    this.events.push({ name, payload });
  }
}

// ---------------------------------------------------------------------------
// Unit tests — detectBroadcastIntent
// ---------------------------------------------------------------------------

describe('detectBroadcastIntent', () => {
  test.each([
    // The today's-prod failure utterance.
    'circuit breaker for all circuits is a 60898.',
    // "all"-form variants.
    'for all circuits use type B',
    'across all circuits',
    'on all the circuits',
    'to all of them',
    'all circuits are type B',
    'every circuit is 6kA',
    'the whole board is BS EN 60898',
    'whole board',
    'entire board uses Type C',
    // Range-form (noun-anchored).
    'circuits 1 to 6 are type B',
    'circuit 1 through 6',
    'circuits 2-8 use this',
    'circuits 1 thru 5',
    // List-form (noun-anchored).
    'circuits 1, 3 and 5 are type B',
    'circuit 2, 4, 7',
    'circuits 1 and 3',
  ])('matches broadcast: %p', (text) => {
    expect(detectBroadcastIntent(text)).toBe(true);
  });

  test.each([
    // Single-circuit dictation — must NOT match.
    'RCD on circuit 4',
    'Ring continuity for circuit 13',
    'circuit 4 is type B',
    // Numeric values that look range-like but aren't anchored to "circuits".
    'ring continuity for circuit 3 is 1 to 6 ohms',
    'insulation resistance 1, 3 megohms live-to-live',
    'breaker 60898, 6 kA', // codex's worst-case
    'circuit 4 cable size is 1 to 6 mils',
    'Ze is 0.32 ohms',
    'is everything tested?', // no "circuit" anchor
    // Empty / falsy.
    '',
    null,
    undefined,
  ])('does NOT match: %p', (text) => {
    expect(detectBroadcastIntent(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — pre-filter behaviour inside processDialogueTurn
// ---------------------------------------------------------------------------

describe('pre-filter — bypass on entry', () => {
  test("today's prod repro — 'circuit breaker for all circuits is a 60898' bypasses OCPD", () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {}, 3: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit breaker for all circuits is a 60898.',
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });

    // Engine returns handled:false so the Stage 6 caller routes to Sonnet.
    expect(out).toEqual({ handled: false });
    // No script entered, no WS payload emitted.
    expect(session.dialogueScriptState).toBeFalsy();
    expect(ws.sent).toHaveLength(0);
    // Bypass-on-entry log marker present; ocpd_script_entered absent.
    const bypassed = logger.events.find((e) => e.name === 'dialogue_broadcast_bypassed_entry');
    expect(bypassed).toBeTruthy();
    expect(bypassed.payload).toMatchObject({
      sessionId: SESSION_ID,
      textPreview: expect.stringContaining('all circuits'),
    });
    expect(logger.events.find((e) => e.name === 'stage6.ocpd_script_entered')).toBeUndefined();
  });

  test.each([
    'for all the circuits use BS EN 60898',
    'every circuit is type B',
    'the whole board is BS EN 61008',
    'across all circuits set type to C',
    'circuits 1 to 6 are 6kA',
    'circuits 1, 3 and 5 are 32A',
  ])('positive phrasing bypasses: %p', (transcriptText) => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {} });
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
    expect(ws.sent).toHaveLength(0);
    expect(logger.events.find((e) => e.name === 'dialogue_broadcast_bypassed_entry')).toBeTruthy();
  });

  test.each([
    // Natural value dictation that the noun anchor must protect.
    'RCD on circuit 4 is type AC, 30 milliamps',
    'Ring continuity for circuit 3',
    'circuit 4 cable size is 1 to 6 mils',
    'breaker 60898, 6 kA',
    'insulation resistance 1, 3 megohms live-to-live',
    'Ze is 0.32 ohms',
  ])('negative phrasing does NOT bypass: %p', (transcriptText) => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 3: { circuit_designation: 'Cooker' }, 4: {} });
    processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      schemas: ALL_DIALOGUE_SCHEMAS,
      logger,
      now: 1000,
    });

    // The bypass marker MUST NOT have fired. The utterance may or may
    // not have entered a script depending on its content — that's not
    // what this test guards. We only assert the pre-filter stayed
    // hands-off.
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_bypassed_entry')
    ).toBeUndefined();
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_aborted_mid_script')
    ).toBeUndefined();
  });
});

describe('pre-filter — active-script abort', () => {
  test('aborts active OCPD script + clears state when broadcast utterance arrives mid-flow', () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {}, 3: { circuit_designation: 'Cooker' } });

    // Drive OCPD to mid-flow: enter on circuit 3, fill BS EN 60898.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 3',
      logger,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 60898',
      logger,
      now: 2000,
    });

    expect(session.dialogueScriptState).toBeTruthy();
    expect(session.dialogueScriptState.active).toBe(true);
    expect(session.dialogueScriptState.schemaName).toBe('ocpd');
    expect(session.dialogueScriptState.bulkApplyPending).toBeFalsy();

    // Inspector pivots: "actually, for all circuits".
    ws.sent.length = 0;
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'actually for all circuits use type B',
      logger,
      now: 3000,
    });

    expect(out).toEqual({ handled: false });
    // State cleared so Sonnet sees a clean slate next turn.
    expect(session.dialogueScriptState).toBeFalsy();
    // No new WS payload (Stage 6 will route to Sonnet and Sonnet emits
    // its own writes).
    expect(ws.sent).toHaveLength(0);
    // Abort log marker present with state diagnostics.
    const aborted = logger.events.find((e) => e.name === 'dialogue_broadcast_aborted_mid_script');
    expect(aborted).toBeTruthy();
    expect(aborted.payload).toMatchObject({
      sessionId: SESSION_ID,
      schemaName: 'ocpd',
      circuit_ref: 3,
    });
    expect(Array.isArray(aborted.payload.filled_keys)).toBe(true);
    // Snapshot writes already committed for circuit 3 (the BS EN value)
    // are preserved — only the in-memory script state is discarded.
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBeDefined();
  });
});

describe('pre-filter — bulkApplyPending preservation (RCD regression guard)', () => {
  // Helper: drive the RCD walk-through to the bulk-apply prompt.
  function runRcdToBulkPrompt(session, ws, logger) {
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 1.',
      logger,
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      logger,
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      logger,
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      logger,
      now: 4000,
    });
  }

  test("'all' reply to RCD bulk-apply prompt still flows through handleBulkApplyReply", () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {}, 3: {} });
    runRcdToBulkPrompt(session, ws, logger);

    expect(session.dialogueScriptState).toBeTruthy();
    expect(session.dialogueScriptState.bulkApplyPending).toBe(true);

    ws.sent.length = 0;
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'all',
      logger,
      now: 5000,
    });

    // The bulk-apply path owns this turn (handled:true), NOT the
    // pre-filter. The pre-filter must have kept its hands off.
    expect(out.handled).toBe(true);
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_bypassed_entry')
    ).toBeUndefined();
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_aborted_mid_script')
    ).toBeUndefined();

    // RCD bulk-apply actually fired: circuits 2 + 3 got the device.
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      rcd_bs_en: 'BS EN 61008',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
    expect(session.stateSnapshot.circuits[3]).toMatchObject({
      rcd_bs_en: 'BS EN 61008',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
    // Confirmation TTS, script cleared.
    const last = ws.sent.at(-1);
    expect(last.question).toBe('Applied RCD to all circuits.');
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test("'all of them' reply to RCD bulk-apply prompt still flows through handleBulkApplyReply", () => {
    const ws = new FakeWS();
    const logger = new RecordingLogger();
    const session = buildSession({ 1: {}, 2: {} });
    runRcdToBulkPrompt(session, ws, logger);

    expect(session.dialogueScriptState.bulkApplyPending).toBe(true);

    ws.sent.length = 0;
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'yes all of them',
      logger,
      now: 5000,
    });

    expect(out.handled).toBe(true);
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_bypassed_entry')
    ).toBeUndefined();
    expect(
      logger.events.find((e) => e.name === 'dialogue_broadcast_aborted_mid_script')
    ).toBeUndefined();
    expect(ws.sent.at(-1).question).toBe('Applied RCD to all circuits.');
  });
});
