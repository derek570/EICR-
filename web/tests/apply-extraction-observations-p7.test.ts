/**
 * P7 (marker ④, feedback id 82) — observation dedupe demoted to server
 * `observation_id` keying (web companion to the iOS
 * `applySonnetObservations` fix).
 *
 * Bug (session 36731498): two same-vocabulary observations were dictated
 * ("small hole in the SIDE of the enclosure" / "small hole present in the
 * TOP of the enclosure"). The second was backend-created (distinct
 * observation_id) and its confirmation SPOKEN, then the client >0.7
 * word-overlap gate false-positive-swallowed it (~0.8 overlap). Heard but
 * never written — an inverse Audio-First violation.
 *
 * The fix keys dedupe on the server id: distinct ids BOTH render; a re-seen
 * id is an IDEMPOTENT REPLAY (P4d reconnect) → a PURE NO-OP (no double-append,
 * no field fill, no creation side-effects, no schedule re-projection); a nil id
 * retains the text-similarity gate.
 *
 * The M9 / exact-dedupe tests in apply-extraction-observations-parity.test.ts
 * and apply-extraction-parity.test.ts exercise the RETAINED nil-id fallback
 * (nil-id obs vs nil-id rows) and must still pass UNCHANGED — this file ADDS
 * the id-keyed cases alongside them.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyExtractionToJob, applyObservationUpdate } from '@/lib/recording/apply-extraction';
import {
  OBSERVATION_PHOTO_LINK_WINDOW_MS,
  type PendingObservationPhoto,
} from '@/lib/recording/observation-photo';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

void OBSERVATION_PHOTO_LINK_WINDOW_MS;
const NOW = 1_700_000_000_000;

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

function makePending(over: Partial<PendingObservationPhoto> = {}): PendingObservationPhoto {
  return {
    jobId: 'job_1',
    blobId: 'blob-1',
    timestamp: NOW - 10_000,
    status: 'pending',
    filename: 'capture.jpg',
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────
// The id-82 fix — distinct server ids render despite high text overlap
// ────────────────────────────────────────────────────────────────────
describe('P7 — distinct server_id observations both render', () => {
  it('renders BOTH when two distinct-id observations share >0.7 vocabulary', () => {
    const job = makeJob({
      observations: [
        {
          id: 'r-side',
          server_id: 'srv-side',
          code: 'C3',
          description:
            'Small hole in the side of the consumer unit enclosure. No live parts exposed.',
        },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [
        {
          observation_id: 'srv-top',
          observation_text: 'Small hole present in the top of the consumer unit enclosure.',
          code: 'C3',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toHaveLength(2);
  });

  it('renders BOTH when distinct ids carry IDENTICAL text (live Stage-6 mints a fresh id)', () => {
    const job = makeJob({
      observations: [
        { id: 'r-1', server_id: 'srv-1', code: 'C2', description: 'damaged socket outlet' },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [
        { observation_id: 'srv-2', observation_text: 'damaged socket outlet', code: 'C2' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// Idempotent replay (same server_id) — PURE NO-OP (no append, no fill, no side-effects)
// ────────────────────────────────────────────────────────────────────
describe('P7 — same server_id is a pure no-op replay', () => {
  it('does NOT double-append and does NOT fill any field (pure no-op)', () => {
    const job = makeJob({
      observations: [
        { id: 'r-A', server_id: 'srv-A', code: 'C3', description: 'loose earth conductor' },
      ],
    } as Partial<JobDetail>);
    // Replay the same id, now carrying a regulation the row lacks. A pure no-op
    // replay must change NOTHING (fill-absent could only ever restore a field an
    // authoritative update cleared — never useful, sometimes harmful).
    const result = makeResult({
      observations: [
        {
          observation_id: 'srv-A',
          observation_text: 'loose earth conductor',
          code: 'C3',
          regulation: '543.3.1',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // No observation change at all → no patch.observations.
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('a replay of a NON-TAIL row attaches the photo to neither row (no creation side-effects)', () => {
    const onPhotoAttached = vi.fn();
    const onLastObservationCreated = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      // Row A is the matched (replayed) row but is NOT the array tail; row B is
      // unrelated and sits at the tail. A `changed`-gated photo attach would
      // wrongly land on `existing[last]` (row B) despite no new observation.
      const job = makeJob({
        observations: [
          { id: 'r-A', server_id: 'srv-A', code: 'C3', description: 'loose earth' },
          { id: 'r-B', server_id: 'srv-B', code: 'C2', description: 'loose terminal' },
        ],
      } as Partial<JobDetail>);
      const result = makeResult({
        observations: [
          {
            observation_id: 'srv-A',
            observation_text: 'loose earth',
            code: 'C3',
            regulation: '543.3.1',
          },
        ],
      });
      const applied = applyExtractionToJob(job, result, {
        pendingPhoto: makePending(),
        onPhotoAttached,
        onLastObservationCreated,
      });
      // Pure no-op → no observation change and NO creation side-effects.
      expect(applied?.patch.observations).toBeUndefined();
      expect(onPhotoAttached).not.toHaveBeenCalled();
      expect(onLastObservationCreated).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('initial extraction → refinement → ORIGINAL replay does NOT restore stale fields', () => {
    // Post-refine state: observation_update authoritatively changed code (C2→C1)
    // and text. A P4d reconnect then replays the ORIGINAL frame; a pure no-op
    // must leave the refined row untouched (no stale code/text restore).
    const job = makeJob({
      observations: [
        {
          id: 'r-A',
          server_id: 'srv-A',
          code: 'C1',
          description: 'Small hole in the side of the enclosure — reclassified.',
        },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [
        {
          observation_id: 'srv-A',
          observation_text: 'small hole side',
          code: 'C2',
          regulation: '416.2',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // Pure no-op → no patch; the refined row is untouched.
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('a replay does NOT restore a regulation_title an authoritative update CLEARED (cycle-2 BLOCKER)', () => {
    // observation_update sets regulation_title/description UNCONDITIONALLY, so a
    // table-miss refinement CLEARS the canonical wording to nil. Post-clear the
    // row has NO wording. A replay of the ORIGINAL frame (which carried the
    // wording) must NOT resurrect the stale wording of the old regulation.
    const job = makeJob({
      observations: [
        { id: 'r-A', server_id: 'srv-A', code: 'C2', description: 'no earth to metalwork' },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [
        {
          observation_id: 'srv-A',
          observation_text: 'no earth to metalwork',
          code: 'C2',
          regulation_title: 'ADS - Protective earthing',
          regulation_description:
            'Exposed-conductive-parts shall be connected to a protective conductor.',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // Pure no-op → wording is NOT restored (no observation patch at all).
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('DISCRIMINATING schedule regression — a replay does NOT re-project a CLEARED outcome', () => {
    // Post-state: the observation exists (server_id + schedule_item both set),
    // but the inspector has CLEARED the schedule outcome (ref now open).
    const job = makeJob({
      observations: [
        {
          id: 'r-A',
          server_id: 'srv-A',
          code: 'C3',
          description: 'small hole side',
          schedule_item: '5.1',
        },
      ],
      inspection_schedule: { items: {} },
    } as unknown as Partial<JobDetail>);
    // Replay the ORIGINAL extraction frame (P4d reconnect) — schedule_item is
    // already set on the row, so it is NOT an accepted field-fill.
    const result = makeResult({
      observations: [
        {
          observation_id: 'srv-A',
          observation_text: 'small hole side',
          code: 'C3',
          schedule_item: '5.1',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // Observations unchanged (no dup) AND the cleared outcome does NOT re-appear.
    expect(applied?.patch.observations).toBeUndefined();
    expect(applied?.patch.inspection_schedule).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// nil-id fallback (older servers omit observation_id)
// ────────────────────────────────────────────────────────────────────
describe('P7 — nil-id fallback retains the text-similarity gate', () => {
  it('dedupes a nil-id repeated frame by text', () => {
    const job = makeJob({
      observations: [
        { id: 'r-1', code: 'C2', description: 'no rcd protection on the socket circuit' },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [{ observation_text: 'no rcd protection on the socket circuit', code: 'C2' }],
    });
    const applied = applyExtractionToJob(job, result);
    // Nil-id text-dup → no observation patch.
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('renders a nil-id distinct-text observation', () => {
    const job = makeJob({
      observations: [
        { id: 'r-1', code: 'C2', description: 'no rcd protection on the socket circuit' },
      ],
    } as Partial<JobDetail>);
    const result = makeResult({
      observations: [{ observation_text: 'main bonding to gas is undersized', code: 'C3' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// applyObservationUpdate — id-first, scoped fuzzy fallback
// ────────────────────────────────────────────────────────────────────
describe('P7 — applyObservationUpdate scoped fuzzy fallback', () => {
  it('a distinct incoming id does NOT patch a DIFFERENT server_id row — it creates', () => {
    const job = makeJob({
      observations: [
        {
          id: 'r-B',
          server_id: 'srv-B',
          code: 'C3',
          description: 'small hole in the side of the enclosure',
        },
      ],
    } as Partial<JobDetail>);
    const updated = applyObservationUpdate(job, {
      observation_id: 'srv-A', // distinct id, high overlap with row B
      observation_text: 'Small hole present in the top of the enclosure.',
      original_text: 'small hole present in the top of the enclosure',
      code: 'C3',
      regulation: '416.2',
    });
    expect(updated).toHaveLength(2);
    const bRow = updated?.find((o) => o.server_id === 'srv-B');
    expect(bRow?.code).toBe('C3');
    expect(bRow?.regulation).toBeUndefined(); // row B untouched
    expect(updated?.find((o) => o.server_id === 'srv-A')).toBeTruthy();
  });

  it('a non-empty incoming id fuzzy-matches a LEGACY (no server_id) row via >70% overlap and STAMPS it', () => {
    const job = makeJob({
      observations: [
        { id: 'r-legacy', code: 'C3', description: 'small hole in the side of the enclosure' },
      ],
    } as Partial<JobDetail>);
    const updated = applyObservationUpdate(job, {
      observation_id: 'srv-new', // misses (no row carries it), fuzzy-matches the legacy row
      observation_text: 'Small hole on the side of enclosure.',
      // NON-identical to the row description (so the exact-match shortcut is
      // NOT taken) but ~86% directional word overlap → exercises the real
      // >70% fuzzy branch that P7 scopes to legacy rows.
      original_text: 'small hole on the side of enclosure',
      code: 'C2',
    });
    expect(updated).toHaveLength(1);
    expect(updated?.[0].code).toBe('C2');
    expect(updated?.[0].server_id).toBe('srv-new'); // stamped
  });

  it('a nil incoming id keeps the unrestricted fuzzy (older-server compat)', () => {
    const job = makeJob({
      observations: [
        {
          id: 'r-1',
          server_id: 'srv-existing',
          code: 'C3',
          description: 'loose neutral in the board',
        },
      ],
    } as Partial<JobDetail>);
    const updated = applyObservationUpdate(job, {
      observation_id: null,
      observation_text: 'loose neutral in the board (tidied)',
      original_text: 'loose neutral in the board',
      code: 'C2',
    });
    expect(updated).toHaveLength(1);
    expect(updated?.[0].code).toBe('C2');
    expect(updated?.[0].server_id).toBe('srv-existing');
  });
});
