/**
 * Cross-platform mirror of the iOS `buildConfirmationDedupeKey` algorithm.
 *
 * WHY: PLAN voice-feedback-2026-06-05 §A condition 2 + W1.2 (b) + W1.4.
 * The bundler emits `ios_send_attempt` rows that must carry the
 * `expected_dedupe_key` iOS will compute on receive; the dispatcher emits
 * an early projection on its `stage6_tool_call` row. Both call sites must
 * use the SAME djb2 hash + key shape so server-side telemetry reconciles
 * byte-for-byte against iOS-side reality (Wave 2 cross-wave coupling).
 *
 * Reference: CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:649
 * (`buildConfirmationDedupeKey`).
 *
 * Three key shapes — pick at the call site:
 *   - per-circuit:   "<field>_<circuit>_<djb2(text)>"  (VALUE-AWARE, id-84)
 *   - multi-circuit: "<field>_<sortedCircuits.join('-')>_<djb2(text)>"
 *   - degenerate:    "<field>_<djb2(text + (boardId ?? ''))>"  (NEW W2.3 shape)
 *
 * The degenerate shape changed in PLAN voice-feedback-2026-06-05 W2.3 — old
 * shape was "<field>_none" (cross-board / cross-value collision risk). Wave
 * 1 telemetry uses the NEW shape so it can be reconciled against the iOS
 * build that ships in Wave 2.
 *
 * Algorithm — DO NOT alter without also updating the Swift mirror at
 * DeepgramRecordingViewModel.swift:649 + the parity test in
 * Tests/CertMateUnifiedTests/Recording/ConfirmationDedupeKeyTests.swift.
 * The Swift uses UInt64 with overflow operators (&*, &+); JS uses BigInt to
 * preserve the same 64-bit wrap arithmetic.
 *
 * ── Operation dedupe tokens (field-feedback-2026-07-14 §A1a) ──
 * Five TEXT-OP confirmation fields collide under the positional key shapes:
 * every "Observation deleted" is circuit:null + byte-identical text (the
 * DEGENERATE branch computes identical keys), and a repeated legitimate
 * field_cleared / rename on the same slot speaks byte-identical text too —
 * so text hashing alone cannot separate identical-text REPEATS of DISTINCT
 * operations (field session 6B6FE011: F2 correction read-back and F7/F10
 * apologies were all client-swallowed on colliding keys). For those fields
 * the bundler stamps a `dedupe_token` on the wire confirmation entry —
 * replay-stable operation identity — and every key builder here PREFERS
 * `{field}_{dedupe_token}` when the token is present, in EVERY branch the
 * confirmation can reach. Token composition (pinned by the drift test in
 * src/__tests__/ios-dedupe-key.test.js):
 *   - observation           → `obs_<observation id>`
 *   - observation_deletion  → `obsdel_<observation id>`
 *   - field_cleared         → `clear_<field>_<circuit|board>_<turnId|legacy>_ord<N>`
 *   - circuit_op            → `circop_<turnId|noturn>_<ordinal>_<op>_<ref>`
 *   - circuit_designation   → `desig_<circuit(s)>_<turnId>`
 * Measured-value fields NEVER carry a token — their VALUE-AWARE
 * `{field}_{circuit}_{djb2(text)}` shape separates a correction from a
 * duplicate on its own (id-84 correction-swallow fix, 2026-07-24).
 *
 * Rollout window: `expected_dedupe_key` telemetry is forward-looking during
 * the backend→TestFlight/web window — build-418 (and pre-sweep web) clients
 * still dedupe on the bare key, so mismatched telemetry rows in that window
 * are expected, not a regression.
 *
 * A1(b)'s 30 s field-nil TTL is CLIENT-LOCAL state (iOS + web) and needs no
 * mirror here — the key SHAPE is unchanged by it.
 */

/**
 * The exact synchronized allowlist of text-op confirmation fields that carry
 * a backend-emitted `dedupe_token`. Derived from bundler output — the
 * collision-prone text operations. Mirrored in iOS
 * `buildConfirmationDedupeKey` and web `confirmation-dedupe-key.ts`; the
 * drift test pins membership.
 */
export const DEDUPE_TOKEN_FIELDS = new Set([
  'circuit_op',
  'observation',
  'observation_deletion',
  'field_cleared',
  'circuit_designation',
]);

const DJB2_INIT = 5381n;
const DJB2_MULT = 33n;
const U64_MASK = (1n << 64n) - 1n;

/**
 * Compute djb2 over a UTF-16 code-point stream, wrapping at UInt64.
 * Matches the Swift `for scalar in conf.text.unicodeScalars { hash = (hash &* 33) &+ UInt64(scalar.value) }`
 * loop byte-for-byte. Returns a decimal string (matches Swift's
 * `"\(hash)"` interpolation of UInt64).
 *
 * @param {string} text
 * @returns {string}
 */
export function djb2UInt64Decimal(text) {
  if (text == null) return '0';
  const str = String(text);
  let hash = DJB2_INIT;
  // Use Array.from to enumerate by Unicode scalar (not by UTF-16 code unit).
  // Swift's `unicodeScalars` iterates scalars; matching that here keeps the
  // hash stable across the rare emoji / supplementary-plane case.
  for (const ch of str) {
    const code = BigInt(ch.codePointAt(0) ?? 0);
    hash = (((hash * DJB2_MULT) & U64_MASK) + code) & U64_MASK;
  }
  return hash.toString(10);
}

/**
 * Per-circuit dedupe key. VALUE-AWARE shape "{field}_{circuit}_{djb2(text)}"
 * (id-84 correction-swallow fix, 2026-07-24) — the confirmation TEXT encodes
 * the reading value, so folding its djb2 hash makes a correction (0.83 → 0.63,
 * DIFFERENT text) produce a DISTINCT key and speak, while a genuine duplicate
 * (same field+circuit+SAME text) still dedupes. This matches the multi-circuit
 * branch's `djb2(text)` fold. The prior shape was deliberately value-LESS so
 * the iOS local correction-TTS dedupe (`correctionDedupeKey`) could cross-match
 * these wire keys; that cross-match is now INTENTIONALLY dropped (id-84: the
 * cross-match permanently swallowed the second read-back of a corrected value).
 * Worst case of dropping it is an extra local read-back, never silence — guarded
 * on server-confirmation turns by the iOS `!(confirmationModeEnabled && …)` check
 * (see `correctionDedupeKey` in DeepgramRecordingViewModel.swift).
 *
 * §A1a: when the confirmation carries a `dedupe_token` AND the field is on
 * the text-op allowlist, the token key takes precedence — `{field}_{token}`.
 * Measured-value fields ignore the token; their value-aware shape does the
 * correction-vs-duplicate separation on its own.
 *
 * @param {string} field
 * @param {number} circuit
 * @param {string} text  — the final TTS-line text the bundler emitted (encodes value)
 * @param {string|null|undefined} opToken — the wire `dedupe_token`, if any
 * @returns {string}
 */
export function buildPerCircuitDedupeKey(field, circuit, text, opToken) {
  if (opToken && DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  return `${field ?? 'unknown'}_${circuit}_${djb2UInt64Decimal(text ?? '')}`;
}

/**
 * Multi-circuit (broadcast) dedupe key. djb2 over the spoken TTS text.
 *
 * @param {string} field
 * @param {number[]} circuits
 * @param {string} text  — the final TTS-line text the bundler emitted
 * @returns {string}
 */
export function buildMultiCircuitDedupeKey(field, circuits, text, opToken) {
  // §A1a: token takes precedence in EVERY branch an allowlisted text-op
  // confirmation can reach (a grouped circuit_designation broadcast lands
  // here, not in the per-circuit branch).
  if (opToken && DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  const sorted = [...(circuits ?? [])].sort((a, b) => a - b);
  const circuitKey = sorted.join('-');
  return `${field ?? 'unknown'}_${circuitKey}_${djb2UInt64Decimal(text ?? '')}`;
}

/**
 * Degenerate dedupe key (board-level / supply / installation — no circuit).
 *
 * Wave 2 W2.3 shape — djb2 over the spoken text + boardId. Replaces the
 * pre-fix "<field>_none" shape, which collided when two distinct board-
 * level confirmations on the same field landed in the same session.
 *
 * Call-site contract:
 *   - bundler (W1.4): pass the FINAL TTS text the inspector hears. This is
 *     what iOS will see on `ValueConfirmation.text` and what makes the
 *     server-side `expected_dedupe_key` byte-equal to the iOS-computed key.
 *   - dispatcher (W1.2 b): pass the Sonnet `value` as a TEXT proxy at
 *     dispatch time. This produces an EARLY projection that the operator
 *     can correlate against the later bundler row using the shared
 *     (field, value) pair — it is NOT byte-equal to iOS until the bundler
 *     row lands. Plan W1.2 (b) calls this the "round-trip expected_dedupe_key".
 *
 * @param {string} field
 * @param {string} text  — final TTS text (bundler) OR value-as-proxy (dispatcher)
 * @param {string|null|undefined} boardId
 * @returns {string}
 */
export function buildDegenerateDedupeKey(field, text, boardId, opToken) {
  // §A1a: token takes precedence — this is the branch EVERY observation
  // deletion reaches (circuit:null + constant "Observation deleted" text →
  // identical hashed keys without the token).
  if (opToken && DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  const composite = `${text ?? ''}${boardId ?? ''}`;
  return `${field ?? 'unknown'}_${djb2UInt64Decimal(composite)}`;
}
