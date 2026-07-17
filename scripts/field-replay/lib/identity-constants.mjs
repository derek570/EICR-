/**
 * identity-constants.mjs — THE single constants module pinning every identity
 * class used by the field-replay corpus (plan: replay-corpus-gate-2026-07,
 * Item 1 "canonical crypto spec").
 *
 * Three DISJOINT identity classes. Conflating them lets one implementation
 * derive what another randomizes, so the class split is normative:
 *
 *   1. RANDOM-ONLY public references (frc_*, fix_*): generated from
 *      crypto.randomBytes(16), lowercase hex, NEVER derived from any input.
 *      A derivable public reference would let anyone holding the raw capture
 *      re-derive the mapping the private manifest exists to protect.
 *
 *   2. DETERMINISTIC identities (replay session/generation/utterance ids,
 *      attestation + evidence hashes): SHA-256(domain || 0x00 || JCS-bytes),
 *      domain-separated so two identities over the same tuple can never
 *      collide. Rendering is full lowercase hex UNLESS the class pins a
 *      prefix + truncation below.
 *
 *   3. KEYED commitments (private-source commitments): HMAC-SHA-256 with a
 *      per-corpus random 256-bit key held ONLY in the private manifest. A
 *      bare SHA-256 of a raw source is itself a stable correlator — anyone
 *      holding a candidate capture can hash it and link the fixture back to
 *      the production session — so source commitments MUST be keyed.
 *
 * Every domain string lives here and nowhere else. Changing any value is a
 * breaking change to every committed fixture hash — do not edit without a
 * corpus-wide migration plan.
 */

/** Domain-separation strings for class-2 (deterministic) identities. */
export const DOMAINS = Object.freeze({
  /** Replay-runner sessionId — tuple: [corpusId]. ONE per fixture, constant
   *  across turns (a per-turn session identity would break multi-turn state,
   *  ask registries, turn numbering, and activeSessions attribution). */
  SESSION: 'field-replay/session',
  /** Replay-runner generationId — tuple: [corpusId, turnIndex]. */
  GENERATION: 'field-replay/generation',
  /** Replay-runner utteranceId — tuple: [corpusId, turnIndex]. Own domain so
   *  it can never equal a generation id over the same tuple. */
  UTTERANCE: 'field-replay/utterance',
  /** Fixture-local alias for the PRODUCTION-owned turnId (captured, then
   *  aliased) — tuple: [corpusId, turnIndex]. */
  TURN_ALIAS: 'field-replay/turn-alias',
  /** Public review-attestation payload hash — tuple: the fixture's immutable
   *  projection object (see fixture-hash.mjs). Full 64-char hex, no prefix. */
  FIXTURE_ATTESTATION: 'field-replay/fixture-attestation',
  /** Evidence-event payload hash — tuple: the evidence event object. Full
   *  64-char hex, no prefix. */
  EVIDENCE_EVENT: 'field-replay/evidence-event',
  /** Keyed source commitment (class 3) — HMAC message domain. Tuple: the
   *  key-sorted source tuple {content_sha256, role, type}. */
  SOURCE_COMMITMENT: 'field-replay/source-commitment',
});

/**
 * Class-1 opaque public reference classes. Format is `<prefix><32 lowercase
 * hex>` from crypto.randomBytes(16). NEVER UUID (the validator rejects
 * UUID-shaped ids), never base64 (path safety), never date/marker-encoded
 * (an id like `field-2026-07-16-f1` trivially links to the incident).
 */
export const OPAQUE_REF_CLASSES = Object.freeze({
  corpus: Object.freeze({ prefix: 'frc_', pattern: /^frc_[0-9a-f]{32}$/ }),
  fix: Object.freeze({ prefix: 'fix_', pattern: /^fix_[0-9a-f]{32}$/ }),
});

/**
 * Class-2 deterministic identity classes: domain + rendered prefix +
 * truncation (in hex chars of the full 64-char digest) + encoding.
 * `truncationHexChars: 64` means the full digest.
 */
export const DETERMINISTIC_ID_CLASSES = Object.freeze({
  session: Object.freeze({
    domain: DOMAINS.SESSION,
    prefix: 'frsess_',
    truncationHexChars: 32,
    encoding: 'lowercase-hex',
  }),
  generation: Object.freeze({
    domain: DOMAINS.GENERATION,
    prefix: 'frgen_',
    truncationHexChars: 32,
    encoding: 'lowercase-hex',
  }),
  utterance: Object.freeze({
    domain: DOMAINS.UTTERANCE,
    prefix: 'frutt_',
    truncationHexChars: 32,
    encoding: 'lowercase-hex',
  }),
  turnAlias: Object.freeze({
    domain: DOMAINS.TURN_ALIAS,
    prefix: 'frturn_',
    truncationHexChars: 32,
    encoding: 'lowercase-hex',
  }),
  fixtureAttestation: Object.freeze({
    domain: DOMAINS.FIXTURE_ATTESTATION,
    prefix: '',
    truncationHexChars: 64,
    encoding: 'lowercase-hex',
  }),
  evidenceEvent: Object.freeze({
    domain: DOMAINS.EVIDENCE_EVENT,
    prefix: '',
    truncationHexChars: 64,
    encoding: 'lowercase-hex',
  }),
});

/** Number of random bytes in a class-1 opaque reference (128-bit). */
export const OPAQUE_REF_RANDOM_BYTES = 16;

/** Byte length of a class-3 per-corpus HMAC key (256-bit), generated at
 *  conversion time and stored ONLY in the mode-0600 private manifest. */
export const SOURCE_COMMITMENT_KEY_BYTES = 32;
