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
import { extractCcuGeometric } from '../extraction/ccu-geometric.js';
import { extractCcuRewireable } from '../extraction/ccu-geometric-rewireable.js';

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
function normaliseCircuitLabels(analysis) {
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
function applyBsEnFallback(analysis) {
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
 * Small, fast VLM call that returns only board_technology + main_switch_position.
 *
 * Purpose: route the subsequent per-slot geometric pipeline (modern vs rewireable).
 * Running this in parallel to the big single-shot prompt keeps total latency flat
 * — the classifier returns in ~3s and lets us kick off the correct geometric
 * extractor while single-shot is still running. Single-shot is the authoritative
 * source of board_technology in the final response; this cheap call is ONLY used
 * for geometric pipeline routing and is discarded afterwards.
 *
 * @param {string} base64 — base64-encoded JPEG
 * @param {object} anthropic — Anthropic client
 * @param {string} model — model id (e.g. claude-sonnet-4-6)
 * @returns {Promise<{boardTechnology:string, mainSwitchPosition:string, confidence:number, usage:{inputTokens:number,outputTokens:number}}>}
 */
async function classifyBoardTechnology(base64, anthropic, model) {
  const prompt = `Look at this UK fuseboard photo. Return ONLY a JSON object:
{"board_technology": "modern" | "rewireable_fuse" | "cartridge_fuse" | "mixed", "main_switch_position": "left" | "right" | "none", "confidence": 0.0-1.0}

Definitions:
- "modern" — MCBs/RCBOs on DIN rail with toggle levers. ANY board with at least one toggle-style MCB showing a trip-curve letter (B/C/D) IS modern.
- "rewireable_fuse" — pull-out fuse carriers with semi-enclosed fuse wire (BS 3036). Wylex/MEM/Crabtree/Bill/Ashley. Carrier BODIES are colour-coded (white/blue/yellow/red/green) — the red "push to remove" tab at the top of every Wylex carrier is NOT a rating indicator. No toggles, no curve letters, no test buttons on circuit devices.
- "cartridge_fuse" — pull-out carriers that contain a cylindrical ceramic HBC cartridge (BS 1361 / BS 88). No rewireable fuse wire visible; cartridge face usually stamped with amp rating.
- "mixed" — combination (rewireable carriers plus a retrofitted 30mA RCD main switch, or some MCBs and some fuse carriers on the same panel).

main_switch_position: which side of the circuit devices the main isolator / pull-out switch-fuse sits — "left", "right", or "none" (if inline with the circuit row with no clear handedness).

Return ONLY the JSON object.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 200,
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
  return {
    boardTechnology: parsed.board_technology || 'modern',
    mainSwitchPosition: parsed.main_switch_position || 'none',
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
 * Per-slot classifications give us reliable device identification (what is in
 * each position on the board) but NO label text — labels always come from the
 * single-shot prompt, which reads the circuit-schedule card or stickers on the
 * board cover. We therefore merge: slot data drives `ocpd_*` / `rcd_*` /
 * `is_rcbo` on each circuit, and single-shot labels are pasted in by circuit
 * number.
 *
 * Circuit numbering follows the BS 7671 convention encoded in the existing
 * prompt: circuit 1 is the device nearest the main switch, numbering OUTWARD.
 * When `mainSwitchSide === 'right'` we therefore iterate the physical-order
 * slot array in reverse.
 *
 * Per-slot confidence gating: if a slot's classification confidence is below
 * `minSlotConfidence` (or its classification is "unknown"), we fall back to
 * the single-shot value for that circuit position rather than emit a
 * low-confidence Stage-3 reading. This keeps Stage 3's output as the primary
 * source without regressing on individual slots where the VLM was uncertain.
 *
 * @returns {Array|null} circuits array, or null if slots is empty/invalid.
 */
function slotsToCircuits({
  slots,
  mainSwitchSide,
  singleShotCircuits,
  minSlotConfidence = 0.7,
}) {
  if (!Array.isArray(slots) || slots.length === 0) return null;

  const scanOrder = mainSwitchSide === 'right' ? [...slots].reverse() : [...slots];
  const circuits = [];
  let circuitNumber = 1;
  let upstreamRcd = null;

  for (const slot of scanOrder) {
    const cls = (slot.classification || '').toLowerCase();

    if (cls === 'main_switch' || cls === 'spd') continue;

    if (cls === 'rcd') {
      // Standalone RCD — not a circuit, but its type/sensitivity cascade to the
      // circuits it protects (all subsequent non-RCBO circuits until the next RCD).
      upstreamRcd = {
        type: slot.rcdWaveformType || null,
        sensitivity:
          slot.sensitivity != null && slot.sensitivity !== ''
            ? String(slot.sensitivity)
            : null,
      };
      continue;
    }

    const fallback = (singleShotCircuits || []).find((c) => c.circuit_number === circuitNumber);
    const confident = (slot.confidence ?? 0) >= minSlotConfidence;

    let circuit;
    if (cls === 'blank') {
      circuit = {
        circuit_number: circuitNumber,
        label: fallback?.label && fallback.label !== 'null' ? fallback.label : 'Spare',
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
      // Low-confidence slot — prefer single-shot's reading at this position.
      circuit = fallback
        ? { ...fallback, circuit_number: circuitNumber }
        : {
            circuit_number: circuitNumber,
            label: null,
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
      // Still cascade upstream RCD even on low-confidence slots.
      if (upstreamRcd && !circuit.is_rcbo) {
        circuit.rcd_protected = true;
        if (!circuit.rcd_type) circuit.rcd_type = upstreamRcd.type;
        if (!circuit.rcd_rating_ma) circuit.rcd_rating_ma = upstreamRcd.sensitivity;
        if (!circuit.rcd_bs_en) circuit.rcd_bs_en = '61008';
      }
    } else {
      circuit = buildCircuitFromSlot(slot, circuitNumber, upstreamRcd);
      if (fallback?.label && fallback.label !== 'null') circuit.label = fallback.label;
    }

    circuits.push(circuit);
    circuitNumber++;
  }

  return circuits;
}

/**
 * Translate one high-confidence slot classification into an EICR-schema circuit row.
 * Device fields come from the slot; label comes from single-shot later.
 */
function buildCircuitFromSlot(slot, circuit_number, upstreamRcd) {
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
router.post('/analyze-ccu', auth.requireAuth, upload.single('photo'), async (req, res) => {
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

    logger.info('CCU photo analysis requested', {
      userId: req.user.id,
      fileSize: req.file.size,
      model,
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

    // Per-slot primary pipeline (sprint 2026-04-22):
    //   1. Run the cheap board_technology classifier immediately (returns in ~3s).
    //   2. Kick off the matching geometric pipeline the moment the classifier
    //      returns — modern -> extractCcuGeometric, rewireable/cartridge/mixed ->
    //      extractCcuRewireable. "mixed" uses the rewireable path because that
    //      module also handles retrofitted RCD main switches.
    //   3. The single-shot VLM prompt runs in parallel (kicked off below) and
    //      remains the authoritative source for LABELS, main switch, SPD,
    //      board manufacturer/model, confidence message, and questionsForInspector.
    //      Slot classifications OVERWRITE the single-shot circuits[] array
    //      (ocpd_* / rcd_* / is_rcbo fields) when their confidence >= threshold;
    //      low-confidence or "unknown" slots fall back to single-shot per-position.
    //
    // Kill switch: CCU_GEOMETRIC_V1=false in the task-def disables the whole
    // per-slot path and falls back to pure single-shot, preserving the pre-sprint
    // behaviour. Default (env unset or "true") is per-slot ON.
    const perSlotEnabled = process.env.CCU_GEOMETRIC_V1 !== 'false';

    let boardClassification = null;
    let geometricPromise = Promise.resolve(null);

    if (perSlotEnabled) {
      try {
        const classifierAnthropic = new (await import('@anthropic-ai/sdk')).default({
          apiKey: anthropicKey,
        });
        boardClassification = await classifyBoardTechnology(base64, classifierAnthropic, model);
        logger.info('CCU board_technology classifier', {
          userId: req.user.id,
          boardTechnology: boardClassification.boardTechnology,
          mainSwitchPosition: boardClassification.mainSwitchPosition,
          confidence: boardClassification.confidence,
        });
      } catch (err) {
        logger.warn('CCU board_technology classifier failed — defaulting to modern path', {
          userId: req.user.id,
          error: err.message,
        });
        boardClassification = null;
      }

      const chooseRewireable =
        boardClassification?.boardTechnology === 'rewireable_fuse' ||
        boardClassification?.boardTechnology === 'cartridge_fuse' ||
        boardClassification?.boardTechnology === 'mixed';

      geometricPromise = (
        chooseRewireable ? extractCcuRewireable(imageBytes) : extractCcuGeometric(imageBytes)
      ).catch((err) => {
        logger.warn('CCU geometric extraction failed (non-fatal)', {
          userId: req.user.id,
          path: chooseRewireable ? 'rewireable' : 'modern',
          error: err.message,
        });
        return null;
      });
    }

    const prompt = `You are an expert UK electrician extracting devices from a consumer unit photo for an EICR certificate. Follow these 4 steps IN ORDER. Return ONLY valid JSON.

## STEP 1: FIND MAIN SWITCH AND CLASSIFY BOARD

### 1a. Main switch
Look for the device labelled "MAIN SWITCH" on the board (printed text on the board cover, or on the device itself). It is typically the largest device, often 2 modules wide.
CRITICAL — Confirm it is NOT an RCD/RCCB: the main switch has NO test button, NO "30mA" or sensitivity marking, and NO "RCD"/"RCCB" text on it. Do NOT identify the main switch by toggle colour — RCDs also have red/orange toggles and WILL be misidentified if you rely on colour alone.
Record: rating (amps), type (Isolator/Switch Disconnector/Switch-Fuse/Rotary Isolator/RCD/RCCB), poles (DP/TP/TPN/4P), BS/EN number, voltage if visible. Note its position on the board (left/right).
Identify board manufacturer and model if visible (e.g. "Hager", "MK", "Wylex").

On older rewireable-fuse boards the main switch is often a **pull-out switch-fuse** (Wylex-style, integrated with neutral bar) or a **rotary isolator** (MEM). Rating typically 60A/80A/100A. BS/EN is often BS 5419 (legacy) or BS EN 60947-3; set null if not printed. Use main_switch_type "Switch-Fuse" or "Rotary Isolator" accordingly.

### 1b. Board technology
Classify the board's overcurrent-protection technology. Set board_technology to exactly one of:
- **"modern"** — toggle-style MCBs / RCBOs on DIN rail, ~18mm modules each. Any board with even one MCB/RCBO is NOT rewireable.
- **"rewireable_fuse"** — every protective device is a **pull-out fuse carrier** (no toggles). Carriers are typically colour-coded on the body or the fuse-shield tab. Commonly Wylex (bakelite or plastic), MEM, Crabtree, Bill, Ashley. Devices to the protection standard BS 3036 (semi-enclosed rewireable fuse wire).
- **"cartridge_fuse"** — pull-out carriers that contain a cylindrical HBC cartridge (not rewireable fuse wire). Standard BS 1361 or BS 88-2/88-3.
- **"mixed"** — combination (e.g. rewireable carriers plus a retrofitted 30mA RCD main switch, or a board where some ways are MCBs and some are fuse carriers).

If unsure between rewireable and cartridge, look at the carrier contents: visible twisted fuse wire = rewireable (BS 3036), cylindrical ceramic/metal cartridge = BS 1361/88-2. If a carrier is closed and you cannot tell, prefer rewireable_fuse for classic domestic Wylex/MEM boards and add a question for the inspector.

### 1c. SPD
Also check for an SPD module (status indicator window, no toggle, 2-3 modules wide). If present: set spd_present=true and extract type/rating/BS EN/short circuit kA. If absent: spd_present=false. Do NOT copy main switch data into SPD fields — they are completely different components. Rewireable-fuse boards almost never have an SPD.

## STEP 2: SEQUENTIAL DEVICE SCAN

Starting from the device immediately next to the main switch, scan outward one device at a time. For split boards (main switch in middle), scan non-RCD side first, then RCD side. Number circuits sequentially — circuit 1 is nearest the main switch, incrementing outward. Skip standalone RCDs when numbering — they are NOT circuits. Ignore printed circuit numbers on the board (often wrong).

Use the classification rules that match the board_technology from Step 1b.

### 2a. MODERN BOARDS (board_technology = "modern")
For each position, classify as exactly ONE of:
- **MCB**: Single-width (18mm), has toggle lever, NO test button. Record type curve (B/C/D) and amp rating from device face.
- **RCBO**: Double-width (36mm), has BOTH toggle lever AND test button, plus RCD waveform symbol. Record curve, rating, RCD type (count waveform lines: 1=AC, 2=A, 3=B; S or F if letter-marked), and sensitivity (mA). Set is_rcbo=true, rcd_protected=true.
- **RCD/RCCB**: Double-width, has test button, has sensitivity marking (e.g. 30mA), but NO type curve letter (B/C/D). This is NOT a circuit — do NOT number it. Store its RCD type + sensitivity; apply them to ALL subsequent circuits until the next RCD is encountered.
- **Blank/Spare**: Flat cover plate, no toggle lever, no device behind it. Record as label:"Spare", ocpd_type:null, ocpd_rating_a:null. NEVER fabricate device data for empty slots.
- **Spare MCB**: Real MCB with toggle + rating but no label. Record with label:"Spare" and real ocpd_type/rating from the device face.

### 2b. REWIREABLE / CARTRIDGE FUSE BOARDS (board_technology = "rewireable_fuse" | "cartridge_fuse")
There are NO toggles, NO curve letters, and NO test buttons on the circuit devices. Each way is a pull-out fuse carrier. Classify each position as exactly ONE of:
- **Fuse carrier (rewireable, BS 3036)** — body or shield tab is COLOUR-CODED. This is the primary signal for the amp rating:
  - **White = 5A** (typical: lighting)
  - **Blue = 15A** (typical: immersion heater, old radial)
  - **Yellow = 20A** (typical: radial)
  - **Red = 30A** (typical: ring final, legacy cooker)
  - **Green = 45A** (typical: cooker, shower)
  If a rating is also printed on the carrier face or carrier tab, it must match the colour. If they disagree, set ocpd_rating_a=null and raise a question for the inspector. Set ocpd_type="Rew", ocpd_bs_en="BS 3036", ocpd_breaking_capacity_ka=null (rewireable fuses have no kA rating).
- **Fuse carrier (HBC cartridge, BS 1361 / BS 88-2)** — carrier holds a cylindrical ceramic cartridge; face usually stamped with the rating (e.g. 30A, 45A) and often a BS 1361 or BS 88 mark. Set ocpd_type="HRC", ocpd_bs_en="BS 1361" (domestic) or "BS 88-2" (commercial) as appropriate, ocpd_breaking_capacity_ka from device face or null.
- **Blank/Spare way** — empty carrier socket with no carrier fitted, or blank cover. Record as label:"Spare", ocpd_type:null, ocpd_rating_a:null, ocpd_bs_en:null.
- **Spare fuse** — fitted carrier with a valid colour/rating but no circuit label. Record with label:"Spare" and real ocpd_type/ocpd_rating_a.

For every circuit on a rewireable or cartridge board, set is_rcbo=false. Set rcd_protected=false and rcd_type=null UNLESS an upstream RCD is clearly visible (e.g. a retrofitted 30mA RCD main switch or an RCD banked ahead of a group of ways); in that case apply the upstream RCD's type and sensitivity to the circuits it protects, same as the modern-board rule.

Do NOT assign a curve letter (B/C/D) to any rewireable or cartridge fuse — ocpd_type is "Rew" or "HRC", never B/C/D.

### 2c. MIXED BOARDS (board_technology = "mixed")
Apply 2a rules to positions that are MCBs/RCBOs and 2b rules to positions that are fuse carriers. Classify each position on its own merits.

### B6 vs B16 WARNING
On many MCBs (especially Legrand) the gap between "B" and "6" mimics "B16". Count digits: single "6"=B6 (6A, typical for lighting/smoke), two digits "16"=B16 (16A, typical for sockets). If you read B16 on a lighting or smoke alarm circuit, it is almost certainly B6 — re-examine.

### Amp ratings
ALWAYS read from the device face. Never assume from circuit name ("Shower" ≠ 40A, "Cooker" ≠ 32A). If not legible, set to null.

### RCD type determination
1. Read waveform symbol on device: 1 line=AC, 2 lines=A, 3 lines=B, letter S=S, letter F=F. If any hint of a second line below the sine wave, it is Type A not AC.
2. If symbol not visible, look up by manufacturer+model prefix (Hager ADA=A, ADN=AC; MK H79xx=AC, H68xx=A; BG CURB=AC, CUCRB=A; Wylex WRS=AC, WRSA=A).
3. If both fail, set rcd_type=null. Never return "RCD" or "RCBO" as rcd_type — only AC, A, B, F, S, or null.

### BS/EN numbers
Read from device. If not visible, look up: MCB=60898-1, RCBO=61009-1, RCD=61008. Only null if device is unidentifiable.

## STEP 3: LABEL PASS

After all hardware is locked in, scan for labels above/below each device: strip labels, handwritten text, stickers, and circuit details cards (secondary source only — often outdated).
Match labels to devices by physical proximity. Ignore printed circuit numbers (often wrong). If a label is faded or unclear, set to null — never guess or copy from adjacent positions.

Normalise labels to EICR standard terms (title case):
Imm/Immersion→Water Heater, Smokes/Smoke/S/D/S/Det→Smoke Alarm, Lts/Ltg→Lights, Skt/Skts→Sockets (keep prefix e.g. "Kitchen Sockets"), CKR→Cooker, Shwr→Shower, Blr→Boiler, FF/F/F→Fridge Freezer, CH→Central Heating, UFH→Underfloor Heating, W/M→Washing Machine, T/D→Tumble Dryer, EV/EVCP→Electric Vehicle.
A circuit with a visible MCB/RCBO and a readable label is NOT "Spare".

## STEP 4: OUTPUT

Return ONLY valid JSON matching this exact schema:
{
  "board_manufacturer": "string or null",
  "board_model": "string or null",
  "board_technology": "modern|rewireable_fuse|cartridge_fuse|mixed",
  "main_switch_rating": "string — amps",
  "main_switch_position": "left or right",
  "main_switch_bs_en": "string or null",
  "main_switch_type": "Isolator|Switch Disconnector|Switch-Fuse|Rotary Isolator|RCD|RCCB or null",
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
  "questionsForInspector": ["Question 1?", "Question 2?"],
  "circuits": [
    {
      "circuit_number": 1,
      "label": "Kitchen Sockets or null",
      "ocpd_type": "B|C|D|Rew|HRC or null (null ONLY for blank positions with no physical device)",
      "ocpd_rating_a": "32 or null",
      "ocpd_bs_en": "60898-1|61009-1|BS 3036|BS 1361|BS 88-2 or null",
      "ocpd_breaking_capacity_ka": "6 or null (null for rewireable fuses — they have no kA rating)",
      "is_rcbo": false,
      "rcd_protected": true,
      "rcd_type": "AC|A|B|F|S or null",
      "rcd_rating_ma": "30 or null",
      "rcd_bs_en": "61008 or null"
    }
  ]
}

Device type mapping: RCBO→is_rcbo:true, rcd_protected:true, rcd_type from device waveform; MCB behind standalone RCD→is_rcbo:false, rcd_protected:true, rcd_type/sensitivity from upstream RCD; plain MCB (no RCD upstream)→is_rcbo:false, rcd_protected:false, rcd_type:null; rewireable/cartridge fuse (no upstream RCD)→is_rcbo:false, rcd_protected:false, rcd_type:null, ocpd_type "Rew" or "HRC"; rewireable/cartridge fuse behind retrofitted RCD→is_rcbo:false, rcd_protected:true, rcd_type/sensitivity from upstream RCD; blank→all ocpd fields null.

Confidence: overall 0.0-1.0, image_quality clear/partially_readable/poor, uncertain_fields lists guessed/looked-up field paths, message notes reading difficulties and lookups.

questionsForInspector: return EMPTY array [] unless RCD type could not be determined for a circuit. Questions are read aloud via TTS — keep extremely short and conversational. Never ask about BS/EN, ratings, board info, SPD, or labels you already extracted.`;

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Use AbortController to enforce extraction timeout (default 60s)
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CCU_EXTRACTION_TIMEOUT_MS);

    let response;
    const anthropicStartMs = Date.now();
    try {
      response = await anthropic.messages.create(
        {
          model,
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
                },
                { type: 'text', text: prompt },
              ],
            },
          ],
        },
        { signal: abortController.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }
    const anthropicElapsedMs = Date.now() - anthropicStartMs;
    logger.info('CCU Anthropic API call timing', {
      userId: req.user.id,
      model,
      elapsedMs: anthropicElapsedMs,
      elapsedSec: (anthropicElapsedMs / 1000).toFixed(1),
    });

    // Extract text content (skip thinking blocks)
    const textBlocks = (response.content || []).filter((b) => b.type === 'text');
    const content = textBlocks.map((b) => b.text).join('') || '';
    const promptTokens = response.usage?.input_tokens || 0;
    const completionTokens = response.usage?.output_tokens || 0;
    const stopReason = response.stop_reason || 'unknown';

    logger.info('CCU analysis complete', {
      userId: req.user.id,
      model,
      promptTokens,
      completionTokens,
      responseLength: content.length,
      stopReason,
      rawContentPreview: content.slice(0, 500),
    });

    if (stopReason === 'max_tokens') {
      logger.error('CCU analysis truncated by token limit', {
        userId: req.user.id,
        model,
        completionTokens,
        responseLength: content.length,
      });
      return res.status(502).json({
        error: `Response truncated (${completionTokens} tokens). The model hit its output limit. Try a clearer photo or retry.`,
      });
    }

    // Extract JSON from response — Claude may include reasoning text before the JSON
    let jsonStr = content;
    // Try to find a JSON code block first (in case model still wraps in code block)
    const jsonBlockMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    } else {
      // Find the first { and last } to extract the JSON object
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }
    }
    jsonStr = jsonStr.trim();

    let analysis = JSON.parse(jsonStr);

    analysis = applyBsEnFallback(analysis);
    analysis = normaliseCircuitLabels(analysis);

    // Pass 2: Web search for missing RCD types — Opus may still miss some.
    // Use gpt-5-search-api to look up the actual RCD type from datasheets.
    // We still need an OpenAI client for this web search step.
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

    // Populate Supply Protective Device fields from main switch data as fallback.
    // In most domestic installations the CU main switch rating is the relevant value
    // for the "Supply Protective Device" section on the EICR form. These fields use
    // the supply_characteristics schema keys (spd_rated_current, spd_bs_en, etc.)
    // which are distinct from the CU surge-protector fields (spd_rated_current_a, etc.).
    if (!analysis.spd_rated_current && analysis.main_switch_current) {
      analysis.spd_rated_current = analysis.main_switch_current;
    }
    if (!analysis.spd_bs_en && analysis.main_switch_bs_en) {
      analysis.spd_bs_en = analysis.main_switch_bs_en;
    }
    if (!analysis.spd_type_supply && analysis.main_switch_type) {
      analysis.spd_type_supply = analysis.main_switch_type;
    }

    // Sonnet 4.6 pricing: $3/1M input, $15/1M output
    const inputCost = (promptTokens * 0.003) / 1000;
    const outputCost = (completionTokens * 0.015) / 1000;
    analysis.gptVisionCost = {
      cost_usd: parseFloat((inputCost + outputCost).toFixed(6)),
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      image_count: 1,
    };

    const labelledCircuits = (analysis.circuits || []).filter(
      (c) => c.label && c.label !== 'null'
    ).length;
    const totalCircuits = analysis.circuits?.length || 0;

    logger.info('CCU analysis parsed', {
      userId: req.user.id,
      model,
      boardManufacturer: analysis.board_manufacturer,
      boardModel: analysis.board_model,
      circuitCount: totalCircuits,
      labelledCircuits,
      labelCoverage: totalCircuits > 0 ? `${labelledCircuits}/${totalCircuits}` : '0/0',
      circuitLabels: (analysis.circuits || []).map((c) => c.label || null),
      circuitRcdTypes: (analysis.circuits || []).map((c) => c.rcd_type || null),
      mainSwitchCurrent: analysis.main_switch_current,
      spdPresent: analysis.spd_present,
      confidenceOverall: analysis.confidence?.overall,
      confidenceQuality: analysis.confidence?.image_quality,
      uncertainFieldCount: analysis.confidence?.uncertain_fields?.length || 0,
      confidenceMessage: analysis.confidence?.message,
      costUsd: analysis.gptVisionCost.cost_usd,
    });

    // Sprint 2026-04-22: await the geometric extractor (parallel to single-shot),
    // attach its geometry + slots[] to the response, and — when Stage 3 succeeded
    // with usable slots — merge those slot classifications into analysis.circuits[].
    // The merge uses slotsToCircuits(): slot data drives ocpd_* / rcd_* / is_rcbo
    // per position; single-shot labels are pasted in by circuit number; any slot
    // below confidence threshold falls back to the single-shot value at that
    // position, so per-slot reliability gains never regress an individual row.
    const geometricResult = await geometricPromise;
    let extractionSource = 'single-shot';

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
      };

      // Expose per-slot classifications to iOS (LiveFillState.slotCrops).
      if (Array.isArray(geometricResult.slots) && geometricResult.slots.length > 0) {
        analysis.slots = geometricResult.slots;

        // Merge: slot classifications become the PRIMARY circuits[] source.
        // Prefer the classifier's main-switch side; fall back to single-shot's.
        const mainSwitchSide =
          geometricResult.mainSwitchSide ||
          boardClassification?.mainSwitchPosition ||
          analysis.main_switch_position ||
          'none';

        const mergedCircuits = slotsToCircuits({
          slots: geometricResult.slots,
          mainSwitchSide,
          singleShotCircuits: analysis.circuits,
        });

        if (mergedCircuits && mergedCircuits.length > 0) {
          analysis.circuits = mergedCircuits;
          extractionSource = 'geometric-merged';
        }
      }

      logger.info('CCU geometric extraction attached', {
        userId: req.user.id,
        moduleOrCarrierCount: analysis.geometric.moduleCount,
        slotCount: geometricResult.slots?.length ?? 0,
        lowConfidence: geometricResult.lowConfidence,
        stage3Error: geometricResult.stage3Error ?? null,
        extractionSource,
      });
    }

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
      perSlotEnabled,
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
        promptTokens,
        completionTokens,
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
});

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
