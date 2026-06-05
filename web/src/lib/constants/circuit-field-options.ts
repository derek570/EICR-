/**
 * Pre-populated option lists for circuit fields. Mirrors
 * `config/field_schema.json` `circuit_fields[*].options` and iOS
 * `Sources/Utilities/Constants.swift`. Single source of truth so the
 * desktop schedule, card view, and table view all stay in sync.
 *
 * When adding a new field with presets, add it here AND in
 * `config/field_schema.json` so backend validation + Sonnet extraction
 * stay aligned with the picker UI.
 */

export type CircuitFieldKey =
  | 'wiring_type'
  | 'ref_method'
  | 'ocpd_bs_en'
  | 'ocpd_type'
  | 'rcd_bs_en'
  | 'rcd_type'
  | 'polarity_confirmed'
  | 'rcd_button_confirmed'
  | 'afdd_button_confirmed';

export const CIRCUIT_FIELD_OPTIONS: Record<CircuitFieldKey, readonly string[]> = {
  wiring_type: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'O'],
  ref_method: ['A', 'B', 'C', 'D', 'E', 'F', 'G', '100', '101', '102', '103'],
  ocpd_bs_en: [
    'BS EN 60898',
    'BS EN 61009',
    'BS EN 60947-2',
    'BS EN 60947-3',
    'BS EN 60269-2',
    'BS 3036',
    'BS 1361',
    'N/A',
  ],
  ocpd_type: ['B', 'C', 'D', 'gG', 'gM', 'aM', 'HRC', 'Rew', 'N/A'],
  rcd_bs_en: ['BS EN 61008', 'BS EN 61009', 'BS EN 62423', 'N/A'],
  rcd_type: ['AC', 'A', 'F', 'B', 'S', 'N/A'],
  polarity_confirmed: ['OK', 'Y', 'N'],
  rcd_button_confirmed: ['OK', 'Y', 'N'],
  afdd_button_confirmed: ['OK', 'Y', 'N'],
};

export function hasOptions(key: string): key is CircuitFieldKey {
  return key in CIRCUIT_FIELD_OPTIONS;
}

/** iOS-aligned spare detection — see transcript-field-matcher.ts:974. */
export function isSpareCircuit(c: Record<string, unknown>): boolean {
  const v = c['circuit_designation'];
  return typeof v === 'string' && v.trim().toLowerCase() === 'spare';
}
