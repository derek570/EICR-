/**
 * Tests for auth module — JWT tokens, password verification, account lockout, middleware.
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Mock db and logger before importing auth
const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateLastLogin = jest.fn();
const mockUpdateLoginAttempts = jest.fn();
const mockLogAction = jest.fn();
const mockIncrementTokenVersion = jest.fn();
const mockSetTokenVersion = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  updateLastLogin: mockUpdateLastLogin,
  updateLoginAttempts: mockUpdateLoginAttempts,
  logAction: mockLogAction,
  incrementTokenVersion: mockIncrementTokenVersion,
  setTokenVersion: mockSetTokenVersion,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const JWT_SECRET = 'dev-secret-change-in-production';
process.env.JWT_SECRET = JWT_SECRET;

const auth = await import('../auth.js');

describe('auth', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('verifyPassword', () => {
    test('should return true for matching password and hash', async () => {
      const password = 'test-password-123';
      const hash = bcrypt.hashSync(password, 10);
      expect(await auth.verifyPassword(password, hash)).toBe(true);
    });

    test('should return false for non-matching password', async () => {
      const hash = bcrypt.hashSync('correct-password', 10);
      expect(await auth.verifyPassword('wrong-password', hash)).toBe(false);
    });

    test('should return false for invalid hash', async () => {
      expect(await auth.verifyPassword('password', 'not-a-valid-hash')).toBe(false);
    });
  });

  describe('isAccountLocked', () => {
    test('should return true when locked_until is in the future', () => {
      const future = new Date(Date.now() + 60000).toISOString();
      expect(auth.isAccountLocked({ locked_until: future })).toBe(true);
    });

    test('should return false when locked_until is in the past', () => {
      const past = new Date(Date.now() - 60000).toISOString();
      expect(auth.isAccountLocked({ locked_until: past })).toBe(false);
    });

    test('should return false when locked_until is null', () => {
      expect(auth.isAccountLocked({ locked_until: null })).toBe(false);
    });

    test('should return false when locked_until is undefined', () => {
      expect(auth.isAccountLocked({})).toBe(false);
    });
  });

  describe('getLockoutRemaining', () => {
    test('should return remaining minutes when locked', () => {
      const tenMinutesFromNow = new Date(Date.now() + 10 * 60000).toISOString();
      const remaining = auth.getLockoutRemaining({ locked_until: tenMinutesFromNow });
      expect(remaining).toBeGreaterThanOrEqual(9);
      expect(remaining).toBeLessThanOrEqual(11);
    });

    test('should return 0 when not locked', () => {
      const past = new Date(Date.now() - 60000).toISOString();
      expect(auth.getLockoutRemaining({ locked_until: past })).toBe(0);
    });

    test('should return 0 when locked_until is null', () => {
      expect(auth.getLockoutRemaining({ locked_until: null })).toBe(0);
    });
  });

  describe('authenticate', () => {
    const testUser = {
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      company_name: 'Test Co',
      password_hash: bcrypt.hashSync('correct-password', 10),
      is_active: true,
      locked_until: null,
      failed_login_attempts: 0,
    };

    test('should return token on successful login', async () => {
      mockGetUserByEmail.mockResolvedValue(testUser);
      mockUpdateLastLogin.mockResolvedValue();
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'correct-password');

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.user.email).toBe('test@example.com');
      expect(result.user.id).toBe('user-1');
      // Should not expose password hash
      expect(result.user.password_hash).toBeUndefined();
    });

    test('should normalize email to lowercase', async () => {
      mockGetUserByEmail.mockResolvedValue(testUser);
      mockUpdateLastLogin.mockResolvedValue();
      mockLogAction.mockResolvedValue();

      await auth.authenticate('  TEST@EXAMPLE.COM  ', 'correct-password');

      expect(mockGetUserByEmail).toHaveBeenCalledWith('test@example.com');
    });

    test('should fail for unknown email', async () => {
      mockGetUserByEmail.mockResolvedValue(null);

      const result = await auth.authenticate('unknown@example.com', 'password');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    test('should fail for disabled account', async () => {
      mockGetUserByEmail.mockResolvedValue({ ...testUser, is_active: false });
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'correct-password');

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    test('should fail for locked account', async () => {
      const lockedUser = {
        ...testUser,
        locked_until: new Date(Date.now() + 15 * 60000).toISOString(),
      };
      mockGetUserByEmail.mockResolvedValue(lockedUser);
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'correct-password');

      expect(result.success).toBe(false);
      expect(result.error).toContain('locked');
    });

    test('should fail for wrong password and increment attempts', async () => {
      mockGetUserByEmail.mockResolvedValue(testUser);
      mockUpdateLoginAttempts.mockResolvedValue();
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'wrong-password');

      expect(result.success).toBe(false);
      expect(mockUpdateLoginAttempts).toHaveBeenCalledWith('user-1', 1, null);
    });

    test('should lock account after 5 failed attempts', async () => {
      const userWith4Failures = { ...testUser, failed_login_attempts: 4 };
      mockGetUserByEmail.mockResolvedValue(userWith4Failures);
      mockUpdateLoginAttempts.mockResolvedValue();
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'wrong-password');

      expect(result.success).toBe(false);
      expect(result.error).toContain('locked');
      // Should have been called with attempts=5 and a locked_until timestamp
      expect(mockUpdateLoginAttempts).toHaveBeenCalledWith('user-1', 5, expect.any(String));
    });

    test('should generate valid JWT on success', async () => {
      mockGetUserByEmail.mockResolvedValue(testUser);
      mockUpdateLastLogin.mockResolvedValue();
      mockLogAction.mockResolvedValue();

      const result = await auth.authenticate('test@example.com', 'correct-password');

      const decoded = jwt.verify(result.token, JWT_SECRET);
      expect(decoded.userId).toBe('user-1');
      expect(decoded.email).toBe('test@example.com');
    });
  });

  describe('verifyToken', () => {
    test('should return user for valid token', async () => {
      const token = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      mockGetUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test',
        company_name: 'Co',
        is_active: true,
      });

      const user = await auth.verifyToken(token);

      expect(user).not.toBeNull();
      expect(user.id).toBe('user-1');
    });

    test('should return null for expired token', async () => {
      const token = jwt.sign({ userId: 'user-1' }, JWT_SECRET, { expiresIn: '-1s' });

      const user = await auth.verifyToken(token);

      expect(user).toBeNull();
    });

    test('should return null for tampered token', async () => {
      const token = jwt.sign({ userId: 'user-1' }, 'wrong-secret', { expiresIn: '24h' });

      const user = await auth.verifyToken(token);

      expect(user).toBeNull();
    });

    test('should return null for inactive user', async () => {
      const token = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      mockGetUserById.mockResolvedValue({ id: 'user-1', is_active: false });

      const user = await auth.verifyToken(token);

      expect(user).toBeNull();
    });

    test('should return null if user not found in DB', async () => {
      const token = jwt.sign({ userId: 'nonexistent', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      mockGetUserById.mockResolvedValue(null);

      const user = await auth.verifyToken(token);

      expect(user).toBeNull();
    });
  });

  describe('refreshToken', () => {
    const activeUser = {
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test',
      company_name: 'Co',
      is_active: true,
    };

    test('should refresh a still-valid token', async () => {
      const oldToken = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      mockGetUserById.mockResolvedValue(activeUser);

      const result = await auth.refreshToken(oldToken);

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.user.id).toBe('user-1');
    });

    test('should refresh a recently-expired token within grace period', async () => {
      // Create a token that expired 1 hour ago (within 7-day grace)
      const oldToken = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '-1h',
      });
      mockGetUserById.mockResolvedValue(activeUser);

      const result = await auth.refreshToken(oldToken);

      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
    });

    test('should reject token expired beyond grace period', async () => {
      // Create a token that expired 8 days ago (beyond 7-day grace)
      const payload = { userId: 'user-1', email: 'test@example.com' };
      const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
      const oldToken = jwt.sign(
        { ...payload, exp: eightDaysAgo, iat: eightDaysAgo - 3600 },
        JWT_SECRET
      );

      const result = await auth.refreshToken(oldToken);

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired too long ago');
    });

    test('should reject token with invalid signature', async () => {
      const oldToken = jwt.sign({ userId: 'user-1' }, 'wrong-secret', { expiresIn: '24h' });

      const result = await auth.refreshToken(oldToken);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid token');
    });

    test('should reject if user is inactive', async () => {
      const oldToken = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      mockGetUserById.mockResolvedValue({ ...activeUser, is_active: false });

      const result = await auth.refreshToken(oldToken);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or disabled');
    });
  });

  describe('requireAuth middleware', () => {
    let req, res, next;

    beforeEach(() => {
      req = { headers: {}, query: {} };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
    });

    test('should return 401 when no token provided', () => {
      auth.requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    test('should extract token from Authorization header', async () => {
      const token = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      req.headers.authorization = `Bearer ${token}`;
      mockGetUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test',
        company_name: 'Co',
        is_active: true,
      });

      auth.requireAuth(req, res, next);

      // Wait for async verifyToken to resolve
      await new Promise((r) => setTimeout(r, 50));

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.id).toBe('user-1');
    });

    test('should extract token from query parameter', async () => {
      const token = jwt.sign({ userId: 'user-1', email: 'test@example.com' }, JWT_SECRET, {
        expiresIn: '24h',
      });
      req.query.token = token;
      mockGetUserById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test',
        company_name: 'Co',
        is_active: true,
      });

      auth.requireAuth(req, res, next);

      await new Promise((r) => setTimeout(r, 50));

      expect(next).toHaveBeenCalled();
    });

    test('should return 401 for invalid token', async () => {
      req.headers.authorization = 'Bearer invalid-token-here';

      auth.requireAuth(req, res, next);

      await new Promise((r) => setTimeout(r, 50));

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
