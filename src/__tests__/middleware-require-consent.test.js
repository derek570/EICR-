/**
 * Tests for the require-consent middleware.
 *
 * Pinned behaviours:
 *   - PASS when an acceptance row exists for the current version.
 *   - 403 + code:'consent_required' when no row exists.
 *   - PASS (fail-open) when the DB throws — keeps local dev usable
 *     against a stub DB without staging the consent migration.
 *   - PASS when req.user is missing (the requireAuth-skipped path).
 */

import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetMostRecentAcceptedConsent = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
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

const { requireConsent } = await import('../middleware/require-consent.js');
const { CURRENT_VERSIONS } = await import('../lib/legal-text-versions.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Test-only: stamp req.user from a header so requireConsent runs in isolation.
  app.use((req, _res, next) => {
    const u = req.headers['x-test-user'];
    if (u) req.user = JSON.parse(u);
    next();
  });
  app.get('/gated', requireConsent, (_req, res) => res.json({ ok: true }));
  return app;
}

const user = { id: 'user-abc', email: 'a@b' };

beforeEach(() => {
  mockGetMostRecentAcceptedConsent.mockReset();
});

describe('requireConsent middleware', () => {
  test('passes when a current-version row exists', async () => {
    mockGetMostRecentAcceptedConsent.mockResolvedValue({ id: 1 });
    const app = buildApp();
    const res = await request(app).get('/gated').set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 403 + consent_required when no row exists', async () => {
    mockGetMostRecentAcceptedConsent.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/gated').set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('consent_required');
    expect(res.body.current_version).toBe(CURRENT_VERSIONS.beta_tester_agreement);
  });

  test('fails open when DB throws (local-dev / DB-unavailable path)', async () => {
    mockGetMostRecentAcceptedConsent.mockRejectedValue(new Error('connection refused'));
    const app = buildApp();
    const res = await request(app).get('/gated').set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(200);
  });

  test('passes when req.user is missing (requireAuth-skipped path)', async () => {
    const app = buildApp();
    // No x-test-user header → no req.user.
    const res = await request(app).get('/gated');
    expect(res.status).toBe(200);
    expect(mockGetMostRecentAcceptedConsent).not.toHaveBeenCalled();
  });
});
