/**
 * PLAN-W1 M2 (Decision 7, 2026-09-26) — the ONE sole-value grammar shared by
 * every deterministic value parse that runs over a whole reply.
 *
 * The defect it closes is the same in every caller: a parser that takes the
 * first (or last) match ANYWHERE in the reply, run on the WHOLE reply. "Give me
 * 2 minutes" became a 2 A breaker, "0.47, not 0.7" became 0.7, "the main switch
 * is type AC but this one is A" became AC. A deterministic path may write only
 * when the WHOLE reply is one value; anything else goes to the model through the
 * caller's existing handoff. A missed shape costs one model turn; a wrong write
 * reaches a certificate.
 *
 * A reply matches when, after trimming, it is exactly (case-insensitive):
 *   1. leading `[\s,.;:]*` — absorbs spans `maskCircuitSpans` blanked;
 *   2. at most one answer particle (yes/yeah/yep/no/nope/nah/ok/okay);
 *   3. at most one copula ("it's", "that is", "the reading was", …);
 *   4. `reading` grammar only: at most one label naming the ASKED field
 *      (FIELD_NAME_ALIASES, after canonicaliseNumericReadingField), then an
 *      optional "is"/"was"/"=";
 *   5. at most one article (a/an);
 *   6. the grammar's VALUE;
 *   7. optionally the grammar's UNIT;
 *   8. trailing punctuation only.
 *
 * The lead-in set is the union of two anchored matchers already in the tree:
 * `BARE_LIM_RE` (parsers/lim-slot.js) and the ring `pendingValuePattern`
 * (schemas/ring-continuity.js).
 */

import { FIELD_NAME_ALIASES } from './stage6-pending-value.js';
import { canonicaliseNumericReadingField } from './value-enum-validator.js';
import { MEGAOHMS_VALUE_GROUP } from './dialogue-engine/parsers/megaohms.js';

const NUMBER_SRC = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
// The shared four-form LIM policy (value-enum-validator.js LIM_FORM_RE).
const LIM_SRC = String.raw`lim|limb|limp|limitation`;

// A leading "." is absorbed only when it is not the start of a leading-dot
// number (".43" is Deepgram's rendering of "point four three").
const LEAD_SRC = String.raw`^(?:[\s,;:]|\.(?!\d))*`;
const PARTICLE_SRC = String.raw`(?:(?:yes|yeah|yep|no|nope|nah|ok|okay)[,.!]?\s+)?`;
const COPULA_SRC = String.raw`(?:(?:it['’]?s|its|it\s+is|it\s+was|that['’]?s|that\s+is|the\s+(?:reading|value)\s+(?:is|was)|reading\s+is|value\s+is)\s+)?`;
const ARTICLE_SRC = String.raw`(?:an?\s+)?`;
const TRAIL_SRC = String.raw`[.!?,;:]*\s*$`;

/**
 * Unit families (W1-2). A unit token maps to exactly one family; the asked
 * field's family comes from its canonical name's suffix. Order within the
 * family list is irrelevant — every alternation below is end-anchored.
 */
const UNIT_FAMILIES = Object.freeze([
  {
    family: 'megaohm',
    suffix: '_mohm',
    src: String.raw`megs?|mega?\s*[- ]?\s*ohms?|megohms?|meg(?:a|ger)?\s*ohms?|m\s*Ω|milli\s*grams?|millies?`,
  },
  { family: 'ohm', suffix: '_ohm', src: String.raw`ohms?|Ω` },
  { family: 'millisecond', suffix: '_ms', src: String.raw`milli\s*seconds?|ms|m\s*s` },
  { family: 'milliamp', suffix: '_ma', src: String.raw`milli\s*amps?|m\s*a` },
  { family: 'kiloamp', suffix: '_ka', src: String.raw`k\s*a|kilo\s*amps?` },
  { family: 'amp', suffix: '_a', src: String.raw`amps?|a` },
  { family: 'volt', suffix: '_v', src: String.raw`volts?|v` },
]);

const UNIT_FAMILY_MATCHERS = UNIT_FAMILIES.map((f) => ({
  family: f.family,
  re: new RegExp(`^(?:${f.src})$`, 'i'),
}));

/**
 * The unit family a captured unit token belongs to, or null.
 *
 * @param {string|null} unit
 * @returns {string|null}
 */
export function unitFamilyOf(unit) {
  if (typeof unit !== 'string' || !unit.trim()) return null;
  const token = unit.trim();
  for (const m of UNIT_FAMILY_MATCHERS) {
    if (m.re.test(token)) return m.family;
  }
  return null;
}

/**
 * The unit family of a field, from its canonical name's suffix, or null when
 * the field has no family suffix (then any explicit unit is a mismatch).
 * `_mohm` is tested before `_ohm`, and `_ma`/`_ka` before `_a`.
 *
 * @param {string|null} field
 * @returns {string|null}
 */
export function fieldUnitFamily(field) {
  if (typeof field !== 'string' || !field) return null;
  const canonical = canonicaliseNumericReadingField(field);
  for (const f of UNIT_FAMILIES) {
    if (canonical.endsWith(f.suffix)) return f.family;
  }
  return null;
}

/**
 * The N/A phrases of the enum resolver, each tagged with the device it names
 * (W1-3). `any` applies to every field; a device tag applies only to fields of
 * that device (`rcd_` → rcd, `ocpd_` → ocpd, `spd_` → spd).
 */
export const NOT_APPLICABLE_PHRASES = Object.freeze([
  Object.freeze({ phrase: 'n/a', device: 'any' }),
  Object.freeze({ phrase: 'na', device: 'any' }),
  Object.freeze({ phrase: 'not applicable', device: 'any' }),
  Object.freeze({ phrase: 'none', device: 'any' }),
  Object.freeze({ phrase: 'no rcd fitted', device: 'rcd' }),
  Object.freeze({ phrase: 'no rcd', device: 'rcd' }),
  Object.freeze({ phrase: 'no ocpd', device: 'ocpd' }),
  Object.freeze({ phrase: 'no spd', device: 'spd' }),
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const phraseSrc = (p) =>
  p
    .split(/\s+/)
    .map(escapeRe)
    .join(String.raw`\s+`);

/**
 * The device an N/A phrase names (`any`, `rcd`, `ocpd`, `spd`), or null when
 * the token is not one of the phrases.
 *
 * @param {string} token
 * @returns {string|null}
 */
export function notApplicableDeviceOf(token) {
  if (typeof token !== 'string') return null;
  const norm = token.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = NOT_APPLICABLE_PHRASES.find((p) => p.phrase === norm);
  return hit ? hit.device : null;
}

/**
 * The device a field belongs to, from its prefix, or null.
 *
 * @param {string} field
 * @returns {'rcd'|'ocpd'|'spd'|null}
 */
export function fieldDevice(field) {
  if (typeof field !== 'string') return null;
  if (field.startsWith('rcd_')) return 'rcd';
  if (field.startsWith('ocpd_')) return 'ocpd';
  if (field.startsWith('spd_')) return 'spd';
  return null;
}

const ALL_UNITS_SRC = UNIT_FAMILIES.map((f) => f.src).join('|');

/**
 * One entry per grammar. `value` is the VALUE alternation, `unit` the optional
 * UNIT alternation (null when the grammar takes no unit), `valuePrefix` a
 * non-captured prefix before the value (bsCode's "BS EN"), `labelled` whether
 * the asked-field label lead-in applies.
 */
export const SOLE_VALUE_GRAMMARS = Object.freeze({
  number: Object.freeze({ name: 'number', value: NUMBER_SRC, unit: null }),
  reading: Object.freeze({
    name: 'reading',
    value: `${NUMBER_SRC}|${LIM_SRC}|infinite|infinity|open(?:\\s+circuit|\\s+ring)?|discontinuous|disconnected|overload|over\\s+load|ol`,
    unit: ALL_UNITS_SRC,
    labelled: true,
  }),
  amps: Object.freeze({
    name: 'amps',
    value: String.raw`\d{1,4}|${LIM_SRC}`,
    unit: String.raw`a|amps?`,
  }),
  kiloamps: Object.freeze({
    name: 'kiloamps',
    value: String.raw`\d+(?:\.\d+)?|${LIM_SRC}`,
    unit: String.raw`k\s*a|kilo\s*amps?`,
  }),
  milliamps: Object.freeze({
    name: 'milliamps',
    value: String.raw`\d{1,4}|${LIM_SRC}`,
    unit: String.raw`m\s*a|milli\s*amps?`,
  }),
  ohms: Object.freeze({
    name: 'ohms',
    value: `${NUMBER_SRC}|${LIM_SRC}|infinite|infinity|open(?:\\s+circuit|\\s+ring)?|discontinuous`,
    unit: String.raw`ohms?|Ω`,
  }),
  megaohms: Object.freeze({
    name: 'megaohms',
    value: MEGAOHMS_VALUE_GROUP,
    unit: String.raw`m(?:ega)?\s*[- ]?\s*ohms?|mΩ|milli\s*grams?|millies?|megs?|meg(?:a|ger)?\s*ohms?|megohms?`,
  }),
  rcdType: Object.freeze({
    name: 'rcdType',
    value: String.raw`(?:type\s*)?(?:ac|a|f|b|s)|selective|not\s+applicable|n\s*\/?\s*a`,
    unit: null,
  }),
  bsCode: Object.freeze({
    name: 'bsCode',
    valuePrefix: String.raw`(?:bs\s*(?:en\s*)?)?`,
    value: String.raw`\d[\d-]*\d|\d+`,
    unit: null,
  }),
  notApplicable: Object.freeze({
    name: 'notApplicable',
    value: NOT_APPLICABLE_PHRASES.map((p) => phraseSrc(p.phrase)).join('|'),
    unit: null,
  }),
});

/**
 * The label lead-in for an asked field: every FIELD_NAME_ALIASES key that maps
 * to the field (after canonicalisation), longest first. Empty when none does.
 */
function labelSrcFor(contextField) {
  if (typeof contextField !== 'string' || !contextField) return '';
  const canonical = canonicaliseNumericReadingField(contextField);
  const keys = [];
  for (const [label, field] of FIELD_NAME_ALIASES) {
    if (canonicaliseNumericReadingField(field) === canonical) keys.push(label);
  }
  if (keys.length === 0) return '';
  keys.sort((a, b) => b.length - a.length);
  return `(?:(?:${keys.map(phraseSrc).join('|')})(?:\\s+(?:is|was)\\s+|\\s*=\\s*|\\s+))?`;
}

const compiled = new Map();

function compile(grammar, contextField) {
  const label = grammar.labelled ? labelSrcFor(contextField) : '';
  const key = `${grammar.name}\u0000${label}`;
  let re = compiled.get(key);
  if (!re) {
    const unit = grammar.unit ? `(?:\\s*(?<unit>${grammar.unit}))?` : '';
    re = new RegExp(
      `${LEAD_SRC}${PARTICLE_SRC}${COPULA_SRC}${label}${ARTICLE_SRC}${grammar.valuePrefix ?? ''}(?<value>${grammar.value})${unit}${TRAIL_SRC}`,
      'i'
    );
    compiled.set(key, re);
  }
  return re;
}

/**
 * Match a WHOLE reply against one sole-value grammar.
 *
 * @param {string} reply
 * @param {object} grammar — one of SOLE_VALUE_GRAMMARS
 * @param {{contextField?: string|null}} [options] — `reading` only: the asked
 *   field, which gates the label lead-in ("Zs is 0.47" only for Zs).
 * @returns {{value: string, unit: string|null}|null}
 */
export function matchSoleValueReply(reply, grammar, options = {}) {
  if (typeof reply !== 'string' || !grammar || typeof grammar.value !== 'string') return null;
  const text = reply.trim();
  if (!text) return null;
  const m = compile(grammar, options?.contextField ?? null).exec(text);
  if (!m) return null;
  const value = m.groups.value.trim();
  if (!value) return null;
  const unit = m.groups.unit ? m.groups.unit.trim() : null;
  return { value, unit: unit || null };
}
