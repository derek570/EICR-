/**
 * Snapshot user-text sanitise + wrap helpers — extracted leaf module.
 *
 * A1 agentic-voice (2026-07-23): these were PRIVATE functions inside
 * eicr-extraction-session.js (Plan 04-13 r7-#1 / 04-14 r8-#1 / 04-18 r12-#1).
 * The inspect_session_state dispatcher must apply the IDENTICAL sanitisation +
 * <<<USER_TEXT>>> wrapping to every user-derived string it returns in a
 * tool_result (a raw echo of a stored designation is a stored prompt-injection
 * path), and security-sensitive logic is never duplicated — so the helpers
 * moved here and BOTH the session and the dispatcher import them. Behaviour is
 * byte-identical to the pre-extraction private definitions; the identity test
 * in stage6-inspect-dispatcher.test.js pins snapshot-render output against
 * inspect-scope output through the same functions.
 */

import { CONTROL_CHAR_PATTERN } from './stage6-sanitise-user-text.js';

export const SNAPSHOT_USER_TEXT_OPEN = '<<<USER_TEXT>>>';
export const SNAPSHOT_USER_TEXT_CLOSE = '<<<END_USER_TEXT>>>';
export const SNAPSHOT_MAX_FIELD_LEN = 2048; // Parity with MAX_USER_TEXT_LEN in stage6-sanitise-user-text.js.

// Match any occurrence of either marker tag, case-insensitive. Global
// flag so .replace() catches all occurrences in a single pass.
export const SNAPSHOT_MARKER_ESCAPE_PATTERN = /<<<\s*(END_USER_TEXT|USER_TEXT)\s*>>>/gi;

/**
 * Plan 04-13 r7-#1 — sanitise a user-derived string before it lands
 * in the cached-prefix snapshot block (or, since A1, in an
 * inspect_session_state tool_result).
 *
 * Strips C0 control characters (shared CONTROL_CHAR_PATTERN so ask_user
 * replies and snapshot fields share the same hygiene contract), escapes any
 * literal `<<<USER_TEXT>>>` / `<<<END_USER_TEXT>>>` substrings so an attacker
 * cannot close the framing boundary by embedding the marker in raw text, and
 * caps length at `SNAPSHOT_MAX_FIELD_LEN`.
 *
 * Returns the cleaned string. Non-string inputs (null, undefined, numbers)
 * return empty string — defence in depth.
 */
export function sanitiseSnapshotField(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(CONTROL_CHAR_PATTERN, '');
  // Escape every marker tag occurrence (case-insensitive) to a safe
  // form that preserves visibility ("the attacker tried to inject
  // <END_USER_TEXT>") but cannot terminate a real region. Replace
  // outer `<` and `>` pairs with `_` so the substring can never
  // re-match the open/close regex.
  text = text.replace(SNAPSHOT_MARKER_ESCAPE_PATTERN, (match) => {
    const inner = match.replace(/[<>]/g, '');
    return `<_${inner}_>`;
  });
  if (text.length > SNAPSHOT_MAX_FIELD_LEN) {
    text = text.slice(0, SNAPSHOT_MAX_FIELD_LEN);
  }
  return text;
}

/**
 * Plan 04-13 r7-#1 — wrap a sanitised field in the snapshot user-text
 * markers. Callers MUST sanitise before wrapping (this helper does not
 * double-sanitise, to keep composition explicit and testable).
 */
export function wrapSnapshotUserText(sanitised) {
  return `${SNAPSHOT_USER_TEXT_OPEN}${sanitised}${SNAPSHOT_USER_TEXT_CLOSE}`;
}

/**
 * Plan 04-14 r8-#1 — sanitise AND wrap a user-derived string that lands
 * INSIDE a JSON string value. The markers are part of the STRING value, so
 * JSON shape is preserved while the r7 preamble's "only tagged regions are
 * quoted" contract still covers the content at the semantic layer.
 */
export function wrapSnapshotUserTextInline(raw) {
  return wrapSnapshotUserText(sanitiseSnapshotField(raw));
}

// Plan 04-18 r12-#1 — WRAP_POLICY classifies each field that can land in
// `stateSnapshot.circuits[n][field]` or `stateSnapshot.circuits[0][field]`
// by AUTHORSHIP:
//   - 'user_derived'     → sanitise + wrap (free text the inspector dictates).
//   - 'server_canonical' → sanitise ONLY (closed-enum selects / BS-EN codes
//                          that originate from server-side schema enforcement).
// DEFAULT for unlisted string-valued fields: 'user_derived' — a FAIL-SAFE
// (over-apply the wrap rather than reopen the injection surface). The r12-1d
// test pins this default. Full authorship rationale in the git history of
// eicr-extraction-session.js (Plan 04-18 r12-#1).
export const WRAP_POLICY = {
  // --- User-derived free text (WRAP) ---
  circuit_designation: 'user_derived',
  designation: 'user_derived', // upsertCircuitMeta stores under 'designation'

  // --- Server-canonical enums / status / codes (SANITISE only) ---
  wiring_type: 'server_canonical',
  ref_method: 'server_canonical',
  ocpd_type: 'server_canonical',
  rcd_type: 'server_canonical',
  polarity_confirmed: 'server_canonical',
  phase: 'server_canonical',
  ocpd_bs_en: 'server_canonical',
  rcd_bs_en: 'server_canonical',
  supply_type: 'server_canonical',
  earthing_system: 'server_canonical',
  ze: 'server_canonical',
  pfc: 'server_canonical',
  earth_loop_impedance_ze: 'server_canonical',
  prospective_fault_current: 'server_canonical',
  ocpd_rating_a: 'server_canonical', // numeric amp rating (closed: 6/16/20/32/40/45)
  ocpd_breaking_capacity_ka: 'server_canonical', // numeric kA rating (typical 6/10)
  ir_test_voltage_v: 'server_canonical', // numeric test V (closed: 250/500/1000)
  max_disconnect_time_s: 'server_canonical', // numeric seconds (BS 7671 Table 41.1)
  live_csa_mm2: 'server_canonical', // numeric mm² — line conductor CSA
  cpc_csa_mm2: 'server_canonical', // numeric mm² — CPC / earth conductor CSA
};

/**
 * Plan 04-18 r12-#1 — look up the wrap policy for a field. Unknown
 * fields fall through to 'user_derived' as a fail-safe default
 * (over-apply wrap rather than under-apply).
 */
export function wrapPolicyFor(fieldKey) {
  return WRAP_POLICY[fieldKey] ?? 'user_derived';
}

/**
 * Plan 04-18 r12-#1 — apply WRAP_POLICY to a field's value.
 *   - user_derived      → wrapSnapshotUserTextInline (sanitise + wrap)
 *   - server_canonical  → sanitiseSnapshotField (sanitise only)
 * Non-string values pass through unchanged (numbers, booleans, nulls).
 */
export function applyWrapPolicy(fieldKey, value) {
  if (typeof value !== 'string') return value;
  const policy = wrapPolicyFor(fieldKey);
  if (policy === 'server_canonical') {
    return sanitiseSnapshotField(value);
  }
  return wrapSnapshotUserTextInline(value);
}
