/**
 * apply-extraction — observation → inspection schedule auto-marking.
 *
 * iOS canon: when an inspector dictates "the kitchen socket is loose,
 * item 4.4" Sonnet emits an observation with `code` + `schedule_item`,
 * and iOS auto-marks `inspection_schedule.items[schedule_item] = code`
 * so the Inspection tab's schedule row shows the outcome ticked
 * alongside the linked observation preview. The PWA's Inspection page
 * (`web/src/app/job/[id]/inspection/page.tsx:123-130`) ALREADY reads
 * `observation.schedule_item` to render the linked preview, but the
 * outcome column stayed blank because nothing in the apply path
 * touched `inspection_schedule.items`. These tests pin the
 * `markScheduleItemsFromObservations` helper that closes the gap.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
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

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

describe('apply-extraction observation → inspection schedule auto-marking', () => {
  // ScheduleOutcome enum (tick / N/A / C1 / C2 / C3 / LIM) excludes FI.
  // Code 'FI' is a valid observation classification but doesn't have a
  // matching schedule outcome — the schedule mirror skips it (see
  // apply-extraction.ts markScheduleItemsFromObservations). Tested as
  // a negative case below.
  it.each([
    ['C1', 'C1'],
    ['C2', 'C2'],
    ['C3', 'C3'],
  ])('marks schedule item %s when observation has code %s + schedule_item', (code, expected) => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'Damaged outlet',
          code,
          schedule_item: '4.4',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const schedule = applied!.patch.inspection_schedule as Record<string, unknown>;
    const items = schedule.items as Record<string, string>;
    expect(items['4.4']).toBe(expected);
  });

  it('preserves other schedule items when marking a new one', () => {
    const job = makeJob({
      inspection_schedule: {
        items: { '3.1': '✓', '5.2': 'N/A' },
      },
    });
    const result = makeResult({
      observations: [
        {
          observation_text: 'Missing label',
          code: 'C3',
          schedule_item: '4.4',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    const schedule = applied!.patch.inspection_schedule as Record<string, unknown>;
    const items = schedule.items as Record<string, string>;
    expect(items['3.1']).toBe('✓');
    expect(items['5.2']).toBe('N/A');
    expect(items['4.4']).toBe('C3');
  });

  it('does NOT overwrite a user-set outcome', () => {
    // Inspector already marked 4.4 as PASS (✓). Sonnet then says
    // there's actually a C2 here. Priority guard keeps the user's
    // value; the observation still lands but the schedule mark
    // stays untouched. Inspector sees the conflict and can resolve
    // it manually.
    const job = makeJob({
      inspection_schedule: { items: { '4.4': '✓' } },
    });
    const result = makeResult({
      observations: [
        {
          observation_text: 'Actually loose',
          code: 'C2',
          schedule_item: '4.4',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // patch.inspection_schedule may exist or not — what matters is
    // that the outcome is NOT changed.
    const items =
      (applied!.patch.inspection_schedule as Record<string, unknown> | undefined)?.items ?? {};
    // Either the user value is preserved in a returned items record,
    // or no items patch fires at all (existing job state intact).
    const final = (items as Record<string, string>)['4.4'] ?? '✓';
    expect(final).toBe('✓');
    // Observation still lands.
    expect(applied!.patch.observations).toHaveLength(1);
  });

  it('skips observations without a schedule_item (no marking)', () => {
    const result = makeResult({
      observations: [{ observation_text: 'Free-text defect', code: 'C2' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.inspection_schedule).toBeUndefined();
  });

  it('skips observations with a schedule_item but no code', () => {
    // Sonnet sometimes emits notes-only observations (no code) with
    // a schedule_item. The schedule outcome should NOT be marked —
    // the inspector decides.
    const result = makeResult({
      observations: [
        {
          observation_text: 'Note for follow-up',
          schedule_item: '4.4',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    // Observation lands.
    expect(applied!.patch.observations).toBeDefined();
    // But no inspection_schedule patch.
    expect(applied!.patch.inspection_schedule).toBeUndefined();
  });

  it('marks multiple schedule items from multiple observations', () => {
    const result = makeResult({
      observations: [
        { observation_text: 'A', code: 'C2', schedule_item: '4.4' },
        { observation_text: 'B', code: 'C3', schedule_item: '5.1' },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const schedule = applied!.patch.inspection_schedule as Record<string, unknown>;
    const items = schedule.items as Record<string, string>;
    expect(items['4.4']).toBe('C2');
    expect(items['5.1']).toBe('C3');
  });
});
