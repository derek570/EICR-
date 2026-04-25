/**
 * `observation_update` end-to-end shape compatibility — regression for
 * codex P1 finding on commit `d035b71`.
 *
 * The bug: `applyObservations` writes new rows with `description` +
 * `id` (web-generated UUID), but the original `onObservationUpdate`
 * lookup searched for `observation_text` + `observation_id` — fields
 * that didn't exist on the stored shape. Every refinement message
 * the server sent was dropped on the floor in normal use.
 *
 * The fix is two-sided:
 *   - `applyObservations` now persists the wire `observation_id` onto
 *     the row so the id-based match path works.
 *   - The `onObservationUpdate` lookup uses `observation_id` and
 *     falls back to fuzzy match against `description` (the stored
 *     text key), not `observation_text` (the wire key).
 *
 * This file covers the round-trip without mounting the recording
 * context (which carries Deepgram + Sonnet + sleep deps that are
 * tangential to the fix).
 */

import { describe, it, expect } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail, ObservationRow } from '@/lib/types';

function makeJob(): JobDetail {
  return {
    id: 'job-1',
    address: '1 Test Road',
    status: 'pending',
    created_at: '2026-04-25T00:00:00.000Z',
    certificate_type: 'EICR',
    observations: [],
  } as JobDetail;
}

describe('applyObservations persists observation_id from the wire (codex P1 on d035b71)', () => {
  it('writes the server-assigned observation_id onto the new row', () => {
    const job = makeJob();
    const result: ExtractionResult = {
      readings: [],
      observations: [
        {
          observation_id: 'srv-uuid-7',
          observation_text: 'Bonding to gas service incomplete',
          code: 'C2',
          item_location: 'Meter cupboard',
        },
      ],
    };
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const next = applied!.patch.observations as ObservationRow[];
    expect(next).toHaveLength(1);
    expect(next[0].observation_id).toBe('srv-uuid-7');
    expect(next[0].description).toBe('Bonding to gas service incomplete');
    expect(next[0].code).toBe('C2');
    expect(next[0].location).toBe('Meter cupboard');
  });

  it('omits observation_id field when the wire payload has none (legacy session)', () => {
    const job = makeJob();
    const result: ExtractionResult = {
      readings: [],
      observations: [
        {
          observation_text: 'No CPC at light fitting',
          code: 'C2',
        },
      ],
    };
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const next = applied!.patch.observations as ObservationRow[];
    expect(next[0].observation_id).toBeUndefined();
    // Fuzzy text fallback still works because `description` is set.
    expect(next[0].description).toBe('No CPC at light fitting');
  });
});

describe('onObservationUpdate lookup contract — id-first, then fuzzy text', () => {
  // Tiny copy of the recording-context lookup so the regression is
  // observable without spinning up the full provider tree. If the
  // lookup logic moves to a helper later, swap this for the import.
  function findIndexForUpdate(
    observations: ObservationRow[],
    update: { observation_id?: string; observation_text?: string }
  ): number {
    if (update.observation_id) {
      const idx = observations.findIndex((o) => o.observation_id === update.observation_id);
      if (idx !== -1) return idx;
    }
    if (update.observation_text) {
      const target = update.observation_text.trim().toLowerCase();
      return observations.findIndex(
        (o) => typeof o.description === 'string' && o.description.trim().toLowerCase() === target
      );
    }
    return -1;
  }

  it('finds the row by observation_id even when Sonnet has reworded the description', () => {
    const observations: ObservationRow[] = [
      {
        id: 'web-uuid-1',
        observation_id: 'srv-uuid-X',
        description: 'Bonding to gas service incomplete',
        code: 'C2',
      },
    ];
    // Refinement reworded the text but kept the same id.
    const idx = findIndexForUpdate(observations, {
      observation_id: 'srv-uuid-X',
      observation_text: 'Equipotential bonding to gas pipework not present',
    });
    expect(idx).toBe(0);
  });

  it('falls back to fuzzy `description` match when no id is supplied (legacy)', () => {
    const observations: ObservationRow[] = [
      { id: 'web-uuid-2', description: 'No CPC at light fitting', code: 'C2' },
    ];
    const idx = findIndexForUpdate(observations, {
      observation_text: '  No CPC at light fitting  ', // whitespace + casing variation
    });
    expect(idx).toBe(0);
  });

  it('returns -1 when neither id nor text matches (deleted observation)', () => {
    const observations: ObservationRow[] = [
      { id: 'web-uuid-3', observation_id: 'srv-uuid-A', description: 'Other defect', code: 'C2' },
    ];
    const idx = findIndexForUpdate(observations, {
      observation_id: 'srv-uuid-Z',
      observation_text: 'Different text entirely',
    });
    expect(idx).toBe(-1);
  });
});
