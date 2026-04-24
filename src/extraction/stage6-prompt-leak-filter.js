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

  // Family 5 — per-field length ceilings.
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
