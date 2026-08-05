/**
 * Plan 00C §C1 — conditional-create reservations.
 *
 * Two reservation classes, both deterministic-keyed, both created with
 * SigV4 `PutObject If-None-Match: *`, both read back and version-checked,
 * NEVER deleted or overwritten:
 *
 *  1. Logical new-work identity / run ordinals (`ir-repetition`,
 *     `corpus-run-haiku`, `corpus-run-luna`): a contender that receives 412
 *     reads and validates the winning allocation, calls no provider, and
 *     refolds before choosing the next unused ordinal. A 409 is NOT proof
 *     another writer won: retry the exact same key/identity; HOLD/BLOCK on
 *     any delete-marker or integrity conflict.
 *
 *  2. Per-attempt-generation PENDING objects — the reservation IS the
 *     authoritative `attempt_pending` record (no separate lock ⇒ no
 *     lock-only crash state). The key derives from the non-caller-
 *     overridable requirement_key + generation; the body carries one
 *     runner-minted cryptographically random opaque `attempt_ref`, the
 *     logical-allocation VersionId, requested model/tier and every
 *     prompt/tool/expectation digest.
 *
 * The invocation RETAINS its frozen candidate (`buildAttemptCandidate`) so
 * a lost 200 / transport error can be recovered by retrying `reserveAttempt`
 * with the SAME candidate: on 412, a COMPLETE canonical-body match against
 * the frozen candidate — while the invocation-local dispatch latch proves
 * dispatch has not begun — is recovery of this runner's lost 200 and
 * permits exactly one provider dispatch. A valid reservation with a
 * DIFFERENT attempt_ref is another winner (zero provider calls). Any
 * same-ref key/body mismatch is an integrity HOLD/BLOCK. A 409 retries the
 * exact same key/ref/body and never skips a generation or mints a new
 * ordinal.
 */

import { createHash, randomBytes } from 'node:crypto';
import { canonicalBytes } from '../../field-replay/lib/canonical-crypto.mjs';
import { EVIDENCE_PREFIX, EVIDENCE_SCHEMA_VERSION } from './constants.mjs';
import { sha256Hex } from './store.mjs';

export function mintAttemptRef() {
  return `att_${randomBytes(16).toString('hex')}`;
}

export function ordinalReservationKey({ cohortId, lane, ordinal }) {
  const padded = String(ordinal).padStart(6, '0');
  return `${EVIDENCE_PREFIX}/reservations/${cohortId}/${lane}/ordinal-${padded}.json`;
}

export function requirementKeyDigest(requirementKey) {
  return createHash('sha256').update(requirementKey, 'utf8').digest('hex');
}

export function attemptPendingKey({ cohortId, requirementKey, generation }) {
  return `${EVIDENCE_PREFIX}/reservations/${cohortId}/attempts/${requirementKeyDigest(requirementKey)}/gen-${generation}.json`;
}


/** Any delete marker in a reservation key's version history is an
 *  integrity violation: evidence is never deleted, so a marker means an
 *  operator mistake is hiding state — HOLD, never create-through. */
async function deleteMarkerHold(store, key, code) {
  if (typeof store.listAllVersions !== 'function') return null;
  const { deleteMarkers } = await store.listAllVersions({ prefix: key });
  if (deleteMarkers.some((d) => d.key === key)) return { code, key };
  return null;
}

function versionOk(versionId) {
  return typeof versionId === 'string' && versionId.length > 0 && versionId !== 'null';
}

/** Freeze an ordinal-allocation candidate (nonce identifies THIS invocation). */
export function buildOrdinalCandidate({ cohortId, lane, ordinal, allocator }) {
  const body = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    reservation_kind: 'logical_ordinal',
    cohort_id: cohortId,
    lane,
    ordinal,
    allocator: allocator ?? null,
    nonce: `ord_${randomBytes(16).toString('hex')}`,
  };
  return {
    key: ordinalReservationKey({ cohortId, lane, ordinal }),
    body,
    bytes: canonicalBytes(body),
  };
}

/**
 * Try to claim ONE specific ordinal with a frozen candidate. Retryable with
 * the SAME candidate after transport errors. Outcomes:
 *  - { allocated: true, versionId, recovered? }
 *  - { allocated: false, taken: true, winner }   — refold, then next ordinal
 *  - { allocated: false, hold: {...} }           — integrity HOLD/BLOCK
 */
export async function allocateOrdinal(store, candidate) {
  const { key, bytes, body } = candidate;
  const marker = await deleteMarkerHold(store, key, 'allocation_hidden_by_delete_marker');
  if (marker) return { allocated: false, hold: marker };

  const resolveExisting = async () => {
    const back = await store.getObjectCurrent({ key });
    if (!back.found) {
      return { allocated: false, hold: { code: 'allocation_hidden_by_delete_marker', key } };
    }
    if (sha256Hex(back.bytes) === sha256Hex(bytes)) {
      // Our own lost 200 — only this invocation knows this nonce.
      if (!versionOk(back.versionId)) {
        return { allocated: false, hold: { code: 'allocation_version_id_invalid', key } };
      }
      return { allocated: true, versionId: back.versionId, recovered: true };
    }
    let winner;
    try {
      winner = JSON.parse(back.bytes.toString('utf8'));
    } catch {
      return { allocated: false, hold: { code: 'allocation_unparseable', key } };
    }
    if (
      winner?.reservation_kind !== 'logical_ordinal' ||
      winner?.lane !== body.lane ||
      winner?.ordinal !== body.ordinal ||
      winner?.cohort_id !== body.cohort_id
    ) {
      return { allocated: false, hold: { code: 'allocation_winner_invalid', key } };
    }
    return { allocated: false, taken: true, winner };
  };

  for (let attempt = 0; ; attempt += 1) {
    let put;
    try {
      put = await store.putObjectIfAbsent({ key, bytes });
    } catch (err) {
      // Transport failure — the write may or may not have happened (a lost
      // 200). Resolve by reading back; a missing object means the write
      // never landed and the same candidate may retry.
      const existing = await resolveExisting();
      if (existing.hold?.code === 'allocation_hidden_by_delete_marker') {
        if (attempt < 4) continue;
        return { allocated: false, hold: { code: 'allocation_transport_unresolved', key, error: err?.message } };
      }
      return existing;
    }
    if (put.status === 200) {
      if (!versionOk(put.versionId)) {
        return { allocated: false, hold: { code: 'allocation_version_id_invalid', key } };
      }
      const back = await store.getObjectCurrent({ key });
      if (!back.found || back.versionId !== put.versionId) {
        return { allocated: false, hold: { code: 'allocation_readback_mismatch', key } };
      }
      if (sha256Hex(back.bytes) !== sha256Hex(bytes)) {
        return { allocated: false, hold: { code: 'allocation_content_mismatch', key } };
      }
      return { allocated: true, versionId: put.versionId };
    }
    if (put.status === 412) {
      return resolveExisting();
    }
    if (put.status === 409) {
      // Never a new ordinal merely because of 409 — retry the SAME key.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      return { allocated: false, hold: { code: 'allocation_conflict_unresolved', key } };
    }
    return { allocated: false, hold: { code: `allocation_put_status_${put.status}`, key } };
  }
}

/** Freeze the atomic per-attempt-generation PENDING candidate this
 *  invocation will retain across retries. `requirement_key` and generation
 *  come from the harness, never a caller override (plan §C1). */
export function buildAttemptCandidate({ cohortId, requirementKey, generation, requirement }) {
  const attemptRef = mintAttemptRef();
  const body = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    reservation_kind: 'attempt_pending',
    cohort_id: cohortId,
    requirement_key: requirementKey,
    attempt_generation: generation,
    attempt_ref: attemptRef,
    allocation_version_id: requirement?.allocationVersionId ?? null,
    requirement_class: requirement?.requirementClass ?? null,
    model: requirement?.model ?? null,
    tier: requirement?.tier ?? null,
    prompt_digest: requirement?.promptDigest ?? null,
    tool_digest: requirement?.toolDigest ?? null,
    expectation_digest: requirement?.expectationDigest ?? null,
  };
  return {
    attemptRef,
    key: attemptPendingKey({ cohortId, requirementKey, generation }),
    body,
    bytes: canonicalBytes(body),
  };
}

/**
 * Create (or recover) the atomic PENDING and decide dispatch authorisation.
 * `dispatchLatch` is the invocation-local latch { begun: boolean } owned by
 * the caller and set true ONLY immediately before provider dispatch.
 *
 * Outcomes:
 *  - { authorised: true, attemptRef, versionId, lastModified, recovered? }
 *  - { authorised: false, otherWinner: true, winnerRef }
 *  - { authorised: false, hold: {...} }
 */
export async function reserveAttempt(store, candidate, { dispatchLatch } = {}) {
  const { key, bytes, attemptRef, body } = candidate;
  const marker = await deleteMarkerHold(store, key, 'pending_hidden_by_delete_marker');
  if (marker) return { authorised: false, hold: marker };

  const resolveExisting = async ({ fromTransportError = false } = {}) => {
    const back = await store.getObjectCurrent({ key });
    if (!back.found) {
      if (fromTransportError) return { retry: true };
      return { authorised: false, hold: { code: 'pending_hidden_by_delete_marker', key } };
    }
    let current;
    try {
      current = JSON.parse(back.bytes.toString('utf8'));
    } catch {
      return { authorised: false, hold: { code: 'pending_unparseable', key } };
    }
    if (sha256Hex(back.bytes) === sha256Hex(bytes)) {
      // COMPLETE canonical-body match ⇒ recovery of THIS invocation's lost
      // 200 — permitted only while the local latch proves dispatch has not
      // begun.
      if (dispatchLatch?.begun) {
        return { authorised: false, hold: { code: 'recovery_after_dispatch_began', key } };
      }
      if (!versionOk(back.versionId)) {
        return { authorised: false, hold: { code: 'pending_version_id_invalid', key } };
      }
      return {
        authorised: true,
        recovered: true,
        attemptRef,
        versionId: back.versionId,
        lastModified: back.lastModified,
      };
    }
    if (
      current?.reservation_kind === 'attempt_pending' &&
      typeof current?.attempt_ref === 'string' &&
      current.attempt_ref !== attemptRef
    ) {
      // Cycle-5 — a different-ref winner is honoured ONLY when its COMPLETE
      // canonical body equals ours except the ref itself; any other field
      // divergence is an integrity conflict, never a silent concession.
      const ours = { ...body, attempt_ref: null };
      const theirs = { ...current, attempt_ref: null };
      if (sha256Hex(canonicalBytes(ours)) !== sha256Hex(canonicalBytes(theirs))) {
        return { authorised: false, hold: { code: 'pending_winner_field_divergence', key } };
      }
      return { authorised: false, otherWinner: true, winnerRef: current.attempt_ref };
    }
    // Same ref with a different body, or a malformed winner — integrity.
    return { authorised: false, hold: { code: 'pending_integrity_conflict', key } };
  };

  for (let attempt = 0; ; attempt += 1) {
    let put;
    try {
      put = await store.putObjectIfAbsent({ key, bytes });
    } catch (err) {
      const resolved = await resolveExisting({ fromTransportError: true });
      if (resolved.retry) {
        // Crash-before-create leaves NO attempt state — safely retryable.
        if (attempt < 4) continue;
        return {
          authorised: false,
          hold: { code: 'pending_transport_unresolved', key, error: err?.message },
        };
      }
      return resolved;
    }
    if (put.status === 200) {
      if (!versionOk(put.versionId)) {
        return { authorised: false, hold: { code: 'pending_version_id_invalid', key } };
      }
      const back = await store.getObjectCurrent({ key });
      if (!back.found || back.versionId !== put.versionId) {
        return { authorised: false, hold: { code: 'pending_readback_mismatch', key } };
      }
      if (sha256Hex(back.bytes) !== sha256Hex(bytes)) {
        return { authorised: false, hold: { code: 'pending_readback_content_mismatch', key } };
      }
      return {
        authorised: true,
        attemptRef,
        versionId: put.versionId,
        lastModified: back.lastModified,
      };
    }
    if (put.status === 412) {
      return resolveExisting();
    }
    if (put.status === 409) {
      // Refold-and-retry the EXACT same reservation key/ref/body; the 412
      // recovery rule applies after the retry. Never a skipped generation.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      return { authorised: false, hold: { code: 'pending_conflict_unresolved', key } };
    }
    return { authorised: false, hold: { code: `pending_put_status_${put.status}`, key } };
  }
}
