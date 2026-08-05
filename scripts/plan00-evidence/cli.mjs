#!/usr/bin/env node
/**
 * Plan 00C §C4/C5 — the operator command surface.
 *
 *   node scripts/plan00-evidence/cli.mjs publish-stage-a --run-id <id> --head-sha <sha> [--role-proof iam|smoke --session-id <sid>]
 *   node scripts/plan00-evidence/cli.mjs attest-expectations
 *   node scripts/plan00-evidence/cli.mjs init-cohort
 *   node scripts/plan00-evidence/cli.mjs bind-session --session-id <sid>
 *   node scripts/plan00-evidence/cli.mjs attest-daily --session-ids <a,b> --confirmation-session <sid> --confirmation-ref <op_key> --heard true --result pass|fail
 *   node scripts/plan00-evidence/cli.mjs attest-dialogue-hearing --session-id <sid> --delivery-ref d:N --heard true --result pass|fail
 *   node scripts/plan00-evidence/cli.mjs decide-mismatch --mismatch-id <id> --decision approved|rejected
 *   node scripts/plan00-evidence/cli.mjs decide-corpus-gap --target <stratum-or-fixture> --decision approved|rejected
 *   node scripts/plan00-evidence/cli.mjs status [--cohort <id>] [--handoff <dir>]
 *
 * Machine-namespace publications (stage_a_deployed, attempt terminals,
 * production_session_bound) are schema-restricted to machine kinds; ONLY
 * the explicitly interactive commands above may create Derek-namespace
 * events, and each requires a TTY confirmation. This separation is
 * PROCEDURAL, not cryptographic — one maintainer, accident threat model.
 *
 * Every publisher and fold verifies bucket versioning FIRST (fail closed);
 * nothing here can overwrite or delete evidence.
 */

import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { EVIDENCE_BUCKET, EVIDENCE_PREFIX, STAGE_A_COHORT } from './lib/constants.mjs';
import { buildEvent, eventSchemaHash, validateStoredEvent } from './lib/events.mjs';
import {
  assertBucketVersioned,
  createS3Store,
  loadAuditedPrefix,
  publishDurable,
} from './lib/store.mjs';
import { foldEvidence } from './lib/fold.mjs';
import { collectSessionManifests } from './lib/collector.mjs';
import {
  checkLiveDeployment,
  proveTaskRolePrefixAccessViaIam,
  proveTaskRolePrefixAccessViaSmoke,
  verifyTrustedDeploy,
} from './lib/deployment.mjs';
import { writeProjections } from './lib/projections.mjs';
import { evidenceEventHash } from '../field-replay/lib/canonical-crypto.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_HANDOFF = path.join(
  process.env.HOME ?? '',
  '.claude/handoffs/EICR_Automation--00c-three-day-evidence-gate-2026-08-03'
);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function awsJson(cliArgs) {
  const { stdout } = await execFileAsync('aws', [...cliArgs, '--output', 'json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function ghRunFetcher(runId) {
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/derek570/EICR-/actions/runs/${runId}`,
  ]);
  const run = JSON.parse(stdout);
  const { stdout: jobsOut } = await execFileAsync('gh', [
    'api',
    `repos/derek570/EICR-/actions/runs/${runId}/jobs`,
    '--paginate',
  ]);
  const jobs = JSON.parse(jobsOut).jobs ?? [];
  return {
    repository: run.repository?.full_name ?? null,
    workflow_path: run.path ?? null,
    event: run.event ?? null,
    ref: `refs/heads/${run.head_branch}`,
    head_sha: run.head_sha ?? null,
    conclusion: run.conclusion ?? null,
    artifact_name: null,
    jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })),
  };
}

/** Interactive Derek confirmation — the ONLY path to a Derek-namespace
 *  event. Refuses when stdin is not a TTY (automated runners cannot invoke
 *  it); tests exercise the library layer, never this gate. */
async function confirmInteractive(summary) {
  if (!process.stdin.isTTY) {
    throw new Error('interactive confirmation required — refusing outside a TTY');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${summary}\nType "attest" to confirm: `);
    if (answer.trim() !== 'attest') throw new Error('confirmation declined');
  } finally {
    rl.close();
  }
}

function expectationManifestContent() {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/model-ab/plan00-expectation-manifest.json'), 'utf8')
  );
}

async function recomputeOracleDigest() {
  const mod = await import('../model-ab/lib/expectation-projection.mjs');
  return mod.computeSemanticOracleDigest(REPO_ROOT).digest;
}

async function publishEvent(store, { kind, cohortId, namespace, body }) {
  await assertBucketVersioned(store);
  const event = buildEvent({ kind, cohortId, namespace, body });
  const problems = validateStoredEvent({ key: event.key, payload: event.payload });
  if (problems.length > 0) {
    throw new Error(`refusing to publish invalid event: ${JSON.stringify(problems)}`);
  }
  const receipt = await publishDurable(store, { key: event.key, bytes: event.bytes });
  if (!receipt.ok) throw new Error(`publish failed: ${receipt.error} (${event.key})`);
  return { event, receipt };
}

async function loadCohortState(store, cohortId) {
  const stageA = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/${STAGE_A_COHORT}/`);
  const cohort = cohortId
    ? await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/${cohortId}/`)
    : { records: [], holds: [] };
  const reservations = cohortId
    ? await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/reservations/${cohortId}/`)
    : { records: [], holds: [] };
  return {
    stageARecords: stageA.records,
    cohortRecords: cohort.records,
    reservationRecords: reservations.records,
    integrityHolds: [...stageA.holds, ...cohort.holds, ...reservations.holds],
  };
}

function latestValid(records, kind) {
  const valid = records.filter(
    (r) =>
      r.payload?.kind === kind && validateStoredEvent({ key: r.key, payload: r.payload }).length === 0
  );
  return valid.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)).at(-1) ?? null;
}

/** Prospective cohort id/fingerprint from the current stage-A deploy event
 *  plus the attested expectation hashes (plan §C5). */
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

async function findCohortIds(store) {
  const { versions } = await store.listAllVersions({ prefix: `${EVIDENCE_PREFIX}/events/` });
  const ids = new Set();
  for (const v of versions) {
    const m = v.key.match(new RegExp(`^${EVIDENCE_PREFIX}/events/([^/]+)/`));
    if (m && m[1] !== STAGE_A_COHORT) ids.add(m[1]);
  }
  return [...ids].sort();
}

// ── subcommands ──────────────────────────────────────────────────────────

async function cmdPublishStageA(args, store) {
  const runId = args['run-id'];
  const headSha = args['head-sha'];
  if (!runId || !headSha) throw new Error('publish-stage-a requires --run-id and --head-sha');

  const deploy = await verifyTrustedDeploy({ runId, headSha, fetchRun: ghRunFetcher });
  if (!deploy.ok) throw new Error(`trusted-deploy verification failed: ${deploy.errors.join(', ')}`);

  const live = await checkLiveDeployment({ awsRunner: awsJson, expected: { commit_sha: headSha } });
  if (!live.available || !live.fingerprint_matches) {
    throw new Error(`live runtime does not match the deploy: ${live.reason}`);
  }

  // §C5 pre-stage task-role manifest-prefix proof — absent proof BLOCKS.
  const proofMode = args['role-proof'] ?? 'iam';
  let proof;
  if (proofMode === 'smoke') {
    if (!args['session-id']) throw new Error('--role-proof smoke requires --session-id');
    const fingerprint = args['deployment-fingerprint'];
    if (!fingerprint) throw new Error('--role-proof smoke requires --deployment-fingerprint');
    proof = await proveTaskRolePrefixAccessViaSmoke(store, {
      deploymentFingerprint: fingerprint,
      sessionId: args['session-id'],
    });
  } else {
    proof = await proveTaskRolePrefixAccessViaIam({
      awsRunner: awsJson,
      taskDefArn: live.live.task_def_arn,
    });
  }
  if (!proof.proven) {
    throw new Error(
      `task-role manifest-prefix proof FAILED (${JSON.stringify(proof)}) — fix IAM from source in a fresh handoff; stage_a_deployed is blocked`
    );
  }

  const versioning = await store.getBucketVersioningStatus();
  const oracle = await recomputeOracleDigest();
  const { event, receipt } = await publishEvent(store, {
    kind: 'stage_a_deployed',
    cohortId: STAGE_A_COHORT,
    namespace: 'machine',
    body: {
      deploy_run: {
        run_id: String(runId),
        head_sha: headSha,
        repository: deploy.run.repository,
        workflow_path: deploy.run.workflow_path,
      },
      runtime: live.live,
      evidence_bucket: store.bucket,
      evidence_bucket_versioning: versioning,
      config_fingerprint: null,
      tool_fingerprint: null,
      prompt_fingerprint: null,
      semantic_oracle_digest: oracle,
      deployed_evidence_runtime_digest: live.live.image_digest ?? null,
      event_schema_hash: eventSchemaHash(),
      role_prefix_proof: { mode: proof.mode ?? proofMode, proven: true },
    },
  });
  console.log(`stage_a_deployed published: ${event.key} (version ${receipt.versionId})`);
  console.log('Fold state is now STAGE_A_IMPLEMENTED (run `status` to verify).');
}

async function cmdAttestExpectations(args, store) {
  const manifest = expectationManifestContent();
  const oracle = await recomputeOracleDigest();
  if (oracle !== manifest.semantic_oracle_digest) {
    throw new Error('semantic_oracle_digest drift: checked-out sources no longer match the manifest');
  }
  const { stageARecords } = await loadCohortState(store, null);
  const stageA = latestValid(stageARecords, 'stage_a_deployed');
  if (!stageA) throw new Error('no valid stage_a_deployed event — run publish-stage-a first');
  const { cohortId, hash } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: manifest.combined_sha256,
  });
  await confirmInteractive(
    `Attest BOTH frozen expectation manifests?\n` +
      `  vendor_live sha256:          ${manifest.vendor_live_sha256}\n` +
      `  deterministic_egress sha256: ${manifest.deterministic_egress_sha256}\n` +
      `  combined sha256:             ${manifest.combined_sha256}\n` +
      `  prospective cohort:          ${cohortId} (fingerprint ${hash.slice(0, 16)}…)`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'expectations_attested',
    cohortId,
    namespace: 'derek',
    body: {
      reviewer: 'Derek',
      attested_at: new Date().toISOString(),
      combined_sha256: manifest.combined_sha256,
      vendor_live_sha256: manifest.vendor_live_sha256,
      deterministic_egress_sha256: manifest.deterministic_egress_sha256,
    },
  });
  console.log(`expectations_attested published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdInitCohort(args, store) {
  const manifest = expectationManifestContent();
  const { stageARecords } = await loadCohortState(store, null);
  const stageA = latestValid(stageARecords, 'stage_a_deployed');
  if (!stageA) throw new Error('no valid stage_a_deployed event');
  const { cohortId, fingerprint, hash } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: manifest.combined_sha256,
  });
  const { cohortRecords } = await loadCohortState(store, cohortId);
  const attested = latestValid(cohortRecords, 'expectations_attested');
  if (!attested) throw new Error(`no expectations_attested under ${cohortId} — run attest-expectations`);
  if (attested.payload.combined_sha256 !== manifest.combined_sha256) {
    throw new Error('attested expectation hash no longer matches the committed manifest');
  }
  const live = await checkLiveDeployment({
    awsRunner: awsJson,
    expected: {
      image_digest: stageA.payload.runtime?.image_digest ?? null,
      commit_sha: stageA.payload.deploy_run?.head_sha ?? null,
    },
  });
  if (!live.available || !live.fingerprint_matches) {
    throw new Error(`live deployment drift (${live.reason}) — a new deploy needs a new cohort`);
  }
  await confirmInteractive(
    `Initialise cohort ${cohortId}?\n  fingerprint: ${hash}\n  stage_a: ${stageA.key}`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'cohort_initialized',
    cohortId,
    namespace: 'derek',
    body: {
      cohort_fingerprint: fingerprint,
      stage_a_event_hash: evidenceEventHash(stageA.payload),
      expectations_event_hash: evidenceEventHash(attested.payload),
      initialized_at: new Date().toISOString(),
    },
  });
  console.log(`cohort_initialized published: ${event.key} (version ${receipt.versionId})`);
  console.log(`Status is now HOLD_EVIDENCE — 0/3 for cohort ${cohortId}.`);
}

async function cmdBindSession(args, store) {
  const sessionId = args['session-id'];
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1);
  if (!sessionId || !cohortId) throw new Error('bind-session requires --session-id (and a cohort)');
  const { stageARecords } = await loadCohortState(store, null);
  const stageA = latestValid(stageARecords, 'stage_a_deployed');
  if (!stageA) throw new Error('no valid stage_a_deployed event');
  const fingerprint =
    args['deployment-fingerprint'] ?? stageA.payload.runtime?.deployment_fingerprint ?? null;
  if (!fingerprint) throw new Error('bind-session requires --deployment-fingerprint');
  const pair = await collectSessionManifests(store, {
    deploymentFingerprint: fingerprint,
    sessionId,
  });
  if (pair.problems.length > 0 || !pair.start || !pair.completion) {
    throw new Error(`session manifests failed collection: ${JSON.stringify(pair.problems)}`);
  }
  const { event, receipt } = await publishEvent(store, {
    kind: 'production_session_bound',
    cohortId,
    namespace: 'machine',
    body: {
      field_session_id: sessionId,
      deployment_fingerprint: fingerprint,
      start_manifest: { published_hash: evidenceEventHash(pair.start) },
      completion_manifest: {
        published_hash: evidenceEventHash(pair.completion),
        published_at: pair.published_at,
      },
    },
  });
  console.log(`production_session_bound published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdAttestDaily(args, store) {
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1);
  const sessionIds = String(args['session-ids'] ?? '').split(',').filter(Boolean);
  const confirmationSession = args['confirmation-session'];
  const confirmationRef = args['confirmation-ref'];
  const heard = args.heard === 'true';
  const result = args.result;
  if (!cohortId || sessionIds.length === 0 || !confirmationSession || !confirmationRef || !result) {
    throw new Error(
      'attest-daily requires --session-ids, --confirmation-session, --confirmation-ref, --heard, --result'
    );
  }
  await confirmInteractive(
    `Daily manual attestation (GENUINE ON-SITE work)?\n` +
      `  sessions: ${sessionIds.join(', ')}\n` +
      `  heard-confirmation op: ${confirmationRef} in ${confirmationSession}\n` +
      `  heard completed during session: ${heard}\n  result: ${result}`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'manual_attestation',
    cohortId,
    namespace: 'derek',
    body: {
      day: args.day ?? null,
      field_session_ids: sessionIds,
      field_context: 'genuine_on_site',
      manual_heard_by: 'Derek',
      heard_completed_during_session: heard,
      confirmation_ref: confirmationRef,
      confirmation_session_id: confirmationSession,
      attested_at: new Date().toISOString(),
      manual_result: result,
    },
  });
  console.log(`manual_attestation published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdAttestDialogueHearing(args, store) {
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1);
  const sessionId = args['session-id'];
  const deliveryRef = args['delivery-ref'];
  const heard = args.heard === 'true';
  const result = args.result;
  if (!cohortId || !sessionId || !deliveryRef || !result) {
    throw new Error('attest-dialogue-hearing requires --session-id, --delivery-ref, --heard, --result');
  }
  await confirmInteractive(
    `Dialogue hearing attestation?\n  session: ${sessionId}\n  delivery: ${deliveryRef}\n` +
      `  heard completed during session: ${heard}\n  result: ${result}`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'dialogue_hearing_attestation',
    cohortId,
    namespace: 'derek',
    body: {
      field_session_id: sessionId,
      dialogue_delivery_ref: deliveryRef,
      manual_heard_by: 'Derek',
      heard_completed_during_session: heard,
      manual_result: result,
      attested_at: new Date().toISOString(),
    },
  });
  console.log(`dialogue_hearing_attestation published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdDecideMismatch(args, store) {
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1);
  if (!cohortId || !args['mismatch-id'] || !args.decision) {
    throw new Error('decide-mismatch requires --mismatch-id and --decision approved|rejected');
  }
  await confirmInteractive(
    `Decide non-safety mismatch ${args['mismatch-id']}: ${args.decision}?`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'non_safety_decision',
    cohortId,
    namespace: 'derek',
    body: {
      mismatch_id: args['mismatch-id'],
      decision: args.decision,
      reviewer: 'Derek',
      decided_at: new Date().toISOString(),
      rationale: args.rationale ?? null,
    },
  });
  console.log(`non_safety_decision published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdDecideCorpusGap(args, store) {
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1);
  if (!cohortId || !args.target || !args.decision) {
    throw new Error('decide-corpus-gap requires --target and --decision approved|rejected');
  }
  await confirmInteractive(
    `Corpus-gap deferral for ${args.target}: ${args.decision}? (safety-critical strata cannot be deferred)`
  );
  const { event, receipt } = await publishEvent(store, {
    kind: 'corpus_gap_decision',
    cohortId,
    namespace: 'derek',
    body: {
      stratum_or_fixture: args.target,
      decision: args.decision,
      safety_critical: false,
      reviewer: 'Derek',
      decided_at: new Date().toISOString(),
      rationale: args.rationale ?? null,
    },
  });
  console.log(`corpus_gap_decision published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdStatus(args, store) {
  await assertBucketVersioned(store);
  const cohortId = args.cohort ?? (await findCohortIds(store)).at(-1) ?? null;
  const state = await loadCohortState(store, cohortId);
  const manifest = expectationManifestContent();
  const oracle = await recomputeOracleDigest();

  const stageA = latestValid(state.stageARecords, 'stage_a_deployed');
  const live = await checkLiveDeployment({
    awsRunner: awsJson,
    expected: stageA
      ? {
          image_digest: stageA.payload.runtime?.image_digest ?? null,
          commit_sha: stageA.payload.deploy_run?.head_sha ?? null,
        }
      : null,
  });

  // Load manifests for every bound session.
  const manifestsBySession = new Map();
  for (const rec of state.cohortRecords) {
    if (rec.payload?.kind !== 'production_session_bound') continue;
    const sid = rec.payload.field_session_id;
    const fp = rec.payload.deployment_fingerprint;
    if (!sid || !fp || manifestsBySession.has(sid)) continue;
    manifestsBySession.set(
      sid,
      await collectSessionManifests(store, { deploymentFingerprint: fp, sessionId: sid })
    );
  }

  const fold = foldEvidence({
    ...state,
    cohortId,
    manifestsBySession,
    expectationManifest: manifest,
    recomputedOracleDigest: oracle,
    liveDeployment: live,
  });

  const handoffDir = args.handoff ?? DEFAULT_HANDOFF;
  const generatedAtIso = new Date().toISOString();
  const { jsonPath, mdPath } = writeProjections(handoffDir, fold, { generatedAtIso });
  console.log(`State: ${fold.state}${fold.progress ? ` — ${fold.progress}` : ''}`);
  if (fold.stale_deployment) console.log('STALE_DEPLOYMENT — live runtime does not match the cohort.');
  console.log(`Projections written: ${jsonPath}, ${mdPath}`);
  if (args['exit-nonzero-unless-done'] && fold.state !== 'DONE') process.exit(2);
}

const COMMANDS = {
  'publish-stage-a': cmdPublishStageA,
  'attest-expectations': cmdAttestExpectations,
  'init-cohort': cmdInitCohort,
  'bind-session': cmdBindSession,
  'attest-daily': cmdAttestDaily,
  'attest-dialogue-hearing': cmdAttestDialogueHearing,
  'decide-mismatch': cmdDecideMismatch,
  'decide-corpus-gap': cmdDecideCorpusGap,
  status: cmdStatus,
};

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[sub];
  if (!handler) {
    console.error(`Unknown subcommand "${sub ?? ''}". Known: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }
  const args = parseArgs(rest);
  const store = createS3Store({ bucket: args.bucket ?? EVIDENCE_BUCKET });
  handler(args, store).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
