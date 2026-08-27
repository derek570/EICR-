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
import { POOR_SIGNAL_ADVISORY_TEXT, UPLINK_LOSS_DISCLOSURE_TEXT } from '@/lib/recording/tts';

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
  spoken_distinctness_union: string[];
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
    expect(digest).toBe('6ed9eb2a4d91ca578a1add1c5bcef304d945dc7eb279291e95c3e3fc0c130753');
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

  // PLAN-E1 E3 (Codex diff-review r1 BLOCKER fix) — the plan requires the
  // poor-signal advisory's coalescing key to be its own canonical spoken
  // string, which only matters if this fixture's live-inventory collision
  // check (src/__tests__/stage6-honest-refusal.test.js §5.12) can actually
  // see it. PLAN-E2 adds its own disclosure line to the SAME member in its
  // own PR (same contract) — this member is deliberately NOT closed to
  // future additions.
  it('spoken_distinctness_union is internally unique and contains the E1 advisory, byte-identical to its source', () => {
    const union = fixture.spoken_distinctness_union;
    expect(new Set(union).size).toBe(union.length);
    expect(union).toContain(POOR_SIGNAL_ADVISORY_TEXT);
    // PLAN-E2 — the single cause-agnostic loss disclosure, byte-identical
    // to its TS source.
    expect(union).toContain(UPLINK_LOSS_DISCLOSURE_TEXT);
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

describe('deliberate divergence — codes the iOS dropdown offers but the schema does not', () => {
  // PLAN-C decision, recorded so a future reader does not "fix" it by
  // widening the option lists on one client.
  //
  // iOS's `Constants.refMethods` picker offers the granular BS 7671
  // reference methods A1/A2/B1/B2/D1/D2, and its OCPD-type picker is a
  // superset too. `config/field_schema.json` — the CROSS-CLIENT contract
  // that the backend validator, web dropdowns and the PDF all read — does
  // NOT carry them. The guard is derived from the schema, so a dictated
  // "reference method A1" is REFUSED with a re-ask.
  //
  // That is the correct behaviour for THIS plan: it matches what the
  // backend voice path already does today (the validator rejects A1), and
  // unioning the iOS superset into the guard would make one client accept
  // a value the other cannot store or print. Widening the SCHEMA is a
  // separate, deliberate decision (backend schema + web dropdown + PDF)
  // and is queued as a follow-up for Derek — not something to smuggle in
  // through a client-side guard.
  it('ref_method A1 is refused even though the iOS picker lists it', () => {
    const outcome = canonicaliseClosedEnumValue('ref_method', 'A1');
    expect(outcome.kind).toBe('invalid_value');
    expect(fixture.options.ref_method).not.toContain('A1');
  });

  it('ocpd_type 1 is refused (a device-count digit is not a trip curve)', () => {
    expect(canonicaliseClosedEnumValue('ocpd_type', '1').kind).toBe('invalid_value');
  });

  it('the refusal is audible and restates the field, not a silent drop', () => {
    const outcome = canonicaliseClosedEnumValue('ref_method', 'A1');
    expect(outcome.kind).toBe('invalid_value');
    if (outcome.kind !== 'invalid_value') return;
    const spoken = renderClosedEnumReask('ref_method', 'invalid_value', outcome.heard, {
      kind: 'single',
      circuit: 4,
    });
    expect(spoken).toBe(
      "I heard reference method 'A1', which isn't a valid reference method — say, for example, 'reference method C for circuit 4'."
    );
  });
});
