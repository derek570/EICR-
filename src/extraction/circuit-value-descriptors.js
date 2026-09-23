/**
 * PLAN-A (feedback-2026-09-17, ids 140/141/143) — the per-slot validation
 * DESCRIPTOR the handoff note carries, and the value-enum maps it reads.
 *
 * WHY THIS FILE EXISTS AT ALL — it is a DEPENDENCY LEAF, and that is the
 * whole point. Decision 1's amendment (WAVE-CONTEXT.md, 2026-09-19) requires
 * the first-miss handoff note to tell the model, per remaining slot, what
 * that slot will actually accept. The engine therefore needs the enum maps
 * and the range tables. It cannot reach them the obvious way:
 *
 *   stage6-dispatch-validation.js imports stage6-tool-schemas.js, which
 *   imports ALL_DIALOGUE_SCHEMA_NAMES from dialogue-engine/index.js (which
 *   imports engine.js) and USES it at module top level. Production enters
 *   through dialogue-engine/index.js, so an engine.js import of
 *   stage6-dispatch-validation.js would evaluate stage6-tool-schemas.js
 *   while that binding is still uninitialised.
 *
 * So the CIRCUIT_FIELD_VALUE_ENUMS / BOARD_FIELD_VALUE_ENUMS builders move
 * HERE, verbatim, and stage6-dispatch-validation.js re-exports both names so
 * the speculator, the bulk dispatcher and every existing test import path are
 * unchanged. The engine's note builder imports from this leaf and NEVER from
 * stage6-dispatch-validation.js.
 *
 * STATIC IMPORTS ARE RESTRICTED TO THREE MODULES and an assertion enforces
 * it (`circuit-value-descriptors-imports.test.js`):
 *   - node:module createRequire (config/field_schema.json)
 *   - ./value-enum-validator.js (which imports only value-normalise.js)
 *   - ./value-normalise.js      (which imports nothing)
 *
 * DESCRIPTOR CONTRACT. `describeSlotValidation(field)` returns what the LIVE
 * `validateRecordReading` chain will do to a value for that field — derived,
 * never a second copy of the rules. `acceptsPerDescriptor(desc, value)` is a
 * pure predicate over that descriptor, and the oracle test asserts the two
 * agree with `validateRecordReading` for every non-`_ui_` circuit field over a
 * fixed vector set. A new range, enum or sentinel is picked up with no edit
 * here, because the descriptor owns no data.
 */

import { createRequire } from 'node:module';
import {
  CIRCUIT_FIELD_NUMERIC_RANGES,
  NUMERIC_READING_FIELDS,
  canonicaliseNumericReadingField,
} from './value-enum-validator.js';
import { STAGE6_VALUE_RULES } from './value-normalise.js';

const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

// ── The value-enum maps, MOVED VERBATIM from stage6-dispatch-validation.js ──
//
// Fix B 2026-06-02 (handoff-2026-06-02-fixes.md §B) — per-field VALUE
// enum lookup, loaded from config/field_schema.json. The schema is the
// single source of truth (already consumed by stage6-tool-schemas.js's
// CIRCUIT_FIELD_ENUM builder for the name namespace); building the
// VALUE map here means a schema edit to `options[]` propagates to the
// dispatcher with no code change.
//
// What gets a value enum: every field with `type: "select"` AND a
// non-empty `options` array. Fields with `type: "text"` are not
// constrained here (numeric ranges, BS-EN format checks, etc. are
// separate concerns and not in this validator's scope today).
//
// PLAN-A / Decision 9 (A-201): the `type === 'select'` rule is UNCHANGED.
// A-80/A-93 would have re-keyed it on "any non-empty options array" so that
// adding `options` to a text field created a dispatcher gate; both changes
// are WITHDRAWN. `suggestions` (the Decision 16 researched breaking-capacity
// list) is therefore inert to this builder BY CONSTRUCTION — no gate can grow
// back from it by accident.
//
// CRITICAL — the empty string "" is NOT auto-allowed. Some select
// fields list "" as an explicit option (rcd_type, polarity_confirmed)
// to mean "no reading yet"; others (ocpd_type, wiring_type, ref_method)
// do NOT — they don't have an "unwritten" representation. Treating ""
// as a universal escape would leak garbage writes through on every
// field that doesn't enumerate it. The validator checks membership
// strictly: input.value must appear in options[] verbatim.
export const CIRCUIT_FIELD_VALUE_ENUMS = (() => {
  const out = new Map();
  const fields = fieldSchema.circuit_fields ?? {};
  for (const [name, spec] of Object.entries(fields)) {
    if (name.startsWith('_ui_')) continue;
    if (spec?.type === 'select' && Array.isArray(spec.options)) {
      out.set(name, new Set(spec.options.map(String)));
    }
  }
  return out;
})();

/**
 * BOARD-side value enum map. Same construction as CIRCUIT_FIELD_VALUE_ENUMS
 * but spans THREE schema sections — supply_characteristics_fields,
 * board_fields, installation_details_fields — matching the union
 * `BOARD_FIELD_ENUM` builder uses in stage6-tool-schemas.js.
 *
 * Exported so the board dispatcher can apply the same enum guard pattern
 * inline (the dispatcher's existing field-NAME check is left intact;
 * this map adds the value-side check).
 */
export const BOARD_FIELD_VALUE_ENUMS = (() => {
  const out = new Map();
  for (const section of [
    'supply_characteristics_fields',
    'board_fields',
    'installation_details_fields',
  ]) {
    const fields = fieldSchema[section] ?? {};
    for (const [name, spec] of Object.entries(fields)) {
      if (name.startsWith('_ui_')) continue;
      if (spec?.type === 'select' && Array.isArray(spec.options)) {
        out.set(name, new Set(spec.options.map(String)));
      }
    }
  }
  return out;
})();

// ── parser_backed: the ONE seam a sibling adds a field-specific gate through ─
//
// `describeSlotValidation` derives `kind` from the COMPLETE live
// `validateRecordReading` chain, not from absence from the three generic maps.
// That chain is three gates today (closed enum, then the numeric gate), so the
// four generic kinds below are complete TODAY. The moment any plan adds a
// FIELD-SPECIFIC rule to `validateRecordReading` beyond those maps, a bare
// `{ kind: 'text', … }` would tell the model "any string is accepted" while
// the dispatcher rejects — so that plan registers its gate here instead and
// `describeSlotValidation` returns `kind: 'parser_backed'` for the field.
//
// OWNERSHIP (A-208): PLAN-A owns the MECHANISM — this registry, the kind,
// `acceptsPerDescriptor`'s delegation to `predicate`, and the oracle. A
// sibling owns its own ENTRY, added in the SAME PR as its gate.
//
// THIS REGISTRY IS EMPTY AT PLAN-A's MERGE, because no field-specific gate
// exists on `main` today. It is NOT a reminder: the oracle enumerates every
// non-`_ui_` circuit field against a vector set including 'abc', so a gate
// added with no registry row makes the suite go RED in the PR that adds the
// gate, naming the field. A sibling cannot land its gate without the row.
//
// Row shape: field → { predicate, module, grammar_ref, allowed_values?,
// accepts_lim, accepts_na }. `predicate(value)` is the gate's OWN predicate —
// the same function `validateRecordReading` calls — so the oracle keeps
// holding by construction rather than by a second copy of the rule. `module`
// is the predicate's repo-relative source path, and it is REQUIRED: it is the
// input the import-closure assertion walks, and a row without it cannot be
// checked at all.
//
// IMPORT SAFETY — the DURABLE property, not a snapshot (A-216/A-221/A-227).
// A registered predicate's module must have NO import path, direct OR
// TRANSITIVE, back into the dialogue engine or the validation layer. The
// NORMATIVE artefact is the executable assertion in
// `circuit-value-descriptors-imports.test.js`, which computes the transitive
// static-import closure of each registered predicate and fails if it contains
// `circuit-value-descriptors.js` itself, `stage6-dispatch-validation.js`,
// `stage6-tool-schemas.js`, or ANY module under `dialogue-engine/` other than
// `parsers/`. This comment is DESCRIPTIVE of that assertion: if the two ever
// disagree, the assertion is right. Enumerating forbidden destinations by hand
// was tried in three consecutive review rounds and was incomplete each time —
// the leaf imports every registered predicate by construction, so
// `leaf → predicate → leaf` closes a cycle while touching no named module.
export const PARSER_BACKED_FIELD_GATES = new Map();

const SENTINELS_MINUS_LIM = Object.freeze(
  STAGE6_VALUE_RULES.VALID_SENTINELS.filter((s) => s !== 'lim')
);

/** Canonical LIM, as `isWithinRange` admits it (value-enum-validator.js). */
const CANONICAL_LIM = 'LIM';

/**
 * The parenthesised suffix of a field's `label` in field_schema.json —
 * "Breaking Capacity (kA)" → "kA"; likewise (A), (mA), (V), (Mohm), (ohm),
 * (ms). `null` when the label has none.
 *
 * The schema has NO `unit` attribute (its circuit-field attribute set is
 * label, type, options, description, ai_guidance, pdf_column, group, default,
 * defaults_by_circuit), so the label is the canonical carrier.
 */
function unitFromLabel(label) {
  if (typeof label !== 'string') return null;
  const m = /\(([^()]+)\)\s*$/.exec(label.trim());
  if (!m) return null;
  const unit = m[1].trim();
  return unit === '' ? null : unit;
}

function circuitFieldSpec(field) {
  return fieldSchema.circuit_fields?.[field] ?? null;
}

/**
 * Describe what the live validator chain will accept for one circuit field.
 *
 * Mirrors `validateRecordReading`'s own gate ORDER: the closed-enum gate runs
 * first, the numeric gate second. Enum SUPPRESSES range — serializing both
 * would invite the model to write an off-list number, and a member of a closed
 * list always satisfies any range that also covers it, so the range gate can
 * never reject an accepted enum value.
 *
 * `accepts_lim` and `accepts_na` are REQUIRED on EVERY kind. On `enum`,
 * `ranged_numeric` and `unranged_numeric` neither is recoverable from
 * `accepted_sentinels`: a `ranged_numeric` descriptor carries
 * `accepts_lim: true` with `accepted_sentinels: []`, so the flag is the only
 * signal that LIM stays valid. Their ABSENCE, not their presence, is what
 * would mislead — a model that cannot see `N/A` is accepted avoids writing it,
 * which is the silent drop this wave exists to remove.
 *
 * @param {string} field — a circuit field name
 * @returns {object} the descriptor
 */
export function describeSlotValidation(field) {
  const spec = circuitFieldSpec(field);
  const unit = unitFromLabel(spec?.label);
  const suggestions = Array.isArray(spec?.suggestions) ? [...spec.suggestions] : null;
  const withSuggestions = (desc) => (suggestions ? { ...desc, suggestions } : desc);

  // parser_backed FIRST — a registered field-specific gate is authoritative
  // over the generic derivation, and BOTH flags come from that gate's own
  // predicate rather than from this function's rules (A-196).
  const gate = PARSER_BACKED_FIELD_GATES.get(field);
  if (gate) {
    return withSuggestions({
      kind: 'parser_backed',
      unit,
      grammar_ref: gate.grammar_ref,
      ...(gate.allowed_values ? { allowed_values: [...gate.allowed_values] } : {}),
      accepts_lim: gate.accepts_lim === true,
      accepts_na: gate.accepts_na === true,
    });
  }

  // Gate 1 — closed enum.
  const allowed = CIRCUIT_FIELD_VALUE_ENUMS.get(field);
  if (allowed) {
    const allowed_values = Array.from(allowed);
    return withSuggestions({
      kind: 'enum',
      unit,
      allowed_values,
      accepts_lim: allowed_values.includes(CANONICAL_LIM),
      accepts_na: allowed_values.includes('N/A'),
    });
  }

  // Gate 2 — the numeric chain, alias-normalised exactly as the validator does.
  const canonical = canonicaliseNumericReadingField(field);

  if (CIRCUIT_FIELD_NUMERIC_RANGES.has(canonical)) {
    const { min, max } = CIRCUIT_FIELD_NUMERIC_RANGES.get(canonical);
    return withSuggestions({
      kind: 'ranged_numeric',
      unit,
      range: { min, max },
      // isWithinRange's two accepted shapes: a finite number within range, or
      // ">N" with the tail within range. "<N" is NOT accepted on a ranged field.
      numeric_forms: ['number', 'gt'],
      accepted_sentinels: [],
      accepts_lim: true,
      accepts_na: false,
    });
  }

  if (NUMERIC_READING_FIELDS.has(canonical)) {
    // ocpd_max_zs_ohm is the one exception the validator carves out: a
    // COMPUTED ceiling, so only a finite numeric or canonical LIM.
    if (canonical === 'ocpd_max_zs_ohm') {
      return withSuggestions({
        kind: 'unranged_numeric',
        unit,
        numeric_forms: ['number'],
        accepted_sentinels: [],
        accepts_lim: true,
        accepts_na: false,
      });
    }
    return withSuggestions({
      kind: 'unranged_numeric',
      unit,
      numeric_forms: ['number', 'gt', 'lt'],
      accepted_sentinels: [...SENTINELS_MINUS_LIM],
      accepts_lim: true,
      accepts_na: true,
    });
  }

  // No gate applies at all. Applying NO gate IS an acceptance decision
  // (accept everything), so both flags are truthfully true:
  // validateRecordReading returns null for ANY string on a pure text field.
  return withSuggestions({
    kind: 'text',
    unit,
    accepts_lim: true,
    accepts_na: true,
  });
}

function isFiniteNumericString(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '') return false;
  return Number.isFinite(Number(t));
}

function withinRange(n, range) {
  return n >= range.min && n <= range.max;
}

/**
 * Does the descriptor accept this value? A PURE function of the descriptor —
 * the executable half of the A-101 pin. The oracle asserts this equals
 * `validateRecordReading(...) === null` for every non-`_ui_` circuit field over
 * a fixed vector set, with ONE coerced value fed to both sides.
 *
 * `suggestions` is ADVISORY METADATA and is ignored here entirely — it is
 * never an acceptance constraint.
 */
export function acceptsPerDescriptor(desc, value) {
  if (!desc) return false;

  // A registered field-specific gate answers for itself.
  if (desc.kind === 'parser_backed') {
    const gate = [...PARSER_BACKED_FIELD_GATES.values()].find(
      (g) => g.grammar_ref === desc.grammar_ref
    );
    return gate ? gate.predicate(value) === true : false;
  }

  if (desc.kind === 'enum') {
    // validateRecordReading's enum gate rejects a non-string outright, then
    // tests verbatim membership.
    if (typeof value !== 'string') return false;
    return desc.allowed_values.includes(value);
  }

  const isLim = typeof value === 'string' && value.trim().toLowerCase() === 'lim';

  if (desc.kind === 'ranged_numeric') {
    // isWithinRange rejects a non-string before anything else.
    if (typeof value !== 'string') return false;
    if (isLim) return desc.accepts_lim;
    if (value === '') return true; // blank passes the range gate (see its JSDoc)
    const sentinel = /^>\s*(\d+(?:\.\d+)?)$/.exec(value);
    const numeric = sentinel ? Number(sentinel[1]) : Number(value);
    if (!Number.isFinite(numeric)) return false;
    return withinRange(numeric, desc.range);
  }

  if (desc.kind === 'unranged_numeric') {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (v === '') return true;
    if (isLim) return desc.accepts_lim;
    if (desc.numeric_forms.length === 1) {
      // ocpd_max_zs_ohm — finite numeric only, past LIM.
      return isFiniteNumericString(v);
    }
    if (/^[<>]\s*\d+(?:\.\d+)?$/.test(v)) return true;
    if (isFiniteNumericString(v)) return true;
    return desc.accepted_sentinels.includes(v.toLowerCase());
  }

  // text — the chain gates the field nowhere, so validateRecordReading
  // returns null for ANY string.
  return typeof value === 'string' || typeof value === 'number';
}
