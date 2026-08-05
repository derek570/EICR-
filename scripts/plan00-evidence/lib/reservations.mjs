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
 *     lock-only crash state). Key derives from the non-caller-overridable
 *     requirement_key + generation; body carries one runner-minted
 *     cryptographically random opaque `attempt_ref`, the logical-allocation
 *     VersionId, requested model/tier and every prompt/tool/expectation
 *     digest. Provider dispatch is allowed ONLY after a 200 + exact
 *     versioned read-back, or after the same-invocation lost-200 recovery:
 *     on 412, if the current reservation's COMPLETE canonical body matches
 *     the frozen candidate retained by this still-running invocation AND
 *     the invocation-local dispatch latch proves dispatch has not begun,
 *     treat it as recovery of this runner's lost 200 (exactly one dispatch
 *     permitted). A valid reservation with a different attempt_ref is
 *     another winner: call NO provider. Any same-ref key/body mismatch is
 *     an integrity HOLD/BLOCK.
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

function versionOk(versionId) {
  return typeof versionId === 'string' && versionId.length > 0 && versionId !== 'null';
}

/**
 * Try to allocate ONE specific ordinal. Outcomes:
 *  - { allocated: true, versionId, key, body }        — this invocation owns it
 *  - { allocated: false, taken: true, winner }        — valid other winner; pick next ordinal AFTER a refold
 *  - { allocated: false, hold: {...} }                — integrity HOLD/BLOCK
 */
export async function allocateOrdinal(store, { cohortId, lane, ordinal, allocator }) {
  const key = ordinalReservationKey({ cohortId, lane, ordinal });
  const body = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    reservation_kind: 'logical_ordinal',
    cohort_id: cohortId,
    lane,
    ordinal,
    allocator: allocator ?? null,
    nonce: `ord_${randomBytes(16).toString('hex')}`,
  };
  const bytes = canonicalBytes(body);
  for (let attempt = 0; ; attempt += 1) {
    const put = await store.putObjectIfAbsent({ key, bytes });
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
      return { allocated: true, key, versionId: put.versionId, body };
    }
    if (put.status === 412) {
      const back = await store.getObjectCurrent({ key });
      if (!back.found) {
        // Existing-but-unreadable: could be a delete marker hiding history.
        return { allocated: false, hold: { code: 'allocation_hidden_by_delete_marker', key } };
      }
      let winner;
      try {
        winner = JSON.parse(back.bytes.toString('utf8'));
      } catch {
        return { allocated: false, hold: { code: 'allocation_unparseable', key } };
      }
      if (sha256Hex(back.bytes) === sha256Hex(bytes)) {
        // Our own lost 200 (same nonce can only be ours).
        if (!versionOk(back.versionId)) {
          return { allocated: false, hold: { code: 'allocation_version_id_invalid', key } };
        }
        return { allocated: true, key, versionId: back.versionId, body, recovered: true };
      }
      if (
        winner?.reservation_kind !== 'logical_ordinal' ||
        winner?.lane !== lane ||
        winner?.ordinal !== ordinal ||
        winner?.cohort_id !== cohortId
      ) {
        return { allocated: false, hold: { code: 'allocation_winner_invalid', key } };
      }
      return { allocated: false, taken: true, winner };
    }
    if (put.status === 409) {
      // Never a new ordinal merely because of 409 — retry the SAME key.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      return { allocated: false, hold: { code: 'allocation_conflict_unresolved', key } };
    }
    return { allocated: false, hold: { code: `allocation_put_status_${put.status}`, key } };
  }
}

/**
 * Create (or recover) the atomic per-attempt-generation PENDING and decide
 * dispatch authorisation. `dispatchLatch` is the invocation-local latch:
 * { begun: boolean } owned by the caller and set to true ONLY by the caller
 * immediately before provider dispatch.
 *
 * Outcomes:
 *  - { authorised: true, attemptRef, key, versionId, lastModified, body }
 *  - { authorised: false, otherWinner: true, winnerRef }
 *  - { authorised: false, hold: {...} }
 */
export async function reserveAttemptPending(
  store,
  { cohortId, requirementKey, generation, requirement, dispatchLatch }
) {
  const attemptRef = mintAttemptRef();
  const key = attemptPendingKey({ cohortId, requirementKey, generation });
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
  const bytes = canonicalBytes(body);

  const resolve412 = async () => {
    const back = await store.getObjectCurrent({ key });
    if (!back.found) {
      return { authorised: false, hold: { code: 'pending_hidden_by_delete_marker', key } };
    }
    let current;
    try {
      current = JSON.parse(back.bytes.toString('utf8'));
    } catch {
      return { authorised: false, hold: { code: 'pending_unparseable', key } };
    }
    if (sha256Hex(back.bytes) === sha256Hex(bytes)) {
      // COMPLETE canonical body match ⇒ recovery of THIS invocation's lost
      // 200 — but only while the invocation-local latch proves dispatch has
      // not already begun.
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
        key,
        versionId: back.versionId,
        lastModified: back.lastModified,
        body,
      };
    }
    if (current?.attempt_ref && current.attempt_ref !== attemptRef) {
      // A valid reservation with a DIFFERENT ref is another winner — this
      // invocation calls no provider.
      if (
        current.reservation_kind !== 'attempt_pending' ||
        current.requirement_key !== requirementKey ||
        current.attempt_generation !== generation
      ) {
        return { authorised: false, hold: { code: 'pending_winner_invalid', key } };
      }
      return { authorised: false, otherWinner: true, winnerRef: current.attempt_ref };
    }
    // Same ref but different body — an integrity violation, never retry.
    return { authorised: false, hold: { code: 'pending_same_ref_body_mismatch', key } };
  };

  for (let attempt = 0; ; attempt += 1) {
    const put = await store.putObjectIfAbsent({ key, bytes });
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
        key,
        versionId: put.versionId,
        lastModified: back.lastModified,
        body,
      };
    }
    if (put.status === 412) {
      return resolve412();
    }
    if (put.status === 409) {
      // Refold-and-retry the EXACT same reservation key/ref/body; the 412
      // recovery rule applies after the retry. Never a skipped generation.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      return { authorised: false, hold: { code: 'pending_conflict_unresolved', key } };
    }
    return { authorised: false, hold: { code: `pending_put_status_${put.status}`, key } };
  }
}
