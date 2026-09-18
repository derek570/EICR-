/**
 * openai-vision-adapter — reasoning-family detection.
 *
 * Why: until 2026-09-18 the adapter tested /^gpt-5/ to decide whether a
 * model needs reasoning headroom and a `reasoning_effort`. A gpt-6 model
 * name (gpt-6-astra) matched neither, so it ran at the vendor default
 * effort against a 4096-token cap that reasoning tokens also count
 * against — the exact empty-content failure the adapter's guard exists
 * for. These tests pin the request shape per model family and the
 * OPENAI_VISION_REASONING_EFFORT override.
 */
import { jest } from '@jest/globals';

const mockCreate = jest.fn();
jest.unstable_mockModule('openai', () => ({
  default: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: mockCreate } };
    }
  },
}));

const { createOpenAIAnthropicAdapter } = await import('../extraction/openai-vision-adapter.js');

const OK_RESPONSE = {
  choices: [{ message: { content: '{"entries":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

async function requestFor(model) {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(OK_RESPONSE);
  const adapter = createOpenAIAnthropicAdapter({ apiKey: 'test' });
  await adapter.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  return mockCreate.mock.calls[0][0];
}

describe('openai-vision-adapter reasoning family', () => {
  const saved = process.env.OPENAI_VISION_REASONING_EFFORT;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_VISION_REASONING_EFFORT;
    else process.env.OPENAI_VISION_REASONING_EFFORT = saved;
  });

  test('gpt-5.5 gets reasoning headroom and effort none', async () => {
    delete process.env.OPENAI_VISION_REASONING_EFFORT;
    const req = await requestFor('gpt-5.5');
    expect(req.max_completion_tokens).toBe(16384);
    expect(req.reasoning_effort).toBe('none');
  });

  test("gpt-6-astra gets the same headroom but effort 'low' — it rejects 'none'", async () => {
    delete process.env.OPENAI_VISION_REASONING_EFFORT;
    const req = await requestFor('gpt-6-astra');
    expect(req.max_completion_tokens).toBe(16384);
    expect(req.reasoning_effort).toBe('low');
  });

  test('OPENAI_VISION_REASONING_EFFORT overrides the effort', async () => {
    process.env.OPENAI_VISION_REASONING_EFFORT = 'low';
    const req = await requestFor('gpt-6-astra');
    expect(req.reasoning_effort).toBe('low');
  });

  test("OPENAI_VISION_REASONING_EFFORT='default' omits the field entirely", async () => {
    process.env.OPENAI_VISION_REASONING_EFFORT = 'default';
    const req = await requestFor('gpt-6-astra');
    expect(req).not.toHaveProperty('reasoning_effort');
    expect(req.max_completion_tokens).toBe(16384);
  });

  test('a non-reasoning model name keeps the plain cap and no effort field', async () => {
    delete process.env.OPENAI_VISION_REASONING_EFFORT;
    const req = await requestFor('gpt-4.1');
    expect(req.max_completion_tokens).toBe(4096);
    expect(req).not.toHaveProperty('reasoning_effort');
  });
});
