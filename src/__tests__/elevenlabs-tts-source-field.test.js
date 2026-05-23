/**
 * /api/proxy/elevenlabs-tts — Stage 1a commit 1a.5 `source` field
 * contract. Pins:
 *   - missing source → 'confirmation' default (back-compat with old iOS)
 *   - empty-string source → 'confirmation' default
 *   - non-string source → 'confirmation' default
 *   - valid string source → echoed in success log
 *
 * We DON'T exercise the actual ElevenLabs HTTP call here — fetch is
 * mocked to return a tiny buffer. The behavioural contract is the
 * shape of the success-log payload + the absence of any source-derived
 * branching today (Stage 3 will add suppression branching, Stage 5
 * will route 'question' differently).
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

jest.unstable_mockModule('../extraction/active-sessions.js', () => ({
  activeSessions: new Map(),
  recordElevenLabsUsageForSession: jest.fn().mockReturnValue(false),
}));

// keys.js imports * as storage from '../storage.js'; storage.js touches
// import.meta.dirname which Jest's experimental VM modules trip on. We
// don't exercise storage in this contract test so a no-op mock is fine.
jest.unstable_mockModule('../storage.js', () => ({
  downloadText: jest.fn(),
  uploadText: jest.fn(),
}));

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  arrayBuffer: async () => new ArrayBuffer(128),
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

function findSuccessLog() {
  return mockLogger.info.mock.calls
    .filter((c) => c[0] === 'ElevenLabs TTS success')
    .map((c) => c[1]);
}

describe('/api/proxy/elevenlabs-tts — Stage 1a.5 source field', () => {
  let request;
  beforeAll(async () => {
    request = (await import('supertest')).default;
  });

  afterEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    global.fetch.mockClear();
  });

  test('missing source defaults to "confirmation"', async () => {
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello' });
    expect(res.status).toBe(200);
    const log = findSuccessLog()[0];
    expect(log.source).toBe('confirmation');
  });

  test('empty-string source defaults to "confirmation"', async () => {
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello', source: '' });
    expect(findSuccessLog()[0].source).toBe('confirmation');
  });

  test('non-string source defaults to "confirmation"', async () => {
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello', source: 42 });
    expect(findSuccessLog()[0].source).toBe('confirmation');
  });

  test('source="correction" is echoed in the success log', async () => {
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'no, make that 17', source: 'correction' });
    expect(findSuccessLog()[0].source).toBe('correction');
  });

  test('source="notification" is accepted (suppression-exempt category)', async () => {
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Server disconnected', source: 'notification' });
    expect(findSuccessLog()[0].source).toBe('notification');
  });

  test('unknown source string is passed through (Stage 1a is lenient)', async () => {
    const app = await buildApp();
    const token = await authToken();
    await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hello', source: 'future_source' });
    expect(findSuccessLog()[0].source).toBe('future_source');
  });

  test('400 still returned for missing text regardless of source', async () => {
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/elevenlabs-tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'confirmation' });
    expect(res.status).toBe(400);
  });
});
