import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchCircuitType, applyPresetToJob } from '@/lib/defaults/service';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';
import type { JobDetail } from '@/lib/types';

/**
 * Phase B — Defaults service unit coverage (2026-05-03).
 *
 * Three behaviours we need confidence in:
 *   1. matchCircuitType produces the same key as
 *      CertMateUnified/Sources/Services/CertificateDefaultsService.swift
 *      .matchCircuitType — Sonnet voice + CCU rely on the cable
 *      auto-fill being identical across iOS and the PWA.
 *   2. applyPresetToJob respects the only-fill-empty contract
 *      (job-typed values never get overwritten by the preset).
 *   3. applyPresetToJob skips the identity fields the iOS applier
 *      skips (clientName, address, postcode, town, county) so a
 *      preset never bleeds another customer's address into a job.
 */

describe('matchCircuitType — iOS classifier parity', () => {
  it('matches socket / ring designations', () => {
    expect(matchCircuitType('Socket Ring', '32')).toBe('socket_ring');
    expect(matchCircuitType('Upstairs Ring Final Circuit', '32')).toBe('socket_ring');
  });
  it('matches lighting circuits with floor disambiguation', () => {
    expect(matchCircuitType('Lighting Upstairs', '6')).toBe('lighting_6a_upstairs');
    expect(matchCircuitType('Downstairs lighting', '6')).toBe('lighting_6a_downstairs');
    expect(matchCircuitType('Light - 1st floor', '')).toBe('lighting_6a_upstairs');
    expect(matchCircuitType('Lighting 10A', '10')).toBe('lighting_10a');
  });
  it('matches cooker / shower / immersion appliances', () => {
    expect(matchCircuitType('Cooker', '32')).toBe('cooker_32a');
    expect(matchCircuitType('Oven and Hob', '20')).toBe('cooker_16_20a');
    expect(matchCircuitType('Shower', '40')).toBe('shower_40a');
    expect(matchCircuitType('Shower Bathroom', '32')).toBe('shower_32a');
    expect(matchCircuitType('Immersion Heater', '16')).toBe('water_heater_16_20a');
  });
  it('falls back to generic_<rating>a when designation is unknown', () => {
    expect(matchCircuitType('Spare', '20')).toBe('generic_20a');
    expect(matchCircuitType('External', '32')).toBe('generic_32a');
  });
  it('returns null for unrecognised designations + ratings', () => {
    expect(matchCircuitType('Spare', '')).toBe(null);
    expect(matchCircuitType('Spare', '99')).toBe(null);
  });
});

describe('applyPresetToJob — only-fill-empty merge', () => {
  function makePreset(overrides: Partial<JobDetail>): CertificateDefaultPreset {
    return {
      id: 'p1',
      user_id: 'u1',
      name: 'Standard Domestic',
      certificate_type: 'EICR',
      default_data: overrides,
      last_modified: 0,
    };
  }

  function makeJob(overrides: Partial<JobDetail>): JobDetail {
    return {
      id: 'j1',
      user_id: 'u1',
      certificate_type: 'EICR',
      folder_name: 'j1',
      ...overrides,
    } as JobDetail;
  }

  it('fills empty Supply fields without clobbering inspector-typed values', () => {
    const preset = makePreset({
      supply_characteristics: {
        earthing_arrangement: 'TN-C-S',
        nominal_voltage_u: '230',
        nominal_frequency: '50',
      } as never,
    });
    const job = makeJob({
      supply_characteristics: {
        earthing_arrangement: 'TT', // already set — must be preserved
      } as never,
    });
    const patch = applyPresetToJob(preset, job);
    const supply = patch.supply_characteristics as Record<string, unknown>;
    // Existing TT preserved; preset TN-C-S did not overwrite.
    expect(supply.earthing_arrangement).toBe('TT');
    // Empty fields filled from the preset.
    expect(supply.nominal_voltage_u).toBe('230');
    expect(supply.nominal_frequency).toBe('50');
  });

  it('skips Installation identity fields (client / address / postcode / town / county)', () => {
    const preset = makePreset({
      installation_details: {
        client_name: 'Mrs Smith',
        address: '123 Old Street',
        postcode: 'SW1 1AA',
        town: 'Brighton',
        county: 'East Sussex',
        premises_description: 'Three-bed semi',
        next_inspection_years: 5,
      } as never,
    });
    const job = makeJob({});
    const patch = applyPresetToJob(preset, job);
    const inst = patch.installation_details as Record<string, unknown>;
    // Identity fields must NOT have been written even though the job has no installation_details.
    expect(inst.client_name).toBeUndefined();
    expect(inst.address).toBeUndefined();
    expect(inst.postcode).toBeUndefined();
    expect(inst.town).toBeUndefined();
    expect(inst.county).toBeUndefined();
    // Description + next_inspection_years should be filled.
    expect(inst.premises_description).toBe('Three-bed semi');
    expect(inst.next_inspection_years).toBe(5);
  });

  it('only copies preset circuits/observations when the job is empty', () => {
    const preset = makePreset({
      circuits: [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Lights' }] as never,
      observations: [{ id: 'o1', code: 'C3', observation_text: 'Old wiring' }] as never,
    });
    const jobWithCircuits = makeJob({
      circuits: [{ id: 'cX', circuit_ref: '1' }] as never,
      observations: [],
    });
    const patch1 = applyPresetToJob(preset, jobWithCircuits);
    // Existing circuit preserved (no overlay), but observations were
    // empty so they got copied.
    expect(patch1.circuits).toBeUndefined();
    expect(patch1.observations).toBeDefined();
    expect((patch1.observations as Array<{ id: string }>)[0].id).toBe('o1');

    const fresh = makeJob({});
    const patch2 = applyPresetToJob(preset, fresh);
    expect(patch2.circuits).toBeDefined();
    expect(patch2.observations).toBeDefined();
  });

  it('merges inspection_schedule items by ref without overwriting existing outcomes', () => {
    const preset = makePreset({
      inspection_schedule: {
        items: {
          '1.1': { outcome: 'tick' },
          '2.1': { outcome: 'tick' },
        },
      } as never,
    });
    const job = makeJob({
      inspection_schedule: {
        items: {
          '1.1': { outcome: 'C2', observation_text: 'Existing finding' },
        },
      } as never,
    });
    const patch = applyPresetToJob(preset, job);
    const items = (patch.inspection_schedule as { items: Record<string, { outcome: string }> })
      .items;
    // '1.1' must have been preserved (was C2, must NOT become tick).
    expect(items['1.1'].outcome).toBe('C2');
    // '2.1' filled from the preset.
    expect(items['2.1'].outcome).toBe('tick');
  });
});
