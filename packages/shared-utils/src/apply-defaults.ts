/**
 * Apply-defaults helpers — mirrors iOS
 * `DefaultsService.applyDefaults(to:)` (user-selected defaults) +
 * `CertificateDefaultsService.applyCableDefaults(to:)` (per-circuit-type
 * cable sizing) + the BS 7671 fallback in iOS
 * `DefaultsService.defaultDisconnectTime`.
 *
 * Key invariant (carried over from iOS):
 *   **Apply-defaults MUST never overwrite a non-empty field.**
 *   The inspector's input is always canonical. Defaults fill holes.
 *
 * Three layers, applied in this order (last-write-wins, but we only
 * write when the field is empty, so order is additive not destructive):
 *   1. User-selected global defaults (passed in via `userDefaults` —
 *      sourced from the Settings → Defaults page; optional).
 *   2. Per-circuit-type defaults from `field_schema.json`
 *      (`defaults_by_circuit` — lighting / socket / cooker / shower /
 *      immersion), keyed off `inferCircuitType`.
 *   3. BS 7671 / schema-level fallbacks (`GLOBAL_DEFAULTS` — applied
 *      to every circuit regardless of inferred type).
 *
 * Ambiguous circuits (inferCircuitType returns null) still pick up
 * layer-1 user defaults and layer-3 global defaults — we just skip
 * layer-2 because we don't know which column of the per-type table to
 * read from.
 */

import type { Circuit } from '@certmate/shared-types';
import { DEFAULTS_BY_CIRCUIT, GLOBAL_DEFAULTS, inferCircuitType } from './circuit-defaults-schema';

/** Returns true if a circuit field is empty (missing, null, or whitespace-only). */
function isEmpty(value: string | undefined | null): boolean {
  if (value == null) return true;
  return String(value).trim().length === 0;
}

export interface ApplyDefaultsSummary {
  /** Fields filled (sum across all circuits). */
  filledFields: number;
  /** Circuits that had at least one field filled. */
  touchedCircuits: number;
  /** Circuits skipped entirely because inferCircuitType returned null AND no user/global defaults applied. */
  ambiguousCircuits: number;
}

export interface ApplyDefaultsOptions {
  /**
   * Global user-selected defaults (from the Defaults page / iOS
   * `DefaultsService.defaults`). Keys are Circuit field names; values
   * are strings. Empty strings are ignored. iOS only applies a known
   * subset — we honour any key the caller passes and let the type
   * system guide them via `Partial<Circuit>`.
   */
  userDefaults?: Partial<Record<keyof Circuit, string>>;
}

/**
 * Apply defaults to a single circuit. Pure: returns a new object if
 * any field was filled, otherwise the input reference is preserved.
 */
export function applyDefaultsToCircuit<T extends Partial<Circuit>>(
  circuit: T,
  options: ApplyDefaultsOptions = {}
): { circuit: T; filledFields: number; ambiguous: boolean } {
  const { userDefaults = {} } = options;
  const inferred = inferCircuitType(circuit);
  const next = { ...circuit } as T;
  let filled = 0;

  // Layer 1: user-selected defaults. Fill any empty field the user has
  // chosen a value for. Don't overwrite existing values.
  for (const [key, value] of Object.entries(userDefaults)) {
    if (value == null || String(value).trim() === '') continue;
    if (isEmpty(next[key as keyof T] as string | undefined)) {
      (next as Record<string, string | undefined>)[key] = String(value);
      filled += 1;
    }
  }

  // Layer 2: per-circuit-type schema defaults.
  if (inferred) {
    for (const [fieldKey, perType] of Object.entries(DEFAULTS_BY_CIRCUIT)) {
      const typeValue = perType[inferred.type];
      if (!typeValue) continue;
      if (isEmpty(next[fieldKey as keyof T] as string | undefined)) {
        (next as Record<string, string | undefined>)[fieldKey] = typeValue;
        filled += 1;
      }
    }
  }

  // Layer 3: global schema defaults (applies to every circuit).
  for (const [fieldKey, value] of Object.entries(GLOBAL_DEFAULTS)) {
    if (value == null) continue;
    if (isEmpty(next[fieldKey as keyof T] as string | undefined)) {
      (next as Record<string, string | undefined>)[fieldKey] = value as string;
      filled += 1;
    }
  }

  return {
    circuit: filled === 0 ? circuit : next,
    filledFields: filled,
    ambiguous: inferred === null && filled === 0,
  };
}

export interface ApplyDefaultsBulkResult<T extends Partial<Circuit>> {
  circuits: T[];
  summary: ApplyDefaultsSummary;
}

/**
 * Apply defaults to every circuit in the given array.
 * Returns a new array when any field is filled; otherwise preserves
 * the input array (reference-equal) so React renders don't thrash.
 */
export function applyDefaultsToCircuits<T extends Partial<Circuit>>(
  circuits: T[],
  options: ApplyDefaultsOptions = {}
): ApplyDefaultsBulkResult<T> {
  let filledFields = 0;
  let touchedCircuits = 0;
  let ambiguousCircuits = 0;
  let changed = false;

  const next = circuits.map((c) => {
    const res = applyDefaultsToCircuit(c, options);
    if (res.filledFields > 0) {
      filledFields += res.filledFields;
      touchedCircuits += 1;
      changed = true;
    }
    if (res.ambiguous) ambiguousCircuits += 1;
    return res.circuit;
  });

  return {
    circuits: changed ? next : circuits,
    summary: { filledFields, touchedCircuits, ambiguousCircuits },
  };
}
