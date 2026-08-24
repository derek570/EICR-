/**
 * PLAN-C (feedback id 129) — web half of the closed-enum guard contract.
 *
 * The fixture `config/closed-enum-vectors.json` is the CROSS-PLATFORM
 * contract: this file reads the canonical copy directly (repo-relative, so
 * there is exactly ONE fixture — a packages-path twin would drift), and the
 * iOS XCTest asserts the SAME pinned SHA-256 over its byte-identical copy.
 * `scripts/check-closed-enum-fixture-sync.sh` byte-compares the two as a
 * named pre-TestFlight step, closing the "both sides edited together" hole
 * paired constants cannot see.
 *
 * The fixture's `options` are re-derived from `config/field_schema.json`
 * here as well, so the guard vocabulary provably tracks the schema (PLAN-C
 * C2b: the SCHEMA is the vocabulary, NOT either client's UI picker list).
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  CLOSED_ENUM_LABELS,
  CLOSED_ENUM_OPTIONS,
  GUARDED_CLOSED_ENUM_FIELDS,
  WIRING_TYPE_DESCRIPTION_TO_CODE,
  canonicaliseClosedEnumValue,
  isGuardedClosedEnumField,
  renderClosedEnumReask,
  type ClosedEnumReaskReason,
  type GuardedClosedEnumField,
  type GuardedTarget,
} from '@certmate/shared-utils';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'closed-enum-vectors.json');

type Fixture = {
  guarded_fields: GuardedClosedEnumField[];
  options: Record<GuardedClosedEnumField, string[]>;
  labels: Record<GuardedClosedEnumField, string>;
  wiring_type_description_to_code: Record<string, string>;
  accepted_value_vectors: Array<{ field: GuardedClosedEnumField; input: string; expected: string }>;
  rejected_value_vectors: Array<{
    field: GuardedClosedEnumField;
    input: string;
    reason: 'invalid_value' | 'missing_value';
  }>;
  reask_render_vectors: Array<{
    field: GuardedClosedEnumField;
    reason: ClosedEnumReaskReason;
    heard: string;
    target: GuardedTarget;
    expected: string;
  }>;
};

const fixture = require('../../config/closed-enum-vectors.json') as Fixture;
const schema = require('../../config/field_schema.json') as {
  circuit_fields: Record<string, { options?: string[] }>;
};

describe('closed-enum fixture — cross-platform pins', () => {
  /** PLAN-C cross-repo contract pin. The iOS repo carries a byte-identical
   *  COPY whose XCTest asserts the SAME hex constant; changing either file
   *  alone fails one side. When the vectors legitimately change: edit the
   *  fixture, `shasum -a 256 config/closed-enum-vectors.json`, and update
   *  BOTH constants in the same coordinated change. */
  it('fixture bytes match the pinned cross-platform digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(digest).toBe('13f1710acb79a7ac4a11700230712f5068da165b9b0bd4eaae5da3b17f5827ba');
  });

  it('fixture options are exactly field_schema.json minus the empty sentinel', () => {
    for (const field of fixture.guarded_fields) {
      const fromSchema = (schema.circuit_fields[field].options ?? []).filter((o) => o !== '');
      expect(fixture.options[field]).toEqual(fromSchema);
    }
  });

  it('the guard module tracks the fixture (options, labels, wiring map, guarded set)', () => {
    expect([...GUARDED_CLOSED_ENUM_FIELDS].sort()).toEqual([...fixture.guarded_fields].sort());
    for (const field of fixture.guarded_fields) {
      expect(CLOSED_ENUM_OPTIONS[field]).toEqual(fixture.options[field]);
      expect(CLOSED_ENUM_LABELS[field]).toBe(fixture.labels[field]);
    }
    expect({ ...WIRING_TYPE_DESCRIPTION_TO_CODE }).toEqual(fixture.wiring_type_description_to_code);
  });

  it('every wiring-description target is itself a schema option', () => {
    for (const code of Object.values(fixture.wiring_type_description_to_code)) {
      expect(fixture.options.wiring_type).toContain(code);
    }
  });

  it('the four boolean/confirmable selects are NOT guarded', () => {
    for (const field of [
      'polarity_confirmed',
      'rcd_button_confirmed',
      'afdd_button_confirmed',
      'is_distribution_circuit',
    ]) {
      expect(isGuardedClosedEnumField(field)).toBe(false);
    }
  });
});

describe('canonicaliseClosedEnumValue — accepted vectors', () => {
  for (const { field, input, expected } of fixture.accepted_value_vectors) {
    it(`${field} ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const outcome = canonicaliseClosedEnumValue(field, input);
      expect(outcome).toEqual({ kind: 'valid', field, value: expected });
      // Every accepted canonical value must be a genuine schema option.
      expect(fixture.options[field]).toContain(expected);
    });
  }
});

describe('canonicaliseClosedEnumValue — rejected vectors', () => {
  for (const { field, input, reason } of fixture.rejected_value_vectors) {
    it(`${field} ${JSON.stringify(input)} → ${reason}`, () => {
      const outcome = canonicaliseClosedEnumValue(field, input);
      expect(outcome.kind).toBe(reason);
    });
  }

  it('never snaps a near-miss BS code onto a neighbouring standard (Lev-1 NOT ported)', () => {
    // The backend's fuzzy fallback maps 1362 → BS 1361 and 6898 → BS EN
    // 60898. On a client that writes straight into the certificate, a
    // silently-substituted DEVICE STANDARD is the failure this plan exists
    // to prevent.
    for (const near of ['1362', '6898', '6100', '60899', '3037']) {
      expect(canonicaliseClosedEnumValue('ocpd_bs_en', near).kind).toBe('invalid_value');
    }
  });

  it('non-string values: finite numbers are echoed, structural non-values are missing', () => {
    expect(canonicaliseClosedEnumValue('ocpd_type', 1)).toEqual({
      kind: 'invalid_value',
      field: 'ocpd_type',
      heard: '1',
    });
    for (const v of [true, false, null, undefined, {}, [], NaN]) {
      expect(canonicaliseClosedEnumValue('wiring_type', v).kind).toBe('missing_value');
    }
  });

  it('unknown / unguarded fields are passed through untouched', () => {
    expect(canonicaliseClosedEnumValue('measured_zs_ohm', '0.42')).toEqual({
      kind: 'unknown_field',
    });
    expect(canonicaliseClosedEnumValue('polarity_confirmed', 'PASS')).toEqual({
      kind: 'unknown_field',
    });
  });

  it('edge punctuation is stripped but internal / - + & survive', () => {
    expect(canonicaliseClosedEnumValue('rcd_type', ' "b+". ')).toEqual({
      kind: 'valid',
      field: 'rcd_type',
      value: 'B+',
    });
    expect(canonicaliseClosedEnumValue('rcd_type', 'a-s,')).toEqual({
      kind: 'valid',
      field: 'rcd_type',
      value: 'A-S',
    });
    expect(canonicaliseClosedEnumValue('wiring_type', "'t&e'")).toEqual({
      kind: 'valid',
      field: 'wiring_type',
      value: 'A',
    });
  });
});

describe('renderClosedEnumReask — frozen render vectors', () => {
  for (const { field, reason, heard, target, expected } of fixture.reask_render_vectors) {
    it(`${field}/${reason}/${target.kind}`, () => {
      expect(renderClosedEnumReask(field, reason, heard, target)).toBe(expected);
    });
  }

  it('every rendered re-ask is mutually full-string distinct', () => {
    const texts = fixture.reask_render_vectors.map((v) => v.expected);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('re-asks name the field, echo the value, and carry a complete restatement example', () => {
    const invalid = renderClosedEnumReask('wiring_type', 'invalid_value', 'FOR', {
      kind: 'single',
      circuit: 3,
    });
    expect(invalid).toBe(
      "I heard wiring type 'FOR', which isn't a valid code — say, for example, 'wiring type A for circuit 3'."
    );
  });

  it('spare policy is echoed on bulk targets so the restatement is complete', () => {
    expect(
      renderClosedEnumReask('ocpd_type', 'invalid_value', 'MCB', {
        kind: 'all',
        sparePolicy: 'include',
      })
    ).toContain("for all circuits, including spares'");
    expect(
      renderClosedEnumReask('ocpd_type', 'invalid_value', 'MCB', {
        kind: 'range',
        from: 3,
        to: 5,
        sparePolicy: 'exclude',
      })
    ).toContain("for circuits 3 to 5, excluding spares'");
    // `automatic` is the default resolution, not a spoken qualifier.
    expect(
      renderClosedEnumReask('ocpd_type', 'invalid_value', 'MCB', {
        kind: 'all',
        sparePolicy: 'automatic',
      })
    ).toContain("for all circuits'");
  });
});
