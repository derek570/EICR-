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
import { mockClient, mockStream } from './helpers/mockStream.js';
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
    // Messages were extended: user(start) + assistant(tool_use) +
    // user(tool_result) + assistant(end_turn text) = 4. The final-round
    // assistant message is pushed even on end_turn (Codex STG MAJOR fix —
    // multi-turn callers need the model's final reply in messages_final).
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content.some((b) => b.type === 'tool_use' && b.id === 'toolu_1')).toBe(true);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      is_error: false,
    });
    // Round-2 end_turn assistant message present (the model's final text reply).
    expect(messages[3].role).toBe('assistant');
  });

  test('end_turn assistant message persisted to messages_final (Codex STG MAJOR — no dropped final turn)', async () => {
    // Single-round end_turn: pre-fix behavior broke out of the loop before
    // pushing stream.finalMessage(), so messages_final lost the model's
    // only reply. Any caller building multi-turn history would lose context.
    const client = mockClient([endTurnRound('final reply text')]);
    const messages = [{ role: 'user', content: 'hello' }];
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    // mockStream's finalMessage echoes the content blocks it saw — end_turn
    // round carries a single text block.
    expect(messages[1].content[0]).toMatchObject({ type: 'text' });
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

  test('orphan_delta error record (tool_call_id=null) is SKIPPED — no synthetic "unknown" tool_result (Codex STG BLOCK)', async () => {
    // Construct a round that produces a MIX of real tool_use + orphan_delta.
    // Pre-fix bug: the normal-branch error path used `rec.tool_call_id ??
    // "unknown"`, emitting a tool_result referencing a nonexistent tool_use
    // — Anthropic rejects the next round with tool_use_id_without_result.
    // Fix: skip orphan records entirely (they have no matching tool_use).
    const roundWithOrphan = [
      { type: 'message_start', message: { id: 'msg_orphan', role: 'assistant', content: [] } },
      // Real tool_use at index 0.
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_real', name: 'record_reading', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.9,
            source_turn_id: 't1',
          }),
        },
      },
      { type: 'content_block_stop', index: 0 },
      // Orphan delta at index 99 — NO preceding content_block_start. Assembler
      // emits {tool_call_id: null, error: 'orphan_delta'}.
      {
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'input_json_delta', partial_json: '{"oops":true}' },
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const client = mockClient([roundWithOrphan, endTurnRound('done')]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    // The user tool_result message is messages[2] (after user(start) +
    // assistant(round-1)). It must contain EXACTLY ONE tool_result — the
    // real tool_use's result — NOT a second "unknown"-id entry for the
    // orphan.
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0].tool_use_id).toBe('toolu_real');
    // No tool_result references the sentinel string 'unknown'.
    for (const block of messages[2].content) {
      expect(block.tool_use_id).not.toBe('unknown');
    }
    // Real tool_use dispatched, orphan did NOT trigger a dispatch.
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0][0].tool_call_id).toBe('toolu_real');
  });

  test('padding: assistant tool_use id with no matching assembler record → synthetic internal_no_result tool_result (Codex STG MAJOR)', async () => {
    // Pathological: assistant message emits tool_use block toolu_real, but
    // the assembler's records also contains an orphan_delta that we skip
    // AND (hypothetically) the real record is dropped. We simulate the
    // "every record skipped" edge by constructing a round whose ONLY
    // record-producing event is an orphan delta (no content_block_start),
    // PLUS a content_block_start that never receives a delta or stop —
    // so finalize() flushes it as incomplete_stream WITH its real id.
    // The assembler therefore emits 2 records: 1 orphan (skipped) + 1
    // incomplete_stream with toolu_real. The incomplete_stream is routed
    // through the error branch which (given tool_call_id is present)
    // emits a real tool_result — so this would actually answer the pair.
    //
    // Instead we construct the true MAJOR-case: the assistant emits a
    // tool_use block BUT the assembler never synthesises any record that
    // references that id (e.g. because the model emits tool_use in the
    // assistant message via finalMessage() but the iteration feed to the
    // assembler is somehow starved — an SDK race / mock divergence). In
    // real code this "cannot happen" but the API will 400 if it does, so
    // the loop must pad.
    //
    // We express that here by feeding the stream normal events (so the
    // assembler has 1 valid record) AND then causing a DIFFERENT assistant
    // tool_use id (toolu_phantom) to appear in the finalMessage() content
    // by constructing a minimal custom stream that forks.
    const phantomAssistantContent = [
      { type: 'tool_use', id: 'toolu_phantom', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.51', confidence: 0.9, source_turn_id: 't' } },
    ];
    const customStream = {
      async *[Symbol.asyncIterator]() {
        // Iteration feeds the assembler ZERO tool_use records — assembler
        // finalizes with records=[] but stop_reason='tool_use'.
        yield { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } };
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
        yield { type: 'message_stop' };
      },
      async finalMessage() {
        // BUT finalMessage() returns a phantom tool_use id — what Anthropic
        // "committed to" diverges from what the assembler saw.
        return { role: 'assistant', content: phantomAssistantContent, stop_reason: 'tool_use' };
      },
    };
    const endTurnStream = mockStream(endTurnRound('done'));
    let call = 0;
    const client = {
      messages: {
        stream() {
          call += 1;
          return call === 1 ? customStream : endTurnStream;
        },
      },
    };
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    const dispatcher = jest.fn(NOOP_DISPATCHER);

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    // messages[0]=user(start), messages[1]=assistant(phantom tool_use),
    // messages[2]=user(synthetic tool_result for toolu_phantom).
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_phantom',
      is_error: true,
    });
    const parsed = JSON.parse(messages[2].content[0].content);
    expect(parsed).toMatchObject({
      error: 'internal_no_result',
      reason: 'record_missing_or_skipped',
    });
    // Observability: warn log emitted with outcome='internal_no_result'.
    const warnCall = logger.warn.mock.calls.find(
      (c) => c[0] === 'stage6.tool_call' && c[1]?.outcome === 'internal_no_result',
    );
    expect(warnCall).toBeDefined();
    expect(warnCall[1].tool_call_id).toBe('toolu_phantom');
    // Dispatcher was NOT called — the phantom had no assembler record to
    // drive dispatch from.
    expect(dispatcher).not.toHaveBeenCalled();
  });

  test('invariant: stop_reason=tool_use with zero assistant tool_use blocks → abort turn (Codex STG MAJOR)', async () => {
    // Anthropic protocol violation: model said "I am about to use tools"
    // but the assistant message contains NO tool_use blocks. Pre-fix the
    // loop would push {role:'user', content:[]} and 400 on the next
    // stream() invocation. Post-fix: abort cleanly with a logged error.
    const emptyToolUseRound = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } };
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
        yield { type: 'message_stop' };
      },
      async finalMessage() {
        return { role: 'assistant', content: [], stop_reason: 'tool_use' };
      },
    };
    const client = {
      messages: {
        stream: () => emptyToolUseRound,
      },
    };
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher: NOOP_DISPATCHER,
      ctx: baseCtx(),
      logger,
    });

    expect(result.aborted).toBe(true);
    expect(result.rounds).toBe(1);
    // No empty user message was pushed — assistant message is the final one.
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    // Invariant violation logged for ops visibility.
    expect(logger.error).toHaveBeenCalledWith(
      'stage6.tool_loop_invariant',
      expect.objectContaining({
        reason: 'tool_use_stop_reason_with_no_tool_use_blocks',
      }),
    );
  });

  test('cap-hit invariant: stop_reason=tool_use at LOOP_CAP with zero real tool ids → abort (no empty user-content push) (Codex STG round-4 MAJOR)', async () => {
    // Symmetry bug with the round-2 normal-branch invariant fix: when the
    // cap-hit branch runs but neither `records` (all orphan_delta, skipped)
    // nor `assistantToolUseIds(assistantMsg)` surfaces a real id, the
    // pre-fix code would `messages.push({role:'user', content:[]})`,
    // malforming the conversation history. Any caller reusing messages_final
    // would 400 on the next stream() call. Post-fix: abort cleanly, no push.
    //
    // Construct 7 real tool_use rounds + an 8th round that presents
    // stop_reason=tool_use with zero real tool_use blocks (assembler sees
    // nothing, finalMessage() echoes empty content).
    const rounds = [];
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
    const emptyRound8 = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: 'm8', role: 'assistant', content: [] } };
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } };
        yield { type: 'message_stop' };
      },
      async finalMessage() {
        return { role: 'assistant', content: [], stop_reason: 'tool_use' };
      },
    };
    let call = 0;
    const client = {
      messages: {
        stream() {
          call += 1;
          if (call <= 7) return mockStream(rounds[call - 1]);
          return emptyRound8;
        },
      },
    };
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

    expect(result.aborted).toBe(true);
    expect(result.rounds).toBe(8);
    // CRITICAL: the last message in history is the round-8 assistant message
    // (pushed at line 179 before the cap-hit branch runs). NO user message
    // with empty content was pushed — content:[] would malform history.
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toEqual([]);
    // No user message with empty content anywhere in the tail.
    for (const m of messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        expect(m.content.length).toBeGreaterThan(0);
      }
    }
    // Invariant violation logged with the cap-specific reason string.
    expect(logger.error).toHaveBeenCalledWith(
      'stage6.tool_loop_invariant',
      expect.objectContaining({
        reason: 'tool_use_stop_reason_with_no_tool_use_blocks_at_cap',
        rounds: 8,
      }),
    );
    // Dispatcher called 7× (rounds 1–7 normal), NOT called on round 8 (cap).
    expect(dispatcher).toHaveBeenCalledTimes(7);
  });

  test('rogue dispatcher returning wrong tool_use_id → tool_result keyed to rec.tool_call_id + warn log (Codex STG round-3 MAJOR)', async () => {
    // Defence in depth: if the dispatcher ever returns an object whose
    // tool_use_id diverges from rec.tool_call_id (buggy custom dispatcher,
    // typo, id-rewriting middleware), Anthropic's API will 400 the next
    // round with `tool_use_id_without_result` because the pair is broken.
    // The loop must ignore the rogue id and key the tool_result to
    // rec.tool_call_id — AND emit a stage6.tool_call_id_mismatch warn log
    // so ops can find the buggy dispatcher.
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_real', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.9, source_turn_id: 't1' } },
      ]),
      endTurnRound('ok'),
    ]);
    const messages = [{ role: 'user', content: 'start' }];
    const logger = makeLogger();
    // Rogue dispatcher: returns a DIFFERENT tool_use_id than the input's tool_call_id.
    const dispatcher = jest.fn(async () => ({
      tool_use_id: 'toolu_WRONG_ID',
      content: '{"ok":true}',
      is_error: false,
    }));

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: baseCtx(),
      logger,
    });

    // tool_result is keyed to the ORIGINAL rec.tool_call_id — NOT the rogue id.
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_real',
      is_error: false,
    });
    // No tool_result block references the rogue id.
    for (const block of messages[2].content) {
      expect(block.tool_use_id).not.toBe('toolu_WRONG_ID');
    }
    // Observability: divergence warn log emitted with both ids for debugging.
    expect(logger.warn).toHaveBeenCalledWith(
      'stage6.tool_call_id_mismatch',
      expect.objectContaining({
        sessionId: 'sess-xyz',
        turnId: 'turn-1',
        tool_call_id: 'toolu_real',
        dispatcher_returned_id: 'toolu_WRONG_ID',
        tool_name: 'record_reading',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Plan 03-06 — sortRecords hook (Phase 3 STA-02 defense-in-depth).
  // The hook is additive + opt-in. Default is identity — Phase 1/2 tests
  // above run without supplying `sortRecords` and must remain green.
  // -------------------------------------------------------------------------

  describe('sortRecords hook (Phase 3)', () => {
    test('omitted → dispatch order equals assembler.finalize() order (identity default)', async () => {
      const client = mockClient([
        toolUseRound([
          { id: 'toolu_0', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.2', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_2', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 3, value: '0.3', confidence: 0.9, source_turn_id: 't1' } },
        ]),
        endTurnRound('done'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const seen = [];
      const dispatcher = jest.fn(async (call) => {
        seen.push(call.tool_call_id);
        return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
      });

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: baseCtx(),
        logger: makeLogger(),
        // sortRecords omitted → default identity
      });

      expect(seen).toEqual(['toolu_0', 'toolu_1', 'toolu_2']);
    });

    test('provided (reverse) → dispatch order follows hook output', async () => {
      const client = mockClient([
        toolUseRound([
          { id: 'toolu_0', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.2', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_2', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 3, value: '0.3', confidence: 0.9, source_turn_id: 't1' } },
        ]),
        endTurnRound('done'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const seen = [];
      const dispatcher = jest.fn(async (call) => {
        seen.push(call.tool_call_id);
        return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
      });
      const sortRecords = jest.fn((records) => [...records].reverse());

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: baseCtx(),
        logger: makeLogger(),
        sortRecords,
      });

      expect(seen).toEqual(['toolu_2', 'toolu_1', 'toolu_0']);
    });

    test('called exactly once per round with the full record array', async () => {
      const client = mockClient([
        toolUseRound([
          { id: 'toolu_a', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_b', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.2', confidence: 0.9, source_turn_id: 't1' } },
        ]),
        endTurnRound('ok'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const sortRecords = jest.fn((records) => records);

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher: NOOP_DISPATCHER,
        ctx: baseCtx(),
        logger: makeLogger(),
        sortRecords,
      });

      // One tool_use round → hook called exactly once.
      expect(sortRecords).toHaveBeenCalledTimes(1);
      // Received the FULL record array (not per-record).
      const arg = sortRecords.mock.calls[0][0];
      expect(Array.isArray(arg)).toBe(true);
      expect(arg).toHaveLength(2);
      expect(arg[0].tool_call_id).toBe('toolu_a');
      expect(arg[1].tool_call_id).toBe('toolu_b');
    });

    test('called once per round across a multi-round turn (N tool_use rounds → N hook invocations)', async () => {
      const client = mockClient([
        toolUseRound([{ id: 'toolu_r1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } }]),
        toolUseRound([{ id: 'toolu_r2', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.2', confidence: 0.9, source_turn_id: 't2' } }]),
        endTurnRound('done'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const sortRecords = jest.fn((records) => records);

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher: NOOP_DISPATCHER,
        ctx: baseCtx(),
        logger: makeLogger(),
        sortRecords,
      });

      // Two tool_use rounds → two hook calls. The final end_turn round has
      // no records to dispatch, so the hook is NOT invoked for it.
      expect(sortRecords).toHaveBeenCalledTimes(2);
    });

    test('hook throws → surfaces as dispatcher_error for each owed tool_use (loop does NOT crash)', async () => {
      // If sortRecords throws, the loop must still honour the Anthropic
      // invariant that every assistant tool_use gets a matching tool_result
      // — otherwise the next stream() would 400. The existing error envelope
      // shape (dispatcher_error with is_error:true) is reused.
      const client = mockClient([
        toolUseRound([
          { id: 'toolu_throw', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } },
        ]),
        endTurnRound('ok'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const logger = makeLogger();
      const sortRecords = () => {
        throw new Error('sort_failed');
      };

      const result = await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher: NOOP_DISPATCHER,
        ctx: baseCtx(),
        logger,
        sortRecords,
      });

      // Loop did not crash.
      expect(result.rounds).toBeGreaterThanOrEqual(1);
      // An error was logged against the loop.
      const errorLogged = logger.error.mock.calls.some(([tag]) => tag === 'stage6.tool_call' || tag === 'stage6.tool_loop_invariant' || tag === 'stage6.tool_loop_sort_error');
      expect(errorLogged).toBe(true);
    });

    // Plan 03-12 r15 MAJOR#1 — when the sortRecords hook throws, the loop
    // must NOT fall back to identity order (that could dispatch ask_user
    // BEFORE writes in the same round, violating STA-02 at its
    // enforcement point). Instead, it must synthesise the minimum
    // guarantee the hook was meant to provide: move ask_user records to
    // the tail of the dispatch array, preserving each partition's
    // relative order. Pure, allocation-light, no external deps — matches
    // createSortRecordsAsksLast's contract closely enough to preserve
    // STA-02 defensively under hook-failure conditions.
    test('hook throws → emergency STA-02 fallback moves ask_user to tail (r15 MAJOR#1)', async () => {
      const client = mockClient([
        toolUseRound([
          { id: 'toolu_ask', name: 'ask_user', input: { question: 'Which circuit did you mean — 3 or 4?', reason: 'ambiguous_circuit', expected_answer_shape: 'circuit_ref' } },
          { id: 'toolu_r1', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 1, value: '0.1', confidence: 0.9, source_turn_id: 't1' } },
          { id: 'toolu_r2', name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: 2, value: '0.2', confidence: 0.9, source_turn_id: 't1' } },
        ]),
        endTurnRound('done'),
      ]);
      const messages = [{ role: 'user', content: 'start' }];
      const seen = [];
      const dispatcher = jest.fn(async (call) => {
        seen.push(call.tool_call_id);
        return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
      });
      const sortRecords = () => {
        throw new Error('sort_failed_for_r15_major_1');
      };
      const logger = makeLogger();

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages,
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: baseCtx(),
        logger,
        sortRecords,
      });

      // Writes dispatched before the ask — STA-02 preserved despite the
      // hook throw. Relative order within each partition is the
      // assembler's original order (toolu_r1 before toolu_r2).
      expect(seen).toEqual(['toolu_r1', 'toolu_r2', 'toolu_ask']);
      // The error is still logged so CloudWatch alarms can fire.
      const errorLogged = logger.error.mock.calls.some(
        ([tag]) => tag === 'stage6.tool_loop_sort_error',
      );
      expect(errorLogged).toBe(true);
    });
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
