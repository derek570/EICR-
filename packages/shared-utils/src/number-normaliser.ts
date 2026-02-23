/**
 * Number normaliser — port of iOS NumberNormaliser.swift
 *
 * Converts spoken number and unit forms in Deepgram transcript text
 * before regex field matching runs.
 *
 * Handles mixed formats like "nought point two seven" -> "0.27"
 * and unit normalisations like "meg ohms" -> "MΩ".
 *
 * The order of regex passes matters. Incorrect order causes artifacts like "0.0.87".
 */

// -- Digit Word Maps --

const digitWords: Record<string, string> = {
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

const teensMap: Record<string, string> = {
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

const tensMap: Record<string, string> = {
  twenty: '2',
  thirty: '3',
  forty: '4',
  fifty: '5',
  sixty: '6',
  seventy: '7',
  eighty: '8',
  ninety: '9',
};

// -- Spoken Abbreviations --

const spokenAbbreviations: [RegExp, string][] = [
  [/\bzed\s+s(?:s|ess)?\b/gi, 'Zs'],
  [/\bzed\s+e\b/gi, 'Ze'],
  [/\bzed(?:dy|d?e(?:e)?)\b/gi, 'Ze'],
  [/\bp\s+f\s+c\b/gi, 'PFC'],
  [/\bm\s+c\s+b\b/gi, 'MCB'],
  [/\br\s+c\s+b\s+o\b/gi, 'RCBO'],
  [/\br\s+c\s+d\b/gi, 'RCD'],
  [/\ba\s+f\s+d\s+d\b/gi, 'AFDD'],
  [/\bc\s+p\s+c\b/gi, 'CPC'],
  [/\br\s+one\b/gi, 'R1'],
  [/\br\s+two\b/gi, 'R2'],
];

// -- Default Unit Normalisation --
// Sorted by key length descending so longer strings match first
// (e.g. "millimeters squared" before "millimeters")

const defaultUnitNormalisation: [string, string][] = [
  ['millimeters squared', 'mm\u00B2'],
  ['millimetres', 'mm'],
  ['millimeters', 'mm'],
  ['milli seconds', 'ms'],
  ['milliseconds', 'ms'],
  ['millimetre', 'mm'],
  ['millimeter', 'mm'],
  ['megger ohms', 'M\u03A9'],
  ['milli amps', 'mA'],
  ['mm squared', 'mm\u00B2'],
  ['mil squared', 'mm\u00B2'],
  ['mega ohms', 'M\u03A9'],
  ['meg ohms', 'M\u03A9'],
  ['milliamps', 'mA'],
  ['megohms', 'M\u03A9'],
  ['grooms', 'M\u03A9'],
  ['ohms', '\u03A9'],
];

// -- Precompiled Patterns --

const DW = 'naught|nought|zero|oh|one|two|three|four|five|six|seven|eight|nine';

// 0pre. "Nought Point 0.87" -> "0.87"
const spokenZeroPointNumericRe = new RegExp(
  `\\b(?:naught|nought|zero|oh)\\s+point\\s+(\\d+\\.?\\d*)`,
  'gi'
);

// 0a. "Nought 88" -> "0.88"
const impliedDecimalRe = new RegExp(`\\b(naught|nought|zero|oh)\\s+(\\d{2,3})\\b`, 'gi');

// 0b. "naught 0.14" -> "0.14"
const strayDigitWordRe = new RegExp(`\\b(naught|nought|zero|oh|no)\\s+(?=\\d+\\.)`, 'gi');

// 0c. "Nought0.87" -> "0.87"
const gluedDigitWordRe = new RegExp(`\\b(naught|nought|zero|oh)(\\d+\\.?\\d*)`, 'gi');

// 2. "three hundred" -> "300"
const hundredRe = new RegExp(
  `\\b(one|two|three|four|five|six|seven|eight|nine)\\s+hundred\\b`,
  'gi'
);

// 3. "nought point two seven" -> "0.27"
const decimalRe = new RegExp(
  `\\b(${DW})\\s+point\\s+(${DW})(?:\\s+(${DW}))?(?:\\s+(${DW}))?\\b`,
  'gi'
);

// 4. "point two seven" -> "0.27"
const impliedZeroDecimalRe = new RegExp(`(?<=\\s|^)point\\s+(${DW})(?:\\s+(${DW}))?\\b`, 'gi');

// 5. "twenty one" -> "21"
const tensOnesRe =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi;

// 6. "thirteen" -> "13"
const teensRe =
  /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;

// 7a. "twenties" -> "20"
const tensPluralRe = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:ies|s)\b/gi;

// 7b. "twenty" -> "20"
const standaloneTensRe = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;

// 8. "2 9 9" -> "299"
const digitSequenceRe = /\b(\d)\s+(\d)(?:\s+(\d))?\b/g;

// 8b. "point 60" -> "0.60"
const pointDigitRe = /(?<=\s|^)point\s+(\d+)/gi;

// -- Helpers --

/**
 * Replace all matches of a global regex using a callback.
 * Process in reverse order to preserve indices (like the Swift version).
 * If the callback returns null, the match is left unchanged.
 */
function replaceWithFn(
  text: string,
  regex: RegExp,
  fn: (match: RegExpExecArray) => string | null
): string {
  regex.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    matches.push({ ...m, index: m.index } as RegExpExecArray);
    if (m[0].length === 0) regex.lastIndex++;
  }

  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const replacement = fn(match);
    if (replacement !== null) {
      result =
        result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
    }
  }
  return result;
}

// -- Public API --

/**
 * Normalise a transcript string: convert spoken numbers to digits,
 * spoken abbreviations to standard forms, and spoken units to symbols.
 */
export function normalise(text: string): string {
  let result = text;

  // 0pre. Mixed spoken zero + "point" + numeric: "Nought Point 0.87" -> "0.87"
  result = replaceWithFn(result, spokenZeroPointNumericRe, (m) => {
    const digits = m[1];
    if (!digits) return null;
    if (digits.includes('.')) return digits;
    return `0.${digits}`;
  });

  // 0a. Convert implied decimals: "Nought 88" -> "0.88"
  result = replaceWithFn(result, impliedDecimalRe, (m) => {
    const digits = m[2];
    if (!digits) return null;
    return `0.${digits}`;
  });

  // 0b. Remove stray digit words before numeric values WITH decimal
  strayDigitWordRe.lastIndex = 0;
  result = result.replace(strayDigitWordRe, '');

  // 0c. Handle zero-word glued to digits without space
  result = replaceWithFn(result, gluedDigitWordRe, (m) => {
    const digits = m[2];
    if (!digits) return null;
    if (digits.includes('.')) return digits;
    if (digits.length >= 2 && digits.length <= 3) return `0.${digits}`;
    return null;
  });

  // 1. Spoken abbreviations (zed s -> Zs, etc.)
  for (const [re, replacement] of spokenAbbreviations) {
    re.lastIndex = 0;
    result = result.replace(re, replacement);
  }

  // 2. Hundreds ("three hundred" -> "300")
  result = replaceWithFn(result, hundredRe, (m) => {
    const word = m[1]?.toLowerCase() ?? '';
    const digit = digitWords[word];
    if (!digit) return null;
    return `${digit}00`;
  });

  // 3. Spoken decimals ("nought point two seven" -> "0.27")
  result = replaceWithFn(result, decimalRe, (m) => {
    const whole = m[1]?.toLowerCase() ?? '';
    const d1 = m[2]?.toLowerCase() ?? '';
    const d2 = m[3]?.toLowerCase();
    const d3 = m[4]?.toLowerCase();

    const w = digitWords[whole];
    const f1 = digitWords[d1];
    if (!w || !f1) return null;
    let decimal = `${w}.${f1}`;
    if (d2) {
      const f2 = digitWords[d2];
      if (f2) decimal += f2;
    }
    if (d3) {
      const f3 = digitWords[d3];
      if (f3) decimal += f3;
    }
    return decimal;
  });

  // 4. Implied zero decimal ("point two seven" -> "0.27")
  result = replaceWithFn(result, impliedZeroDecimalRe, (m) => {
    const d1 = m[1]?.toLowerCase() ?? '';
    const d2 = m[2]?.toLowerCase();
    const f1 = digitWords[d1];
    if (!f1) return null;
    let decimal = `0.${f1}`;
    if (d2) {
      const f2 = digitWords[d2];
      if (f2) decimal += f2;
    }
    return decimal;
  });

  // 5. Tens+ones ("twenty one" -> "21")
  result = replaceWithFn(result, tensOnesRe, (m) => {
    const tens = m[1]?.toLowerCase() ?? '';
    const ones = m[2]?.toLowerCase() ?? '';
    const t = tensMap[tens];
    const o = digitWords[ones];
    if (!t || !o) return null;
    return `${t}${o}`;
  });

  // 6. Teens ("thirteen" -> "13")
  result = replaceWithFn(result, teensRe, (m) => {
    const word = m[1]?.toLowerCase() ?? '';
    return teensMap[word] ?? null;
  });

  // 7a. Tens-plurals ("twenties" -> "20", "thirties" -> "30")
  result = replaceWithFn(result, tensPluralRe, (m) => {
    const word = m[1]?.toLowerCase() ?? '';
    const digit = tensMap[word];
    if (!digit) return null;
    return `${digit}0`;
  });

  // 7b. Standalone tens ("twenty" -> "20")
  result = replaceWithFn(result, standaloneTensRe, (m) => {
    const word = m[1]?.toLowerCase() ?? '';
    const digit = tensMap[word];
    if (!digit) return null;
    return `${digit}0`;
  });

  // 8. Collapse single-digit sequences: "2 9 9" -> "299"
  result = replaceWithFn(result, digitSequenceRe, (m) => {
    const d1 = m[1] ?? '';
    const d2 = m[2] ?? '';
    const d3 = m[3];
    if (d3) return `${d1}${d2}${d3}`;
    return `${d1}${d2}`;
  });

  // 8b. "point 60" -> "0.60"
  result = replaceWithFn(result, pointDigitRe, (m) => {
    const digits = m[1];
    if (!digits) return null;
    return `0.${digits}`;
  });

  // 8c. Re-apply implied decimal after digit collapse: "nought 34" -> "0.34"
  result = replaceWithFn(result, impliedDecimalRe, (m) => {
    const digits = m[2];
    if (!digits) return null;
    return `0.${digits}`;
  });

  // 9. Unit normalisation (longest match first)
  for (const [spoken, symbol] of defaultUnitNormalisation) {
    const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unitRe = new RegExp(escaped, 'gi');
    result = result.replace(unitRe, symbol);
  }

  return result;
}
