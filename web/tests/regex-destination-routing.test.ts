/**
 * A02D (Codex diff-review cycle 1, BLOCKER 2) — ONE destination-routing rule
 * for the matcher provenance, the freshness gate, cutoff identity and the
 * apply layer. Pins: every matcher-emittable field routes to a LABELLED
 * canonical destination (the five board-routed supply fields included), the
 * renamed installation field, and duplicate circuit refs resolved by board —
 * identically in `computeFreshRegexWrites` and `canonicalDestinationKey`.
 */
import { describe, expect, it } from 'vitest';
import {
  aliasFamily,
  canonicalFieldForAlias,
  indexCircuitRowsByRef,
  readEffectiveSectionValue,
  resolveRegexDestination,
  routeSectionField,
  SECTION_FIELD_ALIASES,
  SUPPLY_FIELD_TO_KEY,
  BOARD_FIELD_TO_KEY,
  INSTALLATION_FIELD_TO_KEY,
} from '@/lib/recording/regex-destination-routing';
import {
  DESTINATION_FIELD_LABELS,
  canonicalDestinationKey,
  describeDestination,
  destinationKeyFromChangedKey,
  diffRegexDestinations,
  isRegexDestinationKey,
  readRegexDestinationValue,
} from '@/lib/recording/regex-fresh-occurrence';
import {
  applyRegexMatchToJob,
  computeFreshRegexWrites,
  jobBaselineReader,
} from '@/lib/recording/apply-regex-match';
import { emptyRegexMatchResult } from '@/lib/recording/regex-match-result';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import type { JobDetail } from '@/lib/types';

function twoBoardJob(): JobDetail {
  return {
    id: 'j',
    job_id: 'j',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: '',
    last_modified: '',
    boards: [
      { id: 'b_main', designation: 'main', slug: 'main' },
      { id: 'b_garage', designation: 'garage', slug: 'garage' },
    ],
    circuits: [
      { id: 'row4_main', circuit_ref: '4', circuit_designation: 'Cooker', board_id: 'b_main' },
      { id: 'row3', circuit_ref: '3', circuit_designation: 'Kitchen ring', board_id: 'b_main' },
      {
        id: 'row4_garage',
        circuit_ref: '4',
        circuit_designation: 'Garage sockets',
        board_id: 'b_garage',
      },
    ],
    supply_characteristics: {},
    board_info: {},
    installation_details: {},
  } as unknown as JobDetail;
}

describe('[invariant] regex destination routing — one rule for every consumer', () => {
  it('every matcher-emittable section field routes to a labelled canonical destination', () => {
    const cases: Array<['supply' | 'board' | 'install', string]> = [
      ...Object.keys(SUPPLY_FIELD_TO_KEY).map((f) => ['supply', f] as ['supply', string]),
      ...Object.keys(BOARD_FIELD_TO_KEY).map((f) => ['board', f] as ['board', string]),
      ...Object.keys(INSTALLATION_FIELD_TO_KEY).map((f) => ['install', f] as ['install', string]),
    ];
    for (const [scope, field] of cases) {
      const route = routeSectionField(scope, field);
      expect(
        isRegexDestinationKey(route.trackerKey),
        `${scope}.${field} → ${route.trackerKey}`
      ).toBe(true);
      expect(canonicalDestinationKey(`${scope}.${field}`, twoBoardJob())).toBe(route.trackerKey);
    }
    // The fixture-pinned label table names every matcher field (pinned
    // byte-equal by regex-freshness-fixture.test.ts); every one resolves.
    for (const scope of ['supply', 'board', 'install'] as const) {
      for (const field of Object.keys(DESTINATION_FIELD_LABELS[scope])) {
        expect(canonicalDestinationKey(`${scope}.${field}`, twoBoardJob())).not.toBeNull();
      }
    }
  });

  it('the five board-routed supply fields canonicalise to board.* with their board labels', () => {
    const j = twoBoardJob();
    for (const f of [
      'main_switch_bs_en',
      'main_switch_current',
      'main_switch_conductor_csa',
      'spd_bs_en',
      'spd_rated_current',
    ]) {
      expect(canonicalDestinationKey(`supply.${f}`, j)).toBe(`board.${f}`);
      expect(describeDestination(`board.${f}`, j)).toBe(DESTINATION_FIELD_LABELS.board[f]);
    }
    expect(canonicalDestinationKey('install.general_condition_of_installation', j)).toBe(
      'install.general_condition'
    );
    expect(describeDestination('install.general_condition', j)).toBe('general condition');
    // A manual edit of the STORED field is diffed under the canonical key.
    const before = { ...j, installation_details: { general_condition: 'Satisfactory' } };
    const after = { ...j, installation_details: { general_condition: '' } };
    expect(diffRegexDestinations(before as JobDetail, after as JobDetail)).toEqual([
      { key: 'install.general_condition', cleared: true },
    ]);
    const b1 = { ...j, board_info: { main_switch_current: '100' } };
    const b2 = { ...j, board_info: { main_switch_current: '' } };
    expect(diffRegexDestinations(b1 as JobDetail, b2 as JobDetail)).toEqual([
      { key: 'board.main_switch_current', cleared: true },
    ]);
  });

  it('duplicate circuit refs resolve by ACTIVE board, then the default (first) board, never by array order', () => {
    const j = twoBoardJob();
    expect(indexCircuitRowsByRef(j, 'b_garage').get('4')).toBe(2);
    expect(indexCircuitRowsByRef(j, 'b_main').get('4')).toBe(0);
    expect(indexCircuitRowsByRef(j, null).get('4')).toBe(0); // default board = boards[0]
    expect(indexCircuitRowsByRef(j, 'b_unknown').get('4')).toBe(0);
    expect(canonicalDestinationKey('circuit.4.measured_zs_ohm', j, 'b_garage')).toBe(
      'circuit.row4_garage.measured_zs_ohm'
    );
    expect(canonicalDestinationKey('circuit.4.measured_zs_ohm', j)).toBe(
      'circuit.row4_main.measured_zs_ohm'
    );
    expect(resolveRegexDestination('circuit.4.measured_zs_ohm', j, 'b_garage')?.circuitIdx).toBe(2);
    // No boards at all: a row without board_id wins over one with a stray id.
    const legacy = {
      ...j,
      boards: undefined,
      circuits: [
        { id: 'stray', circuit_ref: '4', board_id: 'gone' },
        { id: 'plain', circuit_ref: '4' },
      ],
    } as unknown as JobDetail;
    expect(indexCircuitRowsByRef(legacy).get('4')).toBe(1);
  });

  it('alias families: the UI alias is the effective value; a page-style clear of the VISIBLE alias is a clear of the destination; a regex write lands on every alias; alias changed-keys name the canonical destination', () => {
    const j = twoBoardJob();
    expect(SECTION_FIELD_ALIASES.supply_characteristics.ze).toEqual([
      'ze',
      'earth_loop_impedance_ze',
    ]);
    expect(aliasFamily('installation_details', 'general_condition')).toEqual([
      'general_condition',
      'general_condition_of_installation',
    ]);
    expect(aliasFamily('installation_details', 'client_name')).toEqual(['client_name']);
    expect(canonicalFieldForAlias('supply_characteristics', 'prospective_fault_current')).toBe(
      'pfc'
    );
    expect(canonicalFieldForAlias('supply_characteristics', 'ze')).toBe('ze');
    // Effective value prefers the UI alias.
    expect(
      readEffectiveSectionValue(
        { ze: '0.35', earth_loop_impedance_ze: '0.5' },
        'supply_characteristics',
        'ze'
      )
    ).toBe('0.5');
    // The UI key PRESENT and empty is authoritative (a page clear)…
    expect(
      readEffectiveSectionValue(
        { ze: '0.35', earth_loop_impedance_ze: '' },
        'supply_characteristics',
        'ze'
      )
    ).toBeNull();
    // …while a section that never had the UI key falls back to the wire key.
    expect(readEffectiveSectionValue({ ze: '0.35' }, 'supply_characteristics', 'ze')).toBe('0.35');
    expect(
      readEffectiveSectionValue(
        { ze: '', earth_loop_impedance_ze: '' },
        'supply_characteristics',
        'ze'
      )
    ).toBeNull();
    // The Installation page's patch: only `general_condition_of_installation` changes.
    const before = {
      ...j,
      installation_details: {
        general_condition: 'Satisfactory',
        general_condition_of_installation: 'Satisfactory',
      },
    } as JobDetail;
    const after = {
      ...j,
      installation_details: {
        general_condition: 'Satisfactory',
        general_condition_of_installation: '',
      },
    } as JobDetail;
    expect(diffRegexDestinations(before, after)).toEqual([
      { key: 'install.general_condition', cleared: true },
    ]);
    expect(readRegexDestinationValue(after, 'install.general_condition')).toBeNull();
    // The Supply page's Ze / PFC patches.
    const s1 = {
      ...j,
      supply_characteristics: {
        ze: '0.35',
        earth_loop_impedance_ze: '0.35',
        pfc: '1.2',
        prospective_fault_current: '1.2',
      },
    } as JobDetail;
    const s2 = {
      ...j,
      supply_characteristics: {
        ze: '0.35',
        earth_loop_impedance_ze: '',
        pfc: '1.2',
        prospective_fault_current: '2.0',
      },
    } as JobDetail;
    expect(diffRegexDestinations(s1, s2)).toEqual([
      { key: 'supply.ze', cleared: true },
      { key: 'supply.pfc', cleared: false },
    ]);
    // Changed keys from the extraction dual-write name the canonical destination.
    expect(destinationKeyFromChangedKey('supply.earth_loop_impedance_ze')).toBe('supply.ze');
    expect(destinationKeyFromChangedKey('installation.general_condition_of_installation')).toBe(
      'install.general_condition'
    );
    // A regex write after the visible clear: the effective baseline is empty,
    // so the identical value is fresh again and lands on BOTH aliases. (An
    // UNSEEDED tracker: ownership is a separate, higher-tier gate — a
    // family still owned by Sonnet or a pre-existing value refuses the
    // regex write regardless of freshness; seeding is exercised below.)
    const tracker = new FieldSourceTracker();
    const result = emptyRegexMatchResult();
    result.installation_updates = { general_condition_of_installation: 'Satisfactory' };
    const applied = applyRegexMatchToJob(after, result, tracker);
    expect(applied?.changedKeys).toEqual(['install.general_condition']);
    expect(applied?.patch.installation_details).toEqual({
      general_condition: 'Satisfactory',
      general_condition_of_installation: 'Satisfactory',
    });
    // The tracker shares the SAME families: seeding either alias owns both.
    const seeded = new FieldSourceTracker();
    seeded.seedFromJob({
      ...j,
      supply_characteristics: { prospective_fault_current: '1.2' },
      installation_details: { general_condition_of_installation: 'Fair' },
    } as JobDetail);
    expect(seeded.canRegexWrite('supply.pfc')).toBe(false);
    expect(seeded.canRegexWrite('install.general_condition')).toBe(false);
    expect(seeded.canRegexWrite('supply.ze')).toBe(true);
  });

  it('computeFreshRegexWrites targets the SAME row the freshness gate canonicalised', () => {
    const j = twoBoardJob();
    const tracker = new FieldSourceTracker();
    tracker.seedFromJob(j);
    const result = emptyRegexMatchResult();
    result.circuit_updates = { '4': { measured_zs_ohm: '0.35' } };
    result.supply_updates = { main_switch_current: '100' };
    const garage = computeFreshRegexWrites(j, result, tracker, jobBaselineReader(j), 'b_garage');
    expect(garage.map((c) => c.trackerKey).sort()).toEqual([
      'board.main_switch_current',
      'circuit.row4_garage.measured_zs_ohm',
    ]);
    expect(garage.find((c) => c.target === 'circuit')?.circuitIdx).toBe(2);
    expect(garage.find((c) => c.target === 'board_info')?.fieldKey).toBe('main_switch_current');
    const main = computeFreshRegexWrites(j, result, tracker, jobBaselineReader(j), null);
    expect(main.find((c) => c.target === 'circuit')?.trackerKey).toBe(
      'circuit.row4_main.measured_zs_ohm'
    );
  });
});
