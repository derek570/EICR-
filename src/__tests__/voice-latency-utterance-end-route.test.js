/**
 * Tests for src/routes/voice-latency-utterance-end.js
 *
 * Voice-latency plan 2026-06-03 final, Tier 1.3 route. Pins:
 *   - 204 on valid body (both with and without monotonic_at_ms)
 *   - 204 with orphaned:true + null turnId (the iOS TTL-sweep path)
 *   - 400 on body validation failures (sessionId / turnId / utterance_id
 *     / source / at_ms / monotonic_at_ms / process_uptime_id)
 *   - 503 on kill switch
 *   - Emit row carries namespaced utterance_end_monotonic_at_ms +
 *     utterance_end_process_uptime_id fields (required by §CloudWatch query)
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

const loggerCalls = { info: [], warn: [] };
jest.unstable_mockModule('../logger.js', () => ({
  default: {
    info: (msg, payload) => loggerCalls.info.push({ msg, payload }),
    warn: (msg, payload) => loggerCalls.warn.push({ msg, payload }),
  },
}));

const router = (await import('../routes/voice-latency-utterance-end.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  loggerCalls.info.length = 0;
  loggerCalls.warn.length = 0;
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
});

function validBody(overrides = {}) {
  return {
    sessionId: 'sess-ue',
    turnId: 'turn-1',
    utterance_id: 'utt-uuid-1',
    source: 'deepgram_utterance_end',
    at_ms: Date.now(),
    monotonic_at_ms: 12345678.9,
    process_uptime_id: 'proc-uuid-1',
    ...overrides,
  };
}

describe('POST /api/voice-latency/utterance-end', () => {
  test('204 on valid body with monotonic_at_ms', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody());
    expect(res.status).toBe(204);
    // log row should fire with namespaced monotonic field
    const row = loggerCalls.info.find((c) => c.msg === 'voice_latency.utterance_end');
    expect(row).toBeDefined();
    expect(row.payload.utterance_end_monotonic_at_ms).toBe(12345678.9);
    expect(row.payload.utterance_end_process_uptime_id).toBe('proc-uuid-1');
  });

  test('204 with monotonic_at_ms omitted (Deepgram anchor unavailable)', async () => {
    const body = validBody();
    delete body.monotonic_at_ms;
    const res = await request(buildApp()).post('/api/voice-latency/utterance-end').send(body);
    expect(res.status).toBe(204);
    const row = loggerCalls.info.find((c) => c.msg === 'voice_latency.utterance_end');
    expect(row.payload.utterance_end_monotonic_at_ms).toBeNull();
  });

  test('204 with monotonic_at_ms explicitly null', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ monotonic_at_ms: null }));
    expect(res.status).toBe(204);
    const row = loggerCalls.info.find((c) => c.msg === 'voice_latency.utterance_end');
    expect(row.payload.utterance_end_monotonic_at_ms).toBeNull();
  });

  test('204 with orphaned:true and null turnId (iOS TTL-sweep path)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ orphaned: true, turnId: null }));
    expect(res.status).toBe(204);
    const row = loggerCalls.info.find((c) => c.msg === 'voice_latency.utterance_end');
    expect(row.payload.orphaned).toBe(true);
  });

  test('204 with orphaned:true and turnId omitted entirely', async () => {
    const body = validBody({ orphaned: true });
    delete body.turnId;
    const res = await request(buildApp()).post('/api/voice-latency/utterance-end').send(body);
    expect(res.status).toBe(204);
  });

  test('503 when kill switch active', async () => {
    process.env.VOICE_LATENCY_KILL_SWITCH = 'true';
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody());
    expect(res.status).toBe(503);
  });

  test('400 on missing sessionId', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ sessionId: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  test('400 on missing turnId when orphaned !== true', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ turnId: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/turnId/);
  });

  test('400 on missing utterance_id', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ utterance_id: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/utterance_id/);
  });

  test('400 on invalid source', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ source: 'unknown_source' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source/);
  });

  test('400 on at_ms in the future', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ at_ms: Date.now() + 60_000 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at_ms/);
  });

  test('400 on at_ms = 0 (invalid)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ at_ms: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at_ms/);
  });

  test('400 on monotonic_at_ms = 0 (sentinel reserved for null)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ monotonic_at_ms: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/monotonic_at_ms/);
  });

  test('400 on monotonic_at_ms wrong type (string)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ monotonic_at_ms: 'not-a-number' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/monotonic_at_ms/);
  });

  test('400 on missing process_uptime_id', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ process_uptime_id: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/process_uptime_id/);
  });

  test('400 on orphaned wrong type (string)', async () => {
    const res = await request(buildApp())
      .post('/api/voice-latency/utterance-end')
      .send(validBody({ orphaned: 'maybe' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/orphaned/);
  });

  test('accepts all three source enum values', async () => {
    for (const source of ['deepgram_speech_final', 'deepgram_utterance_end', 'silero_vad']) {
      const res = await request(buildApp())
        .post('/api/voice-latency/utterance-end')
        .send(validBody({ source }));
      expect(res.status).toBe(204);
    }
  });
});
