/**
 * A1 agentic-voice (2026-07-23) — pure projector behind inspect_session_state.
 *
 * Policy + response shapes are pinned by the APPROVED appendix
 * docs/reference/inspect-session-state-policy.md (A1 Phase 0.6): change the
 * appendix first, then this module. Everything here is PURE — reads a
 * stateSnapshot, mutates nothing, no session/IO access. Board/circuit access
 * goes ONLY through the stage6-multi-board-shape helpers (main and sub-boards
 * can share a circuit reference; direct `circuits[...]` keying returns the
 * wrong circuit). Every user-derived string that leaves this module is
 * sanitised + USER_TEXT-wrapped via the shared stage6-snapshot-user-text
 * helpers — identical hygiene to the cached-prefix snapshot rendering.
 */

import { createRequire } from 'node:module';
import {
  getCircuitBucket,
  getMainBoardId,
  listCircuitRefsInBoard,
} from './stage6-multi-board-shape.js';
import { applyWrapPolicy, wrapSnapshotUserTextInline } from './stage6-snapshot-user-text.js';

const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

/** Serialized-size cap (UTF-8 bytes of the tool_result content) — appendix §4. */
export const INSPECT_MAX_RESULT_BYTES = 4096;

// ---------------------------------------------------------------------------
// Appendix §2.1 — classification of the 31 circuit_fields keys.
// ---------------------------------------------------------------------------

const CIRCUIT_FIELD_KEYS = Object.keys(fieldSchema.circuit_fields);

// 18 base schedule columns, in schema declaration order (stable for tests).
const REQUIRED_BASE = [
  'circuit_designation',
  'wiring_type',
  'ref_method',
  'number_of_points',
  'live_csa_mm2',
  'cpc_csa_mm2',
  'max_disconnect_time_s',
  'ocpd_bs_en',
  'ocpd_type',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ocpd_max_zs_ohm',
  'r1_r2_ohm',
  'ir_test_voltage_v',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
  'polarity_confirmed',
  'measured_zs_ohm',
];

const RING_FIELDS = ['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm'];
const RCD_FIELDS = [
  'rcd_bs_en',
  'rcd_type',
  'rcd_operating_current_ma',
  'rcd_time_ms',
  'rcd_button_confirmed',
];

/** Appendix §2.2 — a value is MISSING iff null/undefined or blank-after-trim.
 *  LIM / N/A / >200 / FAIL etc. all COUNT as recorded. */
export function isMissingValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function isPopulated(bucket, key) {
  return !isMissingValue(bucket?.[key]);
}

/**
 * Appendix §2 — THE pure policy function. certType is retained for a future
 * divergence but the matrix is identical for EICR and EIC (shared Schedule of
 * Test Results columns).
 *
 * @param {{certType?: string, circuit: object}} args — circuit is the BUCKET.
 * @returns {string[]} applicable required circuit-field keys.
 */
export function getApplicableRequiredFields({ certType: _certType, circuit }) {
  const bucket = circuit && typeof circuit === 'object' ? circuit : {};
  const designation =
    typeof bucket.circuit_designation === 'string'
      ? bucket.circuit_designation
      : typeof bucket.designation === 'string'
        ? bucket.designation
        : '';

  // Spare-way exemption: no tests on a spare way.
  if (/\bspare\b/i.test(designation)) {
    return ['circuit_designation'];
  }

  const required = new Set(REQUIRED_BASE);

  // Ring final circuit → the three end-to-end leg readings.
  const isRing = /\bring\b/i.test(designation) || RING_FIELDS.some((f) => isPopulated(bucket, f));
  if (isRing) {
    for (const f of RING_FIELDS) required.add(f);
  }

  // RCD-protected → the five RCD columns. "Populated with a value other than
  // N/A" — an explicit N/A on an rcd field is a recorded inapplicability, not
  // evidence of RCD protection.
  const rcdEvidence =
    RCD_FIELDS.some((f) => {
      const v = bucket?.[f];
      if (isMissingValue(v)) return false;
      return String(v).trim().toUpperCase() !== 'N/A';
    }) || String(bucket?.ocpd_bs_en ?? '').includes('61009');
  if (rcdEvidence) {
    for (const f of RCD_FIELDS) required.add(f);
  }

  // Distribution circuit → must name the board it feeds.
  if (String(bucket?.is_distribution_circuit ?? '').toLowerCase() === 'yes') {
    required.add('feeds_board_id');
  }

  // Emit in schema declaration order for deterministic output.
  return CIRCUIT_FIELD_KEYS.filter((k) => required.has(k));
}

/** Missing-field keys for one circuit bucket, per the policy above. */
export function computeMissingFields(bucket, certType) {
  return getApplicableRequiredFields({ certType, circuit: bucket }).filter(
    (key) => !isPopulated(bucket, key)
  );
}

// ---------------------------------------------------------------------------
// Board / field-key validation surfaces
// ---------------------------------------------------------------------------

function realKeys(section) {
  return Object.keys(section ?? {}).filter((k) => !k.startsWith('_'));
}

// Known keys for scope='field'. Circuit fields plus the supply / board /
// installation buckets (the same union record_board_reading writes).
const BOARD_LEVEL_FIELD_KEYS = new Set([
  ...realKeys(fieldSchema.supply_characteristics_fields),
  ...realKeys(fieldSchema.board_fields),
  ...realKeys(fieldSchema.installation_details_fields),
]);
const CIRCUIT_FIELD_KEY_SET = new Set(CIRCUIT_FIELD_KEYS);

export function isKnownFieldKey(field) {
  return CIRCUIT_FIELD_KEY_SET.has(field) || BOARD_LEVEL_FIELD_KEYS.has(field);
}

function findBoard(snapshot, boardId) {
  if (!Array.isArray(snapshot?.boards)) return undefined;
  return snapshot.boards.find((b) => b && b.id === boardId);
}

/** Resolve the target board id. Explicit unknown id → null (caller emits
 *  not_found); absent → currentBoardId → main. */
export function resolveBoardTarget(snapshot, requestedBoardId) {
  if (requestedBoardId != null && requestedBoardId !== '') {
    return findBoard(snapshot, requestedBoardId) ? requestedBoardId : null;
  }
  const id = snapshot?.currentBoardId ?? getMainBoardId(snapshot);
  return id;
}

function boardDesignation(snapshot, boardId) {
  const board = findBoard(snapshot, boardId);
  const raw = board?.designation;
  return typeof raw === 'string' && raw.trim() ? wrapSnapshotUserTextInline(raw) : null;
}

function bucketDesignation(bucket) {
  const raw =
    typeof bucket?.circuit_designation === 'string' && bucket.circuit_designation.trim()
      ? bucket.circuit_designation
      : typeof bucket?.designation === 'string' && bucket.designation.trim()
        ? bucket.designation
        : null;
  return raw == null ? null : wrapSnapshotUserTextInline(raw);
}

// ---------------------------------------------------------------------------
// Scope projections (appendix §3)
// ---------------------------------------------------------------------------

function normaliseCertType(certType) {
  if (typeof certType !== 'string') return null;
  const upper = certType.trim().toUpperCase();
  return upper === 'EIC' || upper === 'EICR' ? upper : null;
}

export function projectSummary(snapshot, { certType, observationCount } = {}) {
  const boards = Array.isArray(snapshot?.boards) ? snapshot.boards : [];
  const ct = normaliseCertType(certType);
  const boardRows = [];
  let totalCircuits = 0;
  let totalComplete = 0;
  for (const board of boards) {
    if (!board || board.id == null) continue;
    const refs = listCircuitRefsInBoard(snapshot, board.id);
    let complete = 0;
    for (const ref of refs) {
      const bucket = getCircuitBucket(snapshot, ref, board.id);
      if (computeMissingFields(bucket, ct).length === 0) complete += 1;
    }
    boardRows.push({
      board_id: board.id,
      designation: boardDesignation(snapshot, board.id),
      circuit_count: refs.length,
      complete_circuits: complete,
      incomplete_circuits: refs.length - complete,
    });
    totalCircuits += refs.length;
    totalComplete += complete;
  }
  return {
    ok: true,
    scope: 'summary',
    cert_type: ct,
    boards: boardRows,
    total_circuits: totalCircuits,
    total_complete: totalComplete,
    total_incomplete: totalCircuits - totalComplete,
    observation_count: Number.isInteger(observationCount) ? observationCount : null,
    truncated: false,
  };
}

export function projectBoard(snapshot, boardId, { certType } = {}) {
  const refs = listCircuitRefsInBoard(snapshot, boardId);
  const ct = normaliseCertType(certType);
  const incomplete = [];
  for (const ref of refs) {
    const bucket = getCircuitBucket(snapshot, ref, boardId);
    const missing = computeMissingFields(bucket, ct);
    if (missing.length > 0) {
      incomplete.push({
        circuit: ref,
        designation: bucketDesignation(bucket),
        missing,
        missing_count: missing.length,
      });
    }
  }
  return {
    ok: true,
    scope: 'board',
    board_id: boardId,
    designation: boardDesignation(snapshot, boardId),
    circuit_count: refs.length,
    circuits: incomplete,
    truncated: false,
  };
}

export function projectCircuit(snapshot, circuit, boardId, { certType } = {}) {
  const bucket = getCircuitBucket(snapshot, circuit, boardId);
  if (!bucket || typeof bucket !== 'object') return null; // caller emits not_found
  const values = {};
  for (const key of CIRCUIT_FIELD_KEYS) {
    if (isPopulated(bucket, key)) {
      values[key] = applyWrapPolicy(key, bucket[key]);
    }
  }
  return {
    ok: true,
    scope: 'circuit',
    board_id: boardId,
    circuit,
    designation: bucketDesignation(bucket),
    values,
    missing: computeMissingFields(bucket, normaliseCertType(certType)),
    truncated: false,
  };
}

export function projectField(snapshot, { field, circuit, boardId }) {
  let value;
  if (circuit != null) {
    const bucket = getCircuitBucket(snapshot, circuit, boardId);
    if (!bucket || typeof bucket !== 'object') return null; // not_found
    value = bucket[field];
  } else {
    // Supply/board-level lookup: the legacy circuits[0] bucket first, then the
    // board record itself (ze/ipf_at_db/location live on boards[] for
    // non-main boards).
    const supplyBucket = getCircuitBucket(snapshot, 0, boardId);
    value = supplyBucket?.[field];
    if (isMissingValue(value)) {
      const board = findBoard(snapshot, boardId);
      if (board && !isMissingValue(board[field])) value = board[field];
    }
  }
  const recorded = !isMissingValue(value);
  return {
    ok: true,
    scope: 'field',
    board_id: boardId,
    circuit: circuit ?? null,
    field,
    recorded,
    value: recorded ? applyWrapPolicy(field, value) : null,
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Appendix §4 — deterministic truncation ladder.
// ---------------------------------------------------------------------------

function byteLength(body) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/**
 * Enforce INSPECT_MAX_RESULT_BYTES. Mutates a shallow-cloned body through the
 * appendix's ladder; counts/totals are never recomputed after truncation.
 */
export function capInspectResult(body) {
  if (byteLength(body) <= INSPECT_MAX_RESULT_BYTES) return body;
  const capped = { ...body, truncated: true };

  // Stage 1: drop per-circuit `missing` arrays (keep missing_count).
  if (Array.isArray(capped.circuits)) {
    capped.circuits = capped.circuits.map((c) => {
      if (!Array.isArray(c.missing)) return c;
      const rest = { ...c };
      delete rest.missing;
      return rest;
    });
    if (byteLength(capped) <= INSPECT_MAX_RESULT_BYTES) return capped;
  }

  // Stage 2: drop tail entries of circuits[]/boards[] (lowest refs kept).
  for (const listKey of ['circuits', 'boards']) {
    while (Array.isArray(capped[listKey]) && capped[listKey].length > 0) {
      if (byteLength(capped) <= INSPECT_MAX_RESULT_BYTES) return capped;
      capped[listKey] = capped[listKey].slice(0, -1);
    }
  }

  // Stage 3: circuit scope — drop `values` entries from the tail.
  if (capped.values && typeof capped.values === 'object') {
    const entries = Object.entries(capped.values);
    while (entries.length > 0 && byteLength({ ...capped, values: Object.fromEntries(entries) }) > INSPECT_MAX_RESULT_BYTES) {
      entries.pop();
    }
    capped.values = Object.fromEntries(entries);
    if (byteLength(capped) <= INSPECT_MAX_RESULT_BYTES) return capped;
  }

  // Stage 4: field scope — slice the value string.
  if (typeof capped.value === 'string' && capped.value.length > 512) {
    capped.value = capped.value.slice(0, 512);
  }
  return capped;
}
