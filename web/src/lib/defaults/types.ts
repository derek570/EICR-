/**
 * Phase B — Defaults full port (2026-05-03).
 *
 * Mirrors iOS canon:
 *   - CertMateUnified/Sources/Models/CertificateDefault.swift  (preset)
 *   - CertMateUnified/Sources/Models/CableDefault.swift        (cable size row)
 *   - CertMateUnified/Sources/Services/CertificateDefaultsService.swift
 *
 * iOS persists these to a local SQLite (GRDB) database; the PWA
 * persists them inside the existing `user_defaults.json` S3 blob
 * (`/api/settings/:userId/defaults`) under the namespaced keys
 * `presets` and `cable_defaults`. Co-locating with the legacy flat
 * field-defaults keeps the round-trip count to one PUT/GET per save.
 */

import type { JobDetail } from '../types';

/**
 * A preset captures a snapshot of a `JobDetail` that the inspector can
 * "apply" to a brand-new job to seed common values (premises
 * description, supply characteristics, common observations, inspection
 * outcomes, etc.). Stored as a full JobDetail blob — the iOS apply
 * helper does an only-fill-empty merge so applying a preset never
 * stomps a value the inspector has typed.
 *
 * Fields mirror `CertificateDefault.swift` exactly (snake_case for
 * wire-format parity with the rest of the API).
 */
export interface CertificateDefaultPreset {
  id: string;
  user_id: string;
  name: string;
  /** "EICR" | "EIC" — matches `CertificateType.rawValue` on iOS. */
  certificate_type: string;
  /** Full JobDetail snapshot. The applier reads it with an
   *  only-fill-empty merge — see `applyPresetToJob` in `apply-preset.ts`. */
  default_data: Partial<JobDetail>;
  /** Unix epoch (seconds), matches `Int64(Date().timeIntervalSince1970)`
   *  on iOS so a preset created on iOS sorts identically here. */
  last_modified: number;
}

/**
 * A cable size default is a single row of the lookup table that the
 * Circuits tab reads when auto-filling cable sizes. Keyed by
 * `circuit_type_key` — the iOS classifier matches a circuit's
 * `designation` + `ocpd_rating` to one of the known keys via
 * `matchCircuitType()`. Mirrors `CableDefault.swift`.
 */
export interface CableDefault {
  id: string;
  user_id: string;
  circuit_type_key: string;
  display_name: string;
  conductor_size: string | null;
  cpc_size: string | null;
  wiring_type: string | null;
  ref_method: string | null;
}

/**
 * The seed list ships with every install. Mirrors
 * `CertificateDefaultsService.defaultCableTypes` exactly so the
 * "match circuit by designation" classifier produces the same key on
 * iOS and the PWA.
 */
export const DEFAULT_CABLE_TYPES: ReadonlyArray<{
  key: string;
  name: string;
  conductor: string | null;
  cpc: string | null;
}> = [
  { key: 'socket_ring', name: 'Socket Ring Circuit', conductor: '2.5', cpc: '1.5' },
  { key: 'radial_16_20a', name: 'Radial Circuit (16-20A)', conductor: '2.5', cpc: '1.5' },
  { key: 'lighting_6a_upstairs', name: 'Lighting 6A Upstairs', conductor: '1.5', cpc: '1.0' },
  { key: 'lighting_6a_downstairs', name: 'Lighting 6A Downstairs', conductor: '1.5', cpc: '1.0' },
  { key: 'lighting_10a', name: 'Lighting 10A', conductor: '1.5', cpc: '1.0' },
  { key: 'cooker_16_20a', name: 'Cooker Circuit (16-20A)', conductor: '2.5', cpc: '1.5' },
  { key: 'cooker_32a', name: 'Cooker Circuit 32A', conductor: '6', cpc: '2.5' },
  { key: 'shower_32a', name: 'Shower Circuit 32A', conductor: '6', cpc: '2.5' },
  { key: 'shower_40a', name: 'Shower Circuit 40A', conductor: '10', cpc: '4' },
  {
    key: 'water_heater_16_20a',
    name: 'Water Heater Radial (16-20A)',
    conductor: '2.5',
    cpc: '1.5',
  },
  { key: 'generic_6a', name: 'Generic 6A Circuit', conductor: '1.5', cpc: '1.0' },
  { key: 'generic_10a', name: 'Generic 10A Circuit', conductor: '1.5', cpc: '1.0' },
  { key: 'generic_16a', name: 'Generic 16A Circuit', conductor: '2.5', cpc: '1.5' },
  { key: 'generic_20a', name: 'Generic 20A Circuit', conductor: '2.5', cpc: '1.5' },
  { key: 'generic_32a', name: 'Generic 32A Circuit', conductor: '6', cpc: '2.5' },
  { key: 'generic_40a', name: 'Generic 40A Circuit', conductor: '10', cpc: '4' },
];

/** Cable size dropdown options — mirrors iOS `Constants.cableSizes`. */
export const CABLE_SIZE_OPTIONS = [
  '1.0',
  '1.5',
  '2.5',
  '4',
  '6',
  '10',
  '16',
  '25',
  '35',
  '50',
  '70',
  '95',
  '120',
] as const;

/** Wiring type dropdown — iOS `Constants.wiringTypes`. */
export const WIRING_TYPE_OPTIONS = [
  'PVC/PVC',
  'PVC SWA',
  'XLPE/SWA',
  'XLPE/LSF',
  'Singles in conduit',
  'Singles in trunking',
  'MICC',
  'FP200',
] as const;

/** Reference method dropdown — iOS `Constants.refMethods`. */
export const REF_METHOD_OPTIONS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  '100',
  '101',
  '102',
  '103',
] as const;
