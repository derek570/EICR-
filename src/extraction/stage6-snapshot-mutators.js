// stage6-snapshot-mutators.js
//
// Shared mutation atoms for the Stage 6 agentic-extraction state snapshot.
// Both the LEGACY updateStateSnapshot path (eicr-extraction-session.js) and
// the new Phase 2 tool-call dispatchers MUST call these helpers — any logic
// that mutates stateSnapshot.circuits or session.extractedObservations lives
// here and only here. If it doesn't live here, the two paths WILL drift.
//
// Design:
//  - Every function is pure with respect to the snapshot/session ref it
//    receives. No logging. No WebSocket traffic. No session-level bookkeeping
//    beyond the narrow input shape documented per-function.
//  - Functions either mutate and return void, or mutate and return a small
//    `{ok, error?}` / `{cleared}` / `{id}` envelope so callers can react
//    without re-inspecting the snapshot.
//  - appendObservation OWNS UUID generation (crypto.randomUUID). The caller
//    does not pass an id in. This is deliberate — the dispatcher will surface
//    the returned id to the model in the tool_result envelope so the model
//    can reference it later in delete_observation.
//
// Plan 02-01 §Q4 locks an intentional divergence: record_reading for an
// unknown circuit is auto-created here (applyReadingToSnapshot creates the
// bucket) because the LEGACY path did so at eicr-extraction-session.js:989
// and behaviour must be preserved for the legacy refactor to pass its
// existing tests. Phase 2 dispatchers layer their own existence check on
// TOP of this atom — the strict-mode rejection lives in the dispatcher, not
// here.
//
// See Plan 02-01 for the full rationale; see §Interfaces for the locked
// function signatures that Phase 2 will consume verbatim.

import { randomUUID } from 'node:crypto';
import { getMainBoardId } from './stage6-multi-board-shape.js';

/**
 * Write a reading into stateSnapshot.circuits[circuit][field]. Auto-creates
 * the circuit bucket if missing — LEGACY behaviour. Phase 2 dispatchers MUST
 * validate circuit existence BEFORE calling this helper.
 *
 * @param {{circuits: Object}} snapshot — session.stateSnapshot reference
 * @param {{circuit: number, field: string, value: string}} input
 */
export function applyReadingToSnapshot(snapshot, { circuit, field, value }) {
  if (!snapshot.circuits[circuit]) snapshot.circuits[circuit] = {};
  snapshot.circuits[circuit][field] = value;
}

/**
 * Write a board / supply / installation-level reading into
 * stateSnapshot.circuits[0][field]. The `circuits[0]` bucket is the legacy
 * "supply / board / installation" surface — see `_seedStateFromJobState`
 * in eicr-extraction-session.js (which seeds `ze` / `pfc` etc. into
 * circuits[0]) and the `KNOWN_FIELDS` flat set in sonnet-stream.js (which
 * routes supply + board + installation field names through the same channel).
 *
 * Why circuits[0] (and not a new `snapshot.installation` namespace): the
 * legacy parser path already stores these readings here. If the agentic tool
 * path stored them under `snapshot.installation` instead, every shadow-mode
 * divergence row for a board-level reading would read "extra_in_tool" /
 * "extra_in_legacy" depending on direction, and the live cutover would have
 * to translate the namespace at the wire boundary. Mirroring legacy keeps
 * the slot comparator's projection trivial.
 *
 * Auto-creates the circuits[0] bucket if missing — same pattern as
 * applyReadingToSnapshot. Phase 2 dispatchers (record_board_reading) layer
 * their own field-enum validation on TOP of this atom — the strict-mode
 * defence-in-depth check lives in the dispatcher, not here.
 *
 * @param {{circuits: Object}} snapshot — session.stateSnapshot reference
 * @param {{field: string, value: string}} input
 */
export function applyBoardReadingToSnapshot(snapshot, { field, value }) {
  if (!snapshot.circuits[0]) snapshot.circuits[0] = {};
  snapshot.circuits[0][field] = value;
}

/**
 * Delete stateSnapshot.circuits[circuit][field]. Noop if circuit missing or
 * field absent on the bucket.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{circuit: number, field: string}} input
 * @returns {{cleared: boolean}}
 */
export function clearReadingInSnapshot(snapshot, { circuit, field }) {
  const bucket = snapshot.circuits?.[circuit];
  if (!bucket || !(field in bucket)) return { cleared: false, previousValue: null };
  // 1a.6: capture pre-clear value so the dispatcher can emit
  // field_corrected with `previous_value`. Stringify everything so the
  // wire shape (PLAN_v3 §4.5) is always string|null even when the
  // bucket held a number/boolean.
  const previousValue = bucket[field];
  delete bucket[field];
  return {
    cleared: true,
    previousValue: previousValue == null ? null : String(previousValue),
  };
}

/**
 * Upsert a circuit bucket with optional meta fields. Used by create_circuit
 * (to seed a new bucket with meta) and by rename_circuit (the meta-update
 * half — caller composes rename + upsert if both are changing). Does NOT
 * rekey — use renameCircuit for that.
 *
 * Null/undefined meta fields are ignored (no key written). This preserves
 * the "leave unchanged" semantics documented on the rename_circuit tool
 * schema — callers pass null when they don't want to touch a meta field.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{circuit_ref: number, designation?: string|null, phase?: string|null,
 *          rating_amps?: number|null, cable_csa_mm2?: number|null}} input
 */
export function upsertCircuitMeta(
  snapshot,
  { circuit_ref, designation, phase, rating_amps, cable_csa_mm2 }
) {
  if (!snapshot.circuits[circuit_ref]) snapshot.circuits[circuit_ref] = {};
  const target = snapshot.circuits[circuit_ref];
  // Canonical snapshot key is `circuit_designation` (matches field_schema.json,
  // _seedStateFromJobState, the Sonnet field enum, and iOS Circuit.swift's
  // formData decoder). Writing the legacy `designation` key here made
  // tool-loop-created circuits invisible to the canonical-key resolver
  // (Sonnet ambiguous_circuit lookup) — prod session 286D500D-2026-05-24
  // looped "Which circuit is the upstairs lighting?" because of it.
  if (designation != null) target.circuit_designation = designation;
  if (phase != null) target.phase = phase;
  if (rating_amps != null) target.rating_amps = rating_amps;
  if (cable_csa_mm2 != null) target.cable_csa_mm2 = cable_csa_mm2;
}

/**
 * Rekey a circuit bucket from `from_ref` to `circuit_ref`.
 *
 * Edge cases:
 *  - from_ref === circuit_ref → idempotent noop; returns {ok:true}. Plan
 *    02-01 §Q8 locks this — callers may emit a meta-only rename and we
 *    don't want to force them to choose a different tool.
 *  - from_ref missing in snapshot.circuits → {ok:false, error:source_not_found}.
 *  - target circuit_ref already exists (and is different from from_ref) →
 *    {ok:false, error:target_exists}. NO destructive merge — the caller must
 *    decide what to do (typically ask_user).
 *
 * Mutates in place on success. Does NOT call upsertCircuitMeta — caller
 * composes the two calls if meta is ALSO changing.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{from_ref: number, circuit_ref: number}} input
 * @returns {{ok: true} | {ok: false, error: {code: 'source_not_found'|'target_exists'}}}
 */
export function renameCircuit(snapshot, { from_ref, circuit_ref }) {
  if (from_ref === circuit_ref) return { ok: true };
  if (!snapshot.circuits[from_ref]) {
    return { ok: false, error: { code: 'source_not_found' } };
  }
  if (snapshot.circuits[circuit_ref]) {
    return { ok: false, error: { code: 'target_exists' } };
  }
  snapshot.circuits[circuit_ref] = snapshot.circuits[from_ref];
  delete snapshot.circuits[from_ref];
  return { ok: true };
}

/**
 * Remove a circuit bucket entirely. Used by the Stage 6 delete_circuit tool —
 * field-test 2026-05-04 (session 07635782) showed the inspector saying "delete
 * circuit 2" twice with no effect because the tool didn't exist; the bucket
 * lingered and stole subsequent designation lookups (see "the cooker" → wrong
 * circuit downstream).
 *
 * Edge cases:
 *  - circuit_ref absent in snapshot.circuits → {ok:true, deleted:false}.
 *    Same noop pattern as deleteObservation: the post-state already
 *    satisfies the request, so the dispatcher reports success.
 *  - circuit_ref === 0 (supply bucket) → caller-level concern; this atom
 *    deletes whatever key it's given. The dispatcher / validator must
 *    refuse refs ≤ 0 before reaching here.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{circuit_ref: number}} input
 * @returns {{ok: true, deleted: boolean}}
 */
export function deleteCircuit(snapshot, { circuit_ref }) {
  if (!snapshot.circuits || !(circuit_ref in snapshot.circuits)) {
    return { ok: true, deleted: false };
  }
  delete snapshot.circuits[circuit_ref];
  return { ok: true, deleted: true };
}

// ---------------------------------------------------------------------------
// Phase 5.2 — composite-key multi-board mutator helpers. Live alongside the
// legacy flat-key mutators above; the dual-shape wrappers below ("Work on
// Board" Phase A) route any non-main target through these.
//
// Composite key shape: `${board_id}::${circuit}` — a string so it never
// collides with the legacy numeric keys (JS object keys are always strings,
// so `circuits['1']` and `circuits['main::1']` are distinct slots).
//
// Bucket shape: `{ circuit: number, board_id: string, ...fields }`. The
// self-describing `circuit` + `board_id` keys let the serialiser flatten
// composite-keyed snapshots back to the iOS array shape
// `[{circuit, board_id, ...}]` without extra bookkeeping.
//
// Board ID defaulting: explicit `boardId` arg wins; falls back to
// `snapshot.currentBoardId`; falls back to `'main'`. The fallback chain is
// the same in every helper, factored into `resolveBoardId`.
// ---------------------------------------------------------------------------

const DEFAULT_BOARD_ID_FALLBACK = 'main';

function resolveBoardId(snapshot, explicitBoardId) {
  return explicitBoardId ?? snapshot?.currentBoardId ?? DEFAULT_BOARD_ID_FALLBACK;
}

function compositeKey(boardId, circuit) {
  return `${boardId}::${circuit}`;
}

/**
 * Lookup a circuit bucket by composite key. Returns the resolved key + the
 * bucket reference (or undefined if absent). Useful for read paths that need
 * to know the key for logging or for "did this exist before I wrote?" checks.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {number} circuit
 * @param {string|undefined|null} boardId — optional explicit override
 * @returns {{key: string, bucket: Object|undefined}}
 */
export function findCircuitBucket(snapshot, circuit, boardId) {
  const id = resolveBoardId(snapshot, boardId);
  const key = compositeKey(id, circuit);
  return { key, bucket: snapshot?.circuits?.[key] };
}

/**
 * Composite-key version of applyReadingToSnapshot. Writes
 * `snapshot.circuits[key][field] = value` where `key = ${board_id}::${circuit}`.
 *
 * Auto-creates the bucket if missing, seeded with the self-describing
 * `{circuit, board_id}` skeleton so the bucket can be flattened back to the
 * iOS row shape later.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {{circuit: number, field: string, value: string, boardId?: string}} input
 */
export function applyReadingMultiBoard(snapshot, { circuit, field, value, boardId }) {
  const id = resolveBoardId(snapshot, boardId);
  const key = compositeKey(id, circuit);
  if (!snapshot.circuits[key]) {
    snapshot.circuits[key] = { circuit, board_id: id };
  }
  snapshot.circuits[key][field] = value;
}

/**
 * Composite-key version of clearReadingInSnapshot. Removes
 * `snapshot.circuits[key][field]` if present; returns `{cleared: boolean}`
 * matching the legacy contract.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {{circuit: number, field: string, boardId?: string}} input
 * @returns {{cleared: boolean}}
 */
export function clearReadingMultiBoard(snapshot, { circuit, field, boardId }) {
  const id = resolveBoardId(snapshot, boardId);
  const key = compositeKey(id, circuit);
  const bucket = snapshot?.circuits?.[key];
  if (!bucket || !(field in bucket)) return { cleared: false, previousValue: null };
  // 1a.6: capture pre-clear value for field_corrected emission (see
  // sibling clearReadingInSnapshot above for the wire-shape rationale).
  const previousValue = bucket[field];
  delete bucket[field];
  return {
    cleared: true,
    previousValue: previousValue == null ? null : String(previousValue),
  };
}

/**
 * Composite-key version of upsertCircuitMeta. Same null-skipping semantics —
 * passing `null` for a meta field leaves the existing value untouched.
 * Auto-creates the bucket with the self-describing skeleton on first write.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {{circuit_ref: number, designation?: string|null, phase?: string|null,
 *          rating_amps?: number|null, cable_csa_mm2?: number|null,
 *          boardId?: string}} input
 */
export function upsertCircuitMetaMultiBoard(
  snapshot,
  { circuit_ref, designation, phase, rating_amps, cable_csa_mm2, boardId }
) {
  const id = resolveBoardId(snapshot, boardId);
  const key = compositeKey(id, circuit_ref);
  if (!snapshot.circuits[key]) {
    snapshot.circuits[key] = { circuit: circuit_ref, board_id: id };
  }
  const target = snapshot.circuits[key];
  // Canonical key — see upsertCircuitMeta comment.
  if (designation != null) target.circuit_designation = designation;
  if (phase != null) target.phase = phase;
  if (rating_amps != null) target.rating_amps = rating_amps;
  if (cable_csa_mm2 != null) target.cable_csa_mm2 = cable_csa_mm2;
}

/**
 * Composite-key version of renameCircuit. Same-board only — moving a circuit
 * between boards is a different operation (not yet a tool). Same edge cases
 * as the flat version: idempotent on `from_ref === circuit_ref`,
 * `source_not_found` if the from-key is empty, `target_exists` if the
 * to-key is occupied (no destructive merge).
 *
 * On success, the bucket's self-describing `circuit` field is updated to
 * the new ref so the bucket stays internally consistent post-rekey.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {{from_ref: number, circuit_ref: number, boardId?: string}} input
 * @returns {{ok: true} | {ok: false, error: {code: 'source_not_found'|'target_exists'}}}
 */
export function renameCircuitMultiBoard(snapshot, { from_ref, circuit_ref, boardId }) {
  if (from_ref === circuit_ref) return { ok: true };
  const id = resolveBoardId(snapshot, boardId);
  const fromKey = compositeKey(id, from_ref);
  const toKey = compositeKey(id, circuit_ref);
  if (!snapshot.circuits[fromKey]) {
    return { ok: false, error: { code: 'source_not_found' } };
  }
  if (snapshot.circuits[toKey]) {
    return { ok: false, error: { code: 'target_exists' } };
  }
  const bucket = snapshot.circuits[fromKey];
  bucket.circuit = circuit_ref;
  snapshot.circuits[toKey] = bucket;
  delete snapshot.circuits[fromKey];
  return { ok: true };
}

/**
 * Composite-key version of deleteCircuit. Noop if the bucket is absent
 * (returns `{ok:true, deleted:false}` matching the legacy semantic).
 * Dispatcher / validator layer is responsible for refusing `circuit_ref <= 0`.
 *
 * @param {{circuits: Object, currentBoardId?: string}} snapshot
 * @param {{circuit_ref: number, boardId?: string}} input
 * @returns {{ok: true, deleted: boolean}}
 */
export function deleteCircuitMultiBoard(snapshot, { circuit_ref, boardId }) {
  const id = resolveBoardId(snapshot, boardId);
  const key = compositeKey(id, circuit_ref);
  if (!snapshot?.circuits || !(key in snapshot.circuits)) {
    return { ok: true, deleted: false };
  }
  delete snapshot.circuits[key];
  return { ok: true, deleted: true };
}

/**
 * Phase 5.5 — board-level multi-board mutator. Writes to BoardInfo on the
 * resolved board's `boards[]` entry rather than to `circuits[0]`. The
 * structural shift is the point: under flag-on, supply / board /
 * installation fields stop sharing the legacy `circuits[0]` namespace and
 * land on the board record they describe, so the iOS app's already-shipped
 * multi-board model is the authoritative shape on both sides of the wire.
 *
 * Bucket shape: `{id, designation, board_type, ...fields}`. The first three
 * are seeded by `ensureMultiBoardShape` (slice 5.1); subsequent writes
 * accrete supply / installation field names alongside.
 *
 * Synthesised on first write if the resolved board id is missing — the
 * session constructor's `ensureMultiBoardShape` call guarantees a default
 * `main` board, but a future writer (e.g. an `add_board` flow that pushes
 * AFTER the write target is named) might point at an id that doesn't yet
 * exist. Synthesise rather than silent-drop.
 *
 * Why a separate mutator from `applyReadingMultiBoard`: the storage shape
 * is different. Circuits live at `snapshot.circuits[`${id}::${ref}`]`;
 * board-level fields live at `snapshot.boards[].find(b => b.id === id)`.
 * Sharing a helper would conflate two namespaces that the iOS model
 * deliberately separates.
 *
 * @param {{boards?: Array, currentBoardId?: string}} snapshot
 * @param {{field: string, value: string, boardId?: string}} input
 */
export function applyBoardReadingMultiBoard(snapshot, { field, value, boardId }) {
  const id = resolveBoardId(snapshot, boardId);
  if (!Array.isArray(snapshot.boards)) {
    snapshot.boards = [];
  }
  let board = snapshot.boards.find((b) => b && b.id === id);
  if (!board) {
    // Defensive: ensureMultiBoardShape guarantees boards is non-empty for the
    // 'main' default, but a writer may target a previously-unseen id. Seed a
    // minimum-viable BoardInfo so subsequent writes accrete fields normally.
    board = {
      id,
      designation: id,
      board_type: id === DEFAULT_BOARD_ID_FALLBACK ? 'main' : 'sub-distribution',
    };
    snapshot.boards.push(board);
  }
  board[field] = value;
}

// ---------------------------------------------------------------------------
// "Work on Board" sprint Phase A — dual-shape wrappers. Replaces the previous
// STAGE6_MULTI_BOARD flag-on/off branch with a per-call rule: writes to the
// MAIN board (resolved via getMainBoardId) take the legacy flat-key path,
// writes to ANY OTHER board take the composite-key path.
//
// Why dual-shape rather than full composite: every existing iterator that
// filters `Number.isInteger(n) && n >= 1` over snapshot.circuits keys keeps
// working untouched, because main's circuits stay at bare numeric keys.
// Sub-board buckets live at `${board_id}::${ref}` and are naturally skipped
// by the legacy filters. Phase 5.6 of the older sprint can retire the
// legacy half later as a clean-up.
//
// Wrapper names stay (*FlagAware) so every dispatcher import keeps compiling.
// ---------------------------------------------------------------------------

function isMainBoardTarget(snapshot, args) {
  const mainId = getMainBoardId(snapshot);
  const target = args?.boardId ?? snapshot?.currentBoardId ?? mainId;
  return target === mainId;
}

export function applyReadingFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    applyReadingToSnapshot(snapshot, args);
  } else {
    applyReadingMultiBoard(snapshot, args);
  }
}

export function clearReadingFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    return clearReadingInSnapshot(snapshot, args);
  }
  return clearReadingMultiBoard(snapshot, args);
}

export function upsertCircuitMetaFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    upsertCircuitMeta(snapshot, args);
  } else {
    upsertCircuitMetaMultiBoard(snapshot, args);
  }
}

export function renameCircuitFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    return renameCircuit(snapshot, args);
  }
  return renameCircuitMultiBoard(snapshot, args);
}

export function deleteCircuitFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    return deleteCircuit(snapshot, args);
  }
  return deleteCircuitMultiBoard(snapshot, args);
}

/**
 * Dual-shape wrapper for board / supply / installation reads.
 *
 * Main-target: legacy `applyBoardReadingToSnapshot` writes to `circuits[0]`,
 * preserving every existing reader (8+ files) until slice 5.6 retires the
 * legacy bucket.
 * Non-main target: `applyBoardReadingMultiBoard` writes to the resolved
 * board's BoardInfo entry on `boards[]`.
 */
export function applyBoardReadingFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) {
    applyBoardReadingToSnapshot(snapshot, args);
  } else {
    applyBoardReadingMultiBoard(snapshot, args);
  }
}

/**
 * Append an observation to session.extractedObservations with a fresh
 * crypto.randomUUID(). The atom owns id generation — callers never pass an
 * id in. Initialises session.extractedObservations if absent.
 *
 * Returns {id} so the dispatcher can surface the new id to the model in the
 * tool_result envelope (Plan 02-04 will consume this).
 *
 * Semantic dedup (e.g. OBSERVATION_CORRECTION_LEAD_IN) is NOT handled here —
 * that is a dispatcher-layer concern and deliberately differs between the
 * legacy path and the tool-call path.
 *
 * @param {{extractedObservations?: Array}} session
 * @param {{code: string, location: string, text: string,
 *          circuit: number|null, suggested_regulation: string|null}} input
 * @returns {{id: string}}
 */
export function appendObservation(
  session,
  {
    code,
    location,
    text,
    circuit,
    suggested_regulation,
    schedule_item,
    // Plan 06-23 obs-#52 Fix B — canonical BS 7671 wording attached by the
    // dispatcher on a regulation-table HIT (null on a MISS / no ref).
    regulation_title,
    regulation_description,
    // Plan 06-23 obs-#51 — one-clause "why this code" rationale (null if none).
    rationale,
  }
) {
  const id = randomUUID();
  if (!Array.isArray(session.extractedObservations)) {
    session.extractedObservations = [];
  }
  session.extractedObservations.push({
    id,
    code,
    location,
    text,
    circuit: circuit ?? null,
    suggested_regulation: suggested_regulation ?? null,
    schedule_item: schedule_item ?? null,
    regulation_title: regulation_title ?? null,
    regulation_description: regulation_description ?? null,
    rationale: rationale ?? null,
  });
  return { id };
}

/**
 * Remove an observation from session.extractedObservations by its id.
 * Returns {ok:true, removed} with the removed object on success, or
 * {ok:false, error:{code:'not_found'}} if no observation with that id
 * exists. Semantic noop handling (duplicate delete, etc.) lives in the
 * dispatcher — the atom simply reports boolean removal.
 *
 * @param {{extractedObservations?: Array}} session
 * @param {{observation_id: string}} input
 * @returns {{ok: true, removed: object} | {ok: false, error: {code: 'not_found'}}}
 */
export function deleteObservation(session, { observation_id }) {
  const arr = Array.isArray(session.extractedObservations) ? session.extractedObservations : [];
  const idx = arr.findIndex((o) => o.id === observation_id);
  if (idx === -1) return { ok: false, error: { code: 'not_found' } };
  const [removed] = arr.splice(idx, 1);
  return { ok: true, removed };
}
