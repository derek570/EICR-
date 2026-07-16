/**
 * evidence-accept-core.mjs — the three evidence-acceptance modes (plan
 * Item 1 "Evidence logs get the same treatment"), with INJECTED fetchers so
 * tests can mock the GitHub API. The CLI (accept-evidence.mjs) supplies the
 * real `gh`-backed fetchers.
 *
 * Modes:
 *   red      — --manifest + --run-id + --artifact-name: SOURCE-DERIVED RED
 *              evidence; ADDITIONALLY scans the fetched artifact against
 *              the private raw-ID map locally (the manifest never enters CI).
 *   green    — --fixture + --attestation + --run-id + --artifact-name:
 *              deterministic GREEN evidence; opaque IDs + generic scans
 *              only, NO private manifest.
 *   advisory — --run-id + --artifact-name: live-lane advisory evidence;
 *              enforces per-fixture consecutiveness and REJECTS
 *              known_red→green_evidence flips without a valid three-event
 *              chain.
 *
 * ALL modes use TRUSTED-RUN retrieval: the tool itself fetches the run and
 * artifact and verifies repository, workflow path/blob, event, ref, head
 * SHA, conclusion, artifact name + digest, fixture hash, assertion ID, and
 * tested tree BEFORE reading the result tuple. A locally supplied artifact
 * file alone is never acceptable evidence.
 */

import {
  verifyTrustedRun,
  buildEvidenceEvent,
  assertAppendOnly,
  validateAdvisoryGreenChain,
} from './evidence-events.mjs';
import { scanRawContent } from './pii-scanner.mjs';

export const TRUSTED = Object.freeze({
  repository: 'derek570/EICR-',
  deterministic_workflow_path: '.github/workflows/field-replay-evidence.yml',
  advisory_workflow_path: '.github/workflows/field-replay-nightly.yml',
  deterministic_events: ['push', 'pull_request', 'workflow_dispatch'],
  advisory_events: ['schedule', 'workflow_dispatch'],
});

/**
 * Shared retrieval + verification. `fetchers` = { getRun(runId),
 * getArtifact(runId, name), getAnchoredWorkflowBlobSha(path) } — getRun
 * returns the run metadata shape of verifyTrustedRun's `fetched`;
 * getArtifact returns { bytes, digest, name }.
 */
export async function retrieveTrustedResult({ mode, runId, artifactName, fetchers, expectedOverrides = {} }) {
  const run = await fetchers.getRun(runId);
  const artifact = await fetchers.getArtifact(runId, artifactName);
  const workflowPath =
    mode === 'advisory' ? TRUSTED.advisory_workflow_path : TRUSTED.deterministic_workflow_path;
  const anchoredBlobSha = fetchers.getAnchoredWorkflowBlobSha
    ? await fetchers.getAnchoredWorkflowBlobSha(workflowPath)
    : null;

  let parsed = null;
  try {
    parsed = JSON.parse(artifact.bytes.toString('utf8'));
  } catch {
    throw new Error('artifact is not parseable structured runner output');
  }

  const expected = {
    repository: TRUSTED.repository,
    workflow_path: workflowPath,
    workflow_blob_sha: anchoredBlobSha,
    events: mode === 'advisory' ? TRUSTED.advisory_events : TRUSTED.deterministic_events,
    artifact_name: artifactName,
    ...expectedOverrides,
  };
  const fetched = {
    repository: run.repository,
    workflow_path: run.workflow_path,
    workflow_blob_sha: run.workflow_blob_sha,
    event: run.event,
    ref: run.ref,
    head_sha: run.head_sha,
    conclusion: run.conclusion,
    artifact_name: artifact.name,
    artifact_digest: artifact.digest,
    fixture_attestation_hash: parsed.fixture_attestation_hash ?? null,
    assertion_id: parsed.assertion_id ?? null,
    tested_tree_oid: parsed.tested_tree_oid ?? null,
  };
  const verdict = verifyTrustedRun(expected, fetched);
  if (!verdict.ok) {
    const err = new Error(`trusted-run verification failed: ${verdict.errors.join(', ')}`);
    err.codes = verdict.errors;
    throw err;
  }
  return { run, artifact, parsed };
}

/** RED evidence: manifest-driven, local raw-ID scan of the fetched bytes. */
export async function acceptRedEvidence({ manifest, runId, artifactName, fetchers, expectedOverrides, existingEvidenceNames = [] }) {
  const { run, artifact, parsed } = await retrieveTrustedResult({
    mode: 'red',
    runId,
    artifactName,
    fetchers,
    expectedOverrides,
  });
  // Local raw-ID scan — the manifest never enters CI, so THIS is where the
  // private raw fragments are checked against the fetched artifact.
  const fragments = Object.keys(manifest?.raw_id_map ?? {});
  const scan = scanRawContent(artifact.bytes, artifactName, { manifestFragments: fragments });
  const rawIdHits = scan.findings.filter((f) => f.code === 'manifest_listed_fragment');
  if (rawIdHits.length > 0) {
    throw new Error(`fetched RED artifact contains ${rawIdHits.length} private raw-ID fragment(s) — evidence rejected`);
  }
  const { event, attestation } = buildEvidenceEvent({
    kind: 'red',
    corpus_id: parsed.corpus_id,
    assertion_id: parsed.assertion_id,
    subject_code_sha: parsed.subject_code_sha,
    harness_commit_sha: parsed.harness_commit_sha,
    base_sha: parsed.base_sha ?? null,
    tested_tree_oid: parsed.tested_tree_oid ?? null,
    fixture_attestation_hash: parsed.fixture_attestation_hash,
    exact_command: parsed.exact_command,
    outcome: parsed.outcome,
    run: {
      id: run.id,
      repository: run.repository,
      workflow_path: run.workflow_path,
      workflow_blob_sha: run.workflow_blob_sha,
      event: run.event,
      ref: run.ref,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      artifact_name: artifact.name,
      artifact_digest: artifact.digest,
      node_version: parsed.node_version ?? null,
    },
  });
  const name = `red-${parsed.assertion_id}-${run.id}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  assertAppendOnly(existingEvidenceNames, name);
  return { event, attestation, fileName: name };
}

/** GREEN evidence: fixture + attestation driven, no manifest. */
export async function acceptGreenEvidence({ attestation: fixtureAttestation, runId, artifactName, fetchers, expectedOverrides, existingEvidenceNames = [] }) {
  const { run, artifact, parsed } = await retrieveTrustedResult({
    mode: 'green',
    runId,
    artifactName,
    fetchers,
    expectedOverrides: {
      fixture_attestation_hash: fixtureAttestation.immutable_payload_hash,
      ...expectedOverrides,
    },
  });
  const scan = scanRawContent(artifact.bytes, artifactName);
  if (!scan.ok) {
    throw new Error(`fetched GREEN artifact fails the generic privacy scan (${scan.findings.map((f) => f.code).join(', ')})`);
  }
  const { event, attestation } = buildEvidenceEvent({
    kind: 'green',
    corpus_id: parsed.corpus_id,
    assertion_id: parsed.assertion_id,
    subject_code_sha: parsed.subject_code_sha,
    harness_commit_sha: parsed.harness_commit_sha ?? null,
    base_sha: parsed.base_sha ?? null,
    tested_tree_oid: parsed.tested_tree_oid ?? null,
    fixture_attestation_hash: parsed.fixture_attestation_hash,
    exact_command: parsed.exact_command,
    outcome: parsed.outcome,
    proof_state: parsed.proof_state ?? null,
    run: {
      id: run.id,
      repository: run.repository,
      workflow_path: run.workflow_path,
      workflow_blob_sha: run.workflow_blob_sha,
      event: run.event,
      ref: run.ref,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      artifact_name: artifact.name,
      artifact_digest: artifact.digest,
      node_version: parsed.node_version ?? null,
    },
  });
  const name = `green-${parsed.assertion_id}-${run.id}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  assertAppendOnly(existingEvidenceNames, name);
  return { event, attestation, fileName: name };
}

/**
 * Advisory evidence: enforces per-fixture consecutiveness; a lifecycle flip
 * `known_red → green_evidence` REQUIRES a valid three-event chain over the
 * same assertion + model + behaviour_fingerprint with distinct run ids.
 */
export async function acceptAdvisoryEvidence({ runId, artifactName, fetchers, expectedOverrides, existingEvidenceNames = [], history = [], lifecycleFlipRequested = false }) {
  const { run, artifact, parsed } = await retrieveTrustedResult({
    mode: 'advisory',
    runId,
    artifactName,
    fetchers,
    expectedOverrides,
  });
  const scan = scanRawContent(artifact.bytes, artifactName);
  if (!scan.ok) {
    throw new Error(`fetched advisory artifact fails the generic privacy scan (${scan.findings.map((f) => f.code).join(', ')})`);
  }
  const { event, attestation } = buildEvidenceEvent({
    kind: 'advisory',
    corpus_id: parsed.corpus_id,
    assertion_id: parsed.assertion_id,
    model: parsed.model ?? null,
    behaviour_fingerprint: parsed.behaviour_fingerprint ?? null,
    outcome: parsed.outcome,
    run: {
      id: run.id,
      repository: run.repository,
      workflow_path: run.workflow_path,
      workflow_blob_sha: run.workflow_blob_sha,
      event: run.event,
      ref: run.ref,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
      artifact_name: artifact.name,
      artifact_digest: artifact.digest,
      node_version: parsed.node_version ?? null,
    },
  });
  if (lifecycleFlipRequested) {
    const chain = validateAdvisoryGreenChain([...history, event]);
    if (!chain.ok) {
      const err = new Error(`known_red → green_evidence rejected: ${chain.errors.join(', ')} (three consecutive qualifying executions required)`);
      err.codes = chain.errors;
      throw err;
    }
  }
  const name = `advisory-${parsed.assertion_id}-${run.id}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  assertAppendOnly(existingEvidenceNames, name);
  return { event, attestation, fileName: name };
}
