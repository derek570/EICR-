/**
 * Ring continuity script — server-driven micro-conversation that captures
 * the three ring continuity readings (R1 / Rn / R2) for a single circuit.
 *
 * Background — 2026-04-29: even with the 60-second `ring-continuity-timeout.js`
 * detector, ring readings still leak when Flux fragments speech across turns
 * faster than the timer fires. Session B107472D (06:23, 2026-04-29) repro:
 * the user said "Lives are 0.43. Neutrals are. Zero point four three. And
 * earths are 0.78." — Flux closed five EndOfTurn events in 15 seconds, all
 * at borderline confidences (0.71-0.76). Sonnet wrote `ring_r1_ohm` from
 * the first turn but mis-routed the bare "0.43." as a generic
 * `missing_field_and_circuit` ask, dropping Rn entirely. R2 was buffered
 * into a closed socket when the user stopped recording in frustration.
 *
 * The fix is structural: ring continuity is the only EICR test family that
 * is genuinely sequential (probe → reading → reposition → reading), so
 * once the inspector says "ring continuity for circuit N", the server
 * takes over. It writes values directly without invoking Sonnet, prompts
 * for the next missing field via TTS (ask_user_started wire shape), and
 * clears state when the bucket fills or the inspector cancels. Sonnet is
 * bypassed for every turn the script handles — same wire output, no
 * extraction round-trip, ~2 seconds saved per turn.
 *
 * Contract:
 *   - Sits alongside `ring-continuity-timeout.js` (60s detector). Both
 *     can be active for the same session at once: the script catches
 *     fast-fragmenting cases (the bug above), the timeout catches
 *     genuinely-abandoned partial buckets after a long pause.
 *   - When the script writes a ring reading, it ALSO calls
 *     `recordRingContinuityWrite` from the timeout module so the 60s
 *     timer's per-circuit timestamp stays in sync. If the inspector
 *     cancels mid-script with 1-2 of 3 written, the timeout module is
 *     the safety net that asks for the rest later.
 *   - Wire output mirrors what Sonnet would emit: `{type: 'extraction',
 *     result: {readings: [...]}}` for writes, `{type: 'ask_user_started'}`
 *     for TTS prompts. iOS does not need a code change.
 *
 * State (attached to EICRExtractionSession instance as `ringContinuityScript`):
 *   {
 *     active: boolean,
 *     circuit_ref: number | null,    // null → entry without a circuit number;
 *                                       first prompt asks "Which circuit?"
 *     values: { ring_r1_ohm?, ring_rn_ohm?, ring_r2_ohm? },
 *     entered_at: number (ms),
 *     last_turn_at: number (ms),
 *   }
 *
 * Lifecycle:
 *   1. Entry:   transcript matches RING_ENTRY_PATTERN → state initialised,
 *               TTS asks first missing field.
 *   2. Active:  every transcript routed through processRingContinuityTurn
 *               BEFORE Sonnet. Cancel / topic-switch / value detection.
 *   3. Exit:    bucket full (3 of 3) → completion TTS, state cleared.
 *               Voice cancel → "cancelled, saved [N]" TTS, state cleared.
 *               Topic switch → state cleared, fallthrough=true so the
 *                 caller runs the same transcript through Sonnet normally.
 *               Hard timeout (RING_SCRIPT_HARD_TIMEOUT_MS, 180s) → clear
 *                 state silently; the 60s timeout module picks up partial
 *                 buckets if any.
 */

import {
  RING_FIELDS,
  recordRingContinuityWrite,
  clearRingContinuityState,
} from './ring-continuity-timeout.js';
import { applyReadingFlagAware } from './stage6-snapshot-mutators.js';
// P1 ring-script-hardening — reading-like classification mirror (leaf
// module, no cycle). Kept in sync with the live engine's import.
import { detectStructuredReading } from './stage6-pending-value.js';

/**
 * Hard cap on script duration. If the inspector enters the script, walks
 * away, and never says anything for this long, the state is cleared on the
 * next turn that arrives. The 60s timeout module is the partial-fill
 * safety net after that — see `findExpiredPartial`.
 */
export const RING_SCRIPT_HARD_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * Map canonical ring fields to the words the inspector would speak. Used
 * both by the value parser (to recognise the named-field forms like
 * "lives 0.43") and by the TTS question builder.
 */
const FIELD_PROMPTS = {
  ring_r1_ohm: { tts: 'What are the lives?', label: 'lives' },
  ring_rn_ohm: { tts: 'What are the neutrals?', label: 'neutrals' },
  ring_r2_ohm: { tts: "What's the CPC?", label: 'CPC' },
};

/**
 * Entry triggers — variations the inspector might say to start the
 * script. `circuit` capture group is optional; if absent, the first TTS
 * prompt asks "Which circuit?". Garbled Deepgram variants ("continuance",
 * "continuancy", "continue") are tolerated up to the same shape.
 *
 * Pattern 1 ("full") matches "ring continuity/final" with an optional
 * circuit number anywhere within ~50 characters of the trigger phrase.
 * The intervening characters can include fillers like "for, uh,",
 * prepositions ("for"/"on"), or punctuation — Flux occasionally splits
 * a single sentence across these on its way to EndOfTurn. The 50-char
 * window stops the regex from absorbing an unrelated trailing "circuit
 * 5" mentioned later in the same long utterance.
 *
 * Pattern 2 ("terse") matches the bare "ring on circuit N" form when
 * the word "ring" sits at a clause start (optionally preceded by a
 * filler discourse marker). Critically, it REQUIRES the "circuit N"
 * trailer — without it, "the phone is ringing" / "the ring main is..."
 * would false-positive. The clause-start anchor blocks "the ring main"
 * narration from triggering the script.
 *
 * Patterns are ordered so the more-specific (full) pattern is tried
 * first; an unmatched bare "ring continuity" still hits Pattern 1 with
 * the circuit capture group undefined, which the caller treats as null.
 */
const RING_ENTRY_PATTERNS = [
  // 1. Full: "ring/bring/wing continuity/final" + optional "circuit N"
  //    within 50 chars. Allows filler ("for, uh,"), any preposition, or none.
  //
  //    P1 ring-script-hardening (2026-07-22): updated to the COMPLETE
  //    dialogue-engine schema pattern (schemas/ring-continuity.js). This is
  //    a DELIBERATE legacy behaviour widening: Pattern 1 here historically
  //    LACKED the `bring|wing` alternation the live schema has carried
  //    since 2026-04-30 (pre-existing divergence), and both now gain the
  //    enumerated `re-?continuity` Flux garble (session B4C45F25). Exact
  //    alternative only — no open suffix (§3E enumerated-garbles scope).
  //    Circuit stays capture group 1 so twin and schema converge and the
  //    replay garble scenarios are parity-green.
  /\b(?:(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)|re-?continuity)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // 2. Terse: clause-start "ring ... circuit N" — no "continuity"/"final"
  //    word required, but the "circuit N" trailer is mandatory to block
  //    "ringing"/"ring main" false positives.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?ring\b[^.?!]{0,20}?\bcircuit\s*(\d{1,3})\b/i,
];

// ── P1 ring-script-hardening (2026-07-22) — confirmation-correction
// machinery, mirrored from the live dialogue engine (engine.js + the
// ring-continuity schema) per this file's keep-in-sync contract. The
// wordings/matchers are byte-identical to the schema's confirmation API so
// dialogue-engine-replay.test.js parity holds for the new scenarios.

// Destructive/corrective verbs only — mirrors schemas/ring-continuity.js
// `entryExclusionPattern` (used HERE only for the confirmation-mode guarded
// re-entry / seed rejection; the twin has no engine-level entry guard).
const RING_ENTRY_EXCLUSION_PATTERN = /\b(delete|undo|remove|clear|cancel|fix)\b/i;

// Confirmation-mode delete/clear INTENT — ordered proximity (verb precedes
// object within the clause) so "Yeah, all clear." can never hijack into a
// delete exit. Mirrors schema `confirmationClearIntentPattern`.
const RING_CONFIRMATION_CLEAR_INTENT_PATTERN =
  /\b(delete|remove|clear|undo|cancel)\b[^.?!]{0,40}?\b(readings?|values?|them|all)\b/i;

// Reply-initial bare negation — mirrors engine NEGATIVE_RE.
const RING_NEGATIVE_RE = /^\s*(?:no|nope|nah|negative)\b/i;

// Negated-positive guard — mirrors engine NEGATED_POSITIVE_RE ("That's not
// correct" / "Not okay" must never false-finish via detectConfirmationPositive,
// which matches `correct`/`ok(ay)` anywhere).
const RING_NEGATED_POSITIVE_RE =
  /(?:\b(?:not|never|no)\b[^.?!]{0,25}?\b(?:correct|ok(?:ay)?|right|good|yes|confirm(?:ed)?)\b|n't\s+(?:correct|ok(?:ay)?|right|good))/i;

// Non-ring context rejection + circuit-span masking — mirrors the engine's
// extraction-safety qualification (the ring extractors capture the first
// digit near CPC/earth/R1/R2, so "CPC size for circuit 17 is 2.5" would
// extract ring_r2_ohm=17 and "earth fault loop impedance is 0.62" would
// write ring_r2_ohm=0.62).
const RING_ANCHOR_SRC = '(?:cpc|c\\s*p\\s*c|earths?|lives?|neutrals?|r\\s*(?:1|2|n))';
const NON_RING_ADJ_SRC = '(?:sizes?|csa|mm2?|millimetre?s?|conductors?|cables?)';
const RING_NON_RING_ADJACENT_RE = new RegExp(
  `\\b${RING_ANCHOR_SRC}\\b[^.?!]{0,20}?\\b${NON_RING_ADJ_SRC}\\b|\\b${NON_RING_ADJ_SRC}\\b[^.?!]{0,20}?\\b${RING_ANCHOR_SRC}\\b`,
  'i'
);
const RING_R1_PLUS_R2_COMPOUND_RE = /\bR\s*1\s*(?:\+|\s+plus\s+)\s*R\s*2\b/i;
const RING_NON_RING_EARTH_COMPOUND_RE =
  /\b(?:earth\s+fault\s+loop|loop\s+impedance|earth\s+electrode|electrode\s+resistance|earth\s+leakage)\b/i;

function maskCircuitSpans(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\bcircuit\s*\d{1,3}\b/gi, (m) => ' '.repeat(m.length));
}

function extractRingSafeNamedValues(replyText) {
  if (
    RING_NON_RING_ADJACENT_RE.test(replyText) ||
    RING_R1_PLUS_R2_COMPOUND_RE.test(replyText) ||
    RING_NON_RING_EARTH_COMPOUND_RE.test(replyText)
  ) {
    return { rejected: true, values: [] };
  }
  return { rejected: false, values: extractNamedFieldValues(maskCircuitSpans(replyText)) };
}

// Multi-ref collection with negation polarity — mirrors engine
// collectCircuitRefsWithPolarity (`circuit N` form ONLY, never the bare
// whole-utterance digit; whitespace-adjacent not/no/never negates).
function collectCircuitRefsWithPolarity(replyText) {
  const out = [];
  if (typeof replyText !== 'string' || !replyText) return out;
  for (const m of replyText.matchAll(/\bcircuit\s*(\d{1,3})\b/gi)) {
    const ref = Number(m[1]);
    if (!Number.isInteger(ref) || ref <= 0) continue;
    const before = replyText.slice(0, m.index);
    const negated = /\b(?:not|no|never)\s*$/i.test(before);
    out.push({ ref, negated });
  }
  return out;
}

// Reading-like classifier — mirrors engine isReadingLikeReply (pinned
// mechanism: detectStructuredReading(...)?.complete === true OR a
// number+unit OR a `circuit N` mention OR an enumerated non-ring field
// anchor co-occurring with a number).
const RING_READING_FIELD_ANCHOR_RE =
  /\b(?:zs|ze|pfc|pscc|efli|insulation|polarity|rcd|trip\s*time|r\s*1\s*(?:\+|plus)\s*r\s*2)\b/i;

function hasNumericValueWithUnit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\d+(?:\.\d+)?\s*(?:m\s*s\b|millisecond|milliseconds|ohm|ohms|m\s*Ω|kΩ|MΩ|mega\s*ohms?|kilo\s*ohms?|mA\b|milli\s*amps?|amps?\b|kA\b|kilo\s*amps?|volts?\b|kV\b|kilo\s*volts?)/i.test(
    text
  );
}

function isReadingLikeReply(replyText) {
  if (typeof replyText !== 'string' || !replyText.trim()) return false;
  try {
    if (detectStructuredReading(replyText)?.complete === true) return true;
  } catch {
    // classifier must never take down the confirmation branch
  }
  if (hasNumericValueWithUnit(replyText)) return true;
  if (/\bcircuit\s*\d{1,3}\b/i.test(replyText)) return true;
  if (RING_READING_FIELD_ANCHOR_RE.test(replyText) && /\d/.test(replyText)) return true;
  return false;
}

// Confirmation-correction wordings + matchers — byte-identical mirrors of
// the schema confirmation API (every rendered string is pinned in tests).
const RING_CONFIRMATION_NEGATION_REASON = 'confirm_ring_continuity_correction';
const RING_CONFIRMATION_NEGATION_REASK = 'Which value is wrong — R1, Rn or R2?';
const RING_CONFIRMATION_NEGATION_REASK_ALTERNATE =
  'Sorry — tell me which reading to change, or say the corrected value.';
const ringConfirmationNegationCapExit = ({ circuit_ref }) =>
  `Okay — leaving the ring readings for circuit ${circuit_ref} as they are; say the correction when ready.`;
const RING_CONFIRMATION_SLOT_SELECTORS = [
  {
    field: 'ring_r1_ohm',
    selector: /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*1|lives?)\s*[.!?]?\s*$/i,
    label: 'R1',
  },
  {
    field: 'ring_rn_ohm',
    selector: /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*n|neutrals?)\s*[.!?]?\s*$/i,
    label: 'Rn',
  },
  {
    field: 'ring_r2_ohm',
    selector:
      /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*2|earths?|cpc|c\s*p\s*c)\s*[.!?]?\s*$/i,
    label: 'R2',
  },
];
const RING_CONFIRMATION_PENDING_VALUE_PATTERN =
  /^\s*(?:(?:no|nope|nah|it's|its|it\s+is)[,.\s]+){0,2}(\d{1,3}(?:\.\d{1,3})?|\.\d{1,3})\s*(?:ohms?)?\s*\.?\s*$/i;

/**
 * Cancel triggers — exit the script and preserve whatever's been written
 * so far. Keep generous; the inspector's hands are tied so a few synonym
 * false-positives are better than an unrescuable script.
 */
const RING_CANCEL_PATTERNS = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|skip(?:\s+(?:this|that|ring))?|scrap(?:\s+(?:that|this|ring))?|forget\s+(?:it|that|this)|never\s+mind|abort|ignore\s+(?:that|this))\b/i,
];

/**
 * Topic-switch triggers — utterances that announce a different test or a
 * different circuit. We exit the script and let Sonnet handle the new
 * utterance normally (`fallthrough=true`). Crucially, do NOT match the
 * named-field words here ("lives", "neutrals", "earths", "CPC") — those
 * are values FOR the script, not topic switches.
 */
const TOPIC_SWITCH_PATTERNS = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i, // "Zs is 0.62", "Ze of 0.18"
  /\bcircuit\s+\d+\s+is\b/i, // "circuit 5 is the cooker"
  /\bR\s*1\s*\+\s*R\s*2\b/i, // "R1+R2"
  /\b(?:insulation|installation)\s+resistance\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
  // C2 (2026-06-19, #35): observation lead-in exits the ring loop so a bare
  // "observation." isn't eaten by an active script. Mirrors the engine schema
  // dialogue-engine/schemas/ring-continuity.js topicSwitchTriggers for replay
  // parity.
  /\b(?:observ\w*|obs|make\s+a\s+note)\b/i,
];

/**
 * Match a "different ring continuity for circuit M" against the active
 * `circuit_ref`. If the inspector started the script for c13 and now
 * says "ring continuity for circuit 14", that's a topic switch (exit +
 * fallthrough so Sonnet sees the new entry on its own turn — actually
 * no, we re-enter the script for c14 ourselves; cleaner UX).
 *
 * Returns the new circuit_ref if a different ring entry is detected,
 * else null.
 */
function detectDifferentRingEntry(text, currentCircuitRef) {
  for (const pattern of RING_ENTRY_PATTERNS) {
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
 * Detect script entry from a transcript. Returns `{matched, circuit_ref}`
 * where `circuit_ref` is `null` when the inspector didn't name a circuit.
 *
 * @param {string} text
 * @returns {{matched: boolean, circuit_ref: number | null}}
 */
export function detectEntry(text) {
  if (typeof text !== 'string' || !text) return { matched: false, circuit_ref: null };
  for (const pattern of RING_ENTRY_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const ref = m[1] ? Number(m[1]) : null;
      const validRef = Number.isInteger(ref) && ref > 0 ? ref : null;
      return { matched: true, circuit_ref: validRef };
    }
  }
  return { matched: false, circuit_ref: null };
}

/**
 * Detect a cancel utterance. Returns true if any cancel phrase matches.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectCancel(text) {
  if (typeof text !== 'string' || !text) return false;
  return RING_CANCEL_PATTERNS.some((p) => p.test(text));
}

/**
 * Detect a topic-switch utterance — the inspector has moved on to a
 * different test family or a different circuit. Returns true if any of
 * the topic-switch patterns match.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectTopicSwitch(text) {
  if (typeof text !== 'string' || !text) return false;
  return TOPIC_SWITCH_PATTERNS.some((p) => p.test(text));
}

/**
 * Parse a numeric value from a transcript fragment. iOS already
 * normalises "naught point four three" → "0.43" before the transcript
 * hits the backend (see Sources/Recording/NumberNormaliser.swift), so
 * we only need to recognise the digit form. We also accept the discontinuous
 * sentinels "infinite", "open", "discontinuous" → "∞".
 *
 * Returns the canonical string value or null if no parseable value found.
 *
 * @param {string} text
 * @returns {string | null}
 */
function parseValue(text) {
  if (typeof text !== 'string') return null;
  // Discontinuous CPC / open-ring sentinels — write the literal "∞" the
  // agentic prompt teaches Sonnet to use for `r1_r2_ohm`/ring fields.
  if (/\b(?:infinite|open(?:\s+ring|\s+circuit)?|discontinuous|infinity)\b/i.test(text)) {
    return '∞';
  }
  // Numeric — accept "0.43", ".43", "0.4", or integer "1".
  const m = text.match(/-?\d*\.\d+|-?\d+/);
  if (!m) return null;
  // Canonical form: strip leading "+", collapse trailing zeros, ensure
  // leading zero on bare ".43" → "0.43" (iOS normaliser already does
  // this, but we're defensive).
  const raw = m[0];
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Preserve the user-spoken precision rather than reformatting via
  // Number.toString (which would turn "0.430" into "0.43" — fine for
  // ring continuity, but stripping precision is a behaviour change we
  // don't need here). Just normalise leading-zero shape.
  if (raw.startsWith('.')) return `0${raw}`;
  if (raw.startsWith('-.')) return `-0${raw.slice(1)}`;
  return raw;
}

/**
 * Try to extract one or more named-field readings from a transcript.
 * Recognises "lives <value>", "neutrals <value>", "earths <value>",
 * "CPC <value>" — same words the agentic prompt teaches.
 *
 * Each conductor has TWO directional patterns:
 *   - Field-first: "lives are 0.21", "lives 0.21 ohms"
 *   - Value-first: "0.21 on the lives", "0.21 ohms lives"
 *
 * Both patterns are tried; if both match, the one with the SMALLER
 * gap between the conductor word and the value wins. This handles
 * "lives 0.43, 0.43 on the neutrals, CPC 0.78" correctly — for
 * `neutrals`, field-first would skip over 17 chars (", and CPC is ")
 * to grab 0.78, while value-first matches 0.43 with only 8 chars of
 * gap; value-first wins on proximity. On ties (e.g. "lives 0.43"
 * where only field-first matches), the existing pattern wins.
 *
 * Mirror added 2026-05-21 (session 293F074F): "Ring continuity for
 * the cooker is 0.21 on the lives" defeated the original field-first-
 * only regex (no digit appears AFTER "lives"), forcing the script to
 * ask "What are the lives?" after the user had already volunteered
 * the value.
 *
 * Returns an ordered array of `{field, value}` for every matching pair
 * found. Empty array if none.
 *
 * @param {string} text
 * @returns {Array<{field: string, value: string}>}
 */
function extractNamedFieldValues(text) {
  if (typeof text !== 'string' || !text) return [];
  const VAL = '\\d*\\.?\\d+|infinite|open|discontinuous|infinity';
  // Value-first connector words. Restricts the mirror so it can't
  // glue bare digits onto a conductor word — "circuit 13. Lives 0.43"
  // must NOT match value-first as "13 [...] Lives" (the value-first
  // path would otherwise hijack the circuit number). Requiring an
  // explicit preposition mirrors how inspectors actually phrase
  // value-first dictation: "0.21 on the lives", "0.43 across the
  // neutrals", "0.78 for the CPC".
  const VALUE_FIRST_CONNECTOR =
    '\\s*(?:ohms?|Ω)?\\s*(?:on|for|across|at|down|onto|to)\\s+(?:the\\s+)?';
  const out = [];
  // Order: r1 (lives) → rn (neutrals) → r2 (earths/CPC). Each conductor
  // has a field-first regex and a value-first mirror. Field-first
  // filler excludes digits AND ∞ so it can't skip past another reading
  // to grab a far-away digit; value-first requires an explicit
  // connector preposition so circuit numbers / way numbers don't get
  // mis-classified as readings.
  const conductors = [
    { field: 'ring_r1_ohm', word: 'lives?' },
    { field: 'ring_rn_ohm', word: 'neutrals?' },
    { field: 'ring_r2_ohm', word: '(?:earths?|cpc|c\\s*p\\s*c)' },
  ];
  for (const { field, word } of conductors) {
    // Field-first: "<word> [filler ≤30, no digits] <value>". Filler
    // captured in group 1 for proximity scoring, value in group 2.
    const fieldFirst = new RegExp(`\\b${word}\\b([^\\d∞]{0,30}?)(${VAL})`, 'i');
    // Value-first: "<value> [optional 'ohms'] <connector> [optional 'the'] <word>".
    // Value in group 1, filler (connector phrase) in group 2.
    const valueFirst = new RegExp(`(${VAL})(${VALUE_FIRST_CONNECTOR})\\b${word}\\b`, 'i');
    const ff = text.match(fieldFirst);
    const vf = text.match(valueFirst);
    const ffGap = ff ? ff[1].length : Infinity;
    const vfGap = vf ? vf[2].length : Infinity;
    let captured = null;
    if (ff && vf) {
      // Tie → field-first wins (matches the canonical dictation form).
      captured = ffGap <= vfGap ? ff[2] : vf[1];
    } else if (ff) {
      captured = ff[2];
    } else if (vf) {
      captured = vf[1];
    }
    if (captured !== null) {
      const val = parseValue(captured);
      if (val !== null) out.push({ field, value: val });
    }
  }
  return out;
}

/**
 * Initialise script state on the session. Idempotent — replaces any
 * existing state. Safe to call as part of entry handling even if a stale
 * state object is hanging around from a prior cancelled run.
 *
 * `pending_writes` (added 2026-04-29 — Fix A from session 74201B27):
 * holds field/value pairs the inspector volunteered while the script
 * had no `circuit_ref` yet. Drained when the circuit resolves (digit or
 * designation match in the active path's circuit-resolution block).
 * Discarded if the circuit never resolves and the script exits via
 * fallthrough — that data class is genuinely unrecoverable without
 * Fix C's last-named-circuit fallback (deliberately deferred).
 */
function initScript(session, circuit_ref, now) {
  session.ringContinuityScript = {
    active: true,
    circuit_ref,
    values: {},
    pending_writes: [],
    entered_at: now,
    last_turn_at: now,
    // P1 ring-script-hardening — confirmation-correction episode state,
    // mirrored from the live engine's initScriptState (see engine.js for
    // the full rationale on each field).
    confirmation_no_progress: 0,
    confirmation_pending_slot: null,
    confirmation_negation_reask_emitted: false,
  };
}

/**
 * Clear script state. Called on completion, cancel, topic switch, or
 * hard timeout. Safe on already-cleared state.
 */
function clearScript(session) {
  if (session) session.ringContinuityScript = null;
}

/**
 * Find the next ring field that hasn't been written yet, in canonical
 * R1 → Rn → R2 order. Returns null if all three are filled.
 */
function nextMissingField(values) {
  for (const f of RING_FIELDS) {
    if (values[f] === undefined || values[f] === null || values[f] === '') return f;
  }
  return null;
}

/**
 * Attempt to send a JSON message over the WS. Swallows send errors —
 * the script's persistent state is the source of truth, not the wire.
 * Mirrors the pattern in stage6-dispatcher-ask.js's ask_user_started emit.
 */
function safeSend(ws, payload) {
  if (!ws || typeof ws.send !== 'function') return;
  try {
    if (ws.readyState !== undefined && ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch {
    // Intentional: WS send failures must not tear down the script.
  }
}

/**
 * PLAN-C P4d (row 2) — stamp the creation-time response epoch onto an
 * ask_user_started frame (as `utterance_id`) so the client chime-silence
 * watchdog disarms on the spoken question. Non-empty string only, mirroring
 * the live dialogue-engine helper (helpers/wire-emit.js) and P4c's
 * advance-only-on-non-empty rule. NOTE: this legacy script is no longer on the
 * live path (sonnet-stream drives the dialogue-engine wrappers) — the epoch is
 * threaded here for wire-contract completeness / future re-wiring, with a null
 * default rather than the engine's REQUIRED sentinel (no live caller to
 * enforce, and a throw would add abort risk with no runtime benefit).
 */
function stampResponseEpoch(payload, responseEpoch) {
  if (typeof responseEpoch === 'string' && responseEpoch) {
    payload.utterance_id = responseEpoch;
  }
  return payload;
}

/**
 * Build an ask_user_started wire payload for the next missing field.
 * Synthetic tool_call_id so the iOS side's dedupe doesn't collide with a
 * Sonnet-emitted ask. Marker `srv-rcs` distinguishes the script from the
 * 60s timeout module's `srv-ring` namespace.
 */
function buildScriptAsk({
  sessionId,
  circuit_ref,
  missing_field,
  now,
  kind,
  responseEpoch = null,
  // P1 — optional question override for the confirmation-correction value
  // asks ("What should R1 be?" / the distinct alternate). Mirrors the live
  // engine's buildScriptAsk `slotQuestion` parameter; the default keeps the
  // legacy FIELD_PROMPTS lookup byte-identical.
  slotQuestion = null,
}) {
  // kind:
  //   'which_circuit' → entry without a circuit number; question asks
  //                     for the circuit, not a value. context_field/circuit
  //                     null because the iOS side will re-route the answer
  //                     via Sonnet (see fallthrough on circuit answer below).
  //   'value'         → standard "what's the next reading?" prompt.
  if (kind === 'which_circuit') {
    return stampResponseEpoch(
      {
        type: 'ask_user_started',
        tool_call_id: `srv-rcs-${sessionId}-which-${now}`,
        question: 'Which circuit is the ring continuity for?',
        reason: 'missing_context',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'value',
      },
      responseEpoch
    );
  }
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `srv-rcs-${sessionId}-${circuit_ref}-${missing_field}-${now}`,
      question: slotQuestion ?? FIELD_PROMPTS[missing_field]?.tts ?? `What's the ${missing_field}?`,
      reason: 'missing_value',
      context_field: missing_field,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    },
    responseEpoch
  );
}

/**
 * P1 — confirmation-correction ask with an arbitrary question + reason.
 * Mirrors the live engine's generic buildScriptConfirm shape (same
 * `-confirm-` tool_call_id segment) for the negation re-ask and its
 * alternate; the standard readback confirm keeps using buildScriptConfirm.
 */
function buildScriptCorrectionConfirm({
  sessionId,
  circuit_ref,
  question,
  reason,
  now,
  responseEpoch = null,
}) {
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `srv-rcs-${sessionId}-${circuit_ref}-confirm-${now}`,
      question,
      reason,
      context_field: null,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    },
    responseEpoch
  );
}

/**
 * Build the end-of-loop confirmation ask. Reads the three filled values
 * back to the inspector and waits for either "yes/correct/etc" (→ real
 * finishScript) or a named-field overwrite ("lives 0.65" → replace R1
 * + re-emit confirmation). Added 2026-05-26 in response to the
 * field-test ask: Deepgram garbles continuity readings, and the
 * pre-fix flow (a one-way `buildScriptInfo` "Got it." readback) gave
 * no opportunity to amend after re-entry. Sits on the same
 * `ask_user_started` wire shape as `buildScriptAsk` so iOS doesn't
 * need a new payload type; the distinguishing marker is the `confirm`
 * tool_call_id suffix and `reason: 'confirm_ring_continuity'`.
 */
function buildScriptConfirm({ sessionId, circuit_ref, values, now, responseEpoch = null }) {
  const r1 = values.ring_r1_ohm ?? '?';
  const rn = values.ring_rn_ohm ?? '?';
  const r2 = values.ring_r2_ohm ?? '?';
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `srv-rcs-${sessionId}-${circuit_ref}-confirm-${now}`,
      question: `R1 ${r1}, Rn ${rn}, R2 ${r2}. All correct?`,
      reason: 'confirm_ring_continuity',
      context_field: null,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    },
    responseEpoch
  );
}

/**
 * Detect a positive confirmation response. Narrow vocabulary on
 * purpose — "right" / "good" alone are too common as filler words to
 * count as confirmation; the inspector must say one of these explicit
 * forms. Anything else routes to the overwrite branch (named-field
 * value) or fall-through (Sonnet handles).
 */
function detectConfirmationPositive(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\b(?:yes|yeah|yep|yup|ok(?:ay)?|correct|confirm(?:ed)?|all\s+(?:correct|good|right)|that's\s+(?:correct|right))\b/i.test(
    text
  );
}

/**
 * Transition the script into confirmation mode. Sets the flag,
 * emits the confirmation ask, and logs. Called from both the
 * entry path (all 3 already filled at entry) and the active path
 * (all 3 just became filled after a write).
 */
function transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch = null) {
  const state = session.ringContinuityScript;
  if (!state) return;
  state.awaiting_confirmation = true;
  safeSend(
    ws,
    buildScriptConfirm({
      sessionId,
      circuit_ref: state.circuit_ref,
      values: state.values,
      now,
      responseEpoch,
    })
  );
  logger?.info?.('stage6.ring_continuity_script_awaiting_confirmation', {
    sessionId,
    circuit_ref: state.circuit_ref,
    values: { ...state.values },
  });
}

/**
 * Build a completion / cancellation TTS payload. We piggyback on
 * `ask_user_started` because that's the wire shape iOS already plays
 * through ElevenLabs; the alternative would be a new wire type and an
 * iOS code change. Setting `expected_answer_shape: 'none'` signals iOS
 * that no reply is wanted; iOS treats this as a brief informational
 * announcement.
 */
function buildScriptInfo({ sessionId, kind, text, now, responseEpoch = null }) {
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `srv-rcs-${sessionId}-${kind}-${now}`,
      question: text,
      reason: 'info',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'none',
    },
    responseEpoch
  );
}

/**
 * Build the extraction wire payload for one or more script-driven writes.
 * Matches the bundler's `extracted_readings` shape so iOS sees the same
 * structure it gets from Sonnet (see stage6-event-bundler.js).
 */
function buildExtractionPayload(circuit_ref, writes) {
  return {
    type: 'extraction',
    result: {
      readings: writes.map((w) => ({
        field: w.field,
        circuit: circuit_ref,
        value: w.value,
        confidence: 1.0,
        source: 'ring_script',
      })),
      // Empty arrays for the other slots iOS may inspect. Omitting
      // them is fine for Codable on iOS, but keeping them parallels
      // the bundler's full shape — fewer surprises if a future
      // consumer assumes the keys exist.
      observations: [],
      questions: [],
    },
  };
}

/**
 * Apply a write to the snapshot, the script's local values map, the 60s
 * timer's per-circuit timestamp, and produce a wire-extraction record.
 */
function applyWrite(session, circuit_ref, field, value, now) {
  // Ring-continuity script writes flow through the flag-aware wrapper so
  // synthesised values (e.g. completing a ring on the third reading) land
  // in the same bucket shape as the inspector-dictated readings that
  // triggered the script. Under flag-on, the write is scoped to the
  // current board; under flag-off, the legacy flat-key write path is
  // byte-identical to the pre-Phase-5 behaviour.
  applyReadingFlagAware(session.stateSnapshot, {
    circuit: circuit_ref,
    field,
    value,
  });
  if (session.ringContinuityScript) {
    session.ringContinuityScript.values[field] = value;
    session.ringContinuityScript.last_turn_at = now;
  }
  // Keep the 60s timeout module's view in sync — when the script clears
  // (success or cancel), `findExpiredPartial` reads ringContinuityState
  // and decides whether to fire its server note. recordRingContinuityWrite
  // stamps the latest write timestamp so the timeout window restarts
  // cleanly per circuit.
  recordRingContinuityWrite(session, circuit_ref, now);
}

/**
 * Process one transcript turn against the ring continuity script.
 *
 * Returns one of:
 *   - { handled: false }                        → script not active and
 *                                                  no entry trigger; caller
 *                                                  proceeds with normal
 *                                                  Sonnet flow.
 *   - { handled: true, fallthrough: false }     → script handled the turn
 *                                                  end-to-end; caller
 *                                                  SKIPS the Sonnet call
 *                                                  for this transcript.
 *   - { handled: true, fallthrough: true,
 *       transcriptText }                        → script exited via topic
 *                                                  switch; caller proceeds
 *                                                  with normal Sonnet flow
 *                                                  using the SAME (or a
 *                                                  cleaned-up) transcript.
 *
 * The returned `transcriptText` (only on fallthrough) lets the caller
 * substitute a sanitised version of the user's utterance — currently
 * unchanged from input, but kept in the contract so future cleanup
 * (e.g. stripping a leading cancel phrase) doesn't churn callers.
 *
 * @param {object} ctx
 * @param {object} ctx.ws         iOS WebSocket — outgoing wire emit only
 * @param {object} ctx.session    EICRExtractionSession instance
 * @param {string} ctx.sessionId
 * @param {string} ctx.transcriptText
 * @param {object} [ctx.logger]   Optional pino-style logger
 * @param {number} [ctx.now]      Override for test determinism
 */
export function processRingContinuityTurn(ctx) {
  const {
    ws,
    session,
    sessionId,
    transcriptText,
    logger,
    now = Date.now(),
    // PLAN-C P4d (row 2) — creation-time response epoch threaded to every ask
    // this turn emits (null on the dead legacy path; see stampResponseEpoch).
    responseEpoch = null,
    // P1 Fix 4 — the raw un-annotated reply; every confirmation-branch
    // decision parses this (annotated fallback for direct callers). Mirrors
    // the live engine's contract.
    rawReplyText = null,
  } = ctx;
  if (!session) return { handled: false };

  const state = session.ringContinuityScript;
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  const reply = typeof rawReplyText === 'string' ? rawReplyText : text;

  // ───────────────────────────────────────────── Hard timeout sweep ──
  if (state?.active && now - state.last_turn_at > RING_SCRIPT_HARD_TIMEOUT_MS) {
    logger?.info?.('stage6.ring_continuity_script_hard_timeout', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled: Object.keys(state.values).length,
      ms_since_last_turn: now - state.last_turn_at,
    });
    clearScript(session);
    // Fall through to entry detection on this turn — the user might be
    // starting a fresh ring continuity script after stepping away.
  }

  // ───────────────────────────────────────────── Inactive: detect entry ──
  const stateAfterSweep = session.ringContinuityScript;
  if (!stateAfterSweep?.active) {
    const entry = detectEntry(text);
    if (!entry.matched) return { handled: false };

    // Honour any pre-existing partial fill on this circuit (e.g. R1
    // already written from a prior turn) so the script picks up where
    // the inspector left off rather than overwriting.
    //
    // Entry-time designation lookup (2026-04-29, session 6754FE6E): the
    // entry regex's circuit-capture group only matches the literal word
    // "circuit" + digits. An inspector saying "ring continuity for
    // upstairs sockets, neutrals are 0.32" matches the head but the
    // "for upstairs sockets" portion is invisible to the capture group,
    // so circuit_ref comes back null and the script asks "Which
    // circuit?" — even though the designation was right there in the
    // entry sentence. Fix: when the regex didn't capture a digit, try
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
    const existing = circuitRef ? readExistingRingValues(session, circuitRef) : {};

    // Did the entry utterance also volunteer one or more field values?
    // ("Ring continuity for circuit 13. Lives are 0.43." OR — the case
    // Fix A unblocks — "Ring continuity is lives are 0.75." with no
    // circuit named, where the inspector dictated the R1 reading
    // upfront and we ask for the circuit on the next turn.)
    //
    // Bug A (session 74201B27, 2026-04-29): the original code guarded
    // this extract on `circuitRef`, so volunteered values landed on
    // the floor whenever the entry utterance carried readings without
    // a circuit number. ALWAYS extract; let the queue (pending_writes)
    // hold the values until the circuit resolves.
    const volunteered = extractNamedFieldValues(text);

    initScript(session, circuitRef, now);
    // Seed values from existing snapshot AND from any volunteered fields.
    for (const [f, v] of Object.entries(existing)) {
      if (RING_FIELDS.includes(f) && v !== '' && v !== null && v !== undefined) {
        session.ringContinuityScript.values[f] = v;
      }
    }
    const writes = [];
    for (const w of volunteered) {
      // Skip if the snapshot already holds a value for this field — the
      // inspector may be re-stating; we don't overwrite without an
      // explicit clear.
      if (session.ringContinuityScript.values[w.field] !== undefined) continue;
      if (circuitRef !== null) {
        // Circuit known → write immediately, same as before Fix A.
        applyWrite(session, circuitRef, w.field, w.value, now);
        writes.push(w);
      } else {
        // Circuit not yet known → queue. The active path's
        // circuit-resolution block drains pending_writes once a digit
        // or designation answer lands.
        session.ringContinuityScript.pending_writes.push(w);
      }
    }

    if (writes.length > 0) {
      safeSend(ws, buildExtractionPayload(circuitRef, writes));
    }

    logger?.info?.('stage6.ring_continuity_script_entered', {
      sessionId,
      circuit_ref: circuitRef,
      entry_designation_matched: entryDesignationMatched,
      pre_existing_filled: Object.keys(existing).filter((f) => RING_FIELDS.includes(f)),
      volunteered_writes: writes.map((w) => w.field),
      pending_writes: session.ringContinuityScript.pending_writes.map((w) => w.field),
      textPreview: text.slice(0, 80),
    });

    // What do we ask next?
    if (circuitRef === null) {
      // Entry without a circuit. Ask which circuit. When the inspector
      // answers, the next turn re-enters this function; if it carries a
      // circuit number we promote to value-asking. If not, the script
      // exits via topic-switch fallthrough.
      safeSend(
        ws,
        buildScriptAsk({
          sessionId,
          circuit_ref: null,
          missing_field: null,
          now,
          kind: 'which_circuit',
          responseEpoch,
        })
      );
      return { handled: true, fallthrough: false };
    }

    const nextField = nextMissingField(session.ringContinuityScript.values);
    if (!nextField) {
      // All three filled (volunteered + existing) — ask the inspector
      // to confirm, with the chance to overwrite any garbled reading.
      // Was finishScript(); replaced 2026-05-26 to close the "stuck
      // with whatever Deepgram heard first" trap. See
      // `buildScriptConfirm` doc for the wire-shape choice.
      transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
      return { handled: true, fallthrough: false };
    }
    safeSend(
      ws,
      buildScriptAsk({
        sessionId,
        circuit_ref: circuitRef,
        missing_field: nextField,
        now,
        kind: 'value',
        responseEpoch,
      })
    );
    return { handled: true, fallthrough: false };
  }

  // ───────────────────────────────────────────── Active: handle turn ──
  state.last_turn_at = now;

  // P1 canonical position 1 — delete/clear-intent preflight, evaluated ONLY
  // during awaiting_confirmation (mirrors the live engine; see engine.js for
  // the full rationale). Runs BEFORE the cancel branch so "clear/cancel the
  // readings" takes the delete exit while bare "cancel that" still falls to
  // the preserve-and-exit cancel path. The engine exits the script and
  // falls through to the model with a FIXED server-controlled antecedent
  // (no reading values interpolated); the note REPLACES any client
  // annotation.
  if (state.awaiting_confirmation && RING_CONFIRMATION_CLEAR_INTENT_PATTERN.test(reply)) {
    const circuitN =
      Number.isInteger(state.circuit_ref) && state.circuit_ref > 0
        ? String(state.circuit_ref)
        : 'the current circuit';
    const serverNote =
      `[Server note: The assistant just read back the complete ring-continuity set ` +
      `(R1, Rn and R2) for circuit ${circuitN} and asked "All correct?". ` +
      `The user's reply follows.] `;
    logger?.info?.('stage6.ring_continuity_script_confirmation_delete_exit', {
      sessionId,
      circuit_ref: state.circuit_ref,
      textPreview: reply.slice(0, 80),
    });
    clearScript(session);
    return { handled: true, fallthrough: true, transcriptText: `${serverNote}${reply}` };
  }

  // 1. Cancel — preserve writes, clear state, announce.
  if (detectCancel(text)) {
    const filled = Object.keys(state.values).length;
    logger?.info?.('stage6.ring_continuity_script_cancelled', {
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
            ? `Ring continuity cancelled. ${filled} of 3 saved.`
            : 'Ring continuity cancelled.',
        now,
        responseEpoch,
      })
    );
    clearScript(session);
    return { handled: true, fallthrough: false };
  }

  // 2. Different ring entry on a NEW circuit — seamlessly switch.
  //    P1 canonical position 3 GATE: generic different-entry detection must
  //    NOT consume confirmation-mode replies — the confirmation branch's 5a
  //    preflight owns different-circuit routing there (mirrors the engine).
  const newRef = state.awaiting_confirmation
    ? null
    : detectDifferentRingEntry(text, state.circuit_ref);
  if (newRef !== null) {
    logger?.info?.('stage6.ring_continuity_script_switched_circuit', {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: Object.keys(state.values).length,
      textPreview: text.slice(0, 80),
    });
    // Clear old state — the 60s timeout module's per-circuit state
    // covers any partial fill on the old circuit. Then re-run entry
    // through the same path as the inactive branch so volunteered
    // fields on the new entry utterance get applied.
    clearScript(session);
    return processRingContinuityTurn({ ...ctx, now });
  }

  // 3. Topic switch (different test family) — exit, let Sonnet handle.
  if (detectTopicSwitch(text)) {
    logger?.info?.('stage6.ring_continuity_script_topic_switch', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled: Object.keys(state.values).length,
      textPreview: text.slice(0, 80),
    });
    clearScript(session);
    return { handled: true, fallthrough: true, transcriptText };
  }

  // 3.5. Confirmation mode — all 3 values are filled and we're waiting
  //      for the inspector to confirm or correct. Field-test ask
  //      2026-05-26: Deepgram garbles continuity readings and the
  //      pre-fix flow gave no opportunity to amend (re-entry just
  //      replayed the readback).
  //
  //      Resolution order on this turn:
  //        a) Named-field overwrite ("lives 0.65" / "neutrals 0.42" /
  //           "CPC 0.71") → overwrite that slot, re-emit confirmation
  //           with the updated values, stay in confirmation mode.
  //        b) Positive confirmation ("yes" / "all correct" / etc.) →
  //           run the real finishScript and clear state.
  //        c) Inspector re-saying the entry trigger ("ring continuity
  //           for circuit 1") → re-emit the confirmation prompt.
  //        d) Otherwise → fall through to Sonnet without clearing.
  //           State survives so a follow-up amend or confirm can land.
  //           Hard timeout (180s) eventually clears stale state.
  if (state.awaiting_confirmation) {
    // P1 ring-script-hardening — canonical confirmation order 5a–5h,
    // mirrored from the live engine's confirmation branch (engine.js). All
    // decisions parse `reply` (raw with annotated fallback); the annotated
    // `transcriptText` is reserved for model fallthroughs. See engine.js
    // for the per-position rationale; this mirror exists so the replay
    // corpus (dialogue-engine-replay.test.js) stays byte-parity green for
    // the new confirmation scenarios.
    const ringSafe = extractRingSafeNamedValues(reply);

    const clearAndFallThrough = (logEvent, extra = {}) => {
      logger?.info?.(`stage6.ring_continuity_script_${logEvent}`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: reply.slice(0, 80),
        ...extra,
      });
      clearScript(session);
      return { handled: true, fallthrough: true, transcriptText };
    };

    const takeNegationCapExit = () => {
      safeSend(
        ws,
        buildScriptInfo({
          sessionId,
          kind: 'confirmation_cap_exit',
          text: ringConfirmationNegationCapExit({ circuit_ref: state.circuit_ref }),
          now,
          responseEpoch,
        })
      );
      logger?.info?.('stage6.ring_continuity_script_confirmation_cap_exit', {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: reply.slice(0, 80),
      });
      clearScript(session);
      return { handled: true, fallthrough: false };
    };

    const slotLabel = (field) =>
      RING_CONFIRMATION_SLOT_SELECTORS.find((s) => s.field === field)?.label ?? field;

    const emitValueAsk = (field, questionText) => {
      safeSend(
        ws,
        buildScriptAsk({
          sessionId,
          circuit_ref: state.circuit_ref,
          missing_field: field,
          now,
          kind: 'value',
          responseEpoch,
          slotQuestion: questionText,
        })
      );
    };

    const emitPendingSlotAlternate = () => {
      const field = state.confirmation_pending_slot;
      emitValueAsk(field, `I still need a number for ${slotLabel(field)} — what should it be?`);
    };

    const handleNegation = () => {
      if (state.confirmation_no_progress >= 1) {
        state.confirmation_no_progress = 2;
        return takeNegationCapExit();
      }
      state.confirmation_no_progress = 1;
      if (!state.confirmation_negation_reask_emitted) {
        state.confirmation_negation_reask_emitted = true;
        safeSend(
          ws,
          buildScriptCorrectionConfirm({
            sessionId,
            circuit_ref: state.circuit_ref,
            question: RING_CONFIRMATION_NEGATION_REASK,
            reason: RING_CONFIRMATION_NEGATION_REASON,
            now,
            responseEpoch,
          })
        );
        logger?.info?.('stage6.ring_continuity_script_confirmation_negation_reask', {
          sessionId,
          circuit_ref: state.circuit_ref,
          textPreview: reply.slice(0, 80),
        });
        return { handled: true, fallthrough: false };
      }
      if (state.confirmation_pending_slot) {
        emitPendingSlotAlternate();
      } else {
        safeSend(
          ws,
          buildScriptCorrectionConfirm({
            sessionId,
            circuit_ref: state.circuit_ref,
            question: RING_CONFIRMATION_NEGATION_REASK_ALTERNATE,
            reason: RING_CONFIRMATION_NEGATION_REASON,
            now,
            responseEpoch,
          })
        );
      }
      logger?.info?.('stage6.ring_continuity_script_confirmation_negation_reask_alternate', {
        sessionId,
        circuit_ref: state.circuit_ref,
        pending_slot: state.confirmation_pending_slot,
        textPreview: reply.slice(0, 80),
      });
      return { handled: true, fallthrough: false };
    };

    // 5a. Different-circuit preflight.
    const polarityRefs = collectCircuitRefsWithPolarity(reply);
    if (polarityRefs.length > 0) {
      const unnegated = [...new Set(polarityRefs.filter((r) => !r.negated).map((r) => r.ref))];
      const targets = unnegated.filter((ref) => ref !== state.circuit_ref);
      const allNegated = polarityRefs.every((r) => r.negated);
      if (targets.length >= 2 || allNegated) {
        return clearAndFallThrough('confirmation_multi_ref_fallthrough', {
          unnegated_targets: targets,
          all_negated: allNegated,
        });
      }
      if (targets.length === 1) {
        const targetRef = targets[0];
        const ringEvidence =
          detectEntry(reply).matched || (!ringSafe.rejected && ringSafe.values.length > 0);
        if (ringEvidence) {
          if (RING_CONFIRMATION_CLEAR_INTENT_PATTERN.test(reply)) {
            return clearAndFallThrough('confirmation_clear_intent_guarded', {
              target_ref: targetRef,
            });
          }
          if (RING_ENTRY_EXCLUSION_PATTERN.test(reply)) {
            return clearAndFallThrough('confirmation_destructive_seed_rejected', {
              target_ref: targetRef,
            });
          }
          // Seed the NEW circuit with the circuit-span-MASKED reply as the
          // extraction text and OVERWRITE semantics (mirrors the engine's
          // runEntry seed). Emit only the NEW circuit's grouped confirm.
          logger?.info?.('stage6.ring_continuity_script_confirmation_circuit_switch', {
            sessionId,
            from_ref: state.circuit_ref,
            to_ref: targetRef,
            textPreview: reply.slice(0, 80),
          });
          const maskedText = maskCircuitSpans(reply);
          clearScript(session);
          const volunteered = extractNamedFieldValues(maskedText);
          const existingOnTarget = readExistingRingValues(session, targetRef);
          if (
            volunteered.length === 0 &&
            Object.keys(existingOnTarget).length === 0 &&
            hasNumericValueWithUnit(maskedText)
          ) {
            // Mirror of the engine runEntry handover-to-Sonnet bail.
            return { handled: false };
          }
          initScript(session, targetRef, now);
          const freshState = session.ringContinuityScript;
          for (const [f, v] of Object.entries(existingOnTarget)) {
            if (RING_FIELDS.includes(f) && v !== '' && v !== null && v !== undefined) {
              freshState.values[f] = v;
            }
          }
          const writes = [];
          for (const w of volunteered) {
            // OVERWRITE: dictated values replace pre-filled destination
            // readings (a skip would silently retain stale readings).
            applyWrite(session, targetRef, w.field, w.value, now);
            writes.push(w);
          }
          if (writes.length > 0) {
            safeSend(ws, buildExtractionPayload(targetRef, writes));
          }
          const nextField = nextMissingField(freshState.values);
          if (!nextField) {
            transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
            return { handled: true, fallthrough: false };
          }
          safeSend(
            ws,
            buildScriptAsk({
              sessionId,
              circuit_ref: targetRef,
              missing_field: nextField,
              now,
              kind: 'value',
              responseEpoch,
            })
          );
          return { handled: true, fallthrough: false };
        }
      }
    }

    // 5b. Named amend (masked + qualified).
    if (ringSafe.rejected) {
      return clearAndFallThrough('confirmation_non_ring_context_fallthrough');
    }
    if (ringSafe.values.length > 0) {
      // Overwrite is intentional during confirmation — bypasses the
      // "skip if already set" guard the normal value loop applies.
      const overwrites = [];
      for (const w of ringSafe.values) {
        applyWrite(session, state.circuit_ref, w.field, w.value, now);
        overwrites.push(w);
      }
      if (overwrites.length > 0) {
        safeSend(ws, buildExtractionPayload(state.circuit_ref, overwrites));
      }
      state.confirmation_no_progress = 0;
      state.confirmation_pending_slot = null;
      transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
      logger?.info?.('stage6.ring_continuity_script_confirmation_amended', {
        sessionId,
        circuit_ref: state.circuit_ref,
        overwritten: overwrites.map((w) => w.field),
      });
      return { handled: true, fallthrough: false };
    }

    // 5c. Pending-slot anchored value.
    if (state.confirmation_pending_slot) {
      const pv = reply.match(RING_CONFIRMATION_PENDING_VALUE_PATTERN);
      if (pv) {
        const parsed = parseValue(pv[1]);
        if (parsed !== null && parsed !== undefined) {
          const field = state.confirmation_pending_slot;
          applyWrite(session, state.circuit_ref, field, parsed, now);
          safeSend(ws, buildExtractionPayload(state.circuit_ref, [{ field, value: parsed }]));
          logger?.info?.('stage6.ring_continuity_script_confirmation_pending_slot_amended', {
            sessionId,
            circuit_ref: state.circuit_ref,
            field,
            value: parsed,
          });
          state.confirmation_no_progress = 0;
          state.confirmation_pending_slot = null;
          transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
          return { handled: true, fallthrough: false };
        }
      }
    }

    // 5d. Slot-name-only selector.
    const selected = RING_CONFIRMATION_SLOT_SELECTORS.find((s) => s.selector.test(reply));
    if (selected) {
      if (state.confirmation_pending_slot === selected.field) {
        state.confirmation_no_progress += 1;
        if (state.confirmation_no_progress >= 2) return takeNegationCapExit();
        emitPendingSlotAlternate();
        logger?.info?.('stage6.ring_continuity_script_confirmation_same_slot_repeat', {
          sessionId,
          circuit_ref: state.circuit_ref,
          field: selected.field,
        });
        return { handled: true, fallthrough: false };
      }
      state.confirmation_pending_slot = selected.field;
      state.confirmation_no_progress = 0;
      emitValueAsk(selected.field, `What should ${selected.label} be?`);
      logger?.info?.('stage6.ring_continuity_script_confirmation_slot_selected', {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: selected.field,
      });
      return { handled: true, fallthrough: false };
    }

    // 5e. Bare negation.
    if (RING_NEGATIVE_RE.test(reply)) {
      return handleNegation();
    }

    // 5f. Positive finish, guarded against negated positives.
    if (detectConfirmationPositive(reply)) {
      if (RING_NEGATED_POSITIVE_RE.test(reply)) {
        return handleNegation();
      }
      finishScript(ws, session, sessionId, now, logger, responseEpoch);
      return { handled: true, fallthrough: false };
    }

    // 5g. Guarded re-entry.
    if (detectEntry(reply).matched) {
      if (RING_ENTRY_EXCLUSION_PATTERN.test(reply)) {
        return clearAndFallThrough('confirmation_reentry_guarded');
      }
      state.confirmation_pending_slot = null;
      state.confirmation_negation_reask_emitted = false;
      state.confirmation_no_progress = 0;
      transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
      return { handled: true, fallthrough: false };
    }

    // 5h. Idle — reading-like clears + falls through untouched; junk while
    // a slot is pending is a counted miss (first miss always speaks);
    // plain idle clears + falls through.
    if (isReadingLikeReply(reply)) {
      return clearAndFallThrough('confirmation_reading_fallthrough');
    }
    if (state.confirmation_pending_slot) {
      state.confirmation_no_progress += 1;
      if (state.confirmation_no_progress >= 2) return takeNegationCapExit();
      emitPendingSlotAlternate();
      logger?.info?.('stage6.ring_continuity_script_confirmation_pending_junk_miss', {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: state.confirmation_pending_slot,
        textPreview: reply.slice(0, 80),
      });
      return { handled: true, fallthrough: false };
    }
    return clearAndFallThrough('confirmation_idle_cleared');
  }

  // 4. Resolve circuit FIRST if pending. Digit answer ("circuit 1" /
  //    "1") preferred; designation answer ("downstairs sockets") falls
  //    out via Fix B's findCircuitByDesignation. If neither resolves,
  //    the script can't move forward — exit with fallthrough so Sonnet
  //    sees the same transcript on its normal path.
  //
  //    Reordered 2026-04-29: previously this block ran AFTER the value-
  //    extraction block, which meant a "Circuit 1, neutrals 0.43" answer
  //    would silently drop the named-field portion (the writes-loop
  //    skipped because state.circuit_ref was still null). Resolving
  //    first lets the value loop fire on the same turn that resolved
  //    the circuit.
  const writes = [];
  let drainedFromPending = false;
  let circuitResolvedThisTurn = false;
  if (state.circuit_ref === null) {
    const m = text.match(/\bcircuit\s*(\d{1,3})\b|^\s*(\d{1,3})\s*\.?\s*$/i);
    let ref = m ? Number(m[1] ?? m[2]) : NaN;

    // Fix B (2026-04-29, session 74201B27): designation lookup. If the
    // inspector answered "downstairs sockets" rather than "circuit 1",
    // search the snapshot for a unique designation match.
    if (!Number.isInteger(ref) || ref <= 0) {
      const designationMatch = findCircuitByDesignation(session, text);
      if (designationMatch !== null) {
        ref = designationMatch;
        logger?.info?.('stage6.ring_continuity_script_designation_match', {
          sessionId,
          circuit_ref: ref,
          textPreview: text.slice(0, 80),
        });
      }
    }

    if (Number.isInteger(ref) && ref > 0) {
      state.circuit_ref = ref;
      circuitResolvedThisTurn = true;
      const existing = readExistingRingValues(session, ref);
      for (const [f, v] of Object.entries(existing)) {
        if (RING_FIELDS.includes(f) && v !== '' && v !== null && v !== undefined) {
          state.values[f] = v;
        }
      }
      // Drain pending_writes onto the now-resolved circuit. Skip any
      // field already filled (existing snapshot win or the inspector
      // said it twice between entry and resolution).
      if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
        for (const w of state.pending_writes) {
          if (state.values[w.field] !== undefined) continue;
          applyWrite(session, ref, w.field, w.value, now);
          writes.push(w);
          drainedFromPending = true;
        }
        state.pending_writes = [];
      }
      logger?.info?.('stage6.ring_continuity_script_circuit_resolved', {
        sessionId,
        circuit_ref: ref,
        pre_existing_filled: Object.keys(state.values).filter(
          (f) => !writes.some((w) => w.field === f)
        ),
        drained_pending_writes: writes.map((w) => w.field),
        textPreview: text.slice(0, 80),
      });
    } else {
      // Couldn't resolve a circuit from this turn. Before giving up,
      // check whether the inspector volunteered MORE field values
      // while still waiting on the circuit naming. Common pattern
      // (session 361A638D, 2026-04-29 10:44 BST):
      //
      //   T1: "ring continuity"          → script enters, asks
      //                                     "Which circuit?"
      //   T2: "Uh, the lives are 0.86."  → not a circuit answer; the
      //                                     inspector has just kept
      //                                     dictating. Queue R1=0.86,
      //                                     stay alive, wait for the
      //                                     circuit on a later turn.
      //   T3: "downstairs sockets"       → designation match → resolve
      //                                     circuit → drain queue.
      //
      // If the text has neither a circuit reference nor a field value,
      // we genuinely have nothing to do — fall through to Sonnet so
      // its prompt can reason about the utterance. The script's pending
      // queue is discarded in that case (logged so we can size the
      // problem in production).
      const followUpVolunteered = extractNamedFieldValues(text);
      if (followUpVolunteered.length > 0) {
        // Stay in the script. Queue the values and wait silently for
        // the circuit. (No re-ask via TTS — interrupting the inspector
        // mid-dictation with another "Which circuit?" prompt would be
        // disruptive. The hard timeout / next entry will handle the
        // case where the circuit never arrives.)
        for (const w of followUpVolunteered) {
          // De-dup: don't queue the same field twice.
          const alreadyQueued = (state.pending_writes ?? []).some(
            (existing) => existing.field === w.field
          );
          if (alreadyQueued) continue;
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          state.pending_writes.push(w);
        }
        logger?.info?.('stage6.ring_continuity_script_queued_values', {
          sessionId,
          textPreview: text.slice(0, 80),
          queued_fields: followUpVolunteered.map((w) => w.field),
          pending_writes_total: state.pending_writes.length,
        });
        return { handled: true, fallthrough: false };
      }

      // Truly nothing to work with — text has no circuit ref, no
      // designation match, and no field value. Exit and let Sonnet
      // handle it. Any pending_writes from earlier turns are lost
      // (Fix C, deferred, would route them to a last-named-circuit
      // fallback). Logged for analytics / future tuning.
      logger?.info?.('stage6.ring_continuity_script_unresolvable_circuit', {
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

  // 5. Did the user volunteer one or more named-field values on THIS
  //    turn? Runs AFTER circuit resolution above, so a "Circuit 1,
  //    neutrals 0.43" answer applies the Rn write on the same turn.
  const named = extractNamedFieldValues(text);
  for (const w of named) {
    if (state.values[w.field] !== undefined) continue; // don't overwrite
    applyWrite(session, state.circuit_ref, w.field, w.value, now);
    writes.push(w);
  }

  // 6. If no named fields matched on this turn (and pending didn't
  //    cover everything), treat a bare value as the currently-expected
  //    field. (This is the "Neutrals are." → "0.43." case from session
  //    B107472D — the bare value lands as Rn because `expecting`
  //    advanced past R1 already. Also covers the "Note tools are 0.75"
  //    Deepgram-garbled case from session 74201B27 — even when the
  //    field word is mangled, the bare numeric still lands on the next
  //    missing slot.)
  //
  //    Suppress the bare-value fallback when:
  //    a) we just drained pending writes from an entry-without-circuit
  //       answer turn (the utterance has already been consumed by the
  //       resolver — e.g. "downstairs sockets" → designation match →
  //       c1 → drained R1), OR
  //    b) circuit_ref was JUST resolved from this turn's text. The
  //       digit that resolved the circuit ("circuit 13" / bare "13")
  //       would otherwise re-parse as bareValue="13" and write
  //       ring_r1_ohm=13 — clearly nonsensical. Same logic for the
  //       designation path: "downstairs sockets" alone won't parse,
  //       but "circuit 13, 0.43" is genuinely ambiguous (could be R1
  //       or just punctuation), so we conservatively suppress and
  //       require the user to use a field word ("lives 0.43") for
  //       same-turn value disambiguation.
  if (
    !drainedFromPending &&
    !circuitResolvedThisTurn &&
    named.length === 0 &&
    state.circuit_ref !== null
  ) {
    const bareValue = parseValue(text);
    if (bareValue !== null) {
      const expected = nextMissingField(state.values);
      if (expected) {
        applyWrite(session, state.circuit_ref, expected, bareValue, now);
        writes.push({ field: expected, value: bareValue });
      }
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(state.circuit_ref, writes));
  }

  // 7. Are we done filling? Yes → confirmation phase. No → ask next.
  //    Confirmation gives the inspector a chance to amend any reading
  //    Deepgram garbled before we finalise. See `buildScriptConfirm`.
  const nextField = nextMissingField(state.values);
  if (!nextField) {
    transitionToConfirmation(ws, session, sessionId, now, logger, responseEpoch);
    return { handled: true, fallthrough: false };
  }

  // 8. Otherwise, ask for the next missing field.
  safeSend(
    ws,
    buildScriptAsk({
      sessionId,
      circuit_ref: state.circuit_ref,
      missing_field: nextField,
      now,
      kind: 'value',
      responseEpoch,
    })
  );
  return { handled: true, fallthrough: false };
}

/**
 * Look up a circuit by its designation in the snapshot. Used when the
 * inspector answers a "Which circuit is the ring continuity for?" prompt
 * by NAME ("downstairs sockets") rather than NUMBER ("circuit 1").
 *
 * Background — Bug B from session 74201B27 (2026-04-29 09:33 BST): the
 * inspector created circuit 1 with designation "downstairs sockets",
 * then said "Ring continuity is lives are 0.75". The script asked
 * "Which circuit?" and they answered with the designation
 * ("downstairs sockets") — the natural way to refer to the circuit they
 * had just named. The original parser only accepted digit form
 * ("circuit 1" or bare "1") so the script gave up and the R1 reading
 * was lost.
 *
 * The agentic system prompt at `config/prompts/sonnet_agentic_system.md:47`
 * already documents the "DESCRIPTION MATCHING: schedule match → use"
 * pattern for Sonnet's own circuit lookups; this helper applies the same
 * idea to the script's own answer parser.
 *
 * Match rules:
 *   - Lowercase + collapse whitespace on BOTH sides.
 *   - Bidirectional substring match: the user's text may be a longer
 *     sentence containing the designation ("it's the downstairs sockets
 *     one"), or a shorter prefix of the designation ("downstairs" when
 *     the canonical name is "downstairs sockets"). Either way is a
 *     legitimate designation reference; users don't always recite the
 *     full canonical name.
 *   - Returns the circuit_ref if exactly ONE designation matches.
 *   - Returns null if zero or two-plus circuits match (ambiguous).
 *   - Skips circuit 0 — that bucket is the supply / installation slot,
 *     not a real circuit.
 *
 * @param {object} session     EICRExtractionSession instance.
 * @param {string} text        User's transcript text.
 * @returns {number | null}    circuit_ref if unambiguous, else null.
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
    // circuit 0 is the supply / installation bucket — not askable.
    if (!Number.isInteger(ref) || ref <= 0) continue;
    // Canonical schema key is `circuit_designation` (per
    // `_seedStateFromJobState` in eicr-extraction-session.js, which mirrors
    // `field_schema.json.circuit_fields`). Fall back to bare `designation`
    // for legacy in-memory shapes that haven't been canonicalised yet.
    // 2026-04-30 (session BBE66264, 59 Chucklesville Road) repro: the iOS
    // session_start payload seeded this circuit with `circuit_designation:
    // "Upstairs Sockets"` but the lookup checked only `bucket.designation`
    // — always undefined post-seed — so "ring continuity for upstairs
    // sockets" entered the script with circuit_ref=null and asked "Which
    // circuit?" even though the designation was right there in the
    // utterance.
    const designation = bucket.circuit_designation || bucket.designation;
    if (typeof designation !== 'string' || !designation.trim()) continue;
    const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normDes) continue;
    // Bidirectional substring — user may say more or less than the
    // canonical designation. Both directions are intentional reference
    // forms ("the downstairs sockets one" or "downstairs" → "downstairs
    // sockets").
    if (normalised.includes(normDes) || normDes.includes(normalised)) {
      matches.push(ref);
    }
  }
  // Deduplicate (in case the iteration produced a circuit twice via
  // string + number key collision).
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Read whatever ring values already exist on the snapshot for a given
 * circuit. Tolerant of the same schema shape as findExpiredPartial — the
 * snapshot's `circuits` may be either an Object or an Array depending on
 * which path mutated it last.
 */
function readExistingRingValues(session, circuit_ref) {
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
  for (const f of RING_FIELDS) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}

/**
 * Emit completion TTS and clear state. Also clears the 60s timeout
 * module's per-circuit timestamp because the bucket is full and there's
 * nothing to ask about later.
 */
function finishScript(ws, session, sessionId, now, logger, responseEpoch = null) {
  const state = session.ringContinuityScript;
  if (!state) return;
  const { circuit_ref, values } = state;
  // #34 (2026-06-19): terse completion ack — the "All correct?" confirmation
  // prompt already read R1/Rn/R2 aloud, so re-reading them here double-read
  // the triple. Kept byte-identical with the dialogue-engine ring-continuity
  // schema finishMessage so dialogue-engine-replay.test.js parity holds.
  safeSend(
    ws,
    buildScriptInfo({
      sessionId,
      kind: 'done',
      text: 'Got it.',
      now,
      responseEpoch,
    })
  );
  logger?.info?.('stage6.ring_continuity_script_completed', {
    sessionId,
    circuit_ref,
    values: { ...values },
  });
  clearScript(session);
  clearRingContinuityState(session, circuit_ref);
}

// Test-only exports for fine-grained unit tests.
export const __testing__ = {
  detectDifferentRingEntry,
  parseValue,
  extractNamedFieldValues,
  nextMissingField,
  readExistingRingValues,
  findCircuitByDesignation,
  initScript,
  clearScript,
  buildScriptAsk,
  buildScriptInfo,
  buildScriptConfirm,
  buildExtractionPayload,
  detectConfirmationPositive,
};
