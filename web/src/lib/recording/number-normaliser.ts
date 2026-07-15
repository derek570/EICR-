/**
 * NumberNormaliser — TypeScript port of
 * `CertMateUnified/Sources/Recording/NumberNormaliser.swift` (594 lines, 21
 * ordered normalisation steps).
 *
 * Normalises spoken number / unit / abbreviation forms in Deepgram transcript
 * text BEFORE TranscriptFieldMatcher runs. Mirrors the iOS pipeline so the
 * PWA and iOS clients see identical normalised text reaching the matcher,
 * the dialogue engine, and Sonnet.
 *
 * **Step ordering is load-bearing.** Each comment marker (0pre0, 0pre0b, …,
 * 8e, 9) matches the Swift source. Reordering reproduces dated production
 * incidents — see the Swift commit history (sessions 9FC3A6F1 2026-04-30,
 * A354882B 2026-04-28, F456A97C 2026-04-27, B200FF05 2026-04-28, CA335528
 * 2026-04-27) for the bugs the ordering pins.
 *
 * **Swift→TS port mechanics** (codex review findings A1–A3):
 *   - Inline `(?i)` ICU modifiers stripped — JS `RegExp` doesn't support
 *     them. The `i` flag goes on the `RegExp` constructor / literal flag set.
 *   - Every pattern that's used with `String.replace` carries `g` so all
 *     matches fire (Swift's `matches(in:range:)` is global by default).
 *   - All regexes pre-compiled once at module load — mirrors the
 *     `compiledSpokenAbbreviations` pattern from Swift commit 7f1d2a9.
 *   - Swift's reverse-iterate-to-preserve-indices helper is unnecessary in
 *     JS — `String.replace(regex, fn)` runs left-to-right with stable
 *     callback indices and the regex re-walks the modified string only at
 *     the engine's discretion (no overlap risk for the 21 patterns here).
 *
 * **Lookbehind support floor.** Step 8d uses a negative lookbehind. Safari
 * 16.0–16.3 throws on construction; 16.4+ supports it. The PWA's stated
 * support floor for the regex-hints feature is Safari 16.4+. The matcher
 * caller (TranscriptFieldMatcher) wraps construction in try/catch — if any
 * RegExp here throws at module load, the matcher caller logs once and
 * degrades to the no-regex-hints path. See PLAN risks #2.
 */

// MARK: — Digit Word Maps

const DIGIT_WORDS: Record<string, string> = {
  naught: '0',
  nought: '0',
  zero: '0',
  oh: '0',
  nil: '0',
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

// MARK: — Spoken Abbreviations (step 1)

const SPOKEN_ABBREVIATIONS: Array<readonly [RegExp, string]> = [
  [/\bzed\s+s(?:s|ess)?\b/gi, 'Zs'],
  [/\bzed\s+e\b/gi, 'Ze'],
  [/\bzed(?:dy|d?e(?:e)?)\b/gi, 'Ze'],
  // field-feedback-2026-07-14 F10: "Zedi" garble of "Ze". This table feeds
  // the BACKEND-facing normalised text (recording-context sends
  // normalise(text)), so without this entry the server still receives raw
  // "zedi" and recovery depends on the prompt alone. iOS canon:
  // NumberNormaliser.swift spokenAbbreviations (commit 67ffb9d).
  [/\bzedi\b/gi, 'Ze'],
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

// MARK: — Default Unit Normalisation (step 9)

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

// MARK: — Pre-compiled Patterns

/** 0pre0. Flux's "circuit"→"second" mishearing. Rewrites bare "second" →
 *  "circuit". MUST run first so downstream passes see the rewritten text.
 *  See Swift line 131 docblock for the trade-off rationale (session 9FC3A6F1
 *  2026-04-30: 6+ instances in 207 seconds). */
const MISHEARED_CIRCUIT_PATTERN = /\bsecond\b/gi;

/** 0pre0b. Flux letter-splitting "a b s [e n]" → "BS" / "BS EN". The trailing
 *  negative lookahead `(?![a-z])` instead of `\b` is required because `\b`
 *  between a final `.` and whitespace doesn't match (both non-word) and
 *  would leave a stranded period after replacement. See Swift line 155. */
const SPELLED_BS_PATTERN = /\ba\.?\s+b\.?\s+s\.?(?:\s+e\.?\s+n\.?)?(?![a-z])/gi;

/** 0pre. Mixed spoken zero + "point" + already-numeric: "Nought Point 0.87"
 *  → "0.87". Must run before any other pattern to prevent step 8b
 *  (`pointDigitPattern`) from converting "Point 0.87" → "0.0.87". */
const SPOKEN_ZERO_POINT_NUMERIC_PATTERN = /\b(?:naught|nought|zero|oh)\s+point\s+(\d+\.?\d*)/gi;

/** 0a. Implied decimal "Nought 88" → "0.88" — speaker dropped "point". */
const IMPLIED_DECIMAL_PATTERN = /\b(naught|nought|zero|oh|nil)\s+(\d{2,3})\b/gi;

/** 0b. Strip stray digit-words before numerics with decimal: "naught 0.14"
 *  → "0.14". "no" / "nil" included — Deepgram regularly mishears "naught"
 *  as those forms (session B200FF05 2026-04-28). */
const STRAY_DIGIT_WORD_PATTERN = /\b(?:naught|nought|zero|oh|no|nil)\s+(?=\d+\.)/gi;

/** 0c. Zero-word glued to digits: "Nought0.87" → "0.87". */
const GLUED_DIGIT_WORD_PATTERN = /\b(naught|nought|zero|oh|nil)(\d+\.?\d*)/gi;

/** Word alternation for spoken decimals (steps 3, 4). */
const DIGIT_WORD_ALT = 'naught|nought|zero|oh|nil|one|two|three|four|five|six|seven|eight|nine';

const DECIMAL_PATTERN = new RegExp(
  `\\b(${DIGIT_WORD_ALT})\\s+point\\s+(${DIGIT_WORD_ALT})(?:\\s+(${DIGIT_WORD_ALT}))?(?:\\s+(${DIGIT_WORD_ALT}))?\\b`,
  'gi'
);

const IMPLIED_ZERO_DECIMAL_PATTERN = new RegExp(
  `(?<=\\s|^)point\\s+(${DIGIT_WORD_ALT})(?:\\s+(${DIGIT_WORD_ALT}))?\\b`,
  'gi'
);

/** 5. Tens+ones — "twenty one" → "21". */
const TENS_ONES_PATTERN =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi;

/** 6. Teens — "thirteen" → "13". */
const TEENS_PATTERN =
  /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;

/** 7a. Tens-plurals — "twenties" → "20". */
const TENS_PLURAL_PATTERN =
  /\b(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/gi;

/** 7b. Standalone tens — "twenty" → "20". */
const STANDALONE_TENS_PATTERN = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;

/** 2. Bare hundreds — "three hundred" → "300". MUST run AFTER step 2pre. */
const HUNDRED_PATTERN = /\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b/gi;

/** 2pre. Compound hundreds — British "<digit> hundred and <tens>[ <ones>]"
 *  with optional "and". Captures four groups in priority order: hundreds
 *  digit (required), teen (optional), tens (optional alt), ones (optional
 *  with tens). MUST run BEFORE step 2 — session A354882B 2026-04-28
 *  produced "200 and 50 volts" without this rule. See Swift line 248. */
const COMPOUND_HUNDRED_PATTERN = (() => {
  const digit = 'one|two|three|four|five|six|seven|eight|nine';
  const teen = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
  const tens = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
  return new RegExp(
    `\\b(${digit})\\s+hundred(?:\\s+and)?\\s+(?:(${teen})|(${tens})(?:\\s+(${digit}))?)\\b`,
    'gi'
  );
})();

/** 8 / 8e. Digit-sequence collapse: "6 0 8 9 8" → "60898", admits zero-words
 *  inside runs. Multi-digit tokens (`\d+`) on both ends so step 8 can fold
 *  partial runs (e.g. "608 9 8" after step 8 + step 8d) cleanly in step 8e.
 *  See Swift line 277 for the 2026-04-30 zero-word extension. */
const DIGIT_SEQUENCE_PATTERN = /\b\d+(?:\s+(?:\d+|zero|oh|nought|naught))+\b/gi;

/** 8b. "point 60" → "0.60" — standalone "point" before already-numeric
 *  digits (after step 8 collapse). */
const POINT_DIGIT_PATTERN = /(?<=\s|^)point\s+(\d+)/gi;

/** 8d. Standalone single-digit word: "four" → "4". Negative lookbehind
 *  excludes "one" after ordinal/pronoun context (first/second/.../tenth +
 *  next/last/this/that/etc) so "the second one" doesn't become "the second
 *  1". Zero-words are excluded — they have specific multi-word patterns
 *  earlier. Production session F456A97C 2026-04-27 motivated the lookbehind.
 *
 *  **Safari support:** `(?<!...)` requires Safari 16.4+. The construction
 *  may throw on older versions — caller wraps in try/catch and degrades. */
const STANDALONE_DIGIT_WORD_PATTERN =
  /(?<!\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|last|this|that|previous|another|other|new|same|right|wrong|good|bad|each|every)\s)\b(one|two|three|four|five|six|seven|eight|nine)\b/gi;

// MARK: — Public API

/**
 * Normalise a transcript: convert spoken numbers to digits, spoken
 * abbreviations to standard forms, and spoken units to symbols.
 *
 * Idempotent for already-normalised input ("0.27" stays "0.27").
 * Returns the input unchanged on empty / no-numbers text.
 *
 * @param text Raw Deepgram transcript text.
 * @returns Normalised text.
 */
export function normalise(text: string): string {
  let result = text;

  // 0pre0. Flux misheard "second" → "circuit". MUST run first.
  result = result.replace(MISHEARED_CIRCUIT_PATTERN, 'circuit');

  // 0pre0b. Letter-splitting "a b s [e n]" → "BS" / "BS EN".
  result = result.replace(SPELLED_BS_PATTERN, (matched) =>
    matched.toLowerCase().includes('e') ? 'BS EN' : 'BS'
  );

  // 0pre. Mixed spoken zero + "point" + numeric: "Nought Point 0.87" → "0.87".
  result = result.replace(SPOKEN_ZERO_POINT_NUMERIC_PATTERN, (_m, digits: string) => {
    if (digits.includes('.')) return digits;
    return `0.${digits}`;
  });

  // 0a. Implied decimal: "Nought 88" → "0.88".
  result = result.replace(
    IMPLIED_DECIMAL_PATTERN,
    (_m, _zeroWord: string, digits: string) => `0.${digits}`
  );

  // 0b. Strip stray digit words before "0.14".
  result = result.replace(STRAY_DIGIT_WORD_PATTERN, '');

  // 0c. Zero-word glued to digits: "Nought0.87" → "0.87".
  result = result.replace(GLUED_DIGIT_WORD_PATTERN, (m, _zeroWord: string, digits: string) => {
    if (digits.includes('.')) return digits;
    if (digits.length >= 2 && digits.length <= 3) return `0.${digits}`;
    return m;
  });

  // 1. Spoken abbreviations (zed s → Zs, etc.) — pre-compiled.
  for (const [regex, replacement] of SPOKEN_ABBREVIATIONS) {
    result = result.replace(regex, replacement);
  }

  // 2pre. Compound hundreds. MUST run BEFORE step 2.
  result = result.replace(
    COMPOUND_HUNDRED_PATTERN,
    (
      _m,
      hWord: string,
      teen: string | undefined,
      tens: string | undefined,
      ones: string | undefined
    ) => {
      const hDigit = DIGIT_WORDS[hWord.toLowerCase()];
      if (hDigit === undefined) return _m;
      const hundreds = parseInt(hDigit, 10) * 100;
      if (teen) {
        const teenDigit = TEENS_MAP[teen.toLowerCase()];
        if (teenDigit !== undefined) return String(hundreds + parseInt(teenDigit, 10));
      }
      if (tens) {
        const tensDigit = TENS_MAP[tens.toLowerCase()];
        if (tensDigit === undefined) return _m;
        const tensVal = parseInt(tensDigit, 10) * 10;
        if (ones) {
          const onesDigit = DIGIT_WORDS[ones.toLowerCase()];
          if (onesDigit !== undefined) return String(hundreds + tensVal + parseInt(onesDigit, 10));
        }
        return String(hundreds + tensVal);
      }
      return _m;
    }
  );

  // 2. Hundreds: "three hundred" → "300".
  result = result.replace(HUNDRED_PATTERN, (_m, word: string) => {
    const digit = DIGIT_WORDS[word.toLowerCase()];
    if (digit === undefined) return _m;
    return `${digit}00`;
  });

  // 3. Spoken decimals: "nought point two seven" → "0.27".
  result = result.replace(
    DECIMAL_PATTERN,
    (m, whole: string, d1: string, d2: string | undefined, d3: string | undefined) => {
      const w = DIGIT_WORDS[whole.toLowerCase()];
      const f1 = DIGIT_WORDS[d1.toLowerCase()];
      if (w === undefined || f1 === undefined) return m;
      let dec = `${w}.${f1}`;
      if (d2) {
        const f2 = DIGIT_WORDS[d2.toLowerCase()];
        if (f2 !== undefined) dec += f2;
      }
      if (d3) {
        const f3 = DIGIT_WORDS[d3.toLowerCase()];
        if (f3 !== undefined) dec += f3;
      }
      return dec;
    }
  );

  // 4. Implied zero decimal: "point two seven" → "0.27".
  result = result.replace(IMPLIED_ZERO_DECIMAL_PATTERN, (m, d1: string, d2: string | undefined) => {
    const f1 = DIGIT_WORDS[d1.toLowerCase()];
    if (f1 === undefined) return m;
    let dec = `0.${f1}`;
    if (d2) {
      const f2 = DIGIT_WORDS[d2.toLowerCase()];
      if (f2 !== undefined) dec += f2;
    }
    return dec;
  });

  // 5. Tens+ones: "twenty one" → "21".
  result = result.replace(TENS_ONES_PATTERN, (m, tens: string, ones: string) => {
    const t = TENS_MAP[tens.toLowerCase()];
    const o = DIGIT_WORDS[ones.toLowerCase()];
    if (t === undefined || o === undefined) return m;
    return `${t}${o}`;
  });

  // 6. Teens: "thirteen" → "13".
  result = result.replace(TEENS_PATTERN, (m, word: string) => TEENS_MAP[word.toLowerCase()] ?? m);

  // 7a. Tens-plurals: "twenties" → "20".
  result = result.replace(TENS_PLURAL_PATTERN, (m, word: string) => {
    const digit = TENS_PLURAL_MAP[word.toLowerCase()];
    if (digit === undefined) return m;
    return `${digit}0`;
  });

  // 7b. Standalone tens: "twenty" → "20".
  result = result.replace(STANDALONE_TENS_PATTERN, (m, word: string) => {
    const digit = TENS_MAP[word.toLowerCase()];
    if (digit === undefined) return m;
    return `${digit}0`;
  });

  // 8. Collapse single-digit sequences (with zero-word admission).
  result = result.replace(DIGIT_SEQUENCE_PATTERN, (matched) =>
    matched
      .split(/\s+/)
      .map((tok) => {
        const lower = tok.toLowerCase();
        if (lower === 'zero' || lower === 'oh' || lower === 'nought' || lower === 'naught')
          return '0';
        return tok;
      })
      .join('')
  );

  // 8b. "point 60" → "0.60".
  result = result.replace(POINT_DIGIT_PATTERN, (_m, digits: string) => `0.${digits}`);

  // 8c. Re-apply implied decimal: "nought 34" → "0.34".
  result = result.replace(
    IMPLIED_DECIMAL_PATTERN,
    (_m, _zeroWord: string, digits: string) => `0.${digits}`
  );

  // 8d. Standalone single-digit words.
  result = result.replace(
    STANDALONE_DIGIT_WORD_PATTERN,
    (m, word: string) => DIGIT_WORDS[word.toLowerCase()] ?? m
  );

  // 8e. Re-collapse digit sequences after step 8d.
  result = result.replace(DIGIT_SEQUENCE_PATTERN, (matched) =>
    matched
      .split(/\s+/)
      .map((tok) => {
        const lower = tok.toLowerCase();
        if (lower === 'zero' || lower === 'oh' || lower === 'nought' || lower === 'naught')
          return '0';
        return tok;
      })
      .join('')
  );

  // 9. Unit normalisation (longest key first to avoid partial-shadowing).
  const unitEntries = Object.entries(DEFAULT_UNIT_NORMALISATION).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [spoken, symbol] of unitEntries) {
    const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), symbol);
  }

  return result;
}
