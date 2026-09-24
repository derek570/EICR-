/**
 * PLAN-A / Decision 9 (feedback-2026-09-17, taken by Derek) — breaking
 * capacity follows fuse type: RECORD it, ADVISE once, never block.
 *
 * The advisory is spoken exactly once on every path this plan touches, and so
 * is the VALUE (Decision 17). THREE producers carry the advisory — the
 * bundler's ordinary confirmation, the script's terminal read-back, and the
 * script's normal completion summary — and the assertion that matters is that
 * their operation sets are DISJOINT, so nothing is advised twice.
 *
 * FIVE PATHS are driven, not three. v41 named two producers and missed the most
 * ordinary one: the script that simply FINISHES.
 */

import {
  processProtectiveDeviceTurn,
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { advisoryForFieldValue } from '../extraction/circuit-value-descriptors.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import {
  createPerTurnWrites,
  recordReadingWrite,
  encodeReadingKey,
} from '../extraction/stage6-per-turn-writes.js';

const SESSION_ID = 'sess_ka_advisory';
const ADVISORY_66 = "recorded — 66 kA isn't a standard breaking capacity";

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

const spoken = (ws) =>
  ws.sent
    .filter((m) => m?.type === 'ask_user_started')
    .map((m) => m.question ?? '')
    .join(' || ');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

function reachBreakingCapacitySlot(session, ws, logger) {
  for (const [transcriptText, now] of [
    ['MCB on circuit 5.', 1000],
    ['BS EN 60898', 2000],
    ['B', 3000],
    ['32 amps', 4000],
  ]) {
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText,
      logger,
      now,
    });
  }
}

describe('the derivation itself', () => {
  test('off-list earns the advisory; every listed value and LIM earn none', () => {
    expect(advisoryForFieldValue('ocpd_breaking_capacity_ka', '66')).toBe(ADVISORY_66);
    // Decision 16's vectors — the whole of Case 1's dissolution. These would go
    // RED if the suggestion list were reverted to the old published ladder.
    for (const v of ['1', '1.5', '2', '3', '4', '4.5', '6', '9', '10', '15', '16', '16.5']) {
      expect({ v, advisory: advisoryForFieldValue('ocpd_breaking_capacity_ka', v) }).toEqual({
        v,
        advisory: null,
      });
    }
    for (const v of ['20', '25', '33', '35', '36', '50', '65', '80', '100']) {
      expect({ v, advisory: advisoryForFieldValue('ocpd_breaking_capacity_ka', v) }).toEqual({
        v,
        advisory: null,
      });
    }
    // LIM is a recorded non-value the ranged validator already accepts; the
    // advisory must never fire on it, in any spoken form's canonical output.
    for (const v of ['LIM', 'lim']) {
      expect(advisoryForFieldValue('ocpd_breaking_capacity_ka', v)).toBeNull();
    }
    // 16 and 16.5 are DISTINCT and must never be collapsed — 16.5 is the
    // BS 1361 Type I / BS 88-3 figure at 240 V, 16 is an MCCB Icu. Neither
    // earns an advisory, and the list is STRINGS for exactly this reason.
    expect(advisoryForFieldValue('ocpd_breaking_capacity_ka', '16.50')).toBe(
      "recorded — 16.50 kA isn't a standard breaking capacity"
    );
  });

  test('no other field carries an advisory today', () => {
    for (const f of ['ocpd_rating_a', 'ocpd_type', 'r1_r2_ohm', 'measured_zs_ohm']) {
      expect(advisoryForFieldValue(f, '999')).toBeNull();
    }
  });
});

describe('path (a) — the script COMPLETES on the off-list answer', () => {
  test('OCPD: the advisory rides finishScript’s combined frame, exactly once', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    const rows = [];
    const logger = { info: (e, p) => rows.push({ e, p }), warn: () => {} };
    reachBreakingCapacitySlot(session, ws, logger);

    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '66',
      logger,
      now: 5000,
    });

    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBe('66');
    // WRITTEN, not markRejected + re-asked: no out-of-set log line on any schema.
    expect(rows.filter((r) => /_slot_value_out_of_set$/.test(r.e))).toEqual([]);
    // Spoken exactly once, and no second ask follows.
    expect(occurrences(spoken(ws), ADVISORY_66)).toBe(1);
    expect(session.dialogueScriptState).toBeNull();
  });

  test('RCBO: the same, on the schema with its own finishMessage and a finishCoveredFields opt-in', () => {
    const ws = new FakeWS();
    const session = buildSession({
      // PLAN-CS (CS-64) — no mirror fills the RCD's BS number from the OCPD
      // standard any more, and Decision 39 asks it at the start of the RCD
      // half, after breaking capacity. It is stored here so the walk still
      // COMPLETES on the breaking-capacity answer, which is this path.
      6: { rcd_bs_en: 'BS EN 61009', rcd_type: 'A', rcd_operating_current_ma: '30' },
    });
    const logger = { info: () => {}, warn: () => {} };
    for (const [transcriptText, now] of [
      ['RCBO on circuit 6.', 1000],
      ['BS EN 61009', 2000],
      ['type B', 3000],
      ['32 amps', 4000],
      ['66 kA', 5000],
    ]) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        logger,
        now,
      });
    }
    expect(session.stateSnapshot.circuits[6].ocpd_breaking_capacity_ka).toBe('66');
    expect(occurrences(spoken(ws), ADVISORY_66)).toBe(1);
  });
});

describe('path (b) — the script CONTINUES after the off-list answer', () => {
  test('the advisory rides the ask turn’s read-back once, and not again at completion', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    const logger = { info: () => {}, warn: () => {} };
    // Answer breaking capacity FIRST, volunteered with the entry, so slots
    // remain and the script asks on.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'MCB on circuit 5, breaking capacity 66 kA.',
      logger,
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBe('66');
    expect(session.dialogueScriptState).not.toBeNull();

    for (const [transcriptText, now] of [
      ['BS EN 60898', 2000],
      ['B', 3000],
      ['32 amps', 4000],
    ]) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        logger,
        now,
      });
    }
    // Once across the WHOLE episode — this is the cross-turn assertion.
    expect(occurrences(spoken(ws), ADVISORY_66)).toBe(1);
  });
});

describe('path (d) — a BUNDLER-OWNED entry write, then a later completion (CROSS-TURN)', () => {
  test('spoken once at entry, and neither the advisory NOR the value recurs in the summary', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    const logger = { info: () => {}, warn: () => {} };

    // `sonnet_start_dialogue_script` seeds the off-list value; an
    // ownershipResolver being present is the ordinary dispatcher case, and it
    // is what stamps the seed bundler-owned — the bundler reads it back on
    // this same turn, so `finishScript` must not say it again.
    enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ocpd',
      circuit_ref: 5,
      pending_writes: [{ field: 'ocpd_breaking_capacity_ka', value: '66' }],
      ws,
      logger,
      now: 1000,
      ownershipResolver: () => null,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_breaking_capacity_ka).toBe('66');

    for (const [transcriptText, now] of [
      ['BS EN 60898', 2000],
      ['B', 3000],
      ['32 amps', 4000],
    ]) {
      processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        logger,
        now,
      });
    }

    const heard = spoken(ws);
    // The engine speaks the advisory ZERO times here: the bundler owns that
    // value's read-back on the entry turn (and carries the advisory with it —
    // asserted separately in the bundler case below), and Decision 17 keeps the
    // completion summary from repeating either half.
    expect(occurrences(heard, ADVISORY_66)).toBe(0);
    expect(occurrences(heard, '66 kA')).toBe(0);
    // …and the summary still names the other three fields, so the omission is
    // PER FIELD and not a suppressed line.
    const finishFrames = ws.sent
      .filter((m) => m?.type === 'ask_user_started')
      .map((m) => m.question ?? '')
      .filter((q) => q.startsWith('Got it.'));
    expect(finishFrames).toHaveLength(1);
    expect(finishFrames[0]).toBe('Got it. BS EN 60898, type B, 32 amps.');
  });
});

describe('producer 1 — the bundler’s ordinary confirmation', () => {
  test('a model write of 66 carries the advisory in its read-back text', () => {
    const perTurnWrites = createPerTurnWrites();
    recordReadingWrite(perTurnWrites, encodeReadingKey('ocpd_breaking_capacity_ka', 5, null), {
      value: '66',
      confidence: 1,
      source_turn_id: 't1',
    });
    const result = bundleToolCallsIntoResult(perTurnWrites, null, {});
    const confs = result.confirmations ?? [];
    const ka = confs.filter((c) => c.field === 'ocpd_breaking_capacity_ka');
    expect(ka).toHaveLength(1);
    expect(ka[0].text).toContain(ADVISORY_66);
    // Exactly once, and the expanded form is derived from the FINAL text.
    expect(occurrences(ka[0].text, ADVISORY_66)).toBe(1);
    expect(ka[0].expanded_text).toContain('standard breaking capacity');
  });

  test('a listed value carries none, and no new dedupe token is minted for it', () => {
    const perTurnWrites = createPerTurnWrites();
    recordReadingWrite(perTurnWrites, encodeReadingKey('ocpd_breaking_capacity_ka', 5, null), {
      value: '6',
      confidence: 1,
      source_turn_id: 't1',
    });
    const result = bundleToolCallsIntoResult(perTurnWrites, null, {});
    const ka = (result.confirmations ?? []).filter((c) => c.field === 'ocpd_breaking_capacity_ka');
    expect(ka).toHaveLength(1);
    expect(ka[0].text).not.toContain('standard breaking capacity');
  });

  test('breaking capacity is NEVER on the WIRE/CLIENT dedupe-token allowlist', async () => {
    // Adding a measured-value field there would reopen the id-84
    // correction-swallow bug (fixed 2026-07-24, session 2ACE7677). The advisory
    // needs no entry because it rides the read-back TEXT and the key is already
    // value-aware.
    const { WIRE_CLIENT_DEDUPE_TOKEN_FIELDS } = await import('../extraction/ios-dedupe-key.js');
    expect(WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has('ocpd_breaking_capacity_ka')).toBe(false);
  });
});
