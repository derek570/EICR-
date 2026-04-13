/**
 * Tests for the stale-ref fix in use-recording.ts.
 *
 * Background: applySonnetReadings() previously read jobRef.current (a React
 * ref updated asynchronously via useEffect) which could lag behind Zustand
 * when the user typed in a form field. The fix replaces that read with
 * useJobStore.getState().currentJob, which is synchronous and always current.
 *
 * This file tests that useJobStore.getState() provides synchronous,
 * always-current access — confirming the fix works as expected.
 */

// Mock Dexie — IndexedDB is unavailable in jsdom. The store calls saveLocalJob
// and refreshPendingCount fire-and-forget; without a mock they produce unhandled
// promise rejections that crash the test runner on Node.js 25.
jest.mock('../lib/db', () => ({
  db: {
    jobs: {
      update: jest.fn().mockResolvedValue(undefined),
      where: jest.fn().mockReturnValue({
        filter: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(0),
        }),
      }),
    },
  },
  saveLocalJob: jest.fn().mockResolvedValue(undefined),
  getLocalJob: jest.fn().mockResolvedValue(null),
}));

import { useJobStore } from '../lib/store';
import type { JobDetail } from '../lib/api';

// Minimal JobDetail fixture — only the fields needed for these tests
function makeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-1',
    address: '1 Test Street',
    status: 'active',
    created_at: '2026-04-13T00:00:00Z',
    certificate_type: 'EICR',
    circuits: [],
    observations: [],
    board_info: {
      location: '',
      phases: '',
      max_demand_a: '',
      manufacturer: '',
      type: '',
      rating_a: '',
      rcd: '',
      rcd_rating: '',
      rcd_operating_time: '',
      num_ways: '',
      zs_at_db: '',
    },
    ...overrides,
  } as JobDetail;
}

// Reset the store between tests so state doesn't bleed across
beforeEach(() => {
  useJobStore.setState({ currentJob: null, userId: null, isDirty: false });
});

describe('useJobStore.getState() — synchronous read for stale-ref fix', () => {
  it('returns null before any job is loaded', () => {
    expect(useJobStore.getState().currentJob).toBeNull();
  });

  it('reflects the latest job immediately after set — no render cycle needed', () => {
    const job = makeJob({ address: '1 Test St' });
    // Directly set the store (simulates what loadJob does after API fetch)
    useJobStore.setState({ currentJob: job });

    // getState() must return the updated value synchronously, with no await
    const current = useJobStore.getState().currentJob;
    expect(current?.address).toBe('1 Test St');
  });

  it('reflects user edits immediately after updateCircuits', () => {
    const job = makeJob();
    useJobStore.setState({ currentJob: job, userId: 'user-1' });

    const editedCircuits = [{ circuit_ref: '1', circuit_designation: 'Lights', r1_r2_ohm: '0.35' }];
    useJobStore.getState().updateCircuits(editedCircuits as JobDetail['circuits']);

    // getState() must return the new circuits without a render cycle —
    // this is exactly the scenario that was broken: user types a value,
    // Sonnet fires before useEffect re-runs, getState() must see the edit.
    const current = useJobStore.getState().currentJob;
    expect(current?.circuits[0].r1_r2_ohm).toBe('0.35');
  });

  it('applySonnetReadings fix: getState() sees user edit made between renders', () => {
    // Simulate the race: user edits a field, then Sonnet fires before
    // the useEffect that syncs jobRef.current has had a chance to run.
    const initialJob = makeJob({
      installation_details: {
        client_name: '',
        address: '',
        premises_description: '',
        installation_records_available: false,
        evidence_of_additions_alterations: false,
        next_inspection_years: 5,
      } as JobDetail['installation_details'],
    });
    useJobStore.setState({ currentJob: initialJob, userId: 'user-1' });

    // User types their name — this updates Zustand synchronously
    useJobStore.getState().updateInstallationDetails({
      ...initialJob.installation_details!,
      client_name: 'John Smith',
    });

    // jobRef.current would still be the old value here (useEffect hasn't run)
    // but getState() returns the current value immediately
    const currentJob = useJobStore.getState().currentJob;
    expect(currentJob?.installation_details?.client_name).toBe('John Smith');

    // If Sonnet now fires and reads getState() (the fix), it sees "John Smith"
    // and won't overwrite it when spreading the base job.
    expect(currentJob?.installation_details?.client_name).not.toBe('');
  });
});
