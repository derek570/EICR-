import { reconcileLegacyReadingConfirmations } from '../extraction/reading-field-contract-sanitizer.js';

describe('DictatedReadbackPolicyV1 legacy reconciliation', () => {
  test('replaces wrong model value/scope/expanded text and removes unmatched reading claims', () => {
    const result = {
      extracted_readings: [
        { field: 'measured_zs_ohm', circuit: 2, value: '0.42', confidence: 0.2 },
      ],
      confirmations: [
        { field: 'measured_zs_ohm', circuit: 9, text: 'Circuit 9 Zs 9.9', expanded_text: 'wrong' },
        { field: 'rcd_time_ms', circuit: 1, text: 'unmatched' },
        { field: null, circuit: null, text: 'Non-reading terminal' },
      ],
    };
    reconcileLegacyReadingConfirmations(result);
    expect(result.confirmations).toEqual([
      expect.objectContaining({ field: 'measured_zs_ohm', circuit: 2, text: 'Circuit 2, Zs 0.42' }),
      { field: null, circuit: null, text: 'Non-reading terminal' },
    ]);
    expect(result.confirmations[0].expanded_text).not.toBe('wrong');
  });

  test('creates a mandatory read-back when model confirmations are absent or empty', () => {
    for (const confirmations of [undefined, []]) {
      const result = {
        extracted_readings: [
          { field: 'polarity_confirmed', circuit: 4, value: 'N', confidence: 0.2 },
        ],
        ...(confirmations === undefined ? {} : { confirmations }),
      };
      reconcileLegacyReadingConfirmations(result);
      expect(result.confirmations).toEqual([
        expect.objectContaining({ text: 'Circuit 4, polarity is reversed' }),
      ]);
    }
  });

  test('derived readings remain silent and designation ownership is preserved', () => {
    const designation = { field: 'designation', circuit: 1, text: 'Circuit 1 is now the Cooker' };
    const result = {
      extracted_readings: [
        { field: 'polarity_confirmed', circuit: 1, value: 'Y', derived: true },
        { field: 'designation', circuit: 1, value: 'Cooker' },
      ],
      confirmations: [designation],
    };
    reconcileLegacyReadingConfirmations(result);
    expect(result.confirmations).toEqual([designation]);
  });
});
