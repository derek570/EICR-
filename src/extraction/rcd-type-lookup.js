/**
 * RCD-type / way-count lookup table.
 *
 * Replaces the per-slot waveform-glyph VLM read as the primary source of
 * truth for `rcd_type` on UK consumer-unit extractions. The Stage 1
 * classifier already returns a clean `board_manufacturer` + `board_model`
 * pair on most photos; given those, the manufacturer's published RCD type
 * is deterministic — there is no need for a sub-millimetre symbol read.
 *
 * Lookup order:
 *   1. Exact `<manufacturer>/<model>` match in `models{}` (most specific).
 *   2. Manufacturer default in `manufacturer_defaults{}`.
 *   3. Miss — fall through to the existing pipeline.
 *
 * Confidence policy (see `applyRcdTypeLookup`):
 *   - high   → override every RCD-protected circuit's `rcd_type`.
 *   - medium → set as default; per-slot reads at confidence ≥ 0.95 that
 *              disagree are kept (covers older retrofitted devices).
 *   - low    → fill nulls only; never overwrite an existing read.
 *
 * The table itself lives in `config/rcd-type-lookup.json` so it can be
 * extended without redeploying. The file is read on first call and
 * reloaded on mtime change — a containerised promote-and-restart cycle
 * picks up changes immediately, while a long-running dev process picks
 * up file edits between calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOOKUP_PATH = path.resolve(__dirname, '../../config/rcd-type-lookup.json');

// Per-slot confidence floor above which a disagreeing per-slot read is
// trusted over a `medium`-confidence table default. 0.95 is deliberately
// high — Stage 4's typical confident read sits in 0.85-0.92, so anything
// at or above this is genuinely a high-conviction read worth honouring.
export const PER_SLOT_OVERRIDE_THRESHOLD = 0.95;

let _cache = null;
let _cacheMtime = 0;
let _cachePath = null;

/**
 * Lower-case, alphanumeric-with-underscore manufacturer key. Stable
 * across "Click Scolmore" / "click-scolmore" / "Click  Scolmore " etc.
 */
export function normaliseManufacturer(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : null;
}

/**
 * Upper-case model key with whitespace stripped. Hyphens and underscores
 * preserved because they appear in real model codes ("CU1SPD-275",
 * "NHRS_12SL"). Stable across casing and incidental whitespace.
 */
export function normaliseModel(model) {
  if (typeof model !== 'string') return null;
  const cleaned = model.trim().toUpperCase().replace(/\s+/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Load the lookup table from disk, with mtime-based cache invalidation.
 * Errors are swallowed and an empty-but-valid table is returned so a
 * malformed config can never bring down the route handler.
 */
export function loadLookupTable(lookupPath = DEFAULT_LOOKUP_PATH) {
  try {
    const stat = fs.statSync(lookupPath);
    if (_cache && _cacheMtime === stat.mtimeMs && _cachePath === lookupPath) {
      return _cache;
    }
    const raw = fs.readFileSync(lookupPath, 'utf8');
    const parsed = JSON.parse(raw);
    _cache = {
      schema_version: parsed.schema_version ?? 1,
      manufacturer_defaults: parsed.manufacturer_defaults ?? {},
      models: parsed.models ?? {},
    };
    _cacheMtime = stat.mtimeMs;
    _cachePath = lookupPath;
    return _cache;
  } catch (_err) {
    // Returning an empty-but-shape-correct table is the safe behaviour:
    // callers degrade to the existing per-slot path with no crash.
    return { schema_version: 1, manufacturer_defaults: {}, models: {} };
  }
}

/**
 * Reset the cached table — for tests that swap the file under us.
 */
export function _resetCacheForTests() {
  _cache = null;
  _cacheMtime = 0;
  _cachePath = null;
}

const VALID_TYPES = new Set(['AC', 'A', 'B', 'F', 'S']);
const VALID_CONFIDENCES = new Set(['high', 'medium', 'low']);

function sanitiseEntry(entry, source) {
  if (!entry || typeof entry !== 'object') return null;
  const rcdType =
    typeof entry.rcd_type === 'string' && VALID_TYPES.has(entry.rcd_type.toUpperCase())
      ? entry.rcd_type.toUpperCase()
      : null;
  const confidence = VALID_CONFIDENCES.has(entry.confidence) ? entry.confidence : 'low';
  return {
    rcd_type: rcdType,
    ways: Number.isFinite(entry.ways) && entry.ways > 0 ? entry.ways : null,
    confidence,
    source,
    note: typeof entry.note === 'string' ? entry.note : null,
    verified_by: typeof entry.verified_by === 'string' ? entry.verified_by : null,
  };
}

/**
 * Pure lookup. Returns a result object describing the match (or miss).
 * Side-effect free; safe to call from anywhere.
 *
 * @param {{ manufacturer?: string|null, model?: string|null }} ident
 * @param {string} [lookupPath] — override path, for tests.
 * @returns {{
 *   rcd_type: ('AC'|'A'|'B'|'F'|'S'|null),
 *   ways: number|null,
 *   confidence: ('high'|'medium'|'low'|null),
 *   source: ('model'|'manufacturer_default'|'miss'),
 *   matched_key: string|null,
 *   note: string|null,
 *   verified_by: string|null
 * }}
 */
export function lookupRcdType({ manufacturer, model } = {}, lookupPath = DEFAULT_LOOKUP_PATH) {
  const table = loadLookupTable(lookupPath);
  const mfgKey = normaliseManufacturer(manufacturer);
  const modelKey = normaliseModel(model);

  if (mfgKey && modelKey) {
    const fullKey = `${mfgKey}/${modelKey}`;
    // Try both case variants of the model in the file (we normalise to
    // upper, but a hand-edited file might use mixed case).
    const candidates = [fullKey, `${mfgKey}/${modelKey.toLowerCase()}`];
    for (const k of candidates) {
      const hit = table.models?.[k];
      if (hit) {
        const sanitised = sanitiseEntry(hit, 'model');
        if (sanitised) {
          return { ...sanitised, matched_key: fullKey };
        }
      }
    }
  }

  if (mfgKey) {
    const mfgHit = table.manufacturer_defaults?.[mfgKey];
    if (mfgHit) {
      const sanitised = sanitiseEntry(mfgHit, 'manufacturer_default');
      if (sanitised) {
        return { ...sanitised, matched_key: mfgKey };
      }
    }
  }

  return {
    rcd_type: null,
    ways: null,
    confidence: null,
    source: 'miss',
    matched_key: null,
    note: null,
    verified_by: null,
  };
}

/**
 * Apply the lookup to an analysis object in-place. Mutates
 * `analysis.circuits[].rcd_type` per the confidence policy and attaches
 * provenance fields (`rcd_type_source`, `rcd_type_lookup_match`) so
 * downstream UI / logging can show why a value was chosen.
 *
 * Returns a summary object with counts and the raw lookup result so the
 * caller can emit a single structured log line and decide whether to
 * write a pending-review entry.
 *
 * Behaviour by lookup source:
 *   - `model` hit → uses the entry's confidence as-is.
 *   - `manufacturer_default` hit with rcd_type set → applies that type.
 *   - `manufacturer_default` hit with rcd_type=null → no-op (signal that
 *      the manufacturer is known but we explicitly chose not to default).
 *   - `miss` → no-op.
 *
 * Slot-confidence override only applies to RCBOs where Stage 3 already
 * read a per-slot waveform type AND the table entry is `medium`. The
 * override threshold is `PER_SLOT_OVERRIDE_THRESHOLD` (0.95).
 *
 * @param {object} analysis — mutated.
 * @param {{ logger?: object, userId?: string }} [opts]
 * @returns {{
 *   outcome: ('hit'|'default'|'miss'|'no_type'),
 *   matched_key: string|null,
 *   rcd_type: string|null,
 *   ways: number|null,
 *   confidence: string|null,
 *   verified_by: string|null,
 *   applied: number,
 *   overridden: number,
 *   kept: number,
 *   ways_warning: string|null
 * }}
 */
export function applyRcdTypeLookup(analysis, opts = {}) {
  const { logger, userId, lookupPath = DEFAULT_LOOKUP_PATH } = opts;
  const lookup = lookupRcdType(
    {
      manufacturer: analysis?.board_manufacturer,
      model: analysis?.board_model,
    },
    lookupPath
  );

  const baseSummary = {
    outcome:
      lookup.source === 'miss'
        ? 'miss'
        : lookup.source === 'model'
          ? 'hit'
          : lookup.rcd_type
            ? 'default'
            : 'no_type',
    matched_key: lookup.matched_key,
    rcd_type: lookup.rcd_type,
    ways: lookup.ways,
    confidence: lookup.confidence,
    verified_by: lookup.verified_by,
    applied: 0,
    overridden: 0,
    kept: 0,
    ways_warning: null,
  };

  // Cross-check ways against detected slot count — useful diagnostic
  // signal even when we can't fix the count from here.
  if (lookup.ways && analysis?.geometric?.moduleCount) {
    const detected = analysis.geometric.moduleCount;
    if (detected !== lookup.ways) {
      baseSummary.ways_warning = `detected ${detected} modules but ${lookup.matched_key} datasheet expects ${lookup.ways}`;
    }
  }

  if (lookup.source === 'miss' || !lookup.rcd_type) {
    if (logger) {
      logger.info('RCD type lookup outcome', {
        userId,
        manufacturer: analysis?.board_manufacturer ?? null,
        model: analysis?.board_model ?? null,
        outcome: baseSummary.outcome,
        matchedKey: baseSummary.matched_key,
        rcdType: baseSummary.rcd_type,
        confidence: baseSummary.confidence,
        verifiedBy: baseSummary.verified_by,
        applied: 0,
        overridden: 0,
        kept: 0,
        waysExpected: baseSummary.ways,
        waysDetected: analysis?.geometric?.moduleCount ?? null,
        waysWarning: baseSummary.ways_warning,
      });
    }
    return baseSummary;
  }

  const circuits = Array.isArray(analysis.circuits) ? analysis.circuits : [];
  const slots = Array.isArray(analysis.slots) ? analysis.slots : [];
  const slotsByIndex = new Map();
  for (const s of slots) {
    if (s && typeof s.slotIndex === 'number') slotsByIndex.set(s.slotIndex, s);
  }

  let applied = 0;
  let overridden = 0;
  let kept = 0;

  for (const circuit of circuits) {
    if (!circuit || circuit.is_rcd_device) continue;
    if (!circuit.rcd_protected) continue;

    const previousType = circuit.rcd_type ?? null;
    const slot = circuit.slot_index != null ? slotsByIndex.get(circuit.slot_index) : null;
    const slotConfidence = typeof slot?.confidence === 'number' ? slot.confidence : 0;

    let shouldApply;
    if (lookup.confidence === 'high') {
      shouldApply = true;
    } else if (lookup.confidence === 'medium') {
      // Honour confident per-slot reads that disagree (covers older
      // retrofitted devices in an otherwise-uniform-A board).
      const confidentDisagreement =
        previousType &&
        previousType !== lookup.rcd_type &&
        slotConfidence >= PER_SLOT_OVERRIDE_THRESHOLD;
      shouldApply = !confidentDisagreement;
    } else {
      // low — fill nulls only.
      shouldApply = !previousType;
    }

    if (shouldApply) {
      circuit.rcd_type = lookup.rcd_type;
      circuit.rcd_type_source = lookup.source;
      circuit.rcd_type_lookup_match = lookup.matched_key;
      circuit.rcd_type_lookup_confidence = lookup.confidence;
      if (previousType && previousType !== lookup.rcd_type) {
        overridden += 1;
      } else {
        applied += 1;
      }
    } else {
      kept += 1;
    }
  }

  const summary = { ...baseSummary, applied, overridden, kept };

  if (logger) {
    logger.info('RCD type lookup applied', {
      userId,
      manufacturer: analysis?.board_manufacturer ?? null,
      model: analysis?.board_model ?? null,
      outcome: summary.outcome,
      matchedKey: summary.matched_key,
      rcdType: summary.rcd_type,
      confidence: summary.confidence,
      verifiedBy: summary.verified_by,
      applied: summary.applied,
      overridden: summary.overridden,
      kept: summary.kept,
      waysExpected: summary.ways,
      waysDetected: analysis?.geometric?.moduleCount ?? null,
      waysWarning: summary.ways_warning,
    });
  }

  return summary;
}
