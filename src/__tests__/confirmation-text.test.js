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

  test('2026-05-29 v2: deny-list policy — speak unless on SUPPRESSED list or *_id', () => {
    // Inspector explicitly asked for TTS on EVERYTHING that lands in
    // the UI (hands-free AirPods workflow). Address, client name,
    // postcode NOW speak. Internal IDs and sort metadata still skip.
    expect(buildConfirmationText('address', '1 Tilehurst Road', null)).toBe(
      'address 1 Tilehurst Road'
    );
    expect(buildConfirmationText('client_name', 'Mr Smith', null)).toBe('client name Mr Smith');
    expect(buildConfirmationText('postcode', 'RG5 4RD', null)).toBe('postcode RG5 4RD');
    // Truly unknown field also speaks via snake_case fallback.
    expect(buildConfirmationText('some_made_up_field', 'value', 1)).toBe(
      'Circuit 1, some made up field value'
    );
    // Suppressed: internal IDs and metadata.
    expect(buildConfirmationText('circuit_ref', 7, null)).toBeNull();
    expect(buildConfirmationText('board_id', 'main', null)).toBeNull();
    expect(buildConfirmationText('parent_board_id', 'main', null)).toBeNull();
    expect(buildConfirmationText('sort_order', '5', null)).toBeNull();
    expect(buildConfirmationText('signature_file', '/tmp/sig.png', null)).toBeNull();
  });

  test('2026-05-29: circuit_designation speaks "Circuit N is now the {value}"', () => {
    expect(buildConfirmationText('circuit_designation', 'Cooker', 1)).toBe(
      'Circuit 1 is now the Cooker'
    );
    // Board-level (circuit=0/null) → suppress, designation is a circuit
    // concept and the supply bucket has no name to report.
    expect(buildConfirmationText('circuit_designation', 'Cooker', 0)).toBeNull();
    expect(buildConfirmationText('circuit_designation', 'Cooker', null)).toBeNull();
  });

  test('2026-05-29: ocpd_bs_en and other expanded fields now confirm', () => {
    expect(buildConfirmationText('ocpd_bs_en', 'BS EN 60898', 1)).toBe(
      'Circuit 1, OCPD BS EN BS EN 60898'
    );
    expect(buildConfirmationText('rcd_bs_en', 'BS EN 61008', 1)).toBe(
      'Circuit 1, RCD BS EN BS EN 61008'
    );
    expect(buildConfirmationText('max_disconnect_time_s', '0.4', 1)).toBe(
      'Circuit 1, disconnection time 0.4'
    );
  });

  test('2026-05-29: designation prefix replaces "Circuit N" when provided', () => {
    expect(buildConfirmationText('measured_zs_ohm', '0.62', 1, 'Cooker')).toBe(
      'Cooker, circuit 1, Zs 0.62'
    );
    expect(buildConfirmationText('polarity_confirmed', 'Y', 1, 'Upstairs lights')).toBe(
      'Upstairs lights, circuit 1, polarity confirmed'
    );
    // null/empty designation falls back to "Circuit N".
    expect(buildConfirmationText('measured_zs_ohm', '0.62', 1, null)).toBe('Circuit 1, Zs 0.62');
    expect(buildConfirmationText('measured_zs_ohm', '0.62', 1, '')).toBe('Circuit 1, Zs 0.62');
    // Length cap at 40 chars (prevents "Upstairs sockets and lights and
    // smoke alarm" dominating every TTS line).
    expect(
      buildConfirmationText(
        'measured_zs_ohm',
        '0.62',
        1,
        'Upstairs sockets, lights, and smoke alarms in hall'
      )
    ).toBe('Upstairs sockets, lights, and smoke alar, circuit 1, Zs 0.62');
  });

  test('empty value returns null', () => {
    expect(buildConfirmationText('measured_zs_ohm', '', 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', null, 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', undefined, 1)).toBeNull();
    expect(buildConfirmationText('measured_zs_ohm', '   ', 1)).toBeNull();
  });

  test('polarity_confirmed reads back on truthy forms (Y / OK / true / yes); falsy/empty/unknown suppressed', () => {
    // Canonical schema enum forms (post-2026-05-24 dispatcher coercion).
    expect(buildConfirmationText('polarity_confirmed', 'Y', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    expect(buildConfirmationText('polarity_confirmed', 'OK', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    // Legacy off-mode forms still accepted (no coercion in that path).
    expect(buildConfirmationText('polarity_confirmed', 'true', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    expect(buildConfirmationText('polarity_confirmed', 'TRUE', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    expect(buildConfirmationText('polarity_confirmed', 'yes', 1)).toBe(
      'Circuit 1, polarity confirmed'
    );
    // Board-level polarity (no circuit) → bare "polarity confirmed".
    expect(buildConfirmationText('polarity_confirmed', 'Y', null)).toBe('polarity confirmed');
    expect(buildConfirmationText('polarity_confirmed', 'true', null)).toBe('polarity confirmed');
    // Falsy / empty / unknown is suppressed (a failed polarity is an
    // inspection failure the inspector will edit by hand — do not
    // acoustically reinforce it as if accepted).
    expect(buildConfirmationText('polarity_confirmed', 'N', 1)).toBeNull();
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

  test('2026-05-29 v2: returns false only for suppressed/ID fields', () => {
    // Deny-list policy: address/client_name/unknown fields now speak.
    expect(shouldGenerateConfirmation({ field: 'address' })).toBe(true);
    expect(shouldGenerateConfirmation({ field: 'client_name' })).toBe(true);
    expect(shouldGenerateConfirmation({ field: 'some_made_up_field' })).toBe(true);
    // Internal IDs and metadata still skip.
    expect(shouldGenerateConfirmation({ field: 'circuit_ref' })).toBe(false);
    expect(shouldGenerateConfirmation({ field: 'board_id' })).toBe(false);
    expect(shouldGenerateConfirmation({ field: 'sort_order' })).toBe(false);
  });

  test('2026-05-29: returns true for circuit_designation (newly opted into TTS)', () => {
    expect(shouldGenerateConfirmation({ field: 'circuit_designation' })).toBe(true);
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
