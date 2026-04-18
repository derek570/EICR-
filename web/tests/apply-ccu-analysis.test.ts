import { describe, it, expect } from 'vitest';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import type { CCUAnalysis, JobDetail } from '@/lib/types';

/**
 * Wave 1 P0-3 regression: multi-board CCU analysis must NOT cross-bleed.
 *
 * The pre-P0-3 implementation wrote `job.ccu_analysis = analysis` flat,
 * so a job with DB1 + DB2 analysed in sequence ended up with only the
 * second analysis visible and the first board's raw response lost. The
 * fix introduced `ccu_analysis_by_board` keyed by `boardId` so each
 * board retains its own audit trail.
 *
 * This test proves the scoping by analysing the second board with
 * `targetBoardId` set, then asserting both boards' entries exist under
 * the per-board map.
 */

function makeJob(boards: Array<{ id: string; designation: string }>): JobDetail {
  return {
    id: 'job-1',
    user_id: 'u1',
    certificate_type: 'EICR',
    folder_name: 'job-1',
    board: { boards },
  } as unknown as JobDetail;
}

function makeAnalysis(model: string): CCUAnalysis {
  return {
    board_manufacturer: 'Wylex',
    board_model: model,
    main_switch_current: '100A',
    circuits: [],
    questionsForInspector: [],
  };
}

describe('applyCcuAnalysisToJob — P0-3 multi-board scoping', () => {
  it('writes each analysis under its boardId without overwriting the other', () => {
    // Step 1 — DB1 already analysed (simulated by providing an existing
    // ccu_analysis_by_board entry). Step 2 — run the applier for DB2 and
    // assert DB1's entry survives intact.
    const job: JobDetail = {
      ...makeJob([
        { id: 'board-db1', designation: 'DB1' },
        { id: 'board-db2', designation: 'DB2' },
      ]),
      ccu_analysis_by_board: {
        'board-db1': { board_manufacturer: 'Wylex', board_model: 'NH10' } as Record<
          string,
          unknown
        >,
      },
    };

    const result = applyCcuAnalysisToJob(job, makeAnalysis('Amendment3'), {
      targetBoardId: 'board-db2',
    });

    // Both boards' raw analyses present.
    expect(result.patch.ccu_analysis_by_board).toBeDefined();
    const perBoard = result.patch.ccu_analysis_by_board!;
    expect(Object.keys(perBoard).sort()).toEqual(['board-db1', 'board-db2']);
    expect(perBoard['board-db1']).toMatchObject({ board_model: 'NH10' });
    expect(perBoard['board-db2']).toMatchObject({ board_model: 'Amendment3' });

    // Flat legacy field mirrors the most recent analysis (used by debug
    // panels + single-board consumers that were written pre-P0-3).
    expect(result.patch.ccu_analysis).toMatchObject({ board_model: 'Amendment3' });
  });

  it('maps board_model → board_model AND name (P0-3 field correction)', () => {
    // Pre-P0-3: analysis.board_model was mis-wired to board_name only;
    // a distinct board_model field on the board row stayed blank. The fix
    // writes both so PDF + compliance downstreams can read either.
    const job = makeJob([{ id: 'board-db1', designation: 'DB1' }]);
    const result = applyCcuAnalysisToJob(job, makeAnalysis('Wylex NH10'), {
      targetBoardId: 'board-db1',
    });

    const patchedBoard = result.patch.board as { boards: Array<Record<string, unknown>> };
    const row = patchedBoard.boards[0];
    expect(row.board_model).toBe('Wylex NH10');
    expect(row.name).toBe('Wylex NH10');
  });

  it('null-safe on spd — undefined spd_present leaves existing values alone', () => {
    // P0-3 sibling fix: `analysis.spd.type` dereference without a null
    // guard used to throw when analysis omitted `spd_*`. The current
    // code reads `spd_present` and early-returns when undefined.
    const job: JobDetail = {
      ...makeJob([{ id: 'board-db1', designation: 'DB1' }]),
      board: {
        boards: [
          {
            id: 'board-db1',
            designation: 'DB1',
            spd_status: 'Fitted',
            spd_type: 'Type 2',
          },
        ],
      },
    };

    const result = applyCcuAnalysisToJob(job, { board_model: 'X', circuits: [] } as CCUAnalysis, {
      targetBoardId: 'board-db1',
    });

    const patchedBoard = result.patch.board as { boards: Array<Record<string, unknown>> };
    const row = patchedBoard.boards[0];
    // Untouched because spd_present was undefined on the incoming analysis.
    expect(row.spd_status).toBe('Fitted');
    expect(row.spd_type).toBe('Type 2');
  });
});
