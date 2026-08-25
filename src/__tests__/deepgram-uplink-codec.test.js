/**
 * PLAN-E1 E1 — POST /api/proxy/deepgram-streaming-key gains an additive
 * `uplink_codec` field. Contract: the field is ALWAYS present (never
 * omitted) on the response of a backend carrying this change, resolved
 * from DEEPGRAM_UPLINK_CODEC at module load, defaulting to `linear16` for
 * unset/invalid config. "Absent" is the old-backend compatibility case,
 * which clients handle themselves — not reproducible from this backend.
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
  getDeepgramKey: jest.fn().mockResolvedValue('fake-dg-master-key'),
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

global.fetch = jest.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'fake-jwt-grant' }),
    text: async () => '',
  })
);

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

describe('POST /api/proxy/deepgram-streaming-key — uplink_codec contract', () => {
  let request;

  beforeAll(async () => {
    request = (await import('supertest')).default;
  });

  beforeEach(() => {
    global.fetch.mockClear();
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_UPLINK_CODEC;
    jest.resetModules();
  });

  test('unset DEEPGRAM_UPLINK_CODEC → response ALWAYS carries uplink_codec: linear16 (never omitted)', async () => {
    delete process.env.DEEPGRAM_UPLINK_CODEC;
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/deepgram-streaming-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');
    expect(res.body).toHaveProperty('uplink_codec', 'linear16');
  });

  test('DEEPGRAM_UPLINK_CODEC=opus → response carries uplink_codec: opus', async () => {
    process.env.DEEPGRAM_UPLINK_CODEC = 'opus';
    jest.resetModules();
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/deepgram-streaming-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.uplink_codec).toBe('opus');
  });

  test('invalid DEEPGRAM_UPLINK_CODEC → falls back to linear16 and logs a startup warning', async () => {
    process.env.DEEPGRAM_UPLINK_CODEC = 'flac';
    jest.resetModules();
    mockLogger.warn.mockClear();
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/deepgram-streaming-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.uplink_codec).toBe('linear16');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DEEPGRAM_UPLINK_CODEC'),
      expect.objectContaining({ configured: 'flac' })
    );
  });

  test('empty-string DEEPGRAM_UPLINK_CODEC is treated as unset → linear16', async () => {
    process.env.DEEPGRAM_UPLINK_CODEC = '';
    jest.resetModules();
    const app = await buildApp();
    const token = await authToken();
    const res = await request(app)
      .post('/api/proxy/deepgram-streaming-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.uplink_codec).toBe('linear16');
  });
});
