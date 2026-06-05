/**
 * apply-regex-match unit tests — locks the 3-tier write-priority
 * behaviour the FieldSourceTracker enforces, and the JobDetail patch
 * shape the recording-context.tsx wiring depends on.
 *
 * Critical invariants:
 *   - regex never overwrites Sonnet OR pre-existing
 *   - regex CAN overwrite a previous regex write (last-hit-wins)
 *   - changedKeys list matches FieldSourceTracker keys (so liveFill
 *     and buildRegexSummary see the same keys)
 *   - circuit cells route by row UUID (not circuit_ref)
 *   - empty result returns null (caller can skip updateJob)
 */
import { describe, it, expect } from 'vitest';
import { applyRegexMatchToJob } from '@/lib/recording/apply-regex-match';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import type { RegexMatchResult } from '@/lib/recording/regex-match-result';
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

describe('applyRegexMatchToJob', () => {
  it('returns null when nothing matched', () => {
    const tracker = new FieldSourceTracker();
    const out = applyRegexMatchToJob(makeJob(), makeResult(), tracker);
    expect(out).toBeNull();
  });

  it('writes ze on a fresh job and reports the key', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).not.toBeNull();
    expect(out!.patch.supply_characteristics).toEqual({ ze: '0.34' });
    expect(out!.changedKeys).toEqual(['supply.ze']);
    expect(tracker.getSource('supply.ze')).toBe('regex');
  });

  it('does not overwrite a pre-existing supply value', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({ supply_characteristics: { ze: '0.50' } });
    tracker.seedFromJob(job);
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).toBeNull();
    expect(tracker.getSource('supply.ze')).toBe('preExisting');
  });

  it('does not overwrite a Sonnet-owned field', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    tracker.recordSonnetWrite('supply.ze');
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).toBeNull();
    expect(tracker.getSource('supply.ze')).toBe('sonnet');
  });

  it('overwrites a previous regex write (last-hit-wins)', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out1 = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out1?.patch.supply_characteristics).toEqual({ ze: '0.34' });
    const out2 = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.42' } }), tracker);
    expect(out2?.patch.supply_characteristics).toEqual({ ze: '0.42' });
    expect(tracker.getSource('supply.ze')).toBe('regex');
  });

  it('routes main_switch_* to board_info', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out = applyRegexMatchToJob(
      job,
      makeResult({
        supply_updates: { main_switch_current: '100', main_switch_bs_en: '60898' },
      }),
      tracker
    );
    expect(out!.patch.board_info).toEqual({
      main_switch_current: '100',
      main_switch_bs_en: '60898',
    });
    expect(out!.patch.supply_characteristics).toBeUndefined();
    expect(out!.changedKeys.sort()).toEqual([
      'board.main_switch_bs_en',
      'board.main_switch_current',
    ]);
  });

  it('routes circuit_updates by row UUID', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({
      circuits: [
        { id: 'row-uuid-A', circuit_ref: '1', circuit_designation: 'Lights' },
        { id: 'row-uuid-B', circuit_ref: '2', circuit_designation: 'Sockets' },
      ],
    });
    const out = applyRegexMatchToJob(
      job,
      makeResult({
        circuit_updates: { '1': { measured_zs_ohm: '0.72' } },
      }),
      tracker
    );
    expect(out).not.toBeNull();
    expect(out!.changedKeys).toEqual(['circuit.row-uuid-A.measured_zs_ohm']);
    expect(out!.patch.circuits?.[0]).toMatchObject({
      id: 'row-uuid-A',
      circuit_ref: '1',
      measured_zs_ohm: '0.72',
    });
    expect(out!.patch.circuits?.[1]).toMatchObject({ id: 'row-uuid-B', circuit_ref: '2' });
    expect((out!.patch.circuits![1] as Record<string, unknown>).measured_zs_ohm).toBeUndefined();
    expect(tracker.getSource('circuit.row-uuid-A.measured_zs_ohm')).toBe('regex');
  });

  it('drops circuit_updates whose ref is not in the job (out of scope here)', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({ circuits: [{ id: 'a', circuit_ref: '1', circuit_designation: 'L' }] });
    const out = applyRegexMatchToJob(
      job,
      makeResult({ circuit_updates: { '99': { measured_zs_ohm: '0.5' } } }),
      tracker
    );
    expect(out).toBeNull();
  });

  it('consumeTurnWrites returns and clears between calls', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(tracker.consumeTurnWrites()).toEqual(['supply.ze']);
    // Second call against same tracker — no new writes, consumeTurnWrites empty.
    expect(tracker.consumeTurnWrites()).toEqual([]);
  });
});
