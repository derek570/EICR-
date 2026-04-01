/**
 * Extraction routes — Gemini chunked audio extraction, CCU photo analysis, observation enhancement
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import { geminiExtract } from '../gemini_extract.js';
import { getActiveSession } from '../state/recording-sessions.js';
import logger from '../logger.js';
import sharp from 'sharp';
import { createFileFilter, IMAGE_MIMES, handleUploadError } from '../utils/upload.js';

const router = Router();

// --- CCU extraction timeout & size config ---
const CCU_EXTRACTION_TIMEOUT_MS = parseInt(process.env.CCU_EXTRACTION_TIMEOUT_MS, 10) || 120_000;
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

const geminiChunkLimits = new Map();

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
  REWIREABLE: '3036',
  CARTRIDGE: '1361',
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

  if (needsLookup.length === 0) return analysis;

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
 * Gemini chunked audio extraction
 * POST /api/recording/gemini-extract
 */
router.post('/recording/gemini-extract', auth.requireAuth, async (req, res) => {
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
  let limits = geminiChunkLimits.get(userId);
  if (!limits || now - limits.windowStart > 60_000) {
    limits = { count: 0, windowStart: now, sessionChunks: limits?.sessionChunks || new Map() };
    geminiChunkLimits.set(userId, limits);
  }
  limits.count++;
  if (limits.count > 20) {
    logger.warn('Gemini extract rate limited', { userId, sessionId, count: limits.count });
    return res.status(429).json({ error: 'Rate limited: max 20 chunks/minute' });
  }

  const sessionCount = (limits.sessionChunks.get(sessionId) || 0) + 1;
  limits.sessionChunks.set(sessionId, sessionCount);
  if (sessionCount > 200) {
    logger.warn('Gemini extract session limit', { userId, sessionId, sessionCount });
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
    const result = await geminiExtract(
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

        session.geminiFullTranscript = session.preDebugContext;
        session.debugMode = false;
        session.debugBuffer = '';

        logger.info('── DEBUG MODE ENDED (Gemini) ──', {
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
          modelUsed: 'gemini-extract',
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
        logger.info('── DEBUG MODE — buffering (Gemini) ──', {
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
          modelUsed: 'gemini-extract',
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
        session.preDebugContext = session.geminiFullTranscript;
        session.debugMode = true;
        session.debugStartTime = new Date().toISOString();
        session.debugBuffer = '';

        const parts = transcript.split(DEBUG_START);
        const beforeDebug = parts[0]?.trim() || '';
        const afterDebug = parts.slice(1).join(' ').trim() || '';
        if (afterDebug) session.debugBuffer = afterDebug;

        logger.info('── DEBUG MODE STARTED (Gemini) ──', {
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
          modelUsed: 'gemini-extract',
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

        session.geminiFullTranscript += (session.geminiFullTranscript ? ' ' : '') + beforeDebug;
      }

      if (!session.debugMode && transcript) {
        session.geminiFullTranscript += (session.geminiFullTranscript ? ' ' : '') + transcript;
      }

      if (!session.debugMode || !DEBUG_START.test(transcript)) {
        session.debugLog.push({
          chunkIndex,
          timestamp: new Date().toISOString(),
          transcript: transcript || '(empty)',
          isDebugChunk: false,
          modelUsed: 'gemini-extract',
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
      }
    }

    logger.info('Gemini extract chunk', {
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
    logger.error('Gemini extract failed', {
      userId,
      sessionId,
      chunkIndex,
      error: error.message,
    });
    res.status(500).json({ error: 'Extraction failed: ' + error.message });
  }
});

/**
 * Analyze a consumer unit (fuseboard) photo using GPT Vision
 * POST /api/analyze-ccu
 */
router.post('/analyze-ccu', auth.requireAuth, upload.single('photo'), async (req, res) => {
  const tempPath = req.file?.path;

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

    const prompt = `You are an expert UK electrician analysing a photo of a consumer unit for an EICR certificate.

## TASK

Extract every protective device from this consumer unit photo and return structured JSON. Before producing the JSON output, you MUST work through the following 5-step methodology internally to ensure accuracy.

## STEP 1: READ ALL VISIBLE TEXT FIRST (CRITICAL)

Before identifying devices, carefully scan the ENTIRE photo for ALL visible text, including:
- **Handwritten text** in pen, marker, or pencil on the board, cover, blanking plates, or surrounding area
- **Label charts/legends** — printed or handwritten lists mapping circuit numbers to names (often stuck inside the door, above, or below the board)
- **Adhesive stickers** next to or below each device
- **Printed label strips** or engraved markings from the manufacturer
- **Text on cover plates** between devices
- **CIRCUIT DETAILS CARDS** — Most UK consumer units have one or two pre-printed cardboard cards clipped or stuck to the BOTTOM or INSIDE of the board cover. They have columns for: Circuit Number, Circuit Designation, Conductor CSA (Live/CPC in mm²), Overcurrent Protective Device (BS(EN), Type No., Rating). These cards can be a USEFUL ADDITIONAL source for circuit names, but be aware they are often NOT updated after changes to the board and may contain outdated or incorrect information. Use them as a cross-reference alongside strip labels, not as the primary source.

Handwritten text on consumer units is often faint, at an angle, or in poor lighting — look carefully. Note down every piece of text you can read before proceeding.

### COMMON HANDWRITTEN UK ABBREVIATIONS
UK electricians commonly use these shorthand labels. When you see these, expand them to the full term:
- "Imm" / "Immersion" = Immersion Heater (circuit for hot water tank heating element)
- "Smks" / "Smokes" / "Smoke" / "S/D" / "S/Det" = Smoke Alarm / Smoke Detector
- "Lts" / "Ltg" = Lights / Lighting
- "Skt" / "Skts" = Sockets
- "D/S" = Downstairs, "U/S" = Upstairs
- "CKR" / "Ckr" = Cooker
- "SH" / "Shwr" = Shower
- "Blr" = Boiler
- "FF" / "F/F" = Fridge Freezer
- "W/M" = Washing Machine
- "T/D" = Tumble Dryer
- "UFH" = Underfloor Heating
- "CH" = Central Heating
- "EV" / "EVCP" = Electric Vehicle Charging Point
- "Ext" = External / Outside
- "Gar" = Garage

## STEP 2: PHYSICAL DEVICE SCAN

Start by finding the MAIN SWITCH — it has a red toggle and is usually the largest device on the board. IMPORTANT: Many UK consumer units are SPLIT BOARDS where the main switch is in the MIDDLE, with circuits going BOTH directions:
- One side has "CIRCUITS PROTECTED BY RCD" (behind a standalone RCD)
- The other side has "CIRCUITS NOT RCD PROTECTED"
You MUST scan BOTH sides of the main switch — left AND right — and include ALL devices from both sides. Do NOT stop after scanning one side.

Identify EVERY physical module, including blank/spare positions. You MUST account for every single position on the board — do NOT stop partway through. If the board has 8 ways, you must account for all 8 positions — some may be blank cover plates (no device, no toggle lever) which MUST have ocpd_type: null and ocpd_rating_a: null. A blank slot with no MCB installed is NOT a circuit — it is a Spare with null ocpd_type and null ocpd_rating_a. Do NOT fabricate device data (type curve, amp rating) for positions where there is no physical device with a toggle lever. Use these width rules:
- MCB = 1 module (narrow, single toggle lever, NO test button)
- RCBO = 2 modules — ALWAYS has BOTH a toggle lever AND a small test button on the same device, plus an RCD waveform symbol. If a device has a test button, it is an RCBO, not an MCB.
- RCD = 2-4 modules (test button, protects multiple downstream circuits, is NOT itself a circuit breaker)
- Main switch / isolator = 2 modules (usually red toggle)
- SPD = 2-3 modules (has status indicator window, no toggle lever)
- Blank / spare = 1 module (flat cover plate, no toggle)

CRITICAL DISTINCTION between blank positions and spare MCBs:
- A **BLANK POSITION** has a flat cover plate with NO toggle lever, NO device behind it — it is an empty slot. Include it in the circuits array with label: "Spare", ocpd_type: null, and ocpd_rating_a: null. Do NOT invent MCB data (type, rating) for empty slots — a blank position has no physical device so it CANNOT have a type or rating.
- A **SPARE MCB** is a real physical MCB (with a toggle lever and visible rating) that has no circuit label — include it with label: "Spare" and its real ocpd_type/rating read from the device face.
- KEY: If a position has NO toggle lever and NO physical device, it MUST have ocpd_type: null and ocpd_rating_a: null. Never fabricate device data for empty positions.

Count the total modules to verify against the board's stated ways.

### MANDATORY DEVICE COUNT (you MUST complete this before proceeding)

After scanning both sides of the board, state your device count in this exact format BEFORE moving to Step 3:

DEVICE COUNT:
- Non-RCD side: [N] physical toggle levers + [M] blank cover plates = [N+M] total positions
- RCD side: [N] physical toggle levers + [M] blank cover plates = [N+M] total positions

This count is your ANCHOR for the rest of the extraction. When you generate the circuits JSON in Step 4:
- The number of entries with non-null ocpd_type MUST EXACTLY equal your toggle lever count for each side.
- The number of entries with ocpd_type: null MUST EXACTLY equal your blank cover plate count for each side.
- If these numbers do not match, you have either MISSED a device or FABRICATED a phantom device. Stop and re-examine the photo.

A toggle lever is the flip-switch on an MCB or RCBO. A blank cover plate is a flat plastic plate with NO toggle lever, NO test button, and NO device behind it — it is just filling an empty slot.

## STEP 3: MAP LABELS TO DEVICES (with CROSS-REFERENCING)

Match the text/labels you found in Step 1 to the physical devices from Step 2 based on PHYSICAL PROXIMITY — each label belongs to the device it is physically closest to. RCDs and the main switch are NOT numbered circuits — circuit labels skip over them.

CRITICAL: If the board has printed or handwritten circuit NUMBERS (e.g. "1", "2", "3" next to devices), IGNORE THESE NUMBERS COMPLETELY. These numbers are frequently wrong, out of date, or do not match the actual device positions. Only use the descriptive TEXT labels (e.g. "Cooker", "Lights", "Smoke Detector") and match them to devices by physical proximity. If a number and a text label appear together (e.g. "3 - Kitchen"), use the text "Kitchen" but ignore the number "3".

### CROSS-REFERENCE: STRIP LABELS vs CIRCUIT DETAILS CARD (CRITICAL)

If the photo contains BOTH strip labels above/below the devices AND a Circuit Details Card:
1. Read BOTH sources independently
2. The strip labels physically attached to the board near each device are the PRIMARY source — they reflect the current state of the board
3. Circuit Details Cards are a SECONDARY cross-reference — they are often outdated, incomplete, or wrong. Use them to help decipher unclear strip labels, but do NOT trust them over clear physical evidence
4. When the strip label and Circuit Details Card DISAGREE — prefer the strip label unless it is completely unreadable
5. When a strip label is UNCLEAR or FADED — the Circuit Details Card can help you interpret what it says, but verify against the physical device
6. **NO DUPLICATE DESIGNATIONS**: Do NOT assign the same designation (e.g. "Sockets", "Lighting") to multiple circuits unless you have strong physical evidence from BOTH the strip label AND the circuit details card confirming each occurrence independently. When strip labels are hard to read or ambiguous, cross-reference against the Circuit Details Card before assigning a name. If you cannot confirm a designation from at least one clear source, leave the label as null rather than guessing — a missing label is better than a duplicate that creates phantom circuits downstream.
7. **RCD IS NOT A CIRCUIT**: A standalone RCD (the double-width device with a TEST button and toggle lever) is a protection device, NOT a circuit breaker. Its toggle lever and test button must NEVER be counted as a device position or circuit way. Skip over it entirely when counting devices and numbering circuits.
8. **FADED / UNCLEAR STRIP LABELS → null**: If a strip label is faded, smudged, partially obscured, or otherwise not CLEARLY readable with high confidence, set the circuit label to null. NEVER guess a label from a faded strip, and NEVER copy or infer a label from an adjacent strip position. Each label must be independently and clearly readable to be used.
9. **CROSS-REFERENCE EVERY LABEL AGAINST THE CIRCUIT DETAILS CARD**: Before finalising any circuit label, check whether the Circuit Details Card at the bottom of the board lists a matching circuit. If a strip label appears to say something (e.g. "Sockets") but the Circuit Details Card does NOT list a corresponding entry for that position, treat the strip label as suspect and set the label to null. The card and strip must broadly agree for a label to be trusted.
10. **GENERIC LABEL DEDUPLICATION CHECK**: After your initial extraction pass, count how many times each generic designation appears (e.g. "Sockets", "Lighting", "Ring Main"). If any generic designation appears MORE than twice, you MUST re-examine each instance individually:
    - For each occurrence, can you point to a DISTINCT, clearly readable strip label AND a matching entry on the Circuit Details Card?
    - If not, set that circuit's label to null. Consumer units rarely have 3+ identically-named circuits — multiple occurrences almost always indicate misread faded labels.
    - Common misreads: "Heat" / "Hob" / "Cooker" misread as "Sockets" due to faded text. Check the Circuit Details Card for non-socket circuits (cooker, hob, heater) that may correspond to positions you've labeled as generic sockets.

IMPORTANT: Do NOT default to "Spare" or null for a circuit label if there is readable text on the strip labels or handwritten notes that identifies what the circuit supplies. A circuit with a visible MCB/RCBO and a readable label is NOT a spare.

## STEP 4: EXTRACT DATA

### PRE-EXTRACTION GATE (CRITICAL — do this BEFORE generating any circuit JSON)

For each position on the board, confirm:
- Can you see a toggle lever (MCB) or toggle + test button (RCBO)? → This is a REAL device. Extract its type, rating, and label.
- Is it a flat cover plate with NO toggle lever? → This is a BLANK position. It MUST have ocpd_type: null, ocpd_rating_a: null, label: "Spare". Do NOT copy data from adjacent devices.

Cross-check: Does your planned number of non-null circuit entries match the toggle lever count from your DEVICE COUNT in Step 2? If not, STOP — you are about to fabricate a phantom device or miss a real one. Re-examine the photo at the position that doesn't match.

### NUMBERING — CRITICAL

ALWAYS start from the RED MAIN SWITCH and number outward away from it. This is the ONLY method you must use — physical position from the main switch determines circuit order.

Circuit 1 is the device IMMEDIATELY next to the main switch (the red toggle). Circuit 2 is the next device after that, and so on, moving outward away from the main switch. Every 18mm-wide module position counts as one circuit way. Blank positions (flat cover plate, no device) are included with label: "Spare", ocpd_type: null, ocpd_rating_a: null — but do NOT fabricate device data for them.

IMPORTANT: Do NOT count standalone RCDs as circuit ways — they are double-width (36mm) protection devices that sit between the main switch and the circuits they protect. Skip over them when numbering.

**IGNORE PRINTED/HANDWRITTEN CIRCUIT NUMBERS ON THE BOARD.** Any numbers printed on the board cover, label strips, or handwritten next to devices are often WRONG or out of date. Do NOT use them for ordering. ALWAYS determine circuit order by physical position starting from the red main switch and moving outward. Map the handwritten/printed LABELS (e.g. "Cooker", "Lights") to devices based on their physical proximity to that device, but NEVER use the printed NUMBERS.

On split boards where the main switch is in the middle or at one end:
- Number the non-RCD side FIRST: Circuit 1 starts from the device nearest the main switch on that side, numbering outward
- Then number the RCD-protected side: Circuit numbering continues from where the non-RCD side left off, starting from the device nearest the main switch (or nearest the RCD which is closest to the main switch), numbering outward
- In the output JSON, list the non-RCD side circuits FIRST, then the RCD-protected side circuits

### AMP RATING — CRITICAL

Read the amp rating from the DEVICE FACE, not assumed from the circuit label.
- "Shower" does NOT mean 40A — read the actual breaker face.
- "Cooker" does NOT mean 32A — read the actual breaker face.
- If the rating is not legible, set to null and add to uncertain_fields. Do NOT guess from circuit name.

**CRITICAL — B6 vs B16 CONFUSION**: On many UK MCBs (especially Legrand), the type letter "B" and the rating number are printed with a wide gap between them. This makes "B 6" (6 amp) look deceptively like "B 16" (16 amp) — the whitespace can be misread as a "1" digit. ALWAYS verify the digit count:
- **B6** = letter B followed by a SINGLE digit "6". Common on lighting and smoke alarm circuits.
- **B16** = letter B followed by TWO digits "1" then "6". Common on radial socket circuits.
- If you read "B16" on a circuit labelled Lighting, Smoke Alarm, or Smoke Detector, DOUBLE-CHECK — UK lighting circuits are almost always 6A (B6), not 16A. A B16 on a lighting circuit is a strong signal you have misread a B6.
- When in doubt, look at the physical size of the printed number: a single "6" takes up less horizontal space than "16".

### FOR EACH DEVICE, EXTRACT:

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

### RCD TYPE — TWO-STEP DETERMINATION (CRITICAL)

STEP A: Read the waveform symbol on the device face. ALWAYS TRUST THE VISIBLE SYMBOL OVER ANY LOOKUP.
- Type AC = ONE waveform line only (a simple sine wave with nothing below it)
- Type A = TWO waveform lines stacked (sine wave on top + pulsating DC half-wave below it)
- Type B = THREE waveform lines stacked
- Type S = marked with letter "S" (time-delayed / selective)
- Type F = marked with letter "F"
- COUNT THE LINES in the waveform symbol carefully: 1 line = AC, 2 lines = A, 3 lines = B.
- CRITICAL: Look very carefully at the waveform. If there is ANY indication of a second line below the sine wave — even if faint or partially obscured — it is Type A, NOT Type AC. Type AC has ONLY a single clean sine wave with empty space below it.
- RCDs and RCBOs within the same board can be DIFFERENT types — check each device individually.
- If you CANNOT clearly count the waveform lines (e.g. due to photo angle, glare, resolution), set rcd_type to NULL. Do NOT guess — a wrong RCD type is worse than a missing one.

STEP B: ONLY if the symbol is not visible or legible, use your knowledge to LOOK UP
the RCD type from the manufacturer and model number you identified.
Different model ranges from the same manufacturer have different RCD types, so
match by the specific model prefix, not just manufacturer name. Examples:
- Hager: ADA/ADN series — ADA = Type A, ADN = Type AC
- MK: H79xx = Type AC, H68xx = Type A
- BG: CURB = Type AC, CUCRB = Type A
- Wylex: WRS = Type AC, WRSA = Type A; NSEM = Type A RCBO, NSB = MCB (no RCD type)
- Contactum: CRBO = Type A RCBO series
IMPORTANT: If you CAN see the waveform symbol, use it — do NOT override what you see with a lookup.

If BOTH steps fail, or if you are uncertain between AC and A, set rcd_type to null.
The system will perform a web search lookup to determine the correct type.
NEVER return "RCD" or "RCBO" as an rcd_type value. Always return one of: AC, A, B, F, S, or null.

### BOARD INFO

- Identify manufacturer and model if visible (e.g. "Hager", "MK", "Wylex").
- Note main switch position ("left" or "right").

### MAIN SWITCH DETAILS

- Read the current rating in amps (e.g., "63", "80", "100").
- Identify the type: "Isolator", "Switch Disconnector", "RCD", "RCCB", or other.
- Look for BS/EN standard number (e.g., "60947-3", "61008").
- Identify poles: "DP" (double pole), "TP" (triple pole), "TPN", "4P".
- Read voltage rating if printed (e.g., "230", "400").

### SPD (SURGE PROTECTION DEVICE)

- If an SPD module is visible, set spd_present to true and extract: BS/EN standard, SPD type ("Type 1", "Type 2", "Type 1+2", "Type 3"), rated current in amps, short circuit rating in kA.
- If NO SPD is visible, set spd_present to false.
- CRITICAL: SPD fields are for a dedicated surge protection device ONLY. Do NOT copy the main switch rating into spd_rated_current_a. The main switch (e.g. 100A isolator) goes ONLY in main_switch_current/main_switch_rating. These are completely different components.

### DEVICE TYPE MAPPING

For each circuit device:
- If it is an RCBO (combined MCB+RCD): set is_rcbo=true, rcd_protected=true, and set rcd_type from the device's own waveform symbol
- If it is behind a standalone RCD: set is_rcbo=false, rcd_protected=true, and set rcd_type from the upstream RCD's waveform symbol
- If it is a plain MCB with no RCD protection: set is_rcbo=false, rcd_protected=false, rcd_type=null
- Blank/empty positions (flat cover plate, no device): set ocpd_type to null, ocpd_rating_a to null, label to "Spare"
- Spare MCBs (real device, no label): set label to "Spare", read ocpd_type and rating from the device face

### CIRCUIT LABELS — CRITICAL

You MUST use the text you identified in Step 1. Circuit labels are essential for the certificate — missing labels means the certificate is incomplete.

Common UK circuit names: "Lighting", "Ring Main", "Kitchen Sockets", "Cooker", "Shower", "Immersion Heater", "Water Heater", "Smoke Alarm", "Garage", "Garden", "Upstairs Sockets", "Downstairs Sockets", "Boiler", "Fridge Freezer", "Washer", "Central Heating", "Electric Vehicle".

If you can see ANY text that identifies what a circuit supplies — whether handwritten, printed, on a sticker, on a label chart, or on a Circuit Details Card — return it. Only return null if there is genuinely no label visible for that circuit from ANY source.

**NORMALISATION**: When returning the label, use the standard EICR certificate form. Apply these mappings:
- "Immersion" / "Imm" / "Immersion Heater" → "Water Heater"
- "Smokes" / "Smoke" / "Smoke Det" / "Smoke Detector" / "S/D" → "Smoke Alarm"
- "Lts" / "Ltg" → "Lights"
- "Skt" / "Skts" → "Sockets" (keep any prefix, e.g. "Skt kitchen" → "Kitchen Sockets")
- "Ring" / "Ring Main" → "Ring Main"
- "Rad" / "Radial" → "Radial"
- "CKR" → "Cooker"
- "Shwr" → "Shower"
- "Blr" → "Boiler"
- "FF" / "F/F" → "Fridge Freezer"
- "CH" → "Central Heating"
- "UFH" → "Underfloor Heating"

Use proper capitalisation (title case). If the handwritten label says "immersion", return "Water Heater". If it says "smokes", return "Smoke Alarm".

## STEP 5: CROSS-CHECK

Before outputting JSON, verify:
- You have extracted EVERY module position on the board — both physical devices (MCBs/RCBOs) and blank positions. If your circuits array has fewer entries than the number of module positions visible, you have MISSED some.
- CRITICAL PHANTOM DEVICE CHECK: Compare your circuits array against the DEVICE COUNT from Step 2. Count how many entries have non-null ocpd_type on each side. This number MUST EXACTLY match the toggle lever count you stated. If you have MORE non-null entries than toggle levers, you have fabricated a phantom device — find it by re-examining each position in the photo and checking: is there a toggle lever here, or just a flat blank plate? Fix any phantom: set ocpd_type: null, ocpd_rating_a: null, ocpd_bs_en: null, ocpd_breaking_capacity_ka: null, label: "Spare". Common phantom pattern: the last position on a side is a blank cover plate but gets filled with data copied from the adjacent B6 MCB.
- Every circuit with a physical device has a label if ANY text was visible for it — re-check the text from Step 1.
- The count of MCBs + RCBOs + blank positions matches the total module positions on the board (excluding main switch and standalone RCDs).
- The total module count is consistent with the board's stated ways.
- Every amp rating was read from the device face (not assumed from the circuit label).
- An RCD type (AC, A, B, F, or S) was identified for every RCD and every RCBO individually.
- SPD presence was explicitly checked (present or absent).
- All labels are normalised to standard EICR certificate terms (e.g. "Immersion" → "Water Heater", "Smokes" → "Smoke Alarm").
- If any check fails, note it in confidence.message and add relevant fields to uncertain_fields.

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
  "questionsForInspector": ["Question 1?", "Question 2?"],
  "circuits": [
    {
      "circuit_number": 1,
      "label": "Kitchen Sockets or null",
      "ocpd_type": "B|C|D or null (null ONLY for blank positions with no physical device)",
      "ocpd_rating_a": "32 or null",
      "ocpd_bs_en": "60898-1 or null",
      "ocpd_breaking_capacity_ka": "6 or null",
      "is_rcbo": false,
      "rcd_protected": true,
      "rcd_type": "AC|A|B|F|S or null",
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

## QUESTIONS FOR INSPECTOR

CRITICAL: These questions are READ ALOUD via text-to-speech to an inspector on site. Keep them EXTREMELY short and conversational — no technical numbers, no BS/EN references, no amp ratings.

Return an EMPTY array [] unless you absolutely could not determine the RCD type for a circuit.

The ONLY valid reason to add a question is:
- RCD type is null because you could not read the waveform symbol AND could not look it up — ask simply: "What is the RCD type for circuit N? Type A or AC?"

NEVER include in questions:
- BS/EN numbers, breaking capacity, or any technical specifications
- Board manufacturer, model, or any board details
- Main switch rating, type, or poles
- Confirmation of ANY value you already set
- Image quality concerns (put those in confidence.message)
- SPD details
- Circuit labels you DID extract
- Long sentences with multiple data points

If everything was readable, return an EMPTY array []. Most photos should result in zero questions.

IMPORTANT: If you cannot read the BS/EN number from the device, use your knowledge to look it up based on manufacturer and model. Only leave as null if you cannot identify the device at all.`;

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // Use AbortController to enforce extraction timeout (default 60s)
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CCU_EXTRACTION_TIMEOUT_MS);

    let response;
    try {
      response = await anthropic.messages.create(
        {
          model,
          max_tokens: 8192,
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
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: openaiKey });
      analysis = await lookupMissingRcdTypes(analysis, openai, logger, req.user.id);
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

    res.json(analysis);
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
