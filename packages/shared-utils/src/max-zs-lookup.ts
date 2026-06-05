/**
 * BS 7671 Maximum Earth Fault Loop Impedance (Zs) lookup.
 *
 * Mirrors iOS `MaxZsLookup.swift`. Table values are direct copies of
 * BS 7671 18th Edition Tables 41.2 / 41.3 / 41.4 — keep in lock-step
 * with the Swift file if a future amendment changes a row.
 *
 * Usage: pass an OCPD type code (`B`, `C`, `D`, `BS3036`, `BS1361`,
 * `BS88`, `RCBO`, or one of the historic aliases `1`/`2`/`gG`/`gM`/
 * `HRC`/`Rew`), a current rating in amps as a string, and an optional
 * disconnect-time string (`'5'` for the 5-second table; any other
 * value — typically `'0.4'` — picks the 0.4-second table).
 *
 * iOS canon: `MaxZsLookup.lookup` + `.maxZs`. Both surfaces are
 * re-exported here so call sites match the Swift API 1:1.
 *
 * RCBO defaults to Type B (most-common UK domestic RCBO trip
 * characteristic). Unknown device types fall through to a null return
 * rather than guessing — caller chooses whether to leave the column
 * blank or surface a "couldn't compute" warning.
 */

const TABLE_04S_VALUES: Record<string, number> = {
  // MCB Type B — BS EN 60898 / RCBOs BS EN 61009 — Table 41.2 (0.4s)
  B_6: 7.67,
  B_10: 4.6,
  B_13: 3.54,
  B_16: 2.87,
  B_20: 2.3,
  B_25: 1.84,
  B_32: 1.44,
  B_40: 1.15,
  B_50: 0.92,
  B_63: 0.73,
  B_80: 0.57,
  B_100: 0.46,

  // MCB Type C — BS EN 60898 — Table 41.2 (0.4s)
  C_6: 3.83,
  C_10: 2.3,
  C_13: 1.77,
  C_16: 1.44,
  C_20: 1.15,
  C_25: 0.92,
  C_32: 0.72,
  C_40: 0.57,
  C_50: 0.46,
  C_63: 0.36,
  C_80: 0.29,
  C_100: 0.23,

  // MCB Type D — BS EN 60898 — Table 41.2 (0.4s)
  D_6: 1.92,
  D_10: 1.15,
  D_13: 0.88,
  D_16: 0.72,
  D_20: 0.57,
  D_25: 0.46,
  D_32: 0.36,
  D_40: 0.29,
  D_50: 0.23,
  D_63: 0.18,
  D_80: 0.14,
  D_100: 0.12,

  // BS 3036 Semi-enclosed (rewireable) fuses — Table 41.4 (0.4s)
  BS3036_5: 8.89,
  BS3036_15: 2.67,
  BS3036_20: 1.78,
  BS3036_30: 1.09,
  BS3036_45: 0.62,
  BS3036_60: 0.41,
  BS3036_100: 0.26,

  // BS 1361 Cartridge fuses — Table 41.4 (0.4s)
  BS1361_5: 9.58,
  BS1361_15: 2.8,
  BS1361_20: 1.85,
  BS1361_30: 1.09,
  BS1361_45: 0.6,
  BS1361_60: 0.39,
  BS1361_80: 0.27,
  BS1361_100: 0.19,

  // BS 88-2 / BS 88-3 HRC fuses (gG) — Table 41.4 (0.4s)
  BS88_6: 5.58,
  BS88_10: 5.33,
  BS88_16: 2.26,
  BS88_20: 1.77,
  BS88_25: 1.3,
  BS88_32: 0.93,
  BS88_40: 0.62,
  BS88_50: 0.47,
  BS88_63: 0.3,
  BS88_80: 0.22,
  BS88_100: 0.16,
  BS88_125: 0.12,
  BS88_160: 0.09,
  BS88_200: 0.07,
};

const TABLE_5S_VALUES: Record<string, number> = {
  // MCB Type B — Table 41.3 (5s)
  B_6: 12.78,
  B_10: 7.67,
  B_13: 5.9,
  B_16: 4.79,
  B_20: 3.83,
  B_25: 3.07,
  B_32: 2.4,
  B_40: 1.92,
  B_50: 1.53,
  B_63: 1.22,
  B_80: 0.96,
  B_100: 0.77,

  // MCB Type C — Table 41.3 (5s)
  C_6: 6.39,
  C_10: 3.83,
  C_13: 2.95,
  C_16: 2.4,
  C_20: 1.92,
  C_25: 1.53,
  C_32: 1.2,
  C_40: 0.96,
  C_50: 0.77,
  C_63: 0.61,
  C_80: 0.48,
  C_100: 0.38,

  // MCB Type D — Table 41.3 (5s)
  D_6: 3.19,
  D_10: 1.92,
  D_13: 1.47,
  D_16: 1.2,
  D_20: 0.96,
  D_25: 0.77,
  D_32: 0.6,
  D_40: 0.48,
  D_50: 0.38,
  D_63: 0.3,
  D_80: 0.24,
  D_100: 0.19,

  // BS 3036 Semi-enclosed — Table 41.4 (5s)
  BS3036_5: 17.78,
  BS3036_15: 5.22,
  BS3036_20: 3.56,
  BS3036_30: 2.19,
  BS3036_45: 1.2,
  BS3036_60: 0.82,
  BS3036_100: 0.49,

  // BS 1361 Cartridge — Table 41.4 (5s)
  BS1361_5: 17.78,
  BS1361_15: 5.58,
  BS1361_20: 3.71,
  BS1361_30: 2.19,
  BS1361_45: 1.2,
  BS1361_60: 0.78,
  BS1361_80: 0.53,
  BS1361_100: 0.37,

  // BS 88 HRC — Table 41.4 (5s)
  BS88_6: 13.49,
  BS88_10: 8.17,
  BS88_16: 5.11,
  BS88_20: 3.39,
  BS88_25: 2.42,
  BS88_32: 1.7,
  BS88_40: 1.2,
  BS88_50: 0.88,
  BS88_63: 0.58,
  BS88_80: 0.42,
  BS88_100: 0.3,
  BS88_125: 0.22,
  BS88_160: 0.16,
  BS88_200: 0.12,
};

/** Map an OCPD type code / dropdown value / historic alias to the
 *  canonical lookup-key prefix used in the table. RCBO defaults to
 *  Type B (most-common domestic RCBO). Unknown types pass through —
 *  the table lookup will then miss cleanly. */
function normaliseType(type: string): string {
  const t = type.trim().toUpperCase();
  switch (t) {
    case 'B':
      return 'B';
    case 'C':
      return 'C';
    case 'D':
      return 'D';
    case '1':
    case 'REW':
    case 'BS3036':
      return 'BS3036';
    case '2':
    case 'BS1361':
      return 'BS1361';
    case 'GG':
    case 'GM':
    case 'HRC':
    case 'BS88':
      return 'BS88';
    case 'RCBO':
      return 'B';
    default:
      return type;
  }
}

export interface MaxZsLookupArgs {
  deviceType: string;
  rating: string;
  /** Disconnect time as a string. `'5'` triggers the 5-second tables;
   *  any other value (typically `'0.4'`) uses the 0.4-second tables.
   *  Match iOS — string comparison rather than numeric, so callers
   *  pass whatever the user picked from the dropdown. */
  disconnectTime?: string;
}

/** Numeric lookup — returns the Max Zs in ohms, or `null` when the
 *  device type / rating pair isn't in the table. Mirrors iOS
 *  `MaxZsLookup.lookup`. */
export function maxZsLookup(args: MaxZsLookupArgs): number | null {
  const { deviceType, rating, disconnectTime } = args;
  const use5s = disconnectTime === '5';
  const table = use5s ? TABLE_5S_VALUES : TABLE_04S_VALUES;
  const key = `${normaliseType(deviceType)}_${rating}`;
  const value = table[key];
  return typeof value === 'number' ? value : null;
}

/** String variant for direct write to the `ocpd_max_zs_ohm` column —
 *  formats to 2 decimal places. Returns `null` on table miss so the
 *  caller can skip the write (avoids overwriting a value with empty
 *  string). Mirrors iOS `MaxZsLookup.maxZs`. */
export function maxZsString(args: MaxZsLookupArgs): string | null {
  const value = maxZsLookup(args);
  return value == null ? null : value.toFixed(2);
}
