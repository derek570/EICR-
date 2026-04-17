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

/** Non-empty / non-null check used by the 3-tier priority guard. */
export function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'boolean' || typeof v === 'number') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}

/** Apply all readings belonging to circuit 0. Returns a map of
 *  section → merged record that can be folded into the final patch. */
function applyCircuit0Readings(
  job: JobDetail,
  readings: ExtractedReading[]
): Partial<Record<Section, Record<string, unknown>>> {
  const bySection: Partial<Record<Section, Record<string, unknown>>> = {};

  for (const reading of readings) {
    if (reading.circuit !== 0 || !reading.field) continue;
    const section = routeSupplyField(reading.field);
    const existing = (job[section] as Record<string, unknown> | undefined) ?? {};
    // 3-tier priority — don't overwrite a pre-existing value. Sonnet
    // dedups against its own state snapshot, but the user might have
    // typed a correction since the last job_state_update landed.
    if (hasValue(existing[reading.field])) continue;
    bySection[section] = {
      ...(bySection[section] ?? {}),
      [reading.field]: reading.value,
    };
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
  fieldClears: FieldClear[]
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
    // 3-tier priority — keep the user's value if they've already typed
    // one into the field.
    if (hasValue(row[reading.field])) continue;
    circuits[idx] = {
      ...row,
      [reading.field]: reading.value as unknown,
    };
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

/** Public entry point — returns the JobDetail patch or null if the
 *  extraction was effectively empty. Any field_clears on circuit 0 are
 *  honoured too (they delete the key from the matching section). */
export function applyExtractionToJob(
  job: JobDetail,
  result: ExtractionResult
): Partial<JobDetail> | null {
  const readings = result.readings ?? [];
  const circuitUpdates = result.circuit_updates ?? [];
  const fieldClears = result.field_clears ?? [];
  const observations = result.observations ?? [];

  const patch: Partial<JobDetail> = {};

  // Circuit 0 readings — split by section.
  const supplyPatches = applyCircuit0Readings(job, readings);
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
  const newCircuits = applyCircuitReadings(job, readings, circuitUpdates, fieldClears);
  if (newCircuits) patch.circuits = newCircuits;

  // Observations.
  const newObservations = applyObservations(job, observations);
  if (newObservations) patch.observations = newObservations;

  return Object.keys(patch).length > 0 ? patch : null;
}
