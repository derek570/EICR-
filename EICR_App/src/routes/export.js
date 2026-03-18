/**
 * Export routes — CSV and Excel download
 */

import { Router } from "express";
import * as auth from "../auth.js";
import { circuitsToCSV, jobToExcel } from "../export.js";
import { loadJobData } from "../utils/jobs.js";
import logger from "../logger.js";

const router = Router();

/**
 * GET /api/job/:userId/:jobId/export/csv
 * Download circuits as CSV file
 */
router.get("/job/:userId/:jobId/export/csv", auth.requireAuth, async (req, res) => {
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
router.get("/job/:userId/:jobId/export/excel", auth.requireAuth, async (req, res) => {
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

export default router;
