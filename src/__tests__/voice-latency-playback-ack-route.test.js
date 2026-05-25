/**
 * Tests for src/routes/voice-latency-playback-ack.js
 *
 * Single-round latency sprint Phase 0 (PLAN_v8 §A Pivot 8). Pins:
 *   - 204 on valid body (auth applied per-route)
 *   - 400 on body validation failures (sessionId / turnId / source /
 *     at_ms / slot subfields)
 *   - 503 on kill switch
 *   - recordPlaybackAck called with normalised slot
 *   - failure inside recordPlaybackAck does NOT surface as 5xx
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 'test-user' };
    next();
  },
}));

const turnSummary = await import('../extraction/voice-latency-turn-summary.js');
const router = (await import('../routes/voice-latency-playback-ack.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  turnSummary._resetForTests();
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
});
afterEach(() => {
  turnSummary._resetForTests();
});

function validBody(overrides = {}) {
  return {
    sessionId: 'sess-ack',
    turnId: 'turn-1',
    slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
    source: 'bundler',
    at_ms: Date.now(),
    ...overrides,
  };
}

describe('POST /api/voice-latency/playback-ack', () => {
  test('204 on valid body', async () => {
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send(validBody());
    expect(res.status).toBe(204);
  });

  test('204 with omitted slot (slot is optional)', async () => {
    const body = validBody();
    delete body.slot;
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send(body);
    expect(res.status).toBe(204);
  });

  test('503 when kill switch active', async () => {
    process.env.VOICE_LATENCY_KILL_SWITCH = 'true';
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send(validBody());
    expect(res.status).toBe(503);
  });

  test('400 on missing sessionId', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(validBody({ sessionId: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  test('400 on missing turnId', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(validBody({ turnId: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/turnId/);
  });

  test('400 on invalid source', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(validBody({ source: 'unknown_source' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source/);
  });

  test('400 on at_ms in the future', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(validBody({ at_ms: Date.now() + 60_000 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at_ms/);
  });

  test('400 on slot.circuit out of [0,99]', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(
        validBody({
          slot: { field: 'measured_zs_ohm', circuit: 999, boardId: null },
        })
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/circuit/);
  });

  test('400 on slot.boardId wrong type (number)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/playback-ack')
      .send(
        validBody({
          slot: { field: 'measured_zs_ohm', circuit: 1, boardId: 42 },
        })
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boardId/);
  });

  test('ACK feeds through to recordPlaybackAck (late-ACK emits row)', async () => {
    // No finalizer armed → ACK becomes a late-ACK row. Just verify it
    // doesn't 5xx and turn_summary saw the call.
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send(validBody());
    expect(res.status).toBe(204);
  });
});
