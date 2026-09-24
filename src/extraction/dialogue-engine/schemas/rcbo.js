/**
 * RCBO (combined RCD + MCB) schema. The pivot target from OCPD's
 * BS-code slot or RCD's BS-code slot when the inspector says
 * "BS EN 61009" — and the direct entry path when they say "RCBO on
 * circuit N".
 *
 * Slots, in asked order: ocpd_bs_en, rcd_bs_en, ocpd_type (curve),
 * ocpd_rating_a, ocpd_breaking_capacity_ka, rcd_type (waveform),
 * rcd_operating_current_ma.
 *
 * The two BS numbers are ORDINARY ASKED SLOTS with no named extractor and
 * no mirror (PLAN-CS, feedback-2026-09-17, CS-64 / CS-100, under Decision 7).
 * Both slots used to carry the same generic `BS…` extractor, so one stretch
 * of speech matched both and an answer to "What's the RCD's BS number?"
 * silently overwrote the OCPD standard. Five successive rules tried to decide
 * which slot a spoken number belonged to and each failed review; Decision 7
 * forbids a sixth. With no BS extractor here the ambiguity cannot arise: a BS
 * value is collected only as the answer to its own question, through the
 * bare-value path, and a parser miss hands the turn to the model.
 *
 * What happens to a BS number the schema cannot attribute: the plan accepted
 * that an entry utterance carrying one ("RCBO on circuit 3, BS EN 61009"), or
 * a turn that also answered a different asked slot, would drop it. Decision 7
 * forbids that silent skip, so `unconsumedStandardPattern` below DETECTS the
 * standard (never attributes it) and the turn goes to the model instead.
 */

import {
  BS_STANDARD_MENTION_PATTERN,
  parseOcpdStandard,
  parseRcdBsCode,
} from '../parsers/bs-code.js';
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
    question: "What's the BS number of the RCBO?",
    // PLAN-CS — free text (Decision 4); a miss is PLAN-A's first-miss handoff.
    // No `namedExtractor` and no `derivations` (CS-100 / CS-64): see the
    // header comment.
    parser: parseOcpdStandard,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_bs_en',
    kind: 'bs_code',
    label: 'RCD BS number',
    question: "What's the RCD's BS number?",
    // PLAN-CS — strict: must canonicalise to one of `rcd_bs_en`'s options.
    parser: parseRcdBsCode,
    acceptsBareValue: true,
    // PLAN-CS (CS-64 / CS-66) — an ordinary asked slot. It used to be
    // `volunteeredOnly`, filled only by the OCPD mirror, which wrote the
    // RCBO's OCPD standard into the RCD column whether or not the two
    // matched. A stored value `parseRcdBsCode` rejects counts as unfilled and
    // is asked (`slotIsFilled`).
    askWhenStoredUnparseable: true,
    // Entry routing only: a model write of `rcd_bs_en` ALONE still routes to
    // the RCD walk, as it did while this slot was `volunteeredOnly`
    // (tryEnterScriptFromWrites' specificity ranking, 2026-06-02). An RCD's
    // number on its own says "RCD", not "RCBO".
    entryScoreAuxiliary: true,
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
    // P3 — numeric arm OR a field-qualified LIM anchored to "rating" (see ocpd.js).
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
    // phrase (see ocpd.js).
    namedExtractor:
      /\b(\d+(?:\.\d+)?)\s*kA\b|\b(?:breaking\s+capacity|kilo\s*amps?|kA)\b\s*(?:(?:is|was|reads?|equals?|of)\b\s*)?(?:[:=]\s*)?(?:an?\s+)?(lim|limb|limp|limitation)\b/i,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_type',
    label: 'RCD type',
    question: 'What RCD type? AC, A, F, or B?',
    parser: parseRcdType,
    // Audit-2026-06-02 Phase 4 — tightened to require an RCD-context
    // anchor for the bare-letter alternation. Pre-Phase-4 the regex
    // `\btype\s*(AC|[AFB]|S)\b|\b(AC)\b` matched "Type B" inside an
    // RCBO walk-through (when ocpd_type was the asked slot, B is the
    // legitimate curve letter) because B is in both [AFB] (RCD waveform)
    // AND [BCD] (OCPD curve). The engine's extractNamedFieldValues runs
    // ALL slot namedExtractors per turn, so a "Type B" reply wrote BOTH
    // ocpd_type AND rcd_type. Sonnet's prompt-only fix wouldn't help —
    // the writes land server-side BEFORE Sonnet is consulted.
    //
    // Three alternations + three capture groups (Codex Pass 4 caught
    // that the helper only read m[1] until Phase 4 widened it to
    // m[1] ?? m[2] ?? m[3]):
    //   Group 1 — bare letter (A/F/B/S/AC) preceded by an RCD/residual/
    //             waveform context anchor. Catches "RCD type A",
    //             "residual current device type AC", "waveform type B".
    //   Group 2 — "type AC" form. AC is unambiguous (no OCPD value uses
    //             AC) so we accept it without the RCD anchor.
    //   Group 3 — standalone "AC" as the whole reply (one-word answer).
    //             Whole-string anchored so "AC supply" / "AC mains"
    //             don't false-match.
    //
    // Behaviour:
    //   "Type B" (RCBO walkthrough, ocpd_type asked) → no match, no
    //     rcd_type write. BUG FIXED.
    //   "Type AC" → group 2 captures AC.
    //   "RCD type A" → group 1 captures A.
    //   "AC" (one-word reply) → group 3 captures AC.
    //   "AC supply" → no match (whole-string guard).
    namedExtractor:
      /\b(?:RCD\s+(?:waveform\s+)?type|residual(?:\s+current)?\s+(?:device\s+)?type|waveform\s+type)\s*(AC|[AFB]|S)\b|\btype\s*(AC)\b|^\s*(AC)\s*\.?\s*$/i,
    acceptsBareValue: true,
  },
  {
    field: 'rcd_operating_current_ma',
    label: 'RCD operating current',
    question: "What's the operating current in mA?",
    parser: parseMa,
    // P3 — numeric arm OR a field-qualified LIM anchored to an operating-current
    // phrase ("operating current"/"milli amps"/"mA").
    namedExtractor:
      /\b(\d{1,4})\s*(?:mA|milli\s*amps?)\b|\b(?:operating\s+current|milli\s*amps?|mA)\b\s*(?:(?:is|was|reads?|equals?|of)\b\s*)?(?:[:=]\s*)?(?:an?\s+)?(lim|limb|limp|limitation)\b/i,
    acceptsBareValue: true,
  },
];

/**
 * Whether the finish line must name the RCD's BS number separately (CS-70).
 * Each side is compared through its OWN slot parser, so a legacy stored
 * `61009-1` equals a dictated `BS EN 61009` and is not spoken as a second
 * number. A value its parser rejects is compared raw, trimmed and
 * case-insensitively. Stored bytes are never rewritten here: this decides
 * SPEECH only.
 */
function rcdBsDiffers(ocpd, rcd) {
  if (rcd === undefined || rcd === null || rcd === '') return false;
  const norm = (value, parse) => parse(value) ?? String(value).trim().toLowerCase();
  if (ocpd === undefined || ocpd === null || ocpd === '') return true;
  return norm(ocpd, parseOcpdStandard) !== norm(rcd, parseRcdBsCode);
}

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
  // PLAN-CS — Decision 7 applied to what the deletion of the two BS
  // extractors leaves behind. This pattern DETECTS a BS standard in the
  // utterance; it never decides which slot the number belongs to, which is
  // the discriminator Decision 7 forbids. When one is said and no BS slot
  // consumed it — at entry ("RCBO on circuit 3, BS EN 61009") or on a turn
  // that answered a different slot ("BS EN 61009, type B" to the curve
  // question) — the engine did not understand part of what the inspector
  // said, so the turn goes to the model with the utterance instead of being
  // silently dropped. See `bsStandardUnconsumed` in engine.js.
  unconsumedStandardPattern: BS_STANDARD_MENTION_PATTERN,
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
    // PLAN-CS (CS-65 / CS-70) — the RCD's number is named only when it is set
    // and DIFFERS from the OCPD standard, so equal values are spoken once and
    // differing values once each.
    const rcdClause = rcdBsDiffers(values.ocpd_bs_en, values.rcd_bs_en)
      ? `, RCD BS ${values.rcd_bs_en}`
      : '';
    return `Got it. ${bs}${rcdClause}, type ${curve}, ${rating} amps, ${ka} kA, RCD type ${rcdType}, ${ma} mA.`;
  },
  // PLAN A2 (feedback id 117) — the value-bearing fields `finishMessage`
  // actually speaks. Both BS slots are covered because the finish line speaks
  // the BS number, and a differing RCD BS number is named by the finish line
  // itself (PLAN-CS, CS-65).
  finishCoveredFields: [
    'ocpd_bs_en',
    'rcd_bs_en',
    'ocpd_type',
    'ocpd_rating_a',
    'ocpd_breaking_capacity_ka',
    'rcd_type',
    'rcd_operating_current_ma',
  ],
};
