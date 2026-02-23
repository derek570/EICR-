/**
 * Authentication module for EICR-oMatic 3000 (Node.js)
 * Handles JWT token creation/verification and password validation.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as db from "./db.js";
import logger from "./logger.js";

// Config
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required. Set it in .env or AWS Secrets Manager.");
}
const JWT_EXPIRY = "24h";
const REFRESH_GRACE_SECONDS = 24 * 60 * 60; // 1 day — allow refresh up to 1 day after expiry
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

/**
 * Verify password against hash
 */
export function verifyPassword(password, hash) {
  try {
    return bcrypt.compareSync(password, hash);
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
    return { success: false, error: "Invalid email or password" };
  }

  // Check if active
  if (!user.is_active) {
    await db.logAction(user.id, "login_failed", { reason: "account_disabled" }, ipAddress);
    return { success: false, error: "Account has been disabled. Please contact support." };
  }

  // Check if locked
  if (isAccountLocked(user)) {
    const remaining = getLockoutRemaining(user);
    await db.logAction(user.id, "login_failed", { reason: "account_locked" }, ipAddress);
    return { success: false, error: `Account is locked. Try again in ${remaining} minutes.` };
  }

  // Verify password
  if (!verifyPassword(password, user.password_hash)) {
    const attempts = (user.failed_login_attempts || 0) + 1;
    let lockedUntil = null;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockTime = new Date();
      lockTime.setMinutes(lockTime.getMinutes() + LOCKOUT_DURATION_MINUTES);
      lockedUntil = lockTime.toISOString();
      await db.logAction(user.id, "account_locked", { attempts }, ipAddress);
    }

    await db.updateLoginAttempts(user.id, attempts, lockedUntil);
    await db.logAction(user.id, "login_failed", { attempts }, ipAddress);

    const remaining = MAX_FAILED_ATTEMPTS - attempts;
    if (remaining > 0) {
      return { success: false, error: `Invalid email or password. ${remaining} attempts remaining.` };
    }
    return { success: false, error: `Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.` };
  }

  // Success - update last login
  await db.updateLastLogin(user.id);
  await db.logAction(user.id, "login_success", {}, ipAddress);

  // Generate token
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  // Return user without password hash
  const safeUser = {
    id: user.id,
    email: user.email,
    name: user.name || "",
    company_name: user.company_name || "",
  };

  return { success: true, token, user: safeUser };
}

/**
 * Verify JWT token and return user data
 */
export async function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.getUserById(decoded.userId);

    if (!user || !user.is_active) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name || "",
      company_name: user.company_name || "",
    };
  } catch (error) {
    logger.debug("Token verification failed", { error: error.message });
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
      decoded = jwt.verify(oldToken, JWT_SECRET);
    } catch (err) {
      if (err.name !== "TokenExpiredError") {
        return { success: false, error: "Invalid token" };
      }
      // Token is expired — verify signature but ignore expiration to check grace period
      decoded = jwt.verify(oldToken, JWT_SECRET, { ignoreExpiration: true });
      if (!decoded || !decoded.exp) {
        return { success: false, error: "Invalid token" };
      }
      const expiredAgo = Math.floor(Date.now() / 1000) - decoded.exp;
      if (expiredAgo > REFRESH_GRACE_SECONDS) {
        return { success: false, error: "Token expired too long ago" };
      }
    }

    // Look up the user
    const user = await db.getUserById(decoded.userId);
    if (!user || !user.is_active) {
      return { success: false, error: "User not found or disabled" };
    }

    // Issue a fresh token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    const safeUser = {
      id: user.id,
      email: user.email,
      name: user.name || "",
      company_name: user.company_name || "",
    };

    return { success: true, token, user: safeUser };
  } catch (error) {
    logger.error("Token refresh failed", { error: error.message });
    return { success: false, error: "Token refresh failed" };
  }
}

/**
 * Express middleware to require authentication
 * Accepts token from:
 * 1. Authorization header: "Bearer <token>"
 * 2. Query parameter: ?token=<token> (for img src and other resources)
 */
export function requireAuth(req, res, next) {
  let token = null;

  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fall back to query parameter (for img src, etc.)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  verifyToken(token)
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      req.user = user;
      next();
    })
    .catch((error) => {
      logger.error("Auth middleware error", { error: error.message });
      res.status(500).json({ error: "Authentication error" });
    });
}
