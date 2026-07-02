/**
 * WS6 item 6 — job-creation defaults flow
 * (iOS `JobListViewModel.autoApplyDefaults`, JobListViewModel.swift:200-234,
 * + `CertificateDefaultsService.applyStandardDefaults`:430-480).
 *
 * Pins:
 *   - fetch → apply → persist → (navigate) ordering: the created
 *     JobDetail is fetched BEFORE any patch is computed, and persist
 *     completes before the flow reports ready;
 *   - 0 presets → the standard-defaults port is applied + persisted;
 *   - 1 preset → `applyPresetToJob` output is applied + persisted;
 *   - 2+ presets → a pick outcome (no persist yet); Skip caches the
 *     untouched job and persists NOTHING;
 *   - the standard-defaults port matches the iOS field list and is
 *     only-fill-empty.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyPickedPreset,
  prepareCreatedJob,
  skipPresetPick,
  type JobCreationDeps,
} from '@/lib/defaults/job-creation';
import {
  applyStandardDefaultsToJob,
  STANDARD_SUPPLY_BOOLEAN_DEFAULTS,
  STANDARD_SUPPLY_STRING_DEFAULTS,
} from '@/lib/defaults/standard-defaults';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';
import type { JobDetail } from '@/lib/types';

function makeDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-new',
    certificate_type: 'EICR',
    boards: [{ id: 'b1', designation: 'DB1' }],
    ...overrides,
  } as unknown as JobDetail;
}

function makePreset(name: string, data: Partial<JobDetail> = {}): CertificateDefaultPreset {
  return {
    id: `preset-${name}`,
    user_id: 'u1',
    name,
    certificate_type: 'EICR',
    default_data: {
      supply_characteristics: { supply_type: 'TN-C-S from preset' },
      ...data,
    },
    last_modified: 1,
  };
}

function makeDeps(presets: CertificateDefaultPreset[], detail = makeDetail()) {
  const order: string[] = [];
  const persist = vi.fn(async () => {
    order.push('persist');
  });
  const cacheUntouched = vi.fn(async () => {
    order.push('cache');
  });
  const deps: JobCreationDeps = {
    fetchJob: vi.fn(async () => {
      order.push('fetch');
      return detail;
    }),
    loadPresets: vi.fn(async () => {
      order.push('presets');
      return presets;
    }),
    persist,
    cacheUntouched,
  };
  return { deps, order, persist, cacheUntouched };
}

describe('applyStandardDefaultsToJob — iOS applyStandardDefaults port', () => {
  it('fills the full iOS field list on an empty job', () => {
    const patch = applyStandardDefaultsToJob(makeDetail());

    const install = patch.installation_details as Record<string, unknown>;
    expect(install.premises_description).toBe('Residential');
    expect(install.installation_records_available).toBe(true);
    expect(install.evidence_of_additions_alterations).toBe(true);
    expect(install.next_inspection_years).toBe(5);

    const supply = patch.supply_characteristics as Record<string, unknown>;
    for (const [key, value] of Object.entries(STANDARD_SUPPLY_STRING_DEFAULTS)) {
      expect(supply[key], key).toBe(value);
    }
    for (const [key, value] of Object.entries(STANDARD_SUPPLY_BOOLEAN_DEFAULTS)) {
      expect(supply[key], key).toBe(value);
    }
    // Explicit-false canon: means_earthing_electrode defaults to false,
    // not merely "left unset".
    expect(supply.means_earthing_electrode).toBe(false);

    const boards = patch.boards as Array<Record<string, unknown>>;
    expect(boards[0].phases).toBe('1');

    const schedule = patch.inspection_schedule as Record<string, unknown>;
    expect(schedule.mark_section7_na).toBe(true);
  });

  it('is only-fill-empty — never overwrites existing values', () => {
    const patch = applyStandardDefaultsToJob(
      makeDetail({
        installation_details: { premises_description: 'Commercial' },
        supply_characteristics: {
          nominal_voltage_u: '400',
          means_earthing_electrode: true,
        },
        boards: [{ id: 'b1', phases: 'Three' }] as never,
        inspection_schedule: { mark_section7_na: false } as never,
      })
    );

    const install = patch.installation_details as Record<string, unknown>;
    expect(install.premises_description).toBe('Commercial'); // untouched
    const supply = patch.supply_characteristics as Record<string, unknown>;
    expect(supply.nominal_voltage_u).toBe('400');
    expect(supply.means_earthing_electrode).toBe(true);
    // boards[0].phases populated → no boards patch at all.
    expect(patch.boards).toBeUndefined();
    // mark_section7_na explicitly false → respected (== nil gate).
    expect(patch.inspection_schedule).toBeUndefined();
  });
});

describe('prepareCreatedJob — decision ladder + ordering', () => {
  it('0 presets: fetch → presets → persist ordering, standard defaults applied', async () => {
    const { deps, order, persist } = makeDeps([]);

    const outcome = await prepareCreatedJob('u1', 'job-new', 'EICR', deps);

    expect(outcome).toEqual({ kind: 'ready', applied: 'standard' });
    expect(order).toEqual(['fetch', 'presets', 'persist']);
    // The persisted patch is the standard-defaults patch computed
    // against the FETCHED doc, and the merged doc is handed over for
    // the cache warm.
    const [, jobId, patch, merged] = persist.mock.calls[0] as unknown as [
      string,
      string,
      Partial<JobDetail>,
      JobDetail,
    ];
    expect(jobId).toBe('job-new');
    expect((patch.supply_characteristics as Record<string, unknown>).nominal_voltage_u).toBe('230');
    expect((merged.supply_characteristics as Record<string, unknown>).nominal_voltage_u).toBe(
      '230'
    );
  });

  it('1 preset: auto-applies it (applyPresetToJob semantics) and persists', async () => {
    const { deps, persist } = makeDeps([makePreset('Domestic')]);

    const outcome = await prepareCreatedJob('u1', 'job-new', 'EICR', deps);

    expect(outcome).toEqual({ kind: 'ready', applied: 'preset' });
    const [, , patch] = persist.mock.calls[0] as unknown as [string, string, Partial<JobDetail>];
    expect((patch.supply_characteristics as Record<string, unknown>).supply_type).toBe(
      'TN-C-S from preset'
    );
  });

  it('2+ presets: returns a pick outcome and persists NOTHING yet', async () => {
    const presets = [makePreset('Domestic'), makePreset('Commercial')];
    const { deps, persist } = makeDeps(presets);

    const outcome = await prepareCreatedJob('u1', 'job-new', 'EICR', deps);

    expect(outcome.kind).toBe('pick');
    if (outcome.kind === 'pick') {
      expect(outcome.presets).toHaveLength(2);
      expect(outcome.detail.id).toBe('job-new');
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it('picker resolution: applyPickedPreset persists the chosen preset patch', async () => {
    const { deps, persist } = makeDeps([]);
    const detail = makeDetail();

    await applyPickedPreset('u1', detail, makePreset('Commercial'), deps);

    expect(persist).toHaveBeenCalledTimes(1);
    const [, jobId, patch] = persist.mock.calls[0] as unknown as [
      string,
      string,
      Partial<JobDetail>,
    ];
    expect(jobId).toBe('job-new');
    expect((patch.supply_characteristics as Record<string, unknown>).supply_type).toBe(
      'TN-C-S from preset'
    );
  });

  it('Skip: caches the untouched job and never persists a patch', async () => {
    const { deps, persist, cacheUntouched } = makeDeps([]);
    const detail = makeDetail();

    await skipPresetPick('u1', detail, deps);

    expect(persist).not.toHaveBeenCalled();
    expect(cacheUntouched).toHaveBeenCalledWith('u1', 'job-new', detail);
  });
});
