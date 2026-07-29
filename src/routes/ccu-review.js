/**
 * System-admin CCU ground-truth review API.
 *
 * Every live `/api/analyze-ccu` call already writes:
 *
 *   ccu-extractions/{userId}/{sessionId}/{extractionId}/original.jpg
 *   ccu-extractions/{userId}/{sessionId}/{extractionId}/result.json
 *
 * This router turns those diagnostic pairs into an annotation queue. The
 * reviewer sees the original photo beside an editable CertMate-shaped circuit
 * form, then the approved answer is saved beside that exact extraction as:
 *
 *   ccu-extractions/{userId}/{sessionId}/{extractionId}/ground-truth.json
 *
 * Per-extraction storage is deliberate. The older session-level `final.json`
 * can contain multiple boards and later voice edits, so treating it as the
 * unquestioned answer for one photograph would create mislabeled training
 * data. We expose it only as an optional reference in the detail response.
 *
 * Mount contract: `src/api.js` applies `requireAuth` + `requireAdmin`.
 */

import { Router } from 'express';
import { createRequire } from 'node:module';
import * as storage from '../storage.js';
import logger from '../logger.js';

const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

const router = Router();
const ROOT_PREFIX = 'ccu-extractions/';
const MAX_LIST_LIMIT = 200;
const MAX_CIRCUITS = 100;
const MAX_FIELD_LENGTH = 500;
const MAX_NOTES_LENGTH = 5000;

const BOARD_FIELDS = new Set([
  'board_manufacturer',
  'board_model',
  'board_technology',
  'main_switch_rating',
  'main_switch_bs_en',
  'main_switch_type',
  'main_switch_poles',
  'main_switch_current',
  'main_switch_voltage',
  'main_switch_position',
  'spd_present',
  'spd_bs_en',
  'spd_type',
  'spd_rated_current_a',
  'spd_short_circuit_ka',
]);

const CIRCUIT_FIELDS = new Set([
  'id',
  'board_id',
  ...Object.keys(fieldSchema.circuit_fields || {}),
  // Extraction-only truth signals which are useful when scoring the CCU model
  // even though they are not independent PDF schedule columns.
  'is_rcbo',
  'rcd_protected',
]);

function safeSegment(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function encodeCcuReviewSampleId(prefix) {
  return Buffer.from(prefix, 'utf8').toString('base64url');
}

export function decodeCcuReviewSampleId(sampleId) {
  if (typeof sampleId !== 'string' || sampleId.length === 0 || sampleId.length > 1024) {
    return null;
  }
  let prefix;
  try {
    prefix = Buffer.from(sampleId, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = prefix.split('/');
  if (parts.length !== 4 || parts[0] !== 'ccu-extractions' || !parts.slice(1).every(safeSegment)) {
    return null;
  }
  return prefix;
}

function sampleParts(prefix) {
  const [, userId, sessionId, extractionId] = prefix.split('/');
  const timestampMatch = extractionId.match(/^(\d{13})-/);
  const timestamp = timestampMatch ? Number(timestampMatch[1]) : NaN;
  return {
    userId,
    sessionId,
    extractionId,
    createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
  };
}

function projectCircuit(circuit, index) {
  if (!circuit || typeof circuit !== 'object' || Array.isArray(circuit)) return null;
  const projected = {};
  for (const key of [
    'circuit_number',
    'label',
    'ocpd_type',
    'ocpd_rating_a',
    'ocpd_bs_en',
    'ocpd_breaking_capacity_ka',
    'is_rcbo',
    'rcd_protected',
    'rcd_type',
    'rcd_rating_ma',
    'rcd_bs_en',
    'is_rcd_device',
  ]) {
    const value = circuit[key];
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      projected[key] = value ?? null;
    }
  }
  projected._source_index = index;
  return projected;
}

/**
 * Project a potentially multi-megabyte result.json down to the fields the
 * reviewer needs. In particular, never send Stage-3 base64 slot crops back
 * through this endpoint—the presigned original image is the visual source.
 */
export function projectCcuAnalysisForReview(analysis) {
  const source =
    analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? analysis : {};
  const projected = {};
  for (const key of BOARD_FIELDS) {
    const value = source[key];
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      projected[key] = value ?? null;
    }
  }
  projected.extraction_source =
    typeof source.extraction_source === 'string' ? source.extraction_source : null;
  projected.circuits = Array.isArray(source.circuits)
    ? source.circuits.map(projectCircuit).filter(Boolean)
    : [];
  projected.questionsForInspector = Array.isArray(source.questionsForInspector)
    ? source.questionsForInspector.filter((value) => typeof value === 'string').slice(0, 100)
    : [];
  if (source.confidence && typeof source.confidence === 'object') {
    projected.confidence = {
      overall: typeof source.confidence.overall === 'number' ? source.confidence.overall : null,
      image_quality:
        typeof source.confidence.image_quality === 'string'
          ? source.confidence.image_quality
          : null,
      message:
        typeof source.confidence.message === 'string'
          ? source.confidence.message.slice(0, 2000)
          : null,
    };
  }
  return projected;
}

function sanitiseScalar(value, fieldName) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (!['string', 'number'].includes(typeof value)) {
    throw new Error(`${fieldName} must be a string, number, boolean, or null`);
  }
  const text = String(value);
  if (text.length > MAX_FIELD_LENGTH) {
    throw new Error(`${fieldName} exceeds ${MAX_FIELD_LENGTH} characters`);
  }
  return text;
}

export function sanitiseCcuGroundTruth(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Ground truth body must be a JSON object');
  }

  const boardInput =
    body.board && typeof body.board === 'object' && !Array.isArray(body.board) ? body.board : {};
  const board = {};
  for (const key of BOARD_FIELDS) {
    if (Object.hasOwn(boardInput, key)) {
      board[key] = sanitiseScalar(boardInput[key], `board.${key}`);
    }
  }

  if (!Array.isArray(body.circuits)) {
    throw new Error('circuits must be an array');
  }
  if (body.circuits.length > MAX_CIRCUITS) {
    throw new Error(`circuits exceeds the ${MAX_CIRCUITS}-row limit`);
  }

  const circuits = body.circuits.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`circuits[${index}] must be an object`);
    }
    const row = {};
    for (const key of CIRCUIT_FIELDS) {
      if (Object.hasOwn(input, key)) {
        row[key] = sanitiseScalar(input[key], `circuits[${index}].${key}`);
      }
    }
    row.id =
      typeof row.id === 'string' && row.id.trim().length > 0 ? row.id : `ground-truth-${index + 1}`;
    row.circuit_ref =
      typeof row.circuit_ref === 'string' && row.circuit_ref.trim().length > 0
        ? row.circuit_ref
        : String(index + 1);
    return row;
  });

  const notes = body.notes == null ? '' : String(body.notes);
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new Error(`notes exceeds ${MAX_NOTES_LENGTH} characters`);
  }

  return { board, circuits, notes };
}

async function listSamples() {
  const keys = await storage.listFiles(ROOT_PREFIX);
  const keySet = new Set(keys);
  const prefixes = keys
    .filter((key) => key.endsWith('/result.json'))
    .map((key) => key.slice(0, -'/result.json'.length))
    .filter((prefix) => keySet.has(`${prefix}/original.jpg`));

  return prefixes
    .map((prefix) => {
      const parts = sampleParts(prefix);
      return {
        sampleId: encodeCcuReviewSampleId(prefix),
        extractionId: parts.extractionId,
        sessionId: parts.sessionId,
        createdAt: parts.createdAt,
        reviewed: keySet.has(`${prefix}/ground-truth.json`),
      };
    })
    .sort((a, b) => {
      if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.extractionId.localeCompare(a.extractionId);
    });
}

// GET /api/admin/ccu-review?status=unreviewed|reviewed|all&limit=100&offset=0
router.get('/', async (req, res) => {
  try {
    const status = ['unreviewed', 'reviewed', 'all'].includes(req.query.status)
      ? req.query.status
      : 'unreviewed';
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_LIST_LIMIT, requestedLimit))
      : 100;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const all = await listSamples();
    const reviewed = all.filter((sample) => sample.reviewed).length;
    const filtered =
      status === 'all'
        ? all
        : all.filter((sample) => (status === 'reviewed' ? sample.reviewed : !sample.reviewed));

    res.json({
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      reviewed,
      unreviewed: all.length - reviewed,
      limit,
      offset,
    });
  } catch (error) {
    logger.error('CCU review list failed', { adminId: req.user?.id, error: error.message });
    res.status(500).json({ error: 'Failed to list CCU review samples' });
  }
});

// GET /api/admin/ccu-review/:sampleId
router.get('/:sampleId', async (req, res) => {
  const prefix = decodeCcuReviewSampleId(req.params.sampleId);
  if (!prefix) return res.status(400).json({ error: 'Invalid CCU review sample id' });

  try {
    const [result, groundTruthDoc, imageUrl] = await Promise.all([
      storage.downloadJson(`${prefix}/result.json`),
      storage.downloadJson(`${prefix}/ground-truth.json`),
      storage.getFileUrl(`${prefix}/original.jpg`, 15 * 60),
    ]);
    if (!result || !imageUrl) {
      return res.status(404).json({ error: 'CCU review sample not found' });
    }

    const parts = sampleParts(prefix);
    const sessionFinal = await storage.downloadJson(
      `${ROOT_PREFIX}${parts.userId}/${parts.sessionId}/final.json`
    );

    res.json({
      sample: {
        sampleId: req.params.sampleId,
        extractionId: parts.extractionId,
        sessionId: parts.sessionId,
        createdAt: parts.createdAt,
        reviewed: Boolean(groundTruthDoc),
      },
      imageUrl,
      extracted: projectCcuAnalysisForReview(result.analysis),
      extractionMeta: {
        model: typeof result.meta?.model === 'string' ? result.meta.model : null,
        timestamp: typeof result.meta?.timestamp === 'string' ? result.meta.timestamp : null,
        totalElapsedMs:
          typeof result.meta?.totalElapsedMs === 'number' ? result.meta.totalElapsedMs : null,
      },
      groundTruth: groundTruthDoc?.groundTruth ?? null,
      reviewMeta: groundTruthDoc
        ? {
            reviewedAt: groundTruthDoc.reviewedAt ?? null,
            revision: groundTruthDoc.revision ?? 1,
          }
        : null,
      sessionConfirmedLayout: sessionFinal?.layout ?? null,
    });
  } catch (error) {
    logger.error('CCU review detail failed', {
      adminId: req.user?.id,
      sampleId: req.params.sampleId,
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to load CCU review sample' });
  }
});

// PUT /api/admin/ccu-review/:sampleId
router.put('/:sampleId', async (req, res) => {
  const prefix = decodeCcuReviewSampleId(req.params.sampleId);
  if (!prefix) return res.status(400).json({ error: 'Invalid CCU review sample id' });

  let groundTruth;
  try {
    groundTruth = sanitiseCcuGroundTruth(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    const resultExists = await storage.fileExists(`${prefix}/result.json`);
    if (!resultExists) return res.status(404).json({ error: 'CCU review sample not found' });

    const prior = await storage.downloadJson(`${prefix}/ground-truth.json`);
    const now = new Date().toISOString();
    const revision = Number.isFinite(prior?.revision) ? prior.revision + 1 : 1;
    const document = {
      schemaVersion: 'ccu-ground-truth-v1',
      extractionId: sampleParts(prefix).extractionId,
      createdAt: prior?.createdAt ?? now,
      reviewedAt: now,
      reviewedBy: req.user.id,
      revision,
      groundTruth,
    };
    const ok = await storage.uploadJson(document, `${prefix}/ground-truth.json`);
    if (!ok) throw new Error('storage.uploadJson returned false');

    logger.info('CCU ground truth saved', {
      adminId: req.user.id,
      extractionId: document.extractionId,
      circuitCount: groundTruth.circuits.length,
      revision,
    });
    res.json({ success: true, sampleId: req.params.sampleId, reviewedAt: now, revision });
  } catch (error) {
    logger.error('CCU ground truth save failed', {
      adminId: req.user?.id,
      sampleId: req.params.sampleId,
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to save CCU ground truth' });
  }
});

export default router;
