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

// Phase 5.3 — feature flag gate. Kept exported so the lone remaining reader
// (`buildStateSnapshotMessage` in eicr-extraction-session.js, slice A.4 will
// flip it) keeps compiling. After A.4 lands, both this helper and the
// `STAGE6_MULTI_BOARD` env var become dead and can be deleted.
export function isMultiBoardFlagOn() {
  return process.env.STAGE6_MULTI_BOARD === 'true';
}

// "Work on Board" sprint Phase A — resolve the main board id from a
// snapshot. Used by the dual-shape helpers below to decide whether a
// per-call boardId targets the legacy flat namespace (main) or the
// composite namespace (any non-main board).
//
// Resolution order:
//   1. boards[] entry whose board_type is 'main' (or absent — legacy
//      seeded snapshots may omit the field entirely).
//   2. boards[0].id — first declared board wins if no main marker.
//   3. DEFAULT_MAIN_BOARD_ID ('main') — the synthesised default seeded
//      by ensureMultiBoardShape on legacy snapshots.
export function getMainBoardId(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.boards) || snapshot.boards.length === 0) {
    return DEFAULT_MAIN_BOARD_ID;
  }
  const main = snapshot.boards.find((b) => b && (!b.board_type || b.board_type === 'main'));
  return main?.id ?? snapshot.boards[0]?.id ?? DEFAULT_MAIN_BOARD_ID;
}

// "Work on Board" sprint Phase A — dual-shape circuit-bucket lookup.
// Main board reads from the legacy bare-numeric key; non-main boards
// read from composite keys (`${board_id}::${ref}`). Replaces the
// previous flag-gated branch — the env flag was stuck off in production
// because seeded snapshots wrote legacy keys regardless of flag state,
// so flag-on existence checks went invisible to seeded circuits.
//
// Defensive on missing snapshot — returns undefined rather than crashing,
// matching the pre-existing optional-chain idiom (`circuits?.[ref]`).
//
// @param {{circuits: Object, currentBoardId?: string}} snapshot
// @param {number} ref       — circuit ref (1+ for circuits, 0 for legacy supply)
// @param {string?} boardId  — optional explicit override; falls back to currentBoardId then 'main'
// @returns {Object|undefined}
export function getCircuitBucket(snapshot, ref, boardId) {
  if (!snapshot || !snapshot.circuits) return undefined;
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return snapshot.circuits[ref];
  }
  return snapshot.circuits[`${id}::${ref}`];
}

// "Work on Board" sprint Phase A — dual-shape circuit-ref enumerator.
// Main board iterates the legacy bare-numeric keys; non-main boards
// iterate composite-keyed buckets and filter by `bucket.board_id`.
//
// Returns refs sorted ascending (matches the legacy convention so calc tools
// process circuits in numeric order regardless of insertion order).
//
// @param {{circuits: Object, currentBoardId?: string}} snapshot
// @param {string?} boardId  — optional explicit override
// @returns {number[]}        — sorted ascending; circuit 0 (legacy supply) excluded
export function listCircuitRefsInBoard(snapshot, boardId) {
  if (!snapshot || !snapshot.circuits) return [];
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return Object.keys(snapshot.circuits)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  }
  const refs = [];
  for (const bucket of Object.values(snapshot.circuits)) {
    if (
      bucket &&
      bucket.board_id === id &&
      Number.isInteger(bucket.circuit) &&
      bucket.circuit >= 1
    ) {
      refs.push(bucket.circuit);
    }
  }
  return refs.sort((a, b) => a - b);
}

// "Work on Board" sprint Phase A — dual-shape existence check. Main board
// consults the legacy bare-numeric key; non-main boards consult the
// composite-key namespace (`${board_id}::${circuit}`).
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
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return circuit in snapshot.circuits;
  }
  return `${id}::${circuit}` in snapshot.circuits;
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
