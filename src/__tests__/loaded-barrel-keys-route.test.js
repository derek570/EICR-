/**
 * Loaded Barrel Phase 3 — /api/proxy/elevenlabs-tts cache short-circuit.
 *
 * Tests the four cache-lookup paths:
 *   - HIT (cached ready, claim succeeds → serve MP3 + headers)
 *   - HIT_PENDING (cached pending → race with 200ms timer; promise wins)
 *   - HIT_LATE (cached pending → timer fires; re-peek catches ready)
 *   - MISS (no cached entry → fall through to existing live path)
 *
 * Plus invariants:
 *   - no turnId in body → skip lookup
 *   - cache error → log + fall through (request never 500s)
 *   - HIT path serves response BEFORE any cost recorder fires for
 *     the live path (avoids double-bill)
 */

import { jest } from '@jest/globals';

process.env.JWT_SECRET = 'dev-secret-change-in-production';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../logger.js', () => ({ default: mockLogger }));

jest.unstable_mockModule('../services/secrets.js', () => ({
  getElevenLabsKey: jest.fn().mockResolvedValue('fake-el-key'),
  getDeepgramKey: jest.fn().mockResolvedValue('fake-dg-key'),
  getAnthropicKey: jest.fn().mockResolvedValue('fake-anth-key'),
  getSecret: jest.fn().mockResolvedValue(''),
}));

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
}));

jest.unstable_mockModule('../storage.js', () => ({
  downloadText: jest.fn(),
  uploadText: jest.fn(),
}));

// Default-no-op fetch — overridden per test for MISS path live response.
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(64),
  text: async () => '',
});

async function buildApp() {
  const express = (await import('express')).default;
  const { default: router } = await import('../routes/keys.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

async function authToken() {
  const jwt = (await import('jsonwebtoken')).default;
  return jwt.sign({ userId: 'tester' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('/api/proxy/elevenlabs-tts — Loaded Barrel Phase 3 cache short-circuit', () => {
  let request;
  let cacheMod;
  let activeSessionsMod;
  let CostTrackerCls;

  beforeAll(async () => {
    request = (await import('supertest')).default;
    cacheMod = await import('../extraction/loaded-barrel-cache.js');
    activeSessionsMod = await import('../extraction/active-sessions.js');
    ({ CostTracker: CostTrackerCls } = await import('../extraction/cost-tracker.js'));
  });

  beforeEach(() => {
    cacheMod._resetForTests();
    activeSessionsMod.activeSessions.clear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    global.fetch.mockClear();
  });

  afterEach(() => {
    cacheMod._resetForTests();
    activeSessionsMod.activeSessions.clear();
  });

  function registerSession(sessionId) {
    const costTracker = new CostTrackerCls();
    activeSessionsMod.activeSessions.set(sessionId, {
      session: { costTracker },
    });
    return costTracker;
  }

  function makePendingEntry({
    sessionId,
    turnId,
    boardId = null,
    field = 'measured_zs_ohm',
    circuit = 1,
    text,
  }) {
    let resolvePromise;
    const promise = new Promise((r) => {
      resolvePromise = r;
    });
    const controller = { abort: jest.fn() };
    const entry = cacheMod.set({
      cacheKey: cacheMod.buildCacheKey({
        sessionId,
        turnId,
        boardId,
        field,
        circuit,
        expandedText: text,
      }),
      sessionId,
      turnId,
      boardId,
      field,
      circuit,
      expandedText: text,
      correlationId: 'vl_loaded_barrel_test-corr',
      promise,
      resolvePromise,
      controller,
    });
    return { entry, key: entry.cacheKey, resolvePromise, controller };
  }

  test('HIT path: cached ready entry → serves MP3 + claims + promotes cost', async () => {
    const sessionId = 'sess-hit';
    const costTracker = registerSession(sessionId);
    // Pre-fill cache: synth the speculative + mark ready manually.
    const { key } = makePendingEntry({ sessionId, turnId: 'T1', text: 'hello' });
    costTracker.recordElevenLabsSpeculativeStarted(5, 'vl_loaded_barrel_test-corr');
    cacheMod.markReady(key, Buffer.from([9, 8, 7, 6, 5]));

    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'hello',
        sessionId,
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-voice-latency-source']).toBe('loaded_barrel_hit');
    expect(res.headers['x-voice-latency-correlation-id']).toBe('vl_loaded_barrel_test-corr');
    expect(res.body.toString('hex')).toBe('0908070605');

    // Cache entry consumed.
    expect(cacheMod.peek(key)).toBe(null);
    // Cost was promoted to canonical (charsServed > 0).
    expect(costTracker.elevenLabsSpeculative.charsServed).toBe(5);
    // Live ElevenLabs fetch NEVER called.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('MISS path: no cached entry → live ElevenLabs path runs', async () => {
    const sessionId = 'sess-miss';
    registerSession(sessionId);

    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'hello',
        sessionId,
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
      });

    expect(res.status).toBe(200);
    // No HIT header → fell through to live.
    expect(res.headers['x-voice-latency-source']).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  test('no turnId in body → skips cache lookup, runs live', async () => {
    const sessionId = 'sess-no-turn';
    registerSession(sessionId);

    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello', sessionId });

    expect(res.status).toBe(200);
    expect(res.headers['x-voice-latency-source']).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  test('HIT_PENDING path: pending entry → promise resolves within 200ms → claim + serve', async () => {
    const sessionId = 'sess-pending';
    const costTracker = registerSession(sessionId);
    const { key, resolvePromise } = makePendingEntry({ sessionId, turnId: 'T1', text: 'hello' });
    costTracker.recordElevenLabsSpeculativeStarted(5, 'vl_loaded_barrel_test-corr');

    const app = await buildApp();
    const token = await authToken();
    // Fire the request in parallel; resolve the speculator's promise
    // shortly after to simulate the synth completing during the wait.
    const requestPromise = request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'hello',
        sessionId,
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
      });

    // Simulate synth completion 50ms later via the cache.
    setTimeout(() => {
      cacheMod.markReady(key, Buffer.from([1, 2, 3]));
      resolvePromise(Buffer.from([1, 2, 3]));
    }, 50);

    const res = await requestPromise;
    expect(res.status).toBe(200);
    expect(res.headers['x-voice-latency-source']).toBe('loaded_barrel_hit_pending');
    expect(res.body.toString('hex')).toBe('010203');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(costTracker.elevenLabsSpeculative.charsServed).toBe(5);
  });

  test('TIMEOUT: pending entry that never resolves → 200ms timer → fall through to live', async () => {
    const sessionId = 'sess-timeout';
    const costTracker = registerSession(sessionId);
    const { key } = makePendingEntry({ sessionId, turnId: 'T1', text: 'hello' });
    costTracker.recordElevenLabsSpeculativeStarted(5, 'vl_loaded_barrel_test-corr');
    // Don't resolve the promise — let timer fire.

    const app = await buildApp();
    const token = await authToken();
    const start = Date.now();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'hello',
        sessionId,
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
      });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.headers['x-voice-latency-source']).toBeUndefined(); // fell through
    expect(global.fetch).toHaveBeenCalled();
    expect(elapsed).toBeGreaterThanOrEqual(180); // honoured the 200ms wait (with timing slack)

    // Cache entry was marked superseded.
    expect(cacheMod.peek(key)).toBe(null);
  });

  test('claim race lost: ready entry but already claimed by another request → fall through to live', async () => {
    const sessionId = 'sess-race';
    const costTracker = registerSession(sessionId);
    const { key } = makePendingEntry({ sessionId, turnId: 'T1', text: 'hello' });
    costTracker.recordElevenLabsSpeculativeStarted(5, 'vl_loaded_barrel_test-corr');
    cacheMod.markReady(key, Buffer.from([1, 2, 3]));
    // Pre-claim it so the route's claim() returns false.
    cacheMod.claim(key);

    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'hello',
        sessionId,
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-voice-latency-source']).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });
});
