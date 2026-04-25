import { describe, it, expect } from 'vitest';
import { applyRegexValue, applySonnetValue } from '@/lib/recording/apply-rules';
import { FieldSourceMap } from '@/lib/recording/field-source';

function harness() {
  const sources = new FieldSourceMap();
  let written: unknown = null;
  const apply = (v: unknown) => () => {
    written = v;
  };
  return { sources, apply, written: () => written };
}

describe('applyRegexValue — iOS priority truth-table', () => {
  it('first-set: empty currentValue → applies + stamps regex', () => {
    const h = harness();
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '',
      sources: h.sources,
      apply: h.apply('0.27'),
    });
    expect(out).toEqual({ applied: true, reason: 'first-set' });
    expect(h.written()).toBe('0.27');
    expect(h.sources.get('supply.ze')).toBe('regex');
  });

  it('regex last-wins: same source, different value → applies', () => {
    const h = harness();
    h.sources.set('supply.ze', 'regex');
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: true, reason: 'regex-last-wins' });
    expect(h.written()).toBe('0.30');
    expect(h.sources.get('supply.ze')).toBe('regex');
  });

  it('regex same-value: no apply, no source change', () => {
    const h = harness();
    h.sources.set('supply.ze', 'regex');
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out.applied).toBe(false);
    expect(h.written()).toBeNull();
  });

  it('regex-locked-by-sonnet: regex tier respects sonnet writes', () => {
    const h = harness();
    h.sources.set('supply.ze', 'sonnet');
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: false, reason: 'regex-locked-by-sonnet' });
    expect(h.written()).toBeNull();
  });

  it('regex-locked-by-preexisting: regex tier respects manual entries', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: false, reason: 'regex-locked-by-preexisting' });
    expect(h.written()).toBeNull();
  });

  it('untracked + non-empty currentValue: treated as locked by pre-existing', () => {
    // Maps to the iOS behaviour where fieldSources[key] == nil and the
    // value is non-empty — interpreted as a manual / CCU-import value
    // that the regex tier can't overwrite.
    const h = harness();
    const out = applyRegexValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: false, reason: 'regex-locked-by-preexisting' });
  });
});

describe('applySonnetValue — iOS priority truth-table', () => {
  it('first-set: empty currentValue → applies + stamps sonnet', () => {
    const h = harness();
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '',
      sources: h.sources,
      apply: h.apply('0.27'),
    });
    expect(out).toEqual({ applied: true, reason: 'first-set' });
    expect(h.written()).toBe('0.27');
    expect(h.sources.get('supply.ze')).toBe('sonnet');
  });

  it('blocked-duplicate-preexisting: same value over preExisting → no-op', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out).toEqual({ applied: false, reason: 'blocked-duplicate-preexisting' });
    expect(h.written()).toBeNull();
  });

  it('sonnet-overwrite-preexisting: different value over preExisting → applies + flips source + records originally-preExisting', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: true, reason: 'sonnet-overwrite-preexisting' });
    expect(h.written()).toBe('0.30');
    expect(h.sources.get('supply.ze')).toBe('sonnet');
    // Survives the overwrite — question-suppression downstream still sees it.
    expect(h.sources.isOriginallyPreExisting('supply.ze')).toBe(true);
  });

  it('sonnet-overwrite-regex: different value over regex → applies + flips + tagged for discrepancyCount', () => {
    const h = harness();
    h.sources.set('supply.ze', 'regex');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    expect(out).toEqual({ applied: true, reason: 'sonnet-overwrite-regex' });
    expect(h.written()).toBe('0.30');
    expect(h.sources.get('supply.ze')).toBe('sonnet');
  });

  it('sonnet-confirmed-same (regex source): no apply, source flips regex→sonnet', () => {
    const h = harness();
    h.sources.set('supply.ze', 'regex');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out).toEqual({ applied: false, reason: 'sonnet-confirmed-same' });
    expect(h.written()).toBeNull();
    // Source flipped — future regex writes can no longer touch this field.
    expect(h.sources.get('supply.ze')).toBe('sonnet');
  });

  it('sonnet-confirmed-same (sonnet source): no apply, no source change', () => {
    const h = harness();
    h.sources.set('supply.ze', 'sonnet');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out.applied).toBe(false);
    expect(h.sources.get('supply.ze')).toBe('sonnet');
  });

  it('untracked + non-empty currentValue: treated as preExisting (matches iOS isPreExisting check)', () => {
    const h = harness();
    // No source set, but currentValue present → counts as preExisting.
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out).toEqual({ applied: false, reason: 'blocked-duplicate-preexisting' });
    expect(h.sources.isOriginallyPreExisting('supply.ze')).toBe(true);
  });

  it('originallyPreExisting survives sonnet-overwrite-preexisting (iOS contract)', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    applySonnetValue({
      key: 'supply.ze',
      newValue: '0.30',
      currentValue: '0.27',
      sources: h.sources,
      apply: h.apply('0.30'),
    });
    // Source label flipped to 'sonnet':
    expect(h.sources.get('supply.ze')).toBe('sonnet');
    // But originallyPreExisting is sticky:
    expect(h.sources.isOriginallyPreExisting('supply.ze')).toBe(true);
  });

  it('whitespace-only difference is treated as same value (loose equality)', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27 ',
      currentValue: ' 0.27',
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out).toEqual({ applied: false, reason: 'blocked-duplicate-preexisting' });
  });

  it('numeric vs string equivalence is loose (Sonnet "0.27" == typed 0.27)', () => {
    const h = harness();
    h.sources.set('supply.ze', 'preExisting');
    const out = applySonnetValue({
      key: 'supply.ze',
      newValue: '0.27',
      currentValue: 0.27,
      sources: h.sources,
      apply: h.apply('IGNORED'),
    });
    expect(out).toEqual({ applied: false, reason: 'blocked-duplicate-preexisting' });
  });
});
