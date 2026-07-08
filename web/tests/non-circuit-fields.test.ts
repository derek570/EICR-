/**
 * A2 — non-circuit field rescue set + drift guard (sess_mrbnds2d_jczh).
 *
 * iOS canon: `DeepgramRecordingViewModel.swift` `Self.supplyFields`
 * (:10031-10087) rescues section-level readings from the circuit-orphan
 * buffer; the web D4 port omitted the rescue entirely, so "customer is
 * Michael Payden" produced a false "Which circuit was that client_name
 * Michael Payden reading for?" ask which preempt-flushed the queued
 * read-back (Audio-First invariant #1 violation).
 *
 * Drift guard design (web analogue of iOS `SchemaCoverageRescueTests`):
 * membership is asserted against the REAL `CIRCUIT_0_SECTION` route map,
 * not a copied literal — a raw key-set equality check would be both over-
 * and under-inclusive (default-routed and alias-translated fields exist on
 * both sides). Divergences are enumerated in DOCUMENTED exception lists;
 * any NEW divergence fails the test and forces a conscious decision.
 */
import { describe, it, expect, vi } from 'vitest';
import { NON_CIRCUIT_FIELDS, isNonCircuitField } from '@/lib/recording/non-circuit-fields';
import { __circuit0SectionRoutesForTests } from '@/lib/recording/apply-extraction';
import {
  classifyReadingsForBuffer,
  PendingReadingsBuffer,
  buildPendingReadingsQuestion,
} from '@/lib/recording/pending-readings-buffer';

/**
 * Explicit web section routes NOT in the iOS rescue set. iOS also buffers
 * these on a circuit-less reading (they are not `supplyFields` members), so
 * web matching iOS means NOT rescuing them either — the rescue set is a
 * VERBATIM iOS copy (iOS-is-canon). If iOS adds one of these to
 * `supplyFields`, add it to `NON_CIRCUIT_FIELDS` and delete it here.
 */
const ROUTED_BUT_NOT_RESCUED_IOS_PARITY: ReadonlySet<string> = new Set([
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
  'bonding_other',
  'earth_electrode_location',
  'earthing_conductor_material',
  'earthing_conductor_continuity',
  'main_bonding_material',
  'main_bonding_continuity',
  'nominal_voltage_uo',
  'live_conductors',
  'number_of_supplies',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  'client_address',
  'client_postcode',
  'client_town',
  'client_county',
]);

/**
 * Rescue-set members with NO explicit `CIRCUIT_0_SECTION` entry. They are
 * still correctly applied as section fields: either via the
 * default-to-supply fallback (`routeSupplyField` → 'supply_characteristics'
 * — e.g. the surge_* family, schema-coverage block) or because the name is
 * a PWA-column alias written by the dual-write path rather than a wire
 * route key (`earth_loop_impedance_ze`, `prospective_fault_current`,
 * `extent`). Rescuing them from the circuit buffer is therefore correct
 * even without an explicit route.
 */
const RESCUED_VIA_DEFAULT_SUPPLY_OR_ALIAS: ReadonlySet<string> = new Set([
  'earth_loop_impedance_ze',
  'prospective_fault_current',
  'main_switch_type',
  'main_switch_rating',
  'surge_spd_present',
  'surge_spd_type',
  'surge_spd_bs_en',
  'surge_status_indicator',
  'ze_at_db',
  'name',
  'location',
  'phases',
  'ipf_at_db',
  'bonding_conductor_material',
  'bonding_conductor_csa',
  'bonding_conductor_continuity',
  'bonding_other_na',
  'earthing_conductor_csa',
  'means_earthing_distributor',
  'means_earthing_electrode',
  'rcd_operating_current_test',
  'rcd_time_delay_test',
  'rcd_operating_time_test',
  'installation_records_available',
  'evidence_of_additions_alterations',
  'agreed_limitations',
  'agreed_with',
  'operational_limitations',
  'extent',
]);

describe('NON_CIRCUIT_FIELDS drift guard', () => {
  const routes = __circuit0SectionRoutesForTests();

  it('every explicit circuit-0 route is rescued OR documented as iOS-parity-not-rescued', () => {
    const undocumented = Object.keys(routes).filter(
      (field) => !isNonCircuitField(field) && !ROUTED_BUT_NOT_RESCUED_IOS_PARITY.has(field)
    );
    expect(undocumented).toEqual([]);
  });

  it('every rescue-set member has an explicit route OR is documented default-supply/alias', () => {
    const undocumented = [...NON_CIRCUIT_FIELDS].filter(
      (field) => !(field in routes) && !RESCUED_VIA_DEFAULT_SUPPLY_OR_ALIAS.has(field)
    );
    expect(undocumented).toEqual([]);
  });

  it('exception lists do not overlap the rescue set / route map (stale-entry guard)', () => {
    // A field added to NON_CIRCUIT_FIELDS later must be deleted from the
    // not-rescued exception list (and vice versa) — overlap means a stale doc.
    expect([...ROUTED_BUT_NOT_RESCUED_IOS_PARITY].filter((f) => isNonCircuitField(f))).toEqual([]);
    expect([...RESCUED_VIA_DEFAULT_SUPPLY_OR_ALIAS].filter((f) => f in routes)).toEqual([]);
  });

  it('key A2 members are present (session-log regression pins)', () => {
    // client_name is THE sess_mrbnds2d_jczh field; spd_*/surge_* are the
    // iOS Fix D1 / surge-box families the plan calls out explicitly.
    for (const f of ['client_name', 'address', 'spd_bs_en', 'surge_spd_type', 'ze', 'comments']) {
      expect(isNonCircuitField(f)).toBe(true);
    }
    // Deprecated aliases must NOT be members (canonicalised server-side).
    for (const f of ['main_fuse_bs_en', 'supply_fuse_rating', 'spd_type']) {
      expect(isNonCircuitField(f)).toBe(false);
    }
  });
});

describe('classifyReadingsForBuffer (A2 rescue behaviour)', () => {
  it('section reading with circuit:null is rescued — never buffered', () => {
    const { resolved, orphans, rescued } = classifyReadingsForBuffer(
      [{ field: 'client_name', value: 'Michael Payden', circuit: null }],
      isNonCircuitField
    );
    expect(rescued).toEqual([{ field: 'client_name', value: 'Michael Payden' }]);
    expect(orphans).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('section reading with circuit:-1 (iOS wire shape) is rescued too', () => {
    const { orphans, rescued } = classifyReadingsForBuffer(
      [{ field: 'spd_bs_en', value: '61643', circuit: -1 }],
      isNonCircuitField
    );
    expect(rescued).toHaveLength(1);
    expect(orphans).toEqual([]);
  });

  it('genuine circuit orphan (measured_zs_ohm, no circuit) still buffers', () => {
    const { orphans, rescued } = classifyReadingsForBuffer(
      [{ field: 'measured_zs_ohm', value: '0.35' }],
      isNonCircuitField
    );
    expect(orphans).toEqual([{ field: 'measured_zs_ohm', value: '0.35' }]);
    expect(rescued).toEqual([]);
  });

  it('circuit-attributed reading resolves regardless of rescue membership', () => {
    const { resolved, orphans, rescued } = classifyReadingsForBuffer(
      [{ field: 'measured_zs_ohm', value: '0.35', circuit: 3 }],
      isNonCircuitField
    );
    expect(resolved).toEqual([{ field: 'measured_zs_ohm', value: '0.35' }]);
    expect(orphans).toEqual([]);
    expect(rescued).toEqual([]);
  });
});

describe('A2 end behaviour — no false ask for section fields, real orphans still ask after 2s', () => {
  it('rescued section reading never reaches the buffer → no 2s ask fires', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const buffer = new PendingReadingsBuffer(onTimeout);
    const { orphans } = classifyReadingsForBuffer(
      [{ field: 'client_name', value: 'Michael Payden', circuit: null }],
      isNonCircuitField
    );
    if (orphans.length > 0) buffer.addAll(orphans); // recording-context wiring
    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('genuine orphan still asks "Which circuit…" after the 2s window (behaviour preserved)', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const buffer = new PendingReadingsBuffer(onTimeout);
    const { orphans } = classifyReadingsForBuffer(
      [{ field: 'measured_zs_ohm', value: '0.35' }],
      isNonCircuitField
    );
    if (orphans.length > 0) buffer.addAll(orphans);
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const question = buildPendingReadingsQuestion(onTimeout.mock.calls[0][0]);
    expect(question).toBe('Which circuit was that Zs 0.35 reading for?');
  });
});
