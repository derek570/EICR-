/**
 * §A4 (field-feedback-2026-07-14, F8) — pending-value capture + field-name
 * resolution + the typed structurally-complete-reading detector.
 *
 * THE BUG CLASS: session 6B6FE011 06:24 — "ICD trip time … 26 milliseconds"
 * garbled the FIELD, so the model asked "which reading was that for?" with
 * `context_field:"none"`. The inspector answered "RCD trip time." — a FIELD
 * NAME, the inverse of the ordinary ask shape (field known, value expected).
 * `resolveValueAnswer` returned a silent `no_value_context`, the 26 ms was
 * stored NOWHERE, Sonnet failed to rejoin it, and the turn ended in silence
 * (beep-then-nothing; circuit 2's RCD time never written).
 *
 * Three pure helpers close the class:
 *
 *   - extractPendingValue: at ask-registration time, capture the dangling
 *     VALUE from the turn transcript (preferred) or the ask question
 *     (fallback — the F8 question carried BOTH "circuit 2" and "26
 *     milliseconds", so scope-token exclusion must hold for both sources).
 *     Registered as `pendingValue` on the pending-asks entry — a SIBLING of
 *     `pendingWrite` (which covers the ordinary field-known shape).
 *
 *   - resolveFieldNameAnswer: resolve a field-NAME reply against a small
 *     evidence-backed alias table + the canonical field_schema labels,
 *     returning the canonical circuit-field key (snapshot key, e.g.
 *     `rcd_time_ms` — NOT the wire-corrected `rcd_trip_time`; wire
 *     canonicalisation happens downstream in the normal dispatch path).
 *
 *   - detectStructuredReading: the TYPED, schema-aware detector spanning ALL
 *     field families (circuit + board + supply + installation), used by BOTH
 *     answer channels to guard against consuming a structurally complete
 *     FRESH reading as an ask answer (audio-first invariant 2: structurally
 *     complete readings get WRITTEN — "Ze is 0.22" must never be burned as a
 *     pending circuit-field answer). Numeric parsing alone is not enough:
 *     "earthing arrangement is TT" (select) and "customer name is David"
 *     (free text) are complete with zero digits.
 *
 * Pure module — no logger, no session mutation. All consumers thread state.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FIELD_SCHEMA = require('../../config/field_schema.json');

// ── value/unit recognition ──────────────────────────────────────────────────

// Recognised measurement units, normalised. Longest-match-first at use site.
const UNIT_NORMALISE = new Map([
  ['milliseconds', 'ms'],
  ['millisecond', 'ms'],
  ['ms', 'ms'],
  ['megohms', 'Mohm'],
  ['megohm', 'Mohm'],
  ['meg ohms', 'Mohm'],
  ['mohm', 'Mohm'],
  ['milliamps', 'mA'],
  ['milliamp', 'mA'],
  ['ma', 'mA'],
  ['ohms', 'ohm'],
  ['ohm', 'ohm'],
  ['volts', 'V'],
  ['volt', 'V'],
  ['v', 'V'],
  ['kiloamps', 'kA'],
  ['ka', 'kA'],
  ['amps', 'A'],
  ['amp', 'A'],
  ['seconds', 's'],
  ['second', 's'],
]);

// Tokens that mark the ADJACENT number as a SCOPE reference, not a value.
// "circuit 2" / "circuits 5 and 6" / "board 2" / "way 4".
const SCOPE_TOKEN_RE = /^(?:circuits?|boards?|ways?)$/i;

/**
 * Find number spans with their neighbouring tokens classified.
 * Returns [{value, unit|null, isScope}] in text order.
 */
function classifyNumbers(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  // Tokenise keeping order; numbers may carry decimals.
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const m = tokens[i].match(/^(\d+(?:\.\d+)?)[.,;:!?]*$/);
    if (!m) continue;
    const value = m[1];
    // Scope classification: the PRECEDING token names a scope container.
    const prev = (tokens[i - 1] ?? '').replace(/[.,;:!?]+$/, '');
    const isScope = SCOPE_TOKEN_RE.test(prev);
    // Unit binding: the FOLLOWING one or two tokens name a unit.
    let unit = null;
    for (const span of [tokens[i + 1] ?? '', `${tokens[i + 1] ?? ''} ${tokens[i + 2] ?? ''}`]) {
      const cleaned = span
        .toLowerCase()
        .replace(/[.,;:!?]+/g, '')
        .trim();
      if (UNIT_NORMALISE.has(cleaned)) {
        unit = UNIT_NORMALISE.get(cleaned);
        break;
      }
    }
    out.push({ value, unit, isScope });
  }
  return out;
}

/**
 * Capture the dangling value for a `context_field:"none"` inverted ask.
 *
 * Rules (§A4 extractPendingValue algorithm):
 *   - prefer a number directly bound to a recognised unit;
 *   - numbers adjacent to circuit/board scope tokens are NEVER values;
 *   - if multiple candidate value spans remain at the same preference tier,
 *     do NOT capture — register the ask without pendingValue rather than
 *     guess (a wrong join is worse than a re-ask);
 *   - transcript FIRST, ask-question fallback (the prompt's canonical ask
 *     wording sometimes omits the numeric — "what was that reading for?").
 *
 * @param {{transcript?: string|null, question?: string|null}} sources
 * @returns {{value: string, unit: string|null, sourceText: string, source: 'transcript'|'question'}|null}
 */
export function extractPendingValue({ transcript, question }) {
  for (const [source, text] of [
    ['transcript', transcript],
    ['question', question],
  ]) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const numbers = classifyNumbers(text).filter((n) => !n.isScope);
    if (numbers.length === 0) continue;
    const unitBound = numbers.filter((n) => n.unit != null);
    if (unitBound.length === 1) {
      return { value: unitBound[0].value, unit: unitBound[0].unit, sourceText: text, source };
    }
    if (unitBound.length > 1) continue; // ambiguous — never guess
    if (numbers.length === 1) {
      return { value: numbers[0].value, unit: null, sourceText: text, source };
    }
    // >1 unbound spans — ambiguous, try the next source / give up.
  }
  return null;
}

// ── field-name resolution ───────────────────────────────────────────────────

// Evidence-backed alias table for THIS wave (F8's "RCD trip time" family +
// the canonical labels the fixtures exercise). Keys are normalised (lower,
// no punctuation). Extend only with field evidence — no broad fuzzy matching
// (parity-program §3E).
const FIELD_NAME_ALIASES = new Map([
  ['rcd trip time', 'rcd_time_ms'],
  ['rcd time', 'rcd_time_ms'],
  ['trip time', 'rcd_time_ms'],
  ['icd trip time', 'rcd_time_ms'],
  ['icd time', 'rcd_time_ms'],
  ['zs', 'measured_zs_ohm'],
  ['zed s', 'measured_zs_ohm'],
  ['r1 r2', 'r1_r2_ohm'],
  ['r1 plus r2', 'r1_r2_ohm'],
  ['insulation resistance', 'ir_live_earth_mohm'],
]);

// Leading filler the inspector naturally prefixes a field-name answer with.
const ANSWER_FILLER_RE =
  /^(?:the|that|this|it|its|it's|that's|it was|that was|for|for the|is|was)\s+/i;

function normaliseFieldNameReply(text) {
  let t = String(text ?? '')
    .toLowerCase()
    .replace(/[.,;:!?'"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let prev = null;
  while (prev !== t) {
    prev = t;
    t = t.replace(ANSWER_FILLER_RE, '');
  }
  return t;
}

/**
 * Resolve a field-NAME reply to a canonical circuit-field key. NET-NEW —
 * nothing in stage6-answer-resolver resolves field names today (only values,
 * circuits, enums and board ids).
 *
 * Returns the canonical `config/field_schema.json` circuit-field key
 * (e.g. `rcd_time_ms`), or null when nothing matches confidently.
 *
 * @param {string} userText
 * @param {object} [fieldSchema] — injectable for tests; defaults to the real schema
 */
export function resolveFieldNameAnswer(userText, fieldSchema = FIELD_SCHEMA) {
  const reply = normaliseFieldNameReply(userText);
  if (!reply) return null;
  // 1. Alias table — exact match on the normalised reply.
  if (FIELD_NAME_ALIASES.has(reply)) return FIELD_NAME_ALIASES.get(reply);
  // 2. Canonical schema labels ("RCD Trip Time (ms)" → "rcd trip time ms").
  const circuitFields = fieldSchema?.circuit_fields ?? {};
  for (const [key, def] of Object.entries(circuitFields)) {
    const label = typeof def?.label === 'string' ? def.label : '';
    const normLabel = label
      .toLowerCase()
      .replace(/[.,;:!?'"()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normLabel && (reply === normLabel || reply === key.replace(/_/g, ' '))) {
      return key;
    }
  }
  return null;
}

// ── typed structurally-complete-reading detector ────────────────────────────

// Families the detector spans. installation/board/supply fields dispatch via
// record_board_reading; circuit fields via record_reading. _ui_* meta keys
// are skipped.
const FAMILY_SOURCES = [
  ['circuit', 'record_reading', 'circuit_fields'],
  ['board', 'record_board_reading', 'board_fields'],
  ['supply', 'record_board_reading', 'supply_characteristics_fields'],
  ['installation', 'record_board_reading', 'installation_details_fields'],
];

// Hand aliases for spoken field names the schema labels don't cover.
// Evidence-backed, same discipline as FIELD_NAME_ALIASES.
const DETECTOR_ALIASES = new Map([
  ['zs', ['circuit', 'measured_zs_ohm']],
  ['zed s', ['circuit', 'measured_zs_ohm']],
  ['rcd trip time', ['circuit', 'rcd_time_ms']],
  ['trip time', ['circuit', 'rcd_time_ms']],
  ['r1 plus r2', ['circuit', 'r1_r2_ohm']],
  ['r1 r2', ['circuit', 'r1_r2_ohm']],
  ['ze', ['supply', 'earth_loop_impedance_ze']],
  ['zed e', ['supply', 'earth_loop_impedance_ze']],
  ['pfc', ['supply', 'prospective_fault_current']],
  ['earthing arrangement', ['supply', 'earthing_arrangement']],
  ['customer name', ['installation', 'client_name']],
  ['client name', ['installation', 'client_name']],
  ['wiring type', ['circuit', 'wiring_type']],
  ['reference method', ['circuit', 'ref_method']],
  ['ref method', ['circuit', 'ref_method']],
]);

const BOOLEAN_VOCAB = new Set([
  'yes',
  'no',
  'pass',
  'passed',
  'fail',
  'failed',
  'confirmed',
  'ticked',
  'ok',
  'satisfactory',
]);

// Sentinel value vocabulary (LIM family + discontinuous/open + greater-than).
const SENTINEL_VALUE_RE =
  /\b(?:lim|limitation|discontinuous|open circuit|infinity|greater than \d+|>\s*\d+)\b/i;

let lexiconCache = null;
function buildLexicon(fieldSchema) {
  const lex = [];
  for (const [family, toolFamily, schemaKey] of FAMILY_SOURCES) {
    const fields = fieldSchema?.[schemaKey] ?? {};
    for (const [key, def] of Object.entries(fields)) {
      if (key.startsWith('_ui_') || !def || typeof def !== 'object') continue;
      const names = new Set();
      names.add(key.replace(/_/g, ' ').toLowerCase());
      if (typeof def.label === 'string' && def.label.trim()) {
        names.add(
          def.label
            .toLowerCase()
            .replace(/[.,;:!?'"()]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      }
      lex.push({ family, toolFamily, key, def, names: [...names] });
    }
  }
  // Longest names first so "rcd trip time" wins over "trip time" substrings.
  lex.sort(
    (a, b) => Math.max(...b.names.map((n) => n.length)) - Math.max(...a.names.map((n) => n.length))
  );
  return lex;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect a structurally complete FRESH reading (field + type-appropriate
 * value + scope where the family demands it) in free text. Used to guard
 * BOTH ask-answer channels: a complete fresh reading must be treated as an
 * overtake (recorded via normal dispatch), never consumed as an ask answer.
 *
 * Completeness by family:
 *   - circuit fields: field + value + an EXPLICIT circuit ref ("Zs circuit 4
 *     is 0.30"). Without the ref the utterance is ambiguous against an
 *     active ask (it may be restating the ask's own field/value) — stay
 *     conservative and do NOT classify as complete.
 *   - board/supply/installation fields: field + value ("Ze is 0.22",
 *     "earthing arrangement is TT", "customer name is David").
 *
 * Value recognition is SCHEMA-TYPE-AWARE:
 *   - numeric-ish fields: a non-scope number or a sentinel (LIM/discontinuous);
 *   - select fields: one of the field's canonical options (case-insensitive);
 *   - boolean-ish fields: the boolean vocabulary;
 *   - free-text fields: an assignment form ("<name> is <non-empty rest>").
 *
 * @param {string} text
 * @param {object} [fieldSchema]
 * @returns {{fieldKey: string, family: string, toolFamily: string, circuit: number|null, complete: boolean}|null}
 */
export function detectStructuredReading(text, fieldSchema = FIELD_SCHEMA) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (fieldSchema === FIELD_SCHEMA) {
    if (!lexiconCache) lexiconCache = buildLexicon(FIELD_SCHEMA);
  }
  const lexicon = fieldSchema === FIELD_SCHEMA ? lexiconCache : buildLexicon(fieldSchema);

  const lower = text
    .toLowerCase()
    .replace(/[,;:!?'"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Scope parse.
  const circuitMatch = lower.match(/\bcircuits?\s+(\d{1,3})\b/);
  const circuit = circuitMatch ? Number.parseInt(circuitMatch[1], 10) : null;

  // Field-name match: detector aliases first (spoken forms), then lexicon.
  let hit = null;
  let matchedName = null;
  for (const [alias, [family, key]] of DETECTOR_ALIASES) {
    const re = new RegExp(`\\b${escapeRe(alias)}\\b`, 'i');
    if (re.test(lower)) {
      const entry = lexicon.find((l) => l.key === key && l.family === family);
      if (entry) {
        hit = entry;
        matchedName = alias;
        break;
      }
    }
  }
  if (!hit) {
    for (const entry of lexicon) {
      for (const name of entry.names) {
        if (name.length < 3) continue; // too short to trust as a bare-word hit
        const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'i');
        if (re.test(lower)) {
          hit = entry;
          matchedName = name;
          break;
        }
      }
      if (hit) break;
    }
  }
  if (!hit) return null;

  // Value recognition, typed by the schema def.
  const def = hit.def ?? {};
  const type = typeof def.type === 'string' ? def.type : 'text';
  const options = Array.isArray(def.options) ? def.options : null;
  let hasValue = false;

  if (options && options.length > 0) {
    // Select field — one of the canonical options present as a word.
    hasValue = options.some((opt) => {
      const o = String(opt).toLowerCase().trim();
      if (!o) return false;
      return new RegExp(`\\b${escapeRe(o)}\\b`, 'i').test(lower);
    });
  } else if (type === 'number' || /(ohm|_ms|_ma|_v|_s|_ka|current|voltage|time)/.test(hit.key)) {
    // Numeric-ish — a non-scope number or a sentinel.
    const numbers = classifyNumbers(lower).filter((n) => !n.isScope);
    hasValue = numbers.length > 0 || SENTINEL_VALUE_RE.test(lower);
  } else if (/confirmed|_present|polarity/.test(hit.key)) {
    // Boolean-ish.
    const words = lower.split(/\s+/);
    hasValue = words.some((w) => BOOLEAN_VOCAB.has(w.replace(/[.]+$/, '')));
  } else {
    // Free-text — assignment form: "<field name> is|was|equals <rest>".
    const re = new RegExp(`\\b${escapeRe(matchedName)}\\b\\s+(?:is|was|equals)\\s+(\\S+)`, 'i');
    hasValue = re.test(lower);
  }

  const complete = hasValue && (hit.family !== 'circuit' || circuit != null);
  return {
    fieldKey: hit.key,
    family: hit.family,
    toolFamily: hit.toolFamily,
    circuit,
    complete,
  };
}
