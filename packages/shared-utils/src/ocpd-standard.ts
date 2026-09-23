/**
 * PLAN-CC (feedback-2026-09-17 wave) — `ocpd_bs_en` free-text canonicalisation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ocpd_bs_en` used to be a closed enum on both clients: eight schema options,
 * and anything else drew a re-ask. Inspectors read whatever is printed on the
 * device, and the printed standard is often not one of the eight — `BS 3871`,
 * `BS 88-6`, `BS EN 60947-4-1`, `BS 1362`. The closed list made those
 * undictatable and unselectable, so the certificate recorded either nothing or
 * the wrong device standard.
 *
 * This module makes the field tolerant of ANY grammar-valid standard while
 * still canonicalising the forms Deepgram Flux actually produces. The clients
 * canonicalise at every local boundary; PLAN-CS gives the backend the same
 * algorithm as `parseOcpdStandard`.
 *
 * NOT FUZZY MATCHING
 * ------------------
 * Every step below is a fixed, deterministic rewrite of a documented Flux form
 * (letter-splitting, spoken `dash`, zero-words) or a closed alias snap against
 * the canonical device-standard list. There is no edit-distance and no
 * similarity scoring: the project's HARD RULE against fuzzy garble correction
 * (changelog 2026-07-03, WS4) is untouched. Step 9's alias table is the same
 * sanctioned class as the existing Levenshtein-free BS-code alias rows in
 * `src/extraction/dialogue-engine/parsers/bs-code.js` — do not remove it on a
 * "this looks fuzzy" reading.
 *
 * NORMATIVE SOURCE
 * ----------------
 * `config/ocpd-bs-suggestions.json` is the contract. Its
 * `accepted_value_vectors` / `rejected_value_vectors` ARE the canonical
 * mapping, and `web/tests/ocpd-standard.test.ts` drives every one of them
 * through this module and compares returned bytes. The Swift twin
 * (`Sources/Utilities/OcpdStandard.swift`) is driven through the same vectors
 * from a byte-identical copy of that file. If this code and the manifest ever
 * disagree, the manifest wins and this code is the defect.
 */

/** Longest output the grammar can assemble: `BS EN 12345-12-3`. A property of
 *  the grammar, not a rule any boundary enforces — the only length rule in the
 *  plan is the picker control's 24-character cap (`OCPD_STANDARD_INPUT_CAP`). */
export const OCPD_STANDARD_MAX_GRAMMAR_OUTPUT = 16;

/** Picker-control cap. The control refuses a 25th character without changing
 *  the stored value; no other boundary has a length rule. Mirrors the
 *  manifest's `cap`. */
export const OCPD_STANDARD_INPUT_CAP = 24;

/**
 * Step 9 alias table, keyed by the ASSEMBLED step-8 output.
 *
 * Only `-1` on 60898 / 61009 / 3871 is a version suffix; every other `-N` is a
 * standard PART and stays distinct. `BS EN 60909` is the Deepgram
 * misheard-digit variant of `61009` and is NOT a device standard of its own —
 * both clients already map `60909` → RCBO from the same capture, so without
 * this row one utterance would write a device type and a standard that
 * contradict each other.
 */
const OCPD_STANDARD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'BS EN 60898-1': 'BS EN 60898',
  'BS EN 61009-1': 'BS EN 61009',
  'BS EN 60909': 'BS EN 61009',
  'BS 3871-1': 'BS 3871',
});

/** Spoken "not applicable" forms. `ocpd_bs_en` carried `N/A` as a schema
 *  option and the retiring closed-enum guard accepted these spellings; the
 *  field must not LOSE that acceptance by becoming free text. `N/A` itself is
 *  returned unchanged (step 10); the other spellings canonicalise to it. */
const NA_PHRASES: ReadonlySet<string> = new Set([
  'n/a',
  'na',
  'n a',
  'n.a',
  'n.a.',
  'not applicable',
]);

/** Edge punctuation and quote characters only. Internal `/`, `-` and `+` are
 *  preserved so `N/A` and `BS 88-2` survive — the exact characters a naive
 *  `replace(/\W/g)` would eat. Same rule as `cleanClosedEnumResidue`. */
const EDGE_PUNCTUATION = /^[\s"'“”‘’.,!?;:]+|[\s"'“”‘’.,!?;:]+$/g;

/** Step 7 capture grammar, run on the whole normalised value. Anchored: the
 *  value is already isolated, so an unanchored match would silently swallow
 *  trailing words. */
const CAPTURE_GRAMMAR = /^(?:bs)?\s?(en)?\s?(\d{2,5})(?:-(\d{1,2}))?(?:-(\d))?$/;

/**
 * Canonicalise a dictated or typed OCPD standard.
 *
 * Returns the canonical string, or `null` for a MISS. A miss is the caller's
 * signal to re-ask at an interactive boundary, or to store the value as-is
 * with the compatibility row marker at an automatic one (see the plan's
 * standard-write boundary table) — it is never a silent drop.
 */
export function canonicaliseOcpdStandard(raw: unknown): string | null {
  let source: string;
  if (typeof raw === 'string') source = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) source = String(raw);
  else return null;

  // Step 10 — `N/A` short-circuits before step 1 and is returned unchanged.
  const trimmed = source.replace(EDGE_PUNCTUATION, '');
  if (trimmed === '') return null;
  if (NA_PHRASES.has(trimmed.toLowerCase())) return 'N/A';

  // Step 1 — edge trim done above; lower-case for MATCHING only. The output is
  // assembled from captures, never from the input's own casing.
  let v = trimmed.toLowerCase();

  // Step 2 — letter-split standard words. `a b s` drops its leading `a` (Flux's
  // rendering of the letter sequence, as `bs-code.js:76` does today).
  v = v.replace(/\ba\.?\s+b\.?\s*s\.?(?![a-z])/g, 'bs');
  v = v.replace(/\bb\.?\s+s\.?(?![a-z])/g, 'bs');
  v = v.replace(/\be\.?\s+n\.?(?![a-z])/g, 'en');

  // Step 3 — spoken `dash` / `hyphen` between digit groups → `-`. Looped rather
  // than lookbehind so the Swift twin and older Safari behave identically on
  // `12345 dash 12 dash 3`.
  let previous: string;
  do {
    previous = v;
    v = v.replace(/(\d)\s*(?:dash|hyphen)\s*(\d)/g, '$1-$2');
  } while (v !== previous);

  // Step 4 — zero-words inside a digit run → digits (`6 zero 8 9 8` → `60898`).
  v = v.replace(/\b\d+(?:\s+(?:\d+|zero|oh|nought|naught))+\b/g, (m) =>
    m
      .split(/\s+/)
      .map((tok) =>
        tok === 'zero' || tok === 'oh' || tok === 'nought' || tok === 'naught' ? '0' : tok
      )
      .join('')
  );

  // Step 5 — collapse whitespace runs to one space.
  v = v.replace(/\s+/g, ' ').trim();

  // Step 6 — remove spaces around hyphens (`12345 - 12 - 3` → `12345-12-3`).
  v = v.replace(/\s*-\s*/g, '-');

  // Step 7 — capture grammar.
  const m = CAPTURE_GRAMMAR.exec(v);
  if (!m) return null;
  const hasEn = m[1] != null;
  const digits = m[2];
  const part1 = m[3];
  const part2 = m[4];

  // Step 8a — a two-digit capture with no `-N` suffix is a MISS whatever the
  // prefix (`88`, `bs 88`, `bs en 88`). No device standard in either suggestion
  // tier is a bare two-digit number, and `88` alone cannot say which of
  // BS 88-1 / 88-2 / 88-3 / 88-6 was read off the device — four distinct
  // canonical standards the certificate must record as dictated. A NARROW
  // exclusion by shape (digit count + suffix absence), not a blocklist:
  // `88-2` is untouched.
  if (digits.length === 2 && part1 == null) return null;

  // Step 8 — assemble from captures only. A bare number (no `en` captured)
  // takes the `BS EN ` branch when it is five digits starting `6` (IEC-derived)
  // and `BS ` otherwise.
  const en = hasEn || (digits.length === 5 && digits.startsWith('6'));
  let assembled = `BS${en ? ' EN' : ''} ${digits}`;
  if (part1 != null) assembled += `-${part1}`;
  if (part2 != null) assembled += `-${part2}`;

  // Step 9 — alias snap on the ASSEMBLED value. Load-bearing for `60909`: step
  // 8 assembles `BS EN 60909`, and this is the only step that turns it into the
  // standard the inspector actually named.
  return OCPD_STANDARD_ALIASES[assembled] ?? assembled;
}

/** True when the value is already exactly what `canonicaliseOcpdStandard`
 *  would return for it — used by the picker commit path to decide whether a
 *  commit changes the stored value. */
export function isCanonicalOcpdStandard(value: string): boolean {
  return canonicaliseOcpdStandard(value) === value;
}

/**
 * The AUTOMATIC-boundary rule, in one place: canonicalise what the algorithm
 * can read, and store everything else exactly as it arrived.
 *
 * Imports and server applies have nobody to re-ask, so a miss must never drop
 * the value — the row wears the compatibility marker instead and the inspector
 * decides. This is the standard-write boundary table's "preserved as-is, row
 * marker" column, and it is deliberately NOT what an interactive boundary
 * does: a dictated miss re-asks, because there IS someone to ask.
 */
export function canonicaliseOcpdStandardForImport(value: string): string {
  return canonicaliseOcpdStandard(value) ?? value;
}
