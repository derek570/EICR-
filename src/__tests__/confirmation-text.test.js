/**
 * Unit tests for src/extraction/confirmation-text.js (Loaded Barrel
 * Phase 1.B leaf module).
 *
 * The module is a pure extraction of constants + buildConfirmationText
 * from the bundler — these tests just pin the surface so the
 * speculator and bundler can both import without surprises. The
 * bundler-integration assertions already live in
 * stage6-event-bundler.test.js (legacy synthesise-confirmations
 * coverage); this file only covers the leaf in isolation +
 * shouldGenerateConfirmation (new helper).
 */

import {
  CONFIRMATION_FRIENDLY_NAMES,
  CONFIRMATION_MIN_CONFIDENCE,
  buildConfirmationText,
  shouldGenerateConfirmation,
} from '../extraction/confirmation-text.js';

describe('confirmation-text — constants', () => {
  test('CONFIRMATION_MIN_CONFIDENCE matches legacy prompt threshold (0.8)', () => {
    // Drift here would silently change the confidence gate for the
    // entire Voice toggle feature. Pin it.
    expect(CONFIRMATION_MIN_CONFIDENCE).toBe(0.8);
  });

  test('CONFIRMATION_FRIENDLY_NAMES is frozen (defensive against shared-ref mutation)', () => {
    // The bundler + speculator BOTH import this table. A consumer
    // accidentally mutating an entry would silently corrupt
    // confirmation text for every other consumer.
    expect(Object.isFrozen(CONFIRMATION_FRIENDLY_NAMES)).toBe(true);
  });

  test('CONFIRMATION_FRIENDLY_NAMES has board-level fields (Ze, PFC, PSCC, PEFC)', () => {
    // Board-level entries are special: they emit without "Circuit N,"
    // prefix. If any of these go missing, board-level confirmations
    // silently stop being spoken.
    expect(CONFIRMATION_FRIENDLY_NAMES.earth_loop_impedance_ze).toBe('Ze');
    expect(CONFIRMATION_FRIENDLY_NAMES.prospective_fault_current).toBe('PFC');
    expect(CONFIRMATION_FRIENDLY_NAMES.prospective_short_circuit_current).toBe('PSCC');
    expect(CONFIRMATION_FRIENDLY_NAMES.prospective_earth_fault_current).toBe('PEFC');
  });
});

describe('confirmation-text — buildConfirmationText', () => {
  test('circuit reading: "Circuit N, <friendly> <value>"', () => {
    expect(buildConfirmationText('measured_zs_ohm', '0.62', 1)).toBe('Circuit 1, Zs 0.62');
    expect(buildConfirmationText('r1_r2_ohm', '0.6', 2)).toBe('Circuit 2, R1 plus R2 0.6');
    expect(buildConfirmationText('ocpd_type', 'B', 3)).toBe('Circuit 3, OCPD type B');
  });

  test('board-level: circuit=null skips "Circuit N," prefix', () => {
    expect(buildConfirmationText('earth_loop_impedance_ze', '0.19', null)).toBe('Ze 0.19');
    expect(buildConfirmationText('prospective_fault_current', '1.5', undefined)).toBe('PFC 1.5');
  });

  test('board-level: circuit=0 also skips prefix (treated as board)', () => {
    expect(buildConfirmationText('earth_loop_impedance_ze', '0.19', 0)).toBe('Ze 0.19');
  });

  test('unknown field returns null (no friendly name → no confirmation)', () => {
    expect(buildConfirmationText('circuit_designation', 'Cooker', 1)).toBeNull();
    expect(buildConfirmationText('address', '1 Tilehurst Road', null)).toBeNull();
    expect(buildConfirmationText('ocpd_bs_en', 'BS EN 60898', 1)).toBeNull();
  });

  test('empty value returns null', () => {
    expect(buildConfirmationText('measured_zs_ohm', '', 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', null, 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', undefined, 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', '   ', 1)).toBeNull();
  });

  test('polarity_confirmed=true reads back; false/anything-else suppressed', () => {
    expect(buildConfirmationText('polarity_confirmed', 'true', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    expect(buildConfirmationText('polarity_confirmed', 'TRUE', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    // Board-level polarity (no circuit) → bare "polarity confirmed".
    expect(buildConfirmationText('polarity_confirmed', 'true', null)).toBe('polarity confirmed');
    // False / non-true is suppressed.
    expect(buildConfirmationText('polarity_confirmed', 'false', 1)).toBeNull();
    expect(buildConfirmationText('polarity_confirmed', '', 1)).toBeNull();
    expect(buildConfirmationText('polarity_confirmed', 'maybe', 1)).toBeNull();
  });

  test('numeric value is string-coerced + trimmed', () => {
    expect(buildConfirmationText('number_of_points', 5, 1)).toBe('Circuit 1, points 5');
    expect(buildConfirmationText('measured_zs_ohm', '  0.62  ', 1)).toBe('Circuit 1, Zs 0.62');
  });
});

describe('confirmation-text — shouldGenerateConfirmation', () => {
  test('returns false for null / undefined slot', () => {
    expect(shouldGenerateConfirmation(null)).toBe(false);
    expect(shouldGenerateConfirmation(undefined)).toBe(false);
  });

  test('returns false for unknown field (not in friendly-name table)', () => {
    expect(shouldGenerateConfirmation({ field: 'circuit_designation' })).toBe(false);
    expect(shouldGenerateConfirmation({ field: 'address' })).toBe(false);
  });

  test('returns true for known field without confidence (legacy callers default to true)', () => {
    expect(shouldGenerateConfirmation({ field: 'measured_zs_ohm' })).toBe(true);
    expect(shouldGenerateConfirmation({ field: 'earth_loop_impedance_ze' })).toBe(true);
  });

  test('returns true for known field with confidence ≥ threshold', () => {
    expect(shouldGenerateConfirmation({ field: 'measured_zs_ohm', confidence: 0.8 })).toBe(true);
    expect(shouldGenerateConfirmation({ field: 'measured_zs_ohm', confidence: 1.0 })).toBe(true);
  });

  test('returns false for known field with confidence < threshold', () => {
    expect(shouldGenerateConfirmation({ field: 'measured_zs_ohm', confidence: 0.79 })).toBe(false);
    expect(shouldGenerateConfirmation({ field: 'measured_zs_ohm', confidence: 0.0 })).toBe(false);
  });
});
