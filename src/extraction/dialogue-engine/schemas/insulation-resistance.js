/**
 * Insulation resistance schema for the dialogue engine. Replaces
 * insulation-resistance-script.js.
 *
 * Slots: L-L (live to live) → L-E (live to earth) → test voltage, in
 * that order. Voltage uses `exclusiveWhenExpected: true` so that when
 * voltage is the asked-for slot, only the voltage parser runs on the
 * bare text — no L-L / L-E named extraction. This mirrors the legacy
 * script's `phase === 'voltage'` branch (which also silently finishes
 * after a voltage attempt, parseable or not). The engine handles the
 * silent-finish via the same exclusive-slot path.
 *
 * Wire shape, log event names, and tool-call-id prefix are preserved
 * byte-identically to the legacy script.
 */

import {
  parseMegaohms,
  parseBareMegaohmsWithUnit,
  MEGAOHMS_VALUE_GROUP,
  MEGAOHMS_BARE_SAFE_VALUE_GROUP,
} from '../parsers/megaohms.js';
import { parseVoltage } from '../parsers/voltage.js';
import {
  IR_FIELDS,
  recordIrWrite,
  clearIrState,
  recordVoltageReask,
} from '../../insulation-resistance-timeout.js';

const VOLTAGE_FIELD = 'ir_test_voltage_v';

// Standard BS 7671 insulation-resistance test voltages. A reply outside this
// set (e.g. a misheard "fifty" for "two fifty") is CONFIRMED before it is
// written, never silently accepted (field report 2026-06-24 #1, session
// B0F28CFB — the 2026-06-23 fix for this landed in the now-dead legacy
// insulation-resistance-script.js and never ran; this is the live-engine port).
// 50 V SELV is deliberately NOT included (resolved decision #1, 2026-06-24):
// genuine 50 V tests are rare and the confirm is cheap, so a misheard "50" is
// challenged rather than silently accepted.
const STANDARD_IR_VOLTAGES = Object.freeze(new Set([100, 250, 500, 1000]));

// A post-completion correction is a NEGATION followed by a remainder that is
// NOTHING BUT an IR value (anchored ^…$). parseMegaohms alone is unanchored
// (it extracts the first number ANYWHERE), so without this anchor "No, it
// isn't 200" / "No, 5 amps" / "No, 0.5 seconds" would each leak a stray number
// into the IR leg. Lifted verbatim from the legacy script's adversarial-review
// guard. Anything with extra words (leading "it isn't", a non-resistance unit)
// fails the anchor and is rejected — deliberately strict: the inspector simply
// says the bare value.
const IR_VALUE_ONLY_RE =
  /^(?:>\s*\.?\d+(?:\.\d+)?|(?:greater|more)\s+than\s+\.?\d+(?:\.\d+)?|(?:over|above)\s+\.?\d+(?:\.\d+)?|\.?\d+(?:\.\d+)?|infinit(?:e|y)|off\s*scale|out\s*of\s*range|o\.?\s*l|max(?:ed)?(?:\s+out)?|lim|limb|limp|limitation)(?:\s*(?:mΩ|MΩ|meg(?:a|ger)?\s*ohms?|megohms?|milli\s*ohms?|m\s*ohms?|ohms?))?$/i;

const slots = [
  {
    field: 'ir_live_live_mohm',
    label: 'live-to-live',
    question: "What's the live-to-live?",
    parser: parseMegaohms,
    // "live to live", "line to line", "L to L", "L L" / "LL" / "L-L" / "L.L".
    //
    // Label-to-value bridge has TWO branches, both restrictive:
    //   (a) bare form: 0-6 chars of non-letter/non-digit punctuation/whitespace
    //       only. Catches "L-L 200", "L-L: 200", "L-L,  200" (multi-space),
    //       "L-L=200", "L-L >299", "L-L infinite", "L-L OL".
    //   (b) connector form: lead-in punctuation, then an EXPLICIT connector
    //       word — anchored at BOTH ends — from a small allowlist (is, was,
    //       of, reads, measures, equals, came in/out/up at, tested at, =).
    //       Then a TIGHT 0-3 char whitespace/comma gap before the value.
    //       Catches "L-L is 200", "L-L is greater than 299", "L-L tested
    //       at 999", "L-L was 50".
    //
    // Word-boundary `\\b` at the END of each connector is load-bearing:
    // without it, "is" would match the leading two chars of "isolation"
    // and let the value-group's `\\bo\\s*l\\b` saturation sentinel match
    // "ol" mid-word ("isolation" → ">999" L-L certification). Same risk
    // class applies to "tolerance", "old", "voltage" — all matched by
    // the value group's `o\\s*l` branch in MEGAOHMS_VALUE_GROUP before
    // that group itself was word-anchored (defence in depth — see the
    // companion change in parsers/megaohms.js).
    //
    // Why the connector allowlist (vs the previous `[^\\d∞]{0,30}?` open
    // gap): the open gap accepted arbitrary letters between label and value,
    // which let bad utterances capture the wrong number — e.g.
    //   "live to live for circuit 3 is greater than 299"
    //     → gap consumed " for circuit ", value group's `\\d*\\.?\\d+` branch
    //       matched the bare digit "3", and L-L was certified as 3 megaohms
    //   "live to live voltage 500"
    //     → gap consumed " v", value group's `o\\s*l` saturation sentinel
    //       matched the "ol" inside "voltage" and L-L was certified as ">999"
    // Both are safety-critical wrong readings on an EICR. The connector
    // allowlist closes both holes while still supporting the natural
    // "is greater than X" form that motivated the original relaxation
    // (session 8782CB67-…-540F8A circuit 3, 2026-06-02 field repro).
    //
    // Trade-off acknowledged: utterances that link the label to the value
    // via a connector NOT in the allowlist (e.g. "live to live around 200",
    // "live to live IR 500") fall back to a no-match and the engine asks
    // for the value — same surface as a Deepgram-garbled label. Extend the
    // connector list only when field telemetry shows a real omission, not
    // pre-emptively.
    // 2026-06-03 (session 284CBBCD) — split into TWO capture groups
    // so the BARE-bridge arm can use the restricted
    // MEGAOHMS_BARE_SAFE_VALUE_GROUP (no single-digit bare integers)
    // while the CONNECTOR arm keeps the full MEGAOHMS_VALUE_GROUP.
    //
    // Repro: a Flux-garbled utterance "L L 2 L E greater than 299"
    // (likely a fragmented or coalesced rendering of the inspector
    // saying just "Greater than 299" inside an active IR walk-through)
    // pre-fix produced TWO writes: L-L=2 + L-E=>299, leaving the
    // cooker certified with an implausibly low L-L insulation
    // reading. Post-fix the bare-arm rejects "2" (single-digit
    // integer via the loose bridge), only L-E is named-matched, and
    // the engine re-asks L-L on the next turn.
    //
    // Phase 4 (audit-2026-06-02) widened extractNamedFieldValues to
    // read m[1] ?? m[2] ?? m[3], so multi-group regexes work without
    // any helper change here.
    namedExtractor: new RegExp(
      `\\b(?:live\\s+to\\s+live|line\\s+to\\s+line|l\\s+to\\s+l|l[\\s.-]*l)\\b` +
        `(?:` +
        `[^a-z\\d∞]{0,6}?(${MEGAOHMS_BARE_SAFE_VALUE_GROUP})` +
        `|` +
        `[\\s,;:.-]+(?:(?:is|was|of|reads?|measures?|equals?|came\\s+(?:in|out)?\\s*at|came\\s+up\\s+at|test(?:ed|ing)?\\s+at)\\b|=)[\\s,]{0,3}?(${MEGAOHMS_VALUE_GROUP})` +
        `)`,
      'i'
    ),
    acceptsBareValue: true,
    countsTowardCancelTally: true,
  },
  {
    field: 'ir_live_earth_mohm',
    label: 'live-to-earth',
    question: "What's the live-to-earth?",
    parser: parseMegaohms,
    // Same two-branch bridge as L-L above — keep them in lockstep, or a
    // future false-positive class will affect only one slot and fall through
    // unnoticed. See L-L for the rationale and trade-offs.
    namedExtractor: new RegExp(
      `\\b(?:live\\s+to\\s+earth|line\\s+to\\s+earth|l\\s+to\\s+e|l[\\s.-]*e)\\b` +
        `(?:` +
        `[^a-z\\d∞]{0,6}?(${MEGAOHMS_BARE_SAFE_VALUE_GROUP})` +
        `|` +
        `[\\s,;:.-]+(?:(?:is|was|of|reads?|measures?|equals?|came\\s+(?:in|out)?\\s*at|came\\s+up\\s+at|test(?:ed|ing)?\\s+at)\\b|=)[\\s,]{0,3}?(${MEGAOHMS_VALUE_GROUP})` +
        `)`,
      'i'
    ),
    acceptsBareValue: true,
    countsTowardCancelTally: true,
  },
  {
    field: VOLTAGE_FIELD,
    label: 'test voltage',
    question: 'What was the test voltage?',
    parser: parseVoltage,
    // No namedExtractor — voltage isn't extracted from named-field
    // utterances during the readings phase. The legacy script had a
    // dedicated parseVoltage path that runs only when voltage is the
    // asked-for slot. The engine equivalent is exclusiveWhenExpected.
    namedExtractor: null,
    acceptsBareValue: true,
    countsTowardCancelTally: false,
    exclusiveWhenExpected: true,
    // Standard-voltage confirm gate (#1). When the parsed voltage is outside
    // this set the engine does NOT write+finish — it re-asks as a one-shot
    // confirmation and STAYS in the voltage slot, so a spoken correction
    // ("No, 250") lands in-loop on the active circuit instead of finishing on
    // the misheard value and falling to Haiku (which mis-attributed the bare
    // correction to the most-recently-focused circuit). See engine.js step 6.
    confirmWhenNotIn: STANDARD_IR_VOLTAGES,
    confirmQuestion: (v) =>
      `Did you say ${v} volts? The usual is 250 or 500 — if that's right, just say it again.`,
  },
];

// ---------------------------------------------------------------------------
// Compound entry extractor (feedback id 123, 2026-08-12).
//
// The field shape "Installation resistance for the garage socket is greater
// than 299 live to live and live to earth" is VALUE first with two conjunct
// TRAILING labels — neither slot namedExtractor (LABEL→bridge→VALUE) can
// match it, so the loop re-asked both legs and the re-answers lost the `>`
// sentinel. This extractor certifies BOTH legs with the SAME value, and is
// consulted by runEntry ONLY when extractNamedFieldValues returned neither
// IR slot (different per-leg values keep going through the per-label
// extractors, which own that shape).
//
// Matching is LABEL-PAIR-FIRST, not value-first: a value-first search
// selects the EARLIEST eligible number, so "IR for circuit 2 is greater
// than 299 live to live and live to earth" could capture the 2 (the circuit
// ordinal sits before the real value and escapes any gap-only guard;
// numeric designations create the same hazard). Deterministic enumerated
// forms only — no edit-distance fuzz (banned), enumerated connectors only
// ("and", "&").
// ---------------------------------------------------------------------------

// The two label vocabularies, reused from the slot namedExtractors above —
// keep in lockstep with them per this file's own comment.
const LL_LABEL_SRC = 'live\\s+to\\s+live|line\\s+to\\s+line|l\\s+to\\s+l|l[\\s.-]*l';
const LE_LABEL_SRC = 'live\\s+to\\s+earth|line\\s+to\\s+earth|l\\s+to\\s+e|l[\\s.-]*e';

// Trailing label pair: both orderings, joined by an enumerated connector.
// Plus the "both" phrasing — accepted ONLY as end-of-clause "both" or
// explicit "both readings"/"both tests", NEVER "both circuits". Global flag:
// the extractor enumerates ALL pair mentions and keeps the RIGHTMOST one
// that is genuinely trailing (ep-diff-review cycle 1: a first-match search
// let an earlier incidental pair mention preempt a valid final clause).
const LABEL_PAIR_RE = new RegExp(
  `\\b(?:(?:${LL_LABEL_SRC})\\s*,?\\s*(?:and|&)\\s*(?:${LE_LABEL_SRC})` +
    `|(?:${LE_LABEL_SRC})\\s*,?\\s*(?:and|&)\\s*(?:${LL_LABEL_SRC})` +
    `|both(?:\\s+(?:readings|tests))?(?!\\s+circuits?\\b))\\b`,
  'gi'
);

// Clause boundaries for the bounded same-clause prefix. The family's
// [^.?!]{0,40} convention is NOT sufficient on its own — `\r`/`\n`/`;` and
// contrast tokens also terminate eligibility (a value beyond "but"/
// "whereas"/"however"/"except" is not the labels' value).
const CLAUSE_BOUNDARY_RE = /[.?!;\r\n]|\b(?:but|whereas|however|except)\b/gi;

// A single megaohms-value candidate inside the prefix. Sentinel and
// greater-than forms come first (most specific), bare numerics last.
const COMPOUND_CANDIDATE_RE = new RegExp(
  `(?:>\\s*|(?:greater\\s+(?:than|then)|more\\s+than|over|above)\\s+)(?:\\d+(?:\\.\\d+)?|\\.\\d+)` +
    `|infinite|infinity|off\\s*scale|out\\s*of\\s*range|\\bo\\s*l\\b|max(?:ed)?(?:\\s+out)?` +
    `|\\b(?:lim|limb|limp|limitation)\\b` +
    `|\\d+(?:\\.\\d+)?|\\.\\d+`,
  'gi'
);

// Explicit megaohm unit immediately after a bare number → qualified (b).
// `mΩ` carries its OWN delimiter lookahead (ep-diff-review cycle 1): a
// shared trailing `\b` can never match after `Ω` — both `Ω` and whitespace
// are non-word characters, so `250 MΩ` would silently fail qualification.
const MEGAOHM_UNIT_AFTER_RE =
  /^\s*(?:m(?:ega)?\s*[- ]?\s*ohms?\b|mΩ(?![\p{L}\p{N}])|milli\s*grams?\b|millies?\b|megs?\b)/iu;

// Megaohm forms stripped from a candidate's suffix BEFORE the conflicting-
// unit scan, so "250 megaohms" never reads as a bare "ohms" conflict.
const MEGAOHM_FORMS_STRIP_RE = /m(?:ega)?\s*[- ]?\s*ohms?|mΩ|milli\s*grams?|millies?|megs?/giu;

// Conflicting unit ANYWHERE between the candidate and the label pair →
// candidate rejected (ep-diff-review cycle 1: an immediate-suffix-only check
// missed non-adjacent units). volts, amps, milliseconds, milliamps, and
// ohms/kilohms WITHOUT mega-qualification: "…was tested at 500 volts, live
// to live and live to earth" has exactly one bare candidate and would
// otherwise certify BOTH IR fields as 500 MΩ.
// Symbolic Ω forms need no word boundaries (Ω is a non-word character, so
// `\b` can never anchor beside it — same class as the MΩ delimiter fix);
// megaohm forms are stripped before this scan, so any surviving Ω is
// non-mega by construction (ep-diff-review cycle 2).
const CONFLICTING_UNIT_SCAN_RE =
  /\b(?:volts?|v|amps?|amperes?|milli\s*seconds?|ms|milli\s*amps?|ma|(?:kilo\s*|k\s*)?ohms?)\b|(?:k(?:ilo)?\s*)?Ω/i;

// Closed connector set joining a bare number to the IR subject → (c).
const CONNECTOR_BEFORE_RE = /\b(?:is|was|reads|measures|equals)[\s,]{0,3}$/i;

// The IR subject anchor required for connector qualification (ep-diff-review
// cycle 1): "(c) a bare number joined to the IR SUBJECT by the closed
// connector set" — the connector alone proved nothing about WHAT is 299.
// Same head-word vocabulary as this schema's own triggers.
const IR_SUBJECT_RE =
  /\b(?:insulation|installation|insurance)\s+(?:resistance|res(?:istance|istence|istense)?)\b|\bi\s*r\b/i;

/**
 * `schema.compoundEntryExtractor(text)` — returns exactly TWO
 * `{field, value}` entries (same parsed value for both IR legs) or `[]`.
 * MUST receive the RAW entry text: the ordinary and scope-conflict paths
 * mask circuit spans before named extraction, and masked text would erase
 * the `circuit N` evidence the scope guard below needs.
 */
function compoundEntryExtractor(text) {
  if (typeof text !== 'string' || !text) return [];

  // 1. Locate the TRAILING label pair: enumerate every pair mention and
  //    keep the RIGHTMOST one that is genuinely trailing — nothing
  //    substantive may follow it in the same clause ("…299 but live to
  //    earth and live to live were not tested" must never certify);
  //    punctuation/whitespace to a clause boundary or end-of-string is
  //    fine. Rightmost-passing so an earlier incidental mention ("For both
  //    readings, …") cannot preempt a valid final clause.
  let pair = null;
  LABEL_PAIR_RE.lastIndex = 0;
  let pm;
  while ((pm = LABEL_PAIR_RE.exec(text)) !== null) {
    const trailing = text.slice(pm.index + pm[0].length);
    if (/^[\s,]*(?:$|[.?!;\r\n])/.test(trailing)) {
      pair = { index: pm.index, length: pm[0].length };
    }
  }
  if (!pair) return [];
  const pairStart = pair.index;
  const pairEnd = pair.index + pair.length;

  // 2. Bounded same-clause PREFIX: walk back from the pair to the nearest
  //    clause boundary (incl. `;`, CR/LF, and contrast tokens), then keep
  //    at most 40 chars (the family's gap convention).
  const before = text.slice(0, pairStart);
  let clauseStart = 0;
  CLAUSE_BOUNDARY_RE.lastIndex = 0;
  let bm;
  while ((bm = CLAUSE_BOUNDARY_RE.exec(before)) !== null) {
    clauseStart = bm.index + bm[0].length;
  }
  const clauseSpan = before.slice(clauseStart);
  const prefixDrop = Math.max(0, clauseSpan.length - 40);
  const prefix = clauseSpan.slice(prefixDrop);
  if (!prefix.trim()) return [];

  // 4 (checked early — cheapest guard): scope guard over the WHOLE span
  // from the preceding clause boundary through the label-pair end, not
  // merely the value-to-label gap. `\bcircuit\s*\d{1,3}\b` is the SOLE
  // scope marker, matching the codebase's only existing convention for
  // this guard class (maskCircuitSpans in helpers/extraction.js).
  const wholeSpan = clauseSpan + text.slice(pairStart, pairEnd);
  if (/\bcircuit\s*\d{1,3}\b/i.test(wholeSpan)) return [];

  // 3. Enumerate candidates in the prefix; retain only IR-QUALIFIED ones.
  const qualified = [];
  COMPOUND_CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = COMPOUND_CANDIDATE_RE.exec(prefix)) !== null) {
    const candText = m[0];
    const candEnd = m.index + candText.length;
    const restAfter = prefix.slice(candEnd);
    // Negative reading → rejected outright (ep-diff-review cycle 2): the
    // candidate regex is unsigned, so "-1" / "minus 1" would otherwise
    // tail-match as a positive "1" and certify both legs. A negative IR
    // reading is a meter/garble artefact — never silently rewritten.
    if (/(?:-|−|\bminus|\bnegative)\s*$/i.test(prefix.slice(0, m.index))) continue;
    // Conflicting unit ANYWHERE between the candidate and the label pair →
    // rejected outright (megaohm forms stripped first so they never read as
    // bare "ohms").
    if (CONFLICTING_UNIT_SCAN_RE.test(restAfter.replace(MEGAOHM_FORMS_STRIP_RE, ' '))) continue;
    // (a) greater-than / saturation / LIM sentinel forms: every bare
    // numeric candidate starts with a digit or '.', every sentinel/gt form
    // does not.
    const isSentinelOrGt = !/^[\d.]/.test(candText);
    if (isSentinelOrGt) {
      // (a) greater-than / saturation / LIM sentinel forms.
      qualified.push(candText);
      continue;
    }
    // Bare number: (b) explicit megaohm unit, or (c) closed-connector join
    // to the IR SUBJECT — the connector must join the number to an IR
    // mention in the same clause, not to an arbitrary noun ("the garage
    // socket is 299" proves nothing about WHAT is 299).
    if (MEGAOHM_UNIT_AFTER_RE.test(restAfter)) {
      qualified.push(candText);
      continue;
    }
    if (
      CONNECTOR_BEFORE_RE.test(prefix.slice(0, m.index)) &&
      IR_SUBJECT_RE.test(clauseSpan.slice(0, prefixDrop + m.index))
    ) {
      qualified.push(candText);
      continue;
    }
    // Unqualified bare number — ignored (never certifies, never blocks).
  }

  // Accept ONLY when exactly one qualified candidate remains.
  if (qualified.length !== 1) return [];
  const value = parseMegaohms(qualified[0]);
  if (value === null || value === undefined) return [];
  return [
    { field: 'ir_live_live_mohm', value },
    { field: 'ir_live_earth_mohm', value },
  ];
}

const triggers = [
  // Leading-circuit patterns (feedback id 98 companion, 2026-07-27): a
  // circuit stated BEFORE the trigger ("Circuit 4, insulation resistance
  // live to live 200") now binds. Same clause-start anchoring rules as the
  // ring schema's leading patterns (see ring-continuity.js for the full
  // rationale); this file's OWN head-word vocabulary (insurance, not the
  // legacy twin's international) is preserved verbatim. Circuit stays
  // capture group 1; detect* collect across all patterns and a
  // leading-vs-trailing contradiction surfaces as scope_conflict.
  /(?:^|[.?!][ \t]+)[ \t]*(?:(?:so|right|ok(?:ay)?|now)[ \t,]+)?\bcircuit[ \t]*(\d{1,3})\b(?![ \t]+is\b)[^\r\n.?!]{0,20}?\b(?:insulation|installation|insurance)\s+(?:resistance|res(?:istance|istence|istense)?)\b/i,
  /(?:^|[.?!][ \t]+)[ \t]*(?:(?:so|right|ok(?:ay)?|now)[ \t,]+)?\bcircuit[ \t]*(\d{1,3})\b(?![ \t]+is\b)[^\r\n.?!]{0,20}?\bi\s*r\b/i,
  // Pattern 1 (full): "insulation/installation/insurance resistance" + optional
  // "circuit N". The "installation"/"insurance" alternations tolerate Deepgram's
  // tendency to mis-hear "insulation". Field report 2026-06-24 #3: "insurance
  // resistance for the cooker" missed this trigger, so findCircuitsByDesignation
  // never resolved "cooker"→circuit 1 and the turn fell to Haiku, which asked
  // "which circuit?". "Insurance resistance" never occurs in real EICR dictation
  // so the false-positive surface is negligible (same rationale as "installation").
  /\b(?:insulation|installation|insurance)\s+(?:resistance|res(?:istance|istence|istense)?)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // Pattern 2 (terse): "IR for circuit N" — requires "circuit N" trailer.
  // Terse pattern RESTORED to its origin ^ anchor (Codex cycle 2): the
  // clause-start widening let "Zs is 0.62. Ring on circuit 13." ENTER the
  // ring script and swallow the Zs reading. Entry stays start-only; the
  // collectors scan later clause SEGMENTS with this anchored pattern for
  // contradiction REFS only (never for entry), which is what the
  // repeated-terse conflict needs.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\bi\s*r\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,
];

// Cross-utterance delete fix, IR same-utterance parity (feedback id 93
// fold-in, 2026-07-27): the IR schema had NO entryExclusionPattern, so
// "delete the insulation resistance readings for circuit 13" trigger-matched
// Pattern 1 and hijacked into the IR walk-through instead of falling through
// to Sonnet (which owns clear_reading) — the exact class P1
// ring-script-hardening closed for ring on 2026-07-22. Same shape as ring's
// pattern: destructive/corrective verbs ONLY, no question words, no denial
// phrases — question-form entries must keep entering (see the ring schema's
// comment for the field evidence and Derek's 2026-07-22 decision).
const entryExclusionPattern = /\b(delete|undo|remove|clear|cancel|fix)\b/i;

const cancelTriggers = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|skip(?:\s+(?:this|that|ir|insulation))?|scrap(?:\s+(?:that|this|ir|insulation))?|forget\s+(?:it|that|this)|never\s+mind|abort|ignore\s+(?:that|this))\b/i,
];

const topicSwitchTriggers = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i,
  /\bcircuit\s+\d+\s+is\b/i,
  // R1+R2 — accept both literal "+" and the spoken "plus" form. See
  // ring-continuity.js for the field repro that motivated this.
  /\bR\s*1\s*(?:\+|\s+plus\s+)\s*R\s*2\b/i,
  // Ring entries — same trigger vocabulary as ring-continuity.js's
  // own triggers, including the (?:ring|bring|wing) Deepgram-garble
  // alternation. Without this an inspector saying "Wing continuity"
  // mid-IR would not exit IR cleanly.
  /\b(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
  // Bare ring-field words — when said in isolation in IR mode, the
  // inspector has switched topic to ring.
  /\b(?:lives|neutrals|cpc|c\s*p\s*c)\s+(?:are|is|at|=)\b/i,
];

export const insulationResistanceSchema = {
  name: 'insulation_resistance',
  triggers,
  entryExclusionPattern,
  cancelTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-irs',
  extractionSource: 'ir_script',
  // Feedback id 123 (2026-08-12): compound value-first entry — consulted by
  // runEntry on the ordinary + scope-conflict extraction paths ONLY when
  // extractNamedFieldValues returned neither IR slot, with the RAW entry
  // text (masked text would erase the scope guard's evidence).
  compoundEntryExtractor,
  logEventPrefix: 'stage6.insulation_resistance_script',
  whichCircuitQuestion: 'Which circuit is the insulation resistance for?',
  // Capture a single composite IR figure at entry — "the IR for the
  // cooker is 299 milligrams". Named extractors only fire on L-L / L-E
  // tags, so a bare value with no tag was previously discarded. The
  // engine stashes the parsed value in `state.ambiguous_bare_value`
  // and the resume path asks "Was that L-L or L-E?" before continuing
  // the walk-through. Captured ONLY when circuit_ref is null at entry
  // (the case the field-test repro hits — session C3963EA1, cooker
  // circuit didn't exist when 299 was spoken).
  bareEntryParser: parseBareMegaohmsWithUnit,
  bareEntrySource: 'megaohm',
  // Opt in to the engine's pause-and-resume path. When the user names
  // a circuit that doesn't exist yet ("Insulation resistance for the
  // cooker..."), the engine pauses the IR script after the second
  // unresolvable answer (instead of clearing) and a stage6 dispatcher
  // hook resumes it once Sonnet creates a matching circuit. Ring
  // continuity does NOT opt in — Silvertown repro tests guard the
  // existing clear-and-fallthrough behaviour there.
  resumeAfterCircuitCreation: true,
  // L-L vs L-E disambiguation for the bare-entry value. When the
  // resume path lands with `ambiguous_bare_value` set AND both
  // L-L and L-E slots are still empty, the engine asks the question
  // returned by `bareDisambiguationQuestion` and routes the user's
  // reply through `disambiguateBareValue`. Reuses the same regex
  // vocabulary as the slot namedExtractors so any phrasing that
  // would have tagged a value at entry also disambiguates here.
  bareDisambiguationQuestion: (value) => `Was ${value} megaohms live-to-live or live-to-earth?`,
  disambiguateBareValue: (text) => {
    if (typeof text !== 'string' || !text) return null;
    if (/\b(?:live\s+to\s+live|line\s+to\s+line|l\s+to\s+l|l[\s.-]*l)\b/i.test(text)) {
      return { field: 'ir_live_live_mohm' };
    }
    if (/\b(?:live\s+to\s+earth|line\s+to\s+earth|l\s+to\s+e|l[\s.-]*e)\b/i.test(text)) {
      return { field: 'ir_live_earth_mohm' };
    }
    // Inspector wants out of the disambiguation — drop the bare value.
    if (/\b(?:neither|nothing|forget\s+(?:it|that)|skip|cancel|never\s+mind)\b/i.test(text)) {
      return { discard: true };
    }
    return null;
  },
  cancelMessage: ({ filled, total }) =>
    `Insulation resistance cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'Insulation resistance cancelled.',
  finishMessage: ({ values }) => {
    const ll = values.ir_live_live_mohm ?? '?';
    const le = values.ir_live_earth_mohm ?? '?';
    const v = values[VOLTAGE_FIELD];
    const voltageClause = v ? `, voltage ${v}` : '';
    return `Got it. L-L ${ll}, L-E ${le}${voltageClause}.`;
  },
  onWrite: (session, circuit_ref, now) => recordIrWrite(session, circuit_ref, now),
  onFinish: (session, circuit_ref) => clearIrState(session, circuit_ref),
  // M4 (2026-06-25): the engine calls this when the exclusive voltage slot is
  // abandoned WITH both readings present (a fresh interrupting reading or a
  // topic switch during the voltage phase). Register a post-script voltage
  // re-ask for this circuit so the missed test voltage is recovered once no
  // script is active (sonnet-stream drains the carrier). circuit_ref is the
  // PRIOR circuit; board scope from the current snapshot.
  onExclusiveSlotAbandoned: (session, circuit_ref) =>
    recordVoltageReask(session, circuit_ref, session?.stateSnapshot?.currentBoardId ?? null),
  fieldOrder: IR_FIELDS,
  // Post-completion correction breadcrumb (#1 belt-and-braces, field report
  // 2026-06-24). finishScript leaves a short-lived crumb naming the last
  // L-L/L-E leg written; within `windowMs` a "No, <value-only>" on the SAME
  // board re-writes that leg even though the script has cleared. The voltage
  // leg is handled in-loop by the confirm gate above; this covers the reading
  // legs once the script exits. Lifted from the legacy script's item #2b.
  correctionBreadcrumb: {
    windowMs: 15_000,
    fields: IR_FIELDS,
    fieldLabels: { ir_live_live_mohm: 'live-to-live', ir_live_earth_mohm: 'live-to-earth' },
    // NEGATION + captured remainder.
    correctionRe: /^\s*no\b[,.]?\s+(.+?)[.!?]*\s*$/i,
    // The remainder must be NOTHING BUT an IR value (anchored ^…$).
    valueOnlyRe: IR_VALUE_ONLY_RE,
    valueParser: parseMegaohms,
  },
};
