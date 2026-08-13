/**
 * Voice-latency Stage 0 bench routes — gate behaviour.
 *
 * The bench routes are throwaway and gated by STAGE0_BENCH=1. The real
 * synthesis paths hit the paid ElevenLabs API; we don't exercise those
 * here. What we DO pin:
 *
 *   1. With the flag unset (production default), every route returns 404
 *      — confirms ordinary clients see no surface.
 *   2. With the flag set, the route is reachable and requires auth.
 *
 * That's the entire test surface for a throwaway module.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

process.env.JWT_SECRET = 'dev-secret-change-in-production';

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../services/secrets.js', () => ({
  getElevenLabsKey: jest.fn().mockResolvedValue(null), // forces 500 before opening WS
  getDeepgramKey: jest.fn().mockResolvedValue('test-deepgram-key'),
  getAnthropicKey: jest.fn().mockResolvedValue('test-anthropic-key'),
  getSecret: jest.fn().mockResolvedValue(''),
}));

// D1 (feedback id 121) — a controllable fake WS so the language-pin test
// below can drive open/message/close without hitting the real vendor.
class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    FakeWS.instances.push(this);
  }
  send() {}
  close() {}
}
FakeWS.instances = [];
FakeWS.reset = () => {
  FakeWS.instances.length = 0;
};
jest.unstable_mockModule('ws', () => ({ default: FakeWS, WebSocket: FakeWS }));

// auth.requireAuth resolves the JWT against db.getUserById — mock a valid
// active user so authenticated requests get through to the route handler.
// getUserByEmail mocked for the bench-mint-jwt endpoint.
jest.unstable_mockModule('../db.js', () => ({
  getUserById: jest.fn().mockResolvedValue({
    id: 'tester',
    email: 'tester@example.com',
    name: 'Test User',
    is_active: true,
    role: 'user',
    company_id: null,
    company_role: 'employee',
  }),
  getUserByEmail: jest.fn().mockResolvedValue({
    id: 'tester',
    email: 'tester@example.com',
    name: 'Test User',
    is_active: true,
    role: 'user',
    company_id: null,
    company_role: 'employee',
    token_version: 0,
  }),
}));

const benchModulePath = '../routes/voice-latency-bench.js';

async function buildApp() {
  const express = (await import('express')).default;
  const { default: benchRouter } = await import(benchModulePath);
  const app = express();
  app.use(express.json());
  app.use('/api', benchRouter);
  return app;
}

async function authToken() {
  const jwt = (await import('jsonwebtoken')).default;
  return jwt.sign({ userId: 'tester' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('voice-latency-bench routes', () => {
  let request;
  beforeAll(async () => {
    request = (await import('supertest')).default;
  });

  afterEach(() => {
    delete process.env.STAGE0_BENCH;
  });

  test('PCM stream — 404 when STAGE0_BENCH is unset', async () => {
    delete process.env.STAGE0_BENCH;
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/test/elevenlabs-pcm-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(404);
  });

  test('MP3 stream — 404 when STAGE0_BENCH is unset', async () => {
    delete process.env.STAGE0_BENCH;
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/test/elevenlabs-mp3-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(404);
  });

  test('PCM stream — 404 when STAGE0_BENCH=0 explicitly', async () => {
    process.env.STAGE0_BENCH = '0';
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/test/elevenlabs-pcm-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(404);
  });

  test('PCM stream — 401 when bench enabled but unauthenticated', async () => {
    process.env.STAGE0_BENCH = '1';
    const app = await buildApp();
    const res = await request(app).post('/api/test/elevenlabs-pcm-stream').send({ text: 'hello' });
    expect([401, 403]).toContain(res.status);
  });

  test('PCM stream — 500 when bench enabled, authed, but API key missing', async () => {
    process.env.STAGE0_BENCH = '1';
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/test/elevenlabs-pcm-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/api key/i);
  });

  test('PCM stream — 400 when text is empty', async () => {
    process.env.STAGE0_BENCH = '1';
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/test/elevenlabs-pcm-stream')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  // D1 (feedback id 121) — the bench opens its own WS (not
  // ElevenLabsStreamClient), so it is pinned but FAIL-CLOSED: no
  // compatibility retry, exactly one WS instance regardless of outcome.
  //
  // Exercised directly against `streamElevenLabsToResponse` (test-only
  // export) with a minimal fake `res`, NOT through supertest/HTTP — the
  // route's own error-response shaping (Transfer-Encoding + res.json, a
  // pre-existing, out-of-D1-scope defect logged separately as a
  // [FOLLOWUP]) is irrelevant to the pin/no-retry contract this covers,
  // and a real HTTP round-trip only added flakiness and open-handle
  // jest warnings for no additional signal.
  describe('language_code pin (D1, fail-closed)', () => {
    let streamElevenLabsToResponse, _buildBenchStreamUrl;
    beforeAll(async () => {
      ({ streamElevenLabsToResponse, _buildBenchStreamUrl } = await import(benchModulePath));
    });
    beforeEach(() => FakeWS.reset());

    function fakeRes() {
      return { set: jest.fn(), write: jest.fn(), end: jest.fn() };
    }

    test('_buildBenchStreamUrl carries language_code=en', () => {
      expect(_buildBenchStreamUrl('pcm_22050')).toContain('language_code=en');
    });

    test('WS is opened with the pinned URL, and a normal completion resolves', async () => {
      const res = fakeRes();
      const promise = streamElevenLabsToResponse({
        text: 'hello',
        outputFormat: 'pcm_22050',
        contentType: 'audio/L16; rate=22050; channels=1',
        apiKey: 'test-key',
        res,
      });

      expect(FakeWS.instances.length).toBe(1);
      expect(FakeWS.instances[0].url).toContain('language_code=en');
      FakeWS.instances[0].emit('open');
      FakeWS.instances[0].emit('message', JSON.stringify({ isFinal: true }));

      await promise;
      expect(res.end).toHaveBeenCalled();
    });

    test('a vendor rejection is terminal — exactly one WS instance, no retry', async () => {
      const res = fakeRes();
      const promise = streamElevenLabsToResponse({
        text: 'hello',
        outputFormat: 'pcm_22050',
        contentType: 'audio/L16; rate=22050; channels=1',
        apiKey: 'test-key',
        res,
      });

      FakeWS.instances[0].emit('open');
      FakeWS.instances[0].emit('message', JSON.stringify({ error: 'invalid_language_code' }));

      await expect(promise).rejects.toThrow(/invalid_language_code/);
      expect(FakeWS.instances.length).toBe(1);
    });
  });
});
