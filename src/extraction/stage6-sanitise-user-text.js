/**
 * Stage 6 Phase 3 Plan 03-10 Task 2 — user_text sanitiser.
 *
 * WHAT: `sanitiseUserText(raw: string) → { text, truncated, stripped }`.
 * Pure function. Given untrusted user speech that iOS has routed as an
 * ask_user_answered payload, return:
 *   text       — the cleaned string (C0 controls stripped, capped at
 *                MAX_USER_TEXT_LEN)
 *   truncated  — true iff the length cap was applied
 *   stripped   — true iff any control characters were removed
 *
 * Throws TypeError if `raw` is not a string.
 * Throws Error('user_text_too_long:<actual_len>:<hard_cap>') if the
 * RAW input exceeds HARD_REJECT_USER_TEXT_LEN chars (abusive or buggy
 * client — caller converts the throw into an error envelope back to iOS
 * and declines to resolve the ask).
 *
 * WHY this lives in its own module (not inlined in sonnet-stream.js):
 * exhaustive edge-case testing is vastly cheaper with a pure function
 * than through the WebSocket harness. The sanitiser also has to run
 * identically everywhere user_text crosses the trust boundary (logs,
 * tool_result body). Single source of truth = single place to audit.
 *
 * WHY we preserve \\t \\n \\r: voice transcripts carry line breaks when
 * iOS concatenates multi-utterance answers. Stripping them would blur
 * the inspector's pauses and could make Sonnet misread lists as single
 * blobs. Tab is rare but harmless.
 *
 * WHY strip BEFORE truncate: otherwise a 3000-char input of mostly NULs
 * + some real text would come out as 2048 NULs that the strip then
 * deletes into empty string. Strip first preserves the useful content.
 *
 * WHY we do NOT detect prompt injection here: that is a model-alignment
 * concern, not a string-hygiene concern. STR-05 (Phase 8) will add
 * retention-based PII redaction at the analyzer/query layer; injection
 * detection is explicitly out of scope.
 */

export const MAX_USER_TEXT_LEN = 2048;
export const HARD_REJECT_USER_TEXT_LEN = 8192;

// Match every C0 control character EXCEPT \t (0x09), \n (0x0A), \r (0x0D).
// Also matches DEL (0x7F). Global flag so .replace() strips all occurrences.
//
// Plan 04-13 r7-#1 — exported so `eicr-extraction-session.js`'s
// `sanitiseSnapshotField` helper can reuse the same regex. Single
// source of truth for C0-control stripping across both
// `untrusted_user_text` (Phase 3) and cached-prefix snapshot content
// (Phase 4 r7 fix).
// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitiseUserText(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(`user_text must be a string, got ${typeof raw}`);
  }

  if (raw.length > HARD_REJECT_USER_TEXT_LEN) {
    const err = new Error(
      `user_text_too_long:${raw.length}:${HARD_REJECT_USER_TEXT_LEN}`,
    );
    err.code = 'USER_TEXT_TOO_LONG';
    throw err;
  }

  // Strip controls first (see module WHY). Length check comes after.
  const after = raw.replace(CONTROL_CHAR_PATTERN, '');
  const stripped = after.length !== raw.length;

  let text = after;
  let truncated = false;
  if (text.length > MAX_USER_TEXT_LEN) {
    text = text.slice(0, MAX_USER_TEXT_LEN);
    truncated = true;
  }

  return { text, truncated, stripped };
}
