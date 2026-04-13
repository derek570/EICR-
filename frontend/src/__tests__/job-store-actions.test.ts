/**
 * Tests for useJobStore Zustand store actions.
 *
 * The job store is central to the entire app — it holds the live job being
 * edited and propagates updates to both the UI and IndexedDB. These tests
 * verify that the store actions update state correctly and that field updates
 * are reflected synchronously via getState() — the same guarantee relied on
 * by the stale-ref fix in use-recording.ts (applySonnetReadings).
 */

// Mock the Dexie db module — IndexedDB is unavailable in jsdom and the
// store calls saveLocalJob / refreshPendingCount fire-and-forget, so without
// the mock those calls produce unhandled promise rejections.
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

// Minimal valid JobDetail fixture
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
      location: 'Under stairs',
      phases: '1',
      max_demand_a: '',
      manufacturer: 'Hager',
      type: 'Consumer unit',
      rating_a: '100',
      rcd: '',
      rcd_rating: '',
      rcd_operating_time: '',
      num_ways: '12',
      zs_at_db: '',
    },
    ...overrides,
  } as JobDetail;
}

// Reset store to a clean state between tests
beforeEach(() => {
  useJobStore.setState({ currentJob: null, userId: null, isDirty: false });
});

describe('useJobStore — state management', () => {
  describe('initial state', () => {
    it('starts with no current job', () => {
      expect(useJobStore.getState().currentJob).toBeNull();
    });

    it('starts with isDirty = false', () => {
      expect(useJobStore.getState().isDirty).toBe(false);
    });
  });

  describe('clearJob', () => {
    it('clears the current job and resets dirty flag', () => {
      const job = makeJob();
      useJobStore.setState({ currentJob: job, isDirty: true });

      useJobStore.getState().clearJob();

      expect(useJobStore.getState().currentJob).toBeNull();
      expect(useJobStore.getState().isDirty).toBe(false);
    });
  });

  describe('updateCircuits', () => {
    it('updates circuits and marks store dirty', () => {
      const job = makeJob();
      useJobStore.setState({ currentJob: job, userId: 'u1' });

      const circuits = [
        { circuit_ref: '1', circuit_designation: 'Lighting', r1_r2_ohm: '0.45' },
      ] as JobDetail['circuits'];

      useJobStore.getState().updateCircuits(circuits);

      const state = useJobStore.getState();
      expect(state.currentJob?.circuits[0].r1_r2_ohm).toBe('0.45');
      expect(state.isDirty).toBe(true);
    });

    it('updates are immediately visible via getState() without a render cycle', () => {
      const job = makeJob();
      useJobStore.setState({ currentJob: job, userId: 'u1' });

      // This simulates the race the stale-ref fix addresses: user edits a
      // circuit field, then applySonnetReadings fires synchronously. Without
      // getState(), a stale ref would overwrite the user's value.
      useJobStore
        .getState()
        .updateCircuits([
          { circuit_ref: '1', circuit_designation: 'Ring main', r1_r2_ohm: '0.12' },
        ] as JobDetail['circuits']);

      // No React render needed — getState() sees the new value immediately
      expect(useJobStore.getState().currentJob?.circuits[0].r1_r2_ohm).toBe('0.12');
    });
  });

  describe('updateInstallationDetails', () => {
    it('updates installation details and marks dirty', () => {
      const job = makeJob({
        installation_details: {
          client_name: '',
          address: '',
          premises_description: 'Flat',
          installation_records_available: false,
          evidence_of_additions_alterations: false,
          next_inspection_years: 5,
        } as JobDetail['installation_details'],
      });
      useJobStore.setState({ currentJob: job, userId: 'u1' });

      useJobStore.getState().updateInstallationDetails({
        ...job.installation_details!,
        client_name: 'Jane Doe',
        address: '42 Example Road',
      });

      const updated = useJobStore.getState().currentJob?.installation_details;
      expect(updated?.client_name).toBe('Jane Doe');
      expect(updated?.address).toBe('42 Example Road');
      expect(useJobStore.getState().isDirty).toBe(true);
    });
  });

  describe('updateBoardInfo', () => {
    it('updates board info synchronously', () => {
      const job = makeJob();
      useJobStore.setState({ currentJob: job, userId: 'u1' });

      useJobStore.getState().updateBoardInfo({
        ...job.board_info,
        zs_at_db: '0.42',
        num_ways: '16',
      });

      const board = useJobStore.getState().currentJob?.board_info;
      expect(board?.zs_at_db).toBe('0.42');
      expect(board?.num_ways).toBe('16');
    });
  });

  describe('no-op when job is null', () => {
    it('updateCircuits does nothing when currentJob is null', () => {
      // No job set — store has currentJob: null
      expect(() => {
        useJobStore.getState().updateCircuits([]);
      }).not.toThrow();

      // State remains clean
      expect(useJobStore.getState().isDirty).toBe(false);
    });
  });
});
