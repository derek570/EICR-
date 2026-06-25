// stage6-answer-resolver.js
//
// Deterministic matcher for ask_user replies. When Sonnet emits an ask_user
// with a `pending_write` attached (the buffered value waiting for a circuit
// or other context), the server tries to resolve the user's spoken answer
// HERE before round-tripping back to Sonnet. This is the load-bearing piece
// of the "server-side state machine" that bug-1B (number_of_points = 4
// answered "the cooker circuit" but never written) needs.
//
// Architecture: well-formed questions collapse the answer space. A circuit-
// disambiguation ask has ONLY a few legitimate reply shapes:
//
//   - bare integer ("two", "2", "circuit two")
//   - designation match ("the cooker", "kitchen sockets", "shower")
//   - broadcast ("all", "every circuit", "all of them")
//   - cancel ("skip", "never mind", "forget it")
//   - free-form / out-of-band ("actually it's for circuit five not two", a
//     sentence with corrections, mixed clauses, or off-topic content)
//
// The first four are deterministic. The fifth is what Sonnet is good at —
// language interpretation in context. So we match the first four and ESCALATE
// the fifth back to Sonnet with the pending_write echoed plus a parsed_hint
// so it has everything it needs to act in one more turn.
//
// Conservative thresholds: when in doubt, escalate. Misrouting a number to
// the wrong circuit is a much worse failure mode than asking Sonnet to
// finish the job on a tricky reply.
//
// Pure module — no I/O, no logger, no network. The dispatcher is responsible
// for invoking the resolver, performing the auto-write, and shaping the
// tool_result envelope. Keeping this module pure means it tests easily and
// can be stress-tested with synthetic inputs.

import { createRequire } from 'node:module';
import { isEvasionMarker, isValidSentinel } from './value-normalise.js';

// JSON-import via createRequire mirrors the canonical pattern used by
// stage6-tool-schemas.js (lines 33-42) — under this project's ES-modules +
// Jest setup, import-assert / import-with both cause issues, so a node:module
// require is the safest path. field_schema.json is the source of truth.
const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

// Mirror CONTEXT_FIELD_ENUM's non-circuit source set
// (stage6-tool-schemas.js:88-103). Computed once at module load;
// field_schema.json is the canonical source of truth. _ui_* meta keys
// are filtered out. Used by the multi-circuit fan-out guard in the
// resolvers below: a board / supply / installation field is meaningless
// to fan out across N circuits, so the resolver bails out so the legacy
// free-text body can let Sonnet re-ask with the correct scope.
const NON_CIRCUIT_CONTEXT_FIELDS = new Set(
  [
    ...Object.keys(fieldSchema.board_fields ?? {}),
    ...Object.keys(fieldSchema.supply_characteristics_fields ?? {}),
    ...Object.keys(fieldSchema.installation_details_fields ?? {}),
  ].filter((k) => !k.startsWith('_ui_'))
);

// ---------------------------------------------------------------------------
// Number-word lexicon
// ---------------------------------------------------------------------------
//
// Spoken-circuit-ref answers regularly arrive as words rather than digits:
// "circuit two", "two", "twenty-one". Cap at 100 — circuit refs above that
// are vanishingly rare, and bigger lexicons are a maintenance hazard with
// little payoff.

const ONES = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

// Ordinals for "the second circuit" / "third" patterns. Capped at 12 because
// circuits beyond ~10 are rarely phrased as ordinals — speakers default to
// cardinals ("circuit fifteen") at that point. Add more if a real session
// reveals the gap.
const ORDINALS = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};

/**
 * Parse a small English number ("twenty-one", "thirty") into an integer.
 * Returns null if the input doesn't cleanly parse as a number under 100.
 *
 * @param {string} word
 * @returns {number|null}
 */
function parseNumberWord(word) {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, ' ');
  if (!w) return null;
  // ORDINALS first so "second" / "third" parse as 2 / 3 when used alone.
  // (Cardinals shadow them only on multi-word forms — "twenty second" isn't
  // recognised; that's an acceptable gap for now.)
  if (Object.prototype.hasOwnProperty.call(ORDINALS, w)) return ORDINALS[w];
  if (Object.prototype.hasOwnProperty.call(ONES, w)) return ONES[w];
  if (Object.prototype.hasOwnProperty.call(TENS, w)) return TENS[w];
  // "twenty one", "thirty four", etc.
  const parts = w.split(' ');
  if (
    parts.length === 2 &&
    Object.prototype.hasOwnProperty.call(TENS, parts[0]) &&
    Object.prototype.hasOwnProperty.call(ONES, parts[1])
  ) {
    return TENS[parts[0]] + ONES[parts[1]];
  }
  return null;
}

/**
 * Strip leading/trailing punctuation from a lowered string. STT routinely
 * appends commas, periods, or exclamation marks; the cancel/broadcast
 * phrase-match used to compare exact strings and would miss "skip." or
 * "all circuits!" — escalating instead of cancelling/broadcasting and
 * costing the user a clarification turn.
 *
 * Internal whitespace and word characters are preserved.
 *
 * @param {string} s
 * @returns {string}
 */
function stripPunct(s) {
  return s.replace(/^[\W_]+|[\W_]+$/g, '').trim();
}

// ---------------------------------------------------------------------------
// Stop words — phrases users routinely add around a circuit reference that
// don't carry semantic content. Stripped before designation matching so
// "the cooker circuit" matches "Cooker" without the article + suffix
// throwing off the comparison.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'is',
  'on',
  'for',
  'circuit',
  'circuits',
  'cct', // industry shorthand for "circuit"
  'number', // "circuit number two" → strip "number" to leave "two"
  // NOTE 2026-04-27: 'one' was previously a STOP_WORD with the comment
  // "dropped only when paired with a designation (handled by structural check)".
  // P2-B (compound number parsing) now strips STOP_WORDS up-front in
  // extractCircuitRef before the whole-tokens parseNumberWord call. With
  // 'one' in STOP_WORDS, "circuit twenty-one" → tokens=['twenty'] → 20
  // (loses the trailing 'one'). Removing 'one' from STOP_WORDS lets
  // "twenty one" → 21 round-trip; the numeric path runs first so a bare
  // "one" is parsed as cardinal 1 and never reaches the designation pass.
  'please',
  'yeah',
  'yep',
  'yes',
  'um',
  'uh',
  'er',
]);

// NOTE: 'no' is intentionally a CANCEL_PHRASE (below) and NOT a STOP_WORD —
// adding it to STOP_WORDS would make "no" cancel the cancel-detection (the
// stripped reply would be empty, escalating instead of cancelling). Keep
// STOP_WORDS focused on filler tokens that appear AROUND a circuit reference.

// "circuit" appears in STOP_WORDS but we DELIBERATELY keep "one" out of the
// stripper for free-form replies because "one" is also a number — context
// resolves it. The integer-parse pass above already handles "one" as 1; only
// the designation-match pass strips "circuit" because "the cooker circuit"
// reduces to "cooker" without ambiguity.

const BROADCAST_PHRASES = [
  'all',
  'all of them',
  'every',
  'every circuit',
  'all circuits',
  'each',
  'each circuit',
  'everywhere',
  'everything',
];

const CANCEL_PHRASES = [
  'skip',
  'never mind',
  'nevermind',
  'forget it',
  'cancel',
  'leave it',
  'drop it',
  'no',
  'none',
  'pass',
];

// ---------------------------------------------------------------------------
// Designation matching
// ---------------------------------------------------------------------------
//
// Inspector replies like "the cooker" need to match against
// stateSnapshot.circuits[].circuit_designation. Two-pass match:
//
//   pass 1 — exact case-insensitive match on the cleaned reply
//   pass 2 — substring match: cleaned reply IS A SUBSTRING of designation,
//            OR designation is a substring of cleaned reply
//
// Pass 2 returns AMBIGUOUS if it produces multiple hits — never auto-route
// to circuit N when "the kitchen" matches both "Kitchen sockets" and
// "Kitchen lighting". That's where Sonnet earns its keep.
//
// The matcher RETURNS the matching circuit_ref(s), not the designation string,
// because the caller needs the ref to dispatch the buffered write.

/**
 * Strip stop words and "circuit"-like fillers from a reply so the residue is
 * a plausible designation token.
 *
 * @param {string} reply
 * @returns {string} cleaned reply (may be empty)
 */
function cleanReplyForDesignation(reply) {
  const words = reply.toLowerCase().match(/[a-z0-9]+/g) || [];
  const filtered = words.filter((w) => !STOP_WORDS.has(w));
  return filtered.join(' ').trim();
}

/**
 * Match a cleaned reply against the available circuits' designations.
 *
 * @param {string} cleaned        cleanReplyForDesignation() output
 * @param {Array<{circuit_ref: number|string, circuit_designation?: string, designation?: string}>} circuits
 * @returns {{kind: 'exact'|'unique_substring'|'ambiguous'|'no_match', circuitRefs: number[]}}
 */
function matchDesignation(cleaned, circuits) {
  if (!cleaned) return { kind: 'no_match', circuitRefs: [] };
  if (!Array.isArray(circuits) || circuits.length === 0) {
    return { kind: 'no_match', circuitRefs: [] };
  }
  const lc = cleaned;
  const exact = [];
  const substr = [];
  for (const c of circuits) {
    const desig = (c.circuit_designation ?? c.designation ?? '').toLowerCase().trim();
    if (!desig) continue;
    const ref =
      typeof c.circuit_ref === 'number'
        ? c.circuit_ref
        : Number.parseInt(String(c.circuit_ref), 10);
    if (!Number.isFinite(ref)) continue;
    if (desig === lc) {
      exact.push(ref);
      continue;
    }
    if (desig.includes(lc) || lc.includes(desig)) {
      substr.push(ref);
    }
  }
  if (exact.length === 1) return { kind: 'exact', circuitRefs: exact };
  if (exact.length > 1) return { kind: 'ambiguous', circuitRefs: exact };
  if (substr.length === 1) return { kind: 'unique_substring', circuitRefs: substr };
  if (substr.length > 1) return { kind: 'ambiguous', circuitRefs: substr };
  return { kind: 'no_match', circuitRefs: [] };
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

/**
 * Possible verdicts:
 *
 *   { kind: 'auto_resolve', writes: [{tool, field, circuit, value, confidence, source_turn_id}] }
 *     — server should dispatch each write directly. `writes` is an array so
 *       broadcast ("all circuits") expands into one write per circuit.
 *
 *   { kind: 'cancel' }
 *     — the user said "skip" / "never mind". Server discards the pending
 *       write and tells Sonnet via tool_result. Sonnet should not re-ask.
 *
 *   { kind: 'escalate', parsed_hint: string, available_circuits: [...] }
 *     — server cannot confidently match. Tool_result echoes pending_write,
 *       includes the available circuits and the parsed_hint so Sonnet has
 *       full context to retry.
 *
 *   { kind: 'no_pending_write' }
 *     — the ask had no pending_write attached, so the resolver has nothing
 *       to do. Caller falls back to legacy behaviour (just return the
 *       untrusted_user_text).
 */

/**
 * Resolve a circuit-disambiguation ask_user reply against a pending_write +
 * the current snapshot of circuits.
 *
 * Inputs are all data — no side effects. Output is a verdict object the
 * dispatcher acts on.
 *
 * @param {object} args
 * @param {string} args.userText                         the inspector's reply
 * @param {object|null|undefined} args.pendingWrite      buffered write, may be null
 * @param {Array<object>} args.availableCircuits         stateSnapshot circuits
 * @param {string|null} [args.contextBoardId]            board the ask is scoped to (readback-correction-optionb §3.3/§6); stamped onto each resolved write so a sub-board pending_write lands on the right board
 * @returns {{kind: string, writes?: Array, parsed_hint?: string, available_circuits?: Array}}
 */
export function resolveCircuitAnswer({
  userText,
  pendingWrite,
  availableCircuits,
  contextBoardId = null,
}) {
  if (!pendingWrite || typeof pendingWrite !== 'object') {
    return { kind: 'no_pending_write' };
  }
  const text = String(userText ?? '').trim();
  if (!text) {
    return {
      kind: 'escalate',
      parsed_hint: 'empty_reply',
      available_circuits: availableCircuits ?? [],
    };
  }
  const lower = text.toLowerCase();
  // Strip leading/trailing punctuation so "skip." / "never mind!" /
  // "all circuits," still phrase-match. The original `lower` is preserved
  // for the value-shape anti-pattern guards below — those checks examine
  // the user's exact text.
  const stripped = stripPunct(lower);

  // Cancel — short-circuit before anything else.
  if (CANCEL_PHRASES.includes(stripped)) {
    return { kind: 'cancel' };
  }

  // Broadcast — expand pending_write into one write per circuit.
  // EXCEPT for record_board_reading: a board-level write ignores circuit_ref
  // (it lands at circuits[0] regardless), so producing N synthetic writes
  // when the user said "all circuits" creates N redundant log rows and N
  // misleading tool_call_ids that all dispatch the same value to the same
  // bucket. The pending_write schema documents this contract; the resolver
  // honours it by emitting a single write.
  if (BROADCAST_PHRASES.includes(stripped)) {
    if (pendingWrite.tool === 'record_board_reading') {
      return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, 0, contextBoardId)] };
    }
    const circuits = Array.isArray(availableCircuits) ? availableCircuits : [];
    if (circuits.length === 0) {
      return { kind: 'escalate', parsed_hint: 'broadcast_no_circuits', available_circuits: [] };
    }
    const writes = circuits
      .map((c) => {
        const ref =
          typeof c.circuit_ref === 'number'
            ? c.circuit_ref
            : Number.parseInt(String(c.circuit_ref), 10);
        if (!Number.isFinite(ref)) return null;
        return buildWrite(pendingWrite, ref, contextBoardId);
      })
      .filter(Boolean);
    return { kind: 'auto_resolve', writes };
  }

  // Anti-pattern guards FIRST. The user might have answered with the
  // value-shape ("N/A", "incomplete") rather than a circuit — that's not a
  // designation clue, escalate without trying any further matching. Doing
  // this before designation match prevents false positives where the cleaned
  // residue of a sentinel reply ("N/A" → "n" after stop-word strip) accidentally
  // substring-matches a circuit name.
  if (isEvasionMarker(text) || isValidSentinel(text)) {
    return {
      kind: 'escalate',
      parsed_hint: 'reply_was_value_not_circuit',
      available_circuits: availableCircuits ?? [],
    };
  }

  // Numeric path: bare digit ("2"), word ("two"), "circuit 2", "circuit two".
  const numericRef = extractCircuitRef(lower);
  if (numericRef !== null) {
    return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, numericRef, contextBoardId)] };
  }

  // Designation match. Require the cleaned residue to be at least 2 chars —
  // single-letter substrings produce noisy matches (a stray "n" or "a" lights
  // up almost any designation). The 2-char floor is the minimum-meaningful
  // EICR-schedule designation token ("EV" charger, "AC" unit, "EM" emergency
  // lighting, etc.) — pre-2026-04-27 the threshold was 3 and rejected those
  // legitimate short designations even though the comment claimed they were
  // supported. The exact + ambiguous-substring logic below already prevents
  // false positives; the length floor only filters truly noisy 1-char input.
  const cleaned = cleanReplyForDesignation(lower);
  if (cleaned.length < 2) {
    return {
      kind: 'escalate',
      parsed_hint: 'reply_too_short_for_designation_match',
      available_circuits: availableCircuits ?? [],
    };
  }
  const match = matchDesignation(cleaned, availableCircuits ?? []);
  if (match.kind === 'exact' || match.kind === 'unique_substring') {
    return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, match.circuitRefs[0], contextBoardId)] };
  }
  if (match.kind === 'ambiguous') {
    return {
      kind: 'escalate',
      parsed_hint: `ambiguous_designation_match:${match.circuitRefs.join(',')}`,
      available_circuits: availableCircuits ?? [],
    };
  }

  return {
    kind: 'escalate',
    parsed_hint: 'no_deterministic_match',
    available_circuits: availableCircuits ?? [],
  };
}

/**
 * Extract a circuit_ref from a reply that contains exactly one parseable
 * integer reference. Returns null if zero or more than one candidate.
 *
 * Recognised shapes:
 *   "2", "two", "circuit 2", "circuit two", "the second circuit",
 *   "circuit number two".
 *
 * Does NOT match "0.4" (decimal) or "two five" (multi-digit speech) — those
 * shapes are signal that the reply isn't a circuit_ref and we should escalate.
 *
 * @param {string} lowerText
 * @returns {number|null}
 */
export function extractCircuitRef(lowerText) {
  // Strip trailing sentence punctuation up front. STT routinely appends "."
  // to short answers ("circuit 2."), and the digit-match regex's
  // decimal-rejection lookahead `(?![\d.])` treats a trailing "." as a
  // decimal-point separator — wrongly rejecting "circuit 2." while
  // correctly rejecting "0.4". Stripping ONLY the trailing run preserves
  // the decimal guard (".4", "0.4", "1.23" still fail because the dot is
  // internal, not trailing) while letting sentence-ending punctuation
  // through. Mirrors stripPunct's intent without the leading-strip
  // (callers already lower-case; leading word chars are what we want to
  // see).
  const trimmed = lowerText.replace(/[.,!?;:\s]+$/, '');
  // Strict digit match: a single integer 1..200, optionally preceded by
  // "circuit" / "circuit number". Reject decimals.
  const digit = trimmed.match(/(?:^|[^\d.])(\d{1,3})(?![\d.])/);
  if (digit) {
    const n = Number.parseInt(digit[1], 10);
    if (n >= 1 && n <= 200) {
      // Make sure there's only ONE numeric token. Multiple → escalate.
      const allNums = lowerText.match(/\d+/g) || [];
      if (allNums.length === 1) return n;
      return null;
    }
  }

  // Word number. Strip stop-word tokens up front so leading "circuit" /
  // "the" / "number" don't break the parse for "circuit twenty-one" /
  // "the second circuit" / "circuit number two".
  //
  // Pre-2026-04-27 the whole-string parse received the unfiltered tokens
  // and "circuit twenty one" → parseNumberWord('circuit twenty one') →
  // null because the parts.length === 2 check failed. That's the bug
  // P2-B fixes: the JSDoc claimed support for ordinals + compound number
  // patterns that no test ever exercised.
  const allTokens = lowerText.match(/[a-z]+/g) || [];
  const tokens = allTokens.filter((t) => !STOP_WORDS.has(t));
  if (tokens.length === 0) return null;

  // 1) Whole-tokens parse. Handles "twenty one", "twenty-one" (already
  // split by the [a-z]+ regex), and standalone ordinals ("second").
  const whole = parseNumberWord(tokens.join(' '));
  if (whole !== null && whole >= 1 && whole <= 200) {
    return whole;
  }

  // 2) Contiguous TENS+ONES adjacent pairs amid noise tokens. Rejects
  // when there's a non-number residue ("twenty one cookers" → escalate).
  for (let i = 0; i < tokens.length - 1; i++) {
    const compound = parseNumberWord(`${tokens[i]} ${tokens[i + 1]}`);
    if (compound !== null && compound >= 1 && compound <= 200) {
      const otherTokens = tokens.filter((_, idx) => idx !== i && idx !== i + 1);
      const nonNumberOthers = otherTokens.filter((t) => parseNumberWord(t) === null);
      if (nonNumberOthers.length === 0) return compound;
      return null;
    }
  }

  // 3) Single ordinal/cardinal token. ORDINALS already inside parseNumberWord.
  let found = null;
  for (const t of tokens) {
    const n = parseNumberWord(t);
    if (n !== null && n >= 1 && n <= 200) {
      if (found !== null && found !== n) return null;
      found = n;
    }
  }
  if (found !== null) {
    // Reject if a non-number, non-stop residue remains (the user said
    // something more than just a number — likely a designation, not a
    // bare circuit ref). Preserves the same safety check the pre-fix
    // code had at the bottom of this function.
    const nonNumber = tokens.filter((t) => parseNumberWord(t) === null);
    if (nonNumber.length === 0) return found;
    return null;
  }
  return null;
}

/**
 * Build a write object from a pending_write template + a resolved circuit.
 *
 * The resolved write inherits {tool, field, value, confidence, source_turn_id}
 * from the pending_write and adds the circuit_ref. record_board_reading
 * writes ignore the circuit (it's a no-op for them). The caller dispatches.
 *
 * @param {object} pendingWrite
 * @param {number} circuitRef
 * @param {string|null} [contextBoardId]  board the ask is scoped to
 *   (readback-correction-optionb §3.3/§6). Stamped onto the resolved write
 *   so a sub-board circuit-resolution lands on the right board. A board_id
 *   already on the pendingWrite (rare) wins; otherwise the ask's
 *   context_board_id is used. Omitted from the write when both are null.
 * @returns {object}
 */
function buildWrite(pendingWrite, circuitRef, contextBoardId = null) {
  const boardId = pendingWrite.board_id ?? contextBoardId ?? null;
  return {
    tool: pendingWrite.tool,
    field: pendingWrite.field,
    circuit: circuitRef,
    value: pendingWrite.value,
    confidence: pendingWrite.confidence ?? 0.95,
    source_turn_id: pendingWrite.source_turn_id ?? null,
    ...(boardId != null ? { board_id: boardId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Value-resolve (2026-04-28) — bug-J fix
// ---------------------------------------------------------------------------
//
// Symmetric to the circuit-resolver above, but for the OPPOSITE missing piece.
// When Sonnet asks "what is the R1 reading for kitchen sockets?" it carries
// `context_field=ring_r1_ohm`, `context_circuit=6` — the model has the
// schedule entry, the field, just needs a value. Pre-fix, the dispatcher
// returned `{answered: true, untrusted_user_text: "0.47"}` to Sonnet and
// expected the model to follow up with a `record_reading`. In session
// 08469BFC the model just *verbally* acknowledged ("Got it, zero point four
// seven") and never emitted the write — six readings lost in a row.
//
// The value-resolve pulls the same trick as the circuit-resolver: deterministic
// matcher first, escalate when ambiguous. Legitimate reply shapes:
//
//   - bare numeric ("0.47", "naught point four seven" — already normalised)
//   - "is 0.47" / "the value is 0.47"
//   - corrected ("0.7 no 0.47" — take the LAST numeric, lower confidence)
//   - sentinel ("LIM" / "OL" / "infinity" / "discontinuous" — emit ∞ when on
//     a continuity field; escalate when on a non-continuity field)
//   - cancel ("skip", "never mind") — same set as the circuit resolver
//
// Anything more complex (multiple distinct numerics for ONE field, free-form
// sentences) escalates back to Sonnet with a parsed_hint. Conservative-by-
// default — misrouting a number is a worse failure than one extra turn.

const NUMERIC_PATTERN = /-?\d+(?:\.\d+)?/g;
const DISCONTINUOUS_PHRASES = [
  'discontinuous',
  'disconnected',
  'open circuit',
  'open',
  'infinity',
  'infinite',
  'overload',
  'over load',
  'ol',
];
// Continuity field set — the only fields on which a discontinuous/open reply
// maps to ∞, and on which a "limitation" reply maps to the "LIM" sentinel.
const CONTINUITY_FIELDS = ['r1_r2_ohm', 'r2_ohm', 'ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm'];
// "LIM" (limitation) is a STRING sentinel, NOT infinity. The inspector's
// "limitation" can be garbled by Deepgram as lim/limb/limp/limit(ation|ed)/
// lynn/lym. This MUST stay word-boundaried and consistent with the rest of the
// codebase (record-reading-coercion.js IR_LIM_RE, value-normalise.js) — field
// report 2026-06-24 #2: the inspector said "Limb." and a substring
// `"limb".includes("lim")` here wrote ring_r1_ohm = ∞ (silent data corruption,
// deduped on TTS). On a continuity field "limitation" writes the string "LIM";
// ∞ requires an explicit discontinuous/open/infinity phrase below.
const LIM_RE = /\b(?:lim|limb|limp|limit(?:ation|ed)?|lynn|lym)\b/i;
// Build a \b-anchored matcher for the discontinuous phrases so a token like
// "ol"/"open" never bites mid-word (e.g. "old", "opening"). Multi-word phrases
// ("open circuit") are matched verbatim with word boundaries on each end.
const DISCONTINUOUS_RE = new RegExp(
  `\\b(?:${DISCONTINUOUS_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

/**
 * Resolve a value-disambiguation ask_user reply against the asked field +
 * circuit. Pure function — no side effects.
 *
 * Possible verdicts:
 *
 *   { kind: 'auto_resolve', writes: [{tool, field, circuit, value, confidence, source_turn_id}] }
 *   { kind: 'cancel' }
 *   { kind: 'escalate', parsed_hint: string }
 *   { kind: 'no_value_context' }   — caller falls through to circuit-resolver / legacy body
 *
 * @param {object} args
 * @param {string} args.userText                  the inspector's reply
 * @param {string|null} args.contextField         circuit_fields key, or null/sentinel
 * @param {number|null} args.contextCircuit       circuit_ref for single-circuit asks, or null when contextCircuits is set
 * @param {number[]|null} args.contextCircuits    list of circuit_refs (length >= 2) for multi-circuit asks; resolver fans the write out across each circuit
 * @param {string|null} args.sourceTurnId         turn id for source_turn_id stamp
 * @param {string|null} args.contextBoardId       board the ask is scoped to (readback-correction-optionb §3.3/§6); stamped onto each resolved record_reading so a sub-board correction lands on the right board. Omitted from the write when null (back-compat).
 */
export function resolveValueAnswer({
  userText,
  contextField,
  contextCircuit,
  contextCircuits,
  sourceTurnId,
  contextBoardId = null,
}) {
  // Need both pieces to value-resolve. Sentinel field names (`none`,
  // `observation_clarify`) are not real fields — fall through.
  if (!contextField || contextField === 'none' || contextField === 'observation_clarify') {
    return { kind: 'no_value_context' };
  }
  // Accept either single contextCircuit OR multi contextCircuits.
  // Multi asks (e.g. "Zs for circuits 5 and 6") fan out the same write
  // across each circuit. Plural branch requires length >= 2 to match the
  // schema's minItems:2 (stage6-tool-schemas.js context_circuits).
  // Session C0C21546 2026-06-04 turn-12 repro: pre-fix, ask with
  // context_circuit:null + context_circuits:[2,3] hit the old guard and
  // user's reply silently dropped (Sonnet emitted no record_reading).
  const circuitList =
    Array.isArray(contextCircuits) && contextCircuits.length >= 2
      ? contextCircuits
      : Number.isInteger(contextCircuit)
        ? [contextCircuit]
        : null;
  if (!circuitList) {
    return { kind: 'no_value_context' };
  }
  // Multi-circuit fan-out is meaningless for a board/supply/installation
  // field. Bail out so the legacy free-text body can let Sonnet re-ask
  // with the correct field semantics.
  if (NON_CIRCUIT_CONTEXT_FIELDS.has(contextField) && circuitList.length > 1) {
    return { kind: 'no_value_context' };
  }
  // Fan-out helper — preserves each call site's existing confidence
  // value (no default). Source-turn stamp shared across all writes.
  const buildWrites = (value, confidence) =>
    circuitList.map((circuit) => ({
      tool: 'record_reading',
      field: contextField,
      circuit,
      value,
      confidence,
      source_turn_id: sourceTurnId ?? null,
      // readback-correction-optionb §3.3/§6 — carry the ask's board scope so
      // a sub-board correction overwrites the correct board. Omitted when
      // null so single-board writes stay byte-identical.
      ...(contextBoardId != null ? { board_id: contextBoardId } : {}),
    }));
  const text = String(userText ?? '').trim();
  if (!text) {
    return { kind: 'escalate', parsed_hint: 'empty_reply' };
  }
  const lower = text.toLowerCase();
  const stripped = stripPunct(lower);

  // Cancel — same phrase set as the circuit resolver.
  if (CANCEL_PHRASES.includes(stripped)) {
    return { kind: 'cancel' };
  }

  // "Limitation" sentinel (word-boundaried) — a continuity "limitation" reply
  // writes the STRING "LIM", never ∞ and never a silent drop. Checked BEFORE
  // the discontinuous branch so "limb"/"lim" can no longer fall through to ∞.
  // Field report 2026-06-24 #2: "Limb." silently wrote ring_r1_ohm = ∞.
  if (LIM_RE.test(lower)) {
    if (CONTINUITY_FIELDS.includes(contextField)) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites('LIM', 0.9),
      };
    }
    return {
      kind: 'escalate',
      parsed_hint: 'lim_on_non_continuity_field',
    };
  }

  // Discontinuous / open-circuit sentinel — emit ∞ per the prompt contract
  // (line 58 of sonnet_agentic_system.md). Only valid for ring continuity /
  // r2 / r1+r2 fields; others escalate. Word-boundaried (DISCONTINUOUS_RE) so
  // "ol"/"open" never bite mid-word.
  if (DISCONTINUOUS_RE.test(lower)) {
    if (CONTINUITY_FIELDS.includes(contextField)) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites('∞', 0.9),
      };
    }
    return {
      kind: 'escalate',
      parsed_hint: 'discontinuous_on_non_continuity_field',
    };
  }

  // Numeric extraction — find every numeric in the reply.
  const matches = text.match(NUMERIC_PATTERN);
  if (!matches || matches.length === 0) {
    return { kind: 'escalate', parsed_hint: 'no_numeric_in_reply' };
  }
  // De-dup consecutive identicals ("0.47 0.47" → ["0.47"]). Distinct
  // numerics across the reply are NOT collapsed — that's an over-spec for a
  // single-field ask and we'd rather escalate.
  const distinctNumerics = [];
  for (const m of matches) {
    if (distinctNumerics[distinctNumerics.length - 1] !== m) {
      distinctNumerics.push(m);
    }
  }
  if (distinctNumerics.length > 1) {
    // "0.7 no 0.47" / "actually 0.47" — correction marker between
    // numerics → take the last. Anything else escalates.
    const correctionMarker = /\b(no|not|actually|sorry|wait|cancel that|i meant|scratch that)\b/i;
    if (correctionMarker.test(text)) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites(distinctNumerics[distinctNumerics.length - 1], 0.85),
      };
    }
    return {
      kind: 'escalate',
      parsed_hint: `multiple_numerics:${distinctNumerics.join(',')}`,
    };
  }

  // Single numeric — write it.
  return {
    kind: 'auto_resolve',
    writes: buildWrites(distinctNumerics[0], 0.9),
  };
}

// ---------------------------------------------------------------------------
// Board-id resolve (2026-05-09) — add-board hotfix from sessions 7113A114 +
// 399E69A7
// ---------------------------------------------------------------------------
//
// `feeds_board_id` and `parent_board_id` are board-reference fields whose
// valid values are the literal ids of existing boards on the snapshot
// (`main`, `sub-1`, or any UUID iOS supplied via jobState.boards[]). When
// Sonnet emits an ask_user with one of these as `context_field`, the user's
// reply is almost always one of:
//
//   - the main keyword:      "main", "the main", "main board", "the main board"
//   - an affirmative reply:  "yes", "yes it is", "it is", "that's right",
//                            "correct", "yeah" — only meaningful when the
//                            ask was phrased as "...is it the main board?"
//                            (single-main-board jobs).
//   - a board designation:   "DB-1", "Garage", "the garage CU"
//   - a literal id:          "main", "sub-1", "C58D2373-…"
//   - cancel:                "skip", "never mind"
//
// Pre-fix the value-resolver was the only resolver to fire — it looked for
// numerics, found none, and escalated with parsed_hint=no_numeric_in_reply.
// Sonnet then re-asked, the user gave the same answer, infinite loop.
//
// `resolveBoardIdAnswer` is a PURE matcher — given the user's text, the
// context field, and the boards[] array (all data, no I/O), it returns one
// of:
//
//   { kind: 'auto_resolve', resolved_board_id, resolved_via, board }
//     — caller echoes resolved_board_id back to Sonnet via match_status:
//       'board_resolved' so the next turn can call mark_distribution_circuit
//       / add_board with the literal id. resolved_via lets log analysis
//       distinguish keyword vs designation vs id matches.
//
//   { kind: 'cancel' }
//     — user opted out; same shape as the value-resolver cancel branch.
//
//   { kind: 'escalate', parsed_hint, available_boards }
//     — caller falls through to legacy body so Sonnet can interpret the
//       reply in context. available_boards is included so Sonnet can pick
//       in a single retry.
//
//   { kind: 'no_board_context' }
//     — context_field isn't a board-id field; caller proceeds to other
//       resolvers as before.

const BOARD_ID_CONTEXT_FIELDS = new Set(['feeds_board_id', 'parent_board_id']);

// "Yes" affirmatives that, alongside a single-main-board snapshot, mean
// "yes, it's the main board". Conservative: we ONLY auto-resolve these when
// the snapshot has exactly one main candidate, otherwise escalate so the
// model can disambiguate. The alternative (auto-resolving "yes" against
// multi-main snapshots) would silently route to the wrong parent.
const AFFIRMATIVE_PHRASES = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'correct',
  'right',
  'thats right',
  "that's right",
  'it is',
  'yes it is',
  'yes the main',
  'yes the main board',
  'main',
  'the main',
  'main board',
  'the main board',
  'the main one',
  'mains',
  'the mains',
];

// Explicit main-keyword patterns. Subset of AFFIRMATIVE_PHRASES that don't
// need the single-main-board precondition because they NAME the main board
// directly. When the snapshot has exactly one main board, both sets resolve
// identically — but for multi-main snapshots, only this set wins (and even
// then we still need a single main candidate to route confidently).
const MAIN_KEYWORD_PHRASES = new Set([
  'main',
  'the main',
  'main board',
  'the main board',
  'mains',
  'the mains',
  'the main one',
]);

/**
 * Pull the main board out of a boards[] array. Mirrors the resolution order
 * in stage6-multi-board-shape.js#getMainBoardId, but operates on a passed-in
 * array so the resolver stays pure (no snapshot import).
 */
function findMainBoard(boards) {
  if (!Array.isArray(boards)) return null;
  const explicit = boards.find((b) => b && b.board_type === 'main');
  if (explicit) return explicit;
  // Legacy seeds may omit board_type — fall back to "no board_type means main".
  const implicit = boards.find((b) => b && !b.board_type);
  if (implicit) return implicit;
  return null;
}

/**
 * Match a designation against the boards[] array. Same algorithm as
 * `matchDesignation` for circuits: exact (case-insensitive) wins over
 * substring; multiple matches at either level are ambiguous.
 *
 * Normalisation: both sides are reduced to a space-separated alphanumeric
 * residue so "DB-1" matches the cleaned reply "db 1" — the designation
 * cleaner runs the same `[a-z0-9]+` split as `cleanReplyForDesignation`,
 * eliminating hyphen / underscore / case-only mismatches that would
 * otherwise force escalation.
 */
function normaliseDesignation(text) {
  if (typeof text !== 'string') return '';
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.join(' ');
}

function matchBoardDesignation(cleaned, boards) {
  if (!Array.isArray(boards) || boards.length === 0 || !cleaned) {
    return { kind: 'no_match', boards: [] };
  }
  const exact = [];
  const substr = [];
  for (const b of boards) {
    if (!b || typeof b.designation !== 'string') continue;
    const d = normaliseDesignation(b.designation);
    if (!d) continue;
    if (d === cleaned) {
      exact.push(b);
      continue;
    }
    if (d.includes(cleaned) || cleaned.includes(d)) {
      substr.push(b);
    }
  }
  if (exact.length === 1) return { kind: 'exact', boards: exact };
  if (exact.length > 1) return { kind: 'ambiguous', boards: exact };
  if (substr.length === 1) return { kind: 'unique_substring', boards: substr };
  if (substr.length > 1) return { kind: 'ambiguous', boards: substr };
  return { kind: 'no_match', boards: [] };
}

/**
 * Resolve an ask_user reply against the boards[] array on the snapshot.
 *
 * @param {object} args
 * @param {string} args.userText             inspector reply
 * @param {string|null} args.contextField    'feeds_board_id' / 'parent_board_id' / other
 * @param {number|null} args.contextCircuit  carried through but unused for matching
 * @param {Array<object>} args.boards        snapshot.boards[]
 * @returns {object}
 */
export function resolveBoardIdAnswer({ userText, contextField, boards }) {
  if (!BOARD_ID_CONTEXT_FIELDS.has(contextField)) {
    return { kind: 'no_board_context' };
  }
  const text = String(userText ?? '').trim();
  if (!text) {
    return {
      kind: 'escalate',
      parsed_hint: 'empty_reply',
      available_boards: summariseBoards(boards),
    };
  }
  const lower = text.toLowerCase();
  const stripped = stripPunct(lower);

  if (CANCEL_PHRASES.includes(stripped)) {
    return { kind: 'cancel' };
  }

  // 1) Main-keyword match — "main" / "the main" / "main board" etc. Resolves
  //    to the snapshot's main board. Runs BEFORE literal-id walk so a user
  //    saying "main" against a single-main snapshot is logged as
  //    `main_keyword` rather than `literal_id` (the synthetic default
  //    happens to use 'main' as its id; the user typed the keyword, not
  //    the id). Multi-main snapshots escalate here so the model
  //    disambiguates rather than the resolver guessing.
  if (MAIN_KEYWORD_PHRASES.has(stripped)) {
    const main = findMainBoard(boards);
    if (main && typeof main.id === 'string') {
      const mains = (boards ?? []).filter((b) => b && (b.board_type === 'main' || !b.board_type));
      if (mains.length === 1) {
        return {
          kind: 'auto_resolve',
          resolved_board_id: main.id,
          resolved_via: 'main_keyword',
          board: main,
          available_boards: summariseBoards(boards),
        };
      }
      return {
        kind: 'escalate',
        parsed_hint: 'main_keyword_but_multiple_mains',
        available_boards: summariseBoards(boards),
      };
    }
  }

  // 2) Literal id match — UUIDs ("C58D2373-…"), `sub-N`, etc. Runs after
  //    the main-keyword path so a user saying "main" doesn't hit this
  //    branch on a single-main synthetic-id snapshot.
  if (Array.isArray(boards)) {
    const literal = boards.find((b) => {
      if (!b || typeof b.id !== 'string') return false;
      if (b.id === text) return true;
      // Synthetic ids are short ascii; case-insensitive compare is safe.
      // UUIDs are 36 chars with dashes — also case-insensitive per RFC 4122.
      return b.id.toLowerCase() === lower;
    });
    if (literal) {
      return {
        kind: 'auto_resolve',
        resolved_board_id: literal.id,
        resolved_via: 'literal_id',
        board: literal,
        available_boards: summariseBoards(boards),
      };
    }
  }

  // 3) Affirmative reply — only confident with exactly one main board.
  //    Pre-condition: the model phrased the ask as a yes/no on the main
  //    ("Is the parent the main board?") and the user assented. We can't
  //    verify the question shape here, so we use the boards[] as the
  //    proxy: a job with exactly one main has only one valid affirmative
  //    target.
  if (AFFIRMATIVE_PHRASES.includes(stripped)) {
    const mains = Array.isArray(boards)
      ? boards.filter((b) => b && (b.board_type === 'main' || !b.board_type))
      : [];
    if (mains.length === 1 && typeof mains[0].id === 'string') {
      return {
        kind: 'auto_resolve',
        resolved_board_id: mains[0].id,
        resolved_via: 'affirmative_single_main',
        board: mains[0],
        available_boards: summariseBoards(boards),
      };
    }
    // Otherwise escalate — "yes" against a multi-main snapshot is
    // structurally ambiguous.
    return {
      kind: 'escalate',
      parsed_hint: mains.length === 0 ? 'affirmative_no_main_board' : 'affirmative_multiple_mains',
      available_boards: summariseBoards(boards),
    };
  }

  // 4) Designation match. Re-use the cleaned-residue strip from circuit
  //    matching (drops 'circuit', 'the', 'a', stop-words). Two-char floor
  //    matches the circuit resolver — 1-char would substring-hit
  //    everything.
  const cleaned = cleanReplyForDesignation(lower);
  if (cleaned.length >= 2) {
    const match = matchBoardDesignation(cleaned, boards);
    if (match.kind === 'exact' || match.kind === 'unique_substring') {
      return {
        kind: 'auto_resolve',
        resolved_board_id: match.boards[0].id,
        resolved_via: 'designation_match',
        board: match.boards[0],
        available_boards: summariseBoards(boards),
      };
    }
    if (match.kind === 'ambiguous') {
      return {
        kind: 'escalate',
        parsed_hint: `ambiguous_board_designation:${match.boards.map((b) => b.id).join(',')}`,
        available_boards: summariseBoards(boards),
      };
    }
  }

  return {
    kind: 'escalate',
    parsed_hint: 'no_board_match',
    available_boards: summariseBoards(boards),
  };
}

/**
 * Compact representation of boards[] for the available_boards body field.
 * Mirrors the BOARDS: section in buildStateSnapshotMessage so Sonnet sees
 * the same shape on both surfaces.
 */
function summariseBoards(boards) {
  if (!Array.isArray(boards)) return [];
  return boards
    .filter((b) => b && typeof b.id === 'string')
    .map((b) => ({
      id: b.id,
      designation: typeof b.designation === 'string' ? b.designation : null,
      board_type: typeof b.board_type === 'string' ? b.board_type : null,
    }));
}

// ---------------------------------------------------------------------------
// Enum-resolve (2026-05-06) — Bug B fix from session DC946608
// ---------------------------------------------------------------------------
//
// `rcd_bs_en` is a select field with options `["", "61008", "61009", "62423",
// "N/A"]`. When the user dictates "BS 68001" (a typo / mishearing for
// "61008"), the value-resolver above happily extracts the digit "68001"
// and would write it verbatim — but the field schema rejects unknown
// option values, so the write was silently dropped and the same question
// was re-asked. The transcript log of session DC946608 shows three
// identical "What's the BS number?" prompts in 11 seconds.
//
// `resolveEnumAnswer` runs BEFORE `resolveValueAnswer` for select fields:
//   - extracts a 5-digit run from the reply (handles "BS 61008", "61008",
//     "sixty-one zero zero eight" once normalised by upstream NumberNormaliser)
//   - exact-matches against the option list → `auto_resolve`
//   - single-digit-different from a valid option → `did_you_mean`
//     (Sonnet speaks the suggestion: "BS 68001 isn't standard — did you
//     mean 61008?")
//   - otherwise → `invalid_value` with the full option list
//
// Both `did_you_mean` and `invalid_value` carry the structured reason in
// the dispatcher's tool_result body so the prompt's re-ask-once rule can
// fire deterministically (Sonnet retries once with options spoken aloud,
// then writes the empty value and moves on rather than looping).
//
// Conservative-by-default: N/A and the empty option resolve to canonical
// "N/A" / "". A reply with no digits and no N/A signal escalates to the
// legacy free-text body so Sonnet can interpret unusual phrasing.

// Bare-string options that should auto-resolve to N/A. Order matters only
// for log readability — match is case-insensitive substring.
//
// Generalised across BS-EN field families (rcd / ocpd / spd) so a single
// matcher serves all of them. "no rcd" stays in the list because it's a
// natural inspector phrase even when the field being asked about isn't
// rcd_bs_en — a permissive synonym is cheaper than a per-field overlay.
const NA_PHRASES = [
  'n/a',
  'na',
  'not applicable',
  'none',
  'no rcd',
  'no rcd fitted',
  'no ocpd',
  'no spd',
];

/**
 * Levenshtein distance between two strings (substitution / insertion /
 * deletion all cost 1). Standard O(m*n) DP. Used for "did you mean"
 * suggestions on BS-EN codes — accepts typo distance up to a caller-set
 * threshold (currently 1).
 *
 * Replaces the earlier `singleDigitDiff` (equal-length only). With
 * insertions/deletions in scope:
 *   - "6100"   matches "61008" at distance 1 (deletion)
 *   - "610008" matches "61008" at distance 1 (insertion)
 *   - "61018"  matches "61008" at distance 1 (substitution — already
 *              caught by the old equal-length helper)
 *
 * Early exits keep this fast for short codes (the common case is
 * comparing a 4-7 char digit run against ~5 options).
 */
function levenshteinDistance(a, b) {
  if (typeof a !== 'string') a = String(a ?? '');
  if (typeof b !== 'string') b = String(b ?? '');
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Length-difference lower bound — distance can never be less than the
  // absolute length difference. Cheap early-exit for callers that only
  // care about distance <= K.
  if (Math.abs(m - n) > Math.max(m, n)) return Math.max(m, n);
  // Two-row DP (rolling) — O(min(m,n)) memory.
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost // substitution / match
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Strip everything except digits. Used to compare a user-spoken BS-EN
 * candidate ("BS 88-2", "61008", "60898") against the field-schema
 * option list (which stores values like "BS EN 60898", "BS EN 60269-2",
 * "BS 3036") post-2026-05-06 alignment. Comparing on the digit form
 * lets dictation match regardless of prefix or suffix shape:
 *   - "BS 88-2" → "882"     matches option "BS EN 60269-2" digit form? No
 *                            (Lev distance > 1) → invalid; the parseBsCode
 *                            layer is what folds 88-2 → 60269-2 BEFORE
 *                            this resolver runs.
 *   - "60898"   → "60898"   matches option "BS EN 60898" → "60898" (exact)
 *   - "61008"   → "61008"   matches option "BS EN 61008" → "61008" (exact)
 *   - "60898-1" → "608981"  matches option "BS EN 60898" → "60898"  (Lev-1
 *                            deletion → did_you_mean ["BS EN 60898"])
 *
 * The hyphen drop is deliberate so a user dictating "60947-2" matches
 * the option "BS EN 60947-2" exactly on the digit form ("609472").
 */
function normaliseBsEnDigits(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\D/g, '');
}

/**
 * Resolve a select-typed ask_user reply against the asked field's option list.
 * Returns one of:
 *
 *   { kind: 'auto_resolve', writes: [{tool, field, circuit, value, confidence, source_turn_id}] }
 *   { kind: 'did_you_mean', received, suggestions: [...], valid_options: [...] }
 *   { kind: 'invalid_value', received, valid_options: [...] }
 *   { kind: 'no_value_context' }   — fall through (field not select, no options, etc.)
 *
 * Pure function — no side effects, no I/O. Caller (dispatcher) decides
 * how to surface each verdict in the tool_result body.
 *
 * @param {object} args
 * @param {string} args.userText
 * @param {string|null} args.contextField     circuit_fields key
 * @param {number|null} args.contextCircuit   circuit_ref for single-circuit asks, or null when contextCircuits is set
 * @param {number[]|null} args.contextCircuits list of circuit_refs (length >= 2) for multi-circuit asks; resolver fans the write out across each circuit
 * @param {string|null} args.sourceTurnId
 * @param {object} args.fieldSchema           loaded field_schema.json (or its circuit_fields slice)
 */
export function resolveEnumAnswer({
  userText,
  contextField,
  contextCircuit,
  contextCircuits,
  sourceTurnId,
  fieldSchema,
  contextBoardId = null,
}) {
  // Accept either single contextCircuit OR multi contextCircuits.
  // Multi asks (e.g. "wiring type for circuits 2 and 3") fan out the
  // same write across each circuit. Plural branch requires length >= 2
  // to match the schema's minItems:2 (stage6-tool-schemas.js
  // context_circuits). Single-element arrays fall back to single-circuit
  // semantics only via contextCircuit. Session C0C21546 2026-06-04
  // turn-12 repro: pre-fix, ask with context_circuit:null +
  // context_circuits:[2,3] hit the old guard and user's "A." reply
  // silently dropped (Sonnet emitted no record_reading).
  const circuitList =
    Array.isArray(contextCircuits) && contextCircuits.length >= 2
      ? contextCircuits
      : Number.isInteger(contextCircuit)
        ? [contextCircuit]
        : null;
  if (!contextField || !circuitList) {
    return { kind: 'no_value_context' };
  }
  // Multi-circuit fan-out is meaningless for a board/supply/installation
  // field. Bail out so the legacy free-text body can let Sonnet re-ask
  // with the correct field semantics.
  if (NON_CIRCUIT_CONTEXT_FIELDS.has(contextField) && circuitList.length > 1) {
    return { kind: 'no_value_context' };
  }
  // Look up the field. Accept either the full schema object (with
  // circuit_fields key) or the circuit_fields slice directly.
  const fields = fieldSchema?.circuit_fields ?? fieldSchema ?? null;
  const field = fields ? fields[contextField] : null;
  if (!field || field.type !== 'select' || !Array.isArray(field.options)) {
    return { kind: 'no_value_context' };
  }
  // Filter the empty-string and N/A out of the matchable list — those are
  // semantic exits, not user-dictated values.
  const matchableOptions = field.options.filter((o) => o && o !== 'N/A');
  if (matchableOptions.length === 0) {
    return { kind: 'no_value_context' };
  }
  // Fan-out helper — preserves each call site's existing confidence
  // value (no default). Source-turn stamp shared across all writes.
  const buildWrites = (value, confidence) =>
    circuitList.map((circuit) => ({
      tool: 'record_reading',
      field: contextField,
      circuit,
      value,
      confidence,
      source_turn_id: sourceTurnId ?? null,
      // readback-correction-optionb §3.3/§6 — carry the ask's board scope so
      // a sub-board correction overwrites the correct board. Omitted when
      // null so single-board writes stay byte-identical.
      ...(contextBoardId != null ? { board_id: contextBoardId } : {}),
    }));
  const text = String(userText ?? '').trim();
  if (!text) {
    return {
      kind: 'invalid_value',
      received: '',
      valid_options: field.options,
    };
  }
  const lower = text.toLowerCase();

  // N/A short-circuit. Any of NA_PHRASES as a contained whole-word match.
  const naMatch = NA_PHRASES.some((p) =>
    new RegExp(`\\b${p.replace(/\//g, '\\/')}\\b`).test(lower)
  );
  if (naMatch && field.options.includes('N/A')) {
    return {
      kind: 'auto_resolve',
      writes: buildWrites('N/A', 0.95),
    };
  }

  // Word-anchored enum match: select fields whose options ALL contain no
  // digits AND that are explicitly enrolled in the word-anchored
  // matcher. The allowlist keeps polarity_confirmed (Y/N/OK with
  // coercion at record-reading-coercion.js) and any future implicit-
  // coercion field OUT of this path. To enrol a new field, add it
  // here and verify (a) the schema options are all letter-coded and
  // (b) no coercion table maps spoken aliases to canonical values.
  //
  // Predicate is `every` (NOT `some`) so the branch is mutually
  // exclusive with the existing `if (!anyDigitOption) return
  // no_value_context` guard below.
  //
  // Matcher: normaliseEnumToken trims, lowercases, and strips ONLY
  // trailing sentence punctuation (.,!?) — preserves schema-significant
  // characters like '+' (rcd_type "B+") and internal '-' (rcd_type "A-S")
  // so "B+" cannot collide with "B".
  //
  // Session C0C21546 2026-06-04 turn-12 repro: wiring_type, user said
  // "A.", was silently dropped pre-fix.
  const WORD_ANCHORED_ENUM_FIELDS = new Set(['wiring_type', 'rcd_type', 'ocpd_type']);
  const allWordAnchoredOptions = matchableOptions.every((o) => !/\d/.test(String(o)));
  if (allWordAnchoredOptions && WORD_ANCHORED_ENUM_FIELDS.has(contextField)) {
    const normaliseEnumToken = (s) =>
      String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/[.,!?]+$/g, '');
    const normalisedReply = normaliseEnumToken(text);
    const exact = matchableOptions.find((o) => normaliseEnumToken(o) === normalisedReply);
    if (exact) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites(exact, 0.9),
      };
    }
    // No match against a word-anchored option set → invalid_value with
    // the unfiltered field.options list (N/A included) so Sonnet sees
    // the same option-list shape it sees from the digit-anchored
    // invalid_value path below.
    return {
      kind: 'invalid_value',
      received: text,
      valid_options: field.options,
    };
  }

  // Word-anchored enums (e.g. rcd_type AC|A|F|B) have no digits in any
  // option — fall through so the legacy free-text body runs. The matcher
  // below is scoped to digit-anchored enums (BS-EN families).
  const anyDigitOption = matchableOptions.some((o) => /\d/.test(o));
  if (!anyDigitOption) {
    return { kind: 'no_value_context' };
  }

  // Extract a digit-anchored candidate from the user's reply. Pattern
  // matches a digit run with optional internal hyphens — handles
  // "BS 60898" → "60898", "BS 88-2" → "88-2", "60947-3" → "60947-3".
  // The trailing alternation `|\d+` is a fallback for cases where the
  // first token is just digits with no hyphen.
  const digitMatch = text.match(/\d[\d-]*\d|\d+/);
  if (!digitMatch) {
    return {
      kind: 'invalid_value',
      received: text,
      valid_options: field.options,
    };
  }
  const candidate = digitMatch[0];
  const candidateDigits = normaliseBsEnDigits(candidate);

  // Exact match against any option (compared on the digit form so
  // user-spoken "60898" matches option "60898" and user-spoken "88-2"
  // matches option "88-2"). Preserve the original option string for
  // the write — it's the canonical wire / PDF / iOS-picker value.
  for (const opt of matchableOptions) {
    if (normaliseBsEnDigits(opt) === candidateDigits) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites(opt, 0.95),
      };
    }
  }

  // Levenshtein-1 suggestions across the whole digit form. Catches
  // substitution typos ("61018" → "61008"), deletions ("6100" → "61008")
  // and insertions ("610008" → "61008"). Equal-length-only was the
  // earlier behaviour (`singleDigitDiff`); the broader Levenshtein
  // covers Deepgram drift patterns the equal-length check missed.
  const suggestions = matchableOptions.filter(
    (opt) => levenshteinDistance(candidateDigits, normaliseBsEnDigits(opt)) === 1
  );
  if (suggestions.length > 0) {
    return {
      kind: 'did_you_mean',
      received: candidate,
      suggestions,
      valid_options: field.options,
    };
  }
  return {
    kind: 'invalid_value',
    received: candidate,
    valid_options: field.options,
  };
}
