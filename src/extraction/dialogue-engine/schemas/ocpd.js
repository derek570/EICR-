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
    question: "What's the BS number of the breaker?",
    parser: parseBsCode,
    // Accepts both clean `BS 60898` / `BS EN 60898` and Flux's
    // letter-splitting `a b s 60898` / `a. b. s. e. n. 60898` forms.
    // Defensive duplicate of `normaliseBsInput` in
    // parsers/bs-code.js — applied here too because
    // `extractNamedFieldValues` runs the regex against raw text before
    // calling the parser. iOS NumberNormaliser collapses both forms
    // for the iOS path, so this only fires on web / test inputs.
    namedExtractor: /\b(?:a\.?\s+)?b\.?\s*s\.?(?:\s+e\.?\s+n\.?|\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
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
    // P3 — numeric arm OR a field-qualified LIM anchored to the word "rating"
    // ONLY (never bare "amps", which collides with "kilo/milli amps"). Passes
    // the bare LIM token (m[2]) to parseAmps. A BARE "limitation" reply is
    // handled by the active-slot parser (parseLimSlot); a limitation for a
    // sibling slot is captured by THAT slot's anchor, not this one.
    namedExtractor:
      /\b(\d{1,4})\s*(?:amps?|A)\b|\brating\b\s*(?:(?:is|was|reads?|equals?|of)\b\s*)?(?:[:=]\s*)?(?:an?\s+)?(lim|limb|limp|limitation)\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'ocpd_breaking_capacity_ka',
    label: 'breaking capacity',
    question: "What's the breaking capacity in kA?",
    parser: parseKa,
    // P3 — numeric arm OR a field-qualified LIM anchored to a breaking-capacity
    // phrase ("breaking capacity"/"kilo amps"/"kA"), so "breaking capacity is a
    // limitation" writes LIM to THIS slot only. LIM is accepted by the ranged
    // validator itself (value-enum-validator.js), not by any slot allow-set —
    // see the Decision 9 note below.
    namedExtractor:
      /\b(\d+(?:\.\d+)?)\s*kA\b|\b(?:breaking\s+capacity|kilo\s*amps?|kA)\b\s*(?:(?:is|was|reads?|equals?|of)\b\s*)?(?:[:=]\s*)?(?:an?\s+)?(lim|limb|limp|limitation)\b/i,
    acceptsBareValue: true,
    // PLAN-A / Decision 9 (feedback-2026-09-17, taken by Derek) — the
    // `allowedValues` ladder that lived here is REMOVED. Breaking capacity is
    // NOT a validate-or-reject field: an EICR records what the inspector sees.
    //
    // What stood here, and why it went. 2026-05-04 (field test 07635782) the
    // inspector said "six" for the rating, the engine took it as the answer to
    // the question it had already asked, then asked for breaking capacity, and
    // Deepgram heard "66" — which landed on the certificate. The fix was a
    // per-slot allow-set enforced at two live sites (helpers/extraction.js's
    // named-extraction gate and the engine's step-8 bare-value gate), where an
    // off-ladder value was logged, DROPPED and the slot re-asked.
    //
    // That is exactly the deterministic dead end Decision 7 removes: the
    // inspector says a figure, hears nothing about it, and is asked the same
    // question again. Under Decision 9 the value is WRITTEN at whatever it was
    // heard as, read back like any other accepted reading, and carries ONE
    // spoken advisory when it is off the researched list. Nothing is cleared,
    // nothing is blocked, and no second ask follows.
    //
    // WHERE THE LIST WENT. Decision 16 replaced the published-ladder guess
    // with ONE researched list (BEAMA's circuit-breaker standards guide and
    // IET Wiring Matters Table 1, read directly), and it now lives as
    // `suggestions` on `ocpd_breaking_capacity_ka` in config/field_schema.json
    // — the same carrier Decision 6 established for `ocpd_type`. It is inert
    // to CIRCUIT_FIELD_VALUE_ENUMS by construction (that builder admits a
    // field only when `type === 'select'` with an `options` array), so no gate
    // can grow back from it by accident. The advisory derivation and the
    // handoff note's `remaining[].suggestions` are its two consumers.
    //
    // THE COST, recorded rather than glossed: a mistyped or misheard
    // safety-rated figure can now reach a certificate carrying only a spoken
    // advisory. That is the trade Decision 9 makes deliberately — the range
    // gate (1..200, value-enum-validator.js) is unchanged and still refuses a
    // structurally impossible value such as 500.
    //
    // "LIM" needs no allow-set entry any more: the ranged validator accepts
    // canonical LIM on every ranged reading field, and the advisory never
    // fires on it.
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
