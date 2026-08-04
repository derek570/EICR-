/**
 * Plan 00B-2 C3 — the transport×turn-type reasoning-effort matrix.
 *
 * The dispatch resolver (stage6-shadow-harness resolveOpenAIReasoningEffort)
 * computes the EFFECTIVE OpenAI reasoning effort once per turn; the same
 * value reaches the SDK request (Responses consumes streamArgs; Chat
 * Completions deliberately ignores streamArgs and resolves env-only — the
 * resolver's chat value reaches ATTRIBUTION only and equals the adapter's
 * own computation by construction) and `attributeRoundUsage` (the new
 * `reasoning_effort` row field 00C's Terra gate consumes — it rejects
 * configuration-only evidence, so the same-value tests anchor at BOTH
 * adapters' ACTUAL request payloads, never only the streamArgs value).
 *
 * The per-API unset-env defaults DIFFER deliberately and are LIVE-operative:
 * non-'none' effort with function tools draws HTTP 400 on chat-completions,
 * while 'none' on Responses reproduces the documented Luna reasoning-off
 * looping — so a single default in either direction is a production
 * regression. The UNSET-ENV DEFAULT-PARITY tests pin each adapter's request
 * payload byte-unchanged from pre-00B-2 behaviour.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const { resolveOpenAIReasoningEffort } = await import('../extraction/stage6-shadow-harness.js');
const { attributeRoundUsage } = await import('../extraction/round-usage-attribution.js');
const { _internals: tooluseInternals } = await import('../extraction/openai-tooluse-adapter.js');
const { _internals: responsesInternals } =
  await import('../extraction/openai-responses-adapter.js');

const ENV_KEYS = ['OPENAI_EXTRACT_REASONING_EFFORT', 'OPENAI_OBSERVATION_REASONING_EFFORT'];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const BASE_STREAM_ARGS = {
  model: 'gpt-5.6-luna',
  max_tokens: 512,
  system: 'SYS',
  messages: [{ role: 'user', content: 'Circuit 4 Zs 0.63' }],
  tools: [],
};

/** Capture the chat-completions request payload without a full mock stream. */
async function captureChatPayload(streamArgs) {
  const create = jest.fn(async () => {
    throw new Error('capture-only');
  });
  const openai = { chat: { completions: { create } } };
  const stream = tooluseInternals.createStream(openai, streamArgs, {});
  await expect(stream.finalMessage()).rejects.toThrow('capture-only');
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0][0];
}

/** Capture the Responses request payload without a full mock stream. */
async function captureResponsesPayload(streamArgs) {
  const streamFn = jest.fn(() => {
    throw new Error('capture-only');
  });
  const openai = { responses: { stream: streamFn } };
  const stream = responsesInternals.createStream(openai, streamArgs, {});
  await expect(stream.finalMessage()).rejects.toThrow('capture-only');
  expect(streamFn).toHaveBeenCalledTimes(1);
  return streamFn.mock.calls[0][0];
}

describe('resolveOpenAIReasoningEffort — the full transport×turn matrix', () => {
  test('UNSET env: chat_completions resolves none for ordinary AND observation; responses resolves low for both', () => {
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'chat_completions', isObservationTurn: false })
    ).toBe('none');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'chat_completions', isObservationTurn: true })
    ).toBe('none');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'responses', isObservationTurn: false })
    ).toBe('low');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'responses', isObservationTurn: true })
    ).toBe('low');
  });

  test('env overrides: extract env drives chat (both turn types) + responses ordinary; observation env drives responses observation ONLY', () => {
    process.env.OPENAI_EXTRACT_REASONING_EFFORT = 'medium';
    process.env.OPENAI_OBSERVATION_REASONING_EFFORT = 'high';
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'chat_completions', isObservationTurn: false })
    ).toBe('medium');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'chat_completions', isObservationTurn: true })
    ).toBe('medium');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'responses', isObservationTurn: false })
    ).toBe('medium');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'responses', isObservationTurn: true })
    ).toBe('high');
  });

  test('the task-def-equivalent observation=low case: Chat Completions still resolves none', () => {
    // The live task-def sets OPENAI_OBSERVATION_REASONING_EFFORT=low and no
    // extract env — honouring it on chat would flip observation payloads
    // none→low and draw the function-tools HTTP 400.
    process.env.OPENAI_OBSERVATION_REASONING_EFFORT = 'low';
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'chat_completions', isObservationTurn: true })
    ).toBe('none');
    expect(
      resolveOpenAIReasoningEffort({ extractionApi: 'responses', isObservationTurn: true })
    ).toBe('low');
  });
});

describe('same-value contract — adapter request payload === attributed reasoning_effort', () => {
  const MATRIX = [
    { api: 'chat_completions', obs: false },
    { api: 'chat_completions', obs: true },
    { api: 'responses', obs: false },
    { api: 'responses', obs: true },
  ];

  for (const envCase of ['unset', 'override']) {
    for (const { api, obs } of MATRIX) {
      test(`${api} / ${obs ? 'observation' : 'ordinary'} turn / ${envCase} env`, async () => {
        if (envCase === 'override') {
          process.env.OPENAI_EXTRACT_REASONING_EFFORT =
            api === 'chat_completions' ? 'none' : 'medium';
          process.env.OPENAI_OBSERVATION_REASONING_EFFORT = 'high';
        }
        const effort = resolveOpenAIReasoningEffort({ extractionApi: api, isObservationTurn: obs });
        // The live dispatch threads the resolver value as streamArgs.reasoning_effort.
        const streamArgs = { ...BASE_STREAM_ARGS, reasoning_effort: effort };
        const payloadEffort =
          api === 'chat_completions'
            ? (await captureChatPayload(streamArgs)).reasoning_effort
            : (await captureResponsesPayload(streamArgs)).reasoning.effort;
        // Anchor: the ACTUAL request payload carries the resolver's value…
        expect(payloadEffort).toBe(effort);
        // …and attribution records exactly that value.
        const row = attributeRoundUsage({
          provider: 'openai',
          requestedModel: 'gpt-5.6-luna',
          requestedTier: 'standard',
          responseModel: 'gpt-5.6-luna',
          responseTier: 'standard',
          usage: { input_tokens: 1, output_tokens: 1 },
          roundIdx: 0,
          reasoningEffort: effort,
        });
        expect(row.reasoning_effort).toBe(payloadEffort);
      });
    }
  }

  test('anthropic provider attributes null (no reasoning-effort field)', () => {
    const row = attributeRoundUsage({
      provider: 'anthropic',
      requestedModel: 'claude-haiku-4-5',
      requestedTier: null,
      responseModel: 'claude-haiku-4-5',
      responseTier: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      roundIdx: 0,
      reasoningEffort: 'low',
    });
    expect(row.reasoning_effort).toBeNull();
  });
});

describe('UNSET-ENV DEFAULT-PARITY — request payloads byte-unchanged from pre-00B-2', () => {
  test('chat_completions with NO streamArgs effort sends none', async () => {
    const payload = await captureChatPayload({ ...BASE_STREAM_ARGS });
    expect(payload.reasoning_effort).toBe('none');
  });

  test('responses with NO streamArgs effort sends low (the create()/keepalive fallback path)', async () => {
    const payload = await captureResponsesPayload({ ...BASE_STREAM_ARGS });
    expect(payload.reasoning.effort).toBe('low');
  });

  test('threading the resolver value produces the IDENTICAL payload effort on both transports', async () => {
    const chatThreaded = await captureChatPayload({
      ...BASE_STREAM_ARGS,
      reasoning_effort: resolveOpenAIReasoningEffort({
        extractionApi: 'chat_completions',
        isObservationTurn: false,
      }),
    });
    expect(chatThreaded.reasoning_effort).toBe('none');
    const responsesThreaded = await captureResponsesPayload({
      ...BASE_STREAM_ARGS,
      reasoning_effort: resolveOpenAIReasoningEffort({
        extractionApi: 'responses',
        isObservationTurn: false,
      }),
    });
    expect(responsesThreaded.reasoning.effort).toBe('low');
  });

  test('DIRECT-PATH pin: chat_completions IGNORES a supplied reasoning_effort: low entirely', async () => {
    // The direct EICRExtractionSession chat_completions observation call
    // supplies `reasoning_effort: 'low'` in its params; the adapter must not
    // begin honouring it (function tools + non-'none' effort → HTTP 400).
    const payload = await captureChatPayload({ ...BASE_STREAM_ARGS, reasoning_effort: 'low' });
    expect(payload.reasoning_effort).toBe('none');
  });
});
