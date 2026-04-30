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

import { parseMegaohms, MEGAOHMS_VALUE_GROUP } from '../parsers/megaohms.js';
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
    namedExtractor: new RegExp(
      `\\b(?:live\\s+to\\s+live|line\\s+to\\s+line|l\\s+to\\s+l|l[\\s.-]*l)\\b[^\\d∞>a-z]{0,30}?(${MEGAOHMS_VALUE_GROUP})`,
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
    namedExtractor: new RegExp(
      `\\b(?:live\\s+to\\s+earth|line\\s+to\\s+earth|l\\s+to\\s+e|l[\\s.-]*e)\\b[^\\d∞>a-z]{0,30}?(${MEGAOHMS_VALUE_GROUP})`,
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
