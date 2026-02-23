/**
 * Job routes — CRUD, upload, process, debug, history, clone, bulk download
 */

import { Router } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as storage from "../storage.js";
import { processJob } from "../process_job.js";
import { enqueueJob } from "../queue.js";
import { circuitsToCSV } from "../export.js";
import { saveJobVersion, getJobVersions, getJobVersion } from "../db.js";
import { createJobsZip } from "../zip.js";
import {
  resolveJob,
  getJobOutputPrefix,
  parseCSV,
  transformObservations,
  transformExtractedData,
  routeTimeout,
} from "../utils/jobs.js";
import logger from "../logger.js";

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".m4a";
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ============= Job List =============

/**
 * List all jobs for a user
 * GET /api/jobs/:userId
 */
router.get("/jobs/:userId", auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const dbJobs = await db.getJobsByUser(userId);

    let jobs = dbJobs.map(j => {
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

    if (storage.isUsingS3()) {
      const s3Prefix = `jobs/${userId}/`;
      const s3Folders = await storage.listJobFolders(s3Prefix);

      const dbIdentifiers = new Set(
        dbJobs.flatMap(j => [j.id, j.address, j.folder_name].filter(Boolean))
      );
      for (const folder of s3Folders) {
        if (!dbIdentifiers.has(folder.name)) {
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

// ============= Job Create =============

/**
 * Create a blank job
 * POST /api/jobs/:userId
 */
router.post("/jobs/:userId", auth.requireAuth, async (req, res) => {
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

// ============= Upload & Process =============

/**
 * Upload files and start processing
 * POST /api/upload
 */
router.post("/upload", auth.requireAuth, upload.array("files", 20), async (req, res) => {
  const userId = req.user.id;
  const files = req.files;
  const certificateType = req.body.certificateType || "EICR";

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const jobId = `job_${Date.now()}`;
  logger.info("Upload received", { userId, jobId, fileCount: files.length });

  try {
    const s3Prefix = `jobs/${userId}/${jobId}/input/`;

    for (const file of files) {
      const originalName = file.originalname;
      const s3Key = `${s3Prefix}${originalName}`;

      const content = await fs.readFile(file.path);
      await storage.uploadBytes(content, s3Key);

      await fs.unlink(file.path).catch(() => {});
    }

    logger.info("Files uploaded to storage", { userId, jobId, prefix: s3Prefix });

    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: jobId,
      certificate_type: certificateType,
      status: "processing",
      s3_prefix: s3Prefix,
    });

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
    let jobDir;
    let outDir;
    let tempDir = null;

    if (storage.isUsingS3()) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-job-${jobId}-`));
      jobDir = path.join(tempDir, "input");
      outDir = path.join(tempDir, "output");

      await fs.mkdir(jobDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });

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

    const result = await processJob({ jobDir, outDir, dryRun: false, jobId });

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

      await db.updateJobStatus(jobId, userId, "done", result.address);

      if (result.address && result.address !== jobId) {
        const oldPrefix = `jobs/${userId}/${jobId}/`;
        logger.info("Deleting old job folder after rename", { oldPrefix, newAddress: result.address });
        const deleteResult = await storage.deletePrefix(oldPrefix);
        logger.info("Delete prefix result", { oldPrefix, deleted: deleteResult.deleted, errors: deleteResult.errors });
      } else {
        logger.debug("Not deleting old folder", { address: result.address, jobId, reason: result.address === jobId ? "address equals jobId" : "no address" });
      }

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
 */
router.post("/process-job", auth.requireAuth, routeTimeout(120000), async (req, res) => {
  const userId = req.user.id;
  const { jobId, jobFolder } = req.body;

  if (!jobId) {
    return res.status(400).json({
      success: false,
      error: "Missing required field: jobId"
    });
  }

  logger.info("Processing job request", { userId, jobId });

  try {
    let jobDir;
    let outDir;
    let tempDir = null;

    if (storage.isUsingS3()) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-job-${jobId}-`));
      jobDir = path.join(tempDir, "input");
      outDir = path.join(tempDir, "output");

      await fs.mkdir(jobDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });

      const s3Prefix = `jobs/${userId}/${jobId}/input/`;
      const inputFiles = await storage.listFiles(s3Prefix);

      if (inputFiles.length === 0) {
        const altPrefix = `jobs/${userId}/${jobId}/`;
        const altFiles = await storage.listFiles(altPrefix);
        const audioPhotoFiles = altFiles.filter(f =>
          /\.(m4a|mp3|wav|aac|jpg|jpeg|png|heic)$/i.test(f) &&
          !f.includes("/output/")
        );

        if (audioPhotoFiles.length === 0) {
          throw new Error(`No input files found for job ${jobId}`);
        }

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
      if (jobFolder) {
        jobDir = jobFolder;
      } else {
        const projectRoot = path.resolve(import.meta.dirname, "..", "..");
        jobDir = path.join(projectRoot, "data", `INCOMING_${userId}`, jobId);
      }
      outDir = path.join(path.dirname(jobDir).replace("INCOMING", "OUTPUT"), jobId);
    }

    if (!fssync.existsSync(jobDir)) {
      throw new Error(`Job directory not found: ${jobDir}`);
    }

    logger.info("Starting job processing", { jobDir, outDir, jobId });
    const result = await processJob({ jobDir, outDir, dryRun: false, jobId });

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
      logger.info("Uploaded results to S3", { outputPrefix });

      if (result.address && result.address !== jobId) {
        const oldPrefix = `jobs/${userId}/${jobId}/`;
        logger.info("Job renamed, cleaning up old S3 prefix", { oldPrefix, newFolder: folderName });
        const deleteResult = await storage.deletePrefix(oldPrefix);
        logger.info("Old prefix cleanup complete", { deleted: deleteResult.deleted, errors: deleteResult.errors });
      }

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

// ============= Job Details =============

/**
 * Get full job details
 * GET /api/job/:userId/:jobId
 */
router.get("/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    let job = await resolveJob(userId, jobId);

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

    const combinedJsonContent = await storage.downloadText(`${s3Prefix}extracted_data.json`).catch(() => null);

    if (combinedJsonContent) {
      extractedData = JSON.parse(combinedJsonContent);
      logger.info("Loaded extracted_data.json (user-edited)", {
        jobId,
        hasSupply: !!extractedData.supply_characteristics,
        supplyData: extractedData.supply_characteristics,
        hasInstallation: !!extractedData.installation_details,
        installationData: extractedData.installation_details
      });
      if (extractedData.installation_details?.address && !extractedData.address) {
        extractedData.address = extractedData.installation_details.address;
      }
    } else {
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

        const transformed = transformExtractedData(rawInstallation, rawBoard);

        extractedData.installation_details = transformed.installation_details;
        extractedData.supply_characteristics = rawSupply || transformed.supply_characteristics;
        extractedData.board_info = transformed.board_info;

        if (rawInstallation) {
          extractedData.address = rawInstallation.address;
          extractedData.client_name = rawInstallation.client_name;
          extractedData.postcode = rawInstallation.postcode;
        }

        if (observationsJson) {
          extractedData.observations = transformObservations(JSON.parse(observationsJson));
        }

        logger.info("Transformed pipeline data to UI format", { jobId });
      } catch (innerError) {
        logger.warn("Failed to load extracted data files", { jobId, error: innerError.message });
      }
    }

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
 * GET /api/job/:userId/:jobId/debug
 */
router.get("/job/:userId/:jobId/debug", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const job = await resolveJob(userId, jobId);

    const folderName = job?.address || jobId;
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    const debugContent = await storage.downloadText(`${s3Prefix}debug_transcription.json`).catch(() => null);

    if (!debugContent) {
      return res.status(404).json({
        error: "Debug data not found. This job may have been processed before debug logging was enabled, or wasn't recorded through the real-time API."
      });
    }

    const debugData = JSON.parse(debugContent);

    if (debugData.chunks) {
      for (const chunk of debugData.chunks) {
        if (chunk.audioKey) {
          chunk.audioUrl = await storage.getFileUrl(chunk.audioKey, 3600);
        }
      }
    }

    res.json(debugData);
  } catch (error) {
    logger.error("Failed to get debug data", { userId, jobId, error: error.message });
    res.status(500).json({ error: "Failed to get debug data: " + error.message });
  }
});

// ============= Job Update =============

/**
 * Update full job data
 * PUT /api/job/:userId/:jobId
 */
router.put("/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
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
    const job = await resolveJob(userId, jobId);
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

    const dbUpdate = { updated_at: new Date().toISOString() };
    if (installation_details?.address) {
      dbUpdate.address = installation_details.address;
      dbUpdate.folder_name = installation_details.address;
      logger.info("Updating job address from PUT", { jobId, address: installation_details.address });

      if (folderName !== installation_details.address && storage.isUsingS3()) {
        const oldPrefix = `jobs/${userId}/${folderName}/`;
        try {
          const newPrefix = `jobs/${userId}/${installation_details.address}/output/`;
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

// ============= Job Delete =============

/**
 * Delete a job
 * DELETE /api/job/:userId/:jobId
 */
router.delete("/job/:userId/:jobId", auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: "Access denied" });
  }

  logger.info("Delete job requested", { userId, jobId });

  try {
    const job = await resolveJob(userId, jobId);
    const folderName = job?.address || jobId;

    if (storage.isUsingS3()) {
      const s3Prefix = `jobs/${userId}/${folderName}/`;
      logger.info("Deleting job from S3", { s3Prefix, folderName });
      const deleteResult = await storage.deletePrefix(s3Prefix);
      logger.info("S3 delete result", { deleted: deleteResult.deleted, errors: deleteResult.errors });
    }

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
router.get("/job/:userId/:jobId/history", auth.requireAuth, async (req, res) => {
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
router.get("/job/:userId/:jobId/history/:versionId", auth.requireAuth, async (req, res) => {
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

// ============= Job Clone / Template =============

/**
 * Clone a job as a template
 * POST /api/job/:userId/:jobId/clone
 */
router.post("/job/:userId/:jobId/clone", auth.requireAuth, async (req, res) => {
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
    let sourceJob = await db.getJob(jobId);
    if (!sourceJob) {
      sourceJob = await db.getJobByAddress(userId, jobId);
    }
    if (!sourceJob) {
      return res.status(404).json({ error: "Source job not found" });
    }

    if (sourceJob.user_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const sourceFolderName = sourceJob.address || jobId;
    const sourcePrefix = `jobs/${userId}/${sourceFolderName}/output/`;

    let extractedData = {};
    const combinedJson = await storage.downloadText(`${sourcePrefix}extracted_data.json`).catch(() => null);
    if (combinedJson) {
      extractedData = JSON.parse(combinedJson);
    } else {
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

    let circuits = [];
    try {
      const csvContent = await storage.downloadText(`${sourcePrefix}test_results.csv`);
      if (csvContent) {
        circuits = parseCSV(csvContent);
      }
    } catch (e) {
      logger.warn("No circuits CSV found for clone source", { jobId });
    }

    const clonedData = JSON.parse(JSON.stringify(extractedData));

    if (clonedData.installation_details) {
      clonedData.installation_details.address = newAddress.trim();
      clonedData.installation_details.client_name = "";
    }
    clonedData.address = newAddress.trim();
    clonedData.client_name = "";

    clonedData.observations = [];

    if (clonedData.inspection_schedule) {
      clonedData.inspection_schedule = { items: {} };
    }

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

    const newJobId = `job_${Date.now()}`;

    await db.createJob({
      id: newJobId,
      user_id: userId,
      folder_name: newAddress.trim(),
      address: newAddress.trim(),
      certificate_type: sourceJob.certificate_type || "EICR",
      status: "done",
    });

    const newPrefix = `jobs/${userId}/${newAddress.trim()}/output/`;

    await storage.uploadText(
      JSON.stringify(clonedData, null, 2),
      `${newPrefix}extracted_data.json`
    );

    if (clonedCircuits.length > 0) {
      const csvContent = circuitsToCSV(clonedCircuits);
      await storage.uploadText(csvContent, `${newPrefix}test_results.csv`);
    }

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

// ============= Bulk PDF Download =============

/**
 * Bulk download PDFs as a ZIP archive
 * POST /api/jobs/:userId/bulk-download
 */
router.post("/jobs/:userId/bulk-download", auth.requireAuth, async (req, res) => {
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
      logger.warn("Bulk download: no PDFs found for any requested jobs", { userId, jobIds });
    }

    logger.info("Bulk download complete", { userId, pdfCount: count, requestedCount: jobIds.length });
  } catch (error) {
    logger.error("Bulk download failed", { userId, error: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Bulk download failed: " + error.message });
    }
  }
});

// ============= Queue Endpoints =============

router.get("/queue/status/:jobId", auth.requireAuth, async (req, res) => {
  const { getQueueStatus } = await import("../queue.js");
  const { jobId } = req.params;
  try {
    const status = await getQueueStatus(jobId);
    res.json(status);
  } catch (error) {
    logger.error("Failed to get queue status", { jobId, error: error.message });
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

router.get("/queue/health", auth.requireAuth, async (req, res) => {
  const { getQueueHealth } = await import("../queue.js");
  try {
    const health = await getQueueHealth();
    res.json(health);
  } catch (error) {
    logger.error("Failed to get queue health", { error: error.message });
    res.status(500).json({ error: "Failed to get queue health" });
  }
});

export default router;
