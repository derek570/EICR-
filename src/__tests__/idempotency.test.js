/**
 * Tests for the idempotency middleware (src/middleware/idempotency.js).
 *
 * The middleware protects expensive routes (analyze-ccu) from duplicate
 * billing when iOS retries the same capture under flaky network. These
 * tests cover every state transition: cache miss, cache hit, in-flight
 * collision, error path, missing/malformed key, Redis-down fallback.
 */

import { jest } from '@jest/globals';

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();
const mockIsRedisAvailable = jest.fn();

jest.unstable_mockModule('../queue.js', () => ({
  getConnection: () => ({
    get: mockGet,
    set: mockSet,
    del: mockDel,
  }),
  isRedisAvailable: mockIsRedisAvailable,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { withIdempotency } = await import('../middleware/idempotency.js');
const { default: express } = await import('express');
const { default: supertest } = await import('supertest');

function buildApp({ userId = 'user-1', handler } = {}) {
  const app = express();
  app.use(express.json());
  // Stub auth — analyze-ccu sits behind requireAuth in production, the
  // middleware itself only reads req.user.id.
  app.use((req, _res, next) => {
    req.user = { id: userId };
    next();
  });
  app.post('/test', withIdempotency('ccu'), handler);
  return app;
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockDel.mockReset();
  mockIsRedisAvailable.mockReset();
  mockIsRedisAvailable.mockReturnValue(true);
});

describe('idempotency middleware', () => {
  test('passes through when no X-Idempotency-Key header is present (backwards-compat)', async () => {
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    const app = buildApp({ handler });

    const response = await supertest(app).post('/test').send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    // Critical: no Redis interaction at all when key is absent
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('passes through when key is too short (malformed)', async () => {
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    const app = buildApp({ handler });

    await supertest(app).post('/test').set('X-Idempotency-Key', 'short').send({});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('passes through when Redis is unavailable (graceful fallback)', async () => {
    mockIsRedisAvailable.mockReturnValue(false);
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('first call (cache miss) wins the race, runs handler, caches the result on 200', async () => {
    mockSet.mockResolvedValue('OK'); // SET NX returns "OK" → race won
    const handler = jest.fn((req, res) => res.json({ result: 'computed' }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'computed' });
    expect(response.headers['x-idempotency-replay']).toBeUndefined();

    // Initial SET NX with inflight marker
    expect(mockSet).toHaveBeenCalledWith(
      'idem:ccu:user-1:11111111-2222-3333-4444-555555555555',
      expect.stringContaining('"phase":"inflight"'),
      'NX',
      'EX',
      120
    );

    // After response, SET overwrites with the cached result and longer TTL
    expect(mockSet).toHaveBeenCalledWith(
      'idem:ccu:user-1:11111111-2222-3333-4444-555555555555',
      expect.stringContaining('"phase":"done"'),
      'EX',
      600
    );

    // Verify cached body shape — this is what the next duplicate will replay
    const cachedCall = mockSet.mock.calls.find((c) => c[1].includes('"phase":"done"'));
    const cachedValue = JSON.parse(cachedCall[1]);
    expect(cachedValue.statusCode).toBe(200);
    expect(cachedValue.body).toEqual({ result: 'computed' });
  });

  test('duplicate call returns cached body verbatim with X-Idempotency-Replay header', async () => {
    // SET NX fails → race already lost
    mockSet.mockResolvedValue(null);
    // GET returns the cached completed entry from the first call
    mockGet.mockResolvedValue(
      JSON.stringify({
        phase: 'done',
        statusCode: 200,
        body: { result: 'cached-result', circuits: 12 },
        cachedAt: Date.now() - 5000,
      })
    );
    const handler = jest.fn((req, res) => res.json({ result: 'NEVER-RUN' }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'cached-result', circuits: 12 });
    expect(response.headers['x-idempotency-replay']).toBe('1');
    expect(handler).not.toHaveBeenCalled();
  });

  test('in-flight collision returns 409 with Retry-After', async () => {
    mockSet.mockResolvedValue(null);
    mockGet.mockResolvedValue(JSON.stringify({ phase: 'inflight', at: Date.now() - 2000 }));
    const handler = jest.fn((req, res) => res.json({ result: 'NEVER-RUN' }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('idempotency_inflight');
    expect(response.body.retryable).toBe(true);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['x-idempotency-status']).toBe('inflight');
    expect(handler).not.toHaveBeenCalled();
  });

  test('5xx response clears the marker so the next retry can re-attempt', async () => {
    mockSet.mockResolvedValue('OK');
    mockDel.mockResolvedValue(1);
    const handler = jest.fn((req, res) => res.status(500).json({ error: 'boom' }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(500);
    expect(handler).toHaveBeenCalledTimes(1);

    // Critical: marker MUST be cleared on error so a retry can run again.
    // If we left the inflight marker in place, the next retry would 409
    // for the full INFLIGHT_TTL and the user would be stuck.
    expect(mockDel).toHaveBeenCalledWith('idem:ccu:user-1:11111111-2222-3333-4444-555555555555');
    // No "done" cache write on 5xx
    const doneWrites = mockSet.mock.calls.filter((c) => c[1].includes('"phase":"done"'));
    expect(doneWrites).toHaveLength(0);
  });

  test('keys are namespaced per user — same key from different users does not collide', async () => {
    mockSet.mockResolvedValue('OK');
    const handler = jest.fn((req, res) => res.json({ user: req.user.id }));

    const appA = buildApp({ userId: 'user-A', handler });
    const appB = buildApp({ userId: 'user-B', handler });
    const sharedKey = 'shared-uuid-1111-2222-3333-444444444444';

    await supertest(appA).post('/test').set('X-Idempotency-Key', sharedKey).send({});
    await supertest(appB).post('/test').set('X-Idempotency-Key', sharedKey).send({});

    // Two distinct Redis keys created — neither user can poach the other's
    // result by guessing the idempotency key.
    const inflightWrites = mockSet.mock.calls.filter((c) => c[2] === 'NX');
    expect(inflightWrites[0][0]).toBe(`idem:ccu:user-A:${sharedKey}`);
    expect(inflightWrites[1][0]).toBe(`idem:ccu:user-B:${sharedKey}`);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('Redis SET error during marker creation falls through to handler (best-effort protection)', async () => {
    mockSet.mockRejectedValueOnce(new Error('redis down'));
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    // Redis went sideways but the request must still succeed — we'd rather
    // pay for an occasional duplicate than fail the user's capture.
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('corrupt cache entry is dropped and request passes through', async () => {
    mockSet.mockResolvedValue(null);
    mockGet.mockResolvedValue('{not valid json');
    mockDel.mockResolvedValue(1);
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    const app = buildApp({ handler });

    const response = await supertest(app)
      .post('/test')
      .set('X-Idempotency-Key', '11111111-2222-3333-4444-555555555555')
      .send({});

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalled();
  });
});
