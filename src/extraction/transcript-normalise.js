/**
 * Backend dictation-transcript normaliser (P6 — feedback ids 89 + 80A).
 *
 * WHY THIS EXISTS
 *   Until now there was NO backend-side normalisation of the raw dictation
 *   transcript. Two field failures motivated this layer:
 *     - id 89 (session 2ACE7677): "Z s on the heating was 0.67" took two goes.
 *       Flux emitted the earth-loop-impedance field token as the spelled
 *       letters "Z s" (space between). The reading-field anchor
 *       (reading-transcript-anchor.js) looks for the substring "zs", which
 *       "z s" fails, so the reading did not anchor and the model no-op'd on
 *       the first attempt.
 *     - id 80A (session 36731498): an IR-script reply "A hundred MΩ" produced
 *       no digit — the word-number "a hundred" (article form) was never
 *       digit-ised, so parseMegaohms/parseBareMegaohmsWithUnit found nothing
 *       to parse. (The "MΩ" unit itself was already parseable; the miss was
 *       purely the word-number.)
 *
 * DESIGN
 *   ONE canonical normalisation layer, backend, applied at the dictation
 *   ingest (see sonnet-stream.js Seam A + Seam B). Pure function: it derives a
 *   canonical COPY and never mutates its input — the caller keeps the raw
 *   `msg.text` intact so the recorded-corpus fixtures + reverse-race dedupe
 *   keys keep the raw garble (a future replay must reproduce the bug, not mask
 *   it).
 *
 *   Rules are ENUMERATED, word-boundary, pattern-anchored. NO fuzzy /
 *   edit-distance correction of any kind (parity §3E + the
 *   certmate-research-methodology case study — that approach is hard-banned).
 *   The rule set grows ONLY from observed field evidence; v1 is two rules.
 *
 * RULE ORDERING (single pass to a fixed point)
 *   Rules run in a FIXED order that resolves the one directional dependency in
 *   a single forward pass: the word-number rule ("a hundred" → "100") runs
 *   BEFORE the context-gated field-token collapse, because the collapse's
 *   context gate requires the value to already be a DIGIT/sentinel. Without
 *   this order "Z s on the cooker was a hundred" would leave "Z s" un-collapsed
 *   (the gate would see the word-number "a hundred", not a value) — the exact
 *   interaction the plan called out. The reverse dependency does not exist
 *   ("Zs" is a field token, it never creates an "a hundred" pattern), so one
 *   forward pass reaches the fixed point.
 *
 * IDEMPOTENCY
 *   `normalise` reaches a fixed point in a single pass: after normalisation the
 *   two rules cannot re-trigger (rule "zs" output "Zs" has no space to match
 *   `z\s+s`; rule "a_hundred" output "100" is not "a hundred").
 *   `normalise(normalise(x)) === normalise(x)` holds for every rule and chained
 *   input — asserted in the unit tests.
 */

/**
 * Rule 1 — context-gated field-token collapse "Z s"/"Zed s"/"zed s" → "Zs".
 *
 * A GLOBAL "Z s" → "Zs" rewrite is UNSAFE: genuine two-letter dictation
 * appears in customer names ("Z S Electrical"), circuit designations
 * ("designation Z S 1"), and spelled postcodes/addresses. So the collapse is
 * gated on a reading-shaped same-clause: the "Z s" token must be FOLLOWED,
 * within the same clause (no sentence/clause delimiter in between), by a
 * connector/scope word (drawn from a closed electrical-reading set) AND then a
 * numeric-or-sentinel value.
 *
 * This textual predicate distinguishes the cases:
 *   - "Z s on the heating was 0.67"  → MATCH (token, then "on"/"was" connector,
 *                                       then the value 0.67).
 *   - "customer name Z S Electrical" → NO MATCH (no connector, no value).
 *   - "designation Z S 1"            → NO MATCH (the "1" is adjacent — there is
 *                                       NO connector word between the token and
 *                                       the value, which is exactly what a
 *                                       designation looks like).
 *   - spelled postcode / address text → NO MATCH (no connector+value shape).
 *
 * The token itself is matched with `\bz(?:ed)?\s+s\b` (case-insensitive):
 * "z s", "Z S", "zed s", "Zed s". The replacement is the literal "Zs" — the
 * downstream anchor lowercases the transcript, so casing does not matter, and
 * "Zs" carries no internal space so it cannot re-trigger this rule (idempotent).
 *
 * The context test is a zero-width lookahead so ONLY the token is consumed +
 * rewritten; the connector/scope words and the value are left untouched.
 *
 * TIGHT PREDICATE (hardened after review): the value must be introduced by a
 * VALUE-connector **immediately** before it (modulo an optional qualifier). A
 * looser "connector anywhere + value anywhere in the clause" wrongly collapsed
 * genuine designations like "designation Z S for circuit 1" and "customer name
 * Z S Electrical for unit 1" (the scope word "for" + the id number "1" both sit
 * in the clause). Requiring `was/is/reads/… <value>` adjacency keeps
 * "Z s on the heating **was 0.67**" (value introduced by "was") while rejecting
 * "…for **circuit** 1" (the value "1" is introduced by the scope noun "circuit",
 * not a value-connector). The scope gap between the token and the connector is
 * **bounded** (`{0,60}`) so the lookahead can never catastrophically backtrack
 * on a long no-value clause (ReDoS-safe — linear per token).
 */
const ZS_TOKEN = 'z(?:ed)?\\s+s';
// Bounded same-clause scope gap between the token and the value-connector —
// covers "on the heating " / "for circuit 3 " etc. Bounded to defuse ReDoS; a
// reading clause between the field token and its value is short. 120 chars
// accommodates a long circuit designation ("for the upstairs heating and hot
// water boiler radial circuit number three ") while staying bounded (linear
// backtracking). Never bridges a clause/sentence delimiter (. ! ? ; newline).
const ZS_SCOPE_GAP = '[^.!?;\\n]{0,120}?';
// VALUE-introducing connectors — the words that in dictation come IMMEDIATELY
// before a measured value ("was 0.67", "is 0.2", "reads 0.4", "of 0.5"). Scope
// prepositions ("on"/"for") are deliberately NOT here — they introduce the
// nouns being measured, not the value, so "for circuit 1" must not qualify.
// Kept to the common, low-false-positive forms — "measuring"/"equalled"/
// "showing" were dropped (they read naturally in non-reading text like
// "Z S Electrical measuring 10 metres").
const ZS_VALUE_CONNECTOR = '(?:was|were|is|are|reads?|equals?|measured|measures|of|at)';
// Optional qualifier between the connector and the value ("was about 0.67").
const ZS_QUALIFIER = '(?:the\\s+|about\\s+|around\\s+|approximately\\s+)?';
// Value vocabulary — a number (int/decimal/leading-dot) OR a domain sentinel.
const ZS_VALUE =
  '(?:\\d*\\.\\d+|\\d+|>\\s*\\.?\\d|\\b(?:lim|limb|limp|limitation|ol|infinite|infinity|off\\s*scale|out\\s*of\\s*range|max(?:ed)?)\\b)';
const ZS_CONTEXT_RE = new RegExp(
  `\\b${ZS_TOKEN}\\b(?=${ZS_SCOPE_GAP}\\b${ZS_VALUE_CONNECTOR}\\s+${ZS_QUALIFIER}${ZS_VALUE})`,
  'gi'
);

/**
 * Rule 2 — word-number "a hundred" → "100" (minimal observed set).
 *
 * iOS/web already digit-ise "one hundred" and combine compounds like "two
 * hundred and fifty" (NumberNormaliser), but NOT the article form "a hundred".
 * This rule closes ONLY that observed gap — there is NO general word-number
 * parser here (compound handling stays on the iOS/web layer, out of scope).
 *
 * Guard (hardened over two review passes): a trailing negative lookahead
 * prevents firing on any NUMERIC compound continuation — rewriting only the
 * "a hundred" head would corrupt it. The continuation may be introduced by
 * whitespace, comma, OR hyphen (so "a hundred and fifty", "a hundred, and
 * fifty", "a hundred-and-fifty", "a hundred and zero", "a hundred point five",
 * "a hundred and a half", "a hundred fifty", "a hundred 50" / "a hundred-50"
 * are ALL left untouched — a partial "100 and fifty" / "100 point five" /
 * "100 50" would let the IR parser misread 150 / 100.5 / 10050 as 100).
 *
 * Crucially the "and"/"point" branches require a NUMBER after them, so a
 * sentence-level conjunction is NOT a compound: "L to N is a hundred, and
 * polarity is pass" DOES digit-ise the standalone 100 (the "and" introduces a
 * new fact, not "and <number>"). The observed case "a hundred MΩ" /
 * "a hundred ohms" / "a hundred." fires — the following token is a unit/end,
 * not a number-continuation.
 */
const A_HUNDRED_NUM_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const A_HUNDRED_SEP = '[\\s,-]+';
const A_HUNDRED_RE = new RegExp(
  `\\ba\\s+hundred\\b(?!${A_HUNDRED_SEP}(?:` +
    // "and <number|a half>" / "point <number>" compound continuations
    `and${A_HUNDRED_SEP}(?:a${A_HUNDRED_SEP}half\\b|${A_HUNDRED_NUM_WORD}\\b|\\d)|` +
    `point${A_HUNDRED_SEP}(?:${A_HUNDRED_NUM_WORD}\\b|\\d)|` +
    // direct number continuation ("a hundred fifty", "a hundred 50")
    `a${A_HUNDRED_SEP}half\\b|${A_HUNDRED_NUM_WORD}\\b|\\d` +
    `))`,
  'gi'
);

/**
 * Stable rule IDs. Exported for tests + telemetry (the caller logs
 * `stage6.transcript_normalised { rules_hit }` — rule IDs ONLY, never the
 * raw/canonical text, per the leak-filter).
 */
export const NORMALISE_RULE_IDS = Object.freeze({
  ZS_FIELD_TOKEN: 'zs_field_token',
  A_HUNDRED: 'a_hundred',
});

/**
 * Enumerated rule table, in APPLICATION ORDER. Each entry is a single,
 * idempotent, word-boundary rewrite. `apply` returns the rewritten string; the
 * caller diffs before/after to decide whether the rule fired.
 *
 * ORDER IS LOAD-BEARING: `a_hundred` runs first so its digit output ("100")
 * satisfies the `zs_field_token` context gate on the same pass (see the
 * RULE ORDERING note in the file header). `rules_hit` is reported in this
 * application order.
 */
const RULES = Object.freeze([
  {
    id: NORMALISE_RULE_IDS.A_HUNDRED,
    apply: (t) => t.replace(A_HUNDRED_RE, '100'),
  },
  {
    id: NORMALISE_RULE_IDS.ZS_FIELD_TOKEN,
    apply: (t) => t.replace(ZS_CONTEXT_RE, 'Zs'),
  },
]);

/**
 * Normalise a raw dictation transcript to its canonical form.
 *
 * @param {string} text — raw transcript (or ask-answer user text).
 * @returns {{ text: string, rules_hit: string[] }} — the canonical text and
 *   the stable IDs of every rule that actually changed the text (empty when
 *   nothing fired). On a non-string input, returns the input coerced to '' and
 *   an empty rules_hit (the caller is responsible for preserving non-string
 *   `msg.text` behaviour — see the seam wiring).
 */
export function normalise(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', rules_hit: [] };
  }
  let out = text;
  const rulesHit = [];
  for (const rule of RULES) {
    const next = rule.apply(out);
    if (next !== out) {
      rulesHit.push(rule.id);
      out = next;
    }
  }
  return { text: out, rules_hit: rulesHit };
}
