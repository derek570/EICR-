/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — `BLANK_WRITE_ALLOWED_FIELDS` is
 * DERIVED here and compared against the committed constant.
 *
 * WHY THE CONSTANT IS NOT JUST HAND-WRITTEN. The blank predicate rejects an
 * explicit `""` on every write boundary. For almost every field that is
 * exactly right: a blank is not a value, and the clear tools are how a value
 * is removed. But a field could exist whose blank IS a legitimate WRITTEN
 * value and which no clear tool can reach — and rejecting a blank there would
 * make it permanently unclearable by voice. That is a silent, permanent data
 * trap, and it would be created by a schema edit nobody connected to this
 * rule.
 *
 * So the membership rule is executable: a select field whose options include
 * `""`, that is routable to a client, and that neither `classifyBoardClear` /
 * `BOARD_CLEAR_SCOPE_MAP` (board fields) nor `clear_reading` (circuit fields)
 * can clear. The derivation runs against the LIVE schema and manifests on
 * every test run; a mismatch with the committed constant fails.
 *
 * Today the derived set is EMPTY, and the reason is worth stating because it
 * is not obvious: the two candidates — `board_type` and
 * `is_distribution_circuit` — are both in `STRUCTURAL_READING_FIELDS` and are
 * intercepted by the structural refusal long before the value stage, so
 * neither is reachable by the blank predicate at all.
 *
 * AN EMPTY DERIVATION IS AN ASSERTION, NOT AN ABSENCE. If a future schema
 * change produces a real member, this test says so instead of a field quietly
 * becoming unclearable in production.
 */

import { createRequire } from 'node:module';
import { BLANK_WRITE_ALLOWED_FIELDS } from '../extraction/blank-write-policy.js';
import {
  CLEAR_READING_FIELD_ENUM,
  CLEAR_BOARD_READING_FIELD_ENUM,
} from '../extraction/stage6-tool-schemas.js';
import { BOARD_CLEAR_SCOPE_MAP } from '../extraction/stage6-dispatchers-board.js';
import {
  CLIENT_ROUTABLE_READING_FIELDS,
  UNROUTABLE_READING_FIELDS,
  STRUCTURAL_READING_FIELDS,
} from '../extraction/client-routable-reading-fields.js';

const require = createRequire(import.meta.url);
const FIELD_SCHEMA = require('../../config/field_schema.json');

const clearableCircuit = new Set(CLEAR_READING_FIELD_ENUM);
const clearableBoard = new Set(CLEAR_BOARD_READING_FIELD_ENUM);

/** A select field that explicitly lists "" among its options. */
function listsEmptyOption(def) {
  return def?.type === 'select' && Array.isArray(def.options) && def.options.includes('');
}

/**
 * Can a clear tool reach this field at all? For a circuit field that is
 * `clear_reading`'s enum; for a board field it is BOTH the tool enum and
 * `classifyBoardClear`'s scope map, because a field the classifier cannot
 * place fails closed and never clears.
 */
function isClearable(field, { board }) {
  if (board) return clearableBoard.has(field) && BOARD_CLEAR_SCOPE_MAP[field] != null;
  return clearableCircuit.has(field);
}

function deriveAllowedFields(schema = FIELD_SCHEMA) {
  const derived = new Set();
  for (const [field, def] of Object.entries(schema.circuit_fields ?? {})) {
    if (!listsEmptyOption(def)) continue;
    // Not reachable by the predicate: the structural refusal runs first.
    if (STRUCTURAL_READING_FIELDS.has(field)) continue;
    if (UNROUTABLE_READING_FIELDS.has(field)) continue;
    if (!CLIENT_ROUTABLE_READING_FIELDS.has(field)) continue;
    if (isClearable(field, { board: false })) continue;
    derived.add(field);
  }
  for (const section of ['board_fields', 'supply_characteristics', 'installation_details']) {
    for (const [field, def] of Object.entries(schema[section] ?? {})) {
      if (!listsEmptyOption(def)) continue;
      if (STRUCTURAL_READING_FIELDS.has(field)) continue;
      if (UNROUTABLE_READING_FIELDS.has(field)) continue;
      if (isClearable(field, { board: true })) continue;
      derived.add(field);
    }
  }
  return derived;
}

describe('PLAN-C3 — the blank-write allowlist is derived, not asserted', () => {
  test('the committed constant equals the derivation from the live schema', () => {
    const derived = [...deriveAllowedFields()].sort();
    expect([...BLANK_WRITE_ALLOWED_FIELDS].sort()).toEqual(derived);
  });

  test('today the derivation is EMPTY, and the two candidates are structural', () => {
    // Stated explicitly so a future reader can tell "nothing qualifies" from
    // "the derivation silently stopped working".
    expect(deriveAllowedFields().size).toBe(0);
    expect(STRUCTURAL_READING_FIELDS.has('is_distribution_circuit')).toBe(true);
    expect(STRUCTURAL_READING_FIELDS.has('board_type')).toBe(true);
  });

  test('KNOWN-BAD: injecting a qualifying field into the REAL derivation produces it', () => {
    // Proves the empty result above is a finding, not a predicate that can
    // never match. The defect is injected into the CURRENT schema shape and
    // run through the SAME function the real assertion uses — not a separate
    // reimplementation, and not an older input that might take a different
    // branch.
    const injected = {
      ...FIELD_SCHEMA,
      circuit_fields: {
        ...FIELD_SCHEMA.circuit_fields,
        // Lists "", routable, and absent from `clear_reading`'s enum — the
        // exact shape that would become permanently unclearable.
        c3_synthetic_unclearable: { type: 'select', options: ['', 'A', 'B'], label: 'Synthetic' },
      },
    };
    // Routability is a separate manifest, so the injected field has to be
    // admitted there too for the derivation to reach the clearability test.
    CLIENT_ROUTABLE_READING_FIELDS.add('c3_synthetic_unclearable');
    try {
      expect([...deriveAllowedFields(injected)]).toEqual(['c3_synthetic_unclearable']);
    } finally {
      CLIENT_ROUTABLE_READING_FIELDS.delete('c3_synthetic_unclearable');
    }
    // …and with the mutation undone, the real derivation is empty again.
    expect(deriveAllowedFields().size).toBe(0);
  });

  test('a clearable select field that lists "" is correctly EXCLUDED', () => {
    // `rcd_type` lists "" and IS clearable, so it must not be in the
    // allowlist — a blank on it is rejected and the inspector is told to say
    // clear, which works. This is the case the rule exists to distinguish.
    expect(listsEmptyOption(FIELD_SCHEMA.circuit_fields?.rcd_type)).toBe(true);
    expect(isClearable('rcd_type', { board: false })).toBe(true);
    expect(BLANK_WRITE_ALLOWED_FIELDS.has('rcd_type')).toBe(false);
  });
});
