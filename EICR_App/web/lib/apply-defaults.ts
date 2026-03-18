/**
 * apply-defaults.ts — Shared utility for applying circuit field defaults.
 *
 * Mirrors the iOS DefaultsService.applyDefaults(to:) behaviour:
 * - Only fills in EMPTY fields (the "only-fill-empty" strategy)
 * - Never overwrites values that already exist from voice transcription,
 *   CCU photo analysis, or manual entry
 * - Applied at two key points:
 *   1. When a new circuit is created (manual add or regex detection)
 *   2. After Sonnet extraction results are merged (fill remaining gaps)
 *
 * The subset of keys that iOS DefaultsService actually applies:
 *   wiring_type, ref_method, max_disconnect_time_s,
 *   ocpd_bs_en, ocpd_type, ocpd_breaking_capacity_ka,
 *   rcd_bs_en, rcd_type, rcd_operating_current_ma,
 *   ir_test_voltage_v
 */

import type { Circuit, UserDefaults } from './types';

/**
 * The keys that DefaultsService applies — matching the iOS implementation.
 * These are "configuration" fields (equipment specs) rather than "measurement"
 * fields (test results that must come from actual on-site readings).
 */
export const DEFAULTS_APPLICABLE_KEYS = new Set([
  'wiring_type',
  'ref_method',
  'max_disconnect_time_s',
  'ocpd_bs_en',
  'ocpd_type',
  'ocpd_breaking_capacity_ka',
  'rcd_bs_en',
  'rcd_type',
  'rcd_operating_current_ma',
  'ir_test_voltage_v',
]);

/**
 * Apply user defaults to a single circuit using the only-fill-empty strategy.
 * Returns a new circuit object (never mutates the original).
 *
 * @param circuit - The circuit to apply defaults to
 * @param defaults - The user's saved default values
 * @returns A new circuit with defaults applied to empty fields
 */
export function applyDefaultsToCircuit(circuit: Circuit, defaults: UserDefaults): Circuit {
  if (!defaults || Object.keys(defaults).length === 0) return circuit;

  const updated = { ...circuit };
  for (const [key, value] of Object.entries(defaults)) {
    // Only apply keys that are in the approved set
    if (!DEFAULTS_APPLICABLE_KEYS.has(key)) continue;
    // Only fill empty fields — never overwrite existing values
    if (value && (!updated[key] || updated[key] === '')) {
      updated[key] = value;
    }
  }
  return updated;
}

/**
 * Apply user defaults to an array of circuits.
 * Returns a new array (never mutates the originals).
 *
 * @param circuits - Array of circuits to apply defaults to
 * @param defaults - The user's saved default values
 * @returns A new array with defaults applied to empty fields
 */
export function applyDefaultsToCircuits(circuits: Circuit[], defaults: UserDefaults): Circuit[] {
  if (!defaults || Object.keys(defaults).length === 0) return circuits;
  return circuits.map((c) => applyDefaultsToCircuit(c, defaults));
}
