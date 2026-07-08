/**
 * D1 — product-invariant library over behavioural traces.
 *
 * Wave 3 SEEDS this module with the minimal subset the keystone gate
 * needs — invariants 1, 3 and 5 (plan §6 Wave 3). Wave 5 EXTENDS it to
 * the full set (2, 4, 6, 7); it does not create a parallel module.
 *
 * Each invariant returns a list of violation strings (empty = holds).
 * They operate on the normalised BehaviouralTrace, so they run identically
 * over mock-mode replays, live-mode replays, and (via the C2 extractor)
 * iOS session traces.
 */

import type { BehaviouralTrace, UtteranceTrace } from './trace';
import { isNonCircuitField } from '@/lib/recording/non-circuit-fields';

export type InvariantViolation = string;

/**
 * Invariant 1 (Audio-First #1): every SERVER-EXTRACTION-applied reading —
 * i.e. one paired with a confirmation frame — produces exactly ONE played
 * confirmation. Catches silent-entry, double-confirm, and stranded-defer.
 * Regex-tier instant fills are explicitly EXEMPT (silent by design — the
 * read-back comes from the backend confirmation); same-field/same-value
 * applies across tiers within an utterance are deduped before counting.
 *
 * Trace-level formulation: per utterance, `confirmationsEnqueued` entries
 * must each end in exactly one play — so across the run,
 * played == enqueued − legitimately-deduped, with zero permanently
 * deferred and zero discarded-without-replay.
 */
export function invariant1_everyConfirmationPlaysExactlyOnce(
  trace: BehaviouralTrace
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  if (trace.totals.deferredNeverResumed > 0) {
    violations.push(
      `invariant1: ${trace.totals.deferredNeverResumed} confirmation(s) permanently deferred (stranded head — the A1 bug class)`
    );
  }
  const enqueued = trace.utterances.reduce((n, u) => n + u.confirmationsEnqueued, 0);
  const played = trace.totals.confirmationsPlayed.length;
  const discarded = trace.totals.confirmationsDiscarded;
  if (discarded > 0) {
    violations.push(
      `invariant1: ${discarded} confirmation(s) discarded before playing without replay (preempt-flush/overflow — read-back lost)`
    );
  }
  if (played > enqueued) {
    violations.push(
      `invariant1: ${played} plays for ${enqueued} enqueued confirmations (double-confirm)`
    );
  }
  if (played < enqueued - discarded) {
    violations.push(
      `invariant1: only ${played}/${enqueued} enqueued confirmations played (silent entry)`
    );
  }
  // Exactly-once per confirmation text (post-dedupe: the queue is fed
  // AFTER the session dedupe layer, so a text repeating here is a real
  // double-play).
  const counts = new Map<string, number>();
  for (const text of trace.totals.confirmationsPlayed) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  for (const [text, n] of counts) {
    if (n > 1) violations.push(`invariant1: confirmation played ${n}× — "${text.slice(0, 60)}"`);
  }
  return violations;
}

/**
 * Invariant 3: non-circuit (section) fields never trigger a
 * circuit-disambiguation ask (the A2 bug class).
 */
export function invariant3_noCircuitAskForSectionFields(
  trace: BehaviouralTrace
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const u of trace.utterances) {
    for (const ev of u.events) {
      if (ev.kind !== 'pending_readings_ask') continue;
      const fields = String(ev.payload.fieldsPreview ?? '').split(',');
      for (const f of fields) {
        if (f && isNonCircuitField(f.trim())) {
          violations.push(
            `invariant3: circuit-disambiguation ask for section field "${f.trim()}" after "${u.text.slice(0, 40)}"`
          );
        }
      }
    }
  }
  return violations;
}

/**
 * Invariant 5: chitchat/garble-only utterances → no chime, no field write,
 * no question (the A3 consequence class). The caller declares which
 * utterances are chitchat (scenario `expect.web.gate_blocked` or the
 * generated corpus's chitchat set) — classification is data, not
 * heuristics.
 */
export function invariant5_chitchatIsInert(
  trace: BehaviouralTrace,
  chitchatUtterances: readonly string[]
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const isChitchat = (u: UtteranceTrace) =>
    chitchatUtterances.some((c) => u.text === c || u.text === c.slice(0, 80));
  for (const u of trace.utterances) {
    if (!isChitchat(u)) continue;
    if (u.chimes > 0) {
      violations.push(`invariant5: chitchat "${u.text.slice(0, 40)}" played the chime`);
    }
    if (u.appliedFields.length > 0) {
      violations.push(
        `invariant5: chitchat "${u.text.slice(0, 40)}" wrote fields: ${u.appliedFields
          .map((f) => f.key)
          .join(', ')}`
      );
    }
    if (u.questionsAsked.length > 0 || u.pendingReadingsAsks > 0) {
      violations.push(`invariant5: chitchat "${u.text.slice(0, 40)}" raised a question`);
    }
    if (u.sonnetSent) {
      violations.push(`invariant5: chitchat "${u.text.slice(0, 40)}" was sent to Sonnet`);
    }
  }
  return violations;
}

/** Run the Wave-3 seed set. Wave 5 extends this aggregate. */
export function runSeedInvariants(
  trace: BehaviouralTrace,
  opts: { chitchatUtterances?: readonly string[] } = {}
): InvariantViolation[] {
  return [
    ...invariant1_everyConfirmationPlaysExactlyOnce(trace),
    ...invariant3_noCircuitAskForSectionFields(trace),
    ...invariant5_chitchatIsInert(trace, opts.chitchatUtterances ?? []),
  ];
}
