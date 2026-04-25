/**
 * Fold a /api/analyze-document response onto a JobDetail patch.
 *
 * Used by the "Extract" button on the Circuits tab (Phase 5b). The
 * backend runs GPT Vision over a photo of a prior EICR/EIC, handwritten
 * test sheet, or typed record and returns the full formData envelope.
 * This helper merges each section into the live job, with the 3-tier
 * priority guard applied *everywhere*:
 *
 *   Pre-existing user/CCU value  >  Document extraction  >  (empty)
 *
 * This is stricter than iOS `CertificateMerger.merge()` (Sources/
 * Processing/CertificateMerger.swift:7-167), which overwrites
 * non-empty extracted values on installation/supply/board. The Phase 5
 * handoff memo explicitly requires the fill-empty-only policy across
 * all sections so a user mid-edit never has their typing clobbered.
 *
 * Section routing mirrors the backend response envelope exactly —
 * backend keys are already 1:1 with web JobDetail section keys so no
 * translation is needed, only whitelisting (so unknown prompt-evolution
 * additions don't silently land in the wrong section).
 *
 * Scope exclusions (noted in the plan, deferred):
 *   - PDF support (backend hard-codes image/jpeg mime)
 *   - iOS Levenshtein fuzzy designation matcher (ref-match only)
 *   - Cable defaults + recalculateMaxZs helpers
 */

import type {
  CircuitRow,
  DocumentExtractionCircuit,
  DocumentExtractionFormData,
  DocumentExtractionObservation,
  DocumentExtractionResponse,
  JobDetail,
  ObservationRow,
} from '../types';
import { hasValue, parseObservationCode } from './apply-extraction';

/** Whitelist of installation keys we let the extractor populate.
 *  Must stay aligned with `InstallationShape` in
 *  `web/src/app/job/[id]/installation/page.tsx:42-76` and the backend
 *  prompt schema at `src/routes/extraction.js:1351-1367`. */
const INSTALLATION_STRING_KEYS = [
  'client_name',
  'address',
  'postcode',
  'town',
  'county',
  'premises_description',
  'reason_for_report',
  'occupier_name',
  'date_of_previous_inspection',
  'previous_certificate_number',
  'estimated_age_of_installation',
  'general_condition_of_installation',
] as const;

/** Non-string installation fields handled separately because they need
 *  type-specific coercion (numbers stay numbers; yes/no -> boolean). */
const INSTALLATION_YESNO_KEYS = [
  'installation_records_available',
  'evidence_of_additions_alterations',
] as const;

/** Whitelist of supply keys. From backend prompt
 *  `src/routes/extraction.js:1368-1374`. */
const SUPPLY_KEYS = [
  'earthing_arrangement',
  'nominal_voltage_u',
  'nominal_frequency',
  'prospective_fault_current',
  'earth_loop_impedance_ze',
] as const;

/** Board row keys the document extractor populates. Subset of the
 *  iOS board schema; the web board UI uses these exact keys. */
const BOARD_KEYS = [
  'manufacturer',
  'name',
  'rated_current',
  'main_switch_bs_en',
  'spd_status',
] as const;

export interface DocumentApplyResult {
  /** Feed to `updateJob(patch)` — only sections that changed are present. */
  patch: Partial<JobDetail>;
  /** Drives the post-merge hint text on the Circuits page. */
  summary: { circuits: number; observations: number };
}

/**
 * Coerce the backend's "Yes"/"No" string enums (see prompt schema at
 * `src/routes/extraction.js:1365-1366`) to the boolean values the web
 * installation form stores. Mirrors iOS CertificateMerger.swift:37-42.
 */
function yesNoToBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === 'yes') return true;
  if (cleaned === 'no') return false;
  return undefined;
}

/** Fill-empty-only merge across the installation section. Returns the
 *  full updated section or `null` if nothing changed (so the caller can
 *  skip an `updateJob` cycle and avoid re-render churn). */
function mergeInstallation(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...existing };
  let changed = false;

  for (const key of INSTALLATION_STRING_KEYS) {
    if (hasValue(existing[key])) continue;
    if (!hasValue(incoming[key])) continue;
    next[key] = incoming[key];
    changed = true;
  }

  // next_inspection_years is a number in the web schema; the backend
  // prompt permits either a number or omission.
  if (!hasValue(existing.next_inspection_years) && hasValue(incoming.next_inspection_years)) {
    const parsed =
      typeof incoming.next_inspection_years === 'number'
        ? incoming.next_inspection_years
        : Number(incoming.next_inspection_years);
    if (Number.isFinite(parsed)) {
      next.next_inspection_years = parsed;
      changed = true;
    }
  }

  for (const key of INSTALLATION_YESNO_KEYS) {
    if (existing[key] !== undefined) continue;
    const coerced = yesNoToBool(incoming[key]);
    if (coerced === undefined) continue;
    next[key] = coerced;
    changed = true;
  }

  return changed ? next : null;
}

/** Fill-empty-only merge across the supply section. */
function mergeSupply(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...existing };
  let changed = false;

  for (const key of SUPPLY_KEYS) {
    if (hasValue(existing[key])) continue;
    if (!hasValue(incoming[key])) continue;
    next[key] = incoming[key];
    changed = true;
  }

  return changed ? next : null;
}

/** Patch the targeted board (or board 0), synthesising a main-DB row
 *  if the job has no boards yet. Mirrors the synth + merge pattern in
 *  `apply-ccu-analysis.ts:buildBoardPatch`. Fill-empty-only. */
function mergeBoard(
  job: JobDetail,
  incoming: Record<string, unknown>,
  targetBoardId: string | null
): { boards: Record<string, unknown>[]; boardId: string } | null {
  type BoardRecord = Record<string, unknown> & { id: string };
  const existingBoards = (job.boards ?? []) as BoardRecord[];
  const boards: BoardRecord[] = [...existingBoards];

  // Only bother synthesising if the extractor actually populated
  // something — otherwise returning a patch would just churn state.
  const hasAnyIncoming = BOARD_KEYS.some((k) => hasValue(incoming[k]));

  let idx = targetBoardId ? boards.findIndex((b) => b.id === targetBoardId) : 0;
  if (idx < 0 || boards.length === 0) {
    if (!hasAnyIncoming) return null;
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
  let changed = false;

  for (const key of BOARD_KEYS) {
    if (hasValue(next[key])) continue;
    if (!hasValue(incoming[key])) continue;
    next[key] = incoming[key];
    changed = true;
  }

  if (!changed && boards.length === existingBoards.length && boards[idx] === existingBoards[idx]) {
    return null;
  }

  boards[idx] = next;
  return {
    boards,
    boardId: next.id,
  };
}

/** Match each incoming circuit to an existing row by case-insensitive
 *  `circuit_ref`. Matched rows get their empty fields filled (never
 *  overwritten). Unmatched incoming rows are appended as new circuits
 *  tagged with `board_id`. Returns the full updated circuits array or
 *  `null` if nothing changed. Count returned is the number of rows
 *  affected (matched filled + new) so the UI can show a summary. */
function mergeCircuits(
  job: JobDetail,
  incoming: DocumentExtractionCircuit[],
  boardId: string | null
): { circuits: CircuitRow[]; count: number } | null {
  if (incoming.length === 0) return null;

  const existing = ((job.circuits as CircuitRow[] | undefined) ?? []).slice();
  const byRef = new Map<string, number>();
  existing.forEach((row, idx) => {
    const ref = (row.circuit_ref ?? row.number) as string | undefined;
    if (typeof ref === 'string' && ref) byRef.set(ref.toLowerCase(), idx);
  });

  let affected = 0;

  for (const analysed of incoming) {
    const refRaw = analysed.circuit_ref;
    if (!refRaw) continue;
    const key = String(refRaw).toLowerCase();
    const idx = byRef.get(key);

    if (idx != null) {
      // Matched — fill empty fields only.
      const row = { ...existing[idx] };
      let rowChanged = false;
      for (const [field, value] of Object.entries(analysed)) {
        if (field === 'circuit_ref') continue; // keep existing casing
        if (hasValue(row[field])) continue;
        if (!hasValue(value)) continue;
        row[field] = value;
        rowChanged = true;
      }
      if (rowChanged) {
        existing[idx] = row;
        affected += 1;
      }
    } else {
      // Unmatched — build a new row with whatever non-empty fields the
      // extractor populated.
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const row: CircuitRow = {
        id,
        circuit_ref: String(refRaw),
        circuit_designation: '',
      };
      if (boardId) row.board_id = boardId;
      for (const [field, value] of Object.entries(analysed)) {
        if (field === 'id') continue;
        if (!hasValue(value)) continue;
        row[field] = value;
      }
      existing.push(row);
      byRef.set(key, existing.length - 1);
      affected += 1;
    }
  }

  return affected > 0 ? { circuits: existing, count: affected } : null;
}

/**
 * Append new observations using the iOS dedupe rules
 * (`CertificateMerger.swift:100-122`):
 *   - Duplicate if both `schedule_item` AND `code` match an existing row
 *   - OR if both `location` AND the first-50-char lowercased text prefix match
 *
 * Non-duplicates get a fresh uuid + a parsed code enum.
 */
function mergeObservations(
  job: JobDetail,
  incoming: DocumentExtractionObservation[]
): { observations: ObservationRow[]; count: number } | null {
  if (incoming.length === 0) return null;

  type Existing = {
    row: ObservationRow;
    schedule_item?: string;
    code?: string;
    location?: string;
    prefix?: string;
  };

  const existingRows = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const keys: Existing[] = existingRows.map((row) => {
    const scheduleItemRaw = (row as unknown as Record<string, unknown>).schedule_item;
    return {
      row,
      schedule_item: typeof scheduleItemRaw === 'string' ? scheduleItemRaw.trim() : undefined,
      code: row.code,
      location: row.location?.trim().toLowerCase(),
      prefix: row.description?.trim().toLowerCase().slice(0, 50),
    };
  });

  let added = 0;

  for (const obs of incoming) {
    const text = obs.observation_text?.trim();
    if (!text) continue;

    const scheduleItem = obs.schedule_item?.trim();
    const code = parseObservationCode(obs.code);
    const location = obs.item_location?.trim();
    const locLower = location?.toLowerCase();
    const prefix = text.toLowerCase().slice(0, 50);

    const isDuplicate = keys.some((k) => {
      if (scheduleItem && code && k.schedule_item === scheduleItem && k.code === code) return true;
      if (locLower && prefix && k.location === locLower && k.prefix === prefix) return true;
      return false;
    });
    if (isDuplicate) continue;

    const id =
      globalThis.crypto?.randomUUID?.() ??
      `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRow: ObservationRow = {
      id,
      code,
      description: text,
      location,
    };
    // Preserve schedule_item + regulation as passthrough metadata so the
    // observations tab can show them without another backend round-trip.
    const newRowBag = newRow as unknown as Record<string, unknown>;
    if (scheduleItem) newRowBag.schedule_item = scheduleItem;
    if (obs.regulation) newRowBag.regulation = obs.regulation;

    existingRows.push(newRow);
    keys.push({
      row: newRow,
      schedule_item: scheduleItem,
      code,
      location: locLower,
      prefix,
    });
    added += 1;
  }

  return added > 0 ? { observations: existingRows, count: added } : null;
}

/**
 * Public entry point. Returns the patch + a summary count of circuits
 * and observations merged so the UI can render "Document read — X
 * circuits, Y observations merged" in the action hint.
 *
 * When the response envelope is malformed (missing `formData` or
 * `success: false`), we return an empty patch rather than throwing —
 * the caller already surfaces transport-layer errors via ApiError.
 */
export function applyDocumentExtractionToJob(
  job: JobDetail,
  response: DocumentExtractionResponse,
  options: { targetBoardId?: string | null } = {}
): DocumentApplyResult {
  const patch: Partial<JobDetail> = {};
  const summary = { circuits: 0, observations: 0 };

  const formData: DocumentExtractionFormData = response?.formData ?? {};

  const installationIncoming = formData.installation_details ?? {};
  const installationExisting =
    (job.installation_details as Record<string, unknown> | undefined) ?? {};
  const installationPatch = mergeInstallation(installationExisting, installationIncoming);
  if (installationPatch) patch.installation_details = installationPatch;

  const supplyIncoming = formData.supply_characteristics ?? {};
  const supplyExisting = (job.supply_characteristics as Record<string, unknown> | undefined) ?? {};
  const supplyPatch = mergeSupply(supplyExisting, supplyIncoming);
  if (supplyPatch) patch.supply_characteristics = supplyPatch;

  const boardIncoming = formData.board_info ?? {};
  const boardResult = mergeBoard(job, boardIncoming, options.targetBoardId ?? null);
  if (boardResult) patch.boards = boardResult.boards;

  const boardId =
    boardResult?.boardId ??
    options.targetBoardId ??
    (() => {
      // Fall back to the first existing board if we didn't synth one —
      // keeps new circuits attached to a real board when the extractor
      // didn't populate board fields.
      const boards = (job.boards as { id: string }[] | undefined) ?? [];
      return boards[0]?.id ?? null;
    })();

  const circuitsResult = mergeCircuits(job, formData.circuits ?? [], boardId);
  if (circuitsResult) {
    patch.circuits = circuitsResult.circuits;
    summary.circuits = circuitsResult.count;
  }

  const observationsResult = mergeObservations(job, formData.observations ?? []);
  if (observationsResult) {
    patch.observations = observationsResult.observations;
    summary.observations = observationsResult.count;
  }

  return { patch, summary };
}
