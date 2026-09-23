/**
 * PLAN-C (feedback id 129, 2026-08-23) — client-local closed-enum guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * Field session 17821FFA: the inspector said "Wiring type for all circuits
 * is A…", Flux garbled it, iOS's LOCAL ApplyFieldIntent took the first
 * remainder word, uppercased it, and `Constants.normaliseWiringType` fell
 * through OPEN (`return map[trimmed] ?? trimmed`) — so `wiring_type = "FOR"`
 * was written to two circuits and read back aloud as though it were a real
 * code. The backend has enforced closed-list membership since Stage-6
 * (`stage6-dispatch-validation.js`), but the two CLIENT local-intent paths
 * mirror the write WITHOUT that check. This module is the missing mirror.
 *
 * CONTRACT
 * --------
 * Validate-or-ask. A structurally complete but NON-MEMBER value is exactly
 * the Audio-First §2 sanctioned ask case ("invalid/out-of-range values"), so
 * the guard NEVER silently writes and NEVER silently drops: it returns a
 * typed outcome and the caller either applies the canonical value or speaks
 * a complete-restatement re-ask.
 *
 * The guard VOCABULARY is `config/field_schema.json` (PLAN-C C2b) — NOT
 * either client's UI picker list. iOS `Constants.ocpdTypes` carries MCCB
 * curves 1/2/3/K/Z, `Constants.refMethods` carries A1/A2/B1/B2/D1/D2, iOS
 * `ocpdBsEnOptions` carries BS 88-2 / 88-3 / 1362 / EN 62423, and web's
 * `CIRCUIT_FIELD_OPTIONS.rcd_type` is MISSING A-S / B-S / B+. Those are
 * documented divergences of the dropdown lists; the guard follows the
 * schema so both clients accept exactly what the backend accepts.
 *
 * DELIBERATELY NOT PORTED: the backend BS-code parser's Levenshtein-1 fuzzy
 * fallback (`bs-code.js` `fuzzyMatchBsCode`). It collapses "1362" (13 A
 * plug-top fuse) onto "BS 1361" (domestic cartridge fuse) — a DIFFERENT
 * device silently written into a legally-significant certificate. On the
 * client, an unrecognised code re-asks instead. This makes the client
 * STRICTER than the backend by exactly that one fallback, and more LENIENT
 * on `wiring_type` by exactly the curated description map below.
 *
 * PLAN-CC (2026-09-23) REMOVED `ocpd_bs_en` from the guarded set: the field
 * is free text on both clients now, because the printed standard on a real
 * device is routinely outside the schema's eight options. It keeps its re-ask
 * row here (`ClosedEnumReaskField`) so a canonicalisation miss still speaks the
 * same sentence it always did. `rcd_bs_en` is unchanged and still guarded.
 *
 * `CLOSED_ENUM_OPTIONS` and the mapping tables are pinned against
 * `config/closed-enum-vectors.json` (the cross-platform fixture) by a drift
 * test on each client, and the fixture's `options` are in turn re-derived
 * from `config/field_schema.json` in CI. Do not hand-edit either half alone.
 */

export type GuardedClosedEnumField =
  | 'wiring_type'
  | 'ref_method'
  | 'ocpd_type'
  | 'rcd_bs_en'
  | 'rcd_type';

/** Fields the RE-ASK renderer can speak for. A superset of the guarded set by
 *  exactly one member: PLAN-CC made `ocpd_bs_en` free text, so it is no longer
 *  membership-validated here — but a canonicalisation MISS still re-asks, and
 *  it must re-ask in the SAME words it always has. Keeping the field's label,
 *  noun and example row here means the two paths share one renderer and the
 *  spoken copy cannot drift apart. */
export type ClosedEnumReaskField = GuardedClosedEnumField | 'ocpd_bs_en';

/** Guarded set — exactly the six STRING-enum circuit fields. The four
 *  boolean/confirmable selects (`polarity_confirmed`, `rcd_button_confirmed`,
 *  `afdd_button_confirmed`, `is_distribution_circuit`) keep their existing
 *  PASS/FAIL → sigil normalisation and are NEVER string-membership-validated
 *  here — validating them would reject "pass". */
export const GUARDED_CLOSED_ENUM_FIELDS: ReadonlySet<string> = new Set<string>([
  'wiring_type',
  'ref_method',
  'ocpd_type',
  'rcd_bs_en',
  'rcd_type',
]);

/** Schema option sets with the empty-string sentinel stripped (an empty
 *  option is a "clear the cell" UI affordance, never a dictatable value). */
export const CLOSED_ENUM_OPTIONS: Readonly<Record<GuardedClosedEnumField, readonly string[]>> =
  Object.freeze({
    wiring_type: Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'O']),
    ref_method: Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', '100', '101', '102', '103']),
    ocpd_type: Object.freeze(['B', 'C', 'D', 'gG', 'gM', 'aM', 'HRC', 'Rew', 'N/A']),
    rcd_bs_en: Object.freeze(['BS EN 61008', 'BS EN 61009', 'BS EN 62423', 'N/A']),
    rcd_type: Object.freeze(['AC', 'A', 'F', 'B', 'S', 'A-S', 'B-S', 'B+', 'N/A']),
  }) as Readonly<Record<GuardedClosedEnumField, readonly string[]>>;

/** Spoken field labels — byte-identical to `voice-commands.ts` `labelForField`
 *  for these six keys so a re-ask and a success confirmation name the field
 *  the same way. */
export const CLOSED_ENUM_LABELS: Readonly<Record<ClosedEnumReaskField, string>> = Object.freeze({
  wiring_type: 'wiring type',
  ref_method: 'reference method',
  ocpd_bs_en: 'OCPD BS EN',
  ocpd_type: 'OCPD type',
  rcd_bs_en: 'RCD BS EN',
  rcd_type: 'RCD type',
});

/** The noun used in "…which isn't a valid <noun>". Per-field so the sentence
 *  reads naturally over TTS. */
const CLOSED_ENUM_NOUNS: Readonly<Record<ClosedEnumReaskField, string>> = Object.freeze({
  wiring_type: 'code',
  ref_method: 'reference method',
  ocpd_bs_en: 'standard',
  ocpd_type: 'option',
  rcd_bs_en: 'standard',
  rcd_type: 'option',
});

/** The illustrative field+value fragment of the re-ask example. Uses the
 *  spoken ALIASES the parser actually accepts ("OCPD standard" is a real
 *  `CIRCUIT_FIELD_ALIASES` key) so the example the inspector hears is one
 *  the client can genuinely parse back. */
const CLOSED_ENUM_EXAMPLE_PHRASES: Readonly<Record<ClosedEnumReaskField, string>> = Object.freeze({
  wiring_type: 'wiring type A',
  ref_method: 'reference method C',
  ocpd_bs_en: 'OCPD standard BS EN 60898',
  ocpd_type: 'OCPD type B',
  rcd_bs_en: 'RCD standard BS EN 61008',
  rcd_type: 'RCD type AC',
});

/** Curated spoken-description → wiring-code map, ported VERBATIM from iOS
 *  `Constants.wiringTypeDescriptionToCode`. Exact-match only (uppercased
 *  key) — no fuzzy snapping, so "twin and earth cable" re-asks rather than
 *  guessing "A". This map is the ONE place the client is deliberately more
 *  lenient than the backend. */
export const WIRING_TYPE_DESCRIPTION_TO_CODE: Readonly<Record<string, string>> = Object.freeze({
  'TWIN & EARTH': 'A',
  'TWIN AND EARTH': 'A',
  'T&E': 'A',
  'T+E': 'A',
  SHEATHED: 'A',
  'PVC SHEATHED': 'A',
  'FLAT TWIN': 'A',
  'FLAT T&E': 'A',
  'PVC/PVC': 'A',
  'PVC-PVC': 'A',
  'XLPE T&E': 'A',
  'XLPE/PVC T&E': 'A',
  'METALLIC CONDUIT': 'B',
  'METAL CONDUIT': 'B',
  'STEEL CONDUIT': 'B',
  'PVC IN METALLIC CONDUIT': 'B',
  'PVC IN METAL CONDUIT': 'B',
  'NON-METALLIC CONDUIT': 'C',
  'NON METALLIC CONDUIT': 'C',
  'PLASTIC CONDUIT': 'C',
  'PVC CONDUIT': 'C',
  'PVC IN NON-METALLIC CONDUIT': 'C',
  'PVC IN PLASTIC CONDUIT': 'C',
  CONDUIT: 'C',
  'IN CONDUIT': 'C',
  'SINGLE IN CONDUIT': 'C',
  'METALLIC TRUNKING': 'D',
  'METAL TRUNKING': 'D',
  'STEEL TRUNKING': 'D',
  'PVC IN METALLIC TRUNKING': 'D',
  'PVC IN METAL TRUNKING': 'D',
  'NON-METALLIC TRUNKING': 'E',
  'NON METALLIC TRUNKING': 'E',
  'PLASTIC TRUNKING': 'E',
  'PVC TRUNKING': 'E',
  'PVC IN NON-METALLIC TRUNKING': 'E',
  'PVC IN PLASTIC TRUNKING': 'E',
  TRUNKING: 'E',
  'IN TRUNKING': 'E',
  'SINGLE IN TRUNKING': 'E',
  SWA: 'F',
  ARMOURED: 'F',
  'STEEL WIRE ARMOUR': 'F',
  'PVC SWA': 'F',
  'PVC/SWA': 'F',
  'PVC-SWA': 'F',
  'XLPE SWA': 'G',
  'XLPE/SWA': 'G',
  'XLPE-SWA': 'G',
  'XLPE ARMOURED': 'G',
  XLPE: 'G',
  MICC: 'H',
  MINERAL: 'H',
  'MINERAL INSULATED': 'H',
  MIMS: 'H',
  PYRO: 'H',
  PYROTENAX: 'H',
  FP200: 'O',
  'FP 200': 'O',
  'FIRE RATED': 'O',
  'FIRE-RATED': 'O',
  FLEX: 'O',
  FLEXIBLE: 'O',
  'FLEXIBLE CORD': 'O',
  SY: 'O',
  YY: 'O',
  CY: 'O',
  OTHER: 'O',
});

// ─────────────────────────────────────────────────────────────────────────
// Residue cleaning
// ─────────────────────────────────────────────────────────────────────────

/** Sentence punctuation + quote characters stripped at the residue EDGES
 *  only. Internal `/`, `-`, `+` and `&` are preserved so "N/A", "A-S", "B+"
 *  and "T&E" survive intact — the exact characters a naive `replace(/\W/g)`
 *  would have eaten. Identical rule on both clients (PLAN-C round-7). */
const EDGE_PUNCTUATION = /^[\s"'“”‘’.,!?;:]+|[\s"'“”‘’.,!?;:]+$/g;

export function cleanClosedEnumResidue(raw: string): string {
  return raw.replace(EDGE_PUNCTUATION, '');
}

// ─────────────────────────────────────────────────────────────────────────
// BS/EN code alias parser — DETERMINISTIC branch of `parseBsCode` only.
// ─────────────────────────────────────────────────────────────────────────

/** Flux artefacts that survive NumberNormaliser: letter-split "a b s e n"
 *  and zero-words inside a digit run ("6 zero 8 9 8"). Ported from
 *  `src/extraction/dialogue-engine/parsers/bs-code.js` `normaliseBsInput`. */
function normaliseBsInput(text: string): string {
  let out = text.replace(/\ba\.?\s+b\.?\s+s\.?(?:\s+e\.?\s+n\.?)?(?![a-z])/gi, (m) =>
    m.toLowerCase().includes('e') ? 'BS EN' : 'BS'
  );
  out = out.replace(/\b\d+(?:\s+(?:\d+|zero|oh|nought|naught))+\b/gi, (m) =>
    m
      .split(/\s+/)
      .map((tok) => {
        const lower = tok.toLowerCase();
        return lower === 'zero' || lower === 'oh' || lower === 'nought' || lower === 'naught'
          ? '0'
          : tok;
      })
      .join('')
  );
  return out;
}

/** ANCHORED patterns — the whole residue must be consumed. The backend uses
 *  unanchored `text.match` because it scans a free-form sentence; here the
 *  residue is already the isolated value, so an unanchored match would
 *  silently swallow trailing words ("88-2 for circuit" → "BS EN 60269-2",
 *  losing the fact that the utterance was malformed).
 *
 *  The optional `-1` tails on 60898/61008/61009 are the printed sub-clause
 *  numbers ("BS EN 60898-1"); the schema options are suffix-free, so they
 *  canonicalise down. 60947 keeps its `-2`/`-3` because those ARE distinct
 *  standards. */
const BS_PATTERNS: ReadonlyArray<{
  re: RegExp;
  canonical?: string;
  build?: (m: RegExpMatchArray) => string;
}> = [
  { re: /^60947[-\s]*([23])$/i, build: (m) => `BS EN 60947-${m[1]}` },
  { re: /^60269[-\s]*2$/i, canonical: 'BS EN 60269-2' },
  { re: /^60898(?:[-\s]*1)?$/i, canonical: 'BS EN 60898' },
  { re: /^61008(?:[-\s]*1)?$/i, canonical: 'BS EN 61008' },
  { re: /^61009(?:[-\s]*1)?$/i, canonical: 'BS EN 61009' },
  { re: /^62423$/i, canonical: 'BS EN 62423' },
  // PLAN-CC RETIRED the `^88[-\s]*(?:dash[-\s]*)?([23])$` → `BS EN 60269-2`
  // row that used to sit here. It mapped BOTH `88 dash 2` and `88 dash 3` onto
  // ONE canonical, losing which part the inspector read off the device.
  // `ocpd_bs_en` — the only field on which it could ever have fired, since
  // `BS EN 60269-2` is not an `rcd_bs_en` option — now goes through
  // `canonicaliseOcpdStandard`, which keeps `BS 88-2` and `BS 88-3` distinct.
  { re: /^3036$/i, canonical: 'BS 3036' },
  { re: /^1361$/i, canonical: 'BS 1361' },
];

/** Full-consumption BS-code alias resolution. Returns null (→ re-ask) for
 *  anything the deterministic patterns don't wholly consume — including
 *  "1362" and "6898", which the backend's Lev-1 fallback WOULD have
 *  snapped onto a neighbouring standard. */
export function parseClosedEnumBsCode(residue: string): string | null {
  const normalised = normaliseBsInput(residue).trim();
  // Optional "BS" / "BS EN" lead-in — the canonical forms re-attach it.
  const bare = normalised.replace(/^bs\b\.?\s*(?:en\b\.?\s*)?/i, '').trim();
  for (const p of BS_PATTERNS) {
    const m = bare.match(p.re);
    if (m) return p.build ? p.build(m) : (p.canonical as string);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Reference-method alias parser — port of `coerceRefMethodValue`.
// ─────────────────────────────────────────────────────────────────────────

const REF_METHOD_LETTERS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
const REF_METHOD_WORD_NUMBERS = new Map<string, string>([
  ['one hundred', '100'],
  ['a hundred', '100'],
  ['hundred', '100'],
  ['one hundred and one', '101'],
  ['one hundred one', '101'],
  ['one hundred and two', '102'],
  ['one hundred two', '102'],
  ['one hundred and three', '103'],
  ['one hundred three', '103'],
]);

/** Ported from `src/extraction/record-reading-coercion.js` `coerceRefMethodValue`,
 *  plus the two spoken-hundred forms NumberNormaliser actually emits. Which
 *  form you get depends on whether the inspector says "and", and BOTH occur:
 *    "reference method one hundred and one" → "reference method 100 and 1"
 *    "reference method one hundred one"     → "reference method 1001"
 *  (measured against `web/src/lib/recording/number-normaliser.ts`, 2026-08-24
 *  — the compound-hundreds rule only fires for teens/tens, so a trailing
 *  ONES word is not absorbed; "one hundred" collapses to "100" and the bare
 *  "one" then digitises and abuts it.)
 *
 *  So the `^100[123]$` branch below is LOAD-BEARING, not dead: delete it and
 *  "reference method one hundred one for circuit 3" — a perfectly ordinary
 *  dictation — stops being a valid reading and starts drawing a re-ask,
 *  which is the Audio-First §2 failure this guard exists to prevent. It is
 *  also unambiguous: BS 7671 reference methods are A–G and 100–103, so
 *  "1001" has no competing real reading, whereas "100" alone IS an option
 *  and is therefore left exactly as dictated. (Codex cycle 5 proposed
 *  removing this branch on the belief the word-map above already covered
 *  the phrase; it covers only UN-normalised text, and the normaliser runs
 *  first on both clients.) */
export function parseClosedEnumRefMethod(residue: string): string | null {
  let v = residue
    .trim()
    .toLowerCase()
    .replace(/[.,!?]+$/g, '');
  v = v.replace(/^(?:it['’]s|it is|the)\s+/, '');
  v = v.replace(/^(?:reference\s+method|ref\s+method|method)\s+/, '');
  v = v.trim();
  if (REF_METHOD_LETTERS.has(v)) return v.toUpperCase();
  const word = REF_METHOD_WORD_NUMBERS.get(v);
  if (word) return word;
  if (/^10[0-3]$/.test(v)) return v;
  if (/^100[123]$/.test(v)) return `10${v[3]}`;
  const spoken = /^100\s+and\s+([123])$/.exec(v);
  if (spoken) return `10${spoken[1]}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────

export type ClosedEnumOutcome =
  | { kind: 'valid'; field: GuardedClosedEnumField; value: string }
  | { kind: 'invalid_value'; field: GuardedClosedEnumField; heard: string }
  | { kind: 'missing_value'; field: GuardedClosedEnumField }
  | { kind: 'unknown_field' };

export function isGuardedClosedEnumField(field: string | null | undefined): boolean {
  return typeof field === 'string' && GUARDED_CLOSED_ENUM_FIELDS.has(field);
}

/** Phrases that mean "not applicable" — accepted only on the fields whose
 *  schema option set actually carries `N/A`. Deliberately tight: "none" is
 *  excluded because it is just as often a mis-heard fragment as a genuine
 *  N/A.
 *
 *  Codex cycle 1 — `n.a` earns its own entry because the lookup runs on the
 *  EDGE-CLEANED residue: `cleanClosedEnumResidue` has already peeled the
 *  trailing `.`, so a dictated "N.A." arrives here as `n.a` and the `n.a.`
 *  entry alone could never match. `n.a.` is kept for the (unreachable but
 *  harmless) direct-call case rather than silently narrowing the set. */
const NA_PHRASES = new Set(['n/a', 'na', 'n a', 'n.a', 'n.a.', 'not applicable']);

/**
 * Validate-or-ask on one guarded closed-list field.
 *
 * Non-string inputs: a finite NUMBER stringifies (so `ocpd_type: 1` becomes
 * an honest invalid-value re-ask naming "1" rather than a dropped command);
 * booleans, objects, null and undefined are structural non-values and route
 * to `missing_value`.
 */
export function canonicaliseClosedEnumValue(field: string, raw: unknown): ClosedEnumOutcome {
  if (!isGuardedClosedEnumField(field)) return { kind: 'unknown_field' };
  const guarded = field as GuardedClosedEnumField;

  let source: string;
  if (typeof raw === 'string') source = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) source = String(raw);
  else return { kind: 'missing_value', field: guarded };

  const cleaned = cleanClosedEnumResidue(source);
  if (cleaned === '') return { kind: 'missing_value', field: guarded };

  const options = CLOSED_ENUM_OPTIONS[guarded];
  const lower = cleaned.toLowerCase();

  // 1. Case-insensitive membership with a canonical-casing snap. Required,
  //    not cosmetic: "gG", "gM", "aM" and "Rew" would all be REJECTED by a
  //    naive exact-match against a lowercased transcript residue.
  for (const option of options) {
    if (option.toLowerCase() === lower) return { kind: 'valid', field: guarded, value: option };
  }

  // 2. "Not applicable" phrasing, only where N/A is a real option.
  if (NA_PHRASES.has(lower) && options.includes('N/A')) {
    return { kind: 'valid', field: guarded, value: 'N/A' };
  }

  // 3. Field-specific alias resolution.
  let alias: string | null = null;
  if (guarded === 'wiring_type') {
    alias = WIRING_TYPE_DESCRIPTION_TO_CODE[cleaned.toUpperCase()] ?? null;
  } else if (guarded === 'ref_method') {
    alias = parseClosedEnumRefMethod(cleaned);
  } else if (guarded === 'rcd_bs_en') {
    alias = parseClosedEnumBsCode(cleaned);
  }
  // Membership is re-checked per field: "BS EN 60898" is a real standard but
  // is NOT an `rcd_bs_en` option, so it must still re-ask there.
  if (alias != null && options.includes(alias)) {
    return { kind: 'valid', field: guarded, value: alias };
  }

  return { kind: 'invalid_value', field: guarded, heard: cleaned };
}

// ─────────────────────────────────────────────────────────────────────────
// Complete-restatement re-ask
// ─────────────────────────────────────────────────────────────────────────

export type ClosedEnumSparePolicy = 'automatic' | 'include' | 'exclude';

/** What the REJECTED command was actually aimed at. The renderer echoes it
 *  back so the inspector can repeat the whole instruction in one breath —
 *  there is deliberately NO pending-correction state machine (a bare "A"
 *  reply would be indistinguishable from a fresh dictation). */
export type GuardedTarget =
  | { kind: 'single'; circuit: number | string }
  | {
      kind: 'range';
      from: number | string;
      to: number | string;
      sparePolicy?: ClosedEnumSparePolicy;
    }
  | { kind: 'all'; sparePolicy?: ClosedEnumSparePolicy }
  | { kind: 'unknown' };

export type ClosedEnumReaskReason = 'invalid_value' | 'missing_value' | 'missing_target';

function sparePolicySuffix(policy: ClosedEnumSparePolicy | undefined): string {
  if (policy === 'include') return ', including spares';
  if (policy === 'exclude') return ', excluding spares';
  return '';
}

function targetPhrase(target: GuardedTarget): string {
  if (target.kind === 'single') return `for circuit ${target.circuit}`;
  if (target.kind === 'range') {
    return `for circuits ${target.from} to ${target.to}${sparePolicySuffix(target.sparePolicy)}`;
  }
  if (target.kind === 'all') return `for all circuits${sparePolicySuffix(target.sparePolicy)}`;
  // `unknown` — there is no real target to echo, so the example carries an
  // explicitly illustrative circuit number.
  return 'for circuit 3';
}

/**
 * Render the spoken re-ask. Separate from `canonicaliseClosedEnumValue`
 * because only the CALLER knows what the command was aimed at — the guard
 * runs once, before scope resolution.
 *
 * These strings are force-audible on both clients (they must survive
 * confirmations-OFF, which is a suppression of ACKS, never of asks) and are
 * frozen in `config/closed-enum-vectors.json` so the two clients cannot
 * drift apart, and so a distinctness test can prove they never collide with
 * the backend's apology / refusal / decline-ack families.
 */
export function renderClosedEnumReask(
  field: ClosedEnumReaskField,
  reason: ClosedEnumReaskReason,
  heard: string,
  target: GuardedTarget
): string {
  const label = CLOSED_ENUM_LABELS[field];
  const example = `'${CLOSED_ENUM_EXAMPLE_PHRASES[field]} ${targetPhrase(target)}'`;
  if (reason === 'missing_value') {
    return `I didn't get a value for ${label} — say, for example, ${example}.`;
  }
  if (reason === 'missing_target') {
    return `I heard ${label} '${heard}' but not which circuit — say, for example, ${example}.`;
  }
  return `I heard ${label} '${heard}', which isn't a valid ${CLOSED_ENUM_NOUNS[field]} — say, for example, ${example}.`;
}

/** Convenience: turn a rejecting outcome straight into its spoken re-ask.
 *  Returns null for outcomes that do not reject. */
export function reaskForClosedEnumOutcome(
  outcome: ClosedEnumOutcome,
  target: GuardedTarget
): string | null {
  if (outcome.kind === 'invalid_value') {
    return renderClosedEnumReask(outcome.field, 'invalid_value', outcome.heard, target);
  }
  if (outcome.kind === 'missing_value') {
    return renderClosedEnumReask(outcome.field, 'missing_value', '', target);
  }
  return null;
}
