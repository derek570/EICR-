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
// The rule is conservative on purpose — better to forward marginal
// text and waste a Sonnet turn than to silently drop a real reading
// and force the inspector to repeat. Block if and only if ALL of:
//   1. no digit anywhere in the text
//   2. no trigger word (field/circuit/board/action keyword)
//   3. no iOS regex hit attached to the message
//   4. ≤ 2 distinct alphabetic content words (excluding stopwords)
//
// Block-decision is bypassed when the session has a pending ask
// (the transcript might be the answer), when iOS tagged the
// transcript as `in_response_to` a TTS question, or when this is
// the drained-retry replay path. None of those should ever be
// silently dropped.
//
// Telemetry: each block emits `voice_latency.gate_blocked` with the
// reason; the user experience is silence — no canned TTS, no audio
// cue. Inspector-facing rationale: if you said something real and
// the agent didn't react, repeat it; otherwise carry on. Adding TTS
// feedback here would re-introduce the panic-ask pattern the gate
// exists to prevent.

const TRIGGER_WORDS = new Set(
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
    'shower',
    'cooker',
    'oven',
    'hob',
    // Room names that commonly anchor a circuit ref
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
    // Appliance + protection device terms
    'heater',
    'immersion',
    'smoke',
    'alarm',
    'spur',
    'fcu',
    'radial',
    'main',
    'sub-main',
    'submain',
    'spd',
    'rcd',
    'rcbo',
    'mcb',
    'fuse',
    // Observation language
    'observation',
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
    // Action verbs
    'note',
    'record',
    'fill',
    'add',
    'delete',
    'remove',
    'move',
    'next',
    'previous',
    'done',
    'finish',
    'skip',
    // Test-reading field shorthand
    'zs',
    'ze',
    'pfc',
    'psc',
    'ipfc',
    'r1',
    'r2',
    'continuity',
    'insulation',
    'polarity',
    'earth',
    'bond',
    'bonding',
    // Wiring / device language
    'trip',
    'breaker',
    'live',
    'neutral',
    'protective',
    'conductor',
    'cable',
    'wiring',
    'colour',
    'color',
    // Confirmation verbs that are meaningful even outside an ask
    // context (e.g. "confirm circuit 3 readings"). Bare "yes" / "no" /
    // "ok" intentionally NOT included — those only carry signal as
    // answers to an existing question, and the hasPendingAsk bypass
    // forwards them when an ask is open. Outside that bypass they're
    // background-conversation noise (8 of 11 blocks on session
    // 33E6613D were exactly that — see fixture set).
    'confirm',
    'correct',
    // Inspection vocabulary
    'overall',
    'summary',
    'inspection',
  ].map((w) => w.toLowerCase())
);

const TRIGGER_REGEX = new RegExp(
  `\\b(${[...TRIGGER_WORDS].map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`,
  'i'
);

const DIGIT_REGEX = /\d/;
const WORD_REGEX = /[A-Za-z']+/g;

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
  HAS_TRIGGER: 'has_trigger',
  HAS_REGEX_HINT: 'has_regex_hint',
  LOW_CONTENT: 'low_content',
  FALLBACK_FORWARD: 'fallback',
  // Bypass reasons (always forward)
  BYPASS_PENDING_ASK: 'bypass_pending_ask',
  BYPASS_IN_RESPONSE_TO: 'bypass_in_response_to',
  BYPASS_DRAINED_RETRY: 'bypass_drained_retry',
  BYPASS_DISABLED: 'bypass_flag_off',
});

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
 * @param {boolean} [opts.inResponseTo] True if iOS tagged the transcript as
 *                  responding to a specific TTS question.
 * @param {boolean} [opts.drainedRetry] True if this is the replay path; never
 *                  re-gate a transcript we previously forwarded.
 * @param {boolean} [opts.gateEnabled] Master switch. When false the gate is a
 *                  no-op (returns forward + reason 'bypass_flag_off'). Defaults
 *                  to true; production wiring reads VOICE_PRE_LLM_GATE.
 * @returns {{forward: boolean, reason: string, distinctContentWords?: number}}
 */
export function shouldForwardToSonnet(text, opts = {}) {
  const {
    regexResults,
    hasPendingAsk = false,
    inResponseTo = false,
    drainedRetry = false,
    gateEnabled = true,
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
  if (DIGIT_REGEX.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_DIGIT };
  }
  if (TRIGGER_REGEX.test(trimmed)) {
    return { forward: true, reason: GATE_REASONS.HAS_TRIGGER };
  }

  const distinctContent = new Set();
  let match;
  WORD_REGEX.lastIndex = 0;
  while ((match = WORD_REGEX.exec(trimmed)) !== null) {
    const w = match[0].toLowerCase();
    if (w.length > 1 && !STOPWORDS.has(w)) {
      distinctContent.add(w);
    }
  }
  if (distinctContent.size < MIN_DISTINCT_CONTENT_WORDS) {
    return {
      forward: false,
      reason: GATE_REASONS.LOW_CONTENT,
      distinctContentWords: distinctContent.size,
    };
  }

  return {
    forward: true,
    reason: GATE_REASONS.FALLBACK_FORWARD,
    distinctContentWords: distinctContent.size,
  };
}

export const _internals = Object.freeze({
  TRIGGER_WORDS,
  STOPWORDS,
  MIN_DISTINCT_CONTENT_WORDS,
});
