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
import { runToolLoop, NOOP_DISPATCHER, LOOP_CAP } from '../extraction/stage6-tool-loop.js';
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
      baseCtx()
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
        {
          id: 'toolu_1',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.95,
            source_turn_id: 't1',
          },
        },
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

    // F7 Item 2 — the authoritative assembler tool_call_id survives into
    // toolLoopOut.tool_calls. The D2 qualification tightening + the
    // pre-emission audibility fallback (stage6-shadow-harness.js) check a
    // continuation's tool_call_id against emittedAskToolCallIds; a missing id
    // would make every emitted continuation look inaudible and double-fire the
    // fallback.
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({
      name: 'record_reading',
      tool_call_id: 'toolu_1',
    });
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
        {
          id: 'toolu_a',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
        {
          id: 'toolu_b',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 2,
            value: '0.51',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
        {
          id: 'toolu_c',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 3,
            value: '0.77',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
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
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual([
      'toolu_a',
      'toolu_b',
      'toolu_c',
    ]);
  });

  test('STO-01: logger.info called with "stage6.tool_call" for each dispatch', async () => {
    const client = mockClient([
      toolUseRound([
        {
          id: 'toolu_log1',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
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
      })
    );
    // duration_ms is a number (may be 0 on fast mocks — >= 0 is sufficient)
    const callArgs = logger.info.mock.calls.find(([tag]) => tag === 'stage6.tool_call')[1];
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
            input: {
              field: 'measured_zs_ohm',
              circuit: i,
              value: '0.0',
              confidence: 0.9,
              source_turn_id: `t${i}`,
            },
          },
        ])
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
    expect(secondLastMsg.content.some((b) => b.type === 'tool_use' && b.id === 'toolu_r8')).toBe(
      true
    );
    // STD-10 log emitted.
    expect(logger.warn).toHaveBeenCalledWith(
      'tool_loop_cap_hit',
      expect.objectContaining({
        sessionId: 'sess-xyz',
        turnId: 'turn-1',
        rounds: 8,
        pending_tool_uses: 1,
      })
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
            input: {
              field: 'measured_zs_ohm',
              circuit: i,
              value: '0.0',
              confidence: 0.9,
              source_turn_id: `t${i}`,
            },
          },
        ])
      );
    }
    // Round 8: THREE tool_use blocks.
    rounds.push(
      toolUseRound([
        {
          id: 'toolu_r8a',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 8,
            value: '0.1',
            confidence: 0.9,
            source_turn_id: 't8',
          },
        },
        {
          id: 'toolu_r8b',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 9,
            value: '0.2',
            confidence: 0.9,
            source_turn_id: 't8',
          },
        },
        {
          id: 'toolu_r8c',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 10,
            value: '0.3',
            confidence: 0.9,
            source_turn_id: 't8',
          },
        },
      ])
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
      expect.objectContaining({ rounds: 8, pending_tool_uses: 3 })
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
      {
        type: 'tool_use',
        id: 'toolu_phantom',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 2,
          value: '0.51',
          confidence: 0.9,
          source_turn_id: 't',
        },
      },
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
      (c) => c[0] === 'stage6.tool_call' && c[1]?.outcome === 'internal_no_result'
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
      })
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
            input: {
              field: 'measured_zs_ohm',
              circuit: i,
              value: '0.0',
              confidence: 0.9,
              source_turn_id: `t${i}`,
            },
          },
        ])
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
      })
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
        {
          id: 'toolu_real',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
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
      })
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
          {
            id: 'toolu_0',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.2',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_2',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.3',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
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
          {
            id: 'toolu_0',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.2',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_2',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.3',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
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
          {
            id: 'toolu_a',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_b',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.2',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
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
        toolUseRound([
          {
            id: 'toolu_r1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
        ]),
        toolUseRound([
          {
            id: 'toolu_r2',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.2',
              confidence: 0.9,
              source_turn_id: 't2',
            },
          },
        ]),
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
          {
            id: 'toolu_throw',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
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
      const errorLogged = logger.error.mock.calls.some(
        ([tag]) =>
          tag === 'stage6.tool_call' ||
          tag === 'stage6.tool_loop_invariant' ||
          tag === 'stage6.tool_loop_sort_error'
      );
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
          {
            id: 'toolu_ask',
            name: 'ask_user',
            input: {
              question: 'Which circuit did you mean — 3 or 4?',
              reason: 'ambiguous_circuit',
              expected_answer_shape: 'circuit_ref',
            },
          },
          {
            id: 'toolu_r1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 1,
              value: '0.1',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_r2',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.2',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
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
        ([tag]) => tag === 'stage6.tool_loop_sort_error'
      );
      expect(errorLogged).toBe(true);
    });

    // id-100(b) (2026-07-25) — the emergency fallback must ALSO reproduce the
    // hook's earthing-FIRST partition. The server-authoritative impedance clamp
    // resolves the Ze band from the COMMITTED snapshot, so a same-round
    // `earthing_arrangement` write has to dispatch BEFORE an impedance write or
    // the clamp silently declines to divide. A sort-hook throw must not quietly
    // downgrade a safety-critical invariant to "whatever order the model spoke".
    //
    // DISCRIMINATING: the model emits Ze FIRST here (utterance order for "Ze is
    // 16 on a TN-C-S system"), so the pre-fix fallback dispatched toolu_ze
    // before toolu_earthing.
    test('hook throws → emergency fallback ALSO dispatches earthing_arrangement first (id-100(b))', async () => {
      const client = mockClient([
        toolUseRound([
          {
            id: 'toolu_ze',
            name: 'record_board_reading',
            input: {
              field: 'earth_loop_impedance_ze',
              value: '16',
              confidence: 0.95,
              source_turn_id: 't1',
            },
          },
          {
            id: 'toolu_ask',
            name: 'ask_user',
            input: {
              question: 'Which board?',
              reason: 'ambiguous_board',
              expected_answer_shape: 'text',
            },
          },
          {
            id: 'toolu_earthing',
            name: 'record_board_reading',
            input: {
              field: 'earthing_arrangement',
              value: 'TN-C-S',
              confidence: 0.95,
              source_turn_id: 't1',
            },
          },
        ]),
        endTurnRound('done'),
      ]);
      const seen = [];
      const dispatcher = jest.fn(async (call) => {
        seen.push(call.tool_call_id);
        return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
      });

      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages: [{ role: 'user', content: 'start' }],
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: baseCtx(),
        logger: makeLogger(),
        sortRecords: () => {
          throw new Error('sort_failed_for_earthing_partition');
        },
      });

      // Earthing first (so the clamp can resolve the band), then the remaining
      // write, then the blocking ask — all three partitions honoured.
      expect(seen).toEqual(['toolu_earthing', 'toolu_ze', 'toolu_ask']);
    });

    // Drift lock: the fallback branch inlines its own copy of the earthing
    // predicate (this module must not depend on stage6-dispatchers.js — that
    // import would drag the whole dispatcher tree into the loop's module graph
    // and into every loop test that mocks dispatchers). Pin the two
    // implementations to the same ordering over a record set that exercises
    // every partition, BOTH board-context boundaries, and the value-shaped edge
    // cases the predicate has to tolerate (an absent / non-string `field`), so
    // changing one without the other fails here. Note the fixture is limited to
    // shapes the STREAM ASSEMBLER can actually produce — a null record or a
    // non-object `input` never reaches this branch, so pinning those here would
    // be theatre; they are covered as direct predicate calls in
    // stage6-impedance-clamp.test.js.
    test('emergency fallback ordering === createSortRecordsAsksLast ordering (drift lock)', async () => {
      const { createSortRecordsAsksLast } = await import('../extraction/stage6-dispatchers.js');
      const records = [
        { id: 'a', name: 'record_reading', input: { field: 'measured_zs_ohm' } },
        { id: 'b', name: 'ask_user', input: { question: 'q' } },
        { id: 'c', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
        { id: 'd', name: 'record_board_reading', input: { field: 'earth_loop_impedance_ze' } },
        // edge shapes the predicate must tolerate without throwing
        { id: 'e', name: 'record_board_reading', input: {} },
        { id: 'f', name: 'record_board_reading', input: { field: 42 } },
        { id: 'g', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
        // board-context boundary: 'h' pins in place, so 'i' may NOT be hoisted
        // ahead of it (record_board_reading resolves its target board from
        // snapshot.currentBoardId, which add_board mutates).
        { id: 'h', name: 'add_board', input: { designation: 'Garage' } },
        { id: 'i', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
        { id: 'j', name: 'record_board_reading', input: { field: 'ze_at_db' } },
        { id: 'k', name: 'select_board', input: { board_id: 'main' } },
        { id: 'l', name: 'record_board_reading', input: { field: 'earth_loop_impedance_ze' } },
      ];

      const client = mockClient([toolUseRound(records), endTurnRound('done')]);
      const seen = [];
      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages: [{ role: 'user', content: 'start' }],
        tools: TOOL_SCHEMAS,
        dispatcher: jest.fn(async (call) => {
          seen.push(call.tool_call_id);
          return { tool_use_id: call.tool_call_id, content: '{"ok":true}', is_error: false };
        }),
        ctx: baseCtx(),
        logger: makeLogger(),
        sortRecords: () => {
          throw new Error('sort_failed_drift_lock');
        },
      });

      const hookOrder = createSortRecordsAsksLast()(records).map((r) => r.id);
      // Explicit expectation as well as cross-equality: a bare `seen ===
      // hookOrder` would still pass if BOTH regressed to identity order.
      expect(hookOrder).toEqual(['c', 'g', 'a', 'd', 'e', 'f', 'h', 'i', 'j', 'k', 'l', 'b']);
      expect(seen).toEqual(hookOrder);
    });
  });

  test('dispatcher error path → tool_result with is_error:true, loop continues', async () => {
    const client = mockClient([
      toolUseRound([
        {
          id: 'toolu_err',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 1,
            value: '0.43',
            confidence: 0.9,
            source_turn_id: 't1',
          },
        },
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
      })
    );
  });
});

// ---------------------------------------------------------------------------
// F7 Item 3 — AbortController signal-consumer proofs.
// ---------------------------------------------------------------------------

import {
  ExtractionCancelledError,
  isStage6FatalControlFlowError,
} from '../extraction/stage6-control-flow-errors.js';

/** A client that records the request-options (2nd arg) of every stream call. */
function recordingClient(streamResponses) {
  let callCount = 0;
  const optionsSeen = [];
  return {
    optionsSeen,
    messages: {
      stream(args, options) {
        optionsSeen.push(options);
        const events = streamResponses[callCount] ?? [];
        callCount += 1;
        return mockStream(events);
      },
    },
  };
}

describe('stage6-tool-loop — F7 Item 3 cancellation signal', () => {
  test('a later-round transport failure carries prior billed response evidence and identity', async () => {
    const firstRound = toolUseRound([
      { id: 'toolu_1', name: 'record_reading', input: { field: 'x' } },
    ]);
    firstRound[0].message.usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 0,
    };
    firstRound.find((event) => event.type === 'message_delta').usage = { output_tokens: 10 };
    let callCount = 0;
    const client = {
      messages: {
        stream() {
          callCount += 1;
          if (callCount === 1) return mockStream(firstRound);
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  throw new Error('round-two transport failure');
                },
              };
            },
            async finalMessage() {
              throw new Error('unreachable');
            },
          };
        },
      },
    };

    let caught;
    try {
      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        billingIdentity: 'bill-loop-1',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOL_SCHEMAS,
        dispatcher: jest.fn(NOOP_DISPATCHER),
        ctx: baseCtx(),
        logger: makeLogger(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught.message).toBe('round-two transport failure');
    expect(caught.billableUsage).toEqual(
      expect.objectContaining({
        billing_identity: 'bill-loop-1',
        completed_model_rounds: 1,
        round_usage: [
          expect.objectContaining({
            round_idx: 0,
            fresh_input_tokens: 100,
            cache_read_input_tokens: 30,
            cache_write_input_tokens: 20,
            output_tokens: 10,
          }),
        ],
      })
    );
  });

  test('the exact signal is passed to EVERY client.messages.stream call', async () => {
    const client = recordingClient([
      toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
      endTurnRound('ok'),
    ]);
    const ac = new AbortController();
    await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
      signal: ac.signal,
    });
    // Two rounds → two stream calls, each carrying { signal }.
    expect(client.optionsSeen).toHaveLength(2);
    for (const opt of client.optionsSeen) expect(opt.signal).toBe(ac.signal);
  });

  test('an already-aborted signal prevents any new round (stream never called)', async () => {
    const client = recordingClient([endTurnRound('ok')]);
    const ac = new AbortController();
    ac.abort(new ExtractionCancelledError('pre-aborted'));
    await expect(
      runToolLoop({
        client,
        model: 'm',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOL_SCHEMAS,
        dispatcher: jest.fn(NOOP_DISPATCHER),
        ctx: baseCtx(),
        logger: makeLogger(),
        signal: ac.signal,
      })
    ).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(client.optionsSeen).toHaveLength(0); // never entered a round
  });

  test('a fatal control-flow error thrown from a dispatcher is RETHROWN, not converted to a dispatcher_error tool result', async () => {
    const client = mockClient([
      toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
      endTurnRound('ok'),
    ]);
    const dispatcher = jest.fn(async () => {
      throw new ExtractionCancelledError('cancelled mid-dispatch');
    });
    let caught;
    try {
      await runToolLoop({
        client,
        model: 'm',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOL_SCHEMAS,
        dispatcher,
        ctx: baseCtx(),
        logger: makeLogger(),
      });
    } catch (e) {
      caught = e;
    }
    expect(isStage6FatalControlFlowError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(ExtractionCancelledError);
  });

  test('an APIUserAbortError-shaped stream rejection while aborted is canonicalised to ExtractionCancelledError', async () => {
    const ac = new AbortController();
    // A client whose stream rejects on iteration (simulating the SDK's
    // APIUserAbortError) AFTER the signal is aborted.
    const client = {
      messages: {
        stream() {
          ac.abort(new ExtractionCancelledError('ceiling'));
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  // The SDK rejects iteration with APIUserAbortError post-abort.
                  return Promise.reject(
                    Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
                  );
                },
              };
            },
            async finalMessage() {
              throw new Error('unused');
            },
          };
        },
      },
    };
    let caught;
    try {
      await runToolLoop({
        client,
        model: 'm',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOL_SCHEMAS,
        dispatcher: jest.fn(NOOP_DISPATCHER),
        ctx: baseCtx(),
        logger: makeLogger(),
        signal: ac.signal,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtractionCancelledError);
  });
});

// ---------------------------------------------------------------------------
// Plan 08A — per-round instrumentation.
//
// Three additive telemetry surfaces, one describe block:
//   * reasoning_tokens end-to-end through the round-usage allowlist
//   * first_tool_use_ns (think-time vs emit-time split)
//   * a timing row on ALL SEVEN post-completion exits, + the ask_user label
//
// The load-bearing property throughout is that these are additive: no
// behaviour changes, `dispatch_ms` keeps its old meaning, and every `_ns`
// field is a decimal STRING because production serialises telemetry metadata
// with JSON.stringify (src/logger.js), which throws on BigInt.
// ---------------------------------------------------------------------------

/** Attach Anthropic-shaped usage to a fixture round (message_start + delta). */
function withUsage(events, { input = 10, output = 5, reasoning } = {}) {
  const copy = events.map((e) => ({ ...e }));
  copy[0] = {
    ...copy[0],
    message: {
      ...copy[0].message,
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  const deltaIdx = copy.findIndex((e) => e.type === 'message_delta');
  const usage = { output_tokens: output };
  if (reasoning !== undefined) usage.reasoning_tokens = reasoning;
  copy[deltaIdx] = { ...copy[deltaIdx], usage };
  return copy;
}

/** A round that claims stop_reason:'tool_use' but streams ZERO tool_use blocks. */
function toolUseStopWithNoBlocks() {
  return [
    { type: 'message_start', message: { id: 'msg_empty', role: 'assistant', content: [] } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/** Every `_ns` field is a decimal string or null — never a BigInt. */
function assertNsFieldsSerialisable(timing) {
  for (const key of ['started_ns', 'stream_complete_ns', 'dispatch_complete_ns']) {
    expect(typeof timing[key]).toBe('string');
    expect(timing[key]).toMatch(/^\d+$/);
  }
  expect(timing.first_tool_use_ns === null || /^\d+$/.test(timing.first_tool_use_ns)).toBe(true);
}

describe('stage6-tool-loop — Plan 08A reasoning_tokens attribution', () => {
  test('a provider-reported reasoning_tokens reaches round_usage unchanged', async () => {
    const client = mockClient([withUsage(endTurnRound('ok'), { output: 101, reasoning: 87 })]);
    const result = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.round_usage[0].reasoning_tokens).toBe(87);
    // output_tokens keeps its existing meaning and value EXACTLY — reasoning is
    // surfaced ALONGSIDE it, never subtracted from it, or every CostTracker
    // input silently changes.
    expect(result.round_usage[0].output_tokens).toBe(101);
  });

  test('a provider-reported 0 stays 0 — it is a real measurement, not a missing one', async () => {
    const client = mockClient([withUsage(endTurnRound('ok'), { output: 4, reasoning: 0 })]);
    const result = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.round_usage[0].reasoning_tokens).toBe(0);
    expect(result.round_usage[0].reasoning_tokens).not.toBeNull();
  });

  test('an unreported reasoning_tokens attributes null, never a fabricated 0', async () => {
    // Anthropic never reports reasoning tokens; null is the honest answer and
    // an explicit null SURVIVES JSON.stringify, where undefined would vanish
    // from the CloudWatch row entirely.
    const client = mockClient([withUsage(endTurnRound('ok'), { output: 5 })]);
    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.round_usage[0].reasoning_tokens).toBeNull();
    expect('reasoning_tokens' in result.round_usage[0]).toBe(true);
    expect(JSON.parse(JSON.stringify(result.round_usage[0])).reasoning_tokens).toBeNull();
  });
});

describe('stage6-tool-loop — Plan 08A first_tool_use_ns', () => {
  test('a no-tool round emits null; a tool-emitting round emits a decimal string', async () => {
    const client = mockClient([
      toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
      endTurnRound('ok'),
    ]);
    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    const [tooling, terminal] = result.round_timings;
    expect(typeof tooling.first_tool_use_ns).toBe('string');
    expect(tooling.first_tool_use_ns).toMatch(/^\d+$/);
    // The stamp is taken during the stream, so it must fall inside the round.
    expect(BigInt(tooling.first_tool_use_ns)).toBeGreaterThanOrEqual(BigInt(tooling.started_ns));
    expect(BigInt(tooling.first_tool_use_ns)).toBeLessThanOrEqual(
      BigInt(tooling.stream_complete_ns)
    );
    // The terminal round streams text only — no honest first-content marker.
    expect(terminal.first_tool_use_ns).toBeNull();
  });

  test('the stamp is the FIRST tool_use block of the round, not the last', async () => {
    const client = mockClient([
      toolUseRound([
        { id: 'toolu_1', name: 'record_reading', input: { field: 'a' } },
        { id: 'toolu_2', name: 'record_reading', input: { field: 'b' } },
        { id: 'toolu_3', name: 'record_reading', input: { field: 'c' } },
      ]),
      endTurnRound('ok'),
    ]);
    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    // Luna batches up to four calls per round; if the stamp tracked the LAST
    // block it would absorb the emit time of the whole batch and the
    // think-time/emit-time split 08B needs would be meaningless.
    const [batched] = result.round_timings;
    expect(typeof batched.first_tool_use_ns).toBe('string');
    expect(BigInt(batched.first_tool_use_ns)).toBeLessThan(BigInt(batched.stream_complete_ns));
  });
});

describe('stage6-tool-loop — Plan 08A timing rows on all seven exits', () => {
  const baseArgs = () => ({
    model: 'claude-sonnet-4-6',
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOL_SCHEMAS,
    ctx: baseCtx(),
    logger: makeLogger(),
  });

  test('path 1 — end_turn: one row, dispatch_complete === stream_complete, dispatch_ms 0', async () => {
    const result = await runToolLoop({
      ...baseArgs(),
      client: mockClient([endTurnRound('done')]),
      dispatcher: jest.fn(NOOP_DISPATCHER),
    });

    expect(result.round_timings).toHaveLength(1);
    expect(result.round_timings).toHaveLength(result.rounds);
    const [row] = result.round_timings;
    // Byte-for-byte the pre-08A shape on this path: no dispatcher runs, so
    // dispatch_complete defaults to stream_complete and dispatch_ms is 0.
    expect(row.dispatch_complete_ns).toBe(row.stream_complete_ns);
    expect(row.dispatch_ms).toBe(0);
    expect(row.round_idx).toBe(0);
    expect(row.blocking_ask_user_dispatched).toBe(false);
    assertNsFieldsSerialisable(row);
  });

  test('path 2 — cap reached with a tool_use stop_reason but no tool_use blocks', async () => {
    const result = await runToolLoop({
      ...baseArgs(),
      client: mockClient([toolUseStopWithNoBlocks()]),
      dispatcher: jest.fn(NOOP_DISPATCHER),
      maxRounds: 1,
    });

    expect(result.aborted).toBe(true);
    // Before 08A this protocol violation left the paid-for round with a null
    // timing — invisible in every percentile computed from round_usage.
    expect(result.round_timings).toHaveLength(1);
    expect(result.round_timings[0].round_idx).toBe(0);
    expect(result.round_timings[0].dispatch_ms).toBe(0);
    expect(result.round_usage[0].timing).toBe(result.round_timings[0]);
    assertNsFieldsSerialisable(result.round_timings[0]);
  });

  test('path 3 — cap hit: every round measured, and held calls are never labelled as dispatched', async () => {
    const result = await runToolLoop({
      ...baseArgs(),
      client: mockClient([
        toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
        toolUseRound([{ id: 'toolu_2', name: 'ask_user', input: { question: 'which circuit?' } }]),
      ]),
      dispatcher: jest.fn(NOOP_DISPATCHER),
      maxRounds: 2,
    });

    expect(result.aborted).toBe(true);
    expect(result.round_timings).toHaveLength(2);
    expect(result.round_timings.map((t) => t.round_idx)).toEqual([0, 1]);
    // The cap round's ask_user was answered with a synthetic abort, never
    // dispatched — so the round did NOT park on a human and must not claim to.
    expect(result.round_timings[1].blocking_ask_user_dispatched).toBe(false);
    expect(result.round_timings[1].dispatch_ms).toBe(0);
  });

  test('path 4 — cancelled before dispatch: the billed round carries its own timing', async () => {
    const ac = new AbortController();
    const events = toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]);
    const client = {
      messages: {
        stream() {
          const base = mockStream(events);
          return {
            async *[Symbol.asyncIterator]() {
              for await (const ev of base) yield ev;
              // Abort AFTER the stream completes: the round is paid for, but
              // the pre-dispatch guard rejects before any tool runs. This is
              // what a barge-in produces.
              ac.abort(new ExtractionCancelledError('barge-in'));
            },
            finalMessage: () => base.finalMessage(),
          };
        },
      },
    };

    let caught;
    try {
      await runToolLoop({
        ...baseArgs(),
        client,
        dispatcher: jest.fn(NOOP_DISPATCHER),
        signal: ac.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExtractionCancelledError);
    // Finalisation runs BEFORE attachBillableUsage, so the round the caller is
    // billed for is the round the caller can measure.
    expect(caught.billableUsage.round_usage).toHaveLength(1);
    expect(caught.billableUsage.round_usage[0].timing).not.toBeNull();
    expect(caught.billableUsage.round_usage[0].timing.round_idx).toBe(0);
    assertNsFieldsSerialisable(caught.billableUsage.round_usage[0].timing);
  });

  test('path 5 — a fatal dispatcher error rethrows with the round timed exactly once', async () => {
    const dispatcher = jest.fn(async () => {
      throw new ExtractionCancelledError('cancelled mid-dispatch');
    });

    let caught;
    try {
      await runToolLoop({
        ...baseArgs(),
        client: mockClient([
          toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
        ]),
        dispatcher,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExtractionCancelledError);
    const rows = caught.billableUsage.round_usage;
    expect(rows).toHaveLength(1);
    expect(rows[0].timing).not.toBeNull();
    // Dispatch time genuinely elapsed here, so it is stamped rather than
    // defaulted — dispatch_complete moves past stream_complete.
    expect(BigInt(rows[0].timing.dispatch_complete_ns)).toBeGreaterThanOrEqual(
      BigInt(rows[0].timing.stream_complete_ns)
    );
    expect(rows[0].timing.dispatch_ms).toBeGreaterThanOrEqual(0);
  });

  test('path 6 — tool_use stop_reason with no tool_use blocks below the cap', async () => {
    const result = await runToolLoop({
      ...baseArgs(),
      client: mockClient([toolUseStopWithNoBlocks()]),
      dispatcher: jest.fn(NOOP_DISPATCHER),
    });

    expect(result.aborted).toBe(true);
    expect(result.rounds).toBe(1);
    expect(result.round_timings).toHaveLength(1);
    assertNsFieldsSerialisable(result.round_timings[0]);
  });

  test('path 7 — normal continuation: one row per round, indices in order, no duplicates', async () => {
    const result = await runToolLoop({
      ...baseArgs(),
      client: mockClient([
        toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]),
        toolUseRound([{ id: 'toolu_2', name: 'record_reading', input: { field: 'y' } }]),
        endTurnRound('ok'),
      ]),
      dispatcher: jest.fn(NOOP_DISPATCHER),
    });

    expect(result.rounds).toBe(3);
    expect(result.round_timings).toHaveLength(3);
    expect(result.round_timings.map((t) => t.round_idx)).toEqual([0, 1, 2]);
    // Each round's usage row points at ITS OWN timing row, never a neighbour's.
    result.round_usage.forEach((u, i) => {
      expect(u.timing).toBe(result.round_timings[i]);
      expect(u.timing.round_idx).toBe(u.round_idx);
    });
  });
});

describe('stage6-tool-loop — Plan 08A blocking_ask_user_dispatched', () => {
  test('a dispatched ask_user labels its own round and only its own round', async () => {
    const client = mockClient([
      toolUseRound([{ id: 'toolu_1', name: 'ask_user', input: { question: 'which circuit?' } }]),
      toolUseRound([{ id: 'toolu_2', name: 'record_reading', input: { field: 'x' } }]),
      endTurnRound('ok'),
    ]);
    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    // The flag is per-round state, so it must NOT leak forward into the
    // write-only round or the terminal round — those are server work.
    expect(result.round_timings.map((t) => t.blocking_ask_user_dispatched)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('ask rounds are labelled, never dropped', async () => {
    const result = await runToolLoop({
      client: mockClient([
        toolUseRound([{ id: 'toolu_1', name: 'ask_user', input: { question: 'q?' } }]),
        endTurnRound('ok'),
      ]),
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    // Dropping ask rounds would hide the slowest turns and let a later plan
    // claim an improvement it did not make.
    expect(result.round_timings).toHaveLength(result.rounds);
    expect(result.round_timings[0].blocking_ask_user_dispatched).toBe(true);
    expect(result.round_timings[0]).toHaveProperty('dispatch_ms');
  });
});

describe('stage6-tool-loop — Plan 08A production serialisation', () => {
  test('both emitted round arrays survive JSON.stringify with null, 0 and a decimal string', async () => {
    const client = mockClient([
      // Round 0: tool_use (first_tool_use_ns = decimal string) + reasoning 0.
      withUsage(toolUseRound([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }]), {
        output: 40,
        reasoning: 0,
      }),
      // Round 1: text-only terminal (first_tool_use_ns = null) + reasoning 12.
      withUsage(endTurnRound('ok'), { output: 4, reasoning: 12 }),
    ]);
    const result = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    // This is the exact operation src/logger.js performs on telemetry
    // metadata. A BigInt anywhere in either array throws
    // "Do not know how to serialize a BigInt" and takes the live turn down.
    expect(() => JSON.stringify(result.round_timings)).not.toThrow();
    expect(() => JSON.stringify(result.round_usage)).not.toThrow();

    const timings = JSON.parse(JSON.stringify(result.round_timings));
    const usage = JSON.parse(JSON.stringify(result.round_usage));

    // The three values the round-trip has to preserve distinctly.
    expect(timings[1].first_tool_use_ns).toBeNull();
    expect(typeof timings[0].first_tool_use_ns).toBe('string');
    expect(usage[0].reasoning_tokens).toBe(0);
    expect(usage[1].reasoning_tokens).toBe(12);

    timings.forEach(assertNsFieldsSerialisable);
    usage.forEach((row) => assertNsFieldsSerialisable(row.timing));
  });
});
