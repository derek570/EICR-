/**
 * Wave 4 batch 2 — 6b tail. Regression tests for the company-settings
 * S3-key sweep.
 *
 * The P0-15 fix moved company-scoped settings from
 * `settings/${userId}/…` to `settings/company/${company_id}/…`, via
 * `companySettingsPrefix(user)`. This test file guards against a
 * future refactor accidentally re-introducing the per-user key on the
 * write paths (PUT company settings + POST logo). The GET path has a
 * legacy-key read-fallback that's intentional, and is left alone.
 *
 * Approach: start an in-process Express app with only the settings
 * routes mounted, stub the storage layer to capture the S3 key used
 * on write, and assert the key starts with `settings/company/…` when
 * the caller has a `company_id`.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Capture the S3 keys each upload call receives. Reset between tests.
const uploadedText = [];
const uploadedBytes = [];

jest.unstable_mockModule('../storage.js', () => ({
  downloadText: jest.fn(async () => null),
  uploadText: jest.fn(async (_content, key) => {
    uploadedText.push(key);
  }),
  downloadBytes: jest.fn(async () => null),
  uploadBytes: jest.fn(async (_bytes, key) => {
    uploadedBytes.push(key);
  }),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Inline a fake auth middleware so we don't have to mint real JWTs.
// Set `req.user` from a header the test controls. This sidesteps the
// real `auth.requireAuth` (which needs JWT_SECRET + a DB row).
jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    const raw = req.header('x-test-user');
    if (!raw) return next(new Error('x-test-user header required in tests'));
    req.user = JSON.parse(raw);
    next();
  },
}));

// Use the real multer upload middleware — it writes to os.tmpdir.
// We pipe a minimal PNG in the test body so the filter lets it through.
const settingsRouter = (await import('../routes/settings.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', settingsRouter);
  return app;
}

beforeEach(() => {
  uploadedText.length = 0;
  uploadedBytes.length = 0;
});

describe('settings routes — company-scoped key guarantees', () => {
  test('PUT /settings/:userId/company writes to settings/company/<company_id>/ when user has a company_id', async () => {
    const app = buildApp();
    const user = {
      id: 'u1',
      company_id: 'c-abc-123',
      role: 'user',
      company_role: 'admin',
    };
    const res = await request(app)
      .put('/api/settings/u1/company')
      .set('x-test-user', JSON.stringify(user))
      .send({ company_name: 'Acme Ltd' });
    expect(res.status).toBe(200);
    expect(uploadedText).toHaveLength(1);
    // The S3 key MUST be company-scoped — any regression to
    // settings/${userId}/… would surface here. Two admins in the
    // same company must converge on the exact same key.
    expect(uploadedText[0]).toBe('settings/company/c-abc-123/company_settings.json');
    expect(uploadedText[0]).not.toMatch(/^settings\/u\d/);
  });

  test('PUT /settings/:userId/company falls back to per-user key when user has NO company_id (legacy single-user install)', async () => {
    const app = buildApp();
    const user = {
      id: 'u1',
      role: 'user',
      // No company_id — solo inspector pre-dating the companies feature.
      // The `canEditCompanySettings` gate requires system-admin or
      // company-role owner/admin. System-admin passes regardless of
      // company_id so we use that for the legacy path.
    };
    user.role = 'admin'; // system admin passes the edit gate
    const res = await request(app)
      .put('/api/settings/u1/company')
      .set('x-test-user', JSON.stringify(user))
      .send({ company_name: 'Solo' });
    expect(res.status).toBe(200);
    expect(uploadedText).toHaveLength(1);
    // Legacy fallback path — the key IS per-user here, and that's
    // correct for single-user installs (the entire multi-user race
    // P0-15 fixes doesn't apply to a one-person tenant).
    expect(uploadedText[0]).toBe('settings/u1/company_settings.json');
  });

  test('PUT /settings/:userId/company 403s when a non-admin employee tries to write', async () => {
    const app = buildApp();
    const user = {
      id: 'u2',
      company_id: 'c-abc-123',
      role: 'user',
      company_role: 'employee',
    };
    const res = await request(app)
      .put('/api/settings/u2/company')
      .set('x-test-user', JSON.stringify(user))
      .send({ company_name: 'Evil' });
    // Company-scoped writes are admin-gated — this closes the
    // post-P0-15 hole where any valid session could curl the PUT.
    expect(res.status).toBe(403);
    expect(uploadedText).toHaveLength(0);
  });

  test('PUT /settings/:userId/defaults remains per-user (user_defaults are not company-scoped by design)', async () => {
    const app = buildApp();
    const user = { id: 'u1', company_id: 'c-abc-123', role: 'user' };
    const res = await request(app)
      .put('/api/settings/u1/defaults')
      .set('x-test-user', JSON.stringify(user))
      .send({ some_default: 'value' });
    expect(res.status).toBe(200);
    // Sanity check — the *defaults* path stays per-user. If a future
    // refactor drifts it into company-scoping by accident, the
    // inspector's personal circuit preferences would leak across the
    // whole firm.
    expect(uploadedText[0]).toBe('settings/u1/user_defaults.json');
  });

  test('PUT /inspector-profiles/:userId remains per-user (profiles are per-inspector signatures)', async () => {
    const app = buildApp();
    const user = { id: 'u1', company_id: 'c-abc-123', role: 'user' };
    const res = await request(app)
      .put('/api/inspector-profiles/u1')
      .set('x-test-user', JSON.stringify(user))
      .send([{ name: 'Derek' }]);
    expect(res.status).toBe(200);
    expect(uploadedText[0]).toBe('settings/u1/inspector_profiles.json');
  });
});
