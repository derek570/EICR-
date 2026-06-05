/**
 * Cross-reload session-resume persistence tests.
 *
 * Covers the sessionStorage round-trip + TTL gate + status filter +
 * validation. Mirrors the iOS app-process state-survival contract:
 * persist on every state change, surface on next mount if within the
 * 5-min Sonnet TTL window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDING_RESUME_TTL_MS,
  clearRecordingState,
  loadAndConsumeRecordingState,
  peekRecordingState,
  persistRecordingState,
  type PersistedRecordingState,
} from '@/lib/recording/session-resume';

const baseState: PersistedRecordingState = {
  clientSessionId: 'sess_abc_def',
  serverSessionId: 'srv-12345',
  jobId: 'job_99',
  certificateType: 'EICR',
  status: 'active',
  startedAt: 1_700_000_000_000,
  lastUpdatedAt: 1_700_000_000_000,
};

describe('session-resume', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  describe('persist + load round-trip', () => {
    it('round-trips a healthy active-status state within TTL', () => {
      persistRecordingState(baseState);
      const loaded = loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1_000);
      expect(loaded).toEqual(baseState);
    });

    it('round-trips a sleeping-status state', () => {
      const state = { ...baseState, status: 'sleeping' as const };
      persistRecordingState(state);
      const loaded = loadAndConsumeRecordingState(state.lastUpdatedAt + 1_000);
      expect(loaded?.status).toBe('sleeping');
    });

    it('preserves a null serverSessionId (first ack not yet received)', () => {
      const state = { ...baseState, serverSessionId: null };
      persistRecordingState(state);
      const loaded = loadAndConsumeRecordingState(state.lastUpdatedAt + 1_000);
      expect(loaded?.serverSessionId).toBeNull();
    });
  });

  describe('TTL gate', () => {
    it('returns the state when within RECORDING_RESUME_TTL_MS', () => {
      persistRecordingState(baseState);
      const justInsideTtl = baseState.lastUpdatedAt + RECORDING_RESUME_TTL_MS - 1;
      expect(loadAndConsumeRecordingState(justInsideTtl)).not.toBeNull();
    });

    it('returns null when TTL has expired', () => {
      persistRecordingState(baseState);
      const justOutsideTtl = baseState.lastUpdatedAt + RECORDING_RESUME_TTL_MS + 1;
      expect(loadAndConsumeRecordingState(justOutsideTtl)).toBeNull();
    });

    it('measures TTL from lastUpdatedAt (not startedAt) — long sessions that just got reaped are still eligible', () => {
      const state: PersistedRecordingState = {
        ...baseState,
        startedAt: 1_700_000_000_000, // 30 min ago
        lastUpdatedAt: 1_700_000_000_000 + 30 * 60 * 1000, // updated 30s ago from "now"
      };
      persistRecordingState(state);
      // "Now" is 30s after the lastUpdate.
      const now = state.lastUpdatedAt + 30_000;
      expect(loadAndConsumeRecordingState(now)).not.toBeNull();
    });
  });

  describe('validation', () => {
    it('returns null for malformed JSON', () => {
      sessionStorage.setItem('cm-recording-resume-state', '{not json');
      expect(loadAndConsumeRecordingState()).toBeNull();
    });

    it('returns null when status is "paused" (intentional stop, not a reap)', () => {
      sessionStorage.setItem(
        'cm-recording-resume-state',
        JSON.stringify({ ...baseState, status: 'paused' })
      );
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).toBeNull();
    });

    it('returns null when status is "error"', () => {
      sessionStorage.setItem(
        'cm-recording-resume-state',
        JSON.stringify({ ...baseState, status: 'error' })
      );
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).toBeNull();
    });

    it('returns null when certificateType is invalid', () => {
      sessionStorage.setItem(
        'cm-recording-resume-state',
        JSON.stringify({ ...baseState, certificateType: 'OTHER' })
      );
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).toBeNull();
    });

    it('returns null when required fields are missing', () => {
      const incomplete = { clientSessionId: 'sess_x', status: 'active' };
      sessionStorage.setItem('cm-recording-resume-state', JSON.stringify(incomplete));
      expect(loadAndConsumeRecordingState()).toBeNull();
    });
  });

  describe('consume semantics', () => {
    it('loadAndConsumeRecordingState clears the entry after read', () => {
      persistRecordingState(baseState);
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).not.toBeNull();
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).toBeNull();
    });

    it('peekRecordingState does NOT clear', () => {
      persistRecordingState(baseState);
      expect(peekRecordingState()).not.toBeNull();
      expect(peekRecordingState()).not.toBeNull();
      // Subsequent consume still works.
      expect(loadAndConsumeRecordingState(baseState.lastUpdatedAt + 1)).not.toBeNull();
    });

    it('loadAndConsumeRecordingState clears even on validation failure — a corrupt entry should not re-trigger', () => {
      sessionStorage.setItem('cm-recording-resume-state', 'garbage');
      expect(loadAndConsumeRecordingState()).toBeNull();
      // Confirm it's gone.
      expect(sessionStorage.getItem('cm-recording-resume-state')).toBeNull();
    });
  });

  describe('clearRecordingState', () => {
    it('removes a persisted entry', () => {
      persistRecordingState(baseState);
      clearRecordingState();
      expect(peekRecordingState()).toBeNull();
    });

    it('is idempotent — safe to call when nothing is persisted', () => {
      expect(() => clearRecordingState()).not.toThrow();
      expect(() => clearRecordingState()).not.toThrow();
    });
  });
});
