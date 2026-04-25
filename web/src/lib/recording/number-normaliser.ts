/**
 * Normalises spoken-number and unit forms in Deepgram transcript text
 * before regex field matching or Sonnet extraction runs.
 *
 * Port of `CertMateUnified/Sources/Recording/NumberNormaliser.swift`
 * (R1 of `web/audit/REGEX_TIER_PLAN.md`). The Swift original carries a
 * year of voice-quality fixes; this TS port mirrors the *contract* —
 * the same input produces the same output for every case in the iOS
 * test corpus (`NumberNormaliserTests.swift`) and a few extra spoken-
 * form edge cases the regex authors flagged in plan review.
 *
 * Deliberate divergences from Swift:
 *
 * - `RemoteConfigService.shared.unitNormalisation` is iOS-only OTA-tunable
 *   config. v1 of the web port uses the bundled defaults map directly.
 *   If the inspector ever needs a runtime-tunable unit list, plumb it
 *   through `recording-context.tsx` and pass it as the second argument
 *   to `normalise(text, overrideUnitMap)`.
 *
 * - The Swift implementation pre-compiles each pattern at static init
 *   time to amortise NSRegularExpression instantiation cost across the
 *   ~30/min normalisation rate during recording. JavaScript engines
 *   inline-compile and cache regex literals automatically, so module-
 *   level `const RX = /.../` already gives equivalent behaviour without
 *   the manual cache.
 */

const DIGIT_WORDS: Record<string, string> = {
  naught: '0',
  nought: '0',
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const TEENS_MAP: Record<string, string> = {
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
};

const TENS_MAP: Record<string, string> = {
  twenty: '2',
  thirty: '3',
  forty: '4',
  fifty: '5',
  sixty: '6',
  seventy: '7',
  eighty: '8',
  ninety: '9',
};

const TENS_PLURAL_MAP: Record<string, string> = {
  twenties: '2',
  thirties: '3',
  forties: '4',
  fifties: '5',
  sixties: '6',
  seventies: '7',
  eighties: '8',
  nineties: '9',
};

// Spoken abbreviations — converted in order. Keep in sync with the iOS
// source array order; later entries can shadow earlier ones (`our c d`
// after `r c d` is harmless but the dependency on order matters for
// future additions).
const SPOKEN_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bzed\s+s(?:s|ess)?\b/gi, 'Zs'],
  [/\bzed\s+e\b/gi, 'Ze'],
  [/\bzed(?:dy|d?e(?:e)?)\b/gi, 'Ze'],
  [/\bp\s+f\s+c\b/gi, 'PFC'],
  [/\bm\s+c\s+b\b/gi, 'MCB'],
  [/\br\s+c\s+b\s+o\b/gi, 'RCBO'],
  [/\br\s+c\s+d\b/gi, 'RCD'],
  [/\ba\s+f\s+d\s+d\b/gi, 'AFDD'],
  [/\bour\s+c\s*d\b/gi, 'RCD'],
  [/\bc\s+p\s+c\b/gi, 'CPC'],
  [/\br\s+one\b/gi, 'R1'],
  [/\br\s+two\b/gi, 'R2'],
];

const DEFAULT_UNIT_NORMALISATION: Record<string, string> = {
  'meg ohms': 'MΩ',
  'mega ohms': 'MΩ',
  megohms: 'MΩ',
  'megger ohms': 'MΩ',
  grooms: 'MΩ',
  ohms: 'Ω',
  milliamps: 'mA',
  'milli amps': 'mA',
  milliseconds: 'ms',
  'milli seconds': 'ms',
  'mil squared': 'mm²',
  'mm squared': 'mm²',
  'millimeters squared': 'mm²',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  'kilo amps': 'kA',
  kiloamps: 'kA',
};

// Strip a stray spoken-zero word immediately before an already-numeric
// decimal value: "naught 0.14" → "0.14". Only fires when the captured
// number contains a decimal point — "Nought 88" (no point) is owned by
// IMPLIED_DECIMAL_PATTERN below. Includes "no" because Deepgram often
// transcribes "nought" as "no" before decimals.
const STRAY_DIGIT_WORD_PATTERN = /\b(?:naught|nought|zero|oh|no)\s+(?=\d+\.)/gi;

// Zero-word glued directly to digits without a separating space:
// "Nought0.87" → "0.87". Deepgram occasionally concatenates a spoken
// zero-word with the following numeric value.
const GLUED_DIGIT_WORD_PATTERN = /\b(naught|nought|zero|oh)(\d+\.?\d*)/gi;

// "Nought 88" → "0.88" — when a zero-word appears before a 2-3-digit
// integer without "point", the speaker most likely dropped "point"
// (common British speech pattern). Limited to zero-words + 2-3 digit
// numbers so generic phrases like "naught five" don't get rewritten as
// implied decimals (those go through DECIMAL_PATTERN with 'five').
const IMPLIED_DECIMAL_PATTERN = /\b(naught|nought|zero|oh)\s+(\d{2,3})\b/gi;

const DIGIT_WORD_GROUP = 'naught|nought|zero|oh|one|two|three|four|five|six|seven|eight|nine';

// "nought point two seven" → "0.27" — supports 1-4 fractional digit-words.
// iOS handles up to 3; the 4th group is a v1 web-only extension to cover
// 4-sig-fig insulation-resistance readings like "two point one two three
// four megohms" without dropping the trailing digit.
const DECIMAL_PATTERN = new RegExp(
  `\\b(${DIGIT_WORD_GROUP})\\s+point\\s+(${DIGIT_WORD_GROUP})(?:\\s+(${DIGIT_WORD_GROUP}))?(?:\\s+(${DIGIT_WORD_GROUP}))?(?:\\s+(${DIGIT_WORD_GROUP}))?\\b`,
  'gi'
);

// "point two seven" → "0.27" (implied leading zero). `\bpoint\b` instead
// of a `(?<=\s|^)point` lookbehind so this loads cleanly on iOS Safari
// pre-16.4 (which rejects lookbehind regexes at module-parse time and
// would crash recording-context entirely on field iPads still on
// older iPadOS — the PWA runs on inspector-supplied hardware).
const IMPLIED_ZERO_DECIMAL_PATTERN = new RegExp(
  `\\bpoint\\s+(${DIGIT_WORD_GROUP})(?:\\s+(${DIGIT_WORD_GROUP}))?\\b`,
  'gi'
);

const TENS_ONES_PATTERN =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi;

const TEENS_PATTERN =
  /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;

// Tens-plurals: "twenties" → "20". Common spoken shorthand for values
// like "RCD trip time is twenties" meaning 20ms.
const TENS_PLURAL_PATTERN =
  /\b(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/gi;

const STANDALONE_TENS_PATTERN = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;

const HUNDRED_PATTERN = /\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b/gi;

// "6 0 8 9 8" → "60898" — Deepgram outputs digit-by-digit when the
// speaker says each digit individually. Web-only divergence from iOS:
// require **three or more** spaced single digits before collapsing.
// iOS collapses any 2+ run, but on web that turns "circuit 1 6 amp"
// into "circuit 16 amp" — a real corruption path because Deepgram has
// been observed splitting "circuit one, six amp MCB" into separate
// digit tokens. Three-digit runs (which match real spoken postcodes /
// IR readings / Zs values) are vanishingly unlikely to appear by
// accident in a circuit-with-rating sentence, so this trade-off keeps
// the IR-style "two nine nine" → "299" fix while killing the
// circuit-vs-rating false-merge. Single-digit + spoken-unit phrases
// like "1 amp" are unaffected — `\b\d\s+\d\s+\d\b` requires three
// digits in a row.
const DIGIT_SEQUENCE_PATTERN = /\b\d(?:\s+\d){2,}\b/g;

// "point 60" → "0.60" — standalone "point" before already-numeric digits
// (common after digit-sequence collapse with readings like "Zs point six
// zero" → "Zs point 60"). Word-boundary form (no lookbehind) for older
// iOS Safari support — see DECIMAL_PATTERN comment for rationale.
const POINT_DIGIT_PATTERN = /\bpoint\s+(\d+)/gi;

// "Nought Point 0.87" → "0.87" — mixed zero-word + "point" + already-
// converted decimal. Must run before POINT_DIGIT_PATTERN to prevent
// "Point 0.87" → "0.0.87" downstream.
const SPOKEN_ZERO_POINT_NUMERIC_PATTERN = /\b(?:naught|nought|zero|oh)\s+point\s+(\d+\.?\d*)/gi;

/**
 * Normalise spoken numbers, abbreviations and units in transcript text.
 *
 * Idempotent: passing already-numeric input through the function returns
 * it unchanged. Safe to re-run on the same string (some recovery paths
 * do this when re-processing buffered transcript on reconnect).
 */
export function normalise(text: string): string {
  let result = text;

  // 0pre. Mixed spoken-zero + "point" + already-numeric: "Nought Point 0.87"
  // → "0.87". Must run before POINT_DIGIT_PATTERN (8b) so we don't
  // double-prefix the leading zero.
  result = result.replace(SPOKEN_ZERO_POINT_NUMERIC_PATTERN, (_match, digits: string) => {
    if (digits.includes('.')) return digits;
    return `0.${digits}`;
  });

  // 0a. Implied decimal: "Nought 88" → "0.88".
  result = result.replace(IMPLIED_DECIMAL_PATTERN, (_match, _word: string, digits: string) => {
    return `0.${digits}`;
  });

  // 0b. Strip stray digit-word before numeric-with-decimal:
  // "naught 0.14" → "0.14".
  result = result.replace(STRAY_DIGIT_WORD_PATTERN, '');

  // 0c. Zero-word glued to digits: "Nought0.87" → "0.87".
  result = result.replace(GLUED_DIGIT_WORD_PATTERN, (match, _word: string, digits: string) => {
    if (digits.includes('.')) return digits;
    if (digits.length >= 2 && digits.length <= 3) return `0.${digits}`;
    return match;
  });

  // 1. Spoken abbreviations (zed s → Zs, m c b → MCB, …).
  for (const [pattern, replacement] of SPOKEN_ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }

  // 2. Hundreds: "three hundred" → "300".
  result = result.replace(HUNDRED_PATTERN, (match, word: string) => {
    const digit = DIGIT_WORDS[word.toLowerCase()];
    if (!digit) return match;
    return `${digit}00`;
  });

  // 3. Spoken decimals: "nought point two seven" → "0.27" (1-4 fractional
  // digit-words supported — see DECIMAL_PATTERN comment for the 4-digit
  // extension above iOS).
  result = result.replace(
    DECIMAL_PATTERN,
    (
      match,
      whole: string | undefined,
      d1: string | undefined,
      d2: string | undefined,
      d3: string | undefined,
      d4: string | undefined
    ) => {
      const w = whole && DIGIT_WORDS[whole.toLowerCase()];
      const f1 = d1 && DIGIT_WORDS[d1.toLowerCase()];
      if (!w || !f1) return match;
      let decimal = `${w}.${f1}`;
      const f2 = d2 && DIGIT_WORDS[d2.toLowerCase()];
      const f3 = d3 && DIGIT_WORDS[d3.toLowerCase()];
      const f4 = d4 && DIGIT_WORDS[d4.toLowerCase()];
      if (f2) decimal += f2;
      if (f3) decimal += f3;
      if (f4) decimal += f4;
      return decimal;
    }
  );

  // 4. Implied zero decimal: "point two seven" → "0.27".
  result = result.replace(
    IMPLIED_ZERO_DECIMAL_PATTERN,
    (match, d1: string | undefined, d2: string | undefined) => {
      const f1 = d1 && DIGIT_WORDS[d1.toLowerCase()];
      if (!f1) return match;
      let decimal = `0.${f1}`;
      const f2 = d2 && DIGIT_WORDS[d2.toLowerCase()];
      if (f2) decimal += f2;
      return decimal;
    }
  );

  // 5. Tens + ones: "twenty one" → "21".
  result = result.replace(TENS_ONES_PATTERN, (match, tens: string, ones: string) => {
    const t = TENS_MAP[tens.toLowerCase()];
    const o = DIGIT_WORDS[ones.toLowerCase()];
    if (!t || !o) return match;
    return `${t}${o}`;
  });

  // 6. Teens: "thirteen" → "13".
  result = result.replace(TEENS_PATTERN, (match, word: string) => {
    return TEENS_MAP[word.toLowerCase()] ?? match;
  });

  // 7a. Tens-plurals: "twenties" → "20".
  result = result.replace(TENS_PLURAL_PATTERN, (match, word: string) => {
    const digit = TENS_PLURAL_MAP[word.toLowerCase()];
    if (!digit) return match;
    return `${digit}0`;
  });

  // 7b. Standalone tens: "twenty" → "20".
  result = result.replace(STANDALONE_TENS_PATTERN, (match, word: string) => {
    const digit = TENS_MAP[word.toLowerCase()];
    if (!digit) return match;
    return `${digit}0`;
  });

  // 8. Collapse single-digit sequences: "6 0 8 9 8" → "60898".
  result = result.replace(DIGIT_SEQUENCE_PATTERN, (match) => match.replace(/\s+/g, ''));

  // 8b. "point 60" → "0.60" — standalone "point" before now-collapsed digits.
  result = result.replace(POINT_DIGIT_PATTERN, (_match, digits: string) => `0.${digits}`);

  // 8c. Re-apply implied decimal AFTER digit collapse: "nought 34" → "0.34".
  // Step 0a runs before digit-words convert, so transcripts like "nought
  // three four" → "nought 3 4" → "nought 34" only become candidates here.
  result = result.replace(IMPLIED_DECIMAL_PATTERN, (_match, _word: string, digits: string) => {
    return `0.${digits}`;
  });

  // 9. Unit normalisation. Sort entries by spoken-form length descending
  // so longer phrases match before their substrings (e.g.
  // "millimeters squared" before "millimeters").
  const unitMap = DEFAULT_UNIT_NORMALISATION;
  const unitEntries = Object.entries(unitMap).sort(([a], [b]) => b.length - a.length);
  for (const [spoken, symbol] of unitEntries) {
    // Case-insensitive plain-string replace; escape the spoken form so
    // characters like `²` (none today) don't break the regex.
    const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), symbol);
  }

  return result;
}
