/**
 * Unit tests for board-model-registry.
 *
 * Covers the fix for the 2026-05-01 prod incident where the Stage 1 VLM
 * classifier returned `boardTechnology: "mixed"` (conf 0.92) for a
 * Wylex NHRS12SL — a high-integrity DIN-rail consumer unit — routing
 * the per-slot pipeline through prepareRewireableGeometry and emitting
 * 13 circuits with zero RCD-protected entries.
 */
import { describe, test, expect } from '@jest/globals';
import {
  inferTechnologyFromModel,
  _MODERN_MODEL_PATTERNS_FOR_TESTS,
} from '../extraction/board-model-registry.js';

describe('inferTechnologyFromModel — null / empty inputs', () => {
  test('returns null when boardModel is null', () => {
    expect(inferTechnologyFromModel({ boardModel: null, boardManufacturer: 'Wylex' })).toBeNull();
  });

  test('returns null when boardModel is undefined', () => {
    expect(inferTechnologyFromModel({ boardManufacturer: 'Wylex' })).toBeNull();
  });

  test('returns null when boardModel is empty string', () => {
    expect(inferTechnologyFromModel({ boardModel: '', boardManufacturer: 'Wylex' })).toBeNull();
  });

  test('returns null when boardModel is whitespace only', () => {
    expect(inferTechnologyFromModel({ boardModel: '   ', boardManufacturer: 'Wylex' })).toBeNull();
  });

  test('returns null with no arguments', () => {
    expect(inferTechnologyFromModel()).toBeNull();
  });
});

describe('inferTechnologyFromModel — Wylex NH series (the prod repro case)', () => {
  test('NHRS12SL with manufacturer "Wylex" -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'NHRS12SL',
      boardManufacturer: 'Wylex',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
    expect(result.series).toMatch(/Wylex NH/);
    expect(result.manufacturerMatched).toBe(true);
  });

  test('NHRS12SL with null manufacturer -> modern (model alone is unique)', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'NHRS12SL',
      boardManufacturer: null,
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
    expect(result.manufacturerMatched).toBe(true);
  });

  test('NHRS12SL with mismatched manufacturer "Hager" -> null (manufacturer collision)', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'NHRS12SL',
      boardManufacturer: 'Hager',
    });
    expect(result).toBeNull();
  });

  test('case-insensitive: "nhrs12sl" -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'nhrs12sl',
      boardManufacturer: 'wylex',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
  });

  test('whitespace-padded model "  NHRS12SL  " -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: '  NHRS12SL  ',
      boardManufacturer: 'Wylex',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
  });

  test('NHSB12 (standard-integrity Wylex) -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'NHSB12',
      boardManufacturer: 'Wylex',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
  });

  test('AMR3RB (Wylex Amendment-3 metalclad) -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'AMR3RB',
      boardManufacturer: 'Wylex',
    });
    expect(result).not.toBeNull();
    expect(result.series).toMatch(/AMR/);
  });
});

describe('inferTechnologyFromModel — other modern manufacturers', () => {
  test('Hager VML112 -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'VML112',
      boardManufacturer: 'Hager',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
    expect(result.series).toMatch(/Hager/);
  });

  test('Schneider LN5512 (Easy9) -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'LN5512',
      boardManufacturer: 'Schneider Electric',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
    expect(result.series).toMatch(/Easy9/);
  });

  test('Schneider EZ9 (Easy9) -> modern (manufacturer "Schneider Electric" normalised to "schneider")', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'EZ9F56210',
      boardManufacturer: 'Schneider Electric Limited',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
  });

  test('BG CUCRB12W -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'CUCRB12W',
      boardManufacturer: 'BG',
    });
    expect(result).not.toBeNull();
    expect(result.technology).toBe('modern');
  });

  test('Eaton MBO12 (Memshield 3) -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'MBO12',
      boardManufacturer: 'Eaton',
    });
    expect(result).not.toBeNull();
    expect(result.series).toMatch(/Memshield/);
  });

  test('Contactum CPCNR12 (Defender) -> modern', () => {
    const result = inferTechnologyFromModel({
      boardModel: 'CPCNR12',
      boardManufacturer: 'Contactum',
    });
    expect(result).not.toBeNull();
    expect(result.series).toMatch(/Defender/);
  });
});

describe('inferTechnologyFromModel — non-matching models (registry must not fire)', () => {
  test('unknown model "ABC123" -> null', () => {
    expect(
      inferTechnologyFromModel({ boardModel: 'ABC123', boardManufacturer: 'Wylex' })
    ).toBeNull();
  });

  test('Wylex S5 (genuine rewireable J/K/S series) -> null (must NOT match modern)', () => {
    // Wylex S5 / S7 are pull-out fuse-carrier boards.  The registry must
    // never claim these are modern — that would override a correct VLM
    // "rewireable_fuse" classification and break the rewireable pipeline.
    expect(inferTechnologyFromModel({ boardModel: 'S5', boardManufacturer: 'Wylex' })).toBeNull();
    expect(inferTechnologyFromModel({ boardModel: 'S7', boardManufacturer: 'Wylex' })).toBeNull();
  });

  test('empty manufacturer + non-matching model -> null', () => {
    expect(inferTechnologyFromModel({ boardModel: 'XYZ', boardManufacturer: null })).toBeNull();
  });
});

describe('registry hygiene', () => {
  test('every entry has a regex pattern, expectedManufacturer, and series description', () => {
    expect(_MODERN_MODEL_PATTERNS_FOR_TESTS.length).toBeGreaterThan(0);
    for (const entry of _MODERN_MODEL_PATTERNS_FOR_TESTS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.expectedManufacturer).toBe('string');
      expect(entry.expectedManufacturer.length).toBeGreaterThan(0);
      expect(typeof entry.series).toBe('string');
      expect(entry.series.length).toBeGreaterThan(0);
    }
  });
});
