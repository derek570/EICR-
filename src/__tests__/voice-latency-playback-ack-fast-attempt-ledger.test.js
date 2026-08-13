/**
 * Plan B (feedback ids 118/119) B3.1 — the playback-ack route's additive
 * wiring into fast-path-accepted-identity.js's fast-attempt ledger.
 *
 * Additive, second no-throw side effect beside the existing
 * `recordOutcome`/`recordPlaybackAck` telemetry calls — never surfaces as a
 * 5xx, never changes the 204 response shape.
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
const fastIdentity = await import('../extraction/fast-path-accepted-identity.js');
const router = (await import('../routes/voice-latency-playback-ack.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  turnSummary._resetForTests();
  fastIdentity._resetForTests();
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
});
afterEach(() => {
  turnSummary._resetForTests();
  fastIdentity._resetForTests();
});

describe('POST /api/voice-latency/playback-ack — fast-attempt ledger wiring', () => {
  test("source:'fast_tts' + correlation_id transitions a pending record to playback_started", async () => {
    fastIdentity.markFastAttemptPending('cid-1', {
      sessionId: 'sess-ack',
      turnId: 'turn-1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
      rawValue: '0.62',
    });
    expect(fastIdentity.getFastAttemptState('cid-1')).toBe('pending');

    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send({
      sessionId: 'sess-ack',
      source: 'fast_tts',
      correlation_id: 'cid-1',
      at_ms: Date.now(),
    });
    expect(res.status).toBe(204);
    expect(fastIdentity.getFastAttemptState('cid-1')).toBe('playback_started');
  });

  test("source:'bundler' with a correlation_id does NOT touch the fast-attempt ledger", async () => {
    fastIdentity.markFastAttemptPending('cid-2', {
      sessionId: 'sess-ack',
      turnId: 'turn-1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
      rawValue: '0.62',
    });
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send({
      sessionId: 'sess-ack',
      turnId: 'turn-1',
      source: 'bundler',
      correlation_id: 'cid-2',
      at_ms: Date.now(),
    });
    expect(res.status).toBe(204);
    // Gated on source==='fast_tts' — an ordinary bundler ACK that happens to
    // carry a correlation_id (e.g. an ask-path TTS clip's id) must never
    // mutate a fast-attempt record it doesn't own.
    expect(fastIdentity.getFastAttemptState('cid-2')).toBe('pending');
  });

  test('a fast_tts ACK for an unknown correlation_id is a harmless no-op (no crash, still 204)', async () => {
    const res = await request(buildApp()).post('/api/voice-latency/playback-ack').send({
      sessionId: 'sess-ack',
      source: 'fast_tts',
      correlation_id: 'cid-never-seen',
      at_ms: Date.now(),
    });
    expect(res.status).toBe(204);
    expect(fastIdentity.getFastAttemptState('cid-never-seen')).toBeNull();
  });
});
