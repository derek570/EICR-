/**
 * TranscriptFieldMatcher — TypeScript port of
 * `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift` (~2100
 * lines, ~100 pre-compiled regexes).
 *
 * Stateful regex extractor that runs on the cumulative session transcript
 * (NOT individual utterances — see `match()` docblock). Maintains a 30s
 * active-circuit-ref window for cross-utterance ring-continuity readings,
 * a sliding 800-char window for compound-phrase matching, and a
 * `lastProcessedOffset` so each call only scans the new text.
 *
 * Output: `RegexMatchResult` consumed by `apply-regex-match.ts` which
 * translates circuit_ref → row UUID and writes through the
 * FieldSourceTracker.
 *
 * **Step ordering and pattern bodies are load-bearing.** Every pattern is
 * copied byte-for-byte from the Swift raw literals (`#"..."#`). Do NOT
 * "improve" patterns — Swift commit-message rationale documents non-obvious
 * branches. User rule "iOS is canon for parity".
 *
 * **Swift→TS port mechanics (codex review findings A1-A3):**
 *   - Inline `(?i)` stripped — JS `RegExp` doesn't support it. Patterns
 *     use the `i` flag and `g` flag.
 *   - Stateful matcher requires CUMULATIVE transcript (every call
 *     receives all finals so far joined by spaces). Feeding isolated
 *     utterances breaks the offset-based windowing and silently
 *     suppresses cross-utterance matches (codex review finding F2).
 *   - Date parsing uses a manual parser — JS `Date` constructor is
 *     unreliable for UK-format dates ("18/03/2026" parses as Mar 18 in
 *     en-US locale).
 *   - Constants.normaliseWiringType / Constants.wiringTypes are iOS-only;
 *     the wiring-type-word path is stubbed (passthrough) until the PWA
 *     ports the constants. None of the iOS tests exercise this path.
 *   - RemoteConfigService.shared has no PWA equivalent; remote-pattern
 *     hooks return undefined so the built-in patterns are used.
 *   - os.Logger / DebugLogger / AppLogger replaced with console.debug
 *     gated on `process.env.NEXT_PUBLIC_DEBUG_RECORDING === '1'`.
 */

import type { JobDetail, CircuitRow } from '@/lib/types';
import {
  emptyRegexMatchResult,
  isEmptyResult,
  type CircuitUpdates,
  type RegexMatchResult,
} from './regex-match-result';
import { normalise as normaliseNumbers } from './number-normaliser';

// MARK: — Word maps (mirrors Swift lines 184-201)

const WORD_NUMBERS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

const ORDINAL_NUMBERS: Record<string, string> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
  eleventh: '11',
  twelfth: '12',
};

const DIGIT_WORD_MAP: Record<string, string> = {
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

const BOARD_NUMBER_ORDINAL_MAP: Record<string, string> = {
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
};

// MARK: — Earthing map

const EARTHING_MAP: Record<string, string> = {
  'tn-c-s': 'TN-C-S',
  'tn c s': 'TN-C-S',
  tncs: 'TN-C-S',
  pme: 'TN-C-S',
  'combined neutral': 'TN-C-S',
  'tn-c': 'TN-C',
  'tn c': 'TN-C',
  tnc: 'TN-C',
  'tn-s': 'TN-S',
  'tn s': 'TN-S',
  tns: 'TN-S',
  'separate earth': 'TN-S',
  'lead sheath': 'TN-S',
  tt: 'TT',
  'earth rod': 'TT',
};

// MARK: — Designation map (mirrors Swift lines 1075-1108)

const LOCATION_PREFIXES = [
  'upstairs',
  'downstairs',
  'first floor',
  'second floor',
  'ground floor',
  'loft',
  'attic',
  'basement',
  'kitchen',
  'bathroom',
  'bedroom',
  'garage',
  'utility',
  'conservatory',
  'extension',
  'landing',
  'hallway',
  'lounge',
  'dining',
];

const DESIGNATION_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const w of ['socket', 'sockets', 'ring', 'ring main', 'ring final', 'socket ring'])
    m[w] = 'Sockets';
  for (const w of ['light', 'lights', 'lighting', 'light circuit', 'lines']) m[w] = 'Lighting';
  for (const w of ['cooker', 'oven', 'hob', 'range']) m[w] = 'Cooker';
  for (const w of ['shower', 'electric shower']) m[w] = 'Shower';
  for (const w of ['immersion', 'immersion heater', 'hot water']) m[w] = 'Immersion';
  for (const w of [
    'smoke',
    'smokes',
    'smoke detector',
    'smoke detectors',
    'smoke alarm',
    'smoke alarms',
    'fire alarm',
    'fire alarms',
  ])
    m[w] = 'Smoke Detectors';
  m['fridge freezer'] = 'Fridge Freezer';
  m['fridge'] = 'Fridge';
  m['freezer'] = 'Freezer';
  m['dishwasher'] = 'Dishwasher';
  m['washing machine'] = 'Washing Machine';
  m['tumble dryer'] = 'Tumble Dryer';
  m['boiler'] = 'Boiler';
  m['towel rail'] = 'Towel Rail';
  m['underfloor heating'] = 'Underfloor Heating';
  m['garage'] = 'Garage';
  for (const w of ['shed', 'outbuilding']) m[w] = 'Outbuilding';
  for (const w of ['outside light', 'outside lights', 'external light', 'external lights'])
    m[w] = 'External Lighting';
  for (const w of ['alarm', 'intruder alarm']) m[w] = 'Intruder Alarm';
  m['cctv'] = 'CCTV';
  for (const w of ['ev charger', 'car charger', 'electric vehicle']) m[w] = 'EV Charger';
  m['radial'] = 'Radial';
  return m;
})();

const STOP_WORDS = new Set([
  'is',
  'the',
  'a',
  'an',
  'at',
  'in',
  'on',
  'to',
  'of',
  'and',
  'are',
  'was',
  'it',
  'my',
  'our',
  'for',
  'mr',
  'mrs',
  'miss',
  'dr',
  'that',
  'this',
  'its',
  'his',
  'her',
  'not',
  'but',
  'or',
  'so',
  'be',
  'if',
  'as',
  'do',
  'no',
  'up',
  'he',
  'she',
  'we',
  'me',
]);

const BS_EN_TO_OCPD_TYPE: Record<string, string> = {
  '60898': 'MCB',
  '61009': 'RCBO',
  '60909': 'RCBO',
};

const BS_EN_MAP: Record<string, string> = {
  '1361': '1361 type 1',
  '3036': '3036 (S-E)',
  '88': '88 Fuse',
  '1631': '1361 type 1',
  '60947': '60947-3',
  '61008': '61008 RCD',
  '61009': '61009 RCBO',
  '4293': '4293 RCD',
  '5419': '5419 isolator',
};

// MARK: — Pre-compiled patterns
//
// Pattern bodies copied byte-for-byte from Swift raw literals (#"..."#).
// `(?i)` stripped from each (JS uses `i` flag); `g` flag added for
// `String.replace` / `String.matchAll` correctness. Lookahead `(?=…)`
// supported on all Safari versions; only NEGATIVE lookbehind needs 16.4+
// (none in this file — the only lookbehind here is positive `(?<=\s)`
// in `IMPLIED_ZERO_DECIMAL_PATTERN_LOCAL`).

// Ring continuity content
const RING_CONTENT_PATTERN =
  /\b(?:earths?|lives?|neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const CONDUCTOR_TYPES_PATTERN = /\b(?:earths?|lives?|neutrals?|nuts)\b/gi;

// Spoken abbreviations (matcher-local — mirrors Swift lines 205-217;
// note this is a SUPERSET of NumberNormaliser's set with extra "z s" /
// "z e" / "zee" forms).
const SPOKEN_ABBREVIATIONS: Array<readonly [RegExp, string]> = [
  [/\bzed\s+s(?:s|ess)?\b/gi, 'Zs'],
  [/\bz\s+s\b/gi, 'Zs'],
  [/\bzed\s+e\b/gi, 'Ze'],
  [/\bzed(?:dy|d?e(?:e)?)\b/gi, 'Ze'],
  // field-feedback-2026-07-14 F10: "Zedi" is a live Deepgram garble of "Ze"
  // (session 6B6FE011 06:27 — beep then silence because nothing downstream
  // recognised the token). Canonical zed-garble table entry; the Ze pattern
  // consumes the normalised form. iOS canon: TranscriptFieldMatcher.swift
  // spokenAbbreviations (commit 67ffb9d).
  [/\bzedi\b/gi, 'Ze'],
  [/\bzee\b/gi, 'Ze'],
  [/\bz\s+e\b/gi, 'Ze'],
  [/\bp\s+f\s+c\b/gi, 'PFC'],
  [/\bm\s+c\s+b\b/gi, 'MCB'],
  [/\br\s+c\s+b\s+o\b/gi, 'RCBO'],
  [/\br\s+c\s+d\b/gi, 'RCD'],
  [/\ba\s+f\s+d\s+d\b/gi, 'AFDD'],
];

const VERB_PERIOD_STRIP_PATTERN = /\b(is|are)\.\s/g;

const DIGIT_WORD_ALT_NN = 'naught|nought|zero|oh|one|two|three|four|five|six|seven|eight|nine';
const SPOKEN_DECIMAL_PATTERN_LOCAL = new RegExp(
  `\\b(${DIGIT_WORD_ALT_NN})\\s+point\\s+(${DIGIT_WORD_ALT_NN})(?:\\s+(${DIGIT_WORD_ALT_NN}))?(?:\\s+(${DIGIT_WORD_ALT_NN}))?\\b`,
  'gi'
);
const IMPLIED_ZERO_DECIMAL_PATTERN_LOCAL = new RegExp(
  `(?<=\\s)point\\s+(${DIGIT_WORD_ALT_NN})(?:\\s+(${DIGIT_WORD_ALT_NN}))?\\b`,
  'gi'
);
const TENS_ONES_PATTERN_LOCAL =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi;
const TEENS_PATTERN_LOCAL =
  /\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;
const STANDALONE_TENS_PATTERN_LOCAL =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;
const HUNDREDS_PATTERN_LOCAL = /\b(one|two|three|four|five|six|seven|eight|nine|a)\s+hundred\b/gi;

// Spaced UK postcode collapse
const SPACED_POSTCODE_2L = /\b([a-z])\s+([a-z])\s+(\d{1,4})\s+([a-z])\s+([a-z])\b/gi;
const PARTIAL_SPACED_POSTCODE = /\b([a-z]{1,2})\s+(\d{1,4})\s+([a-z])\s+([a-z])\b/gi;
const POSTCODE_FORMAT_VALIDATION = /^[A-Z]{1,2}\d[0-9A-Z]?\d[A-Z]{2}$/;

// Circuit reference + designation
const CIRCUIT_REF_PATTERN =
  /\b(?:(?:circuit|way)\s*(?:number\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+circuit)\b/gi;
const DESIGNATION_PATTERN =
  /\b((?:(?:upstairs|downstairs|first\s+floor|second\s+floor|ground\s+floor|loft|attic|basement|kitchen|bathroom|bedroom|garage|utility|conservatory|extension|landing|hallway|lounge|dining)\s+)?(?:ring\s+main|ring\s+final|ring|radial|lighting|lights?|lines|sockets?|cooker|oven|hob|range|shower|electric\s+shower|immersion\s+heater|immersion|hot\s+water|smokes?|smoke\s+detectors?|smoke\s+alarms?|fire\s+alarms?|fridge\s+freezer|fridge|freezer|dishwasher|washing\s+machine|tumble\s+dryer|boiler|towel\s+rail|underfloor\s+heating|garage|shed|outbuilding|outside\s+lights?|external\s+lights?|alarm|intruder\s+alarm|cctv|ev\s+charger|car\s+charger|electric\s+vehicle))\b/gi;

// Supply patterns
const ZE_PATTERN =
  /\b(?:ze|z\s+e|external\s+(?:earth\s+)?(?:loop\s+)?impedance|external\s+loop)[,;:\s]+(?:is\s+|of\s+|=\s*|reading\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ZE_FLEX_PATTERN = /\bze\b.{0,40}?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const PFC_PATTERN =
  /\b(?:pfc|pscc|prospective\s+(?:fault\s+)?(?:short\s+circuit\s+)?current)\s+(?:is\s+|of\s+|=\s*|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)\s*(?:kilo\s*amps?|k?a|amps?)?/gi;
const EARTHING_PATTERN =
  /\b(tn[-\s]?c[-\s]?s|tn[-\s]?c|tn[-\s]?s|tt|pme|combined\s+neutral|separate\s+earth|lead\s+sheath|earth\s+rod)/gi;
const SUPPLY_POLARITY_PATTERN =
  /\b(?:supply\s+)?polarity\s+(?:is\s+)?(?:confirmed|ok|pass|correct)/gi;
const MAIN_EARTH_CSA_PATTERN =
  /\b(?:main\s+earth(?:ing)?(?:\s+conductor)?|earth(?:ing)?\s+conductor)\s+(?:is\s+|=\s*)?(\d+\.?\d*)\s*(?:mm|mil)/gi;
const BONDING_CSA_PATTERN =
  /\b(?:main\s+)?bonding(?:\s+conductor)?\s+(?:is\s+|=\s*)?(\d+\.?\d*)\s*(?:mm|mil)/gi;
const TAILS_CSA_PATTERN = /\b(?:meter\s+)?tails\s+(?:(?:is|are)\s+)?(\d+\.?\d*)\s*(?:mm|mil)/gi;
const SUPPLY_VOLTAGE_PATTERN =
  /\bsupply\s+voltage\s+(?:is\s+|of\s+|=\s*)?(\d[\d\s]*\d)\s*(?:v(?:olts?)?)?/gi;
const SUPPLY_FREQUENCY_PATTERN =
  /\b(?:supply\s+)?frequency\s+(?:is\s+|of\s+|=\s*)?(\d+)\s*(?:hz|hertz)?/gi;
// Option A (surge-protection-box 2026-06-17): the device alternation was
// previously `main (fuse|switch|isolator)|supply fuse` lumped together and
// routed to main_switch_*, contradicting the established voice contract
// ("main fuse"/"cutout" = the DNO Supply Protective Device → spd_*; "main
// switch"/"isolator" = the consumer-unit isolator → main_switch_*). Split
// into two device families so each routes to the correct slot — mirrors iOS
// TranscriptFieldMatcher Fix D (2026-06-04).
const SWITCH_DEVICE = String.raw`(?:main\s+switch|main\s+isolator|isolator)`;
const FUSE_DEVICE = String.raw`(?:main\s+fuse|supply\s+fuse|service\s+fuse|cut\s*out|dno\s+fuse)`;
// Consumer-unit main switch / isolator → main_switch_*
const MAIN_SWITCH_BS_EN_PATTERN = new RegExp(
  String.raw`\b${SWITCH_DEVICE}\s+(?:is\s+)?(?:a\s+)?(?:bs\s*(?:en\s*)?)?(1361|3036|88|1631|60947|61008|61009|4293|5419)\b`,
  'gi'
);
const MAIN_SWITCH_BS_EN_LIM_PATTERN = new RegExp(
  String.raw`\b${SWITCH_DEVICE}\s+(?:(?:of\s+)?(?:the\s+)?)?(?:bs\s*(?:en\s*)?)?(?:number|standard)?\s+(?:is\s+)?(?:a\s+)?(?:lim(?:itation|ited|b)?)\b`,
  'gi'
);
const MAIN_SWITCH_RATING_PATTERN = new RegExp(
  String.raw`\b(?:${SWITCH_DEVICE}|(?:(?:its|it'?s|the)\s+)?current\s+rating)\s+(?:is\s+)?(?:bs\s*(?:en\s*)?\w+\s+)?(?:and\s+(?:it'?s?\s+)?)?(?:(?:rated?|rating)\s+(?:at\s+)?)?(\d+)\s*(?:a(?:mps?)?)?\b`,
  'gi'
);
const MAIN_SWITCH_LIM_PATTERN = new RegExp(
  String.raw`\b${SWITCH_DEVICE}(?:\s+(?:current\s+)?(?:rating|size))?\s+(?:is\s+)?(?:a\s+)?(?:limitation|limited|lim)\b`,
  'gi'
);
// Supply protective device / DNO cutout / "main fuse" → spd_*
const SUPPLY_FUSE_BS_EN_PATTERN = new RegExp(
  String.raw`\b${FUSE_DEVICE}\s+(?:is\s+)?(?:a\s+)?(?:bs\s*(?:en\s*)?)?(1361|3036|88|1631|60947|61008|61009|4293|5419)\b`,
  'gi'
);
const SUPPLY_FUSE_BS_EN_LIM_PATTERN = new RegExp(
  String.raw`\b${FUSE_DEVICE}\s+(?:(?:of\s+)?(?:the\s+)?)?(?:bs\s*(?:en\s*)?)?(?:number|standard)?\s+(?:is\s+)?(?:a\s+)?(?:lim(?:itation|ited|b)?)\b`,
  'gi'
);
const SUPPLY_FUSE_RATING_PATTERN = new RegExp(
  String.raw`\b${FUSE_DEVICE}\s+(?:is\s+)?(?:bs\s*(?:en\s*)?\w+\s+)?(?:and\s+(?:it'?s?\s+)?)?(?:(?:rated?|rating)\s+(?:at\s+)?)?(\d+)\s*(?:a(?:mps?)?)?\b`,
  'gi'
);
const SUPPLY_FUSE_LIM_PATTERN = new RegExp(
  String.raw`\b${FUSE_DEVICE}(?:\s+(?:current\s+)?(?:rating|size))?\s+(?:is\s+)?(?:a\s+)?(?:limitation|limited|lim)\b`,
  'gi'
);

// Per-circuit Zs
const ZS_EXCLUDE_PATTERN = /\bzs\s+(?:at|of)\s+(?:the\s+)?(?:board|db|distribution|cu|fuse)/gi;
const ZS_PATTERN = /\bzs\s+(?:is\s+|of\s+|=\s*)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ZS_FLEX_PATTERN =
  /\bzs\s+(?:for\s+|at\s+|on\s+)?(?:\w+\s+){0,5}(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;

// R1/R2
const R1R2_PATTERN =
  /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:(?:for\s+circuit\s+\d+\s+(?:is\s+)?)?(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const R1R2_FLEX_PATTERN =
  /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:for\s+|on\s+)?(?:\w+[.,;:\s]+){0,5}(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const RING_R1_PATTERN =
  /\b(?:ring\s+)?r\s*1\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const EXPLICIT_RING_R1_PATTERN =
  /\bring\s+r\s*1\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const RING_RN_PATTERN =
  /\b(?:rn|neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const RING_R2_PATTERN =
  /\b(?:ring\s+)?r\s*2\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const EXPLICIT_RING_R2_PATTERN =
  /\bring\s+r\s*2\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;

// Discontinuous continuity (mirrors Swift lines 601-624)
const DISCONTINUOUS_CUE =
  '(?:discontinuous|open[- ]?circuit|open[- ]?loop|infinity|infinite|broken|o/?c)';
const R1R2_DISCONT = new RegExp(
  String.raw`\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:is\s+|reads?\s+|reading\s+(?:is\s+)?)?` +
    DISCONTINUOUS_CUE,
  'gi'
);
const RING_R1_DISCONT = new RegExp(
  String.raw`\bring\s+r\s*1\s+(?:is\s+|reads?\s+)?` + DISCONTINUOUS_CUE,
  'gi'
);
const RING_RN_DISCONT = new RegExp(
  String.raw`\b(?:rn|neutrals?|nuts)\s+(?:(?:is|are)\s+|reads?\s+)?` + DISCONTINUOUS_CUE,
  'gi'
);
const RING_R2_DISCONT = new RegExp(
  String.raw`\bring\s+r\s*2\s+(?:is\s+|reads?\s+)?` + DISCONTINUOUS_CUE,
  'gi'
);
const RING_LIVES_DISCONT = new RegExp(
  String.raw`\blives?\s+(?:(?:is|are)\s+|read(?:s|ing)?\s+)?` + DISCONTINUOUS_CUE,
  'gi'
);
const RING_EARTHS_DISCONT = new RegExp(
  String.raw`\bearths?\s+(?:(?:is|are)\s+|read(?:s|ing)?\s+)?` + DISCONTINUOUS_CUE,
  'gi'
);
export const DISCONTINUOUS_SENTINEL = '∞';

// Insulation resistance
const IR_LE_PATTERN =
  /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-–]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)(?:\s*(?:mega?\s*ohms?|MΩ|grooms?|meg))?/gi;
const IR_GREATER =
  /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-–]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/gi;
const IR_BRIDGING =
  /\b(?:ir|insulation\s+resistance|inssy|megger)\s+(?:.*?circuit\s+\d+.*?)(?:(?:is|was|reads?)\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const IR_LL_PATTERN =
  /\b(?:live\s+to\s+(?:lives?|neutral)|l[-–]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const IR_LL_GREATER =
  /\b(?:live\s+to\s+(?:lives?|neutral)|l[-–]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/gi;
const IR_LE_POSTFIX =
  /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/gi;
const IR_LE_POSTFIX_GREATER =
  /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/gi;
const IR_LL_POSTFIX =
  /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/gi;
const IR_LL_POSTFIX_GREATER =
  /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/gi;
// P3 (2026-07-23, feedback id 86) — the instant-regex writes land BEFORE
// backend validation, so the client matcher must obey the SAME exact-four-form
// LIM policy (lim/limb/limp/limitation). The old `lim(itation|ited|b)?` group
// matched `limited` (a near-match that must NOT coerce) and missed `limp`;
// narrowed to the exact four forms so a near-match produces NO client write.
const IR_LE_LIM =
  /\b(?:(?:live|light)\s+(?:to\s+)?earth|l[-–]?e|ir\s+live\s+(?:to\s+)?earth)\s+(?:(?:is|was)\s+)?(?:a\s+)?(?:lim|limb|limp|limitation)\b/gi;
const IR_LL_LIM =
  /\b(?:live\s+to\s+(?:lives?|neutral)|l[-–]l)\s+(?:(?:is|are)\s+)?(?:a\s+)?(?:lim|limb|limp|limitation)\b/gi;
const TEST_VOLTAGE_PATTERN = /\b(?:test\s+)?voltage\s+(?:is\s+|of\s+|=\s*)?(\d+)/gi;

// RCD / OCPD
// field-feedback-2026-07-14 F8: "ICD" is a live Deepgram garble of "RCD"
// ("ICD trip time" — session 6B6FE011 06:24). Enumerated alias with field
// evidence, same class as lim/tryptoid; NO broad fuzzy correction
// (parity-program §3E stands). iOS canon: rcdTimePattern /
// rcdTimeFlexPattern (commit 67ffb9d).
const RCD_TIME_PATTERN =
  /\b(?:rcd|icd)\s+(?:trip\s+(?:time\s+)?)?(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;
const RCD_TIME_FLEX =
  /\b(?:(?:rcd|icd)\s+)?trip\s+time\s+(?:for\s+|on\s+)?(?:\w+\s+){0,5}(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;
const OCPD_RATING_BEFORE =
  /\b(\d+)\s*(?:amp|amber|a)\s+(?:mcb|rcbo|rccb|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker)/gi;
const OCPD_RATING_AFTER =
  /\b(?:mcb|rcbo|rccb|breaker|circuit\s+breaker|miniature\s+circuit\s+breaker)\s+(?:is\s+|rated?\s+(?:at\s+)?)?(\d+)\s*(?:amp|a)?/gi;
const OCPD_TYPE_PATTERN = /\btype\s+(?:is\s+)?([a-d])\b/gi;
const WIRING_OR_REF_BEFORE_TYPE =
  /\b(?:wir\w+|worrying|cable|ref\w*|reference|installation)\s+type\s+(?:is\s+)?[a-g]\b/gi;
const OCPD_DEVICE_PATTERN = /\b(mcb|rcbo|rccb)\b/gi;
const BS_EN_STANDARD_PATTERN = /\b(60898|61009|60909)\b/gi;
const OCPD_COMPOSITE_PATTERN =
  /\b(?:bs\s*(?:en)?\s*)?(60898|61009|60909)\s+(?:(?:type|time(?:\s+for)?)\s+([a-d]))?\s*(\d+)?\s*(?:amp|amber|a)?/gi;
const WIRING_TYPE_PATTERN =
  /\b(?:wir(?:ing|rying|ring)|worrying|cable)\s+type\s+(?:is\s+)?([a-h]|o)\b/gi;
const REF_METHOD_PATTERN =
  /\b(?:ref(?:erence)?\s+method|(?:wir(?:ing|rying|ring)|worrying)\s+method|installation\s+method)\s+(?:is\s+)?([a-g]|10[0-3])\b/gi;
const REF_METHOD_NUMERIC_BARE = /\bis\s+(10[1-3])\b/gi;
const POLARITY_PATTERN = /\b(?:correct\s+)?polarity\s+(?:is\s+)?(?:ok|confirmed|pass|correct)/gi;
const RCD_BUTTON_PATTERN =
  /\b(?:rcd\s+)?(?:(?:test|push)\s+)?button\s+(?:is\s+)?(?:ok|works|confirmed|pass)/gi;
const RCD_BUTTON_ALL_PATTERN =
  /\b(?:rcd\s+)?(?:(?:test|push)\s+)?button\s+(?:is\s+)?(?:ok|works|confirmed|pass)\s+(?:for\s+)?(?:all|every|both)\s+circuits?/gi;
const RCD_TYPE_PATTERN =
  /\b(?:rcd\s+(?:is\s+)?type\s+|type\s+(?:is\s+)?(?=(?:AC|A-?S|B-?S|B\s*\+|B\s*plus)\b))(AC|A-?S|B-?S|B\s*\+|B\s*plus|A|B|F|S)\b/gi;
const RCD_TYPE_BEFORE =
  /\b(?:type\s+)?(AC|A-?S|B-?S|B\s*\+|B\s*plus|A|B|F|S)\s+(?:type\s+)?(?:rcd|residual)\b/gi;
const RCD_TYPE_SELECTIVE = /\b(selective|time[- ]?delayed)\s+(?:rcd|residual)\b/gi;
const AFDD_PATTERN = /\bafdd\s+(?:(?:test\s+)?button\s+)?(?:is\s+)?(?:ok|works|confirmed|fitted)/gi;
const CABLE_SIZE_PATTERN =
  /\b(?:cable\s+size|size\s+of\s+(?:the\s+)?cable)\s+(?:is\s+)?(\d+\.?\d*)\s*(?:mm|mil)?\s*(?:squared|sq)?/gi;
const CPC_SIZE_PATTERN =
  /\b(?:(?:earth|cpc|protective\s+conductor)\s+(?:wiring\s+)?(?:size|csa)|(?:earth|cpc)\s+(?:is\s+)?(\d)|size\s+of\s+(?:the\s+)?(?:earth|cpc))\s+(?:is\s+)?(\d+\.?\d*)\s*(?:mm|mil)?\s*(?:squared|sq)?/gi;
const NUMBER_OF_POINTS_PATTERN =
  /\b(?:number\s+(?:of\s+)?points|points)[,;:\s]+(?:is\s+|are\s+)?(\d+)/gi;
const NUMBER_OF_POINTS_FLEX =
  /\b(?:number\s+(?:of\s+)?points)\s+(?:for\s+|on\s+)?(?:\w+\s+){0,5}(?:is\s+|are\s+)?(\d+)/gi;
const NUMBER_OF_POINTS_REVERSE = /\b(\d+)\s+points\b/gi;

// Bonding
const BONDING_WATER =
  /\b(?:bonding?\s+(?:(?:to|with)\s+)?(?:the\s+)?water|water\s+bonding?\s*(?:is\s+)?(?:confirmed|ok|yes|done|pass|present|installed))/gi;
const BONDING_GAS =
  /\b(?:bonding?\s+(?:(?:to|with)\s+)?(?:the\s+)?gas|gas\s+bonding?\s*(?:is\s+)?(?:confirmed|ok|yes|done|pass|present|installed))/gi;
const BONDING_COMBINED =
  /\bbonding?\s+(?:(?:to|with)\s+)?(?:the\s+)?(?:water\s+and\s+(?:(?:to|with)\s+)?(?:the\s+)?gas|gas\s+and\s+(?:(?:to|with)\s+)?(?:the\s+)?water)/gi;
const BONDING_WATER_GAP = /\bbonding\b.{0,50}\b(?:to|with)\s+(?:the\s+)?water\b/gi;
const BONDING_GAS_GAP = /\bbonding\b.{0,50}\b(?:to|with)\s+(?:the\s+)?gas\b/gi;
const BONDING_COMBINED_GAP =
  /\bbonding\b.{0,50}\b(?:to|with)\s+(?:the\s+)?(?:water\s+and\s+(?:(?:to|with)\s+)?(?:the\s+)?gas|gas\s+and\s+(?:(?:to|with)\s+)?(?:the\s+)?water)/gi;

// Earth electrode
const EARTH_ELECTRODE_TYPE =
  /\b(?:earth\s+)?electrode\s+(?:type\s+(?:is\s+)?)?(?:is\s+)?(?:a\s+)?(rod|plate|tape|mat|other)\b/gi;
const EARTH_ROD_SHORT = /\bearth\s+rod\b/gi;
const EARTH_ELECTRODE_RES =
  /\b(?:resistance\s+(?:to\s+)?earth|earth\s+(?:electrode\s+)?resistance|r\s*a(?:\s+value)?)\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)\s*(?:ohms?|Ω)?/gi;

// Ring continuity natural language
const RING_LIVES = /\blives?\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const RING_NEUTRALS =
  /\b(?:neutrals?|nuts)\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const RING_EARTHS =
  /\bearths?\s+(?:(?:is|are)\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)(?:\s*(?:ohms?|Ω))?/gi;

// Board fields
const MANUFACTURER_PATTERN =
  /\b(hager|mk|wylex|crabtree|bg|british\s+general|schneider|square\s+d|eaton)\b/gi;
const ZS_AT_BOARD_PATTERN =
  /\b(?:zs|ze)\s+(?:at\s+(?:the\s+)?)?(?:board|d\s*b|distribution|cu|fuse\s*board)\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ZS_AT_BOARD_LOOSE =
  /\b(?:at\s+(?:the\s+)?(?:board|d\s*b|distribution|cu|fuse\s*board)|(?:board|d\s*b|distribution|cu|fuse\s*board)\s+is\s+also)\s+(?:is\s+)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const ZE_AT_BOARD_EXCLUDE = /\bze\s+(?:at|of)\s+(?:the\s+)?(?:board|d\s*b|distribution|cu|fuse)/gi;

// Board switch
const BOARD_NUMBER_PATTERN =
  /\b(?:(?:d\s*b|board|consumer\s+unit|distribution\s+board|fuse\s*board|c\s*u)\s*(?:number\s+)?(\d+)|(?:second|third|fourth|fifth)\s+(?:board|consumer\s+unit|distribution\s+board|fuse\s*board|c\s*u))/gi;
const BOARD_NAMED_PATTERN =
  /\b(?:(?:going|moving|switched?|on|now\s+on|over\s+to)\s+(?:to\s+)?(?:the\s+)?)?(?:(garage|shed|outbuilding|annex|extension|loft|attic|basement|kitchen|utility|conservatory|first\s+floor|second\s+floor|ground\s+floor|upstairs|downstairs|rear|front|external|outside|main)\s+(?:board|consumer\s+unit|distribution\s+board|fuse\s*board|c\s*u|d\s*b))/gi;
const BOARD_SUB_PATTERN = /\b(?:sub[\s-]?(?:board|main|distribution))/gi;
const BOARD_MAIN_PATTERN =
  /\b(?:(?:back\s+to\s+)?(?:the\s+)?main\s+(?:board|consumer\s+unit|distribution\s+board|fuse\s*board|c\s*u|d\s*b))/gi;

// Installation
const CLIENT_PATTERN =
  /\b(?:client|customer|owner|homeowner)(?:\s+name)?\s+(?:is\s+|name\s+is\s+)(?:mrs?\s+|miss\s+|dr\s+)?(.+?)(?:\.|,|$)/gim;
const ADDRESS_PATTERN =
  /\b(?:address|property\s+at|located\s+at|premises\s+(?:is\s+)?(?:at\s+)?)\s+(?:is\s+|at\s+)?(\d+[.\s]+\w[\w\s,.]+?)(?:,\s*(?:next|recommend|client|customer|earthing|ze|pfc)|supplies|supply|\bin\b|$)/gim;
const PREMISES_PATTERN = /\b(residential|commercial|industrial|domestic|agricultural)\b/gi;
const NEXT_INSPECTION_PATTERN = /\b(?:next\s+inspection|recommend)\s+(?:in\s+)?(\d+)\s*years?/gi;
const CLIENT_PHONE_PATTERN =
  /\b(?:client|customer)\s+(?:phone|number|tel|telephone|mobile)\s+(?:is\s+|number\s+)?[:\s]\s*(.+?)$/gim;
const CLIENT_EMAIL_PATTERN =
  /\b(?:client|customer)\s+(?:email|e-mail)\s+(?:is\s+|address\s+)?[:\s]\s*(.+?)$/gim;
const OCCUPIER_NAME_PATTERN =
  /\b(?:occupier|occupant|tenant|resident)\s+(?:name\s+)?(?:is\s+|[:\s]\s*)(.+?)(?:\.|,|$)/gim;
const REASON_FOR_REPORT_PATTERN =
  /\b(?:reason|purpose)\s+(?:for|of)\s+(?:the\s+)?(?:report|inspection|eicr|test)\s+(?:is\s+)?[:\s]\s*(.+?)$/gim;
const DATE_OF_PREVIOUS_INSPECTION_PATTERN =
  /\b(?:previous|last|prior)\s+(?:inspection|test|eicr)\s+(?:date\s+|was\s+)?[:\s]\s*(.+?)$/gim;
// **Deviation from Swift:** the Swift pattern `\s+(?:is\s+|was\s+)?[:\s]\s*`
// requires a literal `:` OR extra whitespace AFTER "is "/`was ` consumed
// the natural separator. For input "date of inspection is 18th March 2026"
// (the iOS test fixture) the pattern fails — Swift's test was either
// shipping broken or never run. The TS port relaxes the post-phrase
// separator to `\s*(?:is|was)?[:\s]+` so all three natural forms match:
//   • "date of inspection: 18th"  (colon)
//   • "date of inspection is 18th"  (verb)
//   • "date of inspection 18th"  (bare)
// This is the only place the matcher knowingly diverges from the Swift
// regex — documented per user-rule "iOS is canon for parity, deviations
// only where Swift→JS language mechanics demand them".
const DATE_OF_INSPECTION_PATTERN =
  /\b(?:(?:date\s+(?:of\s+)?(?:inspection|test(?:ing)?)|inspection\s+date|test\s+date|today'?s?\s+date)\s*(?:is|was)?[:\s]+|(?:tested|inspected|inspection\s+carried\s+out|carried\s+out)\s+(?:on\s+)?(?:the\s+)?)(.+?)$/gim;
const PREVIOUS_CERT_NUMBER_PATTERN =
  /\b(?:previous|last|prior)\s+(?:certificate|cert)\s+(?:number|ref|reference)\s*[:\s]\s*(.+?)$/gim;
const ESTIMATED_AGE_PATTERN =
  /\b(?:estimated|installation)\s+(?:age|years?\s+old)\s*(?:is\s+|of\s+installation\s+)?[:\s]\s*(.+?)$/gim;
const GENERAL_CONDITION_PATTERN =
  /\b(?:general\s+condition|overall\s+condition|condition\s+of\s+(?:the\s+)?installation)\s*(?:is\s+)?[:\s]\s*([^.!?\n]{3,150}?)(?=[.!?\n]|$)/gim;
const CLIENT_SAME_ADDRESS_PATTERN =
  /\b(?:client|customer)\s+(?:is\s+)?(?:at\s+)?(?:the\s+)?same\s+address|same\s+address\s+(?:for|as)\s+(?:the\s+)?(?:client|customer)|client\s+address\s+(?:is\s+)?(?:the\s+)?same/gim;
const CLIENT_ADDRESS_PATTERN =
  /\b(?:(?:client|customer)\s+(?:address\s+)?(?:is\s+|at\s+|lives\s+at\s+)?|(?:this\s+)?report\s+(?:is\s+)?for\s+|billing\s+address\s+(?:is\s+)?)(\d+[.\s]+\w[\w\s,.]+?)(?:,\s*(?:next|recommend|occupier|earthing|ze|pfc)|supplies|supply|\bin\b|$)/gim;
const POSTCODE_PATTERN = /\b(?:post\s*code\s+(?:is\s+)?)?([A-Z]{1,2}\d[0-9A-Z]?\s*\d[A-Z]{2})\b/gi;
const POSTCODE_FINAL_VALIDATION = /^[A-Z]{1,2}\d[0-9A-Z]?\s?\d[A-Z]{2}$/;

// Compound phrases (mirrors Swift lines 1240-1262)
const ZS_COMPOUND =
  /\bzs\s+(?:for|on|at)\s+(.+?)\s+(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const R1R2_COMPOUND =
  /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:for|on|at)\s+(.+?)\s+(?:is\s+|reading\s+(?:is\s+)?)?(?:(?:naught|nought|zero|oh)\s+)?(\d+\.?\d*)/gi;
const IR_LE_COMPOUND =
  /\b(?:live|light)\s+to\s+earth\s+(?:for|on|at)\s+(.+?)\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const IR_LL_COMPOUND =
  /\b(?:live\s+to\s+(?:lives?|neutral))\s+(?:for|on|at)\s+(.+?)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;
const POINTS_COMPOUND =
  /\b(?:number\s+(?:of\s+)?points)\s+(?:for|on|at)\s+(.+?)\s+(?:is\s+|are\s+)?(\d+)/gi;
const RCD_COMPOUND =
  /\b(?:rcd\s+)?trip\s+time\s+(?:for|on|at)\s+(.+?)\s+(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;

// MARK: — Regex helpers (mirrors Swift lines 2107-2140)

/** Reset RegExp.lastIndex before scanning so /g/ regexes work
 *  deterministically across calls. */
function freshScan(re: RegExp): RegExp {
  re.lastIndex = 0;
  return re;
}

function hasMatch(re: RegExp, text: string): boolean {
  return freshScan(re).test(text);
}

function lastCapture(re: RegExp, text: string, group: number = 1): string | undefined {
  let lastMatch: RegExpExecArray | null = null;
  freshScan(re);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastMatch = m;
    if (re.lastIndex === m.index) re.lastIndex += 1; // zero-width safety
  }
  if (!lastMatch) return undefined;
  return lastMatch[group < lastMatch.length ? group : 0];
}

function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | null = null;
  freshScan(re);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return last ?? undefined;
}

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  freshScan(re);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return out;
}

// MARK: — JobDetail accessors

function circuitRefOf(row: CircuitRow): string {
  const v = (row as { circuit_ref?: unknown }).circuit_ref;
  return typeof v === 'string' ? v : '';
}

function circuitDesignationOf(row: CircuitRow): string {
  const v = (row as { circuit_designation?: unknown }).circuit_designation;
  return typeof v === 'string' ? v : '';
}

// MARK: — Designation resolver

function resolveDesignation(rawDesig: string): string {
  const lower = rawDesig.toLowerCase().trim();
  if (DESIGNATION_MAP[lower]) return DESIGNATION_MAP[lower];
  for (const prefix of LOCATION_PREFIXES) {
    if (lower.startsWith(prefix + ' ')) {
      const base = lower.slice(prefix.length + 1).trim();
      const mapped = DESIGNATION_MAP[base];
      if (mapped) {
        const titleCased = prefix.replace(/\b\w/g, (c) => c.toUpperCase());
        return `${titleCased} ${mapped}`;
      }
    }
  }
  // Capitalised fallback (mirrors Swift `rawDesig.capitalized` — first
  // letter of each word uppercase).
  return rawDesig.replace(/\b\w/g, (c) => c.toUpperCase());
}

// MARK: — Postcode collapse

function normaliseSpacedPostcodes(text: string): string {
  // Fully-spaced: "r g 301 d n" → "RG301DN"
  let result = text.replace(SPACED_POSTCODE_2L, (m, l1, l2, digits, l3, l4) => {
    const collapsed = `${String(l1).toUpperCase()}${String(l2).toUpperCase()}${digits}${String(l3).toUpperCase()}${String(l4).toUpperCase()}`;
    return POSTCODE_FORMAT_VALIDATION.test(collapsed) ? collapsed : m;
  });
  // Partially-spaced: "RG 317 A Q" → "RG317AQ"
  result = result.replace(PARTIAL_SPACED_POSTCODE, (m, prefix, digits, l1, l2) => {
    const collapsed = `${String(prefix).toUpperCase()}${digits}${String(l1).toUpperCase()}${String(l2).toUpperCase()}`;
    return POSTCODE_FORMAT_VALIDATION.test(collapsed) ? collapsed : m;
  });
  return result;
}

// MARK: — Transcript normalisation

export function normalizeTranscript(text: string): string {
  let result = text;

  // 0. Strip Deepgram sentence-ending periods after "is"/"are".
  result = result.replace(VERB_PERIOD_STRIP_PATTERN, '$1 ');

  // 1. Spoken abbreviations.
  for (const [re, rep] of SPOKEN_ABBREVIATIONS) {
    result = result.replace(re, rep);
  }

  // 1b. Collapse spaced UK postcodes.
  result = normaliseSpacedPostcodes(result);

  // 2. Spoken decimals.
  result = result.replace(SPOKEN_DECIMAL_PATTERN_LOCAL, (m, w, d1, d2, d3) => {
    const intDigit = DIGIT_WORD_MAP[String(w).toLowerCase()] ?? '0';
    const f1 = DIGIT_WORD_MAP[String(d1).toLowerCase()] ?? '0';
    let rep = `${intDigit}.${f1}`;
    if (d2) {
      const f2 = DIGIT_WORD_MAP[String(d2).toLowerCase()];
      if (f2) rep += f2;
    }
    if (d3) {
      const f3 = DIGIT_WORD_MAP[String(d3).toLowerCase()];
      if (f3) rep += f3;
    }
    return rep;
  });
  result = result.replace(IMPLIED_ZERO_DECIMAL_PATTERN_LOCAL, (m, d1, d2) => {
    const f1 = DIGIT_WORD_MAP[String(d1).toLowerCase()] ?? '0';
    let rep = `0.${f1}`;
    if (d2) {
      const f2 = DIGIT_WORD_MAP[String(d2).toLowerCase()];
      if (f2) rep += f2;
    }
    return rep;
  });

  // 3. Spoken whole numbers (hundreds → tens+ones → teens → standalone tens).
  result = result.replace(HUNDREDS_PATTERN_LOCAL, (m, w) => {
    const lower = String(w).toLowerCase();
    const digit = lower === 'a' ? '1' : (DIGIT_WORD_MAP[lower] ?? lower);
    return `${digit}00`;
  });
  result = result.replace(TENS_ONES_PATTERN_LOCAL, (m, t, o) => {
    const td = TENS_MAP[String(t).toLowerCase()] ?? '0';
    const od = DIGIT_WORD_MAP[String(o).toLowerCase()] ?? '0';
    return `${td}${od}`;
  });
  result = result.replace(TEENS_PATTERN_LOCAL, (m, w) => TEENS_MAP[String(w).toLowerCase()] ?? m);
  result = result.replace(STANDALONE_TENS_PATTERN_LOCAL, (m, w) => {
    const td = TENS_MAP[String(w).toLowerCase()] ?? '0';
    return `${td}0`;
  });

  return result;
}

export function normaliseBeforeMatch(text: string): string {
  return normaliseNumbers(text);
}

// MARK: — Ring-circuit detection

function isRingCircuit(designation: string | undefined, transcript: string | undefined): boolean {
  if (designation && designation.trim().length > 0) {
    const des = designation.toLowerCase().trim();
    const ringKeywords = [
      'socket',
      'sockets',
      'ring',
      'ring main',
      'ring final',
      'ringmain',
      'continuity',
    ];
    if (ringKeywords.some((k) => des.includes(k))) return true;
  }
  // Fallback — content inference: ≥2 distinct conductor types + small ohm value.
  if (transcript && transcript.length > 0) {
    const text = transcript.toLowerCase();
    const conductorHits = allMatches(CONDUCTOR_TYPES_PATTERN, text);
    const distinct = new Set<string>();
    for (const m of conductorHits) {
      const word = m[0];
      if (word.startsWith('earth')) distinct.add('earth');
      else if (word.startsWith('live')) distinct.add('live');
      else if (word.startsWith('neutral') || word === 'nuts') distinct.add('neutral');
    }
    if (distinct.size >= 2) {
      const m = freshScan(RING_CONTENT_PATTERN).exec(text);
      if (m && m[1]) {
        const num = parseFloat(m[1]);
        if (Number.isFinite(num) && num >= 0.01 && num < 5.0) return true;
      }
    }
  }
  return false;
}

// MARK: — Date parser (mirrors Swift lines 2056-2103)

function parseTwoDigit(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

const MONTH_NAMES_LONG = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTH_NAMES_SHORT = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

function monthIndex(name: string): number | undefined {
  const lower = name.toLowerCase();
  let idx = MONTH_NAMES_LONG.indexOf(lower);
  if (idx >= 0) return idx + 1;
  idx = MONTH_NAMES_SHORT.indexOf(lower);
  if (idx >= 0) return idx + 1;
  return undefined;
}

export function parseSpokenDate(raw: string): Date | undefined {
  let text = raw.trim();
  if (text.toLowerCase().startsWith('the ')) text = text.slice(4);
  text = text.replace(/(\d{1,2})(?:st|nd|rd|th)\b/g, '$1');
  text = text.replace(/(\d{1,2})\s+of\s+/g, '$1 ');
  text = text.trim();

  // Numeric DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (UK convention)
  const numericDmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/;
  const dmy = numericDmy.exec(text);
  if (dmy) {
    const d = parseTwoDigit(dmy[1]);
    const m = parseTwoDigit(dmy[2]);
    const y = parseInt(dmy[3], 10);
    if (
      d !== undefined &&
      m !== undefined &&
      Number.isFinite(y) &&
      d >= 1 &&
      d <= 31 &&
      m >= 1 &&
      m <= 12
    ) {
      return new Date(y, m - 1, d);
    }
  }
  // ISO YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseTwoDigit(iso[2]);
    const d = parseTwoDigit(iso[3]);
    if (
      Number.isFinite(y) &&
      d !== undefined &&
      m !== undefined &&
      d >= 1 &&
      d <= 31 &&
      m >= 1 &&
      m <= 12
    ) {
      return new Date(y, m - 1, d);
    }
  }
  // "18 March 2026" — day month year
  const dmyNamed = /^(\d{1,2})[\s,]+([a-z]+)[\s,]+(\d{4})$/i.exec(text);
  if (dmyNamed) {
    const d = parseTwoDigit(dmyNamed[1]);
    const m = monthIndex(dmyNamed[2]);
    const y = parseInt(dmyNamed[3], 10);
    if (d !== undefined && m !== undefined && Number.isFinite(y) && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }
  // "March 18 2026" — month day year
  const mdyNamed = /^([a-z]+)[\s,]+(\d{1,2})[\s,]+(\d{4})$/i.exec(text);
  if (mdyNamed) {
    const m = monthIndex(mdyNamed[1]);
    const d = parseTwoDigit(mdyNamed[2]);
    const y = parseInt(mdyNamed[3], 10);
    if (m !== undefined && d !== undefined && Number.isFinite(y) && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }
  return undefined;
}

// MARK: — TranscriptFieldMatcher class

const MATCH_WINDOW_SIZE = 800;
const ACTIVE_CIRCUIT_REF_EXPIRY_SECONDS = 30;

export interface TranscriptFieldMatcherOptions {
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

export class TranscriptFieldMatcher {
  private readonly now: () => number;
  private lastProcessedOffset = 0;
  private activeCircuitRef: string | undefined;
  private activeCircuitRefTimestamp: number | undefined;

  constructor(opts: TranscriptFieldMatcherOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  reset(): void {
    this.lastProcessedOffset = 0;
    this.activeCircuitRef = undefined;
    this.activeCircuitRefTimestamp = undefined;
  }

  /**
   * Match transcript against all patterns. Uses a sliding window so each
   * call only scans the new text since the last call.
   *
   * **Cumulative-transcript contract:** caller must pass the WHOLE session
   * transcript so far (concatenation of every Deepgram final, separated
   * by spaces). Feeding individual utterances breaks the offset arithmetic
   * and silently suppresses cross-utterance matches like ring-continuity
   * carryover (codex review finding F2).
   */
  match(transcript: string, existingJob: JobDetail): RegexMatchResult {
    const newChars = transcript.length - this.lastProcessedOffset;
    if (newChars <= 0) return emptyRegexMatchResult();
    if (transcript.trim().length === 0) return emptyRegexMatchResult();

    // Sliding window aligned to nearest sentence boundary.
    let windowStart = Math.max(0, this.lastProcessedOffset - MATCH_WINDOW_SIZE);
    if (windowStart > 0) {
      const prefix = transcript.slice(0, windowStart + 60);
      // Find last sentence boundary at or before windowStart+60.
      const boundaries = [...prefix.matchAll(/[.!?\n]/g)];
      const lastBoundary = boundaries[boundaries.length - 1];
      if (lastBoundary !== undefined && lastBoundary.index !== undefined) {
        const boundaryPos = lastBoundary.index + 1; // upper bound of the matched char
        if (boundaryPos >= windowStart - 60) windowStart = boundaryPos;
      }
    }
    const window = transcript.slice(windowStart);

    this.lastProcessedOffset = transcript.length;

    // Expire active circuit ref (30s window).
    if (
      this.activeCircuitRefTimestamp !== undefined &&
      (this.now() - this.activeCircuitRefTimestamp) / 1000 > ACTIVE_CIRCUIT_REF_EXPIRY_SECONDS
    ) {
      this.activeCircuitRef = undefined;
      this.activeCircuitRefTimestamp = undefined;
    }

    // Normalise window only.
    const preNormalised = normaliseBeforeMatch(window);
    const normalised = normalizeTranscript(preNormalised);

    const result = emptyRegexMatchResult();

    this.detectBoardSwitch(normalised, result);
    this.detectNewCircuits(normalised, existingJob, result);
    this.matchSupplyFields(normalised, result);
    this.matchBoardFields(normalised, result);
    this.matchInstallationFields(normalised, result);

    // Global RCD button — apply to every non-spare circuit.
    if (hasMatch(RCD_BUTTON_ALL_PATTERN, normalised)) {
      for (const circuit of existingJob.circuits ?? []) {
        const ref = circuitRefOf(circuit);
        if (!ref) continue;
        if (circuitDesignationOf(circuit).toLowerCase() === 'spare') continue;
        const updates = result.circuit_updates[ref] ?? {};
        updates.rcd_button_confirmed = '✓';
        result.circuit_updates[ref] = updates;
      }
    }

    this.matchCompoundPhrases(normalised, existingJob, result);
    this.matchCircuitFieldsBySegment(normalised, existingJob, result);

    return result;
  }

  // MARK: — Compound phrase matching

  private matchCompoundPhrases(transcript: string, job: JobDetail, result: RegexMatchResult): void {
    const compounds: Array<{
      re: RegExp;
      apply: (ref: string, val: string, r: RegexMatchResult) => void;
    }> = [
      {
        re: ZS_COMPOUND,
        apply: (ref, val, r) => {
          const num = parseFloat(val);
          if (Number.isFinite(num) && num >= 0.01 && num <= 20.0) {
            const u = r.circuit_updates[ref] ?? {};
            u.measured_zs_ohm = val;
            r.circuit_updates[ref] = u;
          }
        },
      },
      {
        re: R1R2_COMPOUND,
        apply: (ref, val, r) => {
          const num = parseFloat(val);
          if (Number.isFinite(num) && num >= 0.01 && num <= 10.0) {
            const u = r.circuit_updates[ref] ?? {};
            u.r1_r2_ohm = val;
            r.circuit_updates[ref] = u;
          }
        },
      },
      {
        re: IR_LE_COMPOUND,
        apply: (ref, val, r) => {
          const u = r.circuit_updates[ref] ?? {};
          u.ir_live_earth_mohm = val;
          r.circuit_updates[ref] = u;
        },
      },
      {
        re: IR_LL_COMPOUND,
        apply: (ref, val, r) => {
          const u = r.circuit_updates[ref] ?? {};
          u.ir_live_live_mohm = val;
          r.circuit_updates[ref] = u;
        },
      },
      {
        re: POINTS_COMPOUND,
        apply: (ref, val, r) => {
          const u = r.circuit_updates[ref] ?? {};
          u.number_of_points = val;
          r.circuit_updates[ref] = u;
        },
      },
      {
        re: RCD_COMPOUND,
        apply: (ref, val, r) => {
          const num = parseFloat(val);
          if (Number.isFinite(num) && num >= 1 && num <= 1000) {
            const u = r.circuit_updates[ref] ?? {};
            u.rcd_time_ms = val;
            r.circuit_updates[ref] = u;
          }
        },
      },
    ];

    for (const { re, apply } of compounds) {
      const matches = allMatches(re, transcript);
      for (const m of matches) {
        const rawDesig = (m[1] ?? '').trim().replace(/\s+(?:is|reading|are|was)\s*$/, '');
        const designation = resolveDesignation(rawDesig);
        const value = m[2] ?? '';
        const circuit = (job.circuits ?? []).find(
          (c) => circuitDesignationOf(c).toLowerCase() === designation.toLowerCase()
        );
        if (!circuit) continue;
        const ref = circuitRefOf(circuit);
        if (!ref) continue;
        apply(ref, value, result);
      }
    }
  }

  // MARK: — Circuit-field segmentation

  private matchCircuitFieldsBySegment(
    transcript: string,
    job: JobDetail,
    result: RegexMatchResult
  ): void {
    const refMatches = allMatches(CIRCUIT_REF_PATTERN, transcript);
    const path1Refs = new Set<string>();

    if (refMatches.length > 0) {
      // Path 1: explicit "circuit N" — segment by ref position.
      for (let i = 0; i < refMatches.length; i++) {
        const refMatch = refMatches[i];
        const ref = extractCircuitRef(refMatch);
        if (!ref) continue;
        this.activeCircuitRef = ref;
        this.activeCircuitRefTimestamp = this.now();
        path1Refs.add(ref);

        const segStart = (refMatch.index ?? 0) + refMatch[0].length;
        const segEnd =
          i + 1 < refMatches.length
            ? (refMatches[i + 1].index ?? transcript.length)
            : transcript.length;
        if (segEnd <= segStart) continue;
        const segText = transcript.slice(segStart, segEnd);
        this.matchCircuitFields(segText, job, ref, result);
      }

      // Orphaned text BEFORE first circuit ref — designation-anchored fields.
      const firstRefStart = refMatches[0].index ?? 0;
      if (firstRefStart > 20) {
        const orphanedText = transcript.slice(0, firstRefStart);
        const orphanedDesigs = allMatches(DESIGNATION_PATTERN, orphanedText);
        for (const desigMatch of orphanedDesigs) {
          const rawDesig = desigMatch[1] ?? '';
          const designation = resolveDesignation(rawDesig);
          const circuit = (job.circuits ?? []).find(
            (c) => circuitDesignationOf(c).toLowerCase() === designation.toLowerCase()
          );
          if (!circuit) continue;
          const ref = circuitRefOf(circuit);
          if (!ref) continue;
          this.matchCircuitFields(orphanedText, job, ref, result);
        }
      }
    }

    // Path 2: designation-anchored matching (also runs when Path 1 hit refs).
    const desigMatches = allMatches(DESIGNATION_PATTERN, transcript);
    if (desigMatches.length === 0) {
      // Path 3: active circuit ref carryover.
      if (this.activeCircuitRef !== undefined && this.activeCircuitRefTimestamp !== undefined) {
        this.matchCircuitFields(transcript, job, this.activeCircuitRef, result);
      }
      return;
    }

    for (let i = 0; i < desigMatches.length; i++) {
      const desigMatch = desigMatches[i];
      const rawDesig = desigMatch[1] ?? '';
      const designation = resolveDesignation(rawDesig);
      const circuit = (job.circuits ?? []).find(
        (c) => circuitDesignationOf(c).toLowerCase() === designation.toLowerCase()
      );
      if (!circuit) continue;
      const ref = circuitRefOf(circuit);
      if (!ref) continue;
      if (path1Refs.has(ref)) continue; // skip — already matched in Path 1

      const fwdStart = (desigMatch.index ?? 0) + desigMatch[0].length;
      const fwdEnd =
        i + 1 < desigMatches.length
          ? (desigMatches[i + 1].index ?? transcript.length)
          : transcript.length;
      const prevEnd = i > 0 ? (desigMatches[i - 1].index ?? 0) + desigMatches[i - 1][0].length : 0;
      const lookbackStart = Math.max(prevEnd, (desigMatch.index ?? 0) - 80);
      const segText = transcript.slice(lookbackStart, fwdEnd);
      void fwdStart; // segText already includes the lookback span
      this.matchCircuitFields(segText, job, ref, result);
    }
  }

  // MARK: — New circuit detection

  private detectNewCircuits(text: string, job: JobDetail, result: RegexMatchResult): void {
    const refMatches = allMatches(CIRCUIT_REF_PATTERN, text);
    const desigMatches = allMatches(DESIGNATION_PATTERN, text);

    for (const refMatch of refMatches) {
      const ref = extractCircuitRef(refMatch);
      if (!ref) continue;
      const refEnd = (refMatch.index ?? 0) + refMatch[0].length;

      for (const desigMatch of desigMatches) {
        const dist = Math.abs((desigMatch.index ?? 0) - refEnd);
        if (dist >= 80) continue;

        const rawDesig = desigMatch[1] ?? '';
        const designation = resolveDesignation(rawDesig);
        const exists = (job.circuits ?? []).some((c) => circuitRefOf(c) === ref);
        const queued = result.new_circuits.some((n) => n.circuit_ref === ref);
        if (!exists && !queued) {
          result.new_circuits.push({ circuit_ref: ref, designation });
        }
        break;
      }
    }
  }

  // MARK: — Supply fields

  private matchSupplyFields(text: string, result: RegexMatchResult): void {
    const zeAtBoard = hasMatch(ZE_AT_BOARD_EXCLUDE, text);
    if (!zeAtBoard) {
      const v = lastCapture(ZE_PATTERN, text) ?? lastCapture(ZE_FLEX_PATTERN, text);
      if (v !== undefined) {
        const num = parseFloat(v);
        if (Number.isFinite(num) && num >= 0.01 && num <= 5.0) {
          result.supply_updates.ze = v;
        } else if (v.startsWith('0') && !v.includes('.') && v.length >= 3) {
          const implied = '0.' + v.slice(1);
          const n = parseFloat(implied);
          if (Number.isFinite(n) && n >= 0.01 && n <= 5.0) {
            result.supply_updates.ze = implied;
          }
        }
      }
    }

    const pfcVal = lastCapture(PFC_PATTERN, text);
    if (pfcVal !== undefined) {
      const num = parseFloat(pfcVal);
      if (Number.isFinite(num) && num >= 0.1) {
        if (num <= 20.0) {
          result.supply_updates.pfc = pfcVal;
        } else if (num > 20 && num <= 2000) {
          const normalised = num / 100.0;
          if (normalised >= 0.1 && normalised <= 20.0) {
            const formatted = normalised % 1 === 0 ? normalised.toFixed(0) : normalised.toFixed(2);
            result.supply_updates.pfc = formatted;
          }
        } else if (num > 2000 && num <= 20000) {
          const normalised = num / 1000.0;
          if (normalised >= 0.1 && normalised <= 20.0) {
            result.supply_updates.pfc = normalised.toFixed(2);
          }
        }
      }
    }

    const earthing = lastCapture(EARTHING_PATTERN, text, 0);
    if (earthing !== undefined) {
      const norm = EARTHING_MAP[earthing.toLowerCase()] ?? earthing.toUpperCase();
      result.supply_updates.earthing_arrangement = norm;
    }

    if (hasMatch(SUPPLY_POLARITY_PATTERN, text)) {
      result.supply_updates.supply_polarity_confirmed = true;
    }

    const earthCsa = lastCapture(MAIN_EARTH_CSA_PATTERN, text);
    if (earthCsa !== undefined) {
      const n = parseFloat(earthCsa);
      if (Number.isFinite(n) && n >= 1.0 && n <= 50.0)
        result.supply_updates.main_earth_csa = earthCsa;
    }
    const bondingCsa = lastCapture(BONDING_CSA_PATTERN, text);
    if (bondingCsa !== undefined) {
      const n = parseFloat(bondingCsa);
      if (Number.isFinite(n) && n >= 1.0 && n <= 50.0)
        result.supply_updates.bonding_csa = bondingCsa;
    }

    if (hasMatch(BONDING_COMBINED, text) || hasMatch(BONDING_COMBINED_GAP, text)) {
      result.supply_updates.bonding_water = 'PASS';
      result.supply_updates.bonding_gas = 'PASS';
      result.supply_updates.main_bonding_continuity = 'PASS';
    } else {
      if (hasMatch(BONDING_WATER, text) || hasMatch(BONDING_WATER_GAP, text)) {
        result.supply_updates.bonding_water = 'PASS';
        result.supply_updates.main_bonding_continuity = 'PASS';
      }
      if (hasMatch(BONDING_GAS, text) || hasMatch(BONDING_GAS_GAP, text)) {
        result.supply_updates.bonding_gas = 'PASS';
        result.supply_updates.main_bonding_continuity = 'PASS';
      }
    }

    const tails = lastCapture(TAILS_CSA_PATTERN, text);
    if (tails !== undefined) {
      const n = parseFloat(tails);
      if (Number.isFinite(n) && n >= 1.0 && n <= 50.0)
        result.supply_updates.main_switch_conductor_csa = tails;
    }

    const electrodeType = lastCapture(EARTH_ELECTRODE_TYPE, text);
    if (electrodeType !== undefined) {
      result.supply_updates.earth_electrode_type = electrodeType.toLowerCase();
    } else if (hasMatch(EARTH_ROD_SHORT, text)) {
      result.supply_updates.earth_electrode_type = 'rod';
    }

    const electrodeRes = lastCapture(EARTH_ELECTRODE_RES, text);
    if (electrodeRes !== undefined) {
      const n = parseFloat(electrodeRes);
      if (Number.isFinite(n) && n >= 0.1 && n <= 1000) {
        result.supply_updates.earth_electrode_resistance = electrodeRes;
      }
    }

    const rawVoltage = lastCapture(SUPPLY_VOLTAGE_PATTERN, text);
    if (rawVoltage !== undefined) {
      const cleaned = rawVoltage.replace(/\s/g, '');
      const num = parseInt(cleaned, 10);
      if (Number.isFinite(num) && num >= 100 && num <= 500) {
        result.supply_updates.nominal_voltage = String(num);
      }
    }
    const freq = lastCapture(SUPPLY_FREQUENCY_PATTERN, text);
    if (freq !== undefined) {
      const n = parseInt(freq, 10);
      if (Number.isFinite(n) && n >= 45 && n <= 65) result.supply_updates.nominal_frequency = freq;
    }

    // Supply protective device / DNO cutout / "main fuse" → spd_* (Option A).
    const fuseBs = lastCapture(SUPPLY_FUSE_BS_EN_PATTERN, text);
    if (fuseBs !== undefined) {
      result.supply_updates.spd_bs_en = BS_EN_MAP[fuseBs] ?? fuseBs;
    }
    const fuseRating = lastCapture(SUPPLY_FUSE_RATING_PATTERN, text);
    if (fuseRating !== undefined) {
      const n = parseInt(fuseRating, 10);
      if (Number.isFinite(n) && n >= 16 && n <= 400) {
        result.supply_updates.spd_rated_current = fuseRating;
      }
    } else if (hasMatch(SUPPLY_FUSE_LIM_PATTERN, text)) {
      result.supply_updates.spd_rated_current = 'LIM';
    }
    if (
      result.supply_updates.spd_bs_en === undefined &&
      hasMatch(SUPPLY_FUSE_BS_EN_LIM_PATTERN, text)
    ) {
      result.supply_updates.spd_bs_en = 'LIM';
    }

    // Consumer-unit main switch / isolator → main_switch_* (unchanged target).
    const switchBs = lastCapture(MAIN_SWITCH_BS_EN_PATTERN, text);
    if (switchBs !== undefined) {
      result.supply_updates.main_switch_bs_en = BS_EN_MAP[switchBs] ?? switchBs;
    }
    const switchRating = lastCapture(MAIN_SWITCH_RATING_PATTERN, text);
    if (switchRating !== undefined) {
      const n = parseInt(switchRating, 10);
      if (Number.isFinite(n) && n >= 16 && n <= 400) {
        result.supply_updates.main_switch_current = switchRating;
      }
    } else if (hasMatch(MAIN_SWITCH_LIM_PATTERN, text)) {
      result.supply_updates.main_switch_current = 'LIM';
    }
    if (
      result.supply_updates.main_switch_bs_en === undefined &&
      hasMatch(MAIN_SWITCH_BS_EN_LIM_PATTERN, text)
    ) {
      result.supply_updates.main_switch_bs_en = 'LIM';
    }
  }

  // MARK: — Board fields

  private matchBoardFields(text: string, result: RegexMatchResult): void {
    const mfg = lastCapture(MANUFACTURER_PATTERN, text, 0);
    if (mfg !== undefined) {
      const lower = mfg.toLowerCase();
      let normalized: string;
      if (lower === 'bg' || lower === 'british general') normalized = 'British General';
      else if (lower === 'square d') normalized = 'Square D';
      else normalized = mfg.replace(/\b\w/g, (c) => c.toUpperCase());
      result.board_updates.manufacturer = normalized;
    }

    const zb = lastCapture(ZS_AT_BOARD_PATTERN, text) ?? lastCapture(ZS_AT_BOARD_LOOSE, text);
    if (zb !== undefined) {
      const n = parseFloat(zb);
      if (Number.isFinite(n) && n >= 0.01 && n <= 20.0) result.board_updates.ze_at_db = zb;
    }
  }

  // MARK: — Installation fields

  private matchInstallationFields(text: string, result: RegexMatchResult): void {
    const isValidMultiWord = (v: string, minLength = 2): boolean =>
      v.length >= minLength && !STOP_WORDS.has(v.toLowerCase());

    const client = lastCapture(CLIENT_PATTERN, text);
    if (client !== undefined) {
      const trimmed = client.trim();
      if (trimmed.length <= 100 && isValidMultiWord(trimmed, 2)) {
        result.installation_updates.client_name = trimmed;
      }
    }

    if (hasMatch(CLIENT_SAME_ADDRESS_PATTERN, text)) {
      result.installation_updates.client_address_same_as_installation = true;
    }

    let clientAddressMatched = false;
    const clientAddr = lastCapture(CLIENT_ADDRESS_PATTERN, text);
    if (clientAddr !== undefined) {
      const trimmed = clientAddr.trim();
      if (trimmed.length <= 200 && isValidMultiWord(trimmed, 5)) {
        result.installation_updates.client_address = trimmed;
        clientAddressMatched = true;
      }
    }

    if (!clientAddressMatched) {
      const addr = lastCapture(ADDRESS_PATTERN, text);
      if (addr !== undefined) {
        const trimmed = addr.trim();
        if (trimmed.length <= 200 && isValidMultiWord(trimmed, 5)) {
          result.installation_updates.address = trimmed;
        }
      }
    }

    const postcode = lastCapture(POSTCODE_PATTERN, text);
    if (postcode !== undefined) {
      const cleaned = postcode.trim().replace(/\s+/g, ' ').toUpperCase();
      if (POSTCODE_FINAL_VALIDATION.test(cleaned)) {
        result.installation_updates.postcode = cleaned;
      }
    }

    const premises = lastCapture(PREMISES_PATTERN, text, 0);
    if (premises !== undefined) {
      result.installation_updates.premises_description = premises.replace(/\b\w/g, (c) =>
        c.toUpperCase()
      );
    }

    const nextInsp = lastCapture(NEXT_INSPECTION_PATTERN, text);
    if (nextInsp !== undefined) {
      const n = parseInt(nextInsp, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10)
        result.installation_updates.next_inspection_years = n;
    }

    const phone = lastCapture(CLIENT_PHONE_PATTERN, text);
    if (phone !== undefined) {
      const trimmed = phone.trim();
      if (trimmed.length >= 6 && trimmed.length <= 20)
        result.installation_updates.client_phone = trimmed;
    }
    const email = lastCapture(CLIENT_EMAIL_PATTERN, text);
    if (email !== undefined) {
      const trimmed = email.trim();
      if (trimmed.includes('@') && trimmed.length <= 100)
        result.installation_updates.client_email = trimmed;
    }
    const occupier = lastCapture(OCCUPIER_NAME_PATTERN, text);
    if (occupier !== undefined) {
      const trimmed = occupier.trim();
      if (trimmed.length <= 100 && isValidMultiWord(trimmed, 2)) {
        result.installation_updates.occupier_name = trimmed;
      }
    }
    const reason = lastCapture(REASON_FOR_REPORT_PATTERN, text);
    if (reason !== undefined) {
      const trimmed = reason.trim();
      if (trimmed.length >= 3 && trimmed.length <= 200)
        result.installation_updates.reason_for_report = trimmed;
    }
    const prevDate = lastCapture(DATE_OF_PREVIOUS_INSPECTION_PATTERN, text);
    if (prevDate !== undefined) {
      const trimmed = prevDate.trim();
      if (trimmed.length >= 4 && trimmed.length <= 50) {
        result.installation_updates.date_of_previous_inspection = trimmed;
      }
    }
    const inspDate = lastCapture(DATE_OF_INSPECTION_PATTERN, text);
    if (inspDate !== undefined) {
      const trimmed = inspDate.trim();
      if (trimmed.length >= 4 && trimmed.length <= 50) {
        const parsed = parseSpokenDate(trimmed);
        if (parsed !== undefined)
          result.installation_updates.date_of_inspection = parsed.toISOString();
      }
    }
    const prevCert = lastCapture(PREVIOUS_CERT_NUMBER_PATTERN, text);
    if (prevCert !== undefined) {
      const trimmed = prevCert.trim();
      if (trimmed.length >= 2 && trimmed.length <= 50) {
        result.installation_updates.previous_certificate_number = trimmed;
      }
    }
    const estAge = lastCapture(ESTIMATED_AGE_PATTERN, text);
    if (estAge !== undefined) {
      const trimmed = estAge.trim();
      if (trimmed.length <= 50) result.installation_updates.estimated_age_of_installation = trimmed;
    }
    const condition = lastCapture(GENERAL_CONDITION_PATTERN, text);
    if (condition !== undefined) {
      const trimmed = condition.trim();
      if (trimmed.length >= 3 && trimmed.length <= 500) {
        result.installation_updates.general_condition_of_installation = trimmed;
      }
    }
  }

  // MARK: — Per-circuit fields

  private matchCircuitFields(
    text: string,
    job: JobDetail,
    circuitRef: string,
    result: RegexMatchResult
  ): void {
    const circuit = (job.circuits ?? []).find((c) => circuitRefOf(c) === circuitRef);
    let updates: CircuitUpdates = result.circuit_updates[circuitRef] ?? {};

    // Zs (per-circuit) — exclude when "Zs at DB" present.
    if (!hasMatch(ZS_EXCLUDE_PATTERN, text)) {
      const v = lastCapture(ZS_PATTERN, text) ?? lastCapture(ZS_FLEX_PATTERN, text);
      if (v !== undefined) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0.01 && n <= 20.0) updates.measured_zs_ohm = v;
      }
    }

    // Discontinuous continuity sentinel checks.
    if (hasMatch(R1R2_DISCONT, text)) updates.r1_r2_ohm = DISCONTINUOUS_SENTINEL;

    if (updates.r1_r2_ohm === undefined) {
      const v = lastCapture(R1R2_PATTERN, text) ?? lastCapture(R1R2_FLEX_PATTERN, text);
      if (v !== undefined) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.r1_r2_ohm = v;
      }
    }

    const isRing = isRingCircuit(circuit ? circuitDesignationOf(circuit) : undefined, text);

    // Bare R1 → R1+R2 fallback.
    if (updates.r1_r2_ohm === undefined) {
      const v = lastCapture(RING_R1_PATTERN, text);
      if (v !== undefined) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.r1_r2_ohm = v;
      }
    }
    if (isRing) {
      if (hasMatch(RING_RN_DISCONT, text)) {
        updates.ring_rn_ohm = DISCONTINUOUS_SENTINEL;
      } else {
        const v = lastCapture(RING_RN_PATTERN, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_rn_ohm = v;
        }
      }
    }
    // Bare R2 → R1+R2 fallback.
    if (updates.r1_r2_ohm === undefined) {
      const v = lastCapture(RING_R2_PATTERN, text);
      if (v !== undefined) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.r1_r2_ohm = v;
      }
    }

    if (isRing) {
      if (
        updates.ring_r1_ohm === undefined &&
        (hasMatch(RING_R1_DISCONT, text) || hasMatch(RING_LIVES_DISCONT, text))
      ) {
        updates.ring_r1_ohm = DISCONTINUOUS_SENTINEL;
      }
      if (updates.ring_r1_ohm === undefined) {
        const v = lastCapture(EXPLICIT_RING_R1_PATTERN, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_r1_ohm = v;
        }
      }
      if (updates.ring_r1_ohm === undefined) {
        const v = lastCapture(RING_LIVES, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_r1_ohm = v;
        }
      }
      if (updates.ring_rn_ohm === undefined) {
        const v = lastCapture(RING_NEUTRALS, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_rn_ohm = v;
        }
      }
      if (
        updates.ring_r2_ohm === undefined &&
        (hasMatch(RING_R2_DISCONT, text) || hasMatch(RING_EARTHS_DISCONT, text))
      ) {
        updates.ring_r2_ohm = DISCONTINUOUS_SENTINEL;
      }
      if (updates.ring_r2_ohm === undefined) {
        const v = lastCapture(EXPLICIT_RING_R2_PATTERN, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_r2_ohm = v;
        }
      }
      if (updates.ring_r2_ohm === undefined) {
        const v = lastCapture(RING_EARTHS, text);
        if (v !== undefined) {
          const n = parseFloat(v);
          if (Number.isFinite(n) && n >= 0.01 && n <= 10.0) updates.ring_r2_ohm = v;
        }
      }
    }

    const hasTestVoltage = hasMatch(TEST_VOLTAGE_PATTERN, text);

    // IR Live-Earth: postfix → prefix.
    if (!hasTestVoltage) {
      const v = lastCapture(IR_LE_POSTFIX, text);
      if (v !== undefined) {
        const isGreater = hasMatch(IR_LE_POSTFIX_GREATER, text);
        updates.ir_live_earth_mohm = isGreater ? `>${v}` : v;
      }
    }
    if (updates.ir_live_earth_mohm === undefined) {
      const v = lastCapture(IR_LE_PATTERN, text) ?? lastCapture(IR_BRIDGING, text);
      if (v !== undefined) {
        const isGreater = hasMatch(IR_GREATER, text);
        updates.ir_live_earth_mohm = isGreater ? `>${v}` : v;
      }
    }

    // IR Live-Live.
    if (!hasTestVoltage) {
      const v = lastCapture(IR_LL_POSTFIX, text);
      if (v !== undefined) {
        const isGreater = hasMatch(IR_LL_POSTFIX_GREATER, text);
        updates.ir_live_live_mohm = isGreater ? `>${v}` : v;
      }
    }
    if (updates.ir_live_live_mohm === undefined) {
      const v = lastCapture(IR_LL_PATTERN, text);
      if (v !== undefined) {
        const isGreater = hasMatch(IR_LL_GREATER, text);
        updates.ir_live_live_mohm = isGreater ? `>${v}` : v;
      } else if (hasMatch(IR_LL_LIM, text)) {
        updates.ir_live_live_mohm = 'LIM';
      }
    }
    if (updates.ir_live_earth_mohm === undefined && hasMatch(IR_LE_LIM, text)) {
      updates.ir_live_earth_mohm = 'LIM';
    }

    // RCD time.
    {
      const v = lastCapture(RCD_TIME_PATTERN, text) ?? lastCapture(RCD_TIME_FLEX, text);
      if (v !== undefined) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 1 && n <= 1000) updates.rcd_time_ms = v;
      }
    }

    // RCD type.
    {
      const validRcdTypes = new Set(['AC', 'A', 'B', 'F', 'S', 'A-S', 'B-S', 'B+']);
      const raw = lastCapture(RCD_TYPE_PATTERN, text) ?? lastCapture(RCD_TYPE_BEFORE, text);
      if (raw !== undefined) {
        const normalised = raw
          .toUpperCase()
          .replace(/ PLUS/g, '+')
          .replace(/ \+/g, '+')
          .replace(/ /g, '-')
          .replace(/--/g, '-');
        if (validRcdTypes.has(normalised)) updates.rcd_type = normalised;
      } else if (hasMatch(RCD_TYPE_SELECTIVE, text)) {
        updates.rcd_type = 'S';
      }
    }

    // OCPD composite first.
    {
      const m = lastMatch(OCPD_COMPOSITE_PATTERN, text);
      if (m) {
        const bsEn = m[1];
        const typeLetter = m[2];
        const rating = m[3];
        if (bsEn) {
          updates.ocpd_bs_en = bsEn;
          const mapped = BS_EN_TO_OCPD_TYPE[bsEn];
          if (mapped) updates.ocpd_type = mapped;
        }
        if (typeLetter) updates.ocpd_type = typeLetter.toUpperCase();
        if (rating) {
          const n = parseInt(rating, 10);
          if (Number.isFinite(n) && n >= 1 && n <= 125) updates.ocpd_rating_a = rating;
        }
      }
    }
    if (updates.ocpd_rating_a === undefined) {
      const v = lastCapture(OCPD_RATING_BEFORE, text) ?? lastCapture(OCPD_RATING_AFTER, text);
      if (v !== undefined) updates.ocpd_rating_a = v;
    }

    // Wiring/ref method (run BEFORE bare type to disambiguate).
    {
      const v = lastCapture(WIRING_TYPE_PATTERN, text);
      if (v !== undefined) updates.wiring_type = v.toUpperCase();
    }
    {
      const v = lastCapture(REF_METHOD_PATTERN, text);
      if (v !== undefined) updates.ref_method = v.toUpperCase();
      else {
        const v2 = lastCapture(REF_METHOD_NUMERIC_BARE, text);
        if (v2 !== undefined) updates.ref_method = v2;
      }
    }

    // BS EN standard (independent of composite).
    {
      const bsEn = lastCapture(BS_EN_STANDARD_PATTERN, text);
      if (bsEn !== undefined) {
        updates.ocpd_bs_en = bsEn;
        const mapped = BS_EN_TO_OCPD_TYPE[bsEn];
        if (mapped && updates.ocpd_type === undefined) updates.ocpd_type = mapped;
      }
    }

    // Bare "type X" — only when not preceded by wiring/ref/cable.
    {
      const v = lastCapture(OCPD_TYPE_PATTERN, text);
      if (v !== undefined) {
        if (!hasMatch(WIRING_OR_REF_BEFORE_TYPE, text)) updates.ocpd_type = v.toUpperCase();
      } else {
        const dev = lastCapture(OCPD_DEVICE_PATTERN, text, 0);
        if (dev !== undefined) updates.ocpd_type = dev.toUpperCase();
      }
    }

    if (hasMatch(POLARITY_PATTERN, text)) updates.polarity_confirmed = '✓';
    if (hasMatch(RCD_BUTTON_PATTERN, text)) updates.rcd_button_confirmed = '✓';
    if (hasMatch(AFDD_PATTERN, text)) updates.afdd_button_confirmed = '✓';

    {
      const v = lastCapture(CABLE_SIZE_PATTERN, text);
      if (v !== undefined) updates.live_csa_mm2 = v;
    }
    {
      const v = lastCapture(CPC_SIZE_PATTERN, text);
      if (v !== undefined) updates.cpc_csa_mm2 = v;
    }
    {
      const v =
        lastCapture(NUMBER_OF_POINTS_PATTERN, text) ??
        lastCapture(NUMBER_OF_POINTS_FLEX, text) ??
        lastCapture(NUMBER_OF_POINTS_REVERSE, text);
      if (v !== undefined) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 50) updates.number_of_points = v;
      }
    }

    if (Object.keys(updates).length > 0) {
      result.circuit_updates[circuitRef] = updates;
    }
  }

  // MARK: — Board switch

  private detectBoardSwitch(text: string, result: RegexMatchResult): void {
    {
      const m = freshScan(BOARD_MAIN_PATTERN).exec(text);
      if (m) {
        result.board_switch = { board_slug: 'main', raw_match: m[0] };
        return;
      }
    }
    {
      const m = freshScan(BOARD_NUMBER_PATTERN).exec(text);
      if (m) {
        const raw = m[0].toLowerCase();
        let number: string | undefined;
        if (m[1]) number = m[1];
        if (number === undefined) {
          for (const [word, digit] of Object.entries(BOARD_NUMBER_ORDINAL_MAP)) {
            if (raw.includes(word)) {
              number = digit;
              break;
            }
          }
        }
        if (number !== undefined) {
          result.board_switch = { board_slug: `DB${number}`, raw_match: m[0] };
          return;
        }
      }
    }
    {
      const m = freshScan(BOARD_NAMED_PATTERN).exec(text);
      if (m && m[1]) {
        const location = m[1].toLowerCase().replace(/\s+/g, '_');
        result.board_switch = { board_slug: `${location}_board`, raw_match: m[0] };
        return;
      }
    }
    {
      const m = freshScan(BOARD_SUB_PATTERN).exec(text);
      if (m) {
        result.board_switch = { board_slug: 'sub_board', raw_match: m[0] };
      }
    }
  }
}

// MARK: — Helpers used by detectNewCircuits + matchCircuitFieldsBySegment

function extractCircuitRef(match: RegExpExecArray): string | undefined {
  // Group 1: "circuit N" form (word or digit). Group 2: "Nth circuit".
  if (match[1] !== undefined) {
    const raw = match[1].toLowerCase();
    return WORD_NUMBERS[raw] ?? raw;
  }
  if (match[2] !== undefined) {
    const raw = match[2].toLowerCase();
    return ORDINAL_NUMBERS[raw] ?? raw;
  }
  return undefined;
}

// Re-export match-result helpers for consumers.
export { isEmptyResult } from './regex-match-result';
