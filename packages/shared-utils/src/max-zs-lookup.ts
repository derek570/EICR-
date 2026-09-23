import { canonicaliseOcpdStandard } from './ocpd-standard';

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

// ─────────────────────────────────────────────────────────────────────────
// PLAN-CC — standard-aware lookup, the tuple helper, and max-Zs provenance
// ─────────────────────────────────────────────────────────────────────────

/**
 * WHY A SECOND LOOKUP RATHER THAN A WIDER `normaliseType`
 * -------------------------------------------------------
 * `maxZsLookup` keys on the device TYPE alone, which was safe only while
 * `ocpd_bs_en` was a closed list of eight values that the type implied. It is
 * free text from PLAN-CC on, and the type no longer implies the standard: a
 * `BS 3871` breaker dictated with type `2` would otherwise read a BS 1361
 * cartridge-fuse row and print a max Zs for a different device class on a
 * legally significant certificate.
 *
 * So the tuple lookup is a CLOSED table of (standard, type) pairs and returns
 * null for everything else. It returns null far more often than the type-only
 * lookup — which is the point, and also why every write to any of the four
 * tuple members has to route through `recomputeMaxZsForOcpdTuple`: an
 * un-migrated site is MORE likely to leave a stale value behind after this
 * change, not less.
 *
 * `maxZsLookup` / `maxZsString` are left exactly as they are. They remain the
 * right call for a caller that genuinely has only a type and a rating.
 */

/** (standard → type → table key prefix). A type absent from a standard's row
 *  is NOT an oversight: `gM` and `aM` fuses have no 0.4 s / 5 s row in
 *  BS 7671 Table 41.4, so the honest answer for a gM BS 88-2 is null rather
 *  than the gG figure. */
const STANDARD_TYPE_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    'BS EN 60898': Object.freeze({ B: 'B', C: 'C', D: 'D' }),
    'BS EN 61009': Object.freeze({ B: 'B', C: 'C', D: 'D' }),
    'BS EN 62423': Object.freeze({ B: 'B', C: 'C', D: 'D' }),
    'BS 3036': Object.freeze({ REW: 'BS3036', '1': 'BS3036' }),
    'BS 1361': Object.freeze({ '2': 'BS1361' }),
    'BS 88-2': Object.freeze({ GG: 'BS88' }),
    'BS 88-3': Object.freeze({ GG: 'BS88' }),
    'BS EN 60269-2': Object.freeze({ GG: 'BS88' }),
    'BS EN 60269-3': Object.freeze({ GG: 'BS88' }),
  });

export interface OcpdTupleLookupArgs {
  /** Canonical `ocpd_bs_en`. An empty or unknown standard yields null for any
   *  NEW computation — the plan's "empty standard" row. */
  ocpdBsEn?: string | null;
  type?: string | null;
  rating?: string | null;
  /** `max_disconnect_time_s`. `'5'` picks the 5-second tables, as in
   *  `maxZsLookup`. */
  time?: string | null;
}

/** Numeric standard-aware lookup. Null whenever the (standard, type) pair has
 *  no row, the rating is not in that row, or either is missing. */
export function maxZsForOcpdTupleNumber(args: OcpdTupleLookupArgs): number | null {
  const standard = typeof args.ocpdBsEn === 'string' ? args.ocpdBsEn.trim() : '';
  const type = typeof args.type === 'string' ? args.type.trim() : '';
  const rating = typeof args.rating === 'string' ? args.rating.trim() : '';
  if (standard === '' || type === '' || rating === '') return null;
  const row = STANDARD_TYPE_KEYS[standard];
  if (!row) return null;
  const prefix = row[type.toUpperCase()];
  if (!prefix) return null;
  const time = typeof args.time === 'string' ? args.time : undefined;
  const table = time === '5' ? TABLE_5S_VALUES : TABLE_04S_VALUES;
  const value = table[`${prefix}_${rating}`];
  return typeof value === 'number' ? value : null;
}

/** String variant for direct write to `ocpd_max_zs_ohm` — two decimal places,
 *  byte-identical formatting to `maxZsString` so a row derived before this
 *  plan and re-derived after it produces the same characters. */
export function maxZsForOcpdTuple(args: OcpdTupleLookupArgs): string | null {
  const value = maxZsForOcpdTupleNumber(args);
  return value == null ? null : value.toFixed(2);
}

/** Provenance for `ocpd_max_zs_ohm`. Mirrors `OcpdMaxZsSource` in
 *  `@certmate/shared-types`; duplicated as a literal union here so
 *  `shared-utils` does not take a dependency on `shared-types`. */
export type MaxZsSource = 'auto' | 'manual';

/** The four tuple members plus the derived value and its provenance. Loose on
 *  purpose: web rows are plain objects that also carry every other circuit
 *  column, and every call site passes a whole row. */
export interface MaxZsRow {
  ocpd_bs_en?: unknown;
  ocpd_type?: unknown;
  ocpd_rating_a?: unknown;
  max_disconnect_time_s?: unknown;
  ocpd_max_zs_ohm?: unknown;
  ocpd_max_zs_source?: unknown;
  [key: string]: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Read the provenance key. The CSV boundary renders an absent cell as `''`
 *  (`parseCSV` uses `values[idx] || ''`), so `''` MUST read as absent — a row
 *  whose key is `''` is pre-plan data to preserve, not an `auto` row to
 *  recompute. */
export function readMaxZsSource(row: MaxZsRow): MaxZsSource | null {
  const raw = str(row.ocpd_max_zs_source).trim();
  return raw === 'auto' || raw === 'manual' ? raw : null;
}

function hasMaxZsValue(row: MaxZsRow): boolean {
  return str(row.ocpd_max_zs_ohm).trim() !== '';
}

/**
 * The ONE source-aware max-Zs writer. `source` is required and has no default:
 * a defaulted source is how a dictated value silently becomes recomputable.
 * Returns a new row — callers are immutable-style.
 */
export function writeMaxZs<T extends MaxZsRow>(row: T, value: string, source: MaxZsSource): T {
  return { ...row, ocpd_max_zs_ohm: value, ocpd_max_zs_source: source };
}

/**
 * The ONE max-Zs clear. Removes the value AND the key, so a cleared cell is
 * indistinguishable from a never-written one and the next tuple change starts
 * from a clean state rather than from a stale `auto`.
 *
 * `delete` rather than `''`: that is already what the generic field-clear path
 * does for every column, and the two are equivalent at every consumer here —
 * `hasValue` treats both as empty and `circuitsToCSV` writes an empty cell for
 * both.
 */
export function clearMaxZs<T extends MaxZsRow>(row: T): T {
  const next = { ...row };
  delete next.ocpd_max_zs_ohm;
  delete next.ocpd_max_zs_source;
  return next;
}

/** One local-only breadcrumb per helper-driven max-Zs change. Never spoken,
 *  never sent: web logs it through the recording logger's `console.debug` and
 *  iOS through `AppLogger` (OSLog) — deliberately NOT `DebugLogger`, whose
 *  lines go to the streaming WS sink and are uploaded as session analytics. */
export interface MaxZsChange {
  circuitRef: string;
  fromValue: string;
  toValue: string;
  fromStandard: string;
  toStandard: string;
  source: MaxZsSource | null;
}

export type MaxZsChangeLogger = (change: MaxZsChange) => void;

/**
 * Recompute a row's derived max Zs after a write to any of the four tuple
 * members. This is the ONLY automatic writer of `ocpd_max_zs_ohm`.
 *
 * The three provenance states get three different answers, and the difference
 * is the whole point of the key:
 *
 *   `manual`  — never touched. A hand-entered value that happens to equal the
 *               lookup is still the inspector's value; deciding "auto-derived"
 *               by equality is what silently deleted it before this plan.
 *   `auto`    — recomputed; cleared when the new tuple has no row.
 *   ABSENT    — PRESERVED, value and all. The row is pre-plan data of unknown
 *               origin, the compatibility marker asks the inspector to confirm
 *               or recompute, and nothing here guesses on their behalf.
 *
 * An empty cell is filled only when the new tuple actually computes, and the
 * fill is recorded as `auto`.
 *
 * @param before the row BEFORE this turn's writes, or undefined for a row
 *   created this turn (which has no derived history). Used only for the log
 *   breadcrumb and the standard-change detail — the decision is taken from
 *   `after` and its provenance key, never from value equality.
 */
export function recomputeMaxZsForOcpdTuple<T extends MaxZsRow>(
  before: T | undefined,
  after: T,
  log?: MaxZsChangeLogger
): T {
  const source = readMaxZsSource(after);
  const occupied = hasMaxZsValue(after);

  // `manual` is never touched, occupied or not.
  if (source === 'manual') return after;
  // Pre-plan data of unknown origin is preserved as-is.
  if (source === null && occupied) return after;

  const computed = maxZsForOcpdTuple({
    ocpdBsEn: str(after.ocpd_bs_en),
    type: str(after.ocpd_type),
    rating: str(after.ocpd_rating_a),
    time: str(after.max_disconnect_time_s),
  });

  const current = str(after.ocpd_max_zs_ohm).trim();
  if (computed == null) {
    if (!occupied) return after;
    // An `auto` row whose tuple no longer has a row: the derived value is
    // stale and a stale max Zs feeds a false circuit result.
    log?.({
      circuitRef: str(after.circuit_ref) || str(after.number),
      fromValue: current,
      toValue: '',
      fromStandard: str(before?.ocpd_bs_en),
      toStandard: str(after.ocpd_bs_en),
      source,
    });
    return clearMaxZs(after);
  }

  if (current === computed) return after;
  log?.({
    circuitRef: str(after.circuit_ref) || str(after.number),
    fromValue: current,
    toValue: computed,
    fromStandard: str(before?.ocpd_bs_en),
    toStandard: str(after.ocpd_bs_en),
    source,
  });
  return writeMaxZs(after, computed, 'auto');
}

/**
 * Compatibility status for one row's max Zs. Shared by both grid renderers,
 * the mobile card, the iOS cell and both PDF preflights so a warning the
 * inspector sees on screen is the same judgement the preflight makes.
 *
 * Never blocks a save and is never spoken.
 */
export type OcpdMaxZsStatus = 'ok' | 'manual_mismatch' | 'manual_uncheckable' | 'unverified';

export function ocpdMaxZsStatus(row: MaxZsRow): OcpdMaxZsStatus | null {
  if (!hasMaxZsValue(row)) return null;
  const source = readMaxZsSource(row);
  if (source === null) return 'unverified';
  if (source === 'auto') return 'ok';
  const computed = maxZsForOcpdTuple({
    ocpdBsEn: str(row.ocpd_bs_en),
    type: str(row.ocpd_type),
    rating: str(row.ocpd_rating_a),
    time: str(row.max_disconnect_time_s),
  });
  // A tuple with no lookup row establishes NOTHING about the stored value.
  // Calling that a mismatch was a false claim in two ordinary cases: an
  // unreadable standard preserved by an import, and a perfectly readable one
  // with no BS 7671 row (`BS 3871`). The inspector was told their figure
  // "does not match" a comparison that never happened.
  if (computed == null) return 'manual_uncheckable';
  return str(row.ocpd_max_zs_ohm).trim() === computed ? 'ok' : 'manual_mismatch';
}

/**
 * PLAN-CC — the STANDARD's own compatibility status, which is separate from
 * the max Zs's and is reachable when the max Zs is empty.
 *
 * The standard-write boundary table says an automatic ingress preserves an
 * unreadable standard "as-is, row marker". The max-Zs status cannot carry that:
 * it returns null the moment the cell is empty, so a CCU photo or a document
 * import that wrote `There is no RCBO` into `ocpd_bs_en` on a row with no max
 * Zs produced no marker anywhere and no preflight line — the inspector was
 * never told to look at it, which is the silent-drop outcome in a different
 * shape.
 *
 * `unreadable` means the canonicaliser could not read the stored value. It is
 * a QUESTION, not an error: the value is kept exactly as it arrived, because
 * at an import there is nobody to re-ask and refusing it would lose a reading.
 */
export function ocpdStandardStatus(row: MaxZsRow): 'unreadable' | null {
  const stored = str(row.ocpd_bs_en).trim();
  if (stored === '') return null;
  return canonicaliseOcpdStandard(stored) == null ? 'unreadable' : null;
}

/** Pinned warning copy. Byte-identical on both clients and in both preflights
 *  — the fixture test compares these strings, not a description of them. */
export function ocpdStandardWarningText(circuitRef: string, row: MaxZsRow): string | null {
  if (ocpdStandardStatus(row) == null) return null;
  return `Circuit ${circuitRef}: OCPD standard ${str(row.ocpd_bs_en).trim()} was stored as recorded and is not a recognised form — check it before issuing`;
}

/**
 * Every compatibility line this row owes the inspector, in a fixed order:
 * the standard first (it is the cause when both fire), then the max Zs.
 *
 * ONE function so a surface cannot render one and forget the other. Both PDF
 * preflights and both grid markers call it.
 */
export function ocpdRowWarnings(circuitRef: string, row: MaxZsRow): string[] {
  const out: string[] = [];
  const standard = ocpdStandardWarningText(circuitRef, row);
  if (standard) out.push(standard);
  const maxZs = ocpdMaxZsWarningText(circuitRef, row);
  if (maxZs) out.push(maxZs);
  return out;
}

export function ocpdMaxZsWarningText(circuitRef: string, row: MaxZsRow): string | null {
  const status = ocpdMaxZsStatus(row);
  const value = str(row.ocpd_max_zs_ohm).trim();
  if (status === 'manual_mismatch' || status === 'manual_uncheckable') {
    // Only the parts the row actually carries, so an empty standard does not
    // produce a doubled space in a line the inspector reads on the PDF.
    const tuple = [str(row.ocpd_bs_en).trim(), str(row.ocpd_type).trim()]
      .filter((part) => part !== '')
      .join(' ');
    const rating = str(row.ocpd_rating_a).trim();
    const device = [tuple, rating === '' ? '' : `${rating} A`].filter((p) => p !== '').join(' ');
    const subject = device === '' ? 'the OCPD on this circuit' : device;
    if (status === 'manual_uncheckable') {
      return `Circuit ${circuitRef}: max Zs ${value} was entered by hand and cannot be checked against ${subject}`;
    }
    return `Circuit ${circuitRef}: max Zs ${value} was entered by hand and does not match ${subject}`;
  }
  if (status === 'unverified') {
    return `Circuit ${circuitRef}: max Zs ${value} has no recorded source — confirm or recompute`;
  }
  return null;
}

/**
 * The ONE manual-edit commit route: grid cell, keyboard accessory, picker and
 * the desktop column bulk fill all go through here.
 *
 * Three things happen in a fixed order, and the order is the contract:
 *   1. A max-Zs cell in the patch is a HUMAN edit, so it is written `manual`
 *      (or cleared outright, key and all, when the edit empties the cell).
 *      Nothing else in this file can produce `manual` from a keystroke.
 *   2. An `ocpd_bs_en` in the patch canonicalises on commit, so what the
 *      inspector typed and what a dictated equivalent stores are one string.
 *      A value the grammar cannot read is stored exactly as typed — a picker
 *      is a manual boundary and a human typed it deliberately.
 *   3. The tuple is recomputed once, after the whole patch lands, so a patch
 *      that changes two members produces one decision rather than two.
 *
 * Callers that would otherwise spread `{ ...row, [field]: value }` for an
 * arbitrary column must use this instead: that generic form is exactly how a
 * bulk fill or an accessory write used to leave a stale derived value behind.
 */
export function applyOcpdAwarePatch<T extends MaxZsRow>(
  row: T,
  patch: Record<string, unknown>,
  canonicaliseStandard?: (value: string) => string,
  log?: MaxZsChangeLogger
): T {
  let next = { ...row } as T;
  let touchedTuple = false;

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'ocpd_max_zs_ohm') {
      const text = typeof value === 'string' ? value.trim() : '';
      next = text === '' ? clearMaxZs(next) : writeMaxZs(next, text, 'manual');
      continue;
    }
    if (key === 'ocpd_bs_en' && typeof value === 'string' && canonicaliseStandard) {
      (next as MaxZsRow)[key] = value.trim() === '' ? value : canonicaliseStandard(value);
      touchedTuple = true;
      continue;
    }
    (next as MaxZsRow)[key] = value;
    if (
      key === 'ocpd_bs_en' ||
      key === 'ocpd_type' ||
      key === 'ocpd_rating_a' ||
      key === 'max_disconnect_time_s'
    ) {
      touchedTuple = true;
    }
  }

  return touchedTuple ? recomputeMaxZsForOcpdTuple(row, next, log) : next;
}
