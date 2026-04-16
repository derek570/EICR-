import { describe, expect, it } from '@jest/globals';
import {
  applyDeviceLookup,
  lookupDevice,
  __TABLE_SIZE__,
} from '../extraction/device-lookup-table.js';

describe('lookupDevice', () => {
  it('has a non-empty seed table', () => {
    expect(__TABLE_SIZE__).toBeGreaterThan(10);
  });

  it('returns null for null/undefined inputs', () => {
    expect(lookupDevice(null, null)).toBeNull();
    expect(lookupDevice(undefined, undefined)).toBeNull();
    expect(lookupDevice('', '')).toBeNull();
    expect(lookupDevice('Hager', null)).toBeNull();
    expect(lookupDevice(null, 'ADA132')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(lookupDevice(123, 456)).toBeNull();
    expect(lookupDevice({}, [])).toBeNull();
  });

  it('looks up Hager ADA RCBO as Type A', () => {
    const spec = lookupDevice('Hager', 'ADA132');
    expect(spec).not.toBeNull();
    expect(spec.rcdWaveformType).toBe('A');
    expect(spec.bsEn).toBe('BS EN 61009-1');
  });

  it('looks up Hager CDA MCB (no RCD waveform)', () => {
    const spec = lookupDevice('Hager', 'CDA132');
    expect(spec).not.toBeNull();
    expect(spec.rcdWaveformType).toBeNull();
    expect(spec.bsEn).toBe('BS EN 60898-1');
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    const a = lookupDevice('HAGER', 'ADA132');
    const b = lookupDevice('  hager  ', '  ada132  ');
    const c = lookupDevice('Hager', 'ada-132');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(a.rcdWaveformType).toBe('A');
    expect(b.rcdWaveformType).toBe('A');
    expect(c.rcdWaveformType).toBe('A');
  });

  it('matches MK Sentry LN5 MCB and LN8 RCBO differently', () => {
    const mcb = lookupDevice('MK Sentry', 'LN5832');
    const rcbo = lookupDevice('MK Sentry', 'LN8932');
    expect(mcb.rcdWaveformType).toBeNull();
    expect(rcbo.rcdWaveformType).toBe('AC');
  });

  it('matches MK without Sentry suffix', () => {
    const mcb = lookupDevice('MK', 'LN5832');
    expect(mcb).not.toBeNull();
    expect(mcb.bsEn).toBe('BS EN 60898-1');
  });

  it('prefers the longest matching prefix', () => {
    // Wylex NH vs NHXS — NHXS (RCBO) is more specific than NH (MCB)
    const mcb = lookupDevice('Wylex', 'NH32');
    const rcbo = lookupDevice('Wylex', 'NHXS132');
    expect(mcb.rcdWaveformType).toBeNull();
    expect(rcbo.rcdWaveformType).toBe('A');
  });

  it('returns null for unknown manufacturer', () => {
    expect(lookupDevice('AcmeFakeBrand', 'ADA132')).toBeNull();
  });

  it('returns null for unknown model under a known manufacturer', () => {
    expect(lookupDevice('Hager', 'ZZZ999')).toBeNull();
  });

  it('recognises Schneider Acti9 iC60', () => {
    const spec = lookupDevice('Schneider Electric', 'iC60N-C32');
    expect(spec).not.toBeNull();
    expect(spec.bsEn).toBe('BS EN 60898-1');
  });

  it('recognises BG CUR RCBO as Type A', () => {
    const spec = lookupDevice('BG', 'CUR132A');
    expect(spec).not.toBeNull();
    expect(spec.rcdWaveformType).toBe('A');
  });
});

describe('applyDeviceLookup', () => {
  it('returns the slot unchanged for null / non-object input', () => {
    expect(applyDeviceLookup(null)).toBeNull();
    expect(applyDeviceLookup(undefined)).toBeUndefined();
  });

  it('does not overwrite VLM-confirmed rcdWaveformType', () => {
    const slot = {
      slotIndex: 0,
      classification: 'rcbo',
      manufacturer: 'Hager',
      model: 'ADA132',
      rcdWaveformType: 'B', // VLM confidently read Type B
      bsEn: null,
      ratingAmps: 32,
      poles: 2,
      confidence: 0.9,
    };
    const out = applyDeviceLookup(slot);
    expect(out.rcdWaveformType).toBe('B'); // preserved
    expect(out.bsEn).toBe('BS EN 61009-1'); // gap-filled
  });

  it('fills nulls from the lookup table', () => {
    const slot = {
      slotIndex: 1,
      classification: 'rcbo',
      manufacturer: 'Hager',
      model: 'ADA132',
      rcdWaveformType: null,
      bsEn: null,
      ratingAmps: 32,
      poles: 2,
      confidence: 0.82,
    };
    const out = applyDeviceLookup(slot);
    expect(out.rcdWaveformType).toBe('A');
    expect(out.bsEn).toBe('BS EN 61009-1');
    expect(out.ratingAmps).toBe(32); // VLM-confirmed, preserved
  });

  it('leaves slot null-safe when manufacturer/model are blank', () => {
    const slot = {
      slotIndex: 2,
      classification: 'unknown',
      manufacturer: null,
      model: null,
      rcdWaveformType: null,
      bsEn: null,
      ratingAmps: null,
      poles: 1,
      confidence: 0.1,
    };
    const out = applyDeviceLookup(slot);
    // No spec available — both remain null.
    expect(out.rcdWaveformType).toBeNull();
    expect(out.bsEn).toBeNull();
    expect(out.ratingAmps).toBeNull();
  });

  it('does not mutate the original slot', () => {
    const slot = {
      slotIndex: 3,
      classification: 'rcbo',
      manufacturer: 'Hager',
      model: 'ADA132',
      rcdWaveformType: null,
      bsEn: null,
      ratingAmps: null,
      poles: 2,
      confidence: 0.9,
    };
    const out = applyDeviceLookup(slot);
    expect(slot.rcdWaveformType).toBeNull();
    expect(slot.bsEn).toBeNull();
    expect(out).not.toBe(slot);
  });
});
