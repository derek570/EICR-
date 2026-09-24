/**
 * PLAN-CS (feedback-2026-09-17) — the model boundary (acceptance 4) and the
 * OCPD-standard answer resolver (acceptance 4b).
 *
 * `ocpd_bs_en` is free text now. At the model boundary a value that is not
 * standard-shaped is rejected as `ocpd_standard_shape` on both write tools,
 * with no mutation. When the model then asks ONCE, the inspector's answer is
 * read by `resolveOcpdStandardAnswer` ahead of the enum resolver: a readable
 * standard is written through the ordinary tools — a bulk answer through a
 * `set_field_for_all_circuits` carrying the original scope verbatim — and an
 * unreadable one stages PLAN-C3's post-ask refusal.
 *
 * Driven through the REAL write dispatchers and the REAL auto-resolve hook, so
 * the scope-preservation claim is proven by which circuits change.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import {
  createWriteDispatcher,
  createAutoResolveWriteHook,
  WRITE_DISPATCHERS,
} from '../extraction/stage6-dispatchers.js';
import {
  recordAskRegistration,
  resolveAskRejectionLineage,
  stagePostAskRejection,
} from '../extraction/stage6-blank-write-notices.js';
import * as answerResolver from '../extraction/stage6-answer-resolver.js';

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

function buildSession() {
  const circuits = {};
  for (let n = 1; n <= 5; n += 1) circuits[n] = { circuit_designation: `Circuit ${n}` };
  // Circuits 2 and 3 are RCD-protected (an explicit RCD field set).
  circuits[2].rcd_type = 'A';
  circuits[3].rcd_bs_en = 'BS EN 61008';
  return {
    sessionId: 'sess-plan-cs',
    stateSnapshot: {
      circuits,
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
    },
    extractedObservations: [],
  };
}

const bulkNotices = (writes, route) =>
  writes.mandatoryNotices.filter(
    (n) => n.family === 'enum_rejected_after_ask' && n.route === route
  );

/** One model `record_reading` / `set_field_for_all_circuits` through the real dispatcher. */
async function modelWrite(session, writes, name, input, id = 'tu_write') {
  const d = createWriteDispatcher(session, logger(), 'turn-1', writes);
  const env = await d({ tool_call_id: id, name, input }, {});
  return { env, body: JSON.parse(env.content) };
}

/**
 * Drive one ask through the real ask dispatcher, with the PLAN-C3 hooks and
 * the REAL auto-resolve hook wired to a shared accumulator.
 */
async function runAsk({ session, writes, input, userText, send = jest.fn() }) {
  const pendingAsks = createPendingAsksRegistry();
  const log = logger();
  const ws = { readyState: 1, OPEN: 1, send };
  const dispatcher = createAskDispatcher(session, log, 'turn-1', pendingAsks, ws, {
    autoResolveWrite: createAutoResolveWriteHook(session, log, 'turn-1', writes),
    recordAskRegistration: (spec) => recordAskRegistration(session, writes, spec),
    resolveAskRejectionLineage: (spec) => resolveAskRejectionLineage(session, writes, spec),
    stageEnumRejectionAfterAsk: (spec) => stagePostAskRejection(session, writes, 'turn-1', spec),
  });
  const call = dispatcher({ tool_call_id: 'toolu_ask', name: 'ask_user', input }, {});
  await new Promise((r) => setImmediate(r));
  // `resolve` on an id that was never registered is a no-op, which is what the
  // refused-before-registration case needs.
  if (userText !== undefined) {
    pendingAsks.resolve('toolu_ask', { answered: true, user_text: userText });
  }
  const env = await call;
  return { env, body: JSON.parse(env.content), log };
}

const ocpdAsk = (overrides = {}) => ({
  question: "What's the BS number of the breaker?",
  reason: 'missing_context',
  context_field: 'ocpd_bs_en',
  context_circuit: 1,
  expected_answer_shape: 'free_text',
  ...overrides,
});

// ── Acceptance 4 — the model boundary ────────────────────────────────────────

describe('acceptance 4 — model writes to ocpd_bs_en', () => {
  test('record_reading "There is no RCBO" → ocpd_standard_shape, no mutation, accepted forms listed', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { env, body } = await modelWrite(session, writes, 'record_reading', {
      field: 'ocpd_bs_en',
      circuit: 1,
      value: 'There is no RCBO',
      confidence: 0.9,
      source_turn_id: 't1',
    });
    expect(env.is_error).toBe(true);
    expect(body.error.code).toBe('ocpd_standard_shape');
    expect(body.error.accepted_forms).toMatch(/BS EN 60898/);
    expect(body.rejection_ref).toEqual(expect.any(String));
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBeUndefined();
  });

  test.each([
    ['BS 9999', 'BS 9999'],
    ['BS 3871', 'BS 3871'],
    ['60898-1', 'BS EN 60898'],
    ['N/A', 'N/A'],
  ])('record_reading %j → written as %j', async (value, stored) => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { env } = await modelWrite(session, writes, 'record_reading', {
      field: 'ocpd_bs_en',
      circuit: 1,
      value,
      confidence: 0.9,
      source_turn_id: 't1',
    });
    expect(env.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBe(stored);
  });

  test('set_field_for_all_circuits "There is no RCBO" → rejected, zero circuits mutated', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { env, body } = await modelWrite(session, writes, 'set_field_for_all_circuits', {
      field: 'ocpd_bs_en',
      value: 'There is no RCBO',
      confidence: 0.9,
      source_turn_id: 't1',
    });
    expect(env.is_error).toBe(true);
    expect(body.error.code).toBe('ocpd_standard_shape');
    expect(body.rejection_ref).toEqual(expect.any(String));
    for (let n = 1; n <= 5; n += 1) {
      expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBeUndefined();
    }
  });

  test('set_field_for_all_circuits {BS 3871, scope: all} → written to every circuit', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { env } = await modelWrite(session, writes, 'set_field_for_all_circuits', {
      field: 'ocpd_bs_en',
      value: 'BS 3871',
      scope: 'all',
      confidence: 0.9,
      source_turn_id: 't1',
    });
    expect(env.is_error).toBe(false);
    for (let n = 1; n <= 5; n += 1) {
      expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBe('BS 3871');
    }
  });
});

// ── Acceptance 4b — the answer resolver ──────────────────────────────────────

describe('acceptance 4b — an ask for ocpd_bs_en, single circuit', () => {
  test.each([
    ['N/A', 'N/A'],
    ['BS EN 60947-4-1', 'BS EN 60947-4-1'],
    ['b s 3871', 'BS 3871'],
  ])('reply %j → written as %j, one write, no escalation', async (reply, stored) => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { body } = await runAsk({ session, writes, input: ocpdAsk(), userText: reply });
    expect(body.match_status).toBe('ocpd_standard_resolved');
    expect(body.auto_resolved).toBe(true);
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({ tool: 'record_reading', circuit: 1, value: stored, ok: true }),
    ]);
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBe(stored);
  });

  test('reply "BS 123456" → nothing written, ocpd_standard_rejected_after_ask, the refusal staged once', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { body } = await runAsk({ session, writes, input: ocpdAsk(), userText: 'BS 123456' });
    expect(body.match_status).toBe('ocpd_standard_rejected_after_ask');
    expect(body.auto_resolved).toBe(false);
    expect(body.accepted_forms).toMatch(/BS EN 60898/);
    expect(body.post_ask_rejection_policy).toContain('Do not ask again');
    expect(session.stateSnapshot.circuits[1].ocpd_bs_en).toBeUndefined();
    expect(bulkNotices(writes, 'enum_rejected_after_ask')).toHaveLength(1);
  });

  test('a plural ask writes EXACTLY the named circuits, never all', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { body } = await runAsk({
      session,
      writes,
      input: ocpdAsk({ context_circuit: undefined, context_circuits: [2, 3] }),
      userText: 'BS 3871',
    });
    expect(body.match_status).toBe('ocpd_standard_resolved');
    expect(body.resolved_writes.map((w) => w.circuit)).toEqual([2, 3]);
    expect(session.stateSnapshot.circuits[2].ocpd_bs_en).toBe('BS 3871');
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS 3871');
    for (const n of [1, 4, 5]) expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBeUndefined();
  });

  test('the enum resolver is never reached for this field', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { body, log } = await runAsk({ session, writes, input: ocpdAsk(), userText: 'BS 3871' });
    expect(body.match_status).not.toBe('enum_resolved');
    const events = log.info.mock.calls.map((c) => c[0]);
    expect(events).not.toContain('stage6.ask_user_enum_auto_resolved');
    expect(events).not.toContain('stage6.ask_user_enum_rejected');
    expect(events).toContain('stage6.ask_user_ocpd_standard_resolved');
    expect(typeof answerResolver.resolveOcpdStandardAnswer).toBe('function');
  });
});

describe('acceptance 4b — a zero-target ask is never registered (ask_requires_target)', () => {
  test('no circuit, no circuit set, no bulk lineage → refused before registration, nothing emitted', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const send = jest.fn();
    const { env, body } = await runAsk({
      session,
      writes,
      input: ocpdAsk({ context_circuit: null }),
      send,
    });
    expect(env.is_error).toBe(true);
    expect(body).toMatchObject({
      answered: false,
      reason: 'validation_error',
      code: 'ask_requires_target',
    });
    expect(body.hint).toMatch(/context_circuit/);
    // Not journaled (a journaled ask would cover a pending rejection notice),
    // not sent to the client, and no refusal of CS's own staged.
    expect(writes.askRegistrations ?? []).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(writes.mandatoryNotices).toHaveLength(0);
  });

  test('a non-OCPD zero-target ask is unaffected', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const { body } = await runAsk({
      session,
      writes,
      input: ocpdAsk({ context_field: 'rcd_bs_en', context_circuit: null }),
      userText: 'BS EN 61008',
    });
    expect(body.code).not.toBe('ask_requires_target');
  });
});

describe('acceptance 4b — a BULK lineage: the ask’s scope is preserved end to end', () => {
  /** A rejected bulk write, then the model's one ask echoing its rejection_ref. */
  async function rejectedBulkThenAsk(bulk, userText) {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const rejected = await modelWrite(session, writes, 'set_field_for_all_circuits', {
      field: 'ocpd_bs_en',
      value: 'There is no RCBO',
      confidence: 0.9,
      source_turn_id: 't1',
      ...bulk,
    });
    expect(rejected.body.error.code).toBe('ocpd_standard_shape');
    const ref = rejected.body.rejection_ref;
    const asked = await runAsk({
      session,
      writes,
      input: ocpdAsk({ context_circuit: null, rejection_ref: ref }),
      userText,
    });
    return { session, writes, ...asked };
  }

  test('scope: rcd_protected_only → only the RCD-protected circuits are written', async () => {
    const { session, body } = await rejectedBulkThenAsk({ scope: 'rcd_protected_only' }, 'BS 3871');
    expect(body.match_status).toBe('ocpd_standard_resolved');
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({ tool: 'set_field_for_all_circuits', value: 'BS 3871', ok: true }),
    ]);
    expect(session.stateSnapshot.circuits[2].ocpd_bs_en).toBe('BS 3871');
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS 3871');
    for (const n of [1, 4, 5]) expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBeUndefined();
  });

  test('scope: all, exclude_circuits: [4] → circuit 4 untouched', async () => {
    const { session, body } = await rejectedBulkThenAsk(
      { scope: 'all', exclude_circuits: [4] },
      'BS 3871'
    );
    expect(body.match_status).toBe('ocpd_standard_resolved');
    for (const n of [1, 2, 3, 5])
      expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBe('BS 3871');
    expect(session.stateSnapshot.circuits[4].ocpd_bs_en).toBeUndefined();
  });

  test('an unreadable bulk answer stages the BULK-keyed refusal and writes nothing', async () => {
    const { session, writes, body } = await rejectedBulkThenAsk(
      { scope: 'rcd_protected_only' },
      'BS 123456'
    );
    expect(body.match_status).toBe('ocpd_standard_rejected_after_ask');
    expect(bulkNotices(writes, 'enum_rejected_after_ask_bulk')).toHaveLength(1);
    for (let n = 1; n <= 5; n += 1) {
      expect(session.stateSnapshot.circuits[n].ocpd_bs_en).toBeUndefined();
    }
  });

  test('the hook copies scope / spare_policy / exclude_circuits byte-equal from bulkInput', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const original = WRITE_DISPATCHERS.set_field_for_all_circuits;
    const captured = [];
    WRITE_DISPATCHERS.set_field_for_all_circuits = async (call) => {
      captured.push(call.input);
      return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
    };
    try {
      const hook = createAutoResolveWriteHook(session, logger(), 'turn-1', writes);
      const bulkInput = {
        scope: 'rcd_protected_only',
        spare_policy: 'include',
        exclude_circuits: [4, 5],
        board_id: null,
      };
      await hook(
        {
          tool: 'set_field_for_all_circuits',
          field: 'ocpd_bs_en',
          circuit: null,
          value: 'BS 3871',
          confidence: 0.95,
          source_turn_id: 'turn-1',
          bulkInput,
        },
        { toolCallId: 'toolu_ask' }
      );
    } finally {
      WRITE_DISPATCHERS.set_field_for_all_circuits = original;
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      scope: 'rcd_protected_only',
      spare_policy: 'include',
      exclude_circuits: [4, 5],
    });
    // An argument the original call omitted stays omitted (never `null`).
    expect(Object.prototype.hasOwnProperty.call(captured[0], 'board_id')).toBe(false);
  });
});
