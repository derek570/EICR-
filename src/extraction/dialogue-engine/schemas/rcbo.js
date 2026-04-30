/**
 * RCBO (combined RCD + MCB) schema. The pivot target from OCPD's
 * BS-code slot or RCD's BS-code slot when the inspector says
 * "BS EN 61009" — and the direct entry path when they say "RCBO on
 * circuit N".
 *
 * Slots: ocpd_bs_en + rcd_bs_en (mirrored — RCBOs populate both
 * iOS columns with the same value), ocpd_type (curve), ocpd_rating_a,
 * ocpd_breaking_capacity_ka, rcd_type (waveform),
 * rcd_operating_current_ma. After a pivot from OCPD/RCD where both
 * BS fields are already set, RCBO's nextMissingSlot starts at the
 * curve question.
 */

import { parseBsCode } from '../parsers/bs-code.js';
import { parseMcbType } from '../parsers/mcb-type.js';
import { parseAmps } from '../parsers/amps.js';
import { parseKa } from '../parsers/ka.js';
import { parseRcdType } from '../parsers/rcd-type.js';
import { parseMa } from '../parsers/ma.js';

const slots = [
  {
    field: 'ocpd_bs_en',
    kind: 'bs_code',
    label: 'BS number',
    question: "What's the BS number?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    // Mirror to rcd_bs_en — by convention an RCBO populates both
    // OCPD and RCD columns with the same BS code. No pivot here
    // (we ARE the RCBO schema; nothing to pivot to).
    derivations: [{ value: '61009', mirrors: ['rcd_bs_en'] }],
  },
  {
    field: 'rcd_bs_en',
    kind: 'bs_code',
    label: 'RCD BS number',
    question: "What's the BS number?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    derivations: [{ value: '61009', mirrors: ['ocpd_bs_en'] }],
  },
  {
    field: 'ocpd_type',
    label: 'curve',
    question: 'What MCB curve? B, C, or D?',
    parser: parseMcbType,
    namedExtractor: /\b(?:type|curve)\s*([BCD])\b|\b([BCD])\s*[-]?\s*curve\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'ocpd_rating_a',
    label: 'rating',
    question: 'What rating in amps?',
    parser: parseAmps,
    namedExtractor: /\b(\d{1,4})\s*(?:amps?|A)\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'ocpd_breaking_capacity_ka',
    label: 'breaking capacity',
    question: "What's the breaking capacity in kA?",
    parser: parseKa,
    namedExtractor: /\b(\d+(?:\.\d+)?)\s*kA\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_type',
    label: 'RCD type',
    question: 'What RCD type? AC, A, F, or B?',
    parser: parseRcdType,
    namedExtractor: /\btype\s*(AC|[AFB]|S)\b|\b(AC)\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_operating_current_ma',
    label: 'RCD operating current',
    question: "What's the operating current in mA?",
    parser: parseMa,
    namedExtractor: /\b(\d{1,4})\s*(?:mA|milli\s*amps?)\b/i,
    acceptsBareValue: true,
  },
];

const triggers = [
  // Direct entry — "RCBO on circuit N".
  /\bRCBO\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
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
  /\bpolarity\b/i,
];

export const rcboSchema = {
  name: 'rcbo',
  triggers,
  cancelTriggers,
  skipSlotTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-rcbo',
  extractionSource: 'rcbo_script',
  logEventPrefix: 'stage6.rcbo_script',
  whichCircuitQuestion: 'Which circuit is the RCBO for?',
  cancelMessage: ({ filled, total }) => `RCBO cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'RCBO cancelled.',
  finishMessage: ({ values }) => {
    const bs = values.ocpd_bs_en ?? '?';
    const curve = values.ocpd_type ?? '?';
    const rating = values.ocpd_rating_a ?? '?';
    const ka = values.ocpd_breaking_capacity_ka ?? '?';
    const rcdType = values.rcd_type ?? '?';
    const ma = values.rcd_operating_current_ma ?? '?';
    return `Got it. ${bs}, type ${curve}, ${rating} amps, ${ka} kA, RCD type ${rcdType}, ${ma} mA.`;
  },
};
