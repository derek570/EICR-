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
        resultFor({ circuit: 0, field, value: 'contract-value' })
      );
      expect(applied?.patch[route], `${field} did not land in ${route}`).toBeDefined();
    }
  });

  it('routes every circuit field through the real circuit-row apply path', () => {
    for (const [field, route] of Object.entries(fixture)) {
      if (route !== 'circuit') continue;
      const applied = applyExtractionToJob(
        makeJob(),
        resultFor({ circuit: 1, field, value: '1', board_id: 'main' })
      );
      expect(applied?.patch.circuits, `${field} did not land on the circuit row`).toHaveLength(1);
    }
  });

  it.each([
    ['manufacturer', 'manufacturer'],
    ['name', 'name'],
    ['location', 'location'],
    ['phases', 'phases'],
    ['ze_at_db', 'ze_at_db'],
    ['zs_at_db', 'ze_at_db'],
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

  it('fails closed when an off-manifest field somehow reaches the web client', () => {
    const applied = applyExtractionToJob(
      makeJob(),
      resultFor({ circuit: 0, field: 'not_a_contract_field', value: 'must-not-land' })
    );
    expect(applied).toBeNull();
  });
});
