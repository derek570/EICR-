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
  processRingContinuityTurn,
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
    // Codex diff-review r1 — the bulk confirm text ("Applied RCD to all
    // circuits.") only names the field GROUP + circuit scope, never the
    // actual dictated values (formatBulkApplyConfirm has no per-value
    // template): BS/type/current are genuinely never spoken anywhere else
    // either (finishScript is deliberately skipped on the bulk-accept
    // path), so ALL of them — not just trip time — must be named via the
    // terminal-sink append.
    expect(lastQuestion(ws)).toBe(
      'Applied RCD to all circuits. Also got: trip time 25, BS number BS EN 61008, type AC, operating current 30.'
    );
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
    // PLAN-A (feedback-2026-09-17) — the re-dictation rides the SAME turn as
    // the answer to the slot the engine actually asked. BS is snapshot-seeded,
    // so the walk skips it and asks `rcd_type`; re-dictating BS on a turn of
    // its OWN would leave that ask unanswered, which is now a first miss and
    // ends the walk-through (asserted separately below). This is the realistic
    // utterance for the case anyway.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Type AC, BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 4000,
    });
    // Verbatim ceremony still fires — the re-dictated (canonical-equal) BS
    // is script-owned satisfied_existing, so it counts as "dictated" for
    // the device-summary coverage check.
    // satisfied_existing never re-writes — the snapshot keeps its
    // ORIGINAL raw seeded form (never round-tripped through the parser).
    expect(lastQuestion(ws)).toBe('Got it. 61008, type AC, 30 mA.');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('61008');
  });

  // (e2) PLAN-A — the SAME re-dictation on a turn of its own is a first miss,
  // and the Audio-First invariant this pair exists for still holds: a dictated
  // non-empty value is never silent, and no phantom write is created.
  test('(e2) a snapshot-equal re-dictation that leaves the ASK unanswered hands off, still spoken', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { rcd_bs_en: '61008' } });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 5.',
      now: 1000,
    });
    // The engine asked for the TYPE (BS is seeded, so the walk skipped it).
    expect(ws.sent.at(-1).context_field).toBe('rcd_type');

    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });

    // Still SPOKEN — at the terminal exit rather than the finish summary.
    expect(lastQuestion(ws)).toBe('Also got BS number 61008.');
    // Still no phantom write: satisfied_existing, and the snapshot keeps its
    // original raw seeded form.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('61008');
    // And the unanswered ask is a first miss.
    expect(out).toMatchObject({ handled: true, fallthrough: true });
    expect(out.serverNote.asked_field).toBe('rcd_type');
    expect(session.dialogueScriptState).toBeNull();
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

  // Codex diff-review r2 (silent-path lens, 2/3 cycle-2 lenses convergent) —
  // a same-field correction dictated while the circuit is STILL unresolved
  // must upsert the queued entry (superseded op abandoned), never silently
  // drop the correction and keep speaking the stale first value.
  test('a same-field correction while unresolved upserts the queue — the LATEST value drains and speaks, never the stale one', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time is 25 ms.',
      now: 1000,
    });
    // Corrects the SAME field before the circuit resolves.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Actually, trip time is 27 ms.',
      now: 1500,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 5',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel',
      now: 3000,
    });
    expect(lastQuestion(ws)).toBe('RCD cancelled. Also got trip time 27.');
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

  // (i) RCBO BS numbers → ONE spoken occurrence when equal. PLAN-CS (CS-64 /
  // CS-70) retired the mirror: both BS slots are separate asked slots, and
  // the finish line names the RCD's number only when it DIFFERS, so equal
  // values are spoken once and the terminal-sink rule never doubles them.
  test('(i) RCBO BS slots answered separately with equal values — named once, never doubled', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCBO on circuit 5.',
      now: 1000,
    });
    // First-asked slot is ocpd_bs_en, then rcd_bs_en — each its own answer.
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
      transcriptText: 'BS EN 61009',
      now: 2500,
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
    // BS EN 61009 pivots RCD -> RCBO. PLAN-CS (CS-64 / CS-114): no mirror
    // fills the OCPD standard, so RCBO asks it first — one answer turn,
    // then the rest of the walkthrough to finish.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2500,
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
      // PLAN-CS — seeds canonicalise through `parseRcdBsCode`, so the seed's
      // canonical value is `BS EN 61008`.
      const resolver = (field, circuitRef, canonicalValue) =>
        field === 'rcd_bs_en' && circuitRef === 5 && canonicalValue === 'BS EN 61008'
          ? 'bundler'
          : null;
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
      // Codex diff-review r1 — type/current are snapshot-only (never
      // dictated this run, no covering operation), so the legacy verbatim
      // summary is correctly SUPPRESSED (the "ALL summarised fields
      // script-owned" rule requires every finish-covered field to have an
      // operation, not just the ones that happen to). Only the genuinely
      // dictated BS number is spoken — satisfied_existing never re-writes,
      // so it carries the ORIGINAL raw seeded form.
      expect(lastQuestion(ws)).toBe('Also got BS number 61008.');
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
      // Codex diff-review r1 — same partial-dictation reasoning as the
      // canonical-equal case above: type/current are snapshot-only, so the
      // legacy verbatim summary is suppressed; only the genuinely dictated
      // (freshly written) BS number is spoken — in its canonical form, since
      // PLAN-CS canonicalises BS seeds through the slot's parser.
      expect(lastQuestion(ws)).toBe('Also got BS number BS EN 61008.');
    });
  });

  // Ownership triad, DIFFERENT-prior-winner leg (Codex diff-review r1, 3/3
  // lenses convergent) — a prior per-turn winner is compared CANONICALLY,
  // not deferred to unconditionally: a genuinely different seed still
  // overwrites and becomes the latest (bundler-owned) winner. An earlier
  // draft treated ANY prior winner as authoritative regardless of value,
  // silently discarding a valid correction — exactly id 117's class of bug.
  test('a DIFFERENT same-turn prior winner is overwritten by the seed, becomes the new bundler-owned winner', () => {
    const ws = new FakeWS();
    // All OTHER RCD slots pre-filled so this seed triggers IMMEDIATE finish
    // — isolates the ownership question from step-driven walkthrough asks.
    const session = buildSession({
      5: { rcd_bs_en: '61008', rcd_type: 'AC', rcd_operating_current_ma: '30' },
    });
    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 5,
      // 62423 (not 61009 — that value triggers RCD's own RCBO-pivot
      // derivation, an unrelated mechanism this test must not exercise; and
      // not 60898, an MCB standard the strict RCD parser refuses since
      // PLAN-CS).
      pending_writes: [{ field: 'rcd_bs_en', value: '62423' }],
      ws,
      logger: null,
      now: 1000,
      ownershipResolver: (field, circuitRef, canonicalValue) =>
        field === 'rcd_bs_en' && circuitRef === 5 && canonicalValue === 'BS EN 61008'
          ? 'bundler'
          : null,
    });
    expect(result.ok).toBe(true);
    expect(result.seeded_writes).toEqual(['rcd_bs_en']);
    // The seed's genuinely different value overwrites the stale winner. Since
    // PLAN-CS, pending_writes-sourced BS values canonicalise through the
    // slot's parser in normaliseDialogueSlotWrite, like dictation does.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 62423');
    // Bundler-owned (guaranteed backfilled) — the engine speaks NOTHING.
    expect(ws.sent.filter((m) => m?.type === 'ask_user_started')).toHaveLength(0);
  });

  // The EQUAL leg of the same triad — an equal prior winner is bundler-
  // owned and the seed never re-writes (no phantom write op).
  test('an EQUAL same-turn prior winner is bundler-owned, seed does not re-write', () => {
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
      ownershipResolver: (field, circuitRef, canonicalValue) =>
        field === 'rcd_bs_en' && circuitRef === 5 && canonicalValue === 'BS EN 61008'
          ? 'bundler'
          : null,
    });
    expect(result.ok).toBe(true);
    // Canonical-equal to the stored legacy bytes → satisfied, never rewritten.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('61008');
    expect(ws.sent.filter((m) => m?.type === 'ask_user_started')).toHaveLength(0);
  });

  // Codex diff-review r3 (2/3 lenses convergent) — the ownership resolver
  // is a FROZEN pre-call snapshot. Two entries for the SAME field in one
  // pending_writes array, where the SECOND happens to match the frozen
  // prior winner's value, must not let the resolver silently discard the
  // second (latest) write as "already bundler-owned" — it's actually a
  // genuine correction superseding what THIS loop just wrote first.
  test('a later duplicate matching the frozen prior winner still overwrites an intervening same-loop write', () => {
    const ws = new FakeWS();
    const session = buildSession({
      5: { rcd_type: 'AC', rcd_operating_current_ma: '30' },
    });
    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 5,
      // B then A, where the resolver's frozen prior winner is A (62423) —
      // simulating an earlier-in-the-turn record_reading of 62423, then two
      // start_dialogue_script seeds: first a genuinely different write
      // (61008), then a later write that happens to equal the frozen prior
      // winner (62423). The 62423 write is the LATEST dictation and must
      // win — not be silently dropped because it matches the stale
      // pre-call resolver snapshot.
      pending_writes: [
        { field: 'rcd_bs_en', value: '61008' },
        { field: 'rcd_bs_en', value: '62423' },
      ],
      ws,
      logger: null,
      now: 1000,
      ownershipResolver: (field, circuitRef, canonicalValue) =>
        field === 'rcd_bs_en' && circuitRef === 5 && canonicalValue === 'BS EN 62423'
          ? 'bundler'
          : null,
    });
    expect(result.ok).toBe(true);
    // The LATEST dictated value (62423) must be what's actually stored —
    // not silently discarded in favour of the intervening 61008 write.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 62423');
  });

  // (l) two same-field dictations → TWO operations, each spoken per its own
  // coverage (plan's literal test (l); Codex diff-review r2, 2/3 lenses
  // convergent — reverses r1's "latest-only" draft). The finish text covers
  // the LATEST (the value it actually renders, script-owned); the earlier,
  // genuinely-APPLIED (never-abandoned) correction is a distinct dictated
  // reading and is separately named via the terminal-sink append — a
  // superseded QUEUED write is what goes silently `abandoned`, not a
  // superseded APPLIED one.
  test('a repeated same-field correction: both APPLIED dictations are spoken, the latest via the finish text and the earlier via the appended read-back', () => {
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
    // Corrects the SAME field before finishing. PLAN-A (feedback-2026-09-17):
    // the correction rides the same turn as the answer to the slot the engine
    // asked (`rcd_type`). A bare "actually BS EN 60898" on its own turn leaves
    // that ask unanswered, which is now a first miss and ends the walk-through.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      // 62423, not 60898: the strict RCD parser refuses an MCB standard.
      transcriptText: 'Type AC, actually BS EN 62423',
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
    // Stored value is the CORRECTED one.
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 62423');
    // The finish text covers the latest (script-owned, current) value ONCE;
    // the earlier correction is a distinct genuinely-dictated reading and
    // is separately named via the terminal-sink append — neither is
    // doubled, and neither is silently dropped.
    const finish = lastQuestion(ws);
    expect(finish).toBe('Got it. BS EN 62423, type AC, 30 mA. Also got BS number BS EN 61008.');
    expect((finish.match(/62423/g) ?? []).length).toBe(1);
    expect((finish.match(/61008/g) ?? []).length).toBe(1);
  });

  // Cross-circuit provenance (Codex diff-review r1, edge-interactions lens)
  // — an operation carried across a pivot REPLACEMENT from the source
  // schema's circuit must still render with the correct circuit context,
  // never silently mis-attributed to whatever circuit happens to be
  // current when it's finally spoken.
  test('a pivoted-away operation survives the schema change and reads back correctly after finish', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    // RCD entry with a trip-time volunteered value, then BS EN 61009 pivots
    // RCD -> RCBO mid-walkthrough. The trip-time operation must survive the
    // pivot (runPivot carries state.operations across) and still be spoken
    // at the eventual RCBO finish (RCBO's finishCoveredFields excludes
    // rcd_trip_time, so it stays "uncovered" until the terminal-sink append).
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
      transcriptText: 'BS EN 61009',
      now: 2000,
    });
    // PLAN-CS (CS-64 / CS-114) — the RCD → RCBO pivot no longer mirrors the
    // RCD's number into the OCPD standard, so RCBO asks for it next.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61009',
      now: 2500,
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
    const finish = lastQuestion(ws);
    expect(finish).toMatch(/^Got it\./);
    expect(finish).toMatch(/Also got trip time 25\.$/);
    // Same circuit throughout (no cross-circuit pivot here), so no
    // "circuit N" qualifier prefix is expected.
    expect(finish).not.toMatch(/circuit 5 trip time/);
  });

  // Codex diff-review r2 (edge-interactions lens) — a REPLACEMENT site (e.g.
  // the active-path different-entry scope conflict) carries the full
  // `state.operations` list across a CIRCUIT CHANGE. `finishScript`'s
  // coverage check and `askNextOrFinish`'s bulk-apply ceremony gate must
  // both require `effective_circuit_ref === state.circuit_ref` — otherwise a
  // stale operation from the OLD circuit can wrongly satisfy coverage for
  // the NEW circuit's snapshot-only (never-dictated-this-run) value.
  test("a carried operation from a DIFFERENT circuit never satisfies this circuit's finish coverage or bulk-ask gate", () => {
    const ws = new FakeWS();
    const scratchSession = buildSession({ 5: {} });
    // Circuit 5, a throwaway session: dictate ONLY the BS number, capture
    // the resulting 'applied' operation object (effective_circuit_ref: 5).
    const seeded = enterScriptByName({
      session: scratchSession,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 5,
      pending_writes: [{ field: 'rcd_bs_en', value: '62423' }],
      ws: new FakeWS(),
      logger: null,
      now: 1000,
    });
    expect(seeded.ok).toBe(true);
    const staleCircuit5Op = scratchSession.dialogueScriptState.operations[0];
    expect(staleCircuit5Op.effective_circuit_ref).toBe(5);
    // Real session, circuit 6: BS is snapshot-filled (so the walkthrough
    // never asks for it), type/current are missing so the walkthrough
    // genuinely asks for and dictates both this run. A fresh entry puts the
    // engine into a well-defined active state awaiting 'rcd_type' first.
    // THEN append the foreign circuit-5 operation to `state.operations` —
    // simulating exactly what a REPLACEMENT site's
    // `state.operations = priorOperations` produces — without disturbing
    // any of the engine's own slot-tracking state.
    // A VALID stored RCD standard (PLAN-CS: an unparseable one would be asked).
    const session = buildSession({ 6: { rcd_bs_en: 'BS EN 62423' } });
    const entered = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 6,
      pending_writes: [],
      ws,
      logger: null,
      now: 1000,
    });
    expect(entered.ok).toBe(true);
    expect(session.dialogueScriptState.operations).toHaveLength(0);
    session.dialogueScriptState.operations.push(staleCircuit5Op);
    ws.sent = [];
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 3000,
    });
    // The bulk-apply prompt legitimately fires here (type/current WERE
    // genuinely dictated for circuit 6 this run) — decline it to reach the
    // finish text, the same shape as test (b).
    expect(lastQuestion(ws)).toMatch(/Apply these RCD details/);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 4000,
    });
    // The stale circuit-5 operation must never satisfy finishScript's
    // coverage for circuit 6's bs_en — that would misattribute a
    // snapshot-only value as dictated this run and speak the byte-identical
    // verbatim legacy summary as if BS had been said. It must NOT match
    // test (b)'s all-covered verbatim shape.
    const finish = lastQuestion(ws);
    expect(finish).not.toBe('Got it. BS EN 62423, type AC, 30 mA.');
    expect(finish).not.toMatch(/^Got it\./);
    expect(session.stateSnapshot.circuits[6].rcd_type).toBe('AC');
    expect(session.stateSnapshot.circuits[6].rcd_operating_current_ma).toBe('30');
  });

  // Codex diff-review r2 — §(w)'s "a validation-REJECTED operation →
  // `rejected`, no read-back" requires an actual ledger entry for a KNOWN
  // schema field the normaliser refuses (invalid/out-of-range/off-ladder),
  // not just the separate `dropped_fields` return-envelope channel.
  test('a known-field invalid seeded value is recorded rejected in the ledger and produces no read-back', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: { rcd_bs_en: '60898', rcd_type: 'AC' } });
    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 5,
      // Not a valid RCD operating current — off-ladder / out of range.
      pending_writes: [{ field: 'rcd_operating_current_ma', value: 'ten thousand' }],
      ws,
      logger: null,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.dropped_fields).toEqual(['rcd_operating_current_ma']);
    expect(result.seeded_writes ?? []).toEqual([]);
    const ops = session.dialogueScriptState.operations.filter(
      (op) => op.field === 'rcd_operating_current_ma'
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].disposition).toBe('rejected');
    // Never read back — no frame names the rejected value.
    expect(ws.sent.some((m) => /ten thousand/.test(m.question ?? ''))).toBe(false);
  });

  // Codex diff-review r4 (final convergence check) — transitionToConfirmation
  // marked EVERY matching operation for a field covered, not just the
  // LATEST. The confirmation message renders only the CURRENT value, so an
  // earlier same-field correction made before reaching confirmation was
  // wrongly marked covered too and never reached any later read-back.
  test('a mid-collection R1 correction is covered by its LATEST operation in the ring confirmation, not silently dropped', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    // R1 dictated as 0.43 (bare-value answer to "What are the lives?").
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.43',
      now: 1500,
    });
    // Corrected to 0.44 before Rn/R2 are collected.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Actually the lives are 0.44.',
      now: 1800,
    });
    // PLAN-A (feedback-2026-09-17) — WHERE THE READ-BACK NOW HAPPENS, and why
    // it moved. The correction above answers `ring_r1_ohm` while the engine's
    // outstanding ask was `ring_rn_ohm`, so under Decision 1 it is a compound
    // reply with an UNANSWERED ask: a first miss. The walk-through ends here
    // and the terminal exit speaks what this run captured but has not yet said.
    // Previously the script stayed alive, the walk reached confirmation, and
    // the superseded operation waited for a cancel to be spoken.
    //
    // The INVARIANT this test exists for is unchanged and is asserted on the
    // new site: the SUPERSEDED 0.43 R1 operation still reaches a read-back
    // (never silently dropped), and per-operation coverage means the CURRENT
    // 0.44 is named exactly once alongside it rather than twice.
    const terminal = ws.sent.filter((m) => m?.type === 'ask_user_started').at(-1)?.question ?? '';
    expect(terminal).toMatch(/0\.43/);
    expect((terminal.match(/0\.44/g) ?? []).length).toBe(1);
    expect(session.dialogueScriptState).toBeNull();

    // The correction itself landed — a handoff never discards a write.
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.44');
  });
});
