/**
 * Parity tests for `src/extraction/ios-dedupe-key.js` — locks the JS mirror
 * of iOS `buildConfirmationDedupeKey` (CertMateUnified/Sources/Recording/
 * DeepgramRecordingViewModel.swift:649). PLAN voice-feedback-2026-06-05
 * §A condition 2 + W1.2 (b) + W1.4: backend telemetry must reconcile
 * byte-for-byte against iOS-side reality.
 *
 * djb2 expected values were computed by hand against the Swift algorithm:
 *   var h: UInt64 = 5381
 *   for scalar in s.unicodeScalars { h = (h &* 33) &+ UInt64(scalar.value) }
 *   return "\(h)"
 *
 * If a future tweak alters djb2UInt64Decimal output, these tests fail
 * loudly and force a deliberate cross-platform sync.
 */
import {
  djb2UInt64Decimal,
  buildPerCircuitDedupeKey,
  buildMultiCircuitDedupeKey,
  buildDegenerateDedupeKey,
} from '../extraction/ios-dedupe-key.js';

describe('djb2UInt64Decimal — UInt64 wrap arithmetic mirror', () => {
  test('empty string returns the init seed 5381', () => {
    expect(djb2UInt64Decimal('')).toBe('5381');
  });

  test('"a" → 5381*33 + 97 = 177670', () => {
    expect(djb2UInt64Decimal('a')).toBe('177670');
  });

  test('"abc" matches manually-stepped djb2', () => {
    // a:97 → 177670; *33+98=5863208; *33+99=193485963
    expect(djb2UInt64Decimal('abc')).toBe('193485963');
  });

  test('null returns "0" sentinel — guards the W1.4 bundler path where text may be absent', () => {
    expect(djb2UInt64Decimal(null)).toBe('0');
    expect(djb2UInt64Decimal(undefined)).toBe('0');
  });

  test('long ASCII stays a stable decimal string (no scientific notation)', () => {
    const h = djb2UInt64Decimal('main fuse BS EN 1361');
    expect(typeof h).toBe('string');
    expect(h).toMatch(/^\d+$/);
  });

  test('different inputs produce different hashes (no degenerate collisions)', () => {
    const a = djb2UInt64Decimal('main fuse BS EN 1361');
    const b = djb2UInt64Decimal('main fuse BS EN 60898');
    expect(a).not.toBe(b);
  });
});

describe('buildPerCircuitDedupeKey — legacy shape preserved for cross-match', () => {
  test('shape is "<field>_<circuit>"', () => {
    expect(buildPerCircuitDedupeKey('ir_live_live_mohm', 1)).toBe('ir_live_live_mohm_1');
  });

  test('null field falls back to "unknown"', () => {
    expect(buildPerCircuitDedupeKey(null, 2)).toBe('unknown_2');
  });
});

describe('buildMultiCircuitDedupeKey — sorted circuits + djb2 text hash', () => {
  test('circuits sorted ascending in the key', () => {
    const k = buildMultiCircuitDedupeKey(
      'ir_live_live_mohm',
      [3, 1, 2],
      'Circuits 1, 2, 3, IR L to L >299'
    );
    expect(k.startsWith('ir_live_live_mohm_1-2-3_')).toBe(true);
  });

  test('different broadcast text → different key (this is the C0C21546 turn-9/turn-10 bug fix)', () => {
    const a = buildMultiCircuitDedupeKey('rcd_time_ms', [1, 2], 'Circuits 1, 2, RCD time 24');
    const b = buildMultiCircuitDedupeKey('rcd_time_ms', [3, 4], 'Circuits 3, 4, RCD time 28');
    expect(a).not.toBe(b);
  });
});

describe('buildDegenerateDedupeKey — Wave 2 W2.3 shape replaces "<field>_none"', () => {
  test('shape is "<field>_<djb2(text+boardId)>"', () => {
    const k = buildDegenerateDedupeKey('spd_bs_en', 'main fuse BS EN 1361', null);
    expect(k.startsWith('spd_bs_en_')).toBe(true);
    expect(k).toMatch(/^spd_bs_en_\d+$/);
  });

  test('same field + different text → different key (closes the dedupe collision bug)', () => {
    const a = buildDegenerateDedupeKey('spd_bs_en', 'main fuse BS EN 1361', null);
    const b = buildDegenerateDedupeKey('spd_bs_en', 'main fuse BS EN 60898', null);
    expect(a).not.toBe(b);
  });

  test('same field + same text + different boardId → different key (sub-board isolation)', () => {
    const a = buildDegenerateDedupeKey('earth_loop_impedance_ze', 'Ze 0.62', 'main');
    const b = buildDegenerateDedupeKey('earth_loop_impedance_ze', 'Ze 0.62', 'sub-1');
    expect(a).not.toBe(b);
  });

  test('same field + same text + same boardId → SAME key (legitimate dedupe preserved)', () => {
    const a = buildDegenerateDedupeKey('client_name', 'customer Joe Bloggs', null);
    const b = buildDegenerateDedupeKey('client_name', 'customer Joe Bloggs', null);
    expect(a).toBe(b);
  });

  test('boardId null vs empty string normalise to the same key', () => {
    const a = buildDegenerateDedupeKey('client_name', 'customer X', null);
    const b = buildDegenerateDedupeKey('client_name', 'customer X', undefined);
    const c = buildDegenerateDedupeKey('client_name', 'customer X', '');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
