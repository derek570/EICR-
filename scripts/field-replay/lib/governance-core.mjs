/**
 * governance-core.mjs — pure verification of TRUSTED GOVERNANCE EVENTS
 * (plan Item 2 governance branch). Exceptional transitions —
 * expiry_extension, required_green → superseded, * → privacy_quarantined —
 * are not free-form fields: a bare `reviewer:` string is self-assertion.
 * Derek chose the SIGNED-COMMIT branch (Resolved decisions, 2026-07-16):
 * the exact governance-event commit, with the permitted diff only, must be
 * signed by an allowlisted key fingerprint (byte-for-byte binding) — NO
 * PR-review and NO distinct-approver requirement (that would re-create the
 * solo-maintainer impossibility). The machine-account two-phase protocol is
 * the DOCUMENTED FALLBACK only.
 *
 * Key BINDING is explicit: `verified: true` alone is INSUFFICIENT (it
 * accepts ANY GitHub-verified key associated with the committer). For SSH
 * signatures we compare the SshSignature.keyFingerprint byte-for-byte with
 * config/field-replay-maintainers.json; for GPG the key id/fingerprint.
 * The response is bound to the exact commit OID and the expected event
 * diff.
 *
 * The allowlist is read AT THE TARGET-BRANCH/BASE COMMIT, never the PR head
 * (a PR-head read lets a contributor add their own key and authorize a
 * transition in the same PR); an allowlist change is itself a governance
 * event signed by a key ALREADY present in the base allowlist; rotation and
 * the transition it authorizes can never share a PR.
 */

export const GOV_EVENT_TYPES = Object.freeze([
  'expiry_extension',
  'supersede',
  'privacy_quarantine',
  'mechanism_probe',
  'allowlist_rotation',
]);

export const GOV_ERROR = Object.freeze({
  UNKNOWN_TYPE: 'unknown_event_type',
  UNSIGNED: 'commit_not_signed',
  KEY_NOT_ALLOWLISTED: 'signing_key_not_allowlisted',
  WRONG_KEY_VERIFIED: 'wrong_but_verified_key',
  OID_MISMATCH: 'commit_oid_mismatch',
  DIFF_SCOPE: 'diff_touches_disallowed_paths',
  SELF_AUTHORIZING_ROTATION: 'rotation_and_transition_share_pr',
  GENESIS_REQUIRED: 'genesis_verification_required',
});

/**
 * Verify a signed governance commit. Inputs (CLI injects the real gh/git
 * values):
 *   - commitOid: the exact commit OID under test
 *   - signature: { verified, algorithm, keyFingerprint, keyId } from the
 *     GitHub GraphQL SshSignature/GpgSignature (verified === true means
 *     GitHub validated SOME key; we bind the fingerprint ourselves)
 *   - allowlist: the maintainers.json parsed AT THE BASE COMMIT
 *   - changedPaths: files the commit changes
 *   - permittedPaths: the paths this event type may touch
 *   - eventType: one of GOV_EVENT_TYPES
 * Returns { ok, errors: [{code, message}] }.
 */
export function verifyGovernanceCommit({ commitOid, boundOid, signature, allowlist, changedPaths, permittedPaths, eventType }) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });

  if (!GOV_EVENT_TYPES.includes(eventType)) {
    fail(GOV_ERROR.UNKNOWN_TYPE, `unknown governance event type "${eventType}"`);
    return { ok: false, errors };
  }
  if (boundOid != null && boundOid !== commitOid) {
    fail(GOV_ERROR.OID_MISMATCH, `signature bound to ${boundOid}, expected ${commitOid}`);
  }
  if (!signature || signature.verified !== true) {
    fail(GOV_ERROR.UNSIGNED, 'governance commit is not a verified signed commit');
    return { ok: false, errors };
  }
  // Explicit key binding — never trust verified:true alone.
  const fp = signature.keyFingerprint ?? signature.keyId ?? null;
  const match = (allowlist?.keys ?? []).find(
    (k) => k.fingerprint === fp || k.key_id === fp || k.keyId === fp,
  );
  if (!match) {
    // A GitHub-verified key that is NOT in the allowlist is the exact
    // wrong-but-verified-key case.
    fail(GOV_ERROR.WRONG_KEY_VERIFIED, `commit signed by a GitHub-verified key (${fp}) that is NOT in the base allowlist`);
    return { ok: false, errors };
  }
  // Diff scope: the commit may touch ONLY the permitted paths.
  const disallowed = (changedPaths ?? []).filter((p) => !permittedPaths.includes(p));
  if (disallowed.length > 0) {
    fail(GOV_ERROR.DIFF_SCOPE, `governance commit touches disallowed paths: ${disallowed.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Rotation guard: an allowlist_rotation event and any transition it
 * authorizes can never share a PR. `prEventTypes` is the set of governance
 * event types in the PR.
 */
export function checkRotationIsolation(prEventTypes) {
  const set = new Set(prEventTypes);
  if (set.has('allowlist_rotation') && [...set].some((t) => t !== 'allowlist_rotation')) {
    return [{ code: GOV_ERROR.SELF_AUTHORIZING_ROTATION, message: 'an allowlist rotation may not share a PR with the transition it authorizes' }];
  }
  return [];
}

/**
 * GENESIS rule: when no base allowlist exists, the first entry's signed
 * commit OID + fingerprint are verified directly (the already-allowlisted-
 * key rotation rule cannot apply to the first entry).
 */
export function verifyGenesis({ signature, genesisKey, commitOid, boundOid }) {
  const errors = [];
  if (boundOid != null && boundOid !== commitOid) {
    errors.push({ code: GOV_ERROR.OID_MISMATCH, message: 'genesis signature bound to a different commit' });
  }
  if (!signature || signature.verified !== true) {
    errors.push({ code: GOV_ERROR.UNSIGNED, message: 'genesis commit is not a verified signed commit' });
    return { ok: false, errors };
  }
  const fp = signature.keyFingerprint ?? signature.keyId ?? null;
  if (fp !== genesisKey.fingerprint) {
    errors.push({ code: GOV_ERROR.WRONG_KEY_VERIFIED, message: `genesis signed by ${fp}, expected the confirmed ${genesisKey.fingerprint}` });
  }
  return { ok: errors.length === 0, errors };
}
