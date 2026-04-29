/**
 * Stage 6 Phase 3 Plan 03-04 — classifyOvertake.
 *
 * Pure classifier. Given a new user utterance (text + regex-extracted field
 * results) and the per-session pending-asks registry, returns a verdict the
 * Plan 03-08 handleTranscript caller acts on. No side effects, no imports,
 * no registry mutation — the caller does resolve()/rejectAll() based on the
 * returned {kind}.
 *
 * Decision tree (ordered; first match wins):
 *   1. Empty registry            → {kind: 'no_pending_asks'}
 *   2. Any regex hit whose (field, circuit) matches a pending ask's
 *      (contextField, contextCircuit) → {kind: 'answers', toolCallId, userText}
 *   3. Any regex hit that does NOT fully match any pending ask — i.e. a
 *      different field OR same field but different circuit → {kind: 'user_moved_on'}
 *   4. No regex hits — shape-aware (Plan 03-11 Task 2):
 *      4a. Pending ask with expectedAnswerShape === 'yes_no' AND the text
 *          matches the yes/no vocabulary → {kind: 'answers', ...}
 *      4b. Pending ask with expectedAnswerShape === 'circuit_ref' AND
 *          extractCircuitRef parses the text to a 1..200 integer (single-
 *          number guard, decimal-rejection guard) → {kind: 'answers', ...}
 *      4c. Otherwise → {kind: 'user_moved_on'} (fail-safe default)
 *
 * Open Question #4 resolution: when the utterance produces no regex hits, the
 * DEFAULT fail-safe is 'user_moved_on', NOT 'answers-to-oldest'. Letting the
 * user restate is strictly safer than incorrectly attributing an unrelated
 * utterance ("let me think" / "hmm") as the answer to whatever ask happens
 * to be at the front of the registry. A wrongly-attributed answer poisons
 * the slot map and triggers a cascade of downstream corrections; a rejectAll
 * just means the user hears the question again on the next turn.
 *
 * Plan 03-11 Task 2 refinement (STG r3 MAJOR): number / circuit_ref asks
 * still fall through to user_moved_on on no-regex (same rationale — wrong
 * numeric attribution is the harder failure mode to detect). But yes_no
 * asks are *inherently* non-regex: the answer to "Is this reading above 1
 * ohm?" ("yes") will never produce a field regex hit. Without shape-
 * awareness the classifier would reject every such answer flowing through
 * the transcript channel (pre-Phase-4 iOS or the legacy path), forcing
 * the inspector to restate. Shape-aware short-circuit closes that gap
 * while keeping the conservative default wherever false-attribution cost
 * is high.
 *
 * Plan 03-12 STG r6 MAJOR revision: the earlier free_text branch (which
 * accepted any non-empty trimmed text as an answer) is REMOVED. That
 * heuristic misclassified filler speech — "hold on a second", "let me
 * check", "hmm" — as answers to any pending free_text ask, corrupting
 * the ask flow. No-regex speech against a free_text ask now falls
 * through to user_moved_on (conservative default). Phase 4's iOS
 * contract routes free_text answers via the direct ask_user_answered
 * channel with consumed_utterance_id — the transcript-overtake path
 * is not the authoritative route for free_text.
 *
 * 2026-04-29 — circuit_ref branch added. Field-test session 17C4135E lost
 * an IR live-to-earth reading because the disambiguation ask
 * ("I've got two circuits both called Upstairs Sockets — circuit 1 or
 * circuit 2?") had expectedAnswerShape='circuit_ref', and the user's
 * "circuit 2." reply produced no value-regex hit, so step 4 fell
 * through to user_moved_on. The transcript channel's rejectAll fired
 * before iOS's explicit ask_user_answered could resolve the same
 * tool_call_id, dropping the answer. circuit_ref is now shape-aware in
 * step 3 using extractCircuitRef from stage6-answer-resolver, which
 * already enforces the safety rails Open Question #4 cares about:
 * single-number guard rejects "circuit 2 ze 0.34" (a value statement),
 * decimal guard rejects "0.4" (a value, not a circuit ref), 1..200
 * range guard rejects "circuit 250". `number`-shaped asks remain
 * conservative — bare "2" is genuinely ambiguous between value and
 * circuit ref when the question is about a numeric reading.
 *
 * Duck-typed pendingAsks: the parameter only needs .size and .entries().
 * Both the real PendingAsksRegistry (Plan 03-01) and a plain Map work —
 * keeps this module unit-testable without the full registry stood up.
 *
 * Requirement: STA-04.
 */

import { extractCircuitRef } from './stage6-answer-resolver.js';

// Plan 03-11 Task 2 — yes/no vocabulary. Lowercased, trailing punctuation
// stripped by the caller before matching. Kept inline (not a config export)
// because the set is small, the meaning is language-universal within the
// English inspection domain, and a config lookup would buy nothing except
// another hot-reload surface. Add variants here if the inspector pool
// grows regional dialect coverage.
// Plan 03-12 r11 MINOR remediation — restore multi-word variants that
// were dropped from the planned vocabulary. "not really" is the canonical
// example surfaced by r11 review: an inspector replying "not really" to
// "Is this circuit still in service?" falls through the user_moved_on
// branch today because no single-word token matches, and the next turn
// forces a re-ask. Also adding "of course" (yes-sided) + "no way"
// (no-sided) which were in the Plan 03-11 Task 2 research notes but
// never landed. normaliseForYesNo() preserves internal whitespace — it
// only trims leading/trailing whitespace + punctuation — so multi-word
// phrases remain as literal Set keys.
const YES_NO_VOCABULARY = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'affirmative',
  'correct',
  'confirmed',
  'of course',
  'no',
  'nope',
  'nah',
  'negative',
  'incorrect',
  'wrong',
  'not really',
  'no way',
]);

function normaliseForYesNo(text) {
  if (typeof text !== 'string') return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,;:!?(){}[\]-]+/, '')
    .replace(/[\s"'`.,;:!?(){}[\]-]+$/, '');
}

export function classifyOvertake(newText, regexResults, pendingAsks) {
  if (!pendingAsks || pendingAsks.size === 0) {
    return { kind: 'no_pending_asks' };
  }

  const regex = Array.isArray(regexResults) ? regexResults : [];

  // 1. Exact (field, circuit) match wins — iterate regex hits in order, then
  //    pending asks in insertion order. First full match returns immediately.
  for (const r of regex) {
    for (const [id, entry] of pendingAsks.entries()) {
      if (r.field === entry.contextField && r.circuit === entry.contextCircuit) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }
  }

  // 2. Any regex hit that did not fully match a pending ask signals the user
  //    has moved on. Covers BOTH different-field AND same-field-different-
  //    circuit (e.g. pending (ze,5) + regex (ze,3) — step 1 didn't match, so
  //    we land here). Defers to the rejectAll path; user will restate.
  for (const r of regex) {
    let hadFullMatch = false;
    for (const [, entry] of pendingAsks.entries()) {
      if (r.field === entry.contextField && r.circuit === entry.contextCircuit) {
        hadFullMatch = true;
        break;
      }
    }
    if (!hadFullMatch) {
      return { kind: 'user_moved_on' };
    }
  }

  // 3. No regex hits — Plan 03-11 Task 2 shape-aware branch. Walk pending
  //    asks in insertion order (oldest first). First match wins.
  //
  //    yes_no  → text against YES_NO_VOCABULARY (bounded set)
  //    circuit_ref → extractCircuitRef (single-number, 1..200, no decimals)
  //
  //    number / free_text / undefined shapes never match here — they fall
  //    through to the conservative user_moved_on default, preserving the
  //    Open Question #4 ruling for asks where false attribution is
  //    expensive (a bare "2" reply to a number ask is genuinely ambiguous
  //    between "value" and "circuit ref"; a "2" reply to a circuit_ref ask
  //    is not).
  const yesNoNormalised = normaliseForYesNo(newText);
  const lowerNewText = typeof newText === 'string' ? newText.toLowerCase() : '';
  for (const [id, entry] of pendingAsks.entries()) {
    if (entry.expectedAnswerShape === 'yes_no') {
      if (YES_NO_VOCABULARY.has(yesNoNormalised)) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    } else if (entry.expectedAnswerShape === 'circuit_ref') {
      if (extractCircuitRef(lowerNewText) !== null) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }
  }

  // 4. Conservative fail-safe (Open Question #4): no regex hits and no
  //    shape-aware match.
  return { kind: 'user_moved_on' };
}
