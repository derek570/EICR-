/**
 * apply-extraction — supply / installation section field-name dual-write tests.
 *
 * Same class of bug as the per-circuit translation
 * (`tests/apply-extraction-legacy-fields.test.ts`), but for circuit:0
 * readings that land in `supply_characteristics` /
 * `installation_details`. The Sonnet wire ships iOS-legacy short
 * names (`ze`, `pfc`, `main_earth_conductor_csa`,
 * `main_bonding_conductor_csa`, `general_condition`); the
 * corresponding PWA tab pages read modern long names. The fix in
 * applyCircuit0Readings dual-writes under BOTH the wire name and the
 * PWA column name so the during-recording LiveFillView (reads wire
 * names) and the post-recording tabs (read modern names) both
 * render.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

/** Each row: a legacy wire field name (what the backend post-validate
 *  emits) and the PWA tab page column the UI reads. Supply column 5 +
 *  install column 1 = 5 entries (`board` deferred for the structural
 *  fix that touches CIRCUIT_0_SECTION routing). */
const LEGACY_TO_PWA_SECTION_PAIRS: Array<
  [
    wireField: string,
    section: 'supply_characteristics' | 'installation_details',
    pwaColumn: string,
    value: unknown,
  ]
> = [
  ['ze', 'supply_characteristics', 'earth_loop_impedance_ze', '0.42'],
  ['pfc', 'supply_characteristics', 'prospective_fault_current', '1.5'],
  ['main_earth_conductor_csa', 'supply_characteristics', 'earthing_conductor_csa', '10'],
  ['main_bonding_conductor_csa', 'supply_characteristics', 'main_bonding_csa', '10'],
  ['general_condition', 'installation_details', 'general_condition_of_installation', 'Good'],
];

describe('apply-extraction circuit:0 dual-write (wire name + PWA column)', () => {
  it.each(LEGACY_TO_PWA_SECTION_PAIRS)(
    'wire "%s" → %s lands under wire name AND PWA column "%s"',
    (wireField, section, pwaColumn, value) => {
      const result = makeResult({
        readings: [{ circuit: 0, field: wireField, value: value as string }],
      });
      const applied = applyExtractionToJob(makeJob(), result);

      expect(applied).not.toBeNull();
      const sectionPatch = applied!.patch[section] as Record<string, unknown>;
      expect(sectionPatch[wireField]).toBe(value); // LiveFillView read path
      expect(sectionPatch[pwaColumn]).toBe(value); // Supply/Install tab read path
    }
  );

  it('keeps a user value typed under the PWA column name', () => {
    // Inspector already typed "0.99" into the Supply tab's Ze field
    // (stored as `earth_loop_impedance_ze`). Sonnet then dictates a
    // Ze reading. The 3-tier priority rule must protect the user's
    // value — even though the wire name `ze` isn't set, the PWA
    // column IS, and the dual-name check sees it.
    const job = makeJob({
      supply_characteristics: { earth_loop_impedance_ze: '0.99' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).toBeNull();
  });

  it('keeps a user value typed under the wire name', () => {
    // Reverse case — a LiveFillView mutation or legacy import may
    // have left the value under the wire name. Same priority guard
    // applies.
    const job = makeJob({
      supply_characteristics: { ze: '0.99' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).toBeNull();
  });

  it('passes through fields with no PWA column mismatch', () => {
    // `earthing_arrangement` is the same name on both sides (PWA tab
    // and wire). Dual-write must NOT duplicate keys — only one entry
    // on the section.
    const result = makeResult({
      readings: [{ circuit: 0, field: 'earthing_arrangement', value: 'TN-C-S' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.earthing_arrangement).toBe('TN-C-S');
    expect(Object.keys(supply)).toEqual(['earthing_arrangement']);
  });
});
