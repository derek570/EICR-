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
 * P0-15 — Company settings (name, address, phone, email, website,
 * registration, logo) are shared across every user in a company, so
 * they MUST be keyed by `company_id` rather than by `user.id`.
 *
 * Historically these endpoints persisted to `settings/${userId}/…`,
 * which meant each inspector in a shared company kept their own
 * private copy. Two inspectors on the same firm editing "company
 * address" would race each other — whichever saved last was the only
 * version that appeared on their own generated PDFs, and the other
 * user's PDFs still carried the old string. Every other company
 * user's PDFs would continue to carry whatever was in THEIR personal
 * copy (usually empty, depending on first-run state).
 *
 * Switching to company-scoped keying makes a single edit propagate to
 * every user on the firm. Users without a `company_id` (the legacy
 * path for solo inspectors who pre-date the companies feature) fall
 * back to the userId path so their existing S3 files remain readable
 * — we don't migrate them automatically because the fallback path is
 * indistinguishable from the correct behaviour for single-user firms.
 *
 * NOTE on access control: the GET/PUT routes currently allow any
 * authenticated user whose path param matches their own id. That
 * passes unchanged here — the only correctness issue P0-15 addresses
 * is the S3 key. A separate follow-up should gate PUT on
 * company_role ∈ {owner, admin} once the UI surfaces a "you can view
 * but not edit" affordance for employees.
 */
function companySettingsPrefix(user) {
  if (user?.company_id) {
    return `settings/company/${user.company_id}`;
  }
  // Legacy fallback — pre-companies single-user install.
  return `settings/${user.id}`;
}

// Multer for logo uploads — same constraints as signatures. Company logos are
// usually clean PNGs or JPEGs; we don't accept SVG to sidestep embedded-script
// risk in user-uploaded content stamped onto PDF headers.
const logoUpload = multer({
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
    const s3Key = `${companySettingsPrefix(req.user)}/company_settings.json`;
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
    const s3Key = `${companySettingsPrefix(req.user)}/company_settings.json`;
    await storage.uploadText(JSON.stringify(settings, null, 2), s3Key);

    logger.info('Company settings updated', {
      userId,
      companyId: req.user.company_id ?? null,
    });
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
 * Download a signature PNG by filename.
 *
 * GET /api/settings/:userId/signatures/:filename
 *
 * Why this exists: the upload route returns the S3 key
 * (`settings/{userId}/signatures/{filename}`) which is then persisted on the
 * inspector profile as `signature_file`. iOS reads signatures back via the
 * Swift S3 client using that key directly, but the web client cannot —
 * browsers can't attach our Authorization header to a bare S3 URL. So we
 * stream the bytes through an auth'd endpoint and wrap the Blob in
 * URL.createObjectURL on the client. Mirrors the photo-download pattern in
 * routes/photos.js.
 *
 * Access is tenant-scoped: the authenticated user must match `:userId`.
 */
router.get('/settings/:userId/signatures/:filename', auth.requireAuth, async (req, res) => {
  const { userId, filename } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Guard against path traversal — filename must be a simple basename.
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const s3Key = `settings/${userId}/signatures/${filename}`;
    const bytes = await storage.downloadBytes(s3Key);
    if (!bytes) {
      return res.status(404).json({ error: 'Signature not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    res.setHeader('Content-Type', contentType);
    // Private — signatures are PII. Don't let intermediaries cache.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  } catch (error) {
    logger.error('Failed to fetch signature', { userId, filename, error: error.message });
    res.status(500).json({ error: 'Failed to fetch signature' });
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
 * Upload a company logo.
 *
 * POST /api/settings/:userId/logo  (multipart, field `logo`)
 *
 * Why a dedicated route: company settings JSON lives at
 * `settings/{userId}/company_settings.json` and is stamped onto every PDF
 * header. Inlining logo bytes as base64 inside the JSON would bloat the
 * blob (~200KB typical) and bust the read cache on every save. Mirrors
 * the signature uploader: returns the S3 key which the client then
 * merges into `company_settings.logo_file` via the existing PUT route.
 *
 * Two-step save (matches signature flow):
 *  1. POST bytes → get `{ logo_file: s3Key }`
 *  2. PUT company settings with `logo_file` set
 *
 * Access is tenant-scoped. 10MB cap. PNG / JPEG only — SVG rejected to
 * avoid embedded-script risk when the PDF generator inlines the image.
 */
router.post(
  '/settings/:userId/logo',
  auth.requireAuth,
  logoUpload.single('logo'),
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
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const filename = `logo_${Date.now()}${ext}`;
      const s3Key = `${companySettingsPrefix(req.user)}/logos/${filename}`;

      const content = await fs.readFile(file.path);
      const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      await storage.uploadBytes(content, s3Key, contentType);

      await fs.unlink(file.path).catch(() => {});

      logger.info('Company logo uploaded', {
        userId,
        companyId: req.user.company_id ?? null,
        filename,
      });
      res.json({ success: true, logo_file: s3Key });
    } catch (error) {
      logger.error('Failed to upload logo', { userId, error: error.message });
      res.status(500).json({ error: 'Failed to upload logo' });
    }
  }
);

/**
 * Download a company logo by filename.
 *
 * GET /api/settings/:userId/logo/:filename
 *
 * Same rationale as the signature download route: browsers can't attach
 * our bearer header to a bare S3 URL, so we stream the bytes through an
 * auth'd endpoint. Logos aren't especially sensitive but we keep the
 * route tenant-scoped for consistency with signatures — it also avoids
 * leaking a "which companies exist" enumeration surface.
 */
router.get('/settings/:userId/logo/:filename', auth.requireAuth, async (req, res) => {
  const { userId, filename } = req.params;

  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    // Try company-scoped key first (P0-15 layout). Fall back to the
    // legacy per-user key so any logos uploaded before this fix are
    // still retrievable — the returned `logo_file` in the DB may
    // point at either shape. New uploads only ever write the
    // company-scoped key via `companySettingsPrefix`.
    const companyKey = `${companySettingsPrefix(req.user)}/logos/${filename}`;
    let bytes = await storage.downloadBytes(companyKey);
    if (!bytes) {
      const legacyKey = `settings/${userId}/logos/${filename}`;
      bytes = await storage.downloadBytes(legacyKey);
    }
    if (!bytes) {
      return res.status(404).json({ error: 'Logo not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    res.setHeader('Content-Type', contentType);
    // Short-lived cache — logos rarely change but we want admins to see
    // their edits within a few minutes without a hard reload.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  } catch (error) {
    logger.error('Failed to fetch logo', { userId, filename, error: error.message });
    res.status(500).json({ error: 'Failed to fetch logo' });
  }
});

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
