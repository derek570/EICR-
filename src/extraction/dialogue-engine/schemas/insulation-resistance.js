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
} from '../parsers/megaohms.js';
import { parseVoltage } from '../parsers/voltage.js';
import { IR_FIELDS, recordIrWrite, clearIrState } from '../../insulation-resistance-timeout.js';

const VOLTAGE_FIELD = 'ir_test_voltage_v';

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
    namedExtractor: new RegExp(
      `\\b(?:live\\s+to\\s+live|line\\s+to\\s+line|l\\s+to\\s+l|l[\\s.-]*l)\\b` +
        `(?:` +
        `[^a-z\\d∞]{0,6}?` +
        `|` +
        `[\\s,;:.-]+(?:(?:is|was|of|reads?|measures?|equals?|came\\s+(?:in|out)?\\s*at|came\\s+up\\s+at|test(?:ed|ing)?\\s+at)\\b|=)[\\s,]{0,3}?` +
        `)` +
        `(${MEGAOHMS_VALUE_GROUP})`,
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
        `[^a-z\\d∞]{0,6}?` +
        `|` +
        `[\\s,;:.-]+(?:(?:is|was|of|reads?|measures?|equals?|came\\s+(?:in|out)?\\s*at|came\\s+up\\s+at|test(?:ed|ing)?\\s+at)\\b|=)[\\s,]{0,3}?` +
        `)` +
        `(${MEGAOHMS_VALUE_GROUP})`,
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
  },
];

const triggers = [
  // Pattern 1 (full): "insulation/installation resistance" + optional "circuit N".
  // The "installation" alternation tolerates Deepgram's tendency to mis-hear
  // "insulation" as "installation".
  /\b(?:insulation|installation)\s+(?:resistance|res(?:istance|istence|istense)?)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
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
  fieldOrder: IR_FIELDS,
};
