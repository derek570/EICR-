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
// PLAN-CS — the ONE registered parser_backed predicate. `parsers/` is the
// import-closure carve-out: `bs-code.js` statically imports nothing (its two
// JSON reads go through `createRequire`), so the leaf stays a leaf.
import { ocpdStandardShapeAccepts } from './dialogue-engine/parsers/bs-code.js';
// PLAN-C2 — the OCPD type advisory's derivation. Same carve-out: `mcb-type.js`
// statically imports only `bs-code.js`, and reads its manifest via require.
import { ocpdTypeAdvisory, ocpdTypeAdvisoryText } from './dialogue-engine/parsers/mcb-type.js';

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
// This registry was EMPTY at PLAN-A's merge; PLAN-CS added the first row in
// the same PR as its gate. It is NOT a reminder: the oracle enumerates every
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
export const PARSER_BACKED_FIELD_GATES = new Map([
  // PLAN-CS (feedback-2026-09-17, CS-113) — `ocpd_bs_en` is free text
  // (Decision 4) with ONE shape rule, `ocpd_standard_shape` in
  // `validateRecordReading`. `allowed_values` is deliberately ABSENT: the
  // Tier-1 list is offered as `suggestions`, never enforced, and serialising it
  // as allowed values would tell the model the opposite of what was decided.
  [
    'ocpd_bs_en',
    Object.freeze({
      predicate: ocpdStandardShapeAccepts,
      module: 'src/extraction/dialogue-engine/parsers/bs-code.js',
      grammar_ref: 'PLAN-CS parseOcpdStandard (config/ocpd-bs-suggestions.json)',
      accepts_lim: false,
      accepts_na: true,
    }),
  ],
]);

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

// ── The advisory carrier (Decision 9) ───────────────────────────────────────
//
// PLAN-A INTRODUCES this seam; PLAN-C2 reuses it. Checked on `main` before
// writing it: `stage6-event-bundler.js` contains zero occurrences of
// `advisory`, so the carrier did not exist, and PLAN-A ships first.
//
// THE SEAM, minimal and field-agnostic so C2's reuse is a drop-in: a write may
// carry an OPTIONAL advisory sentence, composed at the read-back producer from
// POST-DISPATCH state and appended to that write's own read-back text. It is
// part of the read-back TEXT, so it shares that read-back's existing
// confirmation identity — no new dedupe token, no allowlist entry, no stored
// field and no second spoken line. This is the same shape the Plan E locality
// tail already uses in the bundler.
//
// DO NOT "helpfully" add a suggestion-bearing field to the wire/client
// dedupe-token allowlist (`WIRE_CLIENT_DEDUPE_TOKEN_FIELDS`, in
// `ios-dedupe-key.js` and mirrored on both clients). Measured-value fields
// deliberately IGNORE `dedupe_token`; adding one per field would reopen the
// id-84 correction-swallow bug fixed on 2026-07-24. The advisory needs no entry
// there because it rides the read-back text and the key is already value-aware.
//
// The DERIVATION is per field and lives with the field. PLAN-A supplied
// breaking capacity's; PLAN-C2 (Decision 6) supplies `ocpd_type`'s and the
// standard's.
//
// PLAN-C2 — the seam takes an optional CONTEXT, because the type advisory is a
// judgement about a PAIR: whether `gG` "may not be right" depends on the
// circuit's standard. `context.circuitValues` is the circuit's POST-DISPATCH
// state ({ ocpd_bs_en, ocpd_type, … }), resolved by each producer from the
// session snapshot. A producer that has no circuit state passes nothing, and
// the pair-dependent half then says nothing rather than guess (an unknown
// type is still advised: that half needs no standard).
//
// `context.typeWrittenWithStandard` tells the STANDARD's renderer that the
// same frame also reads back this circuit's `ocpd_type`, whose own read-back
// carries the advisory — so the standard stays silent and the advisory is
// heard exactly once.
//
// `context.valueUnchanged` marks a write that re-states the stored value of
// its pair member while the pair as a whole did not change: Decision 6 — the
// advisory is not repeated for the same value.
function offListAdvisory(field, value, render) {
  const spec = circuitFieldSpec(field);
  const suggestions = Array.isArray(spec?.suggestions) ? spec.suggestions : null;
  if (!suggestions || suggestions.length === 0) return null;
  const v = String(value ?? '').trim();
  if (v === '') return null;
  if (v.toLowerCase() === 'lim') return null;
  if (suggestions.includes(v)) return null;
  return render(v);
}

const ADVISORY_RENDERERS = new Map([
  [
    'ocpd_breaking_capacity_ka',
    (value) =>
      offListAdvisory(
        'ocpd_breaking_capacity_ka',
        value,
        (v) => `recorded — ${v} kA isn't a standard breaking capacity`
      ),
  ],
  [
    // PLAN-C2 — "Circuit 4, OCPD type gG, recorded — may not be right for
    // BS EN 60898" / "…, recorded — not a type I know". N/A never advises.
    'ocpd_type',
    (value, context) => {
      // Decision 6 — never repeated for the same (standard, type) pair.
      if (context?.valueUnchanged) return null;
      const text = ocpdTypeAdvisoryText({
        ocpdBsEn: context?.circuitValues?.ocpd_bs_en ?? null,
        ocpdType: value,
      });
      return text ? `recorded — ${text}` : null;
    },
  ],
  [
    // PLAN-C2 — a later STANDARD change that makes the stored type off for the
    // new standard speaks its clause on the standard's own read-back. Only
    // `incompatible` changes with the standard; an `unknown` type was already
    // advised on its own read-back and is not repeated.
    'ocpd_bs_en',
    (value, context) => {
      if (context?.typeWrittenWithStandard) return null;
      // Decision 6 — a re-stated, unchanged standard is not a change.
      if (context?.valueUnchanged) return null;
      const type = context?.circuitValues?.ocpd_type;
      if (ocpdTypeAdvisory({ ocpdBsEn: value, ocpdType: type }) !== 'incompatible') return null;
      return `type ${String(type).trim()} ${ocpdTypeAdvisoryText({ ocpdBsEn: value, ocpdType: type })}`;
    },
  ],
]);

/**
 * The advisory for one written value, or null.
 *
 * Breaking capacity: null whenever the field carries no `suggestions`, the
 * value IS on the list, or the value is a recorded non-value. `LIM` never
 * earns the advisory — it is a recorded limitation that the ranged validator
 * already accepts, not an off-list measurement.
 *
 * OCPD type / standard: see the renderers above.
 *
 * @param {string} field
 * @param {string|number|null|undefined} value — the WRITTEN value, post-coercion
 * @param {{ circuitValues?: object|null, typeWrittenWithStandard?: boolean }|null} [context]
 * @returns {string|null}
 */
export function advisoryForFieldValue(field, value, context = null) {
  const render = ADVISORY_RENDERERS.get(field);
  if (!render) return null;
  return render(value, context);
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
