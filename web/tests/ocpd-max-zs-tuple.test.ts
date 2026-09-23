/**
 * PLAN-CC (feedback-2026-09-17 wave) — the standard-aware max-Zs lookup, the
 * tuple helper, and `ocpd_max_zs_source` provenance.
 *
 * These are the shared-module halves of plan acceptance 3 / 3a. The per-write-
 * path drives (acceptance 3's "through each of write paths 1-23") live beside
 * the paths themselves in `ocpd-write-paths.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  clearMaxZs,
  maxZsForOcpdTuple,
  maxZsString,
  ocpdMaxZsStatus,
  ocpdMaxZsWarningText,
  readMaxZsSource,
  recomputeMaxZsForOcpdTuple,
  writeMaxZs,
  type MaxZsRow,
} from '@certmate/shared-utils';

const row = (over: Partial<MaxZsRow> = {}): MaxZsRow => ({
  circuit_ref: '1',
  ocpd_bs_en: 'BS EN 60898',
  ocpd_type: 'B',
  ocpd_rating_a: '32',
  ...over,
});

describe('maxZsForOcpdTuple — the standard is part of the key', () => {
  it.each([
    ['BS EN 60898', 'B', '32', undefined, '1.44'],
    ['BS EN 61009', 'B', '32', undefined, '1.44'],
    ['BS EN 62423', 'C', '32', undefined, '0.72'],
    ['BS 1361', '2', '30', undefined, '1.09'],
    ['BS 3036', 'Rew', '30', undefined, '1.09'],
    ['BS 3036', '1', '30', undefined, '1.09'],
    ['BS 88-3', 'gG', '32', '0.4', '0.93'],
    ['BS 88-2', 'gG', '32', '0.4', '0.93'],
    ['BS EN 60269-3', 'gG', '32', '0.4', '0.93'],
    ['BS EN 60269-2', 'gG', '32', '0.4', '0.93'],
    // 5-second table.
    ['BS EN 60898', 'B', '32', '5', '2.40'],
  ])('%s + %s + %s A (t=%s) → %s', (standard, type, rating, time, expected) => {
    expect(maxZsForOcpdTuple({ ocpdBsEn: standard, type, rating, time })).toBe(expected);
  });

  it.each([
    // The headline case: a BS 3871 breaker dictated with the legacy type `2`
    // would read a BS 1361 cartridge-fuse row under the type-only lookup.
    ['BS 3871', '2', '30', undefined],
    // gM and aM have no BS 7671 Table 41.4 row — null, never the gG figure.
    ['BS 88-2', 'gM', '32', '0.4'],
    ['BS 88-2', 'aM', '32', '0.4'],
    // An empty standard yields null for any NEW computation.
    ['', 'B', '32', undefined],
    // A standard with no row at all.
    ['BS 9999', 'B', '32', undefined],
    // A type that is not on this standard's row.
    ['BS EN 60898', 'gG', '32', undefined],
    // A rating that is not in the table.
    ['BS EN 60898', 'B', '7', undefined],
  ])('%s + %s + %s A (t=%s) → null', (standard, type, rating, time) => {
    expect(maxZsForOcpdTuple({ ocpdBsEn: standard, type, rating, time })).toBeNull();
  });

  it('the type-only lookup is UNCHANGED and still the right call without a standard', () => {
    // Proof this plan narrowed the tuple path without touching the old one —
    // `BS 3871 + 2` is the pair the tuple lookup now refuses.
    expect(maxZsString({ deviceType: '2', rating: '30' })).toBe('1.09');
    expect(maxZsForOcpdTuple({ ocpdBsEn: 'BS 3871', type: '2', rating: '30' })).toBeNull();
  });

  it('formats byte-identically to the type-only lookup for a pair both accept', () => {
    expect(maxZsForOcpdTuple({ ocpdBsEn: 'BS EN 60898', type: 'B', rating: '32' })).toBe(
      maxZsString({ deviceType: 'B', rating: '32' })
    );
  });
});

describe('readMaxZsSource — absent is a third state', () => {
  it('reads auto and manual', () => {
    expect(readMaxZsSource(row({ ocpd_max_zs_source: 'auto' }))).toBe('auto');
    expect(readMaxZsSource(row({ ocpd_max_zs_source: 'manual' }))).toBe('manual');
  });

  it('reads the CSV empty-cell rendering as ABSENT, not as a value', () => {
    // `parseCSV` uses `values[idx] || ''`, so a row that has never carried the
    // key arrives with `''`. Treating that as a value would recompute exactly
    // the pre-plan rows the key exists to preserve.
    expect(readMaxZsSource(row({ ocpd_max_zs_source: '' }))).toBeNull();
    expect(readMaxZsSource(row({ ocpd_max_zs_source: '   ' }))).toBeNull();
    expect(readMaxZsSource(row())).toBeNull();
    expect(readMaxZsSource(row({ ocpd_max_zs_source: 'AUTO' }))).toBeNull();
  });
});

describe('writeMaxZs / clearMaxZs', () => {
  it('writeMaxZs records the value and its source together', () => {
    const next = writeMaxZs(row(), '1.44', 'manual');
    expect(next.ocpd_max_zs_ohm).toBe('1.44');
    expect(next.ocpd_max_zs_source).toBe('manual');
  });

  it('clearMaxZs removes the value AND the key', () => {
    const next = clearMaxZs(row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' }));
    expect('ocpd_max_zs_ohm' in next).toBe(false);
    expect('ocpd_max_zs_source' in next).toBe(false);
  });

  it('neither mutates its input', () => {
    const before = row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' });
    writeMaxZs(before, '2.40', 'manual');
    clearMaxZs(before);
    expect(before.ocpd_max_zs_ohm).toBe('1.44');
    expect(before.ocpd_max_zs_source).toBe('auto');
  });
});

describe('recomputeMaxZsForOcpdTuple — three provenance states, three answers', () => {
  it('fills an empty cell as auto when the new tuple computes', () => {
    const next = recomputeMaxZsForOcpdTuple(undefined, row());
    expect(next.ocpd_max_zs_ohm).toBe('1.44');
    expect(next.ocpd_max_zs_source).toBe('auto');
  });

  it('leaves an empty cell alone when the tuple has no row', () => {
    const next = recomputeMaxZsForOcpdTuple(undefined, row({ ocpd_bs_en: 'BS 3871' }));
    expect('ocpd_max_zs_ohm' in next).toBe(false);
    expect('ocpd_max_zs_source' in next).toBe(false);
  });

  it('recomputes an auto row on a standard change', () => {
    const before = row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' });
    const after = { ...before, ocpd_bs_en: 'BS 1361', ocpd_type: '2', ocpd_rating_a: '30' };
    const next = recomputeMaxZsForOcpdTuple(before, after);
    expect(next.ocpd_max_zs_ohm).toBe('1.09');
    expect(next.ocpd_max_zs_source).toBe('auto');
  });

  it('CLEARS an auto row whose new standard has no lookup row', () => {
    const before = row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' });
    const after = { ...before, ocpd_bs_en: 'BS 3871', ocpd_type: '2', ocpd_rating_a: '30' };
    const next = recomputeMaxZsForOcpdTuple(before, after);
    expect('ocpd_max_zs_ohm' in next).toBe(false);
    expect('ocpd_max_zs_source' in next).toBe(false);
  });

  it('NEVER touches a manual row — including one that equals the lookup', () => {
    // The worst failure class in the wave: deciding "auto-derived" by equality
    // with the lookup silently deletes a hand-entered value that happens to
    // match. Both a matching and a differing manual value survive.
    for (const value of ['1.44', '0.99']) {
      const before = row({ ocpd_max_zs_ohm: value, ocpd_max_zs_source: 'manual' });
      const after = { ...before, ocpd_bs_en: 'BS 3871', ocpd_type: '2', ocpd_rating_a: '30' };
      const next = recomputeMaxZsForOcpdTuple(before, after);
      expect(next.ocpd_max_zs_ohm).toBe(value);
      expect(next.ocpd_max_zs_source).toBe('manual');
    }
  });

  it('PRESERVES a pre-plan row that carries a value and no key', () => {
    const before = row({ ocpd_max_zs_ohm: '1.44' });
    const after = { ...before, ocpd_bs_en: 'BS 3871', ocpd_type: '2', ocpd_rating_a: '30' };
    const next = recomputeMaxZsForOcpdTuple(before, after);
    expect(next.ocpd_max_zs_ohm).toBe('1.44');
    expect('ocpd_max_zs_source' in next).toBe(false);
    // …and it stays preserved under a tuple change that WOULD compute.
    const computable = { ...before, ocpd_rating_a: '16' };
    const still = recomputeMaxZsForOcpdTuple(before, computable);
    expect(still.ocpd_max_zs_ohm).toBe('1.44');
    expect('ocpd_max_zs_source' in still).toBe(false);
  });

  it('logs one local breadcrumb per change and none for a no-op', () => {
    const log = vi.fn();
    const before = row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' });
    recomputeMaxZsForOcpdTuple(before, before, log);
    expect(log).not.toHaveBeenCalled();

    const changed = { ...before, ocpd_bs_en: 'BS 1361', ocpd_type: '2', ocpd_rating_a: '30' };
    recomputeMaxZsForOcpdTuple(before, changed, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      circuitRef: '1',
      fromValue: '1.44',
      toValue: '1.09',
      fromStandard: 'BS EN 60898',
      toStandard: 'BS 1361',
      source: 'auto',
    });
  });

  it('is idempotent — running it twice changes nothing the second time', () => {
    const once = recomputeMaxZsForOcpdTuple(undefined, row());
    const twice = recomputeMaxZsForOcpdTuple(once, once);
    expect(twice).toEqual(once);
  });
});

describe('ocpdMaxZsStatus and the pinned marker copy', () => {
  it('null when there is no value to judge', () => {
    expect(ocpdMaxZsStatus(row())).toBeNull();
    expect(ocpdMaxZsStatus(row({ ocpd_max_zs_ohm: '' }))).toBeNull();
  });

  it('ok for an auto row', () => {
    expect(ocpdMaxZsStatus(row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' }))).toBe(
      'ok'
    );
  });

  it('ok for a manual row that matches the lookup', () => {
    expect(ocpdMaxZsStatus(row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'manual' }))).toBe(
      'ok'
    );
  });

  it('manual_mismatch when a manual value differs, or the tuple has no row', () => {
    expect(ocpdMaxZsStatus(row({ ocpd_max_zs_ohm: '0.99', ocpd_max_zs_source: 'manual' }))).toBe(
      'manual_mismatch'
    );
    expect(
      ocpdMaxZsStatus(
        row({ ocpd_bs_en: 'BS 3871', ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'manual' })
      )
    ).toBe('manual_mismatch');
  });

  it('unverified for a value with no key', () => {
    expect(ocpdMaxZsStatus(row({ ocpd_max_zs_ohm: '1.44' }))).toBe('unverified');
  });

  it('renders the pinned copy, byte for byte', () => {
    expect(
      ocpdMaxZsWarningText('3', row({ ocpd_max_zs_ohm: '0.99', ocpd_max_zs_source: 'manual' }))
    ).toBe('Circuit 3: max Zs 0.99 was entered by hand and does not match BS EN 60898 B 32 A');
    expect(ocpdMaxZsWarningText('4', row({ ocpd_max_zs_ohm: '1.44' }))).toBe(
      'Circuit 4: max Zs 1.44 has no recorded source — confirm or recompute'
    );
    expect(
      ocpdMaxZsWarningText('5', row({ ocpd_max_zs_ohm: '1.44', ocpd_max_zs_source: 'auto' }))
    ).toBeNull();
  });
});
