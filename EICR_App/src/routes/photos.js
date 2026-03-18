/**
 * Photo routes — list, get, upload, delete job photos
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import { resolveJob } from '../utils/jobs.js';
import logger from '../logger.js';
import { createFileFilter, IMAGE_MIMES, handleUploadError } from '../utils/upload.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: createFileFilter(IMAGE_MIMES),
});

/**
 * Get all photos for a job
 * GET /api/job/:userId/:jobId/photos
 */
router.get('/job/:userId/:jobId/photos', auth.requireAuth, async (req, res) => {
  const { userId, jobId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const job = await resolveJob(userId, jobId);
    const folderName = job?.address || jobId;

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
    logger.error('Failed to list job photos', { userId, jobId, error: error.message });
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

/**
 * Get a specific photo
 * GET /api/job/:userId/:jobId/photos/:filename
 */
router.get('/job/:userId/:jobId/photos/:filename', auth.requireAuth, async (req, res) => {
  const { userId, jobId, filename } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const job = await resolveJob(userId, jobId);
    const folderName = job?.address || jobId;

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
      return res.status(404).json({ error: 'Photo not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(photoContent);
  } catch (error) {
    logger.error('Failed to get photo', { userId, jobId, filename, error: error.message });
    res.status(500).json({ error: 'Failed to get photo' });
  }
});

/**
 * Upload a new photo to a job
 * POST /api/job/:userId/:jobId/photos
 */
router.post(
  '/job/:userId/:jobId/photos',
  auth.requireAuth,
  upload.single('photo'),
  async (req, res) => {
    const { userId, jobId } = req.params;
    const file = req.file;

    if (req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    try {
      const job = await resolveJob(userId, jobId);
      const folderName = job?.address || jobId;

      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      const filename = `photo_${Date.now()}${ext}`;
      const s3Key = `jobs/${userId}/${folderName}/photos/${filename}`;

      const content = await fs.readFile(file.path);
      await storage.uploadBytes(content, s3Key);

      await fs.unlink(file.path).catch(() => {});

      logger.info('Photo uploaded', { userId, jobId, filename });

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
      logger.error('Failed to upload photo', { userId, jobId, error: error.message });
      res.status(500).json({ error: 'Failed to upload photo' });
    }
  }
);

/**
 * Delete a photo from a job
 * DELETE /api/job/:userId/:jobId/photos/:filename
 */
router.delete('/job/:userId/:jobId/photos/:filename', auth.requireAuth, async (req, res) => {
  const { userId, jobId, filename } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const job = await resolveJob(userId, jobId);
    const folderName = job?.address || jobId;

    const possiblePaths = [
      `jobs/${userId}/${folderName}/input/photos/${filename}`,
      `jobs/${userId}/${folderName}/photos/${filename}`,
      `jobs/${userId}/${folderName}/output/photos/${filename}`,
      `jobs/${userId}/${folderName}/output/photos_scaled/${filename}`,
    ];

    let deleted = false;
    for (const s3Path of possiblePaths) {
      try {
        await storage.deleteFile(s3Path);
        deleted = true;
      } catch (e) {
        // Path doesn't exist, try next
      }
    }

    if (!deleted) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    logger.info('Photo deleted', { userId, jobId, filename });
    res.json({ success: true, filename });
  } catch (error) {
    logger.error('Failed to delete photo', { userId, jobId, filename, error: error.message });
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// Handle Multer file filter rejections with 400 status
router.use(handleUploadError);

export default router;
