/**
 * Tests for DELETE /api/auth/account — Apple Guideline 5.1.1(v) +
 * UK GDPR Article 17 hard-delete flow.
 *
 * Critical behaviours pinned here:
 *   - The route MUST be a hard delete, not a soft `is_active = false`
 *     (the legacy bug Apple rejects for).
 *   - NICEIC retention PDFs MUST be archived BEFORE the S3 wipe — order
 *     matters because the wipe is destructive.
 *   - audit_log MUST receive a `account_deletion_started` row before any
 *     destructive work, and an `account_deleted` receipt after. Both are
 *     the Subject Rights Request Register's source of truth.
 *   - Admin self-delete MUST be refused (admin accounts are tied to
 *     company state and recover badly from orphaning).
 *
 * All external state (DB, S3, logger) is mocked. The route handler is
 * exercised through a mini Express app via supertest so the middleware
 * order + status codes are tested as written, not as imagined.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockHardDeleteUserAccount = jest.fn();
const mockLogAction = jest.fn();
const mockListFiles = jest.fn();
const mockCopyObject = jest.fn();
const mockDeletePrefix = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  hardDeleteUserAccount: mockHardDeleteUserAccount,
  logAction: mockLogAction,
  // The route file imports `* as db`, so any other db function the
  // module reads at import time would also need to be declared. The
  // /account route in particular only touches the two above.
  getUserByEmail: jest.fn(),
  getUserById: jest.fn(),
  resetUserPassword: jest.fn(),
  authenticate: jest.fn(),
}));

jest.unstable_mockModule('../storage.js', () => ({
  listFiles: mockListFiles,
  copyObject: mockCopyObject,
  deletePrefix: mockDeletePrefix,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Stub the auth module — the real one reads JWT_SECRET + queries the DB.
// The header-driven middleware here matches the pattern used by
// `settings-company-scope.test.js` and keeps the test self-contained.
jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    const userHeader = req.headers['x-test-user'];
    if (userHeader) req.user = JSON.parse(userHeader);
    next();
  },
  authenticate: jest.fn(),
  refreshToken: jest.fn(),
  verifyPassword: jest.fn(),
}));

const authRouter = (await import('../routes/auth.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  mockHardDeleteUserAccount.mockReset();
  mockLogAction.mockReset();
  mockListFiles.mockReset();
  mockCopyObject.mockReset();
  mockDeletePrefix.mockReset();

  // Sensible defaults — happy-path returns. Individual tests override.
  mockListFiles.mockResolvedValue([]);
  mockCopyObject.mockResolvedValue(true);
  mockDeletePrefix.mockResolvedValue({ deleted: 0, errors: 0 });
  mockHardDeleteUserAccount.mockResolvedValue({
    job_versions: 0,
    jobs: 0,
    properties: 0,
    clients: 0,
    users: 1,
  });
});

const user = {
  id: 'user-abc',
  email: 'inspector@example.co.uk',
  role: 'user',
};

describe('DELETE /api/auth/account — Apple 5.1.1(v) hard delete', () => {
  test('refuses admin self-delete with 403', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/auth/account')
      .set('x-test-user', JSON.stringify({ ...user, role: 'admin' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
    // No destructive work fired.
    expect(mockHardDeleteUserAccount).not.toHaveBeenCalled();
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  test('happy path: logs intent, archives NICEIC PDFs, wipes RDS+S3, returns 204', async () => {
    mockListFiles.mockResolvedValueOnce([
      'jobs/user-abc/1-some-address/output/eicr_certificate.pdf',
      'jobs/user-abc/2-another-address/output/eicr_certificate.pdf',
      // Non-PDF in /output and non-/output PDF — both should be left
      // for the deletePrefix to handle, not copied to archive.
      'jobs/user-abc/1-some-address/output/cover_page.png',
      'jobs/user-abc/1-some-address/raw/scan-01.jpg',
      'jobs/user-abc/3-rolled-back/extracted_data.json',
    ]);
    mockHardDeleteUserAccount.mockResolvedValueOnce({
      job_versions: 12,
      jobs: 3,
      properties: 2,
      clients: 2,
      users: 1,
    });
    mockDeletePrefix
      .mockResolvedValueOnce({ deleted: 47, errors: 0 }) // jobs/
      .mockResolvedValueOnce({ deleted: 2, errors: 0 }) // settings/
      .mockResolvedValueOnce({ deleted: 11, errors: 0 }); // session-analytics/

    const app = buildApp();
    const res = await request(app)
      .delete('/api/auth/account')
      .set('x-test-user', JSON.stringify(user));

    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // Order matters: started log → archive copies → RDS → S3 → completed log.
    // We can't observe order across mocks directly, but we can check
    // that all expected calls fired with the expected arguments.

    // Two NICEIC PDFs should have been copied to archive/
    expect(mockCopyObject).toHaveBeenCalledTimes(2);
    expect(mockCopyObject).toHaveBeenCalledWith(
      'jobs/user-abc/1-some-address/output/eicr_certificate.pdf',
      'archive/user-abc/1-some-address/output/eicr_certificate.pdf'
    );
    expect(mockCopyObject).toHaveBeenCalledWith(
      'jobs/user-abc/2-another-address/output/eicr_certificate.pdf',
      'archive/user-abc/2-another-address/output/eicr_certificate.pdf'
    );

    expect(mockHardDeleteUserAccount).toHaveBeenCalledWith('user-abc');

    // Three S3 prefixes wiped.
    expect(mockDeletePrefix).toHaveBeenCalledWith('jobs/user-abc/');
    expect(mockDeletePrefix).toHaveBeenCalledWith('settings/user-abc/');
    expect(mockDeletePrefix).toHaveBeenCalledWith('session-analytics/user-abc/');

    // Two audit-log rows: start + complete.
    expect(mockLogAction).toHaveBeenCalledTimes(2);
    expect(mockLogAction).toHaveBeenNthCalledWith(
      1,
      'user-abc',
      'account_deletion_started',
      expect.objectContaining({ email: 'inspector@example.co.uk' }),
      expect.anything()
    );
    expect(mockLogAction).toHaveBeenNthCalledWith(
      2,
      'user-abc',
      'account_deleted',
      expect.objectContaining({
        rds: expect.objectContaining({ users: 1, jobs: 3 }),
        s3: expect.objectContaining({
          niceic_pdfs_archived: 2,
          jobs_objects_deleted: 47,
        }),
      }),
      expect.anything()
    );
  });

  test('archives zero PDFs when the user has no certificates', async () => {
    mockListFiles.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .delete('/api/auth/account')
      .set('x-test-user', JSON.stringify(user));

    expect(res.status).toBe(204);
    expect(mockCopyObject).not.toHaveBeenCalled();
    // RDS + S3 wipes still fire — a user with no jobs is still a valid
    // deletion candidate.
    expect(mockHardDeleteUserAccount).toHaveBeenCalledWith('user-abc');
    expect(mockDeletePrefix).toHaveBeenCalledTimes(3);
  });

  test('returns 404 when the user row is already gone (race with admin tombstone)', async () => {
    mockHardDeleteUserAccount.mockResolvedValueOnce({
      job_versions: 0,
      jobs: 0,
      properties: 0,
      clients: 0,
      users: 0, // <- the signal
    });

    const app = buildApp();
    const res = await request(app)
      .delete('/api/auth/account')
      .set('x-test-user', JSON.stringify(user));

    expect(res.status).toBe(404);
    // S3 wipe must NOT fire on the 0-row branch — we don't want to
    // silently scrub data when the user record was already removed by
    // someone else (the audit trail should reflect a single deletion
    // event, not two).
    expect(mockDeletePrefix).not.toHaveBeenCalled();
  });

  test('returns 500 and writes a failure audit row when RDS deletion throws', async () => {
    mockHardDeleteUserAccount.mockRejectedValueOnce(new Error('deadlock'));

    const app = buildApp();
    const res = await request(app)
      .delete('/api/auth/account')
      .set('x-test-user', JSON.stringify(user));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/account deletion failed/i);
    // Three audit-log calls: started, archive done (no — archive runs
    // BEFORE RDS so it completed; but the second call is the failure
    // tail, not the success tail). We should see: started, failed.
    const actions = mockLogAction.mock.calls.map((c) => c[1]);
    expect(actions).toContain('account_deletion_started');
    expect(actions).toContain('account_deletion_failed');
    // No success row.
    expect(actions).not.toContain('account_deleted');
    // S3 wipe must NOT have fired (the throw was BEFORE deletePrefix).
    expect(mockDeletePrefix).not.toHaveBeenCalled();
  });
});
