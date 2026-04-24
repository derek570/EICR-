/**
 * Embedded subset of `config/field_schema.json` needed to apply
 * per-circuit-type defaults. We copy the values here (rather than
 * reading the JSON at runtime) because:
 *   1. `packages/shared-utils` is consumed by the browser build and
 *      doesn't have filesystem access.
 *   2. Next 16 webpack doesn't resolve JSON imports transparently
 *      across the workspace boundary without a custom loader.
 *   3. The subset is tiny (≈30 values) and changes about once a year
 *      — a manual sync is cheaper than runtime fetch plumbing.
 *
 * **If you change `defaults_by_circuit` in `config/field_schema.json`,
 * update this file too.** A unit test in `web/tests/phase-5-apply-defaults.test.ts`
 * verifies the copy stays aligned on fields the inspector relies on.
 *
 * Top-level default values (fields with a plain `default` rather than
 * `defaults_by_circuit`) are included for BS 7671 fallbacks — iOS
 * mirrors these in `DefaultsService.defaultDisconnectTime = "0.4"`.
 *
 * `circuit_type` classifier mirrors iOS
 * `CertificateDefaultsService.matchCircuitType(designation:ocpdRating:)`.
 */

import type { Circuit } from '@certmate/shared-types';

/** Keys used in `defaults_by_circuit` maps. */
export type CircuitTypeKey =
  | 'lighting'
  | 'socket'
  | 'cooker'
  | 'shower'
  | 'immersion'
  | 'radial'
  | 'unknown';

/** Per-field, per-type defaults extracted verbatim from field_schema.json. */
export const DEFAULTS_BY_CIRCUIT: Record<string, Partial<Record<CircuitTypeKey, string>>> = {
  live_csa_mm2: {
    lighting: '1.0',
    socket: '2.5',
    cooker: '6.0',
    shower: '10.0',
    immersion: '2.5',
  },
  cpc_csa_mm2: {
    lighting: '1.0',
    socket: '1.5',
    cooker: '2.5',
    shower: '4.0',
    immersion: '1.5',
  },
  ocpd_rating_a: {
    lighting: '6',
    socket: '32',
    cooker: '32',
    shower: '40',
    immersion: '16',
  },
};

/**
 * Type-independent defaults from field_schema.json (and iOS
 * `DefaultsService` fallbacks). Applied when a field is empty
 * regardless of the inferred circuit type.
 */
export const GLOBAL_DEFAULTS: Partial<Circuit> = {
  // BS 7671 standard max disconnect time for final circuits up to 32A
  // (Tables 41.1 / 41.4). iOS enforces this even when no user default.
  max_disconnect_time_s: '0.4',
  // iOS schema `default`s (applied when empty + no per-type default).
  ocpd_type: 'B',
  ocpd_breaking_capacity_ka: '6',
  rcd_operating_current_ma: '30',
  ir_test_voltage_v: '500',
  // Schema also defines wiring_type/ref_method defaults of "A" — iOS
  // only applies these when the user has picked them in DefaultsService,
  // so we skip them here to avoid silently branding every circuit "A"
  // wiring (which is domestic T&E). Users who want this can set it
  // once in Defaults and it flows through the user-defaults channel.
};

/**
 * Infer a circuit type from designation + OCPD rating.
 * Mirrors iOS `matchCircuitType` (case-insensitive substring match).
 * Returns `null` when the circuit is too ambiguous to type safely.
 */
export function inferCircuitType(
  circuit: Partial<Circuit>
): { type: CircuitTypeKey; specific: string | null } | null {
  const designation = (circuit.circuit_designation ?? '').toLowerCase();
  const rating = (circuit.ocpd_rating_a ?? '').trim();

  if (designation.includes('socket') || designation.includes('ring')) {
    return { type: 'socket', specific: 'socket_ring' };
  }

  if (designation.includes('light')) {
    if (rating === '10') return { type: 'lighting', specific: 'lighting_10a' };
    if (rating === '6' || rating === '') {
      if (
        designation.includes('upstairs') ||
        designation.includes('1st floor') ||
        designation.includes('first floor')
      ) {
        return { type: 'lighting', specific: 'lighting_6a_upstairs' };
      }
      return { type: 'lighting', specific: 'lighting_6a_downstairs' };
    }
    // A lighting circuit on a non-6/10A breaker — too bespoke to default.
    return null;
  }

  if (
    designation.includes('cooker') ||
    designation.includes('oven') ||
    designation.includes('hob')
  ) {
    if (rating === '32') return { type: 'cooker', specific: 'cooker_32a' };
    if (rating === '16' || rating === '20') {
      return { type: 'cooker', specific: 'cooker_16_20a' };
    }
    if (rating === '') return { type: 'cooker', specific: 'cooker_32a' };
    return null;
  }

  if (designation.includes('shower')) {
    if (rating === '40' || rating === '45') return { type: 'shower', specific: 'shower_40a' };
    if (rating === '32') return { type: 'shower', specific: 'shower_32a' };
    if (rating === '') return { type: 'shower', specific: 'shower_32a' };
    return null;
  }

  if (
    designation.includes('immersion') ||
    designation.includes('water heater') ||
    designation.includes('hot water')
  ) {
    return { type: 'immersion', specific: 'water_heater_16_20a' };
  }

  if (designation.includes('radial')) {
    return { type: 'radial', specific: 'radial_16_20a' };
  }

  return null;
}
