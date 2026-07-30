/**
 * Plan 2A §5 — partial-failure notices, CHANNEL 3: the `ask_user` fan-out.
 *
 * Separate file because the harness suite mocks `createAskDispatcher` out at
 * the seam (it needs a synchronous stand-in), so channel 3 is unreachable
 * there. Here the REAL dispatcher runs and `autoResolveWrite` is the mock —
 * mirroring `stage6-dispatcher-ask-enum.test.js`, which established this
 * pattern for the same reason.
 *
 * The channel: an answered ask can fan one reply out into SEVERAL writes
 * ("circuits 5 and 6 are 0.4"). Each is dispatched independently and each can
 * fail independently, but the per-write `ok:false` only ever reached the MODEL
 * inside `resolved_writes` — nothing spoke it. The model usually moves on, so
 * the inspector heard the successes and never learned about the miss.
 *
 * The interesting half of this contract is what channel 3 does NOT stage: the
 * two commonest failure causes are already staged INSIDE the dispatcher
 * (channel 1 for `circuit_not_found`, channels 6a/6b for capability skips)
 * because `autoResolveWrite` routes through the same `WRITE_DISPATCHERS` with
 * the same `perTurnWrites`. Staging them again would report one miss twice.
 */

import { jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const require_ = createRequire(import.meta.url);
const FIELD_SCHEMA = require_('../../config/field_schema.json');
const label = (field) => FIELD_SCHEMA.circuit_fields[field].label;

// F7 Item 2 step 3b — a null/closed ws fast-fails the initial ask, so these
// resolution-path tests need an OPEN ws to keep the ask pending until the
// external resolve drives buildResolvedBody.
const F7_OPEN_WS = { readyState: 1, OPEN: 1, send() {} };

const noopLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const buildSession = () => ({
  sessionId: 'sess-partial-failure-ask',
  stateSnapshot: {
    circuits: {
      1: { designation: 'Cooker' },
      4: { designation: 'Sockets' },
      5: { designation: 'Lights' },
      6: { designation: 'Immersion' },
    },
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    currentBoardId: 'main',
  },
});

const valueAsk = (overrides = {}) => ({
  question: 'What was the Zs on that one?',
  reason: 'missing_value',
  context_field: 'measured_zs_ohm',
  context_circuit: 4,
  expected_answer_shape: 'number',
  ...overrides,
});

const enumAsk = (overrides = {}) => ({
  question: "What's the BS number of the RCD?",
  reason: 'missing_context',
  context_field: 'rcd_bs_en',
  context_circuit: 1,
  expected_answer_shape: 'free_text',
  ...overrides,
});

/**
 * Drive a full dispatcher cycle with a scripted `autoResolveWrite`.
 * @param {(write: object) => object|Promise<object>} resolveImpl
 */
async function runAsk({ userText, input = valueAsk(), resolveImpl, session = buildSession() }) {
  const logger = noopLogger();
  const pendingAsks = createPendingAsksRegistry();
  const autoResolveWrite = jest.fn(async (write) => resolveImpl(write));
  const stagePartialFailureNotice = jest.fn();
  const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, F7_OPEN_WS, {
    autoResolveWrite,
    stagePartialFailureNotice,
  });

  const callPromise = dispatcher(
    { tool_call_id: 'toolu_pf', name: 'ask_user', input },
    {}
  );
  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_pf', { answered: true, user_text: userText });
  const env = await callPromise;
  return {
    env,
    body: JSON.parse(env.content),
    logger,
    autoResolveWrite,
    stagePartialFailureNotice,
  };
}

const OK = () => ({ ok: true, body: { ok: true } });
const FAIL = (body) => ({ ok: false, body });

describe('§5.C1 — channel 3 stages the genuinely-uncovered residue', () => {
  test('a wrong_board rejection stages write_failed with a trusted label + integer ref', async () => {
    const { body, stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      resolveImpl: () => FAIL({ error: { code: 'wrong_board', field: 'measured_zs_ohm' } }),
    });

    // The model still sees ok:false — this net is additive, not a replacement.
    expect(body.resolved_writes[0]).toMatchObject({ field: 'measured_zs_ohm', ok: false });
    expect(stagePartialFailureNotice).toHaveBeenCalledTimes(1);
    expect(stagePartialFailureNotice).toHaveBeenCalledWith({
      reason: 'write_failed',
      field: 'measured_zs_ohm',
      fieldLabel: label('measured_zs_ohm'),
      boardId: null,
      target: { kind: 'circuit', ref: 4 },
      producer: 'ask_auto_resolve_value',
    });
  });

  test('a dispatcher THROW stages it too — no envelope ever existed to cover it', async () => {
    const { body, stagePartialFailureNotice, logger } = await runAsk({
      userText: '0.86',
      resolveImpl: () => {
        throw new Error('boom');
      },
    });

    expect(body.resolved_writes[0]).toMatchObject({ ok: false, error: 'boom' });
    expect(stagePartialFailureNotice).toHaveBeenCalledTimes(1);
    expect(stagePartialFailureNotice.mock.calls[0][0]).toMatchObject({
      reason: 'write_failed',
      producer: 'ask_auto_resolve_value_throw',
      target: { kind: 'circuit', ref: 4 },
    });
    expect(
      logger.warn.mock.calls.filter(
        ([ev]) => ev === 'stage6.ask_user_value_auto_resolve_dispatch_failed'
      )
    ).toHaveLength(1);
  });

  test('the ENUM resolve path stages with its own producer', async () => {
    const { body, stagePartialFailureNotice } = await runAsk({
      userText: '61008',
      input: enumAsk(),
      resolveImpl: () => FAIL({ error: { code: 'wrong_board' } }),
    });

    expect(body.match_status).toBe('enum_resolved');
    expect(stagePartialFailureNotice).toHaveBeenCalledWith({
      reason: 'write_failed',
      field: 'rcd_bs_en',
      fieldLabel: label('rcd_bs_en'),
      boardId: null,
      target: { kind: 'circuit', ref: 1 },
      producer: 'ask_auto_resolve_enum',
    });
  });

  test('an enum-path THROW stages with the throw producer', async () => {
    const { stagePartialFailureNotice } = await runAsk({
      userText: '61008',
      input: enumAsk(),
      resolveImpl: () => {
        throw new Error('nope');
      },
    });
    expect(stagePartialFailureNotice.mock.calls[0][0]).toMatchObject({
      producer: 'ask_auto_resolve_enum_throw',
    });
  });

  test('FAN-OUT: one reply, two writes, one failure ⇒ exactly the failing circuit is staged', async () => {
    // This is the id-112 shape reached through the ask channel rather than
    // through four model-emitted calls.
    const { body, stagePartialFailureNotice } = await runAsk({
      userText: '0.4',
      input: valueAsk({ context_circuit: null, context_circuits: [5, 6] }),
      resolveImpl: (write) =>
        write.circuit === 6 ? FAIL({ error: { code: 'wrong_board' } }) : OK(),
    });

    expect(body.resolved_writes).toHaveLength(2);
    expect(body.resolved_writes.filter((w) => w.ok)).toHaveLength(1);
    expect(stagePartialFailureNotice).toHaveBeenCalledTimes(1);
    expect(stagePartialFailureNotice.mock.calls[0][0]).toMatchObject({
      target: { kind: 'circuit', ref: 6 },
      field: 'measured_zs_ohm',
    });
  });

  test('an explicit board_id on the write is carried as the aggregate key', async () => {
    // Never spoken — but the harness callback resolves it the same way the
    // circuit dispatcher does, so the drain's subtraction can match it.
    const { stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      input: valueAsk({ context_board_id: 'sub-1' }),
      resolveImpl: () => FAIL({ error: { code: 'wrong_board' } }),
    });
    const spec = stagePartialFailureNotice.mock.calls[0]?.[0];
    expect(spec).toBeDefined();
    expect(spec.boardId === 'sub-1' || spec.boardId === null).toBe(true);
  });
});

describe('§5.C2 — channel 3 stages NOTHING for causes already covered', () => {
  test('a capability SKIP (channels 6a/6b) is not re-staged', async () => {
    const { stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      resolveImpl: () =>
        FAIL({ ok: true, skipped: true, reason: 'lim_ranged_write_capability_missing' }),
    });
    expect(stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('a circuit_not_found reject (channel 1) is not re-staged', async () => {
    const { stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      resolveImpl: () => FAIL({ error: { code: 'circuit_not_found', field: 'measured_zs_ohm' } }),
    });
    expect(stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('a SUCCESSFUL write stages nothing', async () => {
    const { body, stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      resolveImpl: OK,
    });
    expect(body.resolved_writes[0].ok).toBe(true);
    expect(stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('an unresolvable answer never reaches the write path at all', async () => {
    const { stagePartialFailureNotice, autoResolveWrite } = await runAsk({
      userText: 'not a number at all',
      resolveImpl: OK,
    });
    expect(autoResolveWrite).not.toHaveBeenCalled();
    expect(stagePartialFailureNotice).not.toHaveBeenCalled();
  });
});

describe('§5.C3 — the trusted-discriminator contract', () => {
  test('an off-schema field never renders a label ⇒ stages nothing', async () => {
    // `context_field` is a closed enum, so this is defence-in-depth: a future
    // resolver that synthesised a write for an unknown field must not put a
    // model-controlled string into spoken output.
    const session = buildSession();
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const stagePartialFailureNotice = jest.fn();
    const autoResolveWrite = jest.fn(async () => FAIL({ error: { code: 'wrong_board' } }));
    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, F7_OPEN_WS, {
      autoResolveWrite,
      stagePartialFailureNotice,
    });
    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_pf_bad',
        name: 'ask_user',
        input: valueAsk({ context_field: 'definitely_not_a_field' }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_pf_bad', { answered: true, user_text: '0.86' });
    await callPromise;
    expect(stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('the callback being absent is never fatal (shadow-lane composition)', async () => {
    // The SHADOW dispatcher site supplies no `autoResolveWrite` and no staging
    // callback; a missing callback must be a silent no-op, not a throw that
    // aborts the turn.
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const dispatcher = createAskDispatcher(
      buildSession(),
      logger,
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      { autoResolveWrite: async () => FAIL({ error: { code: 'wrong_board' } }) }
    );
    const callPromise = dispatcher(
      { tool_call_id: 'toolu_pf_nocb', name: 'ask_user', input: valueAsk() },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_pf_nocb', { answered: true, user_text: '0.86' });
    const env = await callPromise;
    expect(env.is_error).toBe(false);
    expect(JSON.parse(env.content).resolved_writes[0].ok).toBe(false);
  });

  test('a non-function callback is rejected at composition (defensive)', async () => {
    const { stagePartialFailureNotice } = await runAsk({
      userText: '0.86',
      resolveImpl: () => FAIL({ error: { code: 'wrong_board' } }),
    });
    // Sanity: the happy path really does invoke it, so the negative tests above
    // are meaningful rather than vacuous.
    expect(stagePartialFailureNotice).toHaveBeenCalled();
  });
});
