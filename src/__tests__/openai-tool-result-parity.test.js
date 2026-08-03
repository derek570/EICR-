import { jest } from '@jest/globals';

import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { _internals } from '../extraction/openai-responses-adapter.js';
import { createToolDispatcher, createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

const MODEL = 'gpt-5.6-luna';

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function tool(name) {
  return { name, description: `${name} test schema`, input_schema: { type: 'object' } };
}

function functionCallRound({ callId, name, input, rawArguments, streamCall = true }) {
  const itemId = `fc_${callId}`;
  const argumentsText = rawArguments ?? JSON.stringify(input ?? {});
  const final = {
    model: 'gpt-5.6-luna-2026-07-30',
    service_tier: 'priority',
    output: [
      {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name,
        arguments: argumentsText,
        status: 'completed',
      },
    ],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 5,
    },
  };
  const events = [];
  if (streamCall) {
    events.push(
      {
        type: 'response.output_item.added',
        item: { id: itemId, type: 'function_call', call_id: callId, name },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        delta: argumentsText,
      },
      { type: 'response.output_item.done', item: { id: itemId, type: 'function_call' } }
    );
  }
  events.push({ type: 'response.completed', response: final });
  return { events, final };
}

function endTurnRound(text = 'Done.') {
  const final = {
    model: 'gpt-5.6-luna-2026-07-30',
    service_tier: 'priority',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: {
      input_tokens: 15,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      output_tokens: 2,
    },
  };
  return {
    final,
    events: [
      { type: 'response.output_item.added', item: { id: 'msg_done', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_done', delta: text },
      { type: 'response.output_item.done', item: { id: 'msg_done', type: 'message' } },
      { type: 'response.completed', response: final },
    ],
  };
}

function openAIStream(round) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of round.events) yield event;
    },
    finalResponse: async () => round.final,
  };
}

function scriptedResponsesClient(rounds) {
  let index = 0;
  const payloads = [];
  const openai = {
    responses: {
      stream: jest.fn((payload) => {
        payloads.push(payload);
        const round = rounds[index];
        index += 1;
        if (!round) throw new Error(`unexpected model round ${index}`);
        return openAIStream(round);
      }),
    },
  };
  return {
    client: {
      messages: {
        stream: (args, options) => _internals.createStream(openai, args, options),
      },
    },
    payloads,
    stream: openai.responses.stream,
  };
}

function productionSession(circuits = { 1: {}, 3: {} }, mode = 'live') {
  return {
    sessionId: 's-parity',
    toolCallsMode: mode,
    stateSnapshot: { circuits },
    extractedObservations: [],
  };
}

function captureResults(dispatcher) {
  const results = [];
  return {
    results,
    dispatcher: async (...args) => {
      const result = await dispatcher(...args);
      results.push(result);
      return result;
    },
  };
}

function functionOutput(payload, callId) {
  return payload.input.find(
    (item) => item.type === 'function_call_output' && item.call_id === callId
  );
}

async function runParityLoop({ rounds, dispatcher, tools, maxRounds, signal }) {
  const scripted = scriptedResponsesClient(rounds);
  const out = await runToolLoop({
    client: scripted.client,
    model: MODEL,
    provider: 'openai',
    openAIServiceTier: 'fast',
    system: 'SYSTEM',
    messages: [{ role: 'user', content: 'inspector utterance' }],
    tools,
    dispatcher,
    ctx: { sessionId: 's-parity', turnId: 't-parity' },
    logger: logger(),
    maxRounds,
    signal,
  });
  return { ...scripted, out };
}

function ordinaryAskInput(overrides = {}) {
  return {
    question: 'Which circuit were you referring to?',
    reason: 'ambiguous_circuit',
    context_field: 'circuit_designation',
    context_circuit: 3,
    expected_answer_shape: 'circuit_ref',
    ...overrides,
  };
}

function mirrorAskInput() {
  return {
    question: 'Use the same address for the client?',
    reason: 'missing_context',
    context_field: 'client_address',
    context_circuit: null,
    expected_answer_shape: 'yes_no',
    purpose: 'address_mirror',
  };
}

function resolvingWs(pendingAsks, outcome) {
  return {
    OPEN: 1,
    readyState: 1,
    send: jest.fn((raw) => {
      const frame = JSON.parse(raw);
      if (frame.type === 'ask_user_started') pendingAsks.resolve(frame.tool_call_id, outcome);
    }),
  };
}

describe('Plan 00A A3 — production results survive the Responses continuation byte-for-byte', () => {
  test('successful write keeps the real body, call id and end_turn action', async () => {
    const session = productionSession();
    const writes = createPerTurnWrites();
    const captured = captureResults(
      createWriteDispatcher(session, logger(), 't-parity', writes, {
        hasLowConfReadbackV1: true,
      })
    );
    const callId = 'call_write_ok';
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({
          callId,
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 3,
            value: '0.63',
            confidence: 1,
            source_turn_id: 't-parity',
          },
        }),
        endTurnRound(),
      ],
      dispatcher: captured.dispatcher,
      tools: [tool('record_reading')],
    });

    expect(captured.results[0].content).toBe('{"ok":true}');
    expect(functionOutput(payloads[1], callId)).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: captured.results[0].content,
    });
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.63');
    expect(out.stop_reason).toBe('end_turn');
  });

  test.each([
    {
      label: 'noop',
      callId: 'call_noop',
      name: 'clear_reading',
      input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      expected: '{"ok":true,"noop":true,"reason":"field_not_set"}',
      extraCtx: {},
    },
    {
      label: 'skipped',
      callId: 'call_skipped',
      name: 'record_reading',
      input: {
        field: 'measured_zs_ohm',
        circuit: 3,
        value: '0.62',
        confidence: 0.3,
        source_turn_id: 't-parity',
      },
      expected: '{"ok":true,"skipped":true,"reason":"low_conf_readback_capability_missing"}',
      extraCtx: {},
    },
  ])('$label result stays non-error and Luna ends the turn', async (testCase) => {
    const session = productionSession();
    const captured = captureResults(
      createWriteDispatcher(session, logger(), 't-parity', createPerTurnWrites(), testCase.extraCtx)
    );
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({
          callId: testCase.callId,
          name: testCase.name,
          input: testCase.input,
        }),
        endTurnRound(),
      ],
      dispatcher: captured.dispatcher,
      tools: [tool(testCase.name)],
    });

    expect(captured.results[0].is_error).toBe(false);
    expect(captured.results[0].content).toBe(testCase.expected);
    expect(functionOutput(payloads[1], testCase.callId)?.output).toBe(testCase.expected);
    expect(out.stop_reason).toBe('end_turn');
  });

  test.each([
    [
      'answered ask',
      'live',
      { answered: true, user_text: 'Circuit 5' },
      '{"answered":true,"untrusted_user_text":"Circuit 5"}',
    ],
    ['answered:false ask', 'shadow', null, '{"answered":false,"reason":"shadow_mode"}'],
  ])('%s body is the exact next function_call_output', async (_label, mode, outcome, expected) => {
    const pending = createPendingAsksRegistry();
    const ws = outcome ? resolvingWs(pending, outcome) : resolvingWs(pending, {});
    const ask = createAskDispatcher(
      productionSession({ 3: {} }, mode),
      logger(),
      't-parity',
      pending,
      ws
    );
    const captured = captureResults(ask);
    const callId = `call_ask_${mode}`;
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({ callId, name: 'ask_user', input: ordinaryAskInput() }),
        endTurnRound(),
      ],
      dispatcher: captured.dispatcher,
      tools: [tool('ask_user')],
    });

    expect(captured.results[0].content).toBe(expected);
    expect(functionOutput(payloads[1], callId)).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: expected,
    });
    expect(out.stop_reason).toBe('end_turn');
  });

  test.each([
    ['61018', 'did_you_mean', ['BS EN 61008']],
    ['68001', 'invalid_value', undefined],
  ])(
    '%s correction result reaches Luna before its corrected write and final end_turn',
    async (userText, status, suggestions) => {
      const session = productionSession({ 1: { designation: 'Cooker' } });
      const pending = createPendingAsksRegistry();
      const ask = createAskDispatcher(
        session,
        logger(),
        't-parity',
        pending,
        resolvingWs(pending, { answered: true, user_text: userText }),
        { autoResolveWrite: jest.fn() }
      );
      const write = createWriteDispatcher(session, logger(), 't-parity', createPerTurnWrites(), {
        hasLowConfReadbackV1: true,
      });
      const captured = captureResults(createToolDispatcher(write, ask));
      const correctionId = `call_${status}`;
      const correctedId = `call_${status}_corrected`;
      const { out, payloads } = await runParityLoop({
        rounds: [
          functionCallRound({
            callId: correctionId,
            name: 'ask_user',
            input: ordinaryAskInput({
              question: "What's the BS number of the RCD?",
              reason: 'missing_context',
              context_field: 'rcd_bs_en',
              context_circuit: 1,
              expected_answer_shape: 'free_text',
            }),
          }),
          functionCallRound({
            callId: correctedId,
            name: 'record_reading',
            input: {
              field: 'rcd_bs_en',
              circuit: 1,
              value: 'BS EN 61008',
              confidence: 1,
              source_turn_id: 't-parity',
            },
          }),
          endTurnRound(),
        ],
        dispatcher: captured.dispatcher,
        tools: [tool('ask_user'), tool('record_reading')],
      });

      const correctionBody = JSON.parse(captured.results[0].content);
      expect(correctionBody).toEqual({
        answered: true,
        auto_resolved: false,
        match_status: status,
        untrusted_user_text: userText,
        field: 'rcd_bs_en',
        circuit: 1,
        received: userText,
        valid_options: ['', 'BS EN 61008', 'BS EN 61009', 'BS EN 62423', 'N/A'],
        ...(suggestions ? { suggestions } : {}),
      });
      expect(functionOutput(payloads[1], correctionId)?.output).toBe(captured.results[0].content);
      expect(functionOutput(payloads[2], correctedId)).toEqual({
        type: 'function_call_output',
        call_id: correctedId,
        output: '{"ok":true}',
      });
      expect(out.tool_calls.map((call) => call.name)).toEqual(['ask_user', 'record_reading']);
      expect(out.stop_reason).toBe('end_turn');
    }
  );

  test('repeated address-mirror claim emits the exact already_asked result and no duplicate ask', async () => {
    const pending = createPendingAsksRegistry();
    const ws = resolvingWs(pending, {});
    const ask = createAskDispatcher(
      productionSession({ 0: {} }),
      logger(),
      't-parity',
      pending,
      ws,
      {
        addressMirrorController: {
          claimLiveAsk: jest.fn(async () => ({ ok: false, reason: 'already_asked' })),
        },
      }
    );
    const captured = captureResults(ask);
    const callId = 'call_mirror_duplicate';
    const expected =
      '{"answered":false,"reason":"address_mirror_not_claimed","disposition":"already_asked"}';
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({ callId, name: 'ask_user', input: mirrorAskInput() }),
        endTurnRound(),
      ],
      dispatcher: captured.dispatcher,
      tools: [tool('ask_user')],
    });

    expect(captured.results[0].content).toBe(expected);
    expect(functionOutput(payloads[1], callId)?.output).toBe(expected);
    expect(ws.send).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
    expect(out.tool_calls).toHaveLength(1);
  });

  test('answered address mirror preserves real outcome, changed fields and source replay count', async () => {
    const pending = createPendingAsksRegistry();
    const ws = resolvingWs(pending, { answered: true, user_text: 'yes' });
    const controller = {
      claimLiveAsk: jest.fn(async () => ({ ok: true })),
      resolveLiveAnswer: jest.fn(async () => ({
        handled: true,
        outcome: 'yes',
        changed: ['client_address', 'client_postcode'],
        replayedSource: 2,
      })),
    };
    const ask = createAskDispatcher(
      productionSession({ 0: {} }),
      logger(),
      't-parity',
      pending,
      ws,
      { addressMirrorController: controller }
    );
    const captured = captureResults(ask);
    const callId = 'call_mirror_answered';
    const expected =
      '{"answered":true,"address_mirror":"yes","changed_fields":["client_address","client_postcode"],"source_replay_count":2}';
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({ callId, name: 'ask_user', input: mirrorAskInput() }),
        endTurnRound(),
      ],
      dispatcher: captured.dispatcher,
      tools: [tool('ask_user')],
    });

    expect(captured.results[0].content).toBe(expected);
    expect(functionOutput(payloads[1], callId)?.output).toBe(expected);
    expect(controller.resolveLiveAnswer).toHaveBeenCalledTimes(1);
    expect(out.stop_reason).toBe('end_turn');
  });

  test('invalid tool JSON keeps the real call id and exact assembler-error JSON', async () => {
    const callId = 'call_invalid_json';
    const dispatcher = jest.fn();
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({
          callId,
          name: 'record_reading',
          rawArguments: '{"field":',
        }),
        endTurnRound(),
      ],
      dispatcher,
      tools: [tool('record_reading')],
    });
    const expected = '{"error":"invalid_json","raw_partial":"{\\"field\\":"}';

    expect(dispatcher).not.toHaveBeenCalled();
    expect(functionOutput(payloads[1], callId)).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: expected,
    });
    expect(out.stop_reason).toBe('end_turn');
  });

  test('thrown dispatcher error uses the existing body without an OpenAI is_error wrapper', async () => {
    const callId = 'call_dispatcher_error';
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({ callId, name: 'record_reading', input: { field: 'x' } }),
        endTurnRound(),
      ],
      dispatcher: async () => {
        throw new Error('boom');
      },
      tools: [tool('record_reading')],
    });
    const expected = '{"error":"dispatcher_error","message":"boom"}';

    expect(functionOutput(payloads[1], callId)).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: expected,
    });
    expect(functionOutput(payloads[1], callId)).not.toHaveProperty('is_error');
    expect(out.stop_reason).toBe('end_turn');
  });

  test('missing streamed record receives only the existing internal-no-result envelope', async () => {
    const callId = 'call_internal_missing';
    const dispatcher = jest.fn();
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({
          callId,
          name: 'record_reading',
          input: { field: 'measured_zs_ohm' },
          streamCall: false,
        }),
        endTurnRound(),
      ],
      dispatcher,
      tools: [tool('record_reading')],
    });
    const expected = '{"error":"internal_no_result","reason":"record_missing_or_skipped"}';

    expect(dispatcher).not.toHaveBeenCalled();
    expect(functionOutput(payloads[1], callId)).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: expected,
    });
    expect(out.stop_reason).toBe('end_turn');
  });
});

describe('Plan 00A A3 — server-only failures do not synthesize a Responses result', () => {
  test('loop cap never sends a result for the capped call id', async () => {
    const firstId = 'call_before_cap';
    const cappedId = 'call_at_cap';
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: '{"ok":true}',
      is_error: false,
    }));
    const { out, payloads } = await runParityLoop({
      rounds: [
        functionCallRound({ callId: firstId, name: 'record_reading', input: {} }),
        functionCallRound({ callId: cappedId, name: 'record_reading', input: {} }),
      ],
      dispatcher,
      tools: [tool('record_reading')],
      maxRounds: 2,
    });

    expect(out.aborted).toBe(true);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(payloads).toHaveLength(2);
    expect(
      payloads
        .flatMap((payload) => payload.input)
        .some((item) => item.call_id === cappedId && item.type === 'function_call_output')
    ).toBe(false);
  });

  test('cancellation after a billed response sends no result or continuation request', async () => {
    const controller = new AbortController();
    const callId = 'call_cancelled_after_response';
    const scripted = scriptedResponsesClient([
      functionCallRound({ callId, name: 'record_reading', input: {} }),
    ]);

    await expect(
      runToolLoop({
        client: scripted.client,
        model: MODEL,
        provider: 'openai',
        system: 'SYSTEM',
        messages: [{ role: 'user', content: 'go' }],
        tools: [tool('record_reading')],
        dispatcher: async () => {
          controller.abort();
          return { tool_use_id: callId, content: '{"ok":true}', is_error: false };
        },
        ctx: { sessionId: 's-parity', turnId: 't-parity' },
        logger: logger(),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'ExtractionCancelledError' });

    expect(scripted.payloads).toHaveLength(1);
    expect(
      scripted.payloads
        .flatMap((payload) => payload.input)
        .some((item) => item.type === 'function_call_output' && item.call_id === callId)
    ).toBe(false);
  });

  test('pre-result transport failure stops after one request with no function_call_output', async () => {
    const payloads = [];
    const openai = {
      responses: {
        stream: jest.fn((payload) => {
          payloads.push(payload);
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  throw new Error('transport failed before response');
                },
              };
            },
            finalResponse: async () => {
              throw new Error('unreachable');
            },
          };
        }),
      },
    };
    const client = {
      messages: {
        stream: (args, options) => _internals.createStream(openai, args, options),
      },
    };

    await expect(
      runToolLoop({
        client,
        model: MODEL,
        provider: 'openai',
        system: 'SYSTEM',
        messages: [{ role: 'user', content: 'go' }],
        tools: [tool('record_reading')],
        dispatcher: jest.fn(),
        ctx: { sessionId: 's-parity', turnId: 't-parity' },
        logger: logger(),
      })
    ).rejects.toThrow('transport failed before response');

    expect(payloads).toHaveLength(1);
    expect(payloads[0].input.some((item) => item.type === 'function_call_output')).toBe(false);
  });
});
