import { jest } from '@jest/globals';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';
import {
  ProviderResolutionError,
  providerForModel,
} from '../extraction/model-provider.js';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { renderSystemPrompt } from '../extraction/system-prompt-renderer.js';

const ENV_KEYS = [
  'SONNET_EXTRACT_MODEL',
  'OBSERVATION_EXTRACT_MODEL',
  'OBSERVATION_TIER_ROUTING',
  'OPENAI_API_KEY',
  'OPENAI_EXTRACT_API',
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
  test('real split snapshot blocks render with explicit boundaries and unchanged block text', () => {
    const anthropic = createClient();
    const session = new EICRExtractionSession('anthropic-key', 'prompt-golden', 'eicr', {
      providerClients: { anthropic },
      toolCallsMode: 'live',
      snapshotFormat: 'split_blocks',
    });
    session.updateStateSnapshot({
      extracted_readings: [{ circuit: 3, field: 'measured_zs_ohm', value: '0.63' }],
    });
    const blocks = session.buildSystemBlocks();
    const nonEmptyBlockTexts = blocks.map((block) => block.text).filter(Boolean);

    expect(nonEmptyBlockTexts.length).toBeGreaterThan(1);
    expect(renderSystemPrompt(blocks)).toBe(nonEmptyBlockTexts.join('\n\n'));
    expect(renderSystemPrompt(blocks)).toContain('\n\nEXTRACTED');
  });

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
});

describe('whole-loop provider invariant', () => {
  test('cross-provider round-one override fails before SDK dispatch', async () => {
    process.env.VOICE_LATENCY_ROUND1_MODEL = 'claude-haiku-4-5-20251001';
    const client = createClient();

    await expect(
      runToolLoop({
        client,
        model: 'gpt-5.6-luna',
        provider: 'openai',
        system: 'SYSTEM',
        messages: [{ role: 'user', content: 'reading' }],
        tools: [],
        dispatcher: jest.fn(),
        ctx: {},
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      })
    ).rejects.toThrow(/Cross-provider round-one override is unsupported/);

    expect(client.messages.stream).not.toHaveBeenCalled();
  });
});
