/**
 * RCD (residual current device) schema. Captures the three "device-
 * level" fields iOS shows in the RCD column group: BS/EN code, type
 * (waveform), operating current in mA. As of 2026-05-21 (session
 * 293F074F), the schema also opportunistically captures the
 * per-circuit `rcd_trip_time` when the inspector volunteers it at
 * entry ("RCD trip time for the cooker is 25 ms") — but never asks
 * for it explicitly, because trip time is a test reading that varies
 * per circuit, not a shared property of the RCD device.
 *
 * Pivot: when `rcd_bs_en` fills with "BS EN 61009", the device IS
 * an RCBO — derivation pivots to the RCBO schema and mirrors the
 * BS code into ocpd_bs_en (both columns hold the same value for
 * RCBOs by convention).
 *
 * Bulk apply: after BS / type / mA all fill (the three RCD device
 * properties), the engine emits a follow-up TTS prompt: "Apply these
 * RCD details to any other circuits? Say 'all' or a range like '1
 * to 6'." The inspector's reply propagates BS/type/mA — but NOT
 * trip_time — to the named circuits, creating blanks where the
 * circuit number doesn't exist yet. See engine.js's bulk-apply
 * branch for the implementation.
 */

import { parseBsCode } from '../parsers/bs-code.js';
import { parseRcdType } from '../parsers/rcd-type.js';
import { parseMa } from '../parsers/ma.js';
import { parseMs } from '../parsers/ms.js';

const slots = [
  // rcd_trip_time sits FIRST so the entry-utterance named-field
  // extractor finds it before the regex-overlap-prone "BS"/"mA"
  // patterns. `volunteeredOnly: true` means nextMissingSlot skips it
  // — the engine never asks "What's the trip time?" via TTS. The
  // inspector dictates it as part of the natural sentence; otherwise
  // it stays null and they fill it later via the iOS UI.
  //
  // `countsTowardCancelTally: false` matches the existing IR voltage
  // pattern — the "N of M saved" cancel message shouldn't penalise a
  // never-asked slot.
  {
    field: 'rcd_trip_time',
    label: 'trip time',
    parser: parseMs,
    // "trip time ... 25 ms" / "trip time of 25 ms" / "trip time is
    // 25 milliseconds". Two-word phrase anchor `\btrip\s+time\b`. The
    // unit suffix (ms/millisecond) is REQUIRED so the regex can use
    // it as a right-anchor to skip over an intervening circuit
    // number — "RCD trip time for circuit 5 is 25 ms" needs filler
    // to consume "for circuit 5 is " to reach "25 ms". Allowing the
    // filler to contain digits (only excluding ∞) is safe because
    // the trailing unit pins the actual value position.
    //
    // `tryptoid` — Deepgram garble of "trip time" (field report
    // 2026-06-24 #4/#5, session B0F28CFB: "RCD tryptoid of circuit 2 is
    // 28 ms"). Without it the named-extractor returned 0 volunteered
    // values, the entry hit the handover-to-Sonnet branch
    // (engine.js, hasNumericValueWithUnit && volunteered.length===0),
    // and the orphan net (stage6-shadow-harness.js) caught a STRUCTURALLY
    // COMPLETE reading — producing a contentless local-apply read-back on
    // iOS (#4) and a duplicate re-emit next turn (#5). Adding the garble
    // here populates `volunteered`, so the handover is skipped and the
    // engine applies + confirms the reading itself — the net is never
    // reached for this garble. The unit anchor keeps the false-positive
    // surface negligible. The broader garble class is the dedicated
    // keyterm sibling sprint, NOT this wave (resolved decision #5).
    //
    // `triptan` — second Deepgram garble of "trip time", same class as
    // `tryptoid` (field session 6B6FE011 F8). Previously it relied on
    // the Sonnet handover; the enumerated alias makes it deterministic
    // like `tryptoid`. The ICD-prefixed form of the phrase ("ICD trip
    // time 26 milliseconds", same session) needs no extractor change —
    // the `\btrip\s*time\b` anchor is prefix-agnostic; the fix for
    // that garble is the `ICD` entry-trigger alias below, without
    // which the extractor was never consulted.
    namedExtractor:
      /(?:\btrip\s*time\b|\btryptoid\b|\btriptan\b)[^∞]{0,40}?(\d+(?:\.\d+)?)\s*(?:m\s*s|millisecond|milliseconds)\b/i,
    acceptsBareValue: false,
    volunteeredOnly: true,
    countsTowardCancelTally: false,
  },
  {
    field: 'rcd_bs_en',
    kind: 'bs_code',
    label: 'BS number',
    question: "What's the BS number of the RCD? Or do you want to fill that in later?",
    parser: parseBsCode,
    namedExtractor: /\bBS(?:\s*EN)?\s*(\d{4,5}(?:[-\s]*\d)?)/i,
    acceptsBareValue: true,
    // Defer answer: when the inspector says "fill later" / "later" /
    // "skip" in response to this ask, the engine clears the script
    // and marks the per-session, per-circuit RCD asks as deferred so
    // the 60s ring-style re-ask watchdog (if any) doesn't keep
    // nagging. See engine.js's defer branch for the parser + state
    // update. The hint is built into the question text so the
    // inspector knows the escape hatch exists without needing a
    // tutorial.
    acceptsDeferAnswer: true,
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
    // Audit-2026-06-02 Phase 4 — same RCD-context tightening as
    // rcbo.js. Keeps standalone-RCD walkthroughs symmetric with the
    // RCBO walkthrough on rcd_type capture semantics; without it the
    // pre-Phase-4 regex would still false-match "Type B" inside an
    // RCD walkthrough (technically OK because the slot IS rcd_type
    // there, but routes a curve letter to a waveform field). See the
    // rcbo.js block for the per-group rationale.
    namedExtractor:
      /\b(?:RCD\s+(?:waveform\s+)?type|residual(?:\s+current)?\s+(?:device\s+)?type|waveform\s+type)\s*(AC|[AFB]|S)\b|\btype\s*(AC)\b|^\s*(AC)\s*\.?\s*$/i,
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
  // RCD when the user really wanted RCBO. The optional "trip time"
  // alternative lets the script enter on the natural "RCD trip time
  // for the cooker is 25 ms." utterance — without it, that utterance
  // matched but the entry parser couldn't harvest "25 ms" because
  // `rcd_trip_time` wasn't a slot.
  //
  // `ICD` — Deepgram garble of "RCD" (field session 6B6FE011 F8:
  // "ICD trip time"). Without it the utterance never entered the
  // schema at all and fell through to Sonnet. Same enumerated-alias
  // class as `tryptoid` below — a specific field-evidenced garble,
  // NOT broad fuzzy matching. Non-capturing so group 1 stays the
  // circuit ref (reparseSingleCompleteReading and the entry parser
  // both read m[1] as the circuit number).
  /\b(?:RCD|ICD)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
];

const cancelTriggers = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|scrap(?:\s+(?:that|this))?|forget\s+(?:it|that|this)|never\s+mind|abort)\b/i,
];

const skipSlotTriggers = [
  /\b(?:don'?t\s+know|no\s+idea|leave\s+(?:it\s+)?blank|blank|pass|next\s+one|skip\s+(?:this|that|it|one))\b/i,
];

// "fill later" / "later" / "come back to it" — defer the whole RCD
// script for this circuit (NOT just one slot). Only fires when the
// current slot has `acceptsDeferAnswer: true` (presently only
// rcd_bs_en). Differs from skipSlotTriggers, which blanks ONE slot
// and moves on. Differs from cancelTriggers, which announces "RCD
// cancelled. N of M saved." — defer announces "Okay, I'll come back
// to that later." The inspector's volunteered values (e.g.
// rcd_trip_time written at entry) stay in the snapshot; only the
// remaining unfilled slots are abandoned.
//
// Phrasings deliberately scoped to defer-intent verbs / adverbs;
// the acceptsDeferAnswer gate at the slot level ensures these only
// fire when the inspector is replying to the BS-number prompt, so
// stray matches elsewhere in the script cannot trigger.
//
// 2026-05-31 widening (session E8C6B716 — inspector heard a
// repeating BS-number ask, attempted to defer four ways: "you
// filled in.", "in later.", and the failures landed in CloudWatch
// as `ask_user_answered_routed_to_engine` events the engine
// silently re-asked because none of the regexes matched). Two
// additions:
//   - bare "later" anchor relaxed from the ENTIRE reply to a leading
//     prefix (≤ 2 lead words) so Deepgram's "in later.", "and later",
//     "uh later." also defer. The 2-word lead bound keeps
//     unrelated sentences containing "later" from accidentally
//     deferring ("I'll deal with that later, but right now the BS
//     is 60898" still fails — three+ leading words).
//   - "leave it" / "leave that" — common Deepgram form, sometimes
//     mis-heard as "leve it" / "we'd it" / "you filled in" /
//     "leave it for later". Anchored to short replies (≤ 30 chars)
//     so it cannot fire inside a regular sentence. "fill it in"
//     and "filled in" included as the most-common garbles of "fill
//     it in later" where Deepgram dropped the trailing "later".
//
// Background: 2026-05-29 PLAN_v4 chose to leave inspectors with
// silence when the gate blocks a reply rather than panic-ask. But
// when the ENGINE itself can't recognise a defer phrasing, the
// alternative is far worse — inspector hears the same prompt every
// 6 seconds and rage-quits the session (E8C6B716 ended at "Oh,
// fuck off." then "I give up. Stop."). Better to defer too eagerly
// at this slot than to loop.
const deferTriggers = [
  // Verb-prefix + "later" patterns. Filler between the verb and
  // "later" is bounded (≤ 20 chars, no digits) so the regex can't
  // accidentally span a sentence.
  /\bfill\s+[^\d?!]{0,20}?later\b/i,
  /\bdo\s+[^\d?!]{0,15}?later\b/i,
  /\b(?:come\s+)?back\s+[^\d?!]{0,20}?later\b/i,
  // Leading-"later" variants — entire reply OR ≤ 2 lead words +
  // "later" + optional terminal punctuation. Catches "later.",
  // "in later.", "and later.", "uh later." but NOT "I'll deal with
  // that later, but right now ..." (3+ lead words).
  /^\s*(?:\S+\s+){0,2}later[.!?,]?\s*$/i,
  // Short-reply "leave it" / "leave that" — and the common Deepgram
  // garble "filled in" / "filed in" for the post-prompt deferral
  // form ("fill it in [later]" with the trailing time-word dropped).
  // Bounded to ≤ 30 chars total so this cannot match inside a
  // longer recorded value or observation sentence. Trailing tail
  // bumped to 20 chars to admit "leave it for later." / "leave that
  // until later." while still rejecting full sentences.
  /^.{0,30}\b(?:leave\s+(?:it|that|them|those)|fil(?:l(?:ed)?|ed)\s+(?:it\s+)?in|skip\s+(?:for|until)\s+later)\b.{0,20}$/i,
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
  deferTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-rcd',
  extractionSource: 'rcd_script',
  logEventPrefix: 'stage6.rcd_script',
  whichCircuitQuestion: 'Which circuit is the RCD for?',
  cancelMessage: ({ filled, total }) => `RCD cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'RCD cancelled.',
  deferMessage: "Okay, I'll come back to that later.",
  finishMessage: ({ values }) => {
    const bs = values.rcd_bs_en ?? '?';
    const type = values.rcd_type ?? '?';
    const ma = values.rcd_operating_current_ma ?? '?';
    return `Got it. ${bs}, type ${type}, ${ma} mA.`;
  },
  // Post-completion bulk-apply prompt (2026-05-21, fix B slice 3).
  // When BS / type / mA are all filled, the engine emits this prompt
  // BEFORE finishing the script. Reply parses via parseCircuitRange;
  // applies the listed `fields` to the chosen circuits (creating
  // blank circuits for unknown numbers per user direction). Trip time
  // is NOT in `fields` because it's a per-circuit reading.
  postCompletionAsk: {
    question: "Apply these RCD details to any other circuits? Say 'all' or a range like '1 to 6'.",
    fields: ['rcd_bs_en', 'rcd_type', 'rcd_operating_current_ma'],
    fieldsLabel: 'RCD',
  },
};
