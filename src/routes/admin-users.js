/**
 * Admin user management routes.
 * All routes are protected by requireAuth + requireAdmin middleware
 * (applied at the mount point in api.js, not per-route here).
 *
 * Follows the same CRUD patterns as routes/clients.js:
 * - Pagination via parsePagination/paginatedResponse
 * - Validation before DB writes
 * - Audit logging via db.logAction()
 * - Logger for operational events
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  listUsers,
  listUsersPaginated,
  createUser,
  updateUser,
  getUserById,
  getUserByEmail,
  resetUserPassword,
  unlockUser,
  incrementTokenVersion,
  logAction,
} from '../db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import logger from '../logger.js';

const router = Router();

// A24: Basic email format validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * GET /api/admin/users
 * List all users. Supports optional pagination (?limit=50&offset=0).
 */
router.get('/', async (req, res) => {
  try {
    const isPaginated = req.query.limit !== undefined || req.query.offset !== undefined;

    if (isPaginated) {
      const { limit, offset } = parsePagination(req.query);
      const { rows, total } = await listUsersPaginated(limit, offset);
      res.json(paginatedResponse(rows, total, { limit, offset }));
    } else {
      const users = await listUsers();
      res.json(users);
    }
  } catch (error) {
    logger.error('Failed to list users', { error: error.message });
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * POST /api/admin/users
 * Create a new user. Body: { email, name, password, company_name?, role?, company_id?, company_role? }
 */
router.post('/', async (req, res) => {
  try {
    const { email, name, password, company_name, role, company_id, company_role } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "user"' });
    }
    if (company_role && !['owner', 'admin', 'employee'].includes(company_role)) {
      return res
        .status(400)
        .json({ error: 'company_role must be "owner", "admin", or "employee"' });
    }

    // Check for existing user with this email
    const existing = await getUserByEmail(email.trim());
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const password_hash = bcrypt.hashSync(password, 10);

    const user = await createUser({
      email: email.trim(),
      name: name.trim(),
      company_name: company_name?.trim() || null,
      password_hash,
      role: role || 'user',
      company_id: company_id || null,
      company_role: company_role || 'employee',
    });

    await logAction(req.user.id, 'admin_create_user', {
      created_user_id: user.id,
      email: user.email,
    });

    logger.info('Admin created user', {
      adminId: req.user.id,
      userId: user.id,
      email: user.email,
    });

    res.status(201).json(user);
  } catch (error) {
    logger.error('Failed to create user', { error: error.message });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * PUT /api/admin/users/:userId
 * Update a user. Body: { name?, email?, company_name?, role?, is_active? }
 */
router.put('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const existing = await getUserById(userId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admin from removing their own admin role
    if (userId === req.user.id && req.body.role && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'Cannot remove your own admin role' });
    }

    // Prevent admin from deactivating themselves
    if (userId === req.user.id && req.body.is_active === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    await updateUser(userId, req.body);

    await logAction(req.user.id, 'admin_update_user', {
      updated_user_id: userId,
      changes: Object.keys(req.body),
    });

    logger.info('Admin updated user', {
      adminId: req.user.id,
      userId,
      fields: Object.keys(req.body),
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update user', { error: error.message });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * POST /api/admin/users/:userId/reset-password
 * Reset a user's password. Body: { password: string }
 * Also invalidates all existing sessions by incrementing token version.
 */
router.post('/:userId/reset-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await getUserById(userId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const password_hash = bcrypt.hashSync(password, 10);
    await resetUserPassword(userId, password_hash);
    // Invalidate existing tokens so the user must log in with the new password
    await incrementTokenVersion(userId);

    await logAction(req.user.id, 'admin_reset_password', {
      target_user_id: userId,
    });

    logger.info('Admin reset user password', {
      adminId: req.user.id,
      userId,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to reset password', { error: error.message });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

/**
 * POST /api/admin/users/:userId/unlock
 * Unlock a locked user account. Clears failed attempts and lockout timestamp.
 */
router.post('/:userId/unlock', async (req, res) => {
  try {
    const { userId } = req.params;

    const existing = await getUserById(userId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    await unlockUser(userId);

    await logAction(req.user.id, 'admin_unlock_user', {
      unlocked_user_id: userId,
    });

    logger.info('Admin unlocked user', {
      adminId: req.user.id,
      userId,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to unlock user', { error: error.message });
    res.status(500).json({ error: 'Failed to unlock user' });
  }
});

export default router;
