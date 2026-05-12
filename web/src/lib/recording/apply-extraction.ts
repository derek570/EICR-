/**
 * Map a Sonnet extraction result onto a JobDetail patch.
 *
 * Responsibilities:
 *   1. Route each reading to the correct section of the job (supply,
 *      board, installation, extent, design, or the matching circuit
 *      row) based on field name.
 *   2. Apply 3-tier priority: pre-existing manual/CCU values win over
 *      fresh Sonnet readings. Sonnet's own de-dup lives server-side; we
 *      re-check here in case the server-side state snapshot lagged
 *      behind a user edit.
 *   3. Apply `circuit_updates` — create or rename a CircuitRow so
 *      subsequent readings have somewhere to land.
 *   4. Append `observations` not already present.
 *
 * Returns a partial `JobDetail` patch, or null if nothing changed so
 * the caller can skip an `updateJob` cycle (avoids needless re-renders
 * when Sonnet returns an empty result).
 */

import type { CircuitRow, JobDetail, ObservationRow } from '../types';
import type {
  CircuitUpdate,
  ExtractedReading,
  ExtractionResult,
  FieldClear,
  Observation,
} from './sonnet-session';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';

type Section =
  | 'supply_characteristics'
  | 'board_info'
  | 'installation_details'
  | 'extent_and_type'
  | 'design_construction';

/**
 * Wire field name (post-`validateAndCorrectFields` on the backend) →
 * `CircuitRow` column name on the PWA.
 *
 * The backend's `validateAndCorrectFields` (src/extraction/sonnet-stream.js)
 * rewrites every per-circuit reading from Sonnet's modern
 * `config/field_schema.json` keys to the iOS-legacy names that iOS
 * Build 282's `applySonnetReadings` switch consumes natively. The wire
 * contract is therefore iOS-legacy.
 *
 * The PWA's circuit table (`web/src/components/job/circuits-schedule-
 * desktop.tsx`) reads the MODERN names. Without translation, every
 * Sonnet per-circuit reading lands in `row[legacy]` while the UI reads
 * `row[modern]` — invisible to the inspector. Field session
 * `sess_mp2cacfh_xlur` (2026-05-12) repro'd the symptom across all per-
 * circuit fields: 3 successful `create_circuit` tool calls, 4 extraction
 * frames decoded with `circuit_updates: 0` and no rendered values.
 *
 * Source of truth — backend `FIELD_CORRECTIONS` table at
 * `src/extraction/sonnet-stream.js:774-848`. Mirrored here as a reverse
 * map (legacy → modern) so a future schema drift on either side fails
 * the regression test in `tests/apply-extraction.test.ts` rather than
 * silently dropping values.
 *
 * Why not translate on the backend: per project rule, the backend +
 * shared types are immutable during parity work — iOS is canon for
 * the data contract. Any wire-shape adjustment lands on the PWA only.
 */
const LEGACY_TO_PWA_CIRCUIT_FIELD: Record<string, string> = {
  designation: 'circuit_designation',
  ocpd_rating: 'ocpd_rating_a',
  cable_size: 'live_csa_mm2',
  cable_size_earth: 'cpc_csa_mm2',
  zs: 'measured_zs_ohm',
  r2: 'r2_ohm',
  r1_plus_r2: 'r1_r2_ohm',
  ring_continuity_r1: 'ring_r1_ohm',
  ring_continuity_rn: 'ring_rn_ohm',
  ring_continuity_r2: 'ring_r2_ohm',
  insulation_resistance_l_e: 'ir_live_earth_mohm',
  insulation_resistance_l_l: 'ir_live_live_mohm',
  ir_test_voltage: 'ir_test_voltage_v',
  rcd_trip_time: 'rcd_time_ms',
  ocpd_breaking_capacity: 'ocpd_breaking_capacity_ka',
  max_disconnect_time: 'max_disconnect_time_s',
  polarity: 'polarity_confirmed',
};

/** Translate a wire field name to its PWA column counterpart. Returns
 *  the input unchanged when the field is already in the modern shape
 *  (e.g. `ocpd_type`, `rcd_rating_a`, `wiring_type` — these pass
 *  through `KNOWN_FIELDS` on the backend without rewrite). */
function translateCircuitField(wireField: string): string {
  return LEGACY_TO_PWA_CIRCUIT_FIELD[wireField] ?? wireField;
}

/**
 * Wire field → PWA column counterpart for circuit-0 readings (supply,
 * installation, board sections).
 *
 * Mirror class of bug to LEGACY_TO_PWA_CIRCUIT_FIELD above, but on the
 * tabs above the circuits table. The backend wire ships iOS-legacy
 * short names (`ze`, `pfc`, `main_earth_conductor_csa`,
 * `main_bonding_conductor_csa`, `general_condition`). The Supply tab
 * (`web/src/app/job/[id]/supply/page.tsx`) and Installation tab
 * (`web/src/app/job/[id]/installation/page.tsx`) read modern long
 * names. Without translation, Sonnet's supply / install readings land
 * on keys the tab pages don't render.
 *
 * IMPORTANT — applyCircuit0Readings writes under BOTH the wire name AND
 * the PWA-column name. The wire name keeps the existing LiveFillView
 * during-recording rendering working (`web/src/components/live-fill/
 * live-fill-view.tsx` reads `supply.ze`, `supply.pfc`, etc. directly).
 * The PWA-column write makes the Supply / Installation tabs render
 * the value post-recording. Writing both is additive — same value,
 * two keys, until the PWA settles on a single naming convention.
 */
const LEGACY_TO_PWA_SECTION_FIELD: Record<string, string> = {
  // Supply
  ze: 'earth_loop_impedance_ze',
  pfc: 'prospective_fault_current',
  main_earth_conductor_csa: 'earthing_conductor_csa',
  main_bonding_conductor_csa: 'main_bonding_csa',
  // Installation
  general_condition: 'general_condition_of_installation',
  // Extent (EIC) — backend KNOWN_FIELDS emits `extent_of_installation`
  // routed to `extent_and_type`, the Extent tab
  // (`web/src/app/job/[id]/extent/page.tsx`) reads `extent` from
  // that section. Without translation the EIC Extent of Work
  // field renders empty post-recording.
  extent_of_installation: 'extent',
};

/**
 * Fields whose primary `CIRCUIT_0_SECTION` routing is `board_info`
 * (matches LiveFillView's `board.*` reads) but which the Supply tab
 * (`web/src/app/job/[id]/supply/page.tsx`) ALSO renders. Without a
 * mirror write, dictating "main switch is 100 amps" lands in
 * `job.board_info.main_switch_current` (visible in LiveFillView during
 * recording) but the Supply tab — which reads
 * `job.supply_characteristics.main_switch_current` — stays empty post-
 * recording.
 *
 * Mirror approach (not routing replacement): same value written to
 * both sections so neither consumer regresses. Membership derived by
 * intersecting the `CIRCUIT_0_SECTION === 'board_info'` set with the
 * field names actually grep'd out of `supply/page.tsx`.
 *
 * Deliberately EXCLUDED:
 *   - `manufacturer` — Supply tab doesn't render it; the Board tab
 *     reads `boards[i].manufacturer` not `board_info.manufacturer`,
 *     so this needs a separate `board_info → boards[0]` mirror
 *     (out-of-scope architectural fix).
 *   - `rcd_operating_*_test` variants — inspector-typed only, never
 *     emitted by Sonnet's `record_reading`, so no apply path here.
 */
const MIRROR_BOARD_TO_SUPPLY: ReadonlySet<string> = new Set([
  'main_switch_bs_en',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',
]);

/**
 * Fields written to `board_info` or `supply_characteristics` that the
 * Board tab also reads from the active `boards[i]` record. iOS's
 * multi-board work (2026-05-07 sprint) moved board-level data into
 * `job.boards[]`; the PWA Board tab reads from there
 * (`web/src/app/job/[id]/board/page.tsx:95-101` —
 * `const boards = job.boards ?? []`, then `text('manufacturer')`,
 * `text('main_switch_bs_en')`, `text('earthing_arrangement')`,
 * `text('ze')`, `text('zs_at_db')` on the active board record).
 *
 * The Sonnet apply path currently writes only to the legacy
 * `board_info` / `supply_characteristics` singletons — so dictating
 * "Wylex Amendment 3" lands in `job.board_info.manufacturer` and
 * LiveFillView shows it, but the Board tab (reading
 * `boards[0].manufacturer`) is empty post-recording.
 *
 * This map declares the {source-section, source-key, target boards[i]
 * key} mirror triples. Each entry is also applied to `boards[0]`
 * after the primary section write. Multi-board sessions
 * (`boards.length > 1`) are intentionally skipped — they need
 * `board_id` routing per reading (Phase 2 of the multi-board parity
 * push). For single-board sessions (`boards.length <= 1`), this
 * mirror closes the visible gap.
 *
 * Source of truth: backend KNOWN_FIELDS (sonnet-stream.js:651+) for
 * what Sonnet emits, and `board/page.tsx` `text(...)` calls for what
 * the UI reads. Both sides are grep-pinned by tests in
 * `apply-extraction-boards-mirror.test.ts`.
 */
const MIRROR_TO_BOARDS0: ReadonlyArray<{
  section: Section;
  sectionKey: string;
  boardKey: string;
}> = [
  { section: 'board_info', sectionKey: 'manufacturer', boardKey: 'manufacturer' },
  { section: 'board_info', sectionKey: 'main_switch_bs_en', boardKey: 'main_switch_bs_en' },
  {
    section: 'supply_characteristics',
    sectionKey: 'earthing_arrangement',
    boardKey: 'earthing_arrangement',
  },
  { section: 'supply_characteristics', sectionKey: 'ze', boardKey: 'ze' },
  { section: 'supply_characteristics', sectionKey: 'zs_at_db', boardKey: 'zs_at_db' },
];

// ─────────────────────────────────────────────────────────────────────────
// Field routing for circuit: 0 (supply / installation / etc.)
//
// Keep this in sync with the `KNOWN_FIELDS` + field_reference.md tables
// on the server. Anything unmapped falls through to `supply` as a
// best-effort default — inspectors can manually move it if it lands in
// the wrong tab.
// ─────────────────────────────────────────────────────────────────────────
const CIRCUIT_0_SECTION: Record<string, Section> = {
  // Supply
  ze: 'supply_characteristics',
  pfc: 'supply_characteristics',
  earthing_arrangement: 'supply_characteristics',
  main_earth_conductor_csa: 'supply_characteristics',
  main_bonding_conductor_csa: 'supply_characteristics',
  bonding_water: 'supply_characteristics',
  bonding_gas: 'supply_characteristics',
  bonding_oil: 'supply_characteristics',
  bonding_structural_steel: 'supply_characteristics',
  bonding_lightning: 'supply_characteristics',
  bonding_other: 'supply_characteristics',
  earth_electrode_type: 'supply_characteristics',
  earth_electrode_resistance: 'supply_characteristics',
  earth_electrode_location: 'supply_characteristics',
  earthing_conductor_material: 'supply_characteristics',
  earthing_conductor_continuity: 'supply_characteristics',
  main_bonding_material: 'supply_characteristics',
  main_bonding_continuity: 'supply_characteristics',
  supply_voltage: 'supply_characteristics',
  nominal_voltage: 'supply_characteristics',
  nominal_voltage_u: 'supply_characteristics',
  nominal_voltage_uo: 'supply_characteristics',
  supply_frequency: 'supply_characteristics',
  nominal_frequency: 'supply_characteristics',
  supply_polarity_confirmed: 'supply_characteristics',
  live_conductors: 'supply_characteristics',
  number_of_supplies: 'supply_characteristics',
  zs_at_db: 'supply_characteristics',
  // Board / Main Switch / SPD
  main_switch_bs_en: 'board_info',
  main_switch_current: 'board_info',
  main_switch_fuse_setting: 'board_info',
  main_switch_poles: 'board_info',
  main_switch_voltage: 'board_info',
  main_switch_location: 'board_info',
  main_switch_conductor_material: 'board_info',
  main_switch_conductor_csa: 'board_info',
  rcd_operating_current: 'board_info',
  rcd_time_delay: 'board_info',
  rcd_operating_time: 'board_info',
  spd_bs_en: 'board_info',
  spd_type_supply: 'board_info',
  spd_short_circuit: 'board_info',
  spd_rated_current: 'board_info',
  manufacturer: 'board_info',
  // Installation
  address: 'installation_details',
  postcode: 'installation_details',
  town: 'installation_details',
  county: 'installation_details',
  client_name: 'installation_details',
  client_address: 'installation_details',
  client_postcode: 'installation_details',
  client_town: 'installation_details',
  client_county: 'installation_details',
  client_phone: 'installation_details',
  client_email: 'installation_details',
  reason_for_report: 'installation_details',
  occupier_name: 'installation_details',
  date_of_inspection: 'installation_details',
  date_of_previous_inspection: 'installation_details',
  previous_certificate_number: 'installation_details',
  estimated_age_of_installation: 'installation_details',
  general_condition: 'installation_details',
  next_inspection_years: 'installation_details',
  premises_description: 'installation_details',
  // Extent (EIC)
  extent_of_installation: 'extent_and_type',
  installation_type: 'extent_and_type',
  // Design (EIC)
  departures_from_bs7671: 'design_construction',
  departure_details: 'design_construction',
  design_comments: 'design_construction',
};

function routeSupplyField(field: string): Section {
  return CIRCUIT_0_SECTION[field] ?? 'supply_characteristics';
}

/** Non-empty / non-null check used by the 3-tier priority guard. */
export function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'boolean' || typeof v === 'number') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}

/** Apply all readings belonging to circuit 0. Returns a map of
 *  section → merged record that can be folded into the final patch. */
function applyCircuit0Readings(
  job: JobDetail,
  readings: ExtractedReading[]
): Partial<Record<Section, Record<string, unknown>>> {
  const bySection: Partial<Record<Section, Record<string, unknown>>> = {};

  for (const reading of readings) {
    if (reading.circuit !== 0 || !reading.field) continue;
    const primarySection = routeSupplyField(reading.field);
    const pwaColumn = LEGACY_TO_PWA_SECTION_FIELD[reading.field];

    // Section targets: always the primary. Plus `supply_characteristics`
    // when the field belongs to MIRROR_BOARD_TO_SUPPLY (main switch /
    // SPD / supply RCD) — preserves LiveFillView's `board.*` reads
    // while ALSO populating the Supply tab's `supply.*` reads.
    const targets: Section[] = [primarySection];
    if (
      primarySection === 'board_info' &&
      MIRROR_BOARD_TO_SUPPLY.has(reading.field) &&
      !targets.includes('supply_characteristics')
    ) {
      targets.push('supply_characteristics');
    }

    // 3-tier priority — protect any pre-existing user value across
    // EVERY target section, under BOTH wire and PWA-column names.
    // The inspector might have typed "100" into the Supply tab's
    // Main Switch Current field; that landed in
    // `supply_characteristics.main_switch_current`. A subsequent
    // Sonnet reading routed primarily to `board_info` must NOT clobber
    // it just because the board section is empty.
    let userValueKept = false;
    for (const sec of targets) {
      const existing = (job[sec] as Record<string, unknown> | undefined) ?? {};
      if (hasValue(existing[reading.field])) {
        userValueKept = true;
        break;
      }
      if (pwaColumn && hasValue(existing[pwaColumn])) {
        userValueKept = true;
        break;
      }
    }
    if (userValueKept) {
      pipelineLog('apply_section_reading_user_value_kept', {
        primary_section: primarySection,
        targets,
        wire_field: reading.field,
        pwa_column: pwaColumn ?? null,
      });
      continue;
    }

    // Write to every target under the wire name + the PWA column name
    // (when the latter exists and differs).
    for (const sec of targets) {
      const sectionPatch: Record<string, unknown> = {
        ...(bySection[sec] ?? {}),
        [reading.field]: reading.value,
      };
      if (pwaColumn && pwaColumn !== reading.field) {
        sectionPatch[pwaColumn] = reading.value;
      }
      bySection[sec] = sectionPatch;
    }

    if (targets.length > 1) {
      pipelineLog('apply_section_mirrored', {
        wire_field: reading.field,
        primary_section: primarySection,
        mirrored_to: targets.slice(1),
      });
    }
    if (pwaColumn && pwaColumn !== reading.field) {
      pipelineLog('apply_section_field_translated', {
        primary_section: primarySection,
        targets,
        wire_field: reading.field,
        pwa_column: pwaColumn,
      });
    }
  }

  // Fold in per-section updates, preserving other keys on the section.
  for (const section of Object.keys(bySection) as Section[]) {
    const existing = (job[section] as Record<string, unknown> | undefined) ?? {};
    bySection[section] = { ...existing, ...bySection[section] };
  }

  return bySection;
}

/** Apply per-circuit readings. Returns a new circuits array if any
 *  changes were made, or null for no-op. Creates a new row for any
 *  circuit number we haven't seen yet so subsequent readings have a
 *  stable id to land on. */
function applyCircuitReadings(
  job: JobDetail,
  readings: ExtractedReading[],
  circuitUpdates: CircuitUpdate[],
  fieldClears: FieldClear[]
): CircuitRow[] | null {
  const perCircuitReadings = readings.filter((r) => r.circuit >= 1 && r.field);
  const hasCircuitUpdate = circuitUpdates.some((u) => u.circuit >= 1);
  const hasPerCircuitClear = fieldClears.some((c) => c.circuit >= 1);

  pipelineLog('apply_circuits_entry', {
    per_circuit_readings: perCircuitReadings.length,
    circuit_updates_raw: circuitUpdates.length,
    circuit_updates_qualifying: circuitUpdates.filter((u) => u.circuit >= 1).length,
    per_circuit_clears: fieldClears.filter((c) => c.circuit >= 1).length,
    existing_circuits: Array.isArray(job.circuits) ? job.circuits.length : 0,
  });

  if (perCircuitReadings.length === 0 && !hasCircuitUpdate && !hasPerCircuitClear) {
    pipelineLog('apply_circuits_exit_noop', {
      reason: 'no_qualifying_input',
      // Wire-shape audit — if `circuit_updates` arrived but none
      // qualified, dump the keys actually present on the first entry so
      // we can immediately see whether the backend is using the
      // iOS-flavoured {op, circuit_ref, meta} shape instead of the
      // PWA-flavoured {action, circuit, designation} we read.
      first_update_keys:
        circuitUpdates.length > 0
          ? Object.keys(circuitUpdates[0] as unknown as Record<string, unknown>)
          : [],
    });
    return null;
  }

  const circuits = [...((job.circuits as CircuitRow[] | undefined) ?? [])];
  const indexByRef = new Map<string, number>();
  circuits.forEach((row, idx) => {
    const ref = row.circuit_ref ?? row.number;
    if (typeof ref === 'string' && ref) indexByRef.set(ref, idx);
  });

  const ensureRow = (circuitNum: number): number => {
    const ref = String(circuitNum);
    const existingIdx = indexByRef.get(ref);
    if (existingIdx != null) return existingIdx;
    const id = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${circuitNum}`;
    const row: CircuitRow = { id, circuit_ref: ref, circuit_designation: '' };
    circuits.push(row);
    indexByRef.set(ref, circuits.length - 1);
    return circuits.length - 1;
  };

  // Apply circuit_updates (create / rename designation) first so
  // readings against renamed circuits land on the right row.
  for (const upd of circuitUpdates) {
    const obj = upd as unknown as Record<string, unknown>;
    if (upd.circuit < 1 || !upd.designation) {
      pipelineLog('apply_circuit_update_skipped', {
        reason:
          upd.circuit < 1
            ? typeof upd.circuit === 'undefined'
              ? 'circuit_undefined'
              : 'circuit_lt_1'
            : 'designation_missing_or_empty',
        keys: Object.keys(obj),
        circuit: upd.circuit,
        action: upd.action,
        designation_present: typeof upd.designation === 'string' && upd.designation.length > 0,
      });
      continue;
    }
    const idx = ensureRow(upd.circuit);
    const row = circuits[idx];
    if (upd.action === 'rename' || !hasValue(row.circuit_designation)) {
      circuits[idx] = { ...row, circuit_designation: upd.designation };
      pipelineLog('apply_circuit_update_applied', {
        circuit: upd.circuit,
        action: upd.action,
        designation_length: upd.designation.length,
        designation_preview: upd.designation.slice(0, 40),
        rowCreated: idx === circuits.length - 1,
      });
    } else {
      pipelineLog('apply_circuit_update_user_value_kept', {
        circuit: upd.circuit,
        existing_designation_preview:
          typeof row.circuit_designation === 'string' ? row.circuit_designation.slice(0, 40) : null,
      });
    }
  }

  for (const reading of perCircuitReadings) {
    const idx = ensureRow(reading.circuit);
    const row = circuits[idx];
    // Translate iOS-legacy wire field name → PWA column name. Pass-through
    // when already modern. See LEGACY_TO_PWA_CIRCUIT_FIELD docstring above.
    const column = translateCircuitField(reading.field);
    if (column !== reading.field) {
      pipelineLog('apply_circuit_field_translated', {
        circuit: reading.circuit,
        wire_field: reading.field,
        pwa_column: column,
      });
    }
    // 3-tier priority — keep the user's value if they've already typed
    // one into the field.
    if (hasValue(row[column])) {
      pipelineLog('apply_circuit_reading_user_value_kept', {
        circuit: reading.circuit,
        pwa_column: column,
      });
      continue;
    }
    circuits[idx] = {
      ...row,
      [column]: reading.value as unknown,
    };
  }

  for (const clear of fieldClears) {
    if (clear.circuit < 1 || !clear.field) continue;
    const idx = indexByRef.get(String(clear.circuit));
    if (idx == null) continue;
    const row = { ...circuits[idx] };
    // Same legacy → PWA translation as readings above so a Sonnet
    // `clear_reading` lands on the column the UI actually renders.
    const column = translateCircuitField(clear.field);
    delete row[column];
    circuits[idx] = row;
  }

  return circuits;
}

/** Fold new observations into the existing array. Dedupes by
 *  case-insensitive `observation_text` so Sonnet re-asking about the
 *  same defect doesn't create duplicates.
 *
 *  Captures `observation_id` (server-assigned UUID) into row.server_id
 *  so a follow-up `observation_update` (BPG4 refinement) can patch the
 *  exact row even after the visible text changes. Also captures
 *  `regulation` for the same reason — pre-refinement extractions may
 *  include it, and post-refinement updates reliably will. */
function applyObservations(job: JobDetail, observations: Observation[]): ObservationRow[] | null {
  if (observations.length === 0) return null;
  const existing = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const seen = new Set(
    existing.map((o) => (o.description ?? '').trim().toLowerCase()).filter(Boolean)
  );
  let changed = false;
  for (const obs of observations) {
    const text = (obs.observation_text ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = globalThis.crypto?.randomUUID?.() ?? `obs-${Date.now()}-${existing.length + 1}`;
    const code = parseObservationCode(obs.code);
    const row: ObservationRow = {
      id,
      code,
      description: text,
      location: obs.item_location ?? undefined,
    };
    if (obs.observation_id) row.server_id = obs.observation_id;
    if (obs.regulation) row.regulation = obs.regulation;
    if (obs.schedule_item) row.schedule_item = obs.schedule_item;
    existing.push(row);
    changed = true;
  }
  return changed ? existing : null;
}

/**
 * Apply a Sonnet `observation_update` (BPG4 refinement) to the job's
 * observations[]. Mirrors iOS handleObservationUpdate
 * (DeepgramRecordingViewModel.swift:4954) byte-for-byte:
 *
 *   1. Try `server_id` match first (preferred — exact identity).
 *   2. Fall back to fuzzy text match on `original_text` (or
 *      `observation_text` for older servers): >70 % word-Set overlap.
 *   3. CREATE-from-miss: if no row matches, append a new observation
 *      from the update payload (text + code + regulation +
 *      schedule_item). This handles the case where the initial
 *      extraction was de-duplicated/dropped on the client but the
 *      refinement still needs to land on the cert. Pre-fix that
 *      observation simply vanished.
 *
 * Returns the updated array (with the patched / created row) or null
 * if no change was applicable (invalid code on a CREATE-from-miss).
 */
export function applyObservationUpdate(
  job: JobDetail,
  update: {
    observation_id?: string | null;
    observation_text: string;
    original_text?: string | null;
    code: string;
    regulation?: string | null;
    schedule_item?: string | null;
  }
): ObservationRow[] | null {
  const existing = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const fuzzyKey = (update.original_text ?? update.observation_text ?? '').toLowerCase().trim();
  let matchIndex = -1;
  if (update.observation_id) {
    matchIndex = existing.findIndex((o) => o.server_id === update.observation_id);
  }
  if (matchIndex < 0 && fuzzyKey.length > 0) {
    // Last-match wins — newer observations are at the end of the array,
    // which is what iOS does (`lastIndex(where:)`). Avoids patching an
    // older row when the inspector raised the same defect twice in a
    // long session.
    const targetWords = new Set(fuzzyKey.split(/\s+/).filter(Boolean));
    if (targetWords.size > 0) {
      for (let i = existing.length - 1; i >= 0; i--) {
        const existingText = (existing[i].description ?? '').toLowerCase().trim();
        if (existingText === fuzzyKey) {
          matchIndex = i;
          break;
        }
        const existingWords = new Set(existingText.split(/\s+/).filter(Boolean));
        let overlap = 0;
        for (const w of targetWords) if (existingWords.has(w)) overlap += 1;
        // >70 % word overlap (iOS canon — set-based so duplicates don't
        // double-count). Avoids false-positives on short generic phrases.
        if (overlap / targetWords.size > 0.7) {
          matchIndex = i;
          break;
        }
      }
    }
  }
  const code = parseObservationCode(update.code);
  if (matchIndex < 0) {
    // CREATE-from-miss. Skip if the code is unrecognised — without a
    // valid observation_code we can't render the row in the cert.
    if (!code) return null;
    const id = globalThis.crypto?.randomUUID?.() ?? `obs-${Date.now()}-${existing.length + 1}`;
    const newRow: ObservationRow = {
      id,
      code,
      description: update.observation_text.trim() || (update.original_text ?? '').trim(),
    };
    if (update.observation_id) newRow.server_id = update.observation_id;
    if (update.regulation) newRow.regulation = update.regulation;
    if (update.schedule_item) newRow.schedule_item = update.schedule_item;
    existing.push(newRow);
    return existing;
  }
  // UPDATE existing row. Code/regulation always overwrite when non-empty
  // because the refinement is authoritative for those fields. Text
  // overwrites only when it's non-empty AND different (older servers
  // echo the original — no-op edit avoids polluting history). Mirrors
  // the guards at iOS lines 5051–5072.
  const before = existing[matchIndex];
  let changed = false;
  const next: ObservationRow = { ...before };
  if (code && code !== before.code) {
    next.code = code;
    changed = true;
  }
  if (update.regulation && update.regulation !== before.regulation) {
    next.regulation = update.regulation;
    changed = true;
  }
  const trimmedText = update.observation_text.trim();
  if (
    trimmedText.length > 0 &&
    trimmedText.toLowerCase() !== (before.description ?? '').toLowerCase().trim()
  ) {
    next.description = trimmedText;
    changed = true;
  }
  if (update.schedule_item && update.schedule_item !== before.schedule_item) {
    next.schedule_item = update.schedule_item;
    changed = true;
  }
  // Stamp the server_id when the existing row was created without one
  // (e.g. the initial extraction lost the id). Future updates can then
  // use the fast id path.
  if (update.observation_id && !before.server_id) {
    next.server_id = update.observation_id;
    changed = true;
  }
  if (!changed) return null;
  existing[matchIndex] = next;
  return existing;
}

export function parseObservationCode(
  raw: string | undefined
): 'C1' | 'C2' | 'C3' | 'FI' | undefined {
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === 'C1' || upper === 'C2' || upper === 'C3' || upper === 'FI') {
    return upper;
  }
  return undefined;
}

/** Sections whose flat records feed LiveFillState section keys. */
const SCALAR_SECTIONS: Section[] = [
  'installation_details',
  'supply_characteristics',
  'board_info',
  'extent_and_type',
  'design_construction',
];

/** Diff two section records and emit dot-path keys for any value that
 *  changed. Only reports keys whose new value passes `hasValue` — zero
 *  / empty strings / nulls get suppressed so the flash doesn't fire on
 *  a no-op re-assignment from Sonnet. */
function diffSectionKeys(
  section: Section,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): string[] {
  if (!after) return [];
  const prev = before ?? {};
  const keys: string[] = [];
  for (const field of Object.keys(after)) {
    if (prev[field] !== after[field] && hasValue(after[field])) {
      keys.push(`${section}.${field}`);
    }
  }
  return keys;
}

/** Diff circuits arrays. Emits `circuit.{id}.{field}` for each cell that
 *  changed, plus a whole-row key `circuit.{id}` when a new circuit row
 *  was created so the UI can flash the whole row. */
function diffCircuitKeys(
  before: CircuitRow[] | undefined,
  after: CircuitRow[] | undefined
): string[] {
  if (!after) return [];
  const prevById = new Map<string, CircuitRow>();
  (before ?? []).forEach((row) => prevById.set(row.id, row));
  const keys: string[] = [];
  for (const row of after) {
    const prev = prevById.get(row.id);
    if (!prev) {
      // Newly-created row — flash the whole row plus every filled cell.
      keys.push(`circuit.${row.id}`);
      for (const field of Object.keys(row)) {
        if (field === 'id') continue;
        if (hasValue(row[field])) keys.push(`circuit.${row.id}.${field}`);
      }
      continue;
    }
    for (const field of Object.keys(row)) {
      if (field === 'id') continue;
      if (prev[field] !== row[field] && hasValue(row[field])) {
        keys.push(`circuit.${row.id}.${field}`);
      }
    }
  }
  return keys;
}

/**
 * Mirror selected circuit:0 readings into the `boards[]` array so the
 * Board tab (which reads `job.boards[i]`) renders Sonnet-extracted
 * board-level fields. Iterates over readings (not the section patch
 * map) because per-reading `board_id` is the authoritative routing
 * key for multi-board jobs:
 *
 *   - `reading.board_id` present → find `boards[i].id === board_id`;
 *     when not found (orphan id) the reading is logged and skipped so
 *     a stale wire reference can't synthesise a phantom board record.
 *   - `reading.board_id` absent → fall back to `boards[0]`. If
 *     `boards.length > 1` AND the reading is targetable (in
 *     MIRROR_BOARD_KEYS), skip and log: ambiguous default routing on
 *     a multi-board job needs an explicit board_id, never a guess.
 *   - `boards.length === 0` AND fall-back path → synthesise
 *     `boards[0]` with `{id: UUID, board_type: 'main'}` and the
 *     qualifying mirror values. Matches the Board tab's `newBoard()`
 *     shape.
 *
 * Per-reading priority guard: never overwrites a value already typed
 * into the matching board record under the same key.
 *
 * Returns the updated `boards[]` array when any field landed, or null
 * for no-op (no qualifying readings; orphan ids; user values
 * preserved).
 */
function mirrorReadingsToBoards(
  job: JobDetail,
  readings: ExtractedReading[]
): Record<string, unknown>[] | null {
  const existingBoards = ((job.boards as Record<string, unknown>[] | undefined) ?? []).slice();
  // Index existing boards by id for O(1) lookup. Skip entries without
  // an id (shouldn't happen but be defensive).
  const indexById = new Map<string, number>();
  existingBoards.forEach((b, i) => {
    const id = typeof b.id === 'string' ? b.id : null;
    if (id) indexById.set(id, i);
  });

  // Resolved per-board updates accumulator. Keyed by board index so
  // multiple readings on the same board coalesce into one patch.
  const updatesByIndex = new Map<number, Record<string, unknown>>();
  // Tracks whether we've already synthesised a default board[0] so a
  // second fall-back reading lands on the same synthesised record.
  let syntheticDefaultIdx: number | null = null;

  for (const reading of readings) {
    if (reading.circuit !== 0 || !reading.field) continue;
    const mirror = MIRROR_TO_BOARDS0.find((m) => m.sectionKey === reading.field);
    if (!mirror) continue;

    // Source-section priority — if the inspector has already typed a
    // value into the corresponding section (under the wire name OR
    // the PWA column name), `applyCircuit0Readings` will have skipped
    // it. The board mirror MUST skip in lock-step so a section-
    // protected reading doesn't sneak into boards[] via the
    // reading-driven path.
    const sourceSection = job[mirror.section] as Record<string, unknown> | undefined;
    if (sourceSection) {
      const pwaCol = LEGACY_TO_PWA_SECTION_FIELD[reading.field];
      if (hasValue(sourceSection[reading.field]) || (pwaCol && hasValue(sourceSection[pwaCol]))) {
        pipelineLog('apply_boards_mirror_skipped_source_section_user_value', {
          field: reading.field,
          source_section: mirror.section,
        });
        continue;
      }
    }

    let targetIdx: number;
    if (reading.board_id != null && reading.board_id !== '') {
      const found = indexById.get(reading.board_id);
      if (found == null) {
        pipelineLog('apply_boards_mirror_orphan_board_id', {
          board_id: reading.board_id,
          field: reading.field,
        });
        continue;
      }
      targetIdx = found;
    } else {
      // No board_id — default routing to boards[0]. Refuse to guess
      // for multi-board jobs.
      if (existingBoards.length > 1) {
        pipelineLog('apply_boards_mirror_skipped_ambiguous_multi_board', {
          boards_count: existingBoards.length,
          field: reading.field,
        });
        continue;
      }
      if (existingBoards.length === 0) {
        // Synthesise boards[0] on first fall-back reading.
        if (syntheticDefaultIdx == null) {
          const id = globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}`;
          existingBoards.push({ id, board_type: 'main' });
          syntheticDefaultIdx = existingBoards.length - 1;
          pipelineLog('apply_boards_mirror_synthesized_board0', { id });
        }
        targetIdx = syntheticDefaultIdx;
      } else {
        targetIdx = 0;
      }
    }

    // Priority guard — read the live target board (including any
    // updates already collected this turn) so multiple readings can
    // safely coalesce, but pre-existing user values block.
    const targetBoard = existingBoards[targetIdx] ?? {};
    const pendingUpdates = updatesByIndex.get(targetIdx) ?? {};
    const currentValue = pendingUpdates[mirror.boardKey] ?? targetBoard[mirror.boardKey];
    if (hasValue(currentValue)) {
      pipelineLog('apply_boards_mirror_user_value_kept', {
        target_index: targetIdx,
        board_key: mirror.boardKey,
      });
      continue;
    }

    pendingUpdates[mirror.boardKey] = reading.value;
    updatesByIndex.set(targetIdx, pendingUpdates);
  }

  if (updatesByIndex.size === 0) return null;

  // Apply collected updates onto the boards slice. Return a new array
  // so the patch is a fresh reference (React change detection).
  const out: Record<string, unknown>[] = existingBoards.map((b, i) => {
    const upd = updatesByIndex.get(i);
    return upd ? { ...b, ...upd } : b;
  });

  pipelineLog('apply_boards_mirror_applied', {
    touched_indexes: Array.from(updatesByIndex.keys()),
    fields_per_index: Object.fromEntries(
      Array.from(updatesByIndex.entries()).map(([i, u]) => [i, Object.keys(u)])
    ),
  });

  return out;
}

/** Diff observations. Emits `observation.{id}` for each new row. We
 *  don't bother diffing fields within an existing observation — Sonnet
 *  never amends observations, it only appends them. */
function diffObservationKeys(
  before: ObservationRow[] | undefined,
  after: ObservationRow[] | undefined
): string[] {
  if (!after) return [];
  const prevIds = new Set((before ?? []).map((o) => o.id));
  return after.filter((o) => !prevIds.has(o.id)).map((o) => `observation.${o.id}`);
}

export type AppliedExtraction = {
  patch: Partial<JobDetail>;
  /** Dot-path keys for every field that actually changed vs the job
   *  state the patch was computed against. Feeds LiveFillState so the
   *  LiveFillView can flash exactly the cells Sonnet filled. */
  changedKeys: string[];
};

/** Public entry point — returns the JobDetail patch + a flat list of
 *  dot-path keys describing which fields actually changed, or null if
 *  the extraction was effectively empty. Any field_clears on circuit 0
 *  are honoured too (they delete the key from the matching section). */
export function applyExtractionToJob(
  job: JobDetail,
  result: ExtractionResult
): AppliedExtraction | null {
  const readings = result.readings ?? [];
  const circuitUpdates = result.circuit_updates ?? [];
  const fieldClears = result.field_clears ?? [];
  const observations = result.observations ?? [];

  pipelineLog('apply_extraction_entry', {
    readings: readings.length,
    circuit_updates: circuitUpdates.length,
    field_clears: fieldClears.length,
    observations: observations.length,
    existing_circuits: Array.isArray(job.circuits) ? job.circuits.length : 0,
  });

  const patch: Partial<JobDetail> = {};

  // Circuit 0 readings — split by section.
  const supplyPatches = applyCircuit0Readings(job, readings);
  for (const section of Object.keys(supplyPatches) as Section[]) {
    const merged = supplyPatches[section];
    if (merged) patch[section] = merged;
  }

  // Circuit 0 field_clears — delete key from the right section.
  for (const clear of fieldClears) {
    if (clear.circuit !== 0 || !clear.field) continue;
    const section = routeSupplyField(clear.field);
    const existing =
      (patch[section] as Record<string, unknown> | undefined) ??
      (job[section] as Record<string, unknown> | undefined) ??
      {};
    if (clear.field in existing) {
      const next = { ...existing };
      delete next[clear.field];
      patch[section] = next;
    }
  }

  // Per-circuit readings + updates + clears.
  const newCircuits = applyCircuitReadings(job, readings, circuitUpdates, fieldClears);
  if (newCircuits) patch.circuits = newCircuits;

  // Board mirror — populate the right entry in `boards[]` so the
  // Board tab renders Sonnet-extracted manufacturer, main_switch_bs_en,
  // earthing_arrangement, ze, zs_at_db. Iterates over readings so
  // each one's `board_id` controls which board record receives the
  // value. Multi-board jobs without a board_id are deliberately
  // skipped — the apply path refuses to guess.
  const newBoards = mirrorReadingsToBoards(job, readings);
  if (newBoards) patch.boards = newBoards;

  // Observations.
  const newObservations = applyObservations(job, observations);
  if (newObservations) patch.observations = newObservations;

  if (Object.keys(patch).length === 0) {
    pipelineLog('apply_extraction_exit_no_patch', {
      readings: readings.length,
      circuit_updates: circuitUpdates.length,
      field_clears: fieldClears.length,
      observations: observations.length,
    });
    return null;
  }

  // Compute changedKeys by diffing the patched sections against the
  // pre-patch job. We diff instead of reading the readings array so the
  // flash stays accurate even if the extractor grows new fields or the
  // routing map drifts.
  const changedKeys: string[] = [];
  for (const section of SCALAR_SECTIONS) {
    changedKeys.push(
      ...diffSectionKeys(
        section,
        job[section] as Record<string, unknown> | undefined,
        patch[section] as Record<string, unknown> | undefined
      )
    );
  }
  if (patch.circuits) {
    changedKeys.push(...diffCircuitKeys(job.circuits, patch.circuits));
  }
  if (patch.observations) {
    changedKeys.push(...diffObservationKeys(job.observations, patch.observations));
  }

  pipelineLog('apply_extraction_exit', {
    patch_sections: Object.keys(patch),
    changed_keys: changedKeys.length,
    new_circuit_count: Array.isArray(patch.circuits) ? patch.circuits.length : null,
    new_observation_count: Array.isArray(patch.observations) ? patch.observations.length : null,
  });

  return { patch, changedKeys };
}
