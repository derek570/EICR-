/**
 * NumberNormaliser — ported from CertMateUnified/Sources/Whisper/NumberNormaliser.swift
 *
 * Normalises spoken number and unit forms in Deepgram transcript text
 * before regex field matching runs.
 *
 * Handles mixed formats like "nought point two seven" -> "0.27"
 * and unit normalisations like "meg ohms" -> "MΩ".
 */

// ---- Digit Word Maps ----

const digitWords: Record<string, string> = {
  naught: "0", nought: "0", zero: "0", oh: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};

const teensMap: Record<string, string> = {
  ten: "10", eleven: "11", twelve: "12", thirteen: "13",
  fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19",
};

const tensMap: Record<string, string> = {
  twenty: "2", thirty: "3", forty: "4", fifty: "5",
  sixty: "6", seventy: "7", eighty: "8", ninety: "9",
};

// ---- Spoken Abbreviations ----

const spokenAbbreviations: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bzed\s+s(?:s|ess)?\b/gi, replacement: "Zs" },
  { pattern: /\bzed\s+e\b/gi, replacement: "Ze" },
  { pattern: /\bzed(?:dy|d?e(?:e)?)\b/gi, replacement: "Ze" },
  { pattern: /\bp\s+f\s+c\b/gi, replacement: "PFC" },
  { pattern: /\bm\s+c\s+b\b/gi, replacement: "MCB" },
  { pattern: /\br\s+c\s+b\s+o\b/gi, replacement: "RCBO" },
  { pattern: /\br\s+c\s+d\b/gi, replacement: "RCD" },
  { pattern: /\ba\s+f\s+d\s+d\b/gi, replacement: "AFDD" },
  { pattern: /\bc\s+p\s+c\b/gi, replacement: "CPC" },
  { pattern: /\br\s+one\b/gi, replacement: "R1" },
  { pattern: /\br\s+two\b/gi, replacement: "R2" },
];

// ---- Default Unit Normalisation ----

const defaultUnitNormalisation: Record<string, string> = {
  "meg ohms": "MΩ",
  "mega ohms": "MΩ",
  "megohms": "MΩ",
  "megger ohms": "MΩ",
  "grooms": "MΩ",
  "ohms": "Ω",
  "milliamps": "mA",
  "milli amps": "mA",
  "milliseconds": "ms",
  "milli seconds": "ms",
  "mil squared": "mm²",
  "mm squared": "mm²",
  "millimeters squared": "mm²",
  "millimeter": "mm",
  "millimeters": "mm",
  "millimetre": "mm",
  "millimetres": "mm",
};

// ---- Compiled Patterns ----

const dw = "naught|nought|zero|oh|one|two|three|four|five|six|seven|eight|nine";

// 0pre: "Nought Point 0.87" -> "0.87"
const spokenZeroPointNumericPattern = new RegExp(
  `\\b(?:naught|nought|zero|oh)\\s+point\\s+(\\d+\\.?\\d*)`, "gi"
);

// 0a: "Nought 88" -> "0.88" (implied decimal)
const impliedDecimalPattern = new RegExp(
  `\\b(naught|nought|zero|oh)\\s+(\\d{2,3})\\b`, "gi"
);

// 0b: Stray digit word before numeric WITH decimal ("naught 0.14" -> "0.14")
const strayDigitWordPattern = new RegExp(
  `\\b(naught|nought|zero|oh|no)\\s+(?=\\d+\\.)`, "gi"
);

// 0c: Glued zero-word to digits ("Nought0.87" -> "0.87")
const gluedDigitWordPattern = new RegExp(
  `\\b(naught|nought|zero|oh)(\\d+\\.?\\d*)`, "gi"
);

// 3: Spoken decimals ("nought point two seven" -> "0.27")
const decimalPattern = new RegExp(
  `\\b(${dw})\\s+point\\s+(${dw})(?:\\s+(${dw}))?(?:\\s+(${dw}))?\\b`, "gi"
);

// 4: Implied zero decimal ("point two seven" -> "0.27")
const impliedZeroDecimalPattern = new RegExp(
  `(?<=\\s|^)point\\s+(${dw})(?:\\s+(${dw}))?\\b`, "gi"
);

// 5: Tens+ones ("twenty one" -> "21")
const tensOnesPattern = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi;

// 6: Teens ("thirteen" -> "13")
const teensPattern = /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;

// 7a: Tens-plurals ("twenties" -> "20", "thirties" -> "30")
const tensPluralPattern = /\b(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/gi;

const tensPluralMap: Record<string, string> = {
  twenties: "20", thirties: "30", forties: "40", fifties: "50",
  sixties: "60", seventies: "70", eighties: "80", nineties: "90",
};

// 7b: Standalone tens ("twenty" -> "20")
const standaloneTensPattern = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;

// 2: Hundreds ("three hundred" -> "300")
const hundredPattern = /\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred\b/gi;

// 8: Digit sequence collapse ("2 9 9" -> "299")
const digitSequencePattern = /\b(\d)\s+(\d)(?:\s+(\d))?\b/g;

// 8b: "point 60" -> "0.60"
const pointDigitPattern = /(?<=\s|^)point\s+(\d+)/gi;

// ---- Helper: replace with callback ----

function replaceWithCallback(
  text: string,
  regex: RegExp,
  callback: (match: RegExpExecArray) => string | null
): string {
  // Reset regex lastIndex
  regex.lastIndex = 0;
  const matches: Array<{ start: number; end: number; replacement: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const rep = callback(m);
    if (rep !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, replacement: rep });
    }
  }
  // Apply in reverse to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, replacement } = matches[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

// ---- Public API ----

/**
 * Normalise a transcript string: convert spoken numbers to digits,
 * spoken abbreviations to standard forms, and spoken units to symbols.
 */
export function normalise(text: string, unitOverrides?: Record<string, string>): string {
  let result = text;

  // 0pre. Mixed spoken zero + "point" + numeric: "Nought Point 0.87" -> "0.87"
  result = replaceWithCallback(result, spokenZeroPointNumericPattern, (m) => {
    const digits = m[1];
    if (!digits) return null;
    if (digits.includes(".")) return digits;
    if (digits.length >= 2) return `0.${digits}`;
    return `0.${digits}`;
  });

  // 0a. Implied decimal: "Nought 88" -> "0.88"
  result = replaceWithCallback(result, impliedDecimalPattern, (m) => {
    const digits = m[2];
    if (!digits) return null;
    return `0.${digits}`;
  });

  // 0b. Stray digit word before numeric WITH decimal ("naught 0.14" -> "0.14")
  strayDigitWordPattern.lastIndex = 0;
  result = result.replace(strayDigitWordPattern, "");

  // 0c. Glued zero-word to digits ("Nought0.87" -> "0.87")
  result = replaceWithCallback(result, gluedDigitWordPattern, (m) => {
    const digits = m[2];
    if (!digits) return null;
    if (digits.includes(".")) return digits;
    if (digits.length >= 2 && digits.length <= 3) return `0.${digits}`;
    return null;
  });

  // 1. Spoken abbreviations (zed s -> Zs, etc.)
  for (const { pattern, replacement } of spokenAbbreviations) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  // 2. Hundreds ("three hundred" -> "300")
  result = replaceWithCallback(result, hundredPattern, (m) => {
    const word = m[1]?.toLowerCase();
    if (!word) return null;
    const digit = digitWords[word];
    if (!digit) return null;
    return `${digit}00`;
  });

  // 3. Spoken decimals ("nought point two seven" -> "0.27")
  result = replaceWithCallback(result, decimalPattern, (m) => {
    const whole = m[1]?.toLowerCase();
    const d1 = m[2]?.toLowerCase();
    const d2 = m[3]?.toLowerCase();
    const d3 = m[4]?.toLowerCase();
    if (!whole || !d1) return null;
    const w = digitWords[whole];
    const f1 = digitWords[d1];
    if (!w || !f1) return null;
    let decimal = `${w}.${f1}`;
    if (d2 && digitWords[d2]) decimal += digitWords[d2];
    if (d3 && digitWords[d3]) decimal += digitWords[d3];
    return decimal;
  });

  // 4. Implied zero decimal ("point two seven" -> "0.27")
  result = replaceWithCallback(result, impliedZeroDecimalPattern, (m) => {
    const d1 = m[1]?.toLowerCase();
    const d2 = m[2]?.toLowerCase();
    if (!d1) return null;
    const f1 = digitWords[d1];
    if (!f1) return null;
    let decimal = `0.${f1}`;
    if (d2 && digitWords[d2]) decimal += digitWords[d2];
    return decimal;
  });

  // 5. Tens+ones ("twenty one" -> "21")
  result = replaceWithCallback(result, tensOnesPattern, (m) => {
    const tens = m[1]?.toLowerCase();
    const ones = m[2]?.toLowerCase();
    if (!tens || !ones) return null;
    const t = tensMap[tens];
    const o = digitWords[ones];
    if (!t || !o) return null;
    return `${t}${o}`;
  });

  // 6. Teens ("thirteen" -> "13")
  result = replaceWithCallback(result, teensPattern, (m) => {
    const word = m[1]?.toLowerCase();
    if (!word) return null;
    return teensMap[word] ?? null;
  });

  // 7a. Tens-plurals ("twenties" -> "20")
  result = replaceWithCallback(result, tensPluralPattern, (m) => {
    const word = m[1]?.toLowerCase();
    if (!word) return null;
    return tensPluralMap[word] ?? null;
  });

  // 7b. Standalone tens ("twenty" -> "20")
  result = replaceWithCallback(result, standaloneTensPattern, (m) => {
    const word = m[1]?.toLowerCase();
    if (!word) return null;
    const digit = tensMap[word];
    if (!digit) return null;
    return `${digit}0`;
  });

  // 8. Collapse single-digit sequences: "2 9 9" -> "299"
  result = replaceWithCallback(result, digitSequencePattern, (m) => {
    const d1 = m[1] ?? "";
    const d2 = m[2] ?? "";
    const d3 = m[3];
    if (d3) return `${d1}${d2}${d3}`;
    return `${d1}${d2}`;
  });

  // 8b. "point 60" -> "0.60"
  result = replaceWithCallback(result, pointDigitPattern, (m) => {
    const digits = m[1];
    if (!digits) return null;
    return `0.${digits}`;
  });

  // 9. Unit normalisation
  const unitMap = unitOverrides && Object.keys(unitOverrides).length > 0
    ? unitOverrides
    : defaultUnitNormalisation;
  // Sort by key length descending so longer strings match first
  const sortedEntries = Object.entries(unitMap).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [spoken, symbol] of sortedEntries) {
    const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), symbol);
  }

  return result;
}
