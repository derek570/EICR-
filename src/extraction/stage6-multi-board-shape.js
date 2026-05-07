// stage6-multi-board-shape.js
//
// Phase 5.1 of the multi-board sprint (.planning-stage6-agentic/handoffs/
// multi-board-support-2026-05-07/). Idempotent migration helper that
// turns any Stage 6 stateSnapshot into the multi-board shape: a populated
// `boards` array (synthesising a default `main` board when missing) and
// a `currentBoardId` pointer.
//
// What this module DOES NOT do — by design:
//   * Re-key the `circuits` keyed object. Legacy snapshots store circuits
//     under numeric keys: `circuits[0]` is the supply / board / installation
//     bucket (read by 8+ files, see Phase 5 handoff "circuits[0] strangler"
//     section for the full list); `circuits[1]`, `circuits[2]`, ... are
//     circuit refs. The composite-key model (`${board_id}::${circuit}`)
//     coexists with these legacy numeric keys until slice 5.5 migrates
//     readers/writers and slice 5.6 retires the legacy bucket. Re-keying
//     eagerly here would break every reader that does `snapshot.circuits[0]`.
//
// What this module DOES do:
//   * Ensure `snapshot.boards` is an array (synthesise if missing).
//   * Ensure at least one main board exists (synthesise the default
//     `{id:'main', designation:'DB-1', board_type:'main'}` if empty).
//   * Ensure `snapshot.currentBoardId` points at a board (default to
//     boards[0].id).
//
// Default board metadata mirrors the locked Phase 0.3 decision in
// the multi-board sprint plan: a legacy snapshot synthesises a single
// `main` board with designation `DB-1` and `board_type: 'main'`.
//
// Idempotent — running against an already-multi-board snapshot is a
// no-op. Safe to call from the constructor unconditionally and from
// any future reload / hydration path that reconstructs a snapshot
// from persisted state.

export const DEFAULT_MAIN_BOARD_ID = 'main';
export const DEFAULT_MAIN_BOARD_DESIGNATION = 'DB-1';
export const DEFAULT_MAIN_BOARD_TYPE = 'main';

/**
 * Build a fresh default main-board record. Returned as a new object
 * every call (no shared reference) so callers can mutate without
 * stomping on a frozen template.
 */
export function buildDefaultMainBoard() {
  return {
    id: DEFAULT_MAIN_BOARD_ID,
    designation: DEFAULT_MAIN_BOARD_DESIGNATION,
    board_type: DEFAULT_MAIN_BOARD_TYPE,
  };
}

/**
 * Idempotent migration: ensure the snapshot has a `boards` array with at
 * least one main board and a `currentBoardId` pointer. Mutates the
 * passed snapshot in place and returns it.
 *
 * Critical: the `circuits` keyed object is NOT re-keyed here. Numeric
 * legacy keys (0 = supply bucket, 1+ = circuits) survive untouched.
 * Slice 5.5 / 5.6 retire `circuits[0]`; until then, legacy and
 * composite keys coexist.
 *
 * Calling against an already-multi-board snapshot is a no-op.
 *
 * Defensive on missing/null/non-object input — returns the input
 * unchanged. The Phase 5 wire-in calls this immediately after
 * `this.stateSnapshot = { ... }` in the session constructor where
 * the input is always a fresh object literal, but future hydration
 * paths may pass partially-deserialised state.
 *
 * @param {Object} snapshot - reference to a stateSnapshot-shaped object
 * @returns {Object} the same snapshot reference (for chaining)
 */
export function ensureMultiBoardShape(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  if (!Array.isArray(snapshot.boards)) {
    snapshot.boards = [];
  }
  if (snapshot.boards.length === 0) {
    snapshot.boards.push(buildDefaultMainBoard());
  }
  if (snapshot.currentBoardId == null) {
    snapshot.currentBoardId = snapshot.boards[0].id;
  }

  return snapshot;
}
