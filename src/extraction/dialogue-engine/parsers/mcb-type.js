/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — OCPD type: canonicalise,
 * admit on the script path only, and derive the advisory.
 *
 * `ocpd_type` is FREE TEXT. Derek, 2026-09-19: "it is not CertMate's job to
 * make sure the inspector can't put a fuse type in that is incompatible … If
 * they're not in our standard list, it should advise that this may not be
 * correct but still record it." So nothing in this file ever refuses a
 * non-blank value:
 *
 *   canonicaliseOcpdType(raw) — deterministic normalisation. The ONE backend
 *     function the dialogue slot AND `coerceRecordReadingValue` call, so
 *     direct `record_reading`, `set_field_for_all_circuits` and the loaded-
 *     barrel speculator all see the same bytes. Never null for a non-blank
 *     value; no length rule.
 *   parseMcbType(raw) — the dialogue SCRIPT slot's parser: canonicalise, then
 *     admit exactly one remaining token that is not a no-type sentinel. A miss
 *     returns null, which is PLAN-A's first-miss handoff — never a re-ask.
 *   ocpdTypeAdvisory({ ocpdBsEn, ocpdType }) — the derived advisory, never
 *     persisted: 'unknown' (not a suggestion) or 'incompatible' (not in the
 *     compatibility row of the circuit's canonical standard).
 *
 * The pre-plan patterns this replaces searched ANYWHERE in the reply
 * (`\btype\s*([BCD])\b`). The grammar is now anchored on the whole reply, so a
 * chatty reply ("it's a type B") misses here and is caught by the slot's named
 * extractor or handed to the model (Decision 7). Every form the old parser
 * canonicalised as a whole reply still canonicalises (`B curve`, `b-curve`,
 * `curve c`, `high rupturing capacity`, the rewirable spellings, `g G`,
 * `type 1`, `type 2`).
 *
 * NORMATIVE SOURCE: `config/ocpd-type-suggestions.json`. The TS twin
 * (`packages/shared-utils/src/ocpd-type.ts`) and the Swift twin
 * (`OcpdType.swift`) are driven through the same vectors; this file's
 * conformance suite is `src/__tests__/ocpd-type-suggestions.test.js`. No
 * edit-distance and no nearest match anywhere (HARD RULE).
 */

import { createRequire } from 'node:module';

import { parseOcpdStandard } from './bs-code.js';

const require = createRequire(import.meta.url);
const manifest = require('../../../../config/ocpd-type-suggestions.json');

/** The suggestion list, read from the shared manifest — never a second copy. */
export const OCPD_TYPE_SUGGESTIONS = Object.freeze([...manifest.suggestions]);

/** Compatibility rows keyed by canonical standard. */
const COMPATIBILITY = (() => {
  const out = new Map();
  for (const row of manifest.compatibility) {
    for (const s of row.standards) out.set(s, new Set(row.types));
  }
  return out;
})();

// Same literal as ocpd-standard.ts / OcpdStandard.swift: JavaScript's `\s` and
// ICU's `\s` are different sets, so every twin spells the set out.
const WHITESPACE_CLASS =
  '\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
const ANY_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]`, 'g');

const WHOLE_VALUE_RULES = [
  { re: /^([a-z])(?:-| )?curve$/, to: (m) => m[1].toUpperCase() },
  { re: /^high[ -]*rupturing[ -]*capacity$/, to: 'HRC' },
  { re: /^h ?r ?c$/, to: 'HRC' },
  { re: /^re[- ]?wir[ea]+ble$/, to: 'Rew' },
  { re: /^rew$/, to: 'Rew' },
  { re: /^g ?g$/, to: 'gG' },
  { re: /^g ?m$/, to: 'gM' },
  { re: /^a ?m$/, to: 'aM' },
  { re: /^(?:n ?\/ ?a|n ?a|n\. ?a|not applicable)$/, to: 'N/A' },
  { re: /^(?:i i|eye eye|one one)$/, to: 'II' },
];

const NUMBER_WORDS = Object.freeze({ one: '1', two: '2', three: '3', four: '4' });

// Two-letter words that are never a spelled type code ("type is C" must not
// join to `ISC`). Mirrors SPELLED_CODE_STOPWORDS in the TS twin.
const SPELLED_CODE_STOPWORDS = new Set([
  'is',
  'it',
  'on',
  'of',
  'to',
  'at',
  'in',
  'an',
  'or',
  'be',
  'by',
  'so',
  'no',
  'as',
  'if',
  'up',
  'do',
  'go',
  'we',
  'me',
  'my',
  'he',
  'us',
]);

// PLAN-W2 (B-138) — a spelled-code token is at most two ASCII letters, digits or
// `+`, and never two digits. "C, 32" used to join to `C,32` (the comma rode in on
// a two-glyph token) and "C 32" to `C32` (a rating read as half a code).
function isSpelledCodeToken(token) {
  return (
    Array.from(token).length <= 2 &&
    !SPELLED_CODE_STOPWORDS.has(token.toLowerCase()) &&
    /^[A-Za-z0-9+]+$/.test(token) &&
    !/^[0-9]{2}$/.test(token)
  );
}

// PLAN-W2 (B-138) — the one-letter suggestions (B, C, D, K, Z, I) are curve
// letters. Read from the manifest, never hard-coded.
const CURVE_LETTERS = new Set(
  OCPD_TYPE_SUGGESTIONS.filter((s) => /^[A-Za-z]$/.test(s)).map((s) => s.toLowerCase())
);

// PLAN-W2 (B-138) — a curve letter followed by a number is a letter and a rating,
// not a spelled code: "B 6" must not join to `B6`. The token rule alone misses a
// single-digit rating.
function isSpelledCodeList(tokens) {
  if (tokens.length < 2 || tokens.length > 4 || !tokens.every(isSpelledCodeToken)) return false;
  if (
    CURVE_LETTERS.has(tokens[0].toLowerCase()) &&
    tokens.slice(1).some((t) => /^[0-9]+$/.test(t))
  ) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} raw
 * @returns {string|null} the normalised value; '' for blank; null only for a
 *   non-string, non-number input.
 */
export function canonicaliseOcpdType(raw) {
  let source;
  if (typeof raw === 'string') source = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) source = String(raw);
  else return null;

  let v = source.replace(ANY_WHITESPACE, ' ').trim();
  if (v === '') return '';

  const unpunctuated = v.replace(/[.,?!]+$/, '').trim();
  if (unpunctuated !== '') v = unpunctuated;
  const unprefixed = v.replace(/^(?:type|curve)(?: +|$)/i, '').trim();
  if (unprefixed !== '') v = unprefixed;
  v = v.replace(/ +/g, ' ');

  const lower = v.toLowerCase();
  for (const rule of WHOLE_VALUE_RULES) {
    const m = lower.match(rule.re);
    if (m) return typeof rule.to === 'string' ? rule.to : rule.to(m);
  }

  let tokens = v.split(' ').map((t) => (t.toLowerCase() === 'plus' ? '+' : t));

  const numberAt = tokens
    .map((t, i) => (NUMBER_WORDS[t.toLowerCase()] ? i : -1))
    .filter((i) => i >= 0);
  if (numberAt.length === 1) {
    const at = numberAt[0];
    const others = tokens.filter((_, i) => i !== at);
    const spelledContext =
      tokens.length >= 2 && tokens.length <= 4 && others.every(isSpelledCodeToken);
    if (tokens.length === 1 || spelledContext) {
      tokens = tokens.map((t, i) => (i === at ? NUMBER_WORDS[t.toLowerCase()] : t));
    }
  }

  if (isSpelledCodeList(tokens)) {
    return tokens.join('').toUpperCase();
  }

  if (tokens.length === 1) {
    const t = tokens[0];
    if (/^[a-z]$/i.test(t)) return t.toUpperCase();
    const listed = OCPD_TYPE_SUGGESTIONS.find((s) => s.toLowerCase() === t.toLowerCase());
    return listed ?? t;
  }

  return tokens.join(' ');
}

function isNoTypeSentinel(token) {
  const lower = token.toLowerCase();
  return lower === 'type' || lower === 'curve' || !/[a-z0-9]/i.test(token);
}

/**
 * The OCPD / RCBO scripts' type-slot parser. Admission is the script path's
 * alone: exactly one remaining token that is not a no-type sentinel.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function parseMcbType(text) {
  const c = canonicaliseOcpdType(text);
  if (c == null || c === '') return null;
  if (c.includes(' ')) return null;
  if (isNoTypeSentinel(c)) return null;
  return c;
}

function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * @param {{ ocpdBsEn?: unknown, ocpdType?: unknown }} args
 * @returns {'unknown'|'incompatible'|null}
 */
export function ocpdTypeAdvisory({ ocpdBsEn, ocpdType } = {}) {
  const type = str(ocpdType).trim();
  if (type === '') return null;
  const canonical = canonicaliseOcpdType(type);
  if (canonical == null || canonical === '') return null;
  if (canonical === 'N/A') return null;
  if (!OCPD_TYPE_SUGGESTIONS.includes(canonical)) return 'unknown';
  const standard = parseOcpdStandard(str(ocpdBsEn));
  if (standard == null) return null;
  const row = COMPATIBILITY.get(standard);
  if (!row) return null;
  return row.has(canonical) ? null : 'incompatible';
}

/** The advisory's short text, or null. Same bytes as the TS twin's
 *  `ocpdTypeAdvisoryText`. */
export function ocpdTypeAdvisoryText(args) {
  const advisory = ocpdTypeAdvisory(args);
  if (advisory === 'unknown') return manifest.advisory_phrases.unknown;
  if (advisory === 'incompatible') {
    return manifest.advisory_phrases.incompatible.replace(
      '{standard}',
      parseOcpdStandard(str(args.ocpdBsEn))
    );
  }
  return null;
}

/**
 * The OCPD / RCBO type slot's NAMED extractor (dialogue engine step 7), shared
 * by both schemas so they cannot drift. It runs on the RAW reply with circuit
 * spans masked (the slot declares `parsesRawReply`), never the annotated text:
 * the slot's own question ("say the type printed on a fuse") would otherwise be
 * captured as the answer.
 *
 * The capture widened from `[BCD]` to the C2.2 token grammar. It takes a lazy
 * run after `type` / `curve` that ends at punctuation, a rating ("32 amps",
 * "6 kA"), a linking word ("on", "for", "circuit", "rated", "BS", …) or the end
 * of the clause, and hands it to `parseMcbType`, which admits a single token
 * only. So "type B 32 amps" gives `B`, "type X Y Z" gives `XYZ`, and
 * "type extraordinarily long" gives nothing (the script steps aside).
 *
 * WHICH FIELD A TYPE BELONGS TO is decided by the CLAUSE, not by the words next
 * to it (`OCPD_TYPE_CLAUSE_VETO` below; `namedExtractorClauseVeto` in
 * helpers/extraction.js). Three review rounds each found another phrasing that
 * a word-distance window let through ("RCD is type B", "type B on the RCD",
 * "the RCD fitted here is type B"). The inspector's own words mark the scope:
 * a clause that names another column never yields an OCPD type, and a comma
 * still separates clauses, so "type B, RCD type A" writes `B`. The RCD waveform
 * codes that are not OCPD types (`AC`, `A`, `F`, `S`, `A-S`, `B-S`) are never
 * captured. The `<letter> curve` form keeps its own arm.
 */
export const OCPD_TYPE_NAMED_EXTRACTOR =
  /\b(?:type|curve)\s+(?:(?:is|was|of)\s+)?(?!(?:ac|a|f|s|a-s|b-s)(?:\s|$))([a-z0-9+/][a-z0-9+/ -]*?)(?=\s+\d+(?:\.\d+)?\s*(?:amps?|a|ka|kilo\s*amps?)\b|\s+(?:on|for|at|in|and|with|rated|rating|breaking|bs|b\s*s|circuit|rcbo|mcb)\b|\s*$)|\b([a-z])\s*-?\s*curve\b/i;

/**
 * A clause that names another column's type. When it matches, the clause
 * yields no OCPD type (Decision 7: the fast path does not decide scope it
 * cannot see; the model has the whole utterance). The wiring / reference /
 * installation labels are the SAME vocabulary both client matchers exclude
 * (`WIRING_OR_REF_BEFORE_TYPE` on web, its iOS twin), including the Deepgram
 * garble "worrying", so the three paths agree (Codex EP cycle 4).
 */
export const OCPD_TYPE_CLAUSE_VETO =
  /\b(?:rcd|rccb|residual|waveform|wir\w*|worrying|cable|ref\w*|reference|installation)\b/i;

// ─────────────────────────────────────────────────────────────────────────
// Grouped advisory clause — the backend twin of the TS
// `buildOcpdTypeAdvisoryClause` / `renderOcpdTypeRefList`, used by the
// bundler's grouped `set_field_for_all_circuits` read-back. Same bytes as the
// clients' local bulk sentences, pinned by the manifest's bulk vectors.
// ─────────────────────────────────────────────────────────────────────────

function numericRefs(refs) {
  const out = [];
  for (const r of refs) {
    const n = typeof r === 'number' ? r : Number(String(r).trim());
    if (!Number.isInteger(n)) return null;
    out.push(n);
  }
  return out;
}

/** `4` · `2 and 3` · `1 to 4` (three or more contiguous) · `1, 3 and 5`. */
export function renderOcpdTypeRefList(refs) {
  const nums = numericRefs(refs);
  const ordered = nums ? [...nums].sort((a, b) => a - b).map(String) : refs.map((r) => String(r));
  if (ordered.length === 0) return '';
  if (ordered.length === 1) return ordered[0];
  if (nums && ordered.length >= 3) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
      return `${sorted[0]} to ${sorted[sorted.length - 1]}`;
    }
  }
  if (ordered.length === 2) return `${ordered[0]} and ${ordered[1]}`;
  return `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}`;
}

function circuitsPhrase(refs) {
  return `${refs.length === 1 ? 'circuit' : 'circuits'} ${renderOcpdTypeRefList(refs)}`;
}

/**
 * The advisory clause for a group of written circuits sharing one type, or ''.
 * `' — not a type I know'` (standard-independent, no circuit list) or
 * `' — may not be right for S1 on circuits … and for S2 on circuit …'`.
 *
 * @param {string} type
 * @param {Array<{ circuit: number|string, ocpdBsEn: unknown }>} written
 */
export function buildOcpdTypeAdvisoryClause(type, written) {
  const groups = new Map();
  for (const w of written) {
    const advisory = ocpdTypeAdvisory({ ocpdBsEn: w.ocpdBsEn, ocpdType: type });
    if (advisory === 'unknown') return ` — ${manifest.advisory_phrases.unknown}`;
    if (advisory !== 'incompatible') continue;
    const standard = parseOcpdStandard(str(w.ocpdBsEn));
    const list = groups.get(standard) ?? [];
    list.push(w.circuit);
    groups.set(standard, list);
  }
  if (groups.size === 0) return '';
  const lowest = (refs) => {
    const nums = numericRefs(refs);
    return nums ? Math.min(...nums) : Number.POSITIVE_INFINITY;
  };
  const ordered = [...groups.entries()].sort((a, b) => lowest(a[1]) - lowest(b[1]));
  return ` — may not be right ${ordered
    .map(([standard, refs]) => `for ${standard} on ${circuitsPhrase(refs)}`)
    .join(' and ')}`;
}

/**
 * A grouped STANDARD write's clause: the circuits whose stored type becomes
 * incompatible with the new standard, or ''. Types can differ per circuit, so
 * the clause names "the recorded type" rather than one value.
 *
 * @param {string} standard — the written (canonical) standard
 * @param {Array<{ circuit: number|string, ocpdType: unknown }>} targets
 */
export function buildOcpdStandardTypeClause(standard, targets) {
  const off = targets
    .filter(
      (t) => ocpdTypeAdvisory({ ocpdBsEn: standard, ocpdType: t.ocpdType }) === 'incompatible'
    )
    .map((t) => t.circuit);
  if (off.length === 0) return '';
  return `, the recorded type may not be right for ${parseOcpdStandard(str(standard))} on ${circuitsPhrase(off)}`;
}

/**
 * Non-enumerable marker the record_reading / set_field_for_all_circuits
 * dispatchers stamp on a per-turn write entry whose `ocpd_type` OR `ocpd_bs_en`
 * was ALREADY the stored value (compared canonically on both sides). The
 * bundler reads it: Decision 6 says the advisory "is not repeated on later
 * turns for the same value", and the advisory judges the (standard, type)
 * PAIR, so a re-statement of either member leaves the pair unchanged. A Symbol
 * so it can never reach the wire or a JSON snapshot.
 */
export const OCPD_VALUE_UNCHANGED = Symbol('ocpd_value_unchanged');

/** True when the stored type already equals the candidate canonically. */
export function ocpdTypeUnchanged(stored, candidate) {
  const s = str(stored).trim();
  if (s === '') return false;
  const a = canonicaliseOcpdType(candidate);
  return a != null && a !== '' && a === canonicaliseOcpdType(s);
}

/**
 * The same test for either member of the pair: `ocpd_type` through the type
 * canonicaliser, `ocpd_bs_en` through the standard parser (an unreadable value
 * compares raw). Any other field → false.
 */
export function ocpdPairMemberUnchanged(field, stored, candidate) {
  if (field === 'ocpd_type') return ocpdTypeUnchanged(stored, candidate);
  if (field !== 'ocpd_bs_en') return false;
  const s = str(stored).trim();
  const c = str(candidate).trim();
  if (s === '' || c === '') return false;
  return (parseOcpdStandard(s) ?? s) === (parseOcpdStandard(c) ?? c);
}
