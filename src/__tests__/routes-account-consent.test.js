/**
 * Tests for POST /api/account/consent/accept and GET /api/account/consent/status.
 *
 * Pinned behaviours:
 *   - Body shape validation rejects malformed submissions with the
 *     specific `code` the client gates on.
 *   - Stale-version submissions are rejected (the "user tried to bind
 *     to an older soft draft" guard).
 *   - Clock-skew tolerance window is enforced both directions.
 *   - Idempotent re-submission returns 200, not 500.
 *   - ip_address + user_agent are captured from request headers, not
 *     accepted from the client body.
 *   - Unknown agreement kinds and platforms are rejected.
 *   - /status surfaces the right consent_pending bool.
 */

import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockRecordAccountConsent = jest.fn();
const mockGetMostRecentAcceptedConsent = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  recordAccountConsent: mockRecordAccountConsent,
  getMostRecentAcceptedConsent: mockGetMostRecentAcceptedConsent,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    const userHeader = req.headers['x-test-user'];
    if (userHeader) req.user = JSON.parse(userHeader);
    next();
  },
}));

const accountRouter = (await import('../routes/account.js')).default;
const { CURRENT_VERSIONS } = await import('../lib/legal-text-versions.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/account', accountRouter);
  return app;
}

const user = { id: 'user-abc', email: 'inspector@example.co.uk', role: 'user' };
const CURRENT_BTA = CURRENT_VERSIONS.beta_tester_agreement;

beforeEach(() => {
  mockRecordAccountConsent.mockReset();
  mockGetMostRecentAcceptedConsent.mockReset();
});

describe('POST /api/account/consent/accept', () => {
  test('accepts a well-formed current-version submission', async () => {
    mockRecordAccountConsent.mockResolvedValue({
      id: 1,
      accepted_at: new Date('2026-05-12T10:00:00Z'),
      recorded_at: new Date('2026-05-12T10:00:01Z'),
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: new Date().toISOString(),
        platform: 'ios',
        platform_version: '360',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.consent_id).toBe(1);
    expect(mockRecordAccountConsent).toHaveBeenCalledTimes(1);
    const arg = mockRecordAccountConsent.mock.calls[0][0];
    expect(arg.userId).toBe('user-abc');
    expect(arg.agreementKind).toBe('beta_tester_agreement');
    expect(arg.agreementVersion).toBe(CURRENT_BTA);
  });

  test('rejects body missing agreement_kind', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_version: CURRENT_BTA,
        accepted_at: new Date().toISOString(),
        platform: 'ios',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });

  test('rejects unknown agreement_kind', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'not_a_real_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: new Date().toISOString(),
        platform: 'ios',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_kind');
  });

  test('rejects stale agreement_version', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: '2024-01-01',
        accepted_at: new Date().toISOString(),
        platform: 'ios',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('stale_version');
    expect(res.body.current_version).toBe(CURRENT_BTA);
  });

  test('rejects accepted_at more than 5 min in the past', async () => {
    const app = buildApp();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: stale,
        platform: 'ios',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('clock_skew');
  });

  test('rejects accepted_at more than 1 min in the future', async () => {
    const app = buildApp();
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: future,
        platform: 'ios',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('clock_skew');
  });

  test('rejects unknown platform', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: new Date().toISOString(),
        platform: 'fitbit',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_platform');
  });

  test('captures ip_address from x-forwarded-for header, not body', async () => {
    mockRecordAccountConsent.mockResolvedValue({
      id: 2,
      accepted_at: new Date(),
      recorded_at: new Date(),
    });
    const app = buildApp();
    await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .set('x-forwarded-for', '198.51.100.7, 192.0.2.1')
      .send({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: CURRENT_BTA,
        accepted_at: new Date().toISOString(),
        platform: 'web',
        ip_address: 'CLIENT-SUPPLIED-LIE',
      });
    const arg = mockRecordAccountConsent.mock.calls[0][0];
    expect(arg.ipAddress).toBe('198.51.100.7');
  });

  test('idempotent re-submit returns 200 (DB ON CONFLICT path)', async () => {
    mockRecordAccountConsent.mockResolvedValue({
      id: 1,
      accepted_at: new Date(),
      recorded_at: new Date(),
    });
    const app = buildApp();
    const body = {
      agreement_kind: 'beta_tester_agreement',
      agreement_version: CURRENT_BTA,
      accepted_at: new Date().toISOString(),
      platform: 'ios',
      platform_version: '360',
    };
    const first = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send(body);
    const second = await request(app)
      .post('/api/account/consent/accept')
      .set('x-test-user', JSON.stringify(user))
      .send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('GET /api/account/consent/status', () => {
  test('returns consent_pending=false when row exists', async () => {
    mockGetMostRecentAcceptedConsent.mockResolvedValue({
      id: 1,
      accepted_at: new Date('2026-05-12T10:00:00Z'),
      recorded_at: new Date('2026-05-12T10:00:01Z'),
    });
    const app = buildApp();
    const res = await request(app)
      .get('/api/account/consent/status')
      .set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(200);
    expect(res.body.consent_pending).toBe(false);
    expect(res.body.current_agreement_version).toBe(CURRENT_BTA);
  });

  test('returns consent_pending=true when no row exists', async () => {
    mockGetMostRecentAcceptedConsent.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app)
      .get('/api/account/consent/status')
      .set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(200);
    expect(res.body.consent_pending).toBe(true);
    expect(res.body.current_agreement_version).toBe(CURRENT_BTA);
  });
});
