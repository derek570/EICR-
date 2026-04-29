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
import { applyReadingToSnapshot } from './stage6-snapshot-mutators.js';

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
  // 1. Full: "ring continuity/final" + optional "circuit N" within 50 chars.
  //    Allows filler ("for, uh,"), any preposition ("for"/"on"), or none.
  /\bring\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // 2. Terse: clause-start "ring ... circuit N" — no "continuity"/"final"
  //    word required, but the "circuit N" trailer is mandatory to block
  //    "ringing"/"ring main" false positives.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?ring\b[^.?!]{0,20}?\bcircuit\s*(\d{1,3})\b/i,
];

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
  /\binsulation\s+resistance\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
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
 * Returns an ordered array of `{field, value}` for every matching pair
 * found. Empty array if none.
 *
 * @param {string} text
 * @returns {Array<{field: string, value: string}>}
 */
function extractNamedFieldValues(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // Order: r1 (lives) → rn (neutrals) → r2 (earths/CPC). Each pattern
  // captures the value (numeric or sentinel) within ~30 chars after the
  // field word, allowing for filler words like "are", "is", "at".
  const patterns = [
    {
      field: 'ring_r1_ohm',
      re: /\blives?\b[^\d∞]{0,30}?(\d*\.?\d+|infinite|open|discontinuous|infinity)/i,
    },
    {
      field: 'ring_rn_ohm',
      re: /\bneutrals?\b[^\d∞]{0,30}?(\d*\.?\d+|infinite|open|discontinuous|infinity)/i,
    },
    {
      field: 'ring_r2_ohm',
      re: /\b(?:earths?|cpc|c\s*p\s*c)\b[^\d∞]{0,30}?(\d*\.?\d+|infinite|open|discontinuous|infinity)/i,
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
 * Build an ask_user_started wire payload for the next missing field.
 * Synthetic tool_call_id so the iOS side's dedupe doesn't collide with a
 * Sonnet-emitted ask. Marker `srv-rcs` distinguishes the script from the
 * 60s timeout module's `srv-ring` namespace.
 */
function buildScriptAsk({ sessionId, circuit_ref, missing_field, now, kind }) {
  // kind:
  //   'which_circuit' → entry without a circuit number; question asks
  //                     for the circuit, not a value. context_field/circuit
  //                     null because the iOS side will re-route the answer
  //                     via Sonnet (see fallthrough on circuit answer below).
  //   'value'         → standard "what's the next reading?" prompt.
  if (kind === 'which_circuit') {
    return {
      type: 'ask_user_started',
      tool_call_id: `srv-rcs-${sessionId}-which-${now}`,
      question: 'Which circuit is the ring continuity for?',
      reason: 'missing_context',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'value',
    };
  }
  return {
    type: 'ask_user_started',
    tool_call_id: `srv-rcs-${sessionId}-${circuit_ref}-${missing_field}-${now}`,
    question: FIELD_PROMPTS[missing_field]?.tts ?? `What's the ${missing_field}?`,
    reason: 'missing_value',
    context_field: missing_field,
    context_circuit: circuit_ref,
    expected_answer_shape: 'value',
  };
}

/**
 * Build a completion / cancellation TTS payload. We piggyback on
 * `ask_user_started` because that's the wire shape iOS already plays
 * through ElevenLabs; the alternative would be a new wire type and an
 * iOS code change. Setting `expected_answer_shape: 'none'` signals iOS
 * that no reply is wanted; iOS treats this as a brief informational
 * announcement.
 */
function buildScriptInfo({ sessionId, kind, text, now }) {
  return {
    type: 'ask_user_started',
    tool_call_id: `srv-rcs-${sessionId}-${kind}-${now}`,
    question: text,
    reason: 'info',
    context_field: null,
    context_circuit: null,
    expected_answer_shape: 'none',
  };
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
  applyReadingToSnapshot(session.stateSnapshot, {
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
  const { ws, session, sessionId, transcriptText, logger, now = Date.now() } = ctx;
  if (!session) return { handled: false };

  const state = session.ringContinuityScript;
  const text = typeof transcriptText === 'string' ? transcriptText : '';

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
    const circuitRef = entry.circuit_ref;
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
      pre_existing_filled: Object.keys(existing).filter((f) => RING_FIELDS.includes(f)),
      volunteered_writes: writes.map((w) => w.field),
      pending_writes: session.ringContinuityScript.pending_writes.map((w) => w.field),
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
        })
      );
      return { handled: true, fallthrough: false };
    }

    const nextField = nextMissingField(session.ringContinuityScript.values);
    if (!nextField) {
      // All three filled (volunteered + existing) — emit completion and clear.
      finishScript(ws, session, sessionId, now, logger);
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
      })
    );
    return { handled: true, fallthrough: false };
  }

  // ───────────────────────────────────────────── Active: handle turn ──
  state.last_turn_at = now;

  // 1. Cancel — preserve writes, clear state, announce.
  if (detectCancel(text)) {
    const filled = Object.keys(state.values).length;
    logger?.info?.('stage6.ring_continuity_script_cancelled', {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
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
      })
    );
    clearScript(session);
    return { handled: true, fallthrough: false };
  }

  // 2. Different ring entry on a NEW circuit — seamlessly switch.
  const newRef = detectDifferentRingEntry(text, state.circuit_ref);
  if (newRef !== null) {
    logger?.info?.('stage6.ring_continuity_script_switched_circuit', {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: Object.keys(state.values).length,
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
    });
    clearScript(session);
    return { handled: true, fallthrough: true, transcriptText };
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

  // 7. Are we done?
  const nextField = nextMissingField(state.values);
  if (!nextField) {
    finishScript(ws, session, sessionId, now, logger);
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
    const designation = bucket.designation;
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
function finishScript(ws, session, sessionId, now, logger) {
  const state = session.ringContinuityScript;
  if (!state) return;
  const { circuit_ref, values } = state;
  const r1 = values.ring_r1_ohm ?? '?';
  const rn = values.ring_rn_ohm ?? '?';
  const r2 = values.ring_r2_ohm ?? '?';
  safeSend(
    ws,
    buildScriptInfo({
      sessionId,
      kind: 'done',
      text: `Got it. R1 ${r1}, Rn ${rn}, R2 ${r2}.`,
      now,
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
  buildExtractionPayload,
};
