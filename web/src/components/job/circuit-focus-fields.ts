/**
 * Shared circuit keyboard-accessory focus constants — WS7.
 *
 * ONE source of truth for the order in which the circuit-cell keyboard
 * accessory bar (LIM / N/A / prev / next / Done) traverses fields, and
 * which fields may take a LIM / N/A token. Imported by ALL THREE circuit
 * entry surfaces so none defines its own traversal order:
 *   - web/src/app/job/[id]/circuits/page.tsx      (CircuitCard)
 *   - web/src/components/job/circuits-sticky-table.tsx
 *   - web/src/components/job/circuits-schedule-desktop.tsx
 *
 * ─────────────────────────────────────────────────────────────────────
 * iOS canon (JobDetailView.swift):
 *   - Focus order is `Constants.circuitFieldOrder` MINUS
 *     `Constants.circuitDropdownFields` MINUS `Constants.circuitBooleanFields`.
 *     That derivation resolves to EXACTLY the 13-key ordered list below
 *     (`IOS_CIRCUIT_FOCUSABLE_FIELDS`). prev/next wrap across circuits at
 *     the field-list edges (JobDetailView.swift:987-1009); the arrows are
 *     disabled only at the very first field of the first circuit and the
 *     very last field of the last circuit.
 *   - LIM / N/A tokens are offered for EVERY focusable cell EXCEPT
 *     `circuit_ref` / `circuit_designation` (JobDetailView.swift:1070-1075:
 *     `let isTextCell = fieldKey == "circuit_ref" || "circuit_designation";
 *      if !isTextCell { LIM/N/A }`). Dropdown fields show no keyboard/
 *     toolbar at all on iOS.
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * The 13 iOS-focusable circuit fields, in iOS traversal order. This list
 * is EXACT — the surfaces' tests assert traversal follows this order, NOT
 * each surface's local column array or DOM order. Do not reorder without
 * a matching iOS `Constants.circuitFieldOrder` change.
 */
export const IOS_CIRCUIT_FOCUSABLE_FIELDS = [
  'circuit_ref',
  'circuit_designation',
  'number_of_points',
  'ocpd_max_zs_ohm',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'r1_r2_ohm',
  'r2_ohm',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
  'measured_zs_ohm',
  'rcd_time_ms',
] as const;

export type IosCircuitFocusableField = (typeof IOS_CIRCUIT_FOCUSABLE_FIELDS)[number];

/**
 * Fields eligible for a LIM / N/A token = the iOS focusable fields MINUS
 * `circuit_ref` / `circuit_designation` (the two text cells iOS excludes).
 * `CircuitKeyboardAccessory` shows LIM/N/A ONLY when the focused field is
 * in this set. WEB_EXTRA fields (below) are deliberately NOT here — iOS
 * never offers tokens on those dropdown-origin fields.
 */
export const CIRCUIT_ACCESSORY_TOKEN_FIELDS: readonly string[] =
  IOS_CIRCUIT_FOCUSABLE_FIELDS.filter((f) => f !== 'circuit_ref' && f !== 'circuit_designation');

/**
 * Web-extra keyboard-backed circuit fields (dated divergence — 2026-07-03,
 * WS7). These are fields iOS renders as DROPDOWNS/pickers (so they are NOT
 * in `IOS_CIRCUIT_FOCUSABLE_FIELDS`) but the web grids keep as free-text
 * keyboard `<input>`s — free-form cable sizes, ratings, BS/EN numbers, and
 * disconnect/IR-voltage values that are quicker to type than to pick on
 * web. Because they summon the soft keyboard, they MUST register with the
 * accessory/focus controller (else the keyboard appears with no toolbar or
 * cleanup) and DO get prev/next/Done — but they NEVER get LIM/N/A (iOS
 * offers no token there). Divergence recorded on ledger row
 * `crosscutting/keyboard-accessory-bar`.
 *
 * NOTE per-surface: some of these render as dropdown popovers on the
 * desktop schedule (`wiring_type`, `ref_method`, `ocpd_bs_en`, `rcd_bs_en`
 * use CIRCUIT_FIELD_OPTIONS there) — a surface only registers the ones it
 * actually renders as keyboard inputs. This list is the UNION across the
 * three surfaces.
 */
export const WEB_EXTRA_CIRCUIT_KEYBOARD_FIELDS: readonly string[] = [
  'wiring_type',
  'ref_method',
  'max_disconnect_time_s',
  'live_csa_mm2',
  'cpc_csa_mm2',
  'ocpd_bs_en',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'rcd_bs_en',
  'rcd_operating_current_ma',
  'rcd_rating_a',
  'ir_test_voltage_v',
];

/**
 * Canonical traversal spine: the 13 iOS-focusable fields IN iOS ORDER,
 * followed by the web-extra keyboard fields. Keeping the iOS 13 first
 * means prev/next over the core reading fields matches iOS exactly (e.g.
 * next after `number_of_points` is `ocpd_max_zs_ohm`, NOT the column
 * neighbour) — the web-extra fields trail the canon rather than
 * interleaving, an intentional ordering choice so the iOS-parity spine is
 * never perturbed by web-only fields. Each surface traverses the SUBSET of
 * this list that it actually renders as a keyboard input, in this order.
 */
export const CIRCUIT_FOCUS_ORDER: readonly string[] = [
  ...IOS_CIRCUIT_FOCUSABLE_FIELDS,
  ...WEB_EXTRA_CIRCUIT_KEYBOARD_FIELDS,
];

const CIRCUIT_FOCUS_INDEX = new Map<string, number>(CIRCUIT_FOCUS_ORDER.map((key, i) => [key, i]));

/**
 * Order an arbitrary set of a surface's keyboard-input field keys by the
 * shared canonical order. Unknown keys (none expected) sort to the end,
 * preserving their input order, so a surface never silently drops a field.
 */
export function orderCircuitFocusFields(keys: readonly string[]): string[] {
  const known = keys.filter((k) => CIRCUIT_FOCUS_INDEX.has(k));
  const unknown = keys.filter((k) => !CIRCUIT_FOCUS_INDEX.has(k));
  known.sort((a, b) => CIRCUIT_FOCUS_INDEX.get(a)! - CIRCUIT_FOCUS_INDEX.get(b)!);
  return [...known, ...unknown];
}

/** True when the focused field may take a LIM / N/A token. */
export function isCircuitTokenField(fieldKey: string): boolean {
  return CIRCUIT_ACCESSORY_TOKEN_FIELDS.includes(fieldKey);
}
