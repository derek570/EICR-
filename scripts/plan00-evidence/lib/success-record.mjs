/**
 * Plan 00B-4 §"Digest + success-record contract" — the success-artifact chain
 * every Plan-00 CLI command must prove before it writes anything.
 *
 * The 00B delivery shipped a trusted semantic oracle and recorded, in its `/ep`
 * success record, the exact SHA-256 of the expectation manifest that oracle was
 * proven against. Nothing in this repository ever read that record back: the
 * manifest could be regenerated, hand-edited or reverted and every downstream
 * command would carry on, because each of them compares the manifest to ITSELF
 * (`cmdAttestExpectations` recomputes the oracle from the checked-out sources
 * and compares it to the digest the same file declares — a self-consistent lie
 * passes). The success record is the one anchor OUTSIDE the manifest, written by
 * a run that was genuinely merged and deployed, so it is the only thing that can
 * distinguish "the manifest still says what it said when it was proven" from
 * "the manifest says something new and consistent".
 *
 * This module is deliberately PURE — filesystem reads and hashing only, with
 * every input injectable. The phase dispatch that layers cohort/Stage-A anchors
 * on top lives in `cli.mjs` beside the store helpers it needs; what lives here
 * is the part that is identical in all four phases.
 *
 * Every refusal names what was checked and states that nothing was written, so
 * an operator who hits one at 6am in a loft knows whether to regenerate, re-run
 * `/ep`, or stop.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The manifest the whole Plan-00 oracle contract is written against. */
export const PLAN00_MANIFEST_REPO_PATH = 'scripts/model-ab/plan00-expectation-manifest.json';

/** The artifact row id the 00B success record uses for that manifest. */
export const PLAN00_SUCCESS_ARTIFACT_ID = 'plan00_expectation_manifest';

/** The four phases of the operator sequence, in the order they are run. */
export const ANCHOR_MODES = Object.freeze(['publish', 'attest', 'init', 'run']);

/**
 * Where the 00B success record lives on the operator's machine. This is a
 * machine-local `/ep` artifact by construction — it is written by the executor
 * beside the plan it shipped, not committed to the repo — so the path is
 * resolved from `$HOME` and overridable, never hard-coded into a test.
 */
const DEFAULT_SUCCESS_RECORD_RELPATH =
  '.claude/handoffs/EICR_Automation--00b-trusted-semantic-oracle-2026-08-03/PLAN-final.md.ep-success.json';

export function defaultSuccessRecordPath(env = process.env, homedir = os.homedir()) {
  const override = env?.PLAN00_SUCCESS_RECORD;
  if (typeof override === 'string' && override.length > 0) return override;
  return path.join(homedir, DEFAULT_SUCCESS_RECORD_RELPATH);
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Schema-validate a shipped `/ep` success record.
 *
 * Returns a list of human-readable problems rather than throwing, so a caller
 * can report ALL of them at once — an operator fixing a record one refusal at a
 * time is an operator who runs the command five times.
 *
 * The record only counts as an anchor when it describes a genuinely SHIPPED
 * outcome: `/ep` writes success records exclusively for merged-and-deployed
 * runs, so a `terminal_class` or `deploy.result` saying anything else means the
 * file was hand-edited, and a hand-edited anchor anchors nothing.
 */
export function validateSuccessRecordSchema(record) {
  const problems = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['record is not a JSON object'];
  }
  if (record.schema_version !== 1) {
    problems.push(`schema_version must be 1 (got ${JSON.stringify(record.schema_version)})`);
  }
  if (record.terminal_class !== 'shipped') {
    problems.push(
      `terminal_class must be "shipped" (got ${JSON.stringify(record.terminal_class)}) — ` +
        'a held, partial or failed run is not an anchor'
    );
  }
  if (!record.plan || typeof record.plan !== 'object') {
    problems.push('plan block missing');
  } else if (!HEX64.test(String(record.plan.sha256 ?? ''))) {
    problems.push('plan.sha256 is not a sha256 hex digest');
  }
  if (!HEX40.test(String(record.merge_commit ?? ''))) {
    problems.push('merge_commit is not a 40-hex commit sha');
  }
  if (!record.deploy || typeof record.deploy !== 'object') {
    problems.push('deploy block missing');
  } else if (record.deploy.result !== 'success') {
    problems.push(`deploy.result must be "success" (got ${JSON.stringify(record.deploy.result)})`);
  }
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    problems.push('artifacts must be a non-empty array');
  }
  return problems;
}

/**
 * Find the manifest artifact row.
 *
 * Requires EXACTLY ONE row with the id — duplicate rows would let a tamperer
 * append a second row whose sha matches an edited manifest and rely on
 * whichever one a `find()` happened to reach first. Also requires the row's
 * `path` to be the manifest this CLI actually reads: a row that names some
 * other file would pass a hash comparison that proves nothing about the
 * manifest, which is worse than no check at all because it looks like one.
 */
export function findManifestArtifactRow(record) {
  const rows = (record?.artifacts ?? []).filter((a) => a?.id === PLAN00_SUCCESS_ARTIFACT_ID);
  if (rows.length !== 1) {
    throw new Error(
      `success record must carry EXACTLY ONE "${PLAN00_SUCCESS_ARTIFACT_ID}" artifact row ` +
        `(found ${rows.length})`
    );
  }
  const row = rows[0];
  if (row.path !== PLAN00_MANIFEST_REPO_PATH) {
    throw new Error(
      `"${PLAN00_SUCCESS_ARTIFACT_ID}" row names ${JSON.stringify(row.path)} but the manifest ` +
        `under contract is ${PLAN00_MANIFEST_REPO_PATH} — the recorded hash is about a ` +
        'different file'
    );
  }
  if (!HEX64.test(String(row.sha256 ?? ''))) {
    throw new Error(`"${PLAN00_SUCCESS_ARTIFACT_ID}" row sha256 is not a sha256 hex digest`);
  }
  return row;
}

/** Read + parse the success record, reporting the path in every failure. */
export function readSuccessRecordFile(recordPath) {
  let raw;
  try {
    raw = readFileSync(recordPath, 'utf8');
  } catch (err) {
    throw new Error(
      `REFUSED: the 00B success record is unreadable at ${recordPath} (${err.code ?? err.message}). ` +
        'It is the only anchor outside the manifest; without it the oracle digest can only be ' +
        'compared to itself. Nothing was written.'
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `REFUSED: the 00B success record at ${recordPath} is not valid JSON (${err.message}). ` +
        'Nothing was written.'
    );
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The phase-INDEPENDENT half of the validator: the shipped success record still
 * describes the manifest that is checked out, and the checked-out oracle
 * sources still hash to what that manifest declares.
 *
 * Ordering is deliberate — record schema, then artifact row, then the manifest
 * bytes, then the (comparatively expensive) oracle recompute. A tampered record
 * refuses before any source tree is walked.
 */
export async function assertSuccessArtifactChain(overrides = {}) {
  const {
    recordPath = defaultSuccessRecordPath(),
    readRecord = () => readSuccessRecordFile(recordPath),
    readManifestBytes = null,
    readManifest,
    recomputeOracle,
    repoRoot = process.cwd(),
  } = overrides;

  const record = readRecord();
  const problems = validateSuccessRecordSchema(record);
  if (problems.length > 0) {
    throw new Error(
      `REFUSED: the 00B success record at ${recordPath} is not a valid shipped-run record ` +
        `(${problems.join('; ')}). Nothing was written.`
    );
  }

  let row;
  try {
    row = findManifestArtifactRow(record);
  } catch (err) {
    throw new Error(`REFUSED: ${err.message} (${recordPath}). Nothing was written.`);
  }

  const bytes =
    readManifestBytes != null
      ? readManifestBytes()
      : readFileSync(path.join(repoRoot, PLAN00_MANIFEST_REPO_PATH));
  const manifestSha256 = sha256Hex(bytes);
  if (manifestSha256 !== row.sha256) {
    throw new Error(
      `REFUSED: ${PLAN00_MANIFEST_REPO_PATH} hashes to ${manifestSha256} but the shipped 00B ` +
        `success record pins ${row.sha256}. Either the manifest changed without a delivery that ` +
        'refreshed the record, or the record was edited. Nothing was written.'
    );
  }

  const manifest = readManifest();
  const oracleDigest = await recomputeOracle();
  if (oracleDigest !== manifest.semantic_oracle_digest) {
    throw new Error(
      'REFUSED: semantic_oracle_digest drift — the checked-out oracle sources hash to ' +
        `${oracleDigest} but the committed manifest declares ${manifest.semantic_oracle_digest}. ` +
        'Regenerate the manifest and re-attest. Nothing was written.'
    );
  }

  return { recordPath, record, row, manifestSha256, manifest, oracleDigest };
}

/**
 * The publish-phase DEPLOYMENT-IDENTITY test.
 *
 * A second `publish-stage-a` is not inherently wrong — it is the ONLY way a new
 * cohort becomes reachable, because `init-cohort` derives the cohort id from the
 * latest Stage-A payload. Blocking a publish whenever a cohort exists would
 * therefore make a post-deploy restart impossible, which contradicts the very
 * rule ("a source deploy voids the running count") this machinery exists to
 * enforce.
 *
 * What IS wrong is a REBIND: a publish whose deploy run id, head SHA and runtime
 * fingerprint all match the Stage-A event a live cohort is already bound to. It
 * cannot be a new deployment — it is the same one — so it can only be an attempt
 * to re-anchor a cohort that is already running, and it would produce a second
 * immutable Stage-A event describing the identical deployment for `init-cohort`
 * to fold into an identical cohort id.
 *
 * Any of the three differing means a genuinely different deployment, which is
 * ADMITTED: it writes a new Stage-A event, a subsequent `init-cohort` derives a
 * different cohort id, and the previous cohort is explicitly superseded rather
 * than extended. Neither path ever mutates an existing Stage-A event.
 */
export function assertNotStageARebind({ boundStageAPayload, candidate, cohortId }) {
  if (!boundStageAPayload) return { rebind: false, reason: 'no live cohort binds a stage_a event' };
  const bound = {
    run_id: String(boundStageAPayload.deploy_run?.run_id ?? ''),
    head_sha: String(boundStageAPayload.deploy_run?.head_sha ?? ''),
    deployment_fingerprint: String(boundStageAPayload.runtime?.deployment_fingerprint ?? ''),
  };
  const got = {
    run_id: String(candidate?.run_id ?? ''),
    head_sha: String(candidate?.head_sha ?? ''),
    deployment_fingerprint: String(candidate?.deployment_fingerprint ?? ''),
  };
  const differing = Object.keys(bound).filter((k) => bound[k] !== got[k]);
  if (differing.length === 0) {
    throw new Error(
      `REFUSED: this publish carries the SAME deploy run id (${got.run_id}), head sha ` +
        `(${got.head_sha.slice(0, 12)}) and runtime fingerprint as the stage_a_deployed event ` +
        `cohort ${cohortId} is already bound to — that is a rebind of a live cohort, not a new ` +
        'deployment. Deploy first, then publish. Nothing was written.'
    );
  }
  return { rebind: false, differing };
}
