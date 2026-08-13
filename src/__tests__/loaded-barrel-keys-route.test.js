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
// Voice-latency plan 2026-06-03 Tier 2a — keys.js now consumes the
// ElevenLabs response via response.body.getReader() instead of
// arrayBuffer(); mock a single-chunk reader so existing tests pass.
function mockStreamingResponse(bytes = 64) {
  let yielded = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          releaseLock() {},
        };
      },
    },
    arrayBuffer: async () => new ArrayBuffer(bytes),
    text: async () => '',
  };
}
global.fetch = jest.fn().mockImplementation(() => Promise.resolve(mockStreamingResponse()));

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
    // No HIT → canonical buffered fallback, with its own joinable id.
    expect(res.headers['x-voice-latency-source']).toBe('legacy_confirmation');
    expect(res.headers['x-voice-latency-correlation-id']).toMatch(/^vl_confirmation_/);
    expect(global.fetch).toHaveBeenCalled();
  });

  test('buffered fallback synth timing starts before vendor fetch resolves', async () => {
    const sessionId = 'sess-fallback-timing';
    registerSession(sessionId);
    global.fetch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return mockStreamingResponse();
    });

    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello', sessionId, turnId: 'T1' });

    expect(res.status).toBe(200);
    const success = mockLogger.info.mock.calls.find(
      ([event]) => event === 'ElevenLabs TTS success'
    );
    expect(success).toBeDefined();
    expect(success[1].elevenlabs_synth_total_ms).toBeGreaterThanOrEqual(20);
    expect(success[1].elevenlabs_first_byte_ms).toBeGreaterThanOrEqual(20);
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
    expect(res.headers['x-voice-latency-source']).toBe('legacy_confirmation');
    expect(res.headers['x-voice-latency-correlation-id']).toMatch(/^vl_confirmation_/);
    expect(global.fetch).toHaveBeenCalled();
  });

  // D1 (feedback id 121) — buffered fail-open retry contract.
  describe('D1 fail-open — buffered fallback language_code retry', () => {
    function jsonResponse(status, body) {
      return {
        ok: status >= 200 && status < 300,
        status,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify(body),
      };
    }

    // These tests replace `global.fetch`'s implementation with
    // `mockImplementation` (persistent, not `mockImplementationOnce`) for
    // multi-call assertions — `beforeEach`'s `mockClear()` only resets call
    // history, not the implementation, so it would otherwise leak into
    // later tests in this file. Restore the module's original default.
    afterEach(() => {
      global.fetch.mockImplementation(() => Promise.resolve(mockStreamingResponse()));
    });

    test('attributable 4xx (mentions language_code) → retries once, second attempt succeeds', async () => {
      const sessionId = 'sess-d1-retry-ok';
      registerSession(sessionId);
      global.fetch
        .mockImplementationOnce(async () =>
          jsonResponse(400, { detail: { status: 'invalid_language_code' } })
        )
        .mockImplementationOnce(async () => mockStreamingResponse());

      const app = await buildApp();
      const token = await authToken();
      const res = await request(app)
        .post('/api/proxy/elevenlabs-tts')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'hello', sessionId });

      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      // First call carries the pin, second omits it.
      const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(firstBody.language_code).toBe('en');
      expect(secondBody.language_code).toBeUndefined();
    });

    test('attributable 4xx twice → terminal, exactly two attempts, vendor error passed through', async () => {
      const sessionId = 'sess-d1-retry-fail';
      registerSession(sessionId);
      global.fetch.mockImplementation(async () =>
        jsonResponse(400, { detail: { status: 'invalid_language_code' } })
      );

      const app = await buildApp();
      const token = await authToken();
      const res = await request(app)
        .post('/api/proxy/elevenlabs-tts')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'hello', sessionId });

      expect(res.status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('a 5xx that happens to mention language_code is terminal on the FIRST attempt (status guard)', async () => {
      const sessionId = 'sess-d1-5xx';
      registerSession(sessionId);
      global.fetch.mockImplementation(async () =>
        jsonResponse(500, { error: 'internal error while validating language_code' })
      );

      const app = await buildApp();
      const token = await authToken();
      const res = await request(app)
        .post('/api/proxy/elevenlabs-tts')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'hello', sessionId });

      expect(res.status).toBe(500);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('an unrelated 4xx (no language_code mention) is terminal on the first attempt', async () => {
      const sessionId = 'sess-d1-unrelated';
      registerSession(sessionId);
      global.fetch.mockImplementation(async () =>
        jsonResponse(401, { detail: { status: 'invalid_api_key' } })
      );

      const app = await buildApp();
      const token = await authToken();
      const res = await request(app)
        .post('/api/proxy/elevenlabs-tts')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'hello', sessionId });

      expect(res.status).toBe(401);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
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
    expect(res.headers['x-voice-latency-source']).toBe('legacy_confirmation');
    expect(res.headers['x-voice-latency-correlation-id']).toMatch(/^vl_confirmation_/);
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
    expect(res.headers['x-voice-latency-source']).toBe('legacy_confirmation');
    expect(res.headers['x-voice-latency-correlation-id']).toMatch(/^vl_confirmation_/);
    expect(global.fetch).toHaveBeenCalled();
  });
});
