import { describe, it, expect } from 'vitest';
import { FieldSourceMap, circuit0Key, perCircuitKey } from '@/lib/recording/field-source';
import type { JobDetail } from '@/lib/types';

describe('FieldSourceMap — basic getters/setters', () => {
  it('round-trips set/get', () => {
    const map = new FieldSourceMap();
    map.set('supply.ze', 'preExisting');
    expect(map.get('supply.ze')).toBe('preExisting');
    map.set('supply.ze', 'sonnet');
    expect(map.get('supply.ze')).toBe('sonnet');
  });

  it('clear() wipes both the source map and the originally-pre-existing key set', () => {
    const map = new FieldSourceMap();
    map.set('supply.ze', 'preExisting');
    map.markOriginallyPreExisting('circuit.3.zs');
    expect(map.has('supply.ze')).toBe(true);
    expect(map.isOriginallyPreExisting('circuit.3.zs')).toBe(true);
    map.clear();
    expect(map.has('supply.ze')).toBe(false);
    expect(map.isOriginallyPreExisting('circuit.3.zs')).toBe(false);
  });

  it('preExisting source automatically lands in originally-pre-existing key set', () => {
    const map = new FieldSourceMap();
    map.set('supply.pfc', 'preExisting');
    expect(map.isOriginallyPreExisting('supply.pfc')).toBe(true);
  });

  it('regex / sonnet sources do NOT land in the originally-pre-existing key set', () => {
    const map = new FieldSourceMap();
    map.set('supply.pfc', 'regex');
    map.set('supply.ze', 'sonnet');
    expect(map.isOriginallyPreExisting('supply.pfc')).toBe(false);
    expect(map.isOriginallyPreExisting('supply.ze')).toBe(false);
  });
});

describe('FieldSourceMap — initializeFromJob', () => {
  function emptyJob(): JobDetail {
    return {
      id: 'j1',
      number: 'J-001',
      property_address: '',
      certificate_type: 'EICR',
      cert_type: 'EICR',
    } as unknown as JobDetail;
  }

  it('stamps every populated supply / installation field as preExisting', () => {
    const job = {
      ...emptyJob(),
      supply: { ze: '0.27', pfc: '1.5', earthing_arrangement: 'TN-S' },
      installation: { postcode: 'EC1A 1BB', town: 'London' },
    } as unknown as JobDetail;
    const map = new FieldSourceMap();
    map.initializeFromJob(job);
    expect(map.get('supply.ze')).toBe('preExisting');
    expect(map.get('supply.pfc')).toBe('preExisting');
    expect(map.get('supply.earthing_arrangement')).toBe('preExisting');
    expect(map.get('installation.postcode')).toBe('preExisting');
    expect(map.get('installation.town')).toBe('preExisting');
  });

  it('skips empty / null / whitespace-only fields', () => {
    const job = {
      ...emptyJob(),
      supply: { ze: '', pfc: null, earthing_arrangement: '   ' },
    } as unknown as JobDetail;
    const map = new FieldSourceMap();
    map.initializeFromJob(job);
    expect(map.get('supply.ze')).toBeUndefined();
    expect(map.get('supply.pfc')).toBeUndefined();
    expect(map.get('supply.earthing_arrangement')).toBeUndefined();
  });

  it('keys per-circuit fields by circuit_ref, NOT by row id', () => {
    const job = {
      ...emptyJob(),
      circuits: [
        {
          id: 'uuid-abc',
          circuit_ref: '3',
          circuit_designation: 'Sockets',
          measured_zs_ohm: '0.44',
        },
        { id: 'uuid-def', circuit_ref: '12', circuit_designation: 'Cooker', ocpd_rating_a: '32' },
      ],
    } as unknown as JobDetail;
    const map = new FieldSourceMap();
    map.initializeFromJob(job);
    expect(map.get(perCircuitKey('3', 'circuit_designation'))).toBe('preExisting');
    expect(map.get(perCircuitKey('3', 'measured_zs_ohm'))).toBe('preExisting');
    expect(map.get(perCircuitKey('12', 'ocpd_rating_a'))).toBe('preExisting');
    // Identity fields skipped:
    expect(map.has('circuit.3.id')).toBe(false);
    expect(map.has('circuit.3.circuit_ref')).toBe(false);
  });

  it("idempotent — calling twice doesn't re-process keys", () => {
    const job = {
      ...emptyJob(),
      supply: { ze: '0.27' },
    } as unknown as JobDetail;
    const map = new FieldSourceMap();
    map.initializeFromJob(job);
    map.initializeFromJob(job);
    expect(map.get('supply.ze')).toBe('preExisting');
    expect(map.isOriginallyPreExisting('supply.ze')).toBe(true);
  });

  it('skips circuits whose circuit_ref is missing', () => {
    const job = {
      ...emptyJob(),
      circuits: [{ id: 'uuid-x', circuit_designation: 'Spare' }],
    } as unknown as JobDetail;
    const map = new FieldSourceMap();
    map.initializeFromJob(job);
    expect(Array.from(map.entries())).toEqual([]);
  });
});

describe('FieldSourceMap — key helpers', () => {
  it('circuit0Key formats section.field', () => {
    expect(circuit0Key('supply', 'ze')).toBe('supply.ze');
    expect(circuit0Key('installation', 'postcode')).toBe('installation.postcode');
  });

  it('perCircuitKey formats circuit.<ref>.<field>', () => {
    expect(perCircuitKey('3', 'measured_zs_ohm')).toBe('circuit.3.measured_zs_ohm');
    expect(perCircuitKey(12, 'ocpd_rating_a')).toBe('circuit.12.ocpd_rating_a');
  });
});
