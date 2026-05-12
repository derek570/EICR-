/**
 * apply-extraction — H1 board_ops apply tests.
 *
 * The backend emits multi-board mutation ops as `result.board_ops` on
 * the extraction envelope (`add_board`, `select_board`,
 * `mark_distribution_circuit` — `stage6-dispatchers-board.js`). iOS
 * applies them via `DeepgramRecordingViewModel.applyBoardOpsToJob`.
 *
 * Pre-fix the PWA decoded the envelope but never read `board_ops`,
 * so voice-driven sub-board creation, board switching, and
 * distribution-circuit marking were all silent no-ops. These tests
 * pin the new `applyBoardOpsToJob` helper.
 */
import { describe, expect, it } from 'vitest';
import { applyBoardOpsToJob } from '@/lib/recording/apply-extraction';
import type { BoardOp } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

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

describe('applyBoardOpsToJob — H1 multi-board ops', () => {
  it('appends a new board on add_board', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main', designation: 'DB1' }],
    });
    const ops: BoardOp[] = [
      {
        op: 'add_board',
        board_id: 'sub-1',
        designation: 'Garage',
        board_type: 'sub_distribution',
        parent_board_id: 'main',
        feed_circuit_ref: 2,
      },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).not.toBeNull();
    expect(patch!.boards).toHaveLength(2);
    const newBoard = patch!.boards![1] as Record<string, unknown>;
    expect(newBoard.id).toBe('sub-1');
    expect(newBoard.designation).toBe('Garage');
    expect(newBoard.board_type).toBe('sub_distribution');
    expect(newBoard.parent_board_id).toBe('main');
    expect(newBoard.feed_circuit_ref).toBe(2);
  });

  it('drops duplicate add_board ops (idempotency on session_resume)', () => {
    const job = makeJob({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution', designation: 'Garage' },
      ],
    });
    const ops: BoardOp[] = [
      { op: 'add_board', board_id: 'sub-1', designation: 'Garage (duplicate)' },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    // No-op — boards array unchanged. Returns null.
    expect(patch).toBeNull();
  });

  it('marks the source circuit as a distribution circuit (top-level circuits)', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [{ id: 'c-1', circuit_ref: '2', circuit_designation: 'Garage feed' }],
    });
    const ops: BoardOp[] = [
      {
        op: 'mark_distribution_circuit',
        circuit_ref: 2,
        feeds_board_id: 'sub-1',
        source_board_id: 'main',
      },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).not.toBeNull();
    const row = patch!.circuits![0] as CircuitRow;
    expect(row.is_distribution_circuit).toBe('yes');
    expect(row.feeds_board_id).toBe('sub-1');
    // Untouched fields preserved.
    expect(row.circuit_designation).toBe('Garage feed');
  });

  it('marks a circuit on the nested boards[i].circuits when source_board_id matches', () => {
    const job = makeJob({
      boards: [
        {
          id: 'main',
          board_type: 'main',
          circuits: [{ id: 'c-1', circuit_ref: '2', circuit_designation: 'Garage feed' }],
        },
      ],
    });
    const ops: BoardOp[] = [
      {
        op: 'mark_distribution_circuit',
        circuit_ref: 2,
        feeds_board_id: 'sub-1',
        source_board_id: 'main',
      },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).not.toBeNull();
    const board = patch!.boards![0] as Record<string, unknown>;
    const nestedRow = (board.circuits as CircuitRow[])[0];
    expect(nestedRow.is_distribution_circuit).toBe('yes');
    expect(nestedRow.feeds_board_id).toBe('sub-1');
  });

  it('skips mark_distribution_circuit when source circuit not found', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [{ id: 'c-1', circuit_ref: '99', circuit_designation: 'Other' }],
    });
    const ops: BoardOp[] = [
      {
        op: 'mark_distribution_circuit',
        circuit_ref: 2,
        feeds_board_id: 'sub-1',
        source_board_id: 'main',
      },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).toBeNull();
  });

  it('select_board is inert (broadcast handler owns active-board state)', () => {
    const job = makeJob({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const ops: BoardOp[] = [{ op: 'select_board', board_id: 'sub-1' }];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).toBeNull();
  });

  it('coalesces add_board + mark_distribution_circuit on the same turn (Sonnet add+mark atomic)', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [{ id: 'c-1', circuit_ref: '2', circuit_designation: 'Garage feed' }],
    });
    const ops: BoardOp[] = [
      {
        op: 'add_board',
        board_id: 'sub-1',
        designation: 'Garage',
        board_type: 'sub_distribution',
      },
      {
        op: 'mark_distribution_circuit',
        circuit_ref: 2,
        feeds_board_id: 'sub-1',
        source_board_id: 'main',
      },
    ];
    const patch = applyBoardOpsToJob(job, ops);
    expect(patch).not.toBeNull();
    expect(patch!.boards).toHaveLength(2);
    const c1 = patch!.circuits![0] as CircuitRow;
    expect(c1.is_distribution_circuit).toBe('yes');
    expect(c1.feeds_board_id).toBe('sub-1');
  });

  it('returns null for an empty ops array', () => {
    expect(applyBoardOpsToJob(makeJob(), [])).toBeNull();
  });
});
