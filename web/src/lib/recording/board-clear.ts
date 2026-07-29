/**
 * Plan A1b (2026-07-29) — web board-scope clear routing for the
 * `field_corrected` board frame (`circuit: null` + non-null `board_id`,
 * the §3.4b wire discriminator shipped by A1a's `clear_board_reading`
 * dispatcher).
 *
 * THE ROUTE MAP IS THE CONTRACT SURFACE. `BOARD_CLEAR_ROUTE_MAP` mirrors the
 * backend's authoritative `BOARD_CLEAR_SCOPE_MAP`
 * (src/extraction/stage6-dispatchers-board.js) and is pinned against the
 * committed fixture `tests/fixtures/test-contracts/board-clear-scope-keys.json`
 * by a set-equality gate test (field AND scope). The apply function routes
 * THROUGH this map — an inline switch would make the gate decorative
 * (plan §2). A frame whose field the map does not classify is dropped
 * FAIL-CLOSED (logged, no mutation): the server never emits one (its own
 * scope map fails closed first), so reaching that branch means the two maps
 * have drifted and the safe move is to touch nothing.
 *
 * Scope semantics (plan §3, web column):
 *
 *  - 'global' (`ze`, `pfc`) — ONE value per job. The clear is an ATOMIC
 *    SWEEP of EVERY representation (round-3: clears are NOT A2's
 *    write-mirroring rule — a section-only clear would leave a visible
 *    stale value the Board/Circuits tabs still render):
 *      · `supply_characteristics` under BOTH aliases — the wire short key
 *        (`ze`/`pfc`) AND the PWA long key (`earth_loop_impedance_ze`/
 *        `prospective_fault_current`) — the round-2 dual-key stores: the
 *        Supply tab and the PDF read the LONG keys, so a short-key-only
 *        clear leaves the certificate value intact.
 *      · every `boards[i]` mirror of the field (Ze is mirrored to
 *        `boards[].ze` by MIRROR_TO_BOARDS0; PFC has no boards mirror
 *        today — the sweep visits the key anyway, which is a no-op when
 *        absent and future-proof if a mirror appears).
 *      · any retained `board_info` copy of the field.
 *
 *  - 'board' (`manufacturer`) — one value per board. Tri-state target
 *    resolution mirroring A2-multiboard: an explicit `board_id` matching no
 *    board FAILS CLOSED (no mutation — never `boards[0]`); the canonical
 *    MAIN board clears TWO legs atomically (`board_info.manufacturer` +
 *    `boards[canonicalMainIndex].manufacturer` — web's two-leg matrix; iOS
 *    is one-leg because its board_info is a decode fallback, not a store);
 *    a sub-board clears `boards[idx]` ONLY (never the main summary).
 *
 * The server always emits a non-null `board_id` on board frames
 * (`resolveEffectiveBoardIdForClear` falls back to the main board id), so a
 * board-less call here is a decode-contract violation and fails closed.
 */

import type { JobDetail } from '../types';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';
import { resolveCanonicalMainBoardId, type MainBoardCandidate } from '@/lib/boards/canonical-main';

export type BoardClearScope = 'global' | 'board';

/**
 * Mirror of backend `BOARD_CLEAR_SCOPE_MAP` — pinned by the set-equality
 * gate test against the committed scope-keys fixture. Grow ONLY via the
 * `board-clear-scope-map-expansion` process (backend + both clients + the
 * fixture in the same delivery).
 */
export const BOARD_CLEAR_ROUTE_MAP: Readonly<Record<string, BoardClearScope>> = Object.freeze({
  ze: 'global',
  pfc: 'global',
  manufacturer: 'board',
});

/**
 * Every stored representation a GLOBAL clear must sweep, per field. The
 * wire ships the short key; the long key is the PWA column the tabs/PDF
 * read (LEGACY_TO_PWA_SECTION_FIELD in apply-extraction.ts).
 */
const GLOBAL_SWEEP: Readonly<
  Record<string, { sectionKeys: readonly string[]; boardKeys: readonly string[] }>
> = Object.freeze({
  ze: {
    sectionKeys: ['ze', 'earth_loop_impedance_ze'],
    boardKeys: ['ze'],
  },
  pfc: {
    sectionKeys: ['pfc', 'prospective_fault_current'],
    boardKeys: ['pfc'],
  },
});

export interface BoardClearInput {
  field: string;
  boardId: string | null;
}

export interface AppliedBoardClear {
  patch: Partial<JobDetail>;
  changedKeys: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function deleteKeys(
  source: Record<string, unknown>,
  keys: readonly string[]
): { next: Record<string, unknown>; removed: string[] } {
  const removed = keys.filter((k) => k in source);
  if (removed.length === 0) return { next: source, removed };
  const next = { ...source };
  for (const k of removed) delete next[k];
  return { next, removed };
}

/**
 * Apply a board-scope clear to the job. Pure — returns a patch (fresh
 * references only for the slices it changes) or null when nothing changed
 * (including every fail-closed path).
 */
export function applyBoardClearToJob(
  job: JobDetail,
  input: BoardClearInput
): AppliedBoardClear | null {
  const scope = BOARD_CLEAR_ROUTE_MAP[input.field];
  if (scope === undefined) {
    // Fail closed — the server's own scope map should make this
    // unreachable; reaching it means the maps drifted.
    pipelineLog('board_clear_unroutable_field', { field: input.field });
    return null;
  }

  const patch: Partial<JobDetail> = {};
  const changedKeys: string[] = [];
  const boards = Array.isArray(job.boards) ? (job.boards as Record<string, unknown>[]) : [];

  if (scope === 'global') {
    const sweep = GLOBAL_SWEEP[input.field];
    // The route map and the sweep table are same-keyed by construction
    // (gate-tested); guard anyway so a drift fails closed, not loudly.
    if (!sweep) {
      pipelineLog('board_clear_unroutable_field', { field: input.field, reason: 'no_sweep' });
      return null;
    }
    const supply = asRecord(job.supply_characteristics);
    const { next: nextSupply, removed: supplyRemoved } = deleteKeys(supply, sweep.sectionKeys);
    if (supplyRemoved.length > 0) {
      patch.supply_characteristics = nextSupply as JobDetail['supply_characteristics'];
      changedKeys.push(...supplyRemoved);
    }
    const boardInfo = asRecord(job.board_info);
    const { next: nextBoardInfo, removed: boardInfoRemoved } = deleteKeys(
      boardInfo,
      sweep.sectionKeys
    );
    if (boardInfoRemoved.length > 0) {
      patch.board_info = nextBoardInfo as JobDetail['board_info'];
      changedKeys.push(...boardInfoRemoved.map((k) => `board_info.${k}`));
    }
    if (boards.length > 0) {
      let boardsTouched = false;
      const nextBoards = boards.map((b) => {
        const { next, removed } = deleteKeys(b, sweep.boardKeys);
        if (removed.length > 0) boardsTouched = true;
        return removed.length > 0 ? next : b;
      });
      if (boardsTouched) {
        patch.boards = nextBoards as JobDetail['boards'];
        changedKeys.push(...sweep.boardKeys.map((k) => `boards.${k}`));
      }
    }
    if (changedKeys.length === 0) return null;
    pipelineLog('board_clear_global_sweep', { field: input.field, changed: changedKeys });
    return { patch, changedKeys };
  }

  // scope === 'board'
  if (typeof input.boardId !== 'string' || input.boardId === '') {
    // The dispatcher always resolves a non-null board id for board-scope
    // frames; a missing one is a contract violation → fail closed.
    pipelineLog('board_clear_missing_board_id', { field: input.field });
    return null;
  }
  const targetIdx = boards.findIndex((b) => b.id === input.boardId);
  if (targetIdx === -1) {
    // explicitUnmatched — NEVER boards[0], never a fuzzy fallback.
    pipelineLog('board_clear_explicit_unmatched', {
      field: input.field,
      board_id: input.boardId,
    });
    return null;
  }

  const canonicalMainId = resolveCanonicalMainBoardId(boards as MainBoardCandidate[]);
  const isCanonicalMain = input.boardId === canonicalMainId;

  const targetBoard = boards[targetIdx];
  const boardHasValue = input.field in targetBoard;
  const boardInfo = asRecord(job.board_info);
  const infoHasValue = isCanonicalMain && input.field in boardInfo;
  if (!boardHasValue && !infoHasValue) return null;

  if (boardHasValue) {
    const nextBoards = boards.map((b, i) => {
      if (i !== targetIdx) return b;
      const { next } = deleteKeys(b, [input.field]);
      return next;
    });
    patch.boards = nextBoards as JobDetail['boards'];
    changedKeys.push(`boards.${input.field}`);
  }
  if (infoHasValue) {
    // Two-leg atomicity: the canonical-main summary (`board_info`) and the
    // boards[] record clear in the SAME patch (web-only matrix leg).
    const { next } = deleteKeys(boardInfo, [input.field]);
    patch.board_info = next as JobDetail['board_info'];
    changedKeys.push(`board_info.${input.field}`);
  }
  pipelineLog('board_clear_board_scope', {
    field: input.field,
    board_id: input.boardId,
    canonical_main: isCanonicalMain,
    changed: changedKeys,
  });
  return { patch, changedKeys };
}
