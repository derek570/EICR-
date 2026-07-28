/**
 * A2-multiboard item 7 (2026-07-28) — `replaces_cleared` at BOARD scope.
 *
 * The circuit twin of this defect shipped in A2-core (see
 * `apply-extraction-replaces-cleared.test.ts`). This is the board half, and it
 * is not a copy: a board-level value lives in TWO places on the PWA — a flat
 * section record (`board_info` / `supply_characteristics`, what the Board and
 * Supply tabs render) and the per-board `boards[]` array — written by two
 * functions that iterate `readings` independently. So the board twin has to
 * defend a property the circuit twin never had: the two legs must agree.
 *
 * What arrives on the wire. The backend collapsed a same-turn
 * `clear_board_reading` → `record_board_reading` pair (mechanism B), dropped
 * the stale clear, stamped the survivor `replaces_cleared: true`, and the
 * shadow harness folded it to a `circuit: 0` reading (the only board shape a
 * client ever sees). The cell web holds is therefore still populated with the
 * value the inspector just replaced aloud — and all three fill-only gates
 * would skip it. Spoken, never written.
 *
 * ── The three rules this suite pins ───────────────────────────────────────
 *
 * 1. BOARDLESS FLAGGED READING ⇒ SECTION-ONLY, and that is a SUCCESS.
 *    `BOARD_CLEAR_SCOPE_MAP` marks `ze`/`pfc` `'global'` — one job-wide cell,
 *    no per-board home — so the backend leaves their slot board NULL, and item
 *    7's "flagged ⇒ always enriched" rule means a flagged reading arriving
 *    with no `board_id` is global BY CONSTRUCTION. The mirror's existing
 *    multi-board refusal-to-guess is the right answer for it, not a failed
 *    leg, so the section write proceeds alone. (This supersedes the archive
 *    framing that treated any mirror skip as an atomicity failure.)
 *
 * 2. SUB-BOARD TARGET ⇒ `boards[sub]` ONLY; `board_info` UNTOUCHED.
 *    `board_info` is the MAIN-board summary — the Overview hero strip, the
 *    PDF, and the backend's single-board ingest all read it as "the board".
 *    Publishing a sub-board's manufacturer there would mislabel the whole
 *    certificate. The main board's own summary must be observably unchanged.
 *
 * 3. ORPHAN `board_id` ⇒ NEITHER LEG. The one case where a concrete target
 *    was named and cannot be honoured. Writing the section anyway would leave
 *    the tab showing the new value while the addressed board keeps the old
 *    one — the precise desync the shared preflight exists to prevent.
 *
 * Every test also carries its unflagged twin. A bypass that fires without the
 * flag has not fixed the defect, it has deleted the 3-tier priority guard that
 * stops a low-confidence voice write clobbering CCU/manual data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

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

function makeResult(readings: unknown[]): ExtractionResult {
  return {
    readings,
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
  } as unknown as ExtractionResult;
}

/**
 * A two-board job whose MAIN and SUB boards hold DISTINCT manufacturers, and
 * whose `board_info` summary mirrors the MAIN board (what `persistBoards`
 * derives via the shared canonical-main helper). Distinct values are the whole
 * point: if the sub-board write leaked into `board_info`, identical values
 * would hide it.
 */
const twoBoardJob = (over: Record<string, unknown> = {}): JobDetail =>
  makeJob({
    boards: [
      { id: 'main', designation: 'Main DB', board_type: 'main', manufacturer: 'Hager' },
      {
        id: 'garage',
        designation: 'Garage CU',
        board_type: 'sub_distribution',
        manufacturer: 'Crabtree',
      },
    ],
    board_info: { manufacturer: 'Hager' },
    ...over,
  });

const boardReading = (over: Record<string, unknown> = {}) =>
  ({
    circuit: 0,
    field: 'manufacturer',
    value: 'Wylex',
    replaces_cleared: true,
    ...over,
  }) as unknown as ExtractionResult['readings'][number];

const stages = () => getPipelineLog().map((e) => e.stage);
const payloadOf = (stage: string) => getPipelineLog().find((e) => e.stage === stage)?.payload;

beforeEach(() => {
  clearPipelineLog();
});

// ---------------------------------------------------------------------------
// Rule 1 — a boardless GLOBAL reading is a section-only success.
// ---------------------------------------------------------------------------

describe('item 7 — boardless flagged reading (global scope) writes the section alone', () => {
  it('a flagged `ze` replacement on a 2-board job updates supply_characteristics and adds NO board copy', () => {
    const job = twoBoardJob({ supply_characteristics: { ze: '0.35' } });
    const applied = applyExtractionToJob(
      job,
      makeResult([boardReading({ field: 'ze', value: '0.21' })])
    );

    expect(applied).not.toBeNull();
    // The section leg wrote, over a populated cell.
    expect((applied!.patch.supply_characteristics as Record<string, unknown> | undefined)?.ze).toBe(
      '0.21'
    );
    // …and the boards leg legitimately declined: a global value has no
    // per-board home, so neither board record grew a `ze`.
    const boards = applied!.patch.boards as Record<string, unknown>[] | undefined;
    if (boards) {
      for (const b of boards) expect(b.ze).toBeUndefined();
    }
    // Declining here is NOT the fail-closed path — nothing was declined.
    expect(stages()).toContain('apply_flagged_board_replacement_section_only');
    expect(stages()).not.toContain('apply_flagged_board_replacement_orphan_board_ref');
    expect(stages()).toContain('apply_section_reading_replaces_cleared_bypass');
  });

  it('GATE INTACT — the identical boardless `ze` WITHOUT the flag is still blocked', () => {
    const job = twoBoardJob({ supply_characteristics: { ze: '0.35' } });
    const applied = applyExtractionToJob(
      job,
      makeResult([boardReading({ field: 'ze', value: '0.21', replaces_cleared: undefined })])
    );

    // Pre-item-7 behaviour, unchanged: a bare write never clobbers a value
    // the user already owns.
    const patched = applied?.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(patched?.ze ?? '0.35').toBe('0.35');
    expect(stages()).toContain('apply_section_reading_user_value_kept');
    expect(stages()).not.toContain('apply_section_reading_replaces_cleared_bypass');
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — a sub-board target is a single-leg boards[] write.
// ---------------------------------------------------------------------------

describe('item 7 — a sub-board flagged replacement never rewrites the main-board summary', () => {
  it('replacing the SUB board manufacturer changes boards[garage] only; board_info stays equal to main', () => {
    const job = twoBoardJob();
    const applied = applyExtractionToJob(job, makeResult([boardReading({ board_id: 'garage' })]));

    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards.find((b) => b.id === 'garage')?.manufacturer).toBe('Wylex');
    // The main board is untouched — the replacement named the garage.
    expect(boards.find((b) => b.id === 'main')?.manufacturer).toBe('Hager');

    // `board_info` is the MAIN-board summary. Either it is absent from the
    // patch entirely (the section leg had no surviving target) or it still
    // reads the main board's value — never the sub-board's.
    const info = applied!.patch.board_info as Record<string, unknown> | undefined;
    expect(info?.manufacturer ?? 'Hager').toBe('Hager');

    expect(stages()).toContain('apply_section_reading_board_info_withheld');
    expect(payloadOf('apply_flagged_board_replacement_planned')).toMatchObject({
      board_id: 'garage',
      is_primary_board: false,
    });
    expect(stages()).toContain('apply_boards_mirror_replaces_cleared_bypass');
  });

  it('replacing the MAIN board manufacturer writes BOTH legs — boards[main] and board_info', () => {
    const job = twoBoardJob();
    const applied = applyExtractionToJob(job, makeResult([boardReading({ board_id: 'main' })]));

    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards.find((b) => b.id === 'main')?.manufacturer).toBe('Wylex');
    expect(boards.find((b) => b.id === 'garage')?.manufacturer).toBe('Crabtree');
    // The canonical-main target DOES own the summary, so the section leg runs.
    expect((applied!.patch.board_info as Record<string, unknown>).manufacturer).toBe('Wylex');
    expect(payloadOf('apply_flagged_board_replacement_planned')).toMatchObject({
      board_id: 'main',
      is_primary_board: true,
    });
    expect(stages()).not.toContain('apply_section_reading_board_info_withheld');
  });

  it('GATE INTACT — an unflagged sub-board write is still blocked by the populated cell', () => {
    const job = twoBoardJob();
    const applied = applyExtractionToJob(
      job,
      makeResult([boardReading({ board_id: 'garage', replaces_cleared: undefined })])
    );

    const boards = applied?.patch.boards as Record<string, unknown>[] | undefined;
    const garage = boards?.find((b) => b.id === 'garage');
    expect(garage?.manufacturer ?? 'Crabtree').toBe('Crabtree');
    expect(stages()).not.toContain('apply_boards_mirror_replaces_cleared_bypass');
  });

  it('a SOLE board is treated as canonical-main whatever its board_type says', () => {
    // A single-board job that never got a `board_type` (legacy shape). It is
    // the only board there is, so its summary IS `board_info` — withholding
    // the section leg here would strand the Board tab on the stale value.
    const job = makeJob({
      boards: [{ id: 'b0', designation: 'CU', manufacturer: 'Hager' }],
      board_info: { manufacturer: 'Hager' },
    });
    const applied = applyExtractionToJob(job, makeResult([boardReading({ board_id: 'b0' })]));

    expect((applied!.patch.board_info as Record<string, unknown>).manufacturer).toBe('Wylex');
    expect((applied!.patch.boards as Record<string, unknown>[])[0].manufacturer).toBe('Wylex');
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — an orphan board ref fails closed on BOTH legs.
// ---------------------------------------------------------------------------

describe('item 7 — an unresolvable board id declines both legs', () => {
  it('a flagged reading naming a board we do not have writes NEITHER the section NOR boards[]', () => {
    const job = twoBoardJob();
    const applied = applyExtractionToJob(job, makeResult([boardReading({ board_id: 'shed' })]));

    // Nothing landed anywhere. A section-only write here would show the new
    // manufacturer on the Board tab while every boards[] record kept the old
    // one — worse than a clean miss, because it looks like it worked.
    const info = applied?.patch.board_info as Record<string, unknown> | undefined;
    expect(info?.manufacturer ?? 'Hager').toBe('Hager');
    const boards = applied?.patch.boards as Record<string, unknown>[] | undefined;
    expect(boards?.find((b) => b.id === 'main')?.manufacturer ?? 'Hager').toBe('Hager');
    expect(boards?.find((b) => b.id === 'garage')?.manufacturer ?? 'Crabtree').toBe('Crabtree');

    // …and the miss is NAMED, so it can never be a silent third path.
    expect(payloadOf('apply_flagged_board_replacement_orphan_board_ref')).toMatchObject({
      board_id: 'shed',
      field: 'manufacturer',
    });
    expect(stages()).toContain('apply_section_reading_flagged_declined');
  });
});
