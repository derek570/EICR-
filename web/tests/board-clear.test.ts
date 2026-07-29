/**
 * Plan A1b (2026-07-29) — web board-scope clear routing + the §2 contract
 * gate (web surface).
 *
 * The route map (`BOARD_CLEAR_ROUTE_MAP`) is pinned against the committed
 * scope-keys fixture — field AND scope value, both directions — and the
 * apply function routes THROUGH that map, so growing the clearable set
 * without shipping the client half reddens this suite (the set-equality
 * gate that lets `board_clear_v1` stay advertised safely).
 *
 * Routing semantics under test (§3 web column):
 *  - global `ze`: atomic sweep of EVERY representation — supply short+long
 *    keys, every `boards[].ze` mirror, retained `board_info` copy
 *    (seed-all/assert-all; round-3 — a section-only clear leaves a visible
 *    stale Ze the Board/Circuits tabs still render).
 *  - global `pfc`: both supply aliases (no boards mirror exists today; the
 *    sweep visiting the key is a no-op).
 *  - board `manufacturer`: canonical-main target clears TWO legs atomically
 *    (`board_info` + `boards[canonicalMainIndex]`); a sub-board clears
 *    `boards[sub]` ONLY; an explicit-unmatched board id FAILS CLOSED (never
 *    `boards[0]`); reordered `[sub, main]` jobs route by the canonical-main
 *    helper, not position.
 *  - write→clear sentinel loop (§4 test 5): a value written through the
 *    REAL apply path then cleared through the board-clear path leaves NO
 *    representation populated — per-row table GENERATED from the fixture
 *    (exact row identity, never a count).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBoardClearToJob, BOARD_CLEAR_ROUTE_MAP } from '@/lib/recording/board-clear';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

// vitest cwd is `web/`; the canonical fixture lives at the repo root
// (backend + web are one repo, so web's LOCAL copy IS the canonical one).
const FIXTURE_PATH = resolve(
  process.cwd(),
  '../tests/fixtures/test-contracts/board-clear-scope-keys.json'
);

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

/** A job holding EVERY representation a global Ze/PFC clear must sweep. */
const seededGlobalJob = (): JobDetail =>
  makeJob({
    supply_characteristics: {
      ze: '0.35',
      earth_loop_impedance_ze: '0.35',
      pfc: '1.2',
      prospective_fault_current: '1.2',
      earthing_arrangement: 'TN-C-S',
    },
    board_info: { ze: '0.35', manufacturer: 'Hager' },
    boards: [
      { id: 'main', designation: 'Main DB', board_type: 'main', ze: '0.35', manufacturer: 'Hager' },
      {
        id: 'garage',
        designation: 'Garage CU',
        board_type: 'sub_distribution',
        ze: '0.38',
        manufacturer: 'Crabtree',
      },
    ],
  });

const stages = () => getPipelineLog().map((e) => e.stage);

beforeEach(() => {
  clearPipelineLog();
});

// ───────────────────────────────────────────────────────────────────────────
describe('§2 contract gate — route map deep-equals the committed fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>;

  it('BOARD_CLEAR_ROUTE_MAP matches the fixture: same fields, same scope values, both directions', () => {
    expect({ ...BOARD_CLEAR_ROUTE_MAP }).toEqual(fixture);
  });

  it('a scope-VALUE drift alone fails (keys-only equality is insufficient)', () => {
    const valueDrift = { ...fixture, manufacturer: 'global' };
    expect({ ...BOARD_CLEAR_ROUTE_MAP }).not.toEqual(valueDrift);
    expect(Object.keys(valueDrift).sort()).toEqual(Object.keys(fixture).sort());
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('global scope — atomic sweep of every representation', () => {
  it('ze: seed-all/assert-all — supply BOTH aliases + every boards[].ze + board_info.ze removed in ONE patch', () => {
    const job = seededGlobalJob();
    const applied = applyBoardClearToJob(job, { field: 'ze', boardId: 'main' });
    expect(applied).not.toBeNull();
    const patch = applied!.patch as Record<string, Record<string, unknown> | unknown[]>;
    const supply = patch.supply_characteristics as Record<string, unknown>;
    expect(supply.ze).toBeUndefined();
    expect(supply.earth_loop_impedance_ze).toBeUndefined();
    // Untouched sibling survives — the sweep deletes, it does not replace.
    expect(supply.earthing_arrangement).toBe('TN-C-S');
    // PFC keys untouched by a Ze clear.
    expect(supply.pfc).toBe('1.2');
    expect(supply.prospective_fault_current).toBe('1.2');
    const boards = patch.boards as Record<string, unknown>[];
    expect(boards).toHaveLength(2);
    for (const b of boards) expect(b.ze).toBeUndefined();
    // Non-swept board fields survive.
    expect(boards[0].manufacturer).toBe('Hager');
    const boardInfo = patch.board_info as Record<string, unknown>;
    expect(boardInfo.ze).toBeUndefined();
    expect(boardInfo.manufacturer).toBe('Hager');
  });

  it('pfc: both supply aliases removed; ze untouched; boards untouched (no pfc mirror seeded)', () => {
    const job = seededGlobalJob();
    const applied = applyBoardClearToJob(job, { field: 'pfc', boardId: 'main' });
    expect(applied).not.toBeNull();
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.pfc).toBeUndefined();
    expect(supply.prospective_fault_current).toBeUndefined();
    expect(supply.ze).toBe('0.35');
    // No boards[].pfc was seeded, so the boards slice is untouched.
    expect(applied!.patch.boards).toBeUndefined();
  });

  it('already-empty global clear → accepted-empty shape (no patch keys, ownership still released)', () => {
    const job = makeJob({ supply_characteristics: { earthing_arrangement: 'TT' }, boards: [] });
    const applied = applyBoardClearToJob(job, { field: 'ze', boardId: 'main' });
    expect(applied).not.toBeNull();
    expect(applied!.changedKeys).toEqual([]);
    expect(applied!.patch).toEqual({});
    expect(applied!.ownershipKeys).toEqual(['supply.ze', 'supply.earth_loop_impedance_ze']);
  });

  it('ze sweep also removes the LONG alias off boards[] (Circuits-page fallback reads it)', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main', earth_loop_impedance_ze: '0.35' }],
      supply_characteristics: { ze: '0.35' },
    });
    const applied = applyBoardClearToJob(job, { field: 'ze', boardId: 'main' });
    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards[0].earth_loop_impedance_ze).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('board scope — manufacturer tri-state target resolution', () => {
  it('canonical-main target: TWO legs atomically (board_info + boards[mainIdx]); sub-board rows untouched', () => {
    const job = seededGlobalJob();
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'main' });
    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards[0].manufacturer).toBeUndefined();
    expect(boards[1].manufacturer).toBe('Crabtree');
    const boardInfo = applied!.patch.board_info as Record<string, unknown>;
    expect(boardInfo.manufacturer).toBeUndefined();
    // The two legs land in the SAME patch — atomic by construction.
    expect(Object.keys(applied!.patch).sort()).toEqual(['board_info', 'boards']);
  });

  it('REORDERED [sub, main] job: routes by the canonical-main helper, never boards[0]', () => {
    const job = makeJob({
      boards: [
        {
          id: 'garage',
          designation: 'Garage CU',
          board_type: 'sub_distribution',
          manufacturer: 'Crabtree',
        },
        { id: 'main', designation: 'Main DB', board_type: 'main', manufacturer: 'Hager' },
      ],
      board_info: { manufacturer: 'Hager' },
    });
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'main' });
    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards[0].manufacturer).toBe('Crabtree'); // sub row untouched at index 0
    expect(boards[1].manufacturer).toBeUndefined();
    expect((applied!.patch.board_info as Record<string, unknown>).manufacturer).toBeUndefined();
  });

  it('sub-board target: boards[sub] ONLY — board_info (the MAIN summary) observably unchanged', () => {
    const job = seededGlobalJob();
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'garage' });
    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards[1].manufacturer).toBeUndefined();
    expect(boards[0].manufacturer).toBe('Hager');
    // board_info leg NOT in the patch — the main summary keeps 'Hager'.
    expect(applied!.patch.board_info).toBeUndefined();
  });

  it('a SUB-board that happens to be named "main" with NO true canonical record: single leg, board_info untouched', () => {
    const job = makeJob({
      boards: [
        {
          id: 'main',
          designation: 'Garage CU',
          board_type: 'sub_distribution',
          manufacturer: 'Crabtree',
        },
      ],
      board_info: { manufacturer: 'Hager' },
    });
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'main' });
    expect(applied).not.toBeNull();
    const boards = applied!.patch.boards as Record<string, unknown>[];
    expect(boards[0].manufacturer).toBeUndefined();
    // The record is NOT the canonical main (sub_distribution type), so the
    // main summary must survive — the resolver's synthetic 'main' fallback
    // must never classify an existing record.
    expect(applied!.patch.board_info).toBeUndefined();
  });

  it('LEGACY job: manufacturer only in board_info, no usable boards[] — synthetic-main target clears the board_info leg', () => {
    const job = makeJob({
      boards: [],
      board_info: { manufacturer: 'Hager' },
    });
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'main' });
    expect(applied).not.toBeNull();
    expect((applied!.patch.board_info as Record<string, unknown>).manufacturer).toBeUndefined();
    expect(applied!.changedKeys).toEqual(['board_info.manufacturer']);
  });

  it('explicit-unmatched board id: FAILS CLOSED — no mutation, never boards[0]', () => {
    const job = seededGlobalJob();
    const applied = applyBoardClearToJob(job, { field: 'manufacturer', boardId: 'loft' });
    expect(applied).toBeNull();
    expect(stages()).toContain('board_clear_explicit_unmatched');
  });

  it('missing board id on a board-scope frame: FAILS CLOSED (contract violation — the server always resolves one)', () => {
    const job = seededGlobalJob();
    expect(applyBoardClearToJob(job, { field: 'manufacturer', boardId: null })).toBeNull();
    expect(stages()).toContain('board_clear_missing_board_id');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('fail-closed routing', () => {
  it('a field OUTSIDE the route map is dropped with no mutation (map drift → touch nothing)', () => {
    const job = seededGlobalJob();
    expect(
      applyBoardClearToJob(job, { field: 'earthing_arrangement', boardId: 'main' })
    ).toBeNull();
    expect(stages()).toContain('board_clear_unroutable_field');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§4 test 5 — write→clear sentinel loop through the REAL apply path, rows generated from the fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>;
  // Exact row identity from the fixture — never a count.
  const rows = Object.entries(fixture).map(([field, scope]) => ({ field, scope }));

  it('the generated table is exactly the fixture rows', () => {
    expect(rows.map((r) => r.field).sort()).toEqual(['manufacturer', 'pfc', 'ze']);
  });

  it.each(rows)(
    '$field ($scope): write via applyExtractionToJob, clear via board path → gone everywhere',
    ({ field, scope }) => {
      const base = makeJob({
        boards: [{ id: 'main', designation: 'Main DB', board_type: 'main' }],
        supply_characteristics: {},
        board_info: {},
      });
      const writeValue = field === 'manufacturer' ? 'Wylex' : '0.41';
      const result: ExtractionResult = {
        readings: [{ circuit: 0, field, value: writeValue }],
      } as unknown as ExtractionResult;
      const written = applyExtractionToJob(base, result);
      expect(written).not.toBeNull();
      const jobAfterWrite = { ...base, ...(written!.patch as Partial<JobDetail>) } as JobDetail;

      const cleared = applyBoardClearToJob(jobAfterWrite, { field, boardId: 'main' });
      expect(cleared).not.toBeNull();
      const finalJob = { ...jobAfterWrite, ...(cleared!.patch as Partial<JobDetail>) } as JobDetail;

      const supply = (finalJob.supply_characteristics ?? {}) as Record<string, unknown>;
      const boardInfo = (finalJob.board_info ?? {}) as Record<string, unknown>;
      const boards = (finalJob.boards ?? []) as Record<string, unknown>[];
      if (scope === 'global') {
        const aliases =
          field === 'ze' ? ['ze', 'earth_loop_impedance_ze'] : ['pfc', 'prospective_fault_current'];
        for (const key of aliases) {
          expect(supply[key]).toBeUndefined();
          expect(boardInfo[key]).toBeUndefined();
        }
        for (const b of boards) expect(b[field]).toBeUndefined();
      } else {
        for (const b of boards) expect(b[field]).toBeUndefined();
        expect(boardInfo[field]).toBeUndefined();
      }
    }
  );
});
