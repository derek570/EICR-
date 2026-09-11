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

  it('fails closed on a multi-board job, even photographing the main board', () => {
    // Derek, 2026-09-11. The model-forms argument for promoting at all is the
    // single-consumer-unit case. On a multi-board job the installation main
    // switch may be a separate upstream device, and iOS cannot tell which board
    // was photographed at all (no board selector), so both clients refuse and
    // the inspector dictates the main switch.
    const job = makeJob([
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
      { id: 'board-sub', designation: 'DB2', board_type: 'sub_distribution' },
    ]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)).toBeUndefined();
    // The board record still takes the reading — only Section J is withheld.
    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards[0].rated_current).toBe('100');
  });

  it('fails closed on a reordered [sub, main] multi-board job too', () => {
    // Array position is not what decides this; board COUNT is. Pinned
    // separately so a future change that restores multi-board promotion has to
    // confront the reordering case explicitly.
    const job = makeJob([
      { id: 'board-sub', designation: 'DB2', board_type: 'sub_distribution' },
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
    ]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('counts an id-less row as a second board and fails closed', () => {
    // iOS's `JobViewModel.load` mints a UUID for every id-less row, so such a
    // row IS a second board there once the job is hydrated. Counting raw rows
    // keeps the two clients identical instead of promoting on web and refusing
    // on iOS.
    const job = makeJob([
      { id: 'board-main', designation: 'DB1', board_type: 'main' },
      { id: '', designation: 'ghost' } as { id: string; designation: string },
    ]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('treats an empty board_type as absent, so a legacy single board still fills', () => {
    // Backend and web read `""` as falsy/absent. iOS used to decode it as a
    // present-but-unknown type and refuse the row, leaving Section J blank on
    // one client only.
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: '' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)?.main_switch_current).toBe('100');
  });

  it('treats a whitespace-only existing rating as empty and fills it', () => {
    // `hasValue` trims. iOS's untrimmed `isEmpty` used to let a blank-looking
    // value block the write there while web filled it.
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }], {
      main_switch_current: '   ',
    });

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      targetBoardId: 'board-main',
    });

    expect(supplyOf(patch)?.main_switch_current).toBe('100');
  });

  it('rejects a whitespace-only observed rating', () => {
    const job = makeJob([{ id: 'board-main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(
      job,
      makeAnalysis({ main_switch_current: '   ', main_switch_rating: null }),
      { targetBoardId: 'board-main' }
    );

    expect(supplyOf(patch)?.main_switch_current).toBeUndefined();
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

  it('never treats a sub board carrying the backend default id as the main board', () => {
    // `resolveCanonicalMainBoardId` falls back to the backend's synthesised
    // `'main'` identity when nothing qualifies. A sole sub board whose id IS
    // `'main'` — the id the backend mints for a board-less snapshot — would
    // pass an equality test against that fallback and write its rating into
    // installation-level supply. Gate on an actual canonical record instead.
    const job = makeJob([{ id: 'main', designation: 'DB2', board_type: 'sub_distribution' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), { targetBoardId: 'main' });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('never treats an unknown board_type carrying the default id as the main board', () => {
    // Same collision via a board_type the client does not recognise. Backend
    // and web both keep the raw string and skip such rows, so no board
    // qualifies and the resolver would again fall back to `'main'`.
    const job = makeJob([{ id: 'main', designation: 'DB1', board_type: 'something_new' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), { targetBoardId: 'main' });

    expect(supplyOf(patch)).toBeUndefined();
  });

  it('still writes supply when the main board legitimately carries the default id', () => {
    // The fallback id is only dangerous when it belongs to a NON-main board.
    // A genuine main board with that id must still be recognised.
    const job = makeJob([{ id: 'main', designation: 'DB1', board_type: 'main' }]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), { targetBoardId: 'main' });

    expect(supplyOf(patch)?.main_switch_current).toBe('100');
  });

  it('add_new_board on an empty job leaves a main placeholder, not a lone sub board', () => {
    // iOS's applier guarantees a board exists before any mode handler runs, so
    // it ends with [main-placeholder, newBoard]. Web used to end with just
    // [newBoard] — and a lone type-absent row reads as the canonical main, so a
    // LATER photo of that board could fill Section J from a board the inspector
    // captured as a new one.
    const job = makeJob([]);

    const { patch } = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'add_new_board',
    });

    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards).toHaveLength(2);
    expect(boards[0].board_type).toBe('main');
    // The appended board is NOT the main one, and supply is untouched.
    expect(boards[1].board_type).toBeUndefined();
    expect(supplyOf(patch)).toBeUndefined();
  });

  it('a board appended by add_new_board on an empty job can never later fill Section J', () => {
    // The end-to-end shape of the gap above: append, then re-photograph the
    // appended board. Two usable boards now exist, so the single-board rule
    // refuses regardless of how the appended row is typed.
    const job = makeJob([]);
    const first = applyCcuAnalysisToJob(job, makeAnalysis(), { mode: 'add_new_board' });
    const boards = first.patch.boards as Array<Record<string, unknown>>;
    const appendedId = boards[1].id as string;

    const secondJob = { ...job, boards } as unknown as JobDetail;
    const { patch } = applyCcuAnalysisToJob(secondJob, makeAnalysis(), {
      targetBoardId: appendedId,
    });

    expect(supplyOf(patch)).toBeUndefined();
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
