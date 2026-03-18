/**
 * EICR-aware semantic buffer for real-time recording.
 *
 * Instead of extracting every 200 characters, this module understands
 * EICR test data patterns and only triggers extraction when a complete
 * reading (parameter + value) has been spoken, or when enough context
 * has accumulated for observations.
 *
 * Tracks:
 *  - Active circuit (persists until a new circuit is mentioned)
 *  - Active test type (ring continuity, insulation, etc.)
 *  - Previous readings (for context window sent to GPT)
 */

// ── Pattern definitions ──

const PARAMETERS = [
  /\br\s*1\s*(\+|plus|and)\s*r\s*2\b/i,  // R1+R2 combined continuity - check FIRST
  /\br\s*1\b/i, /\br\s*2\b/i, /\br\s*n\b/i,
  /\bze\b/i, /\bzs\b/i,
  /\bline[\s-]*earth\b/i, /\bline[\s-]*neutral\b/i, /\bneutral[\s-]*earth\b/i,
  /\bpolarity\b/i, /\brcd\b/i, /\btrip\s*time\b/i,
  /\binsulation\b/i, /\bir\b/i, /\bloop\s*impedance\b/i,
  /\bcpc\b/i, /\bearths?\b/i, /\blives?\b/i, /\bneutrals?\b/i,
  /\bocpd\b/i, /\bbreaker\b/i, /\bmcb\b/i, /\brcbo\b/i,
];

const VALUES = /\d+\.?\d*\s*(ohms?|mohms?|megohms?|amps?|volts?|ms|k\s*a)?|\bpass\b|\bfail\b|\bsatisfactory\b|\bn\/?a\b|\bok\b/i;

// Word-numbers commonly spoken by electricians (for circuit counts, number of points, etc.)
const WORD_NUMBERS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;

// Patterns that indicate an incomplete number (waiting for more digits)
// These are spoken ways of saying decimal numbers that got split mid-value
// NOTE: No longer called from shouldExtract or addTranscript (dead code kept for reference)
const INCOMPLETE_NUMBER_PATTERNS = [
  /\b(nought|zero|oh)\s*(point|decimal)\s*$/i,           // "nought point" at end
  /\b(point|decimal)\s*$/i,                               // "point" at end
  /\b\d+\s*(point|decimal)\s*$/i,                         // "one point" at end
  /\b(nought|zero|oh)\s*(point|decimal)\s+[a-z]+\s*$/i,  // "nought point eight" (word-number at end, waiting for more)
  /\b\d+\s*(point|decimal)\s+[a-z]+\s*$/i,               // "one point five" waiting for more digits
  /\bis\s+(nought|zero|oh|\d+)\s*$/i,                    // "is nought" or "is 0" at end (waiting for full value)
  /\b(r1|r2|rn|ze|zs|ir|pfc)\s+(is|are|equals?)?\s*$/i,  // Parameter mentioned but no value yet
];

const CIRCUIT_PATTERNS = [
  /circuit\s*(\d+)/i,
  /\b(ring|radial|lighting|lights?|sockets?|cooker|shower|oven|hob|immersion|water\s*heater)\b/i,
  /\b(upstairs|downstairs|first\s*floor|ground\s*floor|kitchen|bathroom|garage|bedroom|lounge|hall)\b/i,
];

// IMPORTANT: Order matters! Check combined_continuity BEFORE ring_continuity
// because "R1 plus R2" should NOT trigger ring_continuity test type
const TEST_TYPES = {
  // Combined continuity (R1+R2) - for radial circuits, must be checked FIRST
  combined_continuity: [/\br\s*1\s*(\+|plus|and)\s*r\s*2\b/i, /\br1\s*r2\b/i],
  // Ring continuity - separate r1, rn, r2 readings for ring final circuits
  // Only trigger if NOT "R1 plus R2" pattern
  ring_continuity: [/\blives?\b/i, /\bneutrals?\b/i, /\bcpc\b/i, /\bring\s+continuity\b/i, /\bring\s+final\b/i],
  insulation: [/\binsulation\b/i, /\bir\b/i, /\bline[\s-]*earth\b/i, /\bmegger\b/i],
  polarity: [/\bpolarity\b/i],
  rcd: [/\brcd\b/i, /\btrip/i],
  earth_fault_loop: [/\bze\b/i, /\bzs\b/i, /\bloop/i, /\bpfc\b/i, /\bpscc\b/i],
};

const OBSERVATION_PATTERN = /\bobservation\b|\bobs\b|\bdefect\b|\bdamage|\bbonding\b|\bmissing\b|\bno earth\b|\bexposed\b|\bburnt\b|\bscorch\b|\bcombustible\b|\boverloaded\b|\bno rcd\b|\breversed\b/i;

const INSTALLATION_PATTERNS = [
  /\b(address|property|testing\s*at|inspection\s*at|location)\b/i,
  /\b(client|customer|mr|mrs|miss|ms|dr)\b/i,
  /\b(postcode|post\s*code)\b/i,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/,  // UK postcode pattern
];

const CIRCUIT_DETAIL_PATTERNS = [
  /\b(\d+)\s*amp/i,           // "32 amp"
  /\b(type\s*[ABC])\b/i,      // "type B"
  /\b(ring\s*final|radial)\b/i, // "ring final"
  /\b(\d+\.?\d*)\s*mm/i,      // "2.5 mm"
  /\bnumber\s+of\s+points\b/i, // "number of points is 4"
  /\bpoints?\s+(?:is\s+)?\d+/i, // "points 4", "points is 4"
  /\bways?\s+(?:is\s+)?\d+/i,  // "ways 6", "6 way"
  /\b\d+\s*ways?\b/i,          // "6 way" or "6 ways"
];

const SUPPLY_PATTERNS = [
  /\bTN[\s-]?C[\s-]?S\b/i,    // TN-C-S
  /\bTN[\s-]?S\b/i,           // TN-S
  /\bTN[\s-]?C\b/i,           // TN-C
  /\bTT\b/i,                   // TT
  /\bIT\b/,                    // IT (case-sensitive to avoid "it")
  /\bPME\b/i,                  // PME
  /\bearth\s*rod\b/i,          // earth rod
  /\b(separate|lead\s*sheath)\s*earth\b/i,
];

// ── Detection helpers ──

function detectCircuit(text) {
  for (const pattern of CIRCUIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // For "circuit N", return "Circuit N"
      if (/circuit\s*\d+/i.test(match[0])) {
        return match[0].trim();
      }
      // For location/type words, combine adjacent matches
      // e.g. "kitchen sockets" → "kitchen sockets"
      const words = [];
      for (const p of CIRCUIT_PATTERNS) {
        const m = text.match(p);
        if (m && !/circuit\s*\d+/i.test(m[0])) {
          words.push(m[0].trim());
        }
      }
      return words.length > 0 ? words.join(" ") : match[0].trim();
    }
  }
  return null;
}

function detectTestType(text) {
  const lower = text.toLowerCase();

  // Check for "R1 plus R2" / "R1+R2" FIRST - this is combined continuity, NOT ring continuity
  // This must be checked before any other test type to avoid false positives
  if (/\br\s*1\s*(\+|plus|and)\s*r\s*2\b/i.test(lower) || /\br1\s*r2\b/i.test(lower)) {
    return "combined_continuity";
  }

  // Check other test types in order
  for (const [type, patterns] of Object.entries(TEST_TYPES)) {
    // Skip combined_continuity since we already checked it
    if (type === "combined_continuity") continue;

    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        return type;
      }
    }
  }

  // Special case: standalone "R1" or "R2" with a value nearby could be ring continuity
  // but ONLY if we're sure it's not part of "R1 plus R2"
  if ((/\br\s*1\b/i.test(lower) || /\br\s*2\b/i.test(lower)) &&
      !/\br\s*1\s*(\+|plus|and)\s*r\s*2\b/i.test(lower)) {
    // Check if there's a value immediately after (like "R1 is 0.34")
    if (/\br\s*[12]\s*(is|are|equals?)?\s*\d+\.?\d*/i.test(lower)) {
      return "ring_continuity";
    }
  }

  return null;
}

function hasParameter(text) {
  const lower = text.toLowerCase();
  return PARAMETERS.some(p => p.test(lower));
}

function hasValue(text) {
  return VALUES.test(text);
}

function isObservation(text) {
  return OBSERVATION_PATTERN.test(text);
}

/**
 * Detect if the buffer ends with an incomplete number phrase.
 * NOTE: No longer called from shouldExtract or addTranscript.
 * Kept as dead code for potential future use / reference.
 *
 * Examples of incomplete endings:
 *  - "R1 plus R2 is nought point" (waiting for digits)
 *  - "Zs is nought point eight" (could continue with more digits)
 *  - "the reading is" (waiting for value)
 */
function hasIncompleteNumber(text) {
  if (!text || text.trim().length === 0) return false;

  // Get the last ~80 chars to check the ending
  const ending = text.slice(-80).trim();

  // Check against incomplete number patterns
  for (const pattern of INCOMPLETE_NUMBER_PATTERNS) {
    if (pattern.test(ending)) {
      return true;
    }
  }

  // Also check for spoken word-numbers at the very end that might continue
  // e.g., "point eight" could continue as "point eight nine"
  // These word-numbers are common: one, two, three, four, five, six, seven, eight, nine
  const endsWithWordNumber = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i.test(ending);
  const hasDecimalContext = /\b(point|decimal|nought)\b/i.test(ending);

  // If text ends with a word-number AND has decimal context, it might be incomplete
  if (endsWithWordNumber && hasDecimalContext) {
    return true;
  }

  return false;
}

// ── Extraction decision helpers ──

function hasParameterAndValue(text) {
  return hasParameter(text) && hasValue(text);
}

function hasCircuitWithDetails(text) {
  return detectCircuit(text) && CIRCUIT_DETAIL_PATTERNS.some(p => p.test(text));
}

function hasEICRContent(text) {
  return hasParameter(text) || isObservation(text) || detectCircuit(text) || SUPPLY_PATTERNS.some(p => p.test(text)) || INSTALLATION_PATTERNS.some(p => p.test(text));
}

// ── Extraction decision ──

function shouldExtract(buffer) {
  const text = buffer.pendingText;
  if (!text || text.length === 0) return false;

  const elapsed = buffer.lastAddedAt ? Date.now() - buffer.lastAddedAt : 0;

  // Rule 0: Standalone numeric value with context — orphaned readings like "0.99"
  // that arrive as a short chunk. If we have an active circuit or test type,
  // send to GPT with the wider extraction window so it can assign the value.
  if (text.length < 20 && VALUES.test(text) && (buffer.activeCircuit || buffer.activeTestType)) {
    return true;
  }

  // Rule 1: Safety timeout — 15s since last transcript addition
  if (elapsed > 15000 && text.length > 20) return true;

  // Rule 2: Parameter + value detected (e.g., "Zs 0.87", "R1+R2 0.35")
  if (hasParameterAndValue(text)) return true;

  // Rule 3: Observation detected (100+ chars with observation keywords)
  if (text.length > 100 && OBSERVATION_PATTERN.test(text)) return true;

  // Rule 4: Circuit with details (name + rating/type)
  if (hasCircuitWithDetails(text)) return true;

  // Rule 4b: Circuit reference with any value — "Circuit number one. Number of points is four."
  // Even short text (30+ chars) should trigger extraction when it has a circuit ref + a number,
  // since the wider extraction window (~3000 chars) gives GPT enough context.
  // Matches both digit values (0.34) and word numbers (four, six, twelve).
  if (text.length >= 30 && detectCircuit(text) && (VALUES.test(text) || WORD_NUMBERS.test(text))) return true;

  // Rule 5: Supply/earthing info
  if (SUPPLY_PATTERNS.some(p => p.test(text))) return true;

  // Rule 6: Installation details (address, client name)
  if (INSTALLATION_PATTERNS.some(p => p.test(text))) return true;

  // Rule 7: Enough text accumulated (150+ chars with EICR content)
  // Lowered from 300 to 150 — short VAD chunks (67-78 chars) were routinely
  // skipped, losing data that the wider extraction window could have caught.
  if (text.length > 150 && hasEICRContent(text)) return true;

  // Rule 8: Discard timeout — 60s with no EICR content
  if (elapsed > 60000 && !hasEICRContent(text)) {
    buffer.pendingText = "";
    return false;
  }

  return false;
}

// ── Ring continuity local parser ──

const RING_KEYWORD_MAP = {
  r1: [/\br\s*1\b/i, /\blives?\b/i],
  rn: [/\br\s*n\b/i, /\bneutrals?\b/i],
  r2: [/\br\s*2\b/i, /\bearths?\b/i, /\bcpc\b/i],
};

const RING_VALUE_PATTERN = /(\d+\.\d+|\d+)/g;
const RING_MIN = 0.01;
const RING_MAX = 5.0;

/**
 * Parse ring continuity values from transcript text.
 * Only runs when activeTestType === "ring_continuity".
 * Maps values to r1/rn/r2 by keyword or by next empty slot.
 * Returns array of { field, value } for each newly parsed reading.
 *
 * IMPORTANT: Does NOT run for "combined_continuity" test type (R1+R2).
 * That is handled by GPT extraction to avoid parsing "1" and "2" from "R1" and "R2".
 */
export function parseRingValues(buffer, text) {
  // Only parse for actual ring continuity tests, NOT combined continuity (R1+R2)
  if (buffer.activeTestType !== "ring_continuity") return [];

  // Double-check: if text contains "R1 plus R2" or similar, skip local parsing
  // Let GPT handle combined continuity readings correctly
  if (/\br\s*1\s*(\+|plus|and)\s*r\s*2\b/i.test(text)) {
    return [];
  }

  // Track which circuit these readings belong to
  if (buffer.activeCircuit && !buffer.ringCircuit) {
    buffer.ringCircuit = buffer.activeCircuit;
  }

  const lower = text.toLowerCase();
  const results = [];

  // Extract numeric values, but EXCLUDE integers that are part of "R1" or "R2"
  // We want decimal values like "0.34" or values with units like "0.5 ohms"
  // NOT the "1" from "R1" or "2" from "R2"
  const numbers = [];
  let match;

  // Reset the regex
  RING_VALUE_PATTERN.lastIndex = 0;

  while ((match = RING_VALUE_PATTERN.exec(text)) !== null) {
    const val = parseFloat(match[0]);
    const idx = match.index;

    // Skip if value is outside valid range for continuity readings
    if (val < RING_MIN || val > RING_MAX) continue;

    // Skip integers (1, 2, 3) that might be part of "R1", "R2", "R3" etc.
    // Only skip if the character immediately before is 'r' or 'R'
    if (Number.isInteger(val) && val <= 9 && idx > 0) {
      const charBefore = text[idx - 1].toLowerCase();
      if (charBefore === 'r') {
        // This is likely "R1", "R2" etc - skip it
        continue;
      }
    }

    // Also skip if this looks like part of "R1 plus R2" pattern
    // Check surrounding context
    const contextStart = Math.max(0, idx - 3);
    const contextEnd = Math.min(text.length, idx + match[0].length + 3);
    const context = text.slice(contextStart, contextEnd).toLowerCase();
    if (/r\s*[12]\s*(plus|and|\+)/i.test(context)) {
      continue;
    }

    numbers.push({ value: val, index: idx });
  }

  if (numbers.length === 0) return [];

  // For each number, try to find a keyword hint
  for (const num of numbers) {
    let assigned = false;

    // Check keyword proximity — look for keywords in the text
    for (const [field, patterns] of Object.entries(RING_KEYWORD_MAP)) {
      if (buffer.ringReadings[field] !== null) continue; // already filled
      for (const pattern of patterns) {
        if (pattern.test(lower)) {
          buffer.ringReadings[field] = num.value;
          results.push({ field, value: num.value });
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }

    // No keyword match — assign to next empty slot in order r1 -> rn -> r2
    if (!assigned) {
      for (const field of ["r1", "rn", "r2"]) {
        if (buffer.ringReadings[field] === null) {
          buffer.ringReadings[field] = num.value;
          results.push({ field, value: num.value });
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Get current ring readings state (for logging/debugging).
 */
export function getRingReadings(buffer) {
  return {
    r1: buffer.ringReadings.r1,
    rn: buffer.ringReadings.rn,
    r2: buffer.ringReadings.r2,
    circuit: buffer.ringCircuit,
  };
}

// ── New topic detection (dead code — kept for reference) ──

// Words that indicate the start of a new topic when a chunk arrives
// while the buffer is holding incomplete text.
const NEW_TOPIC_CIRCUIT_WORDS = /^(lights?|lighting|sockets?|cooker|shower|oven|hob|immersion|water\s*heater|ring|radial|circuit|upstairs|downstairs|first\s*floor|ground\s*floor|kitchen|bathroom|garage|bedroom|lounge|hall)\b/i;
const NEW_TOPIC_PARAMETER_WORDS = /^(zs|ze|r1|r2|rn|ir|insulation|polarity|rcd|trip|loop|pfc|pscc|ocpd|breaker|mcb|rcbo|r1\s*(\+|plus|and)\s*r2)\b/i;
const NEW_TOPIC_SECTION_WORDS = /^(bonding|earthing|observation|obs|board|consumer\s*unit|main\s*switch|supply|next\s*circuit|moving\s*on|that's\s*it\s*for)\b/i;

/**
 * Detect if incoming transcript text starts a new topic.
 * NOTE: No longer called from addTranscript. Kept as dead code for reference.
 */
function startsNewTopic(text) {
  if (!text || text.trim().length === 0) return false;
  const trimmed = text.trim();
  return (
    NEW_TOPIC_CIRCUIT_WORDS.test(trimmed) ||
    NEW_TOPIC_PARAMETER_WORDS.test(trimmed) ||
    NEW_TOPIC_SECTION_WORDS.test(trimmed)
  );
}

// ── Public API ──

export function createEICRBuffer() {
  return {
    pendingText: "",
    fullText: "",
    lastAddedAt: null,
    activeCircuit: null,
    activeTestType: null,
    previousReadings: [],
    ringReadings: { r1: null, rn: null, r2: null },
    ringCircuit: null,
  };
}

export function addTranscript(buffer, text) {
  // Concatenate incoming text
  buffer.pendingText += (buffer.pendingText ? " " : "") + text;
  buffer.fullText += (buffer.fullText ? " " : "") + text;
  buffer.lastAddedAt = Date.now();

  // Detect circuit change
  const circuit = detectCircuit(text);
  if (circuit && circuit !== buffer.activeCircuit) {
    buffer.activeCircuit = circuit;
    // Reset ring readings when circuit changes to prevent cross-circuit contamination
    buffer.ringReadings = { r1: null, rn: null, r2: null };
    buffer.ringCircuit = null;
  }

  // Detect test type change
  const testType = detectTestType(text);
  if (testType && testType !== buffer.activeTestType) {
    // Reset ring readings when leaving ring_continuity test type
    if (buffer.activeTestType === "ring_continuity") {
      buffer.ringReadings = { r1: null, rn: null, r2: null };
      buffer.ringCircuit = null;
    }
    buffer.activeTestType = testType;
    buffer.previousReadings = []; // Clear history for new test type
  }

  return {
    shouldExtract: shouldExtract(buffer),
    incompleteNumberDetected: false,
    bufferEnding: buffer.pendingText.slice(-50), // Last 50 chars for debugging
    flushedText: null,
  };
}

export function getExtractionPayload(buffer) {
  return {
    fullText: buffer.fullText,
    pendingText: buffer.pendingText,
    activeCircuit: buffer.activeCircuit,
    activeTestType: buffer.activeTestType,
    previousReadings: buffer.previousReadings,
  };
}

/**
 * Get a wider extraction window from the full transcript.
 * Returns the last ~maxChars characters of fullText, trimmed to a word boundary.
 * This gives GPT enough context to understand which circuit/test is active,
 * even when pendingText is short.
 */
export function getExtractionWindow(buffer, maxChars = 3000) {
  const text = buffer.fullText || "";
  if (text.length <= maxChars) return text;

  // Slice from the end, then advance to the first space to avoid cutting mid-word
  let start = text.length - maxChars;
  const spaceIdx = text.indexOf(" ", start);
  if (spaceIdx !== -1 && spaceIdx < start + 50) {
    start = spaceIdx + 1;
  }
  return text.slice(start);
}

// ── Common readings local parser ──

const COMMON_READING_DEFS = [
  {
    name: "Ze",
    target: "supply",
    field: "earth_loop_impedance_ze",
    // "Ze is 0.47", "Ze 0.47", "Ze of 0.47" — but NOT "Zs at the board"
    pattern: /\bze\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)/i,
    validate: (v) => v >= 0.01 && v <= 5.0,
    rawValue: false,
  },
  {
    name: "Zs",
    target: "circuit",
    field: "measured_zs_ohm",
    // "Zs 1.28", "Zs is 1.28" — but NOT "Zs at the board" or "Zs at the DB"
    pattern: /\bzs\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)/i,
    excludePattern: /\bzs\s+(?:at\s+the\s+(?:board|db|distribution))/i,
    validate: (v) => v >= 0.01 && v <= 20.0,
    rawValue: false,
  },
  {
    name: "R1+R2",
    target: "circuit",
    field: "r1_r2_ohm",
    // "R1 plus R2 0.34", "R1+R2 is 0.34", "R1 and R2 0.34"
    pattern: /\br\s*1\s*(?:\+|plus|and)\s*r\s*2\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)/i,
    validate: (v) => v >= 0.01 && v <= 10.0,
    rawValue: false,
  },
  {
    name: "IR",
    target: "circuit",
    field: "ir_live_earth_mohm",
    // "IR 200 megohms", "IR is 200", "IR greater than 200", "insulation resistance 200"
    pattern: /\b(?:ir|insulation\s+resistance)\s+(?:is\s+)?(?:greater\s+than\s+|more\s+than\s+|over\s+|>)?(\d+\.?\d*)\s*(?:megohms?|mohms?)?/i,
    // For IR, we capture the raw string including ">200" prefix
    rawValue: true,
    greaterPattern: /\b(?:ir|insulation\s+resistance)\s+(?:is\s+)?(?:greater\s+than|more\s+than|over|>)\s*(\d+\.?\d*)/i,
    validate: () => true, // Always valid — raw string
  },
  {
    name: "IR_live_earth_natural",
    target: "circuit",
    field: "ir_live_earth_mohm",
    // "live to earth is 299 megohms", "live to earth greater than 200"
    pattern: /\blive\s+to\s+earth\s+(?:is\s+)?(?:greater\s+than\s+|more\s+than\s+|over\s+|>)?(\d+\.?\d*)\s*(?:megohms?|mohms?)?/i,
    rawValue: true,
    greaterPattern: /\blive\s+to\s+earth\s+(?:is\s+)?(?:greater\s+than|more\s+than|over|>)\s*(\d+\.?\d*)/i,
    validate: () => true,
  },
  {
    name: "IR_live_live_natural",
    target: "circuit",
    field: "ir_live_live_mohm",
    // "live to live is 250 megohms", "live to live greater than 200"
    pattern: /\blive\s+to\s+live\s+(?:is\s+)?(?:greater\s+than\s+|more\s+than\s+|over\s+|>)?(\d+\.?\d*)\s*(?:megohms?|mohms?)?/i,
    rawValue: true,
    greaterPattern: /\blive\s+to\s+live\s+(?:is\s+)?(?:greater\s+than|more\s+than|over|>)\s*(\d+\.?\d*)/i,
    validate: () => true,
  },
  {
    name: "RCD",
    target: "circuit",
    field: "rcd_time_ms",
    // "RCD 28 ms", "RCD trip time 28", "RCD is 28 milliseconds"
    pattern: /\brcd\s+(?:trip\s+(?:time\s+)?)?(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/i,
    validate: (v) => v >= 1 && v <= 1000,
    rawValue: false,
  },
  {
    name: "PFC",
    target: "supply",
    field: "prospective_fault_current",
    // "PFC 1.66", "PFC is 1.66 kA", "prospective fault current 1.66"
    pattern: /\b(?:pfc|pscc|prospective\s+(?:fault\s+)?(?:short\s+circuit\s+)?current)\s+(?:is\s+|of\s+|=\s*)?(\d+\.?\d*)\s*(?:ka|kiloa(?:mps?)?)?/i,
    validate: (v) => v >= 0.1 && v <= 50.0,
    rawValue: false,
  },
];

/**
 * Parse common EICR readings from transcript text using regex.
 * Returns array of { name, target, field, value, circuitName } for each match.
 *
 * Runs on every chunk for instant UI updates (Tier 1 — regex).
 * GPT extraction (Tier 2) catches everything regex can't.
 */
export function parseCommonReadings(buffer, text) {
  if (!text || text.trim().length === 0) return [];

  const results = [];

  for (const def of COMMON_READING_DEFS) {
    // Check exclude pattern first (e.g., "Zs at the board")
    if (def.excludePattern && def.excludePattern.test(text)) continue;

    const match = text.match(def.pattern);
    if (!match) continue;

    let value;
    if (def.rawValue) {
      // For IR, check if "greater than" was spoken
      const greaterMatch = def.greaterPattern ? text.match(def.greaterPattern) : null;
      if (greaterMatch) {
        value = `>${greaterMatch[1]}`;
      } else {
        value = match[1];
      }
    } else {
      const num = parseFloat(match[1]);
      if (isNaN(num) || !def.validate(num)) continue;
      value = String(num);
    }

    results.push({
      name: def.name,
      target: def.target,
      field: def.field,
      value,
      circuitName: def.target === "circuit"
        ? (buffer.activeCircuit || null)
        : null,
    });
  }

  return results;
}

export function markExtracted(buffer) {
  // Add pending text to reading history before clearing
  if (buffer.pendingText.trim()) {
    buffer.previousReadings.push(buffer.pendingText.trim());
    // Keep last 10 readings max
    if (buffer.previousReadings.length > 10) {
      buffer.previousReadings = buffer.previousReadings.slice(-10);
    }
  }
  buffer.pendingText = "";
}

export function resetBuffer(buffer) {
  buffer.pendingText = "";
  buffer.fullText = "";
  buffer.lastAddedAt = null;
  buffer.activeCircuit = null;
  buffer.activeTestType = null;
  buffer.previousReadings = [];
  buffer.ringReadings = { r1: null, rn: null, r2: null };
  buffer.ringCircuit = null;
}
