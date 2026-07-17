/**
 * Web port of the iOS client-side transcript forward-gate.
 *
 * LITERAL port of `TranscriptGate` (CertMateUnified
 * `DeepgramRecordingViewModel.swift:22-160` — enum + `shouldForward` —
 * plus the trigger/stopword arrays at ~:327-430 and the word-boundary
 * `containsWord` helper). iOS in turn ports the backend pre-LLM gate
 * (src/extraction/pre-llm-gate.js); the backend remains the authority
 * and this client gate is deliberately PERMISSIVE — when in doubt,
 * forward.
 *
 * WHY (parity WS3 item 7): web previously had NO client-side forward
 * gate — every Deepgram final reached Sonnet, so web users paid for
 * chitchat turns iOS has filtered since 2026-05-29, and the
 * "sent for processing" chime had no gate-pass moment to anchor to.
 * Decision: this IS a behaviour change for web (non-qualifying chatter
 * stops reaching Sonnet — the same cost/noise win iOS shipped).
 *
 * Sync contracts (verbatim from the iOS source comments):
 *  - strong/weak triggers mirror backend WEAK_TRIGGER_WORDS,
 *  - earthingTriggers mirror backend EARTHING_TRIGGER_REGEX,
 *  - identityTriggers mirror backend CERT_IDENTITY_TRIGGER_REGEX,
 *  - the bare-negation pattern mirrors backend
 *    STANDALONE_NEGATION_PATTERN (readback-correction-optionb §3.3),
 *  - OBSERVATION_PATTERN mirrors backend pre-llm-gate.js.
 * Any change here must stay in lock-step with BOTH the iOS arrays and
 * the backend lists.
 */

/**
 * OBSERVATION_PATTERN — matches "observation"/"obs"/"observance" + the
 * Deepgram garble family; rejects verb forms + everyday English.
 * Single source of truth so `shouldForward` and any "processing
 * observation" cue can't drift. Mirrors iOS `TranscriptGate.isObservation`.
 */
const OBSERVATION_PATTERN =
  /\b(?:obs|[oa]?b[a-z]{0,5}v[a-z]{0,4}(?:tion|sion|shun|shen|shan|shon|nce|tor|tior|ation))s?\b/;

/** Backend STANDALONE_NEGATION_PATTERN mirror — a standalone bare
 *  negation forwards so the backend's rolling read-back window can
 *  resolve "no" against the last value it read back (Option B: ask for
 *  the replacement, never clear_reading). Anchored ^…$ over the trimmed
 *  lowercased FULL utterance, so "No earth." / "No problem" do NOT
 *  match and stay on their existing (blocked / weak-trigger) path. */
const STANDALONE_NEGATION_PATTERN = /^(no|nope|nah)[.!?]*$/;

const STRONG_TRIGGERS: readonly string[] = [
  'zs',
  'ze',
  'pfc',
  'psc',
  'ipfc',
  'r1',
  'r2',
  'mcb',
  'rcd',
  'rcbo',
  'spd',
  'polarity',
  'continuity',
  'insulation',
  'delete',
  'remove',
  'fcu',
  'cpc',
  'afdd',
];

// 2026-05-29 — weak-trigger forward authority (mirrors backend
// pre-llm-gate.js WEAK_TRIGGER_WORDS). Inspection vocabulary that grants
// forward authority on its own (with the ≥3 content-word threshold).
// Pure-English chitchat ("Can I use the toilet, please?") contains none
// of these and blocks at the gate.
const WEAK_TRIGGERS: readonly string[] = [
  // Circuit / board nouns
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
  // Generic electrical
  'radial',
  'main',
  'sub-main',
  'submain',
  'fuse',
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
  // Damage / observation language (weak — explicit "observation"
  // keyword still preferred via OBSERVATION_PATTERN)
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
  // Navigation / UI
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
  // Confirmation / inspection
  'confirm',
  'correct',
  'overall',
  'summary',
  'inspection',
  // Cert identity / address dictation markers — 2026-06-12 field report
  // (session 15B88D6B, voiceFeedbackId 20): "Customer is Michael Johnson"
  // had no digit/strong/weak trigger, so spoken client_name corrections
  // died at the gate. Bare "name" deliberately excluded so "Hello my
  // name is ..." chitchat still blocks. MUST stay in sync with backend
  // WEAK_TRIGGER_WORDS.
  'customer',
  'client',
  'landlord',
  'tenant',
  'occupier',
  'address',
  'postcode',
];

// Subset of WEAK_TRIGGERS that lowers the distinct-content-word threshold
// to 2 (see shouldForward). MUST stay in sync with the backend
// CERT_IDENTITY_TRIGGER_REGEX in pre-llm-gate.js.
const IDENTITY_TRIGGERS: readonly string[] = [
  'customer',
  'client',
  'landlord',
  'tenant',
  'occupier',
  'address',
  'postcode',
];

// item #8 (session DFCE2145) — earthing-system markers, forwarded at
// content-threshold 1 (any one of these tokens grants forward authority —
// the marker IS the single content word, so bare "It is TNCS." reaches
// the server and is WRITTEN + read back rather than silently dropped;
// audio-first invariant #2). MUST stay in sync with the backend
// EARTHING_TRIGGER_REGEX in pre-llm-gate.js.
const EARTHING_TRIGGERS: readonly string[] = [
  'tncs',
  'tn-c-s',
  'tns',
  'tn-s',
  'tnc',
  'tn-c',
  'tt',
  'pme',
  'earthing',
];

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'from',
  'on',
  'at',
  'in',
  'is',
  'was',
  'were',
  'am',
  'are',
  'be',
  'been',
  'by',
  'it',
  'its',
  'that',
  'this',
  'these',
  'those',
  'and',
  'or',
  'but',
  'not',
  'no',
  'yes',
  'uh',
  'um',
  'mm',
  'so',
  'just',
  'well',
  'now',
  'then',
  'there',
  'here',
  'whatever',
]);

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary containment — mirrors iOS `containsWord` (NSRegular-
 *  Expression `\b<escaped>\b`). Hyphenated trigger forms ("tn-s") match
 *  because `\b` anchors at the alphanumeric edges. */
function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(text);
}

/** Mirrors iOS `TranscriptGate.isObservation`. */
export function isObservation(text: string): boolean {
  return OBSERVATION_PATTERN.test(text.trim().toLowerCase());
}

/**
 * Decide whether a Deepgram-final transcript should be forwarded to the
 * server for Sonnet extraction. LITERAL port of iOS
 * `TranscriptGate.shouldForward` — every branch, in the same order:
 * pending-ask → inResponseTo → regex-hit → empty-block → digit →
 * bare-negation → observation-pattern → strong triggers → earthing
 * triggers → weak-trigger + content-word threshold (identity triggers
 * lower the threshold from 3 to 2).
 *
 * Note the iOS-canon consequence: a non-expired pending ask or a valid
 * `in_response_to` payload is a gate-PASS by definition — there is no
 * reject-with-valid-ask case.
 */
export function shouldForward(input: {
  text: string;
  hasRegexHit: boolean;
  hasPendingAsk: boolean;
  inResponseTo: boolean;
}): boolean {
  const { text, hasRegexHit, hasPendingAsk, inResponseTo } = input;
  if (hasPendingAsk) return true;
  if (inResponseTo) return true;
  if (hasRegexHit) return true;

  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Numeric-chatter gate (marker-① companion, 2026-07-17). A LETTER-FREE digit
  // string ("30", "0.05", "5, 6, 7, 8") is not a complete reading (no field)
  // and, reaching this branch, has NO pending-value context — hasPendingAsk /
  // inResponseTo / hasRegexHit all forwarded ABOVE, and THOSE are how the
  // client knows a field is awaiting a value. Blocking it here suppresses the
  // "sent for processing" chime this gate-pass anchors, so ambient numbers
  // never beep (and never draw the backend's marker-① no-op apology). This is
  // the PRIMARY chime-suppression lever — the chime is client-side, so the
  // backend deliberately keeps FORWARDING bare numbers (its marker-① net
  // apologises rather than going silent if an un-updated client forwards one).
  // Deliberately CONSERVATIVE: any letter keeps the digit forward, so terse
  // weak-field readings ("lives 0.32") and filler chatter ("30 quid") are NOT
  // dropped. iOS TranscriptGate carries the byte-identical branch (canon).
  if (/\d/.test(trimmed)) {
    if (/[A-Za-z]/.test(trimmed)) return true;
    return false;
  }

  const lower = trimmed.toLowerCase();

  // readback-correction-optionb §3.3 — bare negation forwards.
  if (STANDALONE_NEGATION_PATTERN.test(lower)) return true;

  // OBSERVATION_PATTERN — "observation"/"obs"/garbles.
  if (isObservation(lower)) return true;

  for (const word of STRONG_TRIGGERS) {
    if (containsWord(lower, word)) return true;
  }

  // Earthing markers forward at content-threshold 1.
  for (const word of EARTHING_TRIGGERS) {
    if (containsWord(lower, word)) return true;
  }

  // 2026-05-29 policy: weak-trigger present AND ≥3 distinct content
  // words (≥2 when a cert-identity marker is present).
  let hasWeak = false;
  for (const word of WEAK_TRIGGERS) {
    if (containsWord(lower, word)) {
      hasWeak = true;
      break;
    }
  }
  if (!hasWeak) return false;

  let minContent = 3;
  for (const word of IDENTITY_TRIGGERS) {
    if (containsWord(lower, word)) {
      minContent = 2;
      break;
    }
  }

  // Mirrors the Swift tokenizer (`split(whereSeparator: { !$0.isLetter
  // && $0 != "'" })`): split where the character is neither a Unicode
  // letter nor an apostrophe, keep tokens of length > 1 that aren't
  // stopwords, count distinct.
  const distinct = new Set<string>();
  for (const raw of lower.split(/[^\p{L}']+/u)) {
    if (raw.length > 1 && !STOPWORDS.has(raw)) {
      distinct.add(raw);
      if (distinct.size >= minContent) return true;
    }
  }
  return false;
}
