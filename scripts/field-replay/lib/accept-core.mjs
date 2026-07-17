/**
 * accept-core.mjs — stage 2 (acceptance) and stage 3 (CI validation) of the
 * fixture workflow (plan Item 1).
 *
 * Acceptance verifies freshness, provenance, PII review, raw-ID remapping,
 * and chime evidence AGAINST the private manifest, then emits the committed
 * fixture PLUS a sanitized PUBLIC review_attestation (immutable-payload
 * hash + opaque provenance references + keyed source commitments). CI
 * validation (stage 3) runs against the committed fixture + attestation
 * ONLY — no private manifest needed.
 *
 * Expiry policy (Derek, 2026-07-16): `expires_at` =
 * `review_attestation.accepted_at` + 30 days (UTC) — the accepted_at anchor
 * is immutable and known when acceptance runs (a merge-time anchor is
 * unimplementable: the immutable fixture is committed before the merge
 * exists). Max two 14-day extensions, 58-day hard bound (enforced by the
 * runner's extension-chain validation, not here).
 */

import {
  attestationPayloadHash,
  sourceCommitment,
} from './canonical-crypto.mjs';
import {
  validateFixtureDocument,
  immutableProjection,
  legalTransition,
} from './fixture-schema.mjs';
import { scanRawContent, scanParsedFixture } from './pii-scanner.mjs';

export const EXPIRY_POLICY = Object.freeze({
  initialDays: 30,
  maxExtensions: 2,
  extensionDays: 14,
  hardUpperBoundDays: 58,
});

export function computeExpiresAt(acceptedAtIso) {
  const t = Date.parse(acceptedAtIso);
  if (Number.isNaN(t)) throw new Error(`bad accepted_at: ${acceptedAtIso}`);
  return new Date(t + EXPIRY_POLICY.initialDays * 24 * 60 * 60 * 1000).toISOString();
}

function fail(code, message) {
  return { code, message };
}

/**
 * Stage-2 acceptance. Inputs are PARSED objects + raw bytes (the CLI owns
 * IO). Returns { ok, errors, fixture, attestation } — `fixture` is the
 * committed document (gate_state/expiry stamped), `attestation` the public
 * sidecar. Fails closed on: missing/mismatched manifest, non-fresh source
 * verdicts, unsanctioned chime provenance, PII findings, raw-ID residue.
 */
export async function acceptFixture({
  draftDoc,
  draftRawBytes,
  manifest,
  acceptedAtIso,
  reviewer,
  draftPath = '',
  outPath = '',
  isInsideCorpusRootFn,
}) {
  const errors = [];

  // Draft location guard: the basename rule alone must never be the only
  // guard — an ignored draft saved as fixture.yaml inside the corpus root
  // would still be discovered by the runner.
  if (isInsideCorpusRootFn && draftPath && isInsideCorpusRootFn(draftPath)) {
    errors.push(fail('draft_inside_corpus_root', `draft ${draftPath} sits inside the executable corpus root — drafts live in .field-replay-drafts/`));
  }

  // Manifest integrity.
  if (!manifest || manifest.manifest_version !== 1) {
    return { ok: false, errors: [fail('manifest_missing', 'private manifest missing or wrong version — acceptance fails closed')] };
  }
  if (manifest.corpus_id !== draftDoc?.corpus_id) {
    errors.push(fail('manifest_mismatch', `manifest corpus_id ${manifest.corpus_id} != draft ${draftDoc?.corpus_id}`));
  }
  for (const s of manifest.sources ?? []) {
    if (s.freshness?.status !== 'fresh') {
      errors.push(fail('source_stale', `manifest source ${s.type}:${s.role} computes ${s.freshness?.status}: ${s.freshness?.reason ?? ''}`));
    }
  }
  if (!manifest.privacy_review?.signed_off) {
    errors.push(fail('privacy_review_missing', 'human privacy review has not signed off in the private manifest'));
  }

  // Raw-ID remapping: no manifest-listed raw fragment may survive in the
  // draft bytes (keys of raw_id_map are the raw identifiers).
  const manifestFragments = Object.keys(manifest.raw_id_map ?? {});
  const rawScan = scanRawContent(draftRawBytes, outPath || 'fixture.yaml', { manifestFragments });
  for (const f of rawScan.findings) {
    errors.push(fail(`pii_${f.code}`, `privacy scan: ${f.code} "${f.match}"`));
  }
  const parsedScan = scanParsedFixture(draftDoc, outPath);
  for (const f of parsedScan.findings) {
    errors.push(fail(`pii_${f.code}`, `privacy scan (parsed): ${f.match} at ${f.path}`));
  }

  // Chime provenance: every chime_observed:true turn needs a recognized
  // correlation (machine or human-selected) in the manifest.
  const machineCorrelations = manifest.chime_correlations ?? [];
  const humanMappings = (manifest.chime_correlation_failures ?? []).filter(
    (f) => f.human_selected_transcript_ts != null,
  );
  const recognizedChimeCount = machineCorrelations.length + humanMappings.length;
  const chimeTurns = (draftDoc.turns ?? []).filter((t) => t.chime_observed === true);
  if (chimeTurns.length > recognizedChimeCount) {
    errors.push(fail('chime_provenance_unrecognized', `${chimeTurns.length} chime_observed turns but only ${recognizedChimeCount} recognized chime correlations in the manifest`));
  }

  // Document validation (with manifest fragments for the id checks).
  const docCheck = await validateFixtureDocument(draftDoc, { manifestFragments });
  for (const e of docCheck.errors) errors.push(fail(e.code, `${e.path}: ${e.message}`));

  // Purpose/gate-state admission rules.
  const gs = draftDoc.gate_state;
  if (gs === 'expected_red') {
    if (draftDoc.red_proof_failure_id !== draftDoc.expected_failure_id) {
      errors.push(fail('red_proof_mismatch', 'acceptance requires red_proof_failure_id === expected_failure_id'));
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Stamp expiry from the immutable accepted_at anchor (expected_red only).
  const fixture = JSON.parse(JSON.stringify(draftDoc));
  if (gs === 'expected_red') {
    fixture.expires_at = computeExpiresAt(acceptedAtIso);
  }

  // Re-derive committed source commitments from the manifest key so the
  // public attestation never carries a bare raw hash.
  const key = Buffer.from(manifest.commitment_key_hex, 'hex');
  const attestedSources = (manifest.sources ?? []).map((s) => ({
    type: s.type,
    role: s.role,
    commitment: sourceCommitment(key, {
      content_sha256: s.fingerprint,
      role: s.role,
      type: s.type,
    }),
    source_priority: s.source_priority,
  }));
  fixture.sources = attestedSources;

  const payloadHash = attestationPayloadHash(immutableProjection(fixture));
  const attestation = {
    attestation_version: 1,
    corpus_id: fixture.corpus_id,
    purpose: fixture.purpose,
    accepted_at: acceptedAtIso,
    reviewer,
    immutable_payload_hash: payloadHash,
    red_proof_failure_id: fixture.red_proof_failure_id ?? null,
    sources: attestedSources,
    privacy_review: 'pass',
  };

  return { ok: true, errors: [], fixture, attestation };
}

/**
 * Stage-3 CI validation: committed fixture + public attestation ONLY.
 * `previousVersion` (from the merge base) drives the history-anchored
 * immutability check when supplied.
 */
export async function validateCommittedFixture({ fixtureDoc, fixtureRawBytes, attestation, relPath = '', previousVersion = null }) {
  const errors = [];
  const docCheck = await validateFixtureDocument(fixtureDoc);
  for (const e of docCheck.errors) errors.push(fail(e.code, `${e.path}: ${e.message}`));

  // Governance attestation is OPTIONAL under the accident-class scope: a
  // committed fixture is validated STRUCTURALLY (schema + cross-field) and for
  // PRIVACY, but a signed review attestation is NOT required. When an
  // attestation IS supplied it is still verified (hash + corpus_id binding).
  // The signed-attestation REQUIREMENT — and the trusted-evidence / signed
  // governance layer generally — is deferred to field-replay-hardening-followups
  // (it is the malice-hardening the threat model defers).
  const recomputed = attestationPayloadHash(immutableProjection(fixtureDoc));
  if (attestation) {
    if (recomputed !== attestation.immutable_payload_hash) {
      errors.push(fail('attestation_hash_mismatch', 'immutable payload hash does not match the attestation (tampered fixture or regenerated hash)'));
    }
    if (attestation.corpus_id !== fixtureDoc.corpus_id) {
      errors.push(fail('attestation_mismatch', 'attestation corpus_id differs from the fixture'));
    }
  }

  // Generic privacy scans (no manifest in CI).
  const rawScan = scanRawContent(fixtureRawBytes, relPath);
  for (const f of rawScan.findings) errors.push(fail(`pii_${f.code}`, `privacy scan: ${f.code} "${f.match}"`));
  const parsedScan = scanParsedFixture(fixtureDoc, relPath);
  for (const f of parsedScan.findings) errors.push(fail(`pii_${f.code}`, `privacy scan (parsed): ${f.match}`));

  // History-anchored immutability: compare against the merge-base version.
  if (previousVersion) {
    const prevHash = attestationPayloadHash(immutableProjection(previousVersion.fixtureDoc));
    if (prevHash !== recomputed) {
      errors.push(fail('immutable_payload_changed', 'immutable projection differs from the merge-base version — only gate_state/expected_failure_id transitions are legal on an existing fixture'));
    }
    const t = legalTransition(previousVersion.fixtureDoc.gate_state, fixtureDoc.gate_state, previousVersion.transitionContext ?? {});
    if (!t.ok) {
      errors.push(fail('illegal_gate_transition', `gate_state ${previousVersion.fixtureDoc.gate_state} → ${fixtureDoc.gate_state}: ${t.reason}`));
    }
    // Removal of the ACTIVE expected_failure_id must equal the red proof.
    if (
      previousVersion.fixtureDoc.expected_failure_id != null &&
      fixtureDoc.expected_failure_id == null &&
      previousVersion.fixtureDoc.expected_failure_id !== previousVersion.fixtureDoc.red_proof_failure_id
    ) {
      errors.push(fail('illegal_failure_id_removal', 'removed expected_failure_id must equal the immutable red_proof_failure_id'));
    }
  }

  return { ok: errors.length === 0, errors };
}
