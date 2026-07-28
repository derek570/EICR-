/**
 * A2 (2026-07-28) — `replaces_cleared`, the CONSUMER half.
 *
 * The defect this closes: the backend collapses a same-turn `clear_reading` +
 * `record_reading` for one circuit slot (P5, 2026-07-23), so the wire carries a
 * BARE write against a cell web still believes the user owns. Web's fill-only,
 * source-agnostic 3-tier gate (`hasValue(cell)` → skip) silently DROPPED it:
 * the assistant SPOKE the replacement and the server + iOS stored it, while web
 * kept the STALE value. Spoken but not written — the inverse Audio-First
 * violation, and invisible to a hands-free inspector verifying by ear.
 *
 * `replaces_cleared: true` carries the one fact the collapse destroyed — the
 * server already emptied this cell — so the overwrite is a REPLACEMENT rather
 * than a 3-tier priority regression, and the gate stays intact for everything
 * else.
 *
 * The two properties every test here exists to protect:
 *
 *   1. The bypass is NARROW. It fires only for a flagged reading on an
 *      unambiguously-resolvable single-board slot. An unflagged reading must
 *      still be blocked by the gate, or A2 has quietly deleted the protection
 *      that stops a low-priority source clobbering CCU/manual data.
 *
 *   2. Declining is never a SKIP. Every path that refuses the bypass falls
 *      through to the unchanged gate, so an empty cell still fills. A
 *      fail-closed skip would manufacture a fresh spoken-but-not-written case —
 *      the very defect being closed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';
import wireContract from '../../tests/fixtures/test-contracts/replaces-cleared-circuit.json';

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

/** A circuit 1 whose IR L-L cell is already populated — the cell the
 *  collapsed replacement has to be able to overwrite. */
const populatedRow = (over: Partial<CircuitRow> = {}): CircuitRow => ({
  id: 'c-1',
  circuit_ref: '1',
  circuit_designation: 'Sockets',
  ir_live_live_mohm: 'LIM',
  ...over,
});

/** The replacement reading, as the backend stamps it. */
const flaggedReading = (over: Record<string, unknown> = {}) =>
  ({
    circuit: 1,
    field: 'ir_live_live_mohm',
    value: '100',
    replaces_cleared: true,
    ...over,
  }) as unknown as ExtractionResult['readings'][number];

const stages = () => getPipelineLog().map((e) => e.stage);
const cellAfter = (job: JobDetail, result: ExtractionResult, idx = 0) => {
  const applied = applyExtractionToJob(job, result);
  expect(applied).not.toBeNull();
  return applied!.patch.circuits![idx];
};

beforeEach(() => {
  clearPipelineLog();
});

// ---------------------------------------------------------------------------
// 1 + 2 — the bypass fires, and ONLY for a flagged reading.
// ---------------------------------------------------------------------------

describe('A2 — the flagged replacement overwrites a populated cell', () => {
  it('applies a `replaces_cleared` reading over an existing value (single-board job)', () => {
    const job = makeJob({ circuits: [populatedRow()] });
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('GATE INTACT — the identical reading WITHOUT the flag is still blocked', () => {
    const job = makeJob({ circuits: [populatedRow()] });
    const row = cellAfter(
      job,
      makeResult({ readings: [flaggedReading({ replaces_cleared: undefined })] })
    );

    // This is the pre-A2 behaviour and it must not change: a bare write never
    // clobbers a value the user (or CCU) already owns.
    expect(row.ir_live_live_mohm).toBe('LIM');
    expect(stages()).toContain('apply_circuit_reading_user_value_kept');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('an explicit `replaces_cleared: false` is treated as unflagged (strict === true)', () => {
    const job = makeJob({ circuits: [populatedRow()] });
    const row = cellAfter(
      job,
      makeResult({ readings: [flaggedReading({ replaces_cleared: false })] })
    );
    expect(row.ir_live_live_mohm).toBe('LIM');
  });

  it('the flag on ONE reading never leaks onto a sibling ordinary write in the same envelope', () => {
    const job = makeJob({
      circuits: [populatedRow({ measured_zs_ohm: '1.50' })],
    });
    const row = cellAfter(
      job,
      makeResult({
        readings: [
          flaggedReading(),
          flaggedReading({
            field: 'measured_zs_ohm',
            value: '0.42',
            replaces_cleared: undefined,
          }),
        ],
      })
    );

    expect(row.ir_live_live_mohm).toBe('100'); // flagged → replaced
    expect(row.measured_zs_ohm).toBe('1.50'); // unflagged → kept
  });

  it('translates the LEGACY wire field name before resolving the cell', () => {
    // The backend renames canonical → legacy on egress
    // (`ir_live_live_mohm` → `insulation_resistance_l_l`), so the bypass has to
    // survive `translateCircuitField` or it would look at the wrong column.
    const job = makeJob({ circuits: [populatedRow()] });
    const row = cellAfter(
      job,
      makeResult({ readings: [flaggedReading({ field: 'insulation_resistance_l_l' })] })
    );
    expect(row.ir_live_live_mohm).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// 3 — multi-board deferral, asserted through all three cardinality sources.
//
// Web's apply is REF-ONLY (`circuit_ref` carries no board scope), so on a
// multi-board job two boards' "circuit 1" are indistinguishable here and an
// overwrite could clobber the WRONG board's value. The gate therefore counts
// the UNION of every board identity visible this turn; >1 defers.
// ---------------------------------------------------------------------------

describe('A2 — multi-board jobs defer (all three cardinality sources)', () => {
  const expectDeferred = (job: JobDetail, result: ExtractionResult) => {
    const row = cellAfter(job, result);
    expect(row.ir_live_live_mohm).toBe('LIM'); // unchanged — fell through to the gate
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  };

  it('source 1 — the job board registry names two boards', () => {
    expectDeferred(
      makeJob({
        circuits: [populatedRow()],
        boards: [{ id: 'main' }, { id: 'sub-1' }],
      } as unknown as Partial<JobDetail>),
      makeResult({ readings: [flaggedReading()] })
    );
  });

  it('source 2 — existing circuit ROWS carry two distinct board ids', () => {
    expectDeferred(
      makeJob({
        circuits: [
          populatedRow({ board_id: 'main' } as Partial<CircuitRow>),
          { id: 'c-2', circuit_ref: '2', board_id: 'sub-1' } as CircuitRow,
        ],
      }),
      makeResult({ readings: [flaggedReading()] })
    );
  });

  it('source 3 — a SIBLING reading in the same envelope names a second board', () => {
    // Nothing on the job says multi-board; only the envelope does. Without this
    // source the bypass would fire against a board registry that is merely
    // stale, which is exactly when guessing is most dangerous.
    expectDeferred(
      makeJob({
        circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
      }),
      makeResult({
        readings: [
          flaggedReading({ board_id: 'main' }),
          flaggedReading({
            circuit: 2,
            field: 'measured_zs_ohm',
            value: '0.42',
            board_id: 'sub-1',
            replaces_cleared: undefined,
          }),
        ],
      })
    );
  });

  it('3c — the INCOMING reading names a board the job does not know about', () => {
    expectDeferred(
      makeJob({
        circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
      }),
      makeResult({ readings: [flaggedReading({ board_id: 'sub-1' })] })
    );
  });

  it('source 4 — a same-envelope `add_board` defers, even though boards[] is still single', () => {
    // The ordering trap: `board_ops` rides this envelope but the caller applies
    // it AFTER the readings (`onBoardOps` fires after `onExtraction`). Read off
    // `job.boards` alone, cardinality is 1 at apply time and the bypass would
    // overwrite the ORIGINAL board's circuit 1 before board B exists.
    expectDeferred(
      makeJob({
        circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
        boards: [{ id: 'main' }],
      } as unknown as Partial<JobDetail>),
      makeResult({
        readings: [flaggedReading()],
        board_ops: [{ op: 'add_board', board_id: 'sub-1', designation: 'Garage CU' }],
      })
    );
  });

  it('source 4b — an `add_board` whose id is empty STILL defers (the belt-and-braces term)', () => {
    // A malformed op contributes nothing to the id union, so the set-size test
    // alone would pass it. `addsBoardThisTurn` is what catches it.
    expectDeferred(
      makeJob({
        circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
        boards: [{ id: 'main' }],
      } as unknown as Partial<JobDetail>),
      makeResult({
        readings: [flaggedReading()],
        board_ops: [{ op: 'add_board', board_id: '' }],
      })
    );
  });

  it('source 4c — a NON-add board op on one board does not defer', () => {
    // `select_board` naming the board we already know about is not evidence of
    // a second board; deferring on it would cost overwrites for nothing.
    const job = makeJob({
      circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
      boards: [{ id: 'main' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'main' })],
        board_ops: [{ op: 'select_board', board_id: 'main' }],
      })
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('source 4d — a `select_board` onto a board web has NO record of defers', () => {
    // The wrong-board class `add_board` covers, reached by a different door.
    // Legacy/stale job: no `boards[]`, no row scope — so web's own evidence is
    // EMPTY. The server, which knows main + sub-1, selects sub-1 and sends a
    // board-omitted flagged replacement for "circuit 1". Folding the op's id in
    // makes the union exactly {sub-1} — cardinality 1, no add_board — so on
    // count alone this would take the bypass and overwrite the one flat
    // "circuit 1" row, which may well be the MAIN board's. Naming a board web
    // cannot independently corroborate means the registries are out of sync and
    // the ref is unroutable, so it defers.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading()],
        board_ops: [{ op: 'select_board', board_id: 'sub-1' }],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('LIM');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
    const deferred = getPipelineLog().find(
      (e) => e.stage === 'apply_replaces_cleared_multiboard_deferred'
    );
    // Pinned so the reason cannot silently become the cardinality term: this
    // case defers at count 1, which is exactly what the count alone misses.
    expect(deferred?.payload).toMatchObject({
      unknown_named_board: true,
      effective_board_count: 1,
    });
  });

  it('source 4f — a READING naming a board web has NO record of defers (no ops at all)', () => {
    // The same unroutable-ref class as 4d, reached through the OTHER door and
    // with an EMPTY `board_ops` — so nothing in the op term can catch it. Web
    // has no `boards[]` and one unscoped flat "circuit 1" row; the server sends
    // a flagged replacement stamped `board_id:'sub-1'`. If the reading's own id
    // were allowed to count as evidence FOR ITSELF the union would be exactly
    // {sub-1} — cardinality 1, no ops — and the bypass would overwrite a flat
    // row that may belong to the MAIN board.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'sub-1' })],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('LIM');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
    const deferred = getPipelineLog().find(
      (e) => e.stage === 'apply_replaces_cleared_multiboard_deferred'
    );
    expect(deferred?.payload).toMatchObject({
      unknown_named_board: true,
      adds_board_this_turn: false,
      effective_board_count: 1,
    });
  });

  it('NEVER A NEW SKIP — a reading-named-unknown-board defer still FILLS an empty cell', () => {
    const job = makeJob({
      circuits: [populatedRow({ ir_live_live_mohm: undefined })],
      boards: [],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'sub-1' })],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('a reading whose board IS in the registry stays fully evidenced and takes the bypass', () => {
    // The guard must not swallow the ordinary scoped single-board case: web
    // knows `main`, the row is scoped to `main`, and the server stamps `main`.
    const job = makeJob({
      circuits: [populatedRow({ board_id: 'main' })],
      boards: [{ id: 'main' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'main' })],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
    expect(stages()).not.toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('LEGACY SHAPE — the backend default main id overwrites on a job with no board identity', () => {
    // The single most common job shape: no `boards[]`, every row unscoped. The
    // backend has synthesised its default main board and stamps that literal
    // id on the reading. Web has never seen the string, so without the seed it
    // reads as an unknown board and the bypass declines — leaving the stale
    // value in place, i.e. the exact defect A2 exists to close.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'main' })],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
    expect(stages()).not.toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('LEGACY SHAPE — the seed cannot mask a SECOND board in the same envelope', () => {
    // The seed goes into the independence snapshot, never into the cardinality
    // set, so `main` + `sub-1` still declines on the count.
    expectDeferred(
      makeJob({ circuits: [populatedRow()], boards: [] } as unknown as Partial<JobDetail>),
      makeResult({
        readings: [
          flaggedReading({ board_id: 'main' }),
          flaggedReading({
            circuit: 2,
            field: 'measured_zs_ohm',
            value: '0.42',
            board_id: 'sub-1',
            replaces_cleared: undefined,
          }),
        ],
      } as unknown as Partial<ExtractionResult>)
    );
  });

  it('a job that HAS its own registry naming something else is a real mismatch and defers', () => {
    // The seed is deliberately narrow: it fires only when web has NO board
    // identity of its own. Here web knows `db-1`, so a server-asserted `main`
    // is a genuine registry disagreement, not the legacy flat shape.
    expectDeferred(
      makeJob({
        circuits: [populatedRow({ board_id: 'db-1' } as Partial<CircuitRow>)],
        boards: [{ id: 'db-1' }],
      } as unknown as Partial<JobDetail>),
      makeResult({ readings: [flaggedReading({ board_id: 'main' })] })
    );
  });

  it('POST-add_board TURN — a registry board no row is scoped to, beside unscoped rows, defers', () => {
    // The turn AFTER "add the garage board": web's `applyBoardOpsToJob` appended
    // `sub-1` WITHOUT materialising the implicit main its flat rows belong to,
    // so the registry says one board while the rows say a different one. The
    // write omits `board_id` (the backend omits it whenever the model relies on
    // the current board), so neither the count nor the reading term sees the
    // second scope — without this term the bypass would put SUB's reading into
    // MAIN's circuit 1.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [{ id: 'sub-1', board_type: 'sub_distribution' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('LIM');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
    const deferred = getPipelineLog().find(
      (e) => e.stage === 'apply_replaces_cleared_multiboard_deferred'
    );
    expect(deferred?.payload).toMatchObject({
      implicit_unregistered_board: true,
      effective_board_count: 1,
      unknown_named_board: false,
      adds_board_this_turn: false,
    });
  });

  it('NEVER A NEW SKIP — an implicit-unregistered-board defer still FILLS an empty cell', () => {
    const job = makeJob({
      circuits: [populatedRow({ ir_live_live_mohm: undefined })],
      boards: [{ id: 'sub-1' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('a registry board that DOES own a row is not an implicit second scope', () => {
    // Same registry, but a row is scoped to it — the unscoped sibling belongs to
    // that one board, so this stays cardinality 1 and must still bypass.
    const job = makeJob({
      circuits: [
        populatedRow({ board_id: 'sub-1' } as Partial<CircuitRow>),
        { id: 'c-2', circuit_ref: '2', circuit_designation: 'Lights' } as CircuitRow,
      ],
      boards: [{ id: 'sub-1' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
    expect(stages()).not.toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('NEVER A NEW SKIP — a `select_board`-deferred reading still FILLS an empty cell', () => {
    const job = makeJob({
      circuits: [populatedRow({ ir_live_live_mohm: undefined })],
      boards: [],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading()],
        board_ops: [{ op: 'select_board', board_id: 'sub-1' }],
      } as unknown as Partial<ExtractionResult>)
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('NEVER A NEW SKIP — an `add_board`-deferred reading still FILLS an empty cell', () => {
    const job = makeJob({
      circuits: [populatedRow({ ir_live_live_mohm: undefined, board_id: 'main' })],
      boards: [{ id: 'main' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading()],
        board_ops: [{ op: 'add_board', board_id: 'sub-1' }],
      })
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
  });

  it('3b — a SOLE board with an explicit id still bypasses (cardinality 1, not 0)', () => {
    const job = makeJob({
      circuits: [populatedRow({ board_id: 'main' } as Partial<CircuitRow>)],
      boards: [{ id: 'main' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'main' })] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('NEVER A NEW SKIP — a deferred flagged reading still FILLS an empty cell', () => {
    // The whole point of falling through rather than skipping: deferral costs
    // an overwrite, never a write.
    const job = makeJob({
      circuits: [populatedRow({ ir_live_live_mohm: undefined })],
      boards: [{ id: 'main' }, { id: 'sub-1' }],
    } as unknown as Partial<JobDetail>);
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_multiboard_deferred');
  });
});

// ---------------------------------------------------------------------------
// 3d / 3e — ref resolution on a single-board job.
// ---------------------------------------------------------------------------

describe('A2 — ref resolution declines', () => {
  it('3d — an ORPHAN ref (no such circuit before this turn) still lands, via the synthesised row', () => {
    const job = makeJob({ circuits: [populatedRow()] });
    const row = cellAfter(
      job,
      makeResult({ readings: [flaggedReading({ circuit: 7 })] }),
      1 // the row ensureRow synthesised for circuit 7
    );

    expect(row.circuit_ref).toBe('7');
    expect(row.ir_live_live_mohm).toBe('100');
    // A blank synthesised cell needs no bypass — logged, not bypassed.
    expect(stages()).toContain('apply_replaces_cleared_orphan_ref');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('3e — a DUPLICATE ref is ambiguous even on one board: the populated cell is kept', () => {
    const job = makeJob({
      circuits: [populatedRow(), populatedRow({ id: 'c-1b', ir_live_live_mohm: '50' })],
    });
    const applied = applyExtractionToJob(job, makeResult({ readings: [flaggedReading()] }));

    expect(applied).not.toBeNull();
    // Same refusal the LIM guard makes: never resolve an ambiguous ref by
    // picking one arbitrarily.
    expect(applied!.patch.circuits![0].ir_live_live_mohm).toBe('LIM');
    expect(applied!.patch.circuits![1].ir_live_live_mohm).toBe('50');
    expect(stages()).toContain('apply_replaces_cleared_duplicate_ref');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });
});

// ---------------------------------------------------------------------------
// 4 + 5 — the WIRE contract.
//
// The fixture is a verbatim snapshot of the frame the backend emits, generated
// from the real production egress chain and asserted on the backend side by
// regeneration. Importing the SAME file here is what stops the two halves of
// the contract drifting apart silently: a producer change that alters the wire
// fails the backend test, and a consumer assumption that stops matching the
// wire fails here.
// ---------------------------------------------------------------------------

describe('A2 — wire contract (shared cross-client fixture)', () => {
  const frameReadings = () =>
    JSON.parse(JSON.stringify(wireContract)).result
      .readings as unknown as ExtractionResult['readings'];

  it('the marker survives the JSON wire and is ABSENT on ordinary writes', () => {
    const readings = frameReadings();
    const replacement = readings.find((r) => r.field === 'insulation_resistance_l_l')!;
    const ordinary = readings.find((r) => r.field === 'zs')!;

    expect(replacement.replaces_cleared).toBe(true);
    // Omit-when-false is what makes a pre-A2 client byte-identical — assert the
    // KEY is absent, not merely falsy.
    expect('replaces_cleared' in ordinary).toBe(false);
  });

  it('the real backend frame drives the overwrite end-to-end', () => {
    const job = makeJob({
      circuits: [populatedRow({ measured_zs_ohm: '1.50', r1_r2_ohm: '0.86' })],
    });
    const row = cellAfter(job, makeResult({ readings: frameReadings() }));

    // The collapsed replacement lands over the stale value…
    expect(row.ir_live_live_mohm).toBe('100');
    // …and the unflagged sibling in the same real frame is still gate-blocked.
    expect(row.measured_zs_ohm).toBe('1.50');
  });
});
