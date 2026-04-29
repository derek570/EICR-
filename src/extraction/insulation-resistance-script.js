/**
 * Insulation resistance script — server-driven micro-conversation that
 * captures the two IR readings (Live-to-Live, Live-to-Earth) for a single
 * circuit and prompts for the test voltage when the field hasn't been set.
 *
 * Background — 2026-04-29: same fragmentation problem ring continuity has,
 * applied to IR. Field-test session 17C4135E (job_1777459894020, 11:51 BST)
 * lost a 299 MΩ live-to-earth reading because Sonnet had no circuit
 * context across turns: the inspector said "live to live 299" (recorded ✓)
 * then "live to earth 299" on the next utterance, and Sonnet's ask_user
 * disambiguation flow dropped the answer when the answer-resolver path
 * failed (separate fix shipped in 6157a28). The structural problem remains:
 * IR is a sequential test-pair with predictable shape, and pushing every
 * fragment back through Sonnet introduces a class of attribution failures.
 *
 * Mirrors `ring-continuity-script.js` exactly (same lifecycle, same wire
 * shapes, same exit conditions) so iOS does not need a code change. The
 * differences:
 *
 *   - Two readings instead of three. Order: LL → LE if both missing; if
 *     one is filled (volunteered on entry, or pre-existing on the snapshot
 *     from an earlier turn) ask only the other.
 *   - "Greater than N" / "over N" / ">N" / "off scale" / "OL" / "infinite"
 *     sentinels — schema permits ">200", ">999", any value. Parse forms
 *     into canonical ">N" string. Saturation words map to ">999".
 *   - Test voltage ask after both readings: if the circuit's
 *     `ir_test_voltage_v` field is empty, TTS asks "What was the test
 *     voltage?" before the completion announcement. If voltage is already
 *     populated (default 500V applied upstream, or recorded earlier), the
 *     script skips straight to completion. The voltage prompt is at the
 *     END so the inspector's natural flow (probe → reading → reading) is
 *     not interrupted.
 *
 * Contract:
 *   - Sits alongside `insulation-resistance-timeout.js` (60s detector for
 *     partial fills the script left behind on cancel / topic-switch / hard
 *     timeout). Both can be active for the same session at once.
 *   - Wire output mirrors what Sonnet would emit: `{type: 'extraction',
 *     result: {readings: [...]}}` for writes, `{type: 'ask_user_started'}`
 *     for TTS prompts. iOS does not need a code change.
 *
 * State (attached to EICRExtractionSession instance as `insulationResistanceScript`):
 *   {
 *     active: boolean,
 *     circuit_ref: number | null,
 *     values: { ir_live_live_mohm?, ir_live_earth_mohm?, ir_test_voltage_v? },
 *     phase: 'readings' | 'voltage',
 *     pending_writes: [],            // values dictated before a circuit was named
 *     entered_at: number (ms),
 *     last_turn_at: number (ms),
 *   }
 */

import { IR_FIELDS, recordIrWrite, clearIrState } from './insulation-resistance-timeout.js';
import { applyReadingToSnapshot } from './stage6-snapshot-mutators.js';

/**
 * Hard cap on script duration. If the inspector enters the script and then
 * goes silent for this long, state is cleared on the next turn. The 60s
 * timeout module is the partial-fill safety net after that.
 */
export const IR_SCRIPT_HARD_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * The voltage field — recorded after both readings if not already set.
 */
const VOLTAGE_FIELD = 'ir_test_voltage_v';

/**
 * Map canonical IR fields to the words the inspector would speak.
 */
const FIELD_PROMPTS = {
  ir_live_live_mohm: { tts: "What's the live-to-live?", label: 'live-to-live' },
  ir_live_earth_mohm: { tts: "What's the live-to-earth?", label: 'live-to-earth' },
};

const VOLTAGE_PROMPT = 'What was the test voltage?';

/**
 * Entry triggers — variations that start the script. Pattern 1 ("full")
 * matches "insulation resistance" with optional "circuit N" within ~50
 * chars. Pattern 2 ("terse") matches "IR for circuit N" but REQUIRES
 * "circuit N" to avoid false-positives on the bigram "I R" appearing in
 * unrelated speech.
 *
 * Garbled Deepgram variants of "resistance" tolerated up to similar shape.
 *
 * Head-word alternation `(?:insulation|installation)` (2026-04-29, session
 * 6754FE6E): Deepgram routinely mishears "insulation" as "installation"
 * — both end in "-stallation"-shaped acoustics and "installation
 * resistance" is a phrase the model favours from training data. Without
 * this alternation, the IR script never enters and the IR walk-through
 * is skipped entirely (the failure mode that left a half-filled IR row
 * in session 6754FE6E). Acceptable false-positive surface: someone
 * narrating about an actual installation alongside the word "resistance"
 * — vanishingly unlikely in mid-test dictation.
 */
const IR_ENTRY_PATTERNS = [
  // 1. Full: "insulation/installation resistance" + optional "circuit N"
  /\b(?:insulation|installation)\s+(?:resistance|res(?:istance|istence|istense)?)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // 2. Terse: "IR for circuit N" — requires "circuit N" trailer.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\bi\s*r\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,
];

/**
 * Cancel triggers — exit, preserve writes. Same vocabulary as ring.
 */
const IR_CANCEL_PATTERNS = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|skip(?:\s+(?:this|that|ir|insulation))?|scrap(?:\s+(?:that|this|ir|insulation))?|forget\s+(?:it|that|this)|never\s+mind|abort|ignore\s+(?:that|this))\b/i,
];

/**
 * Topic-switch triggers — utterances that announce a different test or a
 * different circuit. Crucially do NOT match named-field words for IR
 * ("live to live", "live to earth", "voltage") — those are values FOR
 * the script.
 *
 * Note: "ring continuity" / "lives" / "neutrals" / "earths" / "CPC" are
 * topic switches — they signal a move to ring continuity. The IR script's
 * named-field vocabulary is intentionally narrower than ring's so the two
 * scripts don't fight over ambiguous shorthand. If the inspector wants to
 * dictate IR, they say "live to live"; if they want ring, they say "lives".
 */
const TOPIC_SWITCH_PATTERNS = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i, // "Zs is 0.62", "Ze of 0.18"
  /\bcircuit\s+\d+\s+is\b/i, // "circuit 5 is the cooker"
  /\bR\s*1\s*\+\s*R\s*2\b/i, // "R1+R2"
  /\bring\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
  // Bare ring-field words — when said in isolation in IR mode, the
  // inspector has switched topic to ring. (In ring mode these are values;
  // here they're a topic switch. Same word, different context.)
  /\b(?:lives|neutrals|cpc|c\s*p\s*c)\s+(?:are|is|at|=)\b/i,
];

/**
 * Detect a different IR entry on a NEW circuit while one is already active.
 */
function detectDifferentIrEntry(text, currentCircuitRef) {
  for (const pattern of IR_ENTRY_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const newRef = Number(m[1]);
      if (Number.isInteger(newRef) && newRef > 0 && newRef !== currentCircuitRef) {
        return newRef;
      }
    }
  }
  return null;
}

/**
 * Detect script entry from a transcript.
 */
export function detectEntry(text) {
  if (typeof text !== 'string' || !text) return { matched: false, circuit_ref: null };
  for (const pattern of IR_ENTRY_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const ref = m[1] ? Number(m[1]) : null;
      const validRef = Number.isInteger(ref) && ref > 0 ? ref : null;
      return { matched: true, circuit_ref: validRef };
    }
  }
  return { matched: false, circuit_ref: null };
}

export function detectCancel(text) {
  if (typeof text !== 'string' || !text) return false;
  return IR_CANCEL_PATTERNS.some((p) => p.test(text));
}

export function detectTopicSwitch(text) {
  if (typeof text !== 'string' || !text) return false;
  return TOPIC_SWITCH_PATTERNS.some((p) => p.test(text));
}

/**
 * Parse an IR reading value from a transcript fragment.
 *
 * Recognised shapes (order matters — most specific first):
 *   - Greater-than: "greater than 200", "over 999", ">200", "more than X",
 *     "above X" → ">N" (the integer or decimal is preserved verbatim)
 *   - Saturation sentinels: "infinite", "infinity", "off scale", "OL",
 *     "out of range", "maxed out" → ">999" (canonical max — IR meters
 *     typically saturate at 999 MΩ; the schema's ai_guidance says
 *     `'>200' or '999' if meter maxed out`)
 *   - Numeric: "200", "0.43", ".43" → preserved as-spoken with a leading-
 *     zero normalisation
 *
 * The greater-than form accepts ANY value (per the field-test request) —
 * "greater than 500" is a perfectly valid answer when the inspector's
 * meter scale tops out at 500. The schema validator downstream allows
 * arbitrary text in `ir_live_*_mohm` (type "text"), so any ">N" string
 * passes through.
 *
 * Returns the canonical string value or null if no parseable value found.
 */
export function parseValue(text) {
  if (typeof text !== 'string') return null;

  // 1. Explicit greater-than forms. Allow integer or decimal payload.
  //    Patterns matched (case-insensitive):
  //      "greater than 200" / "greater than .5"
  //      "greater then 200"  (Deepgram occasionally hears "than" as "then")
  //      "more than 500"
  //      "over 999" / "above 200"
  //      ">200" / "> 200"
  //    Exclude "above zero" / "over zero" — those parse as ">0" which is
  //    technically valid input; downstream validators flag if needed.
  const gt = text.match(
    /(?:greater\s+(?:than|then)|more\s+than|over|above|>)\s*(\d+(?:\.\d+)?|\.\d+)/i
  );
  if (gt) {
    const raw = gt[1];
    // Leading-zero normalise a bare ".5" → "0.5"
    const normalised = raw.startsWith('.') ? `0${raw}` : raw;
    return `>${normalised}`;
  }

  // 2. Saturation sentinels — meter is over-range. Canonical ">999".
  //    `lim` / `limit` added 2026-04-29 (session 6754FE6E) — UK megger
  //    meters (Megger MFT, Kewtech KT64, Fluke 1664) display "LIM" or
  //    "LIMIT" when the reading exceeds the configured test range, and
  //    inspectors say it verbatim. The Deepgram vocabulary doesn't bias
  //    against the shape so transcripts arrive as literal "LIM" / "LIMIT".
  //    Same canonical mapping as the other saturation forms — `>999`.
  if (
    /\b(?:infinite|infinity|off\s*scale|out\s*of\s*range|o\s*l|lim(?:it)?|max(?:ed)?(?:\s+out)?)\b/i.test(
      text
    )
  ) {
    return '>999';
  }

  // 3. Numeric — accept "200", "0.43", ".43", or integer "1".
  const m = text.match(/-?\d*\.\d+|-?\d+/);
  if (!m) return null;
  const raw = m[0];
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.startsWith('.')) return `0${raw}`;
  if (raw.startsWith('-.')) return `-0${raw.slice(1)}`;
  return raw;
}

/**
 * Parse a test voltage from the inspector's reply to "What was the test
 * voltage?". Common values: 100, 250, 500, 1000. iOS NumberNormaliser
 * already converts spoken "five hundred" → "500" before the transcript
 * reaches the backend, so we only need to recognise digits.
 *
 * Sanity range 50..2500 — anything outside that is almost certainly a
 * misparse (a circuit reference, a Zs value, etc.) — return null and let
 * the script re-ask.
 */
export function parseVoltage(text) {
  if (typeof text !== 'string') return null;
  // Take the first 2-4 digit integer in the text. IR voltage is always
  // integer (no decimal) and in the hundreds.
  const m = text.match(/\b(\d{2,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 50 || n > 2500) return null;
  return String(n);
}

/**
 * Try to extract one or both named-field IR readings from a transcript.
 * Recognises "live to live <value>" and "live to earth <value>" plus
 * common shorthand variants ("L L", "L to L", "L E", "L to E").
 *
 * Returns an ordered array of {field, value} for every match found.
 */
export function extractNamedFieldValues(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const valueGroup =
    '>\\s*\\d+(?:\\.\\d+)?|>\\s*\\.\\d+|greater\\s+(?:than|then)\\s+\\d+(?:\\.\\d+)?|greater\\s+(?:than|then)\\s+\\.\\d+|more\\s+than\\s+\\d+(?:\\.\\d+)?|more\\s+than\\s+\\.\\d+|over\\s+\\d+(?:\\.\\d+)?|above\\s+\\d+(?:\\.\\d+)?|infinite|infinity|off\\s*scale|out\\s*of\\s*range|o\\s*l|lim(?:it)?|max(?:ed)?(?:\\s+out)?|\\d*\\.?\\d+';
  // Field words (case-insensitive). The negative lookahead on "L L"-style
  // shorthand keeps it from biting on "L1" or letters inside other words.
  const patterns = [
    {
      field: 'ir_live_live_mohm',
      // "live to live", "line to line", "L to L", "L L" / "LL" / "L-L" / "L.L".
      // Separator class allows 0+ space/dot/dash so all of "LL", "L L", "L.L.",
      // "L-L" land. Word boundaries on both ends prevent biting on "ll" inside
      // words like "called" / "yellow".
      re: new RegExp(
        `\\b(?:live\\s+to\\s+live|line\\s+to\\s+line|l\\s+to\\s+l|l[\\s.-]*l)\\b[^\\d∞>a-z]{0,30}?(${valueGroup})`,
        'i'
      ),
    },
    {
      field: 'ir_live_earth_mohm',
      // "live to earth", "line to earth", "L to E", "L E" / "LE" / "L-E" / "L.E".
      re: new RegExp(
        `\\b(?:live\\s+to\\s+earth|line\\s+to\\s+earth|l\\s+to\\s+e|l[\\s.-]*e)\\b[^\\d∞>a-z]{0,30}?(${valueGroup})`,
        'i'
      ),
    },
  ];
  for (const { field, re } of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const val = parseValue(m[1]);
      if (val !== null) out.push({ field, value: val });
    }
  }
  return out;
}

function initScript(session, circuit_ref, now) {
  session.insulationResistanceScript = {
    active: true,
    circuit_ref,
    values: {},
    phase: 'readings',
    pending_writes: [],
    entered_at: now,
    last_turn_at: now,
  };
}

function clearScript(session) {
  if (session) session.insulationResistanceScript = null;
}

/**
 * Find the next missing reading in canonical LL → LE order. Returns null
 * if both are filled. Voltage is handled separately (via the phase=='voltage'
 * branch, only after both readings are in).
 */
function nextMissingReading(values) {
  for (const f of IR_FIELDS) {
    if (values[f] === undefined || values[f] === null || values[f] === '') return f;
  }
  return null;
}

function safeSend(ws, payload) {
  if (!ws || typeof ws.send !== 'function') return;
  try {
    if (ws.readyState !== undefined && ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch {
    // Intentional: WS send failures must not tear down the script.
  }
}

function buildScriptAsk({ sessionId, circuit_ref, missing_field, now, kind }) {
  if (kind === 'which_circuit') {
    return {
      type: 'ask_user_started',
      tool_call_id: `srv-irs-${sessionId}-which-${now}`,
      question: 'Which circuit is the insulation resistance for?',
      reason: 'missing_context',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'value',
    };
  }
  if (kind === 'voltage') {
    return {
      type: 'ask_user_started',
      tool_call_id: `srv-irs-${sessionId}-${circuit_ref}-${VOLTAGE_FIELD}-${now}`,
      question: VOLTAGE_PROMPT,
      reason: 'missing_value',
      context_field: VOLTAGE_FIELD,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    };
  }
  return {
    type: 'ask_user_started',
    tool_call_id: `srv-irs-${sessionId}-${circuit_ref}-${missing_field}-${now}`,
    question: FIELD_PROMPTS[missing_field]?.tts ?? `What's the ${missing_field}?`,
    reason: 'missing_value',
    context_field: missing_field,
    context_circuit: circuit_ref,
    expected_answer_shape: 'value',
  };
}

function buildScriptInfo({ sessionId, kind, text, now }) {
  return {
    type: 'ask_user_started',
    tool_call_id: `srv-irs-${sessionId}-${kind}-${now}`,
    question: text,
    reason: 'info',
    context_field: null,
    context_circuit: null,
    expected_answer_shape: 'none',
  };
}

function buildExtractionPayload(circuit_ref, writes) {
  return {
    type: 'extraction',
    result: {
      readings: writes.map((w) => ({
        field: w.field,
        circuit: circuit_ref,
        value: w.value,
        confidence: 1.0,
        source: 'ir_script',
      })),
      observations: [],
      questions: [],
    },
  };
}

/**
 * Apply a write to the snapshot, the script's local values map, the 60s
 * timer's per-circuit timestamp, and produce a wire-extraction record.
 *
 * Voltage writes do NOT bump the IR-timeout per-circuit timestamp — the
 * timeout module tracks the two readings, not the voltage field.
 */
function applyWrite(session, circuit_ref, field, value, now) {
  applyReadingToSnapshot(session.stateSnapshot, {
    circuit: circuit_ref,
    field,
    value,
  });
  if (session.insulationResistanceScript) {
    session.insulationResistanceScript.values[field] = value;
    session.insulationResistanceScript.last_turn_at = now;
  }
  if (IR_FIELDS.includes(field)) {
    recordIrWrite(session, circuit_ref, now);
  }
}

/**
 * Read whatever IR values + voltage already exist on the snapshot for a
 * given circuit. Tolerant of the same schema shape variations as the ring
 * timeout module.
 */
function readExistingIrValues(session, circuit_ref) {
  const out = {};
  const snapshot = session?.stateSnapshot;
  if (!snapshot) return out;
  const circuits = snapshot.circuits;
  let bucket = null;
  if (circuits && typeof circuits === 'object' && !Array.isArray(circuits)) {
    bucket = circuits[circuit_ref] || circuits[String(circuit_ref)] || null;
  } else if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  }
  if (!bucket) return out;
  for (const f of [...IR_FIELDS, VOLTAGE_FIELD]) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}

/**
 * Look up a circuit by its designation. Mirrors the ring script helper —
 * supports the "downstairs sockets" answer shape when the script's
 * "Which circuit?" prompt would otherwise expect a digit.
 */
function findCircuitByDesignation(session, text) {
  if (typeof text !== 'string' || !text) return null;
  const snapshot = session?.stateSnapshot;
  if (!snapshot?.circuits) return null;
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalised) return null;

  const circuits = snapshot.circuits;
  const entries = Array.isArray(circuits)
    ? circuits.map((c) => [c?.circuit_ref, c])
    : Object.entries(circuits);

  const matches = [];
  for (const [refKey, bucket] of entries) {
    if (!bucket || typeof bucket !== 'object') continue;
    const ref = Number(refKey);
    if (!Number.isInteger(ref) || ref <= 0) continue;
    const designation = bucket.designation;
    if (typeof designation !== 'string' || !designation.trim()) continue;
    const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normDes) continue;
    if (normalised.includes(normDes) || normDes.includes(normalised)) {
      matches.push(ref);
    }
  }
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Decide the next action on a script that has a known circuit_ref. Returns
 * one of:
 *   - { kind: 'ask_reading', field }   — still missing one of LL/LE
 *   - { kind: 'ask_voltage' }          — both readings in, voltage missing
 *   - { kind: 'done' }                 — everything filled
 */
function nextScriptStep(session, circuit_ref) {
  const state = session.insulationResistanceScript;
  const missingReading = nextMissingReading(state.values);
  if (missingReading) return { kind: 'ask_reading', field: missingReading };

  // Both readings filled. Check voltage.
  const existingVoltage =
    state.values[VOLTAGE_FIELD] ?? readExistingIrValues(session, circuit_ref)[VOLTAGE_FIELD];
  if (!existingVoltage) return { kind: 'ask_voltage' };

  return { kind: 'done' };
}

/**
 * Emit completion TTS and clear state.
 */
function finishScript(ws, session, sessionId, now, logger) {
  const state = session.insulationResistanceScript;
  if (!state) return;
  const { circuit_ref, values } = state;
  const ll = values.ir_live_live_mohm ?? '?';
  const le = values.ir_live_earth_mohm ?? '?';
  const v = values[VOLTAGE_FIELD];
  const voltageClause = v ? `, voltage ${v}` : '';
  safeSend(
    ws,
    buildScriptInfo({
      sessionId,
      kind: 'done',
      text: `Got it. L-L ${ll}, L-E ${le}${voltageClause}.`,
      now,
    })
  );
  logger?.info?.('stage6.insulation_resistance_script_completed', {
    sessionId,
    circuit_ref,
    values: { ...values },
  });
  clearScript(session);
  clearIrState(session, circuit_ref);
}

/**
 * Process one transcript turn against the IR script. Same return contract
 * as `processRingContinuityTurn` — the caller in sonnet-stream.js treats
 * both scripts identically.
 *
 * Returns one of:
 *   - { handled: false }                                  → not active and
 *                                                            no entry trigger
 *   - { handled: true, fallthrough: false }               → consumed turn,
 *                                                            skip Sonnet
 *   - { handled: true, fallthrough: true, transcriptText} → topic switch /
 *                                                            unresolvable
 *                                                            circuit, run
 *                                                            Sonnet on the
 *                                                            same transcript
 */
export function processInsulationResistanceTurn(ctx) {
  const { ws, session, sessionId, transcriptText, logger, now = Date.now() } = ctx;
  if (!session) return { handled: false };

  const state = session.insulationResistanceScript;
  const text = typeof transcriptText === 'string' ? transcriptText : '';

  // ───────────────────────────────────────── Hard timeout sweep ──
  if (state?.active && now - state.last_turn_at > IR_SCRIPT_HARD_TIMEOUT_MS) {
    logger?.info?.('stage6.insulation_resistance_script_hard_timeout', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled: Object.keys(state.values).length,
      ms_since_last_turn: now - state.last_turn_at,
    });
    clearScript(session);
    // Fall through to entry detection — user might be starting a fresh script.
  }

  // ─────────────────────────────────────── Inactive: detect entry ──
  const stateAfterSweep = session.insulationResistanceScript;
  if (!stateAfterSweep?.active) {
    const entry = detectEntry(text);
    if (!entry.matched) return { handled: false };

    // Entry-time designation lookup (2026-04-29, mirrors ring-continuity-
    // script.js fix from session 6754FE6E): the entry regex's circuit-
    // capture group only matches the literal word "circuit" + digits.
    // An inspector saying "insulation resistance for upstairs sockets,
    // live to live is 200" matches the head but the "for upstairs
    // sockets" portion is invisible to the capture group, so the script
    // would ask "Which circuit?" — even though the designation was right
    // there. When the regex didn't capture a digit, run
    // findCircuitByDesignation against the entry text. The same helper
    // already runs in the active path's resolve block; calling it one
    // turn earlier removes the unnecessary disambiguation prompt.
    let circuitRef = entry.circuit_ref;
    let entryDesignationMatched = false;
    if (circuitRef === null) {
      const designationMatch = findCircuitByDesignation(session, text);
      if (designationMatch !== null) {
        circuitRef = designationMatch;
        entryDesignationMatched = true;
      }
    }
    const existing = circuitRef ? readExistingIrValues(session, circuitRef) : {};
    const volunteered = extractNamedFieldValues(text);

    initScript(session, circuitRef, now);

    // Seed values from existing snapshot.
    for (const [f, v] of Object.entries(existing)) {
      if ([...IR_FIELDS, VOLTAGE_FIELD].includes(f) && v !== '' && v !== null && v !== undefined) {
        session.insulationResistanceScript.values[f] = v;
      }
    }

    // Apply or queue volunteered values.
    const writes = [];
    for (const w of volunteered) {
      if (session.insulationResistanceScript.values[w.field] !== undefined) continue;
      if (circuitRef !== null) {
        applyWrite(session, circuitRef, w.field, w.value, now);
        writes.push(w);
      } else {
        session.insulationResistanceScript.pending_writes.push(w);
      }
    }

    if (writes.length > 0) {
      safeSend(ws, buildExtractionPayload(circuitRef, writes));
    }

    logger?.info?.('stage6.insulation_resistance_script_entered', {
      sessionId,
      circuit_ref: circuitRef,
      entry_designation_matched: entryDesignationMatched,
      pre_existing_filled: Object.keys(existing).filter((f) =>
        [...IR_FIELDS, VOLTAGE_FIELD].includes(f)
      ),
      volunteered_writes: writes.map((w) => w.field),
      pending_writes: session.insulationResistanceScript.pending_writes.map((w) => w.field),
      textPreview: text.slice(0, 80),
    });

    if (circuitRef === null) {
      safeSend(
        ws,
        buildScriptAsk({
          sessionId,
          circuit_ref: null,
          missing_field: null,
          now,
          kind: 'which_circuit',
        })
      );
      return { handled: true, fallthrough: false };
    }

    const step = nextScriptStep(session, circuitRef);
    if (step.kind === 'done') {
      finishScript(ws, session, sessionId, now, logger);
      return { handled: true, fallthrough: false };
    }
    if (step.kind === 'ask_voltage') {
      session.insulationResistanceScript.phase = 'voltage';
      safeSend(
        ws,
        buildScriptAsk({
          sessionId,
          circuit_ref: circuitRef,
          missing_field: VOLTAGE_FIELD,
          now,
          kind: 'voltage',
        })
      );
      return { handled: true, fallthrough: false };
    }
    safeSend(
      ws,
      buildScriptAsk({
        sessionId,
        circuit_ref: circuitRef,
        missing_field: step.field,
        now,
        kind: 'value',
      })
    );
    return { handled: true, fallthrough: false };
  }

  // ────────────────────────────────────────────── Active: handle turn ──
  state.last_turn_at = now;

  // 1. Cancel.
  if (detectCancel(text)) {
    const filled = Object.keys(state.values).filter((f) => IR_FIELDS.includes(f)).length;
    logger?.info?.('stage6.insulation_resistance_script_cancelled', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
      textPreview: text.slice(0, 80),
    });
    safeSend(
      ws,
      buildScriptInfo({
        sessionId,
        kind: 'cancel',
        text:
          filled > 0
            ? `Insulation resistance cancelled. ${filled} of 2 saved.`
            : 'Insulation resistance cancelled.',
        now,
      })
    );
    clearScript(session);
    return { handled: true, fallthrough: false };
  }

  // 2. Different IR entry on a NEW circuit — seamlessly switch.
  const newRef = detectDifferentIrEntry(text, state.circuit_ref);
  if (newRef !== null) {
    logger?.info?.('stage6.insulation_resistance_script_switched_circuit', {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: Object.keys(state.values).filter((f) => IR_FIELDS.includes(f)).length,
      textPreview: text.slice(0, 80),
    });
    clearScript(session);
    return processInsulationResistanceTurn({ ...ctx, now });
  }

  // 3. Topic switch.
  if (detectTopicSwitch(text)) {
    logger?.info?.('stage6.insulation_resistance_script_topic_switch', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled: Object.keys(state.values).filter((f) => IR_FIELDS.includes(f)).length,
      textPreview: text.slice(0, 80),
    });
    clearScript(session);
    return { handled: true, fallthrough: true, transcriptText };
  }

  // 4. Resolve circuit FIRST if pending.
  const writes = [];
  let drainedFromPending = false;
  let circuitResolvedThisTurn = false;
  if (state.circuit_ref === null) {
    const m = text.match(/\bcircuit\s*(\d{1,3})\b|^\s*(\d{1,3})\s*\.?\s*$/i);
    let ref = m ? Number(m[1] ?? m[2]) : NaN;

    if (!Number.isInteger(ref) || ref <= 0) {
      const designationMatch = findCircuitByDesignation(session, text);
      if (designationMatch !== null) {
        ref = designationMatch;
        logger?.info?.('stage6.insulation_resistance_script_designation_match', {
          sessionId,
          circuit_ref: ref,
          textPreview: text.slice(0, 80),
        });
      }
    }

    if (Number.isInteger(ref) && ref > 0) {
      state.circuit_ref = ref;
      circuitResolvedThisTurn = true;
      const existing = readExistingIrValues(session, ref);
      for (const [f, v] of Object.entries(existing)) {
        if (
          [...IR_FIELDS, VOLTAGE_FIELD].includes(f) &&
          v !== '' &&
          v !== null &&
          v !== undefined
        ) {
          state.values[f] = v;
        }
      }
      // Drain pending_writes onto the resolved circuit.
      if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
        for (const w of state.pending_writes) {
          if (state.values[w.field] !== undefined) continue;
          applyWrite(session, ref, w.field, w.value, now);
          writes.push(w);
          drainedFromPending = true;
        }
        state.pending_writes = [];
      }
      logger?.info?.('stage6.insulation_resistance_script_circuit_resolved', {
        sessionId,
        circuit_ref: ref,
        pre_existing_filled: Object.keys(state.values).filter(
          (f) => !writes.some((w) => w.field === f)
        ),
        drained_pending_writes: writes.map((w) => w.field),
        textPreview: text.slice(0, 80),
      });
    } else {
      // Couldn't resolve a circuit. Mirror ring's "queue values, stay
      // alive" pattern: if the inspector volunteered MORE field values
      // while waiting on the circuit, queue them and wait silently.
      const followUpVolunteered = extractNamedFieldValues(text);
      if (followUpVolunteered.length > 0) {
        for (const w of followUpVolunteered) {
          const alreadyQueued = (state.pending_writes ?? []).some(
            (existing) => existing.field === w.field
          );
          if (alreadyQueued) continue;
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          state.pending_writes.push(w);
        }
        logger?.info?.('stage6.insulation_resistance_script_queued_values', {
          sessionId,
          textPreview: text.slice(0, 80),
          queued_fields: followUpVolunteered.map((w) => w.field),
          pending_writes_total: state.pending_writes.length,
        });
        return { handled: true, fallthrough: false };
      }

      // Nothing to work with — exit and let Sonnet handle the utterance.
      logger?.info?.('stage6.insulation_resistance_script_unresolvable_circuit', {
        sessionId,
        textPreview: text.slice(0, 80),
        discarded_pending_writes: Array.isArray(state.pending_writes)
          ? state.pending_writes.map((w) => w.field)
          : [],
      });
      clearScript(session);
      return { handled: true, fallthrough: true, transcriptText };
    }
  }

  // 5. If we're in the voltage phase, parse the reply as a voltage.
  if (state.phase === 'voltage') {
    const voltage = parseVoltage(text);
    if (voltage !== null) {
      applyWrite(session, state.circuit_ref, VOLTAGE_FIELD, voltage, now);
      writes.push({ field: VOLTAGE_FIELD, value: voltage });
    }
    if (writes.length > 0) {
      safeSend(ws, buildExtractionPayload(state.circuit_ref, writes));
    }
    // After voltage capture (or skip if unparseable), we're done — there's
    // nothing else to ask. If voltage didn't parse, the inspector said
    // something we don't recognise as a voltage; we still finish (the
    // 60s timeout module will not re-ask voltage — voltage is not in
    // IR_FIELDS). The next turn would have run through Sonnet anyway.
    finishScript(ws, session, sessionId, now, logger);
    return { handled: true, fallthrough: false };
  }

  // 6. Reading phase — extract any named-field values on this turn.
  const named = extractNamedFieldValues(text);
  for (const w of named) {
    if (state.values[w.field] !== undefined) continue;
    applyWrite(session, state.circuit_ref, w.field, w.value, now);
    writes.push(w);
  }

  // 7. Bare-value fallback: if no named fields matched and the user just
  //    said a value, write it to whichever IR field is still missing.
  //    Suppress when the circuit was just resolved this turn (the digit
  //    that resolved the circuit would re-parse as a value) or when we
  //    drained pending writes (the entry-without-circuit case).
  if (
    !drainedFromPending &&
    !circuitResolvedThisTurn &&
    named.length === 0 &&
    state.circuit_ref !== null
  ) {
    const bareValue = parseValue(text);
    if (bareValue !== null) {
      const expected = nextMissingReading(state.values);
      if (expected) {
        applyWrite(session, state.circuit_ref, expected, bareValue, now);
        writes.push({ field: expected, value: bareValue });
      }
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(state.circuit_ref, writes));
  }

  // 8. What's next?
  const step = nextScriptStep(session, state.circuit_ref);
  if (step.kind === 'done') {
    finishScript(ws, session, sessionId, now, logger);
    return { handled: true, fallthrough: false };
  }
  if (step.kind === 'ask_voltage') {
    state.phase = 'voltage';
    safeSend(
      ws,
      buildScriptAsk({
        sessionId,
        circuit_ref: state.circuit_ref,
        missing_field: VOLTAGE_FIELD,
        now,
        kind: 'voltage',
      })
    );
    return { handled: true, fallthrough: false };
  }
  safeSend(
    ws,
    buildScriptAsk({
      sessionId,
      circuit_ref: state.circuit_ref,
      missing_field: step.field,
      now,
      kind: 'value',
    })
  );
  return { handled: true, fallthrough: false };
}

// Test-only exports.
export const __testing__ = {
  detectDifferentIrEntry,
  parseValue,
  parseVoltage,
  extractNamedFieldValues,
  nextMissingReading,
  readExistingIrValues,
  findCircuitByDesignation,
  initScript,
  clearScript,
  buildScriptAsk,
  buildScriptInfo,
  buildExtractionPayload,
  VOLTAGE_FIELD,
};
