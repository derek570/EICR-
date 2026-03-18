/**
 * Push notification routes — VAPID key, subscribe, unsubscribe
 */

import { Router } from "express";
import * as auth from "../auth.js";
import { getVapidPublicKey, isConfigured as isPushConfigured } from "../services/push.js";
import { savePushSubscription, deletePushSubscription } from "../db.js";
import logger from "../logger.js";

const router = Router();

/**
 * Get VAPID public key for push subscription
 * GET /api/push/vapid-key
 */
router.get("/vapid-key", (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: "Push notifications not configured" });
  }
  res.json({ publicKey: getVapidPublicKey() });
});

/**
 * Subscribe to push notifications
 * POST /api/push/subscribe
 */
router.post("/subscribe", auth.requireAuth, async (req, res) => {
  const { subscription } = req.body;

  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription object" });
  }

  try {
    await savePushSubscription(req.user.id, subscription);
    logger.info("Push subscription saved", { userId: req.user.id, endpoint: subscription.endpoint });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to save push subscription", { error: error.message });
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

/**
 * Unsubscribe from push notifications
 * POST /api/push/unsubscribe
 */
router.post("/unsubscribe", auth.requireAuth, async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: "Endpoint is required" });
  }

  try {
    await deletePushSubscription(req.user.id, endpoint);
    logger.info("Push subscription removed", { userId: req.user.id, endpoint });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to remove push subscription", { error: error.message });
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

export default router;
