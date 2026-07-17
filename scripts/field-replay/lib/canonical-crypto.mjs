/**
 * canonical-crypto.mjs — the ONE implementation of the field-replay corpus
 * crypto spec (plan: replay-corpus-gate-2026-07, Item 1).
 *
 * Spec (normative — two conforming-looking implementations must be
 * byte-identical):
 *   - Immutable projections serialize per RFC 8785 (JCS) via the PINNED
 *     `canonicalize` package (exact-version devDependency). Hand-rolled
 *     key-sorting is NOT RFC 8785 for edge-case numbers/strings, so the
 *     dependency is deliberate. Key-sorted UTF-8 JSON, array order
 *     PRESERVED, no Unicode normalization (input strings hash as-is), JCS
 *     number serialization, `null` serialized literally.
 *   - Deterministic identities: SHA-256(domain || 0x00 || canonical-bytes),
 *     domain-separated per identity-constants.mjs.
 *   - Keyed commitments: HMAC-SHA-256(perCorpusKey, domain || 0x00 ||
 *     canonical-bytes).
 *   - Digests render full lowercase hex except where a class pins a prefix +
 *     truncation rule.
 *   - Opaque public references: crypto.randomBytes(16) lowercase hex with a
 *     class prefix — RANDOM ONLY, never derived.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  DETERMINISTIC_ID_CLASSES,
  DOMAINS,
  OPAQUE_REF_CLASSES,
  OPAQUE_REF_RANDOM_BYTES,
  SOURCE_COMMITMENT_KEY_BYTES,
} from './identity-constants.mjs';

/** RFC 8785 canonical UTF-8 bytes of a JSON value. Throws on undefined /
 *  non-JSON values (a silent `undefined` would hash to an empty message and
 *  make two different inputs collide). */
export function canonicalBytes(value) {
  const s = canonicalize(value);
  if (typeof s !== 'string') {
    throw new Error('canonicalBytes: value is not JCS-serializable (got undefined)');
  }
  return Buffer.from(s, 'utf8');
}

/** SHA-256(domain || 0x00 || canonical-bytes) → full lowercase hex. */
export function domainHash(domain, value) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('domainHash: domain must be a non-empty string');
  }
  const h = createHash('sha256');
  h.update(Buffer.from(domain, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(canonicalBytes(value));
  return h.digest('hex');
}

/** HMAC-SHA-256(key, domain || 0x00 || canonical-bytes) → full lowercase hex.
 *  `key` is a Buffer (the per-corpus 256-bit key from the private manifest). */
export function keyedCommitment(keyBuffer, domain, value) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== SOURCE_COMMITMENT_KEY_BYTES) {
    throw new Error(
      `keyedCommitment: key must be a ${SOURCE_COMMITMENT_KEY_BYTES}-byte Buffer`,
    );
  }
  const h = createHmac('sha256', keyBuffer);
  h.update(Buffer.from(domain, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(canonicalBytes(value));
  return h.digest('hex');
}

/** Render a deterministic identity per its class (prefix + truncation). */
function renderIdentity(cls, fullHex) {
  return `${cls.prefix}${fullHex.slice(0, cls.truncationHexChars)}`;
}

/** Class-2: replay sessionId — computed ONCE per fixture, constant across
 *  turns. `frsess_<32hex>`. */
export function mintSessionId(corpusId) {
  const cls = DETERMINISTIC_ID_CLASSES.session;
  return renderIdentity(cls, domainHash(cls.domain, [corpusId]));
}

/** Class-2: replay generationId — one per (corpusId, turnIndex). */
export function mintGenerationId(corpusId, turnIndex) {
  const cls = DETERMINISTIC_ID_CLASSES.generation;
  return renderIdentity(cls, domainHash(cls.domain, [corpusId, turnIndex]));
}

/** Class-2: replay utteranceId — one per (corpusId, turnIndex), own domain. */
export function mintUtteranceId(corpusId, turnIndex) {
  const cls = DETERMINISTIC_ID_CLASSES.utterance;
  return renderIdentity(cls, domainHash(cls.domain, [corpusId, turnIndex]));
}

/** Class-2: fixture-local alias for the PRODUCTION-owned turnId. */
export function mintTurnAlias(corpusId, turnIndex) {
  const cls = DETERMINISTIC_ID_CLASSES.turnAlias;
  return renderIdentity(cls, domainHash(cls.domain, [corpusId, turnIndex]));
}

/** Class-2: public attestation payload hash (full 64-hex, no prefix). */
export function attestationPayloadHash(immutableProjection) {
  return domainHash(DOMAINS.FIXTURE_ATTESTATION, immutableProjection);
}

/** Class-2: evidence-event payload hash (full 64-hex, no prefix). */
export function evidenceEventHash(eventPayload) {
  return domainHash(DOMAINS.EVIDENCE_EVENT, eventPayload);
}

/** Class-3: keyed source commitment over the stable key-sorted source tuple
 *  {content_sha256, role, type}. Raw source hashes NEVER enter committed
 *  artifacts — only this keyed commitment does. */
export function sourceCommitment(keyBuffer, { content_sha256, role, type }) {
  if (!/^[0-9a-f]{64}$/.test(String(content_sha256))) {
    throw new Error('sourceCommitment: content_sha256 must be 64 lowercase hex chars');
  }
  return keyedCommitment(keyBuffer, DOMAINS.SOURCE_COMMITMENT, {
    content_sha256,
    role: String(role),
    type: String(type),
  });
}

/** Generate a per-corpus 256-bit commitment key (private-manifest only). */
export function generateCommitmentKey() {
  return randomBytes(SOURCE_COMMITMENT_KEY_BYTES);
}

/** Class-1: mint an opaque public reference (`frc_*` / `fix_*`). RANDOM
 *  ONLY — never derived from any input. Collision = regenerate upstream. */
export function mintOpaqueRef(className) {
  const cls = OPAQUE_REF_CLASSES[className];
  if (!cls) throw new Error(`mintOpaqueRef: unknown class "${className}"`);
  return `${cls.prefix}${randomBytes(OPAQUE_REF_RANDOM_BYTES).toString('hex')}`;
}

/** SHA-256 of raw bytes (for PRIVATE-manifest source fingerprints only —
 *  never committed; see sourceCommitment for the public form). */
export function rawSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
