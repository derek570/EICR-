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

describe('Flux artefact tolerance — session 9FC3A6F1 (2026-04-30)', () => {
  // Production session 9FC3A6F1: user said "Six zero eight nine eight"
  // three times answering "What's the BS number?". iOS NumberNormaliser
  // produced "6 zero 8 9 8" (zero-word survived the standalone-digit-word
  // pass's idiom guard). The legacy parseBsCode required \b60898\b which
  // didn't match the spaced form, looping the engine. Backend defence-
  // in-depth: parseBsCode's normaliseBsInput now collapses the run.
  test('answer "Six zero eight nine eight" lands as BS EN 60898', () => {
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

    // Backend gets the un-normalised form (e.g. from web frontend or
    // a test harness that doesn't pre-normalise). parseBsCode must
    // tolerate it.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '6 zero 8 9 8',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 60898');
  });

  test('answer "6 0 8 9 8" (pure digits) still lands', () => {
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
      transcriptText: '6 0 8 9 8',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 60898');
  });

  // Production trigger utterance: "The circuit breaker for circuit one
  // is a b s six zero eight nine eight." iOS rewrites "second"→"circuit",
  // collapses "a b s"→"BS" and "Six zero eight nine eight"→"60898" so
  // the backend sees "...BS 60898." cleanly. This test exercises the
  // backend's namedExtractor with the still-spaced form (web frontend
  // path) — the regex now accepts both "BS" and "a b s" prefixes.
  test('trigger "...is a b s 60898" volunteers the BS code (no redundant ask)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {} });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'The circuit breaker for circuit 1 is a b s 60898.',
      now: 1000,
    });
    expect(out.handled).toBe(true);
    // BS code volunteered — engine moves directly to the curve question.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    expect(ws.sent.at(-1).question).toBe('What MCB curve? B, C, or D?');
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBe('BS EN 60898');
  });

  test('trigger with iOS-normalised "BS 60898" still works (no regression)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'The circuit breaker for circuit 1 is BS 60898.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBe('BS EN 60898');
  });

  // BS EN 61009 via spelled-letter form — should pivot to RCBO same as
  // clean form does.
  test('trigger "...is a b s e n 61009" pivots to RCBO', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'OCPD on circuit 5 is a b s e n 61009.',
      now: 1000,
    });
    expect(out.handled).toBe(true);
    expect(session.stateSnapshot.circuits[5]).toMatchObject({
      ocpd_bs_en: 'BS EN 61009',
      rcd_bs_en: 'BS EN 61009',
    });
    // Pivoted to RCBO — ocpd_type still pending so the next ask is the curve.
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
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

describe('OCPD breaking-capacity allowed-value gate (2026-05-04, field test 07635782)', () => {
  // Field test 07635782 (08:24 BST 2026-05-04): inspector said "six" for
  // breaking capacity, the engine had moved on, Deepgram heard the next
  // utterance as "66" → 66 kA landed on the cert. The slot now declares
  // allowedValues: ['1.5','3','4.5','6','10','16','20','25','36','50','80'];
  // anything else falls through to a re-ask.

  function reachBreakingCapacitySlot(session, ws) {
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
      transcriptText: '32 amps',
      now: 4000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ocpd_breaking_capacity_ka');
  }

  test('rejects 66 (not on the BS-EN ratings ladder) and re-asks', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    reachBreakingCapacitySlot(session, ws);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '66',
      now: 5000,
    });

    // No write happened; engine re-asks the same slot.
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBeUndefined();
    expect(ws.sent.at(-1).context_field).toBe('ocpd_breaking_capacity_ka');
    expect(ws.sent.at(-1).question).toBe("What's the breaking capacity in kA?");
    // Script still active — inspector can answer with a valid value.
    expect(session.dialogueScriptState).not.toBeNull();
  });

  test("rejects 66 in named form (e.g. '66 kA')", () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    reachBreakingCapacitySlot(session, ws);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '66 kA',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBeUndefined();
    expect(ws.sent.at(-1).context_field).toBe('ocpd_breaking_capacity_ka');
  });

  test('accepts 6 (on the ladder) and finishes the script', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    reachBreakingCapacitySlot(session, ws);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '6',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBe('6');
    // Script completed — finish message emitted.
    expect(session.dialogueScriptState).toBeNull();
  });

  test('accepts 1.5 (half-step on the ladder)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    reachBreakingCapacitySlot(session, ws);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '1.5',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBe('1.5');
    expect(session.dialogueScriptState).toBeNull();
  });

  test('rejects 100 (off-ladder, even though parser would accept)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    reachBreakingCapacitySlot(session, ws);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '100',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBeUndefined();
    expect(ws.sent.at(-1).context_field).toBe('ocpd_breaking_capacity_ka');
  });
});
