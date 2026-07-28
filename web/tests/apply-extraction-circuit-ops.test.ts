/**
 * A2-multiboard item 3 (2026-07-28) — web applies circuit-topology ops
 * LOSSLESSLY and on the board the SERVER actually mutated.
 *
 * Three defects are pinned here, all of them silent.
 *
 * 1. DELETES NEVER ARRIVED. `circuit_updates` was guarded by
 *    `if (upd.circuit < 1 || !upd.designation) continue`, and a delete has no
 *    designation to carry (the backend projects `''` because iOS declares that
 *    field non-optional). Every `delete_circuit` the inspector spoke — and
 *    heard confirmed — was dropped, so the circuit stayed on screen.
 *
 * 2. METADATA-FREE CREATES NEVER ARRIVED. Same guard. The wire carrier for a
 *    create is a fold of the op's metadata into `readings`, and the fold skips
 *    null values, so a bare `create_circuit{circuit_ref}` emitted no reading at
 *    all — the row reached NEITHER carrier and the next dictated reading for
 *    that circuit had nothing to land on.
 *
 * 3. OPS WERE BOARD-BLIND. `ensureRow` resolves by ref alone and refs are PER
 *    BOARD, so a `select_board sub-b → delete 2` turn deleted MAIN's circuit 2.
 *
 * Plus the structural property the three fixes share: ops are applied in ONE
 * ORDERED PASS in wire order, with the row indexes rebuilt after every topology
 * mutation, because `create 3 → delete 3` means the opposite of
 * `delete 3 → create 3` and a staged implementation would reorder the
 * inspector's intent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { CircuitUpdate, ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

const MAIN = 'main';
const SUB = 'sub-b';

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
    boards: [
      { id: MAIN, designation: 'DB-1', board_type: 'main' },
      { id: SUB, designation: 'DB-2', board_type: 'sub_distribution', parent_board_id: MAIN },
    ],
    ...over,
  } as unknown as JobDetail;
}

function singleBoardJob(over: Partial<JobDetail> = {}): JobDetail {
  return makeJob({ boards: [{ id: MAIN, designation: 'DB-1', board_type: 'main' }], ...over } as
    Partial<JobDetail>);
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

const row = (over: Partial<CircuitRow> = {}): CircuitRow =>
  ({
    id: 'c-x',
    circuit_ref: '2',
    circuit_designation: 'Sockets',
    ...over,
  }) as CircuitRow;

/** A circuit op exactly as the backend now projects it. */
const op = (over: Partial<CircuitUpdate> & { circuit: number }): CircuitUpdate =>
  ({ designation: '', action: 'create', ...over }) as CircuitUpdate;

const applied = (job: JobDetail, result: ExtractionResult) => {
  const out = applyExtractionToJob(job, result);
  expect(out).not.toBeNull();
  return out!.patch.circuits!;
};
const stages = () => getPipelineLog().map((e) => e.stage);

beforeEach(() => {
  clearPipelineLog();
});

// ---------------------------------------------------------------------------
// 1. Deletes arrive, and land on the right board.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — a spoken delete actually removes the row', () => {
  it('removes the circuit on the board the server mutated, leaving the other board alone', () => {
    const job = makeJob({
      circuits: [
        row({ id: 'c-main-2', board_id: MAIN } as Partial<CircuitRow>),
        row({ id: 'c-sub-2', board_id: SUB, circuit_designation: 'Shed sockets' } as Partial<CircuitRow>),
      ],
    });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 2, action: 'delete', board_id: SUB })] })
    );

    // Pre-fix BOTH assertions failed: the op never reached the loop body at
    // all, so nothing was deleted; had the guard let it through, ref-only
    // resolution would have deleted MAIN's row instead.
    expect(circuits.map((c) => c.id)).toEqual(['c-main-2']);
    expect(stages()).toContain('apply_circuit_delete_applied');
  });

  it('an unscoped delete on a MULTI-board job fails closed rather than guessing', () => {
    const job = makeJob({
      circuits: [
        row({ id: 'c-main-2', board_id: MAIN } as Partial<CircuitRow>),
        row({ id: 'c-sub-2', board_id: SUB } as Partial<CircuitRow>),
      ],
    });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 2, action: 'delete' })] })
    );

    // A delete is the most destructive op on the wire. An ambiguous target is
    // never guessed at — the inspector can re-say it; a wrong-board delete of a
    // completed circuit's readings is not recoverable by ear.
    expect(circuits).toHaveLength(2);
    expect(stages()).toContain('apply_circuit_delete_declined');
  });

  it('an unscoped delete on a SINGLE-board job still works (legacy flat traffic)', () => {
    const job = singleBoardJob({ circuits: [row({ id: 'c-2' })] });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 2, action: 'delete' })] })
    );

    expect(circuits).toHaveLength(0);
  });

  it('a delete naming a ref that has no row leaves the job untouched', () => {
    const job = singleBoardJob({ circuits: [row({ id: 'c-2' })] });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 9, action: 'delete' })] })
    );

    expect(circuits.map((c) => c.id)).toEqual(['c-2']);
    expect(stages()).toContain('apply_circuit_delete_declined');
  });
});

// ---------------------------------------------------------------------------
// 2. Metadata-free creates arrive.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — a create with no designation still creates the row', () => {
  it('creates the row so the NEXT dictated reading has somewhere to land', () => {
    const job = singleBoardJob({ circuits: [] });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 6, action: 'create' })] })
    );

    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_ref).toBe('6');
    expect(stages()).toContain('apply_circuit_create_bare_applied');
  });

  it('scopes the new row to the board the server created it on', () => {
    const job = makeJob({ circuits: [row({ id: 'c-main-4', circuit_ref: '4', board_id: MAIN } as Partial<CircuitRow>)] });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 4, action: 'create', board_id: SUB })] })
    );

    // Ref-only resolution would have found MAIN's circuit 4 and created
    // nothing — the sub-board circuit would silently not exist.
    expect(circuits).toHaveLength(2);
    expect(circuits[1].board_id).toBe(SUB);
    expect(circuits[1].circuit_ref).toBe('4');
  });

  it('a rename with no designation is still skipped (nothing to write)', () => {
    const job = singleBoardJob({ circuits: [row({ id: 'c-2' })] });

    const circuits = applied(
      job,
      makeResult({ circuit_updates: [op({ circuit: 2, action: 'rename' })] })
    );

    expect(circuits[0].circuit_designation).toBe('Sockets');
    expect(stages()).toContain('apply_circuit_update_skipped');
  });
});

// ---------------------------------------------------------------------------
// 3. A renumbering rename MOVES the row.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — `from_ref` re-keys instead of duplicating', () => {
  it('moves the existing row (with its readings) to the new ref', () => {
    const job = singleBoardJob({
      circuits: [row({ id: 'c-2', measured_zs_ohm: '0.42' } as Partial<CircuitRow>)],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [
          op({ circuit: 5, from_ref: 2, action: 'rename', designation: 'Cooker' }),
        ],
      })
    );

    // The defect this pins: without `from_ref` the client could only ADD a row
    // at ref 5 and left circuit 2 behind as a duplicate — with the readings
    // still on the stale row.
    expect(circuits).toHaveLength(1);
    expect(circuits[0].id).toBe('c-2');
    expect(circuits[0].circuit_ref).toBe('5');
    expect(circuits[0].circuit_designation).toBe('Cooker');
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
  });

  it('declines the move when the destination ref is already occupied', () => {
    const job = singleBoardJob({
      circuits: [row({ id: 'c-2' }), row({ id: 'c-5', circuit_ref: '5', circuit_designation: 'Lights' })],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 5, from_ref: 2, action: 'rename', designation: 'Cooker' })],
      })
    );

    // Merging two circuits' readings is worse than a stale ref.
    expect(circuits).toHaveLength(2);
    expect(circuits.find((c) => c.id === 'c-2')!.circuit_ref).toBe('2');
    expect(stages()).toContain('apply_circuit_rekey_declined');
  });

  it('re-keys within the naming board only', () => {
    const job = makeJob({
      circuits: [
        row({ id: 'c-main-2', board_id: MAIN } as Partial<CircuitRow>),
        row({ id: 'c-sub-2', board_id: SUB } as Partial<CircuitRow>),
      ],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [
          op({ circuit: 5, from_ref: 2, action: 'rename', designation: 'Cooker', board_id: SUB }),
        ],
      })
    );

    expect(circuits.find((c) => c.id === 'c-main-2')!.circuit_ref).toBe('2');
    expect(circuits.find((c) => c.id === 'c-sub-2')!.circuit_ref).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// 4. ONE ORDERED PASS — wire order is authoritative.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — ops apply in wire order, indexes rebuilt between them', () => {
  it('create → delete on the same ref leaves nothing behind', () => {
    const job = singleBoardJob({ circuits: [] });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [
          op({ circuit: 7, action: 'create', designation: 'Immersion' }),
          op({ circuit: 7, action: 'delete' }),
        ],
      })
    );

    expect(circuits).toHaveLength(0);
  });

  it('delete → create on the same ref leaves a FRESH row, not the deleted one', () => {
    const job = singleBoardJob({
      circuits: [row({ id: 'c-old-7', circuit_ref: '7', measured_zs_ohm: '0.99' } as Partial<CircuitRow>)],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [
          op({ circuit: 7, action: 'delete' }),
          op({ circuit: 7, action: 'create', designation: 'Immersion' }),
        ],
      })
    );

    // The opposite order to the test above, and it MUST mean something
    // different: the old circuit's readings are gone and the new row is bare.
    expect(circuits).toHaveLength(1);
    expect(circuits[0].id).not.toBe('c-old-7');
    expect(circuits[0].circuit_designation).toBe('Immersion');
    expect(circuits[0].measured_zs_ohm).toBeUndefined();
  });

  it('two deletes in one envelope both land', () => {
    const job = singleBoardJob({
      circuits: [row({ id: 'c-1', circuit_ref: '1' }), row({ id: 'c-2' }), row({ id: 'c-3', circuit_ref: '3' })],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 1, action: 'delete' }), op({ circuit: 3, action: 'delete' })],
      })
    );

    // A stale index after the first delete would have made the second resolve
    // to the wrong array position (or to a row that no longer exists).
    expect(circuits.map((c) => c.id)).toEqual(['c-2']);
  });

  it('a reading in the SAME envelope lands on the row the create just made', () => {
    const job = singleBoardJob({ circuits: [] });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 4, action: 'create' })],
        readings: [
          { circuit: 4, field: 'measured_zs_ohm', value: '0.42' },
        ] as unknown as ExtractionResult['readings'],
      })
    );

    expect(circuits).toHaveLength(1);
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
  });

  it('a deleted circuit is not resurrected by a later reading landing on a stale index', () => {
    const job = singleBoardJob({
      circuits: [row({ id: 'c-1', circuit_ref: '1' }), row({ id: 'c-2' })],
    });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 1, action: 'delete' })],
        readings: [
          { circuit: 2, field: 'measured_zs_ohm', value: '0.42' },
        ] as unknown as ExtractionResult['readings'],
      })
    );

    expect(circuits.map((c) => c.id)).toEqual(['c-2']);
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
  });
});

// ---------------------------------------------------------------------------
// 5. (E) — a create makes its row eligible for a same-envelope replacement.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — a created row is a legal `replaces_cleared` target', () => {
  it('a flagged replacement writes to the circuit this same envelope created', () => {
    const job = singleBoardJob({ circuits: [] });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 4, action: 'create', designation: 'Cooker' })],
        readings: [
          { circuit: 4, field: 'measured_zs_ohm', value: '0.42', replaces_cleared: true },
        ] as unknown as ExtractionResult['readings'],
      })
    );

    // The fail-closed replacement resolver counts eligible rows out of
    // `refCounts`, which `ensureRow` never maintained — so before the
    // index rebuild a just-created circuit was `orphan` to its OWN
    // replacement and the write was declined. Spoken, never written.
    expect(circuits).toHaveLength(1);
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
    expect(stages()).not.toContain('apply_replaces_cleared_orphan_board_ref');
  });

  it('a board-scoped create makes the scoped row eligible for a scoped replacement', () => {
    const job = makeJob({ circuits: [row({ id: 'c-main-4', circuit_ref: '4', board_id: MAIN } as Partial<CircuitRow>)] });

    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [op({ circuit: 4, action: 'create', board_id: SUB, designation: 'Shed' })],
        readings: [
          { circuit: 4, field: 'measured_zs_ohm', value: '0.55', board_id: SUB, replaces_cleared: true },
        ] as unknown as ExtractionResult['readings'],
      })
    );

    expect(circuits.find((c) => c.board_id === SUB)!.measured_zs_ohm).toBe('0.55');
    expect(circuits.find((c) => c.id === 'c-main-4')!.measured_zs_ohm).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed entries still cannot create junk rows.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — malformed ops are skipped, not applied', () => {
  it('an op with no `circuit` no longer synthesises a row keyed "undefined"', () => {
    const job = singleBoardJob({ circuits: [] });

    // Paired with a VALID op deliberately: `applyExtractionToJob` gates entry
    // on `circuit_updates.some((u) => u.circuit >= 1)`, so a LONE malformed
    // entry never reaches the loop at all. The valid op opens the door; the
    // malformed one then has to be rejected inside it.
    const circuits = applied(
      job,
      makeResult({
        circuit_updates: [
          op({ circuit: 3, action: 'create', designation: 'Lights' }),
          { designation: 'Cooker', action: 'create' } as unknown as CircuitUpdate,
        ],
      })
    );

    // `undefined < 1` is false, so the old guard let the malformed entry
    // through to `ensureRow(undefined)` — a row with `circuit_ref: "undefined"`
    // — while its own `circuit_undefined` reason string was unreachable.
    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_ref).toBe('3');
    const skipped = getPipelineLog().filter((e) => e.stage === 'apply_circuit_update_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload?.reason).toBe('circuit_undefined');
  });
});
