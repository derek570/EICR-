/**
 * surge-protection-box (2026-06-17) — backend contract regressions.
 *
 * Option A: spd_* stays = DNO Supply Protective Device / "main fuse"; the new
 * additive surge_* family carries a real Surge Protection Device. These tests
 * lock the backend plumbing so surge_* survives extraction → persistence and
 * board-scoped surge data never pollutes the supply Main Fuse box.
 *
 * Driver: field session F1AC26FB (2026-06-16).
 */

import { jest } from '@jest/globals';
import { KNOWN_FIELDS } from '../extraction/known-fields.js';
import { FIELD_CORRECTIONS } from '../extraction/field-name-corrections.js';

// utils/jobs.js transitively imports storage.js, which uses
// `import.meta.dirname` — undefined under jest --experimental-vm-modules.
// Mock the storage + db layers so we can unit-test the pure transform.
jest.unstable_mockModule('../storage.js', () => ({}));
jest.unstable_mockModule('../db.js', () => ({}));
const { transformExtractedData } = await import('../utils/jobs.js');

const SURGE_KEYS = [
  'surge_spd_present',
  'surge_spd_type',
  'surge_spd_bs_en',
  'surge_status_indicator',
];

describe('surge-protection — known fields allowlist', () => {
  test('all four surge_* keys are known fields (else record_board_reading is dropped)', () => {
    for (const k of SURGE_KEYS) {
      expect(KNOWN_FIELDS.has(k)).toBe(true);
    }
  });

  test('the spd_* cutout family is preserved (Option A keeps it = main fuse)', () => {
    for (const k of ['spd_bs_en', 'spd_type_supply', 'spd_short_circuit', 'spd_rated_current']) {
      expect(KNOWN_FIELDS.has(k)).toBe(true);
    }
  });
});

describe('surge-protection — voice routing aliases', () => {
  test('surge_* / surge_protection_* variants canonicalise to surge_* keys', () => {
    expect(FIELD_CORRECTIONS.surge_protection_present).toBe('surge_spd_present');
    expect(FIELD_CORRECTIONS.surge_present).toBe('surge_spd_present');
    expect(FIELD_CORRECTIONS.surge_protection_type).toBe('surge_spd_type');
    expect(FIELD_CORRECTIONS.surge_protection_bs_en).toBe('surge_spd_bs_en');
    expect(FIELD_CORRECTIONS.surge_indicator).toBe('surge_status_indicator');
    expect(FIELD_CORRECTIONS.surge_protection_status).toBe('surge_status_indicator');
  });

  test('main fuse / supply fuse aliases STILL route to spd_* (no regression)', () => {
    expect(FIELD_CORRECTIONS.main_fuse_rating).toBe('spd_rated_current');
    expect(FIELD_CORRECTIONS.main_fuse_bs_en).toBe('spd_bs_en');
    expect(FIELD_CORRECTIONS.supply_fuse_type).toBe('spd_bs_en');
  });

  test('no surge alias accidentally points at the spd_* cutout family', () => {
    for (const [alias, canonical] of Object.entries(FIELD_CORRECTIONS)) {
      if (alias.startsWith('surge')) {
        expect(canonical.startsWith('surge_')).toBe(true);
      }
    }
  });
});

describe('surge-protection — transformExtractedData (document/photo → job state)', () => {
  test('board.spd_type does NOT leak into supply_characteristics.spd_type_supply', () => {
    const { supply_characteristics } = transformExtractedData({}, { spd_type: 'Type 2' });
    // Pre-fix this fell through `board.spd_type_supply || board.spd_type`,
    // pulling board-scoped CCU surge data into the supply Main Fuse box.
    expect(supply_characteristics.spd_type_supply).toBe('');
  });

  test('genuine cutout type still populates spd_type_supply', () => {
    const { supply_characteristics } = transformExtractedData({}, { spd_type_supply: 'gG' });
    expect(supply_characteristics.spd_type_supply).toBe('gG');
  });

  test('surge_* values survive the transform into supply_characteristics', () => {
    const { supply_characteristics } = transformExtractedData(
      {},
      {
        surge_spd_present: 'Yes',
        surge_spd_type: 'Type 2',
        surge_spd_bs_en: '61643-11',
        surge_status_indicator: 'Satisfactory',
      }
    );
    expect(supply_characteristics.surge_spd_present).toBe('Yes');
    expect(supply_characteristics.surge_spd_type).toBe('Type 2');
    expect(supply_characteristics.surge_spd_bs_en).toBe('61643-11');
    expect(supply_characteristics.surge_status_indicator).toBe('Satisfactory');
  });

  test('supply_characteristics always carries the surge_* keys (no silent drop)', () => {
    const { supply_characteristics } = transformExtractedData({}, {});
    for (const k of SURGE_KEYS) {
      expect(k in supply_characteristics).toBe(true);
    }
  });
});
