import { describe, it, expect } from 'vitest';
import { applyRegexResultToJob } from '@/lib/recording/apply-regex-result';
import { FieldSourceMap } from '@/lib/recording/field-source';
import type { RegexMatchResult } from '@/lib/recording/transcript-field-matcher';
import type { JobDetail } from '@/lib/types';

function emptyJob(extra: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'j1',
    number: 'J-001',
    property_address: '',
    certificate_type: 'EICR',
    cert_type: 'EICR',
    circuits: [],
    ...extra,
  } as unknown as JobDetail;
}

function emptyResult(): RegexMatchResult {
  return { supplyUpdates: {}, circuitUpdates: new Map() };
}

describe('applyRegexResultToJob — supply fields', () => {
  it('first-set: empty supply.ze + matcher emits Ze → patch contains supply.ze + changedKeys lists supply.ze', () => {
    const sources = new FieldSourceMap();
    const result = emptyResult();
    result.supplyUpdates.ze = '0.34';
    const out = applyRegexResultToJob(emptyJob(), result, sources);
    expect(out).not.toBeNull();
    expect((out!.patch.supply as Record<string, unknown>).ze).toBe('0.34');
    expect(out!.changedKeys).toContain('supply.ze');
    expect(sources.get('supply.ze')).toBe('regex');
  });

  it('first-set: PFC alongside Ze → both in patch', () => {
    const sources = new FieldSourceMap();
    const result = emptyResult();
    result.supplyUpdates.ze = '0.34';
    result.supplyUpdates.pfc = '1.5';
    const out = applyRegexResultToJob(emptyJob(), result, sources);
    expect((out!.patch.supply as Record<string, unknown>).ze).toBe('0.34');
    expect((out!.patch.supply as Record<string, unknown>).pfc).toBe('1.5');
  });

  it('regex tier respects pre-existing source: Ze already set by inspector → no overwrite', () => {
    const sources = new FieldSourceMap();
    sources.set('supply.ze', 'preExisting', '0.27');
    const job = emptyJob({ supply: { ze: '0.27' } } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.supplyUpdates.ze = '0.34';
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).toBeNull();
    expect(sources.get('supply.ze')).toBe('preExisting');
  });

  it('regex last-wins: prior regex source + new value differs → overwrite', () => {
    const sources = new FieldSourceMap();
    sources.set('supply.ze', 'regex', '0.30');
    const job = emptyJob({ supply: { ze: '0.30' } } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.supplyUpdates.ze = '0.34';
    const out = applyRegexResultToJob(job, result, sources);
    expect((out!.patch.supply as Record<string, unknown>).ze).toBe('0.34');
    expect(out!.changedKeys).toContain('supply.ze');
  });

  it('regex tier respects sonnet source: Sonnet wrote → regex no-op', () => {
    const sources = new FieldSourceMap();
    sources.set('supply.ze', 'sonnet', '0.30');
    const job = emptyJob({ supply: { ze: '0.30' } } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.supplyUpdates.ze = '0.34';
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).toBeNull();
  });
});

describe('applyRegexResultToJob — circuit fields', () => {
  function jobWithCircuit(ref: string): JobDetail {
    return emptyJob({
      circuits: [{ id: `uuid-${ref}`, circuit_ref: ref, circuit_designation: 'Sockets' }],
    } as unknown as Partial<JobDetail>);
  }

  it('writes Zs to the matching circuit row + emits circuit.<rowId>.<field> changedKey', () => {
    const sources = new FieldSourceMap();
    const job = jobWithCircuit('3');
    const result = emptyResult();
    result.circuitUpdates.set('3', { measured_zs_ohm: '0.44' });
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).not.toBeNull();
    const circuits = out!.patch.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].measured_zs_ohm).toBe('0.44');
    expect(out!.changedKeys).toContain('circuit.uuid-3.measured_zs_ohm');
  });

  it('skips circuits whose ref has no matching row in the job (matcher claimed an unknown ref)', () => {
    const sources = new FieldSourceMap();
    const job = jobWithCircuit('3');
    const result = emptyResult();
    result.circuitUpdates.set('99', { measured_zs_ohm: '0.44' });
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).toBeNull();
  });

  it('multi-circuit: each ref lands on its own row', () => {
    const sources = new FieldSourceMap();
    const job = emptyJob({
      circuits: [
        { id: 'uuid-3', circuit_ref: '3', circuit_designation: 'Sockets' },
        { id: 'uuid-12', circuit_ref: '12', circuit_designation: 'Cooker' },
      ],
    } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.circuitUpdates.set('3', { measured_zs_ohm: '0.44' });
    result.circuitUpdates.set('12', { measured_zs_ohm: '0.27' });
    const out = applyRegexResultToJob(job, result, sources);
    const circuits = out!.patch.circuits as Array<Record<string, unknown>>;
    expect(circuits.find((c) => c.id === 'uuid-3')?.measured_zs_ohm).toBe('0.44');
    expect(circuits.find((c) => c.id === 'uuid-12')?.measured_zs_ohm).toBe('0.27');
  });

  it('regex tier respects pre-existing circuit field: prior typed value not overwritten', () => {
    const sources = new FieldSourceMap();
    sources.set('circuit.3.measured_zs_ohm', 'preExisting', '0.30');
    const job = emptyJob({
      circuits: [
        { id: 'uuid-3', circuit_ref: '3', circuit_designation: 'Sockets', measured_zs_ohm: '0.30' },
      ],
    } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.circuitUpdates.set('3', { measured_zs_ohm: '0.44' });
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).toBeNull();
  });

  it('multiple fields per circuit applied together (Zs + R1+R2 + IR live-earth)', () => {
    const sources = new FieldSourceMap();
    const job = jobWithCircuit('5');
    const result = emptyResult();
    result.circuitUpdates.set('5', {
      measured_zs_ohm: '0.44',
      r1_r2_ohm: '0.32',
      ir_live_earth_mohm: '299',
    });
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).not.toBeNull();
    const row = (out!.patch.circuits as Array<Record<string, unknown>>)[0];
    expect(row.measured_zs_ohm).toBe('0.44');
    expect(row.r1_r2_ohm).toBe('0.32');
    expect(row.ir_live_earth_mohm).toBe('299');
    expect(out!.changedKeys).toEqual(
      expect.arrayContaining([
        'circuit.uuid-5.measured_zs_ohm',
        'circuit.uuid-5.r1_r2_ohm',
        'circuit.uuid-5.ir_live_earth_mohm',
      ])
    );
  });

  it('mixed: some circuit fields apply, some respect higher-tier source', () => {
    const sources = new FieldSourceMap();
    sources.set('circuit.5.measured_zs_ohm', 'sonnet', '0.30');
    const job = emptyJob({
      circuits: [
        {
          id: 'uuid-5',
          circuit_ref: '5',
          circuit_designation: 'Sockets',
          measured_zs_ohm: '0.30',
        },
      ],
    } as unknown as Partial<JobDetail>);
    const result = emptyResult();
    result.circuitUpdates.set('5', {
      measured_zs_ohm: '0.44', // blocked by sonnet source
      r1_r2_ohm: '0.32', // first-set
    });
    const out = applyRegexResultToJob(job, result, sources);
    expect(out).not.toBeNull();
    const row = (out!.patch.circuits as Array<Record<string, unknown>>)[0];
    expect(row.measured_zs_ohm).toBe('0.30'); // unchanged
    expect(row.r1_r2_ohm).toBe('0.32'); // applied
    expect(out!.changedKeys).toEqual(['circuit.uuid-5.r1_r2_ohm']);
  });
});

describe('applyRegexResultToJob — empty result', () => {
  it('empty regex result → null patch', () => {
    const sources = new FieldSourceMap();
    const out = applyRegexResultToJob(emptyJob(), emptyResult(), sources);
    expect(out).toBeNull();
  });
});
