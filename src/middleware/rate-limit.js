/**
 * Rate limiting middleware for EICR-oMatic 3000 Backend.
 * Applies tiered limits to AI, upload, email, and auth endpoints.
 * Uses Redis-backed store (shared ioredis connection from queue.js) with
 * graceful fallback to in-memory MemoryStore when Redis is unavailable.
 */

import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getConnection, isRedisAvailable } from '../queue.js';
import logger from '../logger.js';

/**
 * Create a RedisStore for express-rate-limit if Redis is available.
 * Returns undefined (triggers default MemoryStore) when Redis is down.
 */
function getStore() {
  try {
    if (!isRedisAvailable()) {
      logger.warn('Redis unavailable for rate limiting — falling back to in-memory store');
      return undefined;
    }

    return new RedisStore({
      sendCommand: (...args) => getConnection().call(...args),
      prefix: 'rl:',
    });
  } catch (err) {
    logger.warn('Failed to create RedisStore for rate limiting — falling back to in-memory store', {
      error: err.message,
    });
    return undefined;
  }
}

/**
 * Normalize client IP by stripping the ::ffff: prefix from IPv4-mapped IPv6 addresses.
 * e.g. "::ffff:192.168.1.1" -> "192.168.1.1"
 */
function normalizeIp(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

/**
 * Create a rate limiter with Redis store (or MemoryStore fallback).
 */
function createLimiter(options) {
  return rateLimit({
    ...options,
    store: getStore(),
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// AI extraction endpoints — expensive, limit to 10 requests/min per user
export const aiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || normalizeIp(req),
  message: { error: 'Too many AI requests. Please wait a moment before trying again.' },
});

// Upload endpoints — 20 requests/min per user
export const uploadLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || normalizeIp(req),
  message: { error: 'Too many uploads. Please wait a moment before trying again.' },
});

// Email endpoints — 5 requests/min per user
export const emailLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || normalizeIp(req),
  message: { error: 'Too many email requests. Please wait a moment before trying again.' },
});

// Auth endpoints — 10 requests/min per IP (brute force protection)
export const authLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => normalizeIp(req),
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
