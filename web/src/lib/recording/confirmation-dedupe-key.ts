/**
 * Web mirror of the iOS `buildConfirmationDedupeKey` algorithm.
 *
 * WHY: parity WS3 item 2 (read-back dedupe re-key). iOS re-keyed its TTS
 * confirmation dedupe on 2026-06-18 (universal read-back wave) so a
 * same-field reading on a DIFFERENT circuit/board/value is still read
 * back; the web dedupe was still field+circuit only, which silently
 * swallowed the second read-back in exactly the cases the iOS fix
 * targeted (session C0C21546 turn-9/10 broadcast collision; session
 * 84CE2125 board-level spd_bs_en collision).
 *
 * Canon: CertMateUnified `DeepgramRecordingViewModel.swift:800`
 * (`buildConfirmationDedupeKey`) and the backend telemetry mirror
 * `src/extraction/ios-dedupe-key.js` (READ-ONLY reference — backend is
 * shared with iOS and immutable during PWA work). The three shapes:
 *
 *   - per-circuit:   `${field}_${circuit}`             (legacy shape —
 *     shared with correction-TTS dedupe, preserves cross-matching)
 *   - multi-circuit: `${field}_${sortedCircuits.join('-')}_${djb2(text)}`
 *   - degenerate:    `${field}_${djb2(text + (boardId ?? ''))}`
 *     (board-level / supply / installation — no circuit info; boardId
 *     folded into the hash so sub-board confirmations stay isolated)
 *
 * The confirmation TEXT is the value discriminator: the wire embeds the
 * value in `text` via the backend's `buildConfirmationText`, so hashing
 * the text is what makes "same field, different value" produce a
 * distinct key. djb2 is UInt64-wrap over Unicode scalars — Swift uses
 * `UInt64` overflow operators (&*, &+); here BigInt masked to 64 bits
 * preserves identical wrap arithmetic, and the decimal-string render
 * matches Swift's `"\(hash)"`.
 *
 * DO NOT alter without also updating the Swift canon + the backend
 * mirror's parity expectations — the backend `ios_send_attempt`
 * telemetry computes `expected_dedupe_key` with the same algorithm and
 * reconciles byte-for-byte against client reality.
 *
 * ── Operation dedupe tokens (field-feedback-2026-07-14 §A1a) ──
 * Five TEXT-OP confirmation fields collide under ALL of the positional
 * shapes above: every "Observation deleted" is circuit:null +
 * byte-identical text (the degenerate branch hashes identically), and a
 * repeated legitimate field_cleared / rename on the same slot speaks
 * byte-identical text too — so text hashing cannot separate
 * identical-text REPEATS of DISTINCT operations (field session 6B6FE011:
 * the F2 correction read-back and the F7/F10 apologies were all
 * client-swallowed on colliding keys). For those fields the backend
 * stamps a `dedupe_token` on the wire confirmation entry (replay-stable
 * operation identity — see `stage6-event-bundler.js`) and the token key
 * `${field}_${dedupe_token}` takes precedence in EVERY branch the
 * confirmation can reach. Measured-value fields IGNORE the token — the
 * bare `${field}_${circuit}` single-circuit shape is load-bearing for
 * the iOS correction-TTS cross-match, mirrored here. Token absent
 * (pre-token backend) → the legacy shapes, byte-unchanged.
 */

/**
 * The exact synchronized allowlist of text-op confirmation fields that
 * carry a backend-emitted `dedupe_token`. Mirrors
 * `src/extraction/ios-dedupe-key.js` `DEDUPE_TOKEN_FIELDS` and iOS
 * `DeepgramRecordingViewModel.dedupeTokenFields`; the drift tests on all
 * three sides pin membership + per-op token composition.
 */
export const DEDUPE_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  'circuit_op',
  'observation',
  'observation_deletion',
  'field_cleared',
  'circuit_designation',
]);

// BigInt() constructor calls (not `5381n` literals) — the web tsconfig
// targets ES2017 where BigInt LITERALS are a syntax error, but the
// BigInt runtime global is universally available in the PWA's supported
// browsers (iOS Safari ≥ 14). Semantics are identical.
const DJB2_INIT = BigInt(5381);
const DJB2_MULT = BigInt(33);
const U64_MASK = (BigInt(1) << BigInt(64)) - BigInt(1);

/**
 * djb2 over Unicode scalars, wrapping at UInt64, decimal-string output.
 * `for..of` iterates by code point (not UTF-16 code unit), matching
 * Swift's `unicodeScalars` on emoji / supplementary-plane input.
 */
export function djb2UInt64Decimal(text: string | null | undefined): string {
  if (text == null) return '0';
  let hash = DJB2_INIT;
  for (const ch of String(text)) {
    const code = BigInt(ch.codePointAt(0) ?? 0);
    hash = (((hash * DJB2_MULT) & U64_MASK) + code) & U64_MASK;
  }
  return hash.toString(10);
}

/** The subset of the wire `Confirmation` shape the key derives from. */
export interface DedupeKeySource {
  text: string;
  field?: string | null;
  circuit?: number | null;
  circuits?: number[] | null;
  board_id?: string | null;
  /** §A1a backend-stamped operation token (five text-op fields only). */
  dedupe_token?: string | null;
}

/**
 * Literal port of iOS `buildConfirmationDedupeKey` branch selection:
 * token precedence for allowlisted text-op fields (every branch), then
 * single-circuit wins, then multi-circuit broadcast, then degenerate.
 */
export function buildConfirmationDedupeKey(conf: DedupeKeySource): string {
  const field = conf.field ?? 'unknown';
  // §A1a — token precedence for the allowlisted text-op fields, in every
  // branch (single-circuit, multi-circuit AND degenerate). Empty-string
  // token treated as absent (mirrors the JS `opToken &&` falsiness in
  // ios-dedupe-key.js and the Swift `!token.isEmpty` guard).
  if (conf.dedupe_token && conf.field && DEDUPE_TOKEN_FIELDS.has(conf.field)) {
    return `${conf.field}_${conf.dedupe_token}`;
  }
  if (conf.circuit != null) {
    // Single-circuit: historical "{field}_{circuit}" shape so
    // correction-TTS dedupe entries still cross-match (iOS Bug A fix).
    return `${field}_${conf.circuit}`;
  }
  if (conf.circuits != null && conf.circuits.length > 0) {
    // Multi-circuit broadcast: sorted circuits + djb2 of the spoken text.
    const circuitKey = [...conf.circuits].sort((a, b) => a - b).join('-');
    return `${field}_${circuitKey}_${djb2UInt64Decimal(conf.text)}`;
  }
  // Degenerate (board-level / supply / installation) — W2.3 shape:
  // boardId folded into the hashed string so same-field same-text
  // confirmations on different boards stay distinct.
  return `${field}_${djb2UInt64Decimal(conf.text + (conf.board_id ?? ''))}`;
}
