/**
 * PLAN-A (feedback-2026-09-17) — the EXECUTABLE pin for the handoff note's
 * per-slot validation descriptor (A-101).
 *
 * The descriptor is a code-level contract, not a derivation narrative: it must
 * report what the LIVE `validateRecordReading` chain will actually do. This
 * suite is the oracle that keeps the two from drifting, and it is what makes
 * canonical row 5's two flags ENFORCEABLE rather than advisory.
 *
 * Why the oracle feeds ONE coerced value to BOTH sides (A-112): the direct
 * dispatcher coerces IN PLACE (`stage6-dispatchers-circuit.js`
 * `input.value = coerceRecordReadingValue(...)`) and validates afterwards. An
 * earlier version coerced only the descriptor side, so `limb` on
 * `ocpd_breaking_capacity_ka` reached the descriptor as `LIM` and the
 * validator raw — and the oracle failed against correct production code.
 * Raw-input behaviour is covered by the dispatcher's own tests, not here.
 */

import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'node:module';
import {
  describeSlotValidation,
  acceptsPerDescriptor,
  PARSER_BACKED_FIELD_GATES,
  CIRCUIT_FIELD_VALUE_ENUMS,
} from '../extraction/circuit-value-descriptors.js';
import { validateRecordReading } from '../extraction/stage6-dispatch-validation.js';
import { coerceRecordReadingValue } from '../extraction/record-reading-coercion.js';

const require = createRequire(import.meta.url);
const FIELD_SCHEMA = require('../../config/field_schema.json');

const CIRCUIT_FIELDS = Object.keys(FIELD_SCHEMA.circuit_fields ?? {}).filter(
  (f) => !f.startsWith('_ui_')
);

// Blank is PLAN-C3's gate and is deliberately excluded.
const VECTORS = [
  '6',
  '66',
  '6.0',
  'LIM',
  'limb',
  '>200',
  '<0.1',
  '>5',
  'n/a',
  '∞',
  '0.35',
  '3000',
  'abc',
  'N/A',
];

// A snapshot with circuit 1 present on the default board, so the oracle
// exercises the VALUE gates with circuit existence and confidence held valid.
// `circuits` is the KEYED object the session actually builds (see
// eicr-extraction-session.js), not an array — `circuitExistsInSnapshot` tests
// `circuit in snapshot.circuits` on the main board.
function snapshotWithCircuit1() {
  return {
    circuits: { 1: {} },
    boards: [{ id: 'main', board_type: 'main' }],
    currentBoardId: 'main',
  };
}

describe('describeSlotValidation — shape invariants (canonical row 5)', () => {
  test('every non-_ui_ circuit field yields a descriptor carrying BOTH flags', () => {
    for (const field of CIRCUIT_FIELDS) {
      const d = describeSlotValidation(field);
      expect(typeof d.kind).toBe('string');
      // The two flags are REQUIRED on EVERY kind. Their ABSENCE is what
      // misleads: a model that cannot see N/A is accepted avoids writing it.
      expect(Object.prototype.hasOwnProperty.call(d, 'accepts_lim')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(d, 'accepts_na')).toBe(true);
      expect(typeof d.accepts_lim).toBe('boolean');
      expect(typeof d.accepts_na).toBe('boolean');
    }
  });

  test('enum SUPPRESSES range — no enum descriptor serializes a range or numeric_forms', () => {
    for (const field of CIRCUIT_FIELDS) {
      const d = describeSlotValidation(field);
      if (d.kind !== 'enum') continue;
      expect(d.range).toBeUndefined();
      expect(d.numeric_forms).toBeUndefined();
      expect(Array.isArray(d.allowed_values)).toBe(true);
    }
  });

  test('a text descriptor is exactly { kind, unit, accepts_lim: true, accepts_na: true }', () => {
    // Source applies NEITHER gate to a pure text field — `allowed` is
    // undefined so the enum gate falls through, and validateNumericReadingValue
    // returns { ok: true } for a field in neither numeric map — so
    // validateRecordReading returns null for ANY string, N/A and LIM included.
    // Applying no gate IS an acceptance decision, and `true` is the truthful
    // serialization.
    const d = describeSlotValidation('circuit_designation');
    expect(d.kind).toBe('text');
    expect(d.accepts_lim).toBe(true);
    expect(d.accepts_na).toBe(true);
  });

  test('the pinned per-field expectations from § Acceptance item 3', () => {
    expect(describeSlotValidation('ocpd_rating_a')).toEqual({
      kind: 'ranged_numeric',
      unit: 'A',
      range: { min: 1, max: 630 },
      numeric_forms: ['number', 'gt'],
      accepted_sentinels: [],
      accepts_lim: true,
      accepts_na: false,
    });
    expect(describeSlotValidation('rcd_operating_current_ma').range).toEqual({ min: 5, max: 1000 });
    expect(describeSlotValidation('rcd_operating_current_ma').unit).toBe('mA');
    expect(describeSlotValidation('ir_test_voltage_v').range).toEqual({ min: 100, max: 1000 });
    expect(describeSlotValidation('ir_test_voltage_v').unit).toBe('V');

    const type = describeSlotValidation('ocpd_type');
    expect(type.kind).toBe('enum');
    expect(type.allowed_values).toContain('N/A');
    expect(type.accepts_na).toBe(true);

    // Decision 9 (A-201): breaking capacity is NOT an enum. Its researched
    // list reaches the model as `suggestions`, NEVER as `allowed_values`.
    const ka = describeSlotValidation('ocpd_breaking_capacity_ka');
    expect(ka.kind).toBe('ranged_numeric');
    expect(ka.range).toEqual({ min: 1, max: 200 });
    expect(ka.numeric_forms).toEqual(['number', 'gt']);
    expect(ka.accepts_lim).toBe(true);
    expect(ka.accepts_na).toBe(false);
    expect(ka.allowed_values).toBeUndefined();
    expect(Array.isArray(ka.suggestions)).toBe(true);
    expect(CIRCUIT_FIELD_VALUE_ENUMS.has('ocpd_breaking_capacity_ka')).toBe(false);

    const ring = describeSlotValidation('ring_r1_ohm');
    expect(ring.kind).toBe('unranged_numeric');
    expect(ring.numeric_forms).toEqual(['number', 'gt', 'lt']);
    expect(ring.accepted_sentinels).toEqual(['n/a', 'na', '∞', 'inf', 'infinity']);
    expect(ring.accepted_sentinels).not.toContain('lim');

    // The one carve-out the validator makes.
    const maxZs = describeSlotValidation('ocpd_max_zs_ohm');
    expect(maxZs.numeric_forms).toEqual(['number']);
    expect(maxZs.accepted_sentinels).toEqual([]);
    expect(maxZs.accepts_na).toBe(false);
    expect(maxZs.accepts_lim).toBe(true);
  });

  test('`suggestions` is copied verbatim where the schema carries it and ABSENT elsewhere', () => {
    // A-209 — advisory metadata with a defined consumer, never an acceptance
    // constraint. This is what lets the handoff note's remaining[0] carry the
    // researched list at all.
    for (const field of CIRCUIT_FIELDS) {
      const spec = FIELD_SCHEMA.circuit_fields[field];
      const d = describeSlotValidation(field);
      if (Array.isArray(spec.suggestions)) {
        expect(d.suggestions).toEqual(spec.suggestions);
      } else {
        expect(Object.prototype.hasOwnProperty.call(d, 'suggestions')).toBe(false);
      }
    }
  });

  test('`suggestions` is IGNORED by acceptsPerDescriptor — it is not a constraint', () => {
    const d = describeSlotValidation('ocpd_breaking_capacity_ka');
    expect(d.suggestions).not.toContain('66');
    // Off the suggestion list, inside the live range → accepted.
    expect(acceptsPerDescriptor(d, '66')).toBe(true);
  });

  test('the parser_backed registry is EMPTY at this plan’s merge', () => {
    // PLAN-A owns the mechanism; a sibling owns its own entry, added in the
    // same PR as its gate. No field-specific gate exists on main today.
    expect(PARSER_BACKED_FIELD_GATES.size).toBe(0);
  });
});

describe('schema-lock', () => {
  test('every numeric dialogue slot label yields a non-empty unit', () => {
    for (const field of CIRCUIT_FIELDS) {
      const d = describeSlotValidation(field);
      if (d.kind !== 'ranged_numeric' && d.kind !== 'unranged_numeric') continue;
      expect(typeof d.unit).toBe('string');
      expect(d.unit.length).toBeGreaterThan(0);
    }
  });

  test('no circuit field carries a non-empty `options` while its `type` is not `select`', () => {
    // A-211 — this is what keeps PLAN-C2's `ocpd_type.options` deletion
    // REQUIRED after Decision 9 withdrew its original reason (A-93's re-key).
    // Green on main today: every options-bearing field is `select`. It goes RED
    // the moment `ocpd_type` becomes `text` with its `options` array still
    // present, and it is also what stops the withdrawn "non-empty options"
    // enum derivation being reintroduced silently.
    const offenders = [];
    for (const [name, spec] of Object.entries(FIELD_SCHEMA.circuit_fields ?? {})) {
      if (!spec || typeof spec !== 'object') continue;
      if (Array.isArray(spec.options) && spec.options.length > 0 && spec.type !== 'select') {
        offenders.push(`${name} (type=${spec.type})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('descriptor-vs-validator oracle (A-101 / A-112)', () => {
  test.each(CIRCUIT_FIELDS)(
    '%s: acceptsPerDescriptor agrees with validateRecordReading on every vector',
    (field) => {
      const snapshot = snapshotWithCircuit1();
      const desc = describeSlotValidation(field);
      for (const raw of VECTORS) {
        // ONE coerced value, fed to BOTH sides, mirroring the direct
        // dispatcher's order: coerce in place, then validate.
        const cv = coerceRecordReadingValue(field, raw);
        const validatorAccepts =
          validateRecordReading(
            { field, circuit: 1, value: cv, confidence: 1 },
            snapshot
          ) === null;
        const descriptorAccepts = acceptsPerDescriptor(desc, cv);
        expect({ field, raw, cv, descriptorAccepts }).toEqual({
          field,
          raw,
          cv,
          descriptorAccepts: validatorAccepts,
        });
      }
    }
  );
});
