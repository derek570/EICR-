/**
 * A01P (2026-09-08) — ACCEPTED SUPPLY Ze on the web.
 *
 *  - an accepted dictated Ze (either wire spelling) REPLACES a differing
 *    seeded / manual / regex-prefilled supply value (iOS `applySonnetValue`
 *    alignment) and always materialises BOTH client aliases;
 *  - equality with a regex prefill still materialises the missing alias;
 *  - a fresh accepted value supersedes both persisted unequal aliases with
 *    no original retained (`[current_behaviour]`, A01-adjudicable);
 *  - the FieldSourceTracker tracks the alias family TOGETHER: seed marks
 *    both, a landed server result promotes both to `sonnet`, a later regex
 *    re-hit respects that ownership, `forget` releases both;
 *  - manual BOARD Ze overrides are a separate cell and are never touched.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { applyRegexMatchToJob } from '@/lib/recording/apply-regex-match';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
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
    circuits: [],
    ...over,
  } as unknown as JobDetail;
}

function zeResult(field: 'ze' | 'earth_loop_impedance_ze', value: string): ExtractionResult {
  return {
    readings: [{ circuit: 0, field, value }],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
  } as unknown as ExtractionResult;
}

const supplyOf = (applied: ReturnType<typeof applyExtractionToJob>) =>
  applied!.patch.supply_characteristics as Record<string, unknown>;

describe('[invariant] accepted supply Ze replaces and materialises both aliases', () => {
  it.each(['ze', 'earth_loop_impedance_ze'] as const)(
    'accepted %s 0.50 replaces a differing seeded short/long 0.35 pair',
    (field) => {
      const job = makeJob({
        supply_characteristics: { ze: '0.35', earth_loop_impedance_ze: '0.35' },
      });
      const applied = applyExtractionToJob(job, zeResult(field, '0.50'));
      expect(applied).not.toBeNull();
      expect(supplyOf(applied)).toMatchObject({ ze: '0.50', earth_loop_impedance_ze: '0.50' });
      expect(applied!.changedKeys).toEqual(
        expect.arrayContaining(['supply.ze', 'supply.earth_loop_impedance_ze'])
      );
    }
  );

  it('a regex prefill wrote only the short key; the accepted EQUAL value still materialises the long alias', () => {
    const job = makeJob({ supply_characteristics: { ze: '0.35' } });
    const applied = applyExtractionToJob(job, zeResult('ze', '0.35'));
    expect(applied).not.toBeNull();
    expect(supplyOf(applied)).toMatchObject({ ze: '0.35', earth_loop_impedance_ze: '0.35' });
  });

  it('both aliases already equal to the accepted value → no supply write (unchanged replay)', () => {
    const job = makeJob({
      supply_characteristics: { ze: '0.35', earth_loop_impedance_ze: '0.35' },
    });
    const applied = applyExtractionToJob(job, zeResult('earth_loop_impedance_ze', '0.35'));
    expect(applied?.patch.supply_characteristics).toBeUndefined();
  });

  it('[current_behaviour] persisted short 0.35 / long 0.50 → accepted 0.60 → both 0.60 in the apply patch, no original retained (the REAL save/reload boundary is proven in harness/a01p-accepted-ze-save-reload.test.tsx)', () => {
    const job = makeJob({
      supply_characteristics: { ze: '0.35', earth_loop_impedance_ze: '0.50' },
    });
    const applied = applyExtractionToJob(job, zeResult('ze', '0.60'));
    const supply = supplyOf(applied);
    // (M3's silent polarity / continuity derivations ride the same patch — untouched by A01P.)
    expect(supply).toMatchObject({ ze: '0.60', earth_loop_impedance_ze: '0.60' });
    // Patch-fold view only — the mounted save → PUT → GET → rehydrate proof
    // lives in harness/a01p-accepted-ze-save-reload.test.tsx.
    const reloaded = { ...job, ...(applied!.patch as Partial<JobDetail>) } as JobDetail;
    const persisted = reloaded.supply_characteristics as Record<string, unknown>;
    expect(persisted.ze).toBe('0.60');
    expect(persisted.earth_loop_impedance_ze).toBe('0.60');
    expect(Object.values(persisted)).not.toContain('0.35');
    expect(Object.values(persisted)).not.toContain('0.50');
  });

  it('manual BOARD Ze overrides are a separate cell — untouched by an accepted supply Ze', () => {
    const job = makeJob({
      boards: [{ id: 'main', board_type: 'main', ze: '0.30', zs_at_db: '0.31' }],
      supply_characteristics: { ze: '0.35' },
    });
    const applied = applyExtractionToJob(job, zeResult('ze', '0.50'));
    expect(applied!.patch.boards).toBeUndefined();
    expect((job.boards as Record<string, unknown>[])[0]).toMatchObject({
      ze: '0.30',
      zs_at_db: '0.31',
    });
    expect(supplyOf(applied).ze).toBe('0.50');
  });

  it('PFC is NOT part of this family (A01B-owned): the fill-only gate still keeps a pre-existing pfc', () => {
    const job = makeJob({ supply_characteristics: { pfc: '1.2' } });
    const applied = applyExtractionToJob(job, {
      readings: [{ circuit: 0, field: 'pfc', value: '2.0' }],
    } as unknown as ExtractionResult);
    expect(applied?.patch.supply_characteristics).toBeUndefined();
  });
});

describe('[invariant] FieldSourceTracker — the Ze alias family is seeded, promoted and released together', () => {
  it('seeding either spelling marks both; a landed server Ze promotes both to sonnet; regex then respects ownership', () => {
    const tracker = new FieldSourceTracker();
    tracker.seedFromJob(makeJob({ supply_characteristics: { earth_loop_impedance_ze: '0.35' } }));
    expect(tracker.getSource('supply.ze')).toBe('preExisting');
    expect(tracker.getSource('supply.earth_loop_impedance_ze')).toBe('preExisting');

    const job = makeJob({ supply_characteristics: { earth_loop_impedance_ze: '0.35' } });
    const applied = applyExtractionToJob(job, zeResult('ze', '0.50'), {
      fieldSourceTracker: tracker,
    });
    expect(supplyOf(applied)).toMatchObject({ ze: '0.50', earth_loop_impedance_ze: '0.50' });
    expect(tracker.getSource('supply.ze')).toBe('sonnet');
    expect(tracker.getSource('supply.earth_loop_impedance_ze')).toBe('sonnet');
    expect(tracker.canRegexWrite('supply.ze')).toBe(false);
    expect(tracker.canRegexWrite('supply.earth_loop_impedance_ze')).toBe(false);

    // A later regex re-hit of the OLD value is refused — provenance, not equality.
    const after = { ...job, ...(applied!.patch as Partial<JobDetail>) } as JobDetail;
    const regex = applyRegexMatchToJob(
      after,
      {
        supply_updates: { ze: '0.35' },
        board_updates: {},
        installation_updates: {},
        circuit_updates: {},
      } as never,
      tracker
    );
    expect(regex?.patch.supply_characteristics).toBeUndefined();
  });

  it('a regex write on the short key records the family; forget releases both members', () => {
    const tracker = new FieldSourceTracker();
    tracker.recordRegexWrite('supply.ze');
    expect(tracker.getSource('supply.earth_loop_impedance_ze')).toBe('regex');
    expect(tracker.consumeTurnWrites()).toEqual(['supply.ze']);
    tracker.forget(['supply.earth_loop_impedance_ze']);
    expect(tracker.getSource('supply.ze')).toBeUndefined();
    expect(tracker.canRegexWrite('supply.ze')).toBe(true);
  });

  it('a session reset (fresh tracker seeded from the reloaded job) re-derives the family from the persisted values', () => {
    const tracker = new FieldSourceTracker();
    tracker.seedFromJob(
      makeJob({ supply_characteristics: { ze: '0.60', earth_loop_impedance_ze: '0.60' } })
    );
    expect(tracker.canRegexWrite('supply.ze')).toBe(false);
    const empty = new FieldSourceTracker();
    empty.seedFromJob(makeJob({ supply_characteristics: {} }));
    expect(empty.canRegexWrite('supply.ze')).toBe(true);
  });
});
