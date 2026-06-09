/**
 * Cluster C2 (regression lock for the JOIN truncation false alarm) —
 * voice-feedback-cleanup-2026-06-09.
 *
 * Marker 2: "Circuits 1, 2" → TTS reads only "1". The original plan
 * claimed buildGroupedConfirmationText was truncating with .join('')[0]
 * or similar; verification against the source (confirmation-text.js:309)
 * showed the helper uses `.join(', ')` correctly and is NOT the
 * truncation source. The bug must be in a CALLER (bundler/speculator
 * emitting a 1-circuit list) — diagnosis is gated on a CloudWatch
 * trace per the plan's §3.5.
 *
 * This file's role is forward-protection: lock the helper's existing
 * correct behaviour so a future "fix" that misreads the symptom can't
 * regress the join. N=2 / N=5 / N=10 circuit lists must all surface
 * every number, comma-separated, with no truncation.
 */

import { buildGroupedConfirmationText } from '../extraction/confirmation-text.js';

describe('Cluster C2 — buildGroupedConfirmationText preserves every circuit (no truncation)', () => {
  test('N=2 circuits → both numbers appear separated by a comma', () => {
    const text = buildGroupedConfirmationText('measured_zs_ohm', '0.45', [1, 2]);
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toMatch(/1[^0-9]+2/);
  });

  test('N=5 contiguous circuits → range OR comma-list form, never truncated', () => {
    const text = buildGroupedConfirmationText('measured_zs_ohm', '0.45', [1, 2, 3, 4, 5]);
    // Two acceptable shapes:
    //   - Range form: "Circuits 1 to 5, ..." (contiguous range >= 3).
    //   - Comma-list form: "Circuits 1, 2, 3, 4 and 5, ..." (fallback).
    // The range form is preferred for contiguous ranges per
    // buildGroupedConfirmationText's comment (line 246). Test for either
    // form by checking the bookends and the friendly-name + value.
    expect(text).toMatch(/Circuit/);
    expect(text).toContain('1');
    expect(text).toContain('5');
    expect(text).toContain('Zs');
    expect(text).toContain('0.45');
    // If a future edit collapses to comma-list form (e.g. on a forced
    // expand setting), every digit must still appear — guards against
    // re-introducing the marker-2 truncation symptom.
    if (text.includes('Circuits 1,') || text.includes('1, 2')) {
      for (const n of [1, 2, 3, 4, 5]) {
        expect(text).toContain(String(n));
      }
    }
  });

  test('N=10 non-contiguous circuits → every number appears at least once', () => {
    const list = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    const text = buildGroupedConfirmationText('measured_zs_ohm', '0.45', list);
    for (const n of list) {
      // Number must appear somewhere in the spoken text — proves the
      // helper never truncates a non-contiguous bag past the first item.
      expect(text).toContain(String(n));
    }
  });

  test('N=2 IR reading → both circuits + the IR friendly name + the value', () => {
    // marker 2's original transcript was IR-related ("Circuits 1, 2,
    // IR L to L ..."). Lock the IR variant explicitly because the
    // grouped helper's tail uses the same friendly-name table.
    const text = buildGroupedConfirmationText('ir_live_live_mohm', '>299', [1, 2]);
    expect(text).toContain('IR L to L');
    expect(text).toContain('>299');
    expect(text).toContain('1');
    expect(text).toContain('2');
  });
});
