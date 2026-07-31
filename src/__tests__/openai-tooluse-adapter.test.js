/**
 * OpenAI tool-use adapter — proves the adapter satisfies the Anthropic
 * MessageStream contract that `runToolLoop` + `createAssembler` depend on,
 * driving the REAL loop (not a mock) with a mocked OpenAI client underneath.
 *
 * WHY these tests: the adapter is the single seam that lets a `gpt-*` model
 * run the Stage 6 extraction loop. If its synthesized event sequence drifts
 * from what the assembler consumes, tool calls silently vanish (spoken-but-
 * not-written / never-written) — exactly the Audio-First failure class the
 * whole pipeline guards against. So we assert end-to-end: a mocked OpenAI
 * tool_calls response -> real assembler -> real runToolLoop -> dispatched
 * tool call with the right name/input, correct stop_reason, and mapped usage.
 */
import { jest } from '@jest/globals';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { _internals } from '../extraction/openai-tooluse-adapter.js';

// A record_reading tool call, in OpenAI shape.
const OPENAI_TOOLCALL_RESPONSE = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: {
              name: 'record_reading',
              arguments: JSON.stringify({
                field: 'measured_zs_ohm',
                circuit_ref: '4',
                value: '0.63',
              }),
            },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 1000 },
  },
};

// A follow-up end_turn response (the loop re-invokes after tool_result).
const OPENAI_ENDTURN_RESPONSE = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Recorded.' } }],
  usage: {
    prompt_tokens: 1300,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 1200 },
  },
};

/**
 * Build a working adapter object (messages.stream) backed by a scripted
 * OpenAI create() stub, reusing the adapter's OWN translation internals so
 * the test exercises the real request/response mapping, not a re-implementation.
 */
function buildTestAdapter(responses) {
  let call = 0;
  const create = jest.fn(async (payload) => {
    // sanity: the payload must be OpenAI-shaped (function tools, translated messages)
    expect(Array.isArray(payload.messages)).toBe(true);
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return r;
  });
  // Mirror createStream from the module (kept in lockstep via _internals).
  const messages = {
    stream(streamArgs, options) {
      const { model, max_tokens, system, messages: msgs, tools } = streamArgs;
      const requestPayload = {
        model,
        messages: _internals.toOpenAIMessages(system, msgs),
        tools: _internals.toOpenAITools(tools),
        tool_choice: 'auto',
        max_completion_tokens: max_tokens || 4096,
      };
      let resultPromise = null;
      const run = () => {
        if (!resultPromise) {
          resultPromise = create(requestPayload, options).then((resp) => {
            const choice = resp.choices?.[0];
            const message = choice?.message || {};
            return {
              message,
              stopReason: _internals.mapFinishReason(choice?.finish_reason),
              usage: _internals.mapUsage(resp.usage),
              content: _internals.buildAnthropicContent(message),
            };
          });
        }
        return resultPromise;
      };
      return {
        async *[Symbol.asyncIterator]() {
          const { message, stopReason } = await run();
          for (const ev of _internals.synthesizeEvents(message, stopReason)) yield ev;
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

describe('openai-tooluse-adapter — request translation', () => {
  test('flattenSystem handles string and text-block array', () => {
    expect(_internals.flattenSystem('hello')).toBe('hello');
    expect(
      _internals.flattenSystem([
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
      ])
    ).toBe('AB');
  });

  test('toOpenAITools maps Anthropic input_schema -> function.parameters', () => {
    const out = _internals.toOpenAITools([
      {
        name: 'record_reading',
        description: 'd',
        input_schema: { type: 'object', properties: { field: {} } },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'record_reading',
          description: 'd',
          parameters: { type: 'object', properties: { field: {} } },
        },
      },
    ]);
  });

  test('toOpenAIMessages translates assistant tool_use + user tool_result round-trip', () => {
    const out = _internals.toOpenAIMessages('SYS', [
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
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'Zs on circuit 4 is 0.63' });
    expect(out[2].role).toBe('assistant');
    expect(out[2].tool_calls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'record_reading', arguments: JSON.stringify({ field: 'measured_zs_ohm' }) },
    });
    expect(out[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({ ok: true }),
    });
  });

  test('mapFinishReason maps the branches runToolLoop cares about', () => {
    expect(_internals.mapFinishReason('tool_calls')).toBe('tool_use');
    expect(_internals.mapFinishReason('stop')).toBe('end_turn');
    expect(_internals.mapFinishReason('length')).toBe('max_tokens');
  });

  test('mapUsage splits cached reads out of input_tokens', () => {
    expect(
      _internals.mapUsage({
        prompt_tokens: 1200,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 1000 },
      })
    ).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1000,
    });
  });
});

describe('openai-tooluse-adapter — drives the REAL runToolLoop', () => {
  test('a gpt tool_calls response dispatches record_reading, then end_turn terminates', async () => {
    const { client } = buildTestAdapter([OPENAI_TOOLCALL_RESPONSE, OPENAI_ENDTURN_RESPONSE]);
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

    // The loop dispatched exactly the record_reading call the OpenAI stub emitted.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].name).toBe('record_reading');
    expect(dispatched[0].input).toEqual({
      field: 'measured_zs_ohm',
      circuit_ref: '4',
      value: '0.63',
    });

    // Terminated on end_turn, two rounds, usage summed across both.
    expect(out.stop_reason).toBe('end_turn');
    expect(out.rounds).toBe(2);
    expect(out.aborted).toBe(false);
    expect(out.tool_calls).toHaveLength(1);
    expect(out.usage.output_tokens).toBe(50); // 40 + 10
    expect(out.usage.cache_read_input_tokens).toBe(2200); // 1000 + 1200

    // messages_final is well-formed: user, assistant(tool_use), user(tool_result), assistant(text)
    const mf = out.messages_final;
    expect(mf[1].role).toBe('assistant');
    expect(mf[1].content[0].type).toBe('tool_use');
    expect(mf[2].role).toBe('user');
    expect(mf[2].content[0].type).toBe('tool_result');
    expect(mf[2].content[0].tool_use_id).toBe('call_abc123');
  });

  test('invalid tool-call JSON surfaces as an error tool_result, never a crash', async () => {
    const badResponse = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: { name: 'record_reading', arguments: '{"field":' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    };
    const { client } = buildTestAdapter([badResponse, OPENAI_ENDTURN_RESPONSE]);
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

    // Invalid JSON -> assembler error record -> NOT dispatched, error tool_result appended.
    expect(dispatcher).not.toHaveBeenCalled();
    const toolResultMsg = out.messages_final.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    );
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(out.aborted).toBe(false);
  });
});
