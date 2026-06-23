/**
 * Plan 06-23 obs-#52 Fix B — authoritative BS 7671 regulation lookup.
 *
 * WHAT: derive the bare regulation key from a model-produced
 * `suggested_regulation` value and, when that key exists in
 * `config/bs7671-regulations.json`, return the CANONICAL title + description
 * so the displayed observation wording is table-validated rather than
 * model free-text.
 *
 * WHY: Decision 1 (locked 2026-06-23) is "Fix A + B" — raise the ceiling /
 * extend the shape gate so the model's "number + wording" survives (Fix A),
 * AND, where the cited number is in the canonical table, replace its wording
 * with the authoritative BS 7671 text (Fix B). The two compose: Fix A lets the
 * model's wording through, Fix B upgrades it to canonical wording on a table
 * HIT and falls back to the (shape-validated) model wording on a MISS.
 *
 * CAVEAT — table coverage is thin (68 entries, versioned BS 7671:2018+A2:2022)
 * while the tool schema cites A4:2026; the schema's own example ref `411.3.4`
 * is NOT in the table. So table-MISS is the COMMON case, not the exception —
 * most observations fall back to the model wording, which is exactly why
 * Fix A's shape-gate extension is mandatory.
 *
 * The table is consumed read-only here; the only other consumer is
 * `src/routes/settings.js` (the /api/regulations search endpoint). Loaded once
 * synchronously and cached, so the per-observation dispatcher hook stays cheap
 * and non-async.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, {ref: string, title: string, description: string}> | null} */
let regulationIndexCache = null;

function loadRegulationIndex() {
  if (regulationIndexCache) return regulationIndexCache;
  const regPath = path.join(__dirname, '..', '..', 'config', 'bs7671-regulations.json');
  const parsed = JSON.parse(readFileSync(regPath, 'utf-8'));
  const index = new Map();
  const regulations = Array.isArray(parsed.regulations) ? parsed.regulations : [];
  for (const entry of regulations) {
    if (entry && typeof entry.ref === 'string') {
      index.set(entry.ref, {
        ref: entry.ref,
        title: typeof entry.title === 'string' ? entry.title : null,
        description: typeof entry.description === 'string' ? entry.description : null,
      });
    }
  }
  regulationIndexCache = index;
  return index;
}

/**
 * Derive the bare numeric table key from a `suggested_regulation` value.
 *
 * Table keys are all bare numeric refs ("411.3.3", "701.411.3.3"), so we:
 *   1. drop a wording tail — the leading-anchored numeric match below stops at
 *      the first non-ref character (space / dash / colon), so we do NOT need to
 *      pre-split on the prose delimiter;
 *   2. strip a leading "BS 7671" standard prefix and a leading
 *      "Regulation"/"Reg" prefix (these never appear in table keys);
 *   3. return the leading bare-numeric ref token, or null if none is present
 *      (e.g. "BS 7671 Part 6", a bare standard name, or pure prose — all of
 *      which legitimately MISS the table).
 *
 * @param {string} suggestedRegulation
 * @returns {string|null}
 */
export function deriveRegulationRef(suggestedRegulation) {
  if (typeof suggestedRegulation !== 'string') return null;
  let s = suggestedRegulation.trim();
  if (s.length === 0) return null;
  // Strip a leading "BS 7671" standard prefix (table keys are bare numeric).
  s = s.replace(/^BS\s*7671\s+/i, '');
  // Strip a leading "Regulation"/"Reg" prefix.
  s = s.replace(/^Reg(ulation)?\s+/i, '');
  // Leading bare-numeric ref token (matches table-key shape; stops at the
  // first non-ref char, so any trailing wording is ignored).
  const m = s.match(/^\d{1,4}(?:\.\d{1,3}){1,4}[a-z]?/);
  return m ? m[0] : null;
}

/**
 * Look up the canonical BS 7671 entry for a `suggested_regulation` value.
 *
 * @param {string} suggestedRegulation  the model's ref (+ optional wording)
 * @returns {{ref: string, title: string|null, description: string|null}|null}
 *   the canonical entry on a table HIT, or null on a MISS (caller falls back
 *   to the shape-validated model wording).
 */
export function lookupRegulation(suggestedRegulation) {
  const ref = deriveRegulationRef(suggestedRegulation);
  if (!ref) return null;
  const index = loadRegulationIndex();
  return index.get(ref) ?? null;
}

/** Test seam — reset the cached index (jest module-state isolation). */
export function _resetRegulationIndexCacheForTests() {
  regulationIndexCache = null;
}
