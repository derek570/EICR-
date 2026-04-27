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

import { isEvasionMarker, isValidSentinel } from './value-normalise.js';

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
  'one', // dropped only when paired with a designation (handled by structural check)
  'please',
  'yeah',
  'yep',
  'yes',
  'um',
  'uh',
  'er',
]);

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
 * @returns {{kind: string, writes?: Array, parsed_hint?: string, available_circuits?: Array}}
 */
export function resolveCircuitAnswer({ userText, pendingWrite, availableCircuits }) {
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

  // Cancel — short-circuit before anything else.
  if (CANCEL_PHRASES.includes(lower) || CANCEL_PHRASES.some((p) => lower === p)) {
    return { kind: 'cancel' };
  }

  // Broadcast — expand pending_write into one write per circuit.
  if (BROADCAST_PHRASES.includes(lower)) {
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
        return buildWrite(pendingWrite, ref);
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
    return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, numericRef)] };
  }

  // Designation match. Require the cleaned residue to be at least 3 chars —
  // single-letter substrings produce noisy matches (a stray "n" or "a" lights
  // up almost any designation). 3 chars filters those without sacrificing
  // legitimate short designations like "hob" or "ev".
  const cleaned = cleanReplyForDesignation(lower);
  if (cleaned.length < 3) {
    return {
      kind: 'escalate',
      parsed_hint: 'reply_too_short_for_designation_match',
      available_circuits: availableCircuits ?? [],
    };
  }
  const match = matchDesignation(cleaned, availableCircuits ?? []);
  if (match.kind === 'exact' || match.kind === 'unique_substring') {
    return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, match.circuitRefs[0])] };
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
function extractCircuitRef(lowerText) {
  // Strict digit match: a single integer 1..200, optionally preceded by
  // "circuit" / "circuit number". Reject decimals.
  const digit = lowerText.match(/(?:^|[^\d.])(\d{1,3})(?![\d.])/);
  if (digit) {
    const n = Number.parseInt(digit[1], 10);
    if (n >= 1 && n <= 200) {
      // Make sure there's only ONE numeric token. Multiple → escalate.
      const allNums = lowerText.match(/\d+/g) || [];
      if (allNums.length === 1) return n;
      return null;
    }
  }

  // Word number: try to extract a single word-number.
  const tokens = lowerText.match(/[a-z]+/g) || [];
  if (tokens.length === 0) return null;
  // Try whole-string parse first ("twenty one").
  const whole = parseNumberWord(tokens.join(' '));
  if (whole !== null && whole >= 1 && whole <= 200) {
    // Reject if the original reply had non-number tokens beyond stop words.
    const nonNumberTokens = tokens.filter((t) => !STOP_WORDS.has(t) && parseNumberWord(t) === null);
    if (nonNumberTokens.length === 0) return whole;
    return null;
  }
  // Try single tokens.
  let found = null;
  for (const t of tokens) {
    const n = parseNumberWord(t);
    if (n !== null && n >= 1 && n <= 200) {
      if (found !== null && found !== n) return null;
      found = n;
    }
  }
  if (found !== null) {
    // Ensure the rest of the tokens are just stop words ("circuit", "the", ...)
    const nonStop = tokens.filter((t) => !STOP_WORDS.has(t) && parseNumberWord(t) === null);
    if (nonStop.length === 0) return found;
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
 * @returns {object}
 */
function buildWrite(pendingWrite, circuitRef) {
  return {
    tool: pendingWrite.tool,
    field: pendingWrite.field,
    circuit: circuitRef,
    value: pendingWrite.value,
    confidence: pendingWrite.confidence ?? 0.95,
    source_turn_id: pendingWrite.source_turn_id ?? null,
  };
}
