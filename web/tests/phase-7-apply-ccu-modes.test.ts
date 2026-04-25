/**
 * Phase 7 — mode-aware CCU apply.
 *
 * The backend `/api/analyze-ccu` endpoint returns the same superset
 * payload regardless of mode. The three modes diverge client-side:
 *   - `names_only` applies ONLY `circuit_ref` + `circuit_designation`.
 *     Hardware / board / supply fields are untouched.
 *   - `full_capture` keeps the legacy non-destructive merge — matches
 *     by `circuit_ref`, preserves test readings on orphaned circuits,
 *     overwrites empty hardware fields.
 *   - `hardware_update` consumes `userApprovedMatches` from the Match
 *     Review screen: new hardware lands on the matched existing
 *     circuit (readings preserved), unmatched existing circuits with
 *     readings are kept at the tail, board-level info is overwritten
 *     (physically-different board).
 *
 * These tests pin the mode contract so a future refactor can't
 * silently collapse the three behaviours back into one.
 */

import { describe, expect, it } from 'vitest';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import type { CCUAnalysis, CircuitRow, JobDetail } from '@/lib/types';
import { matchCircuits, type CircuitMatch } from '@certmate/shared-utils';

function makeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-1',
    user_id: 'u1',
    certificate_type: 'EICR',
    folder_name: 'job-1',
    boards: [{ id: 'board-1', designation: 'DB1', manufacturer: 'Existing Co' }],
    circuits: [],
    ...overrides,
  } as unknown as JobDetail;
}

function makeAnalysis(): CCUAnalysis {
  return {
    board_manufacturer: 'Wylex',
    board_model: 'NH10',
    main_switch_current: '100A',
    spd_present: true,
    spd_bs_en: 'BS EN 61643-11',
    circuits: [
      {
        circuit_number: 1,
        label: 'Kitchen Sockets',
        ocpd_type: 'B',
        ocpd_rating_a: '32',
        ocpd_bs_en: 'BS EN 60898',
      },
      {
        circuit_number: 2,
        label: 'Upstairs Lighting',
        ocpd_type: 'B',
        ocpd_rating_a: '6',
      },
    ],
    questionsForInspector: [],
  };
}

describe('applyCcuAnalysisToJob — names_only mode', () => {
  it('writes only circuit_ref + circuit_designation; no hardware, no board, no supply', () => {
    const job = makeJob({
      circuits: [
        { id: 'c1', board_id: 'board-1', circuit_ref: '1', circuit_designation: '' } as CircuitRow,
      ],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'names_only',
      targetBoardId: 'board-1',
    });

    // No board / supply patch — names-only mode intentionally skips them.
    expect(result.patch.boards).toBeUndefined();
    expect(result.patch.supply_characteristics).toBeUndefined();

    const circuits = result.patch.circuits as CircuitRow[];
    expect(circuits).toHaveLength(2);
    // Existing c1 keeps its id; designation now filled.
    expect(circuits[0].id).toBe('c1');
    expect(circuits[0].circuit_designation).toBe('Kitchen Sockets');
    // Hardware fields NOT applied.
    expect(circuits[0].ocpd_type).toBeUndefined();
    expect(circuits[0].ocpd_rating_a).toBeUndefined();
    // Second circuit is brand new (different ref).
    expect(circuits[1].circuit_ref).toBe('2');
    expect(circuits[1].circuit_designation).toBe('Upstairs Lighting');
    expect(circuits[1].ocpd_type).toBeUndefined();
  });

  it('preserves existing designations (never stomps inspector-entered labels)', () => {
    const job = makeJob({
      circuits: [
        {
          id: 'c1',
          board_id: 'board-1',
          circuit_ref: '1',
          circuit_designation: 'Hand-typed label',
        } as CircuitRow,
      ],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'names_only',
      targetBoardId: 'board-1',
    });

    const circuits = result.patch.circuits as CircuitRow[];
    expect(circuits[0].circuit_designation).toBe('Hand-typed label');
  });

  it('persists the synthesized board when running against a job with no boards yet', () => {
    // Regression guard: previously the names_only branch extracted a
    // boardId from buildBoardPatch but never persisted the synthesized
    // board, leaving new circuits tagged with a board_id that didn't
    // exist in job.board — breaking every later board-scoped flow.
    const job = makeJob({
      boards: [],
      circuits: [],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), { mode: 'names_only' });

    const patchedBoards = result.patch.boards as { id: string }[] | undefined;
    expect(patchedBoards?.length).toBe(1);
    const boardId = patchedBoards![0].id;

    const circuits = result.patch.circuits as CircuitRow[];
    expect(circuits.length).toBeGreaterThan(0);
    // Every synthesized circuit's board_id must point at a board that
    // is actually in the patch — no orphaned references.
    for (const c of circuits) {
      expect(c.board_id).toBe(boardId);
    }
  });

  it('does NOT re-emit the board patch when the job already has boards', () => {
    // Complement to the synthesis test — if the job already has a
    // board, names_only must stay true to its "no board patch" spec.
    const job = makeJob({
      circuits: [
        { id: 'c1', board_id: 'board-1', circuit_ref: '1', circuit_designation: '' } as CircuitRow,
      ],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'names_only',
      targetBoardId: 'board-1',
    });

    expect(result.patch.boards).toBeUndefined();
  });
});

describe('applyCcuAnalysisToJob — full_capture mode (default)', () => {
  it('defaults to full_capture when no mode is passed', () => {
    const job = makeJob();
    const result = applyCcuAnalysisToJob(job, makeAnalysis(), { targetBoardId: 'board-1' });
    // Board patched (proves full_capture ran, not names_only).
    expect(result.patch.boards).toBeDefined();
    const circuits = result.patch.circuits as CircuitRow[];
    expect(circuits[0].ocpd_type).toBe('B');
  });

  it('merges hardware into existing circuits matched by circuit_ref (incoming non-empty wins)', () => {
    const job = makeJob({
      circuits: [
        {
          id: 'c1',
          board_id: 'board-1',
          circuit_ref: '1',
          circuit_designation: 'Kitchen',
          ocpd_rating_a: '16',
        } as CircuitRow,
      ],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'full_capture',
      targetBoardId: 'board-1',
    });

    const circuits = result.patch.circuits as CircuitRow[];
    // Full-capture mode: iOS parity is that the analysis overwrites
    // hardware fields (represents an up-to-date capture of the board
    // photo). `mergeField` only skips when INCOMING is empty — any
    // non-empty analysed value wins. Inspector guardrails live in the
    // 3-tier priority ladder upstream (pre-existing manual values are
    // captured via the `hasValue` check on the target field only when
    // the analysis returns blank).
    expect(circuits[0].ocpd_rating_a).toBe('32');
    expect(circuits[0].ocpd_type).toBe('B');
    expect(circuits[0].ocpd_bs_en).toBe('BS EN 60898');
  });

  it('preserves circuit_designation when incoming analysis gives no better label', () => {
    // Inspector-typed designations are specifically guarded in
    // `mergeMatchedCircuit` (unlike hardware fields): if the existing
    // designation is non-empty we keep it regardless of the analysis.
    const job = makeJob({
      circuits: [
        {
          id: 'c1',
          board_id: 'board-1',
          circuit_ref: '1',
          circuit_designation: 'My bespoke label',
        } as CircuitRow,
      ],
    });

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'full_capture',
      targetBoardId: 'board-1',
    });

    const circuits = result.patch.circuits as CircuitRow[];
    expect(circuits[0].circuit_designation).toBe('My bespoke label');
  });

  it('does NOT overwrite board manufacturer when full_capture runs over an existing board', () => {
    const job = makeJob({
      boards: [{ id: 'board-1', designation: 'DB1', manufacturer: 'Inspector Typed' }],
    } as unknown as Partial<JobDetail>);

    const result = applyCcuAnalysisToJob(job, makeAnalysis(), {
      mode: 'full_capture',
      targetBoardId: 'board-1',
    });

    const patchedBoards = result.patch.boards as Array<Record<string, unknown>>;
    expect(patchedBoards[0].manufacturer).toBe('Inspector Typed');
  });
});

describe('applyCcuAnalysisToJob — hardware_update mode', () => {
  const existing: CircuitRow[] = [
    {
      id: 'c1',
      board_id: 'board-1',
      circuit_ref: '1',
      circuit_designation: 'Kitchen Sockets',
      ocpd_rating_a: '32', // old rating (20A) will be overwritten on new board
      measured_zs_ohm: '0.45', // reading — must survive
      r1_r2_ohm: '0.30',
    } as CircuitRow,
    {
      id: 'c2',
      board_id: 'board-1',
      circuit_ref: '2',
      circuit_designation: 'Upstairs Lighting',
      rcd_time_ms: '28',
    } as CircuitRow,
    {
      id: 'c3',
      board_id: 'board-1',
      circuit_ref: '3',
      circuit_designation: 'Retired — cooker removed',
      measured_zs_ohm: '0.7', // reading — preserved even though unmatched
    } as CircuitRow,
    {
      id: 'c4',
      board_id: 'board-1',
      circuit_ref: '4',
      circuit_designation: 'Blank spare', // no readings — dropped if unmatched
    } as CircuitRow,
  ];

  it('throws when userApprovedMatches is missing', () => {
    const job = makeJob({ circuits: existing });
    expect(() =>
      applyCcuAnalysisToJob(job, makeAnalysis(), {
        mode: 'hardware_update',
        targetBoardId: 'board-1',
      })
    ).toThrow(/userApprovedMatches/);
  });

  it('OVERWRITES board-level info (physically different board)', () => {
    const job = makeJob({
      circuits: existing,
      boards: [{ id: 'board-1', designation: 'DB1', manufacturer: 'Old Brand' }],
    } as unknown as Partial<JobDetail>);

    const analysis = makeAnalysis();
    const userApprovedMatches = matchCircuits(analysis.circuits ?? [], existing);

    const result = applyCcuAnalysisToJob(job, analysis, {
      mode: 'hardware_update',
      targetBoardId: 'board-1',
      userApprovedMatches,
    });

    const patchedBoards = result.patch.boards as Array<Record<string, unknown>>;
    // Contrast with full_capture — hardware_update IS destructive on board info.
    expect(patchedBoards[0].manufacturer).toBe('Wylex');
  });

  it('preserves readings on matched circuits and drops unmatched blanks', () => {
    const job = makeJob({ circuits: existing });
    const analysis = makeAnalysis();
    const userApprovedMatches = matchCircuits(analysis.circuits ?? [], existing);

    const result = applyCcuAnalysisToJob(job, analysis, {
      mode: 'hardware_update',
      targetBoardId: 'board-1',
      userApprovedMatches,
    });

    const circuits = result.patch.circuits as CircuitRow[];

    // c1 (Kitchen Sockets) matched to analysis #1 — readings kept,
    // rating preserved because mergeField is non-empty-only.
    const kitchen = circuits.find((c) => c.id === 'c1')!;
    expect(kitchen.measured_zs_ohm).toBe('0.45');
    expect(kitchen.r1_r2_ohm).toBe('0.30');
    expect(kitchen.ocpd_type).toBe('B'); // from analysis (was empty)

    // c2 (Upstairs Lighting) matched — rcd_time_ms readings survive.
    const lights = circuits.find((c) => c.id === 'c2')!;
    expect(lights.rcd_time_ms).toBe('28');

    // c3 unmatched but carries readings — tail-appended.
    const orphanWithReadings = circuits.find((c) => c.id === 'c3');
    expect(orphanWithReadings).toBeDefined();

    // c4 unmatched + no readings — dropped.
    const blankOrphan = circuits.find((c) => c.id === 'c4');
    expect(blankOrphan).toBeUndefined();
  });

  it('handles manually-overridden match assignments from the review UI', () => {
    const job = makeJob({ circuits: existing });
    const analysis = makeAnalysis();
    // Simulate the inspector rejecting all auto-matches and manually
    // pairing new circuit #1 with c2 instead of c1.
    const userApprovedMatches: CircuitMatch[] = [
      {
        newCircuit: analysis.circuits![0],
        matchedOldCircuit: existing[1], // c2
        confidence: 1,
        matchReason: 'manual assignment',
      },
      {
        newCircuit: analysis.circuits![1],
        matchedOldCircuit: null,
        confidence: 0,
        matchReason: 'manually unassigned',
      },
    ];

    const result = applyCcuAnalysisToJob(job, analysis, {
      mode: 'hardware_update',
      targetBoardId: 'board-1',
      userApprovedMatches,
    });

    const circuits = result.patch.circuits as CircuitRow[];
    // c2 got claimed by new #1 — original c1 is unmatched but has
    // readings, so it gets tail-preserved.
    const c2Merged = circuits.find((c) => c.id === 'c2')!;
    expect(c2Merged.circuit_ref).toBe('1');
    expect(c2Merged.rcd_time_ms).toBe('28'); // readings preserved
    // c1 also appears as an unmatched-with-readings tail row.
    const c1Preserved = circuits.find((c) => c.id === 'c1');
    expect(c1Preserved).toBeDefined();
    expect(c1Preserved?.measured_zs_ohm).toBe('0.45');
  });
});
