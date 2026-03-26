/**
 * Auth routes — login, logout, refresh, me, change-password
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as auth from '../auth.js';
import * as db from '../db.js';
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
 * Delete current user's account
 * DELETE /api/auth/account
 * Deactivates the user account (soft delete). Admin can reactivate later.
 */
router.delete('/account', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Prevent admin from deleting their own account if they're the only admin
    if (req.user.role === 'admin') {
      return res
        .status(400)
        .json({ error: 'Admin accounts cannot be self-deleted. Contact another admin.' });
    }

    // Soft-delete: deactivate the account
    await db.updateUser(userId, { is_active: false });

    // Invalidate all existing tokens (A5)
    await db.incrementTokenVersion(userId);

    await db.logAction(userId, 'account_deleted');

    logger.info('User deleted their account', { userId });

    res.json({ success: true });
  } catch (error) {
    logger.error('Account deletion failed', { error: error.message, userId: req.user.id });
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

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res
        .status(400)
        .json({
          error:
            'Password must contain at least one uppercase letter, one lowercase letter, and one digit',
        });
    }

    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must not exceed 72 bytes' });
    }

    // Get full user record (with password_hash)
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (!(await auth.verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password and update
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.resetUserPassword(req.user.id, newHash);

    // Invalidate all existing tokens (A4)
    await db.incrementTokenVersion(req.user.id);

    await db.logAction(req.user.id, 'password_changed');
    logger.info('User changed their password', { userId: req.user.id });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Password change failed', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Password change failed' });
  }
});

export default router;
