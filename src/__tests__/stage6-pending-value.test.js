/**
 * §A4 (field-feedback-2026-07-14, F8) — unit tests for the pending-value
 * module: extractPendingValue (capture rules incl. the F8 two-number ask
 * question), resolveFieldNameAnswer (NET-NEW field-name resolution), and
 * detectStructuredReading (the typed schema-aware detector spanning all
 * field families).
 */

import {
  extractPendingValue,
  resolveFieldNameAnswer,
  detectStructuredReading,
} from '../extraction/stage6-pending-value.js';

describe('extractPendingValue — F8 capture rules', () => {
  test('F8 variant A: value in the turn transcript, unit-bound', () => {
    const out = extractPendingValue({
      transcript: 'ICD trip time for circuit 2 is 26 milliseconds.',
      question: 'Which reading was that for?',
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'transcript' });
  });

  test('F8 variant B: transcript empty, ask QUESTION carries TWO numbers — "circuit 2" is scope, "26 milliseconds" is the value', () => {
    const out = extractPendingValue({
      transcript: null,
      question: 'I heard 26 milliseconds for circuit 2 — which reading was that for?',
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'question' });
  });

  test('scope-token exclusion holds in the transcript too', () => {
    const out = extractPendingValue({
      transcript: 'circuit 4 something 0.62 ohms',
      question: null,
    });
    expect(out).toMatchObject({ value: '0.62', unit: 'ohm', source: 'transcript' });
  });

  test('multiple unbound value spans → NO capture (never guess)', () => {
    const out = extractPendingValue({
      transcript: 'it was 26 or maybe 28 I think',
      question: null,
    });
    expect(out).toBeNull();
  });

  test('single unbound number → captured with null unit', () => {
    const out = extractPendingValue({ transcript: 'it was 26', question: null });
    expect(out).toMatchObject({ value: '26', unit: null, source: 'transcript' });
  });

  test('only scope numbers → no capture', () => {
    expect(extractPendingValue({ transcript: 'on circuit 2 please', question: null })).toBeNull();
  });

  test('transcript preferred over question when both carry values', () => {
    const out = extractPendingValue({
      transcript: 'reading was 26 milliseconds',
      question: 'was that 30 milliseconds?',
    });
    expect(out).toMatchObject({ value: '26', source: 'transcript' });
  });

  test('provenance sourceText is recorded', () => {
    const out = extractPendingValue({ transcript: 'reading was 26 milliseconds', question: null });
    expect(out.sourceText).toBe('reading was 26 milliseconds');
  });
});

describe('resolveFieldNameAnswer — field-name replies', () => {
  test('F8 reply "RCD trip time." → rcd_time_ms (canonical snapshot key, NOT the wire key)', () => {
    expect(resolveFieldNameAnswer('RCD trip time.')).toBe('rcd_time_ms');
  });

  test('"trip time" and the ICD garble form resolve too', () => {
    expect(resolveFieldNameAnswer('trip time')).toBe('rcd_time_ms');
    expect(resolveFieldNameAnswer('ICD trip time')).toBe('rcd_time_ms');
  });

  test('leading filler is stripped ("it was the trip time")', () => {
    expect(resolveFieldNameAnswer('it was the trip time')).toBe('rcd_time_ms');
  });

  test('"Zs" resolves to measured_zs_ohm', () => {
    expect(resolveFieldNameAnswer('Zs')).toBe('measured_zs_ohm');
  });

  test('unrelated prose → null (no fuzzy guessing)', () => {
    expect(resolveFieldNameAnswer('the weather is nice')).toBeNull();
    expect(resolveFieldNameAnswer('yes')).toBeNull();
    expect(resolveFieldNameAnswer('')).toBeNull();
  });
});

describe('detectStructuredReading — typed, schema-aware completeness', () => {
  test('circuit field + value + explicit ref → complete ("Zs circuit 4 is 0.30")', () => {
    const d = detectStructuredReading('Zs circuit 4 is 0.30');
    expect(d).toMatchObject({
      fieldKey: 'measured_zs_ohm',
      family: 'circuit',
      toolFamily: 'record_reading',
      circuit: 4,
      complete: true,
    });
  });

  test('BOARD reading needs no circuit → complete ("Ze is 0.22")', () => {
    const d = detectStructuredReading('Ze is 0.22');
    expect(d).toMatchObject({
      fieldKey: 'earth_loop_impedance_ze',
      toolFamily: 'record_board_reading',
      complete: true,
    });
  });

  test('SELECT field with a canonical option, zero digits → complete ("earthing arrangement is TT")', () => {
    const d = detectStructuredReading('earthing arrangement is TT');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('FREE-TEXT installation field via assignment form → complete ("customer name is David")', () => {
    const d = detectStructuredReading('customer name is David');
    expect(d).toMatchObject({ fieldKey: 'client_name', complete: true });
  });

  test('bare field name (the F8 ANSWER shape) → NOT complete', () => {
    const d = detectStructuredReading('RCD trip time.');
    expect(d == null || d.complete === false).toBe(true);
  });

  test('bare numeric value → no field → null', () => {
    expect(detectStructuredReading('26 milliseconds')).toBeNull();
  });

  test('circuit field + value but NO explicit ref → NOT complete (conservative against active asks)', () => {
    const d = detectStructuredReading('Zs is 0.30');
    expect(d).not.toBeNull();
    expect(d.complete).toBe(false);
  });

  test('Codex r1-#2: select ALIASES count — "earthing arrangement is PME" is complete (PME ≡ TN-C-S per the prompt garble list)', () => {
    const d = detectStructuredReading('earthing arrangement is PME');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('Codex r1-#2: squashed option forms count — "earthing arrangement is t n s" (TN-S) is complete', () => {
    const d = detectStructuredReading('earthing arrangement is t n s');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('sentinel value counts for a numeric circuit field ("R1 plus R2 on circuit 3 is a limitation")', () => {
    const d = detectStructuredReading('R1 plus R2 on circuit 3 is a limitation');
    expect(d).toMatchObject({ fieldKey: 'r1_r2_ohm', circuit: 3, complete: true });
  });
});
