// Pre-LLM transcript gate.
//
// Blocks transcripts that have no chance of producing useful extraction
// — typically single-word filler ("Yeah.", "No.", "Hello?") or
// background-chatter fragments — BEFORE they reach Sonnet.
//
// Background: field session 33E6613D-49A7-4B42-A73B-1E2C6A82174D
// (2026-05-26) burnt ~£0.30 of Sonnet+TTS on 14 such transcripts
// across 100s of inspector-adjacent conversation. The model panic-asks
// "Sorry, I didn't catch that…" 6 times in 31 seconds, none of which
// the inspector ever answered. The 2500 ms QuestionGate debounce did
// not catch it because the model's emit rate (~5 s/turn) sits just
// above the gate window.
//
// 2026-05-29 PLAN_v4 tightening — observation-gated architecture.
// User direction: observations are gated behind the explicit keyword
// "observation" (and Deepgram garbles); damage-adjective utterances
// like "socket cracked" no longer forward without that prefix. This
// collapses the original 94-word trigger list into:
//   - STRONG_TRIGGER_WORDS (~20) — measurement abbreviations,
//     equipment abbreviations, state-change verbs; forward alone.
//   - OBSERVATION_PATTERN — fuzzy regex matching "observation" +
//     Deepgram garbles; forwards alone with reason
//     HAS_OBSERVATION_PREFIX.
//   - WEAK_TRIGGER_WORDS (~75) — room/appliance/navigation/generic
//     words; no forward authority alone, still feed the distinct-
//     content-word count.
//
// Forward decision order:
//   1. !gateEnabled                          → forward (BYPASS_DISABLED)
//   2. drainedRetry                          → forward (BYPASS_DRAINED_RETRY)
//   3. hasPendingAsk                         → forward (BYPASS_PENDING_ASK)
//   4. hasActiveDialogueScript               → forward (BYPASS_DIALOGUE_SCRIPT_ACTIVE) [2026-05-31]
//   5. inResponseTo                          → forward (BYPASS_IN_RESPONSE_TO)
//   6. regexResults non-empty                → forward (HAS_REGEX_HINT)
//   7. text empty                            → block   (EMPTY)
//   8. hasDigit                              → forward (HAS_DIGIT)
//   9. OBSERVATION_PATTERN match             → forward (HAS_OBSERVATION_PREFIX)
//  10. hasStrongTrigger                      → forward (HAS_STRONG_TRIGGER)
//  11. hasWeakTrigger                        → forward (HAS_WEAK_TRIGGER) [2026-05-29]
//  12. else                                  → block   (LOW_CONTENT)
//
// 2026-05-31 — BYPASS_DIALOGUE_SCRIPT_ACTIVE. The dialogue engine's
// RCD / OCPD / RCBO / IR / ring-continuity walk-throughs emit TTS
// questions ("What's the BS number? Or do you want to fill that in
// later?") via the server-side script path (`srv-rcd`/`srv-ocpd`/…
// tool-call-id prefixes) which NEVER register in `entry.pendingAsks`
// (sonnet-stream.js:~1429 — these are server-driven, not Sonnet
// `ask_user` calls). Pre-2026-05-31 the gate had no signal that a
// script was awaiting an answer, so terse replies like bare "later"
// failed the weak-trigger + content threshold and never reached
// engine.js's defer branch (rcd.js:144-149 deferTriggers includes
// `^\s*later[.!?]?\s*$`). Field repro: inspector replies "later" to
// the RCD BS-number ask, gate blocks with LOW_CONTENT, engine never
// sees the reply, RCD focus persists past the inspector's intent to
// defer. Fix: surface `session.dialogueScriptState?.active` to the
// gate as `hasActiveDialogueScript`; when a script owns the floor,
// every utterance forwards regardless of length so the engine's
// defer / skip / cancel / topic-switch parsers get a chance to fire.
//
// 2026-05-29 — dropped the "≥3 distinct content words" fallback. Field
// session 1FBAE6E0 (Build 385 chitchat test): "Can I use the toilet,
// please?" passed FALLBACK_FORWARD (6 content words), reached Sonnet,
// got a "No toilet facilities here, I'm afraid!" reply. The inspector
// expected silence. Pure content-word counting let any conversational
// English through; the new policy requires an inspection-domain
// trigger (digit / strong / observation / weak vocab) for forward
// authority. "Lights are radial" still passes (weak: lights+radial).
// "Hello my name is Michael McGinley" still blocks (no trigger).
//
// Telemetry: each block emits `voice_latency.gate_blocked` with the
// reason; the user experience is silence — no canned TTS, no audio
// cue. Inspector-facing rationale: if you said something real and
// the agent didn't react, repeat it; otherwise carry on. Adding TTS
// feedback here would re-introduce the panic-ask pattern the gate
// exists to prevent.

// =============================================================================
// STRONG_TRIGGER_WORDS — 20 words, forward alone
// =============================================================================
// Words whose appearance reliably indicates an extraction-worthy utterance.
// Triggering on these alone is safe; in production this is almost always
// followed by a value or is itself a state-change command.
//
// Composition: 18 promoted/kept from the original 94-word trigger list +
// 2 explicit additions (afdd, r1r2) justified inline below.
const STRONG_TRIGGER_WORDS = new Set(
  [
    // Test field abbreviations.
    'zs',
    'ze',
    'pfc',
    'psc',
    'ipfc',
    'r1',
    'r2',
    // Equipment abbreviations — inspector-only acronyms; near-zero false-
    // positive in everyday speech.
    'mcb',
    'rcd',
    'rcbo',
    'spd',
    // Test concepts — always paired with values in real usage; bare word
    // appears in inspector context.
    'polarity',
    'continuity',
    'insulation',
    // State-change verbs that map to existing Sonnet tools.
    'delete',
    'remove',
    // Specialist abbreviation promoted (was in original WEAK list at line
    // 71; FCU = fused connection unit, narrow inspector vocabulary).
    'fcu',
    // Justified additions (not in original 94):
    //   afdd — 4-letter equipment abbreviation, follows MCB/RCD/RCBO
    //          cluster, near-zero everyday false-positive
    //   cpc  — circuit protective conductor; specialist inspector vocab
    //          that's unambiguous out of context ("CPC discontinuous")
    //
    // Note: 'r1r2' as a compact form was considered but is redundant —
    // any 'r1r2' string contains digits, so HAS_DIGIT fires first.
    'afdd',
    'cpc',
  ].map((w) => w.toLowerCase())
);

const STRONG_TRIGGER_REGEX = new RegExp(
  `\\b(${[...STRONG_TRIGGER_WORDS].map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i'
);

// =============================================================================
// OBSERVATION_PATTERN — fuzzy regex for "observation" + Deepgram garbles
// =============================================================================
// Matches the explicit `observation` keyword and recognised Deepgram garbles.
// Deliberately STRICT — verb forms (observe/observed/observing/observer) are
// NOT matched per user Q2 2026-05-29 directive. Inspector must say
// "observation" (or a recognised garble of it).
//
// Decomposition: /ˌɒb.zəˈveɪ.ʃən/ → ob-zer-vey-shun. Each syllable is
// independently mis-transcribable, so the regex tolerates each axis.
//
// Structure:
//   - First branch: 'obs' alone (truncation form inspectors use as shorthand)
//   - Second branch: [oa]? b [a-z]{0,5} v [a-z]{0,4} <suffix> s?
//     - [oa]? — optional initial vowel (handles 'b-only' and 'ab-' prefixes)
//     - b      — required (anchors the ob-/ab- prefix)
//     - [a-z]{0,5} — 0-5 letters between b and v (handles obs/obz/obser/obstr/...)
//     - v      — required (anchors mid-syllable)
//     - [a-z]{0,4} — 0-4 letters between v and suffix
//     - Suffix alternation: tion|sion|shun|shen|shan|shon|nce|tor|tior|ation
//     - s?     — optional plural
//
// Verified matches (Node test 2026-05-29):
//   observation, observations, obs, observance, obvashon, abservation,
//   obviation, obstervation, obvashen, observatior
//
// Verified rejects:
//   observe, observed, observing, observer, obstruction, operation,
//   objection, obsession, aviation, obvious, absurd, absorb, obscure,
//   obesity, obscene
//
// Accepted false positive:
//   abbreviation — rare in inspector speech; cost = 1 Sonnet round
//   (~$0.005-0.013) per occurrence.
export const OBSERVATION_PATTERN =
  /\b(?:obs|[oa]?b[a-z]{0,5}v[a-z]{0,4}(?:tion|sion|shun|shen|shan|shon|nce|tor|tior|ation))s?\b/i;

// =============================================================================
// WEAK_TRIGGER_WORDS — 82 words; forward when paired with the distinct-
// content-word threshold (3, or 2 for the cert-identity markers)
// =============================================================================
// Originally the demoted remainder of the 94-word list (no forward authority
// alone). Since 2026-05-29 a weak-trigger hit + the content threshold IS the
// forward path (HAS_WEAK_TRIGGER); 2026-06-12 added 7 cert-identity dictation
// markers with a lowered threshold of 2 (see CERT_IDENTITY_TRIGGER_REGEX).
const WEAK_TRIGGER_WORDS = new Set(
  [
    // Circuit and board nouns
    'circuit',
    'circuits',
    'board',
    'boards',
    'ring',
    'socket',
    'sockets',
    'lights',
    'light',
    // Appliance designations
    'shower',
    'cooker',
    'oven',
    'hob',
    'heater',
    'immersion',
    'spur',
    // Room names
    'kitchen',
    'lounge',
    'living',
    'bedroom',
    'bedrooms',
    'bathroom',
    'hallway',
    'garage',
    'utility',
    'loft',
    'attic',
    'landing',
    // Smoke / alarm
    'smoke',
    'alarm',
    // Generic electrical descriptors
    'radial',
    'main',
    'sub-main',
    'submain',
    'fuse',
    'trip',
    'breaker',
    // Generic conductor terms — ring-continuity language always includes
    // digits ('lives 0.32', 'neutrals are 0.41'), so HAS_DIGIT catches
    // those even without 'live'/'neutral' as a strong trigger.
    'live',
    'neutral',
    'protective',
    'conductor',
    'cable',
    'wiring',
    'colour',
    'color',
    // Observation / safety language — DEMOTED to WEAK per 2026-05-29
    // user Q3 directive. The explicit `observation` keyword (matched by
    // OBSERVATION_PATTERN above) is the sole gate trigger for the
    // observation flow. `observe` is intentionally not in
    // OBSERVATION_PATTERN per Q2 strictness.
    'observe',
    'defect',
    'issue',
    'crack',
    'cracked',
    'burn',
    'burnt',
    'damage',
    'damaged',
    'missing',
    'exposed',
    'loose',
    'corroded',
    'earth',
    'bond',
    'bonding',
    // Navigation / UI commands
    'note',
    'record',
    'fill',
    'add',
    'move',
    'next',
    'previous',
    'done',
    'finish',
    'skip',
    // Confirmation / inspection vocabulary
    'confirm',
    'correct',
    'overall',
    'summary',
    'inspection',
    // Cert identity / address dictation markers — 2026-06-12 field report
    // (session 15B88D6B, voiceFeedbackId 20): "Customer is Michael Johnson"
    // has no digit, no strong trigger, and no weak trigger, so every spoken
    // correction of a truncated client_name was blocked at LOW_CONTENT and
    // the inspector could never fix the field by voice. These words mark
    // certificate dictation ("customer is X", "client address is Y") rather
    // than conversational English — bare 'name' stays OUT of the list so
    // "Hello my name is Michael McGinley" (the 2026-05-29 chitchat case
    // above) still blocks. Mirrored in the iOS TranscriptGate weakTriggers
    // (DeepgramRecordingViewModel.swift) — keep the two lists in sync.
    'customer',
    'client',
    'landlord',
    'tenant',
    'occupier',
    'address',
    'postcode',
  ].map((w) => w.toLowerCase())
);

// =============================================================================
// Legacy TRIGGER_WORDS / TRIGGER_REGEX — preserved for back-compat
// =============================================================================
// Used by:
//   - existing _internals export consumers (none in-repo besides tests)
//   - any external dashboard reading the GATE_REASONS.HAS_TRIGGER value
//
// Built as the union of STRONG + WEAK + the literal `observation` token so
// the legacy "any of these words triggers" mental model still resolves
// completely. Not used by the new shouldForwardToSonnet logic.
const TRIGGER_WORDS = new Set([...STRONG_TRIGGER_WORDS, ...WEAK_TRIGGER_WORDS, 'observation']);

const TRIGGER_REGEX = new RegExp(
  `\\b(${[...TRIGGER_WORDS].map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i'
);

// 2026-05-29 — dedicated weak-trigger regex for the new
// HAS_WEAK_TRIGGER forward path. Built from WEAK_TRIGGER_WORDS only
// (no overlap with STRONG/observation), so a weak-word hit is the
// distinct signal that bypasses the previous content-word fallback.
const WEAK_TRIGGER_REGEX = new RegExp(
  `\\b(${[...WEAK_TRIGGER_WORDS].map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i'
);

const DIGIT_REGEX = /\d/;
const WORD_REGEX = /[A-Za-z']+/g;

// 2026-06-12 (session 15B88D6B, voiceFeedbackId 20) — cert-identity
// markers get a LOWER content threshold (2 instead of 3). "Customer is
// Michael" / "Client is Smith" carries exactly two content words
// (customer + michael — "is" is a stopword), so the standard threshold
// still silently blocked single-token name corrections even after the
// markers joined WEAK_TRIGGER_WORDS. The marker word itself counts as
// one of the two, so the floor is effectively "marker + one substantive
// token" — bare "Customer?" chitchat still blocks. Mirrored in the iOS
// TranscriptGate (DeepgramRecordingViewModel.swift).
const CERT_IDENTITY_TRIGGER_REGEX =
  /\b(?:customer|client|landlord|tenant|occupier|address|postcode)\b/i;
const MIN_DISTINCT_CONTENT_WORDS_IDENTITY = 2;

// 2026-06-23 (session DFCE2145, item #8) — earthing-system markers get the
// LOWEST content threshold (1). Field repro: "Supply is a TNCS.",
// "supply is TNCS.", "It is TNCS.", "I think it's TNCS." were ALL blocked
// at the iOS TranscriptGate / backend LOW_CONTENT — no digit, no strong
// trigger, no weak trigger ("supply"/"tncs" were absent from every list),
// and the short forms carry only ONE distinct content word ("it"/"is"/"a"
// are stopwords). A real earthing reading was silently dropped at the gate
// with no ASK (audio-first invariant #2 violation). The earthing-system
// classification is a structurally-complete reading, so once forwarded it
// is WRITTEN + read back — never asked. Threshold 1 (not 2) is required so
// the bare "TNCS." / "It is TNCS." shapes pass; the token itself is the
// single content word. Bare "supply" is deliberately NOT a trigger — that
// would wrongly forward "supply cupboard is locked"; "supply" only helps
// when an earthing token is also present (which already forwards on the
// token alone). MUST stay byte-for-byte in sync with the iOS TranscriptGate
// earthingTriggers (DeepgramRecordingViewModel.swift) — mistakes-log
// precedent on gate-list drift.
const EARTHING_TRIGGER_REGEX =
  /\b(?:tncs|tn[-\s]?c[-\s]?s|tn[-\s]?s|tns|tn[-\s]?c|tnc|tt|pme|earthing)\b/i;
const MIN_DISTINCT_CONTENT_WORDS_EARTHING = 1;

// Common-English stopwords. Deliberately small — the goal is to filter
// scaffolding words ("the", "is") so that the distinct-content-word
// count reflects whether there's any substantive subject in the text.
// Pronouns and short fillers count because a one-pronoun utterance
// ("Yeah.", "Hello?") has no extractable subject.
const STOPWORDS = new Set(
  'the a an of for to from on at in is was were am are be been by it its that this these those and or but not no yes uh um mm so just well now then there here whatever'.split(
    ' '
  )
);

const MIN_DISTINCT_CONTENT_WORDS = 3; // strict < this triggers block

export const GATE_REASONS = Object.freeze({
  EMPTY: 'empty',
  HAS_DIGIT: 'has_digit',
  HAS_OBSERVATION_PREFIX: 'has_observation_prefix',
  HAS_STRONG_TRIGGER: 'has_strong_trigger',
  // 2026-05-29 — new forward authority. Weak vocab (room/appliance/
  // navigation words) now passes the gate on its own; previously these
  // only counted toward the content-word fallback.
  HAS_WEAK_TRIGGER: 'has_weak_trigger',
  // 2026-05-29 PLAN_v4: HAS_TRIGGER value retained but no longer reachable
  // from the new logic. Kept in the enum so any external CloudWatch dashboard
  // filtering on `has_trigger` continues to parse cleanly. The distribution
  // will narrow to zero post-deploy.
  HAS_TRIGGER: 'has_trigger',
  HAS_REGEX_HINT: 'has_regex_hint',
  // PLAN-backend-final.md Phase 5.1 (2026-06-04) — explicit forward
  // authority for inspector complaints / negations. 3 of session
  // 60754E4D's 6 voiced frustrations dropped to LOW_CONTENT under the
  // old rules ("Why did you ask the b s number..." 15 words,
  // "No. That's not what I said." 3 words, "You haven't set it to LIM."
  // 4 words). The COMPLAINT_OR_NEGATION_PATTERN below catches all three
  // and forces the gate to forward so Sonnet can run a corrective turn.
  HAS_COMPLAINT_OR_NEGATION: 'has_complaint_or_negation',
  // 2026-06-23 (session DFCE2145, item #8) — earthing-system markers
  // (TNCS / TN-S / TT / PME / earthing). Forward at content threshold 1 so
  // a bare "It is TNCS." reaches the model and is WRITTEN + read back.
  HAS_EARTHING_SYSTEM: 'has_earthing_system',
  // A1 agentic-voice (2026-07-23) — under the VOICE_AGENTIC_ANSWERS master
  // flag, a would-be LOW_CONTENT block FORWARDS instead: every transcript
  // the server receives corresponds to a client chime already fired
  // (client gate PASS → chime → send), so a server-side content block is an
  // un-nettable beep-then-silence — the block returns before runShadowHarness
  // and the marker nets ever run. With borderline-forward, question detection
  // is the MODEL's job (Derek's verbatim ask): the server stays list-free
  // for questions permanently; the model answers via answer_user, no-ops
  // chatter (marker-① apologises per the confirmation toggle), or writes an
  // oddly-phrased reading. The gate's blocking economics also shifted: it
  // was built against Sonnet-priced turns (~$0.027); the live model is
  // Haiku 4.5 at ~1/10th with a cached prefix, and the measured server-side
  // blocked volume is ~1 turn/month (Phase 0.3, 2026-07-23).
  BORDERLINE_FORWARD: 'borderline_forward',
  LOW_CONTENT: 'low_content',
  FALLBACK_FORWARD: 'fallback',
  // Bypass reasons (always forward)
  BYPASS_PENDING_ASK: 'bypass_pending_ask',
  BYPASS_DIALOGUE_SCRIPT_ACTIVE: 'bypass_dialogue_script_active',
  BYPASS_IN_RESPONSE_TO: 'bypass_in_response_to',
  BYPASS_DRAINED_RETRY: 'bypass_drained_retry',
  BYPASS_DISABLED: 'bypass_flag_off',
});

// PLAN-backend-final.md Phase 5.1 — complaint / negation pattern.
// CRITICAL DESIGN POINT: the bare `no` token is NOT a top-level
// alternation. It only matches with a continuation pronoun /marker
// (`no, that...` / `no, I...` / `no wrong`). This is what keeps
// innocuous *"no problem"* / *"no signal"* / *"no spare"* off the
// forward path while catching *"No. That's not what I said."* and
// *"No, I didn't"*. The plan's negative-cases test pins this
// distinction explicitly.
//
// Other anchors:
//   - "that's not" / "that is not" — explicit denial
//   - "you haven't" / "you have not" — accuser frame
//   - "why (did|haven't|are|do|don't) you" — interrogative complaint
//   - "stop" / "stop it" — corrective imperative
//   - bare "wrong" / "incorrect" / "that's wrong" — value rejection
//   - "undo" / "cancel that" / "fix that" / "delete that" — corrective
//     imperatives that already forward via other paths but are
//     covered here too so the reason code is informative
//   - "i didn't say" — denial-of-prior-utterance
export const COMPLAINT_OR_NEGATION_PATTERN =
  /\b(no[,.]?\s+(that|that's|i|you|it|we|wrong|incorrect)|that's not|that is not|you haven't|you have not|why (did|haven't|are|do|don't) you|stop( it)?|wrong|incorrect|that's wrong|undo|cancel that|fix that|delete that|that's not right|i didn't say)\b/i;

// readback-correction-optionb §3.3 (2026-06-18) — STANDALONE bare negation.
// Audio-first: every applied reading is read back aloud, and the inspector
// rejects a wrong read-back by simply saying "no" / "nope" / "nah". That
// bare token was previously dropped to LOW_CONTENT (the complaint pattern
// above deliberately requires a continuation pronoun). Forward it so the
// live model — which now sees a rolling window of the read-backs it just
// spoke — can resolve the negation against the most recent read-back and
// ask for the replacement (Option B: never clear, only overwrite). This
// matches ONLY the WHOLE utterance being a bare negation (anchored
// ^…$), so "No earth.", "No problem", "No signal", "No spare" — which carry
// a content word — still fall through to the LOW_CONTENT path. Mirror this
// exact relaxation in the iOS TranscriptGate (Phase B).
export const STANDALONE_NEGATION_PATTERN = /^\s*(no|nope|nah)[.!?]*\s*$/i;

/**
 * Decide whether a transcript should be forwarded to Sonnet.
 *
 * @param {string} text Raw transcript text.
 * @param {object} [opts] Optional context.
 * @param {Array}  [opts.regexResults] iOS regex hits attached to the message.
 *                 Any non-empty array forces forward.
 * @param {boolean} [opts.hasPendingAsk] True if the session has unresolved asks.
 *                  When true the gate forwards unconditionally — the transcript
 *                  may be the inspector's answer to a question.
 * @param {boolean} [opts.hasActiveDialogueScript] True if a server-side dialogue
 *                  script (RCD / OCPD / RCBO / IR / ring-continuity walk-
 *                  through) is currently awaiting a reply. These asks bypass
 *                  the `pendingAsks` registry (they're not Sonnet `ask_user`
 *                  calls) so the gate needs a separate signal to know an
 *                  in-flight question is on the wire. When true, forward
 *                  unconditionally — the engine's defer / skip / cancel /
 *                  topic-switch parsers must get a chance to fire on every
 *                  reply, including terse ones ("later", "skip", "blank").
 * @param {boolean} [opts.inResponseTo] True if iOS tagged the transcript as
 *                  responding to a specific TTS question.
 * @param {boolean} [opts.drainedRetry] True if this is the replay path; never
 *                  re-gate a transcript we previously forwarded.
 * @param {boolean} [opts.gateEnabled] Master switch. When false the gate is a
 *                  no-op (returns forward + reason 'bypass_flag_off'). Defaults
 *                  to true; production wiring reads VOICE_PRE_LLM_GATE.
 * @param {boolean} [opts.agenticAnswersEnabled] A1 agentic-voice master flag
 *                  (VOICE_AGENTIC_ANSWERS, latched per session). When true, a
 *                  would-be LOW_CONTENT block FORWARDS as BORDERLINE_FORWARD
 *                  with `borderline: true` — the model decides what the turn
 *                  was. DEFAULTS TO FALSE (fail-closed): a session-absent turn
 *                  keeps legacy LOW_CONTENT routing, never throws. EMPTY is
 *                  unaffected — Phase 0.5 proved production clients cannot
 *                  produce an ordinary-path EMPTY after a chime.
 * @returns {{forward: boolean, reason: string, distinctContentWords?: number, borderline?: boolean}}
 */
export function shouldForwardToSonnet(text, opts = {}) {
  const {
    regexResults,
    hasPendingAsk = false,
    hasActiveDialogueScript = false,
    inResponseTo = false,
    drainedRetry = false,
    gateEnabled = true,
    agenticAnswersEnabled = false,
  } = opts;

  if (!gateEnabled) {
    return { forward: true, reason: GATE_REASONS.BYPASS_DISABLED };
  }
  if (drainedRetry) {
    return { forward: true, reason: GATE_REASONS.BYPASS_DRAINED_RETRY };
  }
  if (hasPendingAsk) {
    return { forward: true, reason: GATE_REASONS.BYPASS_PENDING_ASK };
  }
  if (hasActiveDialogueScript) {
    return { forward: true, reason: GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE };
  }
  if (inResponseTo) {
    return { forward: true, reason: GATE_REASONS.BYPASS_IN_RESPONSE_TO };
  }
  if (Array.isArray(regexResults) && regexResults.length > 0) {
    return { forward: true, reason: GATE_REASONS.HAS_REGEX_HINT };
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return { forward: false, reason: GATE_REASONS.EMPTY };
  }
  // PLAN-backend-final.md Phase 5.1 — complaint / negation BEFORE
  // HAS_DIGIT (deliberately). Complaints sometimes contain digits
  // accidentally (*"you set it to 0.45 but I said 0.55"*) and we want
  // the complaint-forward signal to WIN over the digit-forward path so
  // the reason field reflects the actual intent on the CloudWatch
  // dashboard. Per the plan negative-tests pin, the regex deliberately
  // requires a continuation pronoun after a bare "no" so innocuous
  // utterances ("no problem", "no signal", "no spare") still block via
  // the LOW_CONTENT path.
  if (COMPLAINT_OR_NEGATION_PATTERN.test(trimmed) || STANDALONE_NEGATION_PATTERN.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_COMPLAINT_OR_NEGATION };
  }
  if (DIGIT_REGEX.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_DIGIT };
  }
  // PLAN_v4 step 8 — observation pattern before strong trigger so explicit
  // observation utterances log with the cleaner reason code.
  if (OBSERVATION_PATTERN.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_OBSERVATION_PREFIX };
  }
  if (STRONG_TRIGGER_REGEX.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_STRONG_TRIGGER };
  }

  // 2026-05-29 — replaces the pure "≥3 distinct content words"
  // FALLBACK_FORWARD. New policy: forward only if the utterance has at
  // least one weak-trigger word (inspection vocabulary) AND meets the
  // content threshold. Pure-English chitchat ("Can I use the toilet,
  // please?" — 6 content words, 0 weak triggers) now blocks; damage-
  // only utterances ("Socket cracked." — 1 weak, 2 content) keep
  // blocking per the PLAN_v4 observation-gated design.
  const distinctContent = new Set();
  let match;
  WORD_REGEX.lastIndex = 0;
  while ((match = WORD_REGEX.exec(trimmed)) !== null) {
    const w = match[0].toLowerCase();
    if (w.length > 1 && !STOPWORDS.has(w)) {
      distinctContent.add(w);
    }
  }
  // 2026-06-23 item #8 — earthing-system markers forward at threshold 1
  // (the marker is the single content word). Checked before the weak path
  // so "It is TNCS." / "TNCS." (which carry no weak trigger and only one
  // content word) still forward, logged with the cleaner reason code.
  if (
    EARTHING_TRIGGER_REGEX.test(trimmed) &&
    distinctContent.size >= MIN_DISTINCT_CONTENT_WORDS_EARTHING
  ) {
    return {
      forward: true,
      reason: GATE_REASONS.HAS_EARTHING_SYSTEM,
      distinctContentWords: distinctContent.size,
    };
  }
  const hasWeak = WEAK_TRIGGER_REGEX.test(trimmed);
  const minContent = CERT_IDENTITY_TRIGGER_REGEX.test(trimmed)
    ? MIN_DISTINCT_CONTENT_WORDS_IDENTITY
    : MIN_DISTINCT_CONTENT_WORDS;
  if (hasWeak && distinctContent.size >= minContent) {
    return {
      forward: true,
      reason: GATE_REASONS.HAS_WEAK_TRIGGER,
      distinctContentWords: distinctContent.size,
    };
  }
  // A1 agentic-voice — borderline-forward. The terminal LOW_CONTENT drop
  // becomes a FORWARD when the session's master flag is on: the model (not a
  // server word-list) decides whether the turn was a question, an
  // oddly-phrased reading, or chatter. `borderline: true` lets the call site
  // log voice_latency.gate_borderline_forwarded without inferring from the
  // reason string.
  if (agenticAnswersEnabled === true) {
    return {
      forward: true,
      reason: GATE_REASONS.BORDERLINE_FORWARD,
      distinctContentWords: distinctContent.size,
      borderline: true,
    };
  }
  return {
    forward: false,
    reason: GATE_REASONS.LOW_CONTENT,
    distinctContentWords: distinctContent.size,
  };
}

export const _internals = Object.freeze({
  TRIGGER_WORDS,
  STRONG_TRIGGER_WORDS,
  WEAK_TRIGGER_WORDS,
  OBSERVATION_PATTERN,
  STOPWORDS,
  MIN_DISTINCT_CONTENT_WORDS,
});
