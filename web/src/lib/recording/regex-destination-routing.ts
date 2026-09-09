/**
 * ONE destination-routing function for every regex consumer (A02D, Codex
 * diff-review cycle 1 BLOCKER 2).
 *
 * The matcher emits `supply.<field>`, `board.<field>`, `install.<field>` and
 * `circuit.<ref>.<field>` keys. The apply router stores some "supply" fields
 * under `board_info` (`main_switch_*`, `spd_*`), translates one installation
 * field name (`general_condition_of_installation` → `general_condition`) and
 * resolves a circuit REF to a row. Before this module the freshness gate
 * (`canonicalDestinationKey`) re-derived those rules on its own: it rejected
 * the five board-routed supply fields (their labels live under `board.*`) —
 * dropping valid matches before the value gates — and resolved a duplicate
 * circuit ref with `Array.find` (first row) while the apply router used
 * `Map.set` (last row), so a two-board job with "circuit 4" on both boards
 * could evaluate freshness against one row and write the other.
 *
 * Every consumer — matcher provenance, cutoff identity, clarification
 * naming, application — now routes through `resolveRegexDestination`.
 *
 * Duplicate circuit refs resolve by BOARD, never by array order:
 *  1. the row on the ACTIVE board (`current_board_changed`), when known;
 *  2. otherwise the row on the job's first board (the default board);
 *  3. otherwise a row with no `board_id` (legacy single-board rows);
 *  4. otherwise the first row in job order.
 */
import type { JobDetail, CircuitRow } from '@/lib/types';
import type { RegexMatchResult } from './regex-match-result';

export type RegexSectionTarget = 'supply_characteristics' | 'board_info' | 'installation_details';
export type RegexTarget = RegexSectionTarget | 'circuit';
export type RegexTrackerScope = 'supply' | 'board' | 'install' | 'circuit';

export interface RegexDestinationRoute {
  /** Id-based tracker key (`supply.ze`, `board.main_switch_current`,
   *  `install.general_condition`, `circuit.<rowId>.<field>`). */
  readonly trackerKey: string;
  readonly target: RegexTarget;
  readonly fieldKey: string;
  /** circuit target only — index into `job.circuits`. */
  readonly circuitIdx?: number;
}

export const SUPPLY_FIELD_TO_KEY: Record<
  keyof NonNullable<RegexMatchResult['supply_updates']>,
  string
> = {
  ze: 'ze',
  pfc: 'pfc',
  earthing_arrangement: 'earthing_arrangement',
  supply_polarity_confirmed: 'supply_polarity_confirmed',
  main_earth_csa: 'main_earth_csa',
  bonding_csa: 'bonding_csa',
  bonding_water: 'bonding_water',
  bonding_gas: 'bonding_gas',
  main_bonding_continuity: 'main_bonding_continuity',
  earth_electrode_type: 'earth_electrode_type',
  earth_electrode_resistance: 'earth_electrode_resistance',
  nominal_voltage: 'nominal_voltage',
  nominal_frequency: 'nominal_frequency',
  main_switch_bs_en: 'main_switch_bs_en',
  main_switch_current: 'main_switch_current',
  main_switch_conductor_csa: 'main_switch_conductor_csa',
  // Supply protective device / DNO cutout / "main fuse" (Option A — distinct
  // from the consumer-unit main switch). surge-protection-box 2026-06-17.
  spd_bs_en: 'spd_bs_en',
  spd_rated_current: 'spd_rated_current',
};

export const BOARD_FIELD_TO_KEY: Record<
  keyof NonNullable<RegexMatchResult['board_updates']>,
  string
> = {
  manufacturer: 'manufacturer',
  ze_at_db: 'ze_at_db',
};

// Section assignment for board / supply field routing — main_switch_*
// lives on board_info, the rest on supply_characteristics. Ze-at-DB is
// routed to board_info (mirrors iOS, where boardUpdates.zeAtDb is the
// board-end Zs).
export const SUPPLY_FIELD_SECTION: Record<string, RegexSectionTarget> = {
  main_switch_bs_en: 'board_info',
  main_switch_current: 'board_info',
  main_switch_conductor_csa: 'board_info',
  // spd_* (main fuse) mirrors the main_switch_* live-fill convention — the
  // LiveFillView reads board_info during recording. surge-protection-box.
  spd_bs_en: 'board_info',
  spd_rated_current: 'board_info',
};

export const INSTALLATION_FIELD_TO_KEY: Record<
  keyof NonNullable<RegexMatchResult['installation_updates']>,
  string
> = {
  client_name: 'client_name',
  premises_description: 'premises_description',
  next_inspection_years: 'next_inspection_years',
  client_phone: 'client_phone',
  client_email: 'client_email',
  reason_for_report: 'reason_for_report',
  occupier_name: 'occupier_name',
  date_of_previous_inspection: 'date_of_previous_inspection',
  previous_certificate_number: 'previous_certificate_number',
  estimated_age_of_installation: 'estimated_age_of_installation',
  general_condition_of_installation: 'general_condition',
  date_of_inspection: 'date_of_inspection',
};

/**
 * Storage ALIAS FAMILIES per canonical section field (Codex diff-review
 * cycle 2, BLOCKER 0). One freshness identity, several stored keys: the
 * wire/legacy key the extraction layer and LiveFill use, plus the PWA-column
 * key the Supply / Installation pages edit
 * (`apply-extraction.ts LEGACY_TO_PWA_SECTION_FIELD` dual-writes the same
 * pairs). Every consumer that reads, diffs or writes a destination goes
 * through the family: a manual clear of the VISIBLE alias is a clear of the
 * destination, and a regex write lands on every alias.
 *
 * Order: canonical first, UI aliases after. The EFFECTIVE value prefers the
 * UI alias — the inspector's view — so a cleared page field reads as empty
 * even while the wire key still carries the old value.
 */
export const SECTION_FIELD_ALIASES: Readonly<
  Record<RegexSectionTarget, Readonly<Record<string, readonly string[]>>>
> = {
  supply_characteristics: {
    ze: ['ze', 'earth_loop_impedance_ze'],
    pfc: ['pfc', 'prospective_fault_current'],
  },
  board_info: {},
  installation_details: {
    general_condition: ['general_condition', 'general_condition_of_installation'],
  },
};

/** Every stored key for a canonical section field (`[fieldKey]` when it
 *  has no alias). */
export function aliasFamily(target: RegexSectionTarget, fieldKey: string): readonly string[] {
  return SECTION_FIELD_ALIASES[target][fieldKey] ?? [fieldKey];
}

const CANONICAL_BY_ALIAS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const target of Object.keys(SECTION_FIELD_ALIASES) as RegexSectionTarget[]) {
    for (const [canonical, family] of Object.entries(SECTION_FIELD_ALIASES[target])) {
      for (const alias of family) out.set(`${target}.${alias}`, canonical);
    }
  }
  return out;
})();

/** The canonical field for a stored key (itself when it is not an alias). */
export function canonicalFieldForAlias(target: RegexSectionTarget, storedKey: string): string {
  return CANONICAL_BY_ALIAS.get(`${target}.${storedKey}`) ?? storedKey;
}

function isEmptyValue(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * The destination's EFFECTIVE stored value. The most UI-ward alias that is
 * PRESENT on the section (own key, even when empty) is authoritative — the
 * inspector's page is the truth once it has written the key, so a visible
 * field cleared to '' reads as empty even while the wire key still carries
 * the old value. A section that never had the UI key (data written only to
 * the wire key) falls back to the wire key. Null when empty.
 */
export function readEffectiveSectionValue(
  section: Record<string, unknown> | null | undefined,
  target: RegexSectionTarget,
  fieldKey: string
): unknown {
  if (!section) return null;
  const family = aliasFamily(target, fieldKey);
  for (let i = family.length - 1; i >= 0; i--) {
    const alias = family[i];
    if (!Object.prototype.hasOwnProperty.call(section, alias)) continue;
    const v = section[alias];
    return isEmptyValue(v) ? null : v;
  }
  return null;
}

const SECTION_SCOPE: Record<RegexSectionTarget, Exclude<RegexTrackerScope, 'circuit'>> = {
  supply_characteristics: 'supply',
  board_info: 'board',
  installation_details: 'install',
};

/** Route a SECTION matcher field (`supply` / `board` / `install` scope). */
export function routeSectionField(
  scope: Exclude<RegexTrackerScope, 'circuit'>,
  matcherField: string
): Omit<RegexDestinationRoute, 'circuitIdx'> {
  let fieldKey = matcherField;
  let target: RegexSectionTarget;
  if (scope === 'supply') {
    fieldKey =
      SUPPLY_FIELD_TO_KEY[matcherField as keyof typeof SUPPLY_FIELD_TO_KEY] ?? matcherField;
    target = SUPPLY_FIELD_SECTION[matcherField] ?? 'supply_characteristics';
  } else if (scope === 'board') {
    fieldKey = BOARD_FIELD_TO_KEY[matcherField as keyof typeof BOARD_FIELD_TO_KEY] ?? matcherField;
    target = 'board_info';
  } else {
    fieldKey =
      INSTALLATION_FIELD_TO_KEY[matcherField as keyof typeof INSTALLATION_FIELD_TO_KEY] ??
      matcherField;
    target = 'installation_details';
  }
  return { trackerKey: `${SECTION_SCOPE[target]}.${fieldKey}`, target, fieldKey };
}

function rowBoardId(row: CircuitRow): string | null {
  const id = (row as { board_id?: unknown }).board_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Index circuit rows by `circuit_ref`, one row per ref, resolving duplicate
 * refs by board (see the module doc). Deterministic for a given job and
 * active board; never by first/last array position when a board rule applies.
 */
export function indexCircuitRowsByRef(
  job: JobDetail,
  activeBoardId: string | null = null
): Map<string, number> {
  const circuits = job.circuits ?? [];
  const byRef = new Map<string, number[]>();
  circuits.forEach((row, idx) => {
    const ref = (row as { circuit_ref?: unknown }).circuit_ref;
    if (typeof ref !== 'string') return;
    const list = byRef.get(ref) ?? [];
    list.push(idx);
    byRef.set(ref, list);
  });
  const defaultBoardId = (() => {
    const first = (job.boards ?? [])[0] as { id?: unknown } | undefined;
    return typeof first?.id === 'string' && first.id ? first.id : null;
  })();
  const out = new Map<string, number>();
  for (const [ref, idxs] of byRef) {
    if (idxs.length === 1) {
      out.set(ref, idxs[0]);
      continue;
    }
    const pick =
      (activeBoardId ? idxs.find((i) => rowBoardId(circuits[i]) === activeBoardId) : undefined) ??
      (defaultBoardId ? idxs.find((i) => rowBoardId(circuits[i]) === defaultBoardId) : undefined) ??
      idxs.find((i) => rowBoardId(circuits[i]) === null) ??
      idxs[0];
    out.set(ref, pick);
  }
  return out;
}

/**
 * Resolve a matcher destination key to its routed tracker key and target.
 * Returns null for a circuit ref with no row (out of scope — exactly the
 * rows the apply router skips) or a malformed key.
 */
export function resolveRegexDestination(
  matcherKey: string,
  job: JobDetail,
  activeBoardId: string | null = null,
  rowIndex?: ReadonlyMap<string, number>
): RegexDestinationRoute | null {
  if (matcherKey.startsWith('circuit.')) {
    const rest = matcherKey.slice('circuit.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return null;
    const ref = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    const idx = (rowIndex ?? indexCircuitRowsByRef(job, activeBoardId)).get(ref);
    if (idx === undefined) return null;
    const row = (job.circuits ?? [])[idx];
    if (!row) return null;
    return {
      trackerKey: `circuit.${row.id}.${field}`,
      target: 'circuit',
      fieldKey: field,
      circuitIdx: idx,
    };
  }
  const dot = matcherKey.indexOf('.');
  if (dot <= 0) return null;
  const scope = matcherKey.slice(0, dot);
  const field = matcherKey.slice(dot + 1);
  if (scope !== 'supply' && scope !== 'board' && scope !== 'install') return null;
  if (!field) return null;
  return routeSectionField(scope, field);
}
