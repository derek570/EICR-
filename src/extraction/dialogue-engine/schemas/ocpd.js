/**
 * OCPD (overcurrent protection device) schema. Captures the four
 * fields iOS shows in the OCPD column group: BS/EN code, type/curve,
 * rating in amps, breaking capacity in kA.
 *
 * Pivot: when `ocpd_bs_en` fills with "BS EN 61009", the device IS
 * an RCBO — derivation pivots to the RCBO schema, which carries the
 * OCPD standard over and asks the RCBO's remaining slots, starting with
 * the RCD's own BS number. Nothing copies the OCPD standard into
 * `rcd_bs_en` any more (PLAN-CS, CS-64): an RCBO's two standards are not
 * always the same in the field (61008 against 61009), so each is dictated
 * or asked on its own.
 *
 * Skip: per-slot "skip" / "don't know" / "leave blank" exits the
 * current slot only and moves to the next, rather than cancelling
 * the whole script. Per Derek's PR2 decision (Option B). Mirrors
 * existing legacy iOS form behaviour where individual fields can
 * be left blank.
 */

import { BS_STANDARD_NAMED_EXTRACTOR, parseOcpdStandard } from '../parsers/bs-code.js';
import { parseMcbType } from '../parsers/mcb-type.js';
import { parseAmps } from '../parsers/amps.js';
import { parseKa } from '../parsers/ka.js';

const slots = [
  {
    field: 'ocpd_bs_en',
    kind: 'bs_code',
    label: 'BS number',
    question: "What's the BS number of the breaker?",
    // PLAN-CS — free text (Decision 4). Any grammar-valid standard is
    // accepted and canonicalised; anything else is a miss, and a miss on the
    // asked slot is PLAN-A's first-miss handoff.
    parser: parseOcpdStandard,
    // The whole standard token, prefix included, with the full two-suffix
    // grammar and a right boundary. The previous capture stopped after ONE
    // single-digit suffix, so `BS EN 60947-4-1` was written and read back as
    // `60947-4`. Shared with rcd.js so the two remaining BS extractors cannot
    // drift; see `BS_STANDARD_NAMED_EXTRACTOR`.
    namedExtractor: BS_STANDARD_NAMED_EXTRACTOR,
    acceptsBareValue: true,
    derivations: [
      // Pure MCB BS code — no derivation. The schema asks for ocpd_type
      // (curve) next. Listing it explicitly documents intent.
      // (60898 → no auto-fill; ask for curve.)
      // RCBO — pivots to the RCBO schema. No mirror into rcd_bs_en
      // (PLAN-CS, CS-64/CS-77): the RCBO walk asks the RCD's number.
      { value: '61009', pivot: 'rcbo' },
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
  // PLAN-A / Decision 17 (feedback-2026-09-17, taken by Derek) — the
  // completion summary omits the part it has ALREADY spoken, per field.
  //
  // The defect: a `record_reading` that TRIGGERS this walk-through is stamped
  // `spoken_owner = 'bundler'` (the bundler reads it back on that same turn),
  // but `finishMessage` above is ONE template interpolating all four slot
  // fields unconditionally, so a turn or more later the completion summary
  // says the value a second time. Audio-First invariant 1 names the
  // double-confirm as a bug.
  //
  // Why not the EXISTING gate, which is the option Derek did NOT take:
  // opting into `finishCoveredFields` is all-or-nothing — one bundler-owned or
  // snapshot-seeded field suppresses the whole "Got it …" line. That changes
  // what the inspector hears on every OCPD completion, not only where a repeat
  // occurs, and it would DELETE the first read-back of a snapshot-seeded
  // value. Decision 17 needs the finer thing, so `finishScript` composes these
  // SEGMENTS instead and drops only the ones already spoken.
  //
  // The segments carry today's expressions verbatim, `?? '?'` fallbacks
  // included: Decision 17 changes WHICH segments render, never HOW one
  // renders. With nothing omitted they compose byte-identically to
  // `finishMessage` above, which is pinned as acceptance property (1).
  finishSummarySegments: {
    prefix: 'Got it.',
    joiner: ', ',
    terminator: '.',
    segments: [
      { field: 'ocpd_bs_en', render: (values) => `${values.ocpd_bs_en ?? '?'}` },
      { field: 'ocpd_type', render: (values) => `type ${values.ocpd_type ?? '?'}` },
      { field: 'ocpd_rating_a', render: (values) => `${values.ocpd_rating_a ?? '?'} amps` },
      {
        field: 'ocpd_breaking_capacity_ka',
        render: (values) => `${values.ocpd_breaking_capacity_ka ?? '?'} kA`,
      },
    ],
  },
};
