/**
 * apply-extraction — multi-board `board_id` routing tests.
 *
 * Pins the behaviour of `mirrorReadingsToBoards` when extracted
 * readings carry the optional `board_id` field (from the backend
 * shadow-harness fold at `src/extraction/stage6-shadow-harness.js:
 * 331-339`). Without these tests a future refactor could silently
 * regress to the single-board boards[0] fallback for multi-board
 * sessions.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractedReading, ExtractionResult } from '@/lib/recording/sonnet-session';
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

function makeResult(readings: ExtractedReading[]): ExtractionResult {
  return {
    readings,
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
  };
}

describe('apply-extraction multi-board board_id routing', () => {
  it('routes a reading with board_id="sub-1" to that board record', () => {
    const job = makeJob({
      boards: [
        { id: 'main-board', board_type: 'main', designation: 'DB1' },
        { id: 'sub-1', board_type: 'sub_distribution', designation: 'Garage' },
      ],
    });
    const result = makeResult([
      { circuit: 0, field: 'manufacturer', value: 'Wylex', board_id: 'sub-1' },
    ]);
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.boards).toHaveLength(2);
    const boards = applied!.patch.boards!;
    // sub-1 (index 1) gets the manufacturer; main-board (index 0)
    // stays untouched.
    expect((boards[0] as Record<string, unknown>).manufacturer).toBeUndefined();
    expect((boards[1] as Record<string, unknown>).manufacturer).toBe('Wylex');
    expect((boards[1] as Record<string, unknown>).designation).toBe('Garage');
  });

  it('coalesces multiple readings to the same board into one patch', () => {
    const job = makeJob({
      boards: [{ id: 'b-1', board_type: 'main', designation: 'DB1' }],
    });
    const result = makeResult([
      { circuit: 0, field: 'manufacturer', value: 'Wylex', board_id: 'b-1' },
      { circuit: 0, field: 'main_switch_bs_en', value: 'BS EN 60947-3', board_id: 'b-1' },
      { circuit: 0, field: 'earthing_arrangement', value: 'TN-C-S', board_id: 'b-1' },
    ]);
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const board = applied!.patch.boards![0] as Record<string, unknown>;
    expect(board.manufacturer).toBe('Wylex');
    expect(board.main_switch_bs_en).toBe('BS EN 60947-3');
    expect(board.earthing_arrangement).toBe('TN-C-S');
  });

  it('routes readings on different boards to different records', () => {
    const job = makeJob({
      boards: [
        { id: 'main', board_type: 'main', designation: 'DB1' },
        { id: 'sub', board_type: 'sub_distribution', designation: 'Garage' },
      ],
    });
    const result = makeResult([
      { circuit: 0, field: 'manufacturer', value: 'Wylex', board_id: 'main' },
      { circuit: 0, field: 'manufacturer', value: 'Hager', board_id: 'sub' },
    ]);
    const applied = applyExtractionToJob(job, result);
    const boards = applied!.patch.boards!;
    expect((boards[0] as Record<string, unknown>).manufacturer).toBe('Wylex');
    expect((boards[1] as Record<string, unknown>).manufacturer).toBe('Hager');
  });

  it('skips orphan board_id (id not present in boards[])', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main' }],
    });
    const result = makeResult([
      { circuit: 0, field: 'manufacturer', value: 'Wylex', board_id: 'does-not-exist' },
    ]);
    const applied = applyExtractionToJob(job, result);
    // The reading still flows through section routing (manufacturer →
    // board_info via CIRCUIT_0_SECTION) so applied is non-null. But
    // the boards[] patch must NOT carry a phantom entry.
    expect(applied).not.toBeNull();
    expect(applied!.patch.boards).toBeUndefined();
  });

  it('refuses to default-route to boards[0] when multi-board and no board_id', () => {
    // Multi-board job, reading has no board_id — apply path refuses
    // to guess, leaves boards[] untouched.
    const job = makeJob({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub', board_type: 'sub_distribution' },
      ],
    });
    const result = makeResult([{ circuit: 0, field: 'manufacturer', value: 'Wylex' }]);
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.boards).toBeUndefined();
  });

  it('falls back to boards[0] for single-board sessions without board_id', () => {
    // Backwards-compat path: legacy sessions emit readings with no
    // board_id; for single-board jobs the apply path still mirrors
    // to boards[0] (synthesising it if empty).
    const result = makeResult([{ circuit: 0, field: 'manufacturer', value: 'Wylex' }]);
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.boards).toHaveLength(1);
    const board = applied!.patch.boards![0] as Record<string, unknown>;
    expect(board.manufacturer).toBe('Wylex');
    expect(board.board_type).toBe('main');
  });

  it('protects a user-typed value on the targeted board record', () => {
    // Inspector typed "MK" into the sub-board's Manufacturer field
    // (lands in boards[1].manufacturer). Sonnet then dictates "Wylex"
    // for that board. Priority guard keeps the user's value.
    const job = makeJob({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub', board_type: 'sub_distribution', manufacturer: 'MK' },
      ],
    });
    const result = makeResult([
      { circuit: 0, field: 'manufacturer', value: 'Wylex', board_id: 'sub' },
    ]);
    const applied = applyExtractionToJob(job, result);
    // No board patch fires because the only candidate was protected.
    expect(applied!.patch.boards).toBeUndefined();
  });
});
