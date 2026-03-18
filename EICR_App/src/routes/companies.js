/**
 * Company management routes for multi-user admin.
 *
 * Two tiers of access:
 * - System admin (role: 'admin'): can create/manage companies and assign users
 * - Company admin/owner (company_role: 'owner'/'admin'): can view company jobs,
 *   manage employees within their company, see company stats
 *
 * Mounted at /api/companies in api.js, protected by requireAuth.
 */

import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  getUsersByCompany,
  getUserByEmail,
  getJobsByCompany,
  getJobsByCompanyPaginated,
  getCompanyStats,
  assignUserToCompany,
  createUser,
  logAction,
} from '../db.js';
import { requireAdmin, requireCompanyAdmin } from '../auth.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import logger from '../logger.js';

const router = Router();

// ============= Company CRUD (System Admin Only) =============

/**
 * GET /api/companies
 * List all companies (system admin only)
 */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const companies = await listCompanies();
    res.json(companies);
  } catch (error) {
    logger.error('Failed to list companies', { error: error.message });
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

/**
 * POST /api/companies
 * Create a new company (system admin only)
 * Body: { name: string, settings?: object }
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, settings } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const company = await createCompany({
      name: name.trim(),
      settings: settings || {},
    });

    await logAction(req.user.id, 'company_created', {
      company_id: company.id,
      company_name: company.name,
    });

    logger.info('Company created', {
      adminId: req.user.id,
      companyId: company.id,
      name: company.name,
    });

    res.status(201).json(company);
  } catch (error) {
    logger.error('Failed to create company', { error: error.message });
    res.status(500).json({ error: 'Failed to create company' });
  }
});

/**
 * GET /api/companies/:companyId
 * Get company details (system admin or company member)
 */
router.get('/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;

    // System admin can see any company; others can only see their own
    if (req.user.role !== 'admin' && req.user.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const company = await getCompany(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(company);
  } catch (error) {
    logger.error('Failed to get company', { error: error.message });
    res.status(500).json({ error: 'Failed to get company' });
  }
});

/**
 * PUT /api/companies/:companyId
 * Update a company (system admin only)
 * Body: { name?, is_active?, settings? }
 */
router.put('/:companyId', requireAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    const existing = await getCompany(companyId);
    if (!existing) {
      return res.status(404).json({ error: 'Company not found' });
    }

    await updateCompany(companyId, req.body);

    await logAction(req.user.id, 'company_updated', {
      company_id: companyId,
      changes: Object.keys(req.body),
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update company', { error: error.message });
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// ============= Company Users =============

/**
 * GET /api/companies/:companyId/users
 * List all users in a company (company admin or system admin)
 */
router.get('/:companyId/users', requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    // Company admins can only see their own company's users
    if (req.user.role !== 'admin' && req.user.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const users = await getUsersByCompany(companyId);
    res.json(users);
  } catch (error) {
    logger.error('Failed to list company users', { error: error.message });
    res.status(500).json({ error: 'Failed to list company users' });
  }
});

/**
 * POST /api/companies/:companyId/invite
 * Invite a new employee to the company (company admin/owner)
 * Body: { name: string, email: string }
 * Creates a user with a random temp password and assigns them to the company as 'employee'.
 * Returns the plaintext temp password so the admin can share it with the employee.
 */
router.post('/:companyId/invite', requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { name, email } = req.body;

    // Company admins can only invite to their own company
    if (req.user.role !== 'admin' && req.user.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const company = await getCompany(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Check if email already exists
    const existing = await getUserByEmail(email.trim());
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    // Generate random 8-char temporary password
    const temporaryPassword = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const password_hash = bcrypt.hashSync(temporaryPassword, 10);

    const user = await createUser({
      email: email.trim(),
      name: name.trim(),
      password_hash,
      role: 'user',
      company_id: companyId,
      company_role: 'employee',
    });

    await logAction(req.user.id, 'employee_invited', {
      invited_user_id: user.id,
      email: user.email,
      company_id: companyId,
    });

    logger.info('Employee invited to company', {
      adminId: req.user.id,
      userId: user.id,
      companyId,
    });

    res.status(201).json({
      userId: user.id,
      email: user.email,
      name: user.name,
      temporaryPassword,
    });
  } catch (error) {
    logger.error('Failed to invite employee', { error: error.message });
    res.status(500).json({ error: 'Failed to invite employee' });
  }
});

/**
 * POST /api/companies/:companyId/users/:userId/assign
 * Assign a user to a company with a role (system admin only)
 * Body: { company_role?: 'owner' | 'admin' | 'employee' }
 */
router.post('/:companyId/users/:userId/assign', requireAdmin, async (req, res) => {
  try {
    const { companyId, userId } = req.params;
    const { company_role } = req.body;

    const validRoles = ['owner', 'admin', 'employee'];
    const role = company_role || 'employee';
    if (!validRoles.includes(role)) {
      return res
        .status(400)
        .json({ error: `company_role must be one of: ${validRoles.join(', ')}` });
    }

    const company = await getCompany(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    await assignUserToCompany(userId, companyId, role);

    await logAction(req.user.id, 'user_assigned_to_company', {
      target_user_id: userId,
      company_id: companyId,
      company_role: role,
    });

    logger.info('User assigned to company', {
      adminId: req.user.id,
      userId,
      companyId,
      companyRole: role,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to assign user to company', { error: error.message });
    res.status(500).json({ error: 'Failed to assign user to company' });
  }
});

// ============= Company Jobs (Admin Dashboard) =============

/**
 * GET /api/companies/:companyId/jobs
 * List all jobs across the company (company admin or system admin).
 * This is the core "admin sees all company jobs" endpoint.
 * Supports pagination via ?limit=50&offset=0
 * Optional filter: ?employee_id=user_xxx to filter by employee
 */
router.get('/:companyId/jobs', requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    // Company admins can only see their own company's jobs
    if (req.user.role !== 'admin' && req.user.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const isPaginated = req.query.limit !== undefined || req.query.offset !== undefined;

    let jobs;
    let total;
    if (isPaginated) {
      const { limit, offset } = parsePagination(req.query);
      const result = await getJobsByCompanyPaginated(companyId, limit, offset);
      jobs = result.rows;
      total = result.total;
    } else {
      jobs = await getJobsByCompany(companyId);
      total = jobs.length;
    }

    // Map to consistent list shape with employee info
    const mapped = jobs.map((j) => {
      let address = j.address;
      if (!address || address.startsWith('job_') || address.startsWith('local_')) {
        address =
          j.folder_name && !j.folder_name.startsWith('job_') && !j.folder_name.startsWith('local_')
            ? j.folder_name
            : null;
      }
      return {
        id: j.id,
        address,
        status: j.status || 'done',
        created_at: j.created_at,
        updated_at: j.updated_at,
        certificate_type: j.certificate_type,
        user_id: j.user_id,
        employee_name: j.employee_name,
        employee_email: j.employee_email,
      };
    });

    // Optional: filter by employee_id
    const employeeFilter = req.query.employee_id;
    const filtered = employeeFilter ? mapped.filter((j) => j.user_id === employeeFilter) : mapped;

    if (isPaginated) {
      res.json(paginatedResponse(filtered, total, parsePagination(req.query)));
    } else {
      res.json(filtered);
    }
  } catch (error) {
    logger.error('Failed to list company jobs', { error: error.message });
    res.status(500).json({ error: 'Failed to list company jobs' });
  }
});

// ============= Company Stats =============

/**
 * GET /api/companies/:companyId/stats
 * Company-level statistics (company admin or system admin)
 */
router.get('/:companyId/stats', requireCompanyAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    if (req.user.role !== 'admin' && req.user.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const company = await getCompany(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const stats = await getCompanyStats(companyId);

    res.json({
      company: {
        id: company.id,
        name: company.name,
        is_active: company.is_active,
        created_at: company.created_at,
      },
      ...stats,
    });
  } catch (error) {
    logger.error('Failed to get company stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get company stats' });
  }
});

export default router;
