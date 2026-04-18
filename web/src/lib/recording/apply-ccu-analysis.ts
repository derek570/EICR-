/**
 * Fold a /api/analyze-ccu response onto a JobDetail patch.
 *
 * Mirrors the iOS `FuseboardAnalysisApplier.hardwareUpdate` flow
 * (Sources/Processing/FuseboardAnalysisApplier.swift). The key
 * properties that flow must preserve, in order of importance:
 *
 *   1. **Never clobber user-typed values.** The 3-tier priority guard
 *      (pre-existing manual > CCU > recording-time Sonnet) is the
 *      whole reason this endpoint is safe to re-run — `mergeField`
 *      below is the non-empty-only variant.
 *   2. **Preserve test readings on matched circuits.** If circuit #4
 *      on the new board fuzzy-matches circuit #4 on the old board,
 *      the new OCPD/RCD hardware overwrites but `measured_zs_ohm`,
 *      `r1_r2_ohm`, `ir_live_earth_mohm`, `rcd_time_ms`, etc. stay.
 *   3. **Never lose a circuit with readings.** If the new analysis
 *      omits a circuit that used to exist AND it has test data, we
 *      append it after the new layout rather than dropping it.
 *
 * We don't port iOS's `CircuitMatcher` fuzzy-designation matcher yet
 * — it relies on a Levenshtein pass across designations that the web
 * rebuild hasn't needed. Web v1 matches by `circuit_ref` only, which
 * is correct when CCU re-analysis is run on the same physical board
 * (the usual case: "I missed a label, re-shoot"). Cross-board
 * moves can be done manually; the fuzzy matcher can land later if
 * inspectors report false merges.
 */

import type { CCUAnalysis, CCUAnalysisCircuit, CircuitRow, JobDetail } from '../types';
import { hasValue } from './apply-extraction';

/** Valid RCD sensitivity types — iOS keeps this list in
 *  FuseboardAnalysisApplier.swift (two copies). Matches exactly so
 *  normalisation behaves identically across platforms. */
const VALID_RCD_TYPES = new Set(['AC', 'A', 'B', 'F', 'S', 'A-S', 'B-S', 'B+']);

/** Test-reading fields that, if populated on a matched-but-now-missing
 *  circuit, cause the row to be preserved at the end of the list
 *  instead of being dropped. Matches the iOS checklist at line 177. */
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

export interface CcuApplyResult {
  /** `updateJob(patch)` — only sections that changed are present. */
  patch: Partial<JobDetail>;
  /**
   * Questions for the inspector pulled from the analysis response,
   * augmented with auto-generated questions for RCD-protected
   * circuits whose type couldn't be determined (iOS parity: see
   * FuseboardAnalysisApplier.swift lines 90-98).
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

/** Build the board patch — merges into an existing board row
 *  (matched by `boardId`) or creates one if the job has no boards
 *  yet. Never clobbers non-empty values. */
function buildBoardPatch(
  job: JobDetail,
  analysis: CCUAnalysis,
  targetBoardId: string | null
): { board: Record<string, unknown>; boardId: string } {
  type BoardRecord = Record<string, unknown> & { id: string };
  const boardState = (job.board as { boards?: BoardRecord[] } | undefined) ?? {};
  const boards: BoardRecord[] = boardState.boards ? [...boardState.boards] : [];

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

  // Board identity — web uses `manufacturer` + `name` (iOS same).
  const manufacturer = mergeField(
    next.manufacturer as string | undefined,
    analysis.board_manufacturer
  );
  if (manufacturer !== undefined) next.manufacturer = manufacturer;

  // `analysis.board_model` is the manufacturer's model string (e.g.
  // "Wylex NH10"). Store it in its own `board_model` field so downstream
  // consumers that need the model specifically (PDF, compliance report)
  // don't have to re-derive it from the `name`. Keep `name` in sync with
  // `board_model` when the user hasn't supplied a separate display name
  // — matches the iOS `BoardInfo` mapping and avoids an empty UI label.
  const boardModel = mergeField(next.board_model as string | undefined, analysis.board_model);
  if (boardModel !== undefined) next.board_model = boardModel;
  const boardName = mergeField(next.name as string | undefined, analysis.board_model);
  if (boardName !== undefined) next.name = boardName;

  // Main switch.
  const switchCurrent = analysis.main_switch_current ?? analysis.main_switch_rating;
  const mainSwitchBsEn = mergeField(
    next.main_switch_bs_en as string | undefined,
    analysis.main_switch_bs_en
  );
  if (mainSwitchBsEn !== undefined) next.main_switch_bs_en = mainSwitchBsEn;

  const voltageRating = mergeField(
    next.voltage_rating as string | undefined,
    analysis.main_switch_voltage
  );
  if (voltageRating !== undefined) next.voltage_rating = voltageRating;

  const ratedCurrent = mergeField(next.rated_current as string | undefined, switchCurrent);
  if (ratedCurrent !== undefined) next.rated_current = ratedCurrent;

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
    board: { ...boardState, boards },
    boardId: next.id,
  };
}

/** Build the supply patch — merges the `spd_*` supply-section
 *  fallbacks (which the backend auto-derives from the main switch in
 *  routes/extraction.js:961-974) into `job.supply`. */
function buildSupplyPatch(job: JobDetail, analysis: CCUAnalysis): Record<string, unknown> | null {
  const existing = (job.supply as Record<string, unknown> | undefined) ?? {};
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

/** Build the circuit-list patch. Matches by `circuit_ref` only —
 *  sufficient when CCU re-analysis is scoped to a single board. */
function buildCircuitsPatch(
  job: JobDetail,
  analysis: CCUAnalysis,
  boardId: string
): CircuitRow[] | null {
  const incoming = analysis.circuits ?? [];
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
  // AND has test readings — iOS data-loss guard at line 176-186.
  for (const row of boardCircuits) {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (!ref || consumedRefs.has(ref)) continue;
    const hasReadings = READING_KEYS.some((k) => hasValue(row[k]));
    if (hasReadings) next.push(row);
  }

  return [...otherBoardCircuits, ...next];
}

function mergeMatchedCircuit(
  existing: CircuitRow,
  analysed: CCUAnalysisCircuit,
  boardId: string
): CircuitRow {
  const next: CircuitRow = { ...existing };
  next.board_id = boardId;
  next.circuit_ref = String(analysed.circuit_number);

  // Designation — only fill if empty (iOS line 128).
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

  // iOS uses rcdOperatingCurrentMa for this; the web circuits UI also
  // has a rcd_rating_a field that's independent. Keep both keys in
  // sync so whichever UI label the inspector reads first is correct.
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
    // iOS line 166: mark as RCBO so the circuit UI shows the RCBO
    // badge even without a valid sensitivity category.
    row.rcd_type = 'RCBO';
  }
  if (hasValue(analysed.rcd_rating_ma)) row.rcd_operating_current_ma = analysed.rcd_rating_ma;

  return row;
}

/** Generate "what's the RCD type for circuit X?" prompts for any
 *  RCD-protected circuit whose type we couldn't resolve. iOS does
 *  this in FuseboardAnalysisApplier.swift lines 90-98 / 238-245. */
function buildMissingRcdQuestions(analysis: CCUAnalysis): string[] {
  const missing = (analysis.circuits ?? [])
    .filter((c) => c.rcd_protected === true && !normaliseRcdType(c.rcd_type))
    .map((c) => String(c.circuit_number));
  if (missing.length === 0) return [];
  const refs = missing.join(', ');
  const plural = missing.length > 1;
  return [`What is the RCD type for circuit${plural ? 's' : ''} ${refs}? Is it type A or type AC?`];
}

/** Public entry point. Returns the patch + questions. The caller is
 *  expected to `updateJob(result.patch)` and surface `result.questions`
 *  as dismissible chips in the UI. */
export function applyCcuAnalysisToJob(
  job: JobDetail,
  analysis: CCUAnalysis,
  options: { targetBoardId?: string | null } = {}
): CcuApplyResult {
  const patch: Partial<JobDetail> = {};

  const { board, boardId } = buildBoardPatch(job, analysis, options.targetBoardId ?? null);
  patch.board = board;

  const supply = buildSupplyPatch(job, analysis);
  if (supply) patch.supply = supply;

  const circuits = buildCircuitsPatch(job, analysis, boardId);
  if (circuits) patch.circuits = circuits;

  // Persist the raw analysis keyed per-board so multi-board jobs don't
  // cross-bleed. The legacy implementation stored a single flat
  // `job.ccu_analysis`, which meant re-running CCU analysis on DB2
  // silently overwrote the DB1 photo's extracted metadata. Keying by
  // `boardId` keeps each board's raw response scoped while retaining
  // the audit trail for review/retry flows.
  const existingAnalyses = job.ccu_analysis_by_board ?? {};
  patch.ccu_analysis_by_board = {
    ...existingAnalyses,
    [boardId]: analysis as unknown as Record<string, unknown>,
  };
  // Mirror the most recent analysis onto the legacy flat field for any
  // downstream consumer that still reads `ccu_analysis` directly
  // (e.g. the debug panel). Safe because the per-board map above is
  // authoritative — the flat copy is just a cache.
  patch.ccu_analysis = analysis as unknown as Record<string, unknown>;

  const questions = [
    ...(analysis.questionsForInspector ?? []),
    ...buildMissingRcdQuestions(analysis),
  ];

  return { patch, questions };
}
