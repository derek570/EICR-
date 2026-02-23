/**
 * Rate limiting middleware for EICR-oMatic 3000 Backend.
 * Applies tiered limits to AI, upload, and email endpoints.
 */

import rateLimit from "express-rate-limit";

// AI extraction endpoints — expensive, limit to 10 requests/min per user
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: "Too many AI requests. Please wait a moment before trying again." },
});

// Upload endpoints — 20 requests/min per user
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: "Too many uploads. Please wait a moment before trying again." },
});

// Email endpoints — 5 requests/min per user
export const emailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: "Too many email requests. Please wait a moment before trying again." },
});

// Auth endpoints — 10 requests/min per IP (brute force protection)
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." },
});
