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
 * ---------------------------------------------------------------------------
 * A2-multiboard item 6 (2026-07-28) — THIS SUITE HAS BEEN INVERTED.
 *
 * A2-core resolved a flagged replacement by asking an ENVELOPE-WIDE question:
 * "is this whole turn unambiguous?" It counted the union of every board
 * identity visible on the turn (registry + row scopes + sibling readings +
 * board ops) and, when that count exceeded one, DEFERRED every flagged reading
 * in the envelope — including ones whose target row was never in doubt. It then
 * fell THROUGH to the ordinary fill-only gate, so a declined replacement still
 * wrote whenever the cell happened to be empty.
 *
 * That was the right answer while web routed by bare `circuit_ref`. It is the
 * wrong question now that the backend stamps the dispatcher-resolved effective
 * board onto EVERY flagged write (item 1, `stage6-event-bundler.js`). P4b asks
 * a per-reading, structural question instead: WHICH ROWS may this replacement
 * legally land on? Compute that eligibility set in full, then branch on its
 * size.
 *
 * Four behaviours therefore INVERT, and each is asserted here as an inversion
 * rather than merely deleted — a deleted assertion proves nothing about the
 * code that replaced it:
 *
 *   1. A zero-match ref flips from "fill the freshly-synthesised row" to
 *      NO ROW CREATED. `ensureRow` is prohibited for flagged replacements.
 *   2. A duplicate ref flips from "the unflagged gate still writes the empty
 *      one" to NEITHER ROW CHANGED.
 *   3. Envelope-wide multi-board evidence flips from a blanket block to a
 *      TARGETED overwrite of the named board's row.
 *   4. Declining is now a genuine fail-closed stop, not a fall-through.
 *
 * The two properties every test here still exists to protect:
 *
 *   1. The bypass is NARROW. It fires only for a flagged reading that resolves
 *      to exactly one legal row. An unflagged reading must still be blocked by
 *      the gate, or A2 has quietly deleted the protection that stops a
 *      low-priority source clobbering CCU/manual data.
 *
 *   2. Every non-write outcome is NAMED. The partition is exhaustive
 *      (`ambiguous_board` / `orphan_board_ref` / `duplicate_board_ref`), so a
 *      silent third path cannot exist.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';
import wireContract from '../../tests/fixtures/test-contracts/replaces-cleared-circuit.json';

function makeJob(over: Record<string, unknown> = {}): JobDetail {
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

function makeResult(over: Record<string, unknown> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  } as unknown as ExtractionResult;
}

/** A circuit 1 whose IR L-L cell is already populated — the cell the
 *  collapsed replacement has to be able to overwrite. */
const populatedRow = (over: Record<string, unknown> = {}): CircuitRow =>
  ({
    id: 'c-1',
    circuit_ref: '1',
    circuit_designation: 'Sockets',
    ir_live_live_mohm: 'LIM',
    ...over,
  }) as unknown as CircuitRow;

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
const payloadOf = (stage: string) => getPipelineLog().find((e) => e.stage === stage)?.payload;

const rowsAfter = (job: JobDetail, result: ExtractionResult): CircuitRow[] => {
  const applied = applyExtractionToJob(job, result);
  expect(applied).not.toBeNull();
  expect(applied!.patch.circuits).toBeDefined();
  return applied!.patch.circuits!;
};
const cellAfter = (job: JobDetail, result: ExtractionResult, idx = 0) =>
  rowsAfter(job, result)[idx];

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
// 3 — P4b: the replacement resolves its OWN row, per reading.
//
// Every test in this block replaces an A2-core "defer the whole envelope" case.
// The old behaviour is asserted ABSENT (the stage name no longer exists in the
// codebase) alongside the new outcome, so a revert cannot pass this suite by
// re-introducing the gate.
// ---------------------------------------------------------------------------

describe('A2-multiboard — P4b resolves a flagged replacement against eligible ROWS', () => {
  it('INVERSION 3 — a multi-board job is a TARGETED overwrite, not a blanket defer', () => {
    // A2-core source 1: the registry names two boards, so the whole envelope
    // deferred and the correction was silently lost. Item 1 now stamps the
    // dispatcher-resolved board onto the flagged write, so the target is not in
    // doubt: sub-1's circuit 1 is overwritten and MAIN's is left alone.
    const job = makeJob({
      circuits: [
        populatedRow({ id: 'c-1m', board_id: 'main' }),
        populatedRow({ id: 'c-1s', board_id: 'sub-1' }),
      ],
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'sub-1' })] }));

    expect(rows[0].ir_live_live_mohm).toBe('LIM'); // main untouched
    expect(rows[1].ir_live_live_mohm).toBe('100'); // sub-1 replaced
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('INVERSION 3 — a same-envelope `add_board` no longer blocks an unrelated correction', () => {
    // A2-core source 4, the ordering trap: `board_ops` ride this envelope and
    // the caller applies them AFTER the readings, so cardinality was 1 at apply
    // time and A2-core deferred on the op alone. P4b never consults the ops —
    // the row index already says which rows exist, and the reading says which
    // board it means. "Add the garage board, and Zs on circuit 1 was 100" is a
    // targeted write plus a board creation, not an ambiguity.
    const job = makeJob({
      circuits: [populatedRow({ board_id: 'main' })],
      boards: [{ id: 'main', board_type: 'main' }],
    });
    const row = cellAfter(
      job,
      makeResult({
        readings: [flaggedReading({ board_id: 'main' })],
        board_ops: [{ op: 'add_board', board_id: 'sub-1', designation: 'Garage CU' }],
      })
    );

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4b — a replacement on the CANONICAL MAIN board inherits the legacy flat rows', () => {
    // The commonest post-`add_board` shape: the registry has main + sub, but the
    // original circuits were never scoped. Those unscoped rows genuinely belong
    // to a board, and the one board they can be ATTRIBUTED to without guessing
    // is the canonical main — that is the board whose circuits the legacy
    // namespace has always meant (item 5's rule, mirrored backend/web/iOS).
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [
        { id: 'main-uuid', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(
      job,
      makeResult({ readings: [flaggedReading({ board_id: 'main-uuid' })] })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4b (inverse) — a SUB board NEVER inherits them, and creates no row', () => {
    // The same job, the same unscoped row, but the replacement names the sub
    // board. Attribution would be a guess, so there is nothing eligible — and
    // INVERSION 1 applies: no row is synthesised to receive the value. A
    // replacement names a cell the server has already cleared, so a ref with no
    // eligible row is proof web's view and the server's disagree, not an
    // invitation to invent a circuit the inspector never mentioned.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [
        { id: 'main-uuid', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'sub-1' })] }));

    expect(rows).toHaveLength(1); // NO ROW CREATED
    expect(rows[0].ir_live_live_mohm).toBe('LIM'); // and nothing written
    expect(payloadOf('apply_replaces_cleared_orphan_board_ref')).toMatchObject({
      circuit: 1,
      board_id: 'sub-1',
      eligible_matches: 0,
    });
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4c — a scoped row COLLIDING with an attributed-unscoped row fails closed', () => {
    // The reason eligibility is computed IN FULL before it is branched on. A
    // resolver that returned on the first scoped match it found would silently
    // pick one of these two rows; both are legally "main's circuit 1", and only
    // the inspector knows which. Two candidates → neither is touched.
    const job = makeJob({
      circuits: [
        populatedRow(), // unscoped legacy row, attributed to main
        populatedRow({ id: 'c-1m', board_id: 'main', ir_live_live_mohm: '50' }),
      ],
      boards: [{ id: 'main', board_type: 'main' }],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'main' })] }));

    expect(rows[0].ir_live_live_mohm).toBe('LIM');
    expect(rows[1].ir_live_live_mohm).toBe('50');
    expect(payloadOf('apply_replaces_cleared_duplicate_board_ref')).toMatchObject({
      circuit: 1,
      board_id: 'main',
      eligible_matches: 2,
    });
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4c — two rows scoped to the SAME board and ref also fail closed', () => {
    // The array-valued index exists for exactly this: a last-wins map reports
    // both of these as one row and would overwrite an arbitrary member of the
    // pair. Duplicates have to stay observable to be declinable.
    const job = makeJob({
      circuits: [
        populatedRow({ id: 'c-1a', board_id: 'sub-1' }),
        populatedRow({ id: 'c-1b', board_id: 'sub-1', ir_live_live_mohm: '50' }),
      ],
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'sub-1' })] }));

    expect(rows[0].ir_live_live_mohm).toBe('LIM');
    expect(rows[1].ir_live_live_mohm).toBe('50');
    expect(payloadOf('apply_replaces_cleared_duplicate_board_ref')).toMatchObject({
      board_id: 'sub-1',
      eligible_matches: 2,
    });
  });

  it('leg 4d-iii — an UNSCOPED flagged reading on a multi-board job is ambiguous even when the ref is UNIQUE', () => {
    // Item 1 enriches EVERY flagged write with its effective board, so an
    // unscoped flagged reading arriving at a multi-board job means the
    // enrichment did not happen — an older backend, or a board the dispatcher
    // could not resolve. Ref uniqueness does not rescue it: two boards can each
    // have exactly one circuit 1 and only one of them is a row here, so a
    // unique-ref shortcut would write to whichever board happened to be
    // materialised.
    const job = makeJob({
      circuits: [populatedRow({ board_id: 'main' })], // the ONLY row with ref '1'
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(rows).toHaveLength(1);
    expect(rows[0].ir_live_live_mohm).toBe('LIM');
    expect(payloadOf('apply_replaces_cleared_ambiguous_board')).toMatchObject({
      circuit: 1,
      job_board_count: 2,
    });
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4d-iii (boundary) — the same unscoped reading on a SINGLE-board job still writes', () => {
    // At most one board, so every row is that board's whether it says so or
    // not: the ref IS the identity. Declining here would reopen the exact
    // spoken-but-not-written defect A2 closes, on the commonest job shape there
    // is.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [{ id: 'main', board_type: 'main' }],
    });
    const row = cellAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('leg 4 — a job with NO registry at all is the single-board case', () => {
    // The legacy flat shape: no `boards[]`, every row unscoped, the backend
    // stamping its synthesised default main id. Both branches (scoped to the
    // default main, and unscoped) have to land.
    const flat = () => makeJob({ circuits: [populatedRow()], boards: [] });

    expect(
      cellAfter(flat(), makeResult({ readings: [flaggedReading({ board_id: 'main' })] }))
        .ir_live_live_mohm
    ).toBe('100');
    clearPipelineLog();
    expect(cellAfter(flat(), makeResult({ readings: [flaggedReading()] })).ir_live_live_mohm).toBe(
      '100'
    );
  });

  it('the canonical-main rule is FIRST-USABLE-MAIN, never first-sub', () => {
    // Item 5's shared rule, exercised through the attribution branch: a sub
    // board listed first does not become the attribution target just by being
    // `boards[0]`.
    const job = () =>
      makeJob({
        circuits: [populatedRow()],
        boards: [
          { id: 'sub-1', board_type: 'sub_distribution' },
          { id: 'main-2', board_type: 'main' },
        ],
      });

    // The real main attracts the legacy rows…
    expect(
      cellAfter(job(), makeResult({ readings: [flaggedReading({ board_id: 'main-2' })] }))
        .ir_live_live_mohm
    ).toBe('100');

    clearPipelineLog();

    // …and the first-listed sub does not.
    const rows = rowsAfter(
      job(),
      makeResult({ readings: [flaggedReading({ board_id: 'sub-1' })] })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ir_live_live_mohm).toBe('LIM');
    expect(stages()).toContain('apply_replaces_cleared_orphan_board_ref');
  });

  it('a registry entry with no usable id is skipped when picking the canonical main', () => {
    // "Usable" is the first clause of the shared rule: a plain record with a
    // truthy id. A half-written entry must not shadow the real main and turn
    // every legacy-row replacement into an orphan.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [{ board_type: 'main' }, { id: 'main-2', board_type: 'main' }],
    });
    const row = cellAfter(job, makeResult({ readings: [flaggedReading({ board_id: 'main-2' })] }));

    expect(row.ir_live_live_mohm).toBe('100');
    expect(stages()).toContain('apply_replaces_cleared_bypass_applied');
  });

  it('INVERSION 1 — an ORPHAN ref creates NO row (A2-core filled a synthesised one)', () => {
    // A2-core logged `apply_replaces_cleared_orphan_ref` and then let `ensureRow`
    // manufacture circuit 7 and fill it. A replacement names a cell the server
    // has already cleared, so "no such circuit" is a disagreement to surface,
    // not a circuit to invent — inventing one writes a legally-significant
    // value onto a circuit the inspector never mentioned.
    const job = makeJob({ circuits: [populatedRow()] });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading({ circuit: 7 })] }));

    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.circuit_ref === '7')).toBe(false);
    expect(payloadOf('apply_replaces_cleared_orphan_board_ref')).toMatchObject({
      circuit: 7,
      board_id: null,
      eligible_matches: 0,
    });
  });

  it('INVERSION 2 — a DUPLICATE ref leaves BOTH rows untouched', () => {
    const job = makeJob({
      circuits: [populatedRow(), populatedRow({ id: 'c-1b', ir_live_live_mohm: '50' })],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(rows[0].ir_live_live_mohm).toBe('LIM');
    expect(rows[1].ir_live_live_mohm).toBe('50');
    expect(payloadOf('apply_replaces_cleared_duplicate_board_ref')).toMatchObject({
      circuit: 1,
      board_id: null,
      eligible_matches: 2,
    });
  });

  it('INVERSION 4 — a decline is a STOP, not a fall-through that still fills an empty cell', () => {
    // A2-core's whole "NEVER A NEW SKIP" family: every declined flagged reading
    // fell through to the ordinary fill-only gate, so a duplicate ref still
    // wrote whenever the cell happened to be empty — i.e. it picked one of two
    // ambiguous rows after all, just quietly and only sometimes.
    //
    // The trade is deliberate and stated: the cost here is a missing value the
    // inspector can recover by re-dictating (they will hear it was not read
    // back). The cost of guessing is a silent write onto a circuit they never
    // spoke about, in a legally-significant certificate, which no read-back can
    // catch by ear.
    const job = makeJob({
      circuits: [
        populatedRow({ ir_live_live_mohm: undefined }),
        populatedRow({ id: 'c-1b', ir_live_live_mohm: undefined }),
      ],
    });
    const rows = rowsAfter(job, makeResult({ readings: [flaggedReading()] }));

    expect(rows[0].ir_live_live_mohm).toBeUndefined();
    expect(rows[1].ir_live_live_mohm).toBeUndefined();
    expect(stages()).toContain('apply_replaces_cleared_duplicate_board_ref');
    expect(stages()).not.toContain('apply_replaces_cleared_bypass_applied');
  });

  it('the prohibition is scoped to FLAGGED readings — an ordinary sibling still creates its row', () => {
    // `ensureRow` is not disabled; it is bypassed for the one reading class
    // that must never invent a target. An unflagged reading for the same absent
    // circuit behaves exactly as it did before A2-multiboard.
    const job = makeJob({ circuits: [populatedRow()] });
    const rows = rowsAfter(
      job,
      makeResult({
        readings: [
          flaggedReading({ circuit: 7 }),
          flaggedReading({
            circuit: 7,
            field: 'measured_zs_ohm',
            value: '0.42',
            replaces_cleared: undefined,
          }),
        ],
      })
    );

    const created = rows.find((r) => r.circuit_ref === '7');
    expect(created).toBeDefined();
    expect(created!.measured_zs_ohm).toBe('0.42');
    // …and the flagged one still declined rather than riding the row its
    // unflagged sibling created.
    expect(created!.ir_live_live_mohm).toBeUndefined();
    expect(stages()).toContain('apply_replaces_cleared_orphan_board_ref');
  });

  it('a legacy row CLAIMED by a replacement is not re-used by a later ordinary write for another board', () => {
    // The replacement attributes the unscoped row to main and writes there. A
    // sibling ordinary reading for sub-1 must then get its OWN row — landing on
    // the row main just claimed would be the wrong-board overwrite the whole
    // resolution exists to prevent.
    const job = makeJob({
      circuits: [populatedRow()],
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' },
      ],
    });
    const rows = rowsAfter(
      job,
      makeResult({
        readings: [
          flaggedReading({ board_id: 'main' }),
          flaggedReading({
            board_id: 'sub-1',
            field: 'measured_zs_ohm',
            value: '0.42',
            replaces_cleared: undefined,
          }),
        ],
      })
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].ir_live_live_mohm).toBe('100');
    expect(rows[0].measured_zs_ohm).toBeUndefined();
    expect((rows[1] as unknown as Record<string, unknown>).board_id).toBe('sub-1');
    expect(rows[1].measured_zs_ohm).toBe('0.42');
  });

  it('REMOVAL INVENTORY — the A2-core gate stages no longer exist on ANY path', () => {
    // A2-core's three web stage names are retired, not renamed-in-place: a
    // revert that restores the envelope-wide gate would re-emit one of these
    // and fail here even if it somehow satisfied the outcome assertions above.
    const shapes: [JobDetail, ExtractionResult][] = [
      [
        makeJob({
          circuits: [populatedRow()],
          boards: [{ id: 'main' }, { id: 'sub-1' }],
        }),
        makeResult({ readings: [flaggedReading()] }),
      ],
      [
        makeJob({ circuits: [populatedRow()] }),
        makeResult({ readings: [flaggedReading({ circuit: 7 })] }),
      ],
      [
        makeJob({ circuits: [populatedRow(), populatedRow({ id: 'c-1b' })] }),
        makeResult({ readings: [flaggedReading()] }),
      ],
      [
        makeJob({ circuits: [populatedRow({ board_id: 'main' })], boards: [{ id: 'main' }] }),
        makeResult({
          readings: [flaggedReading()],
          board_ops: [{ op: 'select_board', board_id: 'sub-1' }],
        }),
      ],
    ];

    for (const [job, result] of shapes) {
      clearPipelineLog();
      applyExtractionToJob(job, result);
      expect(stages()).not.toContain('apply_replaces_cleared_multiboard_deferred');
      expect(stages()).not.toContain('apply_replaces_cleared_orphan_ref');
      expect(stages()).not.toContain('apply_replaces_cleared_duplicate_ref');
    }
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
