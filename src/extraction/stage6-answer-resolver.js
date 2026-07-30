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
import { NUMERIC_READING_FIELDS, canonicaliseNumericReadingField } from './value-enum-validator.js';

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
 * Parse a CARDINAL count for an attached plural quantifier.
 *
 * Deliberately excludes ORDINALS. "The second circuit" is a shipped scalar
 * circuit-reference reply, not a request to fan a value out across two
 * circuits. Reusing parseNumberWord here would therefore steal that reply
 * from the legacy scalar path before extractCircuitRef can resolve it.
 *
 * @param {string} word
 * @returns {number|null}
 */
function parseCardinalQuantifier(word) {
  const w = String(word ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, ' ');
  if (!w) return null;
  if (Object.prototype.hasOwnProperty.call(ONES, w)) return ONES[w];
  if (Object.prototype.hasOwnProperty.call(TENS, w)) return TENS[w];
  const parts = w.split(' ');
  if (
    parts.length === 2 &&
    Object.prototype.hasOwnProperty.call(TENS, parts[0]) &&
    Number.isInteger(ONES[parts[1]]) &&
    ONES[parts[1]] >= 1 &&
    ONES[parts[1]] <= 9
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
 * @returns {{kind: 'exact'|'unique_substring'|'fuzzy'|'ambiguous'|'no_match', circuitRefs: number[]}}
 */
// §C1 (field-feedback-2026-07-14) — normalise a designation token stream for
// the fuzzy pass: lowercase (already), then singularise trailing plurals so
// "upstairs light" matches "Upstairs Lights". Deliberately crude (strip one
// trailing 's' per word, keep 'ss' words like "glass") — designations are
// short noun phrases, not prose.
function normaliseDesignationForFuzzy(text) {
  return String(text ?? '')
    .split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ')
    .trim();
}

// §C1 — length-aware Levenshtein budget. A flat <=2 is NOT conservative for
// short designations, and <=1 at length <=4 still cross-matches EV<->EM — so:
// distance 0 (exact after normalisation) for normalised length <= 3;
// distance <= 1 for length 4; distance <= 2 only above 4. Decided by Derek
// 2026-07-14 (Q1: "prompt + conservative fuzzy matcher").
function fuzzyBudgetForLength(len) {
  if (len <= 3) return 0;
  if (len === 4) return 1;
  return 2;
}

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

  // §C1 (field-feedback-2026-07-14, F4-class + "ref method 101" C61473FD) —
  // CONSERVATIVE fuzzy pass, exact+substring having both missed. Runs ONLY in
  // the ask-ANSWER resolution path (this function is never consulted on the
  // primary transcript→record_reading route — F4's primary-turn defence is
  // the prompt rule + the exactly-once read-back). Normalise case/plurals
  // FIRST, then length-aware Levenshtein with a strict best-match margin:
  // the second-best must be STRICTLY worse, tie or margin-fail → no_match
  // (never guess between near-equals). Phonetic garbles ("auto feature" →
  // "water heater") stay deterministically unresolvable and fall to the ask.
  // Scope note: circuit designations ONLY — select_board board designations
  // stay id-only (the deferred-fuzzy comment at stage6-tool-schemas.js
  // ~:1025 is NOT flipped by this).
  const replyNorm = normaliseDesignationForFuzzy(lc);
  if (replyNorm) {
    const budget = fuzzyBudgetForLength(replyNorm.length);
    let best = null; // {ref, dist}
    let secondBestDist = Infinity;
    for (const c of circuits) {
      const desig = (c.circuit_designation ?? c.designation ?? '').toLowerCase().trim();
      if (!desig) continue;
      const ref =
        typeof c.circuit_ref === 'number'
          ? c.circuit_ref
          : Number.parseInt(String(c.circuit_ref), 10);
      if (!Number.isFinite(ref)) continue;
      const desigNorm = normaliseDesignationForFuzzy(desig);
      if (!desigNorm) continue;
      // Both sides constrain the budget — matching a 2-char reply against a
      // 20-char designation at distance 2 is meaningless; use the SHORTER
      // normalised length so short labels (EV/EM/AC) always demand exactness.
      const pairBudget = fuzzyBudgetForLength(Math.min(replyNorm.length, desigNorm.length));
      const dist = levenshteinDistance(replyNorm, desigNorm);
      if (dist > pairBudget) continue;
      if (best === null || dist < best.dist) {
        secondBestDist = best ? best.dist : Infinity;
        best = { ref, dist };
      } else {
        secondBestDist = Math.min(secondBestDist, dist);
      }
    }
    if (best && best.dist < secondBestDist) {
      return { kind: 'fuzzy', circuitRefs: [best.ref] };
    }
  }
  return { kind: 'no_match', circuitRefs: [] };
}

/**
 * Match a QUANTIFIED multi-description span against the union of exact and
 * substring designation refs. The scalar matcher above deliberately gives an
 * exact hit precedence, but that would under-count "all lighting circuits"
 * when the census contains both "Lighting" and "Emergency lighting".
 *
 * This helper is multi-only. With no exact/substring candidates it delegates
 * to the scalar matcher so the existing conservative fuzzy/no-match verdicts
 * remain available (and fuzzy still fails closed before fan-out).
 */
function matchQuantifiedDesignations(spokenSpan, circuits) {
  const cleaned = cleanReplyForDesignation(spokenSpan);
  if (!cleaned || !Array.isArray(circuits) || circuits.length === 0) {
    return { kind: 'no_match', circuitRefs: [] };
  }
  const canonicalSpoken = canonicalSeparatorDesignation(spokenSpan);
  const spokenHasSeparator = hasEnumeratedSeparator(spokenSpan);
  const exact = [];
  const substring = [];
  for (const circuit of circuits) {
    const designation = (circuit?.circuit_designation ?? circuit?.designation ?? '')
      .toLowerCase()
      .trim();
    if (!designation) continue;
    const canonicalDesignation = canonicalSeparatorDesignation(designation);
    const ref =
      typeof circuit?.circuit_ref === 'number'
        ? circuit.circuit_ref
        : Number.parseInt(String(circuit?.circuit_ref), 10);
    if (!Number.isInteger(ref)) continue;
    if (canonicalDesignation === canonicalSpoken) {
      exact.push(ref);
    } else if (
      canonicalDesignation.includes(canonicalSpoken) ||
      canonicalSpoken.includes(canonicalDesignation)
    ) {
      // A separator-bearing designation is one server-owned target, not a
      // bag of independently claimable components. Let its raw/exact whole
      // form win in the whole-designation pass, but do not let a quantified
      // component such as "2 lighting circuits" silently claim
      // "Lighting and Smoke Alarm" merely because it contains "lighting".
      const designationIsComposite = hasEnumeratedSeparator(designation);
      if (designationIsComposite && !spokenHasSeparator) continue;
      substring.push(ref);
    }
  }
  const circuitRefs = [...new Set([...exact, ...substring])].sort((a, b) => a - b);
  if (circuitRefs.length > 1) return { kind: 'ambiguous', circuitRefs };
  if (circuitRefs.length === 1) {
    return {
      kind: exact.includes(circuitRefs[0]) ? 'exact' : 'unique_substring',
      circuitRefs,
    };
  }
  // Only borrow the scalar matcher's conservative FUZZY verdict. An
  // exact/substring/ambiguous result here was deliberately excluded by the
  // canonical loop above (most importantly, a bare component must not reclaim
  // a separator-bearing composite designation through this fallback).
  const fallback = matchDesignation(cleaned, circuits);
  return fallback.kind === 'fuzzy' ? fallback : { kind: 'no_match', circuitRefs: [] };
}

// ---------------------------------------------------------------------------
// PLAN-2B §3.3 — multi-description segmentation
// ---------------------------------------------------------------------------
//
// A reply such as "2 lighting circuits and the smoke alarm" used to enter the
// scalar-number path below first. `extractCircuitRef()` saw the leading 2 and
// the resolver silently discarded the rest of the answer, so only circuit 2
// received the buffered reading. The helpers in this section run ONLY when
// the reply carries multi-target syntax. Single-target replies keep the
// pre-2B path and result shape byte-for-byte.

const ENUMERATED_SEPARATOR_RE = /,|&|\+|\band\b|\bplus\b/gi;

function hasEnumeratedSeparator(text) {
  ENUMERATED_SEPARATOR_RE.lastIndex = 0;
  return ENUMERATED_SEPARATOR_RE.test(String(text ?? ''));
}

const MULTI_TARGET_FILLER_PHRASES = new Set([
  'all done',
  'cheers',
  'done',
  'finished',
  'ok',
  'okay',
  'please',
  'right',
  'thank you',
  'thanks',
  'thanx',
  'that is all',
  'that is it',
  'thats all',
  'thats it',
  'yeah',
  'yep',
  'yes',
]);

/**
 * Consume one leading word/digit token while preserving the remaining text.
 *
 * @param {string} text
 * @returns {{token: string, rest: string}|null}
 */
function consumeLeadingToken(text) {
  const match = String(text ?? '').match(/^\s*([a-z]+|\d+)(?:\s+|$)([\s\S]*)$/i);
  if (!match) return null;
  return { token: match[1].toLowerCase(), rest: match[2] ?? '' };
}

/**
 * Remove only bounded conversational lead-ins seen around designation
 * answers. This stays local to the multi-target resolver: globally treating
 * "it" or "said" as stop words could corrupt a legitimate designation.
 */
function stripDescriptionLeadIn(text) {
  let stripped = String(text ?? '');
  // Bounded correction-free wrappers are safe to discard. Repeat because
  // natural answers stack them ("Sorry, I mean it's for ..."). Correction
  // markers in the MIDDLE of a list are rejected separately below.
  for (let i = 0; i < 4; i += 1) {
    const before = stripped;
    stripped = stripped.replace(/^i\s+(?:said|mean|meant)\b[\s,;:.…-]*/i, '');
    stripped = stripped.replace(/^it(?:['’]?s|\s+is)\b[\s,;:.…-]*/i, '');
    stripped = stripped.replace(/^(?:actually|sorry)\b[\s,;:.…-]*/i, '');
    stripped = stripped.replace(/^for\b[\s,;:.…-]*/i, '');
    if (stripped === before) break;
  }
  return stripped;
}

/**
 * Remove a bounded set of conversational wrappers before whole-designation
 * matching and segmentation. Edge-only stripping is important: treating
 * these as global stop words could alter a legitimate stored designation.
 */
function stripDescriptionWrappers(text) {
  let stripped = stripPunct(String(text ?? ''));
  for (let i = 0; i < 4; i += 1) {
    const before = stripped;
    stripped = stripDescriptionLeadIn(stripped);
    stripped = stripped.replace(
      /^(?:(?:i|we)\s+(?:think|suppose|guess|believe)(?:\s+that)?|maybe|perhaps|probably|possibly)\b[\s,]*/i,
      ''
    );
    stripped = stripPunct(stripped);
    stripped = stripped.replace(
      /(?:[,;]?\s*)(?:(?:i|we)\s+(?:think|suppose|guess|believe)|thanks|thank\s+you|cheers)\s*$/i,
      ''
    );
    stripped = stripPunct(stripped);
    if (stripped === before) break;
  }
  return stripped;
}

/**
 * Remove only reply-opening wrappers which can precede a retraction.
 *
 * This is intentionally separate from designation cleaning. It exists so
 * punctuation and hedges cannot hide a leading retraction, while a qualifier
 * after the target ("circuit 3 without the RCD") remains owned by the shipped
 * scalar circuit-ref path.
 */
function stripLeadingRetractionWrappers(text) {
  let stripped = stripPunct(String(text ?? '')).toLowerCase();
  for (let i = 0; i < 6; i += 1) {
    const before = stripped;
    stripped = stripped.replace(
      /^(?:(?:actually|sorry|maybe|perhaps|probably|possibly)|(?:i|we)\s+(?:think|suppose|guess|believe)(?:\s+that)?|i\s+(?:mean|meant|said)|it(?:['’]?s|\s+is)(?:\s+for)?|for)\b(?:[\s,;:.!?…()[\]{}"'“”‘’\-–—]+|$)/i,
      ''
    );
    stripped = stripPunct(stripped);
    if (stripped === before) break;
  }
  return stripped;
}

/**
 * Detect a retraction which governs the reply's target from the left.
 *
 * Negative auxiliary phrases are enumerated because they are semantically
 * retractive only with a bounded verb. Keeping the grammar anchored prevents
 * a later clause such as "circuit 3 without the RCD" from being mistaken for
 * withdrawal of circuit 3.
 */
function hasLeadingRetractionSyntax(text) {
  const value = stripLeadingRetractionWrappers(text);
  return /^(?:(?:(?:i|we)\s+)?(?:don['’]?t|didn['’]?t|do\s+not|did\s+not)\s+(?:mean|want|use|put|pick)|scratch(?:\s+that)?|forget(?:\s+that)?|correction|make\s+that|not|apart\s+from|except(?:\s+for)?|all\s+but|rather\s+than|instead(?:\s+of)?|exclude|excluding|without|leave\s+out|no|wait)\b/i.test(
    value
  );
}

function hasExplicitCorrectionCommand(text) {
  const value = stripPunct(String(text ?? '')).toLowerCase();
  return /\b(?:scratch(?:\s+that)?|forget(?:\s+that)?|correction|make\s+that)\b/i.test(value);
}

/**
 * A correction or negation is not an enumerated target list. Fail back to the
 * model rather than turning a retracted span into a write.
 * The guard is intentionally syntax-only and conservative: an unnecessary ask
 * is safer than applying "not circuit 2" to circuit 2.
 */
function hasCorrectionOrNegationSyntax(text) {
  // Strip only a bounded reply-opening wrapper first. The same words after a
  // real target separator remain correction syntax ("Kitchen, sorry,
  // cooker"), while "Sorry, I mean it's for Kitchen..." stays a harmless
  // single-target restatement.
  const value = stripDescriptionLeadIn(String(text ?? '')).toLowerCase();
  return (
    hasLeadingRetractionSyntax(text) ||
    // Keep the bulk-subtraction vocabulary aligned with
    // sonnet-stream.js BULK_EXCLUDE_PATTERN. These replies are corrections,
    // never affirmative description lists.
    /\b(?:not|apart\s+from|except|all\s+but|rather\s+than|instead(?:\s+of)?|exclude|excluding|without|leave\s+out)\b/.test(
      value
    ) ||
    /\b(?:don['’]t|do\s+not)\s+use\b/.test(value) ||
    /\b(?:scratch\s+that|forget\s+that|correction|make\s+that)\b/.test(value) ||
    /(?:^|[,;]|\band\b|\bplus\b)\s*(?:no|wait)\b/.test(value) ||
    /(?:[,;]|\band\b|\bplus\b)\s*sorry\b/.test(value) ||
    /(?:[,;]|\band\b|\bplus\b)\s*(?:i\s+(?:mean|meant)|actually)\b/.test(value)
  );
}

function normaliseMultiTargetFiller(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isConversationalFillerSpan(text) {
  const normalised = normaliseMultiTargetFiller(text);
  if (MULTI_TARGET_FILLER_PHRASES.has(normalised)) return true;
  // Bounded grammatical hedge classes, not an open-ended word blacklist.
  // They let "circuit 2, I think" remain the shipped scalar answer while an
  // unmatched noun phrase such as "attic lights" remains a real target that
  // must be surfaced as unresolved.
  return (
    /^(?:i|we)\s+(?:think|suppose|guess|believe)(?:\s+(?:so|that))?$/.test(normalised) ||
    /^(?:maybe|perhaps|probably|possibly)$/.test(normalised)
  );
}

function isCardinalToken(token) {
  const value = String(token ?? '').toLowerCase();
  return (
    /^\d+$/.test(value) ||
    Object.prototype.hasOwnProperty.call(ONES, value) ||
    Object.prototype.hasOwnProperty.call(TENS, value)
  );
}

/**
 * Consume one leading cardinal while retaining the unconsumed suffix.
 *
 * TENS+ONES must be inspected before a standalone TENS token: accepting
 * "twenty" first would leave "one" behind and turn a 21-circuit quantifier
 * into 20. This helper is shared by plain and "all <count>" quantifiers so
 * both forms obey the same ordering.
 *
 * @param {string} text
 * @returns {{value: number, rest: string, malformed?: false}|{value: null, rest: string, malformed: true}|null}
 */
function consumeLeadingCardinal(text) {
  const hyphenated = String(text ?? '').match(/^\s*([a-z]+|\d+)-([a-z]+|\d+)(?:\s+|$)([\s\S]*)$/i);
  if (hyphenated) {
    const firstToken = hyphenated[1].toLowerCase();
    const secondToken = hyphenated[2].toLowerCase();
    const tens = TENS[firstToken];
    const unit = ONES[secondToken];
    if (Number.isInteger(tens) && Number.isInteger(unit) && unit >= 1 && unit <= 9) {
      return { value: tens + unit, rest: hyphenated[3] ?? '' };
    }
    if (isCardinalToken(firstToken) && isCardinalToken(secondToken)) {
      return { value: null, rest: String(text ?? ''), malformed: true };
    }
  }

  const first = consumeLeadingToken(text);
  if (!first) return null;

  if (/^\d+$/.test(first.token)) {
    const second = consumeLeadingToken(first.rest);
    if (second && isCardinalToken(second.token)) {
      return { value: null, rest: String(text ?? ''), malformed: true };
    }
    return { value: Number.parseInt(first.token, 10), rest: first.rest };
  }

  if (Object.prototype.hasOwnProperty.call(TENS, first.token)) {
    const second = consumeLeadingToken(first.rest);
    if (second) {
      const unit = ONES[second.token];
      if (Number.isInteger(unit) && unit >= 1 && unit <= 9) {
        return { value: TENS[first.token] + unit, rest: second.rest };
      }
      // A second numeric token outside one..nine is malformed English, not a
      // standalone TENS count followed by a designation. Decline the entire
      // quantifier so "twenty ten" can never degrade into count=20.
      if (
        /^\d+$/.test(second.token) ||
        Object.prototype.hasOwnProperty.call(ONES, second.token) ||
        Object.prototype.hasOwnProperty.call(TENS, second.token)
      ) {
        return { value: null, rest: String(text ?? ''), malformed: true };
      }
    }
  }

  const value = parseCardinalQuantifier(first.token);
  if (value !== null) {
    const second = consumeLeadingToken(first.rest);
    if (second && isCardinalToken(second.token)) {
      return { value: null, rest: String(text ?? ''), malformed: true };
    }
  }
  return value === null ? null : { value, rest: first.rest };
}

/**
 * Parse and remove an attached count/all quantifier from a designation span.
 *
 * A quantifier is recognised only when the same span also contains the
 * `circuit`/`circuits` noun. That containment is the guard that prevents a
 * designation beginning with a number from being rewritten merely because it
 * starts with a numeric-looking token.
 *
 * @param {string} rawSpan
 * @returns {{text: string, quantifier: null|{kind: 'count'|'all', expected: number|null, source: 'count'|'all'|'both'}, malformed_quantifier: boolean}}
 */
function stripAttachedCircuitQuantifier(rawSpan) {
  const original = stripPunct(String(rawSpan ?? '').toLowerCase());
  if (!/\bcircuits?\b/i.test(original)) {
    return { text: original, quantifier: null, malformed_quantifier: false };
  }

  let working = stripDescriptionLeadIn(original).replace(/^\s*the\s+/i, '');
  let first = consumeLeadingToken(working);

  let quantifier = null;
  let consumedRest = first?.rest ?? working;
  if (first?.token === 'all') {
    quantifier = { kind: 'all', expected: null, source: 'all' };
    // "all three ..." carries an explicit count; plain "all ..." means all
    // exact/substring matches and therefore has no expected integer.
    const count = consumeLeadingCardinal(consumedRest);
    if (count?.malformed) {
      return { text: original, quantifier: null, malformed_quantifier: true };
    }
    if (Number.isInteger(count?.value) && count.value > 0) {
      quantifier = { kind: 'count', expected: count.value, source: 'all' };
      consumedRest = count.rest;
    }
  } else if (first?.token === 'both') {
    quantifier = { kind: 'count', expected: 2, source: 'both' };
  } else {
    const count = consumeLeadingCardinal(working);
    if (count?.malformed) {
      return { text: original, quantifier: null, malformed_quantifier: true };
    }
    if (Number.isInteger(count?.value) && count.value > 0) {
      quantifier = { kind: 'count', expected: count.value, source: 'count' };
      consumedRest = count.rest;
    }
  }

  if (!quantifier) {
    return { text: original, quantifier: null, malformed_quantifier: false };
  }

  // Natural variants: "both of the lighting circuits", "all of the sockets".
  working = consumedRest.replace(/^\s*of\b/i, '').replace(/^\s*the\b/i, '');
  working = working.replace(/\bcircuits?\b/gi, ' ');
  return {
    text: working.replace(/\s+/g, ' ').trim(),
    quantifier,
    malformed_quantifier: false,
  };
}

/**
 * A quantified circuit noun is a hard right boundary for stripped
 * maximum-coverage matching. The raw exact pass still gets first refusal,
 * but once "2 lighting circuits" is recognised, a following list separator
 * belongs to the next target and must not disappear when `circuits` is
 * stripped.
 */
function hasEnumeratedSeparatorAfterCircuitNoun(text) {
  const value = String(text ?? '');
  const circuitNoun = /\bcircuits?\b/i.exec(value);
  if (!circuitNoun) return false;
  const suffix = value.slice(circuitNoun.index + circuitNoun[0].length);
  ENUMERATED_SEPARATOR_RE.lastIndex = 0;
  return ENUMERATED_SEPARATOR_RE.test(suffix);
}

function hasMultiTargetSyntax(text) {
  ENUMERATED_SEPARATOR_RE.lastIndex = 0;
  if (ENUMERATED_SEPARATOR_RE.test(text)) return true;
  const attached = stripAttachedCircuitQuantifier(text);
  return attached.quantifier !== null || attached.malformed_quantifier;
}

/**
 * Split on enumerated separators while preserving source offsets. The offsets
 * let maximum-coverage matching reconstitute the exact original substring,
 * including an internal "and" in a designation.
 *
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function splitEnumeratedAtoms(text) {
  const atoms = [];
  let start = 0;
  ENUMERATED_SEPARATOR_RE.lastIndex = 0;
  let match;
  while ((match = ENUMERATED_SEPARATOR_RE.exec(text)) !== null) {
    const raw = text.slice(start, match.index);
    if (raw.trim()) atoms.push({ text: raw.trim(), start, end: match.index });
    start = match.index + match[0].length;
  }
  const tail = text.slice(start);
  if (tail.trim()) atoms.push({ text: tail.trim(), start, end: text.length });
  return atoms;
}

/**
 * Canonicalise only enumerated separators for whole-designation protection.
 * Exact equivalence here is symmetric: a stored "Cooker & Hob" and spoken
 * "Cooker and Hob", "Cooker plus Hob", or "Cooker, Hob" share one key.
 */
function canonicalSeparatorDesignation(text) {
  const canonicalSeparator = '__enumerated_separator__';
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/(?:\s*(?:[,&+]|\band\b|\bplus\b)\s*)+/gi, ` ${canonicalSeparator} `)
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9_-]+|[^a-z0-9_-]+$/g, ''))
    .filter(Boolean)
    .filter((token) => token === canonicalSeparator || !STOP_WORDS.has(token))
    .map((token) => (token === canonicalSeparator ? 'and' : token));
  return tokens.join(' ').trim();
}

/**
 * Return exact canonical-equivalence refs only. A non-unique canonical match
 * is deliberately ambiguous and must stop before segmentation; otherwise the
 * component circuits could be written even though the whole name is not
 * uniquely attributable.
 */
function matchCanonicalExactDesignation(text, circuits) {
  const canonical = canonicalSeparatorDesignation(text);
  if (!canonical || !Array.isArray(circuits)) {
    return { kind: 'no_match', circuitRefs: [] };
  }
  const refs = [];
  for (const circuit of circuits) {
    const designation = circuit?.circuit_designation ?? circuit?.designation ?? '';
    if (!designation || canonicalSeparatorDesignation(designation) !== canonical) continue;
    const ref =
      typeof circuit?.circuit_ref === 'number'
        ? circuit.circuit_ref
        : Number.parseInt(String(circuit?.circuit_ref), 10);
    if (Number.isInteger(ref)) refs.push(ref);
  }
  const circuitRefs = [...new Set(refs)].sort((a, b) => a - b);
  if (circuitRefs.length === 1) return { kind: 'exact', circuitRefs };
  if (circuitRefs.length > 1) return { kind: 'ambiguous', circuitRefs };
  return { kind: 'no_match', circuitRefs: [] };
}

function matchRawSpanExactDesignation(rawSpan, circuits) {
  const unwrapped = stripDescriptionLeadIn(stripPunct(String(rawSpan ?? '').toLowerCase()));
  return matchCanonicalExactDesignation(unwrapped, circuits);
}

/**
 * Protect a designation-internal separator by greedily taking the longest
 * contiguous atom span that is an EXACT designation. This is the
 * maximum-coverage guard for names such as "Kitchen and utility lights".
 *
 * @param {string} text
 * @param {Array<object>} circuits
 * @returns {string[]}
 */
function segmentDescriptionReply(text, circuits) {
  const atoms = splitEnumeratedAtoms(text);
  if (atoms.length <= 1) return atoms.map((a) => a.text);

  const segments = [];
  for (let i = 0; i < atoms.length; ) {
    let bestEnd = i;
    // Raw exact ownership outranks every stripped interpretation, even when
    // the raw designation occupies one atom and a longer candidate happens
    // to become another exact designation after count/circuit stripping.
    // Among raw exact candidates, retain the existing maximum-coverage rule.
    let rawExactEnd = null;
    for (let end = atoms.length - 1; end >= i; end -= 1) {
      const candidate = text.slice(atoms[i].start, atoms[end].end);
      const rawCanonicalVerdict = matchRawSpanExactDesignation(candidate, circuits);
      if (rawCanonicalVerdict.kind === 'exact' || rawCanonicalVerdict.kind === 'ambiguous') {
        rawExactEnd = end;
        break;
      }
    }
    if (rawExactEnd !== null) {
      bestEnd = rawExactEnd;
    } else {
      for (let end = atoms.length - 1; end > i; end -= 1) {
        const candidate = text.slice(atoms[i].start, atoms[end].end);
        const stripped = stripAttachedCircuitQuantifier(candidate);
        if (stripped.quantifier !== null && hasEnumeratedSeparatorAfterCircuitNoun(candidate)) {
          continue;
        }
        const unwrapped = stripDescriptionLeadIn(stripped.text);
        const cleaned = cleanReplyForDesignation(unwrapped);
        if (cleaned.length < 2) continue;
        const canonicalVerdict = matchCanonicalExactDesignation(unwrapped, circuits);
        if (canonicalVerdict.kind === 'exact' || canonicalVerdict.kind === 'ambiguous') {
          bestEnd = end;
          break;
        }
        const verdict = matchDesignation(cleaned, circuits);
        if (verdict.kind === 'exact') {
          bestEnd = end;
          break;
        }
      }
    }
    segments.push(text.slice(atoms[i].start, atoms[bestEnd].end).trim());
    i = bestEnd + 1;
  }
  return segments;
}

function isMeaningfulDescriptionSegment(segment, circuits) {
  // Exact server-owned names outrank the discourse filler vocabulary. An
  // inspector can genuinely have circuits called "Right", "OK", or "Done";
  // only discard those words when the current census does not own them.
  if (matchRawSpanExactDesignation(segment, circuits).kind !== 'no_match') return true;
  if (isConversationalFillerSpan(segment)) return false;
  const stripped = stripAttachedCircuitQuantifier(segment);
  if (stripped.quantifier !== null) return true;
  if (parseBoundedMultiDescriptionCircuitRefAtom(stripped.text) !== null) return true;
  return cleanReplyForDesignation(stripDescriptionLeadIn(stripped.text)).length > 0;
}

function availableCircuitRefSet(circuits) {
  return new Set(
    (Array.isArray(circuits) ? circuits : [])
      .map((circuit) => {
        const ref =
          typeof circuit?.circuit_ref === 'number'
            ? circuit.circuit_ref
            : Number.parseInt(String(circuit?.circuit_ref), 10);
        return Number.isInteger(ref) ? ref : null;
      })
      .filter(Number.isInteger)
  );
}

/**
 * Parse a bounded circuit-ref answer used only by the registered mdr broker.
 * The ordinary resolver deliberately keeps its shipped "circuit 1 and 2"
 * escalation; this helper is the explicit follow-up exception because the
 * server itself asked for a circuit "number or numbers".
 */
function stripMultiDescriptionRefWrappers(rawAtom) {
  let atom = stripDescriptionWrappers(rawAtom);
  for (let i = 0; i < 4; i += 1) {
    const before = atom;
    atom = atom.replace(
      /^(?:thank\s+you|thanks|cheers|please|yeah|yep|yes|okay|ok|right)\b[\s,;:.!?…()[\]{}"'“”‘’\-–—]*/i,
      ''
    );
    atom = atom.replace(
      /[\s,;:.!?…()[\]{}"'“”‘’\-–—]*(?:(?:and\s+)?(?:all\s+done|done|finished|thank\s+you|thanks|cheers|please|yeah|yep|yes|okay|ok|right))\s*$/i,
      ''
    );
    atom = stripDescriptionWrappers(atom);
    if (atom === before) break;
  }
  return atom.trim();
}

function parseBoundedMultiDescriptionCircuitRefAtom(rawAtom) {
  let atom = stripPunct(String(rawAtom ?? '').toLowerCase())
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!atom) return null;

  // Bounded discourse/politeness is allowed only at the edge. Everything
  // else must be part of the anchored ref grammar; this keeps natural
  // "thanks circuit 2" answers while rejecting "give me 2 seconds".
  atom = stripMultiDescriptionRefWrappers(atom);
  atom = atom.replace(/^the\s+/i, '').trim();
  atom = atom.replace(/^(?:(?:circuits?|ccts?)(?:\s+(?:numbers?|no\.?))?|numbers?)\s+/i, '').trim();
  atom = atom.replace(/\s+circuits?$/i, '').trim();
  if (!atom) return null;

  let ref = null;
  if (/^\d{1,3}$/.test(atom)) {
    ref = Number.parseInt(atom, 10);
  } else {
    ref = parseNumberWord(atom);
  }
  return Number.isInteger(ref) && ref >= 1 && ref <= 200 ? ref : null;
}

function parseMultiDescriptionCircuitRefs(userText) {
  const text = stripPunct(String(userText ?? '').toLowerCase());
  if (!text || hasCorrectionOrNegationSyntax(text)) return null;
  const atoms = splitEnumeratedAtoms(text).filter((atom) => !isConversationalFillerSpan(atom.text));
  if (atoms.length === 0) return null;
  const refs = [];
  for (const atom of atoms) {
    const ref = parseBoundedMultiDescriptionCircuitRefAtom(atom.text);
    if (!Number.isInteger(ref)) return null;
    refs.push(ref);
  }
  return [...new Set(refs)];
}

function isTargetlessMultiDescriptionChatter(userText) {
  const normalised = normaliseMultiTargetFiller(userText);
  if (!normalised || isConversationalFillerSpan(userText)) return true;
  if (/\b(?:seconds?|secs?|minutes?|mins?|moments?)\b/.test(normalised)) return true;
  return /^(?:hold on|wait|not yet|give me (?:a )?(?:moment|second)|one moment)$/.test(normalised);
}

function designationForRef(circuits, ref) {
  const circuit = (Array.isArray(circuits) ? circuits : []).find((c) => {
    const candidate =
      typeof c?.circuit_ref === 'number'
        ? c.circuit_ref
        : Number.parseInt(String(c?.circuit_ref), 10);
    return candidate === ref;
  });
  return (circuit?.circuit_designation ?? circuit?.designation ?? '').toLowerCase().trim();
}

/**
 * `matchDesignation` intentionally treats BOTH substring directions as a
 * unique-substring match. On a multi-target reply, however, a designation
 * being merely contained inside the whole reply is not evidence that the
 * WHOLE reply names only that circuit ("lighting and smoke alarm" contains
 * "smoke alarm"). Preserve the useful opposite direction — a shortened reply
 * contained by one designation — and reject the lossy direction here.
 */
function isWholeReplyDesignationMatch(match, cleaned, circuits) {
  if (match.kind === 'exact' || match.kind === 'fuzzy') return true;
  if (match.kind !== 'unique_substring' || match.circuitRefs.length !== 1) return false;
  const designation = designationForRef(circuits, match.circuitRefs[0]);
  return Boolean(designation && designation.includes(cleaned));
}

function canonicalUnresolvedScope(pendingWrite, contextBoardId) {
  return {
    tool: pendingWrite.tool,
    field: pendingWrite.field,
    board_id: pendingWrite.board_id ?? contextBoardId ?? null,
  };
}

/**
 * A board reading is one logical mutation regardless of how many circuit
 * descriptions established its scope. Mirror the existing "all circuits"
 * contract by collapsing accepted multi-description fan-out to circuit 0.
 */
function collapseBoardWriteFanout(pendingWrite, writes, contextBoardId) {
  if (pendingWrite?.tool !== 'record_board_reading' || writes.length === 0) return writes;
  return [buildWrite(pendingWrite, 0, contextBoardId)];
}

/**
 * Resolver-only scope metadata retained separately from the write array. A
 * board write collapses to circuit 0, so downstream server reconciliation
 * needs the validated pre-collapse refs without adding them to any wire frame.
 */
function selectedCircuitRefsMetadata(refs) {
  const selectedRefs = [...new Set(refs.filter(Number.isInteger))].sort((a, b) => a - b);
  return selectedRefs.length > 0 ? { selected_circuit_refs: selectedRefs } : {};
}

function unresolvedSpan({
  ordinal,
  disposition,
  reason,
  circuitRefs = [],
  requiredCount = null,
  pendingWrite,
  contextBoardId,
}) {
  const refs = [...new Set(circuitRefs.filter(Number.isInteger))].sort((a, b) => a - b);
  const knownRef = refs.length === 1 ? refs[0] : null;
  const isAsk = disposition === 'ask';
  return {
    identity: knownRef ?? ordinal,
    span_kind: knownRef != null ? 'circuit_ref' : 'segment_ordinal',
    ...(isAsk
      ? {
          segment_ordinal: ordinal,
          required_count: Number.isInteger(requiredCount) && requiredCount > 0 ? requiredCount : 1,
        }
      : {}),
    disposition,
    reason,
    ...(refs.length > 0 ? { candidates: refs } : {}),
    scope: canonicalUnresolvedScope(pendingWrite, contextBoardId),
  };
}

/**
 * Resolve a reply that demonstrably contains multiple description targets.
 * Returns null when the legacy scalar/single-designation path should own it.
 *
 * Raw spans never leave this pure function. Every unresolved identity is
 * either a known integer circuit ref or the server-owned one-based segment
 * ordinal, so the dispatcher can speak without echoing untrusted text.
 */
function resolveMultiDescriptionAnswer({ text, pendingWrite, availableCircuits, contextBoardId }) {
  const circuits = Array.isArray(availableCircuits) ? availableCircuits : [];
  const normalisedText = stripDescriptionWrappers(text);
  if (!hasMultiTargetSyntax(normalisedText)) return null;
  if (hasCorrectionOrNegationSyntax(text)) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
      available_circuits: circuits,
    };
  }

  // Whole-designation-first preserves shipped C1 fuzzy behaviour and protects
  // a real designation containing "and" from segmentation.
  const canonicalWholeMatch = matchCanonicalExactDesignation(normalisedText, circuits);
  if (canonicalWholeMatch.kind === 'ambiguous') {
    return {
      kind: 'escalate',
      parsed_hint: `ambiguous_designation_match:${canonicalWholeMatch.circuitRefs.join(',')}`,
      available_circuits: circuits,
    };
  }
  if (canonicalWholeMatch.kind === 'exact') {
    return {
      kind: 'auto_resolve',
      match_status: 'full',
      ...selectedCircuitRefsMetadata(canonicalWholeMatch.circuitRefs),
      writes: collapseBoardWriteFanout(
        pendingWrite,
        [buildWrite(pendingWrite, canonicalWholeMatch.circuitRefs[0], contextBoardId)],
        contextBoardId
      ),
      unresolved: [],
    };
  }

  // Preserve malformed-count state before an internal designation separator
  // can split the offending prefix away from the trailing `circuits` noun.
  // Example: "twenty ten kitchen and utility lights circuits" must not become
  // one no-match span plus a successful "utility lights" substring write.
  // The exact whole-designation owner above still wins first.
  const wholeAttached = stripAttachedCircuitQuantifier(normalisedText);
  if (wholeAttached.malformed_quantifier) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_malformed_quantifier',
      available_circuits: circuits,
    };
  }

  const wholeCleaned = cleanReplyForDesignation(normalisedText);
  if (wholeAttached.quantifier === null && wholeCleaned.length >= 2) {
    const wholeMatch = matchDesignation(wholeCleaned, circuits);
    if (isWholeReplyDesignationMatch(wholeMatch, wholeCleaned, circuits)) {
      return {
        kind: 'auto_resolve',
        match_status: 'full',
        ...selectedCircuitRefsMetadata(wholeMatch.circuitRefs),
        writes: collapseBoardWriteFanout(
          pendingWrite,
          [buildWrite(pendingWrite, wholeMatch.circuitRefs[0], contextBoardId)],
          contextBoardId
        ),
        unresolved: [],
      };
    }
  }

  const segments = segmentDescriptionReply(normalisedText, circuits).filter((segment) =>
    isMeaningfulDescriptionSegment(segment, circuits)
  );
  if (segments.length === 0) return null;
  const segmentStates = segments.map((rawSpan) => ({
    rawExactMatch: matchRawSpanExactDesignation(rawSpan, circuits),
    attached: stripAttachedCircuitQuantifier(rawSpan),
  }));

  // An exact stored designation owns its raw words even when its name starts
  // like a count ("Two Lighting Circuits"). Only an unowned malformed count
  // is terminal; preserving that explicit state prevents "twenty ten" from
  // degrading into a substring/scalar match.
  if (
    segmentStates.some(
      ({ rawExactMatch, attached }) =>
        rawExactMatch.kind === 'no_match' && attached.malformed_quantifier
    )
  ) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_malformed_quantifier',
      available_circuits: circuits,
    };
  }

  if (segments.length === 1) {
    const only = segmentStates[0].attached;
    // A count attached to no designation is just the shipped scalar ref
    // shape: "one circuit", "1 circuit", "twenty-one circuit". Do not turn
    // it into an empty multi-description span.
    if (
      only.quantifier !== null &&
      only.quantifier.source === 'count' &&
      cleanReplyForDesignation(stripDescriptionLeadIn(only.text)).length === 0
    ) {
      return null;
    }
    // A separator followed only by conversational filler is not a real list.
    // Let the shipped scalar path own "circuit 2, please" byte-for-byte.
    if (
      only.quantifier === null &&
      parseBoundedMultiDescriptionCircuitRefAtom(only.text) !== null
    ) {
      return null;
    }
  }
  // Preserve the shipped multiple-number safety verdict. PLAN-2B owns
  // description lists, not a semantic change to "circuit 2 and 3", which the
  // scalar resolver has always escalated as ambiguous. Mixed ref+description
  // lists still use this pipeline.
  if (
    segments.length > 1 &&
    segments.every((span) => {
      const strippedSpan = stripAttachedCircuitQuantifier(span);
      return parseBoundedMultiDescriptionCircuitRefAtom(strippedSpan.text) !== null;
    })
  ) {
    return null;
  }
  const writesByRef = new Map();
  const unresolved = [];

  segmentStates.forEach(({ rawExactMatch, attached }, index) => {
    const ordinal = index + 1;
    const { text: strippedSpan, quantifier } = attached;

    if (rawExactMatch.kind === 'exact') {
      const ref = rawExactMatch.circuitRefs[0];
      if (!writesByRef.has(ref)) {
        writesByRef.set(ref, buildWrite(pendingWrite, ref, contextBoardId));
      }
      return;
    }
    if (rawExactMatch.kind === 'ambiguous') {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'ask',
          reason: 'ambiguous_match',
          circuitRefs: rawExactMatch.circuitRefs,
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    // A detected list may mix designations with an explicit scalar ref:
    // "circuit 2 and the smoke alarm". Once the top-level separator diverts
    // the reply away from the legacy scalar path, each span must retain that
    // same deterministic ref interpretation. Validate it against the
    // server-owned circuit census before writing.
    const explicitRef =
      quantifier == null ? parseBoundedMultiDescriptionCircuitRefAtom(strippedSpan) : null;
    if (explicitRef !== null) {
      const exists = circuits.some((c) => {
        const ref =
          typeof c?.circuit_ref === 'number'
            ? c.circuit_ref
            : Number.parseInt(String(c?.circuit_ref), 10);
        return ref === explicitRef;
      });
      if (exists) {
        if (!writesByRef.has(explicitRef)) {
          writesByRef.set(explicitRef, buildWrite(pendingWrite, explicitRef, contextBoardId));
        }
      } else {
        unresolved.push(
          unresolvedSpan({
            ordinal,
            disposition: 'notice',
            reason: 'no_match',
            pendingWrite,
            contextBoardId,
          })
        );
      }
      return;
    }

    if (isConversationalFillerSpan(strippedSpan)) return;
    const unwrappedSpan = stripDescriptionLeadIn(strippedSpan);
    const cleaned = cleanReplyForDesignation(unwrappedSpan);
    const canonicalSpanMatch =
      quantifier === null
        ? matchCanonicalExactDesignation(unwrappedSpan, circuits)
        : { kind: 'no_match', circuitRefs: [] };
    const match =
      canonicalSpanMatch.kind !== 'no_match'
        ? canonicalSpanMatch
        : quantifier === null
          ? matchDesignation(cleaned, circuits)
          : matchQuantifiedDesignations(unwrappedSpan, circuits);
    const refs = [...new Set(match.circuitRefs.filter(Number.isInteger))].sort((a, b) => a - b);

    if (match.kind === 'fuzzy') {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'ask',
          reason: 'fuzzy_match',
          circuitRefs: refs,
          requiredCount: quantifier?.expected,
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    if (match.kind === 'no_match') {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'notice',
          reason: 'no_match',
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    // A quantifier makes an otherwise-ambiguous exact/substring candidate set
    // decidable only when its explicit count agrees below. Fuzzy matches never
    // reach this branch, so near-spellings cannot fan out.
    const quantifierPromotesAmbiguous = quantifier !== null && match.kind === 'ambiguous';
    const canUseAllMatches =
      match.kind === 'exact' || match.kind === 'unique_substring' || quantifierPromotesAmbiguous;
    if (!canUseAllMatches || refs.length === 0) {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'ask',
          reason: 'ambiguous_match',
          circuitRefs: refs,
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    if (quantifier?.kind === 'count' && refs.length !== quantifier.expected) {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'ask',
          reason: 'quantifier_count_mismatch',
          circuitRefs: refs,
          requiredCount: quantifier.expected,
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    if (!quantifier && refs.length > 1) {
      unresolved.push(
        unresolvedSpan({
          ordinal,
          disposition: 'ask',
          reason: 'ambiguous_match',
          circuitRefs: refs,
          pendingWrite,
          contextBoardId,
        })
      );
      return;
    }

    // Quantified plural spans deliberately fan out to EVERY exact/substring
    // match when the explicit count agrees (or the quantifier is plain "all").
    for (const ref of refs) {
      if (!writesByRef.has(ref)) {
        writesByRef.set(ref, buildWrite(pendingWrite, ref, contextBoardId));
      }
    }
  });

  const writes = collapseBoardWriteFanout(pendingWrite, [...writesByRef.values()], contextBoardId);
  const selectedCircuitMetadata = selectedCircuitRefsMetadata([...writesByRef.keys()]);
  if (
    writes.length === 0 &&
    unresolved.length > 0 &&
    unresolved.every((entry) => entry.reason === 'no_match')
  ) {
    return {
      kind: 'escalate',
      match_status: 'all_unmatched',
      parsed_hint: 'multi_description_all_unmatched',
      available_circuits: circuits,
      unresolved,
    };
  }
  if (unresolved.length === 0) {
    return {
      kind: 'auto_resolve',
      match_status: 'full',
      ...selectedCircuitMetadata,
      writes,
      unresolved: [],
    };
  }
  return {
    kind: 'partial_resolve',
    match_status: 'partial',
    ...selectedCircuitMetadata,
    writes,
    unresolved,
  };
}

/**
 * Match one registered MDR follow-up against the server-owned designation
 * census. All consumers use this helper so wrapper stripping and canonical
 * separator equivalence cannot diverge between the live answer gate and the
 * resolver that ultimately executes the answer.
 */
function matchMultiDescriptionFollowupDesignation(userText, availableCircuits) {
  const circuits = Array.isArray(availableCircuits) ? availableCircuits : [];
  const designationText = stripDescriptionWrappers(String(userText ?? '').toLowerCase());
  const canonicalMatch = matchCanonicalExactDesignation(designationText, circuits);
  const cleaned = cleanReplyForDesignation(designationText);
  return {
    canonicalMatch,
    match:
      canonicalMatch.kind !== 'no_match' ? canonicalMatch : matchDesignation(cleaned, circuits),
  };
}

/**
 * Resolve the answer to the ONE registered multi-description clarification.
 * Explicit ref lists are accepted here only; the ordinary scalar resolver's
 * legacy multi-number escalation remains unchanged.
 */
export function resolveMultiDescriptionFollowup({
  userText,
  pendingWrite,
  availableCircuits,
  contextBoardId = null,
}) {
  if (!pendingWrite || typeof pendingWrite !== 'object') return null;
  const circuits = Array.isArray(availableCircuits) ? availableCircuits : [];
  const stripped = stripPunct(String(userText ?? '').toLowerCase());
  if (CANCEL_PHRASES.includes(stripped)) return { kind: 'cancel' };
  if (hasCorrectionOrNegationSyntax(userText)) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_followup_correction_or_negation',
      available_circuits: circuits,
    };
  }

  const { canonicalMatch: canonicalDesignationMatch, match: designationMatch } =
    matchMultiDescriptionFollowupDesignation(userText, circuits);

  // Raw/exact server-owned designations get first refusal, including names
  // that resemble discourse filler or contain a digit. This is the same
  // ownership rule used by the initial multi-description pass.
  if (designationMatch.kind === 'exact') {
    const ref = designationMatch.circuitRefs[0];
    const writes = collapseBoardWriteFanout(
      pendingWrite,
      [buildWrite(pendingWrite, ref, contextBoardId)],
      contextBoardId
    );
    return {
      kind: 'auto_resolve',
      match_status: 'full',
      ...selectedCircuitRefsMetadata([ref]),
      writes,
      unresolved: [],
    };
  }
  if (canonicalDesignationMatch.kind === 'ambiguous') {
    return {
      kind: 'escalate',
      parsed_hint: `multi_description_followup_ambiguous_designation:${canonicalDesignationMatch.circuitRefs.join(',')}`,
      available_circuits: circuits,
    };
  }

  const refs = parseMultiDescriptionCircuitRefs(userText);
  if (!refs) {
    // A known but non-exact designation answer is substantive. Resolve a
    // unique substring, but fail closed for fuzzy/ambiguous candidates so the
    // registered MDR answer can never fall through to scalar C1 fuzzy and
    // silently write one circuit.
    if (designationMatch.kind === 'unique_substring') {
      const ref = designationMatch.circuitRefs[0];
      const writes = collapseBoardWriteFanout(
        pendingWrite,
        [buildWrite(pendingWrite, ref, contextBoardId)],
        contextBoardId
      );
      return {
        kind: 'auto_resolve',
        match_status: 'full',
        ...selectedCircuitRefsMetadata([ref]),
        writes,
        unresolved: [],
      };
    }
    if (designationMatch.kind === 'ambiguous' || designationMatch.kind === 'fuzzy') {
      return {
        kind: 'escalate',
        parsed_hint: `multi_description_followup_${designationMatch.kind}_designation:${designationMatch.circuitRefs.join(',')}`,
        available_circuits: circuits,
      };
    }
    // Transcript-origin waiting/filler must not consume the registered ask.
    // The predicate shares this distinction; direct answer frames remain
    // authoritative for other substantive but unmatched designations.
    if (isTargetlessMultiDescriptionChatter(userText)) return null;
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_followup_no_designation_match',
      available_circuits: circuits,
    };
  }

  const knownRefs = availableCircuitRefSet(availableCircuits);
  const writes = [];
  const unresolved = [];
  refs.forEach((ref, index) => {
    if (knownRefs.has(ref)) {
      writes.push(buildWrite(pendingWrite, ref, contextBoardId));
    } else {
      unresolved.push(
        unresolvedSpan({
          ordinal: index + 1,
          disposition: 'notice',
          reason: 'no_match',
          pendingWrite,
          contextBoardId,
        })
      );
    }
  });

  const selectedCircuitMetadata = selectedCircuitRefsMetadata(writes.map((write) => write.circuit));
  const resolvedWrites = collapseBoardWriteFanout(pendingWrite, writes, contextBoardId);
  if (resolvedWrites.length === 0) {
    return {
      kind: 'escalate',
      match_status: 'all_unmatched',
      parsed_hint: 'multi_description_followup_all_unmatched',
      available_circuits: circuits,
      unresolved,
    };
  }
  if (unresolved.length === 0) {
    return {
      kind: 'auto_resolve',
      match_status: 'full',
      ...selectedCircuitMetadata,
      writes: resolvedWrites,
      unresolved: [],
    };
  }
  return {
    kind: 'partial_resolve',
    match_status: 'partial',
    ...selectedCircuitMetadata,
    writes: resolvedWrites,
    unresolved,
  };
}

function hasExplicitCircuitRefAnchor(userText) {
  const tokens = String(userText ?? '')
    .toLowerCase()
    .match(/[a-z0-9-]+/g);
  if (!tokens) return false;

  const isValidRefTokens = (candidateTokens) => {
    if (candidateTokens.length === 0) return false;
    const candidate = candidateTokens.join(' ');
    const ref = /^\d+$/.test(candidate)
      ? Number.parseInt(candidate, 10)
      : parseNumberWord(candidate);
    return Number.isInteger(ref) && ref >= 1 && ref <= 200;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^(?:circuit|circuits|cct|ccts)$/.test(tokens[index])) continue;

    let after = index + 1;
    if (/^(?:number|numbers|no)$/.test(tokens[after] ?? '')) after += 1;
    if (
      isValidRefTokens(tokens.slice(after, after + 1)) ||
      isValidRefTokens(tokens.slice(after, after + 2)) ||
      isValidRefTokens(tokens.slice(Math.max(0, index - 1), index)) ||
      isValidRefTokens(tokens.slice(Math.max(0, index - 2), index))
    ) {
      return true;
    }
  }
  return false;
}

function hasKnownDesignationAnchor(userText, availableCircuits) {
  const { match } = matchMultiDescriptionFollowupDesignation(userText, availableCircuits);
  return match.kind !== 'no_match';
}

/**
 * Conservative transcript-channel predicate for a registered mdr ask.
 * Direct ask_user_answered frames remain authoritative; transcript-origin
 * speech is accepted only when it is a valid census ref/list, a known
 * designation, or a target-bearing correction. Filler such as "hold on"
 * therefore cannot consume and delete the pending clarification.
 */
export function isMultiDescriptionAnswerText(userText, availableCircuits) {
  const stripped = stripPunct(String(userText ?? '').toLowerCase());
  if (CANCEL_PHRASES.includes(stripped)) return true;
  // A bounded correction is a substantive answer to the registered mdr ask:
  // consume it so the dispatcher can reach its fail-closed correction verdict
  // and speak a terminal immediately. Require an explicit ref or census
  // designation anchor so targetless waiting chatter such as "wait 2 minutes"
  // still preserves the ask.
  if (hasCorrectionOrNegationSyntax(userText)) {
    if (hasExplicitCorrectionCommand(userText)) return true;
    return (
      hasExplicitCircuitRefAnchor(userText) ||
      hasKnownDesignationAnchor(userText, availableCircuits)
    );
  }
  const circuits = Array.isArray(availableCircuits) ? availableCircuits : [];
  const refs = parseMultiDescriptionCircuitRefs(userText);
  if (refs) {
    // Shape gate only. The follow-up resolver performs the census validation
    // and turns an absent ref into a trusted no-match result; rejecting it
    // here would delete the pending ask before that notice can be produced.
    return refs.length > 0;
  }
  const { match } = matchMultiDescriptionFollowupDesignation(userText, circuits);
  return match.kind !== 'no_match';
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
 *   { kind: 'partial_resolve', writes: [...], unresolved: [...] }
 *     — server dispatches the deterministic sibling writes, stages no-match
 *       notices only for surviving writes, and emits one bounded registered
 *       clarification for ask-required entries.
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

  // Retractions govern both multi-description and scalar targets. Detect them
  // before either path can turn an embedded circuit number/designation into a
  // write. The grammar is left-anchored, so postfix target qualifiers retain
  // their shipped scalar behaviour.
  if (hasLeadingRetractionSyntax(lower)) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
      available_circuits: availableCircuits ?? [],
    };
  }
  // Explicit correction commands govern the reply wherever they occur. This
  // must precede numeric extraction: an unanchored "circuit 2 scratch that"
  // previously committed circuit 2 before the later correction guard ran.
  // Other postfix qualifiers retain their narrow scalar exception below.
  if (hasExplicitCorrectionCommand(lower)) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
      available_circuits: availableCircuits ?? [],
    };
  }

  // PLAN-2B step 0 — detect multi-target syntax BEFORE `extractCircuitRef`.
  // The old ordering turned "2 lighting circuits and the smoke alarm" into a
  // single write for circuit 2 and silently discarded the rest.
  const multiDescriptionVerdict = resolveMultiDescriptionAnswer({
    text: lower,
    pendingWrite,
    availableCircuits,
    contextBoardId,
  });
  if (multiDescriptionVerdict) return multiDescriptionVerdict;

  // A unique server-owned whole designation has first refusal over the scalar
  // number grammar. Census names routinely carry room/flat numbers whose
  // embedded digit is not their circuit ref ("Flat 2 sockets" may be ref 7).
  const scalarWholeDesignation = matchCanonicalExactDesignation(
    stripDescriptionWrappers(lower),
    availableCircuits ?? []
  );
  if (scalarWholeDesignation.kind === 'exact') {
    return {
      kind: 'auto_resolve',
      writes: [buildWrite(pendingWrite, scalarWholeDesignation.circuitRefs[0], contextBoardId)],
    };
  }
  if (scalarWholeDesignation.kind === 'ambiguous') {
    return {
      kind: 'escalate',
      parsed_hint: `ambiguous_designation_match:${scalarWholeDesignation.circuitRefs.join(',')}`,
      available_circuits: availableCircuits ?? [],
    };
  }

  // Numeric path: bare digit ("2"), word ("two"), "circuit 2", "circuit two".
  const numericRef = extractCircuitRef(lower);
  if (numericRef !== null) {
    return { kind: 'auto_resolve', writes: [buildWrite(pendingWrite, numericRef, contextBoardId)] };
  }

  // The multi-description helper deliberately declines single-target replies.
  // Keep a retracted DESIGNATION from being swallowed by scalar substring
  // matching, while preserving the shipped numeric path above for replies
  // such as "circuit 3 without the RCD".
  if (hasCorrectionOrNegationSyntax(lower)) {
    return {
      kind: 'escalate',
      parsed_hint: 'multi_description_correction_or_negation',
      available_circuits: availableCircuits ?? [],
    };
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
  // §C1 — 'fuzzy' is the new conservative Levenshtein verdict (plural/typo
  // variants of a real designation, strict margin). Treated exactly like the
  // deterministic matches: the write auto-resolves to that circuit.
  if (match.kind === 'exact' || match.kind === 'unique_substring' || match.kind === 'fuzzy') {
    return {
      kind: 'auto_resolve',
      writes: [buildWrite(pendingWrite, match.circuitRefs[0], contextBoardId)],
    };
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
  // Parse only a bounded whole reply. The old unanchored digit scan accepted
  // any lone integer anywhere in prose, so "Bedroom 2" silently became
  // circuit 2. Edge-only discourse wrappers remain supported for the shipped
  // "circuit 2, please" / "circuit 3 and done" forms.
  const trimmed = stripMultiDescriptionRefWrappers(String(lowerText ?? '').toLowerCase()).trim();

  // Narrow shipped exception: a postfix RCD qualifier still belongs to its
  // explicit numeric circuit target. Other correction/negation syntax is
  // rejected by resolveCircuitAnswer before this parser runs.
  const qualifiedDigit = trimmed.match(
    /^(?:the\s+)?(?:circuit|cct)(?:\s+(?:number|no\.?))?\s+(\d{1,3})\s+without\s+(?:the\s+)?rcd(?:\s+qualifier)?$/i
  );
  if (qualifiedDigit) {
    const n = Number.parseInt(qualifiedDigit[1], 10);
    return n >= 1 && n <= 200 ? n : null;
  }

  // Strict digit grammar: a single integer 1..200, optionally wrapped by a
  // circuit noun. Anchoring rejects decimals, prose, and multiple numbers.
  const digit = trimmed.match(
    /^(?:(?:the\s+)?(?:circuit|cct)(?:\s+(?:number|no\.?))?\s+)?(\d{1,3})(?:\s+(?:circuit|cct))?$/i
  );
  if (digit) {
    const n = Number.parseInt(digit[1], 10);
    if (n >= 1 && n <= 200) return n;
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
  const allTokens = trimmed.match(/[a-z]+/g) || [];
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
// "LIM" (limitation) is a STRING sentinel, NOT infinity. P3 (2026-07-23):
// narrowed to the EXACT four forms lim/limb/limp/limitation (was
// lim/limb/limp/limit(ation|ed)/lynn/lym) — limit/limited/lynn/lym are
// near-matches that must NOT coerce, keeping this consistent with the shared
// four-form policy (value-enum-validator.js LIM_FORM_RE, record-reading-
// coercion.js, the dialogue parsers). This MUST stay word-boundaried — field
// report 2026-06-24 #2: the inspector said "Limb." and a substring
// `"limb".includes("lim")` here wrote ring_r1_ohm = ∞ (silent data corruption,
// deduped on TTS). On a continuity field "limitation" writes the string "LIM";
// ∞ requires an explicit discontinuous/open/infinity phrase below.
const LIM_RE = /\b(?:lim|limb|limp|limitation)\b/i;
// Build a \b-anchored matcher for the discontinuous phrases so a token like
// "ol"/"open" never bites mid-word (e.g. "old", "opening"). Multi-word phrases
// ("open circuit") are matched verbatim with word boundaries on each end.
const DISCONTINUOUS_RE = new RegExp(
  `\\b(?:${DISCONTINUOUS_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
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
  // P3 (2026-07-23, feedback id 86) — LIM is a valid reading for EVERY numeric
  // reading field, not just the continuity ones. Previously this branch was
  // gated on CONTINUITY_FIELDS, so a LIM reply for e.g. measured_zs_ohm (a
  // non-continuity numeric field) fell through to terminalApology instead of
  // writing. Broaden the LIM branch to accept every alias-normalised
  // NUMERIC_READING_FIELDS member (rcd_trip_time → rcd_time_ms etc.); the
  // discontinuous/open/∞ branch below stays continuity-only (CONTINUITY_FIELDS
  // is a strict subset of NUMERIC_READING_FIELDS, so this only ADDS).
  if (LIM_RE.test(lower)) {
    if (NUMERIC_READING_FIELDS.has(canonicaliseNumericReadingField(contextField))) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites('LIM', 0.9),
      };
    }
    return {
      kind: 'escalate',
      parsed_hint: 'lim_on_non_numeric_reading_field',
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

  // §3.4 (2026-07-30, feedback id 103) — ref_method A–G / 100–103 answer
  // resolution. The generic paths below deterministically CANNOT resolve a
  // letter answer: ref_method has digit options (100–103) so it is barred
  // from WORD_ANCHORED_ENUM_FIELDS (that branch requires digit-free
  // options), and the digit matcher finds no digit in "C" → invalid_value
  // forever. This branch is CONTEXT-GATED (contextField === 'ref_method'),
  // which is also the severity-collision guard: a bare "C" only resolves
  // when the pending ask is about ref_method, never when it is an
  // observation-severity clarify (C1/C2/C3). ENUMERATED only (parity §3E).
  if (contextField === 'ref_method') {
    const optionSet = new Set(field.options);
    // normalised WHOLE reply (trailing punctuation stripped, whitespace
    // collapsed) — used for the STRICTER option-A test.
    const normWhole = lower
      .replace(/[.,!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // reply after stripping enumerated lead-ins — form (i) whole-residue test.
    const residue = normWhole
      .replace(/^(?:it['’]s|it is|the)\s+/, '')
      .replace(/^(?:reference\s+method|ref\s+method|method)\s+/, '')
      .trim();

    const candidates = new Set();

    // Digit methods 100–103: any digit run present in the reply (covers
    // "method 100", "it's a buried run, 100", "one hundred and one" via the
    // word-number map below).
    for (const m of lower.matchAll(/\b(10[0-3])\b/g)) {
      if (optionSet.has(m[1])) candidates.add(m[1]);
    }
    // Word-number forms, LONGEST-first with span consumption so "one
    // hundred and two" matches 102 only (the "one hundred" prefix is
    // consumed before its own shorter pattern is tested — otherwise both
    // 102 AND 100 would register as candidates and force a false ambiguity).
    const REF_METHOD_WORD_NUMBERS_RESOLVER = [
      ['one hundred and one', '101'],
      ['one hundred one', '101'],
      ['one hundred and two', '102'],
      ['one hundred two', '102'],
      ['one hundred and three', '103'],
      ['one hundred three', '103'],
      ['one hundred', '100'],
    ];
    let wordNumWork = lower;
    for (const [phrase, canon] of REF_METHOD_WORD_NUMBERS_RESOLVER) {
      const re = new RegExp(`\\b${phrase}\\b`);
      if (optionSet.has(canon) && re.test(wordNumWork)) {
        candidates.add(canon);
        wordNumWork = wordNumWork.replace(re, ' ');
      }
    }

    // Letters B–G — form (i): the whole residue equals a single letter;
    // form (ii): a letter token immediately preceded by method/reference
    // method anywhere in the reply. A is DELIBERATELY excluded from both
    // loose forms (the indefinite article "a" is not a method letter).
    if (/^[b-g]$/.test(residue) && optionSet.has(residue.toUpperCase())) {
      candidates.add(residue.toUpperCase());
    }
    for (const m of lower.matchAll(/\b(?:reference\s+method|method)\s+([b-g])\b/g)) {
      const L = m[1].toUpperCase();
      if (optionSet.has(L)) candidates.add(L);
    }

    // Option A — STRICTER: only the whole reply "a", or a TERMINAL exact
    // "method a" / "reference method a" (nothing after it). The general
    // preceded-letter rule never applies to A when more prose follows, so
    // "reference method a buried run, 100" resolves to 100, never A.
    if (
      optionSet.has('A') &&
      (normWhole === 'a' ||
        normWhole === 'method a' ||
        normWhole === 'reference method a' ||
        normWhole === 'ref method a')
    ) {
      candidates.add('A');
    }

    if (candidates.size === 1) {
      return {
        kind: 'auto_resolve',
        writes: buildWrites([...candidates][0], 0.9),
      };
    }
    if (candidates.size > 1) {
      // Multiple genuine enum candidates ("C or D", "method b, 100") — ask
      // rather than guess. invalid_value drives the dispatcher's re-ask
      // path (the model owns the follow-up question).
      return {
        kind: 'invalid_value',
        received: text,
        valid_options: field.options,
      };
    }
    // Zero candidates — fall through to the generic digit path, which
    // surfaces invalid_value / did_you_mean for a non-matching reply (a
    // re-ask, never a wrong write).
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
