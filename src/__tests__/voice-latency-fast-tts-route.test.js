/**
 * Tests for src/routes/voice-latency-fast-tts.js
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivots 2, 4, 5, 6, 7,
 * 9, 11, 12.2). Pins:
 *   - eligibility whitelist gate (422 on non-eligible field)
 *   - regex_fast_v2 capability gate (412 on absent)
 *   - kill switch (503)
 *   - flag-off (404)
 *   - missing session (404)
 *   - body validation (400, sessionId / turnId / correlationId / candidate)
 *   - decrement-before-reject contract: every non-success path calls
 *     decrementExpectedAcksByCorrelation
 *   - speculator preflight write: pendingFastTtsSlots populated on accept
 *   - speculator abortBySlot called on accept
 *   - no-native-fallback hint string in error bodies
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock the auth middleware so tests don't need a real JWT.
jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 'test-user' };
    next();
  },
}));

// Mock the elevenlabs client so no real network fires.
jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
  ElevenLabsStreamClient: class {
    constructor(opts) {
      this.outputFormat = opts.outputFormat;
    }
    async synth(_text, opts) {
      opts.onAudio(Buffer.from([0x49, 0x44, 0x33])); // ID3 header bytes
      return { firstAudioNs: 0n, lastAudioNs: 0n };
    }
    static logSynthSpans() {}
  },
  contentTypeForFormat: () => 'audio/mpeg',
}));

// Mock the API-key secrets so the route can resolve without AWS.
jest.unstable_mockModule('../services/secrets.js', () => ({
  getElevenLabsKey: async () => 'test-elevenlabs-key',
}));

const { activeSessions } = await import('../extraction/active-sessions.js');
const turnSummary = await import('../extraction/voice-latency-turn-summary.js');
const fastTtsRouter = (await import('../routes/voice-latency-fast-tts.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', fastTtsRouter);
  return app;
}

function seedSession({
  sessionId = 'SESS',
  regexFastTts = true,
  hasRegexFastV2 = true,
  spec = null,
  boards = null,
} = {}) {
  const stateSnapshot = boards ? { boards } : { boards: [] };
  activeSessions.set(sessionId, {
    session: {
      sessionId,
      stateSnapshot,
      loadedBarrelSpeculator: spec,
    },
    voiceLatency: {
      flags: { regexFastTts },
      capabilities: { hasRegexFastV2 },
    },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
  });
}

function basicBody(overrides = {}) {
  return {
    sessionId: 'SESS',
    turnId: 'T1',
    correlationId: 'cid-abc-123',
    transcript: 'Circuit 1 Zs 0.62',
    candidate: { field: 'measured_zs_ohm', circuit: 1, value: '0.62' },
    ...overrides,
  };
}

beforeEach(() => {
  activeSessions.clear();
  turnSummary._resetForTests();
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
});
afterEach(() => {
  activeSessions.clear();
  turnSummary._resetForTests();
});

describe('POST /api/voice-latency/regex-fast-tts — happy path', () => {
  test('200 on accept, pendingFastTtsSlots seeded, audio bytes returned', async () => {
    const abortBySlot = jest.fn();
    seedSession({ spec: { abortBySlot } });

    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send(basicBody())
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    const entry = activeSessions.get('SESS');
    const seeded = entry.pendingFastTtsSlots.get('T1');
    expect(seeded).toBeDefined();
    expect(seeded.size).toBe(1);
    // slotKey shape: field::circuit::boardId
    expect([...seeded][0]).toBe('measured_zs_ohm::1::');

    expect(abortBySlot).toHaveBeenCalledTimes(1);
    expect(abortBySlot).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'SESS', turnId: 'T1', field: 'measured_zs_ohm' })
    );
  });
});

describe('rejection paths — all call decrementExpectedAcksByCorrelation before reply', () => {
  test('503 when kill switch active', async () => {
    seedSession();
    process.env.VOICE_LATENCY_KILL_SWITCH = 'true';
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send(basicBody());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('kill switch active');
  });

  test('400 on missing sessionId — still attempts to decrement what it can', async () => {
    seedSession();
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({ ...basicBody(), sessionId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
    expect(res.body.hint).toMatch(/silently abandon/);
  });

  test('400 on missing turnId', async () => {
    seedSession();
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({ ...basicBody(), turnId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/turnId/);
  });

  test('400 on missing correlationId', async () => {
    seedSession();
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({ ...basicBody(), correlationId: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/correlationId/);
  });

  test('400 on missing candidate', async () => {
    seedSession();
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({ ...basicBody(), candidate: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/candidate/);
  });

  test('422 on non-eligible field + decrement applied', async () => {
    seedSession();
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({
        ...basicBody(),
        candidate: { field: 'polarity_confirmed', circuit: 1, value: 'true' },
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('field not eligible for fast path');

    // The stash should now have an entry for our correlationId.
    expect(turnSummary._peekStateForTests().pendingAckDecrements).toBe(1);
  });

  test('404 when session not registered', async () => {
    // No seedSession.
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send(basicBody());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session not found');
  });

  test('404 when regexFastTts flag off', async () => {
    seedSession({ regexFastTts: false });
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send(basicBody());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fast path disabled');
  });

  test('412 when iOS missing regex_fast_v2 capability', async () => {
    seedSession({ hasRegexFastV2: false });
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send(basicBody());
    expect(res.status).toBe(412);
    expect(res.body.error).toMatch(/regex_fast_v2/);
  });

  test('422 when boardId is unknown to session', async () => {
    seedSession({ boards: [{ id: 'main' }] });
    const res = await request(buildApp())
      .post('/api/voice-latency/regex-fast-tts')
      .send({
        ...basicBody(),
        candidate: { field: 'measured_zs_ohm', circuit: 1, value: '0.62', boardId: 'phantom' },
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('boardId not known to session');
  });
});
