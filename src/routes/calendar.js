/**
 * Google Calendar routes — auth, events, create job from event, disconnect
 */

import { Router } from "express";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as storage from "../storage.js";
import * as calendar from "../calendar.js";
import { saveCalendarTokens, getCalendarTokens, deleteCalendarTokens } from "../db.js";
import logger from "../logger.js";

const router = Router();

/**
 * GET /api/calendar/auth-url
 */
router.get("/auth-url", auth.requireAuth, (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "https://certmate.uk";
    const redirectUri = `${frontendUrl}/calendar`;
    const url = calendar.getAuthUrl(redirectUri);
    res.json({ url });
  } catch (error) {
    logger.error("Failed to generate calendar auth URL", { error: error.message });
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

/**
 * POST /api/calendar/callback
 */
router.post("/callback", auth.requireAuth, async (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "https://certmate.uk";
    const redirectUri = `${frontendUrl}/calendar`;
    const tokens = await calendar.getTokens(code, redirectUri);

    await saveCalendarTokens(req.user.id, tokens);

    logger.info("Calendar connected successfully", { userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.error("Calendar callback failed", { userId: req.user?.id, error: error.message });
    res.status(500).json({ error: "Failed to connect calendar: " + error.message });
  }
});

/**
 * GET /api/calendar/status
 */
router.get("/status", auth.requireAuth, async (req, res) => {
  try {
    const configured = calendar.isConfigured();
    const tokens = await getCalendarTokens(req.user.id);
    res.json({
      configured,
      connected: !!tokens,
    });
  } catch (error) {
    logger.error("Calendar status check failed", { error: error.message });
    res.status(500).json({ error: "Failed to check calendar status" });
  }
});

/**
 * GET /api/calendar/events
 */
router.get("/events", auth.requireAuth, async (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  try {
    let tokens = await getCalendarTokens(req.user.id);
    if (!tokens) {
      return res.status(400).json({ error: "Calendar not connected. Please connect your Google Calendar first." });
    }

    try {
      const refreshed = await calendar.refreshTokensIfNeeded(tokens);
      if (refreshed.access_token !== tokens.access_token) {
        await saveCalendarTokens(req.user.id, refreshed);
        tokens = refreshed;
      }
    } catch (refreshErr) {
      logger.warn("Token refresh failed, trying with existing tokens", { error: refreshErr.message });
    }

    const events = await calendar.getUpcomingInspections(tokens);
    res.json({ events });
  } catch (error) {
    logger.error("Failed to fetch calendar events", { userId: req.user?.id, error: error.message });

    if (error.message?.includes("invalid_grant") || error.code === 401) {
      await deleteCalendarTokens(req.user.id);
      return res.status(401).json({ error: "Calendar access revoked. Please reconnect your Google Calendar." });
    }

    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
});

/**
 * POST /api/calendar/create-job-from-event
 */
router.post("/create-job-from-event", auth.requireAuth, async (req, res) => {
  const { summary, location, start, description } = req.body;
  const userId = req.user.id;

  if (!location) {
    return res.status(400).json({ error: "Event has no location / address" });
  }

  try {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const address = location.trim();
    const certType = "EICR";

    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: address,
      certificate_type: certType,
      status: "done",
      address,
      client_name: summary || "",
      s3_prefix: `jobs/${userId}/${address}/`,
    });

    const extractedData = {
      installation_details: {
        client_name: summary || "",
        address: address,
        postcode: "",
        premises_description: "Residential",
        installation_records_available: false,
        evidence_of_additions_alterations: false,
        next_inspection_years: 5,
        extent: "",
        agreed_limitations: "",
      },
      supply_characteristics: {},
      board_info: {},
      circuits: [],
      observations: [],
    };

    const s3Key = `jobs/${userId}/${address}/output/extracted_data.json`;
    await storage.uploadText(s3Key, JSON.stringify(extractedData, null, 2));

    logger.info("Job created from calendar event", { userId, jobId, address, summary });
    res.json({ success: true, jobId, address });
  } catch (error) {
    logger.error("Failed to create job from calendar event", { userId, error: error.message });
    res.status(500).json({ error: "Failed to create job from event" });
  }
});

/**
 * DELETE /api/calendar/disconnect
 */
router.delete("/disconnect", auth.requireAuth, async (req, res) => {
  try {
    await deleteCalendarTokens(req.user.id);
    logger.info("Calendar disconnected", { userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to disconnect calendar", { userId: req.user?.id, error: error.message });
    res.status(500).json({ error: "Failed to disconnect calendar" });
  }
});

export default router;
