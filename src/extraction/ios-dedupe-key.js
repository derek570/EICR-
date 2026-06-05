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
 *   - per-circuit:   "<field>_<circuit>"
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
 */

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
 * Per-circuit dedupe key. Preserves the legacy "{field}_{circuit}" shape so
 * correction-TTS dedupe at iOS line 6845 continues to cross-match.
 *
 * @param {string} field
 * @param {number} circuit
 * @returns {string}
 */
export function buildPerCircuitDedupeKey(field, circuit) {
  return `${field ?? 'unknown'}_${circuit}`;
}

/**
 * Multi-circuit (broadcast) dedupe key. djb2 over the spoken TTS text.
 *
 * @param {string} field
 * @param {number[]} circuits
 * @param {string} text  — the final TTS-line text the bundler emitted
 * @returns {string}
 */
export function buildMultiCircuitDedupeKey(field, circuits, text) {
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
export function buildDegenerateDedupeKey(field, text, boardId) {
  const composite = `${text ?? ''}${boardId ?? ''}`;
  return `${field ?? 'unknown'}_${djb2UInt64Decimal(composite)}`;
}
