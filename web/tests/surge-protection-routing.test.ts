/**
 * surge-protection-box (2026-06-17) — web Option A routing regressions.
 *
 * Mirrors the iOS TranscriptFieldMatcher Fix D cases and locks the web-side
 * Option A contract: "main fuse"/"cutout" → spd_* (DNO cutout), "main switch"/
 * "isolator" → main_switch_*, and a real Surge Protection Device → surge_*.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import { applyDocumentExtractionToJob } from '@/lib/recording/apply-document-extraction';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import { emitDraft } from '@/components/defaults/preset-editor-sheet';
import type { JobDetail, CCUAnalysis } from '@/lib/types';

function makeJob(): JobDetail {
  return {
    id: 'test',
    job_id: 'test',
    user_id: 'test',
    folder_name: 'test',
    certificate_type: 'EICR' as const,
    job_address: 'test',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [],
  } as unknown as JobDetail;
}

describe('surge — web regex matcher main-fuse vs main-switch split (Option A)', () => {
  let matcher: TranscriptFieldMatcher;
  beforeEach(() => {
    matcher = new TranscriptFieldMatcher();
  });

  it('"main fuse is BS 1361" → spd_bs_en, NOT main_switch_bs_en', () => {
    const r = matcher.match('the main fuse is BS 1361', makeJob());
    expect(r.supply_updates.spd_bs_en).toBe('1361 type 1');
    expect(r.supply_updates.main_switch_bs_en).toBeUndefined();
  });

  it('"main fuse rated 100 amps" → spd_rated_current, NOT main_switch_current', () => {
    const r = matcher.match('the main fuse is rated 100 amps', makeJob());
    expect(r.supply_updates.spd_rated_current).toBe('100');
    expect(r.supply_updates.main_switch_current).toBeUndefined();
  });

  it('"supply fuse BS 88" → spd_bs_en', () => {
    const r = matcher.match('supply fuse is BS 88', makeJob());
    expect(r.supply_updates.spd_bs_en).toBe('88 Fuse');
    expect(r.supply_updates.main_switch_bs_en).toBeUndefined();
  });

  it('"main switch is BS 60947" → main_switch_bs_en, NOT spd_bs_en', () => {
    const r = matcher.match('the main switch is BS 60947', makeJob());
    expect(r.supply_updates.main_switch_bs_en).toBe('60947-3');
    expect(r.supply_updates.spd_bs_en).toBeUndefined();
  });

  it('"main switch 100 amps" → main_switch_current, NOT spd_rated_current', () => {
    const r = matcher.match('the main switch is 100 amps', makeJob());
    expect(r.supply_updates.main_switch_current).toBe('100');
    expect(r.supply_updates.spd_rated_current).toBeUndefined();
  });

  it('mixed utterance routes each device to its own slot', () => {
    const r = matcher.match('main fuse is BS 1361 and main switch is BS 60947', makeJob());
    expect(r.supply_updates.spd_bs_en).toBe('1361 type 1');
    expect(r.supply_updates.main_switch_bs_en).toBe('60947-3');
  });
});

describe('surge — document extraction carries surge_* into the supply patch', () => {
  it('surge_* values in formData land in patch.supply_characteristics', () => {
    const result = applyDocumentExtractionToJob(makeJob(), {
      formData: {
        supply_characteristics: {
          surge_spd_present: 'Yes',
          surge_spd_type: 'Type 2',
          surge_spd_bs_en: '61643-11',
          surge_status_indicator: 'Satisfactory',
        },
      },
    } as never);
    const supply = result.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(supply?.surge_spd_present).toBe('Yes');
    expect(supply?.surge_spd_type).toBe('Type 2');
    expect(supply?.surge_spd_bs_en).toBe('61643-11');
    expect(supply?.surge_status_indicator).toBe('Satisfactory');
  });
});

describe('surge — CCU analysis routes surge findings to surge_*, never supply spd_*', () => {
  it('spd_present=true → supply surge_*; supply cutout spd_* untouched', () => {
    const analysis = {
      board_model: 'X',
      circuits: [],
      spd_present: true,
      spd_type: 'Type 2',
      spd_bs_en: '61643-11',
    } as unknown as CCUAnalysis;
    const result = applyCcuAnalysisToJob(makeJob(), analysis);
    const supply = result.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(supply?.surge_spd_present).toBe('Yes');
    expect(supply?.surge_spd_type).toBe('Type 2');
    expect(supply?.surge_spd_bs_en).toBe('61643-11');
    // The DNO cutout (main fuse) box must NOT be polluted by CCU surge data.
    expect(supply?.spd_type_supply).toBeUndefined();
    expect(supply?.spd_bs_en).toBeUndefined();
  });

  it('spd_present=false → surge marked No/N-A, cutout spd_* untouched', () => {
    const analysis = {
      board_model: 'X',
      circuits: [],
      spd_present: false,
    } as unknown as CCUAnalysis;
    const result = applyCcuAnalysisToJob(makeJob(), analysis);
    const supply = result.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(supply?.surge_spd_present).toBe('No');
    expect(supply?.spd_bs_en).toBeUndefined();
  });
});

describe('surge — preset editor preserves surge_* through an unrelated edit', () => {
  const fullDraft = {
    earthing_arrangement: '',
    live_conductors: '',
    number_of_supplies: '',
    nominal_voltage_u: '',
    nominal_voltage_uo: '',
    nominal_frequency: '',
    prospective_fault_current: '',
    earth_loop_impedance_ze: '',
    supply_polarity_confirmed: '',
    rcd_operating_current: '',
    rcd_time_delay: '',
    rcd_operating_time: '',
  } as never;

  it('an existing surge_spd_type survives editing an unrelated supply field', () => {
    const out = emitDraft(
      'My Preset',
      {} as never,
      { ...(fullDraft as object), earthing_arrangement: 'TT' } as never,
      { surge_spd_type: 'Type 2', spd_bs_en: '1361 type 1' }
    );
    const supply = (out.default_data as Record<string, unknown>).supply_characteristics as Record<
      string,
      unknown
    >;
    expect(supply.surge_spd_type).toBe('Type 2');
    expect(supply.spd_bs_en).toBe('1361 type 1');
    expect(supply.earthing_arrangement).toBe('TT');
  });
});
