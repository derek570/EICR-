/**
 * Tests for ccu-preflight-screen.js.
 *
 * The preflight is a Haiku call returning {score, issues, user_message}.
 * Tests mock the anthropic client and assert pass/fail decisions plus
 * the open-fail safety behaviour (Haiku outage must NOT block the
 * pipeline — preflight is best-effort).
 */
import { jest } from '@jest/globals';
import sharp from 'sharp';
import { screenCcuPhoto } from '../extraction/ccu-preflight-screen.js';

function makeAnthropicMock(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    messages: {
      create: jest.fn().mockImplementation(() => {
        if (queue.length === 0) {
          return Promise.reject(new Error('mockAnthropic: no more queued responses'));
        }
        const next = queue.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      }),
    },
  };
}

function makeReply(jsonBody, { fenced = false } = {}) {
  const text = fenced ? '```json\n' + JSON.stringify(jsonBody) + '\n```' : JSON.stringify(jsonBody);
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 800, output_tokens: 40 },
  };
}

async function makeTestImage() {
  // Tiny synthesized JPEG so sharp has something real to resize.
  const data = Buffer.alloc(200 * 200 * 3, 128);
  return sharp(data, { raw: { width: 200, height: 200, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe('screenCcuPhoto', () => {
  test('passes when Haiku scores above the threshold', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(makeReply({ score: 0.92, issues: [], user_message: '' }));
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.92);
    expect(result.issues).toEqual([]);
    expect(result.userMessage).toBeNull();
  });

  test('fails when Haiku scores below the threshold and surfaces the user message', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(
      makeReply({
        score: 0.3,
        issues: ['shadow', 'occlusion'],
        user_message: 'Move your hand out of the frame and retake with even light.',
      })
    );
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0.3);
    expect(result.issues).toEqual(['shadow', 'occlusion']);
    expect(result.userMessage).toMatch(/hand|retake/i);
  });

  test('tolerates fenced ```json response', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(
      makeReply({ score: 0.88, issues: [], user_message: '' }, { fenced: true })
    );
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.88);
  });

  test('uses caller-provided minScore', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(makeReply({ score: 0.75, issues: [], user_message: '' }));
    const result = await screenCcuPhoto({
      imageBuffer: img,
      anthropic,
      minScore: 0.85, // stricter than default
    });
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0.75);
  });

  test('open-fails (pass=true) when the Haiku call rejects', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(new Error('Anthropic 503'));
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.openFail).toBe(true);
    expect(result.diagnostic.preflightError).toMatch(/503/);
  });

  test('open-fails (pass=true) when the Haiku JSON is malformed', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock({
      content: [{ type: 'text', text: 'sorry, not JSON' }],
    });
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.openFail).toBe(true);
    expect(result.diagnostic.parseError).toBeTruthy();
  });

  test('hard-fails when the upload image cannot be decoded', async () => {
    const anthropic = makeAnthropicMock(makeReply({ score: 1, issues: [], user_message: '' }));
    const result = await screenCcuPhoto({
      imageBuffer: Buffer.from('not a real image'),
      anthropic,
    });
    expect(result.pass).toBe(false);
    expect(result.issues).toContain('decode_error');
    expect(result.userMessage).toMatch(/retake/i);
    // anthropic was never consulted
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  test('rejects non-buffer imageBuffer', async () => {
    const anthropic = makeAnthropicMock(makeReply({ score: 1, issues: [], user_message: '' }));
    await expect(screenCcuPhoto({ imageBuffer: 'not a buffer', anthropic })).rejects.toThrow(
      /imageBuffer/
    );
  });

  test('passes when score is missing from response (open-fail to pipeline)', async () => {
    const img = await makeTestImage();
    const anthropic = makeAnthropicMock(makeReply({ issues: ['shadow'], user_message: 'bad' }));
    const result = await screenCcuPhoto({ imageBuffer: img, anthropic });
    // Without a numeric score we don't know what to do — open-fail.
    expect(result.pass).toBe(true);
    expect(result.score).toBeNull();
  });
});
