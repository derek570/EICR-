/**
 * Extraction routes — Sonnet chunked audio extraction, CCU photo analysis, observation enhancement
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import { sonnetExtractFromAudio } from '../sonnet_extract.js';
import { getActiveSession } from '../state/recording-sessions.js';
import logger from '../logger.js';
import sharp from 'sharp';
import { createFileFilter, IMAGE_MIMES, handleUploadError } from '../utils/upload.js';
import { prepareModernGeometry, classifyModernSlots } from '../extraction/ccu-geometric.js';
import { tightenAndChunk } from '../extraction/ccu-box-tighten.js';
import { inferTechnologyFromModel } from '../extraction/board-model-registry.js';
import {
  prepareRewireableGeometry,
  classifyRewireableSlots,
} from '../extraction/ccu-geometric-rewireable.js';
import { extractSlotLabels } from '../extraction/ccu-label-pass.js';
import { withIdempotency } from '../middleware/idempotency.js';

const router = Router();

// --- CCU extraction timeout & size config ---
// Increased from 120s — CCU analysis regularly takes 100-110s
const CCU_EXTRACTION_TIMEOUT_MS = parseInt(process.env.CCU_EXTRACTION_TIMEOUT_MS, 10) || 180_000;
const CCU_MAX_UPLOAD_BYTES = parseInt(process.env.CCU_MAX_UPLOAD_BYTES, 10) || 20 * 1024 * 1024;

logger.info('CCU extraction config', {
  timeoutMs: CCU_EXTRACTION_TIMEOUT_MS,
  maxUploadBytes: CCU_MAX_UPLOAD_BYTES,
  maxUploadMB: CCU_MAX_UPLOAD_BYTES / (1024 * 1024),
});

/**
 * Convert the box-tightener output (`tightenAndChunk`) into the same shape
 * `prepareModernGeometry` returns, so downstream Stage 3/4/merger code is
 * unchanged. Coordinates are 0-1000 normalised over the source image.
 */
function adaptTightenerToPrepared(t) {
  const { imageWidth, imageHeight, railFace, moduleCount, pitchPx, slotCentersPx } = t;
  const xToNorm = (x) => (x / imageWidth) * 1000;
  const yToNorm = (y) => (y / imageHeight) * 1000;
  return {
    medianRails: {
      rail_top: yToNorm(railFace.top),
      rail_bottom: yToNorm(railFace.bottom),
      rail_left: xToNorm(railFace.left),
      rail_right: xToNorm(railFace.right),
    },
    moduleCount,
    vlmCount: moduleCount,
    disagreement: 0,
    truncatedFromDisagreement: false,
    lowConfidence: !t.refinement.accepted,
    stage1Source: 'roi-hint',
    railBbox: {
      left: xToNorm(railFace.left),
      right: xToNorm(railFace.right),
      top: yToNorm(railFace.top),
      bottom: yToNorm(railFace.bottom),
    },
    railBboxSource: 'box-tightener',
    pitchSource: 'box-tightener',
    cvPitchDiag: {
      pitchPx,
      moduleCountFromCv: moduleCount,
      railWidthPx: railFace.right - railFace.left,
      reason: t.refinement.accepted ? null : 'no-multi-anchor-refinement',
    },
    pitchCrossCheck: null,
    chunkingDiag: {
      imageWidth,
      imageHeight,
      railWidthPx: railFace.right - railFace.left,
      railHeightPx: railFace.bottom - railFace.top,
      pitchSource: 'box-tightener',
      moduleCountRaw: (railFace.right - railFace.left) / Math.max(1, t.initialPitchPx),
      moduleCount,
      moduleWidthPxUsed: pitchPx,
      initialPitchPx: t.initialPitchPx,
      refinement: t.refinement,
    },
    slotCentersX: slotCentersPx.map(xToNorm),
    moduleWidth: (pitchPx / imageWidth) * 1000,
    mainSwitchWidth: null,
    mainSwitchCenterX: null,
    mainSwitchSide: null,
    imageWidth,
    imageHeight,
    panelBounds: null,
    stageOutputs: {
      // Box-tightener doesn't produce stage1/2 raw outputs, but the
      // route handler reads `stageOutputs.stage1.medianRails` for label-
      // pass crops. Synthesize a minimal shape pointing back at our
      // medianRails so downstream code doesn't NPE.
      stage1: {
        medianRails: {
          rail_top: yToNorm(railFace.top),
          rail_bottom: yToNorm(railFace.bottom),
          rail_left: xToNorm(railFace.left),
          rail_right: xToNorm(railFace.right),
        },
        panelBounds: null,
        boardManufacturer: null,
        boardModel: null,
        mainSwitchPosition: null,
        mainSwitchRating: null,
        spdPresent: null,
        boardTechnology: null,
        confidence: t.refinement.accepted ? 0.85 : 0.6,
        usage: { inputTokens: 0, outputTokens: 0 },
        lowConfidence: !t.refinement.accepted,
        source: 'box-tightener',
      },
      stage2: {
        geometricCount: moduleCount,
        vlmCount: moduleCount,
        disagreement: 0,
        slotCentersX: slotCentersPx.map(xToNorm),
        moduleWidth: (pitchPx / imageWidth) * 1000,
        mainSwitchWidth: null,
        mainSwitchCenterX: null,
        mainSwitchSide: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        railBbox: {
          left: xToNorm(railFace.left),
          right: xToNorm(railFace.right),
          top: yToNorm(railFace.top),
          bottom: yToNorm(railFace.bottom),
        },
        railBboxSource: 'box-tightener',
        pitchSource: 'box-tightener',
        cvPitchDiag: { pitchPx, moduleCountFromCv: moduleCount },
      },
    },
  };
}

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

// Debug audio keyword patterns
const DEBUG_START = /\b(?:d[\s-]?bug|debug|dee\s*bug)\b/i;
const DEBUG_END = /\b(?:end|stop|finish|done)\s+(?:d[\s-]?bug|debug)\b/i;

const sonnetChunkLimits = new Map();

/**
 * Compress a CCU photo to ≤500KB JPEG for training-data logging.
 * Plan 2026-04-16 §7: keep stored samples small — they are only used to
 * train an on-device YOLO detector, not for high-resolution recall. This
 * keeps S3 cost negligible even as TestFlight volume scales.
 */
async function compressForTrainingLog(buffer, targetBytes = 500 * 1024) {
  let out = await sharp(buffer)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  if (out.length <= targetBytes) return out;
  out = await sharp(buffer)
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 65 })
    .toBuffer();
  return out;
}

/**
 * Fire-and-forget S3 logging of every CCU extraction — source of the
 * auto-labelled training corpus for the Phase B→E geometric pipeline.
 * Writes a small compressed JPEG + the VLM result JSON to:
 *   s3://$S3_BUCKET/ccu-extractions/{userId}/{sessionId|no-session}/{extractionId}/
 * Each upload is keyed by a unique extractionId so repeat shots within the
 * same recording session never overwrite earlier samples.
 */
async function logCcuTrainingData({ userId, sessionId, imageBuffer, analysis, meta }) {
  const extractionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Sanitise sessionId for S3 key safety — strip anything that isn't alphanumeric,
  // underscore or hyphen. Prevents path-traversal or spoofed bucket prefixes if a
  // client ever supplies a hostile sessionId (e.g. '../other-user/').
  const sessionSegment = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'no-session';
  const prefix = `ccu-extractions/${userId}/${sessionSegment}/${extractionId}`;

  const compressed = await compressForTrainingLog(imageBuffer);
  // storage.uploadBytes / uploadJson swallow S3 errors and return false. Check each
  // return value so silent S3 outages don't quietly discard training samples.
  const jpegOk = await storage.uploadBytes(compressed, `${prefix}/original.jpg`, 'image/jpeg');
  if (!jpegOk) {
    throw new Error(`storage.uploadBytes returned false for ${prefix}/original.jpg`);
  }
  const jsonOk = await storage.uploadJson(
    { extractionId, userId, sessionId: sessionId || null, meta, analysis },
    `${prefix}/result.json`
  );
  if (!jsonOk) {
    throw new Error(`storage.uploadJson returned false for ${prefix}/result.json`);
  }

  logger.info('CCU training sample logged', {
    userId,
    sessionId: sessionId || null,
    extractionId,
    compressedBytes: compressed.length,
    circuitCount: analysis?.circuits?.length || 0,
  });
}

/**
 * BS/EN standard number lookup by device type
 */
const BS_EN_LOOKUP = {
  MCB: '60898-1',
  B: '60898-1',
  C: '60898-1',
  D: '60898-1',
  RCBO: '61009',
  RCD: '61008',
  RCCB: '61008',
  MCCB: '60947-2',
  SWITCH: '60947-3',
  ISOLATOR: '60947-3',
  gG: '60269-2',
  HRC: '60269-2',
  REW: 'BS 3036',
  REWIREABLE: 'BS 3036',
  CARTRIDGE: 'BS 1361',
};

/**
 * Normalise circuit labels to standard EICR certificate terms.
 * Acts as a safety net after Claude Vision — catches common UK abbreviations
 * and shorthand that the model may return verbatim instead of normalising.
 */
export function normaliseCircuitLabels(analysis) {
  if (!analysis?.circuits) return analysis;

  // Map of patterns (lowercase) to normalised label.
  // Order matters — more specific patterns first.
  const LABEL_MAP = [
    // Immersion / Water Heater variants
    { pattern: /^immersion\s*heater$/i, label: 'Water Heater' },
    { pattern: /^immersion$/i, label: 'Water Heater' },
    { pattern: /^imm$/i, label: 'Water Heater' },
    { pattern: /^hot\s*water$/i, label: 'Water Heater' },
    { pattern: /^hw$/i, label: 'Water Heater' },
    { pattern: /^heater$/i, label: 'Water Heater' },

    // Smoke alarm variants
    { pattern: /^smokes?$/i, label: 'Smoke Alarm' },
    { pattern: /^smoke\s*det(ector)?s?$/i, label: 'Smoke Alarm' },
    { pattern: /^s\/?d$/i, label: 'Smoke Alarm' },
    { pattern: /^smoke\s*alarms?$/i, label: 'Smoke Alarm' },
    { pattern: /^fire\s*alarm$/i, label: 'Smoke Alarm' },

    // Lighting variants
    { pattern: /^lts$/i, label: 'Lights' },
    { pattern: /^ltg$/i, label: 'Lighting' },

    // Cooker
    { pattern: /^ckr$/i, label: 'Cooker' },

    // Shower
    { pattern: /^shwr$/i, label: 'Shower' },

    // Boiler
    { pattern: /^blr$/i, label: 'Boiler' },

    // Fridge Freezer
    { pattern: /^f\/?f$/i, label: 'Fridge Freezer' },
    { pattern: /^fridge\s*freezer$/i, label: 'Fridge Freezer' },

    // Central Heating
    { pattern: /^ch$/i, label: 'Central Heating' },
    { pattern: /^central\s*heating$/i, label: 'Central Heating' },

    // Underfloor Heating
    { pattern: /^ufh$/i, label: 'Underfloor Heating' },
    { pattern: /^under\s*floor\s*heat(ing)?$/i, label: 'Underfloor Heating' },

    // EV Charging
    { pattern: /^ev(cp)?$/i, label: 'Electric Vehicle' },
    { pattern: /^ev\s*charg(er|ing)$/i, label: 'Electric Vehicle' },

    // Washing Machine
    { pattern: /^w\/?m$/i, label: 'Washing Machine' },
    { pattern: /^washer$/i, label: 'Washing Machine' },

    // Tumble Dryer
    { pattern: /^t\/?d$/i, label: 'Tumble Dryer' },

    // Socket expansions (keep prefix)
    {
      pattern: /^skt\s+(.+)$/i,
      label: null,
      transform: (m) => {
        const prefix = m[1].trim();
        return prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase() + ' Sockets';
      },
    },
    { pattern: /^skts?\s*$/i, label: 'Sockets' },
  ];

  for (const circuit of analysis.circuits) {
    if (!circuit.label || circuit.label === 'null') continue;

    const raw = circuit.label.trim();
    let matched = false;

    for (const entry of LABEL_MAP) {
      const m = raw.match(entry.pattern);
      if (m) {
        if (entry.transform) {
          circuit.label = entry.transform(m);
        } else {
          circuit.label = entry.label;
        }
        matched = true;
        break;
      }
    }

    // Title-case cleanup if not matched but all lowercase/uppercase
    if (!matched && (raw === raw.toLowerCase() || raw === raw.toUpperCase()) && raw.length > 1) {
      circuit.label = raw.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return analysis;
}

/**
 * Apply fallback BS/EN numbers to circuits based on device type
 */
export function applyBsEnFallback(analysis) {
  if (!analysis?.circuits) return analysis;

  for (const circuit of analysis.circuits) {
    // Skip blank/spare positions — do not enrich phantom devices with BS/EN data
    if (!circuit.ocpd_type || circuit.ocpd_type === 'null') continue;

    const ocpdType = (circuit.ocpd_type || '').toUpperCase();
    const isRcbo =
      circuit.is_rcbo === true ||
      (circuit.rcd_protected === true &&
        circuit.rcd_rating_ma &&
        ['B', 'C', 'D'].includes(ocpdType));

    if (!circuit.ocpd_bs_en) {
      if (isRcbo) {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.RCBO;
        circuit.rcd_bs_en = BS_EN_LOOKUP.RCBO;
      } else if (BS_EN_LOOKUP[ocpdType]) {
        circuit.ocpd_bs_en = BS_EN_LOOKUP[ocpdType];
      } else if (ocpdType === 'MCCB') {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.MCCB;
      } else if (ocpdType === 'GG' || ocpdType === 'HRC') {
        circuit.ocpd_bs_en = BS_EN_LOOKUP.gG;
      }
    }

    if (!circuit.ocpd_breaking_capacity_ka) {
      if (['B', 'C', 'D'].includes(ocpdType) || isRcbo) {
        circuit.ocpd_breaking_capacity_ka = '6';
      }
    }

    if (circuit.rcd_protected && !circuit.rcd_bs_en && !isRcbo) {
      circuit.rcd_bs_en = BS_EN_LOOKUP.RCD;
    }

    // Validate rcd_type — GPT sometimes returns "RCD" or "RCBO" instead of the actual type
    const validRcdTypes = ['AC', 'A', 'B', 'F', 'S', 'A-S', 'B-S', 'B+'];
    if (circuit.rcd_type) {
      let normalised = circuit.rcd_type
        .toUpperCase()
        .trim()
        .replace(/\s*PLUS$/i, '+') // "B PLUS" → "B+"
        .replace(/\s*\+$/, '+'); // "B +" → "B+"
      if (validRcdTypes.includes(normalised)) {
        circuit.rcd_type = normalised;
      } else {
        // "RCD", "RCBO", or garbage — null it so iOS falls back gracefully
        circuit.rcd_type = null;
      }
    }
  }

  return analysis;
}

/**
 * Web search pass for missing RCD types.
 * For circuits where GPT Vision couldn't determine the RCD type from the
 * waveform symbol or its training data, use gpt-5-search-api to look up
 * the manufacturer datasheet and determine the correct type.
 * Only fires when there are circuits with null rcd_type but known model info.
 */
async function lookupMissingRcdTypes(analysis, openai, logger, userId) {
  const circuits = analysis.circuits || [];
  const manufacturer = analysis.board_manufacturer;

  // Collect circuits needing RCD type lookup — must have a model/manufacturer
  // and be RCD-protected (RCBO or behind an RCD) but missing the type
  const needsLookup = circuits.filter((c) => c.rcd_protected && !c.rcd_type && manufacturer);

  if (needsLookup.length === 0) {
    logger.info('RCD type lookup skipped — all RCD-protected circuits already have types', {
      userId,
      totalCircuits: circuits.length,
      rcdProtectedCount: circuits.filter((c) => c.rcd_protected).length,
    });
    return analysis;
  }

  // Gather any device info GPT extracted — RCBO model markings, ratings, etc.
  const boardModel = analysis.board_model || '';
  const deviceDescriptions = [];
  for (const c of needsLookup) {
    const parts = [`Circuit ${c.circuit_number}`];
    if (c.is_rcbo) parts.push('RCBO');
    if (c.ocpd_rating_a) parts.push(`${c.ocpd_rating_a}A`);
    if (c.rcd_rating_ma) parts.push(`${c.rcd_rating_ma}mA`);
    deviceDescriptions.push(parts.join(' '));
  }

  // Also check if there's a standalone RCD protecting these circuits
  const hasStandaloneRcd = needsLookup.some((c) => !c.is_rcbo && c.rcd_protected);

  const searchPrompt = `I have a UK consumer unit: ${manufacturer} ${boardModel}.
It contains ${needsLookup.length} RCD-protected circuits where I need to determine the RCD type.
${hasStandaloneRcd ? 'Some circuits are protected by a standalone RCD/RCCB in the board.' : 'The circuits use RCBOs (combined MCB+RCD).'}

Circuits needing RCD type: ${deviceDescriptions.join(', ')}.

Search for the ${manufacturer} ${boardModel} consumer unit datasheet or technical specifications.
What RCD type do the RCDs/RCBOs in this board provide? Type AC, Type A, Type B, Type F, or Type S?

Reply ONLY with valid JSON: {"rcd_type": "AC" or "A" or "B" or "F" or "S", "source": "brief description of where you found this"}
If you cannot determine the type, reply: {"rcd_type": null, "source": "not found"}`;

  try {
    logger.info('RCD type web search lookup starting', {
      userId,
      manufacturer,
      boardModel,
      circuitsNeedingLookup: needsLookup.length,
      deviceDescriptions,
    });

    const searchResponse = await openai.chat.completions.create({
      model: 'gpt-5-search-api',
      web_search_options: {},
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const searchContent = searchResponse.choices?.[0]?.message?.content || '';
    const searchTokens = searchResponse.usage?.completion_tokens || 0;

    logger.info('RCD type web search complete', {
      userId,
      responseLength: searchContent.length,
      searchTokens,
      rawPreview: searchContent.slice(0, 300),
    });

    // Parse the search result — extract JSON from the response
    let searchJson = searchContent;
    const jsonMatch = searchContent.match(/\{[\s\S]*?\}/);
    if (jsonMatch) searchJson = jsonMatch[0];

    const searchResult = JSON.parse(searchJson);
    const validTypes = ['AC', 'A', 'B', 'F', 'S'];
    const rcdType = searchResult.rcd_type?.toUpperCase()?.trim();

    if (rcdType && validTypes.includes(rcdType)) {
      // Apply the looked-up type to all circuits that need it
      for (const c of needsLookup) {
        if (!c.rcd_type) {
          c.rcd_type = rcdType;
        }
      }
      logger.info('RCD type web search found type', {
        userId,
        rcdType,
        source: searchResult.source || 'unknown',
      });
    }

    // Count how many we filled
    const filled = needsLookup.filter((c) => c.rcd_type).length;
    logger.info('RCD type web search applied', {
      userId,
      filled,
      total: needsLookup.length,
    });

    // Prune stale questionsForInspector — GPT adds RCD type questions BEFORE
    // this web search pass runs. If we resolved those types, the questions are
    // now stale and would cause unnecessary TTS interruptions on the iOS app.
    if (filled > 0 && Array.isArray(analysis.questionsForInspector)) {
      const before = analysis.questionsForInspector.length;
      const stillMissing = circuits.filter((c) => c.rcd_protected && !c.rcd_type);
      if (stillMissing.length === 0) {
        // All RCD types resolved — remove any RCD-related questions
        analysis.questionsForInspector = analysis.questionsForInspector.filter(
          (q) => !/\brcd\s*type\b/i.test(q)
        );
      }
      const after = analysis.questionsForInspector.length;
      if (before !== after) {
        logger.info('Pruned stale RCD type questions after web search', {
          userId,
          before,
          after,
          removed: before - after,
        });
      }
    }
  } catch (err) {
    // Non-fatal — log and continue with null rcd_types
    logger.warn('RCD type web search failed (non-fatal)', {
      userId,
      error: err.message,
    });
  }

  return analysis;
}

/**
 * Sonnet chunked audio extraction (Deepgram transcription + Claude Sonnet extraction)
 * POST /api/recording/sonnet-extract
 */
router.post('/recording/sonnet-extract', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const {
    sessionId,
    audio,
    audioMimeType,
    previousAudio,
    previousAudioMimeType,
    context,
    chunkIndex,
    chunkDuration,
  } = req.body;

  if (!audio || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields: audio, sessionId' });
  }

  // Rate limiting: 20 chunks/minute per user, 200 chunks per session
  const now = Date.now();
  let limits = sonnetChunkLimits.get(userId);
  if (!limits || now - limits.windowStart > 60_000) {
    limits = { count: 0, windowStart: now, sessionChunks: limits?.sessionChunks || new Map() };
    sonnetChunkLimits.set(userId, limits);
  }
  limits.count++;
  if (limits.count > 20) {
    logger.warn('Sonnet extract rate limited', { userId, sessionId, count: limits.count });
    return res.status(429).json({ error: 'Rate limited: max 20 chunks/minute' });
  }

  const sessionCount = (limits.sessionChunks.get(sessionId) || 0) + 1;
  limits.sessionChunks.set(sessionId, sessionCount);
  if (sessionCount > 200) {
    logger.warn('Sonnet extract session limit', { userId, sessionId, sessionCount });
    return res.status(429).json({ error: 'Session limit: max 200 chunks per session' });
  }

  // Session awareness (for debug audio + transcript accumulation)
  const session = getActiveSession(sessionId);
  if (session) {
    session.lastActivity = Date.now();
    session.chunksReceived++;
  }

  // Save raw audio chunk to S3 for debugging
  try {
    const ext = (audioMimeType || 'audio/flac').includes('flac')
      ? 'flac'
      : (audioMimeType || '').includes('wav')
        ? 'wav'
        : (audioMimeType || '').includes('mp4') || (audioMimeType || '').includes('m4a')
          ? 'm4a'
          : 'bin';
    const chunkKey = `debug/${userId}/${sessionId}/chunk_${String(chunkIndex ?? 0).padStart(3, '0')}.${ext}`;
    const audioBuffer = Buffer.from(audio, 'base64');
    storage.uploadBytes(audioBuffer, chunkKey, audioMimeType || 'audio/flac').catch((e) => {
      logger.warn('Failed to save debug audio chunk', { chunkKey, error: e.message });
    });
  } catch (e) {
    logger.warn('Debug audio chunk save error', { error: e.message });
  }

  try {
    const result = await sonnetExtractFromAudio(
      audio,
      audioMimeType || 'audio/flac',
      context || '',
      previousAudio || null,
      previousAudioMimeType || null
    );

    const transcript = result.transcript || '';

    // Debug audio capture — keyword detection (mirrors standard chunk handler)
    if (session) {
      if (session.debugMode && DEBUG_END.test(transcript)) {
        const debugText = transcript.replace(DEBUG_END, '').trim();
        if (debugText) session.debugBuffer += ' ' + debugText;

        session.debugSegments.push({
          transcript: session.debugBuffer.trim(),
          startedAt: session.debugStartTime,
          endedAt: new Date().toISOString(),
        });

        session.fullTranscript = session.preDebugContext;
        session.debugMode = false;
        session.debugBuffer = '';

        logger.info('── DEBUG MODE ENDED (Sonnet) ──', {
          sessionId,
          chunkIndex,
          segmentCount: session.debugSegments.length,
          segmentLength: session.debugSegments[session.debugSegments.length - 1].transcript.length,
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: '(debug exit)',
          isDebugChunk: true,
          modelUsed: 'sonnet-extract',
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        return res.json({
          ...result,
          transcript: '',
          circuits: [],
          supply: null,
          installation: null,
          board: null,
          orphaned_values: [],
          debug_mode: false,
          debug_segment_complete: true,
        });
      }

      if (session.debugMode) {
        session.debugBuffer += ' ' + transcript;
        logger.info('── DEBUG MODE — buffering (Sonnet) ──', {
          sessionId,
          chunkIndex,
          debugBufferLength: session.debugBuffer.length,
          preview: transcript.substring(0, 100),
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || '(empty)',
          isDebugChunk: true,
          modelUsed: 'sonnet-extract',
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        return res.json({
          ...result,
          transcript: '',
          circuits: [],
          supply: null,
          installation: null,
          board: null,
          orphaned_values: [],
          debug_mode: true,
        });
      }

      if (DEBUG_START.test(transcript)) {
        session.preDebugContext = session.fullTranscript;
        session.debugMode = true;
        session.debugStartTime = new Date().toISOString();
        session.debugBuffer = '';

        const parts = transcript.split(DEBUG_START);
        const beforeDebug = parts[0]?.trim() || '';
        const afterDebug = parts.slice(1).join(' ').trim() || '';
        if (afterDebug) session.debugBuffer = afterDebug;

        logger.info('── DEBUG MODE STARTED (Sonnet) ──', {
          sessionId,
          chunkIndex,
          beforeDebug: beforeDebug.substring(0, 100),
          afterDebug: afterDebug.substring(0, 100),
        });

        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || '(empty)',
          isDebugChunk: true,
          modelUsed: 'sonnet-extract',
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });

        if (!beforeDebug) {
          return res.json({
            ...result,
            transcript: '',
            circuits: [],
            supply: null,
            installation: null,
            board: null,
            orphaned_values: [],
            debug_mode: true,
          });
        }

        session.fullTranscript += (session.fullTranscript ? ' ' : '') + beforeDebug;
      }

      if (!session.debugMode && transcript) {
        session.fullTranscript += (session.fullTranscript ? ' ' : '') + transcript;
      }

      if (!session.debugMode || !DEBUG_START.test(transcript)) {
        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || '(empty)',
          isDebugChunk: false,
          modelUsed: 'sonnet-extract',
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
      }
    }

    logger.info('Sonnet extract chunk', {
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
    logger.error('Sonnet extract failed', {
      userId,
      sessionId,
      chunkIndex,
      error: error.message,
    });
    res.status(500).json({ error: 'Extraction failed: ' + error.message });
  }
});

/**
 * Reassemble the object-shape returned by the pre-split orchestrators
 * (`extractCcuGeometric` / `extractCcuRewireable`) from the prepare + classify
 * halves used by the parallel route handler.
 *
 * Preserves the EXACT top-level field set, schemaVersion, timings, stageOutputs,
 * usage etc. so the sidecar S3 upload, merger, and logging all see the same
 * object they did before the Stage 3 || Stage 4 parallelism refactor.
 *
 * @param {object} perSlotState
 * @param {object} perSlotState.prepared   Output of prepareXXXGeometry.
 * @param {object|null} perSlotState.classified  Output of classifyXXXSlots (or null if Stage 3 soft-failed).
 * @param {boolean} perSlotState.isRewireablePipeline
 * @returns {object|null} Same shape as extractCcuGeometric / extractCcuRewireable.
 */
export function assembleGeometricResult(perSlotState) {
  if (!perSlotState || !perSlotState.prepared) return null;
  const { prepared, classified, isRewireablePipeline } = perSlotState;

  // If classify bailed (caught & returned null) we still ship the prepared
  // geometry + an explicit stage3Error placeholder so the merger / sidecar
  // path knows Stage 3 didn't produce slots.
  const cls = classified || {
    slots: null,
    stage3Error: 'classifyXXXSlots returned null',
    timings: { stage3Ms: 0 },
    usage: { inputTokens: 0, outputTokens: 0 },
    stageOutputs: {
      stage3: {
        slots: null,
        error: 'classifyXXXSlots returned null',
        batchCount: 0,
        batchSize: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
    lowConfidence: false,
  };

  const totalUsage = {
    inputTokens: prepared.usage.inputTokens + cls.usage.inputTokens,
    outputTokens: prepared.usage.outputTokens + cls.usage.outputTokens,
  };

  const timings = {
    stage1Ms: prepared.timings.stage1Ms,
    stage2Ms: prepared.timings.stage2Ms,
    stage3Ms: cls.timings.stage3Ms,
    totalMs: prepared.timings.stage1Ms + prepared.timings.stage2Ms + cls.timings.stage3Ms,
  };

  if (isRewireablePipeline) {
    // Overall lowConfidence combines Stage 1 SD + any Stage 3 per-slot floor hit.
    const lowConfidence = prepared.stageOutputs.stage1.lowConfidence || !!cls.lowConfidence;

    return {
      schemaVersion: 'ccu-rewireable-v1',
      panelBounds: prepared.panelBounds,
      carrierCount: prepared.carrierCount,
      slotCentersX: prepared.slotCentersX,
      carrierPitch: prepared.carrierPitchPx,
      mainSwitchSide: prepared.mainSwitchSide,
      mainSwitchOffset: prepared.mainSwitchOffset,
      mainSwitchSlotIndex: prepared.mainSwitchSlotIndex,
      slots: cls.slots,
      lowConfidence,
      stage3Error: cls.stage3Error,
      imageWidth: prepared.imageWidth,
      imageHeight: prepared.imageHeight,
      timings,
      usage: totalUsage,
      stageOutputs: {
        stage1: prepared.stageOutputs.stage1,
        stage2: prepared.stageOutputs.stage2,
        stage3: cls.stageOutputs.stage3,
      },
    };
  }

  // Modern pipeline shape.
  return {
    schemaVersion: 'ccu-geometric-v1',
    medianRails: prepared.medianRails,
    moduleCount: prepared.moduleCount,
    vlmCount: prepared.vlmCount,
    slotCentersX: prepared.slotCentersX,
    moduleWidth: prepared.moduleWidth,
    mainSwitchCenterX: prepared.mainSwitchCenterX,
    mainSwitchWidth: prepared.mainSwitchWidth,
    lowConfidence: prepared.lowConfidence,
    disagreement: prepared.disagreement,
    railBbox: prepared.railBbox ?? null,
    pitchSource: prepared.pitchSource ?? null,
    cvPitchDiag: prepared.cvPitchDiag ?? null,
    pitchCrossCheck: prepared.pitchCrossCheck ?? null,
    chunkingDiag: prepared.chunkingDiag ?? null,
    imageWidth: prepared.imageWidth,
    imageHeight: prepared.imageHeight,
    slots: cls.slots,
    stage3Error: cls.stage3Error,
    timings,
    usage: totalUsage,
    stageOutputs: {
      stage1: prepared.stageOutputs.stage1,
      stage2: prepared.stageOutputs.stage2,
      stage3: cls.stageOutputs.stage3,
    },
  };
}

/**
 * Small, fast VLM call that returns board-level metadata (no per-circuit data).
 *
 * Returns: board_technology (routes the per-slot pipeline modern vs rewireable),
 * main_switch_position (drives BS-7671 circuit numbering), board_manufacturer +
 * board_model (used for RCD-type lookup against the manufacturer datasheet),
 * main_switch_rating (cert field), spd_present (cert field; cross-checked against
 * Stage 3 slot classifications which can also flag an SPD by its module shape).
 *
 * Single-shot Sonnet was retired 2026-04-29 — it ran a 130-line full-board prompt
 * for ~46s every extraction to produce these same five fields plus a circuits[]
 * that the per-slot merger immediately overwrote anyway. Folding board metadata
 * into this small fast classifier (~5s) drops wall-clock from ~47s → ~21s and
 * cost from ~$0.10 → ~$0.04 per extraction.
 *
 * @param {string} base64 — base64-encoded JPEG
 * @param {object} anthropic — Anthropic client
 * @param {string} model — model id (e.g. claude-sonnet-4-6)
 * @returns {Promise<{boardTechnology:string, technologyOverride:(null|{appliedBy:string,fromVlm:string,toTechnology:string,series:string,matchedPattern:string}), mainSwitchPosition:string, boardManufacturer:(string|null), boardModel:(string|null), mainSwitchRating:(string|null), spdPresent:boolean, confidence:number, usage:{inputTokens:number,outputTokens:number}}>}
 *
 * If `boardTechnology` was forced from a VLM-issued `rewireable_fuse |
 * cartridge_fuse | mixed` to `modern` because the `boardModel` matched a
 * known DIN-rail consumer-unit series (see board-model-registry.js),
 * `technologyOverride` is populated with provenance for diagnostic logging.
 * Otherwise it is null.
 */
export async function classifyBoardTechnology(base64, anthropic, model) {
  const prompt = `Look at this UK fuseboard photo and extract board-level metadata. Return ONLY a JSON object:
{"board_technology": "modern" | "rewireable_fuse" | "cartridge_fuse" | "mixed", "main_switch_position": "left" | "right" | "none", "board_manufacturer": string|null, "board_model": string|null, "main_switch_rating": string|null, "spd_present": boolean, "confidence": 0.0-1.0}

board_technology:
- "modern" — MCBs/RCBOs on DIN rail with toggle levers. ANY board with at least one toggle-style MCB showing a trip-curve letter (B/C/D) IS modern.
- "rewireable_fuse" — pull-out fuse carriers with semi-enclosed fuse wire (BS 3036). Wylex/MEM/Crabtree/Bill/Ashley. Carrier BODIES are colour-coded (white/blue/yellow/red/green) — the red "push to remove" tab at the top of every Wylex carrier is NOT a rating indicator. No toggles, no curve letters, no test buttons on circuit devices.
- "cartridge_fuse" — pull-out carriers that contain a cylindrical ceramic HBC cartridge (BS 1361 / BS 88). No rewireable fuse wire visible; cartridge face usually stamped with amp rating.
- "mixed" — combination (rewireable carriers plus a retrofitted 30mA RCD main switch, or some MCBs and some fuse carriers on the same panel).

main_switch_position: which side of the circuit devices the main isolator / pull-out switch-fuse sits — "left", "right", or "none" (if inline with the circuit row with no clear handedness).

board_manufacturer: brand printed on the cover or main switch (e.g. "Wylex", "Hager", "MK", "Crabtree", "Schneider", "BG", "Eaton", "Contactum", "Chint", "Lewden"). Null if not legible.

board_model: model code printed on the cover or label (e.g. "NHRS12SL", "VML112", "LN5512", "CUCRB12W"). Null if not legible.

main_switch_rating: amp rating of the main switch / isolator as a number-only string (e.g. "100", "80", "63"). Read from the device face — "100A AC22A", "WS100", etc. Null if unreadable.

spd_present: true if a Surge Protection Device module is visible on the rail (status indicator window, no toggle, typically 2-3 modules wide, often labelled "SPD" or with a green/red status indicator). False otherwise. Rewireable-fuse boards almost never have an SPD.

confidence: your overall confidence in the metadata you extracted, 0.0-1.0.

Return ONLY the JSON object.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const textBlocks = (response.content || []).filter((b) => b.type === 'text');
  let raw = textBlocks
    .map((b) => b.text)
    .join('')
    .trim();

  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  } else {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) raw = raw.slice(first, last + 1);
  }

  const parsed = JSON.parse(raw);
  // Normalise main_switch_rating to a numeric string ("100A" → "100", "80 amp" → "80").
  // EICR cert field expects amps as a bare number; the prompt asks for a number-only
  // string but VLMs sometimes append units. Strip non-digits, drop empties.
  const rawRating =
    typeof parsed.main_switch_rating === 'string' ? parsed.main_switch_rating.trim() : null;
  let mainSwitchRating = null;
  if (rawRating) {
    const digits = rawRating.match(/\d+/);
    if (digits) mainSwitchRating = digits[0];
  }

  const boardManufacturer =
    typeof parsed.board_manufacturer === 'string' && parsed.board_manufacturer.trim()
      ? parsed.board_manufacturer.trim()
      : null;
  const boardModel =
    typeof parsed.board_model === 'string' && parsed.board_model.trim()
      ? parsed.board_model.trim()
      : null;

  // Model-prefix override: the same VLM call returns both a fuzzy
  // `board_technology` label and a precise `board_model` string. When they
  // disagree (2026-05-01: Wylex NHRS12SL labelled "mixed" with conf 0.92,
  // routing into the rewireable pipeline and producing zero RCD-protected
  // circuits on a high-integrity board) we trust the model identification.
  // The override only ever forces "modern" — it cannot downgrade a
  // VLM-issued "modern" or upgrade an unmatched model. See
  // src/extraction/board-model-registry.js for the supported series.
  const vlmTechnology = parsed.board_technology || 'modern';
  let boardTechnology = vlmTechnology;
  let technologyOverride = null;
  if (vlmTechnology !== 'modern') {
    const inferred = inferTechnologyFromModel({ boardModel, boardManufacturer });
    if (inferred && inferred.technology === 'modern') {
      boardTechnology = 'modern';
      technologyOverride = {
        appliedBy: 'model-prefix-match',
        fromVlm: vlmTechnology,
        toTechnology: 'modern',
        series: inferred.series,
        matchedPattern: inferred.matchedPattern,
      };
    }
  }

  return {
    boardTechnology,
    technologyOverride,
    mainSwitchPosition: parsed.main_switch_position || 'none',
    boardManufacturer,
    boardModel,
    mainSwitchRating,
    spdPresent: parsed.spd_present === true,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

/**
 * Build an EICR-schema `circuits[]` array from per-slot VLM classifications.
 *
 * Per-slot is the sole source of truth for circuit-level data:
 *   - Device fields (ocpd_*, rcd_*, is_rcbo) come from Stage 3 classification.
 *   - Labels come from Stage 4 (`slot.label`) — a separate per-crop label-
 *     reading pass that looks at a wider-Y crop around each slot. Stage 4
 *     uses the crop-and-classify principle instead of forcing the single-
 *     shot LLM to reason about the whole board at once, which is inherently
 *     unreliable (confirmed 2026-04-22 on a Wylex rewireable — single-shot
 *     mislabeled the Shower carrier even after count was right).
 *   - Single-shot is NOT consulted here. Its output remains the source of
 *     board-level metadata (main switch, SPD, board manufacturer, overall
 *     confidence, questionsForInspector) only — anything that genuinely
 *     requires whole-board context.
 *
 * Low-confidence or "unknown" slots are emitted with the slot's best-effort
 * reading and a `low_confidence: true` marker. UI consumers surface that as
 * "confirm this row" rather than silently overwriting with an equally-
 * unreliable whole-board guess. The paired `slots[]` entry on the response
 * carries the numeric confidence score for fine-grained reliability UI.
 *
 * Circuit numbering follows BS 7671: circuit 1 is the device nearest the
 * main switch, numbering OUTWARD. When `mainSwitchSide === 'right'` we
 * iterate the physical-order slot array in reverse.
 *
 * @returns {Array|null} circuits array, or null if slots is empty/invalid.
 */
export function slotsToCircuits({ slots, mainSwitchSide, minSlotConfidence = 0.7 }) {
  if (!Array.isArray(slots) || slots.length === 0) return null;

  // --- Pre-pass: compute per-slot effective upstream RCD in PHYSICAL order
  //
  // Cascade flows from an RCD onto MCBs that sit physically downstream of
  // it on the rail. The main scan below iterates in scanOrder (which can
  // be reversed for right-handed boards to drive correct circuit
  // numbering), but cascade computation must follow physical adjacency
  // regardless of scan direction. Without this pre-pass, a board where
  // the RCD sits on the LEFT and the main switch on the RIGHT (e.g. 38
  // Dickens Close, 2026-04-28) would scan right-to-left and never see
  // the RCD until AFTER all the MCBs it protects had already been
  // emitted as unprotected — wrong rcd_protected flags throughout.
  //
  // The cascade BREAKS at any non-MCB position (blank, empty, main_switch,
  // spd) per Derek's 2026-04-28 design: a run of spares between the RCD-
  // protected MCBs and the unprotected MCBs is a hard boundary. MCBs
  // after the spares are NOT inheriting RCD protection from upstream.
  // RCDs themselves overwrite cascade with their own type/sensitivity.
  //
  // RCBOs are NOT considered MCBs for cascade purposes — they have their
  // own integral RCD function and don't need upstream protection. We
  // still compute the cascade slot-by-slot; downstream buildCircuitFromSlot
  // is the place that decides whether to apply rcd_* fields, based on
  // is_rcbo. So the pre-pass simply exposes _effectiveUpstreamRcd for
  // every slot and lets buildCircuitFromSlot do the right thing.
  let cascade = null;
  let prevWasRcd = false;
  for (const s of slots) {
    const cls = (s.classification || '').toLowerCase();
    const content = typeof s.content === 'string' ? s.content : 'device';
    if (cls === 'rcd') {
      const newType = s.rcdWaveformType || null;
      const newSens = s.sensitivity != null && s.sensitivity !== '' ? String(s.sensitivity) : null;
      if (prevWasRcd && cascade) {
        // Adjacent RCD slot = the second module of the SAME 2-module
        // physical RCD device. Merge fields, preferring whichever face
        // read came back non-null (gap-fill — the second slot may carry
        // info the first missed and vice versa). DO NOT overwrite a
        // populated cascade with the second slot's nulls. Mirrors the
        // existing main-loop dedupe at the rcd-pair-open branch.
        cascade = {
          type: cascade.type || newType,
          sensitivity: cascade.sensitivity || newSens,
        };
      } else {
        cascade = { type: newType, sensitivity: newSens };
      }
      prevWasRcd = true;
    } else if (
      cls === 'main_switch' ||
      cls === 'spd' ||
      cls === 'blank' ||
      cls === 'empty' ||
      content === 'empty'
    ) {
      // Cascade BREAKS at any non-MCB/RCBO position. Subsequent MCBs are
      // not RCD-protected (until/unless another RCD slot appears).
      cascade = null;
      prevWasRcd = false;
    } else {
      // mcb / rcbo / unknown / partial → keep current cascade unchanged.
      prevWasRcd = false;
    }
    s._effectiveUpstreamRcd = cascade;
  }

  const scanOrder = mainSwitchSide === 'right' ? [...slots].reverse() : [...slots];
  const circuits = [];
  let circuitNumber = 1;
  let upstreamRcd = null;

  for (const slot of scanOrder) {
    const cls = (slot.classification || '').toLowerCase();
    const content = typeof slot.content === 'string' ? slot.content : 'device';
    const extendsSide = typeof slot.extends === 'string' ? slot.extends : 'none';

    if (cls === 'main_switch' || cls === 'spd') continue;

    // Neighbour reconciliation for partial-crop RCD slots.
    //
    // Original intent: catch slots where a 2-module RCD's second half is
    // classified as content="partial" with extends pointing at the
    // already-emitted row, drop it silently instead of emitting a phantom
    // low-confidence duplicate.
    //
    // Codex review 2026-04-23 flagged two correctness traps in my earlier
    // version of this guard:
    //   1. Scan direction: `circuits[circuits.length - 1]` is the physical-
    //      left neighbour only when scanOrder is left-to-right. On right-
    //      handed boards scanOrder is reversed, so extends="left" (physical
    //      left) points at the NEXT slot not the previous one.
    //   2. "Previous row's family" couldn't be reliably derived from the
    //      emitted circuit's fields (ocpd_type stores trip curve, not
    //      device family), so the match check was unsafe for non-RCD rows.
    //
    // Both concerns are satisfied by restricting to cls="rcd": the existing
    // RCD-pair dedupe below (via _rcdPairOpen) already merges the second
    // 'rcd' slot into the first by MERGING readings (better than dropping),
    // regardless of scan direction. So anything we'd have dropped here
    // would be cleanly handled one branch down, and non-rcd cases never
    // needed this guard in the first place (MCBs / RCBOs are 1-module in
    // UK domestic; main_switch / spd are skipped above; empty / blank are
    // handled elsewhere). No standalone partial-dedupe needed.
    //
    // Keeping content + extendsSide in scope so the downstream "low
    // confidence / partial" branch can still flag partial slots for the
    // inspector's UI.

    // Exposed DIN rail (no device, no blanking plate). This is a safety
    // defect — live parts potentially accessible, IP4X violation. Emit as
    // a Spare row labelled "Exposed rail" with low_confidence=true so the
    // inspector's iOS editor flags it for a C2/C3 observation. Schema
    // added 2026-04-23 with the new content discriminator.
    if (content === 'empty' || cls === 'empty') {
      circuits.push({
        circuit_number: circuitNumber,
        label: 'Exposed rail (no device, no blank)',
        ocpd_type: null,
        ocpd_rating_a: null,
        ocpd_bs_en: null,
        ocpd_breaking_capacity_ka: null,
        is_rcbo: false,
        rcd_protected: false,
        rcd_type: null,
        rcd_rating_ma: null,
        rcd_bs_en: null,
        low_confidence: true,
        is_exposed_rail: true,
      });
      circuitNumber++;
      continue;
    }

    if (cls === 'rcd') {
      // Standalone RCD — two roles:
      //   1. Cascade its type/sensitivity to the circuits it protects
      //      (all subsequent non-RCBO circuits until the next RCD).
      //   2. Emit an own-row in the schedule so TradeCert's Schedule of Test
      //      Results shows the RCD's BS EN + rating/sensitivity alongside the
      //      MCBs it protects. `is_rcd_device: true` flags this row; it has
      //      no circuit_number. iOS decoders treat rows where is_rcd_device
      //      is truthy as a non-circuit schedule entry.
      //
      // DEDUPE: an RCD is ALWAYS 2 modules wide on UK boards (BS EN 61008-1),
      // so Stage 3 classifies two consecutive slots as "rcd" for the same
      // physical device. Only the FIRST slot of the pair emits a schedule
      // row; subsequent adjacent 'rcd' slots refresh the cascade (in case
      // the device face was only readable on the second slot) but do not
      // produce duplicate rows. If a non-rcd slot sits between two rcd
      // slots we treat them as two genuinely separate RCDs and emit two
      // rows — rare in practice but matches what the inspector sees.
      const nextUpstreamRcd = {
        type: slot.rcdWaveformType || null,
        sensitivity:
          slot.sensitivity != null && slot.sensitivity !== '' ? String(slot.sensitivity) : null,
      };

      const lastPushed = circuits[circuits.length - 1];
      const lastWasThisRcdPair = lastPushed?.is_rcd_device && lastPushed?._rcdPairOpen === true;

      if (lastWasThisRcdPair) {
        // Second slot of the same physical RCD — gap-fill any field the
        // first slot's VLM read couldn't recover (face-skew can leave one
        // module's reading stronger than the other) and close the pair.
        if (!lastPushed.ocpd_rating_a && slot.ratingAmps != null) {
          lastPushed.ocpd_rating_a = String(slot.ratingAmps);
        }
        if (!lastPushed.rcd_type && nextUpstreamRcd.type) {
          lastPushed.rcd_type = nextUpstreamRcd.type;
        }
        if (!lastPushed.rcd_rating_ma && nextUpstreamRcd.sensitivity) {
          lastPushed.rcd_rating_ma = nextUpstreamRcd.sensitivity;
        }
        delete lastPushed._rcdPairOpen;
        // Refresh cascade with the merged best-available values.
        upstreamRcd = {
          type: lastPushed.rcd_type || null,
          sensitivity: lastPushed.rcd_rating_ma || null,
        };
      } else {
        upstreamRcd = nextUpstreamRcd;
        // The RCD's schedule row ALWAYS carries the label "RCD". Stage 4's
        // label-pass reads the handwritten strip above/below each slot,
        // which reliably picks up bleed-in labels from neighbouring MCBs
        // (the RCD strip section itself has no handwriting — the strip
        // header already labels it as "RCD protected"). Defaulting to
        // slot.label would leak "Sockets" / "Kitchen Sockets" etc. into
        // the RCD row on every real-world board.
        circuits.push({
          circuit_number: null,
          label: 'RCD',
          is_rcd_device: true,
          ocpd_type: null,
          ocpd_rating_a:
            slot.ratingAmps != null && slot.ratingAmps !== '' ? String(slot.ratingAmps) : null,
          ocpd_bs_en: slot.bsEn || 'BS EN 61008-1',
          ocpd_breaking_capacity_ka: null,
          is_rcbo: false,
          rcd_protected: false,
          rcd_type: upstreamRcd.type,
          rcd_rating_ma: upstreamRcd.sensitivity,
          rcd_bs_en: slot.bsEn || 'BS EN 61008-1',
          // Internal marker stripped below; used only to merge the immediate
          // next 'rcd' slot into this row.
          _rcdPairOpen: true,
        });
      }
      continue;
    }

    // Partial crops (VLM saw only part of a wider device) are hallucination
    // hazards — the model can pattern-match a half-RCD to "B32 MCB" with
    // confidence. Force low_confidence on any content="partial" slot so the
    // inspector verifies, and tag `is_partial_crop` for UI awareness (iOS
    // can surface a specific "this crop was clipped" message). The merger
    // still emits the slot's best reading — we don't drop it, because if
    // the neighbour wasn't classified we'd lose the circuit entirely.
    const isPartial = content === 'partial';
    const confident = !isPartial && (slot.confidence ?? 0) >= minSlotConfidence;
    const slotLabel =
      slot.label != null && String(slot.label).trim().length > 0 ? slot.label : null;

    let circuit;
    if (cls === 'blank') {
      circuit = {
        circuit_number: circuitNumber,
        label: slotLabel || 'Spare',
        ocpd_type: null,
        ocpd_rating_a: null,
        ocpd_bs_en: null,
        ocpd_breaking_capacity_ka: null,
        is_rcbo: false,
        rcd_protected: false,
        rcd_type: null,
        rcd_rating_ma: null,
        rcd_bs_en: null,
      };
    } else if (cls === 'unknown' || !confident) {
      // Low-confidence / unknown / partial slot: emit the slot's best
      // reading and mark low_confidence. DO NOT fall back to single-shot —
      // we moved away from that because single-shot is the unreliable
      // whole-board reasoner we're replacing. UI surfaces low_confidence
      // so the inspector verifies.
      // Use the per-slot cascade computed in the physical-order pre-pass —
      // breaks at non-MCB positions so MCBs after a run of spares are
      // correctly unprotected. Falls back to the running `upstreamRcd` if
      // _effectiveUpstreamRcd hasn't been set (defensive — should never
      // happen since the pre-pass runs unconditionally above).
      circuit = buildCircuitFromSlot(
        slot,
        circuitNumber,
        slot._effectiveUpstreamRcd ?? upstreamRcd
      );
      circuit.label = slotLabel;
      circuit.low_confidence = true;
      if (isPartial) {
        circuit.is_partial_crop = true;
        circuit.extends_side = extendsSide;
      }
    } else {
      circuit = buildCircuitFromSlot(
        slot,
        circuitNumber,
        slot._effectiveUpstreamRcd ?? upstreamRcd
      );
      circuit.label = slotLabel;
    }

    // OCR cross-check rejected the rating — mark low_confidence so the
    // inspector verifies. Rating is already null from the parser.
    if (slot.ratingHallucinationDetected) {
      circuit.low_confidence = true;
      circuit.rating_hallucination_detected = true;
    }

    circuits.push(circuit);
    circuitNumber++;
  }

  // Strip any lingering `_rcdPairOpen` flag (the RCD was the last slot, so
  // the pair was never closed by a matching second module — still a valid
  // row, just internal book-keeping we don't want to leak to iOS).
  for (const c of circuits) {
    if (c._rcdPairOpen !== undefined) delete c._rcdPairOpen;
  }

  return circuits;
}

/**
 * Translate one high-confidence slot classification into an EICR-schema circuit row.
 * Device fields come from the slot; label is added separately by the caller
 * from the Stage 4 per-slot label pass (`slot.label`).
 */
export function buildCircuitFromSlot(slot, circuit_number, upstreamRcd) {
  const cls = (slot.classification || '').toLowerCase();
  const ratingAmps = slot.ratingAmps;

  let ocpd_type = null;
  let ocpd_bs_en = slot.bsEn || null;
  let ocpd_breaking_capacity_ka = null;

  if (cls === 'mcb' || cls === 'rcbo') {
    ocpd_type = slot.tripCurve || null;
    if (!ocpd_bs_en) ocpd_bs_en = cls === 'rcbo' ? '61009-1' : '60898-1';
    ocpd_breaking_capacity_ka = '6';
  } else if (cls === 'rewireable') {
    ocpd_type = 'Rew';
    if (!ocpd_bs_en) ocpd_bs_en = 'BS 3036';
    // rewireable fuses have no kA rating — leave null
  } else if (cls === 'cartridge') {
    ocpd_type = 'HRC';
    if (!ocpd_bs_en) ocpd_bs_en = 'BS 1361';
  }

  const is_rcbo = cls === 'rcbo';
  const rcd_protected = is_rcbo || !!upstreamRcd;
  const rcd_type = is_rcbo ? slot.rcdWaveformType || null : upstreamRcd?.type || null;
  const rcd_rating_ma = is_rcbo
    ? slot.sensitivity != null && slot.sensitivity !== ''
      ? String(slot.sensitivity)
      : null
    : upstreamRcd?.sensitivity || null;
  const rcd_bs_en = is_rcbo ? '61009' : upstreamRcd ? '61008' : null;

  return {
    circuit_number,
    label: null,
    ocpd_type,
    ocpd_rating_a: ratingAmps != null && ratingAmps !== '' ? String(ratingAmps) : null,
    ocpd_bs_en,
    ocpd_breaking_capacity_ka,
    is_rcbo,
    rcd_protected,
    rcd_type,
    rcd_rating_ma,
    rcd_bs_en,
  };
}

/**
 * Analyze a consumer unit (fuseboard) photo using GPT Vision
 * POST /api/analyze-ccu
 */
router.post(
  '/analyze-ccu',
  auth.requireAuth,
  upload.single('photo'),
  withIdempotency('ccu'),
  async (req, res) => {
    const tempPath = req.file?.path;
    const endpointStartMs = Date.now();

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No photo uploaded' });
      }

      if (req.file.size > CCU_MAX_UPLOAD_BYTES) {
        return res.status(413).json({
          error: 'payload_too_large',
          message: `Image exceeds ${Math.round(CCU_MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit`,
          retryable: false,
        });
      }

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.status(500).json({ error: 'Anthropic API key not configured' });
      }

      const model = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();

      // Parse the optional rail_roi hint from iOS. Shipped with the 2026-04-23
      // camera-overlay feature: iOS shows a framing rectangle on the capture
      // view, the inspector fits the MCB row into it, and sends the rectangle
      // coords as normalised (0-1) image-space ROI. Backend uses it as the
      // Stage 1 rail bbox directly — skipping the 3-sample VLM rail-detection
      // pass saves ~$0.03 and ~17s per extraction.
      //
      // Parse defensively: multipart fields are always strings; bad JSON or a
      // non-object must NOT fail the whole request (older iOS builds don't
      // send this field, and any malformed value should silently fall back
      // to the VLM rail-detection path).
      let railRoiHint = null;
      if (typeof req.body?.rail_roi === 'string' && req.body.rail_roi.trim().length > 0) {
        try {
          const parsed = JSON.parse(req.body.rail_roi);
          if (parsed && typeof parsed === 'object') {
            railRoiHint = parsed;
            logger.info('CCU rail_roi hint received', {
              userId: req.user.id,
              roi: railRoiHint,
            });
          }
        } catch (err) {
          logger.warn('CCU rail_roi hint invalid JSON (ignored)', {
            userId: req.user.id,
            err: err.message,
            raw: String(req.body.rail_roi).slice(0, 200),
          });
        }
      }

      logger.info('CCU photo analysis requested', {
        userId: req.user.id,
        fileSize: req.file.size,
        model,
        railRoiHint: !!railRoiHint,
      });

      // Resize image if base64 would exceed Anthropic's 5MB limit (~3.75MB raw)
      const MAX_BASE64_BYTES = 5 * 1024 * 1024;
      const MAX_RAW_BYTES = Math.floor(MAX_BASE64_BYTES * 0.74); // ~3.7MB raw → <5MB base64
      let imageBytes = await fs.readFile(tempPath);

      if (imageBytes.length > MAX_RAW_BYTES) {
        logger.info('CCU image too large for API, resizing with sharp', {
          originalBytes: imageBytes.length,
          maxBytes: MAX_RAW_BYTES,
        });
        imageBytes = await sharp(imageBytes)
          .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        logger.info('CCU image resized', { newBytes: imageBytes.length });
      }

      const base64 = Buffer.from(imageBytes).toString('base64');

      // Per-slot pipeline (sprint 2026-04-22, single-shot retired 2026-04-29):
      //   1. Build the Anthropic client ONCE up front.
      //   2. Run the board classifier — extended on 2026-04-29 to return
      //      board_manufacturer, board_model, main_switch_rating and
      //      spd_present alongside its original board_technology +
      //      main_switch_position. Single-shot's only unique outputs were
      //      these fields (everything else duplicated per-slot work) and
      //      single-shot was the wall-clock long pole at ~46s; extending
      //      this fast call to ~5s replaced it without a new round-trip.
      //   3. Kick off the matching PREPARE pipeline (Stage 1 + 2 only) —
      //      modern -> prepareModernGeometry, rewireable/cartridge/mixed ->
      //      prepareRewireableGeometry. "mixed" uses the rewireable path
      //      because that module also handles retrofitted RCD main switches.
      //   4. After geometry is prepared, dispatch Stage 3 (classifyXXXSlots)
      //      and Stage 4 (extractSlotLabels) IN PARALLEL via Promise.all.
      //   5. Build the `analysis` object from classifier output + slots[]
      //      via slotsToCircuits, then run the BS-EN / label normalisation
      //      / RCD-type-lookup enrichers as before.
      //
      // Failure mode: per-slot is now the ONLY path, so prepare/classify
      // failures bubble up as 502s. There's no single-shot safety net any
      // more — better to fail loudly than ship circuit data we don't trust.
      // Wall-clock target ~21s (Stage 4 long pole), cost ~$0.04/extraction.

      // Build the Anthropic SDK client ONCE; reuse for classifier + per-slot.
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: anthropicKey });

      // --- Stage 1: classifier (board metadata) ---
      // Extended 2026-04-29 to also produce board_manufacturer, board_model,
      // main_switch_rating and spd_present (previously only single-shot
      // produced those). ~5s, ~$0.01.
      const anthropicStartMs = Date.now();
      let boardClassification;
      let classifierUsage = { inputTokens: 0, outputTokens: 0 };
      try {
        boardClassification = await classifyBoardTechnology(base64, anthropic, model);
        classifierUsage = boardClassification.usage || classifierUsage;
        logger.info('CCU board_technology classifier', {
          userId: req.user.id,
          boardTechnology: boardClassification.boardTechnology,
          technologyOverride: boardClassification.technologyOverride,
          mainSwitchPosition: boardClassification.mainSwitchPosition,
          boardManufacturer: boardClassification.boardManufacturer,
          boardModel: boardClassification.boardModel,
          mainSwitchRating: boardClassification.mainSwitchRating,
          spdPresent: boardClassification.spdPresent,
          confidence: boardClassification.confidence,
        });
      } catch (err) {
        logger.error('CCU board classifier failed — no per-slot path possible', {
          userId: req.user.id,
          error: err.message,
        });
        return res.status(502).json({
          error: `Board classification failed: ${err.message}. Try a clearer photo or retry.`,
        });
      }

      // --- Stage 2: prepare geometry (Stage 1 of geometric pipeline + bbox) ---
      const chooseRewireable =
        boardClassification.boardTechnology === 'rewireable_fuse' ||
        boardClassification.boardTechnology === 'cartridge_fuse' ||
        boardClassification.boardTechnology === 'mixed';

      // Feature flag: CCU_BOX_TIGHTEN switches the modern-board geometry
      // path to the new box-tightener + multi-anchor pitch refinement
      // (src/extraction/ccu-box-tighten.js). Only fires on the modern
      // path AND when a railRoiHint is present (algorithm needs the
      // user box as a starting point). Default ON. Falls back to the
      // existing prepareModernGeometry on any tightener error so an
      // algorithm bug can never block extraction.
      const boxTightenEnabled = (process.env.CCU_BOX_TIGHTEN ?? 'true').toLowerCase() === 'true';
      let prepared;
      let preparedSource = 'modern-vlm';
      try {
        if (chooseRewireable) {
          prepared = await prepareRewireableGeometry(imageBytes);
          preparedSource = 'rewireable';
        } else if (boxTightenEnabled && railRoiHint) {
          try {
            const tightened = await tightenAndChunk(imageBytes, railRoiHint);
            prepared = adaptTightenerToPrepared(tightened);
            preparedSource = 'box-tightener';
            logger.info('CCU box-tightener used', {
              userId: req.user.id,
              moduleCount: tightened.moduleCount,
              pitchPx: Math.round(tightened.pitchPx * 10) / 10,
              initialPitchPx: tightened.initialPitchPx,
              refinementAccepted: tightened.refinement.accepted,
              pairCount: tightened.refinement.pairCount,
            });
          } catch (tightenErr) {
            logger.warn('CCU box-tightener failed; falling back to modern VLM', {
              userId: req.user.id,
              error: tightenErr.message,
            });
            prepared = await prepareModernGeometry(imageBytes, { railRoiHint });
          }
        } else {
          prepared = await prepareModernGeometry(imageBytes, { railRoiHint });
        }
      } catch (err) {
        logger.error('CCU geometric prepare failed', {
          userId: req.user.id,
          path: chooseRewireable ? 'rewireable' : 'modern',
          error: err.message,
        });
        return res.status(502).json({
          error: `Could not detect device row in photo: ${err.message}. Frame the consumer unit so all MCBs are visible and retry.`,
        });
      }

      // --- Stage 3 || Stage 4 in parallel ---
      // Stage 4 used to be gated on Stage 3 output (skip hint for
      // main_switch/spd/blank); dropping the skip costs ~1-2 extra label
      // crops vs. saving ~10-15s of serial wait, so we run both in parallel.
      // The merger filters main_switch/spd by classification anyway so extra
      // labels never surface in circuits[].
      const panelTopNorm = prepared.panelBounds?.top ?? prepared.medianRails?.rail_top ?? null;
      const panelBottomNorm =
        prepared.panelBounds?.bottom ?? prepared.medianRails?.rail_bottom ?? null;

      // Coordinate-space detection (Codex P1 commit f2e304d): modern
      // pipeline's slotCentersX/moduleWidth are 0-1000 normalised,
      // rewireable's are PIXELS. extractSlotLabels requires PIXELS. Convert
      // for modern, pass-through for rewireable. Detection via
      // carrierPitchPx (rewireable) vs moduleWidth (modern).
      const isRewireablePipeline = typeof prepared.carrierPitchPx === 'number';
      const imageWidthForConvert = prepared.imageWidth || 0;
      const convertNormToPx = (v) =>
        typeof v === 'number' && imageWidthForConvert > 0
          ? Math.round((v / 1000) * imageWidthForConvert)
          : null;

      const labelGeom = {
        slotCentersX: isRewireablePipeline
          ? prepared.slotCentersX
          : (prepared.slotCentersX || []).map((v) => convertNormToPx(v)),
        slotPitchPx: isRewireablePipeline
          ? prepared.carrierPitchPx
          : convertNormToPx(prepared.moduleWidth),
        panelTopNorm,
        panelBottomNorm,
        imageWidth: prepared.imageWidth,
        imageHeight: prepared.imageHeight,
        slotsForSkipHint: null,
      };

      const labelGeomValid =
        Number.isFinite(labelGeom.slotPitchPx) &&
        Number.isFinite(labelGeom.panelTopNorm) &&
        Number.isFinite(labelGeom.panelBottomNorm);

      const classifyFn = isRewireablePipeline ? classifyRewireableSlots : classifyModernSlots;
      const classifyPromise = classifyFn(imageBytes, prepared).catch((err) => {
        logger.warn('CCU per-slot classify failed (non-fatal)', {
          userId: req.user.id,
          path: isRewireablePipeline ? 'rewireable' : 'modern',
          error: err.message,
        });
        return null;
      });
      const labelPromise = labelGeomValid
        ? extractSlotLabels(imageBytes, labelGeom).catch((err) => {
            logger.warn('CCU stage4 label pass failed (non-fatal)', {
              userId: req.user.id,
              error: err.message,
            });
            return { __error: err.message };
          })
        : Promise.resolve(null);

      const [classified, labelPassResult] = await Promise.all([classifyPromise, labelPromise]);

      const perSlotState = {
        prepared,
        classified,
        labelPassResult,
        chooseRewireable,
        isRewireablePipeline,
        labelGeomValid,
      };

      const anthropicElapsedMs = Date.now() - anthropicStartMs;
      logger.info('CCU Anthropic API call timing', {
        userId: req.user.id,
        model,
        elapsedMs: anthropicElapsedMs,
        elapsedSec: (anthropicElapsedMs / 1000).toFixed(1),
      });

      // --- Build analysis from classifier + per-slot output ---
      // The single-shot Sonnet call (retired 2026-04-29) used to populate
      // this object directly from a 4096-token JSON response. Now we
      // assemble it from Stage 1 board metadata + Stage 3/4 (which fill
      // analysis.circuits via slotsToCircuits below). Field names match
      // the legacy single-shot contract — iOS, web, and downstream
      // enrichers (applyBsEnFallback, normaliseCircuitLabels,
      // lookupMissingRcdTypes) all expect the same keys.
      let analysis = {
        board_manufacturer: boardClassification.boardManufacturer,
        board_model: boardClassification.boardModel,
        board_technology: boardClassification.boardTechnology,
        main_switch_position: boardClassification.mainSwitchPosition,
        main_switch_rating: boardClassification.mainSwitchRating,
        main_switch_current: boardClassification.mainSwitchRating,
        main_switch_bs_en: null,
        main_switch_type: null,
        main_switch_poles: null,
        main_switch_voltage: null,
        spd_present: boardClassification.spdPresent,
        spd_bs_en: null,
        spd_type: null,
        spd_rated_current_a: null,
        spd_short_circuit_ka: null,
        confidence: {
          overall: boardClassification.confidence,
          image_quality: 'partially_readable',
          uncertain_fields: [],
          message: null,
        },
        questionsForInspector: [],
        circuits: [],
      };

      // Per-slot is the only source now (single-shot retired 2026-04-29).
      // Assemble geometricResult from the prepared + classified halves
      // already gathered above so the sidecar / merger / logging paths see
      // the same shape they did before the prepare/classify split.
      let extractionSource = 'classifier-only';
      const geometricResult = perSlotState ? assembleGeometricResult(perSlotState) : null;

      if (geometricResult) {
        // Attach geometry — shape varies slightly by pipeline.
        // The modern pipeline returns medianRails (DIN rail); the rewireable
        // pipeline returns panelBounds (carrier-bank rectangle). Both populate
        // slotCentersX so iOS overlay code can render regardless of source.
        analysis.geometric = {
          schemaVersion: geometricResult.schemaVersion,
          moduleCount: geometricResult.moduleCount ?? geometricResult.carrierCount ?? null,
          vlmCount: geometricResult.vlmCount ?? null,
          disagreement: geometricResult.disagreement ?? null,
          lowConfidence: geometricResult.lowConfidence,
          medianRails: geometricResult.medianRails ?? null,
          panelBounds: geometricResult.panelBounds ?? null,
          slotCentersX: geometricResult.slotCentersX,
          moduleWidth: geometricResult.moduleWidth ?? geometricResult.carrierPitch ?? null,
          mainSwitchWidth: geometricResult.mainSwitchWidth ?? null,
          mainSwitchCenterX: geometricResult.mainSwitchCenterX ?? null,
          mainSwitchSide: geometricResult.mainSwitchSide ?? null,
          imageWidth: geometricResult.imageWidth,
          imageHeight: geometricResult.imageHeight,
          pitchSource: geometricResult.pitchSource ?? null,
          cvPitchDiag: geometricResult.cvPitchDiag ?? null,
        };

        // Expose per-slot classifications to iOS (LiveFillState.slotCrops).
        if (Array.isArray(geometricResult.slots) && geometricResult.slots.length > 0) {
          analysis.slots = geometricResult.slots;

          // Stage 4 label-pass result was fetched in parallel with Stage 3
          // via Promise.all earlier in the handler. Three possible shapes:
          //   - { labels: [...], usage: {...}, timings: {...} } — success
          //   - { __error: msg } — VLM threw; we already logged it
          //   - null — labelGeom was invalid; we already warned
          const labelPassResult = perSlotState.labelPassResult;
          if (
            labelPassResult &&
            !labelPassResult.__error &&
            Array.isArray(labelPassResult.labels)
          ) {
            // Attach labels onto the slots[] array by slotIndex so iOS and
            // slotsToCircuits both see them.
            const labelBySlotIndex = new Map(labelPassResult.labels.map((l) => [l.slotIndex, l]));
            analysis.slots = geometricResult.slots.map((slot) => {
              const lab = labelBySlotIndex.get(slot.slotIndex);
              return lab
                ? {
                    ...slot,
                    label: lab.label ?? null,
                    labelRaw: lab.rawLabel ?? null,
                    labelConfidence: lab.confidence,
                  }
                : slot;
            });
            logger.info('CCU stage4 label pass complete', {
              userId: req.user.id,
              labelCount: labelPassResult.labels.length,
              labelsRead: labelPassResult.labels.filter((l) => l.label != null).length,
              skippedSlots: labelPassResult.skippedSlotIndices?.length ?? 0,
              vlmMs: labelPassResult.timings?.vlmMs,
              tokensIn: labelPassResult.usage?.inputTokens,
              tokensOut: labelPassResult.usage?.outputTokens,
            });
          } else if (labelPassResult && labelPassResult.__error) {
            analysis.label_pass_error = labelPassResult.__error;
          }

          // Merger: slot classifications + Stage 4 labels → circuits[].
          //
          // mainSwitchSide drives BS 7671 circuit numbering (circuit 1 =
          // nearest the main switch). Three independent sources, in
          // priority order:
          //
          //   1. Stage 3 found a `main_switch` slot — slot index gives the
          //      side directly (modern boards always tag the device row
          //      this way; rewireable inline-mains boards do too).
          //   2. Stage 2 mainSwitchOffset (rewireable pipeline only —
          //      identifies which carrier-row edge the integrated
          //      switch-fuse occupies on inline-mains boards).
          //   3. Stage 1 classifier's mainSwitchPosition.
          //
          // Stage 2's mainSwitchSide is no longer in the chain (the
          // groups-mode prompt no longer asks for main_switch_center_x as
          // of 2026-04-29).
          let mainSwitchSide = 'none';
          const stage3MainSwitchSlot = (analysis.slots || []).find(
            (s) => s?.classification === 'main_switch'
          );
          if (stage3MainSwitchSlot) {
            const halfwayIdx = (analysis.slots.length - 1) / 2;
            mainSwitchSide = stage3MainSwitchSlot.slotIndex >= halfwayIdx ? 'right' : 'left';
          } else if (geometricResult.mainSwitchOffset === 'right-edge') {
            mainSwitchSide = 'right';
          } else if (geometricResult.mainSwitchOffset === 'left-edge') {
            mainSwitchSide = 'left';
          } else if (
            boardClassification?.mainSwitchPosition === 'left' ||
            boardClassification?.mainSwitchPosition === 'right'
          ) {
            mainSwitchSide = boardClassification.mainSwitchPosition;
          }

          const mergedCircuits = slotsToCircuits({
            slots: analysis.slots,
            mainSwitchSide,
          });

          if (mergedCircuits && mergedCircuits.length > 0) {
            analysis.circuits = mergedCircuits;
            extractionSource = 'geometric-merged';

            // Cheap local enrichers — same lookup tables single-shot
            // used to rely on, now feeding Stage 3 output instead.
            // lookupMissingRcdTypes runs separately below (post-merge,
            // post-defaults).
            analysis = applyBsEnFallback(analysis);
            analysis = normaliseCircuitLabels(analysis);
          }

          // SPD presence: Stage 3 is the authority. If any slot was
          // classified as 'spd', override the classifier's hint to true.
          // Conversely if Stage 3 found NO spd slot, trust Stage 3 over
          // the classifier (Stage 3 examined every slot crop individually
          // — the classifier did a single board-level look). Only fall
          // back to the classifier value when Stage 3 produced no slots
          // at all.
          if (Array.isArray(analysis.slots) && analysis.slots.length > 0) {
            const stage3FoundSpd = analysis.slots.some((s) => s?.classification === 'spd');
            analysis.spd_present = stage3FoundSpd;
          }
        }

        // Stage outputs surfaced for production diagnostics: railBbox is
        // the rectangle the VLM returned (or the user's iOS ROI when
        // trustInputRails was set). pitchCrossCheck flags CV-vs-bbox
        // count drift. chunkingDiag exposes the raw inputs so a missed
        // count can be traced to bbox size, image dims, or pitch source.
        logger.info('CCU geometric extraction attached', {
          userId: req.user.id,
          moduleOrCarrierCount: analysis.geometric.moduleCount,
          slotCount: geometricResult.slots?.length ?? 0,
          lowConfidence: geometricResult.lowConfidence,
          stage3Error: geometricResult.stage3Error ?? null,
          extractionSource,
          railBbox: geometricResult.railBbox ?? null,
          pitchSource: geometricResult.pitchSource ?? null,
          cvPitchDiag: geometricResult.cvPitchDiag ?? null,
          pitchCrossCheck: geometricResult.pitchCrossCheck ?? null,
          chunkingDiag: geometricResult.chunkingDiag ?? null,
        });
      }

      // --- Post-merge enrichment + defaults ---
      // RCD type lookup (gpt-5-search-api): fills rcd_type for circuits where
      // Stage 3 couldn't read the waveform symbol. Skipped if OPENAI_API_KEY
      // is unset (dev / sandbox). Stage 3 is the authority for waveform-read
      // RCD types; this only fills gaps from missing/illegible markings.
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        const rcdStartMs = Date.now();
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: openaiKey });
        analysis = await lookupMissingRcdTypes(analysis, openai, logger, req.user.id);
        const rcdElapsedMs = Date.now() - rcdStartMs;
        logger.info('CCU RCD type lookup timing', {
          userId: req.user.id,
          elapsedMs: rcdElapsedMs,
          elapsedSec: (rcdElapsedMs / 1000).toFixed(1),
        });
      }

      // Main-switch field defaults — only fields the classifier doesn't
      // attempt (BS-EN, poles, voltage). UK domestic CUs are 99% DP @ 230V
      // with the modern BS-EN 60947-3 isolator standard, so these defaults
      // are correct for the overwhelming majority of jobs.
      if (!analysis.main_switch_current && analysis.main_switch_rating) {
        analysis.main_switch_current = analysis.main_switch_rating;
      }
      if (!analysis.main_switch_bs_en) {
        analysis.main_switch_bs_en = '60947-3';
      }
      if (!analysis.main_switch_poles) {
        analysis.main_switch_poles = 'DP';
      }
      if (!analysis.main_switch_voltage) {
        analysis.main_switch_voltage = '230';
      }

      // Supply Protective Device fallback: in most domestic installations the
      // CU main switch rating is the relevant value for the EICR form's
      // "Supply Protective Device" section. These keys (spd_rated_current,
      // spd_bs_en, spd_type_supply) are the supply_characteristics schema —
      // distinct from the CU surge-protector fields (spd_rated_current_a etc.)
      // that the classifier writes via spd_present.
      if (!analysis.spd_rated_current && analysis.main_switch_current) {
        analysis.spd_rated_current = analysis.main_switch_current;
      }
      if (!analysis.spd_bs_en && analysis.main_switch_bs_en) {
        analysis.spd_bs_en = analysis.main_switch_bs_en;
      }
      if (!analysis.spd_type_supply && analysis.main_switch_type) {
        analysis.spd_type_supply = analysis.main_switch_type;
      }

      // Cost: classifier (Stage 1) + Stage 3 + Stage 4 token usage.
      // Sonnet 4.6 pricing: $3/1M input, $15/1M output.
      const stage3Usage = geometricResult?.usage || { inputTokens: 0, outputTokens: 0 };
      const stage4Usage = perSlotState?.labelPassResult?.usage || {
        inputTokens: 0,
        outputTokens: 0,
      };
      const totalInputTokens =
        (classifierUsage.inputTokens || 0) +
        (stage3Usage.inputTokens || 0) +
        (stage4Usage.inputTokens || 0);
      const totalOutputTokens =
        (classifierUsage.outputTokens || 0) +
        (stage3Usage.outputTokens || 0) +
        (stage4Usage.outputTokens || 0);
      const inputCost = (totalInputTokens * 0.003) / 1000;
      const outputCost = (totalOutputTokens * 0.015) / 1000;
      analysis.gptVisionCost = {
        cost_usd: parseFloat((inputCost + outputCost).toFixed(6)),
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        image_count: 1,
      };

      const labelledCircuitCount = (analysis.circuits || []).filter(
        (c) => c.label && c.label !== 'null'
      ).length;
      const totalCircuitCount = analysis.circuits?.length || 0;

      logger.info('CCU analysis parsed', {
        userId: req.user.id,
        model,
        boardManufacturer: analysis.board_manufacturer,
        boardModel: analysis.board_model,
        circuitCount: totalCircuitCount,
        labelledCircuits: labelledCircuitCount,
        labelCoverage:
          totalCircuitCount > 0 ? `${labelledCircuitCount}/${totalCircuitCount}` : '0/0',
        circuitLabels: (analysis.circuits || []).map((c) => c.label || null),
        circuitRcdTypes: (analysis.circuits || []).map((c) => c.rcd_type || null),
        mainSwitchCurrent: analysis.main_switch_current,
        spdPresent: analysis.spd_present,
        confidenceOverall: analysis.confidence?.overall,
        confidenceQuality: analysis.confidence?.image_quality,
        costUsd: analysis.gptVisionCost.cost_usd,
        extractionSource,
      });

      analysis.extraction_source = extractionSource;
      analysis.board_classification = boardClassification
        ? {
            board_technology: boardClassification.boardTechnology,
            main_switch_position: boardClassification.mainSwitchPosition,
            confidence: boardClassification.confidence,
          }
        : null;

      const totalElapsedMs = Date.now() - endpointStartMs;
      logger.info('CCU extraction total timing', {
        userId: req.user.id,
        totalElapsedMs,
        totalElapsedSec: (totalElapsedMs / 1000).toFixed(1),
        geometricSuccess: Boolean(geometricResult),
        extractionSource,
      });

      res.json(analysis);

      // Phase A (plan 2026-04-16 §7): fire-and-forget training-data log.
      // Orthogonal to extraction — every TestFlight session becomes an
      // auto-labelled sample for the future on-device YOLO detector.
      // MUST run after res.json so latency is unaffected; failure is
      // non-fatal and is logged as a warning only.
      logCcuTrainingData({
        userId: req.user.id,
        sessionId: req.body?.sessionId || null,
        imageBuffer: imageBytes,
        analysis,
        meta: {
          model,
          totalElapsedMs,
          anthropicElapsedMs,
          promptTokens: totalInputTokens,
          completionTokens: totalOutputTokens,
          timestamp: new Date().toISOString(),
        },
      }).catch((err) => {
        logger.warn('CCU training log failed (non-fatal)', {
          userId: req.user.id,
          error: err.message,
        });
      });

      // Phase B: log the geometric stage outputs to S3 as a separate JSON
      // so we can compare geometricCount vs vlmCount vs the final extracted
      // circuit count across real sessions. Fire-and-forget; never fails
      // the request. Written to a sibling key under the same extraction
      // prefix convention so Phase C analysis can join by sessionId.
      if (geometricResult) {
        const geoExtractionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sessionSegment =
          String(req.body?.sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'no-session';
        const geoKey = `ccu-geometric/${req.user.id}/${sessionSegment}/${geoExtractionId}/stage-outputs.json`;

        // Phase C: strip base64 crop data from Stage 3 before writing to S3.
        // The bbox coordinates and classification are small and useful for offline
        // analysis; the base64 crops would balloon the sidecar by ~100KB per slot
        // and are already recoverable by re-cropping the original CCU photo.
        const sanitizeSlotsForSidecar = (slots) => {
          if (!Array.isArray(slots)) return slots;
          return slots.map((s) => ({
            slotIndex: s.slotIndex,
            classification: s.classification,
            manufacturer: s.manufacturer,
            model: s.model,
            ratingAmps: s.ratingAmps,
            poles: s.poles,
            // Stage 3 device-level attributes — required for training-data
            // analysis, otherwise RCD/RCBO waveform + curve info is lost.
            tripCurve: s.tripCurve ?? null,
            sensitivity: s.sensitivity ?? null,
            rcdWaveformType: s.rcdWaveformType ?? null,
            bsEn: s.bsEn ?? null,
            confidence: s.confidence,
            // bbox only — never base64 — in the sidecar.
            bbox: s?.crop?.bbox ?? null,
          }));
        };

        const sanitizedStageOutputs = geometricResult.stageOutputs
          ? {
              ...geometricResult.stageOutputs,
              stage3: geometricResult.stageOutputs.stage3
                ? {
                    ...geometricResult.stageOutputs.stage3,
                    slots: sanitizeSlotsForSidecar(geometricResult.stageOutputs.stage3.slots),
                  }
                : undefined,
            }
          : geometricResult.stageOutputs;

        // Fire-and-forget but surface real failures. storage.uploadJson swallows
        // S3 errors and returns false — .catch() never fires — so we need an
        // explicit boolean check inside an async IIFE to avoid silently dropping
        // the geometric sidecar on S3 outage. Kept off the request path.
        (async () => {
          try {
            const ok = await storage.uploadJson(
              {
                extractionId: geoExtractionId,
                userId: req.user.id,
                sessionId: req.body?.sessionId || null,
                timestamp: new Date().toISOString(),
                vlmCircuitCount: (analysis.circuits || []).length,
                geometric: {
                  schemaVersion: geometricResult.schemaVersion,
                  moduleCount: geometricResult.moduleCount,
                  vlmCount: geometricResult.vlmCount,
                  disagreement: geometricResult.disagreement,
                  lowConfidence: geometricResult.lowConfidence,
                  medianRails: geometricResult.medianRails,
                  slotCentersX: geometricResult.slotCentersX,
                  moduleWidth: geometricResult.moduleWidth,
                  mainSwitchWidth: geometricResult.mainSwitchWidth,
                  mainSwitchCenterX: geometricResult.mainSwitchCenterX,
                  imageWidth: geometricResult.imageWidth,
                  imageHeight: geometricResult.imageHeight,
                  slots: sanitizeSlotsForSidecar(geometricResult.slots),
                  stage3Error: geometricResult.stage3Error || null,
                  timings: geometricResult.timings,
                  usage: geometricResult.usage,
                  stageOutputs: sanitizedStageOutputs,
                },
              },
              geoKey
            );
            if (!ok) {
              logger.warn('CCU geometric log failed (non-fatal): uploadJson returned false', {
                userId: req.user.id,
                geoKey,
              });
            }
          } catch (err) {
            logger.warn('CCU geometric log failed (non-fatal)', {
              userId: req.user.id,
              error: err.message,
            });
          }
        })();
      }
    } catch (error) {
      // Timeout — AbortController fired or SDK timeout
      if (
        error.name === 'AbortError' ||
        error.name === 'APIConnectionTimeoutError' ||
        error.message?.includes('aborted') ||
        error.message?.includes('timed out')
      ) {
        logger.error('CCU analysis timed out', {
          userId: req.user.id,
          timeoutMs: CCU_EXTRACTION_TIMEOUT_MS,
          error: error.message,
        });
        return res.status(504).json({
          error: 'extraction_timeout',
          message: 'Processing took too long',
          retryable: true,
        });
      }

      // JSON parse failure — bad model output
      if (error instanceof SyntaxError) {
        logger.error('CCU analysis response parse failed', {
          userId: req.user.id,
          error: error.message,
        });
        return res.status(502).json({
          error: 'extraction_parse_error',
          message: 'Failed to parse analysis response',
          retryable: true,
        });
      }

      // API rate limiting
      const statusCode = error.status || error.statusCode;
      if (statusCode === 429) {
        logger.warn('CCU analysis rate limited', {
          userId: req.user.id,
        });
        return res.status(429).json({
          error: 'rate_limited',
          message: 'API rate limit exceeded, please retry shortly',
          retryable: true,
        });
      }

      // All other errors
      logger.error('CCU analysis failed', {
        userId: req.user.id,
        error: error.message,
        statusCode,
      });
      res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
        error: error.message,
        retryable: statusCode >= 500 || !statusCode,
      });
    } finally {
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch {
          /* ignore cleanup errors */
        }
      }
    }
  }
);

/**
 * Extract certificate data from a photo of a previous certificate, handwritten notes, etc.
 * Returns the same { success, formData } shape as /api/recording/extract-transcript
 * so the iOS app can merge results via CertificateMerger.
 *
 * POST /api/analyze-document
 */
router.post('/analyze-document', auth.requireAuth, upload.single('photo'), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const model = (process.env.DOC_EXTRACT_MODEL || process.env.CCU_MODEL || 'gpt-5.2').trim();

    logger.info('Document extraction requested', {
      userId: req.user.id,
      fileSize: req.file.size,
      model,
    });

    const imageBytes = await fs.readFile(tempPath);
    const base64 = Buffer.from(imageBytes).toString('base64');

    const prompt = `You are an expert UK electrician extracting data from a document for an EICR (Electrical Installation Condition Report) or EIC (Electrical Installation Certificate).

## TASK

The user has uploaded a photo of one of the following:
- A previous EICR or EIC certificate
- Handwritten inspection notes
- A printed or typed test results sheet
- Any document containing electrical installation data

Extract ALL readable data and return structured JSON. Be thorough — extract every field you can read.

## WHAT TO EXTRACT

### Installation Details
- Client name, address (including postcode, town, county)
- Description of premises (e.g., "3 bed semi-detached house")
- Reason for report (e.g., "Periodic inspection", "Change of tenancy")
- Occupier name
- Date of previous inspection
- Previous certificate number
- Estimated age of installation (years)
- General condition of installation
- Next inspection recommended interval (years)
- Installation records available (yes/no)
- Evidence of additions/alterations (yes/no)

### Supply Characteristics
- Earthing arrangement (TN-C-S, TN-S, TT, IT)
- Nominal voltage (e.g., "230")
- Nominal frequency (e.g., "50")
- Prospective fault current in kA (e.g., "0.88")
- External earth loop impedance Ze in ohms (e.g., "0.35")

### Board Info
- Manufacturer and model
- Main switch rating (amps), BS/EN, poles, voltage
- SPD status (fitted/not fitted), type, rating

### Circuits (test results)
For each circuit found, extract:
- Circuit reference number and designation/description
- Cable sizes (live and CPC in mm²)
- Wiring type and reference method
- Number of points
- OCPD: type (B/C/D), rating (A), BS/EN, breaking capacity (kA)
- RCD: type (AC/A/B/F/S), operating current (mA), BS/EN
- Ring continuity: R1, Rn, R2 (ohms)
- r1+r2 and r2 values (ohms)
- Insulation resistance: live-live and live-earth (MΩ) — prefix with > if greater than
- Earth fault loop impedance Zs (ohms)
- Polarity confirmed (true/false)
- RCD trip time (ms)
- RCD button test confirmed (true/false)

### Observations
For each observation/defect noted:
- Classification code: C1 (danger present), C2 (potentially dangerous), C3 (improvement recommended), FI (further investigation)
- Observation text (the defect description)
- Item/location
- Schedule item reference
- Regulation reference

## RULES
- Only extract data you can actually read — do NOT guess or fabricate values
- For illegible fields, omit them (do not set to null)
- For insulation resistance values shown as ">200" or "≥200", return ">200"
- Circuit numbers should be integers
- Amp ratings should be strings (e.g., "32" not 32)
- Ohm values should be strings (e.g., "0.35")
- If multiple boards are shown, extract all circuits

## OUTPUT FORMAT

Return ONLY valid JSON matching this exact schema:
{
  "installation_details": {
    "client_name": "string or omit",
    "address": "string or omit",
    "postcode": "string or omit",
    "town": "string or omit",
    "county": "string or omit",
    "premises_description": "string or omit",
    "reason_for_report": "string or omit",
    "occupier_name": "string or omit",
    "date_of_previous_inspection": "string or omit",
    "previous_certificate_number": "string or omit",
    "estimated_age_of_installation": "string or omit",
    "general_condition_of_installation": "string or omit",
    "next_inspection_years": 5,
    "installation_records_available": "Yes or No or omit",
    "evidence_of_additions_alterations": "Yes or No or omit"
  },
  "supply_characteristics": {
    "earthing_arrangement": "TN-C-S or TN-S or TT or IT",
    "nominal_voltage_u": "230",
    "nominal_frequency": "50",
    "prospective_fault_current": "string kA",
    "earth_loop_impedance_ze": "string ohms"
  },
  "board_info": {
    "manufacturer": "string or omit",
    "name": "string — board model or omit",
    "rated_current": "string amps or omit",
    "main_switch_bs_en": "string or omit",
    "spd_status": "Fitted or Not Fitted or omit"
  },
  "circuits": [
    {
      "circuit_ref": "1",
      "circuit_designation": "Ring Main",
      "live_csa_mm2": "2.5",
      "cpc_csa_mm2": "1.5",
      "wiring_type": "string or omit",
      "ref_method": "string or omit",
      "number_of_points": "string or omit",
      "ocpd_type": "B",
      "ocpd_rating_a": "32",
      "ocpd_bs_en": "60898-1",
      "ocpd_breaking_capacity_ka": "6",
      "rcd_type": "A",
      "rcd_operating_current_ma": "30",
      "rcd_bs_en": "61009",
      "ring_r1_ohm": "0.88",
      "ring_rn_ohm": "0.91",
      "ring_r2_ohm": "1.11",
      "r1_r2_ohm": "0.89",
      "r2_ohm": "0.45",
      "ir_live_live_mohm": ">200",
      "ir_live_earth_mohm": ">200",
      "measured_zs_ohm": "0.45",
      "polarity_confirmed": "true",
      "rcd_time_ms": "18",
      "rcd_button_confirmed": "true"
    }
  ],
  "observations": [
    {
      "code": "C2",
      "observation_text": "Description of defect",
      "item_location": "Distribution board",
      "schedule_item": "4.2",
      "regulation": "Reg 421.1.201"
    }
  ]
}`;

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey });

    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const response = await openai.chat.completions.create({
      model,
      max_completion_tokens: 16384,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content || '';
    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    const finishReason = response.choices?.[0]?.finish_reason || 'unknown';

    logger.info('Document extraction complete', {
      userId: req.user.id,
      model,
      promptTokens,
      completionTokens,
      responseLength: content.length,
      finishReason,
    });

    if (finishReason === 'length') {
      logger.error('Document extraction truncated by token limit', {
        userId: req.user.id,
        model,
        completionTokens,
      });
      return res.status(502).json({
        error: `Response truncated (${completionTokens} tokens). Try a clearer photo or retry.`,
      });
    }

    let jsonStr = content;
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const extracted = JSON.parse(jsonStr);

    // Convert circuits: ensure polarity_confirmed and rcd_button_confirmed are strings
    if (extracted.circuits) {
      for (const c of extracted.circuits) {
        if (typeof c.polarity_confirmed === 'boolean') {
          c.polarity_confirmed = c.polarity_confirmed ? '✓' : '';
        }
        if (typeof c.rcd_button_confirmed === 'boolean') {
          c.rcd_button_confirmed = c.rcd_button_confirmed ? '✓' : '';
        }
        // Ensure circuit_ref is a string
        if (typeof c.circuit_ref === 'number') {
          c.circuit_ref = String(c.circuit_ref);
        }
      }
    }

    // Wrap in { success, formData } envelope to match TranscriptExtractionResponse
    const formData = {
      circuits: extracted.circuits || [],
      observations: extracted.observations || [],
      installation_details: extracted.installation_details || {},
      supply_characteristics: extracted.supply_characteristics || {},
      board_info: extracted.board_info || {},
    };

    const inputCost = (promptTokens * 0.002) / 1000;
    const outputCost = (completionTokens * 0.012) / 1000;

    logger.info('Document extraction parsed', {
      userId: req.user.id,
      model,
      circuitCount: formData.circuits.length,
      observationCount: formData.observations.length,
      hasInstallation: Object.keys(formData.installation_details).length > 0,
      hasSupply: Object.keys(formData.supply_characteristics).length > 0,
      hasBoard: Object.keys(formData.board_info).length > 0,
      costUsd: parseFloat((inputCost + outputCost).toFixed(6)),
    });

    res.json({ success: true, formData });
  } catch (error) {
    logger.error('Document extraction failed', {
      userId: req.user.id,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  } finally {
    if (tempPath) {
      try {
        await fs.unlink(tempPath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
});

/**
 * Enhance an observation using GPT
 * POST /api/enhance-observation
 */
router.post('/enhance-observation', auth.requireAuth, async (req, res) => {
  try {
    const { observation_text, code, item_location } = req.body;

    if (!observation_text || !observation_text.trim()) {
      return res.status(400).json({ error: 'observation_text is required' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const model = (process.env.EXTRACTION_MODEL || 'gpt-5.2').trim();

    logger.info('Observation enhancement requested', {
      userId: req.user.id,
      code: code || 'unknown',
      location: item_location || 'unknown',
      textLength: observation_text.length,
      model,
    });

    const OpenAI = (await import('openai')).default;
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

    const userPrompt = `Observation code: ${code || 'C3'}
Location: ${item_location || 'Not specified'}
Raw observation: ${observation_text}`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_completion_tokens: 500,
    });

    const content = response.choices?.[0]?.message?.content?.trim() || '';

    logger.info('Observation enhancement complete', {
      userId: req.user.id,
      model,
      tokens: response.usage?.total_tokens,
      responseLength: content.length,
    });

    let jsonStr = content;
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const enhanced = JSON.parse(jsonStr);

    if (!enhanced.observation_text) {
      throw new Error('GPT response missing observation_text');
    }

    logger.info('Observation enhancement parsed', {
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
    logger.error('Observation enhancement failed', {
      userId: req.user.id,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  }
});

// Handle Multer file filter rejections with 400 status
router.use(handleUploadError);

export default router;
