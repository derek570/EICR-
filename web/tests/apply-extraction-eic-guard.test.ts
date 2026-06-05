/**
 * apply-extraction — M7 EIC cert-type guards.
 *
 * iOS `applySonnetObservations` :5473 early-returns when the job's
 * certificate_type is `.eic` (EICs are for new installs and must
 * not carry observations). Same path drops EICR-only installation
 * fields. PWA pre-fix had neither guard — defence-in-depth gap.
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
    certificate_type: 'EIC',
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

describe('apply-extraction M7 — EIC cert-type guards', () => {
  it('drops observations entirely when cert is EIC', () => {
    const result = makeResult({
      observations: [{ observation_text: 'Loose terminal', code: 'C2' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('strips EICR-only installation fields when cert is EIC', () => {
    const result = makeResult({
      readings: [
        { circuit: 0, field: 'client_name', value: 'Alice' },
        { circuit: 0, field: 'reason_for_report', value: 'Routine' },
        { circuit: 0, field: 'general_condition', value: 'Acceptable' },
        { circuit: 0, field: 'estimated_age_of_installation', value: '15 years' },
        { circuit: 0, field: 'previous_certificate_number', value: 'X-123' },
        { circuit: 0, field: 'date_of_previous_inspection', value: '2020-01-01' },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.client_name).toBe('Alice'); // EICR + EIC overlap
    expect(install.reason_for_report).toBeUndefined();
    expect(install.general_condition).toBeUndefined();
    expect(install.general_condition_of_installation).toBeUndefined();
    expect(install.estimated_age_of_installation).toBeUndefined();
    expect(install.previous_certificate_number).toBeUndefined();
    expect(install.date_of_previous_inspection).toBeUndefined();
  });

  it('does NOT strip EICR-only fields on an EICR job', () => {
    const job = makeJob({ certificate_type: 'EICR' });
    const result = makeResult({
      readings: [
        { circuit: 0, field: 'reason_for_report', value: 'Routine' },
        { circuit: 0, field: 'general_condition', value: 'Acceptable' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.reason_for_report).toBe('Routine');
    expect(install.general_condition).toBe('Acceptable');
  });
});
