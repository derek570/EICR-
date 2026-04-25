import { describe, it, expect } from 'vitest';
import {
  FieldSourceMap,
  buildRegexHints,
  circuit0Key,
  perCircuitKey,
} from '@/lib/recording/field-source';
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

describe('FieldSourceMap — reconcileFromJob (inspector edits during session)', () => {
  function emptyJob(): JobDetail {
    return {
      id: 'j1',
      number: 'J-001',
      property_address: '',
      certificate_type: 'EICR',
      cert_type: 'EICR',
    } as unknown as JobDetail;
  }

  it('inspector edits a sonnet-source field → reconcile re-stamps as preExisting', () => {
    // Codex P1 on R2 (90d5c85): without reconcile, the next Sonnet
    // extraction would see source=sonnet on the inspector's correction
    // and overwrite it. Reconcile catches the value drift between turns.
    const map = new FieldSourceMap();
    const before = { ...emptyJob(), supply: { ze: '0.27' } } as unknown as JobDetail;
    map.initializeFromJob(before);
    map.set('supply.ze', 'sonnet', '0.30'); // simulate Sonnet writing 0.30 over the preExisting 0.27
    expect(map.get('supply.ze')).toBe('sonnet');
    // Inspector taps into the field and corrects to 0.32:
    const after = { ...emptyJob(), supply: { ze: '0.32' } } as unknown as JobDetail;
    map.reconcileFromJob(after);
    expect(map.get('supply.ze')).toBe('preExisting');
  });

  it('inspector edits a regex-source field → reconcile re-stamps as preExisting', () => {
    const map = new FieldSourceMap();
    map.set('circuit.3.measured_zs_ohm', 'regex', '0.44');
    const after = {
      ...emptyJob(),
      circuits: [{ id: 'x', circuit_ref: '3', measured_zs_ohm: '0.50' }],
    } as unknown as JobDetail;
    map.reconcileFromJob(after);
    expect(map.get('circuit.3.measured_zs_ohm')).toBe('preExisting');
  });

  it('inspector clears a previously-tracked field → reconcile drops the source label', () => {
    const map = new FieldSourceMap();
    const before = { ...emptyJob(), supply: { ze: '0.27' } } as unknown as JobDetail;
    map.initializeFromJob(before);
    expect(map.has('supply.ze')).toBe(true);
    const after = { ...emptyJob(), supply: { ze: '' } } as unknown as JobDetail;
    map.reconcileFromJob(after);
    expect(map.has('supply.ze')).toBe(false);
  });

  it('reconcile is a no-op when the inspector did not edit anything', () => {
    const map = new FieldSourceMap();
    const job = { ...emptyJob(), supply: { ze: '0.27' } } as unknown as JobDetail;
    map.initializeFromJob(job);
    map.set('supply.ze', 'sonnet', '0.30'); // Sonnet wrote
    const post = { ...emptyJob(), supply: { ze: '0.30' } } as unknown as JobDetail;
    map.reconcileFromJob(post);
    // Source label preserved — no inspector edit happened.
    expect(map.get('supply.ze')).toBe('sonnet');
  });

  it('inspector adds a new field mid-session → reconcile stamps preExisting', () => {
    const map = new FieldSourceMap();
    const before = { ...emptyJob(), supply: { ze: '0.27' } } as unknown as JobDetail;
    map.initializeFromJob(before);
    // Inspector adds pfc:
    const after = {
      ...emptyJob(),
      supply: { ze: '0.27', pfc: '1.5' },
    } as unknown as JobDetail;
    map.reconcileFromJob(after);
    expect(map.get('supply.pfc')).toBe('preExisting');
  });

  it('reconcile does not break the originallyPreExisting audit trail', () => {
    const map = new FieldSourceMap();
    const before = { ...emptyJob(), supply: { ze: '0.27' } } as unknown as JobDetail;
    map.initializeFromJob(before);
    map.set('supply.ze', 'sonnet', '0.30');
    const after = { ...emptyJob(), supply: { ze: '0.32' } } as unknown as JobDetail;
    map.reconcileFromJob(after);
    // Source flipped back to preExisting:
    expect(map.get('supply.ze')).toBe('preExisting');
    // OriginallyPreExisting audit trail still true (never cleared):
    expect(map.isOriginallyPreExisting('supply.ze')).toBe(true);
  });
});

describe('FieldSourceMap — snapshot refresh on apply-rules writes', () => {
  function emptyJob(): JobDetail {
    return {
      id: 'j1',
      number: 'J-001',
      property_address: '',
      certificate_type: 'EICR',
      cert_type: 'EICR',
    } as unknown as JobDetail;
  }

  it('regex-last-wins refreshes snapshot — second write does NOT trip reconcile as a manual edit', async () => {
    // Codex P2 on afb5441: without the snapshot refresh in
    // applyRegexValue's regex-last-wins branch, the next reconcile
    // would see the new regex value as a "drift" and re-stamp as
    // preExisting, killing precedence for any field that gets two
    // regex writes in one session.
    const { applyRegexValue } = await import('@/lib/recording/apply-rules');
    const map = new FieldSourceMap();
    let stored: unknown = null;
    const apply = (v: unknown) => () => {
      stored = v;
    };
    // First regex write — empty → first-set
    applyRegexValue({
      key: 'circuit.3.measured_zs_ohm',
      newValue: '0.44',
      currentValue: '',
      sources: map,
      apply: apply('0.44'),
    });
    expect(map.get('circuit.3.measured_zs_ohm')).toBe('regex');
    // Second regex write — same source, different value → last-wins
    applyRegexValue({
      key: 'circuit.3.measured_zs_ohm',
      newValue: '0.45',
      currentValue: '0.44',
      sources: map,
      apply: apply('0.45'),
    });
    expect(stored).toBe('0.45');
    expect(map.get('circuit.3.measured_zs_ohm')).toBe('regex');
    // Now reconcile against the new job state — should NOT
    // re-stamp as preExisting (no inspector edit happened).
    const job = {
      ...emptyJob(),
      circuits: [{ id: 'x', circuit_ref: '3', measured_zs_ohm: '0.45' }],
    } as unknown as JobDetail;
    map.reconcileFromJob(job);
    expect(map.get('circuit.3.measured_zs_ohm')).toBe('regex');
  });
});

describe('buildRegexHints (R5) — regex-tier hint summary for the wire', () => {
  it('returns only keys with source=regex (not preExisting / sonnet)', () => {
    const map = new FieldSourceMap();
    map.set('supply.ze', 'regex', '0.34');
    map.set('supply.pfc', 'preExisting', '1.5');
    map.set('circuit.3.measured_zs_ohm', 'sonnet', '0.44');
    map.set('circuit.5.measured_zs_ohm', 'regex', '0.50');
    const hints = buildRegexHints(map);
    expect(hints.map((h) => h.field).sort()).toEqual(['circuit.5.measured_zs_ohm', 'supply.ze']);
  });

  it('empty source map → empty array', () => {
    expect(buildRegexHints(new FieldSourceMap())).toEqual([]);
  });

  it('postcode hint attaches the value (iOS contract)', () => {
    const map = new FieldSourceMap();
    map.set('installation.postcode', 'regex', 'EC1A 1BB');
    const hints = buildRegexHints(map, { installation: { postcode: 'EC1A 1BB' } });
    expect(hints).toEqual([{ field: 'installation.postcode', value: 'EC1A 1BB' }]);
  });

  it('non-postcode regex hints do NOT include value (matches iOS shape)', () => {
    const map = new FieldSourceMap();
    map.set('supply.ze', 'regex', '0.34');
    map.set('circuit.3.measured_zs_ohm', 'regex', '0.44');
    const hints = buildRegexHints(map);
    for (const h of hints) {
      expect(h).not.toHaveProperty('value');
    }
  });

  it('postcode hint omits value when the job postcode is empty / missing', () => {
    const map = new FieldSourceMap();
    map.set('installation.postcode', 'regex', 'EC1A 1BB');
    const hints = buildRegexHints(map, { installation: { postcode: '' } });
    expect(hints).toEqual([{ field: 'installation.postcode' }]);
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
