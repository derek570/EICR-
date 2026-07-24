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
 * TIGHT PREDICATE (hardened over review passes): the collapse fires ONLY when
 * the token is IMMEDIATELY followed by a reading lead-in — either
 *   (A) a VALUE-connector directly + the value: "Z s **is** 0.2", "Z s **was**
 *       0.67", "Z s **reads** 1.2"; or
 *   (B) a SCOPE-preposition (on/for/…) introducing the measured scope, then —
 *       within a bounded gap — a value-connector + the value:
 *       "Z s **on** the heating **was** 0.67".
 * The word right after the token MUST be one of those structural words. This is
 * what keeps genuine two-letter dictation intact: "customer name Z S
 * **Electrical**, Ze was 0.67" does NOT collapse because "Electrical" is neither
 * a value-connector nor a scope-preposition — even though a later "was 0.67"
 * (belonging to Ze) sits in the same comma-joined clause. A looser
 * "connector/value anywhere in the clause" predicate corrupted exactly that
 * class. The gap in form (B) is **bounded** (`{0,60}`) so the lookahead can
 * never catastrophically backtrack on a long no-value clause (ReDoS-safe).
 *
 * All structural whitespace in this rule is HORIZONTAL only (`[ \t]`, not
 * `\s`), so the collapse never bridges a NEWLINE — a newline is a clause
 * delimiter exactly like `. ! ? ;`. "customer name Z S\nwas 0.67" (two lines)
 * is left untouched. An optional comma/colon may sit between the token and the
 * lead-in ("Z s, on the heating was 0.67" / "Z s: is 0.2").
 */
// Horizontal whitespace only — never crosses a newline (a clause delimiter).
const H = '[ \\t]';
const ZS_TOKEN = `z(?:ed)?${H}+s`;
// VALUE-introducing connectors — the words that in dictation come IMMEDIATELY
// before a measured value ("was 0.67", "is 0.2", "reads 0.4"). Kept to the
// common, low-false-positive forms. "measuring"/"equalled"/"showing" were
// dropped (they read naturally in non-reading text like "…measuring 10 metres"),
// and — critically — "of"/"at" are NOT direct value-connectors: they are the
// prepositions of an address ("Z S at 1 High Street", "Z S of 10 Mill Lane")
// and a bare integer after them ("at 1") would corrupt the name/address. They
// remain SCOPE-prepositions below (form B), where they must be FOLLOWED by a
// real value-connector, so an address (no trailing connector) never collapses.
const ZS_VALUE_CONNECTOR = '(?:was|were|is|are|reads?|equals?|measured|measures)';
// SCOPE prepositions that can introduce the measured scope right after the token
// ("Z s ON the heating…", "Z s FOR circuit 3…"). These are NOT value-connectors
// — they must be FOLLOWED (within the bounded gap) by a value-connector + value.
const ZS_SCOPE_PREP = '(?:on|onto|for|at|of|to|in|across|between)';
// Bounded same-clause scope gap between the scope-prep and the value-connector
// — covers realistic dictated reading scopes ("the heating ", "circuit 3 ",
// "the downstairs ring final circuit "). Bounded to 60 chars, which (a) defuses
// ReDoS (linear per token) and (b) deliberately favours NAME-SAFETY over
// collapsing a pathologically long scope: a longer bound widens the window in
// which a long name-shaped clause "Z S for <long text> was <n>" would wrongly
// collapse. Very long reading scopes (>60 chars) are left un-collapsed
// (false-negative, acceptable — no inspector dictates the full circuit
// description inline with a Zs value; the rule grows from field evidence).
// Never bridges a clause/sentence delimiter (. ! ? ; CR newline).
const ZS_SCOPE_GAP = '[^.!?;\\r\\n]{0,60}?';
// Optional qualifier between the connector and the value ("was about 0.67").
const ZS_QUALIFIER = `(?:the${H}+|about${H}+|around${H}+|approximately${H}+)?`;
// Value vocabulary — a number (int/decimal/leading-dot) OR a domain sentinel.
// Internal spacing is HORIZONTAL-only too (a sentinel like "off scale" must not
// bridge a newline, e.g. a name "Z S is off\nscale" must stay untouched).
const ZS_VALUE =
  `(?:\\d*\\.\\d+|\\d+|>${H}*\\.?\\d|\\b(?:lim|limb|limp|limitation|ol|infinite|infinity|off${H}*scale|out${H}*of${H}*range|max(?:ed)?)\\b)`;
// Form A (direct connector) OR Form B (scope-prep … connector). The token must
// be immediately followed by one of these — an arbitrary noun after the token
// (a name/designation word) matches NEITHER and is left untouched. An optional
// comma/colon may separate the token from the lead-in.
const ZS_VALUE_TAIL = `${ZS_VALUE_CONNECTOR}${H}+${ZS_QUALIFIER}${ZS_VALUE}`;
const ZS_CONTEXT_RE = new RegExp(
  `\\b${ZS_TOKEN}\\b(?=[,:]?${H}+(?:${ZS_VALUE_TAIL}|${ZS_SCOPE_PREP}\\b${ZS_SCOPE_GAP}\\b${ZS_VALUE_TAIL}))`,
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
// Fractional / spoken-decimal filler that can continue a number:
// "a half", "half", "a quarter", "quarter", and the spoken-zero forms
// "oh"/"nought" ("a hundred point oh five" = 100.05).
const A_HUNDRED_FRAC = `(?:a${A_HUNDRED_SEP})?(?:half|quarter)\\b|oh\\b|nought\\b`;
// A continuation token that makes "a hundred …" a bigger/decimal number.
const A_HUNDRED_NUMISH = `(?:${A_HUNDRED_FRAC}|${A_HUNDRED_NUM_WORD}\\b|\\d)`;
const A_HUNDRED_RE = new RegExp(
  `\\ba\\s+hundred\\b(?!${A_HUNDRED_SEP}(?:` +
    // "and <numish>" compound continuation ("and fifty", "and a half", "and half")
    `and${A_HUNDRED_SEP}${A_HUNDRED_NUMISH}|` +
    // "point <anything>" is always a spoken decimal ("point five", "point oh five")
    `point\\b|` +
    // direct number/fraction continuation ("a hundred fifty", "a hundred 50", "a hundred half")
    `${A_HUNDRED_NUMISH}` +
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
