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
import {
  createFileFilter,
  IMAGE_MIMES,
  DOCUMENT_MIMES,
  handleUploadError,
} from '../utils/upload.js';
import { prepareModernGeometry, classifyModernSlots } from '../extraction/ccu-geometric.js';
import { tightenAndChunk } from '../extraction/ccu-box-tighten.js';
import { tightenAndChunkQuad } from '../extraction/ccu-rail-quad.js';
import { inferTechnologyFromModel } from '../extraction/board-model-registry.js';
import {
  prepareRewireableGeometry,
  classifyRewireableSlots,
} from '../extraction/ccu-geometric-rewireable.js';
import { extractSlotLabels } from '../extraction/ccu-label-pass.js';
import { resolveMainSwitchSide } from '../extraction/main-switch-resolver.js';
import { applyRcdTypeLookup, lookupRcdType } from '../extraction/rcd-type-lookup.js';
import { writeRcdPendingEntry } from '../extraction/rcd-pending-writer.js';
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
export function adaptTightenerToPrepared(t) {
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
    // Top-level usage + timings — assembleGeometricResult reads these directly
    // (prepared.usage.inputTokens, prepared.timings.stage1Ms). The box-tightener
    // is pure CV so usage is zero; tightener wall-clock isn't currently surfaced
    // here, so stage1/stage2Ms are zero. The Anthropic-call timing log fired
    // by the route handler captures the real wall-clock cost of the pipeline.
    usage: { inputTokens: 0, outputTokens: 0 },
    timings: { stage1Ms: 0, stage2Ms: 0 },
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

// Doc-extract takes either an image (camera-shot of a printed cert) or a
// PDF (typed cert export). PDFs go straight to Anthropic's native document
// block — no client-side rendering or downscaling — so we accept the PDF
// MIME alongside images on this route only. CCU + observation routes
// remain image-only.
const documentUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, `${file.fieldname}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: createFileFilter([...IMAGE_MIMES, ...DOCUMENT_MIMES]),
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
 * BS/EN standard number lookup by device type. Canonicals match
 * `config/field_schema.json` `ocpd_bs_en` / `rcd_bs_en` options and
 * iOS `Constants.swift` picker options — written form is the prefixed
 * form ("BS EN 60898", not bare-digit "60898-1") so the iOS picker,
 * the printed PDF, the resolver enum check, and what inspectors say
 * aloud all agree.
 */
const BS_EN_LOOKUP = {
  MCB: 'BS EN 60898',
  B: 'BS EN 60898',
  C: 'BS EN 60898',
  D: 'BS EN 60898',
  RCBO: 'BS EN 61009',
  RCD: 'BS EN 61008',
  RCCB: 'BS EN 61008',
  MCCB: 'BS EN 60947-2',
  SWITCH: 'BS EN 60947-3',
  ISOLATOR: 'BS EN 60947-3',
  gG: 'BS EN 60269-2',
  HRC: 'BS EN 60269-2',
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

// Confidence threshold for the secondary "uniform low-confidence" trigger
// in lookupMissingRcdTypes. The waveform glyph (BS EN 61008/61009 Type
// AC/A/F/B symbol) on the device face is sub-millimetre — much smaller
// than rating/curve text. The VLM frequently reports a value with mediocre
// confidence rather than honouring the prompt's "null if unclear" rule.
// 0.85 was picked from the 2026-05-02 Crabtree field case where every
// slot read "AC" at 0.65–0.92 (avg 0.79) and the ground truth was Type A.
export const RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Compute the average per-slot confidence over the slots that actually
 * carry an RCD waveform reading (RCBOs and standalone RCDs with a
 * non-null rcdWaveformType). Returns null when there aren't enough
 * RCD-bearing slots to make uniformity a meaningful signal.
 */
function summariseRcdWaveformReads(slots) {
  if (!Array.isArray(slots)) return null;
  const rcdSlots = slots.filter(
    (s) =>
      s && (s.classification === 'rcbo' || s.classification === 'rcd') && s.rcdWaveformType != null
  );
  if (rcdSlots.length < 2) return null;
  const values = rcdSlots.map((s) => s.rcdWaveformType);
  const uniqueValues = new Set(values);
  const avgConfidence =
    rcdSlots.reduce((a, s) => a + (typeof s.confidence === 'number' ? s.confidence : 0), 0) /
    rcdSlots.length;
  return {
    count: rcdSlots.length,
    uniqueValues,
    uniformValue: uniqueValues.size === 1 ? values[0] : null,
    avgConfidence,
  };
}

/**
 * Web search pass to fill / verify RCD types.
 *
 * Two triggers, both routed through the same gpt-5-search-api lookup:
 *
 * 1. `missing` — original behaviour. Stage 3 returned null `rcdWaveformType`
 *    on at least one RCD-protected circuit (waveform symbol genuinely
 *    illegible). The search fills nulls.
 *
 * 2. `uniform_low_conf` — secondary verification trigger. Stage 3 returned
 *    the SAME rcdWaveformType on every RCD-bearing slot AND the average
 *    per-slot confidence was below RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD.
 *    This is the signature of a fleet-wide VLM default rather than 11
 *    confident reads — the glyph is sub-millimetre and the model tends to
 *    fall back to "AC" rather than null. The search verifies against the
 *    datasheet and OVERRIDES the suspect uniform value if the verified
 *    type differs.
 *
 * Both require a known board manufacturer (the search is keyed on it).
 */
export async function lookupMissingRcdTypes(analysis, openai, logger, userId) {
  const circuits = analysis.circuits || [];
  const manufacturer = analysis.board_manufacturer;
  const slots = Array.isArray(analysis.slots) ? analysis.slots : [];

  // Manufacturer is required for either trigger — without it the search
  // has nothing to key on.
  if (!manufacturer) {
    logger.info('RCD type lookup skipped — no manufacturer', {
      userId,
      totalCircuits: circuits.length,
      rcdProtectedCount: circuits.filter((c) => c.rcd_protected).length,
    });
    return analysis;
  }

  // Primary trigger: any RCD-protected circuit with null rcd_type.
  const missingType = circuits.filter((c) => c.rcd_protected && !c.rcd_type);

  // Secondary trigger: detect the "Stage 3 defaulted to a single value
  // across the whole board with mediocre confidence" signature. We compute
  // this regardless of whether the primary trigger fired — useful in the
  // log output for both branches and as a fallback when no nulls remain.
  const summary = summariseRcdWaveformReads(slots);
  const isUniformLowConf =
    summary != null &&
    summary.uniformValue != null &&
    summary.avgConfidence < RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD;

  let trigger;
  let needsLookup;
  if (missingType.length > 0) {
    trigger = 'missing';
    needsLookup = missingType;
  } else if (isUniformLowConf) {
    trigger = 'uniform_low_conf';
    // Verify ALL RCD-protected circuits — they all share the same suspect
    // uniform value, so any override applies to the whole fleet.
    needsLookup = circuits.filter((c) => c.rcd_protected);
  } else {
    logger.info('RCD type lookup skipped — all RCD-protected circuits already have types', {
      userId,
      totalCircuits: circuits.length,
      rcdProtectedCount: circuits.filter((c) => c.rcd_protected).length,
      rcdSlotCount: summary?.count ?? 0,
      avgConfidence: summary ? Number(summary.avgConfidence.toFixed(3)) : null,
      uniformValue: summary?.uniformValue ?? null,
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

  // When the secondary trigger fires we tell the search what Stage 3 read
  // and how confident it was — gives the search a concrete claim to verify
  // rather than a blank-slate query.
  const verificationContext =
    trigger === 'uniform_low_conf' && summary
      ? `\nThe vision model read Type ${summary.uniformValue} on all ${summary.count} RCD devices but with low confidence (avg ${summary.avgConfidence.toFixed(2)}) — the BS EN 61008/61009 waveform glyph on the device face was likely too small to read reliably. Please verify against the manufacturer's published spec; if the published type is different, reply with the published type.`
      : '';

  const searchPrompt = `I have a UK consumer unit: ${manufacturer} ${boardModel}.
It contains ${needsLookup.length} RCD-protected circuits where I need to determine the RCD type.
${hasStandaloneRcd ? 'Some circuits are protected by a standalone RCD/RCCB in the board.' : 'The circuits use RCBOs (combined MCB+RCD).'}${verificationContext}

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
      trigger,
      stage3UniformValue: summary?.uniformValue ?? null,
      stage3AvgConfidence: summary ? Number(summary.avgConfidence.toFixed(3)) : null,
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
      let filled = 0;
      let overridden = 0;
      for (const c of needsLookup) {
        if (!c.rcd_type) {
          c.rcd_type = rcdType;
          filled += 1;
        } else if (trigger === 'uniform_low_conf' && c.rcd_type !== rcdType) {
          // Override the suspect uniform Stage 3 read with the verified
          // datasheet value. Only happens on the secondary trigger — the
          // primary `missing` trigger preserves existing reads.
          c.rcd_type = rcdType;
          overridden += 1;
        }
      }
      logger.info('RCD type web search found type', {
        userId,
        rcdType,
        source: searchResult.source || 'unknown',
        trigger,
        filled,
        overridden,
        previousValue: trigger === 'uniform_low_conf' ? (summary?.uniformValue ?? null) : null,
      });
    }

    // Count how many ended up with the looked-up type — for the primary
    // trigger this matches "filled" above; for uniform_low_conf it matches
    // "overridden" plus any pre-existing-equal circuits.
    const totalWithType = needsLookup.filter((c) => c.rcd_type).length;
    logger.info('RCD type web search applied', {
      userId,
      trigger,
      filled: totalWithType,
      total: needsLookup.length,
    });

    // Prune stale questionsForInspector — GPT adds RCD type questions BEFORE
    // this web search pass runs. If we resolved those types, the questions are
    // now stale and would cause unnecessary TTS interruptions on the iOS app.
    if (totalWithType > 0 && Array.isArray(analysis.questionsForInspector)) {
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
    // Non-fatal — log and continue with whatever rcd_types Stage 3 produced
    logger.warn('RCD type web search failed (non-fatal)', {
      userId,
      trigger,
      error: err.message,
    });
  }

  return analysis;
}

// Cluster-floor for the outlier detector. Five same-manufacturer, same-
// type confident reads is the smallest cluster where "this slot
// disagrees with the rest of the board" is a statistically meaningful
// signal. A 4-vs-1 split on a tiny board could just as easily be a real
// mixed schedule (older device retained mid-bank, which the user has
// flagged as common in UK domestic re-wires). Lowering this would catch
// more false positives; raising it would miss real outliers on smaller
// boards. Keeping it at 5 leaves small boards untouched.
export const RCD_OUTLIER_CLUSTER_FLOOR = 5;

/**
 * Detect RCD waveform-type outliers within a same-manufacturer cluster.
 *
 * The Stage 3 per-slot VLM occasionally mis-reads the BS EN 61008/61009
 * waveform glyph on ONE device face on an otherwise-uniform board (the
 * symbol is sub-millimetre and even confident reads can flip A↔AC). The
 * existing `uniform_low_conf` lookup gate misses this case because the
 * cluster's reads all came back at high confidence.
 *
 * This detector finds slots whose `rcdWaveformType` disagrees with the
 * rest of the board WHEN the rest of the board is a same-manufacturer
 * confident cluster. It does NOT auto-correct — the caller's job is to
 * flag the outlier circuit `low_confidence:true` and surface a question
 * for the inspector to verify on-device.
 *
 * Manufacturer-clustering is the load-bearing assumption: a genuinely
 * older AC-type RCBO retrofitted into an A-type board nearly always
 * comes from a DIFFERENT manufacturer (the inspector grabbed whatever
 * was in the van), so it lands in its own size-1 cluster and never
 * crosses the cluster floor. Same-manufacturer disagreement, on the
 * other hand, almost always means one slot was misread.
 *
 * Returns an array of outlier descriptors. Empty if no eligible
 * cluster + outlier was found.
 */
export function detectRcdWaveformOutliers(slots, opts = {}) {
  const minClusterSize = opts.minClusterSize ?? RCD_OUTLIER_CLUSTER_FLOOR;
  const minConfidence = opts.minConfidence ?? RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD;

  if (!Array.isArray(slots)) return [];

  const eligible = slots.filter(
    (s) =>
      s &&
      (s.classification === 'rcbo' || s.classification === 'rcd') &&
      typeof s.rcdWaveformType === 'string' &&
      s.rcdWaveformType.length > 0 &&
      typeof s.manufacturer === 'string' &&
      s.manufacturer.trim().length > 0 &&
      (s.confidence ?? 0) >= minConfidence
  );

  if (eligible.length < minClusterSize + 1) return [];

  const groups = new Map();
  for (const s of eligible) {
    const key = s.manufacturer.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const outliers = [];
  for (const group of groups.values()) {
    if (group.length < minClusterSize + 1) continue;

    const counts = new Map();
    for (const s of group) {
      counts.set(s.rcdWaveformType, (counts.get(s.rcdWaveformType) ?? 0) + 1);
    }
    if (counts.size < 2) continue;

    let majorityValue = null;
    let majorityCount = 0;
    for (const [v, c] of counts) {
      if (c > majorityCount) {
        majorityValue = v;
        majorityCount = c;
      }
    }
    if (majorityCount < minClusterSize) continue;

    for (const s of group) {
      if (s.rcdWaveformType !== majorityValue) {
        outliers.push({
          slot: s,
          slotIndex: s.slotIndex ?? null,
          slotValue: s.rcdWaveformType,
          slotConfidence: s.confidence ?? null,
          slotRatingText: s.ratingText ?? null,
          slotLabel: s.label ?? null,
          majorityValue,
          majorityCount,
          manufacturer: s.manufacturer.trim(),
        });
      }
    }
  }

  return outliers;
}

/**
 * Verify RCD waveform-type outliers against the manufacturer's spec sheet
 * and flag the affected circuits for inspector review. NEVER auto-corrects
 * the outlier value — the inspector decides.
 *
 * Pipeline:
 *   1. detectRcdWaveformOutliers identifies any same-manufacturer outlier
 *      (caller-injected slots[] is already populated).
 *   2. For each manufacturer-group with outliers, fire ONE web-search
 *      lookup against gpt-5-search-api with a per-slot prompt: "10 slots
 *      read X, this one read Y — what does the datasheet say?" The
 *      response indicates which value the datasheet supports for the
 *      outlier device (`applies_to: outlier|all|unknown`).
 *   3. Whatever the lookup returns, flag the matching circuit:
 *        - circuit.low_confidence = true
 *        - circuit.rcd_type_outlier = true
 *        - circuit.rcd_type_majority_value = <the majority value>
 *        - circuit.rcd_type_datasheet = <lookup answer or null>
 *      Append a question to questionsForInspector so the iOS review screen
 *      surfaces it. Leave circuit.rcd_type UNCHANGED — manual confirmation
 *      only.
 *
 * Skipped silently when OPENAI_API_KEY is unset (dev/sandbox) or the
 * detector returns no outliers — same lifecycle as lookupMissingRcdTypes.
 */
export async function flagRcdWaveformOutliers(analysis, openai, logger, userId) {
  const slots = Array.isArray(analysis.slots) ? analysis.slots : [];
  const circuits = Array.isArray(analysis.circuits) ? analysis.circuits : [];

  const rawOutliers = detectRcdWaveformOutliers(slots);
  if (rawOutliers.length === 0) return analysis;

  // Suppress outliers already resolved by the upstream RCD-type lookup.
  // applyRcdTypeLookup runs BEFORE this pass and stamps circuit.rcd_type
  // from the manufacturer/model datasheet (high-confidence override on a
  // model hit, manufacturer-default fallback otherwise). When the lookup
  // has already pulled an outlier slot's circuit onto the majority value,
  // the per-slot Stage 3 disagreement is moot — flagging it generates a
  // pointless inspector question (verbatim production repro 2026-05-05
  // 15:05 on a 13-RCBO Elucian board: 5 outlier reads of "AC" all got
  // stamped to "A" by the lookup, but the outlier flagger then asked the
  // inspector to verify all 5 anyway, producing 5 TTS prompts even after
  // the inspector had set the value via the UI).
  const outliers = rawOutliers.filter((o) => {
    const circuit = circuits.find(
      (c) => c.slot_index != null && c.slot_index === o.slotIndex && !c.is_rcd_device
    );
    if (!circuit) return true;
    const postLookupType = typeof circuit.rcd_type === 'string' ? circuit.rcd_type : null;
    if (postLookupType && postLookupType === o.majorityValue) return false;
    return true;
  });
  if (outliers.length < rawOutliers.length && logger) {
    logger.info('RCD waveform outliers suppressed by upstream lookup', {
      userId,
      raw: rawOutliers.length,
      remaining: outliers.length,
      suppressed: rawOutliers.length - outliers.length,
    });
  }
  if (outliers.length === 0) return analysis;

  // Group outliers by manufacturer so we can batch the lookup — usually
  // 1 outlier per board, but if a board ever had two slots disagreeing
  // with the same majority cluster, batching saves a search call.
  const byManufacturer = new Map();
  for (const o of outliers) {
    const key = o.manufacturer.toLowerCase();
    if (!byManufacturer.has(key)) byManufacturer.set(key, []);
    byManufacturer.get(key).push(o);
  }

  const boardModel = analysis.board_model || '';

  for (const [, group] of byManufacturer) {
    const first = group[0];
    const manufacturer = first.manufacturer;
    const majorityValue = first.majorityValue;
    const majorityCount = first.majorityCount;
    const outlierLines = group
      .map((o) => {
        const labelPart = o.slotLabel ? ` labelled "${o.slotLabel}"` : '';
        const ratingPart = o.slotRatingText ? `, ${o.slotRatingText}` : '';
        return `  - ${manufacturer} RCBO${ratingPart}${labelPart}: read as Type ${o.slotValue}`;
      })
      .join('\n');

    const searchPrompt = `I have a UK consumer unit: ${manufacturer} ${boardModel}.
Most of the RCBOs on this board (${majorityCount} devices) were read by a vision model as RCD Type ${majorityValue}. ${group.length === 1 ? 'One device disagreed' : `${group.length} devices disagreed`}:
${outlierLines}

This is most likely a mis-read of the BS EN 61008/61009 waveform glyph on the disagreeing device's face — the symbol is sub-millimetre and easy to confuse. Please search the ${manufacturer} ${boardModel} consumer unit datasheet to verify the published RCD Type for the disagreeing device. If the datasheet covers the whole board uniformly, return that single Type with applies_to="all". If the datasheet shows the disagreeing device as a different Type from the majority (which can happen if it's an older spec retained in stock), return that Type with applies_to="outlier".

Reply ONLY with valid JSON:
{"type": "AC"|"A"|"B"|"F"|"S"|null, "applies_to": "all"|"outlier"|"unknown", "source": "brief description"}`;

    let datasheetType = null;
    let appliesTo = 'unknown';
    let sourceText = null;

    try {
      logger.info('RCD waveform outlier lookup starting', {
        userId,
        manufacturer,
        boardModel,
        majorityValue,
        majorityCount,
        outlierCount: group.length,
        outlierValues: group.map((o) => o.slotValue),
      });

      const searchResponse = await openai.chat.completions.create({
        model: 'gpt-5-search-api',
        web_search_options: {},
        messages: [{ role: 'user', content: searchPrompt }],
      });

      const searchContent = searchResponse.choices?.[0]?.message?.content || '';
      const searchTokens = searchResponse.usage?.completion_tokens || 0;
      const jsonMatch = searchContent.match(/\{[\s\S]*?\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      const validTypes = ['AC', 'A', 'B', 'F', 'S'];
      const candidate = parsed.type?.toUpperCase()?.trim();
      datasheetType = candidate && validTypes.includes(candidate) ? candidate : null;
      appliesTo = ['all', 'outlier', 'unknown'].includes(parsed.applies_to)
        ? parsed.applies_to
        : 'unknown';
      sourceText = typeof parsed.source === 'string' ? parsed.source : null;

      logger.info('RCD waveform outlier lookup complete', {
        userId,
        manufacturer,
        datasheetType,
        appliesTo,
        source: sourceText,
        searchTokens,
      });
    } catch (err) {
      // Non-fatal — flagging proceeds without datasheet steer.
      logger.warn('RCD waveform outlier lookup failed (non-fatal)', {
        userId,
        manufacturer,
        error: err.message,
      });
    }

    // Apply flags to each outlier's circuit. Mapping is by slot_index —
    // both the slot and the circuit carry it after the merger pass.
    for (const o of group) {
      const circuit = circuits.find(
        (c) => c.slot_index != null && c.slot_index === o.slotIndex && !c.is_rcd_device
      );
      if (!circuit) {
        logger.warn('RCD outlier flag: matching circuit not found', {
          userId,
          slotIndex: o.slotIndex,
          slotValue: o.slotValue,
        });
        continue;
      }

      circuit.low_confidence = true;
      circuit.rcd_type_outlier = true;
      circuit.rcd_type_majority_value = o.majorityValue;
      circuit.rcd_type_datasheet = datasheetType;
      // rcd_type intentionally untouched — never auto-correct.

      let questionText;
      if (datasheetType && appliesTo === 'all') {
        questionText = `${circuit.label || `Circuit ${circuit.circuit_number}`}: this device was read as RCD Type ${o.slotValue}, but the other ${o.majorityCount} ${manufacturer} RCBOs on this board read as Type ${o.majorityValue} and the ${manufacturer} ${boardModel || ''} datasheet confirms Type ${datasheetType}. Please verify the waveform symbol on the device face.`;
      } else if (datasheetType && appliesTo === 'outlier') {
        questionText = `${circuit.label || `Circuit ${circuit.circuit_number}`}: this device was read as RCD Type ${o.slotValue} (the other ${o.majorityCount} ${manufacturer} RCBOs read as Type ${o.majorityValue}). The ${manufacturer} datasheet shows Type ${datasheetType} for this rating, so the read may be correct — please verify on the device face.`;
      } else {
        questionText = `${circuit.label || `Circuit ${circuit.circuit_number}`}: this device was read as RCD Type ${o.slotValue}, but the other ${o.majorityCount} ${manufacturer} RCBOs on this board read as Type ${o.majorityValue}. Please double-check the waveform symbol on the device face.`;
      }

      if (!Array.isArray(analysis.questionsForInspector)) {
        analysis.questionsForInspector = [];
      }
      analysis.questionsForInspector.push(questionText);

      logger.info('RCD waveform outlier flagged', {
        userId,
        slotIndex: o.slotIndex,
        circuitNumber: circuit.circuit_number,
        label: circuit.label,
        slotValue: o.slotValue,
        majorityValue: o.majorityValue,
        datasheetType,
        appliesTo,
      });
    }
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

// ---------------------------------------------------------------------------
// 2026-05-07: removed 305 lines of patch functions that fixed symptoms of
// the position-clustered sliding-window pipeline:
//   - scoreMainSwitchPlausibility / trimSpuriousMainSwitchClusterRuns —
//     fixed Stage 3 over-tagging adjacent slots as main_switch when the
//     2-mod isolator's lever bleed crossed slot boundaries. The new
//     ordered-list prompt asks the VLM to return a 2-pole isolator as
//     exactly two adjacent main_switch entries — over-tagging cannot
//     produce a longer run than reality.
//   - promoteLabelMatchedMainSwitch / promoteLabelMatchedRcd — patched
//     Stage 4 labels onto Stage 3 mis-classifications. With the new
//     pipeline labels arrive on the per-window read and Stage 3
//     mis-classifications are vote-resolved across windows during
//     alignment.
// References in extraction.js, ccu-route-merger.test.js, and
// promote-label-main-switch.test.js are removed in the same change.
// ---------------------------------------------------------------------------

/**
 * Build an EICR-schema `circuits[]` array from per-slot VLM classifications.
 *
 * Per-slot is the sole source of truth for circuit-level data:
 *   - Device fields (ocpd_*, rcd_*, is_rcbo) come from Stage 3 classification.
 *   - Labels come from Stage 4 (`slot.label`) — a per-crop label-reading
 *     pass that looks at a wider-Y crop around each slot.
 *   - Low-confidence or "unknown" slots emit the slot's best-effort reading
 *     with `low_confidence: true`. UI surfaces this for inspector verification.
 *
 * Circuit numbering follows BS 7671: circuit 1 is the device nearest the
 * main switch, numbering OUTWARD. When `mainSwitchSide === 'right'` we
 * iterate the physical-order slot array in reverse.
 *
 * RCD protection — Derek's 2026-05-05 two-phase rule:
 *   - Walking outward from the main switch, MCBs start unprotected (phase 1).
 *   - First non-MCB-non-RCBO device on the outward walk (a blank with an RCD
 *     present anywhere on the board, OR an RCD itself) flips state to phase 2.
 *   - Phase-2 MCBs are RCD-protected, with type/sensitivity copied from the
 *     most-recently-seen RCD's face read. Each new RCD overrides the
 *     reference (dual-RCD split-load).
 *   - RCBOs are always self-protected from THIS device's face read.
 *   - Spares (blank classification) ALWAYS emit rcd_protected=false,
 *     regardless of phase.
 *   - RCDs are NOT emitted as schedule rows — they exist only as the
 *     reference source for phase-2 MCBs. Their type/sensitivity propagates
 *     onto every protected circuit row.
 *   - main_switch / spd slots are not emitted.
 *
 * Replaces the previous physical-L→R cascade pre-pass which mis-fired on
 * the 2026-05-05 Wylex NHRS12SL extraction (the cascade walked left-to-right
 * regardless of which side the main switch was on, so right-handed boards
 * got cascade computed in the wrong direction relative to the inspector's
 * "outward from main switch" mental model).
 *
 * @returns {Array|null} circuits array, or null if slots is empty/invalid.
 */
export function slotsToCircuits({
  slots,
  mainSwitchSide,
  minSlotConfidence = 0.7,
  mainSwitchRating = null,
  mainSwitchPoles = null,
}) {
  if (!Array.isArray(slots) || slots.length === 0) return null;

  // --- Pre-pass: build the outward-from-main-switch RCD reference list.
  //
  // Derek's 2026-05-05 spec replaces the previous physical-L→R cascade with
  // a two-phase walk that follows the same outward order as schedule
  // numbering (BS 7671 — circuit 1 nearest the main switch). Three things
  // matter for the main loop:
  //
  //   1. hasAnyRcd — does the board contain any RCD slot at all? Decides
  //      whether a blank can act as a phase-1→phase-2 boundary.
  //   2. rcdEntries — one entry per *physical* RCD device, in scan order,
  //      with its own face read (type / sensitivity / rating / bsEn).
  //      Two adjacent rcd slots are the same physical 2-module device and
  //      gap-fill into one entry (preferring whichever module's face read
  //      came back non-null).
  //   3. rcdScanIndices — sorted scan-order indices of every rcd slot.
  //      Used to look up the *next* RCD when phase 2 was triggered by a
  //      blank but no RCD has been seen yet (38 Dickens Close topology:
  //      RCD at the FAR end of the board, MCBs+blanks between).
  const scanOrder = mainSwitchSide === 'right' ? [...slots].reverse() : [...slots];

  let hasAnyRcd = false;
  const rcdEntries = [];
  const rcdEntryIdxByScanIdx = new Map();
  let prevWasRcd = false;
  for (let i = 0; i < scanOrder.length; i++) {
    const cls = (scanOrder[i].classification || '').toLowerCase();
    if (cls !== 'rcd') {
      prevWasRcd = false;
      continue;
    }
    hasAnyRcd = true;
    const s = scanOrder[i];
    if (prevWasRcd) {
      const prev = rcdEntries[rcdEntries.length - 1];
      if (!prev.type && s.rcdWaveformType) prev.type = s.rcdWaveformType;
      if (!prev.sensitivity && s.sensitivity != null && s.sensitivity !== '') {
        prev.sensitivity = String(s.sensitivity);
      }
      if (!prev.rating && s.ratingAmps != null && s.ratingAmps !== '') {
        prev.rating = String(s.ratingAmps);
      }
      if (!prev.bsEn && s.bsEn) prev.bsEn = s.bsEn;
      rcdEntryIdxByScanIdx.set(i, rcdEntries.length - 1);
    } else {
      rcdEntries.push({
        type: s.rcdWaveformType || null,
        sensitivity: s.sensitivity != null && s.sensitivity !== '' ? String(s.sensitivity) : null,
        rating: s.ratingAmps != null && s.ratingAmps !== '' ? String(s.ratingAmps) : null,
        bsEn: s.bsEn || null,
      });
      rcdEntryIdxByScanIdx.set(i, rcdEntries.length - 1);
    }
    prevWasRcd = true;
  }
  const rcdScanIndices = Array.from(rcdEntryIdxByScanIdx.keys()).sort((a, b) => a - b);

  // Main pass: emit schedule rows in scan order (outward from main switch).
  //
  // Phase walk (Derek's 2026-05-05 spec):
  //   - Phase 1 (default): MCBs unprotected.
  //   - Phase 2: MCBs protected by the most-recently-seen upstream RCD.
  //   - RCBOs anywhere are self-protected from THIS device's face read.
  //   - Blanks emit "Spare" with rcd_protected=false regardless of phase
  //     (Derek's "spares stay non RCD protected" rule).
  //   - RCDs are NOT emitted as schedule rows. They update the upstream
  //     reference and flip phase to 2.
  //
  // Phase transitions:
  //   - First blank (cls='blank') AND board has any RCD anywhere
  //     → flip phase to 2 starting at NEXT slot.
  //   - Any RCD slot → flip phase to 2, update reference.
  //
  // Phase-2 reference resolution: a phase-2 MCB sitting BEFORE any RCD in
  // scan order (because phase 2 was triggered by a blank) backfills its
  // reference from the first upcoming RCD. That covers the 38 Dickens Close
  // topology (RCD at the FAR end of the board, MCBs+blanks between it and
  // the main switch) without forcing the cascade to walk physical L→R as
  // it did before.
  const circuits = [];
  let circuitNumber = 1;
  let phase = 'phase1';
  let upstreamRcd = null;

  for (let i = 0; i < scanOrder.length; i++) {
    const slot = scanOrder[i];
    const cls = (slot.classification || '').toLowerCase();
    const content = typeof slot.content === 'string' ? slot.content : 'device';
    const extendsSide = typeof slot.extends === 'string' ? slot.extends : 'none';

    // 1. main_switch / spd: not emitted, no phase change.
    if (cls === 'main_switch' || cls === 'spd') continue;

    // 2. RCD: not emitted; updates reference + flips phase.
    if (cls === 'rcd') {
      const entryIdx = rcdEntryIdxByScanIdx.get(i);
      if (entryIdx != null) {
        const ent = rcdEntries[entryIdx];
        upstreamRcd = { type: ent.type, sensitivity: ent.sensitivity };
      }
      phase = 'phase2';
      continue;
    }

    // 3. Empty-content slot — should not occur with the ordered-list pipeline
    // (the prompt rules forbid the VLM from reporting bare rail; window
    // overshoot prevents end-of-rail unowned slots; alignment guarantees no
    // interior gaps). Kept as a defensive low-confidence emission for any
    // legacy fixture or future code path that synthesises an empty slot.
    // Critically NOT emitted as `is_exposed_rail` — the production pipeline
    // never had a positive VLM read for exposed rail; every "Exposed rail"
    // row historically emitted was a fabricated artefact of the old
    // position-clustered placement step (extractions 1778086091005-v9sst9
    // and 1778103470875-488yba are the named regressions). Real exposed
    // rail (an IP4X defect) requires a positive identification by the
    // inspector — the model does not have a category for it.
    if (content === 'empty' || cls === 'empty') {
      circuits.push({
        circuit_number: circuitNumber,
        slot_index: slot.slotIndex ?? null,
        label: slot.label ?? null,
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
      });
      circuitNumber++;
      continue;
    }

    // 4. mcb / rcbo / unknown / partial / rewireable / cartridge / blank.
    //    Determine the upstream RCD reference for this slot.
    //
    //    For phase-2 MCBs that appear before any RCD in scan order, look
    //    ahead to the first upcoming RCD. The lookup is O(rcdScanIndices)
    //    which is at most ~3 entries on real UK boards (single-RCD or
    //    dual-RCD split-load).
    let slotUpstreamRcd = null;
    if (phase === 'phase2') {
      if (upstreamRcd) {
        slotUpstreamRcd = upstreamRcd;
      } else {
        const nextScanIdx = rcdScanIndices.find((x) => x > i);
        if (nextScanIdx != null) {
          const ent = rcdEntries[rcdEntryIdxByScanIdx.get(nextScanIdx)];
          slotUpstreamRcd = { type: ent.type, sensitivity: ent.sensitivity };
        }
      }
    }

    // Partial crops (VLM saw only part of a wider device) are hallucination
    // hazards — the model can pattern-match a half-RCD to "B32 MCB" with
    // confidence. Force low_confidence on any content="partial" slot so
    // the inspector verifies, and tag is_partial_crop for UI awareness.
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
      // reading and mark low_confidence. NO fallback to single-shot or
      // board-majority guessing — Derek's 2026-05-05 rule: blank > guessed
      // wrong, because UK boards mix C/B-curve and AC/A waveforms.
      circuit = buildCircuitFromSlot(slot, circuitNumber, slotUpstreamRcd);
      circuit.label = slotLabel;
      circuit.low_confidence = true;
      if (isPartial) {
        circuit.is_partial_crop = true;
        circuit.extends_side = extendsSide;
      }
    } else {
      circuit = buildCircuitFromSlot(slot, circuitNumber, slotUpstreamRcd);
      circuit.label = slotLabel;
    }

    // OCR cross-check rejected the rating — mark low_confidence so the
    // inspector verifies. Rating is already null from the parser.
    if (slot.ratingHallucinationDetected) {
      circuit.low_confidence = true;
      circuit.rating_hallucination_detected = true;
    }

    // Traceability: keep the slot's physical position on the rail. Used
    // by post-merge passes (e.g. flagRcdWaveformOutliers) to map circuits
    // back to their source slot without re-deriving the mainSwitchSide-
    // aware reverse mapping. Optional on iOS — additive decode.
    circuit.slot_index = slot.slotIndex ?? null;

    circuits.push(circuit);
    circuitNumber++;

    // Phase transition: a blank with at least one RCD anywhere on the board
    // flips us into phase 2 from the NEXT slot. The blank itself stays
    // unprotected (Derek's "spares stay non RCD protected" rule).
    if (cls === 'blank' && hasAnyRcd && phase === 'phase1') {
      phase = 'phase2';
    }
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
    if (!ocpd_bs_en) ocpd_bs_en = cls === 'rcbo' ? 'BS EN 61009' : 'BS EN 60898';
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
  const rcd_bs_en = is_rcbo ? 'BS EN 61009' : upstreamRcd ? 'BS EN 61008' : null;

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

      // Phase 4 of the multi-board sprint: optional board attribution. iOS
      // attaches `board_id` (and optionally `board_index`) when uploading
      // a sub-board CCU photo so the server can echo it back in the
      // response, log under the right board, and key training-data S3
      // paths by board. Both fields are optional; older iOS builds that
      // omit them stay on the legacy implicit-main-board path.
      const attributionBoardId =
        typeof req.body?.board_id === 'string' && req.body.board_id.trim().length > 0
          ? req.body.board_id.trim()
          : null;
      const rawBoardIndex = req.body?.board_index;
      let attributionBoardIndex = null;
      if (rawBoardIndex !== undefined && rawBoardIndex !== null && rawBoardIndex !== '') {
        const parsed = Number(rawBoardIndex);
        if (Number.isInteger(parsed) && parsed >= 0) {
          attributionBoardIndex = parsed;
        }
      }

      logger.info('CCU photo analysis requested', {
        userId: req.user.id,
        fileSize: req.file.size,
        model,
        railRoiHint: !!railRoiHint,
        attributionBoardId,
        attributionBoardIndex,
      });

      // Two buffers, one role each:
      //
      //   apiBytes      — downsized for whole-image VLM calls (board
      //                   classifier). Anthropic's request body cap forces a
      //                   resize, AND the model auto-downsamples >1568×1568
      //                   internally before vision processing, so sending
      //                   the full 12 MP iPhone capture buys nothing on
      //                   whole-image calls.
      //
      //   originalBytes — full quality, used for per-window crops in
      //                   extractViaSlidingWindow. Each window is ~5
      //                   modules wide; cropping a sharp 4032-wide source
      //                   yields ~876-px windows that resize cleanly to
      //                   1536 for the per-window VLM call. Cropping the
      //                   downsized 2048-wide source yields ~445-px
      //                   windows that have to be 3.4×-upscaled to 1536,
      //                   destroying small-text legibility on the labels.
      //                   Field test 2026-05-07: same Wylex NHRS12SL board
      //                   gave 16 perfect slots in the morning at 97 px /
      //                   module and 25 duplicated slots in the afternoon
      //                   at 89 px / module — the difference came entirely
      //                   from manual-fit framing variance after the
      //                   downsize had already capped the headroom.
      //                   Sourcing crops from the original buffer takes
      //                   the rail back to ~175 px / module on a typical
      //                   16-way board, well above Sonnet's flip threshold.
      //
      // Image-token billing is bucketed by effective resolution, not source
      // pixels, so the per-window calls cost the same regardless of source
      // size. The classifier still sees the downsized image so its tokens
      // and request size are unchanged from before.
      const MAX_BASE64_BYTES = 5 * 1024 * 1024;
      const MAX_RAW_BYTES = Math.floor(MAX_BASE64_BYTES * 0.74); // ~3.7MB raw → <5MB base64
      const originalBytes = await fs.readFile(tempPath);
      const originalMeta = await sharp(originalBytes).metadata();
      const originalImageWidth = originalMeta.width || 0;
      const originalImageHeight = originalMeta.height || 0;
      let apiBytes = originalBytes;

      if (apiBytes.length > MAX_RAW_BYTES) {
        logger.info('CCU image too large for API, resizing with sharp', {
          originalBytes: apiBytes.length,
          maxBytes: MAX_RAW_BYTES,
        });
        apiBytes = await sharp(originalBytes)
          .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        logger.info('CCU image resized', { newBytes: apiBytes.length });
      }
      // Alias so the rest of the route handler — board classifier base64,
      // CV stages (Stage 1/2), per-slot fallback path — keeps reading the
      // downsized buffer it always read. extractViaSlidingWindow alone is
      // switched over to originalBytes below.
      const imageBytes = apiBytes;

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

      // --- Registry lookup (RCD waveform type only — NOT module count) ---
      // The classifier identifies a board model; the registry knows the
      // RCD waveform type (AC/A/B), BS EN, and other manufacturer-series
      // facts that aren't visible in the photo. We call lookupRcdType
      // here so `applyRcdTypeLookup` downstream can reuse the result
      // without a second filesystem read (it's mtime-cached, but the
      // log line documents *which* match fired).
      //
      // Module count is NOT taken from the registry. The "ways" field
      // in datasheets is ambiguous — it can mean "free outgoing ways",
      // "total module positions", or "RCD-protected ways" depending on
      // who entered the row. On a Wylex NHRS12SL the registry says 12
      // but the physical rail carries 16 modules (12-way bank + main
      // switch + side MCB + 2-mod isolator). Forcing 12 slots into a
      // 16-module bbox produces 4 unowned slots that downstream code
      // asserts as "Exposed rail (no device, no blank)" — a fabricated
      // IP4X safety defect. CV-only count is the correct stance because
      // ccu-rail-quad already handles keystone (perspective-rectified
      // autocorrelation in mm-uniform space, slot centres projected
      // back through the quad), which was the failure mode the override
      // existed to side-step.
      const upfrontLookup = lookupRcdType({
        manufacturer: boardClassification.boardManufacturer,
        model: boardClassification.boardModel,
      });
      if (upfrontLookup.source !== 'miss') {
        logger.info('RCD type lookup pre-geometry', {
          userId: req.user.id,
          source: upfrontLookup.source,
          matchedKey: upfrontLookup.matched_key,
          matchedVia: upfrontLookup.matched_via,
          readAs: upfrontLookup.read_as ?? null,
        });
      }

      // --- Stage 2: prepare geometry (Stage 1 of geometric pipeline + bbox) ---
      const chooseRewireable =
        boardClassification.boardTechnology === 'rewireable_fuse' ||
        boardClassification.boardTechnology === 'cartridge_fuse' ||
        boardClassification.boardTechnology === 'mixed';

      // Feature flag: CCU_BOX_TIGHTEN switches the modern-board geometry
      // path to one of two CV implementations (ccu-rail-quad.js or
      // ccu-box-tighten.js). Default ON. Tries the perspective-aware
      // quadrilateral path first, falls back to the legacy axis-aligned
      // box-tightener on quad error, then to the VLM prepareModernGeometry
      // on box-tightener error. Two layers of fallback because an
      // algorithm regression must NEVER block an extraction in production.
      //
      // CCU_QUAD_GEOMETRY (default true) gates the quadrilateral path.
      // Set to "false" to skip directly to the legacy box-tightener — the
      // kill-switch for any future quad regression.
      const boxTightenEnabled = (process.env.CCU_BOX_TIGHTEN ?? 'true').toLowerCase() === 'true';
      const quadEnabled = (process.env.CCU_QUAD_GEOMETRY ?? 'true').toLowerCase() === 'true';
      let prepared;
      let preparedSource = 'modern-vlm';
      try {
        if (chooseRewireable) {
          prepared = await prepareRewireableGeometry(imageBytes);
          preparedSource = 'rewireable';
        } else if (boxTightenEnabled && railRoiHint) {
          const tightenerOpts = {};
          let tightened = null;
          let tightenedFrom = null;

          if (quadEnabled) {
            try {
              tightened = await tightenAndChunkQuad(imageBytes, railRoiHint, tightenerOpts);
              tightenedFrom = 'quad';
            } catch (quadErr) {
              logger.warn('CCU quad geometry failed; falling back to legacy box-tightener', {
                userId: req.user.id,
                error: quadErr.message,
              });
            }
          }

          if (!tightened) {
            try {
              tightened = await tightenAndChunk(imageBytes, railRoiHint, tightenerOpts);
              tightenedFrom = 'legacy';
            } catch (tightenErr) {
              logger.warn('CCU box-tightener failed; falling back to modern VLM', {
                userId: req.user.id,
                error: tightenErr.message,
              });
              prepared = await prepareModernGeometry(imageBytes, { railRoiHint });
              preparedSource = 'modern-vlm-fallback';
            }
          }

          if (tightened) {
            prepared = adaptTightenerToPrepared(tightened);
            preparedSource = tightenedFrom === 'quad' ? 'rail-quad' : 'box-tightener';
            logger.info('CCU box-tightener used', {
              userId: req.user.id,
              source: tightenedFrom,
              moduleCount: tightened.moduleCount,
              pitchPx: Math.round(tightened.pitchPx * 10) / 10,
              initialPitchPx: tightened.initialPitchPx,
              quadrilateral: tightened.quadrilateral ?? null,
              rectNormCorr: tightened.refinement?.quadDiag?.rectNormCorr ?? null,
              refinementAccepted: tightened.refinement.accepted,
              pairCount: tightened.refinement.pairCount,
            });
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

      // Feature flag for the sliding-window cut-over (2026-05-05).
      // Enable by setting CCU_SLIDING_WINDOW=true on the task definition.
      // Default OFF: an explicit env-var flip turns on the new path
      // without a code rollback if anything goes wrong in the field.
      // Sliding-window REPLACES Stage 3 + Stage 4 + the per-slot batch
      // loops; everything downstream (assembleGeometricResult,
      // slotsToCircuits, applyRcdTypeLookup, applyBsEnFallback,
      // normaliseCircuitLabels, lookupMissingRcdTypes,
      // flagRcdWaveformOutliers) keeps working unchanged because the
      // sliding-window result is reshaped into the same {slots, labels,
      // usage, timings} contract the per-slot pipeline produces.
      const slidingWindowEnabled =
        (process.env.CCU_SLIDING_WINDOW || 'false').toLowerCase() === 'true';

      // Single-shot mode (CCU_USE_SINGLE_SHOT=true): one VLM call sees the
      // entire rail and returns all slots in one go. Field-tested with
      // GPT-5.5 on 2026-05-07: produced exact CV-count match (16/16)
      // where sliding-window Sonnet over-counted to 25 and sliding-window
      // GPT-5.5 over-counted to 18. The board classifier upstream and
      // all enrichment downstream are unchanged.
      const useSingleShot = (process.env.CCU_USE_SINGLE_SHOT || 'false').toLowerCase() === 'true';

      let classified, labelPassResult;
      if (slidingWindowEnabled || useSingleShot) {
        const { extractViaSlidingWindow } = await import('../extraction/ccu-sliding-window.js');
        const { extractViaSingleShot } = await import('../extraction/ccu-single-shot.js');
        // Route the per-slot VLM call(s) to whichever model
        // CCU_SLIDING_WINDOW_MODEL names. Single env var name covers both
        // pipelines because both share the same VLM-routing decision.
        // Defaults to CCU_MODEL so existing deployments don't change
        // behaviour unless explicitly opted in. When the chosen model
        // name starts with "gpt-", wrap an OpenAI client in an
        // Anthropic-shaped adapter; otherwise keep the existing Anthropic
        // client. The classifier and any other whole-image VLM calls
        // upstream stay on Sonnet.
        const slidingWindowModel = (process.env.CCU_SLIDING_WINDOW_MODEL || model).trim();
        const { isOpenAIModel, createOpenAIAnthropicAdapter } =
          await import('../extraction/openai-vision-adapter.js');
        const swUseOpenAI = isOpenAIModel(slidingWindowModel);
        let swClient = anthropic;
        if (swUseOpenAI) {
          const openaiKey = process.env.OPENAI_API_KEY;
          if (!openaiKey) {
            logger.warn(
              'CCU_SLIDING_WINDOW_MODEL is OpenAI but OPENAI_API_KEY missing — falling back to Anthropic',
              {
                userId: req.user.id,
                slidingWindowModel,
              }
            );
          } else {
            swClient = createOpenAIAnthropicAdapter({ apiKey: openaiKey });
            logger.info(
              useSingleShot ? 'CCU single-shot using OpenAI' : 'CCU sliding-window using OpenAI',
              {
                userId: req.user.id,
                slidingWindowModel,
              }
            );
          }
        }
        try {
          // Scale the prepared geometry from CV-space (apiBytes dimensions)
          // into source-space (originalBytes dimensions) so that
          // extractViaSlidingWindow crops windows in original-pixel coords.
          //
          // railBbox, medianRails, slotCentersX, panelBounds are all in
          // per-1000 normalised space and resolve correctly under any
          // imgW/imgH via norm2px(). Only the absolute-pixel-space fields
          // (cvPitchDiag.pitchPx and cvPitchDiag.railWidthPx) need explicit
          // multiplication. If originalBytes was identical to apiBytes
          // (small upload, no resize), the scale is 1.0 and the prepared
          // geometry passes through unchanged.
          const sourceImgW = originalImageWidth || prepared.imageWidth;
          const sourceImgH = originalImageHeight || prepared.imageHeight;
          const sourceScale = prepared.imageWidth > 0 ? sourceImgW / prepared.imageWidth : 1;
          const preparedForSlidingWindow =
            sourceScale === 1
              ? prepared
              : {
                  ...prepared,
                  imageWidth: sourceImgW,
                  imageHeight: sourceImgH,
                  cvPitchDiag: prepared.cvPitchDiag
                    ? {
                        ...prepared.cvPitchDiag,
                        pitchPx:
                          prepared.cvPitchDiag.pitchPx != null
                            ? prepared.cvPitchDiag.pitchPx * sourceScale
                            : null,
                        railWidthPx:
                          prepared.cvPitchDiag.railWidthPx != null
                            ? prepared.cvPitchDiag.railWidthPx * sourceScale
                            : null,
                      }
                    : prepared.cvPitchDiag,
                };
          const extractFn = useSingleShot ? extractViaSingleShot : extractViaSlidingWindow;
          const swResult = await extractFn({
            imageBuffer: originalBytes,
            prepared: preparedForSlidingWindow,
            isRewireable: isRewireablePipeline,
            anthropic: swClient,
            model: swUseOpenAI && process.env.OPENAI_API_KEY ? slidingWindowModel : model,
            imgW: sourceImgW,
            imgH: sourceImgH,
            boardManufacturer: boardClassification.boardManufacturer,
            logger,
            userId: req.user.id,
          });
          classified = {
            slots: swResult.slots,
            usage: swResult.usage,
            timings: swResult.timings,
            lowConfidence: swResult.lowConfidence,
            stage3Error: swResult.stage3Error,
            stageOutputs: swResult.stageOutputs,
          };
          // Synthesise a Stage-4-shaped label-pass result so the
          // downstream merger sees the labels via labelPassResult.labels
          // exactly the way it did with extractSlotLabels.
          labelPassResult = {
            labels: swResult.labels,
            usage: { inputTokens: 0, outputTokens: 0 },
            timings: { vlmMs: 0 },
            skippedSlotIndices: swResult.skippedSlotIndices,
          };
        } catch (err) {
          logger.warn('CCU sliding-window extraction failed (falling back to per-slot)', {
            userId: req.user.id,
            error: err.message,
          });
          // Fall back to the per-slot path on any sliding-window error
          // so a transient VLM/network failure doesn't take the whole
          // endpoint down — the per-slot path is still tested and known.
          classified = null;
          labelPassResult = null;
        }
      }

      if (!classified) {
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
        [classified, labelPassResult] = await Promise.all([classifyPromise, labelPromise]);
      }

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

            // 2026-05-07: removed promoteLabelMatchedMainSwitch /
            // promoteLabelMatchedRcd post-passes. With the ordered-list
            // sliding-window pipeline the per-window VLM call returns
            // both classification and label together, vote-merged across
            // overlapping windows. A Stage 3 mis-classification on one
            // window is corrected by the sibling reads from the two
            // other windows that cover the same slot — no need for a
            // post-merge label-rescue.
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
          // Main-switch side resolution — see src/extraction/main-switch-resolver.js
          // for the full rule book + per-rule unit tests. The resolver handles
          // the false-positive cluster case that bit us on the 2026-05-08
          // Protek board (gpt-5.5 tagged a leftmost RCD as `main_switch`,
          // shadowing the real labelled one in the middle of the rail) by
          // grouping adjacent main_switch slots into clusters and preferring
          // the cluster whose Stage-4 label says "Main Switch" / "Isolator".
          const {
            mainSwitchSide,
            mainSwitchSideSource,
            diagnostic: mainSwitchDiagnostic,
          } = resolveMainSwitchSide({
            slots: analysis.slots || [],
            slotCount: (analysis.slots || []).length,
            stage1Position: boardClassification?.mainSwitchPosition || null,
            stage1Confidence:
              typeof boardClassification?.confidence === 'number'
                ? boardClassification.confidence
                : null,
            stage2Offset: geometricResult.mainSwitchOffset || null,
          });
          logger.info('CCU mainSwitchSide resolved', {
            userId: req.user.id,
            mainSwitchSide,
            mainSwitchSideSource,
            slotCount: (analysis.slots || []).length,
            stage1Confidence: boardClassification?.confidence ?? null,
            ...mainSwitchDiagnostic,
          });

          const mergedCircuits = slotsToCircuits({
            slots: analysis.slots,
            mainSwitchSide,
            mainSwitchRating: boardClassification?.mainSwitchRating ?? null,
            // mainSwitchPoles is null-by-design here — the classifier doesn't
            // currently return a pole count. Plumbed through for future use;
            // until then the trim pre-pass falls back to modal poles across
            // the run, then to the UK domestic default of 2.
            mainSwitchPoles: null,
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
      // RCD type lookup table (config/rcd-type-lookup.json) — runs FIRST so
      // that a high-confidence (manufacturer, model) hit overrides the
      // per-slot waveform-glyph read, which is unreliable on the sub-mm
      // BS-EN 61009 symbol. Confidence policy:
      //   - high   → override every RCD-protected circuit's rcd_type
      //   - medium → set as default; per-slot read at >=0.95 confidence wins
      //   - low    → fill nulls only
      // Anything the table doesn't cover falls through to the existing
      // gpt-5-search-api passes below.
      const lookupSummary = applyRcdTypeLookup(analysis, {
        logger,
        userId: req.user.id,
      });

      // Auto-grow: log unknown (manufacturer, model) pairs to S3 so the
      // promote CLI can review them. `model` hits skip; defaults and
      // misses get a sighting. Inference signals piggyback on whatever
      // the per-slot pipeline already computed for this extraction so a
      // pending entry has enough context for an informed promotion.
      if (lookupSummary.outcome !== 'hit') {
        const slots = Array.isArray(analysis.slots) ? analysis.slots : [];
        const rcdSlots = slots.filter(
          (s) =>
            s &&
            (s.classification === 'rcbo' || s.classification === 'rcd') &&
            typeof s.rcdWaveformType === 'string'
        );
        const typeCounts = new Map();
        for (const s of rcdSlots) {
          typeCounts.set(s.rcdWaveformType, (typeCounts.get(s.rcdWaveformType) ?? 0) + 1);
        }
        let perSlotMajority = null;
        let perSlotMajorityCount = 0;
        for (const [v, c] of typeCounts) {
          if (c > perSlotMajorityCount) {
            perSlotMajority = v;
            perSlotMajorityCount = c;
          }
        }
        const perSlotAvgConfidence =
          rcdSlots.length > 0
            ? rcdSlots.reduce(
                (a, s) => a + (typeof s.confidence === 'number' ? s.confidence : 0),
                0
              ) / rcdSlots.length
            : null;
        const inferenceSource =
          rcdSlots.length === 0
            ? 'classifier_only'
            : typeCounts.size === 1
              ? 'per_slot_uniform'
              : 'per_slot_majority';
        // fire-and-forget — non-fatal if S3 write fails.
        writeRcdPendingEntry({
          manufacturer: analysis.board_manufacturer,
          model: analysis.board_model,
          outcome: lookupSummary.outcome === 'miss' ? 'miss' : 'default',
          inferredType: lookupSummary.rcd_type ?? perSlotMajority,
          inferredWays: analysis.geometric?.moduleCount ?? null,
          classifierConfidence: analysis.confidence?.overall ?? null,
          perSlotAvgConfidence,
          inferenceSource,
          // No extractionId is in scope at this point — the geometric
          // sidecar generates its own further down. The pending writer
          // accepts null; the userId + last_seen timestamp are sufficient
          // to correlate sightings against CloudWatch logs.
          extractionId: null,
          userId: req.user.id,
          notes: lookupSummary.ways_warning,
        }).catch((err) => {
          logger.warn('RCD pending entry promise rejected (non-fatal)', {
            userId: req.user.id,
            error: err?.message,
          });
        });
      }

      // RCD type lookup (gpt-5-search-api): fills rcd_type for circuits where
      // Stage 3 couldn't read the waveform symbol AND the table didn't have
      // a hit. Skipped if OPENAI_API_KEY is unset (dev / sandbox).
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        const rcdStartMs = Date.now();
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: openaiKey });
        analysis = await lookupMissingRcdTypes(analysis, openai, logger, req.user.id);
        // Outlier detection runs AFTER the missing/uniform-low-conf passes
        // — those existing triggers can fill nulls or correct fleet-wide
        // mis-reads first, leaving this final pass to handle the residual
        // case where one slot disagrees with an otherwise-uniform same-
        // manufacturer cluster. Flags only; never auto-corrects.
        analysis = await flagRcdWaveformOutliers(analysis, openai, logger, req.user.id);
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

      // Echo the board attribution sent on the upload (Phase 4 multi-board).
      // Always present (even when both inputs were null) so iOS can use a
      // single decoder path instead of branching on `attribution === undefined`.
      analysis.attribution = {
        board_id: attributionBoardId,
        board_index: attributionBoardIndex,
      };

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
 * Uses Claude Sonnet vision via the Anthropic SDK. We previously tried
 * `gpt-5.2` here and it returned ~50 completion tokens on a 1.9MB EICR
 * photo (finish_reason "stop", not truncation) — the model just shrugged
 * at the task. Sonnet handles the dense schema reliably; the CCU pipeline
 * already uses it for vision and we share the same JSON-extraction
 * helpers and resize logic. Field names below match the iOS
 * CertificateMerger 1:1 so the inspector sees every legible value
 * dropped onto the right tab.
 *
 * POST /api/analyze-document
 */
router.post(
  '/analyze-document',
  auth.requireAuth,
  documentUpload.single('photo'),
  async (req, res) => {
    const tempPath = req.file?.path;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No photo uploaded' });
      }

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.status(500).json({ error: 'Anthropic API key not configured' });
      }

      const model = (process.env.DOC_EXTRACT_MODEL || 'claude-sonnet-4-6').trim();

      // Branch on PDF vs image. Detect via Content-Type with a magic-byte
      // backstop because some HTTP clients (and our own iOS Alamofire
      // multipart) can mislabel the part. PDF files start with "%PDF".
      let fileBytes = await fs.readFile(tempPath);
      const looksLikePdf =
        fileBytes.length >= 4 &&
        fileBytes[0] === 0x25 &&
        fileBytes[1] === 0x50 &&
        fileBytes[2] === 0x44 &&
        fileBytes[3] === 0x46;
      const isPdf = req.file.mimetype === 'application/pdf' || looksLikePdf;

      logger.info('Document extraction requested', {
        userId: req.user.id,
        fileSize: req.file.size,
        mimetype: req.file.mimetype,
        isPdf,
        model,
      });

      if (!isPdf) {
        // Anthropic's image vision rejects base64 payloads larger than ~5MB.
        // iOS already scales client-side via ImageScaler (max 2048px, JPEG
        // 0.80) but the web client can still exceed the cap. Mirror the CCU
        // resize pattern. PDFs do NOT need this — Anthropic accepts up to
        // 32MB / 100 pages natively in the document content block.
        const MAX_BASE64_BYTES = 5 * 1024 * 1024;
        const MAX_RAW_BYTES = Math.floor(MAX_BASE64_BYTES * 0.74); // ~3.7MB raw → <5MB base64

        if (fileBytes.length > MAX_RAW_BYTES) {
          logger.info('Document image too large for API, resizing with sharp', {
            originalBytes: fileBytes.length,
            maxBytes: MAX_RAW_BYTES,
          });
          fileBytes = await sharp(fileBytes)
            .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          logger.info('Document image resized', { newBytes: fileBytes.length });
        }
      } else {
        // Anthropic caps PDF uploads at 32MB. This is unlikely for a typical
        // 4-page EICR (~1-3MB) but enforce it loudly rather than letting
        // the API surface a generic 400.
        const MAX_PDF_BYTES = 32 * 1024 * 1024;
        if (fileBytes.length > MAX_PDF_BYTES) {
          return res.status(413).json({
            error: `PDF exceeds Anthropic's 32MB limit (${(fileBytes.length / 1024 / 1024).toFixed(1)}MB). Try a smaller or split file.`,
          });
        }
      }

      const base64 = Buffer.from(fileBytes).toString('base64');

      const prompt = `You are an expert UK electrician extracting structured data from a photographed or scanned electrical document for the CertMate EICR/EIC certificate workflow.

## INPUT
The attached document is one of:
- A multi-page typed PDF EICR (Electrical Installation Condition Report) — periodic inspection
- A multi-page typed PDF EIC (Electrical Installation Certificate) — new installation
- A photograph of a printed certificate or test results sheet
- A photograph of handwritten inspector notes
- Any document containing electrical installation data

If the input is a PDF, READ EVERY PAGE. EICR PDFs commonly have 3–6 pages: cover / installation details / supply / observations / schedule of test results (often spanning multiple pages with 8–12 circuits per page). The schedule on later pages is just as important as the cover page — DO NOT stop at page 1.

## TASK
Extract EVERY legible value into the JSON schema below. The schema field names match the certificate database keys exactly — emit them verbatim so the values land on the correct tab in the iOS app. The inspector is importing a previous certificate to seed a new job, so be thorough: every value you skip is one they have to retype.

## CRITICAL RULES
1. ONLY emit values you can actually read in the image. Never guess, infer, or fabricate. If a field is illegible or absent, OMIT the key entirely (do not write null, do not write "").
2. Use the exact JSON keys shown in the schema. Do not invent new keys, rename, or reorder nested objects.
3. All numeric values are returned as STRINGS (e.g. "32" not 32, "0.35" not 0.35). The only Int field is "next_inspection_years".
4. For "≥200", "> 200", ">200 MΩ" etc on insulation resistance, normalise to ">200".
5. For tick / cross / Y / N fields, emit "✓" for confirmed and "✗" for not confirmed (or omit if blank).
6. If the image shows multiple boards or multiple pages of circuits, include ALL circuits.
7. Return ONLY the JSON object. No markdown fences, no commentary, no leading/trailing text.

## CIRCUIT COVERAGE — READ CAREFULLY
The schedule of test results is the most important part of the document. It is laid out as a TABLE with one ROW per circuit. Every legible row is a separate \`circuits[]\` entry — there is NO upper limit and NO need to keep the output short.

- If the table has 16 rows of circuits, \`circuits\` MUST contain 16 objects.
- The schema below shows ONE example circuit ONLY — that is a format demo, not a quota. Do not stop after one or two circuits.
- Walk the table TOP TO BOTTOM. For each row, emit one object — even if some test reading cells in that row are blank or hard to read (just omit those specific keys, not the whole circuit).
- Any row with a circuit number, a designation, or any visible reading (Zs, R1+R2, IR, RCD time, etc.) gets its own circuits[] entry.
- A blank cell ≠ skip the circuit. A blank cell = omit that one key.
- If two boards are shown (e.g. a main DB plus a sub-main board), include circuits from both — preserve their original numbering.

## CLIENT vs PROPERTY ADDRESS — DO NOT CONFLATE
EICRs typically show two distinct things: the client/owner being billed, and the property address being inspected. Often they are the same person and the same address; sometimes they are different (landlord client / tenant property). Map them like this:

- \`client_name\` is ONLY a PERSON or COMPANY NAME. Examples: "Mr J Smith", "Acme Property Lettings Ltd". NEVER put a postal address in this field.
- \`address\` is ONLY the STREET LINE of the installation premises. Examples: "12 Acacia Avenue", "Flat 4, Brunswick House". NEVER include the postcode, town, or county here — they each have their own keys.
- \`postcode\` is the UK postcode alone, e.g. "SL6 4QH".
- \`town\` and \`county\` are bare locality names, e.g. "Maidenhead", "Berkshire".
- \`occupier_name\` is only filled when the cert explicitly names a different occupier from the client.

If the cert has a single combined address block like "Mr J Smith, 12 Acacia Avenue, Maidenhead, Berkshire, SL6 4QH", split it across the five keys above — do NOT dump the whole thing into \`client_name\` or into \`address\`.

## ENUM REFERENCE (use these exact strings)
- earthing_arrangement: "TN-C-S" | "TN-S" | "TT" | "IT"
- ocpd_type: "B" | "C" | "D" | "Rew" | "HRC" (Rew = BS 3036 rewireable, HRC = BS 1361 cartridge)
- ocpd_bs_en: "BS EN 60898" | "BS EN 61009" | "BS EN 60947-2" | "BS EN 60947-3" | "BS EN 60269-2" | "BS 3036" | "BS 1361" | "N/A"
- rcd_type: "AC" | "A" | "B" | "F" | "S"
- rcd_bs_en: "BS EN 61008" | "BS EN 61009" | "BS EN 62423" | "N/A"
- wiring_type: "A" (PVC singles in conduit) | "B" (PVC singles in trunking) | "C" (PVC/PVC flat twin & earth, clipped direct) | "D" (Mineral insulated) | "E" (PVC singles in metal trunking) | "F" (Other)
- spd_status: "Fitted" | "Not Fitted" | "Not Required"
- observation code: "C1" (danger present) | "C2" (potentially dangerous) | "C3" (improvement recommended) | "FI" (further investigation required)
- next_inspection_years: integer 1-10
- nominal_voltage_u: usually "230"
- nominal_frequency: usually "50"

## DATE FORMATS
All date fields use UK format DD/MM/YYYY as a string (e.g. "15/03/2024").

## SCHEMA
Return ONLY this JSON. Omit any key whose value is not legibly present in the image.

{
  "installation_details": {
    "client_name": "Householder or company name",
    "address": "Full street address WITHOUT postcode/town/county on the same line — e.g. '12 Acacia Avenue'",
    "postcode": "UK postcode in standard format e.g. 'SL6 4QH'",
    "town": "Post town",
    "county": "County",
    "premises_description": "e.g. '3-bed semi-detached house', 'Retail shop with flat above'",
    "occupier_name": "If different from client",
    "client_phone": "Phone number digits only",
    "client_email": "Email address",
    "reason_for_report": "e.g. 'Periodic inspection', 'Change of tenancy', 'Insurance request', 'Pre-purchase'",
    "extent": "Extent of installation covered by the inspection",
    "agreed_limitations": "Any agreed limitations to the inspection",
    "agreed_with": "Person agreed-with for limitations",
    "operational_limitations": "Operational limitations encountered during inspection",
    "estimated_age_of_installation": "Years as a string e.g. '15'",
    "general_condition_of_installation": "Free-text condition summary as written on the cert",
    "date_of_inspection": "DD/MM/YYYY of THIS inspection (use only the inspection date — not the report-issue date if different)",
    "date_of_previous_inspection": "DD/MM/YYYY of the previous inspection if recorded",
    "previous_certificate_number": "Cert number string",
    "next_inspection_years": 5,
    "installation_records_available": "Yes",
    "evidence_of_additions_alterations": "No"
  },
  "supply_characteristics": {
    "earthing_arrangement": "TN-C-S",
    "nominal_voltage_u": "230",
    "nominal_frequency": "50",
    "prospective_fault_current": "0.88",
    "earth_loop_impedance_ze": "0.35"
  },
  "board_info": {
    "manufacturer": "e.g. 'Wylex', 'Hager', 'MK', 'Crabtree', 'Schneider', 'BG', 'Eaton'",
    "name": "Board model code e.g. 'NHRS12SL', 'VML112'",
    "location": "Where the board is located e.g. 'Hallway under stairs'",
    "phases": "Single Phase | Three Phase",
    "earthing_arrangement": "Repeat from supply characteristics if shown on board section",
    "ze": "External earth loop impedance in ohms — string",
    "ze_at_db": "Ze measured at the distribution board if shown — string",
    "ipf_at_db": "Prospective fault current at the DB in kA — string",
    "rated_current": "Main switch rating in amps as a string e.g. '100'",
    "main_switch_bs_en": "BS/EN of main switch e.g. '60947-3'",
    "voltage_rating": "Main switch voltage rating string",
    "ipf_rating": "Main switch breaking capacity in kA string",
    "rcd_rating_ma": "Main RCD rating in mA string if board has a main RCD",
    "rcd_trip_time": "Main RCD trip time in ms string",
    "spd_status": "Fitted",
    "spd_type": "Type 1 | Type 2 | Type 3 | Type 1+2 | Type 2+3"
  },
  "circuits": [
    {
      "circuit_ref": "1",
      "circuit_designation": "Ring Main Sockets — Ground Floor",
      "wiring_type": "C",
      "ref_method": "C",
      "number_of_points": "8",
      "live_csa_mm2": "2.5",
      "cpc_csa_mm2": "1.5",
      "max_disconnect_time_s": "0.4",
      "ocpd_bs_en": "BS EN 60898",
      "ocpd_type": "B",
      "ocpd_rating_a": "32",
      "ocpd_breaking_capacity_ka": "6",
      "ocpd_max_zs_ohm": "1.37",
      "rcd_bs_en": "BS EN 61009",
      "rcd_type": "A",
      "rcd_operating_current_ma": "30",
      "rcd_rating_a": "32",
      "ring_r1_ohm": "0.88",
      "ring_rn_ohm": "0.91",
      "ring_r2_ohm": "1.11",
      "r1_r2_ohm": "0.89",
      "r2_ohm": "0.45",
      "ir_test_voltage_v": "500",
      "ir_live_live_mohm": ">200",
      "ir_live_earth_mohm": ">200",
      "polarity_confirmed": "✓",
      "measured_zs_ohm": "0.45",
      "rcd_time_ms": "18",
      "rcd_button_confirmed": "✓",
      "afdd_button_confirmed": "✓"
    }
  ],
  "observations": [
    {
      "code": "C2",
      "observation_text": "Verbatim description of the defect as written on the cert",
      "item_location": "Where the defect is — e.g. 'Distribution board', 'Bathroom', 'Outdoor socket'",
      "schedule_item": "Schedule of inspections item reference if shown — e.g. '4.2'",
      "regulation": "BS 7671 regulation reference e.g. 'Reg 421.1.201'"
    }
  ]
}`;

      // Build the Anthropic SDK client. Reuses the same import pattern as
      // CCU classifyBoardTechnology — kept inline so this route's failure
      // surface is independent of the CCU pipeline.
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: anthropicKey });

      // PDFs ship as a `document` content block (Anthropic processes every
      // page natively at full fidelity — the right path for typed cert
      // exports, which are most "previous EICRs"). Images ship as an
      // `image` block — for camera-shot photos of a printed cert, scribbled
      // notes, etc.
      const documentBlock = isPdf
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          }
        : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } };

      const startMs = Date.now();
      const response = await anthropic.messages.create({
        model,
        // 8000 covers a fully-populated 12-circuit EICR with observations and
        // free-text fields. Multi-page PDFs with two boards / 24 circuits
        // can press against this; if we see truncation in the wild we'll
        // bump it. Hitting the cap surfaces as a 502 below so the inspector
        // sees a clear failure rather than a half-populated form.
        max_tokens: 8000,
        messages: [
          {
            role: 'user',
            content: [documentBlock, { type: 'text', text: prompt }],
          },
        ],
      });

      const textBlocks = (response.content || []).filter((b) => b.type === 'text');
      const rawContent = textBlocks
        .map((b) => b.text)
        .join('')
        .trim();

      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const stopReason = response.stop_reason || 'unknown';
      const elapsedMs = Date.now() - startMs;

      logger.info('Document extraction complete', {
        userId: req.user.id,
        model,
        inputTokens,
        outputTokens,
        responseLength: rawContent.length,
        stopReason,
        elapsedMs,
      });

      if (stopReason === 'max_tokens') {
        logger.error('Document extraction truncated by token limit', {
          userId: req.user.id,
          model,
          outputTokens,
        });
        return res.status(502).json({
          error: `Response truncated at ${outputTokens} tokens. Try splitting the document or re-shooting the photo.`,
        });
      }

      // Strip optional ```json fence; otherwise slice between first { and last }.
      let jsonStr = rawContent;
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      } else {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last > first) {
          jsonStr = jsonStr.slice(first, last + 1);
        }
      }

      let extracted;
      try {
        extracted = JSON.parse(jsonStr);
      } catch (parseErr) {
        logger.error('Document extraction JSON parse failed', {
          userId: req.user.id,
          model,
          rawPreview: rawContent.slice(0, 500),
          parseError: parseErr.message,
        });
        return res.status(502).json({
          error: 'Could not parse extraction response. Try a clearer photo.',
        });
      }

      // Coerce a few field types that vision models commonly return in the
      // wrong shape. iOS decoders are permissive (decodeStringOrNumber) but
      // booleans-as-tick-marks and number circuit refs are the two we've
      // seen most often, so fix them up here defensively.
      if (Array.isArray(extracted.circuits)) {
        for (const c of extracted.circuits) {
          if (typeof c.polarity_confirmed === 'boolean') {
            c.polarity_confirmed = c.polarity_confirmed ? '✓' : '';
          }
          if (typeof c.rcd_button_confirmed === 'boolean') {
            c.rcd_button_confirmed = c.rcd_button_confirmed ? '✓' : '';
          }
          if (typeof c.afdd_button_confirmed === 'boolean') {
            c.afdd_button_confirmed = c.afdd_button_confirmed ? '✓' : '';
          }
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

      // Sonnet 4.6 vision pricing (eu-west-2): $3/MTok input, $15/MTok output.
      const inputCost = (inputTokens * 3) / 1_000_000;
      const outputCost = (outputTokens * 15) / 1_000_000;

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

      // Diagnostic dump — captures the parsed JSON so we can audit prompt
      // accuracy from CloudWatch without round-tripping through the user.
      // Truncated to keep CloudWatch event size sane (~16KB events). Drops
      // the per-circuit detail if the response is enormous, but always keeps
      // installation_details / supply / board / circuit_refs / observations
      // shape so misrouted-field bugs are visible.
      try {
        const refsPreview = (formData.circuits || []).map((c) => ({
          ref: c?.circuit_ref,
          designation: c?.circuit_designation,
        }));
        logger.info('Document extraction dump', {
          userId: req.user.id,
          installation_details: formData.installation_details,
          supply_characteristics: formData.supply_characteristics,
          board_info: formData.board_info,
          circuit_refs_designations: refsPreview,
          observations: formData.observations,
          first_circuit_full: formData.circuits?.[0] || null,
        });
      } catch {
        /* logging failure must never affect the response */
      }

      res.json({ success: true, formData });
    } catch (error) {
      logger.error('Document extraction failed', {
        userId: req.user.id,
        error: error.message,
        stack: error.stack,
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
  }
);

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
