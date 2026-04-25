/**
 * Map a Sonnet extraction result onto a JobDetail patch.
 *
 * Responsibilities:
 *   1. Route each reading to the correct section of the job (supply,
 *      board, installation, extent, design, or the matching circuit
 *      row) based on field name.
 *   2. Apply 3-tier priority: pre-existing manual/CCU values win over
 *      fresh Sonnet readings. Sonnet's own de-dup lives server-side; we
 *      re-check here in case the server-side state snapshot lagged
 *      behind a user edit.
 *   3. Apply `circuit_updates` — create or rename a CircuitRow so
 *      subsequent readings have somewhere to land.
 *   4. Append `observations` not already present.
 *
 * Returns a partial `JobDetail` patch, or null if nothing changed so
 * the caller can skip an `updateJob` cycle (avoids needless re-renders
 * when Sonnet returns an empty result).
 */

import type { CircuitRow, JobDetail, ObservationRow } from '../types';
import type {
  CircuitUpdate,
  ExtractedReading,
  ExtractionResult,
  FieldClear,
  Observation,
} from './sonnet-session';
import { FieldSourceMap, circuit0Key, perCircuitKey } from './field-source';
import { applySonnetValue, type ApplyOutcome } from './apply-rules';

type Section = 'supply' | 'board' | 'installation' | 'extent' | 'design';

// ─────────────────────────────────────────────────────────────────────────
// Field routing for circuit: 0 (supply / installation / etc.)
//
// Keep this in sync with the `KNOWN_FIELDS` + field_reference.md tables
// on the server. Anything unmapped falls through to `supply` as a
// best-effort default — inspectors can manually move it if it lands in
// the wrong tab.
// ─────────────────────────────────────────────────────────────────────────
const CIRCUIT_0_SECTION: Record<string, Section> = {
  // Supply
  ze: 'supply',
  pfc: 'supply',
  earthing_arrangement: 'supply',
  main_earth_conductor_csa: 'supply',
  main_bonding_conductor_csa: 'supply',
  bonding_water: 'supply',
  bonding_gas: 'supply',
  bonding_oil: 'supply',
  bonding_structural_steel: 'supply',
  bonding_lightning: 'supply',
  bonding_other: 'supply',
  earth_electrode_type: 'supply',
  earth_electrode_resistance: 'supply',
  earth_electrode_location: 'supply',
  earthing_conductor_material: 'supply',
  earthing_conductor_continuity: 'supply',
  main_bonding_material: 'supply',
  main_bonding_continuity: 'supply',
  supply_voltage: 'supply',
  nominal_voltage: 'supply',
  nominal_voltage_u: 'supply',
  nominal_voltage_uo: 'supply',
  supply_frequency: 'supply',
  nominal_frequency: 'supply',
  supply_polarity_confirmed: 'supply',
  live_conductors: 'supply',
  number_of_supplies: 'supply',
  zs_at_db: 'supply',
  // Board / Main Switch / SPD
  main_switch_bs_en: 'board',
  main_switch_current: 'board',
  main_switch_fuse_setting: 'board',
  main_switch_poles: 'board',
  main_switch_voltage: 'board',
  main_switch_location: 'board',
  main_switch_conductor_material: 'board',
  main_switch_conductor_csa: 'board',
  rcd_operating_current: 'board',
  rcd_time_delay: 'board',
  rcd_operating_time: 'board',
  spd_bs_en: 'board',
  spd_type_supply: 'board',
  spd_short_circuit: 'board',
  spd_rated_current: 'board',
  manufacturer: 'board',
  // Installation
  address: 'installation',
  postcode: 'installation',
  town: 'installation',
  county: 'installation',
  client_name: 'installation',
  client_address: 'installation',
  client_postcode: 'installation',
  client_town: 'installation',
  client_county: 'installation',
  client_phone: 'installation',
  client_email: 'installation',
  reason_for_report: 'installation',
  occupier_name: 'installation',
  date_of_inspection: 'installation',
  date_of_previous_inspection: 'installation',
  previous_certificate_number: 'installation',
  estimated_age_of_installation: 'installation',
  general_condition: 'installation',
  next_inspection_years: 'installation',
  premises_description: 'installation',
  // Extent (EIC)
  extent_of_installation: 'extent',
  installation_type: 'extent',
  // Design (EIC)
  departures_from_bs7671: 'design',
  departure_details: 'design',
  design_comments: 'design',
};

function routeSupplyField(field: string): Section {
  return CIRCUIT_0_SECTION[field] ?? 'supply';
}

// Re-export from `apply-utils` so existing callers keep working.
export { hasValue } from './apply-utils';
import { hasValue } from './apply-utils';

/** Apply all readings belonging to circuit 0. Returns a map of
 *  section → merged record that can be folded into the final patch.
 *  Per-field writes go through `applySonnetValue` so the iOS 3-tier
 *  priority chain decides whether to overwrite pre-existing /
 *  regex-source values. */
function applyCircuit0Readings(
  job: JobDetail,
  readings: ExtractedReading[],
  sources: FieldSourceMap,
  outcomes: Map<string, ApplyOutcome>
): Partial<Record<Section, Record<string, unknown>>> {
  const bySection: Partial<Record<Section, Record<string, unknown>>> = {};

  for (const reading of readings) {
    if (reading.circuit !== 0 || !reading.field) continue;
    const section = routeSupplyField(reading.field);
    const existingSection = (bySection[section] ??
      (job[section] as Record<string, unknown> | undefined) ??
      {}) as Record<string, unknown>;
    const currentValue = existingSection[reading.field];
    const key = circuit0Key(section, reading.field);
    const outcome = applySonnetValue({
      key,
      newValue: reading.value,
      currentValue,
      sources,
      apply: () => {
        bySection[section] = {
          ...existingSection,
          [reading.field]: reading.value,
        };
      },
    });
    outcomes.set(key, outcome);
  }

  // Fold in per-section updates, preserving other keys on the section.
  for (const section of Object.keys(bySection) as Section[]) {
    const existing = (job[section] as Record<string, unknown> | undefined) ?? {};
    bySection[section] = { ...existing, ...bySection[section] };
  }

  return bySection;
}

/** Apply per-circuit readings. Returns a new circuits array if any
 *  changes were made, or null for no-op. Creates a new row for any
 *  circuit number we haven't seen yet so subsequent readings have a
 *  stable id to land on. */
function applyCircuitReadings(
  job: JobDetail,
  readings: ExtractedReading[],
  circuitUpdates: CircuitUpdate[],
  fieldClears: FieldClear[],
  sources: FieldSourceMap,
  outcomes: Map<string, ApplyOutcome>
): CircuitRow[] | null {
  const perCircuitReadings = readings.filter((r) => r.circuit >= 1 && r.field);
  const hasCircuitUpdate = circuitUpdates.some((u) => u.circuit >= 1);
  const hasPerCircuitClear = fieldClears.some((c) => c.circuit >= 1);

  if (perCircuitReadings.length === 0 && !hasCircuitUpdate && !hasPerCircuitClear) {
    return null;
  }

  const circuits = [...((job.circuits as CircuitRow[] | undefined) ?? [])];
  const indexByRef = new Map<string, number>();
  circuits.forEach((row, idx) => {
    const ref = row.circuit_ref ?? row.number;
    if (typeof ref === 'string' && ref) indexByRef.set(ref, idx);
  });

  const ensureRow = (circuitNum: number): number => {
    const ref = String(circuitNum);
    const existingIdx = indexByRef.get(ref);
    if (existingIdx != null) return existingIdx;
    const id = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${circuitNum}`;
    const row: CircuitRow = { id, circuit_ref: ref, circuit_designation: '' };
    circuits.push(row);
    indexByRef.set(ref, circuits.length - 1);
    return circuits.length - 1;
  };

  // Apply circuit_updates (create / rename designation) first so
  // readings against renamed circuits land on the right row.
  for (const upd of circuitUpdates) {
    if (upd.circuit < 1 || !upd.designation) continue;
    const idx = ensureRow(upd.circuit);
    const row = circuits[idx];
    if (upd.action === 'rename' || !hasValue(row.circuit_designation)) {
      circuits[idx] = { ...row, circuit_designation: upd.designation };
    }
  }

  for (const reading of perCircuitReadings) {
    const idx = ensureRow(reading.circuit);
    const row = circuits[idx];
    const currentValue = row[reading.field];
    const key = perCircuitKey(reading.circuit, reading.field);
    const outcome = applySonnetValue({
      key,
      newValue: reading.value,
      currentValue,
      sources,
      apply: () => {
        circuits[idx] = {
          ...circuits[idx],
          [reading.field]: reading.value as unknown,
        };
      },
    });
    outcomes.set(key, outcome);
  }

  for (const clear of fieldClears) {
    if (clear.circuit < 1 || !clear.field) continue;
    const idx = indexByRef.get(String(clear.circuit));
    if (idx == null) continue;
    const row = { ...circuits[idx] };
    delete row[clear.field];
    circuits[idx] = row;
  }

  return circuits;
}

/** Fold new observations into the existing array. Dedupes by
 *  case-insensitive `observation_text` so Sonnet re-asking about the
 *  same defect doesn't create duplicates. */
function applyObservations(job: JobDetail, observations: Observation[]): ObservationRow[] | null {
  if (observations.length === 0) return null;
  const existing = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const seen = new Set(
    existing.map((o) => (o.description ?? '').trim().toLowerCase()).filter(Boolean)
  );
  let changed = false;
  for (const obs of observations) {
    const text = (obs.observation_text ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = globalThis.crypto?.randomUUID?.() ?? `obs-${Date.now()}-${existing.length + 1}`;
    const code = parseObservationCode(obs.code);
    existing.push({
      id,
      code,
      description: text,
      location: obs.item_location ?? undefined,
    });
    changed = true;
  }
  return changed ? existing : null;
}

export function parseObservationCode(
  raw: string | undefined
): 'C1' | 'C2' | 'C3' | 'FI' | undefined {
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === 'C1' || upper === 'C2' || upper === 'C3' || upper === 'FI') {
    return upper;
  }
  return undefined;
}

/** Sections whose flat records feed LiveFillState section keys. */
const SCALAR_SECTIONS: Section[] = ['installation', 'supply', 'board', 'extent', 'design'];

/** Diff two section records and emit dot-path keys for any value that
 *  changed. Only reports keys whose new value passes `hasValue` — zero
 *  / empty strings / nulls get suppressed so the flash doesn't fire on
 *  a no-op re-assignment from Sonnet. */
function diffSectionKeys(
  section: Section,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): string[] {
  if (!after) return [];
  const prev = before ?? {};
  const keys: string[] = [];
  for (const field of Object.keys(after)) {
    if (prev[field] !== after[field] && hasValue(after[field])) {
      keys.push(`${section}.${field}`);
    }
  }
  return keys;
}

/** Diff circuits arrays. Emits `circuit.{id}.{field}` for each cell that
 *  changed, plus a whole-row key `circuit.{id}` when a new circuit row
 *  was created so the UI can flash the whole row. */
function diffCircuitKeys(
  before: CircuitRow[] | undefined,
  after: CircuitRow[] | undefined
): string[] {
  if (!after) return [];
  const prevById = new Map<string, CircuitRow>();
  (before ?? []).forEach((row) => prevById.set(row.id, row));
  const keys: string[] = [];
  for (const row of after) {
    const prev = prevById.get(row.id);
    if (!prev) {
      // Newly-created row — flash the whole row plus every filled cell.
      keys.push(`circuit.${row.id}`);
      for (const field of Object.keys(row)) {
        if (field === 'id') continue;
        if (hasValue(row[field])) keys.push(`circuit.${row.id}.${field}`);
      }
      continue;
    }
    for (const field of Object.keys(row)) {
      if (field === 'id') continue;
      if (prev[field] !== row[field] && hasValue(row[field])) {
        keys.push(`circuit.${row.id}.${field}`);
      }
    }
  }
  return keys;
}

/** Diff observations. Emits `observation.{id}` for each new row. We
 *  don't bother diffing fields within an existing observation — Sonnet
 *  never amends observations, it only appends them. */
function diffObservationKeys(
  before: ObservationRow[] | undefined,
  after: ObservationRow[] | undefined
): string[] {
  if (!after) return [];
  const prevIds = new Set((before ?? []).map((o) => o.id));
  return after.filter((o) => !prevIds.has(o.id)).map((o) => `observation.${o.id}`);
}

export type AppliedExtraction = {
  patch: Partial<JobDetail>;
  /** Dot-path keys for every field that actually changed vs the job
   *  state the patch was computed against. Feeds LiveFillState so the
   *  LiveFillView can flash exactly the cells Sonnet filled. */
  changedKeys: string[];
  /** Count of writes that overwrote a regex-source field with a
   *  different value. Mirrors iOS `discrepancyCount` — surfaced for
   *  per-session telemetry / future R6 soak observability. */
  discrepancyCount: number;
  /** Count of writes that overwrote a pre-existing field with a
   *  different value. Mirrors iOS `preexisting_overwrite` log. */
  preexistingOverwriteCount: number;
};

/** Public entry point — returns the JobDetail patch + a flat list of
 *  dot-path keys describing which fields actually changed, or null if
 *  the extraction was effectively empty. Any field_clears on circuit 0
 *  are honoured too (they delete the key from the matching section).
 *
 *  `sources` is the per-session FieldSourceMap. Callers that don't have
 *  one (legacy / unit tests) get a fresh empty map; that's safe — an
 *  empty map means every populated field is treated as 'preExisting'
 *  on first encounter, exactly matching what iOS does on cold start. */
export function applyExtractionToJob(
  job: JobDetail,
  result: ExtractionResult,
  sources: FieldSourceMap = new FieldSourceMap()
): AppliedExtraction | null {
  const readings = result.readings ?? [];
  const circuitUpdates = result.circuit_updates ?? [];
  const fieldClears = result.field_clears ?? [];
  const observations = result.observations ?? [];

  const outcomes = new Map<string, ApplyOutcome>();
  const patch: Partial<JobDetail> = {};

  // Circuit 0 readings — split by section.
  const supplyPatches = applyCircuit0Readings(job, readings, sources, outcomes);
  for (const section of Object.keys(supplyPatches) as Section[]) {
    const merged = supplyPatches[section];
    if (merged) patch[section] = merged;
  }

  // Circuit 0 field_clears — delete key from the right section.
  for (const clear of fieldClears) {
    if (clear.circuit !== 0 || !clear.field) continue;
    const section = routeSupplyField(clear.field);
    const existing =
      (patch[section] as Record<string, unknown> | undefined) ??
      (job[section] as Record<string, unknown> | undefined) ??
      {};
    if (clear.field in existing) {
      const next = { ...existing };
      delete next[clear.field];
      patch[section] = next;
    }
  }

  // Per-circuit readings + updates + clears.
  const newCircuits = applyCircuitReadings(
    job,
    readings,
    circuitUpdates,
    fieldClears,
    sources,
    outcomes
  );
  if (newCircuits) patch.circuits = newCircuits;

  // Observations.
  const newObservations = applyObservations(job, observations);
  if (newObservations) patch.observations = newObservations;

  if (Object.keys(patch).length === 0) return null;

  // Compute changedKeys by diffing the patched sections against the
  // pre-patch job. We diff instead of reading the readings array so the
  // flash stays accurate even if the extractor grows new fields or the
  // routing map drifts.
  const changedKeys: string[] = [];
  for (const section of SCALAR_SECTIONS) {
    changedKeys.push(
      ...diffSectionKeys(
        section,
        job[section] as Record<string, unknown> | undefined,
        patch[section] as Record<string, unknown> | undefined
      )
    );
  }
  if (patch.circuits) {
    changedKeys.push(...diffCircuitKeys(job.circuits, patch.circuits));
  }
  if (patch.observations) {
    changedKeys.push(...diffObservationKeys(job.observations, patch.observations));
  }

  let discrepancyCount = 0;
  let preexistingOverwriteCount = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.applied && outcome.reason === 'sonnet-overwrite-regex') {
      discrepancyCount += 1;
    }
    if (outcome.applied && outcome.reason === 'sonnet-overwrite-preexisting') {
      preexistingOverwriteCount += 1;
    }
  }

  return { patch, changedKeys, discrepancyCount, preexistingOverwriteCount };
}
