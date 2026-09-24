/**
 * PLAN-CS (feedback-2026-09-17) — ONE source of truth for the OCPD standard
 * suggestion tiers.
 *
 * `config/ocpd-bs-suggestions.json` (PLAN-CC's manifest) is canonical for every
 * surface. The backend holds no second copy: the schema's two suggestion arrays
 * must EQUAL the manifest's tiers, and `bs-code.js` exports the manifest's own
 * arrays. Four hand-maintained lists were the root cause of the September 17
 * rejection; this test fails on any drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OCPD_STANDARD_TIER1,
  OCPD_STANDARD_TIER2,
} from '../extraction/dialogue-engine/parsers/bs-code.js';
import { CIRCUIT_FIELD_VALUE_ENUMS } from '../extraction/circuit-value-descriptors.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
const manifest = read('config/ocpd-bs-suggestions.json');
const schema = read('config/field_schema.json');
const ocpd = schema.circuit_fields.ocpd_bs_en;

describe('config/field_schema.json ocpd_bs_en — free text with manifest suggestions', () => {
  test('the field is text, not a closed select, and carries no options list', () => {
    expect(ocpd.type).toBe('text');
    expect(ocpd.options).toBeUndefined();
    expect(CIRCUIT_FIELD_VALUE_ENUMS.has('ocpd_bs_en')).toBe(false);
  });

  test('suggestions (Tier 1) and suggestions_extended (Tier 2) equal the manifest', () => {
    expect(ocpd.suggestions).toEqual(manifest.tier1);
    expect(ocpd.suggestions_extended).toEqual(manifest.tier2);
  });

  test('the parser module exports the manifest tiers, never a copy of its own', () => {
    expect([...OCPD_STANDARD_TIER1]).toEqual(manifest.tier1);
    expect([...OCPD_STANDARD_TIER2]).toEqual(manifest.tier2);
  });

  test('rcd_bs_en stays a closed select', () => {
    expect(schema.circuit_fields.rcd_bs_en.type).toBe('select');
    expect(CIRCUIT_FIELD_VALUE_ENUMS.has('rcd_bs_en')).toBe(true);
  });
});
