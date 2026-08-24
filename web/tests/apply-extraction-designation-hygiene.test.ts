/**
 * PLAN-B2 (B2-2, wire-frame apply half) — designation hygiene at the
 * ONE web wire mutation point (`applyExtractionToJob`), which also
 * serves onCircuitCreated/onCircuitUpdated via their synthetic
 * envelopes.
 *
 * PLAN-B guarantees the backend never EMITS a raw designation post-fix,
 * but stale frames, replays, and not-yet-deployed-backend windows still
 * reach this path. Pinned: create+measured and rename+measured stale
 * sequences write CANONICAL storage; banned-token-only values apply
 * unchanged (never blanked to spare).
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

const MAIN = 'main';

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
    boards: [{ id: MAIN, designation: 'DB-1', board_type: 'main' }],
    circuits: [],
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    confirmations: [],
    validation_alerts: [],
    observations: [],
    field_clears: [],
    circuit_updates: [],
    ...over,
  } as unknown as ExtractionResult;
}

const rows = (patch: Partial<JobDetail> | null | undefined) =>
  (patch?.circuits ?? []) as Array<Record<string, unknown>>;

describe('circuit_updates — designation canonicalised at wire entry', () => {
  it('stale CREATE carrying a raw designation stores the canonical (create+measured sequence)', () => {
    const applied = applyExtractionToJob(
      makeJob(),
      makeResult({
        circuit_updates: [
          { action: 'create', circuit: 3, designation: 'Downstairs light circuit' },
        ] as unknown as ExtractionResult['circuit_updates'],
        readings: [
          { field: 'measured_zs_ohm', value: '0.35', circuit: 3 },
        ] as unknown as ExtractionResult['readings'],
      })
    );
    const created = rows(applied?.patch).find((r) => r.circuit_ref === '3');
    expect(created?.circuit_designation).toBe('Downstairs light');
    expect(created?.measured_zs_ohm).toBe('0.35');
  });

  it('stale RENAME carrying a raw designation overwrites with the canonical', () => {
    const applied = applyExtractionToJob(
      makeJob({
        circuits: [
          { id: 'c5', circuit_ref: '5', circuit_designation: 'Old name', board_id: MAIN },
        ] as unknown as JobDetail['circuits'],
      }),
      makeResult({
        circuit_updates: [
          { action: 'rename', circuit: 5, designation: 'Garage supply circuit', board_id: MAIN },
        ] as unknown as ExtractionResult['circuit_updates'],
      })
    );
    expect(rows(applied?.patch).find((r) => r.circuit_ref === '5')?.circuit_designation).toBe(
      'Garage supply'
    );
  });

  it('banned-token-only designation applies UNCHANGED (blanking would flip the row to spare)', () => {
    const applied = applyExtractionToJob(
      makeJob(),
      makeResult({
        circuit_updates: [
          { action: 'create', circuit: 1, designation: 'Circuit' },
        ] as unknown as ExtractionResult['circuit_updates'],
      })
    );
    expect(rows(applied?.patch).find((r) => r.circuit_ref === '1')?.circuit_designation).toBe(
      'Circuit'
    );
  });
});

describe('readings routed to circuit_designation — canonicalised before the row write', () => {
  it('a designation READING repairs before mutation', () => {
    const applied = applyExtractionToJob(
      makeJob({
        circuits: [
          { id: 'c2', circuit_ref: '2', circuit_designation: '', board_id: MAIN },
        ] as unknown as JobDetail['circuits'],
      }),
      makeResult({
        readings: [
          { field: 'circuit_designation', value: 'Upstairs lighting circuit', circuit: 2 },
        ] as unknown as ExtractionResult['readings'],
      })
    );
    expect(rows(applied?.patch).find((r) => r.circuit_ref === '2')?.circuit_designation).toBe(
      'Upstairs lighting'
    );
  });

  it('interior tokens and hyphen compounds survive untouched', () => {
    const applied = applyExtractionToJob(
      makeJob({
        circuits: [
          { id: 'c2', circuit_ref: '2', circuit_designation: '', board_id: MAIN },
        ] as unknown as JobDetail['circuits'],
      }),
      makeResult({
        readings: [
          { field: 'circuit_designation', value: 'Ring circuit sockets', circuit: 2 },
        ] as unknown as ExtractionResult['readings'],
      })
    );
    expect(rows(applied?.patch).find((r) => r.circuit_ref === '2')?.circuit_designation).toBe(
      'Ring circuit sockets'
    );
  });
});
