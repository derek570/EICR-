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
 *   4. No regex hits at all → {kind: 'user_moved_on'} (conservative fail-safe)
 *
 * Open Question #4 resolution: when the utterance produces no regex hits, the
 * fail-safe default is 'user_moved_on', NOT 'answers-to-oldest'. Letting the
 * user restate is strictly safer than incorrectly attributing an unrelated
 * utterance ("yes" / "let me think" / "hmm") as the answer to whatever ask
 * happens to be at the front of the registry. A wrongly-attributed answer
 * poisons the slot map and triggers a cascade of downstream corrections; a
 * rejectAll just means the user hears the question again on the next turn.
 *
 * Duck-typed pendingAsks: the parameter only needs .size and .entries().
 * Both the real PendingAsksRegistry (Plan 03-01) and a plain Map work —
 * keeps this module unit-testable without the full registry stood up.
 *
 * Requirement: STA-04.
 */

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

  // 3. No regex hits at all → conservative default (Open Question #4).
  return { kind: 'user_moved_on' };
}
