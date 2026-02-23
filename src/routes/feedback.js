/**
 * Feedback and optimizer report routes
 */

import { Router } from "express";
import express from "express";
import * as storage from "../storage.js";
import logger from "../logger.js";

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Feedback form for session optimizer reports.
 * GET /api/feedback/:sessionId
 */
router.get("/feedback/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CertMate — Session Feedback</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; min-height: 100vh; }
    .container { max-width: 500px; margin: 0 auto; }
    h1 { font-size: 20px; margin-bottom: 4px; color: #fff; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 24px; }
    textarea { width: 100%; min-height: 150px; padding: 14px; border: 2px solid #333; border-radius: 12px; background: #16213e; color: #eee; font-size: 16px; font-family: inherit; resize: vertical; }
    textarea:focus { outline: none; border-color: #6c63ff; }
    textarea::placeholder { color: #555; }
    button { width: 100%; padding: 16px; margin-top: 16px; border: none; border-radius: 12px; background: #6c63ff; color: #fff; font-size: 18px; font-weight: 600; cursor: pointer; }
    button:active { background: #5a52d5; }
    .hint { font-size: 13px; color: #666; margin-top: 12px; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Session Feedback</h1>
    <p class="subtitle">Correct the optimizer's analysis</p>
    <form method="POST" action="/api/feedback/${sessionId}">
      <textarea name="feedback" placeholder="e.g. type A was for wiring type, not RCD type" required autofocus></textarea>
      <button type="submit">Send Feedback</button>
    </form>
    <p class="hint">Your feedback will trigger the optimizer to revert its changes and re-run with your correction. You can submit multiple times.</p>
  </div>
</body>
</html>`;

  res.type("html").send(html);
});

/**
 * Submit feedback for a session optimizer report.
 * POST /api/feedback/:sessionId
 */
router.post("/feedback/:sessionId", express.urlencoded({ extended: false }), async (req, res) => {
  const { sessionId } = req.params;
  const feedbackText = req.body?.feedback?.trim();

  if (!feedbackText) {
    return res.status(400).type("html").send(`<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px;text-align:center;">
      <h2>No feedback provided</h2><p><a href="/api/feedback/${sessionId}" style="color:#6c63ff;">Go back</a></p>
    </body></html>`);
  }

  try {
    const s3Prefix = `session-analytics/`;
    const allKeys = await storage.listFiles(s3Prefix);
    const matchingManifest = allKeys.find(k => k.includes(sessionId) && k.endsWith("manifest.json"));

    if (!matchingManifest) {
      return res.status(404).type("html").send(`<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px;text-align:center;">
        <h2>Session not found</h2><p>Session ID: ${sessionId}</p>
      </body></html>`);
    }

    const sessionS3Path = matchingManifest.replace("manifest.json", "");
    const feedbackKey = `${sessionS3Path}user_feedback.json`;

    let feedbackArray = [];
    const existing = await storage.downloadText(feedbackKey);
    if (existing) {
      try { feedbackArray = JSON.parse(existing); } catch { feedbackArray = []; }
    }

    feedbackArray.push({
      text: feedbackText,
      timestamp: new Date().toISOString(),
    });

    await storage.uploadBytes(
      JSON.stringify(feedbackArray, null, 2),
      feedbackKey,
      "application/json"
    );

    logger.info("Session feedback submitted", { sessionId, feedbackKey, count: feedbackArray.length });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CertMate — Feedback Sent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 500px; text-align: center; }
    .tick { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #888; font-size: 14px; line-height: 1.5; margin-bottom: 16px; }
    a { color: #6c63ff; text-decoration: none; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="tick">&#10003;</div>
    <h1>Feedback Received</h1>
    <p>The optimizer will revert its previous changes and re-run with your correction on its next cycle (~2 minutes).</p>
    <a href="/api/feedback/${sessionId}">Send more feedback</a>
  </div>
</body>
</html>`;

    res.type("html").send(html);
  } catch (error) {
    logger.error("Session feedback submission failed", { sessionId, error: error.message });
    res.status(500).type("html").send(`<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px;text-align:center;">
      <h2>Something went wrong</h2><p>${error.message}</p>
      <p><a href="/api/feedback/${sessionId}" style="color:#6c63ff;">Try again</a></p>
    </body></html>`);
  }
});

/**
 * Serve optimizer report HTML page
 * GET /api/optimizer-report/:reportId
 */
router.get("/optimizer-report/:reportId", async (req, res) => {
  const { reportId } = req.params;
  if (!UUID_REGEX.test(reportId)) {
    return res.status(400).send("Invalid report ID");
  }
  try {
    const html = await storage.downloadText(`optimizer-reports/${reportId}/report.html`);
    if (!html) return res.status(404).send("Report not found");
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).send("Error loading report");
  }
});

/**
 * Accept selected recommendations
 * POST /api/optimizer-report/:reportId/accept
 */
router.post("/optimizer-report/:reportId/accept", async (req, res) => {
  const { reportId } = req.params;
  if (!UUID_REGEX.test(reportId)) {
    return res.status(400).json({ error: "Invalid report ID" });
  }
  try {
    const { accepted } = req.body;
    if (!Array.isArray(accepted)) {
      return res.status(400).json({ error: "accepted must be an array of indices" });
    }
    await storage.uploadJson(
      { accepted, timestamp: new Date().toISOString() },
      `optimizer-reports/${reportId}/accept_command.json`
    );
    res.json({ success: true, message: "Changes queued for application" });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue accept command" });
  }
});

/**
 * Reject all recommendations
 * POST /api/optimizer-report/:reportId/reject
 */
router.post("/optimizer-report/:reportId/reject", async (req, res) => {
  const { reportId } = req.params;
  if (!UUID_REGEX.test(reportId)) {
    return res.status(400).json({ error: "Invalid report ID" });
  }
  try {
    await storage.uploadJson(
      { rejected: true, timestamp: new Date().toISOString() },
      `optimizer-reports/${reportId}/reject_command.json`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue reject" });
  }
});

/**
 * Re-run analysis with additional context
 * POST /api/optimizer-report/:reportId/rerun
 */
router.post("/optimizer-report/:reportId/rerun", async (req, res) => {
  const { reportId } = req.params;
  if (!UUID_REGEX.test(reportId)) {
    return res.status(400).json({ error: "Invalid report ID" });
  }
  const { context } = req.body;
  if (!context || typeof context !== "string") {
    return res.status(400).json({ error: "context string required" });
  }
  try {
    await storage.uploadJson(
      { context, timestamp: new Date().toISOString() },
      `optimizer-reports/${reportId}/rerun_command.json`
    );
    res.json({ success: true, message: "Re-run queued. New URL will be sent via Pushover." });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue rerun" });
  }
});

export default router;
