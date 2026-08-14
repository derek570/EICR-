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
 *   - per-circuit:   `${field}_${circuit}_${djb2(text)}`  (VALUE-AWARE,
 *     id-84 correction-swallow fix — a correction speaks, a duplicate dedupes)
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
 * ── Operation dedupe tokens (field-feedback-2026-07-14 §A1a + PLAN-2C) ──
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
 * confirmation can reach. Measured-value fields IGNORE the token — their
 * VALUE-AWARE `${field}_${circuit}_${djb2(text)}` single-circuit shape
 * (id-84) separates a correction from a duplicate on its own. Token absent
 * (pre-token backend) → the positional shapes, byte-unchanged. PLAN-2C adds
 * `postcode`: two distinct same-text postcode amendments must not collide in
 * the session-permanent field-key store.
 */

/**
 * The exact synchronized WIRE/CLIENT allowlist of confirmation fields whose
 * backend-emitted `dedupe_token` takes precedence. Mirrors
 * `src/extraction/ios-dedupe-key.js`
 * `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` and iOS
 * `DeepgramRecordingViewModel.wireClientDedupeTokenFields`; the drift tests
 * on all three sides pin membership + token composition.
 */
export const WIRE_CLIENT_DEDUPE_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  'circuit_op',
  'observation',
  'observation_deletion',
  'field_cleared',
  'circuit_designation',
  'postcode',
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
  /** Backend-stamped operation token (wire/client-enrolled fields only). */
  dedupe_token?: string | null;
}

/**
 * PLAN-3 reconnect-required severity re-code confirmations deliberately keep
 * `field:null`, but carry a server-owned operation token. They are not members
 * of the ordinary field-token manifest: this prefix is a separate wire lane
 * whose job is to let an owed reconnect suffix bypass stale-frame suppression
 * and dedupe permanently by the originating operation.
 */
export const OBSERVATION_RECODE_DEDUPE_PREFIX = 'obsrecode_';

export function isObservationRecodeConfirmation(conf: DedupeKeySource): boolean {
  return (
    conf.field == null &&
    typeof conf.dedupe_token === 'string' &&
    conf.dedupe_token.startsWith(OBSERVATION_RECODE_DEDUPE_PREFIX)
  );
}

/**
 * The closed P4 decline-ack prompt family — a byte-for-byte mirror of
 * backend canon `ASK_DECLINE_ACK_PROMPTS` in
 * `src/extraction/stage6-shadow-harness.js`. APPEND-ONLY (never reorder or
 * edit an existing entry): the backend's `turnNum % length` rotation and
 * any recorded fixture's `text_exact` assertions depend on stable indices.
 * There is no shared module between web and the Node-only backend, so this
 * list is duplicated deliberately rather than imported.
 */
export const ASK_DECLINE_ACK_PROMPTS: readonly string[] = Object.freeze([
  'Okay — leaving that one.',
  'No problem, moving on.',
  "Alright — I'll leave that as it is.",
  "That's fine — I'll leave it there.",
  'Sure — leaving that as it stands.',
]);

const DECLINE_ACK_TEXT_SET: ReadonlySet<string> = new Set(ASK_DECLINE_ACK_PROMPTS);

/**
 * 2026-08-14 (PLAN-G, Derek decision, id-114): matches ONLY the closed P4
 * decline-ack family, so `recording-context.tsx` can force these through
 * `speakConfirmation` even when the local confirmation-mode toggle is off —
 * an answer to a question the app asked is not a reading confirmation, and
 * silence after "don't worry" is indistinguishable from a broken pipeline.
 * Every OTHER confirmation (ordinary readings, the plain P4 ANSWERED-family
 * ack) stays toggle-gated; this predicate must never widen beyond the exact
 * five strings above.
 */
export function isP4DeclineAck(conf: DedupeKeySource): boolean {
  return conf.field == null && DECLINE_ACK_TEXT_SET.has(conf.text.trim());
}

/**
 * 2026-08-14 (PLAN-G cycle-1 mini-review fix): a forced decline ack that
 * fails to enqueue can only be TTS-unavailable — `force:true` rules out the
 * confirmation-mode toggle as the cause — so its reservation must be
 * released, or a genuine LATER decline landing on the same rotated text
 * would be silently swallowed forever. An ORDINARY (unforced) confirmation
 * muted by the toggle must keep its permanent reservation (a muted
 * confirmation the inspector chose not to hear should not re-prompt), so
 * this only ever returns true for the P4 decline family. Extracted as its
 * own exported function (rather than an inline conditional in
 * recording-context.tsx) so it is unit-testable directly — the previous
 * cycle's test reimplemented this conditional against a bare
 * `ConfirmationDedupeStore`, which would stay green even if
 * `recording-context.tsx`'s own call to this logic broke or was deleted.
 */
export function shouldReleaseP4DeclineReservation(
  isP4Decline: boolean,
  enqueued: boolean
): boolean {
  return isP4Decline && !enqueued;
}

/**
 * Literal port of iOS `buildConfirmationDedupeKey` branch selection:
 * token precedence for allowlisted text-op fields (every branch), then
 * single-circuit wins, then multi-circuit broadcast, then degenerate.
 */
export function buildConfirmationDedupeKey(conf: DedupeKeySource): string {
  const field = conf.field ?? 'unknown';
  if (isObservationRecodeConfirmation(conf)) {
    return `observation_recode_${conf.dedupe_token}`;
  }
  // Plan B B3.2 (feedback ids 118/119) — a `duplicate_<turnId>` token wins
  // ahead of the §A1a allowlist check below. The backend's exact-duplicate
  // re-speak ("Already got …") and its fast-ledger pending fallback can fire
  // for ANY measured field, not just the six wire/client-enrolled text-op
  // fields, and the allowlist route only works per-named-field. This is a
  // structurally separate branch — NOT an allowlist addition — because
  // measured-value fields deliberately IGNORE dedupe_token otherwise (the
  // id-84 correction-swallow fix): adding to the allowlist per field would
  // reopen that bug for each field added. Mirrors the identical branch in
  // the backend's `src/extraction/ios-dedupe-key.js` (all three key
  // builders) and iOS `buildConfirmationDedupeKey`.
  //
  // PLAN-F2 finding 5 (2026-08-14) — `bulkoutcome_<turnId>_<callId>_<board>`
  // is the SAME kind of structural token: dispatchSetFieldForAllCircuits's
  // zero-applied/fallback disclosure can target any circuit reading field,
  // not just the allowlist, so it needs the same prefix-wins-first
  // treatment as `duplicate_` — never an allowlist addition.
  if (
    conf.dedupe_token &&
    (conf.dedupe_token.startsWith('duplicate_') || conf.dedupe_token.startsWith('bulkoutcome_'))
  ) {
    return `${field}_${conf.dedupe_token}`;
  }
  // §A1a — token precedence for the allowlisted text-op fields, in every
  // branch (single-circuit, multi-circuit AND degenerate). Empty-string
  // token treated as absent (mirrors the JS `opToken &&` falsiness in
  // ios-dedupe-key.js and the Swift `!token.isEmpty` guard).
  if (conf.dedupe_token && conf.field && WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has(conf.field)) {
    return `${conf.field}_${conf.dedupe_token}`;
  }
  if (conf.circuit != null) {
    // Single-circuit: VALUE-AWARE "{field}_{circuit}_{djb2(text)}" shape
    // (id-84 correction-swallow fix, 2026-07-24). The confirmation text
    // encodes the value, so a correction (0.83 → 0.63, DIFFERENT text)
    // produces a DISTINCT key and speaks, while a genuine duplicate (same
    // field+circuit+SAME text) still dedupes — matching the multi-circuit
    // branch. The prior value-LESS shape was deliberately kept so the iOS
    // local correction-TTS dedupe could cross-match these wire keys; that
    // cross-match is now INTENTIONALLY dropped (it permanently swallowed
    // the second read-back of a corrected value — session 2ACE7677 id-84).
    //
    // A2-multiboard item 10 (2026-07-28): `board_id` is folded into the hash
    // too, exactly as the degenerate branch below has always folded it. Two
    // boards routinely share circuit refs, so "circuit 1, Zs 0.55" on main and
    // the identical line on the garage board produced the SAME key and the
    // second read-back was silently swallowed — a dictated reading the
    // hands-free inspector never hears (Audio-First #1), though both writes
    // landed. Folding into the hash (rather than adding a key segment) keeps an
    // ABSENT board id hashing `text + ''` — byte-identical to the pre-item-10
    // key — so every single-board confirmation keeps the key it has today.
    return `${field}_${conf.circuit}_${djb2UInt64Decimal(conf.text + (conf.board_id ?? ''))}`;
  }
  if (conf.circuits != null && conf.circuits.length > 0) {
    // Multi-circuit broadcast: sorted circuits + djb2 of the spoken text.
    // A2-multiboard item 10 — `board_id` folded on the same terms; a fan-out is
    // if anything MORE collision-prone, since two boards' schedules commonly
    // run 1..N over the same refs with the same fields.
    const circuitKey = [...conf.circuits].sort((a, b) => a - b).join('-');
    return `${field}_${circuitKey}_${djb2UInt64Decimal(conf.text + (conf.board_id ?? ''))}`;
  }
  // Degenerate (board-level / supply / installation) — W2.3 shape:
  // boardId folded into the hashed string so same-field same-text
  // confirmations on different boards stay distinct.
  return `${field}_${djb2UInt64Decimal(conf.text + (conf.board_id ?? ''))}`;
}
