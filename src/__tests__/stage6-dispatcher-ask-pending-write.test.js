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
import { ExtractionCancelledError } from '../extraction/stage6-control-flow-errors.js';
import { createAutoResolveWriteHook } from '../extraction/stage6-dispatchers.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
// F7 Item 2 step 3b — a null/closed ws now fast-fails the initial ask, so
// these resolution-logic tests use an OPEN ws to keep the ask pending until
// the external resolve drives buildResolvedBody.
const F7_OPEN_WS = { readyState: 1, OPEN: 1, send() {} };
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function capturingWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
  };
}

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
    circuitMap[c.circuit_ref] = { circuit_designation: c.circuit_designation };
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

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, F7_OPEN_WS, {
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

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, F7_OPEN_WS, {
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
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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

    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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

    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS
    );

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

    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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

    const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, F7_OPEN_WS, {
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
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

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

  // P2-D — cross-check pending_write.field against pending_write.tool's enum.
  // Pre-2026-04-27 the validator only checked individual field shapes; a Sonnet
  // contract bug like {tool: 'record_reading', field: 'earth_loop_impedance_ze'}
  // (board field on circuit-only tool) would pass validation, dispatch, and
  // fail the synthetic write inside the resolver. By then the user's
  // clarification turn was already spent and the buffered value dropped on
  // the floor. The validator now rejects the malformed pw before the round trip.
  test('pending_write field+tool mismatch (board field on record_reading) is rejected', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

    const env = await dispatcher(
      {
        tool_call_id: 'toolu_p2d_a',
        name: 'ask_user',
        input: validInput({
          pending_write: validPendingWrite({
            tool: 'record_reading',
            field: 'earth_loop_impedance_ze', // board field, wrong for record_reading
          }),
        }),
      },
      {}
    );
    expect(env.is_error).toBe(true);
    const body = JSON.parse(env.content);
    expect(body.code).toBe('invalid_pending_write_field_for_tool');
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('pending_write field+tool mismatch (circuit field on record_board_reading) is rejected', async () => {
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

    const env = await dispatcher(
      {
        tool_call_id: 'toolu_p2d_b',
        name: 'ask_user',
        input: validInput({
          pending_write: validPendingWrite({
            tool: 'record_board_reading',
            field: 'measured_zs_ohm', // per-circuit field, wrong for board tool
          }),
        }),
      },
      {}
    );
    expect(env.is_error).toBe(true);
    const body = JSON.parse(env.content);
    expect(body.code).toBe('invalid_pending_write_field_for_tool');
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('pending_write field+tool match (record_board_reading + board field) passes validation', async () => {
    // Sanity check — the cross-check rejects mismatches but should still
    // accept legitimate pairings.
    const session = buildSession([{ circuit_ref: 1, circuit_designation: 'Cooker' }]);
    const pendingAsks = createPendingAsksRegistry();
    const autoResolveWrite = jest.fn();
    const dispatcher = createAskDispatcher(
      session,
      noopLogger(),
      'turn-1',
      pendingAsks,
      F7_OPEN_WS,
      {
        autoResolveWrite,
      }
    );

    const callPromise = dispatcher(
      {
        tool_call_id: 'toolu_p2d_c',
        name: 'ask_user',
        input: validInput({
          pending_write: validPendingWrite({
            tool: 'record_board_reading',
            field: 'earth_loop_impedance_ze',
          }),
        }),
      },
      {}
    );
    await new Promise((r) => setImmediate(r));
    // Resolver runs; without a real circuit match the user reply escalates,
    // but VALIDATION must have passed (no is_error envelope).
    pendingAsks.resolve('toolu_p2d_c', { answered: true, user_text: 'unrelated text' });
    const env = await callPromise;
    expect(env.is_error).toBeFalsy();
  });
});

describe('createAskDispatcher — PLAN-2B multi-description execution', () => {
  const multiCircuits = [
    { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
    { circuit_ref: 2, circuit_designation: 'First floor lighting' },
    { circuit_ref: 3, circuit_designation: 'Smoke Alarm' },
    { circuit_ref: 4, circuit_designation: 'Upstairs Lights' },
  ];

  function startMultiDispatcher({
    autoResolveWrite = jest.fn().mockResolvedValue({ ok: true }),
    stagePartialFailureNotice = jest.fn(),
    onAskUserStarted = jest.fn(),
    onAskRegistered = jest.fn(),
    ws = capturingWs(),
    generationId = 'gen-multi',
    session = buildSession(multiCircuits),
    inputOverrides = {},
    pendingWriteOverrides = {},
    responseEpochRef = null,
    signal = null,
  } = {}) {
    const pendingAsks = createPendingAsksRegistry();
    const dispatcher = createAskDispatcher(session, noopLogger(), 'turn-multi', pendingAsks, ws, {
      autoResolveWrite,
      stagePartialFailureNotice,
      onAskUserStarted,
      onAskRegistered,
      generationId,
      responseEpochRef,
      signal,
    });
    const promise = dispatcher(
      {
        tool_call_id: 'toolu_multi',
        name: 'ask_user',
        input: validInput({
          ...inputOverrides,
          pending_write: validPendingWrite(pendingWriteOverrides),
        }),
      },
      {}
    );
    return {
      promise,
      session,
      pendingAsks,
      ws,
      autoResolveWrite,
      stagePartialFailureNotice,
      onAskUserStarted,
      onAskRegistered,
      responseEpochRef,
    };
  }

  test('verbatim id-104 answer dispatches all three writes', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: "I said it's for 2 lighting circuits and the smoke alarm",
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({
      auto_resolved: true,
      match_status: 'full',
      unresolved: [],
    });
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(3);
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalled();
    expect(run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))).toEqual(
      []
    );
  });

  test('verbatim id-104 crosses the real write hook and bundles one grouped read-back', async () => {
    const session = buildSession(multiCircuits.slice(0, 3));
    const perTurnWrites = createPerTurnWrites();
    const autoResolveWrite = createAutoResolveWriteHook(
      session,
      noopLogger(),
      'turn-multi',
      perTurnWrites
    );
    const run = startMultiDispatcher({ session, autoResolveWrite });

    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: "I said it's for 2 lighting circuits and the smoke alarm",
    });
    const body = JSON.parse((await run.promise).content);
    expect(body.match_status).toBe('full');

    const result = bundleToolCallsIntoResult(
      perTurnWrites,
      { questions: [] },
      {
        confirmationsEnabled: true,
        totalCircuitsInJob: 3,
        turnId: 'turn-multi',
      }
    );
    const applied = (result.extracted_readings ?? []).filter(
      (reading) => reading.field === 'number_of_points'
    );
    expect(applied.map((reading) => reading.circuit).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    const spoken = (result.confirmations ?? []).filter(
      (confirmation) => confirmation.field === 'number_of_points'
    );
    expect(spoken).toHaveLength(1);
    expect([...spoken[0].circuits].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(spoken.filter((confirmation) => Number.isInteger(confirmation.circuit))).toHaveLength(0);
  });

  test('partial no-match stages one ordinal notice only after a sibling write succeeds', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'the attic circuit and the smoke alarm',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes).toEqual([expect.objectContaining({ circuit: 3, ok: true })]);
    expect(run.stagePartialFailureNotice).toHaveBeenCalledTimes(1);
    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'designation_no_match',
        target: { kind: 'ordinal', ordinal: 1 },
        requiresSurvivingSibling: true,
      })
    );
  });

  test('an explicit absent ref is noticed by trusted segment ordinal', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'circuit 99 and the smoke alarm',
    });
    await run.promise;

    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'designation_no_match',
        target: { kind: 'ordinal', ordinal: 1 },
      })
    );
  });

  test('mixed absent-ref and unmatched-description targets are both staged', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'circuit 99, the attic circuit, and the smoke alarm',
    });
    await run.promise;

    expect(run.stagePartialFailureNotice).toHaveBeenCalledTimes(2);
    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'ordinal', ordinal: 1 } })
    );
    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'ordinal', ordinal: 2 } })
    );
  });

  test('all-unmatched escalates with zero writes, notices, or brokered asks', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'the attic circuit and the garage circuit',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({
      auto_resolved: false,
      match_status: 'all_unmatched',
      parsed_hint: 'multi_description_all_unmatched',
    });
    expect(run.autoResolveWrite).not.toHaveBeenCalled();
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalled();
    expect(run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))).toEqual(
      []
    );
  });

  test('fuzzy disposition emits one registered mdr-* ask and dispatches its answer', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });
    await tick();

    const frames = run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'ask_user_started',
      expected_answer_shape: 'free_text',
      context_field: 'number_of_points',
    });
    expect(frames[0].question).toMatch(/circuit 4/i);
    expect(frames[0].question).not.toMatch(/upstars/i);
    const mdrId = frames[0].tool_call_id;
    expect([...run.pendingAsks.entries()].some(([id]) => id === mdrId)).toBe(true);
    expect(run.onAskRegistered).toHaveBeenCalledWith(mdrId);
    expect(run.onAskUserStarted).toHaveBeenCalledWith({
      toolCallId: mdrId,
      source: 'multi_description',
    });

    run.pendingAsks.resolve(mdrId, { answered: true, user_text: 'circuit 4' });
    const body = JSON.parse((await run.promise).content);
    expect(body.match_status).toBe('full');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([3, 4]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['response_utterance_id', { response_utterance_id: 'u-mdr-transcript' }, 'u-mdr-transcript'],
    ['utterance_id', { utterance_id: 'u-mdr-direct' }, 'u-mdr-direct'],
  ])(
    'an mdr registry outcome carrying %s accepts the list and advances its epoch',
    async (_outcomeField, outcomePatch, expectedEpoch) => {
      const responseEpochRef = { current: 'u-opening' };
      const run = startMultiDispatcher({ responseEpochRef });
      await tick();
      run.pendingAsks.resolve('toolu_multi', {
        answered: true,
        user_text: 'upstars lights and smke alarm',
      });
      await tick();
      const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

      run.pendingAsks.resolve(mdrFrame.tool_call_id, {
        answered: true,
        user_text: 'circuits 1 and 2',
        ...outcomePatch,
      });
      const body = JSON.parse((await run.promise).content);

      expect(body).toMatchObject({
        match_status: 'full',
        unresolved: [],
      });
      expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2]);
      expect(run.autoResolveWrite).toHaveBeenCalledTimes(2);
      expect(
        run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))
      ).toHaveLength(1);
      expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
      expect(responseEpochRef.current).toBe(expectedEpoch);
    }
  );

  test('overlapping candidate capacities do not claim full from one ambiguous ref allocation', async () => {
    const run = startMultiDispatcher({
      session: buildSession([
        { circuit_ref: 1, circuit_designation: 'Ground floor lighting' },
        { circuit_ref: 2, circuit_designation: 'Kitchen lighting' },
        { circuit_ref: 5, circuit_designation: 'Kitchen sockets' },
      ]),
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '3 lighting circuits and kitchen',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1 and 2',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2]);
    expect(body.unresolved.filter((entry) => entry.disposition === 'ask')).toEqual([
      expect.objectContaining({
        segment_ordinal: 1,
        required_count: 3,
        reason: 'quantifier_count_mismatch',
        candidates: [1, 2],
      }),
      expect.objectContaining({
        segment_ordinal: 2,
        required_count: 1,
        reason: 'ambiguous_match',
        candidates: [2, 5],
      }),
    ]);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/couldn't place every circuit/i),
      }),
    ]);
  });

  test('two equally valid overlapping assignments keep both source segments unresolved', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'lighting and lighting',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1 and 2',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2]);
    expect(body.unresolved.filter((entry) => entry.disposition === 'ask')).toEqual([
      expect.objectContaining({ segment_ordinal: 1, required_count: 1, candidates: [1, 2] }),
      expect.objectContaining({ segment_ordinal: 2, required_count: 1, candidates: [1, 2] }),
    ]);
    expect(run.session.pendingVoicePrompts).toHaveLength(1);
  });

  test('a uniquely assigned reply that fills the requested capacity resolves the entry', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '3 lighting circuits and please',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1, 2 and 3',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({ match_status: 'full', unresolved: [] });
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('a successful collapsed board write reconciles its validated multi-ref answer', async () => {
    const run = startMultiDispatcher({
      inputOverrides: { context_field: 'earth_loop_impedance_ze' },
      pendingWriteOverrides: {
        tool: 'record_board_reading',
        field: 'earth_loop_impedance_ze',
      },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '3 lighting circuits and please',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1, 2 and 3',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({ match_status: 'full', unresolved: [] });
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({
        tool: 'record_board_reading',
        circuit: 0,
        ok: true,
      }),
    ]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(1);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('an exact-designation board follow-up reuses its successful logical board slot', async () => {
    const run = startMultiDispatcher({
      inputOverrides: { context_field: 'earth_loop_impedance_ze' },
      pendingWriteOverrides: {
        tool: 'record_board_reading',
        field: 'earth_loop_impedance_ze',
      },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'Upstairs Lights',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({ match_status: 'full', unresolved: [] });
    expect(body.resolved_writes).toEqual([
      expect.objectContaining({
        tool: 'record_board_reading',
        circuit: 0,
        ok: true,
      }),
    ]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(1);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('validated board refs do not reconcile when the collapsed board write fails', async () => {
    const run = startMultiDispatcher({
      autoResolveWrite: jest.fn().mockResolvedValue({ ok: false, code: 'write_failed' }),
      inputOverrides: { context_field: 'earth_loop_impedance_ze' },
      pendingWriteOverrides: {
        tool: 'record_board_reading',
        field: 'earth_loop_impedance_ze',
      },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '3 lighting circuits and please',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1, 2 and 3',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.unresolved.filter((entry) => entry.disposition === 'ask')).toEqual([
      expect.objectContaining({ segment_ordinal: 1, required_count: 3 }),
    ]);
    expect(run.session.pendingVoicePrompts).toHaveLength(1);
  });

  test('a dedupe-skipped selected singleton counts its already-landed successful slot', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '2 lighting circuits and ground floor lightng',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuit 1',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body).toMatchObject({
      match_status: 'full',
      unresolved: [],
    });
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(2);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('one grouped answer cannot silently close a second unresolved description', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and smke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuit 3',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes).toEqual([expect.objectContaining({ circuit: 3 })]);
    expect(body.unresolved.filter((entry) => entry.disposition === 'ask')).toEqual([
      expect.objectContaining({ identity: 4, candidates: [4] }),
    ]);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/couldn't place every circuit/i),
      }),
    ]);
    expect(run.session.pendingVoicePrompts[0].text).toMatch(/say the reading/i);
  });

  test('multiple writes for one candidate group cannot consume an unrelated unresolved span', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '3 lighting circuits and upstars lights',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuits 1 and 2',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2]);
    expect(body.unresolved.filter((entry) => entry.disposition === 'ask')).toEqual([
      expect.objectContaining({
        segment_ordinal: 1,
        required_count: 3,
        candidates: [1, 2],
        reason: 'quantifier_count_mismatch',
      }),
      expect.objectContaining({ identity: 4, candidates: [4], reason: 'fuzzy_match' }),
    ]);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/couldn't place every circuit/i),
      }),
    ]);
  });

  test('cancellation after a sibling write queues a generation-owned unresolved terminal', async () => {
    const ac = new AbortController();
    const autoResolveWrite = jest.fn().mockImplementation(async () => {
      ac.abort(new ExtractionCancelledError('cancel-after-sibling'));
      return { ok: true };
    });
    const run = startMultiDispatcher({ autoResolveWrite, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(1);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/recorded the matched circuits/i),
      }),
    ]);
    expect(run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))).toEqual(
      []
    );
  });

  test('fatal cancellation between fan-out writes is not mislabeled as write_failed', async () => {
    const ac = new AbortController();
    const autoResolveWrite = jest.fn().mockImplementation(async () => {
      ac.abort(new ExtractionCancelledError('cancel-between-writes'));
      return { ok: true };
    });
    const run = startMultiDispatcher({ autoResolveWrite, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '2 lighting circuits and the smoke alarm',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(1);
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'write_failed' })
    );
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/remaining circuit descriptions/i),
      }),
    ]);
  });

  test('cancellation after the final successful fan-out write rethrows without a false terminal', async () => {
    const ac = new AbortController();
    let writeCount = 0;
    const autoResolveWrite = jest.fn().mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 3) {
        ac.abort(new ExtractionCancelledError('cancel-after-final-write'));
      }
      return { ok: true };
    });
    const run = startMultiDispatcher({ autoResolveWrite, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '2 lighting circuits and the smoke alarm',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(3);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('cancellation immediately before mdr emission keeps the partial result audible', async () => {
    const ac = new AbortController();
    const onAskRegistered = jest.fn((toolCallId) => {
      if (String(toolCallId).startsWith('mdr-')) {
        ac.abort(new ExtractionCancelledError('cancel-before-mdr-emit'));
        return false;
      }
      return true;
    });
    const run = startMultiDispatcher({ onAskRegistered, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(1);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/remaining circuit descriptions/i),
      }),
    ]);
    expect(run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))).toEqual(
      []
    );
    expect(run.pendingAsks.size).toBe(0);
  });

  test('answered-partial cancellation queues one interruption terminal then rethrows', async () => {
    const ac = new AbortController();
    let writeCount = 0;
    const autoResolveWrite = jest.fn().mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 2) {
        ac.abort(new ExtractionCancelledError('cancel-after-followup-write'));
      }
      return { ok: true };
    });
    const run = startMultiDispatcher({ autoResolveWrite, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights, ground floor lightng, and the smoke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuit 4',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(2);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/recorded the matched circuits/i),
      }),
    ]);
    expect(run.session.pendingVoicePrompts[0].text).not.toMatch(
      /still couldn't place every circuit/i
    );
  });

  test('answered-full cancellation rethrows without an unresolved-target terminal', async () => {
    const ac = new AbortController();
    let writeCount = 0;
    const autoResolveWrite = jest.fn().mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 2) {
        ac.abort(new ExtractionCancelledError('cancel-after-complete-followup'));
      }
      return { ok: true };
    });
    const run = startMultiDispatcher({ autoResolveWrite, signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuit 4',
    });

    await expect(run.promise).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(2);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('a spoken mdr cancellation is an ordinary opt-out, not generation cancellation', async () => {
    const ac = new AbortController();
    const run = startMultiDispatcher({ signal: ac.signal });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the smoke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));

    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'skip',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.resolved_writes).toEqual([expect.objectContaining({ circuit: 3, ok: true })]);
    expect(ac.signal.aborted).toBe(false);
    expect(run.session.pendingVoicePrompts ?? []).toEqual([]);
  });

  test('the effective board owns both designation matching and emitted write scope', async () => {
    const session = {
      sessionId: 'sess-test',
      stateSnapshot: {
        currentBoardId: 'sub-b',
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'sub-b', board_type: 'sub_distribution', parent_board_id: 'main' },
        ],
        circuits: {
          1: { circuit_designation: 'Cooker' },
          2: { circuit_designation: 'Shower' },
          3: { circuit_designation: 'Garage' },
          'sub-b::1': {
            circuit: 1,
            board_id: 'sub-b',
            circuit_designation: 'Ground floor lighting',
          },
          'sub-b::2': {
            circuit: 2,
            board_id: 'sub-b',
            circuit_designation: 'First floor lighting',
          },
          'sub-b::3': {
            circuit: 3,
            board_id: 'sub-b',
            circuit_designation: 'Smoke Alarm',
          },
        },
      },
    };
    const run = startMultiDispatcher({
      session,
      inputOverrides: { context_board_id: 'sub-b' },
      pendingWriteOverrides: { board_id: 'sub-b' },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '2 lighting circuits and the smoke alarm',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('full');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([1, 2, 3]);
    expect(run.autoResolveWrite).toHaveBeenCalledTimes(3);
    for (const [write] of run.autoResolveWrite.mock.calls) {
      expect(write.board_id).toBe('sub-b');
    }
  });

  test('main-board designations cannot be borrowed by a sub-board ask', async () => {
    const session = {
      sessionId: 'sess-test',
      stateSnapshot: {
        currentBoardId: 'sub-b',
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'sub-b', board_type: 'sub_distribution', parent_board_id: 'main' },
        ],
        circuits: {
          1: { circuit_designation: 'Ground floor lighting' },
          2: { circuit_designation: 'First floor lighting' },
          3: { circuit_designation: 'Smoke Alarm' },
          'sub-b::1': { circuit: 1, board_id: 'sub-b', circuit_designation: 'Cooker' },
          'sub-b::2': { circuit: 2, board_id: 'sub-b', circuit_designation: 'Shower' },
          'sub-b::3': { circuit: 3, board_id: 'sub-b', circuit_designation: 'Garage' },
        },
      },
    };
    const run = startMultiDispatcher({
      session,
      inputOverrides: { context_board_id: 'sub-b' },
      pendingWriteOverrides: { board_id: 'sub-b' },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: '2 lighting circuits and the smoke alarm',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('all_unmatched');
    expect(run.autoResolveWrite).not.toHaveBeenCalled();
  });

  test('an unnamed server-owned ref remains valid in an explicit mixed answer', async () => {
    const session = {
      sessionId: 'sess-test',
      stateSnapshot: {
        currentBoardId: 'sub-b',
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'sub-b', board_type: 'sub_distribution', parent_board_id: 'main' },
        ],
        circuits: {
          'sub-b::2': { circuit: 2, board_id: 'sub-b', circuit_designation: '' },
          'sub-b::3': {
            circuit: 3,
            board_id: 'sub-b',
            circuit_designation: 'Smoke Alarm',
          },
        },
      },
    };
    const run = startMultiDispatcher({
      session,
      inputOverrides: { context_board_id: 'sub-b' },
      pendingWriteOverrides: { board_id: 'sub-b' },
    });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'circuit 2 and the smoke alarm',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('full');
    expect(body.resolved_writes.map((write) => write.circuit)).toEqual([2, 3]);
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalled();
  });

  test('a retry success makes its sibling no-match notice eligible', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the attic circuit',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));
    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'circuit 4',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.resolved_writes).toEqual([expect.objectContaining({ circuit: 4, ok: true })]);
    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'designation_no_match',
        target: { kind: 'ordinal', ordinal: 2 },
      })
    );
  });

  test('the mdr clarification is bounded to one ask when its answer stays ambiguous', async () => {
    const run = startMultiDispatcher();
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'lighting and the smoke alarm',
    });
    await tick();
    const mdrFrame = run.ws.sent.find((frame) => String(frame.tool_call_id).startsWith('mdr-'));
    run.pendingAsks.resolve(mdrFrame.tool_call_id, {
      answered: true,
      user_text: 'lighting and lighting',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(body.unresolved.some((entry) => entry.disposition === 'ask')).toBe(true);
    expect(
      run.ws.sent.filter((frame) => String(frame.tool_call_id).startsWith('mdr-'))
    ).toHaveLength(1);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/couldn't place every circuit/i),
      }),
    ]);
    expect(run.session.pendingVoicePrompts[0].text).toMatch(/say the reading/i);
  });

  test.each([
    ['closed socket', (run) => (run.ws.readyState = 0)],
    [
      'throwing send',
      (run) => {
        run.ws.send = () => {
          throw new Error('send failed');
        };
      },
    ],
    [
      'register failure',
      (run) => {
        run.pendingAsks.register = () => {
          throw new Error('register failed');
        };
      },
    ],
  ])('a broker %s queues one truthful terminal and leaks no ask', async (_name, breakBroker) => {
    const run = startMultiDispatcher();
    await tick();
    breakBroker(run);
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'upstars lights and the attic circuit',
    });
    const body = JSON.parse((await run.promise).content);

    expect(body.match_status).toBe('partial');
    expect(run.pendingAsks.size).toBe(0);
    expect(run.session.pendingVoicePrompts).toEqual([
      expect.objectContaining({
        generationId: 'gen-multi',
        text: expect.stringMatching(/couldn't ask which circuits that reading was for/i),
      }),
    ]);
    expect(run.session.pendingVoicePrompts[0].text).toMatch(/say the reading/i);
  });

  test('an unmatched notice is not staged when every sibling write fails', async () => {
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: false, code: 'write_failed' });
    const run = startMultiDispatcher({ autoResolveWrite });
    await tick();
    run.pendingAsks.resolve('toolu_multi', {
      answered: true,
      user_text: 'the attic circuit and the smoke alarm',
    });
    await run.promise;

    expect(run.stagePartialFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'write_failed' })
    );
    expect(run.stagePartialFailureNotice).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'designation_no_match' })
    );
  });
});
