/**
 * expect.web assertion evaluator (pwa-replay-harness Wave 3, B4).
 * Returns violation strings (empty = scenario passes) so the same
 * evaluator drives vitest cases, the keystone red/green proof, and the
 * standalone `npm run pwa-replay` report.
 */

import type { ReplayResult } from './runner';
import type { WebExpectations } from './scenario';
import { runSeedInvariants, invariant7_feedbackCapture } from './invariants';

export function evaluateWebExpectations(
  result: ReplayResult,
  expectations: WebExpectations
): string[] {
  const failures: string[] = [];
  const { trace } = result;
  const byText = (text: string) =>
    trace.utterances.find((u) => u.text === text || u.text === text.slice(0, 80));

  for (const text of expectations.gate_blocked ?? []) {
    const u = byText(text);
    if (!u) failures.push(`gate_blocked: utterance not found in trace — "${text}"`);
    else if (u.gate !== 'blocked') failures.push(`gate_blocked: "${text}" was ${u.gate}`);
  }
  for (const text of expectations.gate_passed ?? []) {
    const u = byText(text);
    if (!u) failures.push(`gate_passed: utterance not found in trace — "${text}"`);
    else if (u.gate !== 'passed') failures.push(`gate_passed: "${text}" was ${u.gate}`);
  }
  if (expectations.chime_count != null && trace.totals.chimes !== expectations.chime_count) {
    failures.push(`chime_count: expected ${expectations.chime_count}, got ${trace.totals.chimes}`);
  }
  if (
    expectations.sonnet_send_count != null &&
    trace.totals.sonnetSends !== expectations.sonnet_send_count
  ) {
    failures.push(
      `sonnet_send_count: expected ${expectations.sonnet_send_count}, got ${trace.totals.sonnetSends}`
    );
  }
  if (
    expectations.pending_readings_ask_count != null &&
    trace.totals.pendingReadingsAsks !== expectations.pending_readings_ask_count
  ) {
    failures.push(
      `pending_readings_ask_count: expected ${expectations.pending_readings_ask_count}, got ${trace.totals.pendingReadingsAsks}`
    );
  }
  for (const rescue of expectations.rescued_from_buffer ?? []) {
    const seen = trace.utterances.some((u) => u.rescuedFromBuffer.includes(rescue.field));
    if (!seen) failures.push(`rescued_from_buffer: no rescue event for field "${rescue.field}"`);
  }
  for (const played of expectations.confirmations_played ?? []) {
    const seen = trace.totals.confirmationsPlayed.some((t) => t.includes(played.contains));
    if (!seen)
      failures.push(`confirmations_played: nothing played containing "${played.contains}"`);
  }
  if (expectations.confirmation_played_exactly_once) {
    const counts = new Map<string, number>();
    for (const t of trace.totals.confirmationsPlayed) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) {
      if (n !== 1)
        failures.push(`confirmation_played_exactly_once: "${t.slice(0, 60)}" played ${n}×`);
    }
  }
  if (expectations.no_confirmation_permanently_deferred && trace.totals.deferredNeverResumed > 0) {
    failures.push(
      `no_confirmation_permanently_deferred: ${trace.totals.deferredNeverResumed} stranded`
    );
  }
  if (
    expectations.no_confirmation_discarded_without_replay &&
    trace.totals.confirmationsDiscarded > 0
  ) {
    failures.push(
      `no_confirmation_discarded_without_replay: ${trace.totals.confirmationsDiscarded} discarded`
    );
  }
  for (const field of expectations.applied_fields ?? []) {
    const seen = trace.utterances.some((u) =>
      u.appliedFields.some(
        (f) => f.key === field.key && String(f.value).trim() === String(field.value).trim()
      )
    );
    if (!seen)
      failures.push(`applied_fields: "${field.key}" never landed with value "${field.value}"`);
  }

  // Seed invariants (D1 1/3/5) run on EVERY scenario; gate_blocked doubles
  // as the chitchat declaration for invariant 5. Invariant 7 (feedback
  // capture) joined at Wave 6 when A4 shipped.
  failures.push(
    ...runSeedInvariants(trace, { chitchatUtterances: expectations.gate_blocked ?? [] }),
    ...invariant7_feedbackCapture(trace)
  );
  return failures;
}

/** A4 xfail block (Wave 3 → removed in Wave 6). Evaluated separately so
 *  the main scenario case stays green while A4 is unshipped. */
export function evaluateA4Expectations(
  result: ReplayResult,
  expectations: NonNullable<WebExpectations['xfail_until_wave6']>
): string[] {
  const failures: string[] = [];
  const { trace } = result;
  for (const text of expectations.feedback_capture_started ?? []) {
    const u = trace.utterances.find((x) => x.text === text || x.text === text.slice(0, 80));
    if (!u) {
      failures.push(`feedback: utterance not found — "${text}"`);
      continue;
    }
    if (!u.events.some((e) => e.kind.startsWith('feedback_'))) {
      failures.push(`feedback: no feedback-marker event for "${text}"`);
    }
    if (u.sonnetSent) failures.push(`feedback: trigger "${text}" was sent to Sonnet`);
    if (u.chimes > 0) failures.push(`feedback: trigger "${text}" chimed`);
    if (u.regexChangedKeys.length > 0) {
      failures.push(`feedback: trigger "${text}" produced regex changedKeys`);
    }
  }
  return failures;
}
