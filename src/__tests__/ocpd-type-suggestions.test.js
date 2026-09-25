/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — backend half of the
 * `ocpd_type` free-text contract.
 *
 * Drives every vector in `config/ocpd-type-suggestions.json` through the
 * backend twin and compares returned BYTES, exactly as the web
 * (`web/tests/ocpd-type.test.ts`) and iOS suites do. Also pins the backend
 * drift guards: the schema's `suggestions` equal the manifest's, and the
 * schema carries NO `options` for the field.
 */

import { createRequire } from 'node:module';

import {
  OCPD_TYPE_SUGGESTIONS,
  canonicaliseOcpdType,
  ocpdTypeAdvisory,
  ocpdTypeAdvisoryText,
  parseMcbType,
} from '../extraction/dialogue-engine/parsers/mcb-type.js';

const require = createRequire(import.meta.url);
const manifest = require('../../config/ocpd-type-suggestions.json');
const schema = require('../../config/field_schema.json');

describe('PLAN-C2 — ocpd_type manifest drift guards', () => {
  test('field_schema ocpd_type is text, carries the manifest suggestions and no options', () => {
    const spec = schema.circuit_fields.ocpd_type;
    expect(spec.type).toBe('text');
    expect(spec.options).toBeUndefined();
    expect(spec.suggestions).toEqual(manifest.suggestions);
    expect(spec.default).toBe('B');
    expect([...OCPD_TYPE_SUGGESTIONS]).toEqual(manifest.suggestions);
  });
});

describe('PLAN-C2 — canonicaliseOcpdType / parseMcbType, every vector', () => {
  test.each(manifest.canonicalisation_vectors.map((v) => [JSON.stringify(v.input), v]))(
    '%s',
    (_label, v) => {
      expect(canonicaliseOcpdType(v.input)).toBe(v.canonical);
      expect(parseMcbType(v.input)).toBe(v.script);
    }
  );

  test('never null for a non-blank value; numbers stringify', () => {
    expect(canonicaliseOcpdType('a-very-long-custom-type-marking')).toBe(
      'a-very-long-custom-type-marking'
    );
    expect(canonicaliseOcpdType(2)).toBe('2');
    expect(canonicaliseOcpdType(undefined)).toBeNull();
  });
});

describe('PLAN-C2 — ocpdTypeAdvisory, every vector', () => {
  test.each(
    manifest.advisory_vectors.map((v) => [
      `${JSON.stringify(v.standard)} + ${JSON.stringify(v.type)}`,
      v,
    ])
  )('%s', (_label, v) => {
    expect(ocpdTypeAdvisory({ ocpdBsEn: v.standard, ocpdType: v.type })).toBe(v.advisory);
    expect(ocpdTypeAdvisoryText({ ocpdBsEn: v.standard, ocpdType: v.type })).toBe(v.marker);
  });
});
