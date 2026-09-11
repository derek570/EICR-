import { describe, it, expect } from 'vitest';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import type { CCUAnalysis, CircuitMatch, JobDetail } from '@/lib/types';

/**
 * PLAN-D (feedback id 136a) — a consumer-unit photo must fill the Supply tab's
 * main-switch box, not just the board record.
 *
 * Derek: *"The photo of the consumer unit does not fill out … the main switch
 * section."* The model forms carry exactly ONE main-switch box, at
 * installation level (EICR Section J), and with a single consumer unit that
 * CU's integral main switch IS the installation main switch (Reg 462.1.201).
 * Supply is canon. The document path already agreed; the photo path wrote the
 * board record only.
 *
 * Three properties these tests pin, each of which was a review BLOCKER:
 *
 *   1. **Canonical main-board identity, never array position.** Web lets the
 *      inspector reorder boards, so `[sub, main]` must not let a sub-board
 *      photo redirect a supply write.
 *   2. **Empty-only, unconditionally.** A Hardware Update reading 100 A must
 *      not replace an inspector-entered 80 A certificate particular.
 *   3. **The OBSERVED rating only.** `main_switch_bs_en`, `_poles` and
 *      `_voltage` are synthetic backend defaults
 *      (`src/routes/extraction.js:2707-2722`), not observations, and must not
 *      become Section J particulars.
 */

type BoardSeed = { id: string; designation: string; board_type?: string };

function makeJob(boards: BoardSeed[], supply?: Record<string, unknown>): JobDetail {
  return {
    id: 'job-d',
    user_id: 'u1',
    certificate_type: 'EICR',
    folder_name: 'job-d',
    boards,
    ...(supply ? { supply_characteristics: supply } : {}),
  } as unknown as JobDetail;
}

function makeAnalysis(overrides: Partial<CCUAnalysis> = {}): CCUAnalysis {
  return {
    board_manufacturer: 'Wylex',
    board_model: 'NH10',
    main_switch_current: '100',
    main_switch_bs_en: '60947-3',
    main_switch_poles: 'DP',
    main_switch_voltage: '230',
    circuits: [],
    questionsForInspector: [],
    ...overrides,
  } as CCUAnalysis;
}

function supplyOf(patch: Partial<JobDetail>): Record<string, unknown> | undefined {
  return patch.supply_characteristics as Record<string, unknown> | undefined;
}

describe('PLAN-D — CCU photo fills the Supply main-switch box (web)', () => {
  it('promotes the observed rating to supply.main_switch_current on a main-board photo', () => {
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)?.main_switch_current).toBe('100');

    // The board record keeps exactly what it carried before — this plan adds a
    // supply write, it does not move the board write.
    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards[0].rated_current).toBe('100');
    expect(boards[0].main_switch_bs_en).toBe('60947-3');
  });

  it('falls back to main_switch_rating when main_switch_current is absent', () => {
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(
      job,
      makeAnalysis({ main_switch_current: null, main_switch_rating: '80' }),
      { targetBoardId: 'board-main' }
    );

    expect(supplyOf(patch)?.main_switch_current).toBe('80');
  });

  it('follows canonical main-board IDENTITY when the boards are reordered to [sub, main]', () => {
    // The round-2 guard. `board-main` sits at index 1; array position must not
    // decide which board owns the supply write.
    const job = makeJob([
      { id: 'board-sub', designation: 'DB2', board_type: 'sub_distribution' },
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
    ]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)?.main_switch_current).toBe('100');
  });

  it('never writes supply from the sub board of a reordered [sub, main] job', () => {
    const job = makeJob([
      { id: 'board-sub', designation: 'DB2', board_type: 'sub_distribution' },
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
    ]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-sub',
    });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('leaves supply untouched for a sub-board photo in hardware_update mode', () => {
    const job = makeJob([
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
      { id: 'board-sub', designation: 'DB2', board_type: 'sub_distribution' },
    ]);

    const matches: CircuitMatch[] = [];
    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'hardware_update',
      targetBoardId: 'board-sub',
      userApprovedMatches: matches,
    });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('resolves identity against the POST-patch board list on a first capture', () => {
    // Round-3 finding: `buildSupplyPatch` used to receive the ORIGINAL job.
    // A job with no `boards[]` has its main board synthesised inside
    // `buildBoardPatch`, so evaluating identity against the original list
    // would find nothing and silently skip the supply write.
    const job = makeJob([]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {});

    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards).toHaveLength(1);
    expect(boards[0].board_type).toBe('main');
    expect(supplyOf(patch)?.main_switch_current).toBe('100');
  });

  it('does not overwrite an inspector-entered rating, even in hardware_update mode', () => {
    // The empty-only guard. Hardware Update overwrites the BOARD record
    // because the board has physically changed; a certificate particular is
    // not the board record and must survive.
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }], {
      main_switch_current: '80',
    });

    const matches: CircuitMatch[] = [];
    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'hardware_update',
      targetBoardId: 'board-main',
      userApprovedMatches: matches,
    });

    const supply = supplyOf(patch);
    // Either no supply patch at all, or one that still carries the 80 A.
    expect(supply?.main_switch_current ?? '80').toBe('80');

    // The board record DID take the new reading — that half is unchanged.
    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards[0].rated_current).toBe('100');
  });

  it('does not promote the backend-default BS(EN), poles or voltage to supply', () => {
    // These three are stamped unconditionally by
    // `src/routes/extraction.js:2707-2722` — defaults, not observations.
    // Writing them into Section J would present unverified values as
    // inspected findings.
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    const supply = supplyOf(patch);
    expect(supply?.main_switch_bs_en).toBeUndefined();
    expect(supply?.main_switch_poles).toBeUndefined();
    expect(supply?.main_switch_voltage).toBeUndefined();
  });

  it('writes nothing when the analysis carries no rating at all', () => {
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(
      job,
      makeAnalysis({ main_switch_current: null, main_switch_rating: null }),
      { targetBoardId: 'board-main' }
    );

    expect(supplyOf(patch)?.main_switch_current).toBeUndefined();
  });

  it('skips supply entirely in names_only mode', () => {
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'names_only',
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)).toBeUndefined();
  });
});
