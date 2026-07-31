import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  __liveClientReadingRoutesForTests,
  applyExtractionToJob,
} from '@/lib/recording/apply-extraction';
import {
  CLIENT_ROUTABLE_READING_ROUTES,
  type ClientReadingRoute,
} from '@/lib/recording/client-routable-reading-fields';
import type { ExtractedReading, ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../tests/fixtures/test-contracts/client-routable-reading-fields.json'),
    'utf8'
  )
) as Record<string, ClientReadingRoute>;

const CIRCUIT_COLUMN_BY_WIRE: Readonly<Record<string, string>> = {
  designation: 'circuit_designation',
  circuit_description: 'circuit_designation',
  ocpd_rating: 'ocpd_rating_a',
  cable_size: 'live_csa_mm2',
  cable_size_earth: 'cpc_csa_mm2',
  cpc_csa: 'cpc_csa_mm2',
  zs: 'measured_zs_ohm',
  earth_fault_loop_impedance: 'measured_zs_ohm',
  r2: 'r2_ohm',
  earth_continuity: 'r2_ohm',
  r1_plus_r2: 'r1_r2_ohm',
  r1_r2: 'r1_r2_ohm',
  r1r2: 'r1_r2_ohm',
  ring_continuity_r1: 'ring_r1_ohm',
  ring_continuity_rn: 'ring_rn_ohm',
  ring_continuity_r2: 'ring_r2_ohm',
  insulation_resistance_l_e: 'ir_live_earth_mohm',
  ir_live_earth: 'ir_live_earth_mohm',
  insulation_resistance_l_l: 'ir_live_live_mohm',
  ir_live_live: 'ir_live_live_mohm',
  ir_test_voltage: 'ir_test_voltage_v',
  rcd_trip_time: 'rcd_time_ms',
  rcd_time: 'rcd_time_ms',
  rcd_rating: 'rcd_rating_a',
  ocpd_breaking_capacity: 'ocpd_breaking_capacity_ka',
  max_disconnect_time: 'max_disconnect_time_s',
  polarity: 'polarity_confirmed',
};

function circuitValue(field: string): string {
  if (field === 'circuit_description' || field === 'designation') return 'Kitchen sockets';
  if (field === 'wiring_type') return 'A';
  if (field === 'ocpd_type') return 'B';
  if (field === 'ref_method') return 'C';
  if (field === 'rcd_type') return 'A';
  if (
    field === 'polarity' ||
    field === 'rcd_button_confirmed' ||
    field === 'afdd_button_confirmed'
  ) {
    return 'PASS';
  }
  if (field === 'ir_test_voltage') return '500';
  return '1';
}

function sectionValue(field: string): string {
  if (
    [
      'installation_records_available',
      'evidence_of_additions_alterations',
      'supply_polarity_confirmed',
      'means_earthing_distributor',
      'means_earthing_electrode',
      'bonding_other_na',
    ].includes(field)
  ) {
    return 'yes';
  }
  if (field === 'date_of_inspection' || field === 'date_of_previous_inspection') {
    return '31/07/2026';
  }
  if (field === 'next_inspection_years') return '5';
  return 'contract-value';
}

function makeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'plan2d-web-contract',
    job_id: 'plan2d-web-contract',
    user_id: 'user',
    folder_name: 'folder',
    certificate_type: 'EIC',
    job_address: 'address',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    boards: [{ id: 'main', board_type: 'main' }],
    circuits: [{ id: 'circuit-1', circuit_ref: '1', board_id: 'main' }],
    ...overrides,
  } as unknown as JobDetail;
}

function resultFor(reading: ExtractedReading): ExtractionResult {
  return {
    readings: [reading],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
  };
}

describe('PLAN-2D web client reading contract', () => {
  it('deep-compares the runtime allowlist and live router with the committed fixture', () => {
    expect(CLIENT_ROUTABLE_READING_ROUTES).toEqual(fixture);
    expect(__liveClientReadingRoutesForTests()).toEqual(fixture);
  });

  it('routes every non-circuit, non-board field through its real section apply path', () => {
    for (const [field, route] of Object.entries(fixture)) {
      if (route === 'circuit' || route === 'board_info') continue;
      const applied = applyExtractionToJob(
        makeJob(),
        resultFor({ circuit: 0, field, value: sectionValue(field) })
      );
      expect(applied?.patch[route], `${field} did not land in ${route}`).toBeDefined();
    }
  });

  it('routes every circuit field into its exact rendered circuit column', () => {
    for (const [field, route] of Object.entries(fixture)) {
      if (route !== 'circuit') continue;
      const value = circuitValue(field);
      const applied = applyExtractionToJob(
        makeJob(),
        resultFor({ circuit: 1, field, value, board_id: 'main' })
      );
      const row = applied?.patch.circuits?.[0] as unknown as Record<string, unknown>;
      const destination = CIRCUIT_COLUMN_BY_WIRE[field] ?? field;
      expect(row?.[destination], `${field} did not land in ${destination}`).toBe(value);
      if (destination !== field) {
        expect(row?.[field], `${field} leaked into an invisible raw alias property`).toBeUndefined();
      }
    }
  });

  it.each([
    'installation_records_available',
    'evidence_of_additions_alterations',
    'supply_polarity_confirmed',
    'means_earthing_distributor',
    'means_earthing_electrode',
    'bonding_other_na',
  ])('normalises typed boolean destination %s and rejects unknown forms', (field) => {
    const route = fixture[field] as ClientReadingRoute;
    const positive = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field, value: 'yes' })
    );
    const negative = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field, value: 'false' })
    );
    const invalid = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field, value: 'probably' })
    );
    expect((positive?.patch[route] as Record<string, unknown> | undefined)?.[field]).toBe(true);
    expect((negative?.patch[route] as Record<string, unknown> | undefined)?.[field]).toBe(false);
    expect(invalid?.patch[route]).toBeUndefined();
  });

  it('normalises inspection dates to ISO while retaining previous-inspection N/A', () => {
    const inspected = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field: 'date_of_inspection', value: '31/07/2026' })
    );
    const previous = applyExtractionToJob(
      makeJob({ certificate_type: 'EICR' }),
      resultFor({ circuit: 0, field: 'date_of_previous_inspection', value: 'N/A' })
    );
    const invalid = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field: 'date_of_inspection', value: '31/02/2026' })
    );
    expect(
      (inspected?.patch.installation_details as Record<string, unknown>).date_of_inspection
    ).toBe('2026-07-31');
    expect(
      (previous?.patch.installation_details as Record<string, unknown>).date_of_previous_inspection
    ).toBe('N/A');
    expect(invalid?.patch.installation_details).toBeUndefined();
  });

  it('stores a validated next-inspection interval as a number', () => {
    const applied = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field: 'next_inspection_years', value: '5' })
    );
    const invalid = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field: 'next_inspection_years', value: '5 years' })
    );
    expect(
      (applied?.patch.installation_details as Record<string, unknown>).next_inspection_years
    ).toBe(5);
    expect(invalid?.patch.installation_details).toBeUndefined();
  });

  it.each([
    ['manufacturer', 'manufacturer'],
    ['name', 'name'],
    ['location', 'location'],
    ['phases', 'phases'],
    ['ze_at_db', 'zs_at_db'],
    ['zs_at_db', 'zs_at_db'],
    ['ipf_at_db', 'ipf_at_db'],
  ])('attributes %s to only the addressed board', (field, boardKey) => {
    const job = makeJob({
      board_info: { [field]: 'main-summary' },
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
    } as Partial<JobDetail>);
    const applied = applyExtractionToJob(
      job,
      resultFor({ circuit: 0, field, value: 'garage-value', board_id: 'garage' })
    );
    const boards = applied?.patch.boards as Array<Record<string, unknown>>;
    expect(boards[0][boardKey]).toBeUndefined();
    expect(boards[1][boardKey]).toBe('garage-value');
    expect(applied?.patch.board_info).toBeUndefined();
  });

  it.each([
    ['cpc_csa_mm2', 'cable_size_earth', 'cpc_csa_mm2'],
    ['max_zs', 'ocpd_max_zs_ohm', 'ocpd_max_zs_ohm'],
    ['ocpd_max_zs', 'ocpd_max_zs_ohm', 'ocpd_max_zs_ohm'],
  ])('applies corrected %s as final wire field %s', (_correctionKey, finalWireField, webColumn) => {
    const applied = applyExtractionToJob(
      makeJob(),
      resultFor({
        circuit: 1,
        field: finalWireField,
        value: '1',
        board_id: 'main',
      })
    );
    expect((applied?.patch.circuits?.[0] as unknown as Record<string, unknown>)[webColumn]).toBe(
      '1'
    );
  });

  it('keeps canonical snapshot aliases outside the dispatcher manifest routable', () => {
    const applied = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 1, field: 'measured_zs_ohm', value: '0.42', board_id: 'main' })
    );
    expect(applied?.patch.circuits?.[0].measured_zs_ohm).toBe('0.42');
  });
});
