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
    namedExtractor: new RegExp(`\\blives?\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`, 'i'),
    acceptsBareValue: true,
  },
  {
    field: 'ring_rn_ohm',
    label: 'neutrals',
    question: 'What are the neutrals?',
    parser: parseOhms,
    namedExtractor: new RegExp(`\\bneutrals?\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`, 'i'),
    acceptsBareValue: true,
  },
  {
    field: 'ring_r2_ohm',
    label: 'CPC',
    question: "What's the CPC?",
    parser: parseOhms,
    namedExtractor: new RegExp(
      `\\b(?:earths?|cpc|c\\s*p\\s*c)\\b[^\\d∞]{0,30}?(${RING_VALUE_GROUP})`,
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
  /\b(?:ring|bring|wing)\s+(?:continu(?:ity|ance|ancy|ed|e)|final)\b(?:[^.?!]{0,50}?\bcircuit\s*(\d{1,3})\b)?/i,
  // Pattern 2 ("terse") matches "ring on circuit N" with optional leading filler.
  /^(?:\s*(?:so|right|ok(?:ay)?|now)[\s,]+)?\b(?:ring|bring|wing)\b[^.?!]{0,30}?\bcircuit\s*(\d{1,3})\b/i,
];

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
