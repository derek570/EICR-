/**
 * Integration tests for the OCPD / RCD / RCBO schemas (PR2).
 *
 * Scenarios:
 *   - OCPD walk-through (BS / curve / amps / kA)
 *   - RCD walk-through (BS / type / mA)
 *   - RCBO direct entry walk-through
 *   - OCPD → RCBO pivot via BS EN 61009 (mirror writes both bs_en
 *     fields, RCBO's nextMissingSlot starts at the curve)
 *   - RCD → RCBO pivot symmetric to above
 *   - BS-code derivations: BS 3036 → ocpd_type=Rew (skip curve question)
 *   - Per-slot skip
 *   - Topic switch
 */

import {
  processProtectiveDeviceTurn,
  ocpdSchema,
  rcdSchema,
  rcboSchema,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_pd_test';

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

describe('OCPD walk-through', () => {
  test('full happy path: BS / curve / amps / kA', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    let out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    expect(out.handled).toBe(true);
    expect(ws.sent.at(-1).context_field).toBe('ocpd_bs_en');
    expect(ws.sent.at(-1).question).toBe("What's the BS number?");

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 60898',
      now: 2000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    expect(ws.sent.at(-1).question).toBe('What MCB curve? B, C, or D?');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'B',
      now: 3000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_rating_a');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '32 amps',
      now: 4000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_breaking_capacity_ka');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '6 kA',
      now: 5000,
    });
    expect(ws.sent.at(-1).reason).toBe('info');
    expect(session.stateSnapshot.circuits[5]).toMatchObject({
      ocpd_bs_en: 'BS EN 60898',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_breaking_capacity_ka: '6',
    });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('BS 3036 derivation skips the curve question (Rew auto-set)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS 3036',
      now: 2000,
    });
    // Curve was auto-set to "Rew" via derivation. Engine asks for rating next.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_rating_a');
    expect(session.stateSnapshot.circuits[5].ocpd_type).toBe('Rew');
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS 3036');
  });
});

describe('RCD walk-through', () => {
  test('full happy path: BS / type / mA', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_bs_en');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_type');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    expect(ws.sent.at(-1).context_field).toBe('rcd_operating_current_ma');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    expect(ws.sent.at(-1).reason).toBe('info');
    expect(session.stateSnapshot.circuits[5]).toMatchObject({
      rcd_bs_en: 'BS EN 61008',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
  });
});

describe('RCBO pivot', () => {
  test('OCPD → RCBO pivot via BS EN 61009 mirrors both bs_en fields', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    expect(session.dialogueScriptState.schemaName).toBe('ocpd');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    // After pivot, schemaName flipped to RCBO, both bs_en fields filled.
    expect(session.dialogueScriptState.schemaName).toBe('rcbo');
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
    // Next ask is the curve (next missing slot in RCBO's slot list).
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    expect(ws.sent.at(-1).tool_call_id).toMatch(/^srv-rcbo-/);
  });

  test('RCD → RCBO pivot symmetric: mirror to ocpd_bs_en', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    expect(session.dialogueScriptState.schemaName).toBe('rcd');

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    expect(session.dialogueScriptState.schemaName).toBe('rcbo');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61009');
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
  });

  test('Direct RCBO entry asks for BS first', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    expect(session.dialogueScriptState.schemaName).toBe('rcbo');
    expect(ws.sent.at(-1).context_field).toBe('ocpd_bs_en');
  });

  test('RCBO full walk-through after pivot', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'B',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '32',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '6',
      now: 5000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 6000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 7000,
    });
    expect(ws.sent.at(-1).reason).toBe('info');
    expect(session.stateSnapshot.circuits[5]).toMatchObject({
      ocpd_bs_en: 'BS EN 61009',
      rcd_bs_en: 'BS EN 61009',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_breaking_capacity_ka: '6',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
    expect(session.dialogueScriptState).toBeNull();
  });
});

describe('per-slot skip (PR2 Option B)', () => {
  test('"skip that" mid-OCPD skips current slot, moves to next', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_bs_en');

    // Inspector skips the BS number — moves to curve question.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: "I don't know",
      now: 2000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    // ocpd_bs_en wasn't written.
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBeUndefined();
    // Skipped set tracks it.
    expect(session.dialogueScriptState.skipped_slots.has('ocpd_bs_en')).toBe(true);
  });

  test('"leave it blank" skips current slot', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 60898',
      now: 2000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'leave it blank',
      now: 3000,
    });
    // Curve skipped, moves to rating.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_rating_a');
  });
});

describe('schema isolation across PD wrappers', () => {
  test('Ring active state is preserved when PD wrapper is invoked', () => {
    // Simulate ring being active.
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    session.dialogueScriptState = {
      active: true,
      schemaName: 'ring_continuity',
      circuit_ref: 5,
      values: {},
      pending_writes: [],
      skipped_slots: new Set(),
      entered_at: 1000,
      last_turn_at: 1000,
    };
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something else',
      now: 2000,
    });
    expect(out).toEqual({ handled: false });
    expect(session.dialogueScriptState.schemaName).toBe('ring_continuity');
  });
});

describe('topic switch from OCPD', () => {
  test('"ring continuity" mid-OCPD falls through to Sonnet', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5.',
      now: 1000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 5.',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'Ring continuity for circuit 5.',
    });
    expect(session.dialogueScriptState).toBeNull();
  });
});
