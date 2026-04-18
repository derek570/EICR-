/**
 * Wave 4 batch 2 — 6c tail. Backend guards on PUT /api/admin/users/:userId.
 *
 * Item 1 adds two new server-side checks:
 *   - self-reassignment block: an admin editing their own row cannot
 *     change their own company_id (they'd silently revoke their own
 *     company-admin access).
 *   - company_role enum validation: the DB column is free-text, so
 *     without this check a stray value would persist and later blow
 *     up middleware which asserts the three-value enum.
 *
 * Also asserts the new `/companies/list` lite endpoint returns only
 * `{id, name}` pairs (not the full company blob).
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockListUsers = jest.fn();
const mockListUsersPaginated = jest.fn();
const mockListCompanies = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockResetUserPassword = jest.fn();
const mockUnlockUser = jest.fn();
const mockIncrementTokenVersion = jest.fn();
const mockLogAction = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  listUsers: mockListUsers,
  listUsersPaginated: mockListUsersPaginated,
  listCompanies: mockListCompanies,
  createUser: mockCreateUser,
  updateUser: mockUpdateUser,
  getUserById: mockGetUserById,
  getUserByEmail: mockGetUserByEmail,
  resetUserPassword: mockResetUserPassword,
  unlockUser: mockUnlockUser,
  incrementTokenVersion: mockIncrementTokenVersion,
  logAction: mockLogAction,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const adminUsersRouter = (await import('../routes/admin-users.js')).default;

function buildApp(actingUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actingUser;
    next();
  });
  app.use('/', adminUsersRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /companies/list', () => {
  test('returns lite {id, name} pairs, not the full company row', async () => {
    mockListCompanies.mockResolvedValueOnce([
      {
        id: 'c1',
        name: 'Acme Ltd',
        settings: { logo_file: 'logos/x.png' },
        is_active: true,
        created_at: '2024-01-01',
      },
      { id: 'c2', name: 'Other Firm', settings: {}, is_active: true },
    ]);
    const app = buildApp({ id: 'admin-1', role: 'admin' });
    const res = await request(app).get('/companies/list');
    expect(res.status).toBe(200);
    // The payload MUST be the lite projection — lookups for `settings`
    // or `is_active` on the response shape are the signal the endpoint
    // has drifted into returning the full row.
    expect(res.body).toEqual([
      { id: 'c1', name: 'Acme Ltd' },
      { id: 'c2', name: 'Other Firm' },
    ]);
    // Extra belt-and-braces — nothing else leaks.
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual(['id', 'name']);
    }
  });

  test('returns [] on listCompanies error surfaces 500', async () => {
    mockListCompanies.mockRejectedValueOnce(new Error('db down'));
    const app = buildApp({ id: 'admin-1', role: 'admin' });
    const res = await request(app).get('/companies/list');
    expect(res.status).toBe(500);
  });
});

describe('PUT /:userId — self-reassignment + company_role validation', () => {
  test('400s when an admin tries to change their own company_id', async () => {
    mockGetUserById.mockResolvedValueOnce({
      id: 'admin-1',
      company_id: 'c-current',
    });
    const app = buildApp({ id: 'admin-1', role: 'admin', company_id: 'c-current' });
    const res = await request(app).put('/admin-1').send({ company_id: 'c-different' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company assignment/i);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  test('allows an admin to set their own company_id to the value it already holds (no-op)', async () => {
    mockGetUserById.mockResolvedValueOnce({ id: 'admin-1', company_id: 'c-current' });
    mockUpdateUser.mockResolvedValueOnce();
    const app = buildApp({ id: 'admin-1', role: 'admin', company_id: 'c-current' });
    const res = await request(app)
      .put('/admin-1')
      .send({ company_id: 'c-current', name: 'Unchanged' });
    // Same value shouldn't trip the guard — only a real move should.
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith('admin-1', {
      company_id: 'c-current',
      name: 'Unchanged',
    });
  });

  test('allows an admin to change ANOTHER user’s company_id freely', async () => {
    mockGetUserById.mockResolvedValueOnce({ id: 'u2', company_id: 'c-old' });
    mockUpdateUser.mockResolvedValueOnce();
    const app = buildApp({ id: 'admin-1', role: 'admin', company_id: 'c-current' });
    const res = await request(app).put('/u2').send({ company_id: 'c-new' });
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith('u2', { company_id: 'c-new' });
  });

  test('400s on an unknown company_role enum value', async () => {
    mockGetUserById.mockResolvedValueOnce({ id: 'u2', company_id: 'c-1' });
    const app = buildApp({ id: 'admin-1', role: 'admin' });
    const res = await request(app).put('/u2').send({ company_role: 'god' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner|admin|employee/);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  test('accepts each of the three valid company_role values', async () => {
    for (const role of ['owner', 'admin', 'employee']) {
      mockGetUserById.mockResolvedValueOnce({ id: 'u2', company_id: 'c-1' });
      mockUpdateUser.mockResolvedValueOnce();
      const app = buildApp({ id: 'admin-1', role: 'admin' });
      const res = await request(app).put('/u2').send({ company_role: role });
      expect(res.status).toBe(200);
    }
    expect(mockUpdateUser).toHaveBeenCalledTimes(3);
  });

  test('accepts a null company_role (clears the assignment)', async () => {
    mockGetUserById.mockResolvedValueOnce({ id: 'u2', company_id: 'c-1' });
    mockUpdateUser.mockResolvedValueOnce();
    const app = buildApp({ id: 'admin-1', role: 'admin' });
    const res = await request(app).put('/u2').send({ company_role: null });
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith('u2', { company_role: null });
  });
});
