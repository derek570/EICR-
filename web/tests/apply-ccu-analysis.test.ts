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
    boards,
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

    const patchedBoards = result.patch.boards as Array<Record<string, unknown>>;
    const row = patchedBoards[0];
    expect(row.board_model).toBe('Wylex NH10');
    expect(row.name).toBe('Wylex NH10');
  });

  it('null-safe on spd — undefined spd_present leaves existing values alone', () => {
    // P0-3 sibling fix: `analysis.spd.type` dereference without a null
    // guard used to throw when analysis omitted `spd_*`. The current
    // code reads `spd_present` and early-returns when undefined.
    const job: JobDetail = {
      ...makeJob([{ id: 'board-db1', designation: 'DB1' }]),
      boards: [
        {
          id: 'board-db1',
          designation: 'DB1',
          spd_status: 'Fitted',
          spd_type: 'Type 2',
        },
      ],
    };

    const result = applyCcuAnalysisToJob(job, { board_model: 'X', circuits: [] } as CCUAnalysis, {
      targetBoardId: 'board-db1',
    });

    const patchedBoards = result.patch.boards as Array<Record<string, unknown>>;
    const row = patchedBoards[0];
    // Untouched because spd_present was undefined on the incoming analysis.
    expect(row.spd_status).toBe('Fitted');
    expect(row.spd_type).toBe('Type 2');
  });
});

/**
 * 2026-05-03 regression — per-slot pipeline contract (backend 2026-04-22+).
 *
 * The /api/analyze-ccu response gained `slots[]`, `extraction_source`,
 * `board_technology`, and standalone-RCD schedule rows
 * (`circuit_number: null` + `is_rcd_device: true`). iOS decodes them in
 * Sources/Models/FuseboardAnalysis.swift; the PWA's Zod schema was
 * `.passthrough()`-permissive but the apply helper was unaware. Two
 * concrete bugs that motivated this test:
 *
 *   1. A standalone-RCD row with `circuit_number: null` was reaching
 *      `String(analysed.circuit_number)` → 'null', which then created a
 *      ghost circuit row labelled "circuit null" the inspector had to
 *      delete by hand. iOS filters via `circuitsForSchedule`.
 *   2. `board_technology` was being dropped on the floor — a rewireable
 *      board's UI continued to default to BS 60898 MCB OCPDs because
 *      nothing branched on the technology marker.
 */
describe('applyCcuAnalysisToJob — per-slot pipeline contract', () => {
  it('filters out standalone-RCD schedule rows (is_rcd_device + circuit_number=null)', () => {
    const job = makeJob([{ id: 'b1', designation: 'DB1' }]);
    const analysis: CCUAnalysis = {
      board_manufacturer: 'Hager',
      board_model: 'VML',
      board_technology: 'modern',
      circuits: [
        { circuit_number: 1, label: 'Lights', ocpd_type: 'B', ocpd_rating_a: '6' },
        // Standalone RCD — must be skipped, not turned into a ghost row.
        {
          circuit_number: null,
          label: 'RCD 30mA',
          rcd_type: 'A',
          rcd_rating_ma: '30',
          is_rcd_device: true,
        },
        { circuit_number: 2, label: 'Sockets', ocpd_type: 'B', ocpd_rating_a: '32' },
      ],
    };

    const result = applyCcuAnalysisToJob(job, analysis, { targetBoardId: 'b1' });
    const circuits = result.patch.circuits as Array<Record<string, unknown>>;

    expect(circuits).toHaveLength(2);
    expect(circuits.map((c) => c.circuit_ref)).toEqual(['1', '2']);
    // Verify no row labelled "RCD 30mA" leaked through with circuit_ref 'null'.
    expect(circuits.find((c) => c.circuit_ref === 'null')).toBeUndefined();
    expect(circuits.find((c) => c.circuit_designation === 'RCD 30mA')).toBeUndefined();
  });

  it('persists board_technology onto the patched board so downstream defaults can branch', () => {
    const job = makeJob([{ id: 'b1', designation: 'DB1' }]);
    const analysis: CCUAnalysis = {
      board_manufacturer: 'Wylex',
      board_model: 'Standard',
      board_technology: 'rewireable_fuse',
      circuits: [],
    };

    const result = applyCcuAnalysisToJob(job, analysis, { targetBoardId: 'b1' });
    const patchedBoards = result.patch.boards as Array<Record<string, unknown>>;
    expect(patchedBoards[0].board_technology).toBe('rewireable_fuse');
  });

  it('decodes a realistic per-slot response (slots, extraction_source, technology) without throwing', () => {
    const job = makeJob([]);
    // Shape mirrors a real prod response (extracted from
    // ccu-3of3-2026-04-30-23-25/wylex-count16-truth16.jpg). We don't
    // assert on slots[] directly — they're carried through `.passthrough()`
    // and only consumed by future per-slot UI. Test ensures the merge
    // pipeline doesn't choke on the extra keys.
    const analysis: CCUAnalysis = {
      board_manufacturer: 'Wylex',
      board_model: 'NH10',
      board_technology: 'modern',
      extraction_source: 'geometric-merged',
      main_switch_position: 'right',
      main_switch_current: '100A',
      spd_present: false,
      slots: [
        {
          slotIndex: 0,
          classification: 'main_switch',
          ratingAmps: 100,
          confidence: 0.92,
          bbox: { x: 100, y: 200, w: 60, h: 80 },
        },
        {
          slotIndex: 1,
          classification: 'rcbo',
          ratingAmps: 32,
          rcdWaveformType: 'A',
          sensitivity: 30,
          bsEn: '61009-1',
          confidence: 0.86,
          label: 'Sockets',
          labelConfidence: 0.78,
        },
      ],
      circuits: [
        {
          circuit_number: 1,
          label: 'Sockets',
          ocpd_type: 'B',
          ocpd_rating_a: '32',
          is_rcbo: true,
          rcd_protected: true,
          rcd_type: 'A',
          rcd_rating_ma: '30',
        },
      ],
    };

    const result = applyCcuAnalysisToJob(job, analysis);
    expect(result.patch.boards).toBeDefined();
    expect(result.patch.circuits).toHaveLength(1);
    // The raw analysis (slots and all) is persisted under
    // ccu_analysis_by_board for the audit trail / future per-slot UI.
    const byBoard = result.patch.ccu_analysis_by_board as Record<string, Record<string, unknown>>;
    const stored = Object.values(byBoard)[0];
    expect(stored.slots).toBeDefined();
    expect(stored.extraction_source).toBe('geometric-merged');
    expect(stored.board_technology).toBe('modern');
  });
});
