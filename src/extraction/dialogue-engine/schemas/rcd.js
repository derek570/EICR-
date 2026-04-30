/**
 * RCD (residual current device) schema. Captures the three fields
 * iOS shows in the RCD column group: BS/EN code, type (waveform),
 * operating current in mA. RCD trip time is intentionally NOT a
 * slot here — it's a separate test reading captured by Sonnet's
 * normal extraction path.
 *
 * Pivot: when `rcd_bs_en` fills with "BS EN 61009", the device IS
 * an RCBO — derivation pivots to the RCBO schema and mirrors the
 * BS code into ocpd_bs_en (both columns hold the same value for
 * RCBOs by convention).
 */

import { parseBsCode } from '../parsers/bs-code.js';
import { parseRcdType } from '../parsers/rcd-type.js';
import { parseMa } from '../parsers/ma.js';

const slots = [
  {
    field: 'rcd_bs_en',
    kind: 'bs_code',
    label: 'BS number',
    question: "What's the BS number?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    derivations: [
      // RCBO pivot — mirror the BS code into ocpd_bs_en.
      { value: '61009', mirrors: ['ocpd_bs_en'], pivot: 'rcbo' },
    ],
  },
  {
    field: 'rcd_type',
    label: 'type',
    question: 'What RCD type? AC, A, F, or B?',
    parser: parseRcdType,
    namedExtractor: /\btype\s*(AC|[AFB]|S)\b|\b(AC)\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_operating_current_ma',
    label: 'operating current',
    question: "What's the operating current in mA?",
    parser: parseMa,
    namedExtractor: /\b(\d{1,4})\s*(?:mA|milli\s*amps?)\b/i,
    acceptsBareValue: true,
  },
];

const triggers = [
  // "RCD on circuit N" — the trigger word "RCD" excludes "RCBO" via
  // the trailing word boundary, so "RCBO" doesn't accidentally enter
  // RCD when the user really wanted RCBO.
  /\bRCD\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
];

const cancelTriggers = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|scrap(?:\s+(?:that|this))?|forget\s+(?:it|that|this)|never\s+mind|abort)\b/i,
];

const skipSlotTriggers = [
  /\b(?:don'?t\s+know|no\s+idea|leave\s+(?:it\s+)?blank|blank|pass|next\s+one|skip\s+(?:this|that|it|one))\b/i,
];

const topicSwitchTriggers = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i,
  /\bcircuit\s+\d+\s+is\b/i,
  /\b(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b/i,
  /\binsulation\s+resistance\b/i,
  /\b(?:MCB|breaker|OCPD)\b/i,
  /\bpolarity\b/i,
];

export const rcdSchema = {
  name: 'rcd',
  triggers,
  cancelTriggers,
  skipSlotTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-rcd',
  extractionSource: 'rcd_script',
  logEventPrefix: 'stage6.rcd_script',
  whichCircuitQuestion: 'Which circuit is the RCD for?',
  cancelMessage: ({ filled, total }) => `RCD cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'RCD cancelled.',
  finishMessage: ({ values }) => {
    const bs = values.rcd_bs_en ?? '?';
    const type = values.rcd_type ?? '?';
    const ma = values.rcd_operating_current_ma ?? '?';
    return `Got it. ${bs}, type ${type}, ${ma} mA.`;
  },
};
