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
});
