/**
 * Plan 00C §C5 — the ONE cohort-fingerprint derivation, shared by the
 * attest/init commands AND the fold's recompute (cycle-3: an initialization
 * whose stored fingerprint/cohort id does not reproduce from its bound
 * stage-A event + attested hashes can never advance).
 */

import { evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';

export function computeCohortFingerprint({ stageAPayload, combinedSha256 }) {
  const fingerprint = {
    deploy_run: stageAPayload.deploy_run,
    runtime: stageAPayload.runtime,
    evidence_bucket: stageAPayload.evidence_bucket,
    evidence_bucket_versioning: stageAPayload.evidence_bucket_versioning,
    event_schema_hash: stageAPayload.event_schema_hash,
    prompt_fingerprint: stageAPayload.prompt_fingerprint,
    tool_fingerprint: stageAPayload.tool_fingerprint,
    config_fingerprint: stageAPayload.config_fingerprint,
    semantic_oracle_digest: stageAPayload.semantic_oracle_digest,
    deployed_evidence_runtime_digest: stageAPayload.deployed_evidence_runtime_digest,
    expectations_combined_sha256: combinedSha256,
  };
  const hash = evidenceEventHash(fingerprint);
  return { fingerprint, hash, cohortId: `cohort-${hash.slice(0, 16)}` };
}
