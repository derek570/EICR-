/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — web half of the
 * `ocpd_type` free-text contract.
 *
 * `config/ocpd-type-suggestions.json` is the NORMATIVE source. This file reads
 * it directly and drives every vector through the shared TS twin, comparing
 * returned BYTES. The backend twin (`mcb-type.js`) and the Swift twin
 * (`OcpdType.swift`) are driven through the same vectors in their own suites;
 * `scripts/check-ocpd-type-fixture-sync.sh` proves the iOS copy is the same
 * file. The digest below is pinned by the iOS XCTest too.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  OCPD_TYPE_INPUT_CAP,
  OCPD_TYPE_SUGGESTIONS,
  admitOcpdTypeForScript,
  buildOcpdTypeBulkResponse,
  buildOcpdTypeDuplicateResponse,
  buildOcpdTypeSingleResponse,
  canonicaliseOcpdType,
  ocpdTypeAdvisory,
  ocpdTypeAdvisoryText,
  ocpdTypeCompatibilityTable,
  ocpdTypeDisplay,
  ocpdTypesCanonicallyEqual,
} from '@certmate/shared-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'ocpd-type-suggestions.json');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'field_schema.json');

type Row = { circuit: number; ocpd_bs_en: string; ocpd_type: string };
type Manifest = {
  cap: number;
  suggestions: string[];
  compatibility: Array<{ standards: string[]; types: string[] }>;
  display_aliases: Array<{ standard: string; stored: string; display: string }>;
  advisory_phrases: { unknown: string; incompatible: string };
  canonicalisation_vectors: Array<{ input: string; canonical: string; script: string | null }>;
  advisory_vectors: Array<{
    standard: string;
    type: string;
    advisory: 'unknown' | 'incompatible' | null;
    marker: string | null;
  }>;
  display_vectors: Array<{ standard: string; type: string; display: string }>;
  single_apply_vectors: Array<{
    ocpd_bs_en: string;
    stored: string;
    candidate: string;
    written: boolean;
    response: string;
  }>;
  bulk_apply_vectors: Array<{
    case: string;
    candidate: string;
    rows: Row[];
    written: number[];
    response: string;
  }>;
};

const bytes = readFileSync(FIXTURE_PATH);
const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;

/** Pinned on BOTH clients: the iOS suite asserts the same hex over its copy. */
export const OCPD_TYPE_SUGGESTIONS_SHA256 = createHash('sha256').update(bytes).digest('hex');

describe('PLAN-C2 ocpd_type manifest', () => {
  it('the TS suggestion list and cap are the manifest', () => {
    expect([...OCPD_TYPE_SUGGESTIONS]).toEqual(manifest.suggestions);
    expect(OCPD_TYPE_INPUT_CAP).toBe(manifest.cap);
  });

  it('the TS compatibility table is the manifest rows expanded', () => {
    const expected: Record<string, string[]> = {};
    for (const row of manifest.compatibility) {
      for (const s of row.standards) expected[s] = row.types;
    }
    const actual = Object.fromEntries(
      Object.entries(ocpdTypeCompatibilityTable()).map(([k, v]) => [k, [...v]])
    );
    expect(actual).toEqual(expected);
  });

  it('field_schema.json carries the suggestion list, type text and NO options', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const spec = schema.circuit_fields.ocpd_type;
    expect(spec.type).toBe('text');
    expect(spec.options).toBeUndefined();
    expect(spec.suggestions).toEqual(manifest.suggestions);
    expect(spec.default).toBe('B');
  });
});

describe('canonicaliseOcpdType / admitOcpdTypeForScript — every vector, bytes', () => {
  for (const v of manifest.canonicalisation_vectors) {
    it(`${JSON.stringify(v.input)} → ${JSON.stringify(v.canonical)} / script ${JSON.stringify(v.script)}`, () => {
      expect(canonicaliseOcpdType(v.input)).toBe(v.canonical);
      expect(admitOcpdTypeForScript(v.input)).toBe(v.script);
    });
  }

  it('never returns null for a non-blank value, at any length', () => {
    const long = 'extraordinarily-long-custom-type-marking-seen-on-a-device';
    expect(canonicaliseOcpdType(long)).toBe(long);
    expect(canonicaliseOcpdType(2)).toBe('2');
    expect(canonicaliseOcpdType(null)).toBeNull();
  });
});

describe('ocpdTypeAdvisory — every vector', () => {
  for (const v of manifest.advisory_vectors) {
    it(`${JSON.stringify(v.standard)} + ${JSON.stringify(v.type)} → ${v.advisory}`, () => {
      expect(ocpdTypeAdvisory({ ocpdBsEn: v.standard, ocpdType: v.type })).toBe(v.advisory);
      expect(ocpdTypeAdvisoryText({ ocpdBsEn: v.standard, ocpdType: v.type })).toBe(v.marker);
    });
  }
});

describe('ocpdTypeDisplay — the BS 1361 alias, display only', () => {
  for (const v of manifest.display_vectors) {
    it(`${JSON.stringify(v.standard)} + ${JSON.stringify(v.type)} displays ${JSON.stringify(v.display)}`, () => {
      expect(ocpdTypeDisplay(v.standard, v.type)).toBe(v.display);
    });
  }
});

describe('local-command sentences — every vector, bytes', () => {
  for (const v of manifest.single_apply_vectors) {
    it(`single: ${v.stored || '(blank)'} ← ${v.candidate} on ${v.ocpd_bs_en}`, () => {
      const canonical = canonicaliseOcpdType(v.candidate) as string;
      const identical = ocpdTypesCanonicallyEqual(v.candidate, v.stored);
      expect(!identical).toBe(v.written);
      const response = identical
        ? buildOcpdTypeDuplicateResponse(canonical, 4)
        : buildOcpdTypeSingleResponse(canonical, 4, v.ocpd_bs_en);
      expect(response).toBe(v.response);
    });
  }

  for (const v of manifest.bulk_apply_vectors) {
    it(`bulk ${v.case}`, () => {
      const canonical = canonicaliseOcpdType(v.candidate) as string;
      const written = v.rows.filter((r) => !ocpdTypesCanonicallyEqual(v.candidate, r.ocpd_type));
      const unchanged = v.rows.filter((r) => ocpdTypesCanonicallyEqual(v.candidate, r.ocpd_type));
      expect(written.map((r) => r.circuit)).toEqual(v.written);
      const response = buildOcpdTypeBulkResponse({
        type: canonical,
        written: written.map((r) => ({ circuit: r.circuit, ocpdBsEn: r.ocpd_bs_en })),
        unchanged: unchanged.map((r) => r.circuit),
      });
      expect(response).toBe(v.response);
    });
  }
});
