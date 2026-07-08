/**
 * A3 — value-equality freshness gate in the regex apply layer
 * (sess_mrbnds2d_jczh, 2026-07-08).
 *
 * The matcher deliberately re-scans a CUMULATIVE transcript window
 * (cross-utterance carryover; iOS re-scans cumulatively too). Pre-fix the
 * apply layer had no value-equality check, so after "Customer is Michael
 * Payden." matched once, EVERY later utterance ("What do you mean?",
 * "Feedback.") re-reported `install.client_name` as changed →
 * `hadRegexHit=true` → TranscriptGate PASSED → sent-for-processing chime →
 * Sonnet extracted nothing → silence. It also reset the backend chitchat
 * pause counter every turn.
 *
 * iOS freshness canon: `applyRegexValue`'s `newValue != currentValue`
 * (DeepgramRecordingViewModel.swift:7577-7595) feeds `thisTurnRegexWrites`
 * → the gate's `hasRegexHit`. This suite pins the ported mechanism on BOTH
 * env paths: hints-ON (apply + job-state baseline) and hints-OFF
 * (gate-only + per-session shadow baseline — the value is never written to
 * the job in that mode, so job state would leave every re-hit fresh
 * forever).
 */
import { describe, it, expect } from 'vitest';
import {
  applyRegexMatchToJob,
  computeFreshRegexWrites,
  jobBaselineReader,
  shadowBaselineReader,
  valuesEqualAfterTrim,
} from '@/lib/recording/apply-regex-match';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import { buildRegexSummary, type RegexMatchResult } from '@/lib/recording/regex-match-result';
import { shouldForward } from '@/lib/recording/transcript-gate';
import type { JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<RegexMatchResult> = {}): RegexMatchResult {
  return {
    supply_updates: {},
    circuit_updates: {},
    board_updates: {},
    installation_updates: {},
    new_circuits: [],
    ...over,
  };
}

describe('valuesEqualAfterTrim', () => {
  it('trims and stringifies both sides', () => {
    expect(valuesEqualAfterTrim(' 0.35 ', '0.35')).toBe(true);
    expect(valuesEqualAfterTrim(0.35, '0.35')).toBe(true);
    expect(valuesEqualAfterTrim(true, 'true')).toBe(true);
    expect(valuesEqualAfterTrim('0.35', '0.42')).toBe(false);
  });
  it('null/undefined fold to empty — never equal a real value', () => {
    expect(valuesEqualAfterTrim(null, '0.35')).toBe(false);
    expect(valuesEqualAfterTrim(undefined, null)).toBe(true);
    expect(valuesEqualAfterTrim('', null)).toBe(true);
  });
});

describe('applyRegexMatchToJob freshness (hints-ON path, job-state baseline)', () => {
  it('repeat of an unchanged value produces NO changedKeys (returns null)', () => {
    const tracker = new FieldSourceTracker();
    let job = makeJob();
    const result = makeResult({
      installation_updates: { client_name: 'Michael Payden' },
    });
    const first = applyRegexMatchToJob(job, result, tracker);
    expect(first).not.toBeNull();
    expect(first!.changedKeys).toEqual(['install.client_name']);
    // recording-context folds the patch into jobRef before the next pass.
    job = { ...job, ...(first!.patch as Partial<JobDetail>) };
    // The cumulative matcher re-emits the SAME value on the next utterance.
    const second = applyRegexMatchToJob(job, result, tracker);
    expect(second).toBeNull(); // phantom re-hit — not fresh
  });

  it('a genuinely CHANGED value for the same field still writes', () => {
    const tracker = new FieldSourceTracker();
    let job = makeJob();
    const first = applyRegexMatchToJob(
      job,
      makeResult({ installation_updates: { client_name: 'Michael Payden' } }),
      tracker
    );
    job = { ...job, ...(first!.patch as Partial<JobDetail>) };
    const second = applyRegexMatchToJob(
      job,
      makeResult({ installation_updates: { client_name: 'Michael Hayden' } }),
      tracker
    );
    expect(second).not.toBeNull();
    expect(second!.changedKeys).toEqual(['install.client_name']);
    expect((second!.patch.installation_details as Record<string, unknown>).client_name).toBe(
      'Michael Hayden'
    );
  });

  it('circuit-cell re-hit of an unchanged value is not fresh', () => {
    const tracker = new FieldSourceTracker();
    let job = makeJob({
      circuits: [{ id: 'row-1', circuit_ref: '1', measured_zs_ohm: null }],
    } as unknown as Partial<JobDetail>);
    const result = makeResult({
      circuit_updates: { '1': { measured_zs_ohm: '0.35' } },
    } as unknown as Partial<RegexMatchResult>);
    const first = applyRegexMatchToJob(job, result, tracker);
    expect(first).not.toBeNull();
    job = { ...job, ...(first!.patch as Partial<JobDetail>) };
    expect(applyRegexMatchToJob(job, result, tracker)).toBeNull();
  });
});

describe('computeFreshRegexWrites (hints-OFF path, shadow baseline)', () => {
  it('first hit fresh → shadow advanced → same-value re-hit not fresh → changed value fresh', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob(); // never patched in hints-OFF mode
    const shadow = new Map<string, unknown>();

    const first = computeFreshRegexWrites(
      job,
      makeResult({ installation_updates: { client_name: 'Michael Payden' } }),
      tracker,
      shadowBaselineReader(shadow)
    );
    expect(first).toHaveLength(1);
    for (const c of first) shadow.set(c.trackerKey, c.value); // recording-context wiring

    // Chitchat utterance — cumulative matcher re-emits the same value.
    const reHit = computeFreshRegexWrites(
      job,
      makeResult({ installation_updates: { client_name: 'Michael Payden' } }),
      tracker,
      shadowBaselineReader(shadow)
    );
    expect(reHit).toEqual([]); // job untouched, but the shadow blocks it

    const changed = computeFreshRegexWrites(
      job,
      makeResult({ installation_updates: { client_name: 'Michael Hayden' } }),
      tracker,
      shadowBaselineReader(shadow)
    );
    expect(changed).toHaveLength(1);
  });

  it('job-state baseline alone would NOT block hints-OFF re-hits (why the shadow exists)', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob(); // hints-OFF: value never written
    const result = makeResult({ installation_updates: { client_name: 'Michael Payden' } });
    // Against the (never-updated) job, the re-hit still looks fresh — this
    // pins the round-2 reviewer finding that motivated the shadow map.
    const second = computeFreshRegexWrites(job, result, tracker, jobBaselineReader(job));
    expect(second).toHaveLength(1);
  });
});

describe('A3 gate consequence — sess_mrbnds2d_jczh sequence (real matcher + real gate)', () => {
  /** Replays the recorded sequence through the REAL cumulative matcher, the
   *  REAL apply/freshness layer, and the REAL TranscriptGate, mirroring the
   *  recording-context glue for each env path. */
  function runSequenceHintsOn(utterances: string[]): boolean[] {
    const matcher = new TranscriptFieldMatcher();
    const tracker = new FieldSourceTracker();
    let job = makeJob();
    let cumulative = '';
    const gateDecisions: boolean[] = [];
    for (const text of utterances) {
      cumulative += (cumulative ? ' ' : '') + text;
      const matchResult = matcher.match(cumulative, job);
      const applied = applyRegexMatchToJob(job, matchResult, tracker);
      if (applied) job = { ...job, ...(applied.patch as Partial<JobDetail>) };
      const writtenKeys = tracker.consumeTurnWrites();
      const regexResults = buildRegexSummary(writtenKeys, job);
      const gateRegexHit = Array.isArray(regexResults) && regexResults.length > 0;
      gateDecisions.push(
        shouldForward({
          text,
          hasRegexHit: gateRegexHit,
          hasPendingAsk: false,
          inResponseTo: false,
        })
      );
    }
    return gateDecisions;
  }

  function runSequenceHintsOff(utterances: string[]): boolean[] {
    const matcher = new TranscriptFieldMatcher();
    const tracker = new FieldSourceTracker();
    const job = makeJob(); // never patched in this mode
    const shadow = new Map<string, unknown>();
    let cumulative = '';
    const gateDecisions: boolean[] = [];
    for (const text of utterances) {
      cumulative += (cumulative ? ' ' : '') + text;
      const matchResult = matcher.match(cumulative, job);
      const fresh = computeFreshRegexWrites(
        job,
        matchResult,
        tracker,
        shadowBaselineReader(shadow)
      );
      for (const c of fresh) shadow.set(c.trackerKey, c.value);
      gateDecisions.push(
        shouldForward({
          text,
          hasRegexHit: fresh.length > 0,
          hasPendingAsk: false,
          inResponseTo: false,
        })
      );
    }
    return gateDecisions;
  }

  // The exact recorded sequence: name statement, then pure chitchat that
  // pre-fix re-hit install.client_name and chimed on every line.
  const SESSION_SEQUENCE = ['Customer is Michael Payden.', 'What do you mean?', 'Feedback.'];

  it('hints-ON: name utterance passes, later chitchat no longer chimes (gate-blocked)', () => {
    const decisions = runSequenceHintsOn(SESSION_SEQUENCE);
    expect(decisions[0]).toBe(true); // fresh client_name → chime + send
    expect(decisions[1]).toBe(false); // phantom re-hit blocked → silence
    expect(decisions[2]).toBe(false);
  });

  it('hints-OFF: same gate decisions via the shadow baseline', () => {
    const decisions = runSequenceHintsOff(SESSION_SEQUENCE);
    expect(decisions[0]).toBe(true);
    expect(decisions[1]).toBe(false);
    expect(decisions[2]).toBe(false);
  });

  it('hints-OFF: a genuinely changed value later in the session still passes', () => {
    const decisions = runSequenceHintsOff([
      'Customer is Michael Payden.',
      'What do you mean?',
      'Customer is Michael Hayden.',
    ]);
    expect(decisions).toEqual([true, false, true]);
  });
});
