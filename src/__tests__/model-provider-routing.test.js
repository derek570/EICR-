import { jest } from '@jest/globals';
import fs from 'node:fs';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';
import { ProviderResolutionError, providerForModel } from '../extraction/model-provider.js';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { renderSystemPrompt } from '../extraction/system-prompt-renderer.js';

const ENV_KEYS = [
  'SONNET_EXTRACT_MODEL',
  'OBSERVATION_EXTRACT_MODEL',
  'OBSERVATION_TIER_ROUTING',
  'OPENAI_API_KEY',
  'OPENAI_EXTRACT_API',
  'OPENAI_EXTRACT_SERVICE_TIER',
  'VOICE_LATENCY_ROUND1_MODEL',
  'OPENAI_OBSERVATION_SERVICE_TIER',
  'OPENAI_OBSERVATION_REASONING_EFFORT',
];
let savedEnv;

function createClient(response = {}) {
  return {
    messages: {
      create: jest.fn(async () => ({
        content: [],
        usage: {},
        model: 'test-response-model',
        ...response,
      })),
      stream: jest.fn(),
    },
  };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('canonical extraction provider resolution', () => {
  test.each([false, true])(
    'real split snapshot blocks preserve exact base/prefix/tail order (answers=%s)',
    (agenticAnswersEnabled) => {
      const anthropic = createClient();
      const session = new EICRExtractionSession('anthropic-key', 'prompt-golden', 'eicr', {
        providerClients: { anthropic },
        toolCallsMode: 'live',
        snapshotFormat: 'split_blocks',
        agenticAnswersEnabled,
      });
      session.updateJobState({
        circuits: [{ circuitNumber: 3, circuitDescription: 'Kitchen sockets' }],
      });
      session.updateStateSnapshot({
        extracted_readings: [{ circuit: 3, field: 'measured_zs_ohm', value: '0.63' }],
      });
      const blocks = session.buildSystemBlocks();
      const [base, stablePrefix, volatileTail] = blocks;

      expect(blocks).toHaveLength(3);
      expect(base.text).toBe(session.systemPrompt);
      expect(stablePrefix.text).toBe(session.buildStableSnapshotPrefix());
      expect(volatileTail.text).toBe(session.buildVolatileSnapshotTail());
      expect(stablePrefix.text).toContain('CIRCUIT SCHEDULE');
      expect(stablePrefix.text).not.toMatch(/(?:^|\n)(?:EXTRACTED|PENDING)(?:\n|$)/);
      expect(volatileTail.text).toMatch(/(?:^|\n)EXTRACTED(?:\s|\()/);
      expect(renderSystemPrompt(blocks)).toBe(
        [base.text, stablePrefix.text, volatileTail.text].join('\n\n')
      );
      expect(renderSystemPrompt(blocks)).toContain('\n\nEXTRACTED');
      expect(renderSystemPrompt(blocks)).not.toContain('cache_control');
      expect(renderSystemPrompt(blocks).length).toBe(
        base.text.length + stablePrefix.text.length + volatileTail.text.length + 4
      );
      expect(base.text.includes('`answer_user`')).toBe(agenticAnswersEnabled);
      expect(base.text.includes('`inspect_session_state`')).toBe(agenticAnswersEnabled);
    }
  );

  test('classifies supported model families and rejects unknown identifiers', () => {
    expect(providerForModel(' gpt-5.6-luna ')).toBe('openai');
    expect(providerForModel('claude-sonnet-4-6')).toBe('anthropic');
    expect(() => providerForModel('mystery-model')).toThrow(ProviderResolutionError);
  });

  test('missing OpenAI key fails at construction instead of falling back to Anthropic', () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    expect(() => new EICRExtractionSession('anthropic-key', 'missing-openai')).toThrow(
      /OPENAI_API_KEY missing/
    );
  });

  test('one session resolves Luna/Terra to OpenAI and Sonnet to Anthropic', () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    const openai = createClient();
    const anthropic = createClient();
    const session = new EICRExtractionSession('anthropic-key', 'provider-matrix', 'eicr', {
      providerClients: { openai, anthropic },
    });

    expect(session.resolveExtractionTarget('gpt-5.6-luna')).toEqual({
      client: openai,
      model: 'gpt-5.6-luna',
      provider: 'openai',
    });
    expect(session.resolveExtractionTarget('gpt-5.6-terra').client).toBe(openai);
    expect(session.resolveExtractionTarget('claude-sonnet-4-6')).toEqual({
      client: anthropic,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
  });

  test('supported model changes between turns reuse the matching provider client', async () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    const openai = createClient({ model: 'gpt-5.6-luna' });
    const session = new EICRExtractionSession('anthropic-key', 'same-client-switch', 'eicr', {
      providerClients: { openai },
    });

    await session.callWithRetry([{ role: 'user', content: 'ordinary reading' }], 1, 'SYSTEM');
    process.env.OBSERVATION_EXTRACT_MODEL = 'gpt-5.6-terra';
    await session.callWithRetry(
      [{ role: 'user', content: 'NEW utterance: observation cracked socket category two\n\n' }],
      1,
      'SYSTEM'
    );

    expect(openai.messages.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'gpt-5.6-luna' }),
      { timeout: 30000 }
    );
    expect(openai.messages.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        service_tier: 'standard',
        reasoning_effort: 'low',
      }),
      { timeout: 30000 }
    );
    expect(session._providerClients.get('openai')).toBe(openai);
    expect(session._providerClients.size).toBe(1);
  });

  test('legacy observation routing uses the observation model matching client even with the live flag off', async () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    process.env.OBSERVATION_EXTRACT_MODEL = 'claude-sonnet-4-6';
    process.env.OBSERVATION_TIER_ROUTING = 'false';
    const openai = createClient();
    const anthropic = createClient({ model: 'claude-sonnet-4-6' });
    const session = new EICRExtractionSession('anthropic-key', 'legacy-observation', 'eicr', {
      providerClients: { openai, anthropic },
    });

    await session.callWithRetry(
      [{ role: 'user', content: 'NEW utterance: observation cracked socket category two\n\n' }],
      1,
      'SYSTEM'
    );

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      { timeout: 30000 }
    );
    expect(openai.messages.create).not.toHaveBeenCalled();
  });

  test('cache keepalive resolves the default model/client pair atomically', async () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    const openai = createClient({ model: 'gpt-5.6-luna' });
    const session = new EICRExtractionSession('anthropic-key', 'keepalive-provider', 'eicr', {
      providerClients: { openai },
    });
    session.isActive = true;

    await session._sendCacheKeepalive();
    session._clearCacheKeepalive();

    expect(openai.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-luna' })
    );
  });

  test('two paused-session keepalives are distinct billable rounds with zero inspector turns', async () => {
    jest.useFakeTimers();
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    process.env.OPENAI_EXTRACT_SERVICE_TIER = 'fast';
    const openai = createClient({
      model: 'gpt-5.6-luna-2026-07-30',
      response_model: 'gpt-5.6-luna-2026-07-30',
      response_service_tier: 'priority',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const session = new EICRExtractionSession('anthropic-key', 'keepalive-accounting', 'eicr', {
      providerClients: { openai },
    });
    const countsDuringDispatch = [];
    const response = await openai.messages.create();
    openai.messages.create.mockReset().mockImplementation(async () => {
      countsDuringDispatch.push(session.costTracker.inFlightBillableInvocationCount);
      return { ...response };
    });
    session.isActive = true;
    session._resetCacheKeepalive();
    session.pause();

    try {
      await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
      await jest.advanceTimersByTimeAsync(4 * 60 * 1000);

      expect(countsDuringDispatch).toEqual([1, 1]);
      expect(session.costTracker.sonnet.turns).toBe(0);
      expect(session.costTracker.loopInvocations).toBe(2);
      expect(session.costTracker.completedModelRounds).toBe(2);
      expect(session.costTracker.inFlightBillableInvocationCount).toBe(0);
      expect(session.costTracker.roundUsageEvidence.map((item) => item.kind)).toEqual([
        'cache_keepalive',
        'cache_keepalive',
      ]);
      expect(
        new Set(session.costTracker.roundUsageEvidence.map((item) => item.loop_invocation_id)).size
      ).toBe(2);
      expect(session.costTracker.sonnet.inputTokens).toBe(20);
      const firstEvidence = session.costTracker.roundUsageEvidence[0];
      const costAfterBothKeepalives = session.costTracker.sonnetCost;
      expect(
        session.costTracker.ingestBillableUsage(
          firstEvidence.loop_invocation_id,
          [firstEvidence],
          'cache_keepalive'
        )
      ).toBe(false);
      expect(session.costTracker.sonnetCost).toBe(costAfterBothKeepalives);
    } finally {
      session._clearCacheKeepalive();
      clearTimeout(session.pauseKeepaliveDeadlineHandle);
      session.pauseKeepaliveDeadlineHandle = null;
      jest.useRealTimers();
    }
  });

  test('orphan review owns one non-inspector scope and never increments public turns', async () => {
    process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
    const openai = createClient({
      model: 'gpt-5.6-luna',
      response_model: 'gpt-5.6-luna',
      response_service_tier: null,
      content: [
        {
          type: 'tool_use',
          input: { questions_for_user: [] },
        },
      ],
      usage: { input_tokens: 7, output_tokens: 1 },
    });
    const session = new EICRExtractionSession('anthropic-key', 'orphan-accounting', 'eicr', {
      providerClients: { openai },
    });
    const countsDuringDispatch = [];
    const response = await openai.messages.create();
    openai.messages.create.mockReset().mockImplementation(async () => {
      countsDuringDispatch.push(session.costTracker.inFlightBillableInvocationCount);
      return { ...response };
    });
    session.isActive = true;
    session.conversationHistory = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];

    await session.reviewForOrphanedValues();

    expect(session.costTracker.sonnet.turns).toBe(0);
    expect(session.costTracker.loopInvocations).toBe(1);
    expect(session.costTracker.completedModelRounds).toBe(1);
    expect(session.costTracker.inFlightBillableInvocationCount).toBe(0);
    expect(session.costTracker.roundUsageEvidence[0].kind).toBe('orphan_review');
    expect(countsDuringDispatch).toEqual([1]);
  });

  test('production selection inventory uses the canonical resolver or whole-loop fence', () => {
    const sessionSource = fs.readFileSync(
      new URL('../extraction/eicr-extraction-session.js', import.meta.url),
      'utf8'
    );
    const harnessSource = fs.readFileSync(
      new URL('../extraction/stage6-shadow-harness.js', import.meta.url),
      'utf8'
    );
    const loopSource = fs.readFileSync(
      new URL('../extraction/stage6-tool-loop.js', import.meta.url),
      'utf8'
    );

    expect(sessionSource.match(/resolveExtractionTarget\(/g)).toHaveLength(3);
    expect(harnessSource).toContain('return session.resolveExtractionTarget(model);');
    expect(loopSource).toContain('assertSameProvider(model, configuredRound1Override);');
    expect(loopSource).toContain('const modelProvider = providerForModel(model);');
  });

  test('keepalive cadence and paused-session budget remain the shipped 4m/15m contract', () => {
    const source = fs.readFileSync(
      new URL('../extraction/eicr-extraction-session.js', import.meta.url),
      'utf8'
    );
    expect(source).toContain('const CACHE_KEEPALIVE_MS = 4 * 60 * 1000;');
    expect(source).toContain('const PAUSE_KEEPALIVE_BUDGET_MS = 15 * 60 * 1000;');
    expect(source).toContain(
      'this.cacheKeepaliveHandle = setTimeout(() => this._sendCacheKeepalive(), CACHE_KEEPALIVE_MS);'
    );
    expect(source).not.toMatch(/25\s*\*\s*60\s*\*\s*1000/);
  });
});

describe('whole-loop provider invariant', () => {
  test.each([
    ['gpt-5.6-luna', 'openai', 'claude-haiku-4-5-20251001'],
    ['claude-haiku-4-5-20251001', 'anthropic', 'gpt-5.6-luna'],
  ])(
    'cross-provider override %s -> %s fails before SDK dispatch',
    async (model, provider, override) => {
      process.env.VOICE_LATENCY_ROUND1_MODEL = override;
      const client = createClient();

      await expect(
        runToolLoop({
          client,
          model,
          provider,
          system: 'SYSTEM',
          messages: [{ role: 'user', content: 'reading' }],
          tools: [],
          dispatcher: jest.fn(),
          ctx: {},
          logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        })
      ).rejects.toThrow(/Cross-provider round-one override is unsupported/);

      expect(client.messages.stream).not.toHaveBeenCalled();
    }
  );

  test('same-provider Luna to Terra round-one override reaches the SDK once', async () => {
    process.env.VOICE_LATENCY_ROUND1_MODEL = 'gpt-5.6-terra';
    const events = [
      {
        type: 'message_start',
        message: { id: 'm1', role: 'assistant', content: [], model: 'gpt-5.6-terra' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      async finalMessage() {
        return {
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          model: 'gpt-5.6-terra',
          usage: {},
        };
      },
    };
    const client = { messages: { stream: jest.fn(() => stream) } };

    await runToolLoop({
      client,
      model: 'gpt-5.6-luna',
      provider: 'openai',
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'reading' }],
      tools: [],
      dispatcher: jest.fn(),
      ctx: {},
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    expect(client.messages.stream).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-terra' }),
      undefined
    );
  });
});
