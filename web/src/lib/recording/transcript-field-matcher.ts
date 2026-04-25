/**
 * Regex-tier transcript field matcher — port of iOS
 * `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift`
 * (R3 of `web/audit/REGEX_TIER_PLAN.md`).
 *
 * iOS canon is 2,128 lines and accreted over a year of voice-quality
 * fixes. This v1 web port targets ~700 LoC and ships ONLY the six
 * categories from `default_config.json#regex_patterns`:
 *
 *   1. insulation_resistance — IR live-earth, IR live-live
 *   2. ring_continuity      — bare R1 / Rn / R2 + explicit "ring R1/2"
 *   3. loop_impedance       — Zs (per-circuit), Ze (supply)
 *   4. rcd                  — RCD trip time
 *   5. polarity             — polarity_confirmed
 *   6. earth_continuity     — R1+R2 (compound)
 *
 * Out of scope — explicitly deferred to a v2 once v1 has soaked:
 *   - Designation-based matching ("kitchen sockets" → circuit N)
 *   - Board switch detection ("now testing distribution board 2")
 *   - New-circuit-from-speech ("circuit 22 cooker, four millimetres
 *     squared…")
 *   - Compound phrase patterns ("Zs for sockets is 0.86")
 *   - Installation fields (postcode, address) — Sonnet handles these
 *   - Discontinuous-continuity sentinels (∞ symbol) and LIM values
 *   - OCPD rating / type / BS-EN extraction
 *   - Wiring type / ref method
 *
 * Two R1-deferred matcher concerns are addressed here (see
 * `web/audit/INDEX.md` Wave-C R1 codex follow-ups):
 *   - "circuit N N amp …" → numeric range guard on OCPD ratings keeps
 *     the second N from being treated as a circuit number.
 *   - Zs-style values with >2 decimal places are rejected as plausible
 *     measurements (a normaliser tell that a fractional collapsed into
 *     a following rating). See `looksLikeMergedDecimal`.
 *
 * Public surface:
 *   - `class TranscriptFieldMatcher`
 *     - `match(transcript, job): RegexMatchResult` — main entry
 *     - `reset()` — clears sliding-window + active-circuit state
 *   - `interface RegexMatchResult` — `{supplyUpdates, circuitUpdates}`
 */

import type { JobDetail } from '../types';

// ─────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────

export interface SupplyUpdates {
  ze?: string;
  pfc?: string;
}

export interface CircuitUpdates {
  measured_zs_ohm?: string;
  r1_r2_ohm?: string;
  ring_r1_ohm?: string;
  ring_rn_ohm?: string;
  ring_r2_ohm?: string;
  ir_live_earth_mohm?: string;
  ir_live_live_mohm?: string;
  rcd_time_ms?: string;
  polarity_confirmed?: string;
}

export interface RegexMatchResult {
  supplyUpdates: SupplyUpdates;
  /** Map of circuit_ref → updates for that circuit. */
  circuitUpdates: Map<string, CircuitUpdates>;
}

// ─────────────────────────────────────────────────────────────────
// Range guards (mirrors iOS validation thresholds)
// ─────────────────────────────────────────────────────────────────

const ZS_MIN = 0.01;
const ZS_MAX = 20.0; // iOS: 20Ω; anything above is unrealistic for a circuit Zs.
const R1R2_MIN = 0.01;
const R1R2_MAX = 10.0;
const RCD_MS_MIN = 1;
const RCD_MS_MAX = 1000;

// Sliding window — iOS uses 800 chars in production for compound
// phrases; v1 web doesn't ship compounds so 500 is enough.
const WINDOW_SIZE = 500;

// Active-circuit-ref expiry — iOS holds a circuit ref active for
// 30 s after the inspector last said "circuit N", so subsequent
// readings without a circuit prefix get attributed to that circuit.
const ACTIVE_CIRCUIT_EXPIRY_MS = 30_000;

// ─────────────────────────────────────────────────────────────────
// Spoken-number prefix shared across patterns ("nought 0.5" etc.)
// ─────────────────────────────────────────────────────────────────

const SPOKEN_ZERO_PREFIX = '(?:(?:naught|nought|zero|oh)\\s+)?';

// ─────────────────────────────────────────────────────────────────
// Circuit-ref / segmentation patterns
// ─────────────────────────────────────────────────────────────────

const CIRCUIT_REF_PATTERN =
  /\b(?:(?:circuit|way)\s*(?:number\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+circuit)\b/gi;

// "circuit 16 amp" — a normaliser-collapsed "circuit 1 6 amp" where
// the speaker meant circuit 1 with a 16 A rating but the
// DIGIT_SEQUENCE_PATTERN merged "1 6" into "16" before the matcher
// saw it. Detected here as a refusal-to-match: when a circuit-ref
// number is immediately followed by an OCPD-rating context word
// ("amp"/"amps"/"a"), reject the ref so the segment doesn't
// misattribute readings to circuit 16.
//
// Codex R1 P1 (#1) deferred to R3 — see web/audit/INDEX.md Wave-C
// matcher follow-ups. v1 just drops the ambiguous segment; a future
// commit can synthesise the "circuit 1 + rating 6" split if it
// matters in production.
const CIRCUIT_REF_AMP_AMBIGUOUS_PATTERN = /\b(?:circuit|way)\s+\d+\s+(?:amp|amps|a)\b/i;

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

// ─────────────────────────────────────────────────────────────────
// Supply patterns
// ─────────────────────────────────────────────────────────────────

const ZE_PATTERN = new RegExp(
  `\\b(?:ze|z\\s+e|external\\s+(?:earth\\s+)?(?:loop\\s+)?impedance|external\\s+loop)[,;:\\s]+(?:is\\s+|of\\s+|=\\s*|reading\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

const PFC_PATTERN = new RegExp(
  `\\b(?:pfc|pscc|prospective\\s+(?:fault\\s+)?(?:short\\s+circuit\\s+)?current)\\s+(?:is\\s+|of\\s+|=\\s*|reading\\s+(?:is\\s+)?)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)\\s*(?:kilo\\s*amps?|k?a|amps?)?`,
  'gi'
);

// ─────────────────────────────────────────────────────────────────
// Per-circuit patterns
// ─────────────────────────────────────────────────────────────────

// Zs: "Zs is 0.34", "Zs 0.34". Excludes "Zs at DB / at the board"
// which is a board-level field iOS routes elsewhere.
const ZS_EXCLUDE_PATTERN = /\bzs\s+(?:at|of)\s+(?:the\s+)?(?:board|db|distribution|cu|fuse)\b/i;

const ZS_PATTERN = new RegExp(
  `\\bzs\\s+(?:is\\s+|of\\s+|=\\s*)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

const R1R2_PATTERN = new RegExp(
  `\\br\\s*1\\s*(?:\\+|plus|and)\\s*r\\s*2\\s+(?:(?:for\\s+circuit\\s+\\d+\\s+(?:is\\s+)?)?(?:is\\s+)?)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

// Bare R1 (treated as R1+R2 fallback per iOS). The "ring R1" /
// "ring R2" forms must NOT trigger the r1_r2_ohm fallback (codex
// P1 R3 fix); we enforce that downstream in matchCircuitFields by
// skipping this pattern when an explicit ring marker is present in
// the segment, rather than by lookbehind (older iOS Safari).
const RING_R1_PATTERN = new RegExp(
  `\\br\\s*1\\s+(?:is\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

// Explicit "ring R1 <value>" — only this maps to ring_r1.
const EXPLICIT_RING_R1_PATTERN = new RegExp(
  `\\bring\\s+r\\s*1\\s+(?:is\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

const RING_RN_PATTERN = new RegExp(
  `\\b(?:rn|neutrals?|nuts)\\s+(?:(?:is|are)\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

const RING_R2_PATTERN = new RegExp(
  `\\b(?:ring\\s+)?r\\s*2\\s+(?:is\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

const EXPLICIT_RING_R2_PATTERN = new RegExp(
  `\\bring\\s+r\\s*2\\s+(?:is\\s+)?${SPOKEN_ZERO_PREFIX}(\\d+\\.?\\d*)`,
  'gi'
);

// IR live-earth: prefix form ("IR live to earth is 299").
const IR_LIVE_EARTH_PATTERN =
  /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-–]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)(?:\s*(?:mega?\s*ohms?|MΩ|grooms?|meg))?/gi;

const IR_LE_GREATER_PATTERN =
  /\b(?:ir|insulation\s+resistance|inssy|megger|megging|(?:live|light)\s+(?:to\s+)?earth|l[-–]?e|l2[eh])\s+(?:(?:is|was|reads?)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/i;

// Postfix form ("greater than 299 mega ohms live to earth"):
const IR_LIVE_EARTH_POSTFIX_PATTERN =
  /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/gi;

const IR_LE_POSTFIX_GREATER_PATTERN =
  /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+(?:live|light)\s+to\s+earth/i;

const IR_LIVE_LIVE_PATTERN =
  /\b(?:live\s+to\s+(?:lives?|neutral)|l[-–]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)/gi;

const IR_LL_GREATER_PATTERN =
  /\b(?:live\s+to\s+(?:lives?|neutral)|l[-–]l)\s+(?:(?:is|are)\s+)?(?:also\s+)?(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)/i;

const IR_LIVE_LIVE_POSTFIX_PATTERN =
  /(?:greater\s+than\s+|more\s+than\s+|>\s*|over\s+)?(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/gi;

const IR_LL_POSTFIX_GREATER_PATTERN =
  /(?:greater\s+than|more\s+than|>|over)\s+(\d+\.?\d*)\s*(?:mega?\s*ohms?|MΩ|grooms?|rooms?)?\s+live\s+to\s+(?:lives?|neutral)/i;

// Test-voltage exclusion: "test voltage is 250" must not match the
// postfix IR pattern. Skip postfix when this fires.
const TEST_VOLTAGE_PATTERN = /\b(?:test\s+)?voltage\s+(?:is\s+|of\s+|=\s*)?(\d+)/i;

const RCD_TIME_PATTERN =
  /\brcd\s+(?:trip\s+(?:time\s+)?)?(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;

const RCD_TIME_FLEX_PATTERN =
  /\b(?:rcd\s+)?trip\s+time\s+(?:for\s+|on\s+)?(?:\w+\s+){0,5}(?:is\s+)?(\d+\.?\d*)\s*(?:ms|milliseconds?)?/gi;

const POLARITY_PATTERN = /\b(?:correct\s+)?polarity\s+(?:is\s+)?(?:ok|confirmed|pass|correct)/i;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function lastCapture(pattern: RegExp, text: string): string | null {
  // Use a fresh exec loop so the global pattern's lastIndex doesn't
  // leak across calls. Returns the LAST match's first capture group,
  // mirroring iOS lastCapture behaviour (the most recent reading
  // wins when multiple appear in the same window).
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const localPattern = new RegExp(pattern.source, flags);
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = localPattern.exec(text)) !== null) {
    lastMatch = m;
    if (m.index === localPattern.lastIndex) localPattern.lastIndex++;
  }
  return lastMatch ? (lastMatch[1] ?? null) : null;
}

function hasMatch(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text);
}

/** Run multiple patterns and return the FIRST capture group of the
 *  LATEST (highest-position) match across all of them. Used by the
 *  RCD trip-time matcher so a later flex-form correction wins over
 *  an earlier short-form reading in the same segment. */
function lastCaptureAcross(patterns: RegExp[], text: string): string | null {
  let bestIndex = -1;
  let bestValue: string | null = null;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const localPattern = new RegExp(pattern.source, flags);
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = localPattern.exec(text)) !== null) {
      if (m[1] != null && m.index >= bestIndex) {
        bestIndex = m.index;
        bestValue = m[1];
      }
      if (m.index === localPattern.lastIndex) localPattern.lastIndex++;
    }
  }
  return bestValue;
}

/** Two-decimal-place tell: a normaliser-collapsed fractional run that
 *  swallowed a following rating ("Zs point 6 0 1 6 amp" → "Zs 0.6016
 *  amp"). Matcher refuses to accept Zs / R1+R2 readings whose decimal
 *  portion is longer than 2 digits — real production values are
 *  always 1-2 dp at this layer. Documented R1 codex P1 follow-up. */
function looksLikeMergedDecimal(value: string): boolean {
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  return value.length - dot - 1 > 2;
}

function inRange(value: string, min: number, max: number): boolean {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return false;
  return n >= min && n <= max;
}

function getOrCreateCircuit(map: Map<string, CircuitUpdates>, ref: string): CircuitUpdates {
  let updates = map.get(ref);
  if (!updates) {
    updates = {};
    map.set(ref, updates);
  }
  return updates;
}

/** Resolve a circuit-ref match (group 1 = digit/word; group 2 =
 *  ordinal). Returns the canonical numeric string, or null if neither
 *  group fired. */
function extractCircuitRef(m: RegExpMatchArray): string | null {
  if (m[1]) {
    const raw = m[1].toLowerCase();
    return WORD_NUMBERS[raw] ?? raw;
  }
  if (m[2]) {
    const raw = m[2].toLowerCase();
    return ORDINAL_NUMBERS[raw] ?? null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Per-segment circuit-field matcher
// ─────────────────────────────────────────────────────────────────

function matchCircuitFields(
  text: string,
  circuitRef: string,
  result: RegexMatchResult,
  job: JobDetail,
  knownRing: Set<string>
): void {
  const updates = getOrCreateCircuit(result.circuitUpdates, circuitRef);

  // Zs — guarded by the "Zs at DB" exclusion + range + 2dp cap.
  if (!ZS_EXCLUDE_PATTERN.test(text)) {
    const zsRaw = lastCapture(ZS_PATTERN, text);
    if (zsRaw && inRange(zsRaw, ZS_MIN, ZS_MAX) && !looksLikeMergedDecimal(zsRaw)) {
      updates.measured_zs_ohm = zsRaw;
    }
  }

  // R1+R2 (compound — earth_continuity).
  if (!updates.r1_r2_ohm) {
    const r1r2Raw = lastCapture(R1R2_PATTERN, text);
    if (r1r2Raw && inRange(r1r2Raw, R1R2_MIN, R1R2_MAX) && !looksLikeMergedDecimal(r1r2Raw)) {
      updates.r1_r2_ohm = r1r2Raw;
    }
  }

  const isRing = isRingCircuit(circuitRef, text, job, knownRing);

  // Ring continuity FIRST (codex P1 R3 fix): explicit "ring R1" /
  // "ring R2" land in ring_r{1,2}_ohm. The bare-R1 / bare-R2
  // fallback below is then skipped if an explicit ring marker is
  // present so we don't double-write the same value to r1_r2_ohm
  // AND ring_r{1,2}_ohm. Ring fields require the JOB's circuit row
  // to actually be a ring (designation contains "ring") — codex P2
  // R3 fix: an inline "ring" word in the transcript is NOT enough.
  if (isRing) {
    const ringR1Raw = lastCapture(EXPLICIT_RING_R1_PATTERN, text);
    if (
      !updates.ring_r1_ohm &&
      ringR1Raw &&
      inRange(ringR1Raw, R1R2_MIN, R1R2_MAX) &&
      !looksLikeMergedDecimal(ringR1Raw)
    ) {
      updates.ring_r1_ohm = ringR1Raw;
    }
    const ringRnRaw = lastCapture(RING_RN_PATTERN, text);
    if (
      !updates.ring_rn_ohm &&
      ringRnRaw &&
      inRange(ringRnRaw, R1R2_MIN, R1R2_MAX) &&
      !looksLikeMergedDecimal(ringRnRaw)
    ) {
      updates.ring_rn_ohm = ringRnRaw;
    }
    const ringR2Raw = lastCapture(EXPLICIT_RING_R2_PATTERN, text);
    if (
      !updates.ring_r2_ohm &&
      ringR2Raw &&
      inRange(ringR2Raw, R1R2_MIN, R1R2_MAX) &&
      !looksLikeMergedDecimal(ringR2Raw)
    ) {
      updates.ring_r2_ohm = ringR2Raw;
    }
  }

  // Whether the segment carries an explicit "ring R1" / "ring R2"
  // phrase. When true, the bare-R1 / bare-R2 fallbacks below skip
  // (their match would simply re-capture the same digits and write
  // the value to r1_r2_ohm too — see codex P1 R3 above).
  const hasExplicitRingForm = /\bring\s+r\s*[12]\b/i.test(text);

  // Bare "R1 <value>" → R1+R2 fallback (iOS contract).
  if (!updates.r1_r2_ohm && !hasExplicitRingForm) {
    const ringR1Raw = lastCapture(RING_R1_PATTERN, text);
    if (ringR1Raw && inRange(ringR1Raw, R1R2_MIN, R1R2_MAX) && !looksLikeMergedDecimal(ringR1Raw)) {
      updates.r1_r2_ohm = ringR1Raw;
    }
  }

  // Bare "R2 <value>" → R1+R2 fallback.
  if (!updates.r1_r2_ohm && !hasExplicitRingForm) {
    const ringR2Raw = lastCapture(RING_R2_PATTERN, text);
    if (ringR2Raw && inRange(ringR2Raw, R1R2_MIN, R1R2_MAX) && !looksLikeMergedDecimal(ringR2Raw)) {
      updates.r1_r2_ohm = ringR2Raw;
    }
  }

  // IR live-earth — postfix wins over prefix (iOS contract). Skip
  // postfix when "test voltage is 250" appears (Deepgram occasionally
  // chains "test voltage" → "live to earth" in the same utterance).
  const hasTestVoltage = TEST_VOLTAGE_PATTERN.test(text);
  if (!hasTestVoltage) {
    const irLEPostfix = lastCapture(IR_LIVE_EARTH_POSTFIX_PATTERN, text);
    if (irLEPostfix) {
      const isGreater = IR_LE_POSTFIX_GREATER_PATTERN.test(text);
      updates.ir_live_earth_mohm = isGreater ? `>${irLEPostfix}` : irLEPostfix;
    }
  }
  if (!updates.ir_live_earth_mohm) {
    const irLE = lastCapture(IR_LIVE_EARTH_PATTERN, text);
    if (irLE) {
      const isGreater = IR_LE_GREATER_PATTERN.test(text);
      updates.ir_live_earth_mohm = isGreater ? `>${irLE}` : irLE;
    }
  }

  // IR live-live — same prefix-vs-postfix rule.
  if (!hasTestVoltage) {
    const irLLPostfix = lastCapture(IR_LIVE_LIVE_POSTFIX_PATTERN, text);
    if (irLLPostfix) {
      const isGreater = IR_LL_POSTFIX_GREATER_PATTERN.test(text);
      updates.ir_live_live_mohm = isGreater ? `>${irLLPostfix}` : irLLPostfix;
    }
  }
  if (!updates.ir_live_live_mohm) {
    const irLL = lastCapture(IR_LIVE_LIVE_PATTERN, text);
    if (irLL) {
      const isGreater = IR_LL_GREATER_PATTERN.test(text);
      updates.ir_live_live_mohm = isGreater ? `>${irLL}` : irLL;
    }
  }

  // RCD trip time. Codex P3 R3 fix: pick the LATER of the two
  // pattern's last matches. Without this, a "RCD 25" earlier in
  // the segment suppresses a "trip time ... 30" mentioned later
  // (the inspector correcting their reading).
  const rcdRaw = lastCaptureAcross([RCD_TIME_PATTERN, RCD_TIME_FLEX_PATTERN], text);
  if (rcdRaw && inRange(rcdRaw, RCD_MS_MIN, RCD_MS_MAX)) {
    updates.rcd_time_ms = rcdRaw;
  }

  // Polarity.
  if (POLARITY_PATTERN.test(text)) {
    updates.polarity_confirmed = '✓';
  }

  // Drop the bucket if nothing matched (caller can check empty).
  if (Object.keys(updates).length === 0) {
    result.circuitUpdates.delete(circuitRef);
  }
}

/** Per-session "circuits identified as ring" cache. Once a ref has
 *  been classified as a ring (via designation OR explicit transcript
 *  form), subsequent utterances in the same session keep that
 *  classification — important for the active-circuit follow-up flow:
 *  "Circuit 5 ring R1 is 0.34" then "neutrals are 0.36" within the
 *  30s window must both land in the ring_r{1,n}_ohm fields. Cleared
 *  on `reset()` (session boundary). */
function isRingCircuit(
  circuitRef: string,
  text: string,
  job: JobDetail,
  knownRing: Set<string>
): boolean {
  // Sticky cache hit (codex P1 #2 R3 follow-up, the active-circuit-
  // workflow case).
  if (knownRing.has(circuitRef)) return true;

  const circuits =
    (job.circuits as Array<{ circuit_ref?: string; circuit_designation?: string }>) ?? [];
  const row = circuits.find((c) => c.circuit_ref === circuitRef);

  // No row found at all → don't trust the transcript wording. iOS
  // never invents ring/non-ring classification for circuits that
  // don't yet exist in the job (codex P2 #2 R3 follow-up). The
  // matcher will fall through to the bare-R1/R2 → r1_r2_ohm
  // fallback, the conservative safe default.
  if (!row) return false;

  const designation = row.circuit_designation?.trim() ?? '';
  if (designation.length > 0) {
    // Case (a) + (c): trust the labelled designation.
    if (/\bring\b/i.test(designation)) {
      knownRing.add(circuitRef);
      return true;
    }
    return false;
  }
  // Case (b): row exists with blank designation — trust the
  // explicit transcript form, then cache so follow-ups within the
  // session don't need to re-prove it.
  if (/\bring\s+r\s*[12]\b/i.test(text)) {
    knownRing.add(circuitRef);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Supply-field matcher (Ze + PFC)
// ─────────────────────────────────────────────────────────────────

function matchSupplyFields(text: string, result: RegexMatchResult): void {
  const zeRaw = lastCapture(ZE_PATTERN, text);
  if (zeRaw && inRange(zeRaw, ZS_MIN, ZS_MAX) && !looksLikeMergedDecimal(zeRaw)) {
    result.supplyUpdates.ze = zeRaw;
  }
  const pfcRaw = lastCapture(PFC_PATTERN, text);
  if (pfcRaw && Number.parseFloat(pfcRaw) > 0) {
    result.supplyUpdates.pfc = pfcRaw;
  }
}

// ─────────────────────────────────────────────────────────────────
// Public matcher class
// ─────────────────────────────────────────────────────────────────

export class TranscriptFieldMatcher {
  private lastProcessedOffset = 0;
  private activeCircuitRef: string | null = null;
  private activeCircuitRefTimestamp: number | null = null;
  /** Per-session sticky cache of circuit refs identified as ring
   *  circuits. See `isRingCircuit` docstring for rationale. */
  private readonly knownRingCircuits = new Set<string>();

  /** Reset all sliding-window + active-circuit state. Call at
   *  session boundaries (start / stop / mic toggle) so a new
   *  session doesn't pick up state from a stale one. */
  reset(): void {
    this.lastProcessedOffset = 0;
    this.activeCircuitRef = null;
    this.activeCircuitRefTimestamp = null;
    this.knownRingCircuits.clear();
  }

  /** Match patterns against a transcript window. Caller passes the
   *  full accumulated transcript; the matcher internally clips to a
   *  500-char rolling window so execution stays constant-time as
   *  the session grows. Returns a `RegexMatchResult` describing the
   *  fields detected in this window — empty maps if nothing fired. */
  match(transcript: string, job: JobDetail): RegexMatchResult {
    const result: RegexMatchResult = {
      supplyUpdates: {},
      circuitUpdates: new Map(),
    };

    const newChars = transcript.length - this.lastProcessedOffset;
    if (newChars <= 0) return result;
    if (transcript.trim().length === 0) return result;

    // Sliding window: the last 500 chars cover ~3 typical utterances
    // and keep regex execution O(window) instead of O(transcript).
    const windowStart = Math.max(0, transcript.length - WINDOW_SIZE);
    const window = transcript.slice(windowStart);
    this.lastProcessedOffset = transcript.length;

    // Expire active-circuit tracking after 30 s.
    if (
      this.activeCircuitRefTimestamp !== null &&
      Date.now() - this.activeCircuitRefTimestamp > ACTIVE_CIRCUIT_EXPIRY_MS
    ) {
      this.activeCircuitRef = null;
      this.activeCircuitRefTimestamp = null;
    }

    matchSupplyFields(window, result);
    this.matchCircuitFieldsBySegment(window, result, job);

    return result;
  }

  /** Test-only inspector for the per-session ring-circuit cache.
   *  Lets the matcher's regression suite verify that classifications
   *  carry across calls. Not part of the public production API. */
  _knownRingCircuitsForTest(): ReadonlySet<string> {
    return this.knownRingCircuits;
  }

  private matchCircuitFieldsBySegment(
    window: string,
    result: RegexMatchResult,
    job: JobDetail
  ): void {
    const refMatches: { ref: string; start: number; end: number }[] = [];
    const re = new RegExp(CIRCUIT_REF_PATTERN.source, 'gi');
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(window)) !== null) {
      const ref = extractCircuitRef(m);
      if (!ref) continue;
      // Codex R1 P1 deferral: refuse "circuit N amp" matches where N
      // is directly followed by an OCPD-rating word — almost always
      // a normaliser-collapsed "circuit X N amp" (single-digit
      // circuit + rating). See pattern docstring.
      const matchTail = window.slice(m.index, m.index + m[0].length + 5);
      if (CIRCUIT_REF_AMP_AMBIGUOUS_PATTERN.test(matchTail)) {
        if (m.index === re.lastIndex) re.lastIndex++;
        continue;
      }
      refMatches.push({ ref, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }

    if (refMatches.length === 0) {
      // No explicit "circuit N" in this window. Fall back to active
      // circuit ref if one is still live.
      if (this.activeCircuitRef) {
        matchCircuitFields(window, this.activeCircuitRef, result, job, this.knownRingCircuits);
      }
      return;
    }

    // Segment by circuit-ref position. Each segment starts AFTER the
    // ref match and runs to the next ref or end of window.
    for (let i = 0; i < refMatches.length; i++) {
      const { ref, end } = refMatches[i];
      const segEnd = i + 1 < refMatches.length ? refMatches[i + 1].start : window.length;
      if (segEnd <= end) continue;
      const segText = window.slice(end, segEnd);
      this.activeCircuitRef = ref;
      this.activeCircuitRefTimestamp = Date.now();
      matchCircuitFields(segText, ref, result, job, this.knownRingCircuits);
    }
  }
}
