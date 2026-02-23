/**
 * API Routes for EICR-oMatic 3000 Backend
 * All Express route handlers. Middleware setup is in app.js, server startup in server.js.
 */

import rateLimit from "express-rate-limit";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { processJob } from "./process_job.js";
import logger from "./logger.js";
import * as storage from "./storage.js";
import { extractChunk } from "./extract_chunk.js";
import { createAccumulator, addChunk, addPhoto, getFormData, finalize, injectRingReading, injectReading } from "./chunk_accumulator.js";
import { createEICRBuffer, addTranscript, getExtractionPayload, markExtracted, parseRingValues, getRingReadings, getExtractionWindow, parseCommonReadings } from "./eicr_buffer.js";
import { transcribeChunk } from "./transcribe.js";
import * as auth from "./auth.js";
import * as db from "./db.js";
import adminRouter from "./admin_api.js";
import { enqueueJob, getQueueStatus, getQueueHealth } from "./queue.js";
import { getVapidPublicKey, isConfigured as isPushConfigured } from "./services/push.js";
import { sendCertificateEmail, verifyEmailConfig, isConfigured as isEmailConfigured } from "./services/email.js";
import { savePushSubscription, deletePushSubscription } from "./db.js";
import { saveJobVersion, getJobVersions, getJobVersion } from "./db.js";
import {
  getClients, createClient, updateClient, deleteClient, getClient,
  getProperties, createProperty, getPropertiesByClient, getPropertyByAddress,
} from "./db.js";
import { createJobsZip } from "./zip.js";
import { circuitsToCSV, jobToExcel } from "./export.js";
import { extractFromCertificate } from "./ocr_certificate.js";
import { extractSession } from "./extract_session.js";
import { geminiExtract, geminiExtractFromText } from "./gemini_extract.js";
import { getDeepgramKey } from "./services/secrets.js";
import { WebSocketServer } from "ws";
import { generateAndSaveDebugReports } from "./generate_debug_report.js";
import * as billing from "./billing.js";
import { createTokenAccumulator, logTokenUsage } from "./token_logger.js";
import { getSubscription as getDbSubscription, getSubscriptionByCustomerId, upsertSubscription } from "./db.js";
import { saveCalendarTokens, getCalendarTokens, deleteCalendarTokens } from "./db.js";
import * as calendar from "./calendar.js";
import swaggerUi from "swagger-ui-express";
import yaml from "js-yaml";

// Route modules
import authRouter from "./routes/auth.js";
import keysRouter from "./routes/keys.js";
import settingsRouter from "./routes/settings.js";
import pushRouter from "./routes/push.js";
import feedbackRouter from "./routes/feedback.js";
import billingRouter from "./routes/billing.js";
import calendarRouter from "./routes/calendar.js";
import clientsRouter from "./routes/clients.js";
import analyticsRouter from "./routes/analytics.js";

// Import app from the Express setup module
import app from "./app.js";

// Configure multer for file uploads (preserve original extension for MIME detection)
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".m4a";
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max per file
});

// Stripe webhook route MUST be before express.json() middleware.
// Since app.js does NOT add express.json() (to allow this raw body route first),
// we register it here before the json parser below.

// ============= Stripe Webhook (raw body — MUST be before express.json()) =============
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!billing.isConfigured()) {
    return res.status(503).json({ error: "Billing not configured" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).json({ error: "Missing Stripe signature" });
  }

  let event;
  try {
    event = billing.constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.error("Stripe webhook signature verification failed", { error: err.message });
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  logger.info("Stripe webhook received", { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // Look up which user owns this Stripe customer
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            stripe_subscription_id: subscriptionId,
            status: "active",
            plan: "pro",
          });
          logger.info("Checkout completed — subscription activated", { userId: sub.user_id, subscriptionId });
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          const periodEnd = invoice.lines?.data?.[0]?.period?.end;
          await upsertSubscription(sub.user_id, {
            status: "active",
            current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          });
          logger.info("Invoice paid — subscription renewed", { userId: sub.user_id });
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            status: subscription.status,
            stripe_price_id: subscription.items?.data?.[0]?.price?.id || null,
            current_period_start: subscription.current_period_start
              ? new Date(subscription.current_period_start * 1000).toISOString()
              : null,
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
            cancel_at_period_end: subscription.cancel_at_period_end,
          });
          logger.info("Subscription updated", { userId: sub.user_id, status: subscription.status });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            status: "canceled",
            plan: "free",
            cancel_at_period_end: false,
          });
          logger.info("Subscription cancelled", { userId: sub.user_id });
        }
        break;
      }

      default:
        logger.info("Unhandled Stripe event type", { type: event.type });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error("Stripe webhook handler error", { type: event.type, error: err.message });
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

// express.json() MUST come after the Stripe webhook route above (which needs raw body)
app.use(express.json({ limit: "10mb" }));

// Note: Helmet, hpp, CORS, trust proxy are configured in app.js

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "eicr-backend",
    version: "1.0.0",
    storage: storage.isUsingS3() ? "s3" : "local",
    timestamp: new Date().toISOString()
  });
});

// ============= Swagger UI =============
const openapiPath = path.resolve(import.meta.dirname, "..", "docs", "api", "openapi.yaml");
try {
  const openapiContent = fssync.readFileSync(openapiPath, "utf-8");
  const openapiSpec = yaml.load(openapiContent);
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customSiteTitle: "CertMate API Docs",
  }));
  logger.info("Swagger UI mounted at /api/docs");
} catch (err) {
  logger.warn("Could not load OpenAPI spec — Swagger UI disabled", { error: err.message });
}

// Mount admin routes
app.use("/api/admin", adminRouter);

// Mount extracted route modules
app.use("/api/auth", authRouter);
app.use("/api", keysRouter);         // /api/keys, /api/proxy/*, /api/config/*
app.use("/api", settingsRouter);     // /api/settings/*, /api/inspector-profiles/*, /api/schema/*, /api/regulations
app.use("/api/push", pushRouter);    // /api/push/*
app.use("/api", feedbackRouter);     // /api/feedback/*, /api/optimizer-report/*
app.use("/api/billing", billingRouter); // /api/billing/* (except webhook which stays here)
app.use("/api/calendar", calendarRouter); // /api/calendar/*
app.use("/api", clientsRouter);      // /api/clients/*, /api/properties/*
app.use("/api/analytics", analyticsRouter); // /api/analytics/*

// ============= Data Transformation =============

/**
 * Transform extracted data from pipeline format to UI format.
 *
 * Pipeline outputs:
 * - installation_details.json: { address, client_name, postcode }
 * - board_details.json: { name, location, manufacturer, earthing_arrangement, ze, ..., agreed_limitations, etc. }
 *
 * UI expects:
 * - installation_details: { client_name, address, postcode, premises_description, next_inspection_years, extent, agreed_limitations, ... }
 * - supply_characteristics: { earthing_arrangement, nominal_voltage_u, earth_loop_impedance_ze, ... }
 * - board_info: { name, location, manufacturer, phases, ... }
 */
/**
 * Transform observations from pipeline format to UI format.
 * Pipeline: { title, text, regs, code, schedule_item, confidence }
 * UI: { code, item_location, observation_text, schedule_item }
 */
function transformObservations(pipelineObservations) {
  if (!Array.isArray(pipelineObservations)) return [];

  return pipelineObservations.map(obs => {
    // Convert photo (singular string path) to photos (array of filenames)
    let photos = obs.photos || [];
    if (obs.photo && typeof obs.photo === "string") {
      // Extract just the filename from path like "photos_scaled/IMG_4693.jpg"
      const filename = obs.photo.split("/").pop();
      photos = [filename];
    }

    return {
      code: obs.code || "C3",
      item_location: obs.item_location || obs.title || "",
      observation_text: obs.observation_text || obs.text || "",
      schedule_item: obs.schedule_item || "",
      schedule_description: obs.schedule_description || "",
      photos,
    };
  });
}

function transformExtractedData(extractedInstallation, extractedBoard) {
  const installation = extractedInstallation || {};
  const board = extractedBoard || {};

  // Build installation_details - prefer installation source, fallback to board for backwards compatibility
  const installation_details = {
    client_name: installation.client_name || "",
    address: installation.address || "",
    postcode: installation.postcode || "",
    town: installation.town || "",
    county: installation.county || "",
    // These fields may be in installation or board depending on extraction version
    premises_description: installation.premises_description || board.premises_description || "",
    installation_records_available: installation.installation_records_available ?? board.installation_records_available ?? false,
    evidence_of_additions_alterations: installation.evidence_of_additions_alterations ?? board.evidence_of_additions_alterations ?? false,
    next_inspection_years: installation.next_inspection_years || board.next_inspection_years || "",
    // Extent and limitations - prefer installation source
    extent: installation.extent || board.extent || "",
    agreed_limitations: installation.agreed_limitations || board.agreed_limitations || "",
    agreed_with: installation.agreed_with || board.agreed_with || "",
    operational_limitations: installation.operational_limitations || board.operational_limitations || "",
  };

  // Build supply_characteristics from board_details
  const supply_characteristics = {
    earthing_arrangement: board.earthing_arrangement || "",
    live_conductors: board.live_conductors || "",
    number_of_supplies: board.number_of_supplies || "",
    nominal_voltage_u: board.voltage_rating || board.nominal_voltage_u || "",
    nominal_voltage_uo: board.nominal_voltage_uo || "",
    nominal_frequency: board.nominal_frequency || "",
    prospective_fault_current: board.ipf_at_db || board.prospective_fault_current || "",
    earth_loop_impedance_ze: board.ze || board.earth_loop_impedance_ze || "",
    supply_polarity_confirmed: board.supply_polarity_confirmed ?? false,
    // Supply Protective Device
    spd_bs_en: board.spd_bs_en || "",
    spd_type_supply: board.spd_type || board.spd_type_supply || "",
    spd_short_circuit: board.spd_short_circuit || "",
    spd_rated_current: board.spd_rated_current || board.rated_current || "",
  };

  // Build board_info with only board-specific fields
  const board_info = {
    name: board.name || "",
    location: board.location || "",
    manufacturer: board.manufacturer || "",
    phases: board.phases || "",
    earthing_arrangement: board.earthing_arrangement || "",
    ze: board.ze || "",
    zs_at_db: board.zs_at_db || "",
    ipf_at_db: board.ipf_at_db || "",
    // Main switch details
    main_switch_bs_en: board.main_switch_bs_en || "",
    main_switch_poles: board.main_switch_poles || "",
    main_switch_voltage: board.voltage_rating || "",
    main_switch_current: board.rated_current || "",
    // RCD details
    rcd_rating: board.rcd_rating || "",
    rcd_trip_time: board.rcd_trip_time || "",
    // Conductor details
    tails_material: board.tails_material || "",
    tails_csa: board.tails_csa || "",
    earthing_conductor_material: board.earthing_conductor_material || "",
    earthing_conductor_csa: board.earthing_conductor_csa || "",
    bonding_conductor_material: board.bonding_conductor_material || "",
    bonding_conductor_csa: board.bonding_conductor_csa || "",
    // Notes
    notes: board.notes || "",
  };

  return {
    installation_details,
    supply_characteristics,
    board_info,
  };
}

// Per-route timeout middleware for long-running routes
const routeTimeout = (ms) => (req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timed out" });
    }
  }, ms);
  res.on("finish", () => clearTimeout(timer));
  next();
};

// ============= Jobs Endpoints =============

/**
 * List all jobs for a user
 * GET /api/jobs/:userId
 */
app.get("/api/jobs/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  // Verify user can only access their own jobs
  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Get jobs from database
    const dbJobs = await db.getJobsByUser(userId);

    // Also list jobs from S3 if in cloud mode (fallback for jobs not in DB)
    let jobs = dbJobs.map(j => {
      // Use real address if available; fall back to folder_name or id only if they're
      // not raw job IDs (which iOS would filter to nil anyway)
      let address = j.address;
      if (!address || address.startsWith("job_") || address.startsWith("local_")) {
        address = j.folder_name && !j.folder_name.startsWith("job_") && !j.folder_name.startsWith("local_")
          ? j.folder_name
          : null;
      }
      return {
        id: j.id,
        address: address,
        status: j.status || "done",
        created_at: j.created_at,
        updated_at: j.updated_at,
      };
    });

    // If using S3, also check for job folders that might not be in DB
    if (storage.isUsingS3()) {
      const s3Prefix = `jobs/${userId}/`;
      const s3Folders = await storage.listJobFolders(s3Prefix);

      // Add any S3 jobs not in database.
      // Check id, address, AND folder_name since the S3 folder may be
      // the original job_xxx ID or the address it was renamed to.
      const dbIdentifiers = new Set(
        dbJobs.flatMap(j => [j.id, j.address, j.folder_name].filter(Boolean))
      );
      for (const folder of s3Folders) {
        if (!dbIdentifiers.has(folder.name)) {
          // Skip orphaned S3 folders that are clearly old job IDs or ghost entries:
          // - "job_xxx" folders are leftover from before S3 migration renamed them
          // - "Job YYYY-MM-DD" folders are legacy date-named ghosts
          if (folder.name.startsWith("job_") || /^Job \d{4}-\d{2}-\d{2}$/.test(folder.name)) {
            continue;
          }
          jobs.push({
            id: folder.name,
            address: folder.name,
            status: "done",
            created_at: folder.lastModified || new Date().toISOString(),
            updated_at: folder.lastModified || new Date().toISOString(),
          });
        }
      }
    }

    // Sort by most recently updated (or created if never updated)
    jobs.sort((a, b) => {
      const aDate = new Date(a.updated_at || a.created_at);
      const bDate = new Date(b.updated_at || b.created_at);
      return bDate - aDate;
    });

    res.json(jobs);
  } catch (error) {
    logger.error("Failed to list jobs", { userId, error: error.message });
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

/**
 * Create a blank job (no file upload)
 * POST /api/jobs/:userId
 * JSON body: { certificate_type, address }
 */
app.post("/api/jobs/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const certificateType = req.body.certificate_type || "EICR";
  const address = req.body.address || null;
  const jobId = `job_${Date.now()}`;

  try {
    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: jobId,
      certificate_type: certificateType,
      status: "pending",
      address: address,
    });

    logger.info("Blank job created", { userId, jobId, certificateType });

    const now = new Date().toISOString();
    res.json({
      id: jobId,
      address: address,
      status: "pending",
      created_at: now,
      updated_at: now,
      certificate_type: certificateType,
    });
  } catch (error) {
    logger.error("Failed to create job", { userId, error: error.message });
    res.status(500).json({ error: "Failed to create job" });
  }
});

/**
 * Upload files and start processing
 * POST /api/upload
 * Multipart form with files[] and optional certificateType
 */
app.post("/api/upload", auth.requireAuth, upload.array("files", 20), async (req, res) => {
  const userId = req.user.id;
  const files = req.files;
  const certificateType = req.body.certificateType || "EICR";

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  // Generate job ID
  const jobId = `job_${Date.now()}`;
  logger.info("Upload received", { userId, jobId, fileCount: files.length });

  try {
    // Upload files to S3 or local storage
    const s3Prefix = `jobs/${userId}/${jobId}/input/`;

    for (const file of files) {
      const originalName = file.originalname;
      const s3Key = `${s3Prefix}${originalName}`;

      // Read file from temp location and upload
      const content = await fs.readFile(file.path);
      await storage.uploadBytes(content, s3Key);

      // Clean up temp file
      await fs.unlink(file.path).catch(() => {});
    }

    logger.info("Files uploaded to storage", { userId, jobId, prefix: s3Prefix });

    // Create job record in database
    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: jobId,
      certificate_type: certificateType,
      status: "processing",
      s3_prefix: s3Prefix,
    });

    // Start processing via queue (falls back to in-process if Redis unavailable)
    const queued = await enqueueJob(userId, jobId);
    if (!queued) {
      processJobAsync(userId, jobId);
    }

    res.json({
      success: true,
      jobId,
      message: "Files uploaded, processing started",
    });
  } catch (error) {
    logger.error("Upload failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Upload failed: " + error.message });
  }
});

/**
 * Process a job asynchronously (called after upload)
 */
async function processJobAsync(userId, jobId) {
  try {
    // Call the existing process-job logic internally
    let jobDir;
    let outDir;
    let tempDir = null;

    if (storage.isUsingS3()) {
      // Cloud mode: Download files from S3 to temp directory
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-job-${jobId}-`));
      jobDir = path.join(tempDir, "input");
      outDir = path.join(tempDir, "output");

      await fs.mkdir(jobDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });

      // Download input files from S3
      const s3Prefix = `jobs/${userId}/${jobId}/input/`;
      const inputFiles = await storage.listFiles(s3Prefix);

      for (const s3Key of inputFiles) {
        const filename = path.basename(s3Key);
        const isPhoto = /\.(jpg|jpeg|png|heic)$/i.test(filename);
        const localPath = isPhoto
          ? path.join(jobDir, "photos", filename)
          : path.join(jobDir, filename);

        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await storage.downloadFile(s3Key, localPath);
      }

      logger.info("Downloaded input files from S3 for async processing", { jobId });
    }

    // Run the processing pipeline (pass jobId for accurate cost tracking)
    const result = await processJob({ jobDir, outDir, dryRun: false, jobId });

    // Upload results back to S3
    if (storage.isUsingS3() && tempDir) {
      const folderName = result.address || jobId;
      const outputPrefix = `jobs/${userId}/${folderName}/output/`;
      const actualOutDir = result.finalOutDir || outDir;

      async function uploadDir(dir, prefix) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const localPath = path.join(dir, entry.name);
          const s3Key = `${prefix}${entry.name}`;

          if (entry.isDirectory()) {
            await uploadDir(localPath, `${s3Key}/`);
          } else {
            const content = await fs.readFile(localPath);
            await storage.uploadBytes(content, s3Key);
          }
        }
      }

      await uploadDir(actualOutDir, outputPrefix);

      // Update job in database
      await db.updateJobStatus(jobId, userId, "done", result.address);

      // Clean up old prefix if renamed
      if (result.address && result.address !== jobId) {
        const oldPrefix = `jobs/${userId}/${jobId}/`;
        logger.info("Deleting old job folder after rename", { oldPrefix, newAddress: result.address });
        const deleteResult = await storage.deletePrefix(oldPrefix);
        logger.info("Delete prefix result", { oldPrefix, deleted: deleteResult.deleted, errors: deleteResult.errors });
      } else {
        logger.debug("Not deleting old folder", { address: result.address, jobId, reason: result.address === jobId ? "address equals jobId" : "no address" });
      }

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    logger.info("Async job processing complete", { userId, jobId, address: result.address });
  } catch (error) {
    logger.error("Async job processing failed", { userId, jobId, error: error.message });
    await db.updateJobStatus(jobId, userId, "failed");
  }
}

/**
 * Process a job
 * POST /api/process-job
 * Body: { userId: string, jobId: string, jobFolder?: string }
 *
 * For cloud (S3): Downloads files from S3, processes, uploads results
 * For local: Processes files directly from filesystem
 */
app.post("/api/process-job", routeTimeout(120000), async (req, res) => {
  const { userId, jobId, jobFolder } = req.body;

  if (!userId || !jobId) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: userId and jobId"
    });
  }

  logger.info("Processing job request", { userId, jobId });

  try {
    let jobDir;
    let outDir;
    let tempDir = null;

    if (storage.isUsingS3()) {
      // Cloud mode: Download files from S3 to temp directory
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-job-${jobId}-`));
      jobDir = path.join(tempDir, "input");
      outDir = path.join(tempDir, "output");

      await fs.mkdir(jobDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });

      // Download input files from S3
      const s3Prefix = `jobs/${userId}/${jobId}/input/`;
      const inputFiles = await storage.listFiles(s3Prefix);

      if (inputFiles.length === 0) {
        // Try without /input/ suffix for backwards compatibility
        const altPrefix = `jobs/${userId}/${jobId}/`;
        const altFiles = await storage.listFiles(altPrefix);
        const audioPhotoFiles = altFiles.filter(f =>
          /\.(m4a|mp3|wav|aac|jpg|jpeg|png|heic)$/i.test(f) &&
          !f.includes("/output/")
        );

        if (audioPhotoFiles.length === 0) {
          throw new Error(`No input files found for job ${jobId}`);
        }

        // Download these files
        for (const s3Key of audioPhotoFiles) {
          const filename = path.basename(s3Key);
          const isPhoto = /\.(jpg|jpeg|png|heic)$/i.test(filename);
          const localPath = isPhoto
            ? path.join(jobDir, "photos", filename)
            : path.join(jobDir, filename);

          await fs.mkdir(path.dirname(localPath), { recursive: true });
          const success = await storage.downloadFile(s3Key, localPath);
          if (!success) {
            logger.warn("Failed to download file", { s3Key });
          }
        }
      } else {
        // Download from /input/ prefix
        // Put photos in photos/ subfolder so process_job.js can find them
        for (const s3Key of inputFiles) {
          const filename = path.basename(s3Key);
          const isPhoto = /\.(jpg|jpeg|png|heic)$/i.test(filename);
          const localPath = isPhoto
            ? path.join(jobDir, "photos", filename)
            : path.join(jobDir, filename);

          await fs.mkdir(path.dirname(localPath), { recursive: true });
          const success = await storage.downloadFile(s3Key, localPath);
          if (!success) {
            logger.warn("Failed to download file", { s3Key });
          }
        }
      }

      logger.info("Downloaded input files from S3", { jobDir, fileCount: inputFiles.length });
    } else {
      // Local mode: Use provided jobFolder or construct from userId/jobId
      if (jobFolder) {
        jobDir = jobFolder;
      } else {
        const projectRoot = path.resolve(import.meta.dirname, "..");
        jobDir = path.join(projectRoot, "data", `INCOMING_${userId}`, jobId);
      }
      outDir = path.join(path.dirname(jobDir).replace("INCOMING", "OUTPUT"), jobId);
    }

    // Verify job directory exists and has files
    if (!fssync.existsSync(jobDir)) {
      throw new Error(`Job directory not found: ${jobDir}`);
    }

    // Run the processing pipeline (pass jobId for accurate cost tracking)
    logger.info("Starting job processing", { jobDir, outDir, jobId });
    const result = await processJob({ jobDir, outDir, dryRun: false, jobId });

    // If using S3, upload results back
    if (storage.isUsingS3() && tempDir) {
      // Use address as folder name if available, otherwise fall back to jobId
      const folderName = result.address || jobId;
      const outputPrefix = `jobs/${userId}/${folderName}/output/`;

      // Use finalOutDir from result (processJob may rename the folder)
      const actualOutDir = result.finalOutDir || outDir;

      // Walk output directory and upload all files
      async function uploadDir(dir, prefix) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const localPath = path.join(dir, entry.name);
          const s3Key = `${prefix}${entry.name}`;

          if (entry.isDirectory()) {
            await uploadDir(localPath, `${s3Key}/`);
          } else {
            const content = await fs.readFile(localPath);
            await storage.uploadBytes(content, s3Key);
          }
        }
      }

      await uploadDir(actualOutDir, outputPrefix);
      logger.info("Uploaded results to S3", { outputPrefix });

      // If job was renamed (address differs from jobId), delete the old S3 prefix
      if (result.address && result.address !== jobId) {
        const oldPrefix = `jobs/${userId}/${jobId}/`;
        logger.info("Job renamed, cleaning up old S3 prefix", { oldPrefix, newFolder: folderName });
        const deleteResult = await storage.deletePrefix(oldPrefix);
        logger.info("Old prefix cleanup complete", { deleted: deleteResult.deleted, errors: deleteResult.errors });
      }

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    res.json({
      success: true,
      jobId,
      result: {
        ok: result.ok,
        address: result.address,
        outputs: result.outputs
      }
    });
  } catch (error) {
    logger.error("Job processing failed", {
      userId,
      jobId,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get full job details
 * GET /api/job/:userId/:jobId
 *
 * jobId can be either:
 * - A database job ID (e.g., job_1234567890)
 * - A folder name/address (for legacy S3-only jobs)
 */
app.get("/api/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Try to find job in database by ID first
    let job = await db.getJob(jobId);

    // If not found by ID, try to find by address
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }

    // Determine the S3 prefix - use address if available (S3 folder is renamed to address after processing)
    // Fall back to jobId for S3-only jobs or if address not set
    const folderName = job?.address || jobId;
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    let circuits = [];
    try {
      const csvContent = await storage.downloadText(`${s3Prefix}test_results.csv`);
      if (csvContent) {
        circuits = parseCSV(csvContent);
      }
    } catch (e) {
      logger.warn("No circuits CSV found", { jobId });
    }

    let extractedData = {};

    // First try the combined extracted_data.json (created by PUT endpoint after user edits)
    const combinedJsonContent = await storage.downloadText(`${s3Prefix}extracted_data.json`).catch(() => null);

    if (combinedJsonContent) {
      // User has edited and saved - use the combined file
      extractedData = JSON.parse(combinedJsonContent);
      logger.info("Loaded extracted_data.json (user-edited)", {
        jobId,
        hasSupply: !!extractedData.supply_characteristics,
        supplyData: extractedData.supply_characteristics,
        hasInstallation: !!extractedData.installation_details,
        installationData: extractedData.installation_details
      });
      // Extract address from installation_details if available (for iOS-created jobs)
      if (extractedData.installation_details?.address && !extractedData.address) {
        extractedData.address = extractedData.installation_details.address;
      }
    } else {
      // Fall back to reading individual files (created by processing pipeline)
      // These need to be transformed to UI format
      logger.info("No extracted_data.json, trying individual pipeline files", { jobId, s3Prefix });

      try {
        const [installationJson, boardJson, observationsJson, supplyJson] = await Promise.all([
          storage.downloadText(`${s3Prefix}installation_details.json`).catch(() => null),
          storage.downloadText(`${s3Prefix}board_details.json`).catch(() => null),
          storage.downloadText(`${s3Prefix}observations.json`).catch(() => null),
          storage.downloadText(`${s3Prefix}supply_characteristics.json`).catch(() => null),
        ]);

        logger.info("Pipeline files loaded", {
          jobId,
          hasInstallation: !!installationJson,
          hasBoard: !!boardJson,
          hasObservations: !!observationsJson,
          hasSupply: !!supplyJson
        });

        const rawInstallation = installationJson ? JSON.parse(installationJson) : null;
        const rawBoard = boardJson ? JSON.parse(boardJson) : null;
        const rawSupply = supplyJson ? JSON.parse(supplyJson) : null;

        // Transform extracted pipeline data to UI format
        const transformed = transformExtractedData(rawInstallation, rawBoard);

        // Set the transformed data
        extractedData.installation_details = transformed.installation_details;
        // Use directly extracted supply_characteristics if available, otherwise use transformed
        extractedData.supply_characteristics = rawSupply || transformed.supply_characteristics;
        extractedData.board_info = transformed.board_info;

        // Also set top-level address/client for job display
        if (rawInstallation) {
          extractedData.address = rawInstallation.address;
          extractedData.client_name = rawInstallation.client_name;
          extractedData.postcode = rawInstallation.postcode;
        }

        if (observationsJson) {
          // Transform observations from pipeline format (title/text) to UI format (item_location/observation_text)
          extractedData.observations = transformObservations(JSON.parse(observationsJson));
        }

        logger.info("Transformed pipeline data to UI format", { jobId });
      } catch (innerError) {
        logger.warn("Failed to load extracted data files", { jobId, error: innerError.message });
      }
    }

    // If no job in DB but we found data in S3, create a virtual job object.
    // Use the original jobId param — the caller's ID is authoritative.
    if (!job && (circuits.length > 0 || Object.keys(extractedData).length > 0)) {
      job = {
        id: jobId,
        address: extractedData.address || jobId,
        status: "done",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({
      id: job.id,
      address: job.address || extractedData.address || jobId,
      status: job.status || "done",
      created_at: job.created_at,
      updated_at: job.updated_at || job.created_at,
      certificate_type: job.certificate_type || extractedData.certificate_type || "EICR",
      circuits,
      observations: extractedData.observations || [],
      board_info: extractedData.board_info || {},
      boards: extractedData.boards || null,
      installation_details: extractedData.installation_details || null,
      supply_characteristics: extractedData.supply_characteristics || null,
      inspection_schedule: extractedData.inspection_schedule || null,
      inspector_id: extractedData.inspector_id || null,
      extent_and_type: extractedData.extent_and_type || null,
      design_construction: extractedData.design_construction || null,
    });
  } catch (error) {
    logger.error("Failed to get job", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to get job: " + error.message });
  }
});

/**
 * Get debug transcription data for a job
 * Shows what audio chunks were received, what was transcribed from each, and the full transcript
 * Use this to debug why certain speech wasn't picked up
 * GET /api/job/:userId/:jobId/debug
 */
app.get("/api/job/:userId/:jobId/debug", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Try to find job in database by ID first
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }

    const folderName = job?.address || jobId;
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    // Download debug transcription log
    const debugContent = await storage.downloadText(`${s3Prefix}debug_transcription.json`).catch(() => null);

    if (!debugContent) {
      return res.status(404).json({
        error: "Debug data not found. This job may have been processed before debug logging was enabled, or wasn't recorded through the real-time API."
      });
    }

    const debugData = JSON.parse(debugContent);

    // Generate signed URLs for audio chunks so frontend can play them
    if (debugData.chunks) {
      for (const chunk of debugData.chunks) {
        if (chunk.audioKey) {
          chunk.audioUrl = await storage.getFileUrl(chunk.audioKey, 3600); // 1 hour expiry
        }
      }
    }

    res.json(debugData);
  } catch (error) {
    logger.error("Failed to get debug data", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to get debug data: " + error.message });
  }
});

function parseCSV(csvContent) {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/"/g, ""));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Update full job data
 * PUT /api/job/:userId/:jobId
 */
app.put("/api/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const {
    circuits,
    observations,
    board_info,
    boards,
    installation_details,
    supply_characteristics,
    inspection_schedule,
    inspector_id,
    extent_and_type,
    design_construction
  } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    // Auto-version: snapshot current data before overwriting
    try {
      const currentData = await storage.downloadText(`${s3Prefix}extracted_data.json`).catch(() => null);
      if (currentData) {
        const changedFields = [];
        if (circuits) changedFields.push("circuits");
        if (observations) changedFields.push("observations");
        if (board_info) changedFields.push("board_info");
        if (boards) changedFields.push("boards");
        if (installation_details) changedFields.push("installation_details");
        if (supply_characteristics) changedFields.push("supply_characteristics");
        if (inspection_schedule) changedFields.push("inspection_schedule");

        const summary = changedFields.length > 0
          ? `Updated: ${changedFields.join(", ")}`
          : "Saved";

        await saveJobVersion(jobId, userId, JSON.parse(currentData), summary);
      }
    } catch (versionError) {
      logger.warn("Failed to save job version", { jobId, error: versionError.message });
    }

    if (circuits && Array.isArray(circuits) && circuits.length > 0) {
      const csvContent = circuitsToCSV(circuits);
      await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
    }

    let extractedData = {};
    try {
      const existing = await storage.downloadText(`${s3Prefix}extracted_data.json`);
      if (existing) {
        extractedData = JSON.parse(existing);
      }
    } catch (e) {}

    if (observations) {
      extractedData.observations = observations;
    }
    if (board_info) {
      extractedData.board_info = board_info;
    }
    if (boards) {
      extractedData.boards = boards;
    }
    if (installation_details) {
      extractedData.installation_details = installation_details;
    }
    if (supply_characteristics) {
      extractedData.supply_characteristics = supply_characteristics;
    }
    if (inspection_schedule) {
      extractedData.inspection_schedule = inspection_schedule;
    }
    if (inspector_id !== undefined) {
      extractedData.inspector_id = inspector_id;
    }
    if (extent_and_type) {
      extractedData.extent_and_type = extent_and_type;
    }
    if (design_construction) {
      extractedData.design_construction = design_construction;
    }

    await storage.uploadText(JSON.stringify(extractedData, null, 2), `${s3Prefix}extracted_data.json`);

    // Update the database — always update updated_at, and update address if we have installation_details.address
    const dbUpdate = { updated_at: new Date().toISOString() };
    if (installation_details?.address) {
      dbUpdate.address = installation_details.address;
      dbUpdate.folder_name = installation_details.address;
      logger.info("Updating job address from PUT", { jobId, address: installation_details.address });

      // Clean up old S3 folder if address changed (prevents ghost duplicates)
      if (folderName !== installation_details.address && storage.isUsingS3()) {
        const oldPrefix = `jobs/${userId}/${folderName}/`;
        try {
          // Copy data to new folder first, then delete old
          const newPrefix = `jobs/${userId}/${installation_details.address}/output/`;
          // The current PUT already wrote to the old folder's s3Prefix,
          // so re-upload extracted_data.json to the new location
          await storage.uploadText(
            JSON.stringify(extractedData, null, 2),
            `${newPrefix}extracted_data.json`
          );
          if (circuits && Array.isArray(circuits) && circuits.length > 0) {
            const csvContent = circuitsToCSV(circuits);
            await storage.uploadText(csvContent, `${newPrefix}test_results.csv`);
          }
          await storage.deletePrefix(oldPrefix);
          logger.info("Migrated S3 data to new address folder", { jobId, oldFolder: folderName, newFolder: installation_details.address });
        } catch (migrateErr) {
          logger.warn("Failed to migrate S3 folder on address change", { jobId, error: migrateErr.message });
        }
      }
    }
    await db.updateJob(jobId, dbUpdate);

    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to update job", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to update job: " + error.message });
  }
});



/**
 * Delete a job
 * DELETE /api/job/:userId/:jobId
 */
app.delete("/api/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  logger.info("Delete job requested", { userId, jobId });

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;

    // Delete from S3
    if (storage.isUsingS3()) {
      const s3Prefix = `jobs/${userId}/${folderName}/`;
      logger.info("Deleting job from S3", { s3Prefix, folderName });
      const deleteResult = await storage.deletePrefix(s3Prefix);
      logger.info("S3 delete result", { deleted: deleteResult.deleted, errors: deleteResult.errors });
    }

    // Delete from database
    await db.deleteJob(jobId, userId);

    logger.info("Job deleted successfully", { userId, jobId });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete job", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to delete job: " + error.message });
  }
});

// ============= Job History / Versioning =============

/**
 * Get version history for a job
 * GET /api/job/:userId/:jobId/history
 */
app.get("/api/job/:userId/:jobId/history", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const versions = await getJobVersions(jobId);
    res.json(versions);
  } catch (error) {
    logger.error("Failed to get job history", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to get job history" });
  }
});

/**
 * Get a specific version snapshot
 * GET /api/job/:userId/:jobId/history/:versionId
 */
app.get("/api/job/:userId/:jobId/history/:versionId", auth.requireAuth, async (req, res) => {
  const { userId, jobId, versionId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const version = await getJobVersion(versionId, jobId, userId);
    if (!version) {
      return res.status(404).json({ error: "Version not found" });
    }
    res.json(version);
  } catch (error) {
    logger.error("Failed to get job version", { userId, jobId, versionId, error: error.message });
    res.status(500).json({ error: "Failed to get job version" });
  }
});

// ============= Photo Endpoints =============

/**
 * Get all photos for a job
 * GET /api/job/:userId/:jobId/photos
 */
app.get("/api/job/:userId/:jobId/photos", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;

    // Check all possible photo locations
    const photoPrefixes = [
      `jobs/${userId}/${folderName}/input/photos/`,
      `jobs/${userId}/${folderName}/photos/`,
      `jobs/${userId}/${folderName}/output/photos/`,
      `jobs/${userId}/${folderName}/output/photos_scaled/`,
    ];

    const allPhotos = [];
    const seenFilenames = new Set();

    for (const prefix of photoPrefixes) {
      try {
        const files = await storage.listFiles(prefix);
        for (const filePath of files) {
          // Only include image files
          if (/\.(jpg|jpeg|png|heic|gif|webp)$/i.test(filePath)) {
            const filename = path.basename(filePath);
            if (!seenFilenames.has(filename)) {
              seenFilenames.add(filename);
              allPhotos.push({
                filename,
                url: `/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}`,
                thumbnail_url: `/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}?thumbnail=true`,
              });
            }
          }
        }
      } catch (e) {
        // Prefix doesn't exist, continue
      }
    }

    res.json(allPhotos);
  } catch (error) {
    logger.error("Failed to list job photos", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to list photos" });
  }
});

/**
 * Get a specific photo
 * GET /api/job/:userId/:jobId/photos/:filename
 */
app.get("/api/job/:userId/:jobId/photos/:filename", auth.requireAuth, async (req, res) => {
  const { userId, jobId, filename } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;

    // Try to find the photo in possible locations
    const possiblePaths = [
      `jobs/${userId}/${folderName}/input/photos/${filename}`,
      `jobs/${userId}/${folderName}/photos/${filename}`,
      `jobs/${userId}/${folderName}/output/photos/${filename}`,
      `jobs/${userId}/${folderName}/output/photos_scaled/${filename}`,
    ];

    let photoContent = null;
    for (const s3Path of possiblePaths) {
      try {
        photoContent = await storage.downloadBytes(s3Path);
        if (photoContent) break;
      } catch (e) {
        // Try next path
      }
    }

    if (!photoContent) {
      return res.status(404).json({ error: "Photo not found" });
    }

    // Determine content type
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".heic": "image/heic",
    };

    res.setHeader("Content-Type", contentTypes[ext] || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
    res.send(photoContent);
  } catch (error) {
    logger.error("Failed to get photo", { userId, jobId, filename, error: error.message });
    res.status(500).json({ error: "Failed to get photo" });
  }
});

/**
 * Upload a new photo to a job
 * POST /api/job/:userId/:jobId/photos
 */
app.post("/api/job/:userId/:jobId/photos", auth.requireAuth, upload.single("photo"), async (req, res) => {
  const { userId, jobId } = req.params;
  const file = req.file;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!file) {
    return res.status(400).json({ error: "No photo uploaded" });
  }

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;

    // Generate unique filename
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const filename = `photo_${Date.now()}${ext}`;
    const s3Key = `jobs/${userId}/${folderName}/photos/${filename}`;

    // Read and upload file
    const content = await fs.readFile(file.path);
    await storage.uploadBytes(content, s3Key);

    // Clean up temp file
    await fs.unlink(file.path).catch(() => {});

    logger.info("Photo uploaded", { userId, jobId, filename });

    res.json({
      success: true,
      photo: {
        filename,
        url: `/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}`,
        thumbnail_url: `/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}?thumbnail=true`,
        uploaded_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Failed to upload photo", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

// ============= Real-Time Recording Sessions =============

/**
 * Strip markdown artefacts from transcription output.
 * Defensive — the chunk prompt shouldn't produce markdown, but catches edge cases.
 */
function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // **bold**
    .replace(/^#{1,6}\s+/gm, "")             // # headers
    .replace(/^[-*]\s+/gm, "")               // - bullets / * bullets
    .replace(/\[(\d{1,2}:\d{2})\]/g, "")     // [MM:SS] timestamps
    .replace(/^(RAW_TRANSCRIPT|TEST_VALUES|PHOTO_MOMENTS):?\s*/gim, "")  // section names
    .replace(/\n{3,}/g, "\n\n")              // collapse excess newlines
    .trim();
}

/**
 * Detect if a transcript is just Gemini describing silence/background noise
 * rather than actual speech. Gemini often returns verbose descriptions like
 * "There is no speech in this audio file. It contains only background sounds
 * of rustling paper and writing." which pollute the semantic buffer.
 *
 * For short text (<200 chars), any noise pattern match → filter it.
 * For longer text, also check for EICR terms — if present, it's mixed
 * content with real speech and should NOT be filtered.
 */
function isNoSpeechDescription(text) {
  if (!text || text.trim().length === 0) return false;

  const lower = text.toLowerCase();

  const NOISE_PATTERNS = [
    /no speech/i,
    /does not contain any speech/i,
    /contains only background/i,
    /no spoken words/i,
    /no audible speech/i,
    /there is no.*speech/i,
    /no discernible speech/i,
    /only.*background\s*(noise|sounds?|audio)/i,
    /silence|silent.*audio/i,
    /no.*vocal.*content/i,
    // Gemini sometimes describes environmental sounds instead of transcribing
    /^\[?sound of\b/i,
    /^\[?sounds? of\b/i,
    /^\[?noise of\b/i,
    /^\[?knocking\b/i,
    /^\[?tapping\b/i,
    /^\[?clicking\b/i,
    /^\[?rustling\b/i,
    /^\[?footsteps\b/i,
    /^\(.*sounds?\)/i,
    // Child/baby speech that isn't the inspector
    /^(?:a\s+)?(?:child|baby|toddler)\s+(?:is\s+)?(?:speaking|talking|babbling|crying|laughing)/i,
    // Generic audio descriptions (not transcriptions)
    /^the audio (?:contains?|features?|includes?|consists? of|is)/i,
    /^this audio (?:contains?|features?|includes?|consists? of|is)/i,
    /^(?:the|this) (?:recording|clip|segment) (?:contains?|features?|includes?)/i,
  ];

  const matchesNoise = NOISE_PATTERNS.some(p => p.test(lower));
  if (!matchesNoise) return false;

  // Check for EICR content BEFORE length-based filtering.
  // A transcript like "No speech detected. Then: circuit 1 R1+R2 is 0.87 ohms"
  // contains both a noise pattern AND real data — must NOT be filtered.
  const EICR_TERMS = /\b(circuit|ohm|bonding|rcd|mcb|rcbo|breaker|insulation|polarity|zs|ze|r1|r2|megohm|observation|defect|socket|lighting|ring|radial|cooker|shower)\b/i;
  if (EICR_TERMS.test(lower)) {
    return false;
  }

  // No EICR content — this is just a noise description, filter it
  return true;
}

// In-memory store for active recording sessions
// Key: sessionId, Value: { accumulator, userId, startedAt, lastActivity, pendingChunks, finishRequested, finishResolve }
const activeSessions = new Map();

/**
 * Save a recording session's accumulated data to the database and S3.
 * Used by both the finish endpoint and stale session cleanup.
 */
async function saveSession(sessionId, session, { address, certificateType = "EICR", isStale = false, whisperDebugLog = null } = {}) {
  const userId = session.userId;

  try {
    // 1. Flush any held short audio chunk that never got a partner
    if (session.audioHoldBuffer) {
      const held = session.audioHoldBuffer;
      session.audioHoldBuffer = null;
      logger.info("── FLUSHING HELD CHUNK ON SAVE ──", {
        sessionId,
        isStale,
        heldChunkIndex: held.chunkIndex,
      });
      try {
        const transcribeResult = await transcribeChunk(held.path);
        const rawTranscript = transcribeResult?.transcript || (typeof transcribeResult === "string" ? transcribeResult : "");
        const transcript = stripMarkdown(rawTranscript);
        if (transcribeResult?.usage) {
          session.tokenAccumulator.add(transcribeResult.usage, transcribeResult?.modelUsed || "unknown");
        }
        if (transcript && transcript.trim() && !isNoSpeechDescription(transcript)) {
          addTranscript(session.eicrBuffer, transcript);
        } else if (isNoSpeechDescription(transcript)) {
          logger.info("NOISE DESCRIPTION FILTERED (held chunk flush)", { sessionId, transcript });
        }
        await fs.unlink(held.path).catch(() => {});
      } catch (err) {
        logger.warn("Held chunk transcription failed on save", { sessionId, error: err.message });
        await fs.unlink(held.path).catch(() => {});
      }
    }

    // 2. Extract any remaining unextracted text in the EICR buffer
    if (session.eicrBuffer.pendingText.length > 0) {
      const payload = getExtractionPayload(session.eicrBuffer);
      const extractionWindow = getExtractionWindow(session.eicrBuffer, 3000);
      logger.info("── FINAL EXTRACTION (remaining buffer) ──", {
        sessionId,
        isStale,
        remainingChars: payload.pendingText.length,
        windowLength: extractionWindow.length,
        activeCircuit: payload.activeCircuit,
        activeTestType: payload.activeTestType,
      });
      try {
        const finalChunkData = await extractChunk(
          extractionWindow,
          session.chunksReceived,
          0,
          {
            activeCircuit: payload.activeCircuit,
            activeTestType: payload.activeTestType,
          },
          getFormData(session.accumulator),
        );
        if (finalChunkData.usage) {
          session.tokenAccumulator.add(finalChunkData.usage, process.env.EXTRACTION_MODEL || "gpt-5.2");
        }
        addChunk(session.accumulator, finalChunkData);
        markExtracted(session.eicrBuffer);
      } catch (err) {
        logger.error("Final extraction failed", { sessionId, error: err.message });
      }
    }

    // 3. Finalize the accumulator (last-chance photo linking)
    finalize(session.accumulator);

    // 4. Get form data
    const formData = getFormData(session.accumulator);

    // 5. Determine address and jobId
    const jobAddress = address ||
      session.address ||
      formData.installation_details?.address ||
      `Job ${new Date().toISOString().split("T")[0]}`;

    const jobId = session.jobId || `job_${Date.now()}`;
    const isExistingJob = !!session.jobId;

    logger.info(isStale ? "Auto-saving stale session" : "Finishing recording session", {
      sessionId,
      jobId,
      isExistingJob,
      isStale,
      address: jobAddress,
      circuits: formData.circuits.length,
      observations: formData.observations.length,
      photos: session.pendingPhotos?.length || 0,
    });

    // 6. Update or create job in database
    if (isExistingJob) {
      // Check if the old S3 folder (job_xxx) differs from the new address folder.
      // If so, we'll clean it up after writing to the new folder to prevent ghost duplicates.
      const existingJob = await db.getJob(jobId);
      const oldFolderName = existingJob?.folder_name || existingJob?.address || jobId;

      await db.updateJob(jobId, {
        folder_name: jobAddress,
        address: jobAddress,
        status: "done",
        completed_at: new Date().toISOString(),
      });
      logger.info("Updated existing job", { jobId, address: jobAddress, oldFolder: oldFolderName });

      // Clean up old S3 folder if it differs from the new one (prevents ghost duplicates in job list)
      if (oldFolderName !== jobAddress && storage.isUsingS3()) {
        const oldPrefix = `jobs/${userId}/${oldFolderName}/`;
        try {
          await storage.deletePrefix(oldPrefix);
          logger.info("Cleaned up old S3 folder after address change", { jobId, oldPrefix, newFolder: jobAddress });
        } catch (cleanupErr) {
          logger.warn("Failed to clean up old S3 folder", { jobId, oldPrefix, error: cleanupErr.message });
        }
      }
    } else {
      await db.createJob({
        id: jobId,
        user_id: userId,
        folder_name: jobAddress,
        address: jobAddress,
        certificate_type: certificateType,
        status: "done",
      });
      logger.info("Created new job", { jobId, address: jobAddress });
    }

    // 7. Upload to S3
    const s3Prefix = `jobs/${userId}/${jobAddress}/output/`;

    if (formData.circuits.length > 0) {
      const csvContent = circuitsToCSV(formData.circuits);
      await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
    }

    const extractedData = {
      installation_details: formData.installation_details,
      supply_characteristics: formData.supply_characteristics,
      board_info: formData.board_info,
      observations: formData.observations,
      address: jobAddress,
    };
    await storage.uploadText(JSON.stringify(extractedData, null, 2), `${s3Prefix}extracted_data.json`);

    await storage.uploadText(
      JSON.stringify(formData.installation_details, null, 2),
      `${s3Prefix}installation_details.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.board_info, null, 2),
      `${s3Prefix}board_details.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.supply_characteristics, null, 2),
      `${s3Prefix}supply_characteristics.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.observations, null, 2),
      `${s3Prefix}observations.json`
    );

    if (session.pendingPhotos && session.pendingPhotos.length > 0) {
      for (const photo of session.pendingPhotos) {
        await storage.uploadBytes(photo.buffer, `jobs/${userId}/${jobAddress}/photos/${photo.filename}`);
      }
      logger.info("Photos uploaded", { jobId, count: session.pendingPhotos.length });
    }

    // Save debug log with full transcript buffer
    const debugData = {
      sessionId,
      jobId,
      address: jobAddress,
      startedAt: new Date(session.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - session.startedAt,
      chunksReceived: session.chunksReceived,
      chunks: session.debugLog,
      fullTranscript: session.eicrBuffer?.fullText || session.geminiFullTranscript || "",
      extractedCircuits: formData.circuits.length,
      extractedObservations: formData.observations.length,
      savedBy: isStale ? "stale-cleanup" : "finish-endpoint",
    };
    await storage.uploadText(
      JSON.stringify(debugData, null, 2),
      `jobs/${userId}/${jobAddress}/output/debug_transcription.json`
    );
    logger.info("Debug transcription log saved", { sessionId, jobId, chunks: session.debugLog.length });

    // Save whisper debug log from iOS (on-device regex matching, transcript snapshots, field updates)
    if (whisperDebugLog) {
      try {
        const whisperLog = typeof whisperDebugLog === "string" ? JSON.parse(whisperDebugLog) : whisperDebugLog;
        await storage.uploadText(
          JSON.stringify(whisperLog, null, 2),
          `jobs/${userId}/${jobAddress}/output/whisper_debug.json`
        );
        logger.info("Whisper debug log saved to S3", {
          sessionId,
          jobId,
          events: whisperLog.events?.length || 0,
          snapshots: whisperLog.transcriptSnapshots?.length || 0,
        });
      } catch (err) {
        logger.warn("Failed to save whisper debug log", { sessionId, error: err.message });
      }
    }

    // 8. Session-level GPT extraction — the heavy lifter.
    // Regex on-device does quick snipes; GPT here gets the full transcript + existing data context
    // to unpick messy audio, orphaned values, ring routing, etc.
    // Results are MERGED back (only fill empty fields — never overwrite existing values).
    if (!isStale && session.eicrBuffer.fullText && session.eicrBuffer.fullText.trim().length > 50) {
      try {
        logger.info("── SESSION-LEVEL GPT EXTRACTION ──", {
          sessionId,
          transcriptLength: session.eicrBuffer.fullText.length,
          existingCircuits: formData.circuits?.length || 0,
        });

        // Feed existing job data as context so GPT knows what circuits exist and what's empty
        const existingData = {
          circuits: formData.circuits || [],
          supply_characteristics: formData.supply_characteristics || {},
          installation_details: formData.installation_details || {},
        };

        const sessionResult = await extractSession(session.eicrBuffer.fullText, existingData);

        if (sessionResult.usage) {
          session.tokenAccumulator.add(sessionResult.usage, process.env.EXTRACTION_MODEL || "gpt-5.2");
        }

        // Merge GPT results into formData — only fill empty fields
        let gptFills = 0;

        // Merge circuit test fields
        for (const gptCircuit of sessionResult.circuits) {
          const ref = gptCircuit.circuit_ref;
          if (!ref) continue;

          // Find matching circuit in existing data (by ref or designation)
          const existing = formData.circuits.find(c =>
            c.circuit_ref === ref || c.circuit_ref === String(ref)
          );

          if (existing) {
            // Fill empty test fields from GPT
            const fillableFields = [
              "measured_zs_ohm", "r1_r2_ohm", "ring_r1_ohm", "ring_rn_ohm", "ring_r2_ohm",
              "ir_live_live_mohm", "ir_live_earth_mohm", "rcd_time_ms", "polarity_confirmed",
              "rcd_button_confirmed", "afdd_button_confirmed", "circuit_designation",
              "live_csa_mm2", "cpc_csa_mm2", "r2_ohm",
            ];
            for (const field of fillableFields) {
              if (gptCircuit[field] && !existing[field]) {
                existing[field] = gptCircuit[field];
                gptFills++;
                logger.info("GPT FILL", { sessionId, circuit: ref, field, value: gptCircuit[field] });
              }
            }
          }
          // Don't create new circuits from GPT — iOS regex/CCU already created the full set
        }

        // Merge supply characteristics (only fill empty fields)
        const gptSupply = sessionResult.supply_characteristics || {};
        const existingSupply = formData.supply_characteristics || {};
        const supplyFillFields = [
          "earthing_arrangement", "earth_loop_impedance_ze", "prospective_fault_current",
          "earthing_conductor_csa", "earthing_conductor_material",
          "main_bonding_csa", "main_bonding_material",
          "bonding_water", "bonding_gas", "bonding_oil", "bonding_structural_steel",
          "supply_polarity_confirmed",
        ];
        for (const field of supplyFillFields) {
          if (gptSupply[field] && !existingSupply[field]) {
            existingSupply[field] = gptSupply[field];
            formData.supply_characteristics = existingSupply;
            gptFills++;
            logger.info("GPT FILL supply", { sessionId, field, value: gptSupply[field] });
          }
        }

        // Merge installation details (only fill empty fields)
        const gptInstall = sessionResult.installation || {};
        const existingInstall = formData.installation_details || {};
        const installFillFields = [
          "client_name", "address", "postcode", "premises_description",
          "next_inspection_years", "extent", "agreed_limitations",
        ];
        for (const field of installFillFields) {
          if (gptInstall[field] && !existingInstall[field]) {
            existingInstall[field] = gptInstall[field];
            formData.installation_details = existingInstall;
            gptFills++;
            logger.info("GPT FILL install", { sessionId, field, value: gptInstall[field] });
          }
        }

        // Merge observations (only add new ones not already present)
        const gptObs = sessionResult.observations || [];
        const existingObs = formData.observations || [];
        for (const obs of gptObs) {
          if (!obs.observation_text) continue;
          const isDuplicate = existingObs.some(e =>
            e.observation_text && e.observation_text.toLowerCase().includes(obs.observation_text.toLowerCase().substring(0, 30))
          );
          if (!isDuplicate) {
            existingObs.push(obs);
            formData.observations = existingObs;
            gptFills++;
            logger.info("GPT FILL observation", { sessionId, text: obs.observation_text });
          }
        }

        logger.info("── GPT SESSION EXTRACTION COMPLETE ──", {
          sessionId,
          gptCircuits: sessionResult.circuits?.length || 0,
          gptFills,
          finalCircuits: formData.circuits?.length || 0,
          finalObservations: formData.observations?.length || 0,
        });

        // Re-upload GPT-enriched data to S3 (step 7 already uploaded the pre-GPT version)
        if (gptFills > 0) {
          try {
            const s3Prefix = `jobs/${userId}/${jobAddress}/output/`;
            if (formData.circuits.length > 0) {
              const csvContent = circuitsToCSV(formData.circuits);
              await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
            }
            const enrichedData = {
              installation_details: formData.installation_details,
              supply_characteristics: formData.supply_characteristics,
              board_info: formData.board_info,
              observations: formData.observations,
              address: jobAddress,
            };
            await storage.uploadText(JSON.stringify(enrichedData, null, 2), `${s3Prefix}extracted_data.json`);
            await storage.uploadText(JSON.stringify(formData.supply_characteristics, null, 2), `${s3Prefix}supply_characteristics.json`);
            await storage.uploadText(JSON.stringify(formData.installation_details, null, 2), `${s3Prefix}installation_details.json`);
            await storage.uploadText(JSON.stringify(formData.observations, null, 2), `${s3Prefix}observations.json`);
            logger.info("GPT-enriched data re-uploaded to S3", { sessionId, gptFills });
          } catch (uploadErr) {
            logger.error("Failed to re-upload GPT-enriched data", { sessionId, error: uploadErr.message });
          }
        }
      } catch (err) {
        logger.error("Session-level GPT extraction failed (non-fatal)", { sessionId, error: err.message });
      }
    }

    // 9. Auto-close any open debug segment and generate reports
    if (session.debugMode && session.debugBuffer.trim()) {
      session.debugSegments.push({
        transcript: session.debugBuffer.trim(),
        startedAt: session.debugStartTime,
        endedAt: new Date().toISOString(),
        autoClosedOnSessionEnd: true,
      });
      session.debugMode = false;
      session.debugBuffer = "";
      logger.info("Debug segment auto-closed on session end", {
        sessionId, segmentCount: session.debugSegments.length,
      });
    }

    if (session.debugSegments.length > 0) {
      // Store sessionId on the session object for the report generator
      session.sessionId = sessionId;
      // Fire-and-forget — don't block session save
      generateAndSaveDebugReports(session).catch(err =>
        logger.error("Failed to generate debug reports", { sessionId, error: err.message })
      );
      logger.info("Debug reports queued for generation", {
        sessionId, segments: session.debugSegments.length,
      });
    }

    // 10. Log accumulated token usage for the session
    const tokenTotals = session.tokenAccumulator.getTotals();
    if (tokenTotals.totalTokens > 0) {
      logger.info("Session token usage", {
        sessionId,
        isStale,
        geminiTokens: tokenTotals.geminiTokens,
        geminiCost: `$${tokenTotals.geminiCost.toFixed(4)}`,
        gptTokens: tokenTotals.gptTokens,
        gptCost: `$${tokenTotals.gptCost.toFixed(4)}`,
        totalTokens: tokenTotals.totalTokens,
        totalCost: `$${tokenTotals.totalCost.toFixed(4)}`,
      });
      try {
        await logTokenUsage({
          dataDir: ".",
          jobId,
          address: jobAddress,
          geminiTokens: tokenTotals.geminiTokens,
          geminiCost: tokenTotals.geminiCost,
          gptTokens: tokenTotals.gptTokens,
          gptCost: tokenTotals.gptCost,
          totalTokens: tokenTotals.totalTokens,
          totalCost: tokenTotals.totalCost,
        });
      } catch (err) {
        logger.warn("Failed to log session token usage", { err: err.message });
      }
    }

    // 10. Clean up session from memory
    activeSessions.delete(sessionId);

    logger.info(isStale ? "Stale session auto-saved" : "Recording session finished and saved", {
      sessionId, jobId, address: jobAddress,
    });

    return { jobId, address: jobAddress, formData };
  } catch (error) {
    logger.error(isStale ? "Failed to auto-save stale session" : "Failed to save recording session", {
      sessionId, error: error.message,
    });
    // Always clean up session to prevent memory leak
    if (isStale) {
      activeSessions.delete(sessionId);
    }
    throw error;
  }
}

// Clean up stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 30 * 60 * 1000; // 30 minutes
  for (const [sessionId, session] of activeSessions) {
    if (now - session.lastActivity > staleThreshold) {
      // Only save if session has meaningful data
      const hasData = session.eicrBuffer?.fullText?.length > 0 ||
                      session.accumulator?.circuits?.length > 0 ||
                      session.accumulator?.observations?.length > 0;

      if (hasData) {
        logger.info("Stale session has data — auto-saving before cleanup", {
          sessionId,
          transcriptLength: session.eicrBuffer?.fullText?.length || 0,
          circuits: session.accumulator?.circuits?.length || 0,
          observations: session.accumulator?.observations?.length || 0,
        });
        // Fire-and-forget save (don't block the interval)
        saveSession(sessionId, session, { isStale: true }).catch(err => {
          logger.error("Failed to auto-save stale session", { sessionId, error: err.message });
          activeSessions.delete(sessionId);
        });
      } else {
        logger.info("Cleaning up stale recording session (no data)", { sessionId });
        activeSessions.delete(sessionId);
      }
    }
  }
}, 5 * 60 * 1000);

/**
 * Start a new real-time recording session
 * POST /api/recording/start
 * Body: { address?: string, jobId?: string }
 * Returns: { sessionId: string }
 */
app.post("/api/recording/start", auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { address, jobId } = req.body;

  const sessionId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const session = {
    accumulator: createAccumulator(),
    userId,
    jobId: jobId || null,  // Link to existing job if provided
    address: address || "",
    addressUpdated: false,  // Track if we've already updated the job's address
    startedAt: Date.now(),
    lastActivity: Date.now(),
    chunksReceived: 0,
    pendingChunks: 0,
    finishRequested: false,
    finishResolve: null,
    eicrBuffer: createEICRBuffer(),
    tokenAccumulator: createTokenAccumulator(),
    audioHoldBuffer: null,  // holds small audio chunks to concatenate with the next one
    // Debug log for audio analysis - tracks each chunk's audio and transcript
    debugLog: [],
    // Sliding window of recent transcripts for context-aware extraction
    recentTranscripts: [],
    // Deduplication: track processed chunkIndex → cached response
    processedChunks: new Map(),
    // Debug audio capture state — "D-bug" keyword triggers verbal bug reporting
    debugMode: false,
    debugBuffer: "",
    debugSegments: [],
    preDebugContext: "",
    debugStartTime: null,
    geminiFullTranscript: "",  // Accumulated Gemini transcripts for debug context
  };

  activeSessions.set(sessionId, session);

  logger.info("Recording session started", { sessionId, userId, jobId: jobId || "(new)" });

  res.json({
    sessionId,
    jobId: jobId || null,
    message: "Recording session started. Send audio chunks to /api/recording/:sessionId/chunk",
  });
});

/**
 * Process an audio chunk and return updated form data
 * POST /api/recording/:sessionId/chunk
 * Multipart form with:
 *   - audio: audio file (1 minute chunk)
 *   - chunkIndex: number (0, 1, 2...)
 *   - chunkStartSeconds: number (when this chunk starts in overall recording)
 */
app.post("/api/recording/:sessionId/chunk", auth.requireAuth, routeTimeout(60000), upload.single("audio"), async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Recording session not found or expired" });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: "Access denied" });
  }

  const audioFile = req.file;
  const chunkIndex = parseInt(req.body.chunkIndex, 10) || session.chunksReceived;
  const chunkStartSeconds = parseInt(req.body.chunkStartSeconds, 10) || chunkIndex * 60;

  if (!audioFile) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  // ── Chunk deduplication ──
  // iOS retries on 500/rate-limit, sending the same chunkIndex multiple times.
  // If we already successfully processed this chunkIndex, return the cached response
  // to avoid duplicate transcription, extraction, and buffer pollution.
  if (session.processedChunks.has(chunkIndex)) {
    const cached = session.processedChunks.get(chunkIndex);
    logger.info("── DUPLICATE CHUNK DETECTED — returning cached response ──", {
      sessionId,
      chunkIndex,
      originalTranscript: (cached.transcript || "").substring(0, 100),
    });
    // Clean up the uploaded temp file
    await fs.unlink(audioFile.path).catch(() => {});
    return res.json({
      success: true,
      chunkIndex,
      formData: getFormData(session.accumulator),
      message: "Duplicate chunk — cached response returned",
      deduplicated: true,
    });
  }

  session.lastActivity = Date.now();
  session.chunksReceived++;
  session.pendingChunks++;

  try {
    // Read the audio chunk
    const audioBuffer = await fs.readFile(audioFile.path);

    // Transcribe the chunk
    logger.info("── AUDIO CHUNK RECEIVED ──", {
      sessionId,
      chunkIndex,
      audioSize: `${audioBuffer.length} bytes (${Math.round(audioBuffer.length / 1024)}KB)`,
      audioFile: audioFile.originalname,
      mimeType: audioFile.mimetype,
    });

    // Save to temp file for transcription
    let tempAudioPath = audioFile.path;

    // ── Short chunk concatenation ──
    // If the audio is very small (<50KB / ~3s), Gemini often returns an empty
    // transcript.  Hold the audio and prepend it to the next incoming chunk
    // so the combined audio is long enough for reliable transcription.
    const MIN_CHUNK_BYTES = 50_000;

    if (audioBuffer.length < MIN_CHUNK_BYTES && !session.audioHoldBuffer) {
      // Too short — hold it for next chunk
      session.audioHoldBuffer = { path: tempAudioPath, chunkIndex, chunkStartSeconds };
      logger.info("── SHORT CHUNK HELD ──", {
        sessionId,
        chunkIndex,
        audioSize: audioBuffer.length,
        threshold: MIN_CHUNK_BYTES,
      });

      // Decrement pendingChunks since we're not processing now
      session.pendingChunks--;
      if (session.pendingChunks === 0 && session.finishRequested && session.finishResolve) {
        session.finishResolve();
      }

      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Short chunk held — will be combined with next chunk",
      });
    }

    // If there's a held chunk, concatenate it with this one using ffmpeg
    let wasConcatenated = false;
    let heldChunkIndex = null;
    if (session.audioHoldBuffer) {
      const held = session.audioHoldBuffer;
      session.audioHoldBuffer = null;
      heldChunkIndex = held.chunkIndex;

      // Save the held chunk's audio to S3 BEFORE concatenation so we don't lose it
      try {
        const heldAudioContent = await fs.readFile(held.path);
        const heldExt = path.extname(held.path) || ".m4a";
        const heldDebugKey = `debug/${session.userId}/${sessionId}/chunk_${String(held.chunkIndex).padStart(3, "0")}${heldExt}`;
        await storage.uploadBytes(heldAudioContent, heldDebugKey, audioFile.mimetype || "audio/mp4");
        logger.info("── HELD CHUNK AUDIO SAVED ──", { sessionId, heldChunkIndex: held.chunkIndex, debugKey: heldDebugKey });
      } catch (heldSaveErr) {
        logger.warn("Failed to save held chunk audio", { sessionId, heldChunkIndex: held.chunkIndex, error: heldSaveErr.message });
      }

      const concatPath = tempAudioPath.replace(/(\.[^.]+)$/, "_concat$1");
      try {
        // Create ffmpeg concat list file
        const listPath = tempAudioPath.replace(/(\.[^.]+)$/, "_list.txt");
        await fs.writeFile(listPath, `file '${held.path}'\nfile '${tempAudioPath}'\n`);

        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        await execFileAsync("ffmpeg", [
          "-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-c", "copy", concatPath,
        ], { timeout: 10_000 });

        // Clean up individual files and list
        await fs.unlink(held.path).catch(() => {});
        await fs.unlink(tempAudioPath).catch(() => {});
        await fs.unlink(listPath).catch(() => {});

        tempAudioPath = concatPath;
        wasConcatenated = true;
        logger.info("── CHUNKS CONCATENATED ──", {
          sessionId,
          heldChunkIndex: held.chunkIndex,
          currentChunkIndex: chunkIndex,
          concatPath,
        });
      } catch (concatErr) {
        logger.warn("── CONCAT FAILED, using current chunk only ──", {
          sessionId,
          error: concatErr.message,
        });
        // Clean up held file, proceed with current chunk
        await fs.unlink(held.path).catch(() => {});
      }
    }

    // Transcribe using Gemini (primary model + fallback)
    let transcribeResult;
    let rawTranscript = "";
    let transcript = "";
    let modelUsed = "unknown";
    let transcribeFailed = false;
    let isEmptyTranscriptError = false;

    try {
      transcribeResult = await transcribeChunk(tempAudioPath);
      rawTranscript = transcribeResult?.transcript || (typeof transcribeResult === "string" ? transcribeResult : "");
      transcript = stripMarkdown(rawTranscript);
      modelUsed = transcribeResult?.modelUsed || "unknown";

      // Track Gemini transcription token usage
      if (transcribeResult?.usage) {
        session.tokenAccumulator.add(transcribeResult.usage, modelUsed);
      }
    } catch (transcribeErr) {
      // Both primary and fallback models failed.
      transcribeFailed = true;
      isEmptyTranscriptError = /empty transcript/i.test(transcribeErr.message);
      if (isEmptyTranscriptError) {
        logger.warn("── TRANSCRIPTION EMPTY (all models) — returning 422 ──", {
          sessionId, chunkIndex, error: transcribeErr.message,
        });
      } else {
        logger.warn("── TRANSCRIPTION FAILED (all models) — returning current data ──", {
          sessionId, chunkIndex, error: transcribeErr.message,
        });
      }
    }

    // ── Save audio chunk to S3 for debug playback ──
    const audioStats = await fs.stat(tempAudioPath).catch(() => null);
    const audioBytes = audioStats?.size || 0;
    const debugExt = path.extname(tempAudioPath) || ".m4a";
    const debugAudioKey = `debug/${session.userId}/${sessionId}/chunk_${String(chunkIndex).padStart(3, "0")}${debugExt}`;
    try {
      const audioContent = await fs.readFile(tempAudioPath);
      await storage.uploadBytes(audioContent, debugAudioKey, audioFile.mimetype || "audio/mp4");
    } catch (debugErr) {
      logger.warn("Failed to save debug audio chunk", { sessionId, chunkIndex, error: debugErr.message });
    }

    // ── Add to debug log ──
    session.debugLog.push({
      chunkIndex,
      chunkStartSeconds,
      timestamp: new Date().toISOString(),
      audioKey: debugAudioKey,
      audioBytes,
      wasConcatenated,
      heldChunkIndex: heldChunkIndex || null,
      transcriptRaw: rawTranscript,
      transcript: transcript || "(empty)",
      modelUsed,
      attempts: transcribeResult?.attempts || 0,
      isEmpty: !transcript || transcript.trim() === "",
      transcribeFailed,
    });

    // Clean up temp file
    await fs.unlink(tempAudioPath).catch(() => {});

    // If transcription failed entirely (both models), return appropriate status
    if (transcribeFailed) {
      if (isEmptyTranscriptError) {
        // 422 Unprocessable Entity — iOS should NOT retry empty transcripts
        return res.status(422).json({
          success: false,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: "Empty transcript — Gemini returned no speech after all retries",
        });
      }
      // Other transcription errors — return 200 with current data (don't break iOS flow)
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Transcription failed — audio saved for debug, returning current data",
      });
    }

    logger.info("── TRANSCRIPTION RESULT ──", {
      sessionId,
      chunkIndex,
      modelUsed,
      attempts: transcribeResult?.attempts || 0,
      transcriptLength: transcript.length,
      isEmpty: !transcript || transcript.trim() === "",
      fullTranscript: transcript || "(empty)",
    });

    // Filter out Gemini noise descriptions (e.g. "There is no speech in this audio...")
    // These would pollute the semantic buffer and bury real speech data
    if (isNoSpeechDescription(transcript)) {
      logger.info("NOISE DESCRIPTION FILTERED", { sessionId, chunkIndex, transcript });
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Chunk received but noise description filtered",
      });
    }

    if (!transcript || transcript.trim() === "") {
      logger.warn("Empty transcript for chunk", { sessionId, chunkIndex });
      // Return current form data without changes
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Chunk received but no speech detected",
        debug_mode: session.debugMode,
      });
    }

    // ── Debug audio capture — keyword detection ──
    // "D-bug" / "debug" triggers verbal bug reporting. Debug speech is routed
    // to a separate buffer so it never pollutes the certificate transcript
    // or rolling context window.

    // Check for debug mode exit FIRST (user says "end debug")
    if (session.debugMode && DEBUG_END.test(transcript)) {
      const debugText = transcript.replace(DEBUG_END, "").trim();
      if (debugText) session.debugBuffer += " " + debugText;

      session.debugSegments.push({
        transcript: session.debugBuffer.trim(),
        startedAt: session.debugStartTime,
        endedAt: new Date().toISOString(),
      });

      // Restore rolling context — debug speech never influences future chunks
      session.eicrBuffer.fullText = session.preDebugContext;
      session.debugMode = false;
      session.debugBuffer = "";

      logger.info("── DEBUG MODE ENDED ──", {
        sessionId, chunkIndex,
        segmentCount: session.debugSegments.length,
        segmentLength: session.debugSegments[session.debugSegments.length - 1].transcript.length,
      });

      // Cache chunk and return — no extraction for debug exit chunk
      // (pendingChunks is decremented in the finally block)
      session.processedChunks.set(chunkIndex, { transcript: "" });
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Debug segment complete",
        debug_mode: false,
        debug_segment_complete: true,
      });
    }

    // If already in debug mode, route transcript to debug buffer
    if (session.debugMode) {
      session.debugBuffer += " " + transcript;
      logger.info("── DEBUG MODE — buffering ──", {
        sessionId, chunkIndex,
        debugBufferLength: session.debugBuffer.length,
        preview: transcript.substring(0, 100),
      });

      session.processedChunks.set(chunkIndex, { transcript: "" });
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: "Debug audio captured",
        debug_mode: true,
      });
    }

    // Check for debug mode entry ("debug" or "d-bug" in transcript)
    if (DEBUG_START.test(transcript)) {
      session.preDebugContext = session.eicrBuffer.fullText;
      session.debugMode = true;
      session.debugStartTime = new Date().toISOString();
      session.debugBuffer = "";

      // Split: text before "debug" goes to certificate, text after goes to debug buffer
      const parts = transcript.split(DEBUG_START);
      const beforeDebug = parts[0]?.trim() || "";
      const afterDebug = parts.slice(1).join(" ").trim() || "";
      if (afterDebug) session.debugBuffer = afterDebug;

      logger.info("── DEBUG MODE STARTED ──", {
        sessionId, chunkIndex,
        beforeDebug: beforeDebug.substring(0, 100),
        afterDebug: afterDebug.substring(0, 100),
      });

      // If there's certificate text before the debug keyword, let it fall through
      // to normal processing. Otherwise return early.
      if (!beforeDebug) {
        session.processedChunks.set(chunkIndex, { transcript: "" });
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: "Debug mode activated",
          debug_mode: true,
        });
      }

      // Use only the pre-debug text for normal processing
      transcript = beforeDebug;
    }

    // Store transcript in sliding window for context-aware extraction
    session.recentTranscripts.push(transcript);
    if (session.recentTranscripts.length > 4) {
      session.recentTranscripts.shift(); // keep last 4
    }

    // Add transcript to EICR-aware semantic buffer
    const { shouldExtract: shouldExtractNow, bufferEnding } = addTranscript(session.eicrBuffer, transcript);

    // Local ring continuity parser — parse but don't inject yet (inject AFTER addChunk)
    const ringParsed = parseRingValues(session.eicrBuffer, transcript);
    const ringCircuitName = ringParsed.length > 0
      ? (session.eicrBuffer.ringCircuit || session.eicrBuffer.activeCircuit)
      : null;

    if (ringParsed.length > 0) {
      logger.info("── RING CONTINUITY LOCAL PARSE ──", {
        sessionId,
        chunkIndex,
        circuit: ringCircuitName,
        parsed: ringParsed,
        ringState: getRingReadings(session.eicrBuffer),
      });
    }

    // Local common readings parser — Ze, Zs, R1+R2, IR, RCD, PFC
    const commonParsed = parseCommonReadings(session.eicrBuffer, transcript);
    if (commonParsed.length > 0) {
      logger.info("── COMMON READINGS LOCAL PARSE ──", {
        sessionId,
        chunkIndex,
        readings: commonParsed,
      });
    }

    logger.info("── TRANSCRIPT BUFFER ──", {
      sessionId,
      chunkIndex,
      pendingLength: session.eicrBuffer.pendingText.length,
      totalLength: session.eicrBuffer.fullText.length,
      activeCircuit: session.eicrBuffer.activeCircuit,
      activeTestType: session.eicrBuffer.activeTestType,
      recentTranscripts: session.recentTranscripts.length,
      shouldExtract: shouldExtractNow,
      bufferPreview: session.eicrBuffer.pendingText.substring(0, 200),
    });

    if (shouldExtractNow) {
      const payload = getExtractionPayload(session.eicrBuffer);

      // Use wider extraction window (~3000 chars of fullText) instead of just pendingText
      const extractionWindow = getExtractionWindow(session.eicrBuffer, 3000);

      // Extract with wider window (formData for delta detection)
      const chunkData = await extractChunk(
        extractionWindow,
        chunkIndex,
        chunkStartSeconds,
        {
          activeCircuit: payload.activeCircuit,
          activeTestType: payload.activeTestType,
        },
        getFormData(session.accumulator),
      );

      // markExtracted still clears pendingText (controls when shouldExtract fires next)
      markExtracted(session.eicrBuffer);

      logger.info("── EXTRACTION RESULT (wider window) ──", {
        sessionId,
        chunkIndex,
        windowLength: extractionWindow.length,
        pendingTextLength: payload.pendingText.length,
        existingCircuits: getFormData(session.accumulator).circuits?.length || 0,
        activeCircuit: payload.activeCircuit,
        activeTestType: payload.activeTestType,
        circuits: Array.isArray(chunkData.circuits) ? chunkData.circuits.length : 0,
        circuitDetails: (Array.isArray(chunkData.circuits) ? chunkData.circuits : []).map(c => ({
          ref: c.circuit_ref,
          name: c.circuit_designation,
          zs: c.measured_zs_ohm,
          ir: c.ir_live_earth_mohm,
          ocpd: c.ocpd_rating_a,
          ring_r1: c.ring_r1_ohm,
          ring_rn: c.ring_rn_ohm,
          ring_r2: c.ring_r2_ohm,
          r1r2: c.r1_r2_ohm,
        })),
        observations: Array.isArray(chunkData.observations) ? chunkData.observations.length : 0,
        observationDetails: (Array.isArray(chunkData.observations) ? chunkData.observations : []).map(o => ({
          code: o.code,
          location: o.item_location,
          text: (o.observation_text || "").substring(0, 80),
        })),
        board: chunkData.board || {},
        installation: chunkData.installation || {},
        supply: chunkData.supply_characteristics || {},
        usage: chunkData.usage,
      });

      // Track GPT extraction token usage
      if (chunkData.usage) {
        session.tokenAccumulator.add(chunkData.usage, process.env.EXTRACTION_MODEL || "gpt-5.2");
      }

      // Add to accumulator (handles merging and photo linking)
      addChunk(session.accumulator, chunkData);

      // Inject local ring values AFTER addChunk (fixes ring values being orphaned)
      if (ringParsed.length > 0 && ringCircuitName) {
        for (const { field, value } of ringParsed) {
          injectRingReading(session.accumulator, ringCircuitName, field, value);
        }
        logger.info("── RING VALUES INJECTED POST-EXTRACTION ──", {
          sessionId,
          chunkIndex,
          circuit: ringCircuitName,
          injected: ringParsed,
        });
      }

      // Inject common readings (Ze, Zs, R1+R2, IR, RCD, PFC)
      if (commonParsed.length > 0) {
        for (const reading of commonParsed) {
          const injected = injectReading(session.accumulator, reading);
          if (injected) {
            logger.info("── COMMON READING INJECTED ──", {
              sessionId,
              chunkIndex,
              reading: reading.name,
              field: reading.field,
              value: reading.value,
              target: reading.target,
              circuit: reading.circuitName,
            });
          }
        }
      }

      // Log accumulated circuits after merge
      logger.info("── ACCUMULATED CIRCUITS ──", {
        sessionId,
        chunkIndex,
        circuits: session.accumulator.circuits.map(c => ({
          ref: c.circuit_ref,
          name: c.circuit_designation,
          ring_r1: c.ring_r1_ohm || '-',
          ring_rn: c.ring_rn_ohm || '-',
          ring_r2: c.ring_r2_ohm || '-',
          r1_r2: c.r1_r2_ohm || '-',
          zs: c.measured_zs_ohm || '-',
          ir: c.ir_live_earth_mohm || '-',
        })),
      });
    } else {
      // Even when GPT extraction doesn't fire, inject local regex values immediately
      // This is the whole point of Tier 1: values populate the UI without waiting for GPT

      // Inject ring values
      if (ringParsed.length > 0 && ringCircuitName) {
        for (const { field, value } of ringParsed) {
          injectRingReading(session.accumulator, ringCircuitName, field, value);
        }
        logger.info("── RING VALUES INJECTED (no-extract path) ──", {
          sessionId,
          chunkIndex,
          circuit: ringCircuitName,
          injected: ringParsed,
        });
      }

      // Inject common readings
      if (commonParsed.length > 0) {
        for (const reading of commonParsed) {
          const injected = injectReading(session.accumulator, reading);
          if (injected) {
            logger.info("── COMMON READING INJECTED (no-extract path) ──", {
              sessionId,
              chunkIndex,
              reading: reading.name,
              field: reading.field,
              value: reading.value,
              target: reading.target,
              circuit: reading.circuitName,
            });
          }
        }
      }

      logger.info("── SKIPPING EXTRACTION (semantic buffer incomplete) ──", {
        sessionId,
        chunkIndex,
        pendingLength: session.eicrBuffer.pendingText.length,
        activeCircuit: session.eicrBuffer.activeCircuit,
        activeTestType: session.eicrBuffer.activeTestType,
        ringInjected: ringParsed.length,
        commonInjected: commonParsed.length,
      });
    }

    // Return updated form data
    const formData = getFormData(session.accumulator);

    logger.info("── ACCUMULATED FORM DATA ──", {
      sessionId,
      chunkIndex,
      circuitsTotal: formData.circuits.length,
      observationsTotal: formData.observations.length,
      chunksProcessed: formData.metadata?.chunksProcessed || 0,
      installationAddress: formData.installation_details?.address || "-",
      installationClient: formData.installation_details?.client_name || "-",
    });

    // If we have a linked jobId and address was just extracted, update the job immediately
    const extractedAddress = formData.installation_details?.address;
    if (session.jobId && extractedAddress && !session.addressUpdated) {
      try {
        await db.updateJob(session.jobId, { address: extractedAddress });
        session.addressUpdated = true;
        session.address = extractedAddress;
        logger.info("── JOB ADDRESS UPDATED ──", {
          sessionId,
          jobId: session.jobId,
          address: extractedAddress,
        });
      } catch (updateErr) {
        logger.warn("Failed to update job address", { sessionId, jobId: session.jobId, error: updateErr.message });
      }
    }

    // Cache this chunk for deduplication (iOS may retry on timeout/network errors)
    session.processedChunks.set(chunkIndex, { transcript: transcript || "" });

    res.json({
      success: true,
      chunkIndex,
      formData,
      debug_mode: session.debugMode,
    });
  } catch (error) {
    logger.error("Chunk processing failed", { sessionId, chunkIndex, error: error.message });
    // Return 422 for empty transcript errors (iOS should NOT retry these)
    // Return 500 only for genuine server errors (iOS CAN retry these)
    const isEmptyTranscript = /empty transcript/i.test(error.message);
    const statusCode = isEmptyTranscript ? 422 : 500;
    res.status(statusCode).json({ error: "Chunk processing failed: " + error.message });
  } finally {
    // Decrement pending counter and resolve finish if waiting
    session.pendingChunks = Math.max(0, (session.pendingChunks || 0) - 1);
    if (session.pendingChunks === 0 && session.finishRequested && session.finishResolve) {
      session.finishResolve();
    }
  }
});

/**
 * Add a photo with timestamp to the recording session
 * POST /api/recording/:sessionId/photo
 * Multipart form with:
 *   - photo: image file
 *   - audioSeconds: number (when photo was taken relative to recording start)
 */
app.post("/api/recording/:sessionId/photo", auth.requireAuth, upload.single("photo"), async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Recording session not found or expired" });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: "Access denied" });
  }

  const photoFile = req.file;
  const audioSeconds = parseInt(req.body.audioSeconds, 10);

  if (!photoFile) {
    return res.status(400).json({ error: "No photo file provided" });
  }

  if (isNaN(audioSeconds)) {
    return res.status(400).json({ error: "audioSeconds is required" });
  }

  session.lastActivity = Date.now();

  try {
    // Generate filename
    const ext = path.extname(photoFile.originalname).toLowerCase() || ".jpg";
    const filename = `IMG_${String(session.accumulator.photos.length + 1).padStart(3, "0")}${ext}`;

    // Store photo temporarily (will be uploaded to S3 on finish)
    const photoBuffer = await fs.readFile(photoFile.path);
    session.pendingPhotos = session.pendingPhotos || [];
    session.pendingPhotos.push({
      filename,
      buffer: photoBuffer,
      audioSeconds,
    });

    // Clean up temp file
    await fs.unlink(photoFile.path).catch(() => {});

    // Add to accumulator for linking
    addPhoto(session.accumulator, filename, audioSeconds);

    logger.info("Photo added to session", {
      sessionId,
      filename,
      audioSeconds,
      linkedObservation: session.accumulator.photos.find(p => p.filename === filename)?.linkedToObservation,
    });

    // Return updated form data (in case photo got linked to an observation)
    const formData = getFormData(session.accumulator);

    res.json({
      success: true,
      filename,
      audioSeconds,
      formData,
      linkedPhotos: formData.metadata.linked_photos,
    });
  } catch (error) {
    logger.error("Photo upload failed", { sessionId, error: error.message });
    res.status(500).json({ error: "Photo upload failed: " + error.message });
  }
});

/**
 * Upload session analytics (JSONL debug log + field sources + manifest) for post-session optimization.
 * POST /api/session/:sessionId/analytics
 * Content-Type: multipart/form-data
 * Fields:
 *   - debug_log (file): JSONL debug log file
 *   - field_sources (JSON): field source dictionary {key: "regex"/"sonnet"/"preExisting"}
 *   - manifest (JSON): session metadata
 */
app.post("/api/session/:sessionId/analytics", auth.requireAuth,
  upload.fields([
    { name: "debug_log", maxCount: 1 },
    { name: "field_sources", maxCount: 1 },
    { name: "manifest", maxCount: 1 },
    { name: "job_snapshot", maxCount: 1 },
  ]),
  async (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.id;

  // Collect temp file paths for cleanup
  const tempFiles = [
    req.files?.debug_log?.[0]?.path,
    req.files?.field_sources?.[0]?.path,
    req.files?.manifest?.[0]?.path,
    req.files?.job_snapshot?.[0]?.path,
  ].filter(Boolean);

  try {
    const s3Prefix = `session-analytics/${userId}/${sessionId}/`;
    const uploads = [];

    // 1. Upload JSONL debug log
    const debugLogFile = req.files?.debug_log?.[0];
    if (debugLogFile) {
      const debugLogContent = await fs.readFile(debugLogFile.path);
      uploads.push(
        storage.uploadBytes(debugLogContent, `${s3Prefix}debug_log.jsonl`, "application/x-ndjson")
          .then(() => ({ file: "debug_log", status: "ok" }))
          .catch((err) => ({ file: "debug_log", status: "failed", error: err.message }))
      );
    }

    // 2. Upload field sources (sent as binary JSON data from iOS)
    const fieldSourcesFile = req.files?.field_sources?.[0];
    if (fieldSourcesFile) {
      const fieldSources = await fs.readFile(fieldSourcesFile.path, "utf8");
      uploads.push(
        storage.uploadBytes(fieldSources, `${s3Prefix}field_sources.json`, "application/json")
          .then(() => ({ file: "field_sources", status: "ok" }))
          .catch((err) => ({ file: "field_sources", status: "failed", error: err.message }))
      );
    }

    // 3. Upload manifest (sent as binary JSON data from iOS)
    const manifestFile = req.files?.manifest?.[0];
    if (manifestFile) {
      const manifest = await fs.readFile(manifestFile.path, "utf8");
      uploads.push(
        storage.uploadBytes(manifest, `${s3Prefix}manifest.json`, "application/json")
          .then(() => ({ file: "manifest", status: "ok" }))
          .catch((err) => ({ file: "manifest", status: "failed", error: err.message }))
      );
    }

    // 4. Upload job snapshot (full current UI state — circuits, supply, observations, etc.)
    const jobSnapshotFile = req.files?.job_snapshot?.[0];
    if (jobSnapshotFile) {
      const jobSnapshot = await fs.readFile(jobSnapshotFile.path, "utf8");
      uploads.push(
        storage.uploadBytes(jobSnapshot, `${s3Prefix}job_snapshot.json`, "application/json")
          .then(() => ({ file: "job_snapshot", status: "ok" }))
          .catch((err) => ({ file: "job_snapshot", status: "failed", error: err.message }))
      );
    }

    const results = await Promise.all(uploads);
    const failures = results.filter((r) => r.status === "failed");

    if (failures.length > 0) {
      logger.warn("Partial analytics upload", { sessionId, userId, failures });
      return res.status(207).json({
        success: false,
        message: "Some files failed to upload",
        results,
      });
    }

    logger.info("Session analytics uploaded", { sessionId, userId, s3Prefix });
    res.json({ success: true });
  } catch (error) {
    logger.error("Session analytics upload failed", { sessionId, userId, error: error.message });
    res.status(500).json({ error: "Analytics upload failed: " + error.message });
  } finally {
    // Clean up temp files regardless of success/failure
    for (const tmpPath of tempFiles) {
      fs.unlink(tmpPath).catch(() => {});
    }
  }
});

/**
 * Upload a debug report from iOS v2 recording pipeline.
 * POST /api/debug-report
 * Body (JSON): { sessionId, issueText, address, jobId }
 * Saves debug_report.json + context.json to S3 at debug-reports/{userId}/{timestamp}/
 */
app.post("/api/debug-report", auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { sessionId, issueText, address, jobId } = req.body;

  if (!issueText || !sessionId) {
    return res.status(400).json({ error: "sessionId and issueText are required" });
  }
  if (issueText.length > 5000) {
    return res.status(400).json({ error: "issueText exceeds maximum length of 5000 characters" });
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = `debug-reports/${userId}/${timestamp}`;

    const debugReport = {
      severity: "user_reported",
      tier: "user",
      title: issueText.substring(0, 100),
      description: issueText,
      source: "ios_v2_voice",
      timestamp: new Date().toISOString(),
    };

    const context = {
      userId,
      sessionId,
      jobId: jobId || "",
      address: address || "",
    };

    await Promise.all([
      storage.uploadJson(debugReport, `${prefix}/debug_report.json`),
      storage.uploadJson(context, `${prefix}/context.json`),
    ]);

    logger.info("Debug report uploaded from iOS", { prefix, sessionId, userId });
    res.json({ success: true, reportId: prefix });
  } catch (error) {
    logger.error("Debug report upload failed", { userId, sessionId, error: error.message });
    res.status(500).json({ error: "Debug report upload failed: " + error.message });
  }
});

/**
 * Finish the recording session and save as a job
 * POST /api/recording/:sessionId/finish
 * Body: { address?: string, certificateType?: "EICR" | "EIC", jobData?: object }
 * jobData is sent by iOS Whisper mode, which does on-device transcription and
 * never sends audio chunks to the backend. When present AND the backend accumulator
 * is empty, the iOS-provided job data is used as the authoritative data source.
 */
app.post("/api/recording/:sessionId/finish", auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Recording session not found or expired" });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: "Access denied" });
  }

  const { address, certificateType = "EICR", jobData, whisperDebugLog } = req.body;

  try {
    // Wait for any pending chunks to finish processing (max 90s)
    if (session.pendingChunks > 0) {
      logger.info("Finish waiting for pending chunks", { sessionId, pendingChunks: session.pendingChunks });
      await Promise.race([
        new Promise((resolve) => {
          session.finishRequested = true;
          session.finishResolve = resolve;
          // If chunks already finished between the check and setting the promise, resolve immediately
          if (session.pendingChunks === 0) resolve();
        }),
        new Promise((resolve) => setTimeout(resolve, 90_000)),
      ]);
      logger.info("Finish done waiting", { sessionId, remainingChunks: session.pendingChunks });
    }

    // Whisper mode: iOS sends jobData with on-device extracted data.
    // If the backend accumulator is empty (no audio chunks were received),
    // populate the accumulator from the iOS-provided job data.
    if (jobData && session.chunksReceived === 0) {
      logger.info("Whisper mode: populating accumulator from iOS jobData", {
        sessionId,
        circuits: jobData.circuits?.length || 0,
        observations: jobData.observations?.length || 0,
        hasInstallation: !!jobData.installation_details,
        hasSupply: !!jobData.supply_characteristics,
        boards: jobData.boards?.length || 0,
      });

      // Populate circuits from iOS data (already snake_case from Swift CodingKeys)
      if (jobData.circuits && jobData.circuits.length > 0) {
        for (const circuit of jobData.circuits) {
          // Skip circuits with no meaningful data (just empty shells)
          if (circuit.circuit_ref || circuit.circuit_designation) {
            session.accumulator.circuits.push({ ...circuit });
          }
        }
      }

      // Populate observations
      if (jobData.observations && jobData.observations.length > 0) {
        for (const obs of jobData.observations) {
          if (obs.observation_text || obs.item_location) {
            session.accumulator.observations.push({
              code: obs.code || "C3",
              item_location: obs.item_location || "",
              observation_text: obs.observation_text || "",
              schedule_item: obs.schedule_item || "",
              schedule_description: obs.schedule_description || "",
              photos: obs.photos || [],
            });
          }
        }
      }

      // Populate installation details
      if (jobData.installation_details && typeof jobData.installation_details === "object") {
        session.accumulator.installation = { ...jobData.installation_details };
      }

      // Populate supply characteristics
      if (jobData.supply_characteristics && typeof jobData.supply_characteristics === "object") {
        session.accumulator.supply = { ...jobData.supply_characteristics };
      }

      // Populate board info (iOS sends boards array, accumulator uses single board object)
      if (jobData.boards && jobData.boards.length > 0) {
        session.accumulator.board = { ...jobData.boards[0] };
      }

      // Update address from installation details if available
      if (!session.address && jobData.installation_details?.address) {
        session.address = jobData.installation_details.address;
      }

      logger.info("Whisper mode: accumulator populated", {
        sessionId,
        circuits: session.accumulator.circuits.length,
        observations: session.accumulator.observations.length,
        installationKeys: Object.keys(session.accumulator.installation).length,
        supplyKeys: Object.keys(session.accumulator.supply).length,
        boardKeys: Object.keys(session.accumulator.board).length,
      });

      // Extract the raw transcript from whisper debug log so saveSession can run GPT extraction
      if (whisperDebugLog) {
        try {
          const wdl = typeof whisperDebugLog === "string" ? JSON.parse(whisperDebugLog) : whisperDebugLog;
          const rawTranscript = wdl.finalRawTranscript || wdl.finalTranscript || "";
          if (rawTranscript.trim().length > 20) {
            session.eicrBuffer.fullText = rawTranscript;
            logger.info("Whisper mode: extracted transcript for GPT session extraction", {
              sessionId,
              transcriptLength: rawTranscript.length,
            });
          }
        } catch (err) {
          logger.warn("Could not extract transcript from whisperDebugLog", { sessionId, error: err.message });
        }
      }
    }

    const result = await saveSession(sessionId, session, { address, certificateType, whisperDebugLog });

    res.json({
      success: true,
      jobId: result.jobId,
      address: result.address,
      formData: result.formData,
      message: "Recording saved successfully",
    });
  } catch (error) {
    logger.error("Failed to finish recording session", { sessionId, error: error.message });
    res.status(500).json({ error: "Failed to save recording: " + error.message });
  }
});

/**
 * Extract structured EICR data from a pre-transcribed text (WhisperKit mode).
 * Skips audio transcription entirely — iOS does on-device transcription via WhisperKit,
 * then sends the text here for GPT extraction.
 * POST /api/recording/extract-transcript
 * Body: { transcript: string, sessionId?: string }
 */
app.post("/api/recording/extract-transcript", auth.requireAuth, async (req, res) => {
  const { transcript, sessionId, existingData } = req.body;

  if (!transcript || transcript.trim().length < 10) {
    return res.status(400).json({ error: "Transcript too short for extraction" });
  }

  try {
    const result = await extractSession(transcript, existingData || null);

    // Format as RecordingFormData (same shape iOS expects from chunk pipeline)
    const formData = {
      circuits: result.circuits || [],
      observations: result.observations || [],
      installation_details: result.installation || {},
      supply_characteristics: result.supply_characteristics || {},
      board_info: result.board || {},
    };

    // Log token usage
    if (result.usage) {
      logger.info("Whisper extract-transcript tokens", {
        sessionId: sessionId || "none",
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        transcriptLength: transcript.length,
        circuitsExtracted: formData.circuits.length,
        observationsExtracted: formData.observations.length,
      });
    }

    res.json({ success: true, formData });
  } catch (error) {
    logger.error("Failed to extract transcript", {
      sessionId: sessionId || "none",
      error: error.message,
      transcriptLength: transcript.length,
    });
    res.status(500).json({ error: "Extraction failed: " + error.message });
  }
});

// ── Gemini chunked audio extraction (per-chunk rate limiting) ──

// Debug audio keyword patterns — shared between standard chunk handler and Gemini endpoint
const DEBUG_START = /\b(?:d[\s-]?bug|debug|dee\s*bug)\b/i;
const DEBUG_END = /\b(?:end|stop|finish|done)\s+(?:d[\s-]?bug|debug)\b/i;

const geminiChunkLimits = new Map(); // userId -> { count, windowStart, sessionChunks: Map<sessionId, count> }

/**
 * Gemini chunked audio extraction
 * POST /api/recording/gemini-extract
 * Body: { sessionId, audio (base64), audioMimeType, context, chunkIndex, chunkDuration }
 */
app.post("/api/recording/gemini-extract", auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { sessionId, audio, audioMimeType, previousAudio, previousAudioMimeType, context, chunkIndex, chunkDuration } = req.body;

  if (!audio || !sessionId) {
    return res.status(400).json({ error: "Missing required fields: audio, sessionId" });
  }

  // ── Rate limiting: 20 chunks/minute per user, 200 chunks per session ──
  const now = Date.now();
  let limits = geminiChunkLimits.get(userId);
  if (!limits || now - limits.windowStart > 60_000) {
    limits = { count: 0, windowStart: now, sessionChunks: limits?.sessionChunks || new Map() };
    geminiChunkLimits.set(userId, limits);
  }
  limits.count++;
  if (limits.count > 20) {
    logger.warn("Gemini extract rate limited", { userId, sessionId, count: limits.count });
    return res.status(429).json({ error: "Rate limited: max 20 chunks/minute" });
  }

  const sessionCount = (limits.sessionChunks.get(sessionId) || 0) + 1;
  limits.sessionChunks.set(sessionId, sessionCount);
  if (sessionCount > 200) {
    logger.warn("Gemini extract session limit", { userId, sessionId, sessionCount });
    return res.status(429).json({ error: "Session limit: max 200 chunks per session" });
  }

  // ── Session awareness (for debug audio + transcript accumulation) ──
  const session = activeSessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
    session.chunksReceived++;
  }

  // Save raw audio chunk to S3 for debugging
  try {
    const ext = (audioMimeType || "audio/flac").includes("flac") ? "flac"
      : (audioMimeType || "").includes("wav") ? "wav"
      : (audioMimeType || "").includes("mp4") || (audioMimeType || "").includes("m4a") ? "m4a"
      : "bin";
    const chunkKey = `debug/${userId}/${sessionId}/chunk_${String(chunkIndex ?? 0).padStart(3, "0")}.${ext}`;
    const audioBuffer = Buffer.from(audio, "base64");
    storage.uploadBytes(audioBuffer, chunkKey, audioMimeType || "audio/flac").catch(e => {
      logger.warn("Failed to save debug audio chunk", { chunkKey, error: e.message });
    });
  } catch (e) {
    // Non-fatal — don't block extraction
    logger.warn("Debug audio chunk save error", { error: e.message });
  }

  try {
    const result = await geminiExtract(
      audio,
      audioMimeType || "audio/flac",
      context || "",
      previousAudio || null,
      previousAudioMimeType || null
    );

    const transcript = result.transcript || "";

    // ── Debug audio capture — keyword detection (mirrors standard chunk handler) ──
    if (session) {
      // Check for debug mode exit FIRST (user says "end debug")
      if (session.debugMode && DEBUG_END.test(transcript)) {
        const debugText = transcript.replace(DEBUG_END, "").trim();
        if (debugText) session.debugBuffer += " " + debugText;

        session.debugSegments.push({
          transcript: session.debugBuffer.trim(),
          startedAt: session.debugStartTime,
          endedAt: new Date().toISOString(),
        });

        // Restore rolling context — debug speech never influences future chunks
        session.geminiFullTranscript = session.preDebugContext;
        session.debugMode = false;
        session.debugBuffer = "";

        logger.info("── DEBUG MODE ENDED (Gemini) ──", {
          sessionId, chunkIndex,
          segmentCount: session.debugSegments.length,
          segmentLength: session.debugSegments[session.debugSegments.length - 1].transcript.length,
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: "(debug exit)",
          isDebugChunk: true,
          modelUsed: "gemini-extract",
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        return res.json({
          ...result,
          transcript: "",
          circuits: [],
          supply: null,
          installation: null,
          board: null,
          orphaned_values: [],
          debug_mode: false,
          debug_segment_complete: true,
        });
      }

      // If already in debug mode, route transcript to debug buffer
      if (session.debugMode) {
        session.debugBuffer += " " + transcript;
        logger.info("── DEBUG MODE — buffering (Gemini) ──", {
          sessionId, chunkIndex,
          debugBufferLength: session.debugBuffer.length,
          preview: transcript.substring(0, 100),
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || "(empty)",
          isDebugChunk: true,
          modelUsed: "gemini-extract",
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        return res.json({
          ...result,
          transcript: "",
          circuits: [],
          supply: null,
          installation: null,
          board: null,
          orphaned_values: [],
          debug_mode: true,
        });
      }

      // Check for debug mode entry ("debug" or "d-bug" in transcript)
      if (DEBUG_START.test(transcript)) {
        session.preDebugContext = session.geminiFullTranscript;
        session.debugMode = true;
        session.debugStartTime = new Date().toISOString();
        session.debugBuffer = "";

        const parts = transcript.split(DEBUG_START);
        const beforeDebug = parts[0]?.trim() || "";
        const afterDebug = parts.slice(1).join(" ").trim() || "";
        if (afterDebug) session.debugBuffer = afterDebug;

        logger.info("── DEBUG MODE STARTED (Gemini) ──", {
          sessionId, chunkIndex,
          beforeDebug: beforeDebug.substring(0, 100),
          afterDebug: afterDebug.substring(0, 100),
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || "(empty)",
          isDebugChunk: true,
          modelUsed: "gemini-extract",
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        // If there's certificate text before the debug keyword, include it
        // in the response (but suppress extraction data for the debug part)
        if (!beforeDebug) {
          return res.json({
            ...result,
            transcript: "",
            circuits: [],
            supply: null,
            installation: null,
            board: null,
            orphaned_values: [],
            debug_mode: true,
          });
        }

        // Include pre-debug text in transcript accumulation but suppress extraction
        session.geminiFullTranscript += (session.geminiFullTranscript ? " " : "") + beforeDebug;
      }

      // Accumulate transcript for non-debug chunks
      if (!session.debugMode && transcript) {
        session.geminiFullTranscript += (session.geminiFullTranscript ? " " : "") + transcript;
      }

      // Push to debug log for every chunk
      if (!session.debugMode || !DEBUG_START.test(transcript)) {
        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || "(empty)",
          isDebugChunk: false,
          modelUsed: "gemini-extract",
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
      }
    }

    logger.info("Gemini extract chunk", {
      userId,
      sessionId,
      chunkIndex,
      chunkDuration,
      transcriptLen: result.transcript?.length ?? 0,
      circuits: result.circuits?.length ?? 0,
      orphans: result.orphaned_values?.length ?? 0,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cost: result.usage?.cost ?? 0,
      latencyMs: result.usage?.latencyMs ?? 0,
      debugMode: session?.debugMode ?? false,
    });

    res.json({
      ...result,
      debug_mode: session?.debugMode ?? false,
    });

  } catch (error) {
    logger.error("Gemini extract failed", {
      userId,
      sessionId,
      chunkIndex,
      error: error.message,
    });
    res.status(500).json({ error: "Extraction failed: " + error.message });
  }
});

/**
 * Get current form data for a recording session (without processing new data)
 * GET /api/recording/:sessionId
 */
app.get("/api/recording/:sessionId", auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Recording session not found or expired" });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: "Access denied" });
  }

  session.lastActivity = Date.now();

  res.json({
    sessionId,
    formData: getFormData(session.accumulator),
    chunksReceived: session.chunksReceived,
    photosCount: session.accumulator.photos.length,
    startedAt: session.startedAt,
  });
});

// ============= Queue Endpoints =============

app.get("/api/queue/status/:jobId", auth.requireAuth, async (req, res) => {
  const { jobId } = req.params;
  try {
    const status = await getQueueStatus(jobId);
    res.json(status);
  } catch (error) {
    logger.error("Failed to get queue status", { jobId, error: error.message });
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

app.get("/api/queue/health", auth.requireAuth, async (req, res) => {
  try {
    const health = await getQueueHealth();
    res.json(health);
  } catch (error) {
    logger.error("Failed to get queue health", { error: error.message });
    res.status(500).json({ error: "Failed to get queue health" });
  }
});

// ============= CCU Photo Analysis =============

/**
 * BS/EN standard number lookup by device type
 * Used to fill in BS numbers when AI can't read them from the circuit breaker face
 */
const BS_EN_LOOKUP = {
  // MCBs - Type B, C, D circuit breakers
  MCB: "60898-1",
  B: "60898-1",
  C: "60898-1",
  D: "60898-1",

  // RCBOs - Combined MCB + RCD
  RCBO: "61009",

  // RCDs - Residual current devices (standalone)
  RCD: "61008",
  RCCB: "61008",

  // MCCBs - Moulded case circuit breakers
  MCCB: "60947-2",

  // Main switches / isolators
  SWITCH: "60947-3",
  ISOLATOR: "60947-3",

  // Fuses
  "gG": "60269-2",
  HRC: "60269-2",
  REWIREABLE: "3036",
  CARTRIDGE: "1361",
};

/**
 * Apply fallback BS/EN numbers to circuits based on device type
 * Only fills in when the AI didn't detect a value
 */
function applyBsEnFallback(analysis) {
  if (!analysis?.circuits) return analysis;

  for (const circuit of analysis.circuits) {
    // Determine device type
    const ocpdType = (circuit.ocpd_type || "").toUpperCase();
    const isRcbo = circuit.is_rcbo === true ||
                   (circuit.rcd_protected === true && circuit.rcd_rating_ma &&
                    ["B", "C", "D"].includes(ocpdType));

    // Fill in BS/EN number if missing
    if (!circuit.ocpd_bs_en) {
      if (isRcbo) {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.RCBO;
        circuit.rcd_bs_en = BS_EN_LOOKUP.RCBO;
      } else if (BS_EN_LOOKUP[ocpdType]) {
        circuit.ocpd_bs_en = BS_EN_LOOKUP[ocpdType];
      } else if (ocpdType === "MCCB") {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.MCCB;
      } else if (ocpdType === "GG" || ocpdType === "HRC") {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.gG;
      }
    }

    // Fill in breaking capacity (kA) if missing - default 6kA for domestic MCBs/RCBOs
    if (!circuit.ocpd_breaking_capacity_ka) {
      if (["B", "C", "D"].includes(ocpdType) || isRcbo) {
        circuit.ocpd_breaking_capacity_ka = "6";
      }
    }

    // If RCD protected by separate RCD (not RCBO), set RCD BS number
    if (circuit.rcd_protected && !circuit.rcd_bs_en && !isRcbo) {
      circuit.rcd_bs_en = BS_EN_LOOKUP.RCD;
    }
  }

  return analysis;
}

/**
 * Analyze a consumer unit (fuseboard) photo using GPT Vision
 * POST /api/analyze-ccu
 * Accepts multipart upload with "photo" field (JPEG)
 * Returns structured FuseboardAnalysis JSON
 */
app.post("/api/analyze-ccu", auth.requireAuth, upload.single("photo"), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    const model = (process.env.CCU_MODEL || "gpt-5.2").trim();

    logger.info("CCU photo analysis requested", {
      userId: req.user.id,
      fileSize: req.file.size,
      model,
    });

    // Read image and convert to base64
    const imageBytes = await fs.readFile(tempPath);
    const base64 = Buffer.from(imageBytes).toString("base64");

    const prompt = `You are an expert UK electrician analysing a photo of a consumer unit for an EICR certificate.

## TASK

Extract every protective device from this consumer unit photo and return structured JSON.

## NUMBERING

Find the main switch first. Circuit 1 starts from the device immediately next to the main switch, numbering outward. The main switch may be on the left or right.

## FOR EACH DEVICE, EXTRACT:

Read directly from the photo where possible:
- Manufacturer, model number, current rating, type curve (B/C/D)
- RCD type symbol (A, AC, F, or B), RCD sensitivity (mA)
- Circuit label/name (see CIRCUIT LABELS section below)
- BS/EN standard number printed on device
- Breaking capacity in kA

If any of the following are NOT clearly readable on the device, use your knowledge to look them up based on the manufacturer and model number you CAN see:
- **BS EN number**: Look up the correct standard for that device type (e.g., MCB = BS EN 60898-1, RCBO = BS EN 61009-1)
- **RCD type**: Look up whether this specific model range is Type A or Type AC. Different ranges from the same manufacturer have different RCD types — e.g., Hager ADA = Type A, Hager ADN = Type AC; MK H79xx = Type AC, MK H68xx = Type A; BG CURB = Type AC, BG CUCRB = Type A. Match by model prefix, not just manufacturer.
- **Type curve**: If not visible, B is standard for domestic but flag as assumed.

NEVER return "RCD" as an RCD type. Always return A, AC, F, B, or N/A.

## BOARD INFO

- Identify manufacturer and model if visible (e.g. "Hager", "MK", "Wylex").
- Note main switch position ("left" or "right").

## MAIN SWITCH DETAILS

- Read the current rating in amps (e.g., "63", "80", "100").
- Identify the type: "Isolator", "Switch Disconnector", "RCD", "RCCB", or other.
- Look for BS/EN standard number (e.g., "60947-3", "61008").
- Identify poles: "DP" (double pole), "TP" (triple pole), "TPN", "4P".
- Read voltage rating if printed (e.g., "230", "400").

## SPD (SURGE PROTECTION DEVICE)

- If an SPD module is visible, set spd_present to true and extract: BS/EN standard, SPD type ("Type 1", "Type 2", "Type 1+2", "Type 3"), rated current in amps, short circuit rating in kA.
- If NO SPD is visible, set spd_present to false.

## DEVICE TYPE MAPPING

For each circuit device:
- If it is an RCBO (combined MCB+RCD): set is_rcbo=true, rcd_protected=true
- If it is behind a standalone RCD: set is_rcbo=false, rcd_protected=true
- If it is a plain MCB with no RCD protection: set is_rcbo=false, rcd_protected=false
- Blank/spare positions: set ocpd_type to null, label to null

## CIRCUIT LABELS — IMPORTANT

Actively look for circuit names/labels. They are CRITICAL for the certificate. Check ALL of the following locations in the photo:
- **Label chart/legend**: A printed or handwritten list mapping circuit numbers to names (often inside the door or below the board)
- **Adhesive stickers**: Individual labels stuck next to or below each device
- **Handwritten labels**: Pen/marker writing on the board, cover, or blanking plates
- **Printed panels**: Manufacturer-provided label strips or engraved markings
- **Cover plate text**: Text printed on the plastic blanking strips between devices

Common UK circuit names: "Lighting", "Ring Main", "Kitchen Sockets", "Cooker", "Shower", "Immersion", "Smoke Alarms", "Garage", "Garden", "Upstairs Sockets", "Downstairs Sockets", "Boiler", "Fridge Freezer", "Washer".

If you can see ANY text that identifies what a circuit supplies, return it as the label. Only return null if there is genuinely no label visible for that circuit.

## OUTPUT FORMAT

Return ONLY valid JSON matching this exact schema:
{
  "board_manufacturer": "string or null",
  "board_model": "string or null",
  "main_switch_rating": "string — amps",
  "main_switch_position": "left or right",
  "main_switch_bs_en": "string or null",
  "main_switch_type": "Isolator|Switch Disconnector|RCD|RCCB or null",
  "main_switch_poles": "DP|TP|TPN|4P",
  "main_switch_current": "string — amps",
  "main_switch_voltage": "string or null",
  "spd_present": false,
  "spd_bs_en": "string or null",
  "spd_type": "string or null",
  "spd_rated_current_a": "string or null",
  "spd_short_circuit_ka": "string or null",
  "confidence": {
    "overall": 0.85,
    "image_quality": "clear|partially_readable|poor",
    "uncertain_fields": ["circuits[2].ocpd_bs_en"],
    "message": "Brief note about any reading difficulties or looked-up values"
  },
  "circuits": [
    {
      "circuit_number": 1,
      "label": "Kitchen Sockets or null",
      "ocpd_type": "B|C|D or null for blanks",
      "ocpd_rating_a": "32 or null",
      "ocpd_bs_en": "60898-1 or null",
      "ocpd_breaking_capacity_ka": "6 or null",
      "is_rcbo": false,
      "rcd_protected": true,
      "rcd_rating_ma": "30 or null",
      "rcd_bs_en": "61008 or null"
    }
  ]
}

## CONFIDENCE SCORING

- "overall": 0.0-1.0 reflecting readability. 1.0 = every marking perfectly clear.
- "image_quality": "clear", "partially_readable", or "poor".
- "uncertain_fields": list field paths you had to guess or look up.
- "message": include which values were looked up vs read, and any reading difficulties.

IMPORTANT: If you cannot read the BS/EN number from the device, use your knowledge to look it up based on manufacturer and model. Only leave as null if you cannot identify the device at all.`;

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey });

    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const response = await openai.chat.completions.create({
      model,
      max_completion_tokens: 8192,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "";
    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    const finishReason = response.choices?.[0]?.finish_reason || "unknown";

    logger.info("CCU analysis complete", {
      userId: req.user.id,
      model,
      promptTokens,
      completionTokens,
      responseLength: content.length,
      finishReason,
      rawContentPreview: content.slice(0, 500),
    });

    // Check for truncated response before attempting parse
    if (finishReason === "length") {
      logger.error("CCU analysis truncated by token limit", {
        userId: req.user.id, model, completionTokens, responseLength: content.length,
      });
      return res.status(502).json({
        error: `Response truncated (${completionTokens} tokens). The model hit its output limit. Try a clearer photo or retry.`,
      });
    }

    // Parse JSON
    let jsonStr = content;
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    let analysis = JSON.parse(jsonStr);

    // Apply BS/EN fallback for any circuits missing BS numbers
    analysis = applyBsEnFallback(analysis);

    // Main switch fallbacks
    if (!analysis.main_switch_current && analysis.main_switch_rating) {
      analysis.main_switch_current = analysis.main_switch_rating;
    }
    if (!analysis.main_switch_bs_en) {
      analysis.main_switch_bs_en = "60947-3";
    }
    if (!analysis.main_switch_poles) {
      analysis.main_switch_poles = "DP";
    }
    if (!analysis.main_switch_voltage) {
      analysis.main_switch_voltage = "230";
    }

    // Attach cost data (Gemini Pro 3 Preview: $2/1M input, $12/1M output)
    const inputCost = promptTokens * 0.002 / 1000;
    const outputCost = completionTokens * 0.012 / 1000;
    analysis.gptVisionCost = {
      cost_usd: parseFloat((inputCost + outputCost).toFixed(6)),
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      image_count: 1
    };

    const labelledCircuits = (analysis.circuits || []).filter(c => c.label && c.label !== "null").length;
    const totalCircuits = analysis.circuits?.length || 0;

    logger.info("CCU analysis parsed", {
      userId: req.user.id,
      model,
      boardManufacturer: analysis.board_manufacturer,
      boardModel: analysis.board_model,
      circuitCount: totalCircuits,
      labelledCircuits,
      labelCoverage: totalCircuits > 0 ? `${labelledCircuits}/${totalCircuits}` : "0/0",
      circuitLabels: (analysis.circuits || []).map(c => c.label || null),
      mainSwitchCurrent: analysis.main_switch_current,
      spdPresent: analysis.spd_present,
      confidenceOverall: analysis.confidence?.overall,
      confidenceQuality: analysis.confidence?.image_quality,
      uncertainFieldCount: analysis.confidence?.uncertain_fields?.length || 0,
      confidenceMessage: analysis.confidence?.message,
      costUsd: analysis.gptVisionCost.cost_usd,
    });

    res.json(analysis);
  } catch (error) {
    logger.error("CCU analysis failed", {
      userId: req.user.id,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up temp file
    if (tempPath) {
      try { await fs.unlink(tempPath); } catch {}
    }
  }
});

// ============= Observation Enhancement =============

/**
 * Enhance an observation using GPT
 * POST /api/enhance-observation
 * Rewrites observation text in professional BS 7671 language,
 * identifies relevant regulation(s), and assigns inspection schedule item.
 */
app.post("/api/enhance-observation", auth.requireAuth, async (req, res) => {
  try {
    const { observation_text, code, item_location } = req.body;

    if (!observation_text || !observation_text.trim()) {
      return res.status(400).json({ error: "observation_text is required" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    const model = (process.env.EXTRACTION_MODEL || "gpt-5.2").trim();

    logger.info("Observation enhancement requested", {
      userId: req.user.id,
      code: code || "unknown",
      location: item_location || "unknown",
      textLength: observation_text.length,
      model,
    });

    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey });

    const systemPrompt = `You are a qualified UK electrician writing observations for an Electrical Installation Condition Report (EICR) to BS 7671 (18th Edition IET Wiring Regulations).

Given a raw observation from an electrician, rewrite it professionally and identify:
1. The relevant BS 7671 regulation(s) breached
2. The inspection schedule item number (from Guidance Note 3 / Appendix 6)

Common inspection schedule items:
- 4.1: Consumer unit / distribution board
- 4.2: Overcurrent protective devices (MCBs, fuses)
- 4.3: RCD protection
- 4.4: Presence of adequate main earthing conductor
- 4.5: Presence of adequate main protective bonding conductors
- 4.6: Supplementary bonding
- 4.7: Basic protection (insulation, barriers, enclosures)
- 4.8: Fault protection
- 4.9: Additional protection
- 4.10: Condition of wiring system accessories
- 4.11: Condition of cables
- 4.12: Identification and notices
- 4.13: Enclosures and mechanical protection
- 4.14: Presence of fire barriers
- 5.1-5.13: Testing results (continuity, insulation resistance, polarity, etc.)

Rules for rewriting:
- Keep the meaning identical but use formal electrical inspection terminology
- Be concise but thorough - suitable for an official EICR certificate
- Reference specific BS 7671 regulation numbers (e.g., "Reg 421.1.201", "Reg 544.1.1")
- If multiple regulations apply, list the most relevant one
- The schedule_item should be a single number like "4.13" or "4.7"

Return ONLY valid JSON with no markdown formatting:
{
  "observation_text": "Professional rewrite of the observation",
  "regulation": "Reg XXX.X.X",
  "schedule_item": "4.X"
}`;

    const userPrompt = `Observation code: ${code || "C3"}
Location: ${item_location || "Not specified"}
Raw observation: ${observation_text}`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 500,
    });

    const content = response.choices?.[0]?.message?.content?.trim() || "";

    logger.info("Observation enhancement complete", {
      userId: req.user.id,
      model,
      tokens: response.usage?.total_tokens,
      responseLength: content.length,
    });

    // Strip markdown fences if present
    let jsonStr = content;
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const enhanced = JSON.parse(jsonStr);

    // Validate required fields
    if (!enhanced.observation_text) {
      throw new Error("GPT response missing observation_text");
    }

    logger.info("Observation enhancement parsed", {
      userId: req.user.id,
      regulation: enhanced.regulation,
      scheduleItem: enhanced.schedule_item,
      enhancedLength: enhanced.observation_text.length,
    });

    res.json({
      success: true,
      enhanced: {
        observation_text: enhanced.observation_text,
        regulation: enhanced.regulation || null,
        schedule_item: enhanced.schedule_item || null,
      },
    });
  } catch (error) {
    logger.error("Observation enhancement failed", {
      userId: req.user.id,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
});

// ============= PDF Generation =============

/**
 * Generate PDF certificate
 * POST /api/job/:userId/:jobId/generate-pdf
 */
app.post("/api/job/:userId/:jobId/generate-pdf", auth.requireAuth, routeTimeout(60000), async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  logger.info("PDF generation requested", { userId, jobId });

  let tempDir = null;

  try {
    // Look up job to get the actual folder name (address)
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    const folderName = job?.address || jobId;

    // Create temp directory for job data
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-pdf-${jobId}-`));
    const outputDir = path.join(tempDir, "output");
    await fs.mkdir(outputDir, { recursive: true });

    // Download job files from S3
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    // Download test_results.csv
    const csvContent = await storage.downloadText(`${s3Prefix}test_results.csv`);
    if (csvContent) {
      await fs.writeFile(path.join(outputDir, "test_results.csv"), csvContent);
    }

    // Try to download extracted_data.json first (created by PUT endpoint after user edits)
    // Fall back to individual pipeline files if it doesn't exist
    let extractedContent = null;
    try {
      extractedContent = await storage.downloadText(`${s3Prefix}extracted_data.json`);
    } catch (e) {
      logger.info("No extracted_data.json found, will use pipeline files", { jobId });
    }

    if (extractedContent) {
      // User has edited and saved - use extracted_data.json
      const extracted = JSON.parse(extractedContent);

      // Write installation_details.json from extracted data
      const installationData = extracted.installation_details || {};
      await fs.writeFile(
        path.join(outputDir, "installation_details.json"),
        JSON.stringify({
          address: installationData.address || extracted.address || jobId,
          client_name: installationData.client_name || extracted.client_name || "",
          postcode: installationData.postcode || extracted.postcode || "",
          ...installationData,
        }, null, 2)
      );

      // Write board_details.json - merge board_info with supply_characteristics for PDF generator
      const boardInfo = extracted.board_info || {};
      const supplyChars = extracted.supply_characteristics || {};
      await fs.writeFile(
        path.join(outputDir, "board_details.json"),
        JSON.stringify({
          ...boardInfo,
          // Supply characteristics that PDF generator expects in board_details
          ze: supplyChars.earth_loop_impedance_ze || boardInfo.ze || "",
          ipf_at_db: supplyChars.prospective_fault_current || boardInfo.ipf_at_db || "",
          earthing_arrangement: supplyChars.earthing_arrangement || boardInfo.earthing_arrangement || "",
          voltage_rating: supplyChars.nominal_voltage_u || boardInfo.voltage_rating || "",
          // Full supply characteristics merged into board_details for PDF generator compatibility
          nominal_voltage_u: supplyChars.nominal_voltage_u || boardInfo.nominal_voltage_u || "",
          nominal_voltage_uo: supplyChars.nominal_voltage_uo || boardInfo.nominal_voltage_uo || "",
          nominal_frequency: supplyChars.nominal_frequency || boardInfo.nominal_frequency || "",
          live_conductors: supplyChars.live_conductors || boardInfo.live_conductors || "",
          number_of_supplies: supplyChars.number_of_supplies || boardInfo.number_of_supplies || "",
          supply_polarity_confirmed: supplyChars.supply_polarity_confirmed ?? boardInfo.supply_polarity_confirmed ?? "",
          // Earthing conductor and bonding
          earthing_conductor_csa: supplyChars.earthing_conductor_csa || boardInfo.earthing_conductor_csa || "",
          earthing_conductor_material: supplyChars.earthing_conductor_material || boardInfo.earthing_conductor_material || "",
          main_bonding_csa: supplyChars.main_bonding_csa || boardInfo.main_bonding_csa || "",
          bonding_conductor_material: supplyChars.bonding_conductor_material || boardInfo.bonding_conductor_material || "",
          bonding_conductor_csa: supplyChars.bonding_conductor_csa || boardInfo.bonding_conductor_csa || "",
          bonding_water: supplyChars.bonding_water ?? boardInfo.bonding_water ?? "",
          bonding_gas: supplyChars.bonding_gas ?? boardInfo.bonding_gas ?? "",
          bonding_oil: supplyChars.bonding_oil ?? boardInfo.bonding_oil ?? "",
          bonding_structural_steel: supplyChars.bonding_structural_steel ?? boardInfo.bonding_structural_steel ?? "",
          bonding_lightning: supplyChars.bonding_lightning ?? boardInfo.bonding_lightning ?? "",
          bonding_other: supplyChars.bonding_other || boardInfo.bonding_other || "",
          // Main switch
          main_switch_bs_en: supplyChars.main_switch_bs_en || boardInfo.main_switch_bs_en || "",
          main_switch_poles: supplyChars.main_switch_poles || boardInfo.main_switch_poles || "",
          main_switch_voltage: supplyChars.main_switch_voltage || boardInfo.main_switch_voltage || "",
          main_switch_current: supplyChars.main_switch_current || boardInfo.main_switch_current || "",
          rated_current: supplyChars.main_switch_current || supplyChars.rated_current || boardInfo.rated_current || "",
          // SPD
          spd_bs_en: supplyChars.spd_bs_en || boardInfo.spd_bs_en || "",
          spd_type_supply: supplyChars.spd_type_supply || boardInfo.spd_type_supply || "",
          spd_short_circuit: supplyChars.spd_short_circuit || boardInfo.spd_short_circuit || "",
          spd_rated_current: supplyChars.spd_rated_current || boardInfo.spd_rated_current || "",
          // Earth electrode
          earth_electrode_type: supplyChars.earth_electrode_type || boardInfo.earth_electrode_type || "",
          earth_electrode_resistance: supplyChars.earth_electrode_resistance || boardInfo.earth_electrode_resistance || "",
          // Tails
          tails_csa: supplyChars.tails_csa || boardInfo.tails_csa || "",
          tails_material: supplyChars.tails_material || boardInfo.tails_material || "",
          // Installation details that PDF generator expects in board_details
          extent: extracted.installation_details?.extent || boardInfo.extent || "",
          agreed_limitations: extracted.installation_details?.agreed_limitations || boardInfo.agreed_limitations || "",
          agreed_with: extracted.installation_details?.agreed_with || boardInfo.agreed_with || "",
          operational_limitations: extracted.installation_details?.operational_limitations || boardInfo.operational_limitations || "",
        }, null, 2)
      );

      // Write supply_characteristics.json as a separate file for the PDF generator
      await fs.writeFile(
        path.join(outputDir, "supply_characteristics.json"),
        JSON.stringify(supplyChars, null, 2)
      );

      // Write observations.json
      await fs.writeFile(
        path.join(outputDir, "observations.json"),
        JSON.stringify(extracted.observations || [], null, 2)
      );

      // Write boards.json if multi-board data exists
      if (extracted.boards && Array.isArray(extracted.boards) && extracted.boards.length > 0) {
        await fs.writeFile(
          path.join(outputDir, "boards.json"),
          JSON.stringify(extracted.boards, null, 2)
        );
        logger.info("Written boards.json for multi-board PDF generation", { jobId, boardCount: extracted.boards.length });
      }

      // Write inspection_schedule.json if present
      if (extracted.inspection_schedule) {
        await fs.writeFile(
          path.join(outputDir, "inspection_schedule.json"),
          JSON.stringify(extracted.inspection_schedule, null, 2)
        );
        logger.info("Written inspection_schedule.json for PDF generation", { jobId });
      }

      // Write inspector.json if present
      if (extracted.inspector) {
        await fs.writeFile(
          path.join(outputDir, "inspector.json"),
          JSON.stringify(extracted.inspector, null, 2)
        );
        logger.info("Written inspector.json for PDF generation", { jobId });
      }

      logger.info("Using extracted_data.json for PDF generation", { jobId });
    } else {
      // Fresh job - download individual pipeline files directly
      logger.info("Downloading individual pipeline files for PDF generation", { jobId });

      // Download and write installation_details.json
      try {
        const installationJson = await storage.downloadText(`${s3Prefix}installation_details.json`);
        if (installationJson) {
          await fs.writeFile(path.join(outputDir, "installation_details.json"), installationJson);
        }
      } catch (e) {
        logger.warn("No installation_details.json found", { jobId });
        // Write minimal installation_details.json
        await fs.writeFile(
          path.join(outputDir, "installation_details.json"),
          JSON.stringify({ address: jobId, client_name: "", postcode: "" }, null, 2)
        );
      }

      // Download and write board_details.json
      try {
        const boardJson = await storage.downloadText(`${s3Prefix}board_details.json`);
        if (boardJson) {
          await fs.writeFile(path.join(outputDir, "board_details.json"), boardJson);
        }
      } catch (e) {
        logger.warn("No board_details.json found", { jobId });
        await fs.writeFile(
          path.join(outputDir, "board_details.json"),
          JSON.stringify({}, null, 2)
        );
      }

      // Download and write observations.json
      try {
        const observationsJson = await storage.downloadText(`${s3Prefix}observations.json`);
        if (observationsJson) {
          await fs.writeFile(path.join(outputDir, "observations.json"), observationsJson);
        }
      } catch (e) {
        logger.warn("No observations.json found", { jobId });
        await fs.writeFile(
          path.join(outputDir, "observations.json"),
          JSON.stringify([], null, 2)
        );
      }

      // Download and merge supply_characteristics into board_details for PDF generator
      try {
        const supplyJson = await storage.downloadText(`${s3Prefix}supply_characteristics.json`);
        if (supplyJson) {
          const supply = JSON.parse(supplyJson);
          // Read existing board_details and merge supply characteristics
          const boardPath = path.join(outputDir, "board_details.json");
          let board = {};
          try {
            const existingBoard = await fs.readFile(boardPath, "utf8");
            board = JSON.parse(existingBoard);
          } catch (e) {}

          // Merge supply characteristics into board for PDF generator compatibility
          const mergedBoard = {
            ...board,
            ze: supply.earth_loop_impedance_ze || board.ze || "",
            ipf_at_db: supply.prospective_fault_current || board.ipf_at_db || "",
            earthing_arrangement: supply.earthing_arrangement || board.earthing_arrangement || "",
            voltage_rating: supply.nominal_voltage_u || board.voltage_rating || "",
          };
          await fs.writeFile(boardPath, JSON.stringify(mergedBoard, null, 2));
          logger.info("Merged supply_characteristics into board_details for PDF", { jobId });
        }
      } catch (e) {
        logger.debug("No supply_characteristics.json found for PDF merge", { jobId });
      }
    }

    // Spawn Python PDF generator
    const pythonScript = path.resolve(import.meta.dirname, "..", "python", "generate_full_pdf.py");

    const pdfPath = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("PDF generation timed out after 30 seconds"));
      }, 30000);

      const proc = spawn("python3", [pythonScript, outputDir], {
        cwd: path.resolve(import.meta.dirname, ".."),
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          // Extract PDF path from stdout (format: "Generated: /path/to/file.pdf")
          const match = stdout.match(/Generated:\s*(.+\.pdf)/);
          if (match) {
            resolve(match[1].trim());
          } else {
            resolve(path.join(outputDir, "eicr_certificate.pdf"));
          }
        } else {
          reject(new Error(`PDF generation failed: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Read generated PDF
    const pdfBuffer = await fs.readFile(pdfPath);

    logger.info("PDF generated successfully", { userId, jobId, size: pdfBuffer.length });

    // Send PDF response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="EICR_${jobId}.pdf"`);
    res.send(pdfBuffer);

  } catch (error) {
    logger.error("PDF generation failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "PDF generation failed: " + error.message });
  } finally {
    // Clean up temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

// ============= Job Clone / Template =============

/**
 * Clone a job as a template for a new address
 * POST /api/job/:userId/:jobId/clone
 * Body: { newAddress: string, clearTestResults?: boolean }
 */
app.post("/api/job/:userId/:jobId/clone", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const { newAddress, clearTestResults } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!newAddress || !newAddress.trim()) {
    return res.status(400).json({ error: "New address is required" });
  }

  const trimmedAddress = newAddress.trim();
  if (trimmedAddress.includes("..") || trimmedAddress.includes("/") || trimmedAddress.includes("\\")) {
    return res.status(400).json({ error: "Address contains invalid characters" });
  }

  try {
    // Load source job from DB
    let sourceJob = await db.getJob(jobId);
    if (!sourceJob) {
      sourceJob = await db.getJobByAddress(userId, jobId);
    }
    if (!sourceJob) {
      return res.status(404).json({ error: "Source job not found" });
    }

    // Verify ownership of source job
    if (sourceJob.user_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Determine source S3 folder
    const sourceFolderName = sourceJob.address || jobId;
    const sourcePrefix = `jobs/${userId}/${sourceFolderName}/output/`;

    // Load extracted_data.json from source
    let extractedData = {};
    const combinedJson = await storage.downloadText(`${sourcePrefix}extracted_data.json`).catch(() => null);
    if (combinedJson) {
      extractedData = JSON.parse(combinedJson);
    } else {
      // Fall back to individual pipeline files
      const [installationJson, boardJson, observationsJson, supplyJson] = await Promise.all([
        storage.downloadText(`${sourcePrefix}installation_details.json`).catch(() => null),
        storage.downloadText(`${sourcePrefix}board_details.json`).catch(() => null),
        storage.downloadText(`${sourcePrefix}observations.json`).catch(() => null),
        storage.downloadText(`${sourcePrefix}supply_characteristics.json`).catch(() => null),
      ]);

      const rawInstallation = installationJson ? JSON.parse(installationJson) : null;
      const rawBoard = boardJson ? JSON.parse(boardJson) : null;
      const rawSupply = supplyJson ? JSON.parse(supplyJson) : null;

      const transformed = transformExtractedData(rawInstallation, rawBoard);
      extractedData.installation_details = transformed.installation_details;
      extractedData.supply_characteristics = rawSupply || transformed.supply_characteristics;
      extractedData.board_info = transformed.board_info;

      if (observationsJson) {
        extractedData.observations = transformObservations(JSON.parse(observationsJson));
      }
    }

    // Load circuits CSV from source
    let circuits = [];
    try {
      const csvContent = await storage.downloadText(`${sourcePrefix}test_results.csv`);
      if (csvContent) {
        circuits = parseCSV(csvContent);
      }
    } catch (e) {
      logger.warn("No circuits CSV found for clone source", { jobId });
    }

    // Deep clone the data
    const clonedData = JSON.parse(JSON.stringify(extractedData));

    // Update address in installation_details
    if (clonedData.installation_details) {
      clonedData.installation_details.address = newAddress.trim();
      clonedData.installation_details.client_name = "";
    }
    clonedData.address = newAddress.trim();
    clonedData.client_name = "";

    // Clear observations (property-specific)
    clonedData.observations = [];

    // Clear inspection schedule outcomes (property-specific)
    if (clonedData.inspection_schedule) {
      clonedData.inspection_schedule = { items: {} };
    }

    // Optionally clear test-specific fields in circuits
    const testFieldsToClear = [
      "r1_r2_ohm", "r2_ohm", "ir_live_live_mohm", "ir_live_earth_mohm",
      "measured_zs_ohm", "rcd_time_ms", "ring_r1_ohm", "ring_rn_ohm", "ring_r2_ohm",
    ];

    let clonedCircuits = JSON.parse(JSON.stringify(circuits));
    if (clearTestResults) {
      clonedCircuits = clonedCircuits.map(circuit => {
        const cleaned = { ...circuit };
        for (const field of testFieldsToClear) {
          cleaned[field] = "";
        }
        return cleaned;
      });
    }

    // Generate new job ID
    const newJobId = `job_${Date.now()}`;

    // Create new job in database
    await db.createJob({
      id: newJobId,
      user_id: userId,
      folder_name: newAddress.trim(),
      address: newAddress.trim(),
      certificate_type: sourceJob.certificate_type || "EICR",
      status: "done",
    });

    // Save cloned data to new S3 prefix
    const newPrefix = `jobs/${userId}/${newAddress.trim()}/output/`;

    await storage.uploadText(
      JSON.stringify(clonedData, null, 2),
      `${newPrefix}extracted_data.json`
    );

    // Save circuits CSV if present
    if (clonedCircuits.length > 0) {
      const csvContent = circuitsToCSV(clonedCircuits);
      await storage.uploadText(csvContent, `${newPrefix}test_results.csv`);
    }

    // Log the action
    await db.logAction(userId, "job_cloned", {
      sourceJobId: jobId,
      sourceAddress: sourceFolderName,
      newJobId,
      newAddress: newAddress.trim(),
      clearTestResults: !!clearTestResults,
    });

    logger.info("Job cloned successfully", {
      userId,
      sourceJobId: jobId,
      newJobId,
      newAddress: newAddress.trim(),
      clearTestResults: !!clearTestResults,
      circuitCount: clonedCircuits.length,
    });

    res.json({
      success: true,
      jobId: newJobId,
      address: newAddress.trim(),
    });
  } catch (error) {
    logger.error("Failed to clone job", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to clone job: " + error.message });
  }
});

// ============= Email Endpoints =============

/**
 * Send certificate via email
 * POST /api/job/:userId/:jobId/email
 * Body: { to: string, clientName?: string }
 */
app.post("/api/job/:userId/:jobId/email", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const { to, clientName } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!to) {
    return res.status(400).json({ error: "Recipient email required" });
  }

  // Validate email format and prevent header injection
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(to) || /[\r\n]/.test(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    // Look up job to get address
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const address = job.address || jobId;
    const certificateType = job.certificate_type || "EICR";

    // Download PDF from S3
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
app.get("/api/email/status", auth.requireAuth, async (req, res) => {
  const configured = isEmailConfigured();
  let verified = false;
  if (configured) {
    verified = await verifyEmailConfig();
  }
  res.json({ configured, verified });
});

// ============= WhatsApp Endpoints =============

/**
 * Send certificate via WhatsApp
 * POST /api/job/:userId/:jobId/whatsapp
 * Body: { phoneNumber: string }
 */
app.post("/api/job/:userId/:jobId/whatsapp", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;
  const { phoneNumber } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  // Lazy-import to avoid requiring the module when WhatsApp is not configured
  const { isConfigured, validateUKPhone, sendCertificateViaWhatsApp } = await import("./whatsapp.js");

  if (!isConfigured()) {
    return res.status(503).json({ error: "WhatsApp not configured" });
  }

  // Validate phone number
  const phoneCheck = validateUKPhone(phoneNumber);
  if (!phoneCheck.valid) {
    return res.status(400).json({ error: phoneCheck.error });
  }

  try {
    // Look up job to get address
    let job = await db.getJob(jobId);
    if (!job) {
      job = await db.getJobByAddress(userId, jobId);
    }
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const address = job.address || jobId;
    const certificateType = job.certificate_type || "EICR";

    // Generate presigned URL for the PDF so WhatsApp can fetch it
    const pdfKey = `jobs/${userId}/${address}/output/eicr_certificate.pdf`;
    const mediaUrl = await storage.getFileUrl(pdfKey, 3600); // 1 hour expiry
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
app.get("/api/whatsapp/status", auth.requireAuth, async (req, res) => {
  const { isConfigured } = await import("./whatsapp.js");
  res.json({ configured: isConfigured() });
});

// ============= Bulk PDF Export =============

/**
 * Bulk download PDFs as a ZIP archive
 * POST /api/jobs/:userId/bulk-download
 * Body: { jobIds: string[] }
 * Max 50 jobs per request
 */
app.post("/api/jobs/:userId/bulk-download", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { jobIds } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: "jobIds must be a non-empty array" });
  }

  if (jobIds.length > 50) {
    return res.status(400).json({ error: "Maximum 50 jobs per bulk download" });
  }

  logger.info("Bulk download requested", { userId, jobCount: jobIds.length });

  try {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="certificates_${new Date().toISOString().split("T")[0]}.zip"`);

    const count = await createJobsZip(userId, jobIds, res);

    if (count === 0) {
      // If no PDFs were found, the archive is empty but still valid
      logger.warn("Bulk download: no PDFs found for any requested jobs", { userId, jobIds });
    }

    logger.info("Bulk download complete", { userId, pdfCount: count, requestedCount: jobIds.length });
  } catch (error) {
    logger.error("Bulk download failed", { userId, error: error.message });
    // Only send error JSON if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: "Bulk download failed: " + error.message });
    }
  }
});

// ============= CSV / Excel Export =============

/**
 * Helper: load full job data from S3 (reuses GET endpoint logic).
 * Returns { circuits, observations, board_info, installation_details, supply_characteristics }
 */
async function loadJobData(userId, jobId) {
  let job = await db.getJob(jobId);
  if (!job) {
    job = await db.getJobByAddress(userId, jobId);
  }

  const folderName = job?.address || jobId;
  const s3Prefix = `jobs/${userId}/${folderName}/output/`;

  let circuits = [];
  try {
    const csvContent = await storage.downloadText(`${s3Prefix}test_results.csv`);
    if (csvContent) {
      circuits = parseCSV(csvContent);
    }
  } catch (e) {
    logger.warn("No circuits CSV found for export", { jobId });
  }

  let extractedData = {};

  const combinedJsonContent = await storage.downloadText(`${s3Prefix}extracted_data.json`).catch(() => null);

  if (combinedJsonContent) {
    extractedData = JSON.parse(combinedJsonContent);
  } else {
    try {
      const [installationJson, boardJson, observationsJson, supplyJson] = await Promise.all([
        storage.downloadText(`${s3Prefix}installation_details.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}board_details.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}observations.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}supply_characteristics.json`).catch(() => null),
      ]);

      const rawInstallation = installationJson ? JSON.parse(installationJson) : null;
      const rawBoard = boardJson ? JSON.parse(boardJson) : null;
      const rawSupply = supplyJson ? JSON.parse(supplyJson) : null;

      const transformed = transformExtractedData(rawInstallation, rawBoard);
      extractedData.installation_details = transformed.installation_details;
      extractedData.supply_characteristics = rawSupply || transformed.supply_characteristics;
      extractedData.board_info = transformed.board_info;

      if (observationsJson) {
        extractedData.observations = transformObservations(JSON.parse(observationsJson));
      }
    } catch (innerError) {
      logger.warn("Failed to load extracted data files for export", { jobId, error: innerError.message });
    }
  }

  if (!job && circuits.length === 0 && Object.keys(extractedData).length === 0) {
    return null;
  }

  return {
    address: job?.address || extractedData.address || jobId,
    circuits,
    observations: extractedData.observations || [],
    board_info: extractedData.board_info || {},
    installation_details: extractedData.installation_details || {},
    supply_characteristics: extractedData.supply_characteristics || {},
  };
}

/**
 * GET /api/job/:userId/:jobId/export/csv
 * Download circuits as CSV file
 */
app.get("/api/job/:userId/:jobId/export/csv", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const jobData = await loadJobData(userId, jobId);
    if (!jobData) {
      return res.status(404).json({ error: "Job not found" });
    }

    const csv = circuitsToCSV(jobData.circuits);
    const safeName = jobData.address.replace(/[^a-zA-Z0-9]/g, "_");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="circuits_${safeName}.csv"`);
    res.send(csv);

    logger.info("CSV export complete", { userId, jobId, circuitCount: jobData.circuits.length });
  } catch (error) {
    logger.error("CSV export failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "CSV export failed: " + error.message });
  }
});

/**
 * GET /api/job/:userId/:jobId/export/excel
 * Download full job data as Excel workbook
 */
app.get("/api/job/:userId/:jobId/export/excel", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const jobData = await loadJobData(userId, jobId);
    if (!jobData) {
      return res.status(404).json({ error: "Job not found" });
    }

    const buffer = jobToExcel(jobData);
    const safeName = jobData.address.replace(/[^a-zA-Z0-9]/g, "_");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="EICR_${safeName}.xlsx"`);
    res.send(Buffer.from(buffer));

    logger.info("Excel export complete", { userId, jobId, circuitCount: jobData.circuits.length });
  } catch (error) {
    logger.error("Excel export failed", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Excel export failed: " + error.message });
  }
});

// ============= CRM: Clients & Properties =============

/**
 * List all clients for a user
 * GET /api/clients/:userId
 */
app.get("/api/clients/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const clients = await getClients(userId);
    res.json(clients);
  } catch (error) {
    logger.error("Failed to list clients", { userId, error: error.message });
    res.status(500).json({ error: "Failed to list clients" });
  }
});

/**
 * Create a client
 * POST /api/clients/:userId
 */
app.post("/api/clients/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { name, email, phone, company, notes } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Client name is required" });
  }

  try {
    const client = await createClient({
      user_id: userId,
      name: name.trim(),
      email: email || null,
      phone: phone || null,
      company: company || null,
      notes: notes || null,
    });
    logger.info("Client created", { userId, clientId: client.id });
    res.json(client);
  } catch (error) {
    logger.error("Failed to create client", { userId, error: error.message });
    res.status(500).json({ error: "Failed to create client" });
  }
});

/**
 * Update a client
 * PUT /api/clients/:userId/:clientId
 */
app.put("/api/clients/:userId/:clientId", auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Verify ownership
    const existing = await getClient(clientId);
    if (!existing || existing.user_id !== userId) {
      return res.status(404).json({ error: "Client not found" });
    }

    await updateClient(clientId, req.body);
    logger.info("Client updated", { userId, clientId });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to update client", { userId, clientId, error: error.message });
    res.status(500).json({ error: "Failed to update client" });
  }
});

/**
 * Delete a client
 * DELETE /api/clients/:userId/:clientId
 */
app.delete("/api/clients/:userId/:clientId", auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    await deleteClient(clientId, userId);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete client", { userId, clientId, error: error.message });
    res.status(500).json({ error: "Failed to delete client" });
  }
});

/**
 * Get a single client with properties
 * GET /api/clients/:userId/:clientId
 */
app.get("/api/clients/:userId/:clientId", auth.requireAuth, async (req, res) => {
  const { userId, clientId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const client = await getClient(clientId);
    if (!client || client.user_id !== userId) {
      return res.status(404).json({ error: "Client not found" });
    }

    const properties = await getPropertiesByClient(clientId);

    // Get job history for each property (by address match)
    const propertiesWithHistory = await Promise.all(
      properties.map(async (prop) => {
        const jobs = await db.getJobsByUser(userId);
        const propertyJobs = jobs.filter(j => j.address === prop.address);
        return { ...prop, jobs: propertyJobs };
      })
    );

    res.json({ ...client, properties: propertiesWithHistory });
  } catch (error) {
    logger.error("Failed to get client", { userId, clientId, error: error.message });
    res.status(500).json({ error: "Failed to get client" });
  }
});

/**
 * List all properties for a user
 * GET /api/properties/:userId
 */
app.get("/api/properties/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const properties = await getProperties(userId);
    res.json(properties);
  } catch (error) {
    logger.error("Failed to list properties", { userId, error: error.message });
    res.status(500).json({ error: "Failed to list properties" });
  }
});

/**
 * Create a property
 * POST /api/properties/:userId
 */
app.post("/api/properties/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { address, postcode, property_type, client_id, notes } = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!address || !address.trim()) {
    return res.status(400).json({ error: "Property address is required" });
  }

  try {
    const property = await createProperty({
      user_id: userId,
      client_id: client_id || null,
      address: address.trim(),
      postcode: postcode || null,
      property_type: property_type || null,
      notes: notes || null,
    });
    logger.info("Property created", { userId, propertyId: property.id });
    res.json(property);
  } catch (error) {
    logger.error("Failed to create property", { userId, error: error.message });
    res.status(500).json({ error: "Failed to create property" });
  }
});

/**
 * Get job history for a property (by address match)
 * GET /api/properties/:userId/:propertyId/history
 */
app.get("/api/properties/:userId/:propertyId/history", auth.requireAuth, async (req, res) => {
  const { userId, propertyId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    // Get the property to find its address
    const allProperties = await getProperties(userId);
    const property = allProperties.find(p => p.id === propertyId);

    if (!property) {
      return res.status(404).json({ error: "Property not found" });
    }

    // Find all jobs matching this property address
    const allJobs = await db.getJobsByUser(userId);
    const propertyJobs = allJobs
      .filter(j => j.address === property.address)
      .map(j => ({
        id: j.id,
        address: j.address,
        status: j.status,
        certificate_type: j.certificate_type,
        created_at: j.created_at,
        completed_at: j.completed_at,
      }));

    res.json(propertyJobs);
  } catch (error) {
    logger.error("Failed to get property history", { userId, propertyId, error: error.message });
    res.status(500).json({ error: "Failed to get property history" });
  }
});

// ============= OCR Certificate Extraction =============

/**
 * Create a new job from OCR-extracted data (no audio/photo processing needed)
 * POST /api/ocr/create-job
 * Body: { data: OcrExtractedData, certificateType: "EICR"|"EIC" }
 */
app.post("/api/ocr/create-job", auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { data, certificateType } = req.body;

  if (!data) {
    return res.status(400).json({ error: "No extracted data provided" });
  }

  const jobId = `job_${Date.now()}`;
  const address = data.installation_details?.address || `Imported ${new Date().toLocaleDateString("en-GB")}`;

  logger.info("Creating job from OCR data", { userId, jobId, address });

  try {
    // Use address as the S3 folder name (consistent with how processed jobs work)
    const folderName = address;
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    // Save extracted_data.json
    const extractedData = {
      installation_details: data.installation_details || {},
      supply_characteristics: data.supply_characteristics || {},
      board_info: data.board_info || {},
      observations: data.observations || [],
    };
    await storage.uploadText(JSON.stringify(extractedData, null, 2), `${s3Prefix}extracted_data.json`);

    // Save circuits as CSV
    if (data.circuits && Array.isArray(data.circuits) && data.circuits.length > 0) {
      const csvContent = circuitsToCSV(data.circuits);
      await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
    }

    // Create job record in database
    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: folderName,
      certificate_type: certificateType || "EICR",
      status: "done",
      address,
      client_name: data.installation_details?.client_name || "",
      s3_prefix: s3Prefix,
    });

    logger.info("Job created from OCR data", {
      userId,
      jobId,
      address,
      circuits: data.circuits?.length || 0,
      observations: data.observations?.length || 0,
    });

    res.json({
      success: true,
      jobId,
      address,
    });
  } catch (error) {
    logger.error("Failed to create job from OCR data", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to create job: " + error.message });
  }
});

/**
 * Extract data from an existing EICR/EIC certificate via OCR
 * POST /api/ocr/certificate
 * Body: multipart/form-data with a single file field "file"
 * Returns: extracted certificate data in CertMate format
 */
app.post("/api/ocr/certificate", auth.requireAuth, upload.single("file"), async (req, res) => {
  const userId = req.user?.id;

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Please provide a PDF or image file." });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname || "unknown";
  const ext = path.extname(originalName).toLowerCase();

  // Validate file type
  const allowedExts = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
  if (!allowedExts.has(ext)) {
    // Clean up temp file
    await fs.unlink(filePath).catch(() => {});
    return res.status(400).json({
      error: `Unsupported file type: ${ext}. Accepted: .pdf, .jpg, .jpeg, .png`,
    });
  }

  logger.info("OCR certificate extraction requested", {
    userId,
    originalName,
    ext,
    size: req.file.size,
  });

  try {
    const result = await extractFromCertificate(filePath);

    logger.info("OCR certificate extraction successful", {
      userId,
      originalName,
      circuits: result.data.circuits.length,
      observations: result.data.observations.length,
      tokens: result.usage?.total_tokens || 0,
    });

    res.json({
      success: true,
      data: result.data,
      meta: {
        model: result.model,
        tokens: result.usage?.total_tokens || 0,
        source_file: originalName,
      },
    });
  } catch (error) {
    logger.error("OCR certificate extraction failed", {
      userId,
      originalName,
      error: error.message,
    });

    res.status(500).json({
      error: `OCR extraction failed: ${error.message}`,
    });
  } finally {
    // Always clean up the temp file
    await fs.unlink(filePath).catch(() => {});
  }
});

// ============= Google Calendar / Scheduling =============

/**
 * GET /api/calendar/auth-url
 * Returns the Google OAuth consent URL the frontend should redirect the user to.
 */
app.get("/api/calendar/auth-url", auth.requireAuth, (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "https://certomatic3000.co.uk";
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
 * Exchange the authorization code for tokens and store them.
 * Body: { code: string }
 */
app.post("/api/calendar/callback", auth.requireAuth, async (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "https://certomatic3000.co.uk";
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
 * Check whether the current user has a calendar connected.
 */
app.get("/api/calendar/status", auth.requireAuth, async (req, res) => {
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
 * Fetch upcoming inspection-related events from the user's Google Calendar.
 */
app.get("/api/calendar/events", auth.requireAuth, async (req, res) => {
  if (!calendar.isConfigured()) {
    return res.status(503).json({ error: "Google Calendar integration is not configured" });
  }

  try {
    let tokens = await getCalendarTokens(req.user.id);
    if (!tokens) {
      return res.status(400).json({ error: "Calendar not connected. Please connect your Google Calendar first." });
    }

    try {
      // Try to refresh tokens if needed
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

    // If token is invalid / revoked, clean up
    if (error.message?.includes("invalid_grant") || error.code === 401) {
      await deleteCalendarTokens(req.user.id);
      return res.status(401).json({ error: "Calendar access revoked. Please reconnect your Google Calendar." });
    }

    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
});

/**
 * POST /api/calendar/create-job-from-event
 * Create a new job pre-filled with the event's address / location.
 * Body: { summary, location, start, description }
 */
app.post("/api/calendar/create-job-from-event", auth.requireAuth, async (req, res) => {
  const { summary, location, start, description } = req.body;
  const userId = req.user.id;

  if (!location) {
    return res.status(400).json({ error: "Event has no location / address" });
  }

  try {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const address = location.trim();
    const certType = "EICR";

    // Create job record in database
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

    // Build minimal extracted_data with the pre-filled details
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

    // Save the extracted_data.json to S3 so the job editor can load it
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
 * Remove stored tokens, effectively disconnecting the user's Google Calendar.
 */
app.delete("/api/calendar/disconnect", auth.requireAuth, async (req, res) => {
  try {
    await deleteCalendarTokens(req.user.id);
    logger.info("Calendar disconnected", { userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to disconnect calendar", { userId: req.user?.id, error: error.message });
    res.status(500).json({ error: "Failed to disconnect calendar" });
  }
});

// ============= Analytics =============

app.get("/api/analytics/:userId", auth.requireAuth, async (req, res) => {
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

// ════════════════════════════════════════════════════════════════════════════
// WebSocket Server — Deepgram Nova 2 + Gemini 2.5 Pro hybrid recording
// Path: wss://.../api/recording/stream
// (Exported for server.js to mount on the HTTP upgrade handler)
// ════════════════════════════════════════════════════════════════════════════

const wss = new WebSocketServer({ noServer: true });

// Track active WebSocket recording sessions
const wsRecordingSessions = new Map();

// Deepgram connection config
const DEEPGRAM_CONFIG = {
  model: "nova-2",
  language: "en-GB",
  smart_format: true,
  punctuate: true,
  diarize: false,
  encoding: "linear16",
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  utterance_end_ms: 1500,
  keywords: ["Ze:2", "Zs:2", "R1:2", "R2:2", "Rn:2", "PFC:2", "MCB:2", "RCBO:2", "RCD:2", "AFDD:2", "TN-C-S:2", "TN-S:2"],
};

wss.on("connection", (ws, request) => {
  let sessionState = null;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      switch (msg.type) {
        case "start":
          sessionState = await handleStreamStart(ws, msg, request);
          break;
        case "audio":
          if (sessionState) handleStreamAudio(sessionState, msg);
          break;
        case "context_update":
          if (sessionState) sessionState.context = msg.context || "";
          break;
        case "stop":
          if (sessionState) await handleStreamStop(ws, sessionState);
          sessionState = null;
          break;
        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      logger.error("WebSocket message handler error", { error: err.message, type: msg.type });
      ws.send(JSON.stringify({ type: "error", message: err.message }));
    }
  });

  ws.on("close", () => {
    if (sessionState) {
      logger.info("WebSocket closed, cleaning up session", { sessionId: sessionState.sessionId });
      cleanupStreamSession(sessionState);
    }
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error", { error: err.message });
  });
});

async function handleStreamStart(ws, msg, request) {
  // Authenticate via Authorization header
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }));
    ws.close();
    return null;
  }
  const token = authHeader.slice(7);
  let userId;
  try {
    const decoded = auth.verifyToken(token);
    userId = decoded.userId || decoded.id || decoded.sub;
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
    ws.close();
    return null;
  }

  const sessionId = msg.sessionId || `stream_${Date.now()}`;
  const jobId = msg.jobId || null;
  const context = msg.context || "";

  // Get Deepgram API key
  const deepgramApiKey = await getDeepgramKey();
  if (!deepgramApiKey) {
    ws.send(JSON.stringify({ type: "error", message: "Deepgram API key not configured" }));
    ws.close();
    return null;
  }

  // Build Deepgram WebSocket URL
  const dgParams = new URLSearchParams();
  for (const [k, v] of Object.entries(DEEPGRAM_CONFIG)) {
    if (k === "keywords") {
      for (const kw of v) dgParams.append("keywords", kw);
    } else {
      dgParams.set(k, String(v));
    }
  }
  const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;

  // Open Deepgram WebSocket
  const { default: WebSocket } = await import("ws");
  const deepgramWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${deepgramApiKey}` },
  });

  const state = {
    sessionId,
    jobId,
    userId,
    ws,
    deepgramWs,
    context,
    transcriptBuffer: "",
    lastExtractionOffset: 0,
    lastExtractionTime: Date.now(),
    pendingGeminiExtraction: false,
    extractionTimer: null,
    startTime: Date.now(),
    chunkCount: 0,
  };

  deepgramWs.on("open", () => {
    logger.info("Deepgram WebSocket connected", { sessionId });
    ws.send(JSON.stringify({ type: "ready" }));
  });

  deepgramWs.on("message", (dgData) => {
    try {
      const dgMsg = JSON.parse(dgData.toString());
      handleDeepgramMessage(state, dgMsg);
    } catch (err) {
      logger.error("Deepgram message parse error", { error: err.message });
    }
  });

  deepgramWs.on("close", () => {
    logger.info("Deepgram WebSocket closed", { sessionId });
  });

  deepgramWs.on("error", (err) => {
    logger.error("Deepgram WebSocket error", { sessionId, error: err.message });
    ws.send(JSON.stringify({ type: "error", message: `Deepgram error: ${err.message}` }));
  });

  // Periodic extraction timer — check every 5 seconds
  state.extractionTimer = setInterval(() => {
    maybeRunExtraction(state);
  }, 5000);

  wsRecordingSessions.set(sessionId, state);
  logger.info("Stream recording started", { sessionId, userId, jobId });
  return state;
}

function handleDeepgramMessage(state, dgMsg) {
  // Handle transcript results
  if (dgMsg.type === "Results" && dgMsg.channel?.alternatives?.[0]) {
    const alt = dgMsg.channel.alternatives[0];
    const transcript = alt.transcript || "";
    const isFinal = dgMsg.is_final === true;

    if (!transcript) return;

    if (isFinal) {
      // Append final transcript to buffer
      state.transcriptBuffer += (state.transcriptBuffer ? " " : "") + transcript;

      // Send final transcript to iOS
      state.ws.send(JSON.stringify({
        type: "transcript",
        text: transcript,
        isFinal: true,
      }));

      // Check if extraction should run
      maybeRunExtraction(state);
    } else {
      // Send partial transcript to iOS (for live display)
      state.ws.send(JSON.stringify({
        type: "transcript_partial",
        text: transcript,
      }));
    }
  }

  // Handle utterance end
  if (dgMsg.type === "UtteranceEnd") {
    const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;
    if (newChars > 100) {
      maybeRunExtraction(state, true);
    }
  }
}

function handleStreamAudio(state, msg) {
  if (!msg.data) return;
  // Decode base64 PCM and forward to Deepgram
  const pcmBuffer = Buffer.from(msg.data, "base64");
  if (state.deepgramWs?.readyState === 1) { // WebSocket.OPEN
    state.deepgramWs.send(pcmBuffer);
    state.chunkCount++;
  }
}

async function maybeRunExtraction(state, force = false) {
  if (state.pendingGeminiExtraction) return;

  const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;
  const timeSinceLastMs = Date.now() - state.lastExtractionTime;

  // Trigger conditions
  const shouldExtract = force ||
    (timeSinceLastMs >= 15000 && newChars >= 200) ||
    (timeSinceLastMs >= 10000 && newChars >= 400);

  if (!shouldExtract || newChars < 50) return;

  state.pendingGeminiExtraction = true;
  const extractionStart = Date.now();

  try {
    // Rolling context window: last 5000 chars
    const windowSize = 5000;
    const transcriptWindow = state.transcriptBuffer.length > windowSize
      ? state.transcriptBuffer.slice(-windowSize)
      : state.transcriptBuffer;

    logger.info("Running Gemini text extraction", {
      sessionId: state.sessionId,
      transcriptLen: state.transcriptBuffer.length,
      windowLen: transcriptWindow.length,
      newChars,
    });

    const result = await geminiExtractFromText(transcriptWindow, state.context);

    state.lastExtractionOffset = state.transcriptBuffer.length;
    state.lastExtractionTime = Date.now();

    // Send extraction result to iOS
    state.ws.send(JSON.stringify({
      type: "extraction",
      data: {
        circuits: result.circuits,
        supply: result.supply,
        installation: result.installation,
        board: result.board,
        orphaned_values: result.orphaned_values,
        usage: result.usage,
      },
    }));

    logger.info("Gemini text extraction complete", {
      sessionId: state.sessionId,
      latencyMs: Date.now() - extractionStart,
      circuits: result.circuits?.length ?? 0,
    });
  } catch (err) {
    logger.error("Gemini text extraction error", {
      sessionId: state.sessionId,
      error: err.message,
    });
    state.ws.send(JSON.stringify({
      type: "error",
      message: `Extraction error: ${err.message}`,
    }));
  } finally {
    state.pendingGeminiExtraction = false;
  }
}

async function handleStreamStop(ws, state) {
  logger.info("Stream recording stopping", {
    sessionId: state.sessionId,
    transcriptLen: state.transcriptBuffer.length,
    duration: Date.now() - state.startTime,
  });

  // Run final extraction if there's unextracted text
  const remainingChars = state.transcriptBuffer.length - state.lastExtractionOffset;
  if (remainingChars > 30) {
    state.pendingGeminiExtraction = false; // Force allow
    await maybeRunExtraction(state, true);
  }

  // Close Deepgram WebSocket
  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
    state.deepgramWs.close();
  }

  cleanupStreamSession(state);
  ws.send(JSON.stringify({ type: "stopped" }));
}

function cleanupStreamSession(state) {
  if (state.extractionTimer) {
    clearInterval(state.extractionTimer);
    state.extractionTimer = null;
  }
  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.close();
  }
  wsRecordingSessions.delete(state.sessionId);
}

// Export the recording WebSocket server for server.js to mount
export { wss };
export default app;
