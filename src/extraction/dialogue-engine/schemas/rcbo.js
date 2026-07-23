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
    question: "What's the BS number of the RCBO?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    // Mirror to rcd_bs_en — by convention an RCBO populates both
    // OCPD and RCD columns with the same BS code (single device,
    // single type-test classification). No pivot here (we ARE the
    // RCBO schema; nothing to pivot to).
    //
    // 2026-05-31: dropped the `value: '61009'` gate so the mirror
    // fires for any code the inspector dictates. Was: with the gate
    // in place, entering anything other than 61009 (e.g. 61008 —
    // session E8C6B716) left rcd_bs_en empty, so `nextMissingSlot`
    // then asked the identical "What's the BS number?" prompt for
    // the rcd_bs_en slot, which the inspector reasonably heard as
    // "the system didn't register my answer". For an RCBO the OCPD
    // BS code IS the RCD BS code, so unconditional mirror is the
    // correct semantic regardless of which standard the inspector
    // names.
    derivations: [{ mirrors: ['rcd_bs_en'] }],
  },
  {
    field: 'rcd_bs_en',
    kind: 'bs_code',
    label: 'RCD BS number',
    question: "What's the RCD's BS number?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    // 2026-05-31: never auto-asked. The ocpd_bs_en mirror above
    // unconditionally fills this field, so the inspector hears the
    // BS-number prompt exactly once per RCBO walk-through.
    //
    // The slot is preserved (rather than deleted) so the
    // namedExtractor still harvests volunteered values when the
    // inspector dictates the RCD code first ("the RCD BS code is
    // 61009 …"); the symmetric mirror below then fills ocpd_bs_en.
    // The question text is reworded ("…the RCD's BS number?") as
    // defence-in-depth — if some future code path ever bypasses the
    // mirror, the inspector at least hears WHICH BS number is being
    // asked for instead of an identical-sounding duplicate.
    volunteeredOnly: true,
    derivations: [{ mirrors: ['ocpd_bs_en'] }],
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
      /\b(\d{1,4})\s*(?:amps?|A)\b|\brating\b[^.?!]{0,20}?\b(lim|limb|limp|limitation)\b/i,
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
      /\b(\d+(?:\.\d+)?)\s*kA\b|\b(?:breaking\s+capacity|kilo\s*amps?|kA)\b[^.?!]{0,20}?\b(lim|limb|limp|limitation)\b/i,
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
      /\b(\d{1,4})\s*(?:mA|milli\s*amps?)\b|\b(?:operating\s+current|milli\s*amps?|mA)\b[^.?!]{0,20}?\b(lim|limb|limp|limitation)\b/i,
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
