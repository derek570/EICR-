/**
 * Authentication module for EICR-oMatic 3000 (Node.js)
 * Handles JWT token creation/verification and password validation.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from './db.js';
import logger from './logger.js';

// Config — lazy accessor so secrets loaded from AWS at startup are available
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable is required. Set it in .env or AWS Secrets Manager.'
    );
  }
  return secret;
}
const JWT_EXPIRY = '24h';
const REFRESH_GRACE_SECONDS = 60 * 60; // 1 hour — allow refresh up to 1 hour after expiry
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

// CX-3: Pre-computed bcrypt hash for timing-safe user-not-found path.
// Prevents email enumeration via timing side-channel by ensuring
// bcrypt.compare runs even when the user doesn't exist.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

/**
 * Verify password against hash
 */
export async function verifyPassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * Check if account is locked
 */
export function isAccountLocked(user) {
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    if (new Date() < lockedUntil) {
      return true;
    }
  }
  return false;
}

/**
 * Get remaining lockout time in minutes
 */
export function getLockoutRemaining(user) {
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    const remaining = lockedUntil - new Date();
    if (remaining > 0) {
      return Math.ceil(remaining / 60000);
    }
  }
  return 0;
}

/**
 * Authenticate user and return JWT token
 */
export async function authenticate(email, password, ipAddress = null) {
  email = email.toLowerCase().trim();

  // Get user
  const user = await db.getUserByEmail(email);

  if (!user) {
    // CX-3: Perform dummy bcrypt compare to prevent timing side-channel.
    // Without this, "user not found" returns ~instantly while "wrong password"
    // takes ~100ms for bcrypt, allowing email enumeration via response timing.
    await bcrypt.compare(password, DUMMY_HASH);
    return { success: false, error: 'Invalid email or password' };
  }

  // Check if active
  if (!user.is_active) {
    await db.logAction(user.id, 'login_failed', { reason: 'account_disabled' }, ipAddress);
    return { success: false, error: 'Account has been disabled. Please contact support.' };
  }

  // Check if locked
  if (isAccountLocked(user)) {
    const remaining = getLockoutRemaining(user);
    await db.logAction(user.id, 'login_failed', { reason: 'account_locked' }, ipAddress);
    return { success: false, error: `Account is locked. Try again in ${remaining} minutes.` };
  }

  // Verify password
  if (!(await verifyPassword(password, user.password_hash))) {
    // CX-2: Use atomic SQL increment to prevent race condition where concurrent
    // failed logins undercount attempts and bypass the lockout threshold.
    const attempts = await db.atomicIncrementFailedAttempts(
      user.id,
      MAX_FAILED_ATTEMPTS,
      LOCKOUT_DURATION_MINUTES
    );

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await db.logAction(user.id, 'account_locked', { attempts }, ipAddress);
    }
    await db.logAction(user.id, 'login_failed', { attempts }, ipAddress);

    const remaining = MAX_FAILED_ATTEMPTS - attempts;
    if (remaining > 0) {
      return {
        success: false,
        error: `Invalid email or password. ${remaining} attempts remaining.`,
      };
    }
    return { success: false, error: `Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.` };
  }

  // Success - update last login
  await db.updateLastLogin(user.id);
  await db.logAction(user.id, 'login_success', {}, ipAddress);

  // Generate token with rotation claims
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      tv: user.token_version || 0,
    },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRY, issuer: 'certmate', audience: 'certmate-api' }
  );

  // Return user without password hash
  const safeUser = {
    id: user.id,
    email: user.email,
    name: user.name || '',
    company_name: user.company_name || '',
    role: user.role || 'user',
    company_id: user.company_id || null,
    company_role: user.company_role || 'employee',
  };

  return { success: true, token, user: safeUser };
}

/**
 * Verify JWT token and return user data
 */
export async function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: 'certmate',
      audience: 'certmate-api',
    });
    const user = await db.getUserById(decoded.userId);

    if (!user || !user.is_active) {
      return null;
    }

    // CX-1: Reject tokens with stale token_version — ensures revoked tokens
    // (from password change, account deletion, theft detection) are rejected
    // on every authenticated request, not just during refresh.
    if ((decoded.tv || 0) < (user.token_version || 0)) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name || '',
      company_name: user.company_name || '',
      role: user.role || 'user',
      company_id: user.company_id || null,
      company_role: user.company_role || 'employee',
    };
  } catch (error) {
    logger.debug('Token verification failed', { error: error.message });
    return null;
  }
}

/**
 * Refresh an expired JWT token (within grace period) and return a new one.
 * Returns { success, token, user } or { success: false, error }.
 */
export async function refreshToken(oldToken) {
  try {
    // First try normal verify (token might not actually be expired)
    let decoded;
    try {
      decoded = jwt.verify(oldToken, getJwtSecret(), {
        algorithms: ['HS256'],
        issuer: 'certmate',
        audience: 'certmate-api',
      });
    } catch (err) {
      if (err.name !== 'TokenExpiredError') {
        return { success: false, error: 'Invalid token' };
      }
      // Token is expired — verify signature but ignore expiration to check grace period
      decoded = jwt.verify(oldToken, getJwtSecret(), {
        algorithms: ['HS256'],
        issuer: 'certmate',
        audience: 'certmate-api',
        ignoreExpiration: true,
      });
      if (!decoded || !decoded.exp) {
        return { success: false, error: 'Invalid token' };
      }
      const expiredAgo = Math.floor(Date.now() / 1000) - decoded.exp;
      if (expiredAgo > REFRESH_GRACE_SECONDS) {
        return { success: false, error: 'Token expired too long ago' };
      }
    }

    // Look up the user
    const user = await db.getUserById(decoded.userId);
    if (!user || !user.is_active) {
      return { success: false, error: 'User not found or disabled' };
    }

    // Token rotation: check version matches
    const presentedVersion = decoded.tv || 0;
    const currentVersion = user.token_version || 0;

    if (presentedVersion < currentVersion) {
      // Reuse detected! Old token was stolen and already rotated.
      // Invalidate entire family by bumping version again.
      logger.warn('Token reuse detected -- possible theft', {
        userId: user.id,
        presentedVersion,
        currentVersion,
      });
      await db.incrementTokenVersion(user.id);
      return { success: false, error: 'Token has been revoked' };
    }

    // A7: Atomic compare-and-swap to prevent race conditions on concurrent refresh
    const swapped = await db.atomicIncrementTokenVersion(user.id, currentVersion);
    if (!swapped) {
      // Another concurrent refresh already incremented — treat as reuse
      logger.warn('Token rotation conflict — concurrent refresh detected', {
        userId: user.id,
        currentVersion,
      });
      return { success: false, error: 'Token has been revoked' };
    }
    const newVersion = currentVersion + 1;

    // Issue a fresh token with rotation claims
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        tv: newVersion,
      },
      getJwtSecret(),
      { expiresIn: JWT_EXPIRY, issuer: 'certmate', audience: 'certmate-api' }
    );

    const safeUser = {
      id: user.id,
      email: user.email,
      name: user.name || '',
      company_name: user.company_name || '',
      role: user.role || 'user',
      company_id: user.company_id || null,
      company_role: user.company_role || 'employee',
    };

    return { success: true, token, user: safeUser };
  } catch (error) {
    logger.error('Token refresh failed', { error: error.message });
    return { success: false, error: 'Token refresh failed' };
  }
}

/**
 * Express middleware to require authentication
 * Accepts token from Authorization header: "Bearer <token>"
 */
export function requireAuth(req, res, next) {
  let token = null;

  // Authorization header only -- no query parameter fallback (CSRF risk)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  verifyToken(token)
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    })
    .catch((error) => {
      logger.error('Auth middleware error', { error: error.message });
      res.status(500).json({ error: 'Authentication error' });
    });
}

/**
 * Express middleware to require admin role.
 * Must be used AFTER requireAuth (so req.user is set).
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Express middleware to require company admin/owner role.
 * Must be used AFTER requireAuth (so req.user is set).
 * System admins (role === 'admin') also pass this check.
 */
export function requireCompanyAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // System-level admins always have company admin access
  if (req.user.role === 'admin') {
    return next();
  }

  // CX-4: Company-level admins/owners — require company_id to be present
  // alongside the role check to prevent access from data-inconsistent states.
  if (req.user.company_id && ['owner', 'admin'].includes(req.user.company_role)) {
    return next();
  }

  return res.status(403).json({ error: 'Company admin access required' });
}

/**
 * Helper: check if the authenticated user can access a given userId's resources.
 * Returns true if:
 * - req.user.id === targetUserId (own data)
 * - req.user is a system admin
 * - req.user is a company admin/owner AND targetUserId belongs to the same company
 */
/**
 * A9: Express middleware factory that enforces IDOR protection on a route parameter.
 * Extracts userId from req.params[paramName] and verifies the authenticated user
 * can access that user's resources via canAccessUser().
 * Must be used AFTER requireAuth.
 */
export function requireAccessToUser(paramName = 'userId') {
  return async (req, res, next) => {
    const targetUserId = req.params[paramName];
    if (!targetUserId) {
      return res.status(400).json({ error: `Missing parameter: ${paramName}` });
    }
    const allowed = await canAccessUser(req, targetUserId);
    if (!allowed) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

export async function canAccessUser(req, targetUserId) {
  // Own data
  if (req.user.id === targetUserId) return true;

  // System admin
  if (req.user.role === 'admin') return true;

  // Company admin — check same company
  if (['owner', 'admin'].includes(req.user.company_role) && req.user.company_id) {
    const targetUser = await db.getUserById(targetUserId);
    if (targetUser && targetUser.company_id === req.user.company_id) {
      return true;
    }
  }

  return false;
}
