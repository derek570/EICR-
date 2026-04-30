/**
 * OCPD (overcurrent protection device) schema. Captures the four
 * fields iOS shows in the OCPD column group: BS/EN code, type/curve,
 * rating in amps, breaking capacity in kA.
 *
 * Pivot: when `ocpd_bs_en` fills with "BS EN 61009", the device IS
 * an RCBO — derivation pivots to the RCBO schema, which carries the
 * BS code over (mirrored to rcd_bs_en too, since by convention an
 * RCBO populates both columns) and continues asking for the RCBO's
 * remaining slots (curve + rating + kA + RCD type + RCD operating
 * current).
 *
 * Skip: per-slot "skip" / "don't know" / "leave blank" exits the
 * current slot only and moves to the next, rather than cancelling
 * the whole script. Per Derek's PR2 decision (Option B). Mirrors
 * existing legacy iOS form behaviour where individual fields can
 * be left blank.
 */

import { parseBsCode } from '../parsers/bs-code.js';
import { parseMcbType } from '../parsers/mcb-type.js';
import { parseAmps } from '../parsers/amps.js';
import { parseKa } from '../parsers/ka.js';

const slots = [
  {
    field: 'ocpd_bs_en',
    kind: 'bs_code',
    label: 'BS number',
    question: "What's the BS number?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    derivations: [
      // Pure MCB BS code — no derivation. The schema asks for ocpd_type
      // (curve) next. Listing it explicitly documents intent.
      // (60898 → no auto-fill; ask for curve.)
      // RCBO — pivots to RCBO schema. Mirrors the same value into
      // rcd_bs_en so both iOS columns show "BS EN 61009".
      { value: '61009', mirrors: ['rcd_bs_en'], pivot: 'rcbo' },
      // Rewireable BS code uniquely determines ocpd_type = "Rew".
      { value: '3036', sets: { ocpd_type: 'Rew' } },
      // HRC fuses by BS 88 family.
      { value: '88-2', sets: { ocpd_type: 'HRC' } },
      { value: '88-3', sets: { ocpd_type: 'HRC' } },
      // Cartridge fuse — iOS canonical type is "1" (BS 1361 class).
      { value: '1361', sets: { ocpd_type: '1' } },
    ],
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
];

const triggers = [
  // "MCB on circuit N" / "OCPD for circuit N" / "breaker on circuit N"
  /\b(?:MCB|OCPD|breaker|protective\s+device)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
];

const cancelTriggers = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|scrap(?:\s+(?:that|this))?|forget\s+(?:it|that|this)|never\s+mind|abort)\b/i,
];

const skipSlotTriggers = [
  // Per-slot skip — does NOT cancel the whole script. Examples:
  // "I don't know", "skip that one", "leave it blank", "no idea",
  // "pass", "next one". Distinct vocabulary from the cancel verbs
  // so the inspector has a clean way to say "move on" without
  // losing the rest of the script.
  /\b(?:don'?t\s+know|no\s+idea|leave\s+(?:it\s+)?blank|blank|pass|next\s+one|skip\s+(?:this|that|it|one))\b/i,
];

const topicSwitchTriggers = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i,
  /\bcircuit\s+\d+\s+is\b/i,
  /\b(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b/i,
  /\binsulation\s+resistance\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
];

export const ocpdSchema = {
  name: 'ocpd',
  triggers,
  cancelTriggers,
  skipSlotTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-ocpd',
  extractionSource: 'ocpd_script',
  logEventPrefix: 'stage6.ocpd_script',
  whichCircuitQuestion: 'Which circuit is the OCPD for?',
  cancelMessage: ({ filled, total }) => `OCPD cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'OCPD cancelled.',
  finishMessage: ({ values }) => {
    const bs = values.ocpd_bs_en ?? '?';
    const type = values.ocpd_type ?? '?';
    const rating = values.ocpd_rating_a ?? '?';
    const ka = values.ocpd_breaking_capacity_ka ?? '?';
    return `Got it. ${bs}, type ${type}, ${rating} amps, ${ka} kA.`;
  },
};
