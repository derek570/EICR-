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
  listCompanies,
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

/**
 * GET /api/admin/users/companies/list
 * Lightweight `{id, name}[]` list of every company in the system.
 *
 * URL lives under the admin-users mount because this file is mounted
 * at `/api/admin/users` in api.js. The nesting looks slightly odd but
 * it inherits the `requireAdmin` gate without re-registering middleware
 * elsewhere.
 *
 * Why a dedicated endpoint rather than reusing `GET /api/companies`:
 * the existing route returns the full company row (settings JSON blob,
 * timestamps, is_active, …). The admin-user edit page only needs to
 * render a picker of `{id, name}` pairs, and round-tripping the whole
 * payload just to `.map(({id, name}) => …)` in the client bloats the
 * response by ~10x for no caller-side benefit. The separate route also
 * lets us scope future pagination differently — the admin picker
 * expects every company to be selectable, whereas the companies index
 * page may need filters.
 *
 * The route lives under `admin-users.js` deliberately: `api.js` mounts
 * it at `/api/admin/*` which is already gated by `requireAdmin`, so we
 * inherit the RBAC without reopening the companies router's mount
 * config. Keeps the scope of this fix to a single file.
 */
router.get('/companies/list', async (req, res) => {
  try {
    const companies = await listCompanies();
    const lite = (companies || []).map((c) => ({ id: c.id, name: c.name }));
    res.json(lite);
  } catch (error) {
    logger.error('Failed to list companies (lite)', { error: error.message });
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

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

    // Prevent admin from reassigning their own company — mirrors the
    // demote / deactivate guards. A system admin who accidentally moved
    // themselves into a different tenant would lose company-admin
    // surfaces silently. The 400 makes the failure explicit client-side;
    // the UI also disables the picker for self-edits, so this is purely
    // a backstop against a bypassed UI.
    if (
      userId === req.user.id &&
      Object.prototype.hasOwnProperty.call(req.body, 'company_id') &&
      req.body.company_id !== req.user.company_id
    ) {
      return res.status(400).json({ error: 'Cannot change your own company assignment' });
    }

    // Validate company_role enum — updateUser whitelists the field but
    // doesn't check the value. An arbitrary string would silently write
    // to the DB and later blow up in middleware which asserts the enum.
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'company_role') &&
      req.body.company_role !== null &&
      !['owner', 'admin', 'employee'].includes(req.body.company_role)
    ) {
      return res
        .status(400)
        .json({ error: 'company_role must be "owner", "admin", or "employee"' });
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
