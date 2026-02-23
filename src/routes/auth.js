/**
 * Auth routes — login, logout, refresh, me
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as auth from "../auth.js";
import * as db from "../db.js";
import logger from "../logger.js";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 login attempts per window
  message: { error: "Too many login attempts, try again later" },
});

/**
 * Login
 * POST /api/auth/login
 * Body: { email: string, password: string }
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const result = await auth.authenticate(email, password, ipAddress);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({ token: result.token, user: result.user });
  } catch (error) {
    logger.error("Login failed", { error: error.message });
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * Logout
 * POST /api/auth/logout
 */
router.post("/logout", auth.requireAuth, async (req, res) => {
  await db.logAction(req.user.id, "logout");
  res.json({ success: true });
});

/**
 * Refresh an expired token
 * POST /api/auth/refresh
 * Body: { token: string }
 */
router.post("/refresh", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }
    const result = await auth.refreshToken(token);
    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }
    res.json({ token: result.token, user: result.user });
  } catch (error) {
    logger.error("Token refresh failed", { error: error.message });
    res.status(500).json({ error: "Token refresh failed" });
  }
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get("/me", auth.requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;
