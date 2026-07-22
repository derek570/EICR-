/**
 * Ring continuity schema for the dialogue engine. Replaces the
 * imperative ring-continuity-script.js.
 *
 * Slots: R1 (lives) → Rn (neutrals) → R2 (CPC), in that order.
 * Inspector dictates "ring continuity for circuit N" then values land
 * via named-field ("lives are 0.43") or bare-value-on-expected-slot
 * ("0.43" while R1 is the asked-for slot).
 *
 * Wire shape, log event names, and tool-call-id prefix are preserved
 * byte-identically to the legacy script — verified by the replay
 * corpus and the existing 100-test ring suite.
 */

import { parseOhms } from '../parsers/ohms.js';
import {
  RING_FIELDS,
  recordRingContinuityWrite,
  clearRingContinuityState,
} from '../../ring-continuity-timeout.js';

// Value-alternation matches the legacy script's pattern exactly,
// including the sentinel words ("infinite", "open", etc). The parser
// (parseOhms) returns null on those sentinels — meaning they capture
// in the regex but don't write — which is the existing tested
// behaviour. Restoring the sentinels' write semantics is out of PR1
// scope; the byte-identical replay corpus depends on this match.
const RING_VALUE_GROUP = '\\d*\\.?\\d+|infinite|open|discontinuous|infinity';

// KNOWN LIMITATION (orig. 2026-05-21 session 293F074F; "dead code" claim
// corrected 2026-06-16): this schema IS the live ring-continuity path
// (sonnet-stream.js → dialogue-engine/index.js → engine.js + this schema;
// the legacy `ring-continuity-script.js` survives only as the
// replay-corpus reference). The legacy script was bidirectional-fixed to
// catch value-first phrasings ("0.21 on the lives"); the directional
// namedExtractor below has NOT been ported, so value-first ring phrasing
// still falls through to Sonnet. To close it: port the bidirectional
// pattern from `extractNamedFieldValues` in ring-continuity-script.js and
// either accept a second capture group in `helpers/extraction.js` or add
// a `namedExtractorMirror` field per slot. (Out of scope for F1AC26FB.)
const slots = [
  {
    field: 'ring_r1_ohm',
    label: 'lives',
    question: 'What are the lives?',
    parser: parseOhms,
    // `r\s*1` alias added 2026-06-25 (field session 6674E8C5): the loop
    // read-back speaks "R1 …, Rn …, R2 …", so inspectors correct in that
    // vocabulary ("Your RN is 1.35"). Without the abbreviation the amend
    // gate matched nothing and the first correction was dropped, costing two
    // wasted Sonnet round-trips. `r\s*1` also matches "r1"/"r 1" — mirrors
    // the existing c\s*p\s*c spacing tolerance for Deepgram.
    namedExtractor: new RegExp(`\\b(?:lives?|r\\s*1)\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`, 'i'),
    acceptsBareValue: true,
  },
  {
    field: 'ring_rn_ohm',
    label: 'neutrals',
    question: 'What are the neutrals?',
    parser: parseOhms,
    namedExtractor: new RegExp(
      `\\b(?:neutrals?|r\\s*n)\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`,
      'i'
    ),
    acceptsBareValue: true,
  },
  {
    field: 'ring_r2_ohm',
    label: 'CPC',
    question: "What's the CPC?",
    parser: parseOhms,
    namedExtractor: new RegExp(
      `\\b(?:earths?|cpc|c\\s*p\\s*c|r\\s*2)\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`,
      'i'
    ),
    acceptsBareValue: true,
  },
];

const triggers = [
  // Pattern 1 ("full") matches "ring/bring/wing continuity/final" with an
  // optional circuit number anywhere within ~50 characters of the trigger
  // phrase. The "bring" / "wing" alternation tolerates Deepgram's habit of
  // misrendering the leading "r" sound — field repros: 2026-04-30 sessions
  // 2801896A ("Bring continuity for upstairs sockets") and BD8AB009 ("Wing
  // continuity for upstairs sockets"). Same garble class as the
  // (?:insulation|installation) alternation in the IR schema.
  //
  // `re-?continuity` (P1 ring-script-hardening, 2026-07-22, session
  // B4C45F25): Flux renders "ring continuity" as "recontinuity" /
  // "re-continuity". A SEPARATE EXACT alternative — deliberately NOT
  // `re-?continuit\w*` (an open suffix would exceed the enumerated-garbles
  // scope; §3E bans fuzzy widening). Circuit stays capture group 1.
  /\b(?:(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)|re-?continuity)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // Pattern 2 ("terse") matches "ring on circuit N" with optional leading filler.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\b(?:ring|bring|wing)\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,
];

// P1 ring-script-hardening (2026-07-22, session B4C45F25 feedback 90):
// destructive/corrective verbs ONLY. The engine's per-schema entry guard
// skips script entry when this matches, so "Can you delete the readings for
// the ring continuity on circuit 13" falls through to Sonnet (which owns
// clear_reading) instead of being hijacked into an all-filled confirmation.
// Explicitly NO `why`/`didn't`/`haven't`/`stop` and NO denial phrases —
// question-form entries must keep working: field evidence shows "Why
// haven't you added the ring continuity to circuit 17?" usefully entered
// the script and recovered the user. (Decision confirmed by Derek
// 2026-07-22: destructive verbs only.)
const entryExclusionPattern = /\b(delete|undo|remove|clear|cancel|fix)\b/i;

// Confirmation-mode delete/clear INTENT (distinct from entryExclusionPattern
// — do NOT merge them: this one requires an OBJECT so bare "cancel that"
// still routes to the preserve-and-exit cancel path, and `fix` stays
// available for amendment fallthrough). Ordered proximity: the destructive
// verb must PRECEDE the object within the same clause — bare co-occurrence
// must NOT match, otherwise the natural positive confirm "Yeah, all clear."
// (verb "clear" + object "all", wrong order) would hijack into a delete
// exit. Evaluated at position 1 of the engine's canonical
// awaiting_confirmation decision order.
const confirmationClearIntentPattern =
  /\b(delete|remove|clear|undo|cancel)\b[^.?!]{0,40}?\b(readings?|values?|them|all)\b/i;

const cancelTriggers = [
  /\b(?:cancel|stop(?:\s+(?:that|this))?|skip(?:\s+(?:this|that|ring|continuity))?|scrap(?:\s+(?:that|this|ring|continuity))?|forget\s+(?:it|that|this)|never\s+mind|abort|ignore\s+(?:that|this))\b/i,
];

const topicSwitchTriggers = [
  /\b(?:zs|z\s*s|ze|z\s*e)\s+(?:is|=|of|at)\b/i,
  /\bcircuit\s+\d+\s+is\b/i,
  // R1+R2 — the composite r1_r2_ohm reading. Accept both literal "+" and
  // the spoken "plus" form, since Deepgram normalises spoken "plus" to
  // the word "plus" rather than the symbol. Field repro: 2026-04-30
  // session BD8AB009 ("R1 plus R2 is 47") wrote "1" to ring_r2_ohm
  // because the topic switch missed and the ohms parser ate the "1"
  // from "R1".
  /\bR\s*1\s*(?:\+|\s+plus\s+)\s*R\s*2\b/i,
  /\binsulation\s+resistance\b/i,
  /\bRCD\s+(?:trip|test|time)\b/i,
  /\bpolarity\b/i,
  // C2 (2026-06-19, session AD0AE9FA #35): an explicit observation lead-in
  // ("observation"/"observation note"/"obs"/"make a note", plus the Deepgram
  // garble "observant") while a ring-continuity loop is still active must EXIT
  // the loop (topic switch → partials saved → transcript falls through to
  // Sonnet, which records the observation per RULE 1a). Before this, a bare
  // "observation." at 06:18:38 was EATEN by the still-active ring script AND
  // re-entered it, enqueuing a "Got it" pseudo-question that never presented —
  // the kickoff for the Group A AlertManager pump lockout. Kept in sync with
  // the legacy ring-continuity-script.js TOPIC_SWITCH_PATTERNS for replay parity.
  /\b(?:observ\w*|obs|make\s+a\s+note)\b/i,
];

// End-of-loop confirmation (2026-05-26). After all three slots fill,
// the engine asks "R1 X, Rn Y, R2 Z. All correct?" instead of
// finishing immediately so the inspector can amend a Deepgram-garbled
// reading. Mirrors the legacy `ring-continuity-script.js` confirmation
// flow byte-for-byte — same question text, same `confirm_ring_continuity`
// reason on the wire, same positive-vocabulary detector.
function buildRingContinuityConfirmation({ values }) {
  const r1 = values.ring_r1_ohm ?? '?';
  const rn = values.ring_rn_ohm ?? '?';
  const r2 = values.ring_r2_ohm ?? '?';
  return `R1 ${r1}, Rn ${rn}, R2 ${r2}. All correct?`;
}

function detectRingContinuityPositive(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\b(?:yes|yeah|yep|yup|ok(?:ay)?|correct|confirm(?:ed)?|all\s+(?:correct|good|right)|that's\s+(?:correct|right))\b/i.test(
    text
  );
}

export const ringContinuitySchema = {
  name: 'ring_continuity',
  triggers,
  entryExclusionPattern,
  confirmationClearIntentPattern,
  cancelTriggers,
  topicSwitchTriggers,
  slots,
  hardTimeoutMs: 180_000,
  toolCallIdPrefix: 'srv-rcs',
  extractionSource: 'ring_script',
  logEventPrefix: 'stage6.ring_continuity_script',
  whichCircuitQuestion: 'Which circuit is the ring continuity for?',
  cancelMessage: ({ filled, total }) => `Ring continuity cancelled. ${filled} of ${total} saved.`,
  cancelMessageEmpty: 'Ring continuity cancelled.',
  // #34 (2026-06-19, session AD0AE9FA, build 404): completion ack must be
  // terse. The confirmation prompt above ("R1 X, Rn Y, R2 Z. All correct?")
  // ALREADY read the triple aloud, so re-reading the same three values on the
  // "yes" completion made the inspector hear the readout twice (double
  // read-back, violating the audio-first "read back exactly once" invariant).
  // Drop the value re-read; "Got it." is the acknowledgement the user just
  // approved. Kept byte-identical with the legacy ring-continuity-script.js
  // finishScript text so dialogue-engine-replay.test.js parity holds.
  finishMessage: () => 'Got it.',
  // 2026-05-26: confirmation gate. When the engine sees all slots
  // filled, it emits `confirmationMessage(values)` as an
  // `ask_user_started` (reason `confirmation.reason`) instead of
  // finishing. The next turn runs through the engine's confirmation
  // branch which routes positive replies to finishScript and
  // named-field replies to overwrite-and-re-emit.
  confirmation: {
    reason: 'confirm_ring_continuity',
    buildMessage: buildRingContinuityConfirmation,
    detectPositive: detectRingContinuityPositive,
    // ── P1 ring-script-hardening (2026-07-22) confirmation-correction API.
    // The engine's confirmation branch stays schema-generic; ring supplies
    // the wordings + matchers. Every rendered prompt string is pinned in
    // tests and must stay full-string distinct from the four apology/notice
    // families (client 30s text-keyed dedupe — see Audio-First check).
    negationReason: 'confirm_ring_continuity_correction',
    negationReask: 'Which value is wrong — R1, Rn or R2?',
    // The no-pending post-reset negation alternate: spoken when a SECOND
    // negation arrives after slot-selection reset the counter but the
    // per-episode reask flag is already set — a byte-identical repeat of
    // negationReask would be swallowed by the client dedupe (feedback 91).
    negationReaskAlternate: 'Sorry — tell me which reading to change, or say the corrected value.',
    // Cap exit is a function, not a literal — it interpolates the circuit.
    negationCapExit: ({ circuit_ref }) =>
      `Okay — leaving the ring readings for circuit ${circuit_ref} as they are; say the correction when ready.`,
    // Slot-name-only selectors: anchored to the WHOLE reply modulo an
    // optional leading affirmation/negation token, so "R1.", "No, R1" and
    // "Okay, R1" all select while "circuit 13" and value-bearing replies
    // never do. The labels drive the generated "What should <label> be?" /
    // "I still need a number for <label> — what should it be?" prompts.
    slotSelectors: [
      {
        field: 'ring_r1_ohm',
        selector: /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*1|lives?)\s*[.!?]?\s*$/i,
        label: 'R1',
      },
      {
        field: 'ring_rn_ohm',
        selector: /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*n|neutrals?)\s*[.!?]?\s*$/i,
        label: 'Rn',
      },
      {
        field: 'ring_r2_ohm',
        selector:
          /^\s*(?:(?:no|nope|nah|okay|ok)[,.\s]+)?(?:r\s*2|earths?|cpc|c\s*p\s*c)\s*[.!?]?\s*$/i,
        label: 'R2',
      },
    ],
    // Anchored pending-slot VALUE matcher — the pending-slot write fires
    // ONLY on this whole-reply shape (never the unrestricted slot parser:
    // parseOhms returns the first numeric token ANYWHERE — "R1."→1,
    // "circuit 13"→13 — silent corruption). Tightly-bounded answer fillers
    // (repeats {0,2} so the compound "No, it's 0.85" writes) + optional ohm
    // unit; leading-dot form included because Deepgram renders spoken
    // "point four three" as ".43" and parseOhms zero-normalises it.
    // Sentinel spellings deliberately NOT added (future wave owns that).
    pendingValuePattern:
      /^\s*(?:(?:no|nope|nah|it's|its|it\s+is)[,.\s]+){0,2}(\d{1,3}(?:\.\d{1,3})?|\.\d{1,3})\s*(?:ohms?)?\s*\.?\s*$/i,
  },
  // Sync the 60s timeout module's per-circuit timestamp on every write
  // so its findExpiredPartial sees an up-to-date last-turn-at.
  onWrite: (session, circuit_ref, now) => recordRingContinuityWrite(session, circuit_ref, now),
  // On finish, clear the timeout module's state — bucket is full, no
  // partial-fill watcher needed.
  onFinish: (session, circuit_ref) => clearRingContinuityState(session, circuit_ref),
  // Canonical fields list for downstream introspection.
  fieldOrder: RING_FIELDS,
};
