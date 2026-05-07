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

// Phase 5.3 — feature flag gate. Default OFF in production. Flip to 'true'
// is a Phase 8.4 field-test gate, NOT a routine push. Every Phase 5
// dispatcher branches on this; reading via this helper (rather than
// direct env access at every call site) gives a single seam for tests
// to mock and a single name for grep audits.
export function isMultiBoardFlagOn() {
  return process.env.STAGE6_MULTI_BOARD === 'true';
}

// Phase 5.3 — flag-aware existence check. Replaces inline
// `circuit in snapshot.circuits` checks in the validators so that under
// flag-on, validators consult the composite key (`${board_id}::${circuit}`)
// instead of the legacy flat key.
//
// Defensive on missing snapshot / missing circuits map — returns false
// rather than crashing on `undefined.circuits[...]`. The dispatchers
// always pass `session.stateSnapshot`, which is guaranteed to be a
// stateSnapshot-shaped object with a `circuits: {}` property by the
// constructor wire-in (slice 5.1), but a future call from a partially
// constructed test fixture should fail gracefully.
//
// Board ID resolution: `boardId` arg → `snapshot.currentBoardId` →
// `'main'`. Same chain as the mutators in slice 5.2.
export function circuitExistsInSnapshot(snapshot, circuit, boardId) {
  if (!snapshot || !snapshot.circuits) return false;
  if (isMultiBoardFlagOn()) {
    const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
    return `${id}::${circuit}` in snapshot.circuits;
  }
  return circuit in snapshot.circuits;
}

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
