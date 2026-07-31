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
  BoardOp,
  CircuitUpdate,
  ExtractedReading,
  ExtractionResult,
  FieldClear,
  Observation,
} from './sonnet-session';
import type { ScheduleOutcome } from '@/lib/constants/inspection-schedule';
import { EIC_SCHEDULE, EICR_SCHEDULE } from '@/lib/constants/inspection-schedule';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';
import { resolveCanonicalMainBoardId, type MainBoardCandidate } from '@/lib/boards/canonical-main';
import {
  applyDefaultsToCircuit,
  clampImpedance,
  maxZsString,
  recomputeAll,
  type ImpedanceField,
} from '@certmate/shared-utils';
import {
  mergePendingPhotoIntoObservations,
  type PendingObservationPhoto,
} from './observation-photo';
import {
  CLIENT_ROUTABLE_READING_ROUTES,
  clientReadingRoute,
  type ClientReadingRoute,
} from './client-routable-reading-fields';

/**
 * Options threaded into the apply path. Currently carries the user's
 * circuit-field defaults so newly-created circuit rows arrive with
 * wiring type / OCPD BS EN / RCD BS EN / IR test voltage / max
 * disconnect time pre-filled — iOS canon
 * (`DefaultsService.applyDefaults` + `CertificateDefaultsService.
 * applyCableDefaults`). Optional: omitted by tests + legacy callers
 * skip the defaults pipeline.
 */
export interface ApplyExtractionOptions {
  userDefaults?: Record<string, string>;
  /** L2 obs-photo sprint — pending tuple captured during the current
   *  recording session that's waiting for an observation to claim
   *  it. When an observation lands within `OBSERVATION_PHOTO_LINK_WINDOW_MS`
   *  AND at least one new row was appended this turn, the LAST
   *  appended row's `.photos[]` gets the pending photo's filename
   *  (or `blobId` placeholder if the upload is still in flight per
   *  PLAN §Risks §1). iOS canon:
   *  `DeepgramRecordingViewModel.swift:5583-5593`. */
  pendingPhoto?: PendingObservationPhoto | null;
  /** Invoked after the forward-link succeeds. Caller is expected to
   *  clear `pendingPhotoRef` AND `clearPendingPhoto(jobId)` in IDB so
   *  the next turn doesn't try to attach the same photo a second
   *  time. Receives the `blobId` of the photo that was attached. */
  onPhotoAttached?: (blobId: string) => void;
  /** Invoked once per `applyExtractionToJob` call when at least one
   *  new observation was appended. The id + timestamp feed
   *  `recentObservationRef` in `recording-context.tsx`, which Phase 4's
   *  reverse-link reads to decide whether a fresh photo capture
   *  should skip the pending slot and attach to this observation
   *  directly. iOS canon:
   *  `DeepgramRecordingViewModel.swift:5596-5599`. */
  onLastObservationCreated?: (id: string, timestamp: number) => void;
}

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
 * Per-circuit columns that carry an impedance value (R1+R2, ring
 * continuity legs, bare R2). Map to the `clampImpedance` field
 * tag so the per-reading clamp picks the right bound band. Ze on
 * the circuit row itself is unusual (Ze is supply-level not per-
 * circuit) but listed for completeness — it'd land here only if
 * someone added a per-board Ze override column.
 *
 * `measured_zs_ohm` is DELIBERATELY ABSENT (plan D, id-100(b) web
 * companion, 2026-07-25). It used to sit here on the `continuity`
 * band `[0.01, 2.0]`, which silently divided any Zs above 2 Ω — so a
 * legitimate 5 Ω Zs on a long radial was written as 0.5, an order of
 * magnitude out, with nothing said aloud and nothing shown. That was a
 * WEB-ONLY defect: iOS has never clamped Zs, and the backend's own
 * range gate allows Zs 0–100 Ω (`src/extraction/value-enum-validator.js`),
 * so web was the only surface silently rewriting values the rest of the
 * system considers perfectly valid. Zs legitimately spans two orders of
 * magnitude (a sub-ohm final circuit to a tens-of-ohms TT installation),
 * which is exactly why no continuity-shaped band fits it.
 *
 * Do NOT re-add it, and do NOT assume the server picked the job up: Zs is
 * clamped on NO platform. Plan D's backend clamp set deliberately EXCLUDES
 * `measured_zs_ohm` (`src/extraction/impedance-clamp.js` —
 * `resolveImpedanceKind('measured_zs_ohm')` returns null, and a backend test
 * pins it), because adopting web's continuity band server-side would have
 * newly divided legitimate multi-ohm Zs readings on iOS — a safety fix
 * introducing a fresh safety defect. So after this removal a dictated
 * "forty four" for Zs is STORED AS 44, everywhere, uncorrected.
 *
 * That is the intended outcome, not a gap. A genuinely mis-heard Zs is
 * caught by the READ-BACK, not by arithmetic: the inspector hears "Zs 44",
 * knows it is wrong, and corrects it by speaking. That works precisely
 * because the spoken value and the stored value are the same number —
 * which is the whole point of plan D. Guessing a divisor for a quantity
 * that legitimately spans two orders of magnitude would put those two
 * numbers back out of step, which is the defect, not the fix.
 */
const CIRCUIT_IMPEDANCE_FIELD_TYPE: Record<string, ImpedanceField> = {
  r1_r2_ohm: 'continuity',
  r2_ohm: 'continuity',
  ring_r1_ohm: 'continuity',
  ring_rn_ohm: 'continuity',
  ring_r2_ohm: 'continuity',
};

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
/** PLAN-2D board-attributed voice fields. These are the only circuit-0
 * readings whose destination is one `boards[]` record rather than a
 * job-global section value. */
const BOARD_SCOPED_READING_FIELDS: ReadonlySet<string> = new Set([
  'manufacturer',
  'name',
  'location',
  'phases',
  'ze_at_db',
  'zs_at_db',
  'ipf_at_db',
]);

const MIRROR_TO_BOARDS0: ReadonlyArray<{
  section: Section;
  sectionKey: string;
  boardKey: string;
}> = [
  { section: 'board_info', sectionKey: 'manufacturer', boardKey: 'manufacturer' },
  { section: 'board_info', sectionKey: 'name', boardKey: 'name' },
  { section: 'board_info', sectionKey: 'location', boardKey: 'location' },
  { section: 'board_info', sectionKey: 'phases', boardKey: 'phases' },
  { section: 'board_info', sectionKey: 'ze_at_db', boardKey: 'ze_at_db' },
  { section: 'board_info', sectionKey: 'zs_at_db', boardKey: 'ze_at_db' },
  { section: 'board_info', sectionKey: 'ipf_at_db', boardKey: 'ipf_at_db' },
  { section: 'board_info', sectionKey: 'main_switch_bs_en', boardKey: 'main_switch_bs_en' },
  {
    section: 'supply_characteristics',
    sectionKey: 'earthing_arrangement',
    boardKey: 'earthing_arrangement',
  },
  { section: 'supply_characteristics', sectionKey: 'ze', boardKey: 'ze' },
  // Ambiguous board fields — wire name doesn't match the board record
  // key the Board tab reads. The wire is iOS-legacy
  // (`FIELD_CORRECTIONS` rewrite, sonnet-stream.js:774-848): Sonnet's
  // modern `polarity_confirmed` / `rcd_rating_ma` are rewritten to the
  // short forms below before reaching the PWA. `rcd_trip_time` is a
  // KNOWN_FIELDS pass-through but its source section is
  // `supply_characteristics` (no entry in CIRCUIT_0_SECTION); the
  // Board tab still reads it under the same name.
  {
    section: 'supply_characteristics',
    sectionKey: 'polarity',
    boardKey: 'polarity_confirmed',
  },
  {
    section: 'supply_characteristics',
    sectionKey: 'rcd_rating_a',
    boardKey: 'rcd_rating_ma',
  },
  {
    section: 'supply_characteristics',
    sectionKey: 'rcd_trip_time',
    boardKey: 'rcd_trip_time',
  },
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
  bonding_conductor_material: 'supply_characteristics',
  bonding_conductor_csa: 'supply_characteristics',
  bonding_conductor_continuity: 'supply_characteristics',
  bonding_other_na: 'supply_characteristics',
  earth_electrode_type: 'supply_characteristics',
  earth_electrode_resistance: 'supply_characteristics',
  earth_electrode_location: 'supply_characteristics',
  earthing_conductor_material: 'supply_characteristics',
  earthing_conductor_csa: 'supply_characteristics',
  earthing_conductor_continuity: 'supply_characteristics',
  means_earthing_distributor: 'supply_characteristics',
  means_earthing_electrode: 'supply_characteristics',
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
  zs_at_db: 'board_info',
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
  rcd_operating_current_test: 'supply_characteristics',
  rcd_time_delay_test: 'supply_characteristics',
  rcd_operating_time_test: 'supply_characteristics',
  spd_bs_en: 'board_info',
  spd_type_supply: 'board_info',
  spd_short_circuit: 'board_info',
  spd_rated_current: 'board_info',
  manufacturer: 'board_info',
  name: 'board_info',
  location: 'board_info',
  phases: 'board_info',
  ze_at_db: 'board_info',
  ipf_at_db: 'board_info',
  surge_spd_present: 'supply_characteristics',
  surge_spd_type: 'supply_characteristics',
  surge_spd_bs_en: 'supply_characteristics',
  surge_status_indicator: 'supply_characteristics',
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
  installation_records_available: 'installation_details',
  evidence_of_additions_alterations: 'installation_details',
  agreed_limitations: 'installation_details',
  agreed_with: 'installation_details',
  operational_limitations: 'installation_details',
  // Extent (EIC)
  extent_of_installation: 'extent_and_type',
  installation_type: 'extent_and_type',
  extent: 'extent_and_type',
  // EIC divert-to-comments (obs-#49, backend PR #66/#68) — the RULE 0
  // EIC observation path diverts spoken defect notes into the
  // installation-level comments field. Routed here for field_clears;
  // reading APPLIES go through the dedicated append branch in
  // applyCircuit0Readings (EIC-only guard + newline-append, iOS canon).
  comments: 'extent_and_type',
  // Design (EIC)
  departures_from_bs7671: 'design_construction',
  departure_details: 'design_construction',
  // Both clients' legacy model stores design comments beside EIC extent.
  design_comments: 'extent_and_type',
};

function routeSupplyField(field: string): Section {
  return CIRCUIT_0_SECTION[field] ?? 'supply_characteristics';
}

/** Test-only view of the explicit circuit-0 section routes. Consumed by the
 *  A2 drift guard (`non-circuit-fields.test.ts`) so `NON_CIRCUIT_FIELDS`
 *  membership is asserted against the REAL route map, not a copied literal
 *  (a raw key-set equality check would be both over- and under-inclusive —
 *  default-routed and alias-translated fields exist on both sides). */
export function __circuit0SectionRoutesForTests(): Readonly<Record<string, Section>> {
  return CIRCUIT_0_SECTION;
}

/** Semantic view of the actual web apply router. The manifest is used only as
 * the field iteration surface here; each destination is independently derived
 * from the circuit-row path, board-scoped planner, section map, and deliberate
 * board→supply mirrors. Contract tests deep-compare the result with both the
 * live runtime allowlist and the committed cross-client fixture. */
export function __liveClientReadingRoutesForTests(): Readonly<Record<string, ClientReadingRoute>> {
  const routes: Record<string, ClientReadingRoute> = {};
  for (const [field, declaredRoute] of Object.entries(CLIENT_ROUTABLE_READING_ROUTES)) {
    if (declaredRoute === 'circuit') {
      routes[field] = 'circuit';
    } else if (BOARD_SCOPED_READING_FIELDS.has(field)) {
      routes[field] = 'board_info';
    } else if (MIRROR_BOARD_TO_SUPPLY.has(field)) {
      routes[field] = 'supply_characteristics';
    } else {
      routes[field] = routeSupplyField(field);
    }
  }
  return routes;
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

/**
 * P3 Fix 6 (2026-07-23, feedback id 86) — before/after transition helper for
 * the OCPD-rating → max-Zs invalidation. iOS canon: the pre-write capture in
 * `Circuit.recalculateMaxZs` / the `CircuitsTab` inline lookup.
 *
 * Returns true when a row's AUTO-DERIVED numeric `ocpd_max_zs_ohm` should be
 * CLEARED because `ocpd_rating_a` transitioned from a numeric value (that
 * produced the current max-Zs) to a value the lookup can't use (e.g. the LIM
 * sentinel). A differing MANUAL override is PRESERVED (current max-Zs ≠ the
 * pre-LIM lookup). `ocpd_breaking_capacity_ka` is deliberately irrelevant here
 * — it is not a max-Zs lookup input (max-zs-lookup keys on `type_rating` only),
 * so a LIM breaking-capacity must NOT clear a valid max-Zs.
 *
 * The zero-argument recompute (H3 pass) runs AFTER the write and can't
 * reconstruct the pre-change tuple, so the caller passes BEFORE (`prior`, the
 * unpatched job circuit) and AFTER (`next`, the projected row) state.
 *
 * @param prior — the circuit row BEFORE this turn's writes (or undefined for a
 *   newly-created row, which has no auto-derived history)
 * @param next — the projected circuit row AFTER this turn's writes
 */
export function shouldClearAutoDerivedMaxZs(
  prior: CircuitRow | undefined,
  next: CircuitRow
): boolean {
  // Nothing to clear.
  if (!hasValue(next.ocpd_max_zs_ohm)) return false;
  const nextRating = (typeof next.ocpd_rating_a === 'string' ? next.ocpd_rating_a : '').trim();
  // The RATING is the governing input (not the type). Only clear when the
  // rating itself has transitioned to a NON-NUMERIC value (e.g. the "LIM"
  // sentinel). A blank rating, a still-numeric rating (an OCPD-TYPE change, or
  // a disconnect-time change), or an unchanged rating is NOT a rating→sentinel
  // transition — don't clear on any of those.
  if (nextRating === '' || Number.isFinite(Number(nextRating))) return false;
  // Need the PRE-transition NUMERIC rating to prove the max-Zs was auto-derived
  // (vs a manual override). Absent it, leave the value untouched.
  if (!prior) return false;
  const priorType = typeof prior.ocpd_type === 'string' ? prior.ocpd_type : '';
  const priorRating = typeof prior.ocpd_rating_a === 'string' ? prior.ocpd_rating_a : '';
  // The rating must actually have CHANGED (numeric prior → non-numeric next).
  if (priorRating.trim() === nextRating) return false;
  const priorDisc =
    typeof prior.max_disconnect_time_s === 'string' ? prior.max_disconnect_time_s : undefined;
  if (!priorType || !priorRating) return false;
  const preLimMaxZs = maxZsString({
    deviceType: priorType,
    rating: priorRating,
    disconnectTime: priorDisc,
  });
  return preLimMaxZs != null && next.ocpd_max_zs_ohm === preLimMaxZs;
}

/**
 * Narrative installation-details fields. Long multi-sentence dictations
 * ("Installation is over 50 years old. Walls are damp. Sockets are
 * 1960s.") may arrive split across multiple Deepgram final transcripts
 * because of utterance-end timeouts or chunk boundaries. Each transcript
 * fires its own Sonnet `record_reading`, and a plain overwrite would
 * lose every sentence except the last.
 *
 * iOS handles this in `applySonnetNarrativeValue`
 * (`DeepgramRecordingViewModel.swift:5948-6005`), called for
 * `reason_for_report` (:4331) and `general_condition_of_installation`
 * (:4400). PWA membership here includes the wire name (`general_condition`)
 * and the PWA-column name (`general_condition_of_installation`) because
 * we dual-write both — either one being the field on a `record_reading`
 * should route through the merge logic.
 */
const NARRATIVE_FIELDS: ReadonlySet<string> = new Set([
  'general_condition',
  'general_condition_of_installation',
  'reason_for_report',
]);

/**
 * iOS-canon append/supersede/skip logic for narrative fields.
 *
 *   - empty current → set to new (first write);
 *   - duplicate (case-insensitive) → no-op;
 *   - new contains current → supersede (Sonnet re-emitted the full
 *     narrative — replace to keep latest punctuation/casing);
 *   - current contains new → no-op (a later partial duplicating an
 *     earlier prefix would otherwise truncate the field);
 *   - otherwise → append with `". "` joiner, or `" "` if the current
 *     already ends in sentence-terminating punctuation.
 *
 * Returns `null` for "skip this write", or the merged string. Mirrors
 * `applySonnetNarrativeValue` semantics exactly so cross-platform
 * behaviour is identical for the same transcript sequence.
 */
export function mergeNarrativeValue(
  currentRaw: string | null | undefined,
  incomingRaw: string | null | undefined
): string | null {
  const newTrim = (incomingRaw ?? '').trim();
  if (!newTrim) return null;
  const curTrim = (currentRaw ?? '').trim();
  if (!curTrim) return newTrim;
  const curLower = curTrim.toLowerCase();
  const newLower = newTrim.toLowerCase();
  if (curLower === newLower) return null;
  if (newLower.includes(curLower)) return newTrim;
  if (curLower.includes(newLower)) return null;
  const joiner = /[.!?]$/.test(curTrim) ? ' ' : '. ';
  return curTrim + joiner + newTrim;
}

/**
 * A2-multiboard item 7 (2026-07-28) — the ATOMIC PREFLIGHT for a flagged
 * BOARD-level replacement.
 *
 * A circuit-0 `replaces_cleared` reading is the board twin of P5's circuit
 * collapse: the server collapsed a same-turn `clear_board_reading` →
 * `record_board_reading` pair, dropped the stale clear from the wire, and
 * stamped the SURVIVING write. The client's cell is therefore still populated
 * with the value the inspector just replaced — so all three fill-only gates on
 * the circuit-0 path would skip it, and the reading would be spoken aloud but
 * never written (F5's silent-skip class, at board scope).
 *
 * Two legs can carry a board-level value, and they are written by two
 * functions that iterate `readings` independently: the SECTION leg
 * (`applyCircuit0Readings` → `board_info` / `supply_characteristics`) and the
 * BOARDS leg (`mirrorReadingsToBoards` → `boards[i]`). If they disagreed about
 * a flagged reading, one half of the UI would show the replacement and the
 * other the stale value — worse than either failing cleanly. So the decision
 * is made ONCE, here, before either runs, and both consult the same plan.
 *
 * ── Routing (round-5) ─────────────────────────────────────────────────────
 *
 * `board_info` is the MAIN-BOARD SUMMARY, not a per-board mirror: the Overview
 * hero strip, the PDF, and the backend's single-board ingest all read it as
 * "the board". `boards[]` is where per-board values live. Hence:
 *
 *   - target IS the canonical-main (or sole) board → BOTH legs, atomically:
 *     the section write (including `board_info`) and the `boards[main]` copy;
 *   - target is a SUB-board → SINGLE leg. `boards[sub]` is written and the
 *     `board_info` section target is withheld, because publishing a
 *     sub-board's manufacturer as the job's primary summary corrupts every
 *     board_info consumer. When `board_info` was the only section target the
 *     section leg is empty and the write is legitimately boards[]-only.
 *
 * ── Why a boardless flagged reading is section-only, not a failure ────────
 *
 * The backend encodes board-vs-global scope in whether it enriches the wire at
 * all: `BOARD_CLEAR_SCOPE_MAP` marks `ze`/`pfc` `'global'` and stamps their
 * effective slot with a NULL board, while `'board'`-scoped fields
 * (`manufacturer`) get the resolved board id — and item 7 enriches every
 * FLAGGED board write that has one. So a flagged reading arriving WITHOUT a
 * `board_id` is, by construction, a global one: it has no per-board home, one
 * job-wide cell, and `mirrorReadingsToBoards` correctly declines to guess on a
 * multi-board job (`apply_boards_mirror_skipped_ambiguous_multi_board`). That
 * skip is not a failed leg — it is the right answer — so the section bypass
 * proceeds alone. (This supersedes the archive's framing of any mirror skip as
 * an atomicity failure.)
 *
 * ── Why an ORPHAN board id declines both legs ─────────────────────────────
 *
 * An unresolvable `board_id` is the one case where a concrete target was named
 * and cannot be honoured. Writing the section anyway would publish a value
 * while the board the server addressed keeps its stale one — the desync this
 * preflight exists to prevent — so both legs decline and the miss is logged
 * loudly. Mirrors the P4b fail-closed partition on the circuit path.
 *
 * Keyed by reading IDENTITY (the objects are stable for the life of one apply
 * call), so no field/board tuple has to be re-derived in agreement twice.
 */
type BoardReadingPlan = {
  /** Write the section leg at all. */
  section: boolean;
  /** Index into `job.boards[]` for the boards leg, or null for no boards leg. */
  boardIdx: number | null;
  /** Whether the section leg may include the `board_info` target. */
  allowBoardInfo: boolean;
  /** Only a server-collapsed clear→write may bypass fill-only guards. */
  bypassFillOnly: boolean;
};

function planBoardReadingRoutes(
  job: JobDetail,
  readings: ExtractedReading[]
): Map<ExtractedReading, BoardReadingPlan> {
  const plans = new Map<ExtractedReading, BoardReadingPlan>();
  const boards = (job.boards as Record<string, unknown>[] | undefined) ?? [];
  const canonicalMainId = resolveCanonicalMainBoardId(boards as MainBoardCandidate[]);

  for (const reading of readings) {
    if (reading.circuit !== 0 || !reading.field) continue;
    const boardScoped = BOARD_SCOPED_READING_FIELDS.has(reading.field);
    const replacesCleared = reading.replaces_cleared === true;
    if (!replacesCleared && !boardScoped) continue;

    const mirror = MIRROR_TO_BOARDS0.find((m) => m.sectionKey === reading.field);
    if (!mirror) {
      // Not a board-mirrored field (client_name, address, …). One leg only;
      // nothing to keep atomic.
      plans.set(reading, {
        section: true,
        boardIdx: null,
        allowBoardInfo: true,
        bypassFillOnly: replacesCleared,
      });
      continue;
    }

    let scopedTo = reading.board_id;
    if (scopedTo == null || scopedTo === '') {
      if (boardScoped && boards.length === 0 && !replacesCleared) {
        // Legacy flat web jobs have no boards[] evidence yet. Leave ordinary
        // writes unplanned so the established mirror path can synthesise the
        // sole main board; there is no second board to misattribute it to.
        continue;
      }
      if (boardScoped && boards.length > 1) {
        // PLAN-2D: a per-board field on a multi-board job is never guessed.
        plans.set(reading, {
          section: false,
          boardIdx: null,
          allowBoardInfo: false,
          bypassFillOnly: replacesCleared,
        });
        pipelineLog('apply_board_reading_ambiguous_board_ref', {
          field: reading.field,
          boards_count: boards.length,
        });
        continue;
      }
      if (boardScoped && boards.length === 1 && typeof boards[0]?.id === 'string') {
        scopedTo = boards[0].id as string;
      } else {
        // Global-scoped by construction (see the header). Section-only.
        plans.set(reading, {
          section: true,
          boardIdx: null,
          allowBoardInfo: true,
          bypassFillOnly: replacesCleared,
        });
        pipelineLog('apply_flagged_board_replacement_section_only', {
          field: reading.field,
          boards_count: boards.length,
        });
        continue;
      }
    }

    const boardIdx = boards.findIndex((b) => typeof b?.id === 'string' && b.id === scopedTo);
    if (boardIdx < 0) {
      // Named a board we do not have — decline BOTH legs.
      plans.set(reading, {
        section: false,
        boardIdx: null,
        allowBoardInfo: false,
        bypassFillOnly: replacesCleared,
      });
      pipelineLog('apply_flagged_board_replacement_orphan_board_ref', {
        field: reading.field,
        board_id: scopedTo,
        boards_count: boards.length,
      });
      continue;
    }

    // A sole board is the canonical main whatever it calls itself, so the
    // single-board job keeps its two-leg behaviour.
    const isPrimary = boards.length <= 1 || scopedTo === canonicalMainId;
    const plan: BoardReadingPlan = {
      section: true,
      boardIdx,
      allowBoardInfo: isPrimary,
      bypassFillOnly: replacesCleared,
    };

    // Ordinary board writes remain fill-only. Decide the two-leg guard here so
    // a main-board write cannot fill `board_info` while a pre-existing
    // `boards[main]` value blocks the matching board leg (or vice versa).
    // Sub-board writes deliberately ignore the main-board summary.
    if (!replacesCleared) {
      const pwaColumn = LEGACY_TO_PWA_SECTION_FIELD[reading.field];
      const sourceSection = job[mirror.section] as Record<string, unknown> | undefined;
      const boardValue = boards[boardIdx]?.[mirror.boardKey];
      const sectionHasValue =
        isPrimary &&
        sourceSection != null &&
        (hasValue(sourceSection[reading.field]) ||
          (pwaColumn != null && hasValue(sourceSection[pwaColumn])));
      if (hasValue(boardValue) || sectionHasValue) {
        plan.section = false;
        plan.boardIdx = null;
        pipelineLog('apply_board_reading_user_value_kept', {
          field: reading.field,
          board_id: scopedTo,
          board_value_present: hasValue(boardValue),
          section_value_present: sectionHasValue,
        });
      }
    }

    plans.set(reading, plan);
    pipelineLog(
      replacesCleared ? 'apply_flagged_board_replacement_planned' : 'apply_board_reading_planned',
      {
        field: reading.field,
        board_id: scopedTo,
        target_index: boardIdx,
        is_primary_board: isPrimary,
        section: mirror.section,
      }
    );
  }

  return plans;
}

/** Apply all readings belonging to circuit 0. Returns a map of
 *  section → merged record that can be folded into the final patch. */
function applyCircuit0Readings(
  job: JobDetail,
  readings: ExtractedReading[],
  boardPlans: Map<ExtractedReading, BoardReadingPlan>
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

    // A2-multiboard item 7 — the SECTION leg of the flagged-replacement
    // preflight (`planBoardReadingRoutes`). Three outcomes, all decided
    // there so this leg and the `boards[]` leg cannot disagree:
    //
    //   plan.section === false   the preflight declined BOTH legs (an orphan
    //                            `board_id`). Skip — writing the section while
    //                            the addressed board keeps its stale value is
    //                            precisely the desync we fail closed against.
    //   allowBoardInfo === false the target is a SUB-board, so `board_info`
    //                            (the MAIN-board summary) must not be
    //                            rewritten. Drop that target; if it was the
    //                            only one, this is a legitimate boards[]-only
    //                            write and the section leg is empty.
    //   otherwise                proceed, and bypass the fill-only gate below.
    const boardPlan = boardPlans.get(reading);
    if (boardPlan && !boardPlan.section) {
      pipelineLog('apply_section_reading_flagged_declined', {
        wire_field: reading.field,
        board_id: reading.board_id ?? null,
      });
      continue;
    }
    if (boardPlan && !boardPlan.allowBoardInfo) {
      const withheld = targets.indexOf('board_info');
      if (withheld >= 0) targets.splice(withheld, 1);
      pipelineLog('apply_section_reading_board_info_withheld', {
        wire_field: reading.field,
        board_id: reading.board_id ?? null,
        remaining_targets: targets,
      });
      if (targets.length === 0) continue;
    }

    // EIC divert-to-comments branch (obs-#49, WS3 item 9b 2026-07-02) —
    // dedicated append path, iOS canon: the `comments` case in
    // applySonnetReadings (DeepgramRecordingViewModel.swift:6650-6670).
    // The backend emits ONLY the new diverted-observation note as the
    // value; the client owns the single append (newline-separated) so a
    // note diverted from an EIC observation doesn't overwrite earlier
    // comments. EIC-ONLY: iOS drops the field on an EICR with a warn —
    // observations are first-class there, so a comments write would be
    // a model error.
    if (reading.field === 'comments') {
      const certType = typeof job.certificate_type === 'string' ? job.certificate_type : 'EICR';
      if (certType !== 'EIC') {
        pipelineLog('apply_eic_field_dropped_on_eicr', { field: 'comments' });
        continue;
      }
      const sec: Section = 'extent_and_type';
      const inBySection = (bySection[sec] as Record<string, unknown> | undefined) ?? {};
      const existingSection = (job[sec] as Record<string, unknown> | undefined) ?? {};
      const fromPatch = inBySection.comments;
      const current =
        typeof fromPatch === 'string' && fromPatch.trim().length > 0
          ? fromPatch
          : typeof existingSection.comments === 'string'
            ? (existingSection.comments as string)
            : '';
      const delta = String(reading.value ?? '').trim();
      if (!delta) continue;
      // No userValueKept gate here (append semantics make it moot —
      // mirrors iOS, where the dedicated case always combines).
      const combined = current.trim().length === 0 ? delta : `${current}\n${delta}`;
      if (combined === current) continue;
      bySection[sec] = { ...inBySection, comments: combined };
      pipelineLog('apply_eic_comments_appended', {
        delta_length: delta.length,
        combined_length: combined.length,
        was_first_write: current.trim().length === 0,
      });
      continue;
    }

    // Narrative-field branch — iOS canon `applySonnetNarrativeValue`
    // (`DeepgramRecordingViewModel.swift:5948-6005`). Bypasses the
    // userValueKept gate below: a manually-typed first sentence
    // followed by a dictated continuation should APPEND, not skip.
    // The mergeNarrativeValue helper's subset/superset checks handle
    // duplicate emits without needing the gate.
    const isNarrative =
      NARRATIVE_FIELDS.has(reading.field) || (pwaColumn != null && NARRATIVE_FIELDS.has(pwaColumn));
    if (isNarrative) {
      for (const sec of targets) {
        const existing = (job[sec] as Record<string, unknown> | undefined) ?? {};
        const inBySection = (bySection[sec] as Record<string, unknown> | undefined) ?? {};
        // Read existing across both the in-flight section patch (a
        // prior reading in this same call) and the persisted job
        // state. Fall back across wire-name ↔ PWA-column so a value
        // typed directly into the Installation tab (PWA column) is
        // honoured when Sonnet's `record_reading` arrives under the
        // wire name.
        const wireKey = reading.field;
        const pickExisting = (k: string): string => {
          const fromPatch = inBySection[k];
          if (typeof fromPatch === 'string' && fromPatch.trim().length > 0) return fromPatch;
          const fromJob = existing[k];
          return typeof fromJob === 'string' ? fromJob : '';
        };
        const current = pickExisting(wireKey) || (pwaColumn ? pickExisting(pwaColumn) : '');
        const merged = mergeNarrativeValue(current, String(reading.value ?? ''));
        if (merged == null) {
          pipelineLog('apply_narrative_field_skipped', {
            section: sec,
            wire_field: wireKey,
            reason: !String(reading.value ?? '').trim() ? 'empty_incoming' : 'duplicate_or_subset',
          });
          continue;
        }
        const sectionPatch: Record<string, unknown> = { ...inBySection, [wireKey]: merged };
        if (pwaColumn && pwaColumn !== wireKey) sectionPatch[pwaColumn] = merged;
        bySection[sec] = sectionPatch;
        pipelineLog('apply_narrative_field_merged', {
          section: sec,
          wire_field: wireKey,
          pwa_column: pwaColumn ?? null,
          result_length: merged.length,
          was_first_write: !current,
        });
      }
      continue;
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
    if (userValueKept && boardPlan?.bypassFillOnly) {
      // A2-multiboard item 7 — a `replaces_cleared` write is not a fresh fill
      // racing a manual edit; it is the SURVIVOR of a same-turn clear→write
      // pair the server already collapsed. The cell is still populated with
      // the value the inspector just told us to replace, so the fill-only
      // gate would skip the very write it asked for — spoken aloud, never
      // written (Audio-First #1's inverse). Bypass, loudly.
      pipelineLog('apply_section_reading_replaces_cleared_bypass', {
        primary_section: primarySection,
        targets,
        wire_field: reading.field,
        pwa_column: pwaColumn ?? null,
        board_id: reading.board_id ?? null,
      });
      userValueKept = false;
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
// P3 Codex-r1 F4 — the PWA COLUMN names of the numeric READING fields. Only a
// LIM write to one of these bypasses the 3-tier value guard; a LIM on a free-text
// field (circuit_designation, ref, …) must NOT erase a manual value. Membership
// is checked on the TRANSLATED column (translateCircuitField), so a legacy wire
// name (ocpd_rating / zs / r1_plus_r2 / insulation_resistance_l_l / …) still
// resolves to its canonical column here — F1: checking the raw wire field would
// miss those and re-block the legitimate single-board LIM correction.
// A2 (2026-07-28) — the board id the BACKEND synthesises for a snapshot that
// arrived with no `boards[]` at all. Used here as the seed for the
// `replaces_cleared` evidence check when web's own evidence is empty: it is
// the server's name for "the only board" on a legacy flat job. Sourced from
// the shared canonical-main module (scope item 5) so the literal exists ONCE
// on web. If the backend constant ever changes, the symptom is a
// `replaces_cleared` write silently declining on legacy single-board jobs
// (stale value kept, the A2 defect back) — pinned by the legacy-shape test in
// `web/tests/apply-extraction-replaces-cleared.test.ts`.

const NUMERIC_READING_COLUMNS = new Set<string>([
  'measured_zs_ohm',
  'rcd_time_ms',
  'rcd_operating_current_ma',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ir_test_voltage_v',
  'r1_r2_ohm',
  'r2_ohm',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'ocpd_max_zs_ohm',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
]);

function applyCircuitReadings(
  job: JobDetail,
  readings: ExtractedReading[],
  circuitUpdates: CircuitUpdate[],
  fieldClears: FieldClear[],
  // A2-multiboard item 6 — the envelope's board ops used to be evidence in the
  // `replaces_cleared` cardinality gate this file no longer has: P4b resolves a
  // flagged replacement against the ROWS it may legally land on, so an op
  // naming a board proves nothing the row index doesn't already say. Kept in
  // the signature because it is positional and every caller passes it.
  _boardOps: BoardOp[],
  options: ApplyExtractionOptions = {}
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
  const refCounts = new Map<string, number>();
  circuits.forEach((row, idx) => {
    const ref = row.circuit_ref ?? row.number;
    if (typeof ref === 'string' && ref) {
      indexByRef.set(ref, idx);
      refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
    }
  });

  // Indexes of rows synthesised by this turn — defaults are applied
  // to these AFTER all Sonnet readings / circuit_updates / clears
  // have landed, so the per-circuit priority guard treats the empty
  // bare row (not the default-filled row) as "empty" and lets Sonnet
  // values win in same-turn races. iOS canon does the equivalent —
  // defaults arrive last, never overwrite a set value.
  const synthesisedIndexes = new Set<number>();
  const ensureRow = (circuitNum: number): number => {
    const ref = String(circuitNum);
    const existingIdx = indexByRef.get(ref);
    if (existingIdx != null) return existingIdx;
    const id = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${circuitNum}`;
    const row: CircuitRow = { id, circuit_ref: ref, circuit_designation: '' };
    circuits.push(row);
    const newIdx = circuits.length - 1;
    indexByRef.set(ref, newIdx);
    synthesisedIndexes.add(newIdx);
    return newIdx;
  };

  // A2-multiboard (2026-07-28) — board-scoped row resolution for readings that
  // carry an effective `board_id`.
  //
  // The defect: `ensureRow` resolves by `circuit_ref` ALONE, and circuit refs
  // are PER BOARD — every board has a circuit 1. The backend now stamps the
  // dispatcher-resolved effective board onto every winner of a CROSS-BOARD turn
  // (`stage6-event-bundler.js`), because without it a
  // `select_board A → Zs on 3 → select_board B → Zs on 3` turn puts two
  // distinct winners on the wire and web collapses BOTH onto whichever
  // circuit-3 row it finds first. One of the two spoken readings is then read
  // back aloud and never written — the exact Audio-First #1 inverse this plan
  // closes. The enrichment alone changes nothing until the consumer reads it;
  // this is that consumer.
  //
  // It is deliberately NON-DESTRUCTIVE. Every path that cannot resolve the
  // board unambiguously falls back to the ref-only behaviour that shipped
  // before this change, so a reading is never dropped and no pre-A2-multiboard
  // job shape changes:
  //
  //  • an UNSCOPED reading (no `board_id` — every single-board turn, which is
  //    the overwhelming majority) never enters here at all;
  //  • an EXACT `(board_id, ref)` row wins outright;
  //  • an UNSCOPED legacy row is claimed by the FIRST board to want it this
  //    turn (legacy flat rows genuinely belong to one board and web has no way
  //    to say which — first-come is deterministic, and the SECOND board then
  //    gets its own row rather than silently overwriting the first's);
  //  • a NEW scoped row is only ever created for a board web has INDEPENDENT
  //    evidence of (its own `boards[]` registry, or an existing row already
  //    scoped to it). A board id the server asserts but web has never seen is
  //    a registry mismatch, not a licence to invent a circuit on a phantom
  //    board — those fall back to ref-only, exactly as before.
  const evidencedBoardIds = new Set<string>();
  for (const b of Array.isArray(job.boards) ? job.boards : []) {
    const id = (b as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id !== '') evidencedBoardIds.add(id);
  }
  //
  // The scoped index is ARRAY-valued, not last-wins. Ordinary routing only ever
  // wants one row and takes the last (below), but the `replaces_cleared`
  // resolution further down has to DISTINGUISH "one eligible row" from "two
  // eligible rows" — a last-wins map reports both as one and would silently
  // overwrite an arbitrary member of a duplicated pair. Duplicates must stay
  // observable for that resolution to be able to fail closed on them. Modelled
  // on the scoped ref index in `apply-document-extraction.ts`.
  const indexByBoardRef = new Map<string, number[]>();
  /** Rows carrying NO `board_id` at all, by ref — the legacy flat shape. */
  const unscopedIndexesByRef = new Map<string, number[]>();
  const pushIndex = (map: Map<string, number[]>, key: string, idx: number) => {
    const existing = map.get(key);
    if (existing) existing.push(idx);
    else map.set(key, [idx]);
  };
  const boardRefKey = (boardId: string, ref: string) => `${boardId} ${ref}`;
  const rowBoardId = (row: CircuitRow): string | null => {
    const bid = (row as unknown as Record<string, unknown>).board_id;
    return typeof bid === 'string' && bid !== '' ? bid : null;
  };
  circuits.forEach((row, idx) => {
    const ref = row.circuit_ref ?? row.number;
    if (typeof ref !== 'string' || !ref) return;
    const bid = rowBoardId(row);
    if (bid == null) {
      pushIndex(unscopedIndexesByRef, ref, idx);
      return;
    }
    evidencedBoardIds.add(bid);
    pushIndex(indexByBoardRef, boardRefKey(bid, ref), idx);
  });
  /** Which board (if any) has already claimed each unscoped legacy row THIS turn. */
  const unscopedRefClaimedBy = new Map<string, string>();
  const ensureBoardScopedRow = (circuitNum: number, boardId: string): number => {
    const ref = String(circuitNum);
    // Last of the scoped matches — byte-identical to the last-wins map this
    // index replaced. A same-board duplicate ref is a broken job either way and
    // ORDINARY routing is not the place to arbitrate it; the flagged-
    // replacement resolver below is, and it declines rather than picks.
    const exact = indexByBoardRef.get(boardRefKey(boardId, ref));
    if (exact && exact.length > 0) return exact[exact.length - 1];

    const refOnly = indexByRef.get(ref);
    if (refOnly != null) {
      const existingBoard = rowBoardId(circuits[refOnly]);
      if (existingBoard === null) {
        const claimed = unscopedRefClaimedBy.get(ref);
        if (claimed == null || claimed === boardId) {
          unscopedRefClaimedBy.set(ref, boardId);
          return refOnly;
        }
      }
      // The only row with this ref belongs to a DIFFERENT board (or an unscoped
      // one another board already claimed this turn). Writing here is the
      // wrong-board overwrite; give this board its own row instead — but only
      // if web can independently vouch for the board.
      if (!evidencedBoardIds.has(boardId)) {
        pipelineLog('apply_circuit_reading_unevidenced_board', {
          circuit: circuitNum,
          board_id: boardId,
          existing_row_board_id: existingBoard,
        });
        return refOnly;
      }
    } else if (!evidencedBoardIds.has(boardId)) {
      // No row for this ref at all — `ensureRow` would create a bare one, and
      // that stays the behaviour for an unevidenced board so the new row is
      // indistinguishable from pre-A2-multiboard output.
      return ensureRow(circuitNum);
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${circuitNum}-${boardId}`;
    const row = {
      id,
      circuit_ref: ref,
      circuit_designation: '',
      board_id: boardId,
    } as unknown as CircuitRow;
    circuits.push(row);
    const newIdx = circuits.length - 1;
    pushIndex(indexByBoardRef, boardRefKey(boardId, ref), newIdx);
    // Only seed the ref-only index when nothing owns the ref yet, so a scoped
    // sibling never re-points `field_clears` / `circuit_updates` (both ref-only)
    // away from the row they have always resolved to.
    if (refOnly == null) indexByRef.set(ref, newIdx);
    synthesisedIndexes.add(newIdx);
    pipelineLog('apply_circuit_reading_board_scoped_row_created', {
      circuit: circuitNum,
      board_id: boardId,
      row_idx: newIdx,
    });
    return newIdx;
  };
  /** Ref-only for an unscoped reading; board-scoped the moment the wire says which board. */
  const resolveReadingRow = (reading: { circuit: number; board_id?: unknown }): number => {
    const bid = reading.board_id;
    if (typeof bid !== 'string' || bid === '') return ensureRow(reading.circuit);
    return ensureBoardScopedRow(reading.circuit, bid);
  };

  // A2-multiboard item 6 (2026-07-28) — P4b resolution for a `replaces_cleared`
  // replacement. This REPLACES A2-core's envelope-wide cardinality gate
  // (`apply_replaces_cleared_multiboard_deferred` and its `boardEvidence`
  // apparatus), which asked "is this whole turn unambiguous?" and, when it was
  // not, declined EVERY flagged reading in it — including ones whose target row
  // was never in doubt. That was the right answer while web routed by bare
  // `circuit_ref`; it is the wrong question now that the backend stamps the
  // dispatcher-resolved effective board onto every flagged write
  // (`stage6-event-bundler.js`, item 1). The question P4b asks instead is
  // per-reading and structural: WHICH ROWS may this replacement legally land
  // on? A turn that adds a board while correcting circuit 3 on a named board is
  // now a targeted overwrite, not a blanket defer.
  //
  // Three properties this deliberately has, each of which inverts an A2-core
  // behaviour and is asserted as such in the tests:
  //
  //  1. ELIGIBILITY IS COMPUTED IN FULL BEFORE IT IS BRANCHED ON. Not "find a
  //     scoped match, write to it" — a scoped match that COEXISTS with an
  //     attributed-unscoped match is two candidates, and a resolver that
  //     returns on the first one it finds silently picks one. The set is built,
  //     then its SIZE decides.
  //  2. IT NEVER CREATES A ROW. `ensureRow`/`ensureBoardScopedRow` are
  //     prohibited here. A replacement names a cell the server has already
  //     cleared, so a ref with no row is not "a circuit to invent" — it is
  //     proof web's view and the server's disagree, and inventing a row would
  //     write a legally-significant value onto a circuit the inspector never
  //     mentioned. A2-core filled a freshly-synthesised row; this declines.
  //  3. EVERY NON-WRITE OUTCOME FAILS CLOSED AND IS NAMED. The partition is
  //     exhaustive — `orphan_board_ref` (0 eligible), `duplicate_board_ref`
  //     (>1), `ambiguous_board` (no `board_id` on a multi-board job) — so a
  //     silent third path cannot exist. A2-core's declines fell THROUGH to the
  //     ordinary fill-only gate, which meant a duplicate ref still wrote when
  //     the cell happened to be empty; here neither row changes.
  //
  // The cost of (2)+(3) is a stale value in a genuinely unresolvable case,
  // recoverable by re-dictating. The cost of guessing is a silent overwrite of
  // a cell the inspector never spoke about, in a legally-significant
  // certificate, which no read-back can catch by ear. The asymmetry is the
  // whole design.
  //
  // ACCEPTED RACE (unchanged from A2-core): the marker proves the SERVER
  // cleared the cell, not that web's current value is still the cleared
  // predecessor. A value typed into this exact cell in the ~1-2s between
  // speaking and the extraction landing is overwritten. That is iOS canon, and
  // the alternative — skipping — is the spoken-but-not-written defect this
  // closes. Fixing it properly needs utterance-correlated freshness, a wire
  // change and out of scope.
  const canonicalMainBoardId = resolveCanonicalMainBoardId(
    (Array.isArray(job.boards) ? job.boards : null) as
      | readonly { id?: unknown; board_type?: unknown }[]
      | null
  );
  const jobBoardCount = Array.isArray(job.boards) ? job.boards.length : 0;
  /**
   * The ONE row a wire operation may address, or a NAMED reason it must fail
   * closed. Never creates a row, never picks between candidates.
   *
   * Shared by the `replaces_cleared` replacement resolver (item 6) and by the
   * circuit-topology ops (item 3) deliberately: a `delete circuit 3 on board B`
   * and a `replaces_cleared` write to circuit 3 on board B must never disagree
   * about which row that is. One resolver makes divergence impossible rather
   * than a thing to keep in sync.
   */
  const resolveExistingRow = (
    circuitNum: number,
    boardIdRaw: unknown
  ): {
    idx: number | null;
    reason: 'ambiguous_board' | 'orphan' | 'duplicate' | null;
    eligible: number;
  } => {
    const ref = String(circuitNum);
    const scopedTo = typeof boardIdRaw === 'string' && boardIdRaw !== '' ? boardIdRaw : null;

    if (scopedTo === null) {
      // Item 1 enriches EVERY flagged write with its effective board, so an
      // unscoped flagged reading on a multi-board job means the enrichment did
      // not happen — an older backend, or a board the dispatcher could not
      // resolve. Either way the ref alone cannot say which board's circuit 3
      // this is, and ref uniqueness does not rescue it: two boards can both
      // have exactly one circuit 3 and only one of them is a row here.
      if (jobBoardCount > 1) return { idx: null, reason: 'ambiguous_board', eligible: 0 };
      // At most one board — every row is that board's, scoped or not, so the
      // ref IS the identity. Require it to be unique.
      const refMatches = refCounts.get(ref) ?? 0;
      if (refMatches === 1) return { idx: indexByRef.get(ref) ?? null, reason: null, eligible: 1 };
      return {
        idx: null,
        reason: refMatches === 0 ? 'orphan' : 'duplicate',
        eligible: refMatches,
      };
    }

    // Scoped. Eligible = rows already scoped to this board, PLUS — only when
    // the reading targets the job's CANONICAL MAIN board, or the job has at
    // most one board — the unscoped legacy rows. Legacy flat rows genuinely
    // belong to a board; the one board they can be ATTRIBUTED to without
    // guessing is the canonical main (item 5's rule, the same one the backend
    // and iOS state), because that is the board whose circuits the legacy
    // namespace has always meant. A sub-board never inherits them.
    const attributedUnscoped =
      scopedTo === canonicalMainBoardId || jobBoardCount <= 1
        ? (unscopedIndexesByRef.get(ref) ?? [])
        : [];
    const eligible = [
      ...(indexByBoardRef.get(boardRefKey(scopedTo, ref)) ?? []),
      ...attributedUnscoped,
    ];

    if (eligible.length === 1) return { idx: eligible[0], reason: null, eligible: 1 };
    return {
      idx: null,
      reason: eligible.length === 0 ? 'orphan' : 'duplicate',
      eligible: eligible.length,
    };
  };

  /**
   * The row a flagged replacement may write to, or `null` when it must fail
   * closed (telemetry already emitted by then). Never creates a row.
   */
  const resolveFlaggedReplacementRow = (
    reading: { circuit: number; board_id?: unknown },
    column: string
  ): number | null => {
    const ref = String(reading.circuit);
    const bid = reading.board_id;
    const scopedTo = typeof bid === 'string' && bid !== '' ? bid : null;
    const outcome = resolveExistingRow(reading.circuit, bid);

    if (outcome.idx != null) {
      // If the winner is an unscoped legacy row, record the claim so an
      // ORDINARY reading for a different board later in this same turn gets its
      // own row instead of landing on the one this replacement just took.
      if (
        scopedTo !== null &&
        rowBoardId(circuits[outcome.idx]) === null &&
        !unscopedRefClaimedBy.has(ref)
      ) {
        unscopedRefClaimedBy.set(ref, scopedTo);
      }
      return outcome.idx;
    }

    if (outcome.reason === 'ambiguous_board') {
      pipelineLog('apply_replaces_cleared_ambiguous_board', {
        circuit: reading.circuit,
        pwa_column: column,
        job_board_count: jobBoardCount,
      });
    } else if (outcome.reason === 'orphan') {
      pipelineLog('apply_replaces_cleared_orphan_board_ref', {
        circuit: reading.circuit,
        pwa_column: column,
        board_id: scopedTo,
        eligible_matches: 0,
      });
    } else if (outcome.reason === 'duplicate') {
      pipelineLog('apply_replaces_cleared_duplicate_board_ref', {
        circuit: reading.circuit,
        pwa_column: column,
        board_id: scopedTo,
        eligible_matches: outcome.eligible,
      });
    }
    return null;
  };

  // A2-multiboard item 3 (2026-07-28) — rows removed by a `delete` op in this
  // envelope. TOMBSTONED, not spliced: every index in this function is an ARRAY
  // POSITION, and splicing would silently re-point `synthesisedIndexes` and
  // every already-resolved `idx` at the wrong row. Positions therefore stay
  // stable for the whole apply and the tombstones are filtered out exactly
  // once, at the end, after the defaults pass has run.
  const deletedIndexes = new Set<number>();
  /**
   * Recompute every row index from `circuits`, skipping tombstones. Called
   * after EVERY topology mutation (create / delete / re-key) so the next op —
   * and every reading after the ops pass — resolves against the shape the
   * previous op actually left behind.
   *
   * A full rebuild rather than incremental patching, because the incremental
   * version is where the bugs live: `ensureRow` never maintained `refCounts`,
   * so before this a freshly-created circuit was still `orphan` to the flagged
   * replacement resolver and its own replacement write was declined.
   */
  const rebuildRowIndexes = () => {
    indexByRef.clear();
    refCounts.clear();
    indexByBoardRef.clear();
    unscopedIndexesByRef.clear();
    circuits.forEach((row, idx) => {
      if (deletedIndexes.has(idx)) return;
      const ref = row.circuit_ref ?? row.number;
      if (typeof ref !== 'string' || !ref) return;
      indexByRef.set(ref, idx);
      refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
      const bid = rowBoardId(row);
      if (bid == null) pushIndex(unscopedIndexesByRef, ref, idx);
      else pushIndex(indexByBoardRef, boardRefKey(bid, ref), idx);
    });
  };

  // Apply `circuit_updates` (create / rename / delete) first so readings
  // against a circuit this turn created or renumbered land on the right row.
  //
  // ONE ORDERED PASS (A2-multiboard item 3). The wire sequence is
  // AUTHORITATIVE — the backend emits these in the order the model called the
  // tools, and `create 3 → delete 3` means the opposite of `delete 3 →
  // create 3`. Staging by action (all creates, then all deletes) would reorder
  // the inspector's intent, so every op resolves against the shape its
  // predecessor left behind and every topology mutation rebuilds the indexes
  // before the next one is read.
  for (const upd of circuitUpdates) {
    const obj = upd as unknown as Record<string, unknown>;
    const opBoardId = typeof obj.board_id === 'string' && obj.board_id !== '' ? obj.board_id : null;

    // Strict integer guard. The old `upd.circuit < 1` test let an ENTRY WITH NO
    // `circuit` AT ALL through (`undefined < 1` is false), which then created a
    // row keyed `"undefined"` — the `circuit_undefined` reason string below was
    // unreachable. It is reachable now.
    if (!Number.isInteger(upd.circuit) || upd.circuit < 1) {
      pipelineLog('apply_circuit_update_skipped', {
        reason: typeof upd.circuit === 'number' ? 'circuit_lt_1' : 'circuit_undefined',
        keys: Object.keys(obj),
        circuit: upd.circuit,
        action: upd.action,
        designation_present: typeof upd.designation === 'string' && upd.designation.length > 0,
      });
      continue;
    }

    // DELETE — resolved BEFORE the empty-designation guard below, because a
    // delete legitimately carries no designation (the backend projects `''`,
    // which iOS's non-optional Codable field forces) and that guard silently
    // dropped every one of them: a circuit the inspector deleted aloud, and
    // heard confirmed, stayed on screen.
    //
    // Fail-closed on the SAME resolver the flagged-replacement path uses. A
    // delete is the most destructive op on the wire, so an ambiguous target is
    // never guessed at: an unresolvable delete leaves the row alone and says so
    // in telemetry. The inspector can re-say it; a wrong-board delete of a
    // completed circuit's readings is not recoverable by ear.
    if (upd.action === 'delete') {
      const outcome = resolveExistingRow(upd.circuit, opBoardId);
      if (outcome.idx == null) {
        pipelineLog('apply_circuit_delete_declined', {
          circuit: upd.circuit,
          board_id: opBoardId,
          reason: outcome.reason ?? 'unresolved',
          eligible_matches: outcome.eligible,
        });
        continue;
      }
      deletedIndexes.add(outcome.idx);
      // A row created earlier in THIS envelope and then deleted must not draw
      // the defaults pass — it is about to disappear.
      synthesisedIndexes.delete(outcome.idx);
      rebuildRowIndexes();
      pipelineLog('apply_circuit_delete_applied', {
        circuit: upd.circuit,
        board_id: opBoardId,
        row_idx: outcome.idx,
      });
      continue;
    }

    // RENUMBERING rename — `from_ref` names the row that must MOVE. Without it
    // a client can only add a row at the new ref, leaving the old one behind as
    // a duplicate of the same circuit with the readings still on it.
    const fromRefRaw = obj.from_ref;
    const fromRef = Number.isInteger(fromRefRaw) ? (fromRefRaw as number) : null;
    if (upd.action === 'rename' && fromRef !== null && fromRef !== upd.circuit) {
      const src = resolveExistingRow(fromRef, opBoardId);
      const dest = resolveExistingRow(upd.circuit, opBoardId);
      // Only move when the source is unambiguous AND the destination ref is
      // genuinely free on that board (`orphan` = zero eligible rows). Moving
      // onto an occupied ref would merge two circuits' readings.
      if (src.idx != null && dest.idx == null && dest.reason === 'orphan') {
        const srcRow = circuits[src.idx];
        const rekeyed: CircuitRow = { ...srcRow, circuit_ref: String(upd.circuit) };
        // Legacy rows key off `number` when `circuit_ref` is absent; leaving a
        // stale one behind would make the row resolve differently downstream.
        if (typeof srcRow.number === 'string') rekeyed.number = String(upd.circuit);
        circuits[src.idx] = rekeyed;
        rebuildRowIndexes();
        pipelineLog('apply_circuit_rekeyed', {
          from_ref: fromRef,
          circuit: upd.circuit,
          board_id: opBoardId,
          row_idx: src.idx,
        });
      } else {
        pipelineLog('apply_circuit_rekey_declined', {
          from_ref: fromRef,
          circuit: upd.circuit,
          board_id: opBoardId,
          reason: src.idx == null ? `source_${src.reason ?? 'unresolved'}` : 'target_occupied',
        });
      }
    }

    if (!upd.designation) {
      // A METADATA-FREE CREATE still has to reach the row store. The folded-
      // reading carrier drops null metadata, so `create_circuit{circuit_ref}`
      // with no designation emitted nothing at all — the created circuit
      // reached neither client and the next dictated reading for it had no row
      // to land on. This projection is its only carrier.
      if (upd.action === 'create') {
        const idx =
          opBoardId != null ? ensureBoardScopedRow(upd.circuit, opBoardId) : ensureRow(upd.circuit);
        rebuildRowIndexes();
        pipelineLog('apply_circuit_create_bare_applied', {
          circuit: upd.circuit,
          board_id: opBoardId,
          row_idx: idx,
        });
      } else {
        pipelineLog('apply_circuit_update_skipped', {
          reason: 'designation_missing_or_empty',
          keys: Object.keys(obj),
          circuit: upd.circuit,
          action: upd.action,
          designation_present: false,
        });
      }
      continue;
    }

    // Board-aware from here: circuit refs are per-board, so a create/rename the
    // server performed on a sub-board must not land on MAIN's row of the same
    // ref. Unscoped ops keep the ref-only path they have always taken.
    const idx =
      opBoardId != null ? ensureBoardScopedRow(upd.circuit, opBoardId) : ensureRow(upd.circuit);
    const rowCreated = idx === circuits.length - 1 && !deletedIndexes.has(idx);
    rebuildRowIndexes();
    const row = circuits[idx];
    if (upd.action === 'rename' || !hasValue(row.circuit_designation)) {
      circuits[idx] = { ...row, circuit_designation: upd.designation };
      pipelineLog('apply_circuit_update_applied', {
        circuit: upd.circuit,
        action: upd.action,
        board_id: opBoardId,
        designation_length: upd.designation.length,
        designation_preview: upd.designation.slice(0, 40),
        rowCreated,
      });
    } else {
      pipelineLog('apply_circuit_update_user_value_kept', {
        circuit: upd.circuit,
        existing_designation_preview:
          typeof row.circuit_designation === 'string' ? row.circuit_designation.slice(0, 40) : null,
      });
    }
  }

  // Earthing arrangement is needed to widen the Ze clamp ceiling on
  // TT systems (200 Ω vs 5 Ω). Resolve once outside the loop —
  // either from the just-built section patch (this turn's Sonnet
  // write) or the existing job state.
  const earthingForClamp = (() => {
    const supply = (job.supply_characteristics as Record<string, unknown> | undefined) ?? {};
    const v = supply.earthing_arrangement;
    return typeof v === 'string' ? v : null;
  })();

  for (const reading of perCircuitReadings) {
    // Translate iOS-legacy wire field name → PWA column name. Pass-through
    // when already modern. See LEGACY_TO_PWA_CIRCUIT_FIELD docstring above.
    // Resolved BEFORE row targeting because the A2 resolution telemetry below
    // reports the PWA column, and a decline must be as legible as a write.
    const column = translateCircuitField(reading.field);
    if (column !== reading.field) {
      pipelineLog('apply_circuit_field_translated', {
        circuit: reading.circuit,
        wire_field: reading.field,
        pwa_column: column,
      });
    }
    // A2-multiboard — a `replaces_cleared` replacement resolves its OWN row,
    // authoritatively and without creating one (see
    // `resolveFlaggedReplacementRow`). Everything else keeps the ordinary
    // routing: board-scoped when the wire says which board, ref-only otherwise.
    // Successful resolution IS the bypass — it has already proved the target
    // unambiguous, which is exactly what the old envelope-wide cardinality gate
    // was trying (and structurally unable) to establish.
    let replacesClearedBypass = false;
    let idx: number;
    if (reading.replaces_cleared === true) {
      const resolved = resolveFlaggedReplacementRow(
        reading as unknown as { circuit: number; board_id?: unknown },
        column
      );
      // Fail closed — no row created, no cell touched, telemetry already
      // emitted naming which of the three outcomes fired.
      if (resolved === null) continue;
      idx = resolved;
      replacesClearedBypass = true;
    } else {
      idx = resolveReadingRow(reading as unknown as { circuit: number; board_id?: unknown });
    }
    const row = circuits[idx];
    // H5 — clamp impedance values BEFORE writing. Deepgram regularly
    // drops decimals ("zero point four four" → "44"); on a clean ÷10
    // or ÷100 we recover silently. Out-of-range values still write
    // (the Circuits tab visual + the upcoming inspector review pass
    // are the second line of defence). Continuity fields share the
    // 0.01-2.0 Ω band; Ze on circuit:N (rare — usually circuit:0)
    // shares it too.
    const impedanceField = CIRCUIT_IMPEDANCE_FIELD_TYPE[column];
    let writeValue: unknown = reading.value;
    if (impedanceField && typeof reading.value === 'string') {
      const outcome = clampImpedance(impedanceField, reading.value, earthingForClamp);
      if (outcome.kind === 'divided') {
        pipelineLog('apply_circuit_impedance_clamp_divided', {
          circuit: reading.circuit,
          pwa_column: column,
          original: outcome.original,
          corrected: outcome.corrected,
          divisor: outcome.divisor,
        });
        writeValue = outcome.corrected;
      } else if (outcome.kind === 'out_of_range') {
        pipelineLog('apply_circuit_impedance_out_of_range', {
          circuit: reading.circuit,
          pwa_column: column,
          value_preview: outcome.value.slice(0, 16),
        });
        // Still write the raw value — the visual gate on the Circuits
        // tab + the inspector-review pass on the cert PDF catch
        // egregious outliers. Skipping the write would lose data
        // that's sometimes intentional (e.g. very-high-Ze TT site).
      }
    }
    // 3-tier priority — keep the user's value if they've already typed
    // one into the field.
    //
    // P3 (2026-07-23, feedback id 86) — EXCEPTION: a canonical "LIM"
    // (limitation) reading is an EXPLICIT inspector correction ("actually that
    // reading is a limitation") and MUST overwrite an existing numeric value,
    // else the spoken "recorded as LIM" read-back is a lie (Audio-First #2) and
    // the rating → LIM max-Zs invalidation below is unreachable. LIM only
    // reaches here after the backend's four-form validation + `lim_ranged_write_v1`
    // capability gate, so it is always an intended limitation on a numeric
    // reading field. Every OTHER value still yields to a pre-existing typed
    // value (the long-standing web correction behaviour is unchanged).
    // P3 — a canonical LIM value.
    const isLimValue = typeof writeValue === 'string' && writeValue.trim().toLowerCase() === 'lim';
    // F6/F4 — on a multi-board job web's ref-only apply can't tell apart two
    // boards' circuit 1, so a LIM landing on an AMBIGUOUS ref could corrupt the
    // wrong board. Suppress the LIM write ENTIRELY on an ambiguous ref (skip the
    // reading — never write to an arbitrarily-selected board, even a blank one).
    //
    // A2-multiboard item 6 — BYPASSED for a flagged replacement, and only
    // AFTER `resolveFlaggedReplacementRow` has already returned a single row.
    // This guard exists because a bare `circuit_ref` cannot identify a board;
    // a resolved replacement has been matched on `(board_id, circuit_ref)` (or
    // proved to be on a single-board job), so the ambiguity it defends against
    // has already been ruled out — and it was ruled out by a resolver that
    // declines rather than picks, so this can never be relaxing a live
    // ambiguity. Leaving the guard armed here would silently drop the exact
    // spoken-and-cleared LIM correction the board scoping was added to route.
    if (isLimValue && !replacesClearedBypass && (refCounts.get(String(reading.circuit)) ?? 0) > 1) {
      pipelineLog('apply_circuit_reading_lim_ambiguous_ref_skipped', {
        circuit: reading.circuit,
        pwa_column: column,
      });
      continue;
    }
    // The overwrite exception fires ONLY for a canonical LIM on a numeric
    // READING column (F4 — checked on the TRANSLATED column, never a free-text
    // field like circuit_designation).
    const isLimWrite = isLimValue && NUMERIC_READING_COLUMNS.has(column);
    if (hasValue(row[column]) && !isLimWrite && !replacesClearedBypass) {
      pipelineLog('apply_circuit_reading_user_value_kept', {
        circuit: reading.circuit,
        pwa_column: column,
      });
      continue;
    }
    if (replacesClearedBypass && hasValue(row[column])) {
      pipelineLog('apply_replaces_cleared_bypass_applied', {
        circuit: reading.circuit,
        pwa_column: column,
      });
    }
    circuits[idx] = {
      ...row,
      [column]: writeValue,
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

  // H7 — apply user + global defaults to rows synthesised THIS turn,
  // after Sonnet's readings + circuit_updates landed. `applyDefaults
  // ToCircuit` only fills empty fields, so any value Sonnet just
  // wrote stays untouched. Pre-existing rows (`indexByRef` hit in
  // ensureRow) are NOT in `synthesisedIndexes` and so never have
  // defaults re-applied — preserves the user's manually-typed values.
  if (options.userDefaults && synthesisedIndexes.size > 0) {
    for (const idx of synthesisedIndexes) {
      const merged = applyDefaultsToCircuit(
        circuits[idx] as unknown as Parameters<typeof applyDefaultsToCircuit>[0],
        { userDefaults: options.userDefaults }
      );
      if (merged.filledFields > 0) {
        circuits[idx] = merged.circuit as unknown as CircuitRow;
        pipelineLog('apply_circuit_defaults_applied_on_create', {
          circuit_idx: idx,
          filled_count: merged.filledFields,
        });
      }
    }
  }

  // Drop the tombstones LAST — every index above is an array position, and the
  // defaults pass immediately above is the final consumer of them.
  if (deletedIndexes.size > 0) {
    const kept = circuits.filter((_, idx) => !deletedIndexes.has(idx));
    pipelineLog('apply_circuits_deleted_rows_dropped', {
      deleted_count: deletedIndexes.size,
      remaining: kept.length,
    });
    return kept;
  }

  return circuits;
}

/** Flatten a schedule reference (EICR has nested sections; EIC is
 *  flat) into a Set of valid refs for O(1) lookup. */
function buildScheduleRefSet(certType: string | undefined): Set<string> {
  if (certType === 'EIC') {
    return new Set(EIC_SCHEDULE.map((item) => item.ref));
  }
  const refs = new Set<string>();
  for (const section of EICR_SCHEDULE) {
    for (const item of section.items) refs.add(item.ref);
  }
  return refs;
}

/** iOS-canon observation dedup. Tests bidirectional 40-char prefix
 *  match OR >70 % set-based word overlap. Catches "loose neutral
 *  terminal" matching "loose neutral connection" which the old
 *  case-exact-only check let through as a duplicate row. */
function observationLooksDuplicate(candidate: string, existing: string): boolean {
  const a = candidate.toLowerCase().trim();
  const b = existing.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // 40-char bidirectional prefix match.
  const prefixA = a.slice(0, 40);
  const prefixB = b.slice(0, 40);
  if (a.startsWith(prefixB) || b.startsWith(prefixA)) return true;
  // >70 % word-set overlap.
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0) return false;
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap += 1;
  return overlap / wordsA.size > 0.7;
}

/** Fold new observations into the existing array.
 *
 *  iOS-parity behaviours applied (M-series audit fixes):
 *    M4 — captures `board_id` from the wire onto ObservationRow.
 *    M9 — dedup via iOS-canon 40-char prefix + 70 % word overlap
 *         (replaces the old case-exact-only check that let Sonnet
 *         rewording slip past as a duplicate row).
 *    M10 — invalid BPG4 codes (anything outside C1/C2/C3/FI) cause
 *          the observation to be SKIPPED rather than landing as
 *          un-coded. Matches iOS behaviour at applySonnetObservations
 *          :5501-5508. The drop is logged so support can see why.
 *    M11 — schedule_item refs are validated against the cert-type-
 *          aware schedule reference. Unknown refs are stripped from
 *          the row (the observation still lands; just without the
 *          dead back-reference).
 *
 *  Captures `observation_id` (server-assigned UUID) into row.server_id
 *  so a follow-up `observation_update` (BPG4 refinement) can patch the
 *  exact row even after the visible text changes. */
/** Result of a `applyObservations` fold.
 *
 *  P7 (marker ④): side-effects (pending-photo attach, reverse-link feed) and
 *  downstream schedule projection must fire on ACCEPTED creations / explicit
 *  field-fills — NEVER a raw replay frame. So the fold TRACKS which incoming
 *  observations it actually accepted (`acceptedForSchedule`) and returns the
 *  mutated rows separately; the caller drives `markScheduleItemsFromObservations`
 *  from `acceptedForSchedule`, not the raw `observations` array. */
type ApplyObservationsResult = {
  rows: ObservationRow[];
  /** Observations that should drive inspection-schedule projection — new
   *  creations plus idempotent-replays that filled a previously-ABSENT
   *  schedule_item. A replay whose schedule_item was already set is NOT
   *  included (re-projecting it would resurrect an outcome the inspector has
   *  since cleared/edited). */
  acceptedForSchedule: Observation[];
};

function applyObservations(
  job: JobDetail,
  observations: Observation[],
  options: {
    pendingPhoto?: PendingObservationPhoto | null;
    onPhotoAttached?: (blobId: string) => void;
    onLastObservationCreated?: (id: string, timestamp: number) => void;
  } = {}
): ApplyObservationsResult | null {
  if (observations.length === 0) return null;
  const existing = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const certType = typeof job.certificate_type === 'string' ? job.certificate_type : 'EICR';
  const validScheduleRefs = buildScheduleRefSet(certType);
  let changed = false;
  const acceptedForSchedule: Observation[] = [];
  // Track the count of pre-existing rows so we can compute which
  // appends are *new this turn* (vs. those carried in from the job
  // snapshot). The reverse-link helper only fires for new rows.
  const baselineCount = existing.length;
  for (const obs of observations) {
    const text = (obs.observation_text ?? '').trim();
    if (!text) continue;
    // M10 — drop invalid codes outright.
    const code = parseObservationCode(obs.code);
    if (!code && obs.code != null && String(obs.code).trim() !== '') {
      pipelineLog('apply_observations_dropped_invalid_code', {
        raw_code: String(obs.code).slice(0, 16),
        text_preview: text.slice(0, 40),
      });
      continue;
    }
    const incomingServerId =
      typeof obs.observation_id === 'string' && obs.observation_id.length > 0
        ? obs.observation_id
        : null;

    // P7 (marker ④, feedback id 82) — observation identity is SERVER-OWNED.
    // The backend runs its own dedupe/refinement pipeline and stamps every
    // created observation with a stable `observation_id`, so a server-created
    // observation arriving here is already deduped and authoritative. The old
    // client-side text-similarity gate (`observationLooksDuplicate`, >0.7 word
    // overlap / 40-char prefix) was a redundant belt-and-braces filter that
    // FALSE-POSITIVE-swallowed genuinely distinct observations sharing common
    // electrical vocabulary (the session-36731498 top-hole-vs-side-hole drop:
    // heard, never written — an inverse Audio-First violation). Key dedupe on
    // the server id instead:
    //  • non-nil id already present → IDEMPOTENT REPLAY (a P4d reconnect
    //    replays the ORIGINAL extraction frame PRESERVING ids). Fill only
    //    fields still ABSENT and SKIP every creation side-effect (append,
    //    pending-photo attach, reverse-link) AND raw-frame schedule projection.
    //    Never overwrite a since-refined field from the stale replay payload —
    //    authoritative changes remain applyObservationUpdate's job.
    //  • non-nil id NOT seen → apply (server authoritative, deduped).
    //  • nil/empty id (older servers omit it) → retain the text-similarity
    //    fallback for id-less rows ONLY so a nil-id replay can't duplicate.
    if (incomingServerId) {
      const alreadyPresent = existing.some((o) => o.server_id === incomingServerId);
      if (alreadyPresent) {
        // IDEMPOTENT REPLAY — PURE NO-OP. A P4d reconnect replays the ORIGINAL
        // extraction frame PRESERVING ids. Because it is the SAME frame the
        // original apply already consumed, "filling absent fields" from it can
        // only ever (a) no-op — the frame carries nothing the row lacks — or
        // (b) RESTORE a field an authoritative observation_update has since
        // CLEARED (regulation_title/description clear to null on a table-miss
        // refinement; schedule linking is owned by the create path). So a
        // replay fills NOTHING and skips every creation side-effect (append,
        // pending-photo attach, reverse-link) AND schedule projection.
        // Authoritative field changes remain applyObservationUpdate's job. The
        // plan permits "at most fill absent" — filling none is faithful + safer.
        pipelineLog('apply_observations_idempotent_replay', {
          server_id: incomingServerId.slice(0, 8),
        });
        continue;
      }
      // non-nil id NOT seen — fall through to the create path (authoritative).
    } else {
      // M9 / nil-id fallback — text-similarity dedup for id-less rows ONLY.
      const duplicate = existing.some((o) => observationLooksDuplicate(text, o.description ?? ''));
      if (duplicate) {
        pipelineLog('apply_observations_dedup_skip', {
          text_preview: text.slice(0, 40),
        });
        continue;
      }
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `obs-${Date.now()}-${existing.length + 1}`;
    const row: ObservationRow = {
      id,
      // Persist the server-assigned `observation_id` so follow-up
      // `observation_update` frames can patch this row by stable id
      // even when Sonnet rewords the description between extraction
      // and BPG4-resolved refinement.
      ...(obs.observation_id ? { observation_id: obs.observation_id } : {}),
      code,
      description: text,
      location: obs.item_location ?? undefined,
    };
    if (obs.observation_id) row.server_id = obs.observation_id;
    if (obs.regulation) row.regulation = obs.regulation;
    // obs-#51 / obs-#52 Fix B (WS3 item 3, 2026-07-02) — carry the "why
    // this code" rationale and the canonical BS 7671 wording from the
    // initial extraction onto the row. iOS parity: applySonnetObservations
    // sets all three (DeepgramRecordingViewModel.swift:7235/:7253).
    if (obs.rationale) row.rationale = obs.rationale;
    if (obs.regulation_title) row.regulation_title = obs.regulation_title;
    if (obs.regulation_description) row.regulation_description = obs.regulation_description;
    // M11 — schedule_item validation. Drop the back-reference if
    // the ref isn't in the cert-type schedule. Observation still
    // lands; it just won't render under the Inspection-tab preview.
    if (obs.schedule_item) {
      if (validScheduleRefs.has(obs.schedule_item)) {
        row.schedule_item = obs.schedule_item;
      } else {
        pipelineLog('apply_observations_invalid_schedule_item', {
          ref: obs.schedule_item.slice(0, 16),
          cert_type: certType,
        });
      }
    }
    // M4 — board_id capture for multi-board attribution.
    if (typeof obs.board_id === 'string' && obs.board_id) {
      row.board_id = obs.board_id;
    }
    existing.push(row);
    changed = true;
    // Project the schedule from the NORMALISED row, not the raw wire obs: use
    // the VALIDATED `row.schedule_item` (an M11-invalid ref was stripped → no
    // orphan schedule key) and the parsed `code` (so `markScheduleItems…`
    // never marks an outcome from an unvalidated ref or an unparsed code).
    acceptedForSchedule.push({ ...obs, code, schedule_item: row.schedule_item });
  }
  if (!changed) return null;

  // Side-effects fire ONLY on a real append (P7): a fill-absent replay sets
  // `changed` but appends nothing, so gating the pending-photo attach /
  // reverse-link on `changed` would attach a photo to `existing[last]`
  // (a pre-existing row) despite no new observation. Gate on the append.
  const appended = existing.length > baselineCount;
  if (appended) {
    // Forward-link: attach the pending photo to the LAST appended
    // observation if it's still within the 60 s auto-link window.
    // The merge helper is pure — it returns `true` iff it mutated
    // newRows[last]. On a successful attach we invoke the callback
    // so the caller can drain the pending state (ref + IDB).
    if (options.pendingPhoto) {
      const attached = mergePendingPhotoIntoObservations(existing, options.pendingPhoto);
      if (attached) {
        pipelineLog('apply_observations_photo_forward_linked', {
          blob_id: options.pendingPhoto.blobId,
          has_filename: Boolean(options.pendingPhoto.filename),
          row_count: existing.length,
        });
        options.onPhotoAttached?.(options.pendingPhoto.blobId);
      }
    }
    // Reverse-link feed: record the LAST appended observation so a
    // subsequent photo capture can attach to it directly (Phase 4).
    const last = existing[existing.length - 1];
    options.onLastObservationCreated?.(last.id, Date.now());
  }
  return { rows: existing, acceptedForSchedule };
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
    rationale?: string | null;
    /** obs-#52 Fix B — canonical wording for the REFINED ref. Applied
     *  UNCONDITIONALLY on the update path: null/absent (table MISS)
     *  CLEARS stale wording carried from a prior ref, mirroring iOS
     *  handleObservationUpdate's unconditional assignment. */
    regulation_title?: string | null;
    regulation_description?: string | null;
  }
): ObservationRow[] | null {
  const existing = [...((job.observations as ObservationRow[] | undefined) ?? [])];
  const fuzzyKey = (update.original_text ?? update.observation_text ?? '').toLowerCase().trim();
  const hasIncomingId =
    typeof update.observation_id === 'string' && update.observation_id.length > 0;
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
        // P7 (marker ④): SCOPE the fuzzy fallback. When the update carries a
        // non-empty observation_id that MISSED, NEVER fuzzy-match a row already
        // carrying a DIFFERENT server_id — it's a distinct server-owned
        // observation (the same side/top-hole shape). Only legacy (no-server_id)
        // rows may fuzzy-match; the incoming id is then STAMPED onto the matched
        // row below so future updates match by id. A nil incoming id keeps the
        // unrestricted fuzzy (older-server compat — no id to conflict).
        if (hasIncomingId && existing[i].server_id) continue;
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
    // obs-#51 / obs-#52 Fix B — carry rationale + canonical wording onto
    // the CREATE-from-miss row (iOS: newObs.rationale/.regulationTitle/
    // .regulationDescription in handleObservationUpdate's append paths).
    if (update.rationale) newRow.rationale = update.rationale;
    if (update.regulation_title) newRow.regulation_title = update.regulation_title;
    if (update.regulation_description) {
      newRow.regulation_description = update.regulation_description;
    }
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
  // obs-#51 — refined rationale overwrites only when non-empty (iOS:
  // `if let newRationale = update.rationale, !newRationale.isEmpty`).
  if (update.rationale && update.rationale !== before.rationale) {
    next.rationale = update.rationale;
    changed = true;
  }
  // obs-#52 Fix B — canonical wording is set UNCONDITIONALLY so a
  // refinement whose new ref is a table MISS (title/description null)
  // CLEARS any stale HIT wording carried from the prior ref — the card
  // then falls back to the model `regulation` string. Mirrors iOS
  // handleObservationUpdate's unconditional assignment
  // (DeepgramRecordingViewModel.swift, obs-#52 Fix B comment).
  const nextTitle = update.regulation_title ?? undefined;
  if (nextTitle !== before.regulation_title) {
    next.regulation_title = nextTitle;
    changed = true;
  }
  const nextDescription = update.regulation_description ?? undefined;
  if (nextDescription !== before.regulation_description) {
    next.regulation_description = nextDescription;
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

/** Bonding-row PASS synonyms iOS maps to "PASS" before deciding
 *  whether to fire `autoContinuityIfBonded`. Keeps the same
 *  acceptance band as the iOS tab-edit path so Sonnet's bonding
 *  writes ("yes", "confirmed", "installed") trigger the same
 *  derived `main_bonding_continuity` flag. */
const BONDING_PASS_SYNONYMS: ReadonlySet<string> = new Set([
  'pass',
  'yes',
  'confirmed',
  'ok',
  'done',
  'present',
  'installed',
  '✓',
  'true',
]);

function normaliseBondingValue(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (BONDING_PASS_SYNONYMS.has(s)) return 'PASS';
  return null;
}

const BONDING_KEYS: ReadonlyArray<string> = [
  'bonding_water',
  'bonding_gas',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
  'bonding_other',
];

/**
 * Apply iOS-parity SUPPLY-side derivations to a just-built section
 * patch, mirroring the side effects that fire on Supply-tab edits:
 *
 *   - `earthing_arrangement = 'TT'` →
 *       supply.means_earthing_electrode = true
 *       supply.means_earthing_distributor = false
 *       inspection_schedule.is_tt_earthing = true
 *   - Bonding-row PASS (under any of the 5 extraneous-bond keys) →
 *       supply.main_bonding_continuity = 'PASS' (when empty / N/A).
 *     Sonnet's synonym variants are normalised to "PASS" first.
 *   - Numeric Ze reading →
 *       supply.supply_polarity_confirmed = true (when not set)
 *       supply.earthing_conductor_continuity = 'PASS' (when empty /
 *       N/A)
 *
 * iOS canon:
 *   - SupplyTab.swift `setEarthingArrangement` (TT mirror)
 *   - SupplyTab.swift `autoContinuityIfBonded` (M2)
 *   - SupplyTab.swift `handleZeChange` lines 377-395 (M3)
 *
 * Mutates `patch` in place; pure on `job` (reads only). Idempotent —
 * re-running on the same patch produces no further change.
 */
function applySupplyDerivations(job: JobDetail, patch: Partial<JobDetail>): void {
  const supplyPatch = patch.supply_characteristics as Record<string, unknown> | undefined;
  if (!supplyPatch) return;
  const existingSupply = (job.supply_characteristics as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...existingSupply, ...supplyPatch };

  // M1 — TT mirror.
  if (typeof supplyPatch.earthing_arrangement === 'string') {
    if (supplyPatch.earthing_arrangement === 'TT') {
      if (!hasValue(merged.means_earthing_electrode)) {
        supplyPatch.means_earthing_electrode = true;
      }
      if (!hasValue(merged.means_earthing_distributor)) {
        supplyPatch.means_earthing_distributor = false;
      }
      // Mirror into inspection_schedule too. iOS canon writes both in
      // the same patch.
      const existingSchedule =
        (job.inspection_schedule as Record<string, unknown> | undefined) ?? {};
      const schedulePatch = (patch.inspection_schedule as Record<string, unknown> | undefined) ?? {
        ...existingSchedule,
      };
      if (schedulePatch.is_tt_earthing !== true) {
        schedulePatch.is_tt_earthing = true;
        patch.inspection_schedule = schedulePatch;
      }
      pipelineLog('apply_supply_tt_mirror', {});
    }
  }

  // M2 — bonding PASS → main_bonding_continuity.
  let bondingPass = false;
  for (const key of BONDING_KEYS) {
    if (!(key in supplyPatch)) continue;
    const normalised = normaliseBondingValue(supplyPatch[key]);
    if (normalised === 'PASS') {
      // Normalise the bonding cell itself so the cert reads "PASS"
      // not "yes" / "confirmed".
      supplyPatch[key] = 'PASS';
      bondingPass = true;
    }
  }
  if (bondingPass) {
    const current =
      typeof merged.main_bonding_continuity === 'string' ? merged.main_bonding_continuity : '';
    if (!current || current === 'N/A') {
      supplyPatch.main_bonding_continuity = 'PASS';
      pipelineLog('apply_supply_bonding_pass_mirror', {});
    }
  }

  // M3 — Ze → polarity + earthing continuity. Skip when the user has
  // EXPLICITLY set polarity_confirmed (either true or false — the
  // hasValue check matches both). iOS tracks an explicit manual-
  // override set on the Supply tab; the apply path lacks that
  // observer, so the safest invariant is "never clobber an existing
  // boolean value". A false user-value stays false.
  const zeRaw = supplyPatch.earth_loop_impedance_ze ?? supplyPatch.ze ?? undefined;
  if (typeof zeRaw === 'string') {
    const n = Number(zeRaw.trim());
    if (Number.isFinite(n) && zeRaw.trim() !== '') {
      if (!hasValue(merged.supply_polarity_confirmed)) {
        supplyPatch.supply_polarity_confirmed = true;
      }
      const continuity =
        typeof merged.earthing_conductor_continuity === 'string'
          ? merged.earthing_conductor_continuity
          : '';
      if (!continuity || continuity === 'N/A') {
        supplyPatch.earthing_conductor_continuity = 'PASS';
      }
      pipelineLog('apply_supply_ze_polarity_mirror', {});
    }
  }
}

/**
 * Build the `inspection_schedule.items` patch that mirrors Sonnet's
 * coded observations onto the BS 7671 Appendix 6 schedule. iOS canon:
 * when an inspector dictates "the kitchen socket is loose, item 4.4",
 * Sonnet emits an observation `{code: 'C2', schedule_item: '4.4',
 * observation_text: …}` and iOS auto-stamps
 * `inspection_schedule.items['4.4'] = 'C2'` — so the Inspection tab's
 * schedule row shows the outcome ticked alongside the observation
 * preview, without the inspector having to tap through the manual
 * outcome flow.
 *
 * The PWA's Inspection page already renders the linked-observation
 * preview via `observationForRef` (`inspection/page.tsx:123-130`), but
 * the outcome itself stayed unset because nothing on the apply path
 * wrote to `inspection_schedule.items`. This helper closes the gap.
 *
 * Priority guard: never overwrite a user-set outcome. If the
 * inspector has already manually marked the ref (PASS / N/A /
 * different code), the helper leaves it alone — Sonnet's role is to
 * fill blanks, not contradict the inspector.
 *
 * Returns the merged `items` record, or null when no schedule mirror
 * applies (no coded observation with a schedule_item, or every
 * candidate is already set).
 */
function markScheduleItemsFromObservations(
  job: JobDetail,
  observations: Observation[]
): Record<string, ScheduleOutcome> | null {
  if (observations.length === 0) return null;
  const existingSchedule = (job.inspection_schedule as Record<string, unknown> | undefined) ?? {};
  const existingItems =
    (existingSchedule.items as Record<string, ScheduleOutcome | undefined> | undefined) ?? {};
  const updates: Record<string, ScheduleOutcome> = {};
  for (const obs of observations) {
    const ref = obs.schedule_item;
    if (typeof ref !== 'string' || ref.length === 0) continue;
    const code = parseObservationCode(obs.code);
    if (!code) continue;
    // FI ("Further Investigation") is a valid observation code but not a
    // ScheduleOutcome (the schedule enum is tick / N/A / C1 / C2 / C3 /
    // LIM). Skip — the observation still lands on the row; just no
    // schedule auto-mark.
    if (code === 'FI') continue;
    // 3-tier priority — never clobber a user-set outcome. Empty /
    // missing / undefined are open for Sonnet to fill.
    if (hasValue(existingItems[ref])) {
      pipelineLog('apply_schedule_outcome_user_value_kept', {
        ref,
        existing_outcome: existingItems[ref],
        sonnet_code: code,
      });
      continue;
    }
    // Coalesce: if multiple observations target the same ref in one
    // turn (unusual but defensive), last wins — same policy as
    // applyObservations' dedup-by-text loop.
    updates[ref] = code;
  }
  if (Object.keys(updates).length === 0) return null;
  pipelineLog('apply_schedule_outcomes_marked', { refs: Object.keys(updates) });
  // Filter out the optional-undefined entries from the existing map so
  // the returned record is type-safe `Record<string, ScheduleOutcome>`.
  // `existingItems` is declared with `| undefined` to model the
  // Sonnet-deleted case; persisted state never carries actual undefined
  // values for set keys, so filtering is a defensive no-op.
  const merged: Record<string, ScheduleOutcome> = {};
  for (const [key, value] of Object.entries(existingItems)) {
    if (value != null) merged[key] = value;
  }
  Object.assign(merged, updates);
  return merged;
}

/** Sections whose flat records feed LiveFillState section keys. */
const SCALAR_SECTIONS: Section[] = [
  'installation_details',
  'supply_characteristics',
  'board_info',
  'extent_and_type',
  'design_construction',
];

/** LiveFillView uses short-form section prefixes on its `fieldKey`
 *  props (e.g. `installation.client_name`). The wire-shape Section type
 *  uses the backend-canonical long-form (`installation_details`), so the
 *  diff must emit the short form to keep the "just changed" flash
 *  firing on real-time Sonnet updates. Map here at the emission boundary
 *  rather than renaming all 31 fieldKey props — the short form is a
 *  pure-client identifier with no wire-shape implication. */
const SECTION_LIVE_FILL_PREFIX: Record<Section, string> = {
  installation_details: 'installation',
  supply_characteristics: 'supply',
  board_info: 'board',
  extent_and_type: 'extent',
  design_construction: 'design',
};

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
  const prefix = SECTION_LIVE_FILL_PREFIX[section];
  for (const field of Object.keys(after)) {
    if (prev[field] !== after[field] && hasValue(after[field])) {
      keys.push(`${prefix}.${field}`);
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
  readings: ExtractedReading[],
  boardPlans: Map<ExtractedReading, BoardReadingPlan>
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
    // A2-multiboard item 7 — the BOARDS leg of the flagged-replacement
    // preflight. When `planBoardReadingRoutes` resolved a concrete
    // target it has ALREADY done the routing (and rejected the orphan case),
    // so this leg takes the planned index verbatim rather than re-deriving
    // it: two independent derivations of the same answer is exactly how the
    // two legs would drift apart. A planned `boardIdx` also bypasses the two
    // fill-only gates below, in lock-step with the section leg's bypass.
    const boardPlan = boardPlans.get(reading);
    if (boardPlan) {
      if (boardPlan.boardIdx == null) {
        // Section-only (a global-scoped `ze`/`pfc`) or declined (orphan).
        // Either way there is no board copy to write; both were logged by
        // the preflight.
        continue;
      }
      const idx = boardPlan.boardIdx;
      const pending = updatesByIndex.get(idx) ?? {};
      pending[mirror.boardKey] = reading.value;
      updatesByIndex.set(idx, pending);
      pipelineLog(
        boardPlan.bypassFillOnly
          ? 'apply_boards_mirror_replaces_cleared_bypass'
          : 'apply_boards_mirror_board_scoped',
        {
          target_index: idx,
          board_key: mirror.boardKey,
          board_id: reading.board_id ?? null,
        }
      );
      continue;
    }

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
  result: ExtractionResult,
  options: ApplyExtractionOptions = {}
): AppliedExtraction | null {
  const readings = (result.readings ?? []).filter((reading) => {
    if (clientReadingRoute(reading.field) != null) return true;
    pipelineLog('apply_reading_off_manifest_dropped', {
      field: reading.field,
      circuit: reading.circuit,
      board_id: reading.board_id ?? null,
    });
    return false;
  });
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

  // A2-multiboard item 7 — decide the flagged board-replacement routing ONCE,
  // before either leg runs, and hand the SAME plan to both. The section leg
  // and the boards[] leg iterate `readings` independently; if they each
  // derived "should I bypass, and onto which board?" for themselves, a
  // divergence would leave the Supply/Board tab and the boards[] record
  // disagreeing about what the inspector just said.
  const boardPlans = planBoardReadingRoutes(job, readings);

  // Circuit 0 readings — split by section.
  const supplyPatches = applyCircuit0Readings(job, readings, boardPlans);
  for (const section of Object.keys(supplyPatches) as Section[]) {
    const merged = supplyPatches[section];
    if (merged) patch[section] = merged;
  }

  // M1+M2+M3 — apply Supply-side derivations that mirror tab-edit
  // side effects (TT → schedule mirror, bonding PASS, Ze polarity).
  applySupplyDerivations(job, patch);

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

  // Per-circuit readings + updates + clears. Thread options so
  // ensureRow can apply user defaults on circuit creation (H7 parity).
  // `board_ops` rides the SAME envelope but is applied by the caller
  // AFTER this returns (`onBoardOps` fires after `onExtraction` —
  // sonnet-session.ts). The A2 gate below therefore has to read the ops
  // itself; by the time boards[] reflects them the readings have landed.
  let newCircuits = applyCircuitReadings(
    job,
    readings,
    circuitUpdates,
    fieldClears,
    result.board_ops ?? [],
    options
  );
  if (newCircuits) patch.circuits = newCircuits;

  // H3 — auto-compute `ocpd_max_zs_ohm` for any circuit whose OCPD
  // fields are now resolvable (type + rating + disconnect time). iOS
  // canon: `Circuit.recalculateMaxZs()`. The lookup is pure; we run
  // it on the just-built circuits[] patch so a same-turn write to
  // `ocpd_type` / `ocpd_rating_a` / `max_disconnect_time_s` (defaults
  // applied an instant ago) immediately produces the BS 7671 max Zs
  // ceiling without waiting for the next turn.
  const targetCircuits = newCircuits ?? (job.circuits as CircuitRow[] | undefined);
  if (Array.isArray(targetCircuits) && targetCircuits.length > 0) {
    // P3 Fix 6 — before/after view for the OCPD-rating → max-Zs invalidation.
    // Index the UNPATCHED job circuits so we can recover each row's PRE-write
    // ocpd_rating_a (the patched row already carries the LIM). Keyed by stable
    // row id when present, else by (board_id, circuit_ref) — NOT circuit_ref
    // alone, so a multi-board job where main + sub-board both have circuit 1
    // doesn't collide (which would evaluate provenance against the wrong
    // board's rating).
    const priorRowKey = (r: CircuitRow): string | null => {
      if (r.id != null && r.id !== '') return `id:${r.id}`;
      const ref = r.circuit_ref ?? r.number;
      if (ref == null) return null;
      const board = typeof r.board_id === 'string' ? r.board_id : '';
      return `br:${board}|${ref}`;
    };
    const priorByRef = new Map<string, CircuitRow>();
    for (const p of (job.circuits as CircuitRow[] | undefined) ?? []) {
      const k = priorRowKey(p);
      if (k != null) priorByRef.set(k, p);
    }
    let mzsChanged = false;
    const nextCircuits = targetCircuits.map((row) => {
      const type = typeof row.ocpd_type === 'string' ? row.ocpd_type : '';
      const rating = typeof row.ocpd_rating_a === 'string' ? row.ocpd_rating_a : '';
      const disc =
        typeof row.max_disconnect_time_s === 'string'
          ? (row.max_disconnect_time_s as string)
          : undefined;
      const computed =
        type && rating ? maxZsString({ deviceType: type, rating, disconnectTime: disc }) : null;

      if (computed == null) {
        // P3 Fix 6 — the rating is no longer usable for a max-Zs lookup (it
        // just became a non-numeric sentinel like LIM). An AUTO-DERIVED numeric
        // ocpd_max_zs_ohm would otherwise persist STALE (iOS nils it →
        // cross-platform divergence, and a stale max-Zs feeds a false circuit
        // result). The before/after transition helper clears it ONLY when it
        // was auto-derived (preserving a manual override).
        const rowKey = priorRowKey(row);
        const prior = rowKey != null ? priorByRef.get(rowKey) : undefined;
        if (shouldClearAutoDerivedMaxZs(prior, row)) {
          mzsChanged = true;
          return { ...row, ocpd_max_zs_ohm: '' };
        }
        return row;
      }

      // 3-tier priority — never overwrite a user-typed override.
      if (hasValue(row.ocpd_max_zs_ohm)) return row;
      if (row.ocpd_max_zs_ohm === computed) return row;
      mzsChanged = true;
      return { ...row, ocpd_max_zs_ohm: computed };
    });
    if (mzsChanged) {
      newCircuits = nextCircuits;
      patch.circuits = nextCircuits;
      pipelineLog('apply_circuit_max_zs_computed', {
        touched: nextCircuits.filter((r, i) => r !== targetCircuits[i]).length,
      });
    }
  }

  // H4 — Zs ↔ R1+R2 ↔ Ze derivation. After all readings + the max-Zs
  // pass land, run `recomputeAll` to fill any third unknown using the
  // BS 7671 Zs = Ze + (R1+R2) identity. Pure on the JobDetail —
  // takes the patched supply + circuits views. Only fills empty
  // targets; an inspector value never gets re-derived.
  const projectedForDerive: JobDetail = {
    ...job,
    ...(patch as Partial<JobDetail>),
  } as JobDetail;
  const derivedCircuits = recomputeAll(projectedForDerive as never);
  if (derivedCircuits) {
    patch.circuits = derivedCircuits as unknown as CircuitRow[];
    pipelineLog('apply_circuit_derivation_recomputed', {
      circuit_count: derivedCircuits.length,
    });
  }

  // Board mirror — populate the right entry in `boards[]` so the
  // Board tab renders Sonnet-extracted manufacturer, main_switch_bs_en,
  // earthing_arrangement, ze, zs_at_db. Iterates over readings so
  // each one's `board_id` controls which board record receives the
  // value. Multi-board jobs without a board_id are deliberately
  // skipped — the apply path refuses to guess.
  const newBoards = mirrorReadingsToBoards(job, readings, boardPlans);
  if (newBoards) patch.boards = newBoards;

  // M7 — EIC cert-type guards. iOS `applySonnetObservations :5473`
  // early-returns when `certificate_type == .eic` (EICs are for new
  // installs and must not carry observations), and drops the five
  // EICR-only installation fields on cert-type mismatch. Defence in
  // depth — the backend prompt gates most of this, but a buggy or
  // mid-deploy mismatch would otherwise let EICR-shaped data land
  // on an EIC. Same set as iOS at :4326-:4395.
  const isEic = job.certificate_type === 'EIC';
  if (isEic) {
    const install = patch.installation_details as Record<string, unknown> | undefined;
    if (install) {
      const eicrOnlyKeys: ReadonlyArray<string> = [
        'reason_for_report',
        'date_of_previous_inspection',
        'previous_certificate_number',
        'estimated_age_of_installation',
        'general_condition',
        'general_condition_of_installation', // PWA-column dual-write of general_condition
      ];
      let stripped = false;
      const next = { ...install };
      for (const key of eicrOnlyKeys) {
        if (key in next) {
          delete next[key];
          stripped = true;
        }
      }
      if (stripped) {
        patch.installation_details = next;
        pipelineLog('apply_eic_stripped_eicr_only_install_fields', {});
      }
    }
  }

  // Observations.
  const obsResult =
    isEic && observations.length > 0
      ? null
      : applyObservations(job, observations, {
          pendingPhoto: options.pendingPhoto,
          onPhotoAttached: options.onPhotoAttached,
          onLastObservationCreated: options.onLastObservationCreated,
        });
  if (obsResult) patch.observations = obsResult.rows;
  if (isEic && observations.length > 0) {
    pipelineLog('apply_eic_dropped_observations', {
      dropped_count: observations.length,
    });
  }

  // Mirror coded observations onto inspection_schedule.items — iOS
  // canon auto-marks the schedule row when a `schedule_item`-tagged
  // observation lands. Without this the linked-observation preview
  // shows up on the Inspection tab but the outcome column stays
  // blank, forcing the inspector to manually tick what they already
  // dictated.
  //
  // P7 (marker ④): project from the observations `applyObservations` ACTUALLY
  // accepted (new creations + newly-filled schedule_items) — NEVER the raw
  // frame. A P4d reconnect replays the ORIGINAL observation frame; consuming it
  // raw here would re-project a schedule outcome the inspector has since cleared
  // or edited (the `hasValue` user-set guard only protects an already-SET
  // outcome, so a CLEARED ref would silently re-appear). On the EIC drop path
  // (observations discarded) the schedule frame is empty — unchanged behaviour.
  const scheduleObservations =
    isEic && observations.length > 0 ? [] : (obsResult?.acceptedForSchedule ?? []);
  const newScheduleItems = markScheduleItemsFromObservations(job, scheduleObservations);
  if (newScheduleItems) {
    const existingSchedule = (job.inspection_schedule as Record<string, unknown> | undefined) ?? {};
    patch.inspection_schedule = { ...existingSchedule, items: newScheduleItems };
  }

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

/**
 * Apply Sonnet's per-turn `board_ops` to a JobDetail. iOS canon:
 * `DeepgramRecordingViewModel.swift:5205 applyBoardOpsToJob`.
 *
 * Returns the mutated JobDetail subset (boards + optionally circuits)
 * as a partial patch, or null when no op had a visible effect.
 *
 * Op semantics:
 *   - `add_board`: appends a new entry to `job.boards` carrying id +
 *     designation + board_type + parent_board_id + feed_circuit_ref.
 *     Idempotent on `board_id`: a re-emit (session_resume rehydrate,
 *     duplicate tool-loop fire) is dropped silently.
 *   - `select_board`: NO-OP here. The unified `current_board_changed`
 *     WS broadcast is the source of truth for active-board state;
 *     applying it twice would race the broadcast handler.
 *   - `mark_distribution_circuit`: stamps `is_distribution_circuit:
 *     'yes'` + `feeds_board_id: <child id>` on the matching
 *     `boards[source].circuits[circuit_ref]` row (or `job.circuits`
 *     fallback for legacy single-board snapshots). Skipped when the
 *     source circuit row isn't found.
 *
 * NB on circuit storage: the PWA stores per-board circuits in
 * `boards[i].circuits[]` (multi-board snapshot — iOS canon) AND a
 * flat top-level `job.circuits[]` (single-board legacy). The
 * apply-extraction path writes the flat top-level today; the
 * mark-distribution mutation here targets WHATEVER shape is present,
 * preferring the nested form when the source board has its own
 * circuits[] populated.
 *
 * NB on userDefaults: intentionally NOT threaded through this
 * function. iOS canon `DeepgramRecordingViewModel.swift:5205-5320`
 * doesn't call `DefaultsService.applyDefaults` for any board op
 * either: `add_board` writes structural fields only,
 * `mark_distribution_circuit` mutates two fields on an existing
 * row, and `select_board` is inert. Circuit-level defaults flow
 * through `applyExtractionToJob` (record_reading / add_circuit
 * paths) where new rows are actually created.
 */
export function applyBoardOpsToJob(job: JobDetail, ops: BoardOp[]): Partial<JobDetail> | null {
  if (!Array.isArray(ops) || ops.length === 0) return null;

  let boards = (job.boards as Record<string, unknown>[] | undefined)?.slice();
  let circuits = (job.circuits as CircuitRow[] | undefined)?.slice();
  let touched = false;

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'add_board') {
      const bid = op.board_id;
      if (typeof bid !== 'string' || !bid) {
        pipelineLog('apply_board_op_skipped', { op: 'add_board', reason: 'missing_id' });
        continue;
      }
      const existing = boards ?? [];
      if (existing.some((b) => b && (b as { id?: string }).id === bid)) {
        pipelineLog('apply_board_op_skipped', {
          op: 'add_board',
          reason: 'duplicate_id',
          board_id: bid,
        });
        continue;
      }
      const newBoard: Record<string, unknown> = {
        id: bid,
        designation: op.designation ?? null,
        board_type: op.board_type ?? 'sub_distribution',
      };
      if (op.parent_board_id != null) newBoard.parent_board_id = op.parent_board_id;
      if (op.feed_circuit_ref != null) newBoard.feed_circuit_ref = op.feed_circuit_ref;
      boards = [...existing, newBoard];
      touched = true;
      pipelineLog('apply_board_op_add_board', {
        board_id: bid,
        designation: typeof op.designation === 'string' ? op.designation.slice(0, 40) : null,
        board_type: newBoard.board_type,
      });
    } else if (op.op === 'mark_distribution_circuit') {
      const ref = op.circuit_ref;
      const childId = op.feeds_board_id;
      const sourceId = op.source_board_id ?? null;
      if (
        typeof ref !== 'number' ||
        !Number.isFinite(ref) ||
        typeof childId !== 'string' ||
        !childId
      ) {
        pipelineLog('apply_board_op_skipped', {
          op: 'mark_distribution_circuit',
          reason: 'invalid_payload',
        });
        continue;
      }
      let landed = false;
      // Prefer the per-board nested circuits when sourceId is given
      // and that board has its own circuits[] array.
      if (sourceId && boards) {
        const sourceIdx = boards.findIndex((b) => b && (b as { id?: string }).id === sourceId);
        if (sourceIdx !== -1) {
          const board = boards[sourceIdx] as Record<string, unknown>;
          const boardCircuits = Array.isArray(board.circuits)
            ? (board.circuits as CircuitRow[])
            : null;
          if (boardCircuits) {
            const rowIdx = boardCircuits.findIndex(
              (c) => (c.circuit_ref ?? c.number) === String(ref)
            );
            if (rowIdx !== -1) {
              const nextRow: CircuitRow = {
                ...boardCircuits[rowIdx],
                is_distribution_circuit: 'yes',
                feeds_board_id: childId,
              };
              const nextBoardCircuits = boardCircuits.slice();
              nextBoardCircuits[rowIdx] = nextRow;
              boards[sourceIdx] = { ...board, circuits: nextBoardCircuits };
              landed = true;
            }
          }
        }
      }
      // Fallback: flat top-level circuits[] (single-board legacy).
      if (!landed && circuits) {
        const rowIdx = circuits.findIndex((c) => (c.circuit_ref ?? c.number) === String(ref));
        if (rowIdx !== -1) {
          const nextRow: CircuitRow = {
            ...circuits[rowIdx],
            is_distribution_circuit: 'yes',
            feeds_board_id: childId,
          };
          circuits = circuits.slice();
          circuits[rowIdx] = nextRow;
          landed = true;
        }
      }
      if (landed) {
        touched = true;
        pipelineLog('apply_board_op_mark_distribution_circuit', {
          circuit_ref: ref,
          feeds_board_id: childId,
          source_board_id: sourceId,
        });
      } else {
        pipelineLog('apply_board_op_skipped', {
          op: 'mark_distribution_circuit',
          reason: 'source_circuit_not_found',
          circuit_ref: ref,
        });
      }
    } else if (op.op === 'select_board') {
      // Intentionally inert — see docstring. The current_board_changed
      // broadcast drives the active-board state.
      pipelineLog('apply_board_op_select_board_inert', { board_id: op.board_id });
    } else {
      pipelineLog('apply_board_op_unknown', { op: (op as { op?: string }).op ?? 'undefined' });
    }
  }

  if (!touched) return null;
  const patch: Partial<JobDetail> = {};
  if (boards) patch.boards = boards;
  if (circuits) patch.circuits = circuits;
  return patch;
}
