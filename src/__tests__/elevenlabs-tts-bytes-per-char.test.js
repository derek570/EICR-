/**
 * /api/proxy/elevenlabs-tts — INV-2 bytes-per-char telemetry contract.
 *
 * Background (field session 6B6FE011 F1): ElevenLabs Flash returned
 * 172,661 bytes (~11s @128kbps) for a 33-char address read-back — a
 * garbled synth at ≈5232 bytes/char — while the 42-char twin utterance
 * synthesised normally at 41,839 bytes (≈996 bytes/char). Normal synth
 * runs ~1000-1300 bytes/char, so the route now:
 *   - stamps `bytes_per_char` on every "ElevenLabs TTS success" row
 *   - emits a WARN `elevenlabs_tts_audio_anomaly` row when the ratio
 *     STRICTLY exceeds the guarded absolute threshold of 2500 (the
 *     DECIDED rule — no session-median state)
 *
 * Pins:
 *   - success log carries bytes_per_char (bytes / textLength, 1dp)
 *   - anomaly WARN fires above threshold with a CloudWatch-queryable
 *     payload (sessionId, bytes, textLength, bytes_per_char, model_id)
 *   - no WARN at exactly the threshold or in the normal-synth range
 *   - empty text never reaches the ratio path (400 guard upstream)
 *
 * Same harness as elevenlabs-tts-source-field.test.js — fetch is mocked
 * to a reader-style streaming response so we control the byte count; the
 * real ElevenLabs HTTP call is never exercised. The streaming WS path
 * (elevenlabs-stream-client.js / loaded-barrel speculative TTS) is
 * deliberately OUT OF SCOPE for the anomaly check and these tests.
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

// getVoiceLatencyForSession → null makes the Stage 2.5 streaming gate
// decline cleanly for requests that carry a sessionId, keeping every
// test on the legacy batch path where the success log + anomaly WARN
// live. (We never send turnId, so the loaded-barrel cache short-circuit
// is skipped too — its `sessionId && turnId` gate.)
jest.unstable_mockModule('../extraction/active-sessions.js', () => ({
  activeSessions: new Map(),
  recordElevenLabsUsageForSession: jest.fn().mockReturnValue(false),
  getVoiceLatencyForSession: jest.fn().mockReturnValue(null),
  recordElevenLabsStreamingStartedForSession: jest.fn(),
  recordElevenLabsStreamingTerminalForSession: jest.fn(),
  promoteSpeculativeToCanonicalForSession: jest.fn(),
}));

// keys.js imports * as storage from '../storage.js'; storage.js touches
// import.meta.dirname which Jest's experimental VM modules trip on. We
// don't exercise storage in this contract test so a no-op mock is fine.
jest.unstable_mockModule('../storage.js', () => ({
  downloadText: jest.fn(),
  uploadText: jest.fn(),
}));

// Single-chunk ReadableStream-like reader (Tier 2a shape) with a
// parameterised byte count so each test drives the bytes/textLength
// ratio it needs. Default 128 bytes matches the source-field harness.
let nextResponseBytes = 128;
function mockStreamingResponse(byteCount) {
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
            return { done: false, value: new Uint8Array(byteCount) };
          },
          releaseLock() {},
        };
      },
    },
    arrayBuffer: async () => new ArrayBuffer(byteCount),
    text: async () => '',
  };
}
global.fetch = jest
  .fn()
  .mockImplementation(() => Promise.resolve(mockStreamingResponse(nextResponseBytes)));

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

function findSuccessLog() {
  return mockLogger.info.mock.calls
    .filter((c) => c[0] === 'ElevenLabs TTS success')
    .map((c) => c[1]);
}

function findAnomalyWarns() {
  return mockLogger.warn.mock.calls
    .filter((c) => c[0] === 'elevenlabs_tts_audio_anomaly')
    .map((c) => c[1]);
}

describe('/api/proxy/elevenlabs-tts — INV-2 bytes_per_char telemetry', () => {
  let request;
  beforeAll(async () => {
    request = (await import('supertest')).default;
  });

  afterEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    global.fetch.mockClear();
    nextResponseBytes = 128;
  });

  test('success log carries bytes_per_char = bytes / textLength (1dp)', async () => {
    nextResponseBytes = 5200; // 'hello' = 5 chars → 1040.0, normal-synth range
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(200);
    const log = findSuccessLog()[0];
    expect(log.bytes).toBe(5200);
    expect(log.textLength).toBe(5);
    expect(log.bytes_per_char).toBe(1040);
  });

  test('anomaly WARN fires above the 2500 threshold with a queryable payload', async () => {
    // The literal F1 field numbers: 172,661 bytes for a 33-char read-back.
    const text = 'Flat 3, 12 Example Road, Anytown.'; // 33 chars
    expect(text.length).toBe(33);
    nextResponseBytes = 172661; // ≈5232.2 bytes/char
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text, sessionId: 'sess_anomaly' });
    expect(res.status).toBe(200);

    const warns = findAnomalyWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      sessionId: 'sess_anomaly',
      bytes: 172661,
      textLength: 33,
      bytes_per_char: 5232.2,
      model_id: 'eleven_flash_v2_5',
    });
    // The success row carries the same ratio so the two are joinable.
    expect(findSuccessLog()[0].bytes_per_char).toBe(5232.2);
  });

  test('no WARN at exactly the threshold (strictly greater)', async () => {
    nextResponseBytes = 10000; // 'abcd' = 4 chars → exactly 2500.0
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'abcd' });
    expect(findSuccessLog()[0].bytes_per_char).toBe(2500);
    expect(findAnomalyWarns()).toHaveLength(0);
  });

  test('no WARN in the normal-synth range (~1000 bytes/char)', async () => {
    // The F1 twin utterance: 41,839 bytes for 42 chars ≈ 996 bytes/char.
    const text = 'Flat 3, 12 Example Road, Anytown, AB1 2CD.'; // 42 chars
    expect(text.length).toBe(42);
    nextResponseBytes = 41839;
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text, sessionId: 'sess_normal' });
    expect(findSuccessLog()[0].bytes_per_char).toBe(996.2);
    expect(findAnomalyWarns()).toHaveLength(0);
  });

  test('empty text is rejected 400 before the ratio path — no success log, no WARN', async () => {
    nextResponseBytes = 999999;
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: '' });
    expect(res.status).toBe(400);
    expect(findSuccessLog()).toHaveLength(0);
    expect(findAnomalyWarns()).toHaveLength(0);
  });
});
