/**
 * Stage 6 Phase 1 — Multi-round tool-call loop (stage6-tool-loop.js).
 *
 * Covers REQUIREMENTS.md:
 *   STD-02  Multi-round loop on stop_reason: tool_use, terminates on end_turn
 *   STD-10  Loop cap = 8 ROUNDS. On cap hit: append one synthetic tool_result
 *           per pending tool_use_id with {aborted:true, reason:'loop_cap'}
 *           and is_error:true. Round-N dispatcher MUST NOT be invoked.
 *   STO-01  Per-tool-call log: stage6.tool_call with sessionId, tool_call_id,
 *           tool_name, duration_ms, outcome.
 *
 * Deterministic — uses mockClient from helpers; no Anthropic network calls.
 */

import { jest } from '@jest/globals';
import {
  runToolLoop,
  NOOP_DISPATCHER,
  LOOP_CAP,
} from '../extraction/stage6-tool-loop.js';
import { mockClient } from './helpers/mockStream.js';
import { TOOL_SCHEMAS } from '../extraction/stage6-tool-schemas.js';

// ---------------------------------------------------------------------------
// Event fixture builders — each returns a full event array for one round of
// client.messages.stream(). Built here (not in a json fixture directory)
// because these fixtures are tiny and the shape is load-bearing for the
// assertions immediately below.
// ---------------------------------------------------------------------------

function endTurnRound(text = 'done') {
  return [
    {
      type: 'message_start',
      message: { id: 'msg_end', role: 'assistant', content: [] },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function toolUseRound(toolCalls) {
  // toolCalls: Array<{ id, name, input }>
  const events = [
    {
      type: 'message_start',
      message: { id: 'msg_tu', role: 'assistant', content: [] },
    },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function baseCtx() {
  return { sessionId: 'sess-xyz', turnId: 'turn-1' };
}

describe('stage6-tool-loop', () => {
  test('LOOP_CAP is exported as 8 (STD-10)', () => {
    expect(LOOP_CAP).toBe(8);
  });

  test('NOOP_DISPATCHER returns {tool_use_id, content, is_error:false}', async () => {
    const res = await NOOP_DISPATCHER(
      { tool_call_id: 'toolu_abc', name: 'record_reading', input: { field: 'x' } },
      baseCtx(),
    );
    expect(res).toEqual({
      tool_use_id: 'toolu_abc',
      content: '{"ok":true}',
      is_error: false,
    });
  });

  test('single round with end_turn → rounds=1, no dispatch (STD-02)', async () => {
    const client = mockClient([endTurnRound('hello')]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    expect(result.rounds).toBe(1);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.aborted).toBeFalsy();
    expect(dispatcher).not.toHaveBeenCalled();
    // stage6.tool_call log is only emitted per dispatch — none here.
    expect(logger.info).not.toHaveBeenCalledWith('stage6.tool_call', expect.anything());
  });

  test('two rounds: tool_use then end_turn → 1 dispatch, messages extended (STD-02)', async () => {
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.95, source_turn_id: 't1' } },
      ]),
      endTurnRound('ok'),
    ]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    expect(result.rounds).toBe(2);
    expect(result.stop_reason).toBe('end_turn');
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0][0]).toMatchObject({
      tool_call_id: 'toolu_1',
      name: 'record_reading',
    });
    // Messages were extended: user(start) + assistant(tool_use) + user(tool_result) = 3
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1')).toBe(true);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      is_error: false,
    });
  });

  test('three tool_use blocks in one response → 3 dispatches + 3 tool_results in order', async () => {
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_a', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.9, source_turn_id: 't1' } },
        { id: 'toolu_b', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.51', confidence: 0.9, source_turn_id: 't1' } },
        { id: 'toolu_c', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 3, value: '0.77', confidence: 0.9, source_turn_id: 't1' } },
      ]),
      endTurnRound('all done'),
    ]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    expect(result.rounds).toBe(2);
    expect(dispatcher).toHaveBeenCalledTimes(3);
    // tool_result message (index 2) has 3 tool_result blocks in the same order.
    expect(messages[2].content).toHaveLength(3);
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b', 'toolu_c']);
  });

  test('STO-01: logger.info called with "stage6.tool_call" for each dispatch', async () => {
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_log1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.9, source_turn_id: 't1' } },
      ]),
      endTurnRound('ok'),
    ]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher: NOOP_DISPATCHER,
      ctx: baseCtx(),
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      'stage6.tool_call',
      expect.objectContaining({
        sessionId: 'sess-xyz',
        turnId: 'turn-1',
        tool_call_id: 'toolu_log1',
        tool_name: 'record_reading',
        outcome: 'stub_ok',
      }),
    );
    // duration_ms is a number (may be 0 on fast mocks — >= 0 is sufficient)
    const callArgs = logger.info.mock.calls.find(
      ([tag]) => tag === 'stage6.tool_call',
    )[1];
    expect(typeof callArgs.duration_ms).toBe('number');
    expect(callArgs.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('LOOP CAP (STD-10): 8 rounds each tool_use → dispatcher called 7×, round-8 NOT dispatched, synthetic tool_result appended', async () => {
    const rounds = [];
    for (let i = 1; i <= 8; i += 1) {
      rounds.push(
        toolUseRound([
          {
            id: `toolu_r${i}`,
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: i, value: '0.0', confidence: 0.9, source_turn_id: `t${i}` },
          },
        ]),
      );
    }
    const client = mockClient(rounds);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    expect(result.rounds).toBe(8);
    expect(result.aborted).toBe(true);
    // Rounds 1..7 dispatched (7 calls). Round 8 NOT dispatched.
    expect(dispatcher).toHaveBeenCalledTimes(7);
    // Last message is a user tool_result message containing one synthetic
    // abort tool_result whose tool_use_id matches the round-8 assistant.
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toHaveLength(1);
    expect(lastMsg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_r8',
      content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
      is_error: true,
    });
    // The round-8 assistant message (containing toolu_r8) was pushed BEFORE
    // the synthetic tool_result user message (tool_use-before-tool_result
    // ordering invariant, Research §Pitfall 3).
    const secondLastMsg = messages[messages.length - 2];
    expect(secondLastMsg.role).toBe('assistant');
    expect(
      secondLastMsg.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_r8'),
    ).toBe(true);
    // STD-10 log emitted.
    expect(logger.warn).toHaveBeenCalledWith(
      'tool_loop_cap_hit',
      expect.objectContaining({
        sessionId: 'sess-xyz',
        turnId: 'turn-1',
        rounds: 8,
        pending_tool_uses: 1,
      }),
    );
  });

  test('LOOP CAP with multiple tool_use blocks on round 8 → one synthetic tool_result per tool_use_id (STD-10)', async () => {
    const rounds = [];
    // Rounds 1..7: single tool_use each.
    for (let i = 1; i <= 7; i += 1) {
      rounds.push(
        toolUseRound([
          {
            id: `toolu_r${i}`,
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: i, value: '0.0', confidence: 0.9, source_turn_id: `t${i}` },
          },
        ]),
      );
    }
    // Round 8: THREE tool_use blocks.
    rounds.push(
      toolUseRound([
        { id: 'toolu_r8a', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 8, value: '0.1', confidence: 0.9, source_turn_id: 't8' } },
        { id: 'toolu_r8b', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 9, value: '0.2', confidence: 0.9, source_turn_id: 't8' } },
        { id: 'toolu_r8c', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 10, value: '0.3', confidence: 0.9, source_turn_id: 't8' } },
      ]),
    );
    const client = mockClient(rounds);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    expect(result.rounds).toBe(8);
    expect(result.aborted).toBe(true);
    expect(dispatcher).toHaveBeenCalledTimes(7);

    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toHaveLength(3);
    // Order matches the assembler's index-ascending order (a, b, c).
    expect(lastMsg.content.map((b) => b.tool_use_id)).toEqual([
      'toolu_r8a',
      'toolu_r8b',
      'toolu_r8c',
    ]);
    // Every synthetic tool_result has the STD-10 shape.
    for (const block of lastMsg.content) {
      expect(block).toMatchObject({
        type: 'tool_result',
        content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
        is_error: true,
      });
    }
    expect(logger.warn).toHaveBeenCalledWith(
      'tool_loop_cap_hit',
      expect.objectContaining({ rounds: 8, pending_tool_uses: 3 }),
    );
  });

  test('dispatcher error path → tool_result with is_error:true, loop continues', async () => {
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_err', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.9, source_turn_id: 't1' } },
      ]),
      endTurnRound('ok'),
    ]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(async () => {
      throw new Error('boom');
    });

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    // Loop did NOT crash; it completed normally reaching end_turn.
    expect(result.rounds).toBe(2);
    expect(result.stop_reason).toBe('end_turn');
    expect(dispatcher).toHaveBeenCalledTimes(1);
    // The tool_result that was appended carries is_error:true and an error shape.
    expect(messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_err',
      is_error: true,
    });
    const parsed = JSON.parse(messages[2].content[0].content);
    expect(parsed).toMatchObject({ error: 'dispatcher_error', message: 'boom' });
    // Error log was emitted with outcome: 'dispatcher_error'.
    expect(logger.error).toHaveBeenCalledWith(
      'stage6.tool_call',
      expect.objectContaining({
        tool_call_id: 'toolu_err',
        outcome: 'dispatcher_error',
      }),
    );
  });
});
