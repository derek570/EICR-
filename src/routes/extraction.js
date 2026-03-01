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
 * Apply fallback BS/EN numbers to circuits based on device type
 */
function applyBsEnFallback(analysis) {
  if (!analysis?.circuits) return analysis;

  for (const circuit of analysis.circuits) {
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
    const validRcdTypes = ['AC', 'A', 'B', 'F', 'S'];
    if (circuit.rcd_type) {
      const normalised = circuit.rcd_type.toUpperCase().trim();
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

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const model = (process.env.CCU_MODEL || 'gpt-5.2').trim();

    logger.info('CCU photo analysis requested', {
      userId: req.user.id,
      fileSize: req.file.size,
      model,
    });

    const imageBytes = await fs.readFile(tempPath);
    const base64 = Buffer.from(imageBytes).toString('base64');

    const prompt = `You are an expert UK electrician analysing a photo of a consumer unit for an EICR certificate.

## TASK

Extract every protective device from this consumer unit photo and return structured JSON. Before producing the JSON output, you MUST work through the following 4-step methodology internally to ensure accuracy.

## STEP 1: PHYSICAL DEVICE SCAN

Scan the board left to right and identify every physical module. Use these width rules:
- MCB = 1 module (narrow, single toggle lever)
- RCBO = 2 modules (toggle lever + test button + RCD waveform symbol)
- RCD = 2-4 modules (test button, protects multiple downstream circuits, is NOT itself a circuit breaker)
- Main switch / isolator = 2 modules (usually red toggle)
- SPD = 2-3 modules (has status indicator window, no toggle lever)
- Blank / spare = 1 module (flat cover plate, no toggle)

Count the total modules to verify against the board's stated ways.

## STEP 2: MAP LABELS TO DEVICES

RCDs and the main switch are NOT numbered circuits — circuit labels skip over them. If circuit number labels do not align with physical devices, note the discrepancy in the confidence message.

## STEP 3: EXTRACT DATA

### NUMBERING

Find the main switch first. Circuit 1 starts from the device immediately next to the main switch, numbering outward. The main switch may be on the left or right.

### AMP RATING — CRITICAL

Read the amp rating from the DEVICE FACE, not assumed from the circuit label.
- "Shower" does NOT mean 40A — read the actual breaker face.
- "Cooker" does NOT mean 32A — read the actual breaker face.
- If the rating is not legible, set to null and add to uncertain_fields. Do NOT guess from circuit name.

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

STEP A: Read the waveform symbol on the device face.
- Type AC = ONE waveform line (simple sine wave)
- Type A = TWO waveform lines stacked (sine wave + pulsating DC half-wave)
- Type B = THREE waveform lines stacked
- Type S = marked with letter "S" (time-delayed / selective)
- Type F = marked with letter "F"
- COUNT THE LINES in the waveform symbol: 1 line = AC, 2 lines = A, 3 lines = B.
- RCDs and RCBOs within the same board can be DIFFERENT types — check each device individually.

STEP B: If the symbol is not visible or legible, LOOK UP the type from the
manufacturer and model number you identified. This is MANDATORY — do not
leave rcd_type as null without attempting a lookup. Common UK device mappings:
- Hager ADA/ADC = Type A, Hager ADN = Type AC
- MK H68xx/Sentry = Type A, MK H79xx = Type AC
- BG CUCRB = Type A, BG CURB = Type AC
- Wylex NHXS = Type A, Wylex NHX = Type AC
- Schneider Acti9 iID/iC60H RCBO variants = Type A
- Contactum CPBR = Type A
Match by the MODEL PREFIX, not just manufacturer.

If BOTH steps fail, set rcd_type to null and add a question to
questionsForInspector asking the inspector to confirm the RCD type.
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

### DEVICE TYPE MAPPING

For each circuit device:
- If it is an RCBO (combined MCB+RCD): set is_rcbo=true, rcd_protected=true, and set rcd_type from the device's own waveform symbol
- If it is behind a standalone RCD: set is_rcbo=false, rcd_protected=true, and set rcd_type from the upstream RCD's waveform symbol
- If it is a plain MCB with no RCD protection: set is_rcbo=false, rcd_protected=false, rcd_type=null
- Blank/spare positions: set ocpd_type to null, label to null

### CIRCUIT LABELS — IMPORTANT

Actively look for circuit names/labels. They are CRITICAL for the certificate. Check ALL of the following locations in the photo:
- **Label chart/legend**: A printed or handwritten list mapping circuit numbers to names (often inside the door or below the board)
- **Adhesive stickers**: Individual labels stuck next to or below each device
- **Handwritten labels**: Pen/marker writing on the board, cover, or blanking plates
- **Printed panels**: Manufacturer-provided label strips or engraved markings
- **Cover plate text**: Text printed on the plastic blanking strips between devices

Common UK circuit names: "Lighting", "Ring Main", "Kitchen Sockets", "Cooker", "Shower", "Immersion", "Smoke Alarms", "Garage", "Garden", "Upstairs Sockets", "Downstairs Sockets", "Boiler", "Fridge Freezer", "Washer".

If you can see ANY text that identifies what a circuit supplies, return it as the label. Only return null if there is genuinely no label visible for that circuit.

## STEP 4: CROSS-CHECK

Before outputting JSON, verify:
- The count of MCBs + RCBOs matches the number of circuit labels/positions found.
- The total module count is consistent with the board's stated ways.
- Every amp rating was read from the device face (not assumed from the circuit label).
- An RCD type (AC, A, B, F, or S) was identified for every RCD and every RCBO individually.
- SPD presence was explicitly checked (present or absent).
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
      "ocpd_type": "B|C|D or null for blanks",
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

If ANY information is unclear, illegible, or ambiguous, add plain English questions to the "questionsForInspector" array. Do NOT guess when uncertain — ask instead.

Always ask about RCD type when you could not determine it from the waveform symbol or model lookup. Example: "What is the RCD type for circuits 1-5? I can see it's a Hager ADN but the waveform symbol is not legible."

Other examples: "Is circuit 3 a 20A or 32A breaker? The rating is obscured.", "Is the board a 12-way or 14-way? Two positions are hidden behind cable trunking." If everything is clear, return an empty array.

IMPORTANT: If you cannot read the BS/EN number from the device, use your knowledge to look it up based on manufacturer and model. Only leave as null if you cannot identify the device at all.`;

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey });

    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const response = await openai.chat.completions.create({
      model,
      max_completion_tokens: 8192,
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

    logger.info('CCU analysis complete', {
      userId: req.user.id,
      model,
      promptTokens,
      completionTokens,
      responseLength: content.length,
      finishReason,
      rawContentPreview: content.slice(0, 500),
    });

    if (finishReason === 'length') {
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

    let analysis = JSON.parse(jsonStr);

    analysis = applyBsEnFallback(analysis);

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

    const inputCost = (promptTokens * 0.002) / 1000;
    const outputCost = (completionTokens * 0.012) / 1000;
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
    logger.error('CCU analysis failed', {
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
