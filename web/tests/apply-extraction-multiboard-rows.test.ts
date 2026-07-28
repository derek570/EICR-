/**
 * A2-multiboard (2026-07-28) — web resolves a reading's row by
 * `(board_id, circuit_ref)`, not by ref alone.
 *
 * Circuit refs are PER BOARD: every board has a circuit 1. Web's apply resolved
 * every reading through `ensureRow(circuit)` — ref-only — so a turn that writes
 * the SAME ref on TWO boards
 * (`select_board A → "Zs on 3 is 0.42" → select_board B → "Zs on 3 is 0.55"`)
 * collapsed both winners onto whichever circuit-3 row web found first. One of
 * the two readings was read back aloud and never written: spoken-but-not-
 * written, the inverse Audio-First #1 violation, and undetectable by a
 * hands-free inspector who heard both confirmations.
 *
 * The backend half stamps the dispatcher-resolved effective board onto every
 * winner of a cross-board turn (`stage6-event-bundler.js`). That alone changes
 * NOTHING until the consumer reads it — these tests are the consumer half, and
 * they assert FINAL CLIENT STATE, not wire survival.
 *
 * The second property, equally load-bearing: the branch is non-destructive.
 * Every case web cannot resolve unambiguously falls back to the ref-only
 * behaviour that shipped before it, so no reading is dropped and no existing
 * job shape changes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
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
    circuit_ref: '3',
    circuit_designation: 'Sockets',
    ...over,
  }) as CircuitRow;

/** A `record_reading` winner as the backend now stamps it on a cross-board turn. */
const zs = (boardId: string | undefined, value: string, circuit = 3) =>
  ({
    circuit,
    field: 'measured_zs_ohm',
    value,
    ...(boardId === undefined ? {} : { board_id: boardId }),
  }) as unknown as ExtractionResult['readings'][number];

const applied = (job: JobDetail, result: ExtractionResult) => {
  const out = applyExtractionToJob(job, result);
  expect(out).not.toBeNull();
  return out!.patch.circuits!;
};
const stages = () => getPipelineLog().map((e) => e.stage);

beforeEach(() => {
  clearPipelineLog();
});

describe('A2-multiboard — a cross-board turn lands each reading on its OWN board', () => {
  it('both boards already have their circuit 3: each write hits its own row', () => {
    const job = makeJob({
      circuits: [
        row({ id: 'c-main-3', board_id: MAIN } as Partial<CircuitRow>),
        row({ id: 'c-sub-3', board_id: SUB } as Partial<CircuitRow>),
      ],
    });

    const circuits = applied(job, makeResult({ readings: [zs(MAIN, '0.42'), zs(SUB, '0.55')] }));

    // The whole defect in one assertion pair: ref-only resolution put BOTH of
    // these on `c-main-3` and the second silently won.
    expect(circuits.find((c) => c.id === 'c-main-3')!.measured_zs_ohm).toBe('0.42');
    expect(circuits.find((c) => c.id === 'c-sub-3')!.measured_zs_ohm).toBe('0.55');
  });

  it('only board A has the row: board B gets its OWN scoped row rather than overwriting A', () => {
    const job = makeJob({
      circuits: [row({ id: 'c-main-3', board_id: MAIN } as Partial<CircuitRow>)],
    });

    const circuits = applied(job, makeResult({ readings: [zs(MAIN, '0.42'), zs(SUB, '0.55')] }));

    expect(circuits).toHaveLength(2);
    expect(circuits.find((c) => c.id === 'c-main-3')!.measured_zs_ohm).toBe('0.42');
    const created = circuits.find((c) => c.id !== 'c-main-3')!;
    expect((created as unknown as Record<string, unknown>).board_id).toBe(SUB);
    expect(created.circuit_ref).toBe('3');
    expect(created.measured_zs_ohm).toBe('0.55');
    expect(stages()).toContain('apply_circuit_reading_board_scoped_row_created');
  });

  it('a LEGACY unscoped row is claimed by the first board; the second gets its own', () => {
    // The commonest real multi-board shape: flat legacy rows the Board tab
    // never scoped, plus a board registry that names two boards.
    const job = makeJob({ circuits: [row({ id: 'c-legacy-3' })] });

    const circuits = applied(job, makeResult({ readings: [zs(MAIN, '0.42'), zs(SUB, '0.55')] }));

    expect(circuits).toHaveLength(2);
    // Claimed, not re-stamped — web has no authority to decide which board a
    // legacy row belongs to, only that it cannot belong to BOTH.
    const legacy = circuits.find((c) => c.id === 'c-legacy-3')!;
    expect(legacy.measured_zs_ohm).toBe('0.42');
    expect((legacy as unknown as Record<string, unknown>).board_id).toBeUndefined();
    expect(circuits.find((c) => c.id !== 'c-legacy-3')!.measured_zs_ohm).toBe('0.55');
  });

  it('order is deterministic — the OTHER dictation order mirrors exactly', () => {
    const job = makeJob({ circuits: [row({ id: 'c-legacy-3' })] });

    const circuits = applied(job, makeResult({ readings: [zs(SUB, '0.55'), zs(MAIN, '0.42')] }));

    expect(circuits.find((c) => c.id === 'c-legacy-3')!.measured_zs_ohm).toBe('0.55');
    const created = circuits.find((c) => c.id !== 'c-legacy-3')!;
    expect((created as unknown as Record<string, unknown>).board_id).toBe(MAIN);
    expect(created.measured_zs_ohm).toBe('0.42');
  });
});

describe('A2-multiboard — the branch is non-destructive everywhere it cannot resolve', () => {
  it('an UNSCOPED reading is still ref-only — every single-board turn is unchanged', () => {
    const job = makeJob({ circuits: [row({ id: 'c-legacy-3' })] });

    const circuits = applied(job, makeResult({ readings: [zs(undefined, '0.42')] }));

    expect(circuits).toHaveLength(1);
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
    expect(stages()).not.toContain('apply_circuit_reading_board_scoped_row_created');
  });

  it('a board web has NO independent evidence of falls back to ref-only, never a phantom row', () => {
    // Registry mismatch: the server asserts a board web has never seen. An
    // assertion must not license inventing a circuit on a board that may not
    // exist here — the pre-change ref-only write is the safer status quo, and
    // it still LANDS (declining is never a skip).
    const job = makeJob({
      boards: [{ id: 'db-1', designation: 'DB-1', board_type: 'main' }],
      circuits: [row({ id: 'c-1', board_id: 'db-1' } as Partial<CircuitRow>)],
    } as Partial<JobDetail>);

    const circuits = applied(job, makeResult({ readings: [zs('ghost-board', '0.42')] }));

    expect(circuits).toHaveLength(1);
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
    expect(stages()).toContain('apply_circuit_reading_unevidenced_board');
  });

  it('a scoped reading for a ref no row has yet still creates exactly one row', () => {
    const job = makeJob({
      circuits: [row({ id: 'c-main-3', board_id: MAIN } as Partial<CircuitRow>)],
    });

    const circuits = applied(job, makeResult({ readings: [zs(SUB, '0.55', 7)] }));

    expect(circuits).toHaveLength(2);
    const created = circuits.find((c) => c.circuit_ref === '7')!;
    expect((created as unknown as Record<string, unknown>).board_id).toBe(SUB);
    expect(created.measured_zs_ohm).toBe('0.55');
  });

  it('a scoped sibling row never steals ref-only `field_clears` from the original row', () => {
    // `field_clears` and `circuit_updates` are ref-only on the wire. Creating a
    // board-scoped sibling must not re-point them, or a clear aimed at the
    // legacy row would land on a row the inspector never spoke about.
    const job = makeJob({
      circuits: [row({ id: 'c-legacy-3', measured_zs_ohm: '1.50' } as Partial<CircuitRow>)],
    });

    const circuits = applied(
      job,
      makeResult({
        readings: [zs(MAIN, '0.42'), zs(SUB, '0.55')],
        field_clears: [
          { circuit: 3, field: 'measured_zs_ohm' } as unknown as NonNullable<
            ExtractionResult['field_clears']
          >[number],
        ],
      })
    );

    // The clear followed the ref to the ORIGINAL row (which board A had claimed)…
    expect(circuits.find((c) => c.id === 'c-legacy-3')!.measured_zs_ohm).toBeUndefined();
    // …and board B's own row is untouched by it.
    expect(circuits.find((c) => c.id !== 'c-legacy-3')!.measured_zs_ohm).toBe('0.55');
  });
});

// ---------------------------------------------------------------------------
// Archive §4 leg 4d-iv — the CONSUMER half of the ordinary-write LWW dedup.
//
// The producer half (`stage6-a2-replaces-cleared.test.js`, leg 4d-iv) proves
// the backend now emits exactly ONE reading — the LAST value — when a turn
// spells one effective slot two ways. That fix is only meaningful because of
// what web does with two: its gate is fill-only, so it filled on the FIRST and
// skipped the second with `apply_circuit_reading_user_value_kept` — ending on
// the OLDER value while the backend snapshot and iOS both ended
// last-write-wins. These legs pin BOTH sides of that: the divergence web still
// has if two ever arrive, and the correct outcome for the one that does.
// ---------------------------------------------------------------------------

describe('A2-multiboard leg 4d-iv — web ends on the LAST value the backend kept', () => {
  it('the single deduped reading lands, even though a sibling spelling would have been skipped', () => {
    const job = makeJob({
      boards: [{ id: MAIN, designation: 'DB-1', board_type: 'main' }],
      circuits: [row({ id: 'c-legacy-3' })],
    } as Partial<JobDetail>);

    // Exactly what the producer leg asserts reaches the wire: ONE reading,
    // the later value.
    const circuits = applied(job, makeResult({ readings: [zs(undefined, '0.44')] }));

    expect(circuits.find((c) => c.id === 'c-legacy-3')!.measured_zs_ohm).toBe('0.44');
    expect(stages()).not.toContain('apply_circuit_reading_user_value_kept');
  });

  it('WHY THE BACKEND MUST DEDUP — two spellings of one slot leave web on the FIRST', () => {
    // The characterisation lock. This is the divergence, reproduced: web's
    // fill-only gate is order-sensitive and has no notion of "the server sent
    // me two views of one write", so it keeps the earlier value and logs the
    // skip. If a future change ever makes web LWW on its own, this test goes
    // red and the backend dedup can be reconsidered — until then the dedup is
    // load-bearing, not belt-and-braces.
    const job = makeJob({
      boards: [{ id: MAIN, designation: 'DB-1', board_type: 'main' }],
      circuits: [row({ id: 'c-legacy-3' })],
    } as Partial<JobDetail>);

    const circuits = applied(
      job,
      makeResult({ readings: [zs(undefined, '0.42'), zs(MAIN, '0.44')] })
    );

    expect(circuits.find((c) => c.id === 'c-legacy-3')!.measured_zs_ohm).toBe('0.42');
    expect(stages()).toContain('apply_circuit_reading_user_value_kept');
  });
});

// ---------------------------------------------------------------------------
// Archive §4 leg 4e — a flagged LIM replacement on a multi-board job.
//
// `apply_circuit_reading_lim_ambiguous_ref_skipped` (F6/F4) drops a LIM write
// ENTIRELY when its ref is ambiguous, because a LIM overwrites a populated cell
// and web's ref-only apply could not tell two boards' circuit 1 apart —
// corrupting the wrong board is worse than dropping the write.
//
// Item 6 bypasses that guard for a FLAGGED replacement, and only AFTER the
// resolver has already returned a single row. That ordering is the whole
// safety argument: the resolver DECLINES rather than picks, so the ambiguity
// the guard defends against has already been ruled out by the time the bypass
// is consulted. Leaving the guard armed there would silently drop exactly the
// spoken-and-cleared LIM correction the board scoping exists to route.
// ---------------------------------------------------------------------------

describe('A2-multiboard leg 4e — a flagged LIM replacement routes; an unflagged one still fails closed', () => {
  const limOn = (boardId: string, flagged: boolean) =>
    ({
      circuit: 1,
      field: 'measured_zs_ohm',
      value: 'LIM',
      board_id: boardId,
      ...(flagged ? { replaces_cleared: true } : {}),
    }) as unknown as ExtractionResult['readings'][number];

  const twoBoardsSharingCircuit1 = () =>
    makeJob({
      circuits: [
        row({
          id: 'c-main-1',
          circuit_ref: '1',
          board_id: MAIN,
          measured_zs_ohm: '0.42',
        } as Partial<CircuitRow>),
        row({
          id: 'c-sub-1',
          circuit_ref: '1',
          board_id: SUB,
          measured_zs_ohm: '0.55',
        } as Partial<CircuitRow>),
      ],
    });

  it('FLAGGED — only the named board becomes LIM, and the ambiguity guard never fires', () => {
    const circuits = applied(
      twoBoardsSharingCircuit1(),
      makeResult({ readings: [limOn(SUB, true)] })
    );

    expect(circuits.find((c) => c.id === 'c-sub-1')!.measured_zs_ohm).toBe('LIM');
    // The other board's reading is untouched — the corruption the guard exists
    // to prevent did not happen by another route.
    expect(circuits.find((c) => c.id === 'c-main-1')!.measured_zs_ohm).toBe('0.42');
    expect(stages()).not.toContain('apply_circuit_reading_lim_ambiguous_ref_skipped');
    // …and it landed as a REPLACEMENT over a populated cell, not by accident on
    // an empty one.
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('NEGATIVE — the identical UNFLAGGED LIM still fails closed on the ambiguous ref', () => {
    const circuits = applied(
      twoBoardsSharingCircuit1(),
      makeResult({ readings: [limOn(SUB, false)] })
    );

    // Nothing moved on EITHER board…
    expect(circuits.find((c) => c.id === 'c-main-1')!.measured_zs_ohm).toBe('0.42');
    expect(circuits.find((c) => c.id === 'c-sub-1')!.measured_zs_ohm).toBe('0.55');
    // …and the drop is explained in the log rather than being silent.
    expect(stages()).toContain('apply_circuit_reading_lim_ambiguous_ref_skipped');
  });
});
