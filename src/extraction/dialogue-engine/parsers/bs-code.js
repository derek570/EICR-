/**
 * BS/EN device-standard parsers — PLAN-CS (feedback-2026-09-17 wave).
 *
 * WHY THIS CHANGED
 * ----------------
 * `ocpd_bs_en` was a closed enum of eight options, and this module's old
 * `parseBsCode` returned only those eight. Inspectors read whatever is printed
 * on the device, and on September 17 (session CC9E0915) the printed standard
 * was `BS 3871`: the model's write was rejected twice and it fell back to `""`.
 * Decision 4 makes the field free text with suggestions. The clients were made
 * free-text-tolerant first (PLAN-CC); this is the backend half.
 *
 * TWO PARSERS, EACH BOUND TO ITS OWN SLOTS
 * ----------------------------------------
 * - `parseOcpdStandard` — every `ocpd_bs_en` boundary. ANY grammar-valid
 *   standard is accepted and canonicalised; anything else is a miss (`null`).
 * - `parseRcdBsCode` — every `rcd_bs_en` boundary. `rcd_bs_en` stays a closed
 *   `select`: the value is canonicalised with the same algorithm and must then
 *   be one of the schema's options, the `""` sentinel excluded (accepting it
 *   would be a silent clear — PLAN-C3).
 *
 * Neither takes a field argument: `helpers/extraction.js` calls
 * `slot.parser(captured)` with no context, so each parser is bound to its slot
 * in the schema files instead.
 *
 * NO FUZZY MATCHING (HARD RULE)
 * -----------------------------
 * The Levenshtein-1 fallback that used to live here is gone. It turned a
 * dropped digit into a DIFFERENT real standard with nobody told. Under
 * Decision 7 a value the deterministic path cannot read is a miss, and a miss
 * hands the turn to the model. Every step below is a fixed rewrite of a
 * documented Flux form or a closed alias snap.
 *
 * ONE ALGORITHM, THREE IMPLEMENTATIONS
 * ------------------------------------
 * `parseOcpdStandard` is a line-for-line port of PLAN-CC's
 * `canonicaliseOcpdStandard` (`packages/shared-utils/src/ocpd-standard.ts`;
 * its Swift twin is `CertMateUnified/Sources/Utilities/OcpdStandard.swift`).
 * The backend cannot import the TypeScript: `@certmate/shared-utils` publishes
 * raw `.ts` and the backend runs plain Node ESM (see `impedance-clamp.js` for
 * the same constraint). `config/ocpd-bs-suggestions.json` is the NORMATIVE
 * contract: `dialogue-engine-bs-code-parser.test.js` drives every accepted and
 * rejected vector in it through this function and compares the returned bytes,
 * exactly as the web and iOS suites do. If this code and the manifest ever
 * disagree, the manifest wins and this code is the defect.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../../../../config/ocpd-bs-suggestions.json');
const fieldSchema = require('../../../../config/field_schema.json');

/**
 * The curated suggestion tiers, read from the shared manifest — never a second
 * copy. Tier 1 is rendered into the agentic prompt's OCPD block; both tiers are
 * asserted identical to `field_schema.json`'s `suggestions` /
 * `suggestions_extended` by `ocpd-bs-suggestions.test.js`. They are OFFERED,
 * never enforced: the field accepts any grammar-valid standard.
 */
export const OCPD_STANDARD_TIER1 = Object.freeze([...manifest.tier1]);
export const OCPD_STANDARD_TIER2 = Object.freeze([...manifest.tier2]);

/**
 * Step 9 alias table, keyed by the ASSEMBLED step-8 output. Verbatim from the
 * TypeScript twin. Only `-1` on 60898 / 61009 / 3871 is a version suffix; every
 * other `-N` is a standard PART and stays distinct. `60909` is Deepgram's
 * misheard-digit rendering of `61009` and is not a device standard of its own.
 */
const OCPD_STANDARD_ALIASES = Object.freeze({
  'BS EN 60898-1': 'BS EN 60898',
  'BS EN 61009-1': 'BS EN 61009',
  'BS EN 60909': 'BS EN 61009',
  'BS 3871-1': 'BS 3871',
});

/** Spoken "not applicable" forms; each canonicalises to `N/A` (step 10). */
const NA_PHRASES = new Set(['n/a', 'na', 'n a', 'n.a', 'n.a.', 'not applicable']);

/**
 * Every whitespace character any twin will see, written out. NOT `\s`:
 * JavaScript's `\s` and ICU's (Swift's `NSRegularExpression`) are different
 * sets, and a non-breaking space pasted from a PDF would then trim on one
 * platform and miss on another.
 */
const WHITESPACE_CLASS =
  '\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
const ANY_WHITESPACE = new RegExp(`[${WHITESPACE_CLASS}]`, 'g');

/** Edge punctuation and quotes only; internal `/`, `-` and `+` survive. */
const EDGE_PUNCTUATION = /^[ "'“”‘’.,!?;:]+|[ "'“”‘’.,!?;:]+$/g;

/**
 * Step 7 whole-value capture grammar. Anchored, and `[0-9]` rather than `\d`
 * so fullwidth digits miss on every platform (ICU's `\d` would accept them).
 */
const CAPTURE_GRAMMAR = /^(?:bs)? ?(en)? ?([0-9]{2,5})(?:-([0-9]{1,2}))?(?:-([0-9]))?$/;

/**
 * Canonicalise a dictated, typed or model-written OCPD standard.
 *
 * Returns the canonical string, or `null` for a MISS. The input must be the
 * ISOLATED value — a slot answer, a named-extraction token or a tool argument —
 * never a whole annotated transcript: the grammar is anchored.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseOcpdStandard(raw) {
  let source;
  if (typeof raw === 'string') source = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) source = String(raw);
  else return null;

  // Step 0 — every whitespace character becomes a plain space.
  const spaced = source.replace(ANY_WHITESPACE, ' ');

  // Step 10 — `N/A` short-circuits before step 1.
  const trimmed = spaced.replace(EDGE_PUNCTUATION, '');
  if (trimmed === '') return null;
  if (NA_PHRASES.has(trimmed.toLowerCase())) return 'N/A';

  // Step 1 — lower-case for MATCHING only; output is assembled from captures.
  let v = trimmed.toLowerCase();

  // Step 2 — letter-split standard words (`a b s` drops Flux's leading `a`).
  v = v.replace(/\ba\.? +b\.? *s\.?(?![a-z])/g, 'bs');
  v = v.replace(/\bb\.? +s\.?(?![a-z])/g, 'bs');
  v = v.replace(/\be\.? +n\.?(?![a-z])/g, 'en');

  // Step 3 — spoken `dash` / `hyphen` between digit groups → `-`.
  let previous;
  do {
    previous = v;
    v = v.replace(/([0-9]) *(?:dash|hyphen) *([0-9])/g, '$1-$2');
  } while (v !== previous);

  // Step 4 — zero-words inside a digit run → digits (`6 zero 8 9 8` → `60898`).
  v = v.replace(/\b[0-9]+(?: +(?:[0-9]+|zero|oh|nought|naught))+\b/g, (m) =>
    m
      .split(/\s+/)
      .map((tok) =>
        tok === 'zero' || tok === 'oh' || tok === 'nought' || tok === 'naught' ? '0' : tok
      )
      .join('')
  );

  // Step 5 — collapse whitespace runs to one space.
  v = v.replace(/ +/g, ' ').trim();

  // Step 6 — remove spaces around hyphens (`12345 - 12 - 3` → `12345-12-3`).
  v = v.replace(/ *- */g, '-');

  // Step 7 — capture grammar.
  const m = CAPTURE_GRAMMAR.exec(v);
  if (!m) return null;
  const hasEn = m[1] != null;
  const digits = m[2];
  const part1 = m[3];
  const part2 = m[4];

  // Step 8a — a two-digit capture with no `-N` suffix is a MISS whatever the
  // prefix (`88`, `bs 88`, `bs en 88`). `88` alone cannot say which of
  // BS 88-1 / 88-2 / 88-3 / 88-6 is printed on the device, and those are
  // distinct standards the certificate records as read. The ground is record
  // accuracy, never a max-Zs computation: the max-Zs lookup treats the BS 88
  // parts as one fuse family either way.
  if (digits.length === 2 && part1 == null) return null;

  // Step 8 — assemble from captures only. A bare number takes `BS EN ` when it
  // is five digits starting `6` (IEC-derived) and `BS ` otherwise.
  const en = hasEn || (digits.length === 5 && digits.startsWith('6'));
  let assembled = `BS${en ? ' EN' : ''} ${digits}`;
  if (part1 != null) assembled += `-${part1}`;
  if (part2 != null) assembled += `-${part2}`;

  // Step 9 — alias snap on the ASSEMBLED value.
  return OCPD_STANDARD_ALIASES[assembled] ?? assembled;
}

/**
 * The ONE shape predicate for `ocpd_bs_en` outside the dialogue engine — the
 * dispatcher's `ocpd_standard_shape` gate, the bulk validator, the speculator's
 * pre-synth gate and the parser-backed validation descriptor all call this, so
 * none of them can drift from the others.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function ocpdStandardShapeAccepts(value) {
  return parseOcpdStandard(value) !== null;
}

/** What an `ocpd_standard_shape` rejection tells the model it may write. */
export const OCPD_STANDARD_ACCEPTED_FORMS =
  'a BS or BS EN standard number as printed on the device (for example BS EN 60898, BS 3871, BS 88-2, BS EN 60947-4-1), or N/A';

/**
 * The named extractor for the two BS slots that keep one — `ocpd.js`'s
 * `ocpd_bs_en` and `rcd.js`'s `rcd_bs_en`. The RCBO schema declares NONE
 * (PLAN-CS, CS-100): one generic pattern on both RCBO BS slots matched the
 * same stretch of speech for both, so an answer to the RCD question also
 * overwrote the OCPD standard.
 *
 * Group 1 is the WHOLE standard token — the `BS` / `BS EN` prefix (Flux's
 * letter-split `a b s` / `b s e n` forms included) plus up to five digits and
 * the full two-suffix grammar — so the anchored parser sees exactly what was
 * said. The right boundary stops a longer number, a dangling hyphen, a trailing
 * letter (`BS EN 60898A`), a slash continuation (`BS EN 60898/1`) or a
 * digit-bearing dot or comma (`60947-4-1.2`) being cut into a shorter,
 * different standard: the token is consumed whole or not at all. Sentence
 * punctuation after it (`BS 3036.` / `BS EN 60898, 32 amps`) still matches. Not global: `extractNamedFieldValues`
 * reads capture groups through `String.prototype.match`, which returns none
 * for a `/g` regex.
 */
export const BS_STANDARD_NAMED_EXTRACTOR =
  /\b((?:a\.?\s+)?b\.?\s*s\.?(?:\s+e\.?\s+n\.?|\s*EN)?\s*\d{2,5}(?:\s*-\s*\d{1,2})?(?:\s*-\s*\d)?)(?![A-Za-z0-9\-/]|[.,]\d)/i;

/** One digit, or one spoken digit word, as a regex source fragment. */
const DIGIT_TOKEN = String.raw`(?:\d|\b(?:zero|oh|nought|one|two|three|four|five|six|seven|eight|nine)\b)`;

/**
 * DETECTION ONLY — does the utterance mention a BS standard at all? Much
 * broader than the extractor above: `BS` (or Flux's letter-split `b s`)
 * followed, within the same sentence and 40 characters, by a digit or a
 * spoken digit word — so "the RCD BS code is 61009", "the BS code for the RCD
 * is 61009" and "BS 6 1 zero zero 9" all count. It needs TWO adjacent digit
 * tokens, because every device standard has at least two digits: a circuit
 * designated "BS 3" is not a stated standard (EP cycle 3, c4-1).
 * It is never used to WRITE anything and never decides which field a number
 * belongs to; a schema uses it to notice that a standard was said and not
 * consumed, so the turn can go to the model (Decision 7). Deliberately
 * permissive on the digits (`BS 123456`, `BS EN 60898A` still count as a
 * mention): a missed detection is a silent drop, an extra one is one model
 * turn. Not global.
 */
export const BS_STANDARD_MENTION_PATTERN = new RegExp(
  String.raw`\b(?:a\.?\s+)?b\.?\s*s\.?\b(?=[^.?!]{0,40}?${DIGIT_TOKEN}\s*-?\s*${DIGIT_TOKEN})`,
  'i'
);

/**
 * `rcd_bs_en`'s closed option list, the `""` sentinel EXCLUDED. `rcd_bs_en`
 * stays a `select` field, so the dispatcher's enum gate still covers the model
 * path; this set is what every dialogue boundary checks against.
 */
const RCD_BS_OPTIONS = new Set(
  (fieldSchema.circuit_fields?.rcd_bs_en?.options ?? []).filter(
    (o) => typeof o === 'string' && o !== ''
  )
);

/**
 * Strict RCD standard parser: canonicalise with the OCPD algorithm, then accept
 * only a member of `rcd_bs_en`'s option list. Legacy stored forms canonicalise
 * into the list (`61009-1`, `BS EN 61009-1`, `61009` → `BS EN 61009`), so a
 * healthy legacy value is never re-asked; an OCPD-only standard such as
 * `BS 3036` or `BS EN 60898` is refused, which the old shared parser did not.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseRcdBsCode(raw) {
  const canonical = parseOcpdStandard(raw);
  return canonical !== null && RCD_BS_OPTIONS.has(canonical) ? canonical : null;
}

/**
 * Numeric suffix only — used by the derivation matcher to decide whether a
 * written BS value indicates an RCBO (61009) or a legacy fuse (3036 / 1361).
 *
 *   "BS EN 61009"  → "61009"
 *   "BS 3036"      → "3036"
 *   anything else  → null
 */
export function bsCodeDigits(canonical) {
  if (typeof canonical !== 'string') return null;
  const m = canonical.match(/(\d{4,5}(?:-\d)?)/);
  return m ? m[1] : null;
}
