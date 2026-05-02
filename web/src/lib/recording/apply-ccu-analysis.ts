/**
 * Fold a /api/analyze-ccu response onto a JobDetail patch.
 *
 * Mirrors the iOS `FuseboardAnalysisApplier` flow
 * (Sources/Processing/FuseboardAnalysisApplier.swift). The key
 * properties the three modes must preserve, in order of importance:
 *
 *   1. **Never clobber user-typed values.** The 3-tier priority guard
 *      (pre-existing manual > CCU > recording-time Sonnet) is the
 *      whole reason this endpoint is safe to re-run — `mergeField`
 *      below is the non-empty-only variant.
 *   2. **Preserve test readings on matched circuits.** Hardware
 *      Update mode carries forward `measured_zs_ohm`, `r1_r2_ohm`,
 *      `ir_live_earth_mohm`, `rcd_time_ms`, polarity, etc. on any
 *      circuit the inspector has matched — the analysis overwrites
 *      only the hardware fields.
 *   3. **Never lose a circuit with readings.** Full-capture + Hardware
 *      Update both append any circuit that the analysis omits AND has
 *      test data, rather than dropping it. iOS parity.
 *
 * Three modes:
 *
 *   - `names_only` — apply only `circuit_ref` + `circuit_designation`
 *     onto the board's existing circuits (or append new rows where no
 *     ref exists). Useful for quick label-only scans where the
 *     inspector plans to dictate everything else.
 *   - `full_capture` — original behaviour: match by `circuit_ref` only,
 *     merge hardware non-destructively. No fuzzy matching of labels.
 *   - `hardware_update` — EXPECTS the caller to have already run
 *     `matchCircuits()` and presented the Match Review screen. The
 *     caller passes `userApprovedMatches`; we merge each approved pair
 *     (new hardware onto old circuit, readings preserved) and append
 *     unmatched old rows that carry readings.
 */

import type { CCUAnalysis, CCUAnalysisCircuit, CircuitRow, JobDetail } from '../types';
import { hasValue } from './apply-extraction';
import type { CircuitMatch } from '@certmate/shared-utils';

/** Valid RCD sensitivity types — iOS keeps this list in
 *  FuseboardAnalysisApplier.swift (two copies). Matches exactly so
 *  normalisation behaves identically across platforms. */
const VALID_RCD_TYPES = new Set(['AC', 'A', 'B', 'F', 'S', 'A-S', 'B-S', 'B+']);

/**
 * Filter out the standalone-RCD schedule rows that the per-slot merger
 * emits (2-module BS EN 61008-1 devices with `circuit_number: null`
 * and `is_rcd_device: true`). They represent a device, not a numbered
 * circuit — the BS EN they carry is already applied at the
 * board-SPD/main-switch level. iOS does the same in
 * `FuseboardAnalysis.circuitsForSchedule`.
 */
function circuitsForSchedule(circuits: CCUAnalysisCircuit[]): CCUAnalysisCircuit[] {
  return circuits.filter((c) => c.is_rcd_device !== true && c.circuit_number != null);
}

/** Test-reading fields that, if populated on a matched-but-now-missing
 *  circuit, cause the row to be preserved at the end of the list
 *  instead of being dropped. Matches the iOS checklist. */
const READING_KEYS = [
  'measured_zs_ohm',
  'r1_r2_ohm',
  'r2_ohm',
  'ir_live_earth_mohm',
  'ir_live_live_mohm',
  'rcd_time_ms',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'polarity_confirmed',
] as const;

/** Three client-side apply strategies — the backend returns the same
 *  superset regardless of which one is selected. */
export type CcuApplyMode = 'names_only' | 'full_capture' | 'hardware_update';

export interface CcuApplyOptions {
  /** Which board the analysis targets. Defaults to the first board
   *  (or auto-synthesises a main board when the job has none). */
  targetBoardId?: string | null;
  /** Apply strategy. Defaults to `full_capture` for backward
   *  compatibility with callers that don't know about modes. */
  mode?: CcuApplyMode;
  /** Required when `mode === 'hardware_update'`. The result of the
   *  match review: each entry pairs an analysed circuit with an
   *  optional existing circuit (null = treat as brand new). */
  userApprovedMatches?: CircuitMatch<CCUAnalysisCircuit, CircuitRow>[];
}

export interface CcuApplyResult {
  /** `updateJob(patch)` — only sections that changed are present. */
  patch: Partial<JobDetail>;
  /**
   * Questions for the inspector pulled from the analysis response,
   * augmented with auto-generated questions for RCD-protected
   * circuits whose type couldn't be determined (iOS parity).
   */
  questions: string[];
}

/** Only overwrite if `incoming` is a real non-empty value. Used for
 *  every field touched by the analyser — never let a null/undefined
 *  blank out a manually-typed value. */
function mergeField<T>(existing: T | undefined, incoming: T | undefined | null): T | undefined {
  if (incoming == null) return existing;
  if (typeof incoming === 'string' && incoming.trim() === '') return existing;
  return incoming;
}

/** Normalise the analyser's RCD-type string to one of the approved
 *  values. Returns `undefined` for "RCBO" (that's an OCPD type) and
 *  anything not in VALID_RCD_TYPES. */
function normaliseRcdType(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.toUpperCase().trim().replace(/ PLUS/g, '+').replace(/ \+/g, '+');
  if (!cleaned) return undefined;
  if (!VALID_RCD_TYPES.has(cleaned)) return undefined;
  return cleaned;
}

/** Build the boards-array patch — merges into an existing board row
 *  (matched by `boardId`) or creates one if the job has no boards
 *  yet. Never clobbers non-empty values. Returns the updated boards
 *  array (backend canonical `job.boards`) plus the resolved boardId. */
function buildBoardPatch(
  job: JobDetail,
  analysis: CCUAnalysis,
  targetBoardId: string | null,
  overwrite: boolean
): { boards: Record<string, unknown>[]; boardId: string } {
  type BoardRecord = Record<string, unknown> & { id: string };
  const existingBoards = (job.boards ?? []) as BoardRecord[];
  const boards: BoardRecord[] = [...existingBoards];

  // Resolve which board row we're patching. If none exist, synthesise a main board.
  let idx = targetBoardId ? boards.findIndex((b) => b.id === targetBoardId) : 0;
  if (idx < 0 || boards.length === 0) {
    if (boards.length === 0) {
      const newId = globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}`;
      boards.push({ id: newId, designation: 'DB1', board_type: 'main' });
      idx = 0;
    } else {
      idx = 0;
    }
  }

  const existing = boards[idx];
  const next: BoardRecord = { ...existing };

  /** Hardware-update "overwrite" branch: ALWAYS replace existing
   *  value when the analyser returned a non-empty one (the board
   *  has physically changed). Other modes are non-destructive. */
  const writeField = (key: string, incoming: unknown) => {
    if (!hasValue(incoming)) return;
    if (overwrite || !hasValue(next[key])) next[key] = incoming;
  };

  writeField('manufacturer', analysis.board_manufacturer);
  // `analysis.board_model` is the manufacturer's model string (e.g.
  // "Wylex NH10"). Store it in its own `board_model` field so downstream
  // consumers that need the model specifically (PDF, compliance report)
  // don't have to re-derive it from the `name`. Keep `name` in sync with
  // `board_model` when the user hasn't supplied a separate display name.
  writeField('board_model', analysis.board_model);
  writeField('name', analysis.board_model);
  // `board_technology` was added to the response 2026-04-22 (per-slot
  // pipeline). Persist on the board so PDF / Defaults / circuit
  // editors can branch on rewireable boards (BS 3036 fuses get
  // different OCPD defaults to BS 60898 MCBs).
  writeField('board_technology', analysis.board_technology);

  // Main switch.
  const switchCurrent = analysis.main_switch_current ?? analysis.main_switch_rating;
  writeField('main_switch_bs_en', analysis.main_switch_bs_en);
  writeField('voltage_rating', analysis.main_switch_voltage);
  writeField('rated_current', switchCurrent);

  // SPD — iOS parity: when spd_present is an explicit boolean we set
  // spd_status deterministically (Fitted / Not Fitted). When the
  // analyser is uncertain (undefined), leave whatever the inspector
  // has set alone.
  if (analysis.spd_present === true) {
    if (hasValue(analysis.spd_type)) next.spd_type = analysis.spd_type;
    next.spd_status = 'Fitted';
  } else if (analysis.spd_present === false) {
    next.spd_type = 'N/A';
    next.spd_status = 'Not Fitted';
  }

  boards[idx] = next;

  return {
    boards,
    boardId: next.id,
  };
}

/** Build the supply patch — merges the `spd_*` supply-section
 *  fallbacks (which the backend auto-derives from the main switch in
 *  routes/extraction.js:961-974) into `job.supply_characteristics`. */
function buildSupplyPatch(job: JobDetail, analysis: CCUAnalysis): Record<string, unknown> | null {
  const existing = (job.supply_characteristics as Record<string, unknown> | undefined) ?? {};
  const next: Record<string, unknown> = { ...existing };
  let changed = false;

  const apply = (key: string, incoming: unknown) => {
    if (hasValue(existing[key])) return;
    if (!hasValue(incoming)) return;
    next[key] = incoming;
    changed = true;
  };

  if (analysis.spd_present === true) {
    apply('spd_bs_en', analysis.spd_bs_en);
    apply('spd_type_supply', analysis.spd_type);
    apply('spd_short_circuit', analysis.spd_short_circuit_ka);
    apply('spd_rated_current', analysis.spd_rated_current_a);
  } else if (analysis.spd_present === false) {
    // iOS parity: explicit N/A stamps when there's no SPD in the CU.
    for (const key of ['spd_bs_en', 'spd_type_supply', 'spd_short_circuit', 'spd_rated_current']) {
      if (!hasValue(existing[key])) {
        next[key] = 'N/A';
        changed = true;
      }
    }
  }

  // Backend also sends fallbacks derived from the main switch.
  apply('spd_rated_current', analysis.spd_rated_current);
  apply('spd_type_supply', analysis.spd_type_supply);

  return changed ? next : null;
}

// ---------------------------------------------------------------------------
// Mode 1 — Circuit names only
// ---------------------------------------------------------------------------

/**
 * `names_only` apply strategy — only `circuit_ref` + `circuit_designation`
 * from the analysis touch the job. Other hardware / test fields on
 * existing circuits are preserved. Useful for inspectors who want to
 * use a photo just to auto-fill circuit names, then fill OCPD / RCD /
 * test data manually or via voice.
 *
 * Matching here is by `circuit_ref` only (same as full_capture) —
 * fuzzy designation matching is reserved for Hardware Update. If the
 * analysis returns a ref that doesn't exist, we synthesise a new
 * minimal row.
 */
function buildCircuitsPatchNamesOnly(
  job: JobDetail,
  analysis: CCUAnalysis,
  boardId: string
): CircuitRow[] | null {
  const incoming = circuitsForSchedule(analysis.circuits ?? []);
  if (incoming.length === 0) return null;

  const allCircuits = (job.circuits ?? []) as CircuitRow[];
  const boardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) === boardId || c.board_id == null
  );
  const otherBoardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) !== boardId && c.board_id != null
  );

  const existingByRef = new Map<string, CircuitRow>();
  for (const row of boardCircuits) {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (ref) existingByRef.set(ref, row);
  }

  const consumedRefs = new Set<string>();
  const next: CircuitRow[] = [];

  for (const analysed of incoming) {
    const ref = String(analysed.circuit_number);
    consumedRefs.add(ref);
    const existing = existingByRef.get(ref);
    const label = analysed.label?.trim() || 'Spare';

    if (existing) {
      // Preserve EVERYTHING the inspector has entered — only fill the
      // designation when it's currently empty (iOS parity: names-only
      // should never stomp a label the inspector already wrote).
      const row: CircuitRow = { ...existing, board_id: boardId, circuit_ref: ref };
      if (!hasValue(row.circuit_designation)) row.circuit_designation = label;
      next.push(row);
    } else {
      next.push({
        id: globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${ref}`,
        board_id: boardId,
        circuit_ref: ref,
        circuit_designation: label,
      });
    }
  }

  // Preserve any existing circuit the analysis didn't mention — names
  // mode is additive, never destructive.
  for (const row of boardCircuits) {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (!ref || consumedRefs.has(ref)) continue;
    next.push(row);
  }

  return [...otherBoardCircuits, ...next];
}

// ---------------------------------------------------------------------------
// Mode 2 — Full capture (original behaviour)
// ---------------------------------------------------------------------------

/** Build the circuit-list patch. Matches by `circuit_ref` only —
 *  sufficient when CCU re-analysis is scoped to a single board. */
function buildCircuitsPatchFullCapture(
  job: JobDetail,
  analysis: CCUAnalysis,
  boardId: string
): CircuitRow[] | null {
  const incoming = circuitsForSchedule(analysis.circuits ?? []);
  if (incoming.length === 0) return null;

  const allCircuits = (job.circuits ?? []) as CircuitRow[];
  const boardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) === boardId || c.board_id == null
  );
  const otherBoardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) !== boardId && c.board_id != null
  );

  const existingByRef = new Map<string, CircuitRow>();
  for (const row of boardCircuits) {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (ref) existingByRef.set(ref, row);
  }

  const consumedRefs = new Set<string>();
  const next: CircuitRow[] = [];

  for (const analysed of incoming) {
    const ref = String(analysed.circuit_number);
    const existing = existingByRef.get(ref);
    consumedRefs.add(ref);

    if (existing) {
      next.push(mergeMatchedCircuit(existing, analysed, boardId));
    } else {
      next.push(buildNewCircuit(analysed, boardId));
    }
  }

  // Preserve any existing circuit that the analyser didn't mention
  // AND has test readings — iOS data-loss guard.
  for (const row of boardCircuits) {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (!ref || consumedRefs.has(ref)) continue;
    const hasReadings = READING_KEYS.some((k) => hasValue(row[k]));
    if (hasReadings) next.push(row);
  }

  return [...otherBoardCircuits, ...next];
}

// ---------------------------------------------------------------------------
// Mode 3 — Hardware update (fuzzy-matched, reviewed)
// ---------------------------------------------------------------------------

/**
 * Apply hardware fields from user-approved matches. The caller has
 * already run `matchCircuits()` + the review UI; each match either
 * pairs an analysed circuit with an existing one (preserve readings,
 * overwrite hardware) or flags it as new (create from scratch, no
 * readings). Unmatched existing circuits that carry readings are
 * appended at the end so data isn't lost.
 *
 * Board-level info is overwritten (`overwrite: true`) because this
 * mode represents a physically-different board.
 */
function buildCircuitsPatchHardwareUpdate(
  job: JobDetail,
  matches: CircuitMatch<CCUAnalysisCircuit, CircuitRow>[],
  boardId: string
): CircuitRow[] | null {
  if (matches.length === 0) return null;

  const allCircuits = (job.circuits ?? []) as CircuitRow[];
  const boardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) === boardId || c.board_id == null
  );
  const otherBoardCircuits = allCircuits.filter(
    (c) => (c.board_id as string | undefined) !== boardId && c.board_id != null
  );

  const matchedOldIds = new Set<string>(
    matches.map((m) => m.matchedOldCircuit?.id).filter((id): id is string => !!id)
  );

  const next: CircuitRow[] = [];
  for (const m of matches) {
    if (m.matchedOldCircuit) {
      next.push(mergeMatchedCircuit(m.matchedOldCircuit, m.newCircuit, boardId));
    } else {
      next.push(buildNewCircuit(m.newCircuit, boardId));
    }
  }

  // Append unmatched existing circuits that carry test readings.
  for (const row of boardCircuits) {
    if (matchedOldIds.has(row.id)) continue;
    const hasReadings = READING_KEYS.some((k) => hasValue(row[k]));
    if (hasReadings) next.push(row);
  }

  return [...otherBoardCircuits, ...next];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mergeMatchedCircuit(
  existing: CircuitRow,
  analysed: CCUAnalysisCircuit,
  boardId: string
): CircuitRow {
  const next: CircuitRow = { ...existing };
  next.board_id = boardId;
  next.circuit_ref = String(analysed.circuit_number);

  // Designation — only fill if empty.
  const label = analysed.label?.trim();
  if (!hasValue(next.circuit_designation) && label && label !== 'null') {
    next.circuit_designation = label;
  }

  // OCPD — merge-if-non-empty.
  next.ocpd_bs_en = mergeField(next.ocpd_bs_en as string | undefined, analysed.ocpd_bs_en);
  next.ocpd_type = mergeField(
    next.ocpd_type as string | undefined,
    analysed.ocpd_type ?? undefined
  );
  next.ocpd_rating_a = mergeField(next.ocpd_rating_a as string | undefined, analysed.ocpd_rating_a);
  next.ocpd_breaking_capacity_ka = mergeField(
    next.ocpd_breaking_capacity_ka as string | undefined,
    analysed.ocpd_breaking_capacity_ka
  );

  // RCD — normalise type; only overwrite if we got a valid value.
  next.rcd_bs_en = mergeField(next.rcd_bs_en as string | undefined, analysed.rcd_bs_en);
  const rcdType = normaliseRcdType(analysed.rcd_type);
  if (rcdType) next.rcd_type = rcdType;

  next.rcd_operating_current_ma = mergeField(
    next.rcd_operating_current_ma as string | undefined,
    analysed.rcd_rating_ma
  );

  return next;
}

function buildNewCircuit(analysed: CCUAnalysisCircuit, boardId: string): CircuitRow {
  const id = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${analysed.circuit_number}`;
  const designation =
    analysed.label && analysed.label.trim() && analysed.label.trim() !== 'null'
      ? analysed.label.trim()
      : 'Spare';

  const row: CircuitRow = {
    id,
    board_id: boardId,
    circuit_ref: String(analysed.circuit_number),
    circuit_designation: designation,
  };

  if (hasValue(analysed.ocpd_bs_en)) row.ocpd_bs_en = analysed.ocpd_bs_en;
  if (hasValue(analysed.ocpd_type)) row.ocpd_type = analysed.ocpd_type;
  if (hasValue(analysed.ocpd_rating_a)) row.ocpd_rating_a = analysed.ocpd_rating_a;
  if (hasValue(analysed.ocpd_breaking_capacity_ka)) {
    row.ocpd_breaking_capacity_ka = analysed.ocpd_breaking_capacity_ka;
  }
  if (hasValue(analysed.rcd_bs_en)) row.rcd_bs_en = analysed.rcd_bs_en;

  const rcdType = normaliseRcdType(analysed.rcd_type);
  if (rcdType) {
    row.rcd_type = rcdType;
  } else if (analysed.is_rcbo) {
    // iOS parity: mark as RCBO so the circuit UI shows the RCBO
    // badge even without a valid sensitivity category.
    row.rcd_type = 'RCBO';
  }
  if (hasValue(analysed.rcd_rating_ma)) row.rcd_operating_current_ma = analysed.rcd_rating_ma;

  return row;
}

/** Generate "what's the RCD type for circuit X?" prompts for any
 *  RCD-protected circuit whose type we couldn't resolve. iOS does
 *  this in FuseboardAnalysisApplier.swift. */
function buildMissingRcdQuestions(analysis: CCUAnalysis): string[] {
  const missing = circuitsForSchedule(analysis.circuits ?? [])
    .filter((c) => c.rcd_protected === true && !normaliseRcdType(c.rcd_type))
    .map((c) => String(c.circuit_number));
  if (missing.length === 0) return [];
  const refs = missing.join(', ');
  const plural = missing.length > 1;
  return [`What is the RCD type for circuit${plural ? 's' : ''} ${refs}? Is it type A or type AC?`];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Apply a CCU analysis response to a job, producing a patch.
 *
 * Returns the patch + any questions for the inspector. The caller is
 * expected to `updateJob(result.patch)` and surface `result.questions`
 * as dismissible chips.
 */
export function applyCcuAnalysisToJob(
  job: JobDetail,
  analysis: CCUAnalysis,
  options: CcuApplyOptions = {}
): CcuApplyResult {
  const mode: CcuApplyMode = options.mode ?? 'full_capture';
  const patch: Partial<JobDetail> = {};

  // Hardware Update mode overwrites board-level fields (physically
  // different board). The other two modes are non-destructive.
  const overwriteBoard = mode === 'hardware_update';

  // `names_only` mode intentionally skips board/supply patches — the
  // inspector is using the photo only to read circuit labels.
  if (mode !== 'names_only') {
    const { boards, boardId } = buildBoardPatch(
      job,
      analysis,
      options.targetBoardId ?? null,
      overwriteBoard
    );
    patch.boards = boards;

    const supply = buildSupplyPatch(job, analysis);
    if (supply) patch.supply_characteristics = supply;

    if (mode === 'hardware_update') {
      if (!options.userApprovedMatches) {
        throw new Error(
          'applyCcuAnalysisToJob: mode="hardware_update" requires userApprovedMatches'
        );
      }
      const circuits = buildCircuitsPatchHardwareUpdate(job, options.userApprovedMatches, boardId);
      if (circuits) patch.circuits = circuits;
    } else {
      const circuits = buildCircuitsPatchFullCapture(job, analysis, boardId);
      if (circuits) patch.circuits = circuits;
    }

    // Persist the raw analysis keyed per-board so multi-board jobs don't
    // cross-bleed. The legacy implementation stored a single flat
    // `job.ccu_analysis`, which meant re-running CCU analysis on DB2
    // silently overwrote the DB1 photo's extracted metadata.
    const existingAnalyses = job.ccu_analysis_by_board ?? {};
    patch.ccu_analysis_by_board = {
      ...existingAnalyses,
      [boardId]: analysis as unknown as Record<string, unknown>,
    };
    patch.ccu_analysis = analysis as unknown as Record<string, unknown>;
  } else {
    // Names-only still needs the board id to scope the circuits
    // correctly, and we must persist the synthesized board when the
    // job had none. Skipping the boards patch in that case would leave
    // the new circuits with a `board_id` pointing at a board that
    // never got persisted, breaking every later board-scoped flow.
    const { boards, boardId } = buildBoardPatch(
      job,
      analysis,
      options.targetBoardId ?? null,
      false
    );
    const hadBoardsBefore = Boolean((job.boards ?? []).length);
    if (!hadBoardsBefore) {
      patch.boards = boards;
    }
    const circuits = buildCircuitsPatchNamesOnly(job, analysis, boardId);
    if (circuits) patch.circuits = circuits;
  }

  const questions = [
    ...(analysis.questionsForInspector ?? []),
    ...buildMissingRcdQuestions(analysis),
  ];

  return { patch, questions };
}
