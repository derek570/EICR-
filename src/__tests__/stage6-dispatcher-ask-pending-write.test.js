// Tests for the 2026-04-27 ask_user pending_write resolution path
// (bug-1B fix). These cover the new server-side state machine:
//
//   ask_user with pending_write attached
//     → user replies
//     → resolver runs against availableCircuits + reply
//     → confident match: server auto-emits the write, returns
//       { auto_resolved: true, resolved_writes: [...] }
//     → ambiguous: server escalates with full context echoed back
//     → cancel: server tells Sonnet to drop the buffered write
//
// Legacy ask paths (no pending_write OR no autoResolveWrite hook) MUST
// continue to return the pre-2026-04-27 body shape — these are also covered
// to lock the back-compat invariant.

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const validInput = (overrides = {}) => ({
  question: 'Which circuit is the 4 points for?',
  reason: 'missing_context',
  context_field: 'number_of_points',
  context_circuit: null,
  expected_answer_shape: 'circuit_ref',
  ...overrides,
});

const validPendingWrite = (overrides = {}) => ({
  tool: 'record_reading',
  field: 'number_of_points',
  value: '4',
  confidence: 0.95,
  source_turn_id: 't42',
  ...overrides,
});

const buildSession = (circuits = []) => {
  const circuitMap = {};
  circuits.forEach((c) => {
    circuitMap[c.circuit_ref] = { designation: c.circuit_designation };
  });
  return {
    sessionId: 'sess-test',
    stateSnapshot: { circuits: circuitMap },
  };
};

const noopLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

describe('createAskDispatcher — pending_write resolution (bug-1B fix)', () => {
  test('confident designation match → server auto-emits the write', async () => {
    const session = buildSession([
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Cooker' },
    ]);
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true, body: { ok: true } });

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_aaa',
        name: 'ask_user',
        input: validInput({ pending_write: validPendingWrite() }),
      },
      {}
    );

    // Simulate the user's reply arriving via the pendingAsks resolve path.
    // The dispatcher's await unblocks once we resolve the registered entry.
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_aaa', { answered: true, user_text: 'the cooker circuit' });
    const env = await callPromise;

    expect(env.is_error).toBe(false);
    const body = JSON.parse(env.content);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: true,
      match_status: 'auto_resolved',
      untrusted_user_text: 'the cooker circuit',
    });
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({
        tool: 'record_reading',
        field: 'number_of_points',
        circuit: 2,
        value: '4',
        ok: true,
      }),
    ]);
    expect(autoResolveWrite).toHaveBeenCalledTimes(1);
    const [write, ctx] = autoResolveWrite.mock.calls[0];
    expect(write).toMatchObject({
      tool: 'record_reading',
      field: 'number_of_points',
      circuit: 2,
      value: '4',
      confidence: 0.95,
      source_turn_id: 't42',
    });
    expect(ctx.toolCallId).toBe('toolu_aaa');
  });

  test('ambiguous answer → escalate with full context echoed', async () => {
    const session = buildSession([
      { circuit_ref: 1, circuit_designation: 'Kitchen sockets' },
      { circuit_ref: 2, circuit_designation: 'Kitchen lighting' },
    ]);
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const pw = validPendingWrite();
    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_bbb',
        name: 'ask_user',
        input: validInput({ pending_write: pw }),
      },
      {}
    );

    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_bbb', { answered: true, user_text: 'the kitchen' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: false,
      match_status: 'escalated',
      untrusted_user_text: 'the kitchen',
      pending_write: pw,
    });
    expect(body.parsed_hint).toMatch(/^ambiguous_designation_match:1,2$/);
    expect(body.available_circuits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ circuit_ref: 1, circuit_designation: 'Kitchen sockets' }),
        expect.objectContaining({ circuit_ref: 2, circuit_designation: 'Kitchen lighting' }),
      ])
    );
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('cancel reply → server reports cancelled, no write dispatched', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_ccc',
        name: 'ask_user',
        input: validInput({ pending_write: validPendingWrite() }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_ccc', { answered: true, user_text: 'never mind' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toMatchObject({
      answered: true,
      auto_resolved: false,
      match_status: 'cancelled',
      untrusted_user_text: 'never mind',
    });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('"all circuits" broadcast → one write per circuit', async () => {
    const session = buildSession([
      { circuit_ref: 1, circuit_designation: 'Lighting' },
      { circuit_ref: 2, circuit_designation: 'Sockets' },
      { circuit_ref: 3, circuit_designation: 'Cooker' },
    ]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });

    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_ddd',
        name: 'ask_user',
        input: validInput({
          pending_write: validPendingWrite({ field: 'rcd_time_ms', value: 'N/A' }),
        }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_ddd', { answered: true, user_text: 'all circuits' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('auto_resolved');
    expect(body.resolved_writes).toHaveLength(3);
    expect(body.resolved_writes.map((w) => w.circuit).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    for (const w of body.resolved_writes) {
      expect(w.field).toBe('rcd_time_ms');
      expect(w.value).toBe('N/A');
    }
    expect(autoResolveWrite).toHaveBeenCalledTimes(3);
  });

  test('no pending_write attached → legacy body shape preserved', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();

    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_eee',
        name: 'ask_user',
        input: validInput(), // no pending_write
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_eee', { answered: true, user_text: 'cooker' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toEqual({ answered: true, untrusted_user_text: 'cooker' });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('no autoResolveWrite hook → legacy body shape (back-compat)', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();

    // Create dispatcher WITHOUT the autoResolveWrite opt — mirrors a legacy
    // call site that hasn't migrated yet.
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null);

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_fff',
        name: 'ask_user',
        input: validInput({ pending_write: validPendingWrite() }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_fff', { answered: true, user_text: 'cooker' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toEqual({ answered: true, untrusted_user_text: 'cooker' });
  });

  test('non-answered outcomes do not invoke resolution', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();

    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_ggg',
        name: 'ask_user',
        input: validInput({ pending_write: validPendingWrite() }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_ggg', { answered: false, reason: 'user_moved_on' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toEqual({ answered: false, reason: 'user_moved_on' });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('autoResolveWrite throws → escalation with error captured per-write', async () => {
    const session = buildSession([{ circuit_ref: 2, circuit_designation: 'Cooker' }]);
    const logger = noopLogger();
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn().mockRejectedValue(new Error('write_failed_kapow'));

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_hhh',
        name: 'ask_user',
        input: validInput({ pending_write: validPendingWrite() }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_hhh', { answered: true, user_text: 'cooker' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body.match_status).toBe('auto_resolved');
    expect(body.resolved_writes[0]).toMatchObject({
      ok: false,
      error: 'write_failed_kapow',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'stage6.ask_user_auto_resolve_dispatch_failed',
      expect.any(Object)
    );
  });
});

describe('createAskDispatcher — pending_write validation', () => {
  test('malformed pending_write rejected at validation', async () => {
    const session = buildSession([]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const env = await dispatcher(
      {
        tool_call_id: 'toolu_iii',
        name: 'ask_user',
        input: validInput({
          pending_write: { tool: 'record_reading', field: 'rcd_time_ms' }, // missing required fields
        }),
      },
      {}
    );
    expect(env.is_error).toBe(true);
    const body = JSON.parse(env.content);
    expect(body.code).toMatch(/^invalid_pending_write/);
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('null pending_write is accepted (treated as omitted)', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-1', pendingAsks, null, {
      autoResolveWrite,
    });

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_jjj',
        name: 'ask_user',
        input: validInput({ pending_write: null }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    pendingAsks.resolve('toolu_jjj', { answered: true, user_text: 'cooker' });
    const env = await callPromise;

    const body = JSON.parse(env.content);
    expect(body).toEqual({ answered: true, untrusted_user_text: 'cooker' });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });
});
