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
import { shouldForward } from '@/lib/recording/transcript-gate';

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

/**
 * Invariant 2 (Audio-First #1 exception): auto-derivations/mirrors produce
 * ZERO confirmations. Trace formulation: an utterance whose applies came
 * with NO confirmation frames (regex-tier fills, mirror-only patches) must
 * play nothing — silent by design; the read-back comes from the backend
 * confirmation when there is one.
 */
export function invariant2_derivationsAreSilent(trace: BehaviouralTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const u of trace.utterances) {
    if (u.confirmationsEnqueued === 0 && u.confirmationsPlayed.length > 0) {
      violations.push(
        `invariant2: "${u.text.slice(0, 40)}" played ${u.confirmationsPlayed.length} confirmation(s) with none enqueued for it (derivation/mirror must be silent)`
      );
    }
  }
  return violations;
}

/**
 * Invariant 4: a gate PASS requires at least one of the gate's ACTUAL
 * trigger conditions — re-derived by calling the REAL gate with the
 * trace's inputs (fresh regex changedKeys, in-flight-ask candidacy) and
 * the utterance text (digit / strong trigger / observation pattern /
 * weak-trigger + >=3 content words live inside shouldForward). A bare
 * digit re-dictation legitimately passes without a fresh regex change.
 */
export function invariant4_gatePassHasATrigger(trace: BehaviouralTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const u of trace.utterances) {
    if (u.gate !== 'passed') continue;
    const justified = shouldForward({
      // The gate ran on the DISPATCHED (normalised) text — "Two sugars"
      // becomes "2 sugars" and legitimately gains a digit trigger.
      text: u.dispatchedText ?? u.text,
      hasRegexHit: u.regexChangedKeys.length > 0,
      hasPendingAsk: u.hasInFlightAsk,
      inResponseTo: u.hasInResponseTo,
    });
    if (!justified) {
      violations.push(
        `invariant4: "${u.text.slice(0, 40)}" passed the gate with NO trigger (no fresh regex, no ask, not reading-shaped)`
      );
    }
  }
  return violations;
}

/**
 * Invariant 6: obvious chitchat must be gate-BLOCKED (invariant 5 covers
 * the declared set); a gate-passed utterance that applies nothing and asks
 * nothing is allowed ONLY when it is reading-shaped or an in-flight-answer
 * candidate — and two consecutive such no-op turns are a WARN (the
 * dropped-reading detector, mirroring analyze-session's
 * `unmapped_readings`). WARNs are prefixed "WARN:" so callers can split
 * severity.
 */
export function invariant6_noOpPassesAreBounded(trace: BehaviouralTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  let consecutiveNoOps = 0;
  for (const u of trace.utterances) {
    if (u.gate !== 'passed') {
      consecutiveNoOps = 0;
      continue;
    }
    const applied = u.appliedFields.length > 0;
    const asked = u.questionsAsked.length > 0 || u.pendingReadingsAsks > 0;
    if (applied || asked) {
      consecutiveNoOps = 0;
      continue;
    }
    const readingShaped = shouldForward({
      text: u.dispatchedText ?? u.text,
      hasRegexHit: false,
      hasPendingAsk: false,
      inResponseTo: false,
    });
    if (!readingShaped && !u.hasInFlightAsk && !u.hasInResponseTo) {
      violations.push(
        `invariant6: no-op gate pass for non-reading-shaped "${u.text.slice(0, 40)}"`
      );
      consecutiveNoOps = 0;
      continue;
    }
    consecutiveNoOps += 1;
    if (consecutiveNoOps >= 2) {
      violations.push(
        `WARN: invariant6: ${consecutiveNoOps} consecutive no-op gate passes ending at "${u.text.slice(0, 40)}" (dropped-reading detector)`
      );
    }
  }
  return violations;
}

/** Feedback trigger regex — iOS canon `^\s*(?:feedback|debug)\b`
 *  (TranscriptProcessor.swift:233). */
export const FEEDBACK_TRIGGER = /^\s*(?:feedback|debug)\b/i;

/**
 * Invariant 7 (post-A4/Wave-6): a feedback trigger starts capture and
 * suppresses Sonnet/chime; the marker POST occurs exactly once, on
 * explicit exit or session-stop cleanup — never on the trigger or
 * capture-continuation finals.
 */
export function invariant7_feedbackCapture(trace: BehaviouralTrace): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  let captureStarted = false;
  let uploads = 0;
  for (const u of trace.utterances) {
    const isTrigger = FEEDBACK_TRIGGER.test(u.text);
    if (isTrigger) {
      captureStarted = true;
      if (!u.events.some((e) => e.kind.startsWith('feedback_'))) {
        violations.push(`invariant7: trigger "${u.text.slice(0, 40)}" produced no feedback event`);
      }
      if (u.sonnetSent)
        violations.push(`invariant7: trigger "${u.text.slice(0, 40)}" reached Sonnet`);
      if (u.chimes > 0) violations.push(`invariant7: trigger "${u.text.slice(0, 40)}" chimed`);
    }
    uploads += u.events.filter((e) => e.kind === 'feedback_marker_uploaded').length;
  }
  if (captureStarted && uploads > 1) {
    violations.push(`invariant7: marker uploaded ${uploads}x (must be exactly once per capture)`);
  }
  return violations;
}

/** Run the Wave-3 seed set (kept for the keystone lanes). */
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

/**
 * Full D1 set (Wave 5). Invariant 7 joins the FAIL set only once Wave 6
 * ships A4 (`includeFeedback`). WARN-prefixed entries are advisory —
 * callers split them out rather than failing.
 */
export function runAllInvariants(
  trace: BehaviouralTrace,
  opts: { chitchatUtterances?: readonly string[]; includeFeedback?: boolean } = {}
): { failures: InvariantViolation[]; warnings: InvariantViolation[] } {
  const all = [
    ...runSeedInvariants(trace, opts),
    ...invariant2_derivationsAreSilent(trace),
    ...invariant4_gatePassHasATrigger(trace),
    ...invariant6_noOpPassesAreBounded(trace),
    ...(opts.includeFeedback ? invariant7_feedbackCapture(trace) : []),
  ];
  return {
    failures: all.filter((v) => !v.startsWith('WARN:')),
    warnings: all.filter((v) => v.startsWith('WARN:')),
  };
}
