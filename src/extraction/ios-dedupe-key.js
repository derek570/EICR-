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
 * ── Operation dedupe tokens (field-feedback-2026-07-14 §A1a + PLAN-2C) ──
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
 * PLAN-2C adds a sixth WIRE/CLIENT-enrolled field, `postcode`. Its spoken
 * text can be byte-identical across two distinct amendments, so the
 * positional text hash cannot distinguish operation identity. Ordinary
 * measured-value fields still never carry a token — their VALUE-AWARE
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
 * The exact synchronized WIRE/CLIENT allowlist of confirmation fields whose
 * backend-emitted `dedupe_token` takes precedence in client keys and backend
 * telemetry. Mirrored in iOS `buildConfirmationDedupeKey` and web
 * `confirmation-dedupe-key.ts`; the drift test pins membership.
 */
export const WIRE_CLIENT_DEDUPE_TOKEN_FIELDS = new Set([
  'circuit_op',
  'observation',
  'observation_deletion',
  'field_cleared',
  'circuit_designation',
  'postcode',
]);

/**
 * Dispatcher-owned scope manifest for ordinary section-field token producers.
 *
 * This is deliberately NOT BOARD_CLEAR_SCOPE_MAP: clearability and dedupe
 * operation identity are separate contracts. A postcode write is installation
 * global even when the model supplies a board_id spelling, so the dispatcher
 * stamps `global` before the board-reading journal records the operation.
 * Future section fields must be adjudicated individually here and bring an
 * end-to-end producer test.
 */
export const WIRE_CLIENT_SECTION_DEDUPE_SCOPES = Object.freeze({
  postcode: 'global',
});

/**
 * Backend debounce policy is deliberately distinct from the wire/client
 * contract. PLAN-2 Phase-0 selected candidate 1: postcode was sent by the
 * backend and swallowed by the clients' session-permanent text key. Keeping
 * postcode OUT here preserves today's token-blind 1.5 s server debounce while
 * the wire/client key can distinguish later legitimate amendments.
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
 * PLAN-F2 finding 5 (2026-08-14) — structural token prefixes that win ahead
 * of the WIRE_CLIENT_DEDUPE_TOKEN_FIELDS allowlist check in every key
 * builder below, exactly like `duplicate_` already does (Plan B B3.2,
 * feedback ids 118/119): a `duplicate_<turnId>` exact-duplicate replay can
 * fire for ANY measured field, and a `bulkoutcome_<turnId>_<callId>_<board>`
 * disclosure token (stage6-event-bundler.js) is likewise minted for
 * whichever field dispatchSetFieldForAllCircuits targeted — never just the
 * five allowlisted text-op fields. A prefix SET (not a single string) is
 * the extension point for any future structural token family.
 */
const STRUCTURAL_DEDUPE_TOKEN_PREFIXES = ['duplicate_', 'bulkoutcome_'];

function hasStructuralTokenPrefix(opToken) {
  return (
    typeof opToken === 'string' &&
    STRUCTURAL_DEDUPE_TOKEN_PREFIXES.some((prefix) => opToken.startsWith(prefix))
  );
}

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
 * the wire/client allowlist, the token key takes precedence —
 * `{field}_{token}`. Ordinary measured-value fields ignore the token; their
 * value-aware shape does the correction-vs-duplicate separation on its own.
 *
 * A2-multiboard item 10 (2026-07-28): the wire `board_id` is folded into the
 * hashed string, exactly as the degenerate branch has always folded it. Two
 * boards routinely share circuit refs, so "circuit 1, Zs 0.55" on the main
 * board and the same line on the garage board produced the SAME key and the
 * second read-back was silently swallowed — a dictated reading the hands-free
 * inspector never hears (Audio-First #1), even though both writes landed.
 *
 * Folding into the hash rather than adding a key segment is deliberate: an
 * ABSENT board id hashes `text + ''`, i.e. byte-identical to the pre-item-10
 * key, so every single-board confirmation — the overwhelming majority — keeps
 * the key it has today and no existing session's dedupe state shifts. The wire
 * id is the right discriminator (not the dispatcher's effective board) because
 * the client can only compute the key from what it receives, and item 1
 * guarantees enrichment on exactly the cross-board turns that need it.
 *
 * @param {string} field
 * @param {number} circuit
 * @param {string} text  — the final TTS-line text the bundler emitted (encodes value)
 * @param {string|null|undefined} opToken — the wire `dedupe_token`, if any
 * @param {string|null|undefined} boardId — the wire `board_id`, if any
 * @returns {string}
 */
export function buildPerCircuitDedupeKey(field, circuit, text, opToken, boardId) {
  if (hasStructuralTokenPrefix(opToken)) {
    return `${field ?? 'unknown'}_${opToken}`;
  }
  if (opToken && WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  const composite = `${text ?? ''}${boardId ?? ''}`;
  return `${field ?? 'unknown'}_${circuit}_${djb2UInt64Decimal(composite)}`;
}

/**
 * Multi-circuit (broadcast) dedupe key. djb2 over the spoken TTS text.
 *
 * A2-multiboard item 10: `board_id` folded into the hashed string on the same
 * terms as the per-circuit branch above — a fan-out is if anything MORE prone
 * to the collision, since two boards' schedules commonly run 1..N over the
 * same refs with the same fields.
 *
 * @param {string} field
 * @param {number[]} circuits
 * @param {string} text  — the final TTS-line text the bundler emitted
 * @param {string|null|undefined} opToken — the wire `dedupe_token`, if any
 * @param {string|null|undefined} boardId — the wire `board_id`, if any
 * @returns {string}
 */
export function buildMultiCircuitDedupeKey(field, circuits, text, opToken, boardId) {
  // Plan B B3.2 (feedback ids 118/119): a `duplicate_<turnId>` token wins
  // ahead of the field-allowlist check below — an exact-duplicate re-speak
  // can fire for ANY measured field, not just the six wire/client-enrolled
  // text-op fields, and the allowlist route only works per-named-field.
  if (hasStructuralTokenPrefix(opToken)) {
    return `${field ?? 'unknown'}_${opToken}`;
  }
  // §A1a: token takes precedence in EVERY branch an allowlisted text-op
  // confirmation can reach (a grouped circuit_designation broadcast lands
  // here, not in the per-circuit branch).
  if (opToken && WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  const sorted = [...(circuits ?? [])].sort((a, b) => a - b);
  const circuitKey = sorted.join('-');
  const composite = `${text ?? ''}${boardId ?? ''}`;
  return `${field ?? 'unknown'}_${circuitKey}_${djb2UInt64Decimal(composite)}`;
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
  // Plan B B3.2 (feedback ids 118/119): duplicate_<turnId> wins ahead of the
  // field-allowlist check below — see buildMultiCircuitDedupeKey above for
  // why this must be a structurally separate prefix branch, not an
  // allowlist addition.
  if (hasStructuralTokenPrefix(opToken)) {
    return `${field ?? 'unknown'}_${opToken}`;
  }
  // §A1a: token takes precedence — this is the branch EVERY observation
  // deletion reaches (circuit:null + constant "Observation deleted" text →
  // identical hashed keys without the token).
  if (opToken && WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field}_${opToken}`;
  }
  const composite = `${text ?? ''}${boardId ?? ''}`;
  return `${field ?? 'unknown'}_${djb2UInt64Decimal(composite)}`;
}
