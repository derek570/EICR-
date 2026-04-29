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
      return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, 0)] };
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
  'lim',
];

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
 * @param {number|null} args.contextCircuit       circuit_ref, or null
 * @param {string|null} args.sourceTurnId         turn id for source_turn_id stamp
 */
export function resolveValueAnswer({ userText, contextField, contextCircuit, sourceTurnId }) {
  // Need both pieces to value-resolve. Sentinel field names (`none`,
  // `observation_clarify`) are not real fields — fall through.
  if (
    !contextField ||
    contextField === 'none' ||
    contextField === 'observation_clarify' ||
    contextCircuit === null ||
    contextCircuit === undefined
  ) {
    return { kind: 'no_value_context' };
  }
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

  // Discontinuous / open-circuit sentinel — emit ∞ per the prompt contract
  // (line 58 of sonnet_agentic_system.md). Only valid for ring continuity /
  // r2 / r1+r2 fields; others escalate.
  for (const phrase of DISCONTINUOUS_PHRASES) {
    if (lower.includes(phrase)) {
      const continuityFields = ['r1_r2_ohm', 'r2_ohm', 'ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm'];
      if (continuityFields.includes(contextField)) {
        return {
          kind: 'auto_resolve',
          writes: [
            {
              tool: 'record_reading',
              field: contextField,
              circuit: contextCircuit,
              value: '∞',
              confidence: 0.9,
              source_turn_id: sourceTurnId ?? null,
            },
          ],
        };
      }
      return {
        kind: 'escalate',
        parsed_hint: 'discontinuous_on_non_continuity_field',
      };
    }
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
        writes: [
          {
            tool: 'record_reading',
            field: contextField,
            circuit: contextCircuit,
            value: distinctNumerics[distinctNumerics.length - 1],
            confidence: 0.85,
            source_turn_id: sourceTurnId ?? null,
          },
        ],
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
    writes: [
      {
        tool: 'record_reading',
        field: contextField,
        circuit: contextCircuit,
        value: distinctNumerics[0],
        confidence: 0.9,
        source_turn_id: sourceTurnId ?? null,
      },
    ],
  };
}
