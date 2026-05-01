/**
 * Board-model -> technology lookup.
 *
 * The Stage 1 VLM classifier (`classifyBoardTechnology`) returns five fields
 * in one call: a fuzzy `board_technology` label AND precise `board_manufacturer`
 * + `board_model` strings read from the cover. When those two outputs
 * disagree — e.g. a Wylex NHRS12SL (high-integrity DIN-rail consumer unit)
 * labelled "mixed" — the model identification is the more reliable signal.
 *
 * This registry maps known modern (DIN-rail MCB/RCBO) consumer-unit model
 * prefixes to `technology: 'modern'` so the route handler can override a
 * misclassification before dispatching to the wrong per-slot pipeline.
 *
 * The override is one-way: model lookup can only force `modern`. It will
 * never downgrade a VLM-issued `modern` to anything else, and it will
 * never upgrade an unmatched model. This is conservative on purpose —
 * the worst the registry can do today is fail to override (status quo);
 * it must not introduce a new failure mode by forcing `modern` on a real
 * rewireable board.
 *
 * To extend: add a new entry to `MODERN_MODEL_PATTERNS`. Each entry has a
 * regex matched against the trimmed `board_model` string (case-insensitive
 * via the `i` flag) plus an `expectedManufacturer` substring used as a
 * sanity check (so a coincidental "VML…" model number under a non-Hager
 * brand doesn't match). Include a unit test in
 * `src/__tests__/board-model-registry.test.js` covering both a positive
 * model match and a manufacturer-mismatch rejection.
 */

const MODERN_MODEL_PATTERNS = [
  // Wylex NH series — high-integrity / standard-integrity DIN-rail consumer
  // units (the user's repro photo on 2026-05-01 was an NHRS12SL).  Wylex's
  // older J/K/REW pull-out fuse boards do NOT start with "NH", so this
  // prefix is unambiguously modern.
  {
    pattern: /^NH(?:RS|RSL|SB|B|C|D|M)\d/i,
    expectedManufacturer: 'wylex',
    series: 'Wylex NH (high-/std-integrity DIN-rail)',
  },
  // Wylex AMR Amendment-3 metalclad consumer units.
  {
    pattern: /^AMR\d/i,
    expectedManufacturer: 'wylex',
    series: 'Wylex AMR (Amendment 3 metalclad)',
  },
  // Hager Design 10 / Design 30 consumer units.
  {
    pattern: /^V[MC][LR]\d/i,
    expectedManufacturer: 'hager',
    series: 'Hager Design 10/30 (VML/VCL/VMR)',
  },
  // Schneider Easy9 family (LN5* split-load, EZ9 series).
  {
    pattern: /^(?:EZ9|LN\d|SEA)\d*/i,
    expectedManufacturer: 'schneider',
    series: 'Schneider Easy9',
  },
  // BG Fortress / BG Nexus consumer units.
  {
    pattern: /^CU(?:CRB|FLD|FRC|MCBO)\d/i,
    expectedManufacturer: 'bg',
    series: 'BG Fortress',
  },
  // MK Sentry consumer units (KQ30 / K30 / K* series).
  {
    pattern: /^(?:KQ?\d+RAS?|KMS\d|K\d+RAS?)/i,
    expectedManufacturer: 'mk',
    series: 'MK Sentry',
  },
  // Eaton Memshield 3 consumer units.
  {
    pattern: /^M(?:BO|MC|HCR)\d/i,
    expectedManufacturer: 'eaton',
    series: 'Eaton Memshield 3',
  },
  // Contactum Defender consumer units.
  {
    pattern: /^CPCNR\d?/i,
    expectedManufacturer: 'contactum',
    series: 'Contactum Defender',
  },
];

/**
 * Normalise a manufacturer string for matching: lowercase, strip
 * descriptive suffixes ("Electric", "Electrical", "Limited", "Ltd"),
 * collapse whitespace.  "Schneider Electric" -> "schneider".
 *
 * @param {string|null|undefined} manufacturer
 * @returns {string} lower-case manufacturer keyword, or empty string
 */
function normaliseManufacturer(manufacturer) {
  if (typeof manufacturer !== 'string') return '';
  return manufacturer
    .toLowerCase()
    .replace(/\b(?:electric(?:al)?|limited|ltd|plc|inc)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Look up a board model against the modern-board registry.
 *
 * @param {object} args
 * @param {string|null|undefined} args.boardModel — model string from classifier
 * @param {string|null|undefined} args.boardManufacturer — manufacturer string from classifier
 * @returns {null | { technology: 'modern', series: string, matchedPattern: string, expectedManufacturer: string, manufacturerMatched: boolean }}
 *
 * Returns null when:
 *   - boardModel is null/empty (nothing to match)
 *   - no pattern matches the trimmed model string
 *   - a pattern matches but the expectedManufacturer disagrees with a
 *     non-null boardManufacturer (manufacturer collision -> bail)
 *
 * Returns { technology: 'modern', ... } when a pattern matches AND either:
 *   - boardManufacturer is null/empty (trust the model match alone), OR
 *   - boardManufacturer's normalised form contains the expectedManufacturer
 */
export function inferTechnologyFromModel({ boardModel, boardManufacturer } = {}) {
  if (typeof boardModel !== 'string') return null;
  const trimmedModel = boardModel.trim();
  if (!trimmedModel) return null;

  const normManufacturer = normaliseManufacturer(boardManufacturer);

  for (const entry of MODERN_MODEL_PATTERNS) {
    if (!entry.pattern.test(trimmedModel)) continue;

    // If we have a manufacturer string, require it to match the entry's
    // expectedManufacturer.  When manufacturer is unreadable (null/empty)
    // we trust the model code alone — model strings like "NHRS12SL" are
    // distinctive enough on their own.
    let manufacturerMatched = true;
    if (normManufacturer) {
      manufacturerMatched = normManufacturer.includes(entry.expectedManufacturer);
      if (!manufacturerMatched) return null;
    }

    return {
      technology: 'modern',
      series: entry.series,
      matchedPattern: entry.pattern.source,
      expectedManufacturer: entry.expectedManufacturer,
      manufacturerMatched,
    };
  }

  return null;
}

// Re-exported for tests so the corpus of supported series can be walked
// without parsing the regex source strings out of the patterns array.
export const _MODERN_MODEL_PATTERNS_FOR_TESTS = MODERN_MODEL_PATTERNS;
