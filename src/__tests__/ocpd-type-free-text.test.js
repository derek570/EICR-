/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — `ocpd_type` records what the
 * inspector sees: free text, advisory-only compatibility, spoken exactly once.
 *
 * Acceptance 2 (server producer outcomes) and 3 (dialogue ingress) on the
 * backend. Every write below goes through the REAL dispatcher and the REAL
 * bundler (or the REAL dialogue engine), so what is asserted is what the
 * inspector would hear, not what a helper returns.
 */

import { jest } from '@jest/globals';

import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { validateRecordReading } from '../extraction/stage6-dispatch-validation.js';
import { coerceRecordReadingValue } from '../extraction/record-reading-coercion.js';
import {
  processProtectiveDeviceTurn,
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_c2_ocpd_type';
const INCOMPATIBLE_60898 = 'may not be right for BS EN 60898';
const UNKNOWN = 'not a type I know';

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(circuits) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
    extractedObservations: [],
  };
}

/** One model turn: dispatch every call, then bundle exactly as the harness does. */
async function modelTurn(session, calls, turnId = 't1') {
  const writes = createPerTurnWrites();
  const d = createWriteDispatcher(session, logger(), turnId, writes);
  const results = [];
  for (const [i, call] of calls.entries()) {
    results.push(await d({ tool_call_id: `tu_${turnId}_${i}`, ...call }, {}));
  }
  const bundled = bundleToolCallsIntoResult(writes, null, {
    stateSnapshot: session.stateSnapshot,
  });
  return { results, confirmations: bundled.confirmations ?? [] };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;
const allText = (confs) => confs.map((c) => c.text).join(' || ');

const recordType = (circuit, value) => ({
  name: 'record_reading',
  input: { field: 'ocpd_type', circuit, value, confidence: 1, source_turn_id: 't' },
});

describe('acceptance 2 — record_reading writes, reads back once, advises once', () => {
  test('"2" on BS EN 60898 → written, one read-back carrying the incompatible advisory', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    const { results, confirmations } = await modelTurn(session, [recordType(4, '2')]);
    expect(results[0].is_error).toBe(false);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('2');
    const type = confirmations.filter((c) => c.field === 'ocpd_type');
    expect(type).toHaveLength(1);
    expect(type[0].text).toBe(`Circuit 4, OCPD type 2, recorded — ${INCOMPATIBLE_60898}`);
    expect(count(allText(confirmations), INCOMPATIBLE_60898)).toBe(1);
  });

  test('"2" on BS 3871 → written, no advisory', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS 3871' } });
    const { confirmations } = await modelTurn(session, [recordType(4, '2')]);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('2');
    expect(confirmations.filter((c) => c.field === 'ocpd_type')[0].text).toBe(
      'Circuit 4, OCPD type 2'
    );
  });

  test('"Q" → written, "not a type I know"', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    const { confirmations } = await modelTurn(session, [recordType(4, 'Q')]);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('Q');
    expect(confirmations[0].text).toBe(`Circuit 4, OCPD type Q, recorded — ${UNKNOWN}`);
  });

  test('"extraordinarily long" → written verbatim, advised, never rejected', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    const { results, confirmations } = await modelTurn(session, [
      recordType(4, 'extraordinarily long'),
    ]);
    expect(results[0].is_error).toBe(false);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('extraordinarily long');
    expect(confirmations[0].text).toContain(UNKNOWN);
  });

  test('"N/A" on BS EN 60898 → written, NO advisory', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    const { confirmations } = await modelTurn(session, [recordType(4, 'N/A')]);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('N/A');
    expect(confirmations[0].text).not.toContain('recorded —');
  });

  test('"" → PLAN-C3 blank rejection, never a clear; no value_not_in_options anywhere', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898', ocpd_type: 'B' } });
    const { results } = await modelTurn(session, [recordType(4, '')]);
    expect(results[0].is_error).toBe(true);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('B');
    for (const v of ['superfast', 'two two', 'K', 'type 2']) {
      expect(
        validateRecordReading(
          { field: 'ocpd_type', circuit: 4, value: v, confidence: 1 },
          session.stateSnapshot
        )
      ).toBeNull();
    }
  });

  test('aliases canonicalise identically through record_reading and set_field_for_all_circuits', async () => {
    for (const [raw, canonical] of [
      ['type two', '2'],
      ['g g', 'gG'],
      ['rewireable', 'Rew'],
    ]) {
      // The speculator's pre-synth text is built from this same coercion, so
      // byte-equality here is what keeps it equal to the dispatched value.
      expect(coerceRecordReadingValue('ocpd_type', raw)).toBe(canonical);
      const single = makeSession({ 4: { ocpd_bs_en: 'BS 3036' } });
      await modelTurn(single, [recordType(4, raw)]);
      expect(single.stateSnapshot.circuits[4].ocpd_type).toBe(canonical);
      const bulk = makeSession({ 1: { ocpd_bs_en: 'BS 3036' }, 2: { ocpd_bs_en: 'BS 3036' } });
      await modelTurn(bulk, [
        {
          name: 'set_field_for_all_circuits',
          input: { field: 'ocpd_type', value: raw, confidence: 1, source_turn_id: 't' },
        },
      ]);
      expect(bulk.stateSnapshot.circuits[1].ocpd_type).toBe(canonical);
      expect(bulk.stateSnapshot.circuits[2].ocpd_type).toBe(canonical);
    }
  });

  test('mixed-standard set_field_for_all_circuits → every circuit written, ONE grouped read-back naming only the BS EN 60898 circuits', async () => {
    const session = makeSession({
      1: { ocpd_bs_en: 'BS EN 60898' },
      2: { ocpd_bs_en: 'BS 3871' },
      3: { ocpd_bs_en: 'BS EN 60898' },
      4: { ocpd_bs_en: 'BS 3871' },
    });
    const { confirmations } = await modelTurn(session, [
      {
        name: 'set_field_for_all_circuits',
        input: { field: 'ocpd_type', value: '2', confidence: 1, source_turn_id: 't' },
      },
    ]);
    for (const c of [1, 2, 3, 4]) expect(session.stateSnapshot.circuits[c].ocpd_type).toBe('2');
    const type = confirmations.filter((c) => c.field === 'ocpd_type');
    expect(type).toHaveLength(1);
    expect(type[0].text).toMatch(
      /, OCPD type 2, recorded — may not be right for BS EN 60898 on circuits 1 and 3$/
    );
    expect(count(type[0].text, 'may not be right')).toBe(1);
  });

  test('re-stating the SAME type on a later turn is read back once WITHOUT the advisory (Decision 6)', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    const first = await modelTurn(session, [recordType(4, 'gG')], 't1');
    expect(first.confirmations[0].text).toContain(INCOMPATIBLE_60898);
    const again = await modelTurn(session, [recordType(4, 'g g')], 't2');
    const type = again.confirmations.filter((c) => c.field === 'ocpd_type');
    expect(type).toHaveLength(1);
    expect(type[0].text).toBe('Circuit 4, OCPD type gG');
  });

  test('a DIFFERENT type on the same circuit is advised again', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898' } });
    await modelTurn(session, [recordType(4, 'gG')], 't1');
    const next = await modelTurn(session, [recordType(4, 'gM')], 't2');
    expect(next.confirmations[0].text).toContain(INCOMPATIBLE_60898);
  });

  test('a later standard change that makes the stored type off speaks the clause on the STANDARD read-back, once', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS 3871', ocpd_type: '2' } });
    const { confirmations } = await modelTurn(session, [
      {
        name: 'record_reading',
        input: {
          field: 'ocpd_bs_en',
          circuit: 4,
          value: 'BS EN 60898',
          confidence: 1,
          source_turn_id: 't',
        },
      },
    ]);
    const std = confirmations.filter((c) => c.field === 'ocpd_bs_en');
    expect(std).toHaveLength(1);
    expect(std[0].text).toMatch(/, type 2 may not be right for BS EN 60898$/);
    expect(count(allText(confirmations), 'may not be right')).toBe(1);
  });

  test('a later standard change that makes the pair compatible speaks only the standard (marker stops)', async () => {
    const session = makeSession({ 4: { ocpd_bs_en: 'BS EN 60898', ocpd_type: '2' } });
    const { confirmations } = await modelTurn(session, [
      {
        name: 'record_reading',
        input: {
          field: 'ocpd_bs_en',
          circuit: 4,
          value: 'BS 3871',
          confidence: 1,
          source_turn_id: 't',
        },
      },
    ]);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].text).not.toContain('may not be right');
  });

  test('standard AND type in one turn: the advisory is spoken once, on the type', async () => {
    const session = makeSession({ 4: {} });
    const { confirmations } = await modelTurn(session, [
      {
        name: 'record_reading',
        input: {
          field: 'ocpd_bs_en',
          circuit: 4,
          value: 'BS EN 60898',
          confidence: 1,
          source_turn_id: 't',
        },
      },
      recordType(4, 'gG'),
    ]);
    const text = allText(confirmations);
    expect(count(text, INCOMPATIBLE_60898)).toBe(1);
    expect(confirmations.find((c) => c.field === 'ocpd_type').text).toContain(INCOMPATIBLE_60898);
  });

  test('ocpd_type is NEVER on the WIRE/CLIENT dedupe-token allowlist (id-84)', async () => {
    const { WIRE_CLIENT_DEDUPE_TOKEN_FIELDS } = await import('../extraction/ios-dedupe-key.js');
    expect(WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has('ocpd_type')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Acceptance 3 — dialogue ingress (the OCPD script's type slot)
// ─────────────────────────────────────────────────────────────────────────

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

const spoken = (ws) =>
  ws.sent
    .filter((m) => m?.type === 'ask_user_started')
    .map((m) => m.question ?? '')
    .join(' || ');

function turn(session, ws, transcriptText, now) {
  return processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText,
    logger: logger(),
    now,
  });
}

/** Open the OCPD walk on circuit 4 with the standard stored, so the next
 *  question is the type slot. */
function reachTypeSlot(standard) {
  const ws = new FakeWS();
  const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 4: {} } } };
  turn(session, ws, 'MCB on circuit 4.', 1000);
  turn(session, ws, standard, 2000);
  expect(session.dialogueScriptState?.values?.ocpd_bs_en).toBeDefined();
  return { ws, session };
}

describe('acceptance 3 — the OCPD script type slot', () => {
  test('the slot asks the standard-aware question', () => {
    const { ws } = reachTypeSlot('BS 3871');
    expect(ws.sent.at(-1).context_field).toBe('ocpd_type');
    expect(ws.sent.at(-1).question).toBe(
      'What type? B, C or D for a breaker; say the type printed on a fuse.'
    );
  });

  test.each([
    ['BS 3871', 'type two', '2'],
    ['BS 1361', 'type two', '2'],
    ['BS EN 60898', 'type i i', 'II'],
    ['BS EN 60947-2', 'K', 'K'],
    ['BS EN 60898', 'type X Y Z', 'XYZ'],
    ['BS EN 60898', 'type superfast', 'superfast'],
    ['BS EN 60898', 'type extraordinarily', 'extraordinarily'],
  ])('under %s the reply %p writes %p with no ask', (standard, reply, expected) => {
    const { ws, session } = reachTypeSlot(standard);
    const before = ws.sent.length;
    turn(session, ws, reply, 3000);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe(expected);
    // The next frame asks the RATING, never the type again.
    const asks = ws.sent.slice(before).filter((m) => m?.type === 'ask_user_started');
    expect(asks.some((m) => m.context_field === 'ocpd_type')).toBe(false);
  });

  test('an unknown type written by the script is advised exactly once, even after completion', () => {
    const { ws, session } = reachTypeSlot('BS EN 60898');
    turn(session, ws, 'type superfast', 3000);
    turn(session, ws, '32 amps', 4000);
    turn(session, ws, '6 kA', 5000);
    expect(session.dialogueScriptState).toBeNull();
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('superfast');
    expect(spoken(ws).split(UNKNOWN).length - 1).toBe(1);
  });

  test.each([['type two two'], ['type extraordinarily long'], ["there's no fuse"], ['type.']])(
    'the reply %p is a script MISS — nothing is written by the script and the turn is handed off',
    (reply) => {
      const { ws, session } = reachTypeSlot('BS EN 60898');
      const result = turn(session, ws, reply, 3000);
      expect(session.stateSnapshot.circuits[4].ocpd_type).toBeUndefined();
      // PLAN-A's first-miss handoff: the script steps aside for the model and
      // never re-asks the type itself.
      expect(result?.handled === false || session.dialogueScriptState == null).toBe(true);
      const asks = ws.sent.filter(
        (m) => m?.type === 'ask_user_started' && m.context_field === 'ocpd_type'
      );
      expect(asks).toHaveLength(1);
    }
  );

  test('"RCD type A" said inside an RCBO walk never lands in ocpd_type', () => {
    const ws = new FakeWS();
    const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 6: {} } } };
    turn(session, ws, 'RCBO on circuit 6.', 1000);
    turn(session, ws, 'BS EN 61009', 2000);
    turn(session, ws, 'type B, RCD type A', 3000);
    expect(session.stateSnapshot.circuits[6].ocpd_type).toBe('B');
    expect(session.stateSnapshot.circuits[6].ocpd_type).not.toBe('A');
  });

  test('BS 1361 and BS 88 no longer derive a type; BS 3036 still derives Rew', () => {
    for (const [standard, expected] of [
      ['BS 1361', undefined],
      ['BS 88-2', undefined],
      ['BS 3036', 'Rew'],
    ]) {
      const ws = new FakeWS();
      const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 4: {} } } };
      turn(session, ws, 'MCB on circuit 4.', 1000);
      turn(session, ws, standard, 2000);
      expect(session.stateSnapshot.circuits[4].ocpd_type).toBe(expected);
    }
  });
});

describe('acceptance 3 — cross-turn: the value and the advisory each heard once (Decision 17)', () => {
  test('a compound utterance that STARTS the walk with an off-list type, then completes on later turns', () => {
    const ws = new FakeWS();
    const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 4: {} } } };
    turn(session, ws, 'OCPD is BS 88-2 type superfast on circuit 4', 1000);
    expect(session.stateSnapshot.circuits[4].ocpd_type).toBe('superfast');
    turn(session, ws, '32 amps', 2000);
    turn(session, ws, '80 kA', 3000);
    expect(session.dialogueScriptState).toBeNull();
    const heard = spoken(ws);
    expect(count(heard, UNKNOWN)).toBe(1);
    expect(count(heard, 'type superfast')).toBe(1);
  });

  test('a BUNDLER-OWNED entry write carrying the off-list type, then natural completion', async () => {
    const session = makeSession({ 4: {} });
    const ws = new FakeWS();
    // The model's write enters the walk (the dispatcher's ordinary case, which
    // is what stamps the seed `spoken_owner = 'bundler'`)…
    enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ocpd',
      circuit_ref: 4,
      pending_writes: [
        { field: 'ocpd_bs_en', value: 'BS 88-2' },
        { field: 'ocpd_type', value: 'superfast' },
      ],
      ws,
      logger: logger(),
      now: 1000,
      ownershipResolver: () => null,
    });
    // …and the BUNDLER reads that write back on the same turn, advisory
    // included, against the post-dispatch snapshot.
    const writes = createPerTurnWrites();
    const { recordReadingWrite, encodeReadingKey } =
      await import('../extraction/stage6-per-turn-writes.js');
    recordReadingWrite(writes, encodeReadingKey('ocpd_type', 4, null), {
      value: 'superfast',
      confidence: 1,
      source_turn_id: 't1',
    });
    const entry = bundleToolCallsIntoResult(writes, null, {
      stateSnapshot: session.stateSnapshot,
    });
    // Later turns run the walk to natural completion.
    turn(session, ws, '32 amps', 2000);
    turn(session, ws, '80 kA', 3000);
    expect(session.dialogueScriptState).toBeNull();

    const heard = `${allText(entry.confirmations ?? [])} || ${spoken(ws)}`;
    // The ADVISORY half is this plan's own, asserted unconditionally.
    expect(count(heard, UNKNOWN)).toBe(1);
    // The VALUE half is PLAN-A's Decision 17 deliverable (merged before this
    // plan): the completion summary omits the type it has already spoken. If
    // this goes RED, check that PLAN-A's per-field suppression is present
    // before changing anything in PLAN-C2.
    expect(count(heard, 'type superfast')).toBe(1);
  });
});
