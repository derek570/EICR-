/**
 * OpenAI Responses-API tool-use adapter — proves it satisfies the Anthropic
 * MessageStream contract that `runToolLoop` + `createAssembler` depend on,
 * driving the REAL loop (not a mock) with a mocked `client.responses.stream`
 * emitting REAL SSE-shaped events (not a buffered response).
 *
 * WHY this adapter exists: verified live 2026-07-31 that gpt-5.6-luna on
 * /v1/chat/completions rejects function tools unless reasoning_effort is
 * 'none' — forcing reasoning off caused Luna to loop to the tool-loop cap
 * instead of ever emitting end_turn. /v1/responses allows reasoning WITH
 * tools; this suite pins the translation both directions AND the
 * reasoning-item round-trip that makes multi-round continuity work.
 *
 * WHY real streaming (not buffer-then-synthesize): production runs with
 * Loaded Barrel (VOICE_LATENCY_LOADED_BARREL=true), which pre-synthesizes
 * confirmation TTS the MOMENT a tool_use's content_block_stop fires
 * mid-stream. A buffered adapter can't give that advantage — the decisive
 * test below proves tool_use blocks become assembler-visible (and therefore
 * Loaded-Barrel-visible) BEFORE the full response is buffered via
 * finalResponse(), not after.
 */
import { jest } from '@jest/globals';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { _internals } from '../extraction/openai-responses-adapter.js';
import {
  markOpenAIStableSystemPrefix,
  renderSystemPrompt,
} from '../extraction/system-prompt-renderer.js';

// --- Round 1: reasoning, then one function_call. Streaming events + the
// consistent buffered final response finalResponse() would return. ---
const ROUND1_FINAL = {
  model: 'gpt-5.6-luna-2026-07-15',
  service_tier: 'priority',
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
const ROUND1_STREAM_EVENTS = [
  { type: 'response.created', response: {} },
  { type: 'response.in_progress', response: {} },
  { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
  { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning' } },
  {
    type: 'response.output_item.added',
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_xyz', name: 'record_reading' },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    delta: JSON.stringify({ field: 'measured_zs_ohm', circuit_ref: '4', value: '0.63' }),
  },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1' },
  { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call' } },
  { type: 'response.completed', response: ROUND1_FINAL },
];

// --- Round 2: clean end_turn with a plain text message. ---
const ROUND2_FINAL = {
  model: 'gpt-5.6-luna-2026-07-15',
  service_tier: 'priority',
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
const ROUND2_STREAM_EVENTS = [
  { type: 'response.created', response: {} },
  { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Recorded.' },
  { type: 'response.output_text.done', item_id: 'msg_1' },
  { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
  { type: 'response.completed', response: ROUND2_FINAL },
];

function makeMockOpenAIStream(events, final, { onFinalResponseCalled } = {}) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    finalResponse: async () => {
      onFinalResponseCalled?.();
      return final;
    },
  };
}

/**
 * Build a working adapter object (messages.stream) backed by a scripted
 * openai.responses.stream() stub emitting REAL event/final pairs, reusing the
 * adapter's OWN translation internals so the test exercises the real
 * request/response mapping, not a re-implementation.
 */
function buildTestAdapter(rounds, hooks = {}) {
  let call = 0;
  const streamFn = jest.fn((payload) => {
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.reasoning).toBeDefined();
    const round = rounds[Math.min(call, rounds.length - 1)];
    call += 1;
    return makeMockOpenAIStream(round.events, round.final, hooks);
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
      let openaiStreamPromise = null;
      const getOpenaiStream = () => {
        if (!openaiStreamPromise) {
          openaiStreamPromise = Promise.resolve(streamFn(requestPayload, options));
        }
        return openaiStreamPromise;
      };
      return {
        async *[Symbol.asyncIterator]() {
          const openaiStream = await getOpenaiStream();
          for await (const ev of _internals.translateStreamingEvents(openaiStream)) yield ev;
        },
        async finalMessage() {
          const openaiStream = await getOpenaiStream();
          const finalResp = await openaiStream.finalResponse();
          return _internals.toAnthropicMessage(finalResp, model);
        },
      };
    },
  };
  return { client: { messages }, streamFn };
}

describe('openai-responses-adapter — request/response translation', () => {
  test('system blocks retain order and an explicit boundary', () => {
    expect(_internals.flattenSystem('base')).toBe('base');
    expect(
      _internals.flattenSystem([
        { type: 'text', text: 'BASE SENTINEL' },
        { type: 'text', text: '' },
        { type: 'text', text: 'STABLE PREFIX END' },
        { type: 'text', text: 'EXTRACTED\nPENDING' },
      ])
    ).toBe('BASE SENTINEL\n\nSTABLE PREFIX END\n\nEXTRACTED\nPENDING');
    expect(_internals.flattenSystem([{ type: 'image', data: 'ignored' }])).toBe('');
  });

  test('explicit developer blocks preserve exact prompt bytes and mark only the stable-prefix end', () => {
    const system = markOpenAIStableSystemPrefix(
      [
        { type: 'text', text: 'BASE SENTINEL' },
        { type: 'text', text: 'STABLE PREFIX END' },
        { type: 'text', text: 'EXTRACTED\nPENDING' },
      ],
      2
    );
    const converted = _internals.toExplicitSystemInput(system);
    expect(converted.item.role).toBe('developer');
    expect(converted.item.content.map((block) => block.text).join('')).toBe(
      renderSystemPrompt(system)
    );
    expect(converted.item.content[0]).not.toHaveProperty('prompt_cache_breakpoint');
    expect(converted.item.content[1].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    expect(converted.item.content[2]).not.toHaveProperty('prompt_cache_breakpoint');
    expect(converted.stableText).toBe('BASE SENTINEL\n\nSTABLE PREFIX END');
  });

  test('explicit GPT-5.6 request carries a stable digest key; volatile-tail edits reuse it', async () => {
    const previous = process.env.OPENAI_EXTRACT_PROMPT_CACHE;
    process.env.OPENAI_EXTRACT_PROMPT_CACHE = 'explicit';
    const payloads = [];
    const openai = {
      responses: {
        stream: jest.fn((payload) => {
          payloads.push(payload);
          return makeMockOpenAIStream(ROUND1_STREAM_EVENTS, ROUND1_FINAL);
        }),
      },
    };
    const tools = [{ name: 'record_reading', input_schema: { type: 'object', properties: {} } }];
    const makeSystem = (tail) =>
      markOpenAIStableSystemPrefix(
        [
          { type: 'text', text: 'BASE' },
          { type: 'text', text: 'STABLE' },
          { type: 'text', text: tail },
        ],
        2
      );
    try {
      for (const tail of ['EXTRACTED A', 'EXTRACTED B']) {
        await _internals
          .createStream(openai, {
            model: 'gpt-5.6-luna',
            system: makeSystem(tail),
            messages: [{ role: 'user', content: 'reading' }],
            tools,
          })
          .finalMessage();
      }
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).not.toHaveProperty('instructions');
      expect(payloads[0].prompt_cache_options).toEqual({ mode: 'explicit' });
      expect(payloads[0].prompt_cache_key).toMatch(/^certmate-s6-v1-[a-f0-9]{48}$/);
      expect(payloads[1].prompt_cache_key).toBe(payloads[0].prompt_cache_key);
      expect(payloads[0].input[0].role).toBe('developer');
      expect(payloads[0].input[0].content.map((block) => block.text).join('')).toBe(
        'BASE\n\nSTABLE\n\nEXTRACTED A'
      );
      expect(payloads[0].input[0].content[1].prompt_cache_breakpoint).toEqual({
        mode: 'explicit',
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_EXTRACT_PROMPT_CACHE;
      else process.env.OPENAI_EXTRACT_PROMPT_CACHE = previous;
    }
  });

  test('implicit rollback and non-5.6 models retain the top-level instructions payload', async () => {
    const previous = process.env.OPENAI_EXTRACT_PROMPT_CACHE;
    const payloads = [];
    const openai = {
      responses: {
        stream: jest.fn((payload) => {
          payloads.push(payload);
          return makeMockOpenAIStream(ROUND1_STREAM_EVENTS, ROUND1_FINAL);
        }),
      },
    };
    try {
      process.env.OPENAI_EXTRACT_PROMPT_CACHE = 'implicit';
      await _internals
        .createStream(openai, {
          model: 'gpt-5.6-luna',
          system: 'SYSTEM',
          messages: [],
          tools: [],
        })
        .finalMessage();
      process.env.OPENAI_EXTRACT_PROMPT_CACHE = 'explicit';
      await _internals
        .createStream(openai, {
          model: 'gpt-5.5',
          system: 'SYSTEM',
          messages: [],
          tools: [],
        })
        .finalMessage();
      for (const payload of payloads) {
        expect(payload.instructions).toBe('SYSTEM');
        expect(payload).not.toHaveProperty('prompt_cache_options');
        expect(payload).not.toHaveProperty('prompt_cache_key');
      }
      expect(() => _internals.resolvePromptCacheMode('typo', 'gpt-5.6-luna')).toThrow(
        'Unsupported OPENAI_EXTRACT_PROMPT_CACHE'
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_EXTRACT_PROMPT_CACHE;
      else process.env.OPENAI_EXTRACT_PROMPT_CACHE = previous;
    }
  });

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
    const blocks = _internals.buildAnthropicContent(ROUND1_FINAL);
    // 2026-08-07 — summary_text added for field-test observability; ROUND1_FINAL's
    // fixture reasoning item carries no `summary` array, so it resolves to null.
    expect(blocks[0]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'enc_abc',
      summary_text: null,
    });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'call_xyz',
      name: 'record_reading',
      input: { field: 'measured_zs_ohm', circuit_ref: '4', value: '0.63' },
    });
  });

  test('mapUsage: input_tokens is INCLUSIVE — subtract cached + write to get the fresh remainder', () => {
    expect(_internals.mapUsage(ROUND1_FINAL.usage)).toEqual({
      input_tokens: 3,
      output_tokens: 55,
      reasoning_tokens: 25,
      cache_creation_input_tokens: 2062,
      cache_read_input_tokens: 0,
    });
    expect(_internals.mapUsage(ROUND2_FINAL.usage)).toEqual({
      input_tokens: 3,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 15,
      cache_read_input_tokens: 2047,
    });
  });

  test('mapUsage: reasoning_tokens is surfaced ALONGSIDE output_tokens, never subtracted from it', () => {
    // Plan 08A. `output_tokens` is the Responses API's INCLUSIVE total —
    // reasoning time is folded into it invisibly, which is why round 0 can cost
    // ~3.8 s for ~101 "output" tokens. Surfacing the reasoning share is the
    // whole point, but every CostTracker input is computed from
    // `output_tokens`, so its value must not move by a single token.
    const usage = {
      input_tokens: 100,
      output_tokens: 55,
      output_tokens_details: { reasoning_tokens: 25 },
    };
    expect(_internals.mapUsage(usage).output_tokens).toBe(55);
    expect(_internals.mapUsage(usage).reasoning_tokens).toBe(25);
  });

  test('mapUsage: a reported 0 stays 0; an unreported value is null, never a fabricated 0', () => {
    // A provider-reported 0 is a real measurement (a round that did no
    // thinking) and must be distinguishable from "this transport does not
    // report reasoning at all" — `|| 0` would collapse the two and make the
    // 08B analysis claim a zero-reasoning round that never happened.
    expect(_internals.mapUsage({ input_tokens: 1, output_tokens: 2 }).reasoning_tokens).toBeNull();
    expect(
      _internals.mapUsage({ input_tokens: 1, output_tokens: 2, output_tokens_details: {} })
        .reasoning_tokens
    ).toBeNull();
    expect(
      _internals.mapUsage({
        input_tokens: 1,
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
      }).reasoning_tokens
    ).toBe(0);
    // Survives the JSON.stringify src/logger.js performs on metadata.
    expect(
      JSON.parse(JSON.stringify(_internals.mapUsage({ input_tokens: 1, output_tokens: 2 })))
        .reasoning_tokens
    ).toBeNull();
  });

  test('final-message translation preserves actual model and served Fast tier for billing', () => {
    const message = _internals.toAnthropicMessage(ROUND1_FINAL, 'gpt-5.6-luna');
    expect(message.model).toBe('gpt-5.6-luna-2026-07-15');
    expect(message.service_tier).toBe('priority');
    expect(message.response_model).toBe('gpt-5.6-luna-2026-07-15');
    expect(message.response_service_tier).toBe('priority');
    expect(message.requested_model).toBe('gpt-5.6-luna');
  });

  test('Fast mode is explicit, Standard omits service_tier, and typos fail closed', () => {
    expect(_internals.resolveServiceTier('fast')).toBe('fast');
    expect(_internals.resolveServiceTier(' FAST ')).toBe('fast');
    expect(_internals.resolveServiceTier('standard')).toBeUndefined();
    expect(_internals.resolveServiceTier('default')).toBeUndefined();
    expect(_internals.resolveServiceTier('')).toBeUndefined();
    expect(() => _internals.resolveServiceTier('fasst')).toThrow(
      'Unsupported OPENAI_EXTRACT_SERVICE_TIER'
    );
  });

  test('createStream sends service_tier=fast on the actual Responses request', async () => {
    const previous = process.env.OPENAI_EXTRACT_SERVICE_TIER;
    process.env.OPENAI_EXTRACT_SERVICE_TIER = 'fast';
    const openai = {
      responses: {
        stream: jest.fn(() => makeMockOpenAIStream(ROUND1_STREAM_EVENTS, ROUND1_FINAL)),
      },
    };
    try {
      const stream = _internals.createStream(openai, {
        model: 'gpt-5.6-luna',
        max_tokens: 100,
        system: 'system',
        messages: [{ role: 'user', content: 'Circuit 4 Zs 0.63' }],
        tools: [],
      });
      await stream.finalMessage();
      expect(openai.responses.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.6-luna', service_tier: 'fast' }),
        undefined
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_EXTRACT_SERVICE_TIER;
      else process.env.OPENAI_EXTRACT_SERVICE_TIER = previous;
    }
  });

  test('per-route Standard and reasoning overrides outrank the global Luna Fast policy', async () => {
    const previousTier = process.env.OPENAI_EXTRACT_SERVICE_TIER;
    const previousEffort = process.env.OPENAI_EXTRACT_REASONING_EFFORT;
    process.env.OPENAI_EXTRACT_SERVICE_TIER = 'fast';
    process.env.OPENAI_EXTRACT_REASONING_EFFORT = 'medium';
    const standardFinal = { ...ROUND1_FINAL, service_tier: undefined };
    const openai = {
      responses: {
        stream: jest.fn(() => makeMockOpenAIStream(ROUND1_STREAM_EVENTS, standardFinal)),
      },
    };
    try {
      const stream = _internals.createStream(openai, {
        model: 'gpt-5.6-terra',
        max_tokens: 100,
        system: 'system',
        messages: [{ role: 'user', content: 'observation cracked socket' }],
        tools: [],
        service_tier: 'standard',
        reasoning_effort: 'low',
      });
      const message = await stream.finalMessage();
      expect(openai.responses.stream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.6-terra',
          // 2026-08-07 — summary:'auto' added for field-test observability
          // (openai-responses-adapter.js); effort override still outranks
          // the global policy, which is what this test actually pins.
          reasoning: { effort: 'low', summary: 'auto' },
        }),
        undefined
      );
      expect(openai.responses.stream.mock.calls[0][0]).not.toHaveProperty('service_tier');
      expect(message.service_tier).toBe('standard');
      expect(message.response_service_tier).toBeNull();
      expect(message.requested_service_tier).toBe('standard');
    } finally {
      if (previousTier === undefined) delete process.env.OPENAI_EXTRACT_SERVICE_TIER;
      else process.env.OPENAI_EXTRACT_SERVICE_TIER = previousTier;
      if (previousEffort === undefined) delete process.env.OPENAI_EXTRACT_REASONING_EFFORT;
      else process.env.OPENAI_EXTRACT_REASONING_EFFORT = previousEffort;
    }
  });
});

describe('openai-responses-adapter — translateStreamingEvents (real event translation)', () => {
  test('emits content_block_start/delta/stop for function_call items only; reasoning/message items are silent', async () => {
    const events = [];
    for await (const ev of _internals.translateStreamingEvents(
      (async function* () {
        for (const e of ROUND1_STREAM_EVENTS) yield e;
      })()
    )) {
      events.push(ev);
    }
    // reasoning item produces NO content_block_* events; only the function_call does.
    expect(events).toEqual([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_xyz', name: 'record_reading', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            field: 'measured_zs_ohm',
            circuit_ref: '4',
            value: '0.63',
          }),
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);
  });

  test('a message-only turn (round 2) yields no content_block events, stop_reason end_turn', async () => {
    const events = [];
    for await (const ev of _internals.translateStreamingEvents(
      (async function* () {
        for (const e of ROUND2_STREAM_EVENTS) yield e;
      })()
    )) {
      events.push(ev);
    }
    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  });

  test('routes deltas by item_id, never assumed ordering (two interleaved function_calls)', async () => {
    const interleaved = [
      {
        type: 'response.output_item.added',
        item: { id: 'a', type: 'function_call', call_id: 'call_a', name: 'foo' },
      },
      {
        type: 'response.output_item.added',
        item: { id: 'b', type: 'function_call', call_id: 'call_b', name: 'bar' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'b', delta: '{"x":1}' },
      { type: 'response.function_call_arguments.delta', item_id: 'a', delta: '{"y":2}' },
      { type: 'response.output_item.done', item: { id: 'b', type: 'function_call' } },
      { type: 'response.output_item.done', item: { id: 'a', type: 'function_call' } },
      {
        type: 'response.completed',
        response: { output: [{ type: 'function_call' }, { type: 'function_call' }] },
      },
    ];
    const events = [];
    for await (const ev of _internals.translateStreamingEvents(
      (async function* () {
        for (const e of interleaved) yield e;
      })()
    )) {
      events.push(ev);
    }
    const deltaForIndex0 = events.find((e) => e.type === 'content_block_delta' && e.index === 0);
    const deltaForIndex1 = events.find((e) => e.type === 'content_block_delta' && e.index === 1);
    // index 0 = 'a' (added first), index 1 = 'b' (added second) — deltas route
    // by item_id regardless of the order they arrive in.
    expect(deltaForIndex0.delta.partial_json).toBe('{"y":2}');
    expect(deltaForIndex1.delta.partial_json).toBe('{"x":1}');
  });
});

describe('openai-responses-adapter — drives the REAL runToolLoop across two rounds', () => {
  test('global Luna Fast policy is preserved as requested-tier billing evidence', async () => {
    const previous = process.env.OPENAI_EXTRACT_SERVICE_TIER;
    process.env.OPENAI_EXTRACT_SERVICE_TIER = 'fast';
    try {
      const { client } = buildTestAdapter([{ events: ROUND2_STREAM_EVENTS, final: ROUND2_FINAL }]);
      const out = await runToolLoop({
        client,
        model: 'gpt-5.6-luna',
        provider: 'openai',
        system: 'SYS',
        messages: [{ role: 'user', content: 'done' }],
        tools: [],
      });

      expect(out.round_usage[0]).toEqual(
        expect.objectContaining({
          requested_tier: 'fast',
          response_tier: 'priority',
          billing_tier: 'priority',
        })
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_EXTRACT_SERVICE_TIER;
      else process.env.OPENAI_EXTRACT_SERVICE_TIER = previous;
    }
  });

  test('round 1 dispatches record_reading (reasoning present, tool_use surfaced); round 2 ends cleanly', async () => {
    const { client, streamFn } = buildTestAdapter([
      { events: ROUND1_STREAM_EVENTS, final: ROUND1_FINAL },
      { events: ROUND2_STREAM_EVENTS, final: ROUND2_FINAL },
    ]);
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
      provider: 'openai',
      openAIServiceTier: 'fast',
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

    // The DECISIVE assertion carried over: with reasoning present and
    // round-tripped, the loop reaches end_turn in 2 rounds — no looping.
    expect(out.stop_reason).toBe('end_turn');
    expect(out.rounds).toBe(2);
    expect(out.aborted).toBe(false);
    expect(out.service_tier).toBe('priority');

    expect(out.usage.output_tokens).toBe(65); // 55 + 10
    expect(out.usage.cache_read_input_tokens).toBe(2047); // only round 2 had a cache hit
    expect(out.usage.cache_creation_input_tokens).toBe(2077); // 2062 + 15
    expect(out.round_usage).toEqual([
      expect.objectContaining({
        round_idx: 0,
        provider: 'openai',
        requested_model: 'gpt-5.6-luna',
        response_model: 'gpt-5.6-luna-2026-07-15',
        billing_model: 'gpt-5.6-luna-2026-07-15',
        response_tier: 'priority',
        billing_tier: 'priority',
        model_provenance: 'returned',
        tier_provenance: 'returned',
        cache_creation_input_tokens: 2062,
      }),
      expect.objectContaining({
        round_idx: 1,
        provider: 'openai',
        cache_read_input_tokens: 2047,
      }),
    ]);

    // Round 2's request must carry the reasoning item echoed back BEFORE the
    // function_call it followed — proving continuity round-tripped through
    // messages_final, not just through the mock's shared closure.
    const round2Payload = streamFn.mock.calls[1][0];
    const reasoningIdx = round2Payload.input.findIndex((i) => i.type === 'reasoning');
    const functionCallIdx = round2Payload.input.findIndex((i) => i.type === 'function_call');
    const outputIdx = round2Payload.input.findIndex((i) => i.type === 'function_call_output');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(functionCallIdx);
    expect(functionCallIdx).toBeLessThan(outputIdx);
    expect(round2Payload.input[reasoningIdx].encrypted_content).toBe('enc_abc');
  });

  test('Plan 08A: reasoning_tokens survives the WHOLE path — adapter → tool loop → round_usage', async () => {
    // The regression this locks: `attributeRoundUsage` is an explicit
    // ALLOWLIST that copies fields BY NAME and drops everything unnamed, so
    // surfacing reasoning_tokens in the adapter alone was a silent no-op. Only
    // an end-to-end assertion catches a future re-break — an adapter-level
    // unit test would still pass with the allowlist entry deleted.
    const { client } = buildTestAdapter([
      { events: ROUND1_STREAM_EVENTS, final: ROUND1_FINAL },
      { events: ROUND2_STREAM_EVENTS, final: ROUND2_FINAL },
    ]);
    const out = await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      openAIServiceTier: 'fast',
      system: 'SYS',
      messages: [{ role: 'user', content: 'Zs on circuit 4 is 0.63' }],
      tools: [
        {
          name: 'record_reading',
          description: 'record a reading',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      dispatcher: async (call) => ({
        tool_use_id: call.tool_call_id,
        content: '{}',
        is_error: false,
      }),
      ctx: { sessionId: 's1', turnId: 't1' },
    });

    // Round 1 reasoned (25 of its 55 output tokens); round 2 did not (0).
    // Both are REPORTED values, so neither may normalise to null.
    expect(out.round_usage.map((r) => r.reasoning_tokens)).toEqual([25, 0]);
    // …and the billed totals are untouched by the new field.
    expect(out.round_usage.map((r) => r.output_tokens)).toEqual([55, 10]);

    // The same end-to-end path proves first_tool_use_ns against the REAL
    // translator, whose synthetic message_start precedes the provider SSE:
    // only the function_call item becomes a content_block_start, so a
    // tool-emitting round stamps and a message-only round stays null.
    expect(out.round_timings[0].first_tool_use_ns).toMatch(/^\d+$/);
    expect(out.round_timings[1].first_tool_use_ns).toBeNull();
    expect(() => JSON.stringify(out.round_usage)).not.toThrow();
  });

  test('DECISIVE: onToolUseStreamed fires from the LIVE event translation, before finalResponse() is ever called', async () => {
    const order = [];
    const { client } = buildTestAdapter(
      [
        { events: ROUND1_STREAM_EVENTS, final: ROUND1_FINAL },
        { events: ROUND2_STREAM_EVENTS, final: ROUND2_FINAL },
      ],
      { onFinalResponseCalled: () => order.push('finalResponse_called') }
    );
    const dispatcher = async (call) => ({
      tool_use_id: call.tool_call_id,
      content: '{}',
      is_error: false,
    });

    await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      system: 'SYS',
      messages: [{ role: 'user', content: 'Zs on circuit 4 is 0.63' }],
      tools: [
        {
          name: 'record_reading',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      dispatcher,
      ctx: { sessionId: 's1', turnId: 't1' },
      onToolUseStreamed: ({ record }) => order.push(`tool_use_streamed:${record.name}`),
    });

    // This is the whole point of the real-streaming rewrite: the tool_use
    // record must become visible to Loaded Barrel's early hook (round 1)
    // BEFORE the buffered final response is ever fetched for THAT round —
    // not after. Round 2 has no tool_use (a plain end_turn message), so its
    // finalResponse() call has no preceding streamed marker.
    expect(order).toEqual([
      'tool_use_streamed:record_reading',
      'finalResponse_called',
      'finalResponse_called',
    ]);
  });

  test('invalid tool-call JSON surfaces as an error tool_result, never a crash', async () => {
    const badFinal = {
      output: [
        {
          type: 'function_call',
          id: 'fc_bad',
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
    const badEvents = [
      {
        type: 'response.output_item.added',
        item: { id: 'fc_bad', type: 'function_call', call_id: 'call_bad', name: 'record_reading' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_bad', delta: '{"field":' },
      { type: 'response.output_item.done', item: { id: 'fc_bad', type: 'function_call' } },
      { type: 'response.completed', response: badFinal },
    ];
    const { client } = buildTestAdapter([
      { events: badEvents, final: badFinal },
      { events: ROUND2_STREAM_EVENTS, final: ROUND2_FINAL },
    ]);
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

    // Invalid JSON in the streamed delta -> assembler records invalid_json ->
    // NOT dispatched, error tool_result appended.
    expect(dispatcher).not.toHaveBeenCalled();
    const toolResultMsg = out.messages_final.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
    );
    expect(toolResultMsg.content[0].is_error).toBe(true);
    expect(out.aborted).toBe(false);
  });
});
