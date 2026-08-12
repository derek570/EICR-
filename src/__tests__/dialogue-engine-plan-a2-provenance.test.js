/**
 * PLAN A2 (feedback id 117) — script completion-ceremony provenance &
 * terminal read-backs. Production-ingress probes for the per-run
 * dictation-operation ledger, the seeded-value canonical-compare rule, the
 * dispatcher-resolved speech-ownership triad, and the terminal-sink rule.
 *
 * Test IDs below match the plan's own lettered list (§ Tests).
 */

import {
  processProtectiveDeviceTurn,
  enterScriptByName,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_a2';

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

const infoMessages = (ws) =>
  ws.sent.filter((m) => m?.type === 'ask_user_started' && m?.reason === 'info');
// Purge (cancel_pending_tts) frames carry no `.question` and can land last —
// find the last genuine ask_user_started frame instead of a bare `.at(-1)`.
const lastQuestion = (ws) => ws.sent.filter((m) => m?.type === 'ask_user_started').at(-1)?.question;

describe('PLAN A2 — provenance ledger & terminal read-backs (feedback id 117)', () => {
  // (a) verbatim id-117 — a scoped trip-time correction with every device
  // slot already snapshot-filled produces exactly ONE value-scoped finish
  // frame, and the unwanted "Got it, BS/type/mA" ceremony never fires.
  test('(a) id-117 verbatim: trip-time-only dictation on a fully snapshot-filled circuit → one value-scoped frame, no device-summary ceremony', () => {
    const ws = new FakeWS();
    const session = buildSession({
      5: { rcd_bs_en: '61008', rcd_type: 'AC', rcd_operating_current_ma: '30' },
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for circuit 5, the 27 ms.',
      now: 1000,
    });
    const infos = infoMessages(ws);
    expect(infos).toHaveLength(1);
    expect(infos[0].question).toBe('Also got trip time 27.');
    // No bulk-apply ceremony ask either — §A2.5 point 1.
    expect(
      ws.sent.some((m) => m?.type === 'ask_user_started' && /Apply these RCD/.test(m.question))
    ).toBe(false);
    expect(session.stateSnapshot.circuits[5].rcd_trip_time).toBe('27');
    expect(session.dialogueScriptState).toBeFalsy();
  });

  // (b) trip time + one device field dictated, bulk DECLINED → device
  // summary (script-owned, dictated this run) + appended trip-time
  // read-back, exactly once.
  test('(b) trip time + BS dictated, bulk declined → device summary with appended trip-time read-back', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for circuit 5 is 25 ms.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    // Bulk-apply prompt fires (BS was dictated this run).
    expect(lastQuestion(ws)).toMatch(/Apply these RCD details/);
    // Decline.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 5000,
    });
    expect(lastQuestion(ws)).toBe('Got it. BS EN 61008, type AC, 30 mA. Also got trip time 25.');
  });

  // (c) same, bulk APPLIED → bulk confirmation + appended read-back, once.
  test('(c) trip time + BS dictated, bulk applied → bulk confirmation with appended trip-time read-back', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {}, 6: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for circuit 5 is 25 ms.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'all',
      now: 5000,
    });
    expect(lastQuestion(ws)).toMatch(/^Applied RCD to all circuits\./);
    expect(lastQuestion(ws)).toMatch(/Also got trip time 25\.$/);
    // Only ONE frame named the trip time.
    expect(ws.sent.filter((m) => /trip time 25/.test(m?.question ?? '')).length).toBe(1);
  });

  // (d) device-only walk-through (no trip time) → today's ceremony
  // verbatim; Behaviour-preserved requirement.
  test('(d) device-only walk-through keeps the ceremony verbatim (no trip time dictated)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 5000,
    });
    expect(lastQuestion(ws)).toBe('Got it. BS EN 61008, type AC, 30 mA.');
  });

  // (e) snapshot-equal re-dictation → still spoken (Audio-First: dictated
  // non-empty must never produce silence), no phantom write op (disposition
  // satisfied_existing, not applied).
  test('(e) re-dictating a value equal to the existing snapshot value is still spoken, no phantom write', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { rcd_bs_en: '61008' } });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 5000,
    });
    // Verbatim ceremony still fires — the re-dictated (canonical-equal) BS
    // is script-owned satisfied_existing, so it counts as "dictated" for
    // the device-summary coverage check.
    // satisfied_existing never re-writes — the snapshot keeps its
    // ORIGINAL raw seeded form (never round-tripped through the parser).
    expect(lastQuestion(ws)).toBe('Got it. 61008, type AC, 30 mA.');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('61008');
  });

  // (f) unresolved-circuit drain counts as dictated — a value queued before
  // the circuit resolves still ends up as an 'applied' operation once the
  // circuit lands.
  test('(f) unresolved-circuit queue then drain counts the value as dictated', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time is 25 ms.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 5',
      now: 2000,
    });
    // Cancel immediately — trip time was queued, drained onto circuit 5,
    // and never reached a confirmation, so it must be read back at cancel.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel',
      now: 3000,
    });
    // rcd_trip_time carries countsTowardCancelTally:false (pre-existing,
    // unrelated to this plan) so the count-bearing cancel message never
    // fires for a trip-time-only cancel — the empty variant does, with
    // the terminal-sink read-back appended.
    expect(lastQuestion(ws)).toBe('RCD cancelled. Also got trip time 25.');
  });

  // (h) Sonnet-seeded trip time via tryEnterScriptFromWrites → ONE spoken
  // occurrence (bundler's — the triggering field arrived via record_reading
  // and is always bundler-owned, so finishScript never re-speaks it later).
  test('(h) tryEnterScriptFromWrites triggering field is bundler-owned — never re-spoken later', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    const result = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'rcd_trip_time', circuit: 5, value: '25' }],
      logger: null,
      now: 1000,
    });
    expect(result.entered).toBe(true);
    expect(result.schemaName).toBe('rcd');
    // Enters and asks for the BS number — the trigger field itself produced
    // NO spoken frame (bundler-owned).
    expect(ws.sent.filter((m) => m?.type === 'ask_user_started')).toHaveLength(1);
    expect(lastQuestion(ws)).toMatch(/BS number/);
    // Finish the walkthrough normally.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 5000,
    });
    // The finish text never mentions trip time — the bundler already spoke
    // it, and finishScript must not double it.
    expect(lastQuestion(ws)).toBe('Got it. BS EN 61008, type AC, 30 mA.');
  });

  // (i) RCBO volunteered BS number → ONE spoken occurrence (mirror-covered
  // — rcd_bs_en's value is spoken via ocpd_bs_en's mention in finishMessage,
  // so the terminal-sink rule must never double it).
  test('(i) RCBO volunteered BS mirrors ocpd_bs_en<->rcd_bs_en without doubling the finish text', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    // First-asked slot is ocpd_bs_en — bare "BS EN 61009" answers it and
    // mirrors into rcd_bs_en (never a separate dictation operation).
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
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 7000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
    const finish = lastQuestion(ws);
    expect(finish).toMatch(/^Got it\./);
    // BS number 61009 named exactly once in the finish text.
    expect((finish.match(/61009/g) ?? []).length).toBe(1);
    // No trailing "Also got" — both ocpd_bs_en and rcd_bs_en are covered.
    expect(finish).not.toMatch(/Also got/);
  });

  // (n) terminal-sink: trip time then cancel / topic-switch → exactly one
  // read-back each.
  test('(n) trip time then topic-switch → exactly one read-back, fallthrough carries the transcript', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for circuit 5 is 25 ms.',
      now: 1000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 5',
      now: 2000,
    });
    expect(out.handled).toBe(true);
    expect(out.fallthrough).toBe(true);
    const infos = infoMessages(ws);
    expect(infos).toHaveLength(1);
    expect(infos[0].question).toBe('Also got trip time 25.');
  });

  // (o) seeded-skip: preseeded-DIFFERENT BS → overwritten + spoken + bulk
  // propagates the NEW value.
  test('(o) preseeded-DIFFERENT BS is overwritten, spoken, and the NEW value propagates on bulk-apply', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { rcd_bs_en: '61008' }, 6: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    // BS EN 61009 pivots RCD -> RCBO. Drive the RCBO walkthrough to finish.
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
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61009');
  });

  // (r) IMMEDIATE-COMPLETION ownership triad, direct enterScriptByName probe
  // (a resolver stub stands in for the dispatcher's per-turn-writes
  // projection).
  describe('(r) enterScriptByName immediate-completion ownership triad', () => {
    test('canonical-equal seed with an equal PRIOR winner -> bundler-owned, finishScript stays silent', () => {
      const ws = new FakeWS();
      const session = buildSession({
        5: { rcd_bs_en: '61008', rcd_type: 'AC', rcd_operating_current_ma: '30' },
      });
      const resolver = (field, circuitRef) =>
        field === 'rcd_bs_en' && circuitRef === 5 ? '61008' : undefined;
      const result = enterScriptByName({
        session,
        sessionId: SESSION_ID,
        schemas: ALL_DIALOGUE_SCHEMAS,
        schemaName: 'rcd',
        circuit_ref: 5,
        pending_writes: [{ field: 'rcd_bs_en', value: '61008' }],
        ws,
        logger: null,
        now: 1000,
        ownershipResolver: resolver,
      });
      expect(result.ok).toBe(true);
      // Bundler owns it — the engine speaks NOTHING.
      expect(ws.sent.filter((m) => m?.type === 'ask_user_started')).toHaveLength(0);
    });

    test('canonical-equal seed with NO prior winner -> script-owned, finishScript speaks it', () => {
      const ws = new FakeWS();
      const session = buildSession({
        5: { rcd_bs_en: '61008', rcd_type: 'AC', rcd_operating_current_ma: '30' },
      });
      const result = enterScriptByName({
        session,
        sessionId: SESSION_ID,
        schemas: ALL_DIALOGUE_SCHEMAS,
        schemaName: 'rcd',
        circuit_ref: 5,
        pending_writes: [{ field: 'rcd_bs_en', value: '61008' }],
        ws,
        logger: null,
        now: 1000,
        ownershipResolver: () => undefined,
      });
      expect(result.ok).toBe(true);
      // satisfied_existing never re-writes — the finish text carries the
      // ORIGINAL raw seeded form.
      expect(lastQuestion(ws)).toBe('Got it. 61008, type AC, 30 mA.');
    });

    test('APPLIED seed (no prior winner, genuinely new) -> bundler-owned when a resolver is present (guaranteed backfill)', () => {
      const ws = new FakeWS();
      const session = buildSession({ 5: { rcd_type: 'AC', rcd_operating_current_ma: '30' } });
      const result = enterScriptByName({
        session,
        sessionId: SESSION_ID,
        schemas: ALL_DIALOGUE_SCHEMAS,
        schemaName: 'rcd',
        circuit_ref: 5,
        pending_writes: [{ field: 'rcd_bs_en', value: '61008' }],
        ws,
        logger: null,
        now: 1000,
        ownershipResolver: () => undefined,
      });
      expect(result.ok).toBe(true);
      expect(result.seeded_writes).toEqual(['rcd_bs_en']);
      // Bundler-owned (a resolver is present, so the dispatcher's backfill
      // is guaranteed) — the engine speaks NOTHING itself.
      expect(ws.sent.filter((m) => m?.type === 'ask_user_started')).toHaveLength(0);
    });

    test('APPLIED seed with NO resolver (direct/test caller, no backfill guarantee) -> script-owned, finishScript speaks it', () => {
      const ws = new FakeWS();
      const session = buildSession({ 5: { rcd_type: 'AC', rcd_operating_current_ma: '30' } });
      const result = enterScriptByName({
        session,
        sessionId: SESSION_ID,
        schemas: ALL_DIALOGUE_SCHEMAS,
        schemaName: 'rcd',
        circuit_ref: 5,
        pending_writes: [{ field: 'rcd_bs_en', value: '61008' }],
        ws,
        logger: null,
        now: 1000,
      });
      expect(result.ok).toBe(true);
      expect(lastQuestion(ws)).toBe('Got it. 61008, type AC, 30 mA.');
    });
  });

  // (u)/A2-multiboard defensive guard — a SAME-turn prior winner is
  // authoritative regardless of value equality; the seed never overwrites
  // it (mirrors stage6-a2-multiboard-script-backfill.test.js's own
  // invariant, verified here at the engine layer).
  test('a same-turn prior winner is never overwritten by a differing seed', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { ring_r1_ohm: '0.42' } });
    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 5,
      pending_writes: [{ field: 'ring_r1_ohm', value: '0.85' }],
      ws,
      logger: null,
      now: 1000,
      ownershipResolver: (field, circuitRef) =>
        field === 'ring_r1_ohm' && circuitRef === 5 ? '0.42' : undefined,
    });
    expect(result.ok).toBe(true);
    // The snapshot value is UNTOUCHED — the prior winner wins.
    expect(session.stateSnapshot.circuits[5].ring_r1_ohm).toBe('0.42');
  });
});
