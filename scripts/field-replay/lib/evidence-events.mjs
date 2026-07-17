/**
 * evidence-events.mjs — evidence event schema, TRUSTED-RUN verification,
 * append-only chains, expiry extensions, and the advisory consecutiveness
 * rule (plan Items 1/2/3/4).
 *
 * Evidence is NEVER self-asserted: an arbitrary local `--log` file is never
 * RED or GREEN proof (a matching log + attestation can be authored without
 * ever running the command, and CI cannot re-reproduce a historical RED
 * once the fixture later flips). The acceptance tool FETCHES the run and
 * artifact via authenticated `gh api`/`gh run download` and verifies
 * repository, workflow path (anchored blob), event, ref, head SHA,
 * conclusion, artifact name AND digest, fixture hash, assertion ID, and the
 * tested tree BEFORE reading anything. This module holds the PURE
 * verification/chain logic; the CLI injects the real gh fetchers.
 *
 * Evidence schema (a single SHA cannot identify both the code-under-test
 * and the harness — the harness commit is applied ON TOP of the baseline):
 *   { evidence_version, kind, corpus_id, assertion_id, subject_code_sha,
 *     harness_commit_sha, base_sha, tested_tree_oid, fixture_attestation_hash,
 *     exact_command, outcome, run: {id, repository, workflow_path,
 *     workflow_blob_sha, event, ref, head_sha, conclusion, artifact_name,
 *     artifact_digest, node_version}, model?, behaviour_fingerprint? }
 */

import { evidenceEventHash } from './canonical-crypto.mjs';

export const EVIDENCE_KINDS = Object.freeze(['red', 'green', 'advisory', 'expiry_extension']);

/** Bounded verification failure codes (mock-API tests pin these). */
export const EVIDENCE_ERROR_CODES = Object.freeze({
  WRONG_REPOSITORY: 'wrong_repository',
  WRONG_WORKFLOW: 'wrong_workflow_path',
  WORKFLOW_BLOB_MISMATCH: 'workflow_blob_mismatch',
  WRONG_EVENT: 'wrong_event',
  WRONG_REF: 'wrong_ref',
  WRONG_HEAD_SHA: 'wrong_head_sha',
  NOT_SUCCESS: 'non_success_conclusion',
  ARTIFACT_NAME: 'artifact_name_mismatch',
  ARTIFACT_DIGEST: 'artifact_digest_mismatch',
  FIXTURE_HASH: 'fixture_hash_mismatch',
  ASSERTION_ID: 'assertion_id_mismatch',
  TESTED_TREE: 'tested_tree_mismatch',
  APPEND_ONLY: 'append_only_violation',
  CHAIN_INTERRUPTED: 'advisory_chain_interrupted',
  CHAIN_TOO_SHORT: 'advisory_chain_too_short',
  FINGERPRINT_DRIFT: 'behaviour_fingerprint_drift',
  EXTENSION_CHAIN: 'extension_chain_invalid',
});

/**
 * Verify a fetched run + artifact against the expectations. `expected` and
 * `fetched` are plain objects; the CLI populates `fetched` from gh. Returns
 * { ok, errors: [code…] }.
 */
export function verifyTrustedRun(expected, fetched) {
  const errors = [];
  const want = (cond, code) => {
    if (!cond) errors.push(code);
  };
  want(fetched.repository === expected.repository, EVIDENCE_ERROR_CODES.WRONG_REPOSITORY);
  want(fetched.workflow_path === expected.workflow_path, EVIDENCE_ERROR_CODES.WRONG_WORKFLOW);
  if (expected.workflow_blob_sha != null) {
    want(
      fetched.workflow_blob_sha === expected.workflow_blob_sha,
      EVIDENCE_ERROR_CODES.WORKFLOW_BLOB_MISMATCH,
    );
  }
  if (expected.events != null) {
    want(expected.events.includes(fetched.event), EVIDENCE_ERROR_CODES.WRONG_EVENT);
  }
  if (expected.ref_pattern != null) {
    want(new RegExp(expected.ref_pattern).test(fetched.ref ?? ''), EVIDENCE_ERROR_CODES.WRONG_REF);
  }
  if (expected.head_sha != null) {
    want(fetched.head_sha === expected.head_sha, EVIDENCE_ERROR_CODES.WRONG_HEAD_SHA);
  }
  want(fetched.conclusion === 'success', EVIDENCE_ERROR_CODES.NOT_SUCCESS);
  want(fetched.artifact_name === expected.artifact_name, EVIDENCE_ERROR_CODES.ARTIFACT_NAME);
  if (expected.artifact_digest != null) {
    want(fetched.artifact_digest === expected.artifact_digest, EVIDENCE_ERROR_CODES.ARTIFACT_DIGEST);
  }
  if (expected.fixture_attestation_hash != null) {
    want(
      fetched.fixture_attestation_hash === expected.fixture_attestation_hash,
      EVIDENCE_ERROR_CODES.FIXTURE_HASH,
    );
  }
  if (expected.assertion_id != null) {
    want(fetched.assertion_id === expected.assertion_id, EVIDENCE_ERROR_CODES.ASSERTION_ID);
  }
  if (expected.tested_tree_oid != null) {
    want(fetched.tested_tree_oid === expected.tested_tree_oid, EVIDENCE_ERROR_CODES.TESTED_TREE);
  }
  return { ok: errors.length === 0, errors };
}

/** Build the immutable evidence event + its attestation (hash sidecar). */
export function buildEvidenceEvent(payload) {
  if (!EVIDENCE_KINDS.includes(payload.kind)) {
    throw new Error(`unknown evidence kind "${payload.kind}"`);
  }
  const event = { evidence_version: 1, ...payload };
  return { event, attestation: { event_hash: evidenceEventHash(event) } };
}

/**
 * Append-only guard: `existingNames` are the files already in the fixture's
 * evidence directory; overwrites are rejected.
 */
export function assertAppendOnly(existingNames, newName) {
  if (existingNames.includes(newName)) {
    const err = new Error(`evidence file ${newName} already exists — evidence is append-only`);
    err.code = EVIDENCE_ERROR_CODES.APPEND_ONLY;
    throw err;
  }
}

/**
 * Advisory consecutiveness (Item 3): GREEN evidence = three consecutive
 * QUALIFYING executions of the same fixture + assertion + model +
 * behaviour_fingerprint, with any intervening qualifying failure resetting
 * the chain. `history` is the ordered list of advisory evidence events for
 * one fixture (oldest first). Returns { ok, errors, chain } where `chain`
 * is the qualifying tail.
 */
export function validateAdvisoryGreenChain(history, { requiredLength = 3 } = {}) {
  const errors = [];
  if (!Array.isArray(history) || history.length === 0) {
    return { ok: false, errors: [EVIDENCE_ERROR_CODES.CHAIN_TOO_SHORT], chain: [] };
  }
  const tail = [];
  for (const ev of history) {
    if (ev.outcome === 'pass') {
      if (tail.length > 0) {
        const prev = tail[tail.length - 1];
        if (
          prev.behaviour_fingerprint !== ev.behaviour_fingerprint ||
          prev.model !== ev.model ||
          prev.assertion_id !== ev.assertion_id
        ) {
          // Fingerprint/model/assertion change RESETS the chain.
          tail.length = 0;
        }
      }
      tail.push(ev);
    } else {
      // Any qualifying failure resets.
      tail.length = 0;
    }
  }
  if (tail.length < requiredLength) {
    errors.push(
      tail.length === 0 ? EVIDENCE_ERROR_CODES.CHAIN_INTERRUPTED : EVIDENCE_ERROR_CODES.CHAIN_TOO_SHORT,
    );
    return { ok: false, errors, chain: tail };
  }
  // Distinct run ids (three separate GitHub runs, not one re-read).
  const runIds = new Set(tail.slice(-requiredLength).map((e) => e.run?.id));
  if (runIds.size < requiredLength) {
    return { ok: false, errors: [EVIDENCE_ERROR_CODES.CHAIN_TOO_SHORT], chain: tail };
  }
  return { ok: true, errors: [], chain: tail.slice(-requiredLength) };
}

/**
 * Expiry-extension chain (Item 2): append-only `expiry_extension` events
 * {corpus_id, prior_expires_at, new_expires_at, reason, reviewer,
 * fix_reference}. The runner resolves a validated CHRONOLOGICAL chain —
 * gaps (prior != current effective expiry), backward dates, missing
 * reason/reviewer, or exceeding the policy bounds reject. Returns
 * { ok, errors, effectiveExpiry }.
 */
export function resolveExpiryChain(initialExpiresAtIso, extensions, policy = { maxExtensions: 2, extensionDays: 14 }) {
  const errors = [];
  let effective = Date.parse(initialExpiresAtIso);
  if (Number.isNaN(effective)) {
    return { ok: false, errors: [EVIDENCE_ERROR_CODES.EXTENSION_CHAIN], effectiveExpiry: null };
  }
  if (extensions.length > policy.maxExtensions) {
    errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
  }
  for (const ext of extensions) {
    const prior = Date.parse(ext.prior_expires_at);
    const next = Date.parse(ext.new_expires_at);
    if (Number.isNaN(prior) || Number.isNaN(next)) {
      errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
      break;
    }
    if (prior !== effective) {
      // Gap: the extension must chain off the CURRENT effective expiry.
      errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
      break;
    }
    if (next <= prior) {
      errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
      break;
    }
    if (next - prior > policy.extensionDays * 24 * 60 * 60 * 1000) {
      errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
      break;
    }
    if (!ext.reason || !ext.reviewer) {
      errors.push(EVIDENCE_ERROR_CODES.EXTENSION_CHAIN);
      break;
    }
    effective = next;
  }
  return { ok: errors.length === 0, errors, effectiveExpiry: errors.length ? null : new Date(effective).toISOString() };
}

/**
 * Expiry evaluation uses the REAL CI wall clock captured BEFORE the
 * scenario fake clock installs — never replay time (an old fixture
 * timestamp must never make an expired failure look unexpired).
 */
export function isExpired(effectiveExpiryIso, wallClockNowMs) {
  return wallClockNowMs >= Date.parse(effectiveExpiryIso);
}
