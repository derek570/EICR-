/**
 * Cross-utterance destructive-intent grammar (feedback id 93, session
 * 2D8E432D, 2026-07-27).
 *
 * The repro: "delete" (10:33:03) and "recontinuity readings for circuit 13."
 * (10:33:09) arrived as TWO separate STT-finalised utterances. The per-schema
 * `entryExclusionPattern` tests only the TRIGGER utterance, and the engine's
 * same-text veto is exact-text/same-turn — so the standalone "delete" was
 * discarded and the follow-up trigger entered the ring script, which asked
 * its confirmation instead of letting the model reach `clear_reading`.
 *
 * This module owns the two pieces of the fix that are shared knowledge:
 *
 * - `DESTRUCTIVE_INTENT_RE` — an ANCHORED standalone grammar over the same
 *   enumerated verbs as the ring entry-exclusion pattern. Anchoring is the
 *   point: "fix the socket wiring on circuit 4" must never arm (the verb is
 *   not standalone — it has a real object), while "delete", "please delete
 *   that", "remove the readings" do. Enumerated only; NO fuzzy matching
 *   (§3E). The optional-object tail is a closed set of pronouns/articles +
 *   the readings/values nouns, at most three tokens, so any verb followed by
 *   novel content fails the `$` anchor.
 *
 * - `CROSS_UTTERANCE_DESTRUCTIVE_WINDOW_MS` — how long an armed token stays
 *   live, measured as the ORDERED ARRIVAL DELTA between the delete utterance
 *   and the follow-up trigger (never a consumption-time `now` comparison:
 *   queue latency behind an in-flight extraction must not expire a live
 *   token, and an out-of-order stamp must never match). 12 000 ms — the
 *   field repro gap is 6 s, so the engine's 5 000 ms same-text veto window
 *   would FAIL the actual reported bug; deliberately a separate constant.
 *
 * The token LIFECYCLE (arrival stamping, arming at the model-commit seam,
 * one-shot consumption + window arbitration) lives entirely in
 * sonnet-stream.js — the engine only honours the resulting
 * `suppressDestructiveEntry` flag. The legacy twins have no engine-level
 * entry guard and deliberately get none of this machinery: twin parity for
 * the id-93 scenarios is at the replay-scenario level (the delete→trigger
 * pair routes to the model), not byte-level twin mirroring.
 */

export const DESTRUCTIVE_INTENT_RE =
  /^\s*(?:(?:please|can you|could you|would you)\s+)*(?:delete|undo|remove|clear|cancel|fix)(?:\s+(?:the|that|this|these|those|it|them|all|readings?|values?)){0,3}\s*[.!?]?\s*$/i;

export const CROSS_UTTERANCE_DESTRUCTIVE_WINDOW_MS = 12_000;
