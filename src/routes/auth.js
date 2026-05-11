/**
 * Auth routes — login, logout, refresh, me, change-password
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as auth from '../auth.js';
import * as db from '../db.js';
import * as storage from '../storage.js';
import logger from '../logger.js';

const router = Router();

/**
 * Login
 * POST /api/auth/login
 * Body: { email: string, password: string }
 *
 * Rate limiting handled by authLimiter applied to all /api/auth/* routes in api.js
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const result = await auth.authenticate(email, password, ipAddress);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({ token: result.token, user: result.user });
  } catch (error) {
    logger.error('Login failed', { error: error.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Logout
 * POST /api/auth/logout
 */
router.post('/logout', auth.requireAuth, async (req, res) => {
  await db.logAction(req.user.id, 'logout');
  res.json({ success: true });
});

/**
 * Refresh an expired token
 * POST /api/auth/refresh
 * Token: Authorization header (preferred) or body { token: string } (legacy)
 */
router.post('/refresh', async (req, res) => {
  try {
    // Prefer Authorization header (iOS client sends token here)
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
    // Fall back to body for backward compatibility (web clients, legacy)
    if (!token && req.body.token) {
      token = req.body.token;
    }
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    const result = await auth.refreshToken(token);
    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }
    res.json({ token: result.token, user: result.user });
  } catch (error) {
    logger.error('Token refresh failed', { error: error.message });
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get('/me', auth.requireAuth, (req, res) => {
  res.json(req.user);
});

/**
 * Delete current user's account — hard delete required by Apple App Store
 * Guideline 5.1.1(v) and UK GDPR Article 17.
 *
 * DELETE /api/auth/account
 *
 * The previous implementation did a soft-delete via `users.is_active = false`.
 * That left every row of personal data in place and did not satisfy either
 * Apple's guideline or GDPR Art. 17 — Apple specifically rejects soft-
 * delete-only flows, and an inactive row still constitutes processing.
 *
 * The new flow is intentionally synchronous (one request, one receipt) so
 * the iOS confirmation modal can show a clear success state. Long-running
 * S3 prefix deletes are bounded — a typical user has <1,000 objects.
 *
 * Order matters here:
 *   1. Pre-flight: refuse admin self-delete (an admin account orphaning
 *      a company is harder to recover from than asking another admin).
 *   2. Audit-log the start of the operation. If anything else fails we
 *      still have a "deletion attempted" row for the Subject Rights
 *      Request Register.
 *   3. Archive NICEIC-retention PDFs into `archive/{userId}/` so the
 *      legal-obligation retention (6 years per NICEIC scheme rules) is
 *      preserved even after the active `jobs/{userId}/` prefix goes.
 *   4. Wipe RDS rows + cascade. This is the atomic moment of erasure.
 *   5. Wipe S3 prefixes (`jobs/`, `settings/`, `session-analytics/`).
 *      Done after RDS so a partial S3 failure leaves no "ghost" rows
 *      in the database pointing at half-deleted prefixes.
 *   6. Audit-log the completion with row counts + bucket. The user row
 *      is gone by this point, but `audit_log.user_id` is a TEXT column
 *      with no FK, so the audit row persists and serves as the receipt.
 */
router.delete('/account', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Admin self-delete is refused. The check here matches the legacy
  // policy — admin accounts are tied to company state and are best
  // deleted by another admin via the admin-users surface.
  if (req.user.role === 'admin') {
    return res.status(403).json({
      error: 'Admin accounts cannot self-delete. Contact another admin.',
    });
  }

  try {
    // Step 1: record intent BEFORE any destructive work. If the rest
    // fails, we still have a paper trail (and the legacy register-style
    // erasure log) that the user requested deletion. We also capture
    // `email` here because once `users` is gone we can't look it up;
    // the register row needs to remain self-contained.
    await db.logAction(
      userId,
      'account_deletion_started',
      {
        email: req.user.email,
        role: req.user.role,
      },
      ipAddress
    );

    // Step 2: archive NICEIC-retention PDFs. Any object at
    //   jobs/{userId}/<folder>/output/*.pdf
    // is a certificate the scheme rules require us to keep for 6 years.
    // Copy each into archive/{userId}/<folder>/<filename>; the original
    // is wiped by the prefix delete in step 4. The userId stays in the
    // archive path so future audit / scheme inspections can correlate
    // archived PDFs to the deleting user — though the user row itself
    // is gone, the inspector name + scheme reg number are embedded in
    // the PDF content itself.
    const jobObjects = await storage.listFiles(`jobs/${userId}/`);
    const niceicPdfs = (jobObjects || []).filter(
      (k) => k.includes('/output/') && k.endsWith('.pdf')
    );
    let archived = 0;
    for (const srcKey of niceicPdfs) {
      // jobs/{userId}/<folder>/output/<file>.pdf
      //  →  archive/{userId}/<folder>/output/<file>.pdf
      const dstKey = `archive/${userId}/${srcKey.slice(`jobs/${userId}/`.length)}`;
      const ok = await storage.copyObject(srcKey, dstKey);
      if (ok) archived += 1;
    }

    // Step 3: RDS hard-delete in a transaction. The function audits its
    // own foreign-key coverage in its docstring — read it before changing
    // the per-table deletion order below.
    const rdsCounts = await db.hardDeleteUserAccount(userId);

    // If the user row didn't exist (deleted concurrently? race with an
    // admin tombstone?), bail without touching S3 — there's nothing to
    // wipe and we shouldn't proceed silently because the audit story
    // becomes confusing.
    if (rdsCounts.users === 0) {
      logger.warn('Account deletion: user row absent at delete time', { userId });
      return res.status(404).json({ error: 'Account not found or already deleted.' });
    }

    // Step 4: wipe S3 prefixes. `deletePrefix` paginates + batch-deletes
    // up to 1,000 keys per call; for a typical user the bulk is in
    // jobs/{userId}/. `deletePrefix` returns counts; we surface them
    // in the audit row but don't treat per-prefix failures as fatal —
    // RDS is the source of truth for "is this account live?", and a
    // stray S3 object can be cleaned up by background lifecycle.
    const jobsWipe = await storage.deletePrefix(`jobs/${userId}/`);
    const settingsWipe = await storage.deletePrefix(`settings/${userId}/`);
    const analyticsWipe = await storage.deletePrefix(`session-analytics/${userId}/`);

    // Step 5: completion log. This row sits in audit_log forever as the
    // erasure receipt — UK GDPR Art. 17(3)(b) allows retention of the
    // log for legal-obligation purposes even after the underlying user
    // is gone.
    await db.logAction(
      userId,
      'account_deleted',
      {
        rds: rdsCounts,
        s3: {
          niceic_pdfs_archived: archived,
          jobs_objects_deleted: jobsWipe.deleted,
          settings_objects_deleted: settingsWipe.deleted,
          analytics_objects_deleted: analyticsWipe.deleted,
        },
      },
      ipAddress
    );

    logger.info('Account hard-deleted', {
      userId,
      rds: rdsCounts,
      niceic_archived: archived,
    });

    // 204 No Content — the body is intentionally empty. iOS reads the
    // status code and clears the session; the audit log carries the
    // detail for compliance review.
    res.status(204).end();
  } catch (error) {
    logger.error('Account deletion failed', {
      error: error.message,
      stack: error.stack,
      userId,
    });
    // Record the failure for the rights-request register. `logAction`
    // swallows its own DB errors so it's safe to await without a
    // `.catch()` belt — see src/db.js.
    await db.logAction(userId, 'account_deletion_failed', { error: error.message }, ipAddress);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

/**
 * Change password
 * PUT /api/auth/change-password
 * Body: { currentPassword: string, newPassword: string }
 */
router.put('/change-password', auth.requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    // Get full user record (with password_hash)
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (!auth.verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password and update
    const newHash = bcrypt.hashSync(newPassword, 10);
    await db.resetUserPassword(req.user.id, newHash);

    await db.logAction(req.user.id, 'password_changed');
    logger.info('User changed their password', { userId: req.user.id });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Password change failed', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Password change failed' });
  }
});

export default router;
