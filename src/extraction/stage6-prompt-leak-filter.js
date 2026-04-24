import crypto from 'node:crypto';

/**
 * Stage 6 Phase 4 Plan 04-26 — Layer 2 output-side prompt-leak filter.
 *
 * WHAT: pure function `checkForPromptLeak(text, opts)` returning
 *   { safe: true } on clean text, OR
 *   { safe: false,
 *     reason: string,
 *     sanitised: string | null,
 *     is_error_replacement?: true }
 *
 * WHY: defence-in-depth complement to Layer 1 (the
 * `## CONFIDENTIALITY` section in `config/prompts/sonnet_agentic_system.md`).
 * Layer 1 tells the model not to disclose the system prompt; this
 * filter catches any disclosure content that nonetheless shows up
 * in free-text tool-use arguments. Runs PRE-DISPATCH on:
 *   - `ask_user.question`         (question-class)
 *   - `record_observation.text`   (observation_text-class)
 *   - `create_circuit.designation` / `rename_circuit.designation`
 *                                 (designation-class)
 *
 * WHY pre-dispatch (not post-emission): on ask_user, the leaked
 * text would already have been spoken via TTS before any post-
 * emission check could fire. We MUST scan before the dispatcher
 * registers / forwards.
 *
 * Detection families:
 *   1. Marker strings (case-insensitive substring) — exact
 *      framing strings the prompt uses for its own delimiters.
 *   2. Requirement IDs (/ST[QBGARTSDOI]-0\d/i) — the planning
 *      vocabulary embedded in the prompt comments.
 *   3. Structural phrases — verbatim sentence fragments from the
 *      prompt's own voice.
 *   4. Worked-example markers — "Example N:" where N in 1-9
 *      AND there's a tool-call keyword within ~80 chars.
 *      Context-gated to avoid "for example 1 hour" FPs.
 *   5. Length-based suspicion — question > 500 chars or
 *      observation_text > 1000 chars (real inspection utterances
 *      are short; long free-text on these fields is anomalous).
 *
 * Sanitised replacements (per field class):
 *   - question         → "I can't share that — please proceed with the inspection."
 *   - observation_text → "Attempted prompt extraction — refused."
 *   - designation      → null + is_error_replacement:true; dispatcher
 *                        rejects the tool call rather than corrupt the
 *                        certificate with a refusal-string circuit
 *                        name.
 *
 * WHY the filter is not a throw-site: the filter is defence-in-
 * depth. A malformed call (non-string text, etc.) should NOT break
 * the tool loop — return safe:true and let the dispatcher's own
 * validator handle type errors.
 *
 * WHY marker/phrase lists are inline here (not in the prompt
 * config): the filter needs to know specific banned strings
 * regardless of future prompt rewording — the output channel
 * contract is: "these specific tokens never appear". The prompt
 * may evolve its own wording; the filter's marker set is the
 * stable contract.
 */

/**
 * Exact-match banned markers (case-insensitive substring).
 * Must mirror the banned-literals enumeration in the prompt's
 * CONFIDENTIALITY section.
 *
 * r20-#2: each entry carries a STABLE ID tag that goes into
 * `filter_reason` on the blocked log row. The raw marker string
 * is NEVER logged — only the tag is — so CloudWatch never sees
 * the actual banned content.
 */
const MARKER_STRINGS = [
  { id: 'trust-boundary', value: 'TRUST BOUNDARY' },
  { id: 'snapshot-trust-boundary', value: 'SNAPSHOT TRUST BOUNDARY' },
  { id: 'user-text-open', value: '<<<USER_TEXT>>>' },
  { id: 'user-text-close', value: '<<<END_USER_TEXT>>>' },
  { id: 'system-channel', value: 'SYSTEM_CHANNEL' },
  { id: 'user-channel', value: 'USER_CHANNEL' },
];

/**
 * Requirement-ID regex set. Each must be a 3-letter prefix + dash
 * + 0 + exactly one digit. "STQ-0" alone (no digit) is allowed —
 * too short to be a meaningful disclosure signal and the banned-
 * literal marker list covers that string explicitly in the prompt
 * (iff a downstream reader needs to enforce it, add here).
 */
const REQUIREMENT_PATTERNS = [
  /STQ-0\d/i,
  /STB-0\d/i,
  /STG-0\d/i,
  /STA-0\d/i,
  /STR-0\d/i,
  /STT-0\d/i,
  /STS-0\d/i,
  /STD-0\d/i,
  /STO-0\d/i,
  /STI-0\d/i,
];

/**
 * Structural prompt phrases — exact or near-exact sentence
 * fragments from the prompt's own voice. Case-insensitive
 * substring match.
 *
 * r20-#2: stable IDs so the filter_reason log field never
 * carries the prompt's own wording. The phrase values stay
 * inline for matching; only the ID goes into telemetry.
 */
const STRUCTURAL_PHRASES = [
  { id: 'assistant-intro', value: 'You are an EICR inspection assistant' },
  { id: 'seven-tools', value: 'You have 7 tools' },
  { id: 'no-free-text-json', value: 'Do not emit free-text JSON' },
  { id: 'silent-writes', value: 'Prefer silent writes' },
  { id: 'corrections-are-writes', value: 'Corrections are writes' },
];

/**
 * Tool-call keyword regex — any of the 7 tool names. Used to
 * context-gate worked-example detection (see MARKER_EXAMPLE
 * handling in checkForPromptLeak).
 */
const TOOL_KEYWORD_RE =
  /\b(record_reading|clear_reading|create_circuit|rename_circuit|record_observation|delete_observation|ask_user)\b/;

/**
 * Worked-example header regex: "Example 1:", "Example 2:", ...,
 * "Example 9:" — allowing case-insensitive leading capital.
 */
const EXAMPLE_HEADER_RE = /\bExample\s+[1-9]:/i;

/**
 * Per-field length ceilings. Question > 500 chars, observation_text >
 * 1000 chars, designation > 120 chars are flagged as suspicious.
 * Real designations are short ("Upstairs sockets" — ~16 chars);
 * anything above 120 is either a dump-style attack or a user
 * dictating the WHOLE sentence as a circuit name — both warrant a
 * reject (and the model retries with a short, real name).
 */
const LENGTH_CEILING = {
  question: 500,
  observation_text: 1000,
  designation: 120,
};

/**
 * Plan 04-27 r20-#3 — high-entropy substring detection.
 *
 * Regex captures contiguous base64 or hex blobs of at least 40
 * chars. 40 chars is the tightest threshold that stays above the
 * 36-char UUID boundary while covering useful-size prompt fragments
 * (a 30-byte prompt substring base64-encodes to 40 chars, the
 * minimum an attacker would find useful). Shorter-than-40 blobs
 * are too short to carry meaningful prompt content AND too close
 * to legitimate UUID/hash references to flag without false-
 * positives.
 *
 * WHY base64 charset includes =: base64 pads multiples of 4 with
 * 0–2 `=` chars. A 40-char chunk might end with `==`; stripping
 * padding from the regex would miss those real-world cases.
 *
 * Hex pattern is separate + stricter: legitimate hex in inspection
 * text is rare (observation text doesn't typically contain hash
 * refs) but a colour code `#a1b2c3` (6 chars) or reference
 * `a1b2c3d4` (8 chars) does exist. 40 char-bar excludes those.
 *
 * CHAR-DIVERSITY GUARD: a long run of a single repeated char
 * (`aaaa...aaaa`) technically matches the base64 charset but has
 * near-zero Shannon entropy. Real base64-encoded content uses the
 * full alphabet; repeated-char runs are test fixtures or padding
 * artefacts. We require at least 10 distinct chars inside the
 * matched chunk before flagging — excludes `a.repeat(N)` style
 * length-ceiling test fixtures AND legitimate monotonic content
 * like solid ASCII dashes in a separator.
 */
const BASE64_RE = /[A-Za-z0-9+/=]{40,}/;
const HEX_RE = /[0-9a-fA-F]{40,}/;
const MIN_ENTROPY_DISTINCT_CHARS = 10;

function hasHighEntropyChunk(text, re) {
  const match = text.match(re);
  if (!match) return false;
  const chunk = match[0];
  const distinct = new Set(chunk).size;
  return distinct >= MIN_ENTROPY_DISTINCT_CHARS;
}

/**
 * Plan 04-27 r20-#3 — per-field conservative low-alpha-ratio guard.
 *
 * For short natural-language fields (question + designation) that
 * have low plausible-content length ceilings (500 / 120 chars),
 * a payload with an anomalously low alphabetic-char ratio is
 * suspicious — legitimate inspector questions + circuit names are
 * almost entirely alpha + whitespace.
 *
 * `observation_text` is DELIBERATELY excluded: real observations
 * carry lots of numeric content (Zs 0.35, regulation 411.3.3,
 * cable 2.5mm², test voltage 500V, Ir > 999MΩ). A 200-char
 * observation legitimately hits 30–40% alphabetic ratio — flagging
 * it would destroy voice extraction on real inspection speech.
 * The 1000-char length ceiling is the only backstop for this
 * field.
 *
 * Thresholds:
 *   question:    length ≥ 200 AND alpha ratio < 0.5
 *   designation: length ≥ 40  AND alpha ratio < 0.4
 */
const LOW_ALPHA_MIN_LENGTH = {
  question: 200,
  designation: 40,
};
const LOW_ALPHA_THRESHOLD = {
  question: 0.5,
  designation: 0.4,
};

function alphaRatio(text) {
  if (typeof text !== 'string' || text.length === 0) return 1;
  const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
  return alphaCount / text.length;
}

/**
 * Sanitised-replacement strings per field class.
 */
const SANITISED_QUESTION = "I can't share that — please proceed with the inspection.";
const SANITISED_OBSERVATION_TEXT = 'Attempted prompt extraction — refused.';

/**
 * Scan a free-text tool-use field value for system-prompt
 * disclosure content.
 *
 * @param {any} text     Free-text content (string) emitted by the
 *                       model on a tool-use argument. Non-strings
 *                       are treated as safe (defensive — dispatcher
 *                       validator handles type errors).
 * @param {{field?: string}} [opts] Optional descriptor of the
 *                       target field class. Valid values:
 *                       'question' | 'observation_text' | 'designation'.
 *                       Missing field → no length check, sanitised
 *                       defaults to question phrasing.
 * @returns {{safe: boolean, reason?: string, sanitised?: string|null, is_error_replacement?: boolean}}
 */
export function checkForPromptLeak(text, opts = {}) {
  const field = opts.field || 'unknown';
  if (typeof text !== 'string') return { safe: true };

  const lower = text.toLowerCase();

  // Family 1 — marker strings (stable IDs in filter_reason, r20-#2).
  for (const marker of MARKER_STRINGS) {
    if (lower.includes(marker.value.toLowerCase())) {
      return makeUnsafe(field, `marker:${marker.id}`);
    }
  }

  // Family 2 — requirement IDs. The regex source (e.g. `STQ-0\d`) is
  // structural metadata identifying WHICH requirement namespace was
  // matched; it's not user-supplied content. Kept as-is for analyzer
  // routing.
  for (const re of REQUIREMENT_PATTERNS) {
    if (re.test(text)) {
      return makeUnsafe(field, `req-id:${re.source}`);
    }
  }

  // Family 3 — structural phrases (stable IDs in filter_reason, r20-#2).
  for (const phrase of STRUCTURAL_PHRASES) {
    if (lower.includes(phrase.value.toLowerCase())) {
      return makeUnsafe(field, `phrase:${phrase.id}`);
    }
  }

  // Family 4 — worked-example markers, context-gated to adjacent
  // tool-call keyword within ~80 chars.
  const examMatch = text.match(EXAMPLE_HEADER_RE);
  if (examMatch) {
    const idx = examMatch.index ?? 0;
    const window = text.slice(Math.max(0, idx - 80), idx + 160);
    if (TOOL_KEYWORD_RE.test(window)) {
      return makeUnsafe(field, 'example-marker-adjacent-to-tool');
    }
  }

  // Family 5 — r20-#3 reversed-content detection.
  //
  // Attackers can bypass substring matching by reversing the leaked
  // content. Cheap to check: reverse the whole text once, then test
  // whether it contains any known marker / structural phrase.
  //
  // We check MARKER_STRINGS + STRUCTURAL_PHRASES here (the closed
  // banned-literals lists). REQUIREMENT_PATTERNS are regex-based
  // and not cleanly reversible (STQ-01 reversed is 10-QTS — hyphen
  // position changes; skip). The 04-26 req-id coverage on forward
  // content is sufficient — an attacker reversing a req-id still
  // has a req-id in some orientation.
  const reversed = text.split('').reverse().join('').toLowerCase();
  for (const marker of MARKER_STRINGS) {
    if (reversed.includes(marker.value.toLowerCase())) {
      return makeUnsafe(field, `reversed:marker:${marker.id}`);
    }
  }
  for (const phrase of STRUCTURAL_PHRASES) {
    if (reversed.includes(phrase.value.toLowerCase())) {
      return makeUnsafe(field, `reversed:phrase:${phrase.id}`);
    }
  }

  // Family 6 — r20-#3 high-entropy substring detection.
  //
  // Base64 or hex blobs of ≥40 chars are anomalous in inspection
  // speech and a standard attacker channel for binary-encoding a
  // prompt leak under the length ceiling. 40-char threshold sits
  // above the 36-char UUID bound and below any useful prompt
  // fragment encoding.
  if (hasHighEntropyChunk(text, BASE64_RE)) {
    return makeUnsafe(field, 'entropy:base64');
  }
  if (hasHighEntropyChunk(text, HEX_RE)) {
    return makeUnsafe(field, 'entropy:hex');
  }

  // Family 7 — r20-#3 per-field conservative low-alpha-ratio guard
  // for question + designation (NOT observation_text — see const
  // docblock above for why).
  const minLen = LOW_ALPHA_MIN_LENGTH[field];
  const alphaBar = LOW_ALPHA_THRESHOLD[field];
  if (minLen && alphaBar && text.length >= minLen) {
    const ratio = alphaRatio(text);
    if (ratio < alphaBar) {
      return makeUnsafe(field, `low-alpha-ratio:${ratio.toFixed(2)}<${alphaBar}`);
    }
  }

  // Family 8 — per-field length ceilings (final backstop).
  const ceiling = LENGTH_CEILING[field];
  if (ceiling && text.length > ceiling) {
    return makeUnsafe(field, `length-suspicious:${text.length}>${ceiling}`);
  }

  return { safe: true };
}

function makeUnsafe(field, reason) {
  if (field === 'designation') {
    // Certificate-correctness trade-off: don't substitute a
    // refusal-string as a circuit designation. Signal the
    // dispatcher to reject the tool call; the model retries.
    return {
      safe: false,
      reason,
      sanitised: null,
      is_error_replacement: true,
    };
  }
  const sanitised = field === 'observation_text' ? SANITISED_OBSERVATION_TEXT : SANITISED_QUESTION;
  return {
    safe: false,
    reason,
    sanitised,
  };
}

/**
 * Plan 04-27 r20-#2 — structured-telemetry hash helper.
 *
 * Returns the first 16 hex chars of SHA-256 over the input string.
 * Used by every prompt_leak_blocked emission to correlate repeated
 * leak attempts in logs WITHOUT ever exposing a substring of the
 * blocked content.
 *
 * WHY SHA-256:
 *   - Cryptographic stability: same payload → same hash, always. The
 *     analyzer can count repeated attack payloads across sessions
 *     without reading any content.
 *   - Collision resistance: different payloads → different hashes.
 *   - Non-reversible: an ops engineer reading the log cannot
 *     reconstruct the prompt disclosure that triggered the block.
 *
 * WHY 16 hex chars (64 bits):
 *   - Enough uniqueness for correlation (no practical collisions
 *     across a session log volume).
 *   - Short enough not to dominate the log row size.
 *
 * Defensive shape: returns `null` for non-strings / empty strings so
 * callers don't have to guard — the filter never throws on unexpected
 * input.
 *
 * @param {any} text
 * @returns {string|null} 16-char lowercase hex, or null if input is
 *                        not a non-empty string.
 */
export function hashPayload(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
