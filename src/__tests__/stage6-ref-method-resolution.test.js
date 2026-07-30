/**
 * §3.4 (PLAN-2, feedback id 103, 2026-07-30) — ref_method deterministic
 * dead-end. Letter answers A–G structurally could not resolve on the
 * ask-answer path (ref_method has digit options 100–103, so it is barred
 * from WORD_ANCHORED_ENUM_FIELDS, and the digit matcher finds no digit in
 * "C"), and the record_reading path never coerced spoken forms
 * ("method C", "one hundred"). These tests pin both legs.
 */

import { resolveEnumAnswer } from '../extraction/stage6-answer-resolver.js';
import {
  coerceRecordReadingValue,
  coerceRefMethodValue,
} from '../extraction/record-reading-coercion.js';

const REF_SCHEMA = {
  circuit_fields: {
    ref_method: {
      label: 'Reference Method',
      type: 'select',
      options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', '100', '101', '102', '103'],
      default: 'A',
    },
    // a second enum field to prove the ref_method branch is context-gated
    ocpd_type: {
      label: 'OCPD Type',
      type: 'select',
      options: ['', 'B', 'C', 'D'],
    },
  },
};

const ask = (userText, contextField = 'ref_method', extra = {}) =>
  resolveEnumAnswer({
    userText,
    contextField,
    contextCircuit: 4,
    sourceTurnId: 't1',
    fieldSchema: REF_SCHEMA,
    ...extra,
  });

describe('§3.4 leg 1 — coerceRefMethodValue', () => {
  test('bare lowercase letter → canonical uppercase', () => {
    expect(coerceRefMethodValue('c')).toBe('C');
    expect(coerceRefMethodValue('C')).toBe('C');
    expect(coerceRefMethodValue('a')).toBe('A');
  });
  test('"method C" / "reference method C" → C', () => {
    expect(coerceRefMethodValue('method C')).toBe('C');
    expect(coerceRefMethodValue('reference method c')).toBe('C');
    expect(coerceRefMethodValue("it's method C.")).toBe('C');
  });
  test('word-number forms → 100–103', () => {
    expect(coerceRefMethodValue('one hundred')).toBe('100');
    expect(coerceRefMethodValue('a hundred')).toBe('100');
    expect(coerceRefMethodValue('one hundred and one')).toBe('101');
    expect(coerceRefMethodValue('one hundred three')).toBe('103');
  });
  test('canonical digit run passes through', () => {
    expect(coerceRefMethodValue('100')).toBe('100');
    expect(coerceRefMethodValue('103')).toBe('103');
  });
  test('unrecognised passes through verbatim (validator rejects)', () => {
    expect(coerceRefMethodValue('buried run')).toBe('buried run');
    expect(coerceRefMethodValue('99')).toBe('99');
    expect(coerceRefMethodValue('H')).toBe('H');
  });
  test('coerceRecordReadingValue routes ref_method through the map', () => {
    expect(coerceRecordReadingValue('ref_method', 'method C')).toBe('C');
    expect(coerceRecordReadingValue('ref_method', 'one hundred')).toBe('100');
    // other fields untouched by the ref_method branch
    expect(coerceRecordReadingValue('measured_zs_ohm', '0.4')).toBe('0.4');
  });
});

describe('§3.4 leg 2 — resolveEnumAnswer ref_method letter/digit forms', () => {
  test('reply "a" alone ⇒ A', () => {
    const v = ask('a');
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0]).toMatchObject({ field: 'ref_method', circuit: 4, value: 'A' });
  });
  test('"it\'s a buried run, 100" ⇒ 100, never A', () => {
    const v = ask("it's a buried run, 100");
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0].value).toBe('100');
  });
  test('"reference method a buried run, 100" ⇒ 100, never A', () => {
    const v = ask('reference method a buried run, 100');
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0].value).toBe('100');
  });
  test('"method c" ⇒ C', () => {
    const v = ask('method c');
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0].value).toBe('C');
  });
  test('terminal "method a" / "reference method a" ⇒ A', () => {
    expect(ask('method a').writes[0].value).toBe('A');
    expect(ask('reference method a').writes[0].value).toBe('A');
  });
  test('bare letter B–G ⇒ that letter', () => {
    expect(ask('c').writes[0].value).toBe('C');
    expect(ask('G.').writes[0].value).toBe('G');
  });
  test('word-number "method 100" / "one hundred" ⇒ 100', () => {
    expect(ask('method 100').writes[0].value).toBe('100');
    expect(ask('one hundred').writes[0].value).toBe('100');
    expect(ask('one hundred and two').writes[0].value).toBe('102');
  });
  test('"C or D" ⇒ ask (multiple candidates, no write)', () => {
    const v = ask('C or D');
    expect(v.kind).toBe('invalid_value');
    expect(v.writes).toBeUndefined();
  });
  test('"method b, 100" ⇒ ask (letter + digit candidates)', () => {
    const v = ask('method b, 100');
    expect(v.kind).toBe('invalid_value');
  });
});

describe('§3.4 leg 4 — context gate / severity collision', () => {
  test('ref_method-only word-number logic does NOT apply to other enums', () => {
    // ocpd_type resolves "C" via the pre-existing word-anchored branch
    // (correct), but the ref_method-specific word-number map must be gated:
    // "one hundred" is not an ocpd_type option, so it does NOT auto-resolve.
    const v = ask('one hundred', 'ocpd_type');
    expect(v.kind).not.toBe('auto_resolve');
  });
  test('digit-free invariant preserved: a stray "5" on ref_method asks', () => {
    const v = ask('5');
    expect(['invalid_value', 'did_you_mean']).toContain(v.kind);
  });
});
