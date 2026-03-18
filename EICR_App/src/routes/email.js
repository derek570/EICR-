/**
 * Email and WhatsApp routes — send certificates
 */

import { Router } from "express";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as storage from "../storage.js";
import { sendCertificateEmail, verifyEmailConfig, isConfigured as isEmailConfigured } from "../services/email.js";
import { resolveJob } from "../utils/jobs.js";
import logger from "../logger.js";

const router = Router();

/**
 * Send certificate via email
 * POST /api/job/:userId/:jobId/email
 */
router.post("/job/:userId/:jobId/email", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const { to, clientName } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!to) {
    return res.status(400).json({ error: "Recipient email required" });
  }

  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(to) || /[\r\n]/.test(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const job = await resolveJob(userId, jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const address = job.address || jobId;
    const certificateType = job.certificate_type || "EICR";

    const pdfKey = `jobs/${userId}/${address}/output/eicr_certificate.pdf`;
    const pdfBuffer = await storage.downloadBytes(pdfKey);
    if (!pdfBuffer) {
      return res.status(404).json({ error: "PDF not found — generate it first" });
    }

    if (!isEmailConfigured()) {
      return res.status(503).json({ error: "Email not configured" });
    }

    await sendCertificateEmail({
      to,
      clientName,
      address,
      pdfBuffer,
      certificateType,
    });

    await db.logAction(userId, "email_sent", { to, jobId, address });
    res.json({ ok: true });
  } catch (error) {
    logger.error("Email sending failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to send email: " + error.message });
  }
});

/**
 * Check email configuration status
 * GET /api/email/status
 */
router.get("/email/status", auth.requireAuth, async (req, res) => {
  const configured = isEmailConfigured();
  let verified = false;
  if (configured) {
    verified = await verifyEmailConfig();
  }
  res.json({ configured, verified });
});

/**
 * Send certificate via WhatsApp
 * POST /api/job/:userId/:jobId/whatsapp
 */
router.post("/job/:userId/:jobId/whatsapp", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const { phoneNumber } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  const { isConfigured, validateUKPhone, sendCertificateViaWhatsApp } = await import("../whatsapp.js");

  if (!isConfigured()) {
    return res.status(503).json({ error: "WhatsApp not configured" });
  }

  const phoneCheck = validateUKPhone(phoneNumber);
  if (!phoneCheck.valid) {
    return res.status(400).json({ error: phoneCheck.error });
  }

  try {
    const job = await resolveJob(userId, jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const address = job.address || jobId;
    const certificateType = job.certificate_type || "EICR";

    const pdfKey = `jobs/${userId}/${address}/output/eicr_certificate.pdf`;
    const mediaUrl = await storage.getFileUrl(pdfKey, 3600);
    if (!mediaUrl) {
      return res.status(404).json({ error: "PDF not found \u2014 generate it first" });
    }

    await sendCertificateViaWhatsApp({
      to: phoneNumber,
      address,
      mediaUrl,
      certificateType,
    });

    await db.logAction(userId, "whatsapp_sent", {
      to: phoneCheck.formatted,
      jobId,
      address,
    });

    res.json({ ok: true });
  } catch (error) {
    logger.error("WhatsApp sending failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to send via WhatsApp: " + error.message });
  }
});

/**
 * Check WhatsApp configuration status
 * GET /api/whatsapp/status
 */
router.get("/whatsapp/status", auth.requireAuth, async (req, res) => {
  const { isConfigured } = await import("../whatsapp.js");
  res.json({ configured: isConfigured() });
});

export default router;
