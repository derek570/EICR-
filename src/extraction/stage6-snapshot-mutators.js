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
// Plan 00B §B2 — authoritative mutation capture. Every atom below emits
// exactly ONE immutable commit receipt per REAL state change via
// emitMutationCommit. Dormant single-Symbol-lookup no-op in production
// (no observer attached); only the evaluation harness attaches one.
import { emitMutationCommit, MUTATION_OBSERVER } from './plan00-semantic-capture.js';
import { FIELD_CORRECTIONS } from './field-name-corrections.js';
import { copyAfddPremisesRequirement } from './regulation-lookup.js';

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
  const previous = snapshot.circuits[circuit][field];
  snapshot.circuits[circuit][field] = value;
  if (previous !== value) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'reading',
        field,
        circuit,
        board_id: getMainBoardId(snapshot),
        value,
        previous_value: previous == null ? null : String(previous),
      });
    }
  }
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
  const previous = snapshot.circuits[0][field];
  snapshot.circuits[0][field] = value;
  if (previous !== value) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'board_reading',
        field,
        circuit: null,
        board_id: getMainBoardId(snapshot),
        value,
        previous_value: previous == null ? null : String(previous),
        detail: { storage: 'circuits0' },
      });
    }
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'clear',
      field,
      circuit,
      board_id: getMainBoardId(snapshot),
      value: null,
      previous_value: previousValue == null ? null : String(previousValue),
    });
  }
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
  const created = !snapshot.circuits[circuit_ref];
  if (!snapshot.circuits[circuit_ref]) snapshot.circuits[circuit_ref] = {};
  const target = snapshot.circuits[circuit_ref];
  // Canonical snapshot key is `circuit_designation` (matches field_schema.json,
  // _seedStateFromJobState, the Sonnet field enum, and iOS Circuit.swift's
  // formData decoder). Writing the legacy `designation` key here made
  // tool-loop-created circuits invisible to the canonical-key resolver
  // (Sonnet ambiguous_circuit lookup) — prod session 286D500D-2026-05-24
  // looped "Which circuit is the upstairs lighting?" because of it.
  const changedFields = [];
  const setMeta = (key, next) => {
    if (next == null) return;
    if (target[key] !== next) changedFields.push(key);
    target[key] = next;
  };
  setMeta('circuit_designation', designation);
  setMeta('phase', phase);
  setMeta('rating_amps', rating_amps);
  setMeta('cable_csa_mm2', cable_csa_mm2);
  if (created || changedFields.length > 0) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'circuit_upsert',
        field: null,
        circuit: circuit_ref,
        board_id: getMainBoardId(snapshot),
        value: null,
        detail: { created, changed_fields: changedFields },
      });
    }
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'circuit_rename',
      field: null,
      circuit: circuit_ref,
      board_id: getMainBoardId(snapshot),
      value: null,
      detail: { from_ref, to_ref: circuit_ref },
    });
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'circuit_delete',
      field: null,
      circuit: circuit_ref,
      board_id: getMainBoardId(snapshot),
      value: null,
    });
  }
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
  const previous = snapshot.circuits[key][field];
  snapshot.circuits[key][field] = value;
  if (previous !== value) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'reading',
        field,
        circuit,
        board_id: id,
        value,
        previous_value: previous == null ? null : String(previous),
      });
    }
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'clear',
      field,
      circuit,
      board_id: id,
      value: null,
      previous_value: previousValue == null ? null : String(previousValue),
    });
  }
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
  const created = !snapshot.circuits[key];
  if (!snapshot.circuits[key]) {
    snapshot.circuits[key] = { circuit: circuit_ref, board_id: id };
  }
  const target = snapshot.circuits[key];
  // Canonical key — see upsertCircuitMeta comment.
  const changedFields = [];
  const setMeta = (metaKey, next) => {
    if (next == null) return;
    if (target[metaKey] !== next) changedFields.push(metaKey);
    target[metaKey] = next;
  };
  setMeta('circuit_designation', designation);
  setMeta('phase', phase);
  setMeta('rating_amps', rating_amps);
  setMeta('cable_csa_mm2', cable_csa_mm2);
  if (created || changedFields.length > 0) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'circuit_upsert',
        field: null,
        circuit: circuit_ref,
        board_id: id,
        value: null,
        detail: { created, changed_fields: changedFields },
      });
    }
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'circuit_rename',
      field: null,
      circuit: circuit_ref,
      board_id: id,
      value: null,
      detail: { from_ref, to_ref: circuit_ref },
    });
  }
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
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'circuit_delete',
      field: null,
      circuit: circuit_ref,
      board_id: id,
      value: null,
    });
  }
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
  const previous = board[field];
  board[field] = value;
  if (previous !== value) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'board_reading',
        field,
        circuit: null,
        board_id: id,
        value,
        previous_value: previous == null ? null : String(previous),
        detail: { storage: 'boards' },
      });
    }
  }
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

// ---------------------------------------------------------------------------
// Plan A1a (2026-07-27, feedback id 101) — board/supply-scope CLEAR trio.
// There was no board clearer of any kind before this: clear_reading's trio is
// circuit-scope only, and the asymmetry (write board fields, never clear them)
// is the exact defect session C06B9904 hit ("Delete Ze" ×3, apology loop,
// bogus value persisting into the certificate).
// ---------------------------------------------------------------------------

/**
 * A board field may exist in the snapshot under any spelling the model used
 * on the write path (record_board_reading advertises all 84 members,
 * including both halves of a FIELD_CORRECTIONS alias pair — the
 * canonicalisation is OUTBOUND-ONLY, applied by the bundler when building
 * result.field_corrections; dispatchRecordBoardReading stores the RAW field).
 * A clear must therefore target EVERY spelling that canonicalises to the same
 * wire field — otherwise the untouched alias re-asserts the value on the next
 * snapshot (a clear that un-clears itself: the F5 shape, on Ze, in the plan
 * written to fix F5).
 *
 * Derived from FIELD_CORRECTIONS itself (all keys mapping to the canonical
 * wire name, plus the canonical name), never hand-listed — a future alias
 * then works without a code change. boardFieldAliasSet('ze') ===
 * Set{'ze', 'earth_loop_impedance_ze'}.
 *
 * @param {string} field — any spelling (raw enum member or canonical wire name)
 * @returns {Set<string>}
 */
export function boardFieldAliasSet(field) {
  const canonical = FIELD_CORRECTIONS[field] ?? field;
  const aliases = new Set([field, canonical]);
  for (const [raw, wire] of Object.entries(FIELD_CORRECTIONS)) {
    if (wire === canonical) aliases.add(raw);
  }
  return aliases;
}

/** A value that is actually WORTH clearing: non-nullish and, for strings,
 * non-blank after trimming. A key that merely EXISTS holding null/''/blank
 * is dead residue — reporting it as a successful clear would speak
 * "Ze cleared" over nothing meaningfully removed, when the truthful
 * outcome is the already-empty notice (Codex diff-review r1). */
function isMeaningfulStoredValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** Delete every alias spelling of `field` from one plain record.
 * `cleared` reports whether a MEANINGFUL value was removed (empty residue
 * keys are still deleted, but deleting them is not "a clear").
 * @returns {{cleared: boolean, previousValue: string|null}} */
function clearAliasesFromRecord(record, aliasSet) {
  if (!record || typeof record !== 'object') return { cleared: false, previousValue: null };
  let cleared = false;
  let previousValue = null;
  for (const alias of aliasSet) {
    if (alias in record) {
      const prior = record[alias];
      if (isMeaningfulStoredValue(prior)) {
        if (previousValue == null) previousValue = String(prior);
        cleared = true;
      }
      delete record[alias];
    }
  }
  return { cleared, previousValue };
}

/**
 * Legacy-bucket board clear: removes every alias spelling of `field` from
 * stateSnapshot.circuits[0] (the legacy supply/board/installation surface).
 * Contract matches clearReadingInSnapshot: {cleared, previousValue}.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{field: string}} input
 * @returns {{cleared: boolean, previousValue: string|null}}
 */
export function clearBoardReadingInSnapshot(snapshot, { field }) {
  const res = clearAliasesFromRecord(snapshot?.circuits?.[0], boardFieldAliasSet(field));
  if (res.cleared) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'board_clear',
        field,
        circuit: null,
        board_id: getMainBoardId(snapshot),
        value: null,
        previous_value: res.previousValue,
        detail: { storage: 'circuits0' },
      });
    }
  }
  return res;
}

/**
 * Multi-board board clear: removes every alias spelling of `field` from the
 * resolved board's BoardInfo record on snapshot.boards[].
 *
 * @param {{boards?: Array, currentBoardId?: string}} snapshot
 * @param {{field: string, boardId?: string}} input
 * @returns {{cleared: boolean, previousValue: string|null}}
 */
export function clearBoardReadingMultiBoard(snapshot, { field, boardId }) {
  const id = resolveBoardId(snapshot, boardId);
  const board = Array.isArray(snapshot?.boards)
    ? snapshot.boards.find((b) => b && b.id === id)
    : undefined;
  const res = clearAliasesFromRecord(board, boardFieldAliasSet(field));
  if (res.cleared) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'board_clear',
        field,
        circuit: null,
        board_id: id,
        value: null,
        previous_value: res.previousValue,
        detail: { storage: 'boards' },
      });
    }
  }
  return res;
}

/**
 * Scope-aware board clear (§3.3a). BACKEND STORAGE SCOPE IS A SECOND,
 * INDEPENDENT AXIS from client persistence scope: applyBoardReadingFlagAware
 * deposits a main-target write in circuits[0] and a non-main write in
 * boards[<resolved>], so WHERE a value lives depends on currentBoardId AT
 * WRITE TIME. The rule, in one line: scope decides both the slot key and the
 * bucket sweep — GLOBAL fields clear everywhere under every alias;
 * BOARD-SCOPED fields clear one board's record.
 *
 * `scope` is passed EXPLICITLY by the dispatcher (which owns the pinned
 * scope map) — this module must not import it (dependency inversion) nor
 * re-derive it (drift).
 *
 *  - scope 'global': board-INSENSITIVE. Removes the field from circuits[0],
 *    from EVERY boards[i], under every alias spelling, regardless of
 *    currentBoardId. Never branches on isMainBoardTarget — a global field's
 *    written value may sit in either bucket depending on which board was
 *    selected when it was dictated, and a partial sweep re-asserts on the
 *    next snapshot (the §3.3a F5 factory).
 *  - scope 'board': targets exactly the board a write would have hit
 *    (resolveBoardId convention). Main target additionally sweeps the main
 *    board's boards[] record — both backing buckets feed the same board —
 *    but NEVER another board's record.
 *
 * @param {{circuits: Object, boards?: Array, currentBoardId?: string}} snapshot
 * @param {{field: string, boardId?: string, scope: 'global'|'board'}} args
 * @returns {{cleared: boolean, previousValue: string|null}}
 */
export function clearBoardReadingFlagAware(snapshot, args) {
  const { field, boardId, scope } = args ?? {};
  const aliasSet = boardFieldAliasSet(field);
  if (scope === 'global') {
    let cleared = false;
    let previousValue = null;
    const fold = (res) => {
      if (res.cleared) cleared = true;
      if (previousValue == null) previousValue = res.previousValue;
    };
    fold(clearAliasesFromRecord(snapshot?.circuits?.[0], aliasSet));
    if (Array.isArray(snapshot?.boards)) {
      for (const board of snapshot.boards) {
        fold(clearAliasesFromRecord(board, aliasSet));
      }
    }
    if (cleared) {
      if (snapshot[MUTATION_OBSERVER]) {
        emitMutationCommit(snapshot, {
          kind: 'board_clear',
          field,
          circuit: null,
          board_id: null,
          value: null,
          previous_value: previousValue,
          detail: { scope: 'global' },
        });
      }
    }
    return { cleared, previousValue };
  }
  // Board-scoped: mirror the write path's target resolution.
  if (isMainBoardTarget(snapshot, args)) {
    const legacy = clearAliasesFromRecord(snapshot?.circuits?.[0], aliasSet);
    const mainId = getMainBoardId(snapshot);
    const mainBoard = Array.isArray(snapshot?.boards)
      ? snapshot.boards.find((b) => b && b.id === mainId)
      : undefined;
    const boardRes = clearAliasesFromRecord(mainBoard, aliasSet);
    const merged = {
      cleared: legacy.cleared || boardRes.cleared,
      previousValue: legacy.previousValue ?? boardRes.previousValue,
    };
    if (merged.cleared) {
      if (snapshot[MUTATION_OBSERVER]) {
        emitMutationCommit(snapshot, {
          kind: 'board_clear',
          field,
          circuit: null,
          board_id: mainId,
          value: null,
          previous_value: merged.previousValue,
          detail: { scope: 'board' },
        });
      }
    }
    return merged;
  }
  return clearBoardReadingMultiBoard(snapshot, { field, boardId });
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
export function appendObservation(session, input) {
  const {
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
  } = input;
  const id = randomUUID();
  if (!Array.isArray(session.extractedObservations)) {
    session.extractedObservations = [];
  }
  const stored = {
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
  };
  copyAfddPremisesRequirement(input, stored);
  session.extractedObservations.push(stored);
  if (session[MUTATION_OBSERVER]) {
    emitMutationCommit(session, {
      kind: 'observation_create',
      field: null,
      circuit: stored.circuit ?? null,
      board_id: null,
      value: null,
      detail: { observation_id: id, code: stored.code ?? null },
    });
  }
  return { id, observation: stored };
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
  if (session[MUTATION_OBSERVER]) {
    emitMutationCommit(session, {
      kind: 'observation_delete',
      field: null,
      circuit: removed?.circuit ?? null,
      board_id: null,
      value: null,
      detail: { observation_id },
    });
  }
  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// Plan 00B §B2 — canonical BOARD-OPERATION atoms. Extracted from
// stage6-dispatchers-board.js's inline direct writes (add_board's
// boards.push + currentBoardId flip, the inline distribution-circuit mark,
// select_board's currentBoardId flip) as a deliberate behaviour-preserving
// PRODUCTION refactor: the semantic oracle captures certificate mutations
// solely at declared atoms, and these were the semantic direct writes that
// bypassed the atom layer. Before/after board-state + boardOps identity is
// pinned by the existing board-dispatcher regression suite.
// ---------------------------------------------------------------------------

/**
 * Append a fully-validated board record and make it the current board —
 * add_board's snapshot mutation, verbatim. The dispatcher keeps ownership of
 * every validation and of the wire boardOps push; this atom owns only the
 * two snapshot writes (append + currentBoardId flip) and their single
 * commit receipt.
 */
export function appendBoardToSnapshot(snapshot, board) {
  if (!Array.isArray(snapshot.boards)) snapshot.boards = [];
  const previousCurrent = snapshot.currentBoardId ?? null;
  snapshot.boards.push(board);
  snapshot.currentBoardId = board.id;
  if (snapshot[MUTATION_OBSERVER]) {
    emitMutationCommit(snapshot, {
      kind: 'board_add',
      field: null,
      circuit: null,
      board_id: board.id,
      value: null,
      detail: {
        designation: board.designation ?? null,
        board_type: board.board_type ?? null,
        parent_board_id: board.parent_board_id ?? null,
        previous_current_board_id: previousCurrent,
      },
    });
  }
  return { appended: true, previousCurrentBoardId: previousCurrent };
}

/**
 * Flip snapshot.currentBoardId — select_board's snapshot mutation, verbatim
 * (the assignment always happens, matching the pre-refactor behaviour; the
 * commit receipt only exists when the selection actually CHANGED the
 * current board — a same-board select is not a state change).
 */
export function setCurrentBoardInSnapshot(snapshot, boardId) {
  const previous = snapshot.currentBoardId ?? null;
  snapshot.currentBoardId = boardId;
  if (previous !== boardId) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'select_board',
        field: null,
        circuit: null,
        board_id: boardId,
        value: null,
        detail: { previous_board_id: previous },
      });
    }
  }
  return { changed: previous !== boardId, previousBoardId: previous };
}

/**
 * Mark an EXISTING circuit bucket as a distribution circuit feeding
 * `feedsBoardId` — the shared snapshot mutation behind
 * mark_distribution_circuit AND add_board's inline auto-mark. The caller
 * resolves + validates the bucket; this atom owns the two field writes and
 * their single real-change-gated commit receipt.
 */
export function markDistributionCircuitInSnapshot(
  snapshot,
  bucket,
  { circuitRef, sourceBoardId, feedsBoardId }
) {
  const changed =
    bucket.is_distribution_circuit !== 'yes' || bucket.feeds_board_id !== feedsBoardId;
  bucket.is_distribution_circuit = 'yes';
  bucket.feeds_board_id = feedsBoardId;
  if (changed) {
    if (snapshot[MUTATION_OBSERVER]) {
      emitMutationCommit(snapshot, {
        kind: 'mark_distribution_circuit',
        field: null,
        circuit: circuitRef ?? null,
        board_id: sourceBoardId ?? null,
        value: null,
        detail: { feeds_board_id: feedsBoardId },
      });
    }
  }
  return { changed };
}

/**
 * Plan 00B §B2 — narrowly-named canonical atom for the LEGACY observation
 * apply path (off/shadow modes). The legacy leg reuses the model-provided
 * observation_id and its own record shape, which appendObservation (atom id
 * ownership) cannot reproduce state-identically — so the direct push moves
 * here verbatim instead. Live-mode observations keep using appendObservation.
 */
export function appendLegacyObservationRecord(session, record) {
  if (!Array.isArray(session.extractedObservations)) session.extractedObservations = [];
  session.extractedObservations.push(record);
  if (session[MUTATION_OBSERVER]) {
    emitMutationCommit(session, {
      kind: 'observation_create',
      field: null,
      circuit: record?.circuit ?? null,
      board_id: null,
      value: null,
      detail: { observation_id: record?.id ?? null, code: record?.code ?? null, leg: 'legacy' },
    });
  }
  return record;
}
