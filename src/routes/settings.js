/**
 * Settings routes — user defaults, company settings, inspector profiles, schema, regulations
 */

import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import os from 'node:os';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import logger from '../logger.js';
import { createFileFilter, handleUploadError } from '../utils/upload.js';

const router = Router();

// Multer for signature uploads (PNG + JPEG only)
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: createFileFilter(['image/png', 'image/jpeg']),
});

/**
 * Get user defaults (circuit field defaults)
 * GET /api/settings/:userId/defaults
 */
router.get('/settings/:userId/defaults', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/user_defaults.json`;
    const content = await storage.downloadText(s3Key);

    if (content) {
      res.json(JSON.parse(content));
    } else {
      res.json({});
    }
  } catch (error) {
    logger.error('Failed to get user defaults', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to get user defaults' });
  }
});

/**
 * Update user defaults
 * PUT /api/settings/:userId/defaults
 */
router.put('/settings/:userId/defaults', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const defaults = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/user_defaults.json`;
    await storage.uploadText(JSON.stringify(defaults, null, 2), s3Key);

    logger.info('User defaults updated', { userId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update user defaults', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to update user defaults' });
  }
});

/**
 * Get company settings
 * GET /api/settings/:userId/company
 */
router.get('/settings/:userId/company', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/company_settings.json`;
    const content = await storage.downloadText(s3Key);

    if (content) {
      res.json(JSON.parse(content));
    } else {
      res.json({
        company_name: '',
        company_address: '',
        company_phone: '',
        company_email: '',
        company_website: '',
        company_registration: '',
        logo_file: null,
      });
    }
  } catch (error) {
    logger.error('Failed to get company settings', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to get company settings' });
  }
});

/**
 * Update company settings
 * PUT /api/settings/:userId/company
 */
router.put('/settings/:userId/company', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const settings = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/company_settings.json`;
    await storage.uploadText(JSON.stringify(settings, null, 2), s3Key);

    logger.info('Company settings updated', { userId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update company settings', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to update company settings' });
  }
});

/**
 * Get inspector profiles for a user
 * GET /api/inspector-profiles/:userId
 */
router.get('/inspector-profiles/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/inspector_profiles.json`;
    const content = await storage.downloadText(s3Key);

    if (content) {
      res.json(JSON.parse(content));
    } else {
      res.json([]);
    }
  } catch (error) {
    logger.error('Failed to get inspector profiles', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to get inspector profiles' });
  }
});

/**
 * Update inspector profiles
 * PUT /api/inspector-profiles/:userId
 */
router.put('/inspector-profiles/:userId', auth.requireAuth, async (req, res) => {
  const { userId } = req.params;
  const profiles = req.body;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const s3Key = `settings/${userId}/inspector_profiles.json`;
    await storage.uploadText(JSON.stringify(profiles, null, 2), s3Key);

    logger.info('Inspector profiles updated', { userId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update inspector profiles', { userId, error: error.message });
    res.status(500).json({ error: 'Failed to update inspector profiles' });
  }
});

/**
 * Upload inspector signature
 * POST /api/inspector-profiles/:userId/upload-signature
 */
router.post(
  '/inspector-profiles/:userId/upload-signature',
  auth.requireAuth,
  upload.single('signature'),
  async (req, res) => {
    const { userId } = req.params;
    const file = req.file;

    if (req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `signature_${Date.now()}${ext}`;
      const s3Key = `settings/${userId}/signatures/${filename}`;

      const content = await fs.readFile(file.path);
      await storage.uploadBytes(content, s3Key);

      await fs.unlink(file.path).catch(() => {});

      logger.info('Signature uploaded', { userId, filename });
      res.json({ success: true, signature_file: s3Key });
    } catch (error) {
      logger.error('Failed to upload signature', { userId, error: error.message });
      res.status(500).json({ error: 'Failed to upload signature' });
    }
  }
);

/**
 * Get field schema (for building defaults editor UI)
 * GET /api/schema/fields
 */
router.get('/schema/fields', async (req, res) => {
  try {
    const schemaPath = path.resolve(import.meta.dirname, '..', '..', 'config', 'field_schema.json');
    const content = await fs.readFile(schemaPath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (error) {
    logger.error('Failed to get field schema', { error: error.message });
    res.status(500).json({ error: 'Failed to get field schema' });
  }
});

// In-memory cache for regulations database
let regulationsCache = null;

async function loadRegulations() {
  if (regulationsCache) return regulationsCache;
  const regPath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'config',
    'bs7671-regulations.json'
  );
  const content = await fs.readFile(regPath, 'utf-8');
  regulationsCache = JSON.parse(content);
  return regulationsCache;
}

/**
 * Search regulations by query string
 * GET /api/regulations?q=searchterm
 */
router.get('/regulations', auth.requireAuth, async (req, res) => {
  try {
    const regsDb = await loadRegulations();
    const query = (req.query.q || '').toString().toLowerCase().trim();
    let results = regsDb.regulations;

    if (query) {
      results = regsDb.regulations.filter((reg) => {
        const searchFields = [
          reg.ref,
          reg.section,
          reg.title,
          reg.description,
          ...(reg.common_observations || []),
          reg.recommended_action,
        ]
          .join(' ')
          .toLowerCase();
        return searchFields.includes(query);
      });
    }

    res.json(results.slice(0, 20));
  } catch (error) {
    logger.error('Failed to search regulations', { error: error.message });
    res.status(500).json({ error: 'Failed to search regulations' });
  }
});

// Handle Multer file filter rejections with 400 status
router.use(handleUploadError);

export default router;
