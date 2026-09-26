/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — `ocpd_type` free text.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ocpd_type` was a closed list of nine values (`B, C, D, gG, gM, aM, HRC,
 * Rew, N/A`). A BS 3871 Type 2, a BS 1361 Type II or a BS EN 60947-2 K curve
 * could not be recorded: the closed-enum guard re-asked and the dispatcher
 * rejected them. Derek's Decision 6 (2026-09-19): "it is not CertMate's job to
 * make sure the inspector can't put a fuse type in that is incompatible … If
 * they're not in our standard list, it should advise that this may not be
 * correct but still record it. The point of an EICR is to record what the
 * inspector sees."
 *
 * So there is NO write gate for this field anywhere. This module supplies:
 *   - `canonicaliseOcpdType` — deterministic normalisation of a spoken or typed
 *     type. It never rejects a non-blank value and has no length rule.
 *   - `admitOcpdTypeForScript` — the dialogue script's admission predicate. It
 *     is the ONLY place the grammar can say "that was not a type"; a miss there
 *     hands the turn to the model (PLAN-A's first-miss handoff), never re-asks.
 *   - `ocpdTypeAdvisory` — the derived, never-persisted advisory: `unknown`
 *     (not on the suggestion list) or `incompatible` (on the list, but not in
 *     the compatibility row for the circuit's standard).
 *   - the local-command sentences, so web and iOS speak identical bytes.
 *
 * NOT FUZZY MATCHING
 * ------------------
 * Every rule below is a fixed, whole-value rewrite of a documented spoken form.
 * There is no edit-distance and no nearest match (the project's HARD RULE).
 * An unknown value is stored exactly as dictated, with the advisory.
 *
 * NORMATIVE SOURCE
 * ----------------
 * `config/ocpd-type-suggestions.json` is the contract. `web/tests/ocpd-type.test.ts`
 * drives every vector through this module and compares returned bytes; the
 * backend twin (`src/extraction/dialogue-engine/parsers/mcb-type.js`) and the
 * Swift twin (`Sources/Utilities/OcpdType.swift`) are driven through the same
 * vectors. If this code and the manifest disagree, the manifest wins.
 */

import { canonicaliseOcpdStandard } from './ocpd-standard';

/** The suggestion list, in picker order. A SUGGESTION list, never a closed set:
 *  anything else is still stored, with the `unknown` advisory. Mirrors the
 *  manifest's `suggestions`. */
export const OCPD_TYPE_SUGGESTIONS: readonly string[] = Object.freeze([
  'B',
  'C',
  'D',
  'K',
  'Z',
  '1',
  '2',
  '3',
  '4',
  'I',
  'II',
  'gG',
  'gM',
  'aM',
  'HRC',
  'Rew',
  'N/A',
]);

/** Picker control cap. The control refuses a 25th character; no other boundary
 *  has a length rule. Mirrors the manifest's `cap`. */
export const OCPD_TYPE_INPUT_CAP = 24;

/** Compatibility table, keyed by the CANONICAL standard. Advisory only: a type
 *  outside a row is still written. A standard with no row (BS 1362, BS 646,
 *  BS EN 60269-4, empty, unreadable) never yields `incompatible`. */
const OCPD_TYPE_COMPATIBILITY: Readonly<Record<string, readonly string[]>> = (() => {
  const rows: Array<[string[], string[]]> = [
    [
      ['BS EN 60898', 'BS EN 61009', 'BS EN 62423'],
      ['B', 'C', 'D'],
    ],
    [['BS EN 60947-2'], ['B', 'C', 'D', 'K', 'Z', '1', '2', '3']],
    [['BS 3871'], ['1', '2', '3', '4']],
    // `1` / `2` are the display aliases of `I` / `II` under BS 1361: "type two"
    // stores `2` as said, and the certificate shows `II`.
    [['BS 1361'], ['I', 'II', '1', '2']],
    [
      ['BS 88-2', 'BS EN 60269-2'],
      ['gG', 'gM', 'aM', 'HRC'],
    ],
    [
      ['BS 88-3', 'BS EN 60269-3'],
      ['gG', 'HRC'],
    ],
    [['BS 3036'], ['Rew']],
  ];
  const out: Record<string, readonly string[]> = {};
  for (const [standards, types] of rows) {
    for (const s of standards) out[s] = Object.freeze([...types]);
  }
  return Object.freeze(out);
})();

/** Test hook: the table exactly as the manifest's `compatibility` rows expand. */
export function ocpdTypeCompatibilityTable(): Readonly<Record<string, readonly string[]>> {
  return OCPD_TYPE_COMPATIBILITY;
}

/**
 * EVERY whitespace character either twin will see, written out — the same
 * literal as `ocpd-standard.ts`, for the same reason: JavaScript's `\s` and
 * ICU's `\s` are different sets, and a non-breaking space pasted from a PDF
 * would otherwise trim on one client and not the other.
 */
const WHITESPACE_CLASS =
  '\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
const ANY_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]`, 'g');

/** Step 1 whole-value rewrites, matched against the LOWER-CASED value. Order is
 *  part of the contract. Today's deterministic aliases (the pre-plan
 *  `mcb-type.js` patterns) come first, so every form that canonicalised before
 *  still canonicalises, and never hands off. */
const WHOLE_VALUE_RULES: ReadonlyArray<{
  re: RegExp;
  to: string | ((m: RegExpMatchArray) => string);
}> = [
  // `B curve`, `b-curve`, `K curve` → the letter.
  { re: /^([a-z])(?:-| )?curve$/, to: (m) => m[1].toUpperCase() },
  { re: /^high[ -]*rupturing[ -]*capacity$/, to: 'HRC' },
  { re: /^h ?r ?c$/, to: 'HRC' },
  { re: /^re[- ]?wir[ea]+ble$/, to: 'Rew' },
  { re: /^rew$/, to: 'Rew' },
  { re: /^g ?g$/, to: 'gG' },
  { re: /^g ?m$/, to: 'gM' },
  { re: /^a ?m$/, to: 'aM' },
  { re: /^(?:n ?\/ ?a|n ?a|n\. ?a|not applicable)$/, to: 'N/A' },
  // Roman forms. `one one` is the ONE exempt number-word pair; `two two` is
  // not joined (the v6 claim `type two two → II` stays withdrawn).
  { re: /^(?:i i|eye eye|one one)$/, to: 'II' },
];

const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  one: '1',
  two: '2',
  three: '3',
  four: '4',
});

/**
 * Two-letter English words that are never a spelled type code. Without this a
 * reply like "type is C" joins to `ISC` under the spelled-code rule — a value
 * the inspector never said, which is the opposite of Decision 6. A token here
 * blocks the join, so the value is stored as said (model path) or the script
 * steps aside (Decision 7). Pinned by the manifest's `type is C` / `it is B`
 * vectors.
 */
const SPELLED_CODE_STOPWORDS: ReadonlySet<string> = new Set([
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

function glyphCount(token: string): number {
  return Array.from(token).length;
}

// PLAN-W2 (B-138) — a spelled-code token is at most two ASCII letters, digits or
// `+`, and never two digits. "C, 32" used to join to `C,32` (the comma rode in on
// a two-glyph token) and "C 32" to `C32` (a rating read as half a code). Mirrors
// `isSpelledCodeToken` in mcb-type.js and OcpdType.swift.
function isSpelledCodeToken(token: string): boolean {
  return (
    glyphCount(token) <= 2 &&
    !SPELLED_CODE_STOPWORDS.has(token.toLowerCase()) &&
    /^[A-Za-z0-9+]+$/.test(token) &&
    !/^[0-9]{2}$/.test(token)
  );
}

/** PLAN-W2 (B-138) — the one-letter suggestions (B, C, D, K, Z, I) are curve
 *  letters. Read from the manifest, never hard-coded. */
const CURVE_LETTERS: ReadonlySet<string> = new Set(
  OCPD_TYPE_SUGGESTIONS.filter((s) => /^[A-Za-z]$/.test(s)).map((s) => s.toLowerCase())
);

/** PLAN-W2 (B-138) — 2–4 spelled tokens, except a curve letter followed by a
 *  number: that is a letter and a rating ("B 6"), not a spelled code, and the
 *  token rule alone misses a single-digit rating. */
function isSpelledCodeList(tokens: readonly string[]): boolean {
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
 * Canonicalise a dictated, typed, imported or model-written OCPD type.
 *
 * Returns the normalised non-blank value, `''` for blank input, and `null` only
 * for a non-string, non-number input. It NEVER returns null for a non-blank
 * value and has no length rule — that is the whole of Decision 6 at this layer.
 */
export function canonicaliseOcpdType(raw: unknown): string | null {
  let source: string;
  if (typeof raw === 'string') source = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) source = String(raw);
  else return null;

  let v = source.replace(ANY_WHITESPACE, ' ').trim();
  if (v === '') return '';

  // Step 0 — trailing sentence punctuation, then a leading `type` / `curve`
  // word. Each strip applies ONLY when it leaves something: `type` stays
  // `type`, `.` stays `.`, `type.` becomes `type`. Normalisation never erases
  // a non-blank value.
  const unpunctuated = v.replace(/[.,?!]+$/, '').trim();
  if (unpunctuated !== '') v = unpunctuated;
  const unprefixed = v.replace(/^(?:type|curve)(?: +|$)/i, '').trim();
  if (unprefixed !== '') v = unprefixed;
  v = v.replace(/ +/g, ' ');

  // Step 1 — whole-value rewrites.
  const lower = v.toLowerCase();
  for (const rule of WHOLE_VALUE_RULES) {
    const m = lower.match(rule.re);
    if (m) return typeof rule.to === 'string' ? rule.to : rule.to(m);
  }

  let tokens = v.split(' ').map((t) => (t.toLowerCase() === 'plus' ? '+' : t));

  // Exactly ONE number word converts: alone (`one` → `1`), or as one token of a
  // spelled code (`m one` → `M1`). Prose keeps its words.
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

  // Step 2 — spelled code: 2–4 tokens, each at most 2 glyphs, none a word, and
  // not a curve letter followed by a rating (PLAN-W2, B-138).
  if (isSpelledCodeList(tokens)) {
    return tokens.join('').toUpperCase();
  }

  // Step 3 — a single token: a letter is upper-cased, a case-insensitive
  // suggestion takes the suggestion's spelling, anything else is verbatim.
  if (tokens.length === 1) {
    const t = tokens[0];
    if (/^[a-z]$/i.test(t)) return t.toUpperCase();
    const listed = OCPD_TYPE_SUGGESTIONS.find((s) => s.toLowerCase() === t.toLowerCase());
    return listed ?? t;
  }

  // More than one remaining token: joined by single spaces, as said.
  return tokens.join(' ');
}

/** A single remaining token that carries no type: the bare prefix word, or
 *  punctuation only. */
function isNoTypeSentinel(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === 'type' || lower === 'curve' || !/[a-z0-9]/i.test(token);
}

/**
 * The dialogue script's admission predicate (step 4). Exactly one remaining
 * token that is not a no-type sentinel is the value; anything else is a MISS,
 * and a miss is PLAN-A's first-miss handoff — the script never asks a
 * clarifying question for this slot.
 */
export function admitOcpdTypeForScript(raw: unknown): string | null {
  const c = canonicaliseOcpdType(raw);
  if (c == null || c === '') return null;
  if (c.includes(' ')) return null;
  if (isNoTypeSentinel(c)) return null;
  return c;
}

export type OcpdTypeAdvisory = 'unknown' | 'incompatible';

export interface OcpdTypeAdvisoryArgs {
  ocpdBsEn?: unknown;
  ocpdType?: unknown;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * The derived advisory for one circuit's (standard, type). Never persisted, so
 * pre-plan data is judged by the same rule as new data.
 *
 *   null           — blank type, `N/A`, or a listed type compatible with (or
 *                    not judgeable against) the standard.
 *   'unknown'      — the type is not on the suggestion list (any standard).
 *   'incompatible' — listed, but not in the compatibility row of the circuit's
 *                    canonical standard.
 */
export function ocpdTypeAdvisory(args: OcpdTypeAdvisoryArgs): OcpdTypeAdvisory | null {
  const type = str(args.ocpdType).trim();
  if (type === '') return null;
  const canonical = canonicaliseOcpdType(type);
  if (canonical == null || canonical === '') return null;
  if (canonical === 'N/A') return null;
  if (!OCPD_TYPE_SUGGESTIONS.includes(canonical)) return 'unknown';
  const standard = canonicaliseOcpdStandard(str(args.ocpdBsEn));
  if (standard == null) return null;
  const row = OCPD_TYPE_COMPATIBILITY[standard];
  if (!row) return null;
  return row.includes(canonical) ? null : 'incompatible';
}

/** The advisory's short text: the grid marker, and the phrase every spoken
 *  and printed form is built from. */
export function ocpdTypeAdvisoryText(args: OcpdTypeAdvisoryArgs): string | null {
  const advisory = ocpdTypeAdvisory(args);
  if (advisory === 'unknown') return 'not a type I know';
  if (advisory === 'incompatible') {
    const standard = canonicaliseOcpdStandard(str(args.ocpdBsEn));
    return `may not be right for ${standard}`;
  }
  return null;
}

/** The PDF preflight line. Never blocks generation; the PDF prints the
 *  recorded value unchanged. */
export function ocpdTypeWarningText(
  circuitRef: string,
  row: { ocpd_bs_en?: unknown; ocpd_type?: unknown }
): string | null {
  const args = { ocpdBsEn: row.ocpd_bs_en, ocpdType: row.ocpd_type };
  const advisory = ocpdTypeAdvisory(args);
  if (advisory == null) return null;
  const type = str(row.ocpd_type).trim();
  if (advisory === 'unknown') {
    return `Circuit ${circuitRef}: OCPD type ${type} is not a type I know — check it before issuing`;
  }
  return `Circuit ${circuitRef}: OCPD type ${type} ${ocpdTypeAdvisoryText(args)} — check it before issuing`;
}

/**
 * The display alias. Under BS 1361 a stored `1` / `2` displays `I` / `II` in
 * both PDFs and both pickers. Storage is never rewritten by an alias.
 */
export function ocpdTypeDisplay(ocpdBsEn: unknown, ocpdType: unknown): string {
  const stored = str(ocpdType);
  if (canonicaliseOcpdStandard(str(ocpdBsEn)) !== 'BS 1361') return stored;
  if (stored === '1') return 'I';
  if (stored === '2') return 'II';
  return stored;
}

/** True when the candidate and the stored value are the same type once both
 *  pass through the canonicaliser. The stored bytes are compared through the
 *  function but never rewritten by it. */
export function ocpdTypesCanonicallyEqual(candidate: unknown, stored: unknown): boolean {
  const s = str(stored).trim();
  if (s === '') return false;
  const a = canonicaliseOcpdType(candidate);
  const b = canonicaliseOcpdType(s);
  return a != null && a !== '' && a === b;
}

// ─────────────────────────────────────────────────────────────────────────
// Local-command sentences (web `applyUpdateField` / `applyApplyField`, iOS
// `setCircuitField` / `executeApplyField`). One renderer so both clients speak
// identical bytes; pinned by the manifest's `single_apply_vectors` and
// `bulk_apply_vectors`.
// ─────────────────────────────────────────────────────────────────────────

function numericRefs(refs: ReadonlyArray<number | string>): number[] | null {
  const out: number[] = [];
  for (const r of refs) {
    const n = typeof r === 'number' ? r : Number(String(r).trim());
    if (!Number.isInteger(n)) return null;
    out.push(n);
  }
  return out;
}

/** `4` · `2 and 3` · `1 to 4` (three or more contiguous) · `1, 3 and 5`. */
export function renderOcpdTypeRefList(refs: ReadonlyArray<number | string>): string {
  const nums = numericRefs(refs);
  const ordered: string[] = nums
    ? [...nums].sort((a, b) => a - b).map(String)
    : refs.map((r) => String(r));
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

function circuitsPhrase(refs: ReadonlyArray<number | string>): string {
  return `${refs.length === 1 ? 'circuit' : 'circuits'} ${renderOcpdTypeRefList(refs)}`;
}

export interface OcpdTypeWrittenTarget {
  circuit: number | string;
  ocpdBsEn: unknown;
}

/**
 * The advisory clause for a group of WRITTEN circuits sharing one type, or
 * `''`. `unknown` is standard-independent, so its clause carries no circuit
 * list. `incompatible` names only the circuits it applies to, grouped by
 * standard, groups ordered by their lowest circuit, "may not be right" once.
 */
export function buildOcpdTypeAdvisoryClause(
  type: string,
  written: ReadonlyArray<OcpdTypeWrittenTarget>
): string {
  const groups = new Map<string, Array<number | string>>();
  for (const w of written) {
    const advisory = ocpdTypeAdvisory({ ocpdBsEn: w.ocpdBsEn, ocpdType: type });
    if (advisory === 'unknown') return ' — not a type I know';
    if (advisory !== 'incompatible') continue;
    const standard = canonicaliseOcpdStandard(str(w.ocpdBsEn)) as string;
    const list = groups.get(standard) ?? [];
    list.push(w.circuit);
    groups.set(standard, list);
  }
  if (groups.size === 0) return '';
  const lowest = (refs: Array<number | string>): number => {
    const nums = numericRefs(refs);
    return nums ? Math.min(...nums) : Number.POSITIVE_INFINITY;
  };
  const ordered = [...groups.entries()].sort((a, b) => lowest(a[1]) - lowest(b[1]));
  const parts = ordered.map(([standard, refs]) => `for ${standard} on ${circuitsPhrase(refs)}`);
  return ` — may not be right ${parts.join(' and ')}`;
}

/** Single-circuit local write: `Set OCPD type to gG on circuit 4 — …`. */
export function buildOcpdTypeSingleResponse(
  type: string,
  circuit: number | string,
  ocpdBsEn: unknown
): string {
  const advisory = ocpdTypeAdvisoryText({ ocpdBsEn, ocpdType: type });
  return `Set OCPD type to ${type} on circuit ${circuit}${advisory ? ` — ${advisory}` : ''}.`;
}

/** The identical single-circuit re-apply: nothing written, no advisory. */
export function buildOcpdTypeDuplicateResponse(type: string, circuit: number | string): string {
  return `Already got that — type ${type} for circuit ${circuit}.`;
}

/**
 * Bulk local Apply's ONE outcome. Identical rows are neither rewritten nor
 * re-advised; the advisory clause is spoken at most once and names only the
 * WRITTEN circuits it applies to.
 */
export function buildOcpdTypeBulkResponse(args: {
  type: string;
  written: ReadonlyArray<OcpdTypeWrittenTarget>;
  unchanged: ReadonlyArray<number | string>;
  skipSuffix?: string;
}): string {
  const skip = args.skipSuffix ?? '';
  if (args.written.length === 0) {
    return `Already got type ${args.type} on ${circuitsPhrase(args.unchanged)}${skip}.`;
  }
  const head = `Type ${args.type} set on ${circuitsPhrase(args.written.map((w) => w.circuit))}`;
  const already =
    args.unchanged.length > 0 ? `; ${renderOcpdTypeRefList(args.unchanged)} already had it` : '';
  return `${head}${already}${skip}${buildOcpdTypeAdvisoryClause(args.type, args.written)}.`;
}
