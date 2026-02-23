/**
 * Analytics routes
 */

import { Router } from "express";
import * as auth from "../auth.js";
import * as db from "../db.js";
import logger from "../logger.js";

const router = Router();

/**
 * GET /api/analytics/:userId
 */
router.get("/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const [stats, weekly, timing] = await Promise.all([
      db.getJobStats(userId),
      db.getJobsPerWeek(userId, 12),
      db.getProcessingTimes(userId),
    ]);

    res.json({ stats, weekly, timing });
  } catch (error) {
    logger.error("Analytics fetch failed", { userId, error: error.message });
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

export default router;
