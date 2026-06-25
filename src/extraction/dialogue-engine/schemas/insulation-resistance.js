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
  /^(?:>\s*\.?\d+(?:\.\d+)?|(?:greater|more)\s+than\s+\.?\d+(?:\.\d+)?|(?:over|above)\s+\.?\d+(?:\.\d+)?|\.?\d+(?:\.\d+)?|infinit(?:e|y)|off\s*scale|out\s*of\s*range|o\.?\s*l|max(?:ed)?(?:\s+out)?|lim|limb|limp|limit(?:ation|ed)?|lynn|lym)(?:\s*(?:mΩ|MΩ|meg(?:a|ger)?\s*ohms?|megohms?|milli\s*ohms?|m\s*ohms?|ohms?))?$/i;

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

const triggers = [
  // Pattern 1 (full): "insulation/installation/insurance resistance" + optional
  // "circuit N". The "installation"/"insurance" alternations tolerate Deepgram's
  // tendency to mis-hear "insulation". Field report 2026-06-24 #3: "insurance
  // resistance for the cooker" missed this trigger, so findCircuitsByDesignation
  // never resolved "cooker"→circuit 1 and the turn fell to Haiku, which asked
  // "which circuit?". "Insurance resistance" never occurs in real EICR dictation
  // so the false-positive surface is negligible (same rationale as "installation").
  /\b(?:insulation|installation|insurance)\s+(?:resistance|res(?:istance|istence|istense)?)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // Pattern 2 (terse): "IR for circuit N" — requires "circuit N" trailer.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\bi\s*r\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,
];

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
  cancelTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-irs',
  extractionSource: 'ir_script',
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
