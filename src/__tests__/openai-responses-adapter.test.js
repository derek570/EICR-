/**
 * OpenAI Responses-API tool-use adapter — proves it satisfies the Anthropic
 * MessageStream contract that `runToolLoop` + `createAssembler` depend on,
 * driving the REAL loop (not a mock) with a mocked `client.responses.create`.
 *
 * WHY this adapter exists: verified live 2026-07-31 that gpt-5.6-luna on
 * /v1/chat/completions rejects function tools unless reasoning_effort is
 * 'none' — forcing reasoning off caused Luna to loop to the tool-loop cap
 * instead of ever emitting end_turn. /v1/responses allows reasoning WITH
 * tools; this suite pins the translation both directions AND the
 * reasoning-item round-trip that makes multi-round continuity work.
 */
import { jest } from '@jest/globals';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { _internals } from '../extraction/openai-responses-adapter.js';

// Round 1: model reasons, then emits one function_call.
const RESPONSES_ROUND1 = {
  output: [
    { type: 'reasoning', id: 'rs_1', content: [], encrypted_content: 'enc_abc', summary: [] },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_xyz',
      name: 'record_reading',
      arguments: JSON.stringify({ field: 'measured_zs_ohm', circuit_ref: '4', value: '0.63' }),
      status: 'completed',
    },
  ],
  usage: {
    input_tokens: 2065,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2062 },
    output_tokens: 55,
    output_tokens_details: { reasoning_tokens: 25 },
  },
};

// Round 2: clean end_turn with a text message (no more function_call items).
const RESPONSES_ROUND2 = {
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recorded.' }] },
  ],
  usage: {
    input_tokens: 2065,
    input_tokens_details: { cached_tokens: 2047, cache_write_tokens: 15 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

function buildTestAdapter(responses) {
  let call = 0;
  const create = jest.fn(async (payload) => {
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.reasoning).toBeDefined();
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return r;
  });
  const messages = {
    stream(streamArgs, options) {
      const { model, max_tokens, system, messages: msgs, tools } = streamArgs;
      const requestPayload = {
        model,
        instructions: _internals.flattenSystem(system),
        input: _internals.toResponsesInput(msgs),
        tools: _internals.toResponsesTools(tools),
        tool_choice: 'auto',
        max_output_tokens: Math.max((max_tokens || 4096) * 4, 8192),
        reasoning: { effort: 'low' },
      };
      let resultPromise = null;
      const run = () => {
        if (!resultPromise) {
          resultPromise = create(requestPayload, options).then((resp) => ({
            resp,
            stopReason: _internals.mapStopReason(resp),
            usage: _internals.mapUsage(resp.usage),
            content: _internals.buildAnthropicContent(resp),
          }));
        }
        return resultPromise;
      };
      return {
        async *[Symbol.asyncIterator]() {
          const { resp, stopReason } = await run();
          for (const ev of _internals.synthesizeEvents(resp, stopReason)) yield ev;
        },
        async finalMessage() {
          const { content, usage, stopReason } = await run();
          return { content, usage, stop_reason: stopReason, role: 'assistant' };
        },
      };
    },
  };
  return { client: { messages }, create };
}

describe('openai-responses-adapter — request/response translation', () => {
  test('toResponsesTools is FLAT (no nested function key)', () => {
    const out = _internals.toResponsesTools([
      {
        name: 'record_reading',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        name: 'record_reading',
        description: 'd',
        parameters: { type: 'object', properties: {} },
      },
    ]);
  });

  test('toResponsesInput translates tool_use -> function_call and tool_result -> function_call_output', () => {
    const out = _internals.toResponsesInput([
      { role: 'user', content: 'Zs on circuit 4 is 0.63' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'record_reading',
            input: { field: 'measured_zs_ohm' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: JSON.stringify({ ok: true }),
            is_error: false,
          },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: 'user', content: 'Zs on circuit 4 is 0.63' });
    expect(out[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'record_reading',
      arguments: JSON.stringify({ field: 'measured_zs_ohm' }),
    });
    expect(out[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ ok: true }),
    });
  });

  test('toResponsesInput echoes a reasoning block back BEFORE its function_call sibling', () => {
    const out = _internals.toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_abc' },
          { type: 'tool_use', id: 'call_1', name: 'record_reading', input: {} },
        ],
      },
    ]);
    expect(out[0]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      content: [],
      encrypted_content: 'enc_abc',
      summary: [],
    });
    expect(out[1].type).toBe('function_call');
  });

  test('mapStopReason: function_call present -> tool_use; absent -> end_turn; incomplete -> max_tokens', () => {
    expect(_internals.mapStopReason({ output: [{ type: 'function_call' }] })).toBe('tool_use');
    expect(_internals.mapStopReason({ output: [{ type: 'message' }] })).toBe('end_turn');
    expect(
      _internals.mapStopReason({ output: [], incomplete_details: { reason: 'max_output_tokens' } })
    ).toBe('max_tokens');
  });

  test('buildAnthropicContent preserves reasoning-then-tool_use order', () => {
    const blocks = _internals.buildAnthropicContent(RESPONSES_ROUND1);
    expect(blocks[0]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_abc' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_xyz',
      name: 'record_reading',
      input: { field: 'measured_zs_ohm', circuit_ref: '4', value: '0.63' },
    });
  });

  test('mapUsage: input_tokens is INCLUSIVE — subtract cached + write to get the fresh remainder', () => {
    // Verified live 2026-07-31: cache-cold call had input_tokens=2065,
    // cache_write_tokens=2062, cached=0 (fresh remainder = 3).
    expect(_internals.mapUsage(RESPONSES_ROUND1.usage)).toEqual({
      input_tokens: 3,
      output_tokens: 55,
      cache_creation_input_tokens: 2062,
      cache_read_input_tokens: 0,
    });
    // Cache-warm call: input_tokens=2065, cached=2047, write=15 (fresh remainder = 3).
    expect(_internals.mapUsage(RESPONSES_ROUND2.usage)).toEqual({
      input_tokens: 3,
      output_tokens: 10,
      cache_creation_input_tokens: 15,
      cache_read_input_tokens: 2047,
    });
  });
});

describe('openai-responses-adapter — drives the REAL runToolLoop across two rounds', () => {
  test('round 1 dispatches record_reading (reasoning present, tool_use surfaced); round 2 ends cleanly', async () => {
    const { client, create } = buildTestAdapter([RESPONSES_ROUND1, RESPONSES_ROUND2]);
    const dispatched = [];
    const dispatcher = async (call) => {
      dispatched.push(call);
      return {
        tool_use_id: call.tool_call_id,
        content: JSON.stringify({ ok: true }),
        is_error: false,
      };
    };

    const out = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      system: 'SYS',
      messages: [{ role: 'user', content: 'Zs on circuit 4 is 0.63' }],
      tools: [
        {
          name: 'record_reading',
          description: 'record a reading',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      dispatcher,
      ctx: { sessionId: 's1', turnId: 't1' },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].name).toBe('record_reading');
    expect(dispatched[0].input).toEqual({
      field: 'measured_zs_ohm',
      circuit_ref: '4',
      value: '0.63',
    });

    // The DECISIVE assertion: with reasoning present and round-tripped, the
    // loop reaches end_turn in 2 rounds — no looping to the cap.
    expect(out.stop_reason).toBe('end_turn');
    expect(out.rounds).toBe(2);
    expect(out.aborted).toBe(false);

    // Usage summed across both rounds using the inclusive-input-tokens math.
    expect(out.usage.output_tokens).toBe(65); // 55 + 10
    expect(out.usage.cache_read_input_tokens).toBe(2047); // only round 2 had a cache hit
    expect(out.usage.cache_creation_input_tokens).toBe(2077); // 2062 + 15

    // Round 2's request must carry the reasoning item echoed back BEFORE the
    // function_call it followed, proving continuity actually round-tripped
    // through messages_final (not just through the mock's shared closure).
    const round2Payload = create.mock.calls[1][0];
    const reasoningIdx = round2Payload.input.findIndex((i) => i.type === 'reasoning');
    const functionCallIdx = round2Payload.input.findIndex((i) => i.type === 'function_call');
    const outputIdx = round2Payload.input.findIndex((i) => i.type === 'function_call_output');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(functionCallIdx);
    expect(functionCallIdx).toBeLessThan(outputIdx);
    expect(round2Payload.input[reasoningIdx].encrypted_content).toBe('enc_abc');
  });

  test('invalid tool-call JSON surfaces as an error tool_result, never a crash', async () => {
    const badResponse = {
      output: [
        {
          type: 'function_call',
          call_id: 'call_bad',
          name: 'record_reading',
          arguments: '{"field":',
        },
      ],
      usage: {
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 5,
      },
    };
    const { client } = buildTestAdapter([badResponse, RESPONSES_ROUND2]);
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: '{}',
      is_error: false,
    }));

    const out = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      system: 'SYS',
      messages: [{ role: 'user', content: 'garbled' }],
      tools: [
        {
          name: 'record_reading',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      dispatcher,
      ctx: { sessionId: 's1', turnId: 't1' },
    });

    expect(dispatcher).not.toHaveBeenCalled();
    const toolResultMsg = out.messages_final.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    );
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(out.aborted).toBe(false);
  });
});
