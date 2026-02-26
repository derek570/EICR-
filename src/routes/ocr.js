/**
 * OCR routes — certificate extraction and job creation from OCR data
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as auth from '../auth.js';
import * as db from '../db.js';
import * as storage from '../storage.js';
import { circuitsToCSV } from '../export.js';
import { extractFromCertificate } from '../ocr_certificate.js';
import logger from '../logger.js';
import { sanitizeS3Path } from '../utils/sanitize.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/**
 * Create a new job from OCR-extracted data
 * POST /api/ocr/create-job
 */
router.post('/ocr/create-job', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { data, certificateType } = req.body;

  if (!data) {
    return res.status(400).json({ error: 'No extracted data provided' });
  }

  const jobId = `job_${Date.now()}`;
  const address =
    data.installation_details?.address || `Imported ${new Date().toLocaleDateString('en-GB')}`;

  logger.info('Creating job from OCR data', { userId, jobId, address });

  try {
    const folderName = sanitizeS3Path(address);
    const s3Prefix = `jobs/${userId}/${folderName}/output/`;

    const extractedData = {
      installation_details: data.installation_details || {},
      supply_characteristics: data.supply_characteristics || {},
      board_info: data.board_info || {},
      observations: data.observations || [],
    };
    await storage.uploadText(
      JSON.stringify(extractedData, null, 2),
      `${s3Prefix}extracted_data.json`
    );

    if (data.circuits && Array.isArray(data.circuits) && data.circuits.length > 0) {
      const csvContent = circuitsToCSV(data.circuits);
      await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
    }

    await db.createJob({
      id: jobId,
      user_id: userId,
      folder_name: folderName,
      certificate_type: certificateType || 'EICR',
      status: 'done',
      address,
      client_name: data.installation_details?.client_name || '',
      s3_prefix: s3Prefix,
    });

    logger.info('Job created from OCR data', {
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
    logger.error('Failed to create job from OCR data', { userId, jobId, error: error.message });
    res.status(500).json({ error: 'Failed to create job: ' + error.message });
  }
});

/**
 * Extract data from an existing EICR/EIC certificate via OCR
 * POST /api/ocr/certificate
 */
router.post('/ocr/certificate', auth.requireAuth, upload.single('file'), async (req, res) => {
  const userId = req.user?.id;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Please provide a PDF or image file.' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname || 'unknown';
  const ext = path.extname(originalName).toLowerCase();

  const allowedExts = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
  if (!allowedExts.has(ext)) {
    await fs.unlink(filePath).catch(() => {});
    return res.status(400).json({
      error: `Unsupported file type: ${ext}. Accepted: .pdf, .jpg, .jpeg, .png`,
    });
  }

  logger.info('OCR certificate extraction requested', {
    userId,
    originalName,
    ext,
    size: req.file.size,
  });

  try {
    const result = await extractFromCertificate(filePath);

    logger.info('OCR certificate extraction successful', {
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
    logger.error('OCR certificate extraction failed', {
      userId,
      originalName,
      error: error.message,
    });

    res.status(500).json({
      error: `OCR extraction failed: ${error.message}`,
    });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

export default router;
