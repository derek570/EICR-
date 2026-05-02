/**
 * Phase B — Defaults service module (2026-05-03).
 *
 * Mirrors iOS `CertificateDefaultsService.swift`:
 *   - load/save presets
 *   - load/save cable defaults (with seed-on-empty + add-missing on
 *     subsequent loads, so a release that adds new generic_* keys
 *     auto-extends the user's table)
 *   - matchCircuitType(designation, rating) → cable type key
 *   - applyPresetToJob(preset, job) → only-fill-empty merge of every
 *     section the iOS applier touches
 *
 * Storage path: `/api/settings/{userId}/defaults` JSON blob, namespaced
 * under `presets[]` and `cable_defaults[]`. Coexists with the legacy
 * Phase 5 flat circuit-field defaults at the root.
 */

import { api } from '../api-client';
import type { JobDetail } from '../types';
import type { CertificateDefaultPreset, CableDefault } from './types';
import { DEFAULT_CABLE_TYPES } from './types';

/** Same fallback pattern as `apply-ccu-analysis.ts` so unit tests
 *  running under Node without `globalThis.crypto.randomUUID` still get
 *  a unique-enough id. */
function uuidv4(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

const PRESETS_KEY = 'presets';
const CABLE_DEFAULTS_KEY = 'cable_defaults';

interface RawDefaultsBlob extends Record<string, unknown> {
  presets?: unknown;
  cable_defaults?: unknown;
}

async function readBlob(userId: string): Promise<RawDefaultsBlob> {
  const blob = await api.userDefaults(userId);
  return (blob ?? {}) as RawDefaultsBlob;
}

async function writeBlob(userId: string, next: Record<string, unknown>): Promise<void> {
  await api.saveUserDefaults(userId, next);
}

function isPreset(x: unknown): x is CertificateDefaultPreset {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.user_id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.certificate_type === 'string' &&
    typeof r.last_modified === 'number' &&
    typeof r.default_data === 'object' &&
    r.default_data !== null
  );
}

function isCableDefault(x: unknown): x is CableDefault {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.user_id === 'string' &&
    typeof r.circuit_type_key === 'string' &&
    typeof r.display_name === 'string'
  );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Load all presets. Optionally filter by certificate type. */
export async function loadPresets(
  userId: string,
  certificateType?: string
): Promise<CertificateDefaultPreset[]> {
  const blob = await readBlob(userId);
  const raw = Array.isArray(blob[PRESETS_KEY]) ? (blob[PRESETS_KEY] as unknown[]) : [];
  const presets = raw.filter(isPreset);
  if (certificateType) {
    return presets.filter((p) => p.certificate_type === certificateType);
  }
  return presets;
}

/** Persist a new preset. Round-trips the blob to avoid stomping cable defaults. */
export async function savePreset(
  userId: string,
  input: { name: string; certificate_type: string; default_data: Partial<JobDetail> }
): Promise<CertificateDefaultPreset> {
  const blob = await readBlob(userId);
  const raw = Array.isArray(blob[PRESETS_KEY]) ? (blob[PRESETS_KEY] as unknown[]) : [];
  const existing = raw.filter(isPreset);
  const preset: CertificateDefaultPreset = {
    id: uuidv4(),
    user_id: userId,
    name: input.name,
    certificate_type: input.certificate_type,
    default_data: input.default_data,
    last_modified: Math.floor(Date.now() / 1000),
  };
  await writeBlob(userId, { ...blob, [PRESETS_KEY]: [...existing, preset] });
  return preset;
}

/** Update an existing preset. */
export async function updatePreset(
  userId: string,
  presetId: string,
  patch: { name?: string; default_data?: Partial<JobDetail> }
): Promise<CertificateDefaultPreset | null> {
  const blob = await readBlob(userId);
  const raw = Array.isArray(blob[PRESETS_KEY]) ? (blob[PRESETS_KEY] as unknown[]) : [];
  const existing = raw.filter(isPreset);
  let updated: CertificateDefaultPreset | null = null;
  const next = existing.map((p) => {
    if (p.id !== presetId) return p;
    updated = {
      ...p,
      name: patch.name ?? p.name,
      default_data: patch.default_data ?? p.default_data,
      last_modified: Math.floor(Date.now() / 1000),
    };
    return updated;
  });
  if (!updated) return null;
  await writeBlob(userId, { ...blob, [PRESETS_KEY]: next });
  return updated;
}

/** Delete a preset by id. */
export async function deletePreset(userId: string, presetId: string): Promise<void> {
  const blob = await readBlob(userId);
  const raw = Array.isArray(blob[PRESETS_KEY]) ? (blob[PRESETS_KEY] as unknown[]) : [];
  const remaining = raw.filter(isPreset).filter((p) => p.id !== presetId);
  await writeBlob(userId, { ...blob, [PRESETS_KEY]: remaining });
}

// ---------------------------------------------------------------------------
// Cable defaults
// ---------------------------------------------------------------------------

function seedCableDefaults(userId: string): CableDefault[] {
  return DEFAULT_CABLE_TYPES.map((t) => ({
    id: uuidv4(),
    user_id: userId,
    circuit_type_key: t.key,
    display_name: t.name,
    conductor_size: t.conductor,
    cpc_size: t.cpc,
    wiring_type: null,
    ref_method: null,
  }));
}

/**
 * Load the cable defaults table. Seeds on first read; on subsequent
 * reads, adds any missing default keys (so a release that adds new
 * `generic_*` rows auto-extends the user's table without losing their
 * customisations to the rows they had before).
 *
 * Mirrors `CertificateDefaultsService.loadCableDefaults` →
 * `seedCableDefaults` + `addMissingCableDefaults`.
 */
export async function loadCableDefaults(userId: string): Promise<CableDefault[]> {
  const blob = await readBlob(userId);
  const raw = Array.isArray(blob[CABLE_DEFAULTS_KEY])
    ? (blob[CABLE_DEFAULTS_KEY] as unknown[])
    : [];
  const existing = raw.filter(isCableDefault);

  if (existing.length === 0) {
    const seeded = seedCableDefaults(userId);
    await writeBlob(userId, { ...blob, [CABLE_DEFAULTS_KEY]: seeded });
    return seeded;
  }

  // Add-missing pass.
  const existingKeys = new Set(existing.map((c) => c.circuit_type_key));
  const additions: CableDefault[] = DEFAULT_CABLE_TYPES.filter((t) => !existingKeys.has(t.key)).map(
    (t) => ({
      id: uuidv4(),
      user_id: userId,
      circuit_type_key: t.key,
      display_name: t.name,
      conductor_size: t.conductor,
      cpc_size: t.cpc,
      wiring_type: null,
      ref_method: null,
    })
  );
  if (additions.length > 0) {
    const merged = [...existing, ...additions];
    await writeBlob(userId, { ...blob, [CABLE_DEFAULTS_KEY]: merged });
    return merged;
  }
  return existing;
}

/** Persist the full cable defaults table. */
export async function saveCableDefaults(userId: string, rows: CableDefault[]): Promise<void> {
  const blob = await readBlob(userId);
  await writeBlob(userId, { ...blob, [CABLE_DEFAULTS_KEY]: rows });
}

// ---------------------------------------------------------------------------
// Classifier — designation + rating → cable type key
// ---------------------------------------------------------------------------

/**
 * Match a circuit by its designation/ocpd_rating to one of the
 * `DEFAULT_CABLE_TYPES` keys. Direct port of iOS
 * `CertificateDefaultsService.matchCircuitType` so the auto-fill
 * produces identical results across platforms.
 */
export function matchCircuitType(
  designation: string,
  ocpdRating: string | null | undefined
): string | null {
  const des = (designation || '').toLowerCase();
  const rating = ocpdRating ?? '';

  if (des.includes('socket') || des.includes('ring')) return 'socket_ring';

  if (des.includes('light')) {
    if (rating === '10') return 'lighting_10a';
    if (rating === '6' || rating === '') {
      if (des.includes('upstairs') || des.includes('1st floor') || des.includes('first floor')) {
        return 'lighting_6a_upstairs';
      }
      if (des.includes('downstairs') || des.includes('ground')) {
        return 'lighting_6a_downstairs';
      }
      return 'lighting_6a_downstairs';
    }
    return null;
  }

  if (des.includes('cooker') || des.includes('oven') || des.includes('hob')) {
    if (rating === '32') return 'cooker_32a';
    if (rating === '16' || rating === '20') return 'cooker_16_20a';
    if (rating === '') return 'cooker_32a';
    return null;
  }

  if (des.includes('shower')) {
    if (rating === '40' || rating === '45') return 'shower_40a';
    if (rating === '32') return 'shower_32a';
    if (rating === '') return 'shower_32a';
    return null;
  }

  if (des.includes('immersion') || des.includes('water heater') || des.includes('hot water')) {
    return 'water_heater_16_20a';
  }

  if (des.includes('radial')) return 'radial_16_20a';

  // Generic fallback by MCB rating.
  const generic = ['6', '10', '16', '20', '32', '40'];
  if (generic.includes(rating)) return `generic_${rating}a`;

  return null;
}

// ---------------------------------------------------------------------------
// Apply preset — only-fill-empty merge
// ---------------------------------------------------------------------------

function isEmpty(x: unknown): boolean {
  if (x == null) return true;
  if (typeof x === 'string' && x.trim() === '') return true;
  if (Array.isArray(x) && x.length === 0) return true;
  return false;
}

/**
 * Apply a preset to a job. Mirrors iOS
 * `CertificateDefaultsService.applyPreset` — only-fill-empty merge,
 * never overwrites a value the inspector has already typed.
 *
 * Returns a `Partial<JobDetail>` patch suitable for `updateJob()`.
 *
 * Skipped fields by section (intentional, mirrors iOS):
 *   - Installation: clientName, address, postcode, town, county
 *     (job-specific identity fields).
 *   - Boards: replaced only if the job has the single default
 *     empty board (i.e. user hasn't started filling boards yet).
 *   - Circuits / Observations: copied if the job has none.
 *   - Inspection schedule: merged item-by-item.
 *
 * The implementation is intentionally a shallow walk of the JobDetail
 * sections — we only handle the keys iOS handles. New fields added to
 * JobDetail need an explicit branch added here. Defaulting to "fill
 * everything from the preset" risks stomping job-identity fields.
 */
export function applyPresetToJob(
  preset: CertificateDefaultPreset,
  job: JobDetail
): Partial<JobDetail> {
  const tpl = preset.default_data;
  const patch: Partial<JobDetail> = {};

  // Installation details — skip identity fields.
  if (tpl.installation_details) {
    const src = tpl.installation_details as Record<string, unknown>;
    const dst = { ...((job.installation_details ?? {}) as Record<string, unknown>) };
    const skip = new Set([
      'client_name',
      'address',
      'postcode',
      'town',
      'county',
      'date_of_inspection',
      'date_of_test',
      'next_inspection_date',
    ]);
    let changed = false;
    for (const [k, v] of Object.entries(src)) {
      if (skip.has(k)) continue;
      if (isEmpty(dst[k])) {
        dst[k] = v;
        changed = true;
      }
    }
    if (changed) patch.installation_details = dst;
  }

  // Supply characteristics — fill all empty fields.
  if (tpl.supply_characteristics) {
    const src = tpl.supply_characteristics as Record<string, unknown>;
    const dst = { ...((job.supply_characteristics ?? {}) as Record<string, unknown>) };
    let changed = false;
    for (const [k, v] of Object.entries(src)) {
      if (isEmpty(dst[k])) {
        dst[k] = v;
        changed = true;
      }
    }
    if (changed) patch.supply_characteristics = dst;
  }

  // Boards — replace if the job has zero (or a single empty default) boards.
  const existingBoards = (job.boards ?? []) as Array<Record<string, unknown>>;
  const tplBoards = (tpl.boards ?? []) as Array<Record<string, unknown>>;
  if (tplBoards.length > 0 && existingBoards.length === 0) {
    patch.boards = tplBoards;
  }

  // Circuits — copy if the job has none. Don't merge circuit-by-circuit:
  // circuits are job-specific and a preset's circuits are meant as a
  // starting point, not an overlay.
  const existingCircuits = (job.circuits ?? []) as unknown[];
  const tplCircuits = (tpl.circuits ?? []) as unknown[];
  if (tplCircuits.length > 0 && existingCircuits.length === 0) {
    patch.circuits = tpl.circuits;
  }

  // Observations — copy if the job has none.
  const existingObs = (job.observations ?? []) as unknown[];
  const tplObs = (tpl.observations ?? []) as unknown[];
  if (tplObs.length > 0 && existingObs.length === 0) {
    patch.observations = tpl.observations;
  }

  // Inspection schedule — item-by-item merge.
  const tplSchedule = tpl.inspection_schedule as
    | { items?: Record<string, unknown>; [k: string]: unknown }
    | undefined;
  const existingSchedule = job.inspection_schedule as
    | { items?: Record<string, unknown>; [k: string]: unknown }
    | undefined;
  if (tplSchedule?.items) {
    const dstItems: Record<string, unknown> = { ...(existingSchedule?.items ?? {}) };
    let changed = false;
    for (const [ref, item] of Object.entries(tplSchedule.items)) {
      if (!dstItems[ref]) {
        dstItems[ref] = item;
        changed = true;
      }
    }
    if (changed) {
      patch.inspection_schedule = {
        ...(existingSchedule ?? {}),
        ...tplSchedule,
        items: dstItems,
      };
    }
  }

  // EIC-specific sections (extent, design) — fill empty fields.
  for (const key of ['extent_and_type', 'design_construction'] as const) {
    const src = tpl[key as keyof typeof tpl] as Record<string, unknown> | undefined;
    if (!src) continue;
    const dst = { ...((job[key as keyof JobDetail] ?? {}) as Record<string, unknown>) };
    let changed = false;
    for (const [k, v] of Object.entries(src)) {
      if (isEmpty(dst[k])) {
        dst[k] = v;
        changed = true;
      }
    }
    if (changed) {
      (patch as Record<string, unknown>)[key] = dst;
    }
  }

  return patch;
}
