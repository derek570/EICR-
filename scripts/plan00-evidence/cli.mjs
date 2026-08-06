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
import {
  computeFold,
  loadCohortState as loadCohortStateShared,
  latestValid as latestValidShared,
} from './lib/fold-runner.mjs';
import { collectSessionManifests } from './lib/collector.mjs';
import { resolveDeferralTarget } from './lib/deferral-targets.mjs';
import {
  checkLiveDeployment,
  proveTaskRolePrefixAccessViaIam,
  proveTaskRolePrefixAccessViaSmoke,
  verifyTrustedDeploy,
} from './lib/deployment.mjs';
import { writeProjections } from './lib/projections.mjs';
import { allocateNextOrdinal, runReservedAttempt } from './lib/runner.mjs';
import { translateJudgeResult } from './lib/executor-translation.mjs';
import {
  deriveDispatchState,
  vendorCorpusLane,
  vendorCorpusRequirementKey,
} from './lib/dispatch-plan.mjs';
import {
  PINNED_IR_IDENTITY,
  assertNoPinnedIrOverride,
  loadPinnedIrTarget,
  pinnedIrRequirementKey,
} from './lib/pinned-ir.mjs';
import { PINNED_IR_MODEL_LANE, pinLaneModelEnv, resolveLaneModel } from './lib/lane-models.mjs';
import { mintLiveDispatchCapability } from './lib/live-capability.mjs';
import {
  ANCHOR_MODES,
  assertNotStageARebind,
  assertSuccessArtifactChain,
} from './lib/success-record.mjs';
import { evidenceEventHash } from '../field-replay/lib/canonical-crypto.mjs';
import {
  computeConfigFingerprint,
  computePromptFingerprint,
  computeToolFingerprint,
  deploymentFingerprintOf,
} from '../../src/extraction/plan00-session-manifest.js';

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

const loadCohortState = loadCohortStateShared;
const latestValid = latestValidShared;

export { computeCohortFingerprint } from './lib/fingerprint.mjs';
import { computeCohortFingerprint } from './lib/fingerprint.mjs';

/**
 * Resolve the target cohort: `--cohort` wins; otherwise exactly one LIVE cohort
 * may exist (never lexicographic newest).
 *
 * "Live" is now explicit rather than implied by recency. A source deploy voids
 * the running three-day count, and the only way to restart it is a new Stage-A
 * publish + `init-cohort`, which mints a NEW cohort id. Before supersession was
 * recorded, that left two cohort prefixes in the bucket with nothing to say
 * which one was current: every subsequent run/decide/status command refused with
 * `multiple cohorts exist — pass --cohort explicitly`, and the obvious operator
 * response (pass the id they remember) is exactly the wrong one, because the
 * cohort they remember is the voided one and its accumulated days are dead.
 *
 * So `init-cohort` records `supersedes` on the new cohort record and this
 * resolver follows the chain: a cohort named by any live cohort's `supersedes`
 * is VOID, and only the survivors are candidates. A chain (A→B→C) resolves to C
 * naturally, because both A and B are named as superseded.
 *
 * A single cohort id short-circuits BEFORE the supersession load, deliberately:
 * it costs nothing to resolve, and it preserves the more useful downstream
 * message ("cohort X is not initialized — run init-cohort first") for the
 * commonest failure of all, the half-finished first-time setup.
 */
async function resolveCohortId(store, args) {
  if (args.cohort) return args.cohort;
  const ids = await findCohortIds(store);
  if (ids.length === 0) throw new Error('no cohort exists yet — run attest-expectations first');
  if (ids.length === 1) return ids[0];

  const { initialized, superseded, live } = await loadCohortSupersession(store, ids);
  const liveInitialized = live.filter((id) => initialized.has(id));
  if (liveInitialized.length === 1) return liveInitialized[0];
  if (liveInitialized.length === 0 && live.length === 1) return live[0];

  const voided = [...superseded.entries()].map(([from, to]) => `${from} superseded by ${to}`);
  throw new Error(
    `multiple cohorts exist (${live.join(', ')}) — pass --cohort explicitly` +
      (voided.length > 0 ? ` [${voided.join('; ')}]` : '')
  );
}

/**
 * Read every cohort's `cohort_initialized` record and derive the supersession
 * graph.
 *
 * Returns the `superseded` map (voided id → the id that voided it), the
 * `initialized` records by id, and the `live` ids in stable sort order. An
 * uninitialised cohort prefix — events published under an id whose init never
 * completed — is neither live-blocking nor superseding: it simply has no record
 * to read, so it contributes nothing to either map.
 */
async function loadCohortSupersession(store, knownIds = null) {
  const ids = knownIds ?? (await findCohortIds(store));
  const initialized = new Map();
  const superseded = new Map();
  for (const id of ids) {
    const { cohortRecords } = await loadCohortState(store, id);
    const init = latestValid(cohortRecords, 'cohort_initialized');
    if (!init) continue;
    initialized.set(id, init);
    const prior = init.payload.supersedes;
    if (typeof prior === 'string' && prior.length > 0 && prior !== id) superseded.set(prior, id);
  }
  return { ids, initialized, superseded, live: ids.filter((id) => !superseded.has(id)) };
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

/**
 * Which cohort `status` reports on.
 *
 * Deliberately a SEPARATE ladder from `resolveCohortId`, and deliberately
 * extracted as a pure function rather than left inline. It differs from the
 * write-command resolver in exactly one way that matters: `status` is the
 * diagnostic an operator reaches for when something is WRONG, so it must still
 * pick a cohort that has no valid `cohort_initialized` record — the uninitialised
 * case the write commands are right to refuse is precisely the case a human
 * needs to see. Leaving that ladder inline in `cmdStatus` would have made it
 * untestable without stubbing AWS, so the only way to pin it would have been to
 * pin a copy — which is how the two resolvers would silently drift apart on the
 * supersession rule they DO share.
 *
 * Returns null when no cohort exists at all (`status` prints the empty state).
 */
export function resolveStatusCohortId({ ids, initialized, live }, explicitCohortId = null) {
  if (explicitCohortId) return explicitCohortId;
  const liveInitialized = live.filter((id) => initialized.has(id));
  if (liveInitialized.length === 1) return liveInitialized[0];
  if (live.length === 1) return live[0];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) {
    throw new Error(`multiple live cohorts exist (${live.join(', ')}) — pass --cohort`);
  }
  return null;
}

/**
 * Plan 00B-4 §"Digest + success-record contract" — the ONE shared validator
 * every Plan-00 command runs before it writes anything.
 *
 * It is PHASE-AWARE because the anchors it checks do not all exist yet at every
 * call site: `publish-stage-a` runs before any Stage-A event exists, `attest`
 * after one does but before a cohort, `init` when both exist, and the run
 * commands only ever against an already-initialised cohort. A single
 * check-everything validator would therefore be unusable at the first call site
 * and a single check-nothing one would be useless at the last, so the mode
 * selects exactly what its phase CAN verify — and each mode fails closed on all
 * of it.
 *
 * Common to every mode: the shipped 00B success record still describes the
 * checked-out manifest, and the checked-out oracle sources still hash to what
 * that manifest declares (`assertSuccessArtifactChain`). That is the part which
 * cannot be self-consistently faked, because the success record lives outside
 * the repo and was written by a run that genuinely merged and deployed.
 */
export async function assertPlan00Anchors({ mode, store = null, args = {}, overrides = {} }) {
  if (!ANCHOR_MODES.includes(mode)) {
    throw new Error(
      `assertPlan00Anchors: unknown mode ${JSON.stringify(mode)} (expected one of ${ANCHOR_MODES.join(', ')})`
    );
  }
  const {
    readManifest = expectationManifestContent,
    recomputeOracle = recomputeOracleDigest,
    successRecord = {},
  } = overrides;

  const chain = await assertSuccessArtifactChain({
    repoRoot: REPO_ROOT,
    readManifest,
    recomputeOracle,
    ...successRecord,
  });

  if (mode === 'publish') {
    // The two inputs that IDENTIFY the deployment being anchored. Checked here
    // rather than only at the call site so the rebind test below always has
    // something real to compare.
    for (const flag of ['run-id', 'head-sha']) {
      const value = args[flag];
      if (value === undefined || value === true || String(value).length === 0) {
        throw new Error(
          `REFUSED: publish-stage-a requires --${flag} (the deploy run that produced the ` +
            'runtime being anchored). Nothing was written.'
        );
      }
    }
    // Resolve which Stage-A event a live cohort is currently bound to, so the
    // caller can run the rebind test once it knows the runtime fingerprint.
    // `null` means nothing is bound yet — the first-publish path, always admitted.
    const { initialized, live } = await loadCohortSupersession(store);
    const liveInitialized = live.filter((id) => initialized.has(id));
    let rebindTarget = null;
    if (liveInitialized.length === 1) {
      const cohortId = liveInitialized[0];
      const { stageARecords } = await loadCohortState(store, cohortId);
      const bound = boundValidRecord(
        stageARecords,
        'stage_a_deployed',
        initialized.get(cohortId).payload.stage_a_event_hash
      );
      rebindTarget = { cohortId, boundStageAPayload: bound?.payload ?? null };
    }
    return { ...chain, rebindTarget };
  }

  if (mode === 'attest' || mode === 'init') {
    const { stageARecords } = await loadCohortState(store, null);
    const stageA = latestValid(stageARecords, 'stage_a_deployed');
    if (!stageA) {
      throw new Error(
        'REFUSED: no valid stage_a_deployed event is readable — run publish-stage-a first. ' +
          'Nothing was written.'
      );
    }
    // The Stage-A anchor records the oracle digest the DEPLOYED runtime was
    // published against. If the checkout has drifted since, attesting or
    // initialising now would bind an expectation set proven under one oracle to
    // a runtime published under another — and nothing downstream re-joins them.
    if (stageA.payload.semantic_oracle_digest !== chain.oracleDigest) {
      throw new Error(
        `REFUSED: the published Stage-A anchor declares semantic_oracle_digest ` +
          `${stageA.payload.semantic_oracle_digest} but the checked-out sources hash to ` +
          `${chain.oracleDigest}. Re-deploy and re-publish before ${mode === 'attest' ? 'attesting' : 'initialising'}. ` +
          'Nothing was written.'
      );
    }
    return { ...chain, stageA };
  }

  // 'run' — the cohort-bound anchor equality is layered on by
  // `assertRunPreconditions`, which has already resolved the cohort.
  return chain;
}

// ── subcommands ──────────────────────────────────────────────────────────

async function cmdPublishStageA(args, store, overrides = {}) {
  // Phase gate FIRST: a tampered success record or a drifted oracle refuses
  // before any gh/aws round trip, so a bad invocation costs nothing and writes
  // nothing. It also resolves which stage_a event (if any) a live cohort binds,
  // for the rebind test below.
  const anchors = await assertPlan00Anchors({ mode: 'publish', store, args, overrides });

  const runId = args['run-id'];
  const headSha = args['head-sha'];
  if (!runId || !headSha) throw new Error('publish-stage-a requires --run-id and --head-sha');

  const deploy = await verifyTrustedDeploy({ runId, headSha, fetchRun: ghRunFetcher });
  if (!deploy.ok)
    throw new Error(`trusted-deploy verification failed: ${deploy.errors.join(', ')}`);

  const live = await checkLiveDeployment({ awsRunner: awsJson, expected: { commit_sha: headSha } });
  if (!live.available || !live.fingerprint_matches) {
    throw new Error(`live runtime does not match the deploy: ${live.reason}`);
  }

  // §C5 pre-stage task-role manifest-prefix proof — absent proof BLOCKS.
  const proofMode = args['role-proof'] ?? 'iam';
  let proof;
  if (proofMode === 'smoke') {
    if (!args['session-id']) throw new Error('--role-proof smoke requires --session-id');
    // Cycle-7 — the smoke fingerprint derives from the CURRENT live
    // deployment identity (never operator-supplied): a valid pair from an
    // older revision must not authorise the new one.
    const liveArnMatch = String(live.live.task_def_arn ?? '').match(
      /task-definition\/([^:]+):(\d+)$/
    );
    if (!liveArnMatch || !live.live.image_digest) {
      throw new Error('cannot derive live deployment identity for the smoke proof');
    }
    const fingerprint = deploymentFingerprintOf({
      task_arn: live.live.task_def_arn,
      task_family: liveArnMatch[1],
      task_revision: liveArnMatch[2],
      image_id: live.live.image_digest,
    });
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
  // Already proven by the phase gate above (record → manifest bytes → oracle);
  // reused rather than recomputed so the walk happens exactly once per command.
  const oracle = anchors.oracleDigest;
  // Codex cycle-1 — NON-NULL fingerprints, computed with THE SAME
  // derivations the deployed server uses (one implementation, imported):
  // prompt/tool from this checkout (verified == deployed head_sha above);
  // config from the LIVE task definition's environment, never the
  // operator's shell env.
  const taskDefDetail = await awsJson([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    live.live.task_def_arn,
    '--region',
    'eu-west-2',
  ]);
  const containerDefs = taskDefDetail?.taskDefinition?.containerDefinitions ?? [];
  const backendDef =
    containerDefs.find((c) => c?.name === 'eicr-backend') ??
    (containerDefs.length === 1 ? containerDefs[0] : null);
  const taskEnv = {};
  for (const row of backendDef?.environment ?? []) taskEnv[row.name] = row.value;
  const arnMatch = String(live.live.task_def_arn ?? '').match(/task-definition\/([^:]+):(\d+)$/);
  const identity = {
    task_arn: live.live.task_def_arn,
    task_family: arnMatch?.[1] ?? backendDef?.name ?? 'eicr-backend',
    task_revision: arnMatch?.[2] ?? null,
    image_id: live.live.image_digest ?? null,
  };
  if (!identity.task_revision || !identity.image_id) {
    throw new Error('cannot derive deployment identity (task revision / image digest missing)');
  }
  // Mini-review — the fingerprints must be computed from the EXACT
  // deployed source: the checkout must be at head_sha with a clean tree.
  const { stdout: headOut } = await execFileAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  if (headOut.trim() !== headSha) {
    throw new Error(
      `checkout HEAD ${headOut.trim().slice(0, 12)} != deployed head_sha — cannot fingerprint`
    );
  }
  const { stdout: dirtyOut } = await execFileAsync('git', [
    '-C',
    REPO_ROOT,
    'status',
    '--porcelain',
  ]);
  if (dirtyOut.trim().length > 0) {
    throw new Error('checkout is dirty — fingerprints must come from the exact deployed source');
  }
  const promptFingerprint = computePromptFingerprint();
  const toolFingerprint = await computeToolFingerprint();
  const configFingerprint = computeConfigFingerprint(taskEnv);
  if (!promptFingerprint || !toolFingerprint || !configFingerprint) {
    throw new Error('fingerprint computation failed — refusing to publish stage_a_deployed');
  }
  // The rebind test can only run HERE: the runtime fingerprint is the third
  // leg of deployment identity and is not derivable until the live task
  // definition has been read. A publish that matches the live cohort's bound
  // stage-A on all three is the same deployment, so it is refused; anything
  // differing is a genuinely new deployment and is admitted.
  const deploymentFingerprint = deploymentFingerprintOf(identity);
  assertNotStageARebind({
    boundStageAPayload: anchors.rebindTarget?.boundStageAPayload ?? null,
    cohortId: anchors.rebindTarget?.cohortId ?? null,
    candidate: {
      run_id: String(runId),
      head_sha: headSha,
      deployment_fingerprint: deploymentFingerprint,
    },
  });
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
      runtime: {
        ...live.live,
        task_family: identity.task_family,
        task_revision: identity.task_revision,
        deployment_fingerprint: deploymentFingerprint,
      },
      evidence_bucket: store.bucket,
      evidence_bucket_versioning: versioning,
      config_fingerprint: configFingerprint,
      tool_fingerprint: toolFingerprint,
      prompt_fingerprint: promptFingerprint,
      semantic_oracle_digest: oracle,
      deployed_evidence_runtime_digest: live.live.image_digest ?? null,
      event_schema_hash: eventSchemaHash(),
      role_prefix_proof: { mode: proof.mode ?? proofMode, proven: true },
    },
  });
  console.log(`stage_a_deployed published: ${event.key} (version ${receipt.versionId})`);
  console.log('Fold state is now STAGE_A_IMPLEMENTED (run `status` to verify).');
}

async function cmdAttestExpectations(args, store, overrides = {}) {
  // Phase gate: the success-record chain PLUS the published Stage-A anchor.
  // Attesting is where Derek's signature enters the evidence, so it must not be
  // possible against a manifest the shipped 00B run never proved, nor against a
  // runtime published under a different oracle.
  const anchors = await assertPlan00Anchors({ mode: 'attest', store, args, overrides });
  const { manifest, stageA } = anchors;
  const { cohortId, hash } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: manifest.combined_sha256,
    vendorLiveSha256: manifest.vendor_live_sha256,
    deterministicEgressSha256: manifest.deterministic_egress_sha256,
  });
  // Plan C4 — the single authoritative command RENDERS both frozen
  // manifests for Derek (hashes alone are not a review; cycle-7).
  console.log('════ vendor_live_expectations (frozen; attesting these bytes) ════');
  console.log(JSON.stringify(manifest.vendor_live_expectations, null, 2));
  console.log('════ deterministic_egress_expectations (frozen) ════');
  console.log(JSON.stringify(manifest.deterministic_egress_expectations, null, 2));
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

async function cmdInitCohort(args, store, overrides = {}) {
  // Phase gate: success-record chain + the published Stage-A anchor. Init is
  // the moment the cohort record is minted, so these anchors are bound INTO it
  // below — after this point nothing re-derives them, they are compared.
  const anchors = await assertPlan00Anchors({ mode: 'init', store, args, overrides });
  const { manifest, stageA } = anchors;
  const { cohortId, fingerprint, hash } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: manifest.combined_sha256,
    vendorLiveSha256: manifest.vendor_live_sha256,
    deterministicEgressSha256: manifest.deterministic_egress_sha256,
  });
  const { cohortRecords } = await loadCohortState(store, cohortId);
  const attested = latestValid(cohortRecords, 'expectations_attested');
  if (!attested)
    throw new Error(`no expectations_attested under ${cohortId} — run attest-expectations`);
  if (attested.payload.combined_sha256 !== manifest.combined_sha256) {
    throw new Error('attested expectation hash no longer matches the committed manifest');
  }
  const live = await checkLiveDeployment({
    awsRunner: awsJson,
    expected: {
      task_def_arn: stageA.payload.runtime?.task_def_arn ?? null,
      image_digest: stageA.payload.runtime?.image_digest ?? null,
      commit_sha: stageA.payload.deploy_run?.head_sha ?? null,
      config_fingerprint: stageA.payload.config_fingerprint ?? null,
    },
  });
  if (!live.available || !live.fingerprint_matches) {
    throw new Error(`live deployment drift (${live.reason}) — a new deploy needs a new cohort`);
  }
  // Which cohort does this one VOID? A deploy voids the running three-day
  // count, and the restart mints a new cohort id — so without an explicit
  // record the bucket ends up holding two cohort prefixes and no statement of
  // which is current. Recording it here, at the one moment both ids are known,
  // is what lets `status` report VOID and the run commands resolve without
  // `--cohort`. Re-initialising the SAME id supersedes nothing (it is the same
  // cohort, not a successor).
  const { initialized, live: liveCohorts } = await loadCohortSupersession(store);
  const priorLive = liveCohorts.filter((id) => initialized.has(id) && id !== cohortId);
  if (priorLive.length > 1) {
    throw new Error(
      `REFUSED: ${priorLive.length} live cohorts already exist (${priorLive.join(', ')}) — ` +
        'this cohort cannot state which one it supersedes, and guessing would void the wrong ' +
        'evidence. Resolve the split by hand before initialising. Nothing was written.'
    );
  }
  const supersedes = priorLive[0] ?? null;

  await confirmInteractive(
    `Initialise cohort ${cohortId}?\n  fingerprint: ${hash}\n  stage_a: ${stageA.key}` +
      (supersedes ? `\n  SUPERSEDES: ${supersedes} (its accumulated days are voided)` : '')
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
      // ADDITIVE-OPTIONAL payload fields. Deliberately NOT added to
      // `KIND_REQUIRED_FIELDS`: that map is hashed into `eventSchemaHash()`,
      // which every stage_a_deployed event carries, so requiring them would
      // surface as deployment drift on a cohort that has done nothing wrong.
      // `validateStoredEvent` tolerates extra keys, so an older reader is
      // unaffected and a newer one gets the binding.
      supersedes,
      manifest_artifact_sha256: anchors.manifestSha256,
      semantic_oracle_digest: anchors.oracleDigest,
    },
  });
  console.log(`cohort_initialized published: ${event.key} (version ${receipt.versionId})`);
  if (supersedes) console.log(`cohort ${supersedes} is now VOID (superseded by ${cohortId}).`);
  console.log(`Status is now HOLD_EVIDENCE — 0/3 for cohort ${cohortId}.`);
}

async function cmdBindSession(args, store) {
  const sessionId = args['session-id'];
  const cohortId = await resolveCohortId(store, args);
  if (!sessionId) throw new Error('bind-session requires --session-id');
  const state = await loadCohortState(store, cohortId);
  // Mini-review — the fingerprint must come from the stage-A event THIS
  // cohort's initialization bound (by explicit hash), never the globally
  // newest deploy. Cycle-2: binding REQUIRES an initialized cohort — a
  // pre-initialisation bind would be permanently invalid evidence.
  const init = latestValid(state.cohortRecords, 'cohort_initialized');
  if (!init)
    throw new Error(
      `cohort ${cohortId} is not initialized — run init-cohort before binding sessions`
    );
  const stageACandidates = state.stageARecords.filter(
    (r) => validateStoredEvent({ key: r.key, payload: r.payload }).length === 0
  );
  const stageA = init
    ? (stageACandidates.find(
        (r) => evidenceEventHash(r.payload) === init.payload.stage_a_event_hash
      ) ?? null)
    : latestValid(state.stageARecords, 'stage_a_deployed');
  if (!stageA) throw new Error('no valid stage_a_deployed event bound to this cohort');
  const fingerprint = stageA.payload.runtime?.deployment_fingerprint ?? null;
  if (!fingerprint) throw new Error('stage_a_deployed carries no deployment_fingerprint');
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
      start_manifest: { content_hash: pair.start_content_hash },
      completion_manifest: {
        content_hash: pair.completion_content_hash,
        published_at: pair.published_at,
      },
    },
  });
  console.log(`production_session_bound published: ${event.key} (version ${receipt.versionId})`);
}

async function cmdAttestDaily(args, store) {
  const cohortId = await resolveCohortId(store, args);
  const sessionIds = String(args['session-ids'] ?? '')
    .split(',')
    .filter(Boolean);
  const confirmationSession = args['confirmation-session'];
  const confirmationRef = args['confirmation-ref'];
  if (!['true', 'false'].includes(String(args.heard))) {
    throw new Error('attest-daily requires an EXPLICIT --heard true|false');
  }
  const heard = args.heard === 'true';
  const result = args.result;
  if (!['pass', 'fail'].includes(result)) {
    throw new Error('attest-daily requires --result pass|fail');
  }
  if (heard === false && result === 'pass') {
    throw new Error('false + pass is never valid — a not-heard confirmation cannot PASS');
  }
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
  const cohortId = await resolveCohortId(store, args);
  const sessionId = args['session-id'];
  const deliveryRef = args['delivery-ref'];
  if (!['true', 'false'].includes(String(args.heard))) {
    throw new Error('attest-dialogue-hearing requires an EXPLICIT --heard true|false');
  }
  const heard = args.heard === 'true';
  const result = args.result;
  if (!['pass', 'fail'].includes(result)) {
    throw new Error('attest-dialogue-hearing requires --result pass|fail');
  }
  if (heard === false && result === 'pass') {
    throw new Error('false + pass is never valid');
  }
  if (!cohortId || !sessionId || !deliveryRef || !result) {
    throw new Error(
      'attest-dialogue-hearing requires --session-id, --delivery-ref, --heard, --result'
    );
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
  console.log(
    `dialogue_hearing_attestation published: ${event.key} (version ${receipt.versionId})`
  );
}

async function cmdDecideMismatch(args, store) {
  const cohortId = await resolveCohortId(store, args);
  if (!cohortId || !args['mismatch-id'] || !['approved', 'rejected'].includes(args.decision)) {
    throw new Error('decide-mismatch requires --mismatch-id and --decision approved|rejected');
  }
  await confirmInteractive(`Decide non-safety mismatch ${args['mismatch-id']}: ${args.decision}?`);
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
  const cohortId = await resolveCohortId(store, args);
  if (!cohortId || !args.target || !['approved', 'rejected'].includes(args.decision)) {
    throw new Error('decide-corpus-gap requires --target and --decision approved|rejected');
  }
  // Codex cycle-1 — the target must be KNOWN: an attested fixture id or a
  // manifest-named NON-SAFETY gap stratum. Safety strata cannot be waived.
  //
  // Plan 00B-4 C4 — deferral targets resolve from the UNION of manifest-named
  // gap strata and attested fixtures, in both cases ONLY when the manifest
  // explicitly carries `safety_critical: false`. UNCLASSIFIED (absent, non-
  // boolean, or true) defaults to safety-critical and is refused here. The rule
  // is imported from lib/deferral-targets.mjs — the SAME function the fold's
  // admission gate calls — so the CLI can never mint an event the fold would
  // then reject as invalid.
  const manifest = expectationManifestContent();
  const resolved = resolveDeferralTarget(manifest, args.target);
  if (!resolved.known) {
    throw new Error(
      `"${args.target}" is neither a manifest-named gap stratum nor an attested fixture — unclassified targets default to safety-critical and cannot be deferred`
    );
  }
  if (!resolved.deferrable) {
    throw new Error(
      `"${args.target}" is safety-critical (or unclassified) — it cannot be deferred`
    );
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

// ───────────────────────────────────────────────────────────────────────────
// §C1d/§C1e — the live vendor-lane run coordinator
//
// `run-ir` and `run-corpus` are the only commands that spend real vendor money
// and write vendor evidence. Every fact that could make that evidence a LIE is
// therefore checked BEFORE an ordinal is allocated or a PENDING reservation is
// created: a refusal must cost nothing. `assertRunPreconditions` is that gate,
// and every step in it is a refusal, never a warning.
// ───────────────────────────────────────────────────────────────────────────

/** Pace BETWEEN samples — never between the turns inside one sample. */
const DEFAULT_INTER_SAMPLE_MS = 10000;

/**
 * The judge policy both lanes share. A dialogue script legitimately leaves an
 * ask open outside the declared turn window (the `dialogue_answer_ingress`
 * exclusion — a fixture cannot even declare the trailing script ask its own
 * transcript provokes), so that ONE family is windowed and every other family
 * stays strict. Exported so the orchestration tests pin the coordinator's
 * actual value rather than an agreeing copy that could drift from it.
 */
export const WINDOWED_OPEN_ASK_FAMILIES = Object.freeze(['dialogue_script']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one record of `kind` whose event hash is EXACTLY the one this cohort
 * bound at initialisation. Deliberately NOT `latestValid`: "the newest valid
 * record of this kind" is the right answer while establishing a cohort and the
 * wrong answer forever afterwards — a second `publish-stage-a`, or a
 * re-attestation of an edited manifest, would silently re-point a running
 * cohort at a deployment or an expectation set it never initialised against,
 * and every terminal published after that would carry fingerprints belonging
 * to something else.
 */
function boundValidRecord(records, kind, eventHash) {
  if (typeof eventHash !== 'string' || eventHash.length === 0) return null;
  return (
    records.find(
      (r) =>
        r.payload?.kind === kind &&
        validateStoredEvent({ key: r.key, payload: r.payload }).length === 0 &&
        evidenceEventHash(r.payload) === eventHash
    ) ?? null
  );
}

/**
 * Everything that must be true before ONE vendor call may be dispatched.
 *
 * The ordering is load-bearing — cheapest and most-likely-wrong first, and
 * every branch throws before `allocateNextOrdinal` is reached, so a refused run
 * consumes no ordinal, publishes no reservation and spends no money.
 *
 * `overrides` exists so each refusal branch is unit-testable without an AWS
 * account, a git checkout in a particular state, or a real oracle recompute.
 */
export async function assertRunPreconditions(store, args, overrides = {}) {
  const {
    readManifest = expectationManifestContent,
    recomputeOracle = recomputeOracleDigest,
    liveCheck = (expected) => checkLiveDeployment({ awsRunner: awsJson, expected }),
    readHeadSha = async () =>
      (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout,
    readPorcelain = async () =>
      (await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_ROOT })).stdout,
    successRecord = {},
  } = overrides;

  // 0 — mode. There is exactly ONE mode that may publish vendor evidence, and
  // an unrecognised `--mode` is refused rather than ignored: silently
  // discarding `--mode=mock` would let an operator believe they had run a dry
  // rehearsal while real money was spent and real evidence published.
  if (args.mode !== undefined && args.mode !== 'live') {
    throw new Error(
      `REFUSED: the run commands dispatch the LIVE vendor lane only; --mode=${args.mode} would ` +
        'publish a mock/replay verdict as vendor evidence. Nothing was allocated or reserved.'
    );
  }

  // 0b — the success-artifact chain. Deliberately BEFORE any store work: the
  // manifest under contract is what every downstream check compares against, so
  // if the shipped 00B record no longer describes it there is nothing worth
  // reading a cohort for, and a refusal here costs no ordinal and no
  // reservation.
  const anchors = await assertPlan00Anchors({
    mode: 'run',
    store,
    args,
    overrides: { readManifest, recomputeOracle, successRecord },
  });

  await assertBucketVersioned(store);

  // 1 — an initialised cohort, and the EXACT stage-A + attestation it bound.
  const cohortId = await resolveCohortId(store, args);

  // 1a — a SUPERSEDED cohort is void, and dispatching into it spends real money
  // on evidence that can never count toward the gate. The resolver already skips
  // voided cohorts, so this only fires for an explicit `--cohort <old id>` — the
  // exact mistake an operator makes when they paste the id they remember, which
  // is by construction the one that was re-anchored.
  const { superseded } = await loadCohortSupersession(store);
  if (superseded.has(cohortId)) {
    throw new Error(
      `REFUSED: cohort ${cohortId} was superseded by ${superseded.get(cohortId)} — a later ` +
        'deployment re-anchored the chain, so it accrues no further days and any evidence ' +
        'published against it is dead on arrival. Run against the successor. Nothing was ' +
        'allocated or reserved.'
    );
  }

  const state = await loadCohortState(store, cohortId);
  const init = latestValid(state.cohortRecords, 'cohort_initialized');
  if (!init) throw new Error(`cohort ${cohortId} is not initialized — run init-cohort first`);

  const stageA = boundValidRecord(
    state.stageARecords,
    'stage_a_deployed',
    init.payload.stage_a_event_hash
  );
  if (!stageA) {
    throw new Error(
      `REFUSED: cohort ${cohortId} binds stage_a_event_hash ${init.payload.stage_a_event_hash} ` +
        'but no valid stage_a_deployed event with that hash is readable. Nothing was allocated ' +
        'or reserved.'
    );
  }
  const attested = boundValidRecord(
    state.cohortRecords,
    'expectations_attested',
    init.payload.expectations_event_hash
  );
  if (!attested) {
    throw new Error(
      `REFUSED: cohort ${cohortId} binds expectations_event_hash ` +
        `${init.payload.expectations_event_hash} but no valid expectations_attested event with ` +
        'that hash is readable. Nothing was allocated or reserved.'
    );
  }

  // 1b — the cohort's OWN bound anchors. `cohort_initialized` records the
  // manifest sha and oracle digest that were true at init, atomically with the
  // stage-A binding. Step 0b proved the checked-out tree is self-consistent and
  // matches the shipped 00B record; this proves it is the SAME tree this cohort
  // was initialised against. Without it a cohort could be initialised, the
  // manifest regenerated, the 00B record refreshed by a later delivery, and
  // dispatch would carry on accruing days against expectations nobody ever
  // attested for THIS cohort. Fail-closed on absence: every cohort reachable by
  // this code path was initialised by the same `init-cohort` that writes them.
  for (const [field, bound, current] of [
    ['manifest_artifact_sha256', init.payload.manifest_artifact_sha256, anchors.manifestSha256],
    ['semantic_oracle_digest', init.payload.semantic_oracle_digest, anchors.oracleDigest],
  ]) {
    if (typeof bound !== 'string' || bound.length === 0) {
      throw new Error(
        `REFUSED: cohort ${cohortId} records no ${field} — it predates the success-artifact ` +
          'binding and cannot prove which manifest it was initialised against. Re-initialise ' +
          'the cohort. Nothing was allocated or reserved.'
      );
    }
    if (bound !== current) {
      throw new Error(
        `REFUSED: cohort ${cohortId} was initialised against ${field} ${bound} but the ` +
          `checked-out tree now yields ${current}. The manifest changed under a running cohort; ` +
          're-deploy, re-publish and re-initialise. Nothing was allocated or reserved.'
      );
    }
  }

  // 2 — the ORACLE. `fold.mjs` recomputes this digest and voids the cohort if
  // it drifts, so dispatching under a drifted oracle burns real money to
  // produce evidence that is already known to be unusable. It catches strictly
  // more than an expectation-hash check: a mutated dispatch-path file that is
  // an enumerated oracle input drifts the digest even when every projected
  // expectation is byte-identical.
  //
  // The comparison itself now lives in step 0b (`assertSuccessArtifactChain`
  // performs exactly this test as the last link of the chain), so it is NOT
  // repeated here — a second identical `if` would be dead code that reads like
  // a live guard. What step 0b cannot express is the cohort binding, which is
  // step 1b above. The manifest and digest are reused rather than re-read so
  // the source tree is walked exactly once per command.
  const manifest = anchors.manifest;
  const oracle = anchors.oracleDigest;

  // 3 — the ATTESTED expectations must still be the COMMITTED expectations.
  // Derek attested specific bytes; a manifest edited since then is a different
  // set of promises and may not be measured under his attestation.
  for (const [field, attestedValue, committedValue] of [
    ['combined_sha256', attested.payload.combined_sha256, manifest.combined_sha256],
    ['vendor_live_sha256', attested.payload.vendor_live_sha256, manifest.vendor_live_sha256],
    [
      'deterministic_egress_sha256',
      attested.payload.deterministic_egress_sha256,
      manifest.deterministic_egress_sha256,
    ],
  ]) {
    if (attestedValue !== committedValue) {
      throw new Error(
        `REFUSED: attested ${field} (${attestedValue}) no longer matches the committed manifest ` +
          `(${committedValue}) — re-attest before dispatching. Nothing was allocated or reserved.`
      );
    }
  }

  // 3b — the manifest states each lane's sha TWICE: once nested under the lane
  // object and once as a top-level mirror. `fold.mjs` enforces terminals
  // against the NESTED value while the coordinator binds the TOP-LEVEL one, so
  // a drift between the two mirrors would bind every terminal to a digest the
  // fold then rejects as `terminal_expectation_digest_unattached` — after the
  // money was spent. Cheap to check, and unfalsifiable if left unchecked.
  for (const [lane, nested, mirror] of [
    ['vendor_live', manifest.vendor_live_expectations?.sha256, manifest.vendor_live_sha256],
    [
      'deterministic_egress',
      manifest.deterministic_egress_expectations?.sha256,
      manifest.deterministic_egress_sha256,
    ],
  ]) {
    if (typeof nested !== 'string' || nested.length === 0 || nested !== mirror) {
      throw new Error(
        `REFUSED: manifest ${lane} sha256 mirrors disagree (nested ${nested}, top-level ` +
          `${mirror}) — regenerate the manifest. Nothing was allocated or reserved.`
      );
    }
  }

  // 4 — DISPATCH-SOURCE binding. The lane boots production modules from THIS
  // checkout and judges the result against the deployed stack, so a checkout
  // that is not the deployed commit measures one thing and attributes it to
  // another. A dirty tree is refused for the same reason and is strictly
  // worse: uncommitted edits are unrecoverable provenance — no later reader
  // can reconstruct what actually ran.
  const boundSha = stageA.payload.deploy_run?.head_sha ?? null;
  if (!boundSha) {
    throw new Error(
      'REFUSED: the bound stage_a_deployed event carries no deploy_run.head_sha, so the dispatch ' +
        'source cannot be bound to the deployment. Nothing was allocated or reserved.'
    );
  }
  const head = String(await readHeadSha()).trim();
  if (head !== boundSha) {
    throw new Error(
      `REFUSED: dispatch-source drift — HEAD is ${head} but the cohort's deployment was built ` +
        `from ${boundSha}. Check out the deployed commit. Nothing was allocated or reserved.`
    );
  }
  const porcelain = String(await readPorcelain()).trim();
  if (porcelain !== '') {
    const shown = porcelain.split('\n').slice(0, 5).join('; ');
    throw new Error(
      'REFUSED: the checkout is dirty, so what the lane dispatches cannot be reconstructed from ' +
        `the recorded commit (${shown}${porcelain.split('\n').length > 5 ? '; …' : ''}). ` +
        'Nothing was allocated or reserved.'
    );
  }

  // 5 — the LIVE deployment must still BE the cohort's deployment.
  const live = await liveCheck({
    task_def_arn: stageA.payload.runtime?.task_def_arn ?? null,
    image_digest: stageA.payload.runtime?.image_digest ?? null,
    commit_sha: boundSha,
    config_fingerprint: stageA.payload.config_fingerprint ?? null,
  });
  if (!live.available || !live.fingerprint_matches) {
    throw new Error(
      `REFUSED: live deployment drift (${live.reason ?? 'unavailable'}) — a new deploy needs a ` +
        'new cohort. Nothing was allocated or reserved.'
    );
  }

  // 6 — the fingerprints every terminal must echo. A VALID `stage_a_deployed`
  // event is schema-guaranteed to carry all three, so an absence here means
  // the schema and this reader have diverged: fail closed rather than publish
  // a terminal with a null digest.
  const deploymentFingerprint = stageA.payload.runtime?.deployment_fingerprint ?? null;
  const promptDigest = stageA.payload.prompt_fingerprint ?? null;
  const toolDigest = stageA.payload.tool_fingerprint ?? null;
  for (const [name, value] of [
    ['runtime.deployment_fingerprint', deploymentFingerprint],
    ['prompt_fingerprint', promptDigest],
    ['tool_fingerprint', toolDigest],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `REFUSED: the bound stage_a_deployed event carries no ${name}. Nothing was allocated or ` +
          'reserved.'
      );
    }
  }

  return {
    cohortId,
    state,
    init,
    stageA,
    attested,
    manifest,
    oracle,
    live,
    headSha: head,
    deploymentFingerprint,
    promptDigest,
    toolDigest,
    /**
     * The four facts `mintLiveDispatchCapability` demands. They are asserted
     * `true` here — at the end of the gate that actually established them —
     * rather than passed in by a caller who could assert them without having
     * checked anything.
     */
    attestation: Object.freeze({
      oracleDigestVerified: true,
      expectationAttestationVerified: true,
      deploymentVerified: true,
      sourceBindingVerified: true,
    }),
  };
}

/**
 * A mock verdict must never enter the evidence store. `bootLiveLaneDriver`
 * declares `liveMode: true`; the mock `bootLaneDriver` does not. Asserting it
 * at the moment of dispatch — rather than trusting the import — means a future
 * refactor that swaps the boot function cannot silently begin publishing
 * replayed verdicts as vendor evidence.
 */
export function assertLiveBoot(boot) {
  if (boot?.liveMode !== true) {
    throw new Error(
      'REFUSED: the lane boot is not live — mock/replay verdicts must never enter the evidence ' +
        'store. Nothing was dispatched.'
    );
  }
}

/**
 * Pin the lane's model environment, boot the live lane, hand it to `fn`, and
 * ALWAYS tear the clock control down.
 *
 * `pinLaneModelEnv` must run before the boot: the boot performs the production
 * imports and `EICRExtractionSession` snapshots `SONNET_EXTRACT_MODEL` at
 * construction, so setting it afterwards would leave the terminal declaring a
 * model the call never used.
 *
 * The lane modules are DYNAMIC imports because they pull the whole backend
 * (`sonnet-stream`, the extraction session, the playback app) into memory; a
 * plain `status` invocation must not pay that, and — more importantly — must
 * not be able to reach a real provider client at all.
 */
export async function withLiveLane({ modelLane, repoRoot = REPO_ROOT, log = () => {} }, fn) {
  const descriptor = pinLaneModelEnv(modelLane);
  const [bootMod, driverMod, judgeMod] = await Promise.all([
    import('../model-ab/lib/live-lane-boot.mjs'),
    import('../model-ab/lib/lane-driver.mjs'),
    import('../model-ab/lib/semantic-judge.mjs'),
  ]);
  log(
    `lane ${descriptor.model_lane}: booting live driver (${descriptor.model} @ ${descriptor.tier})`
  );
  const boot = await bootMod.bootLiveLaneDriver({ repoRoot });
  try {
    assertLiveBoot(boot);
    return await fn({ boot, driverMod, judgeMod, descriptor });
  } finally {
    // Teardown must never mask the run's own failure.
    try {
      boot.clockCtl?.uninstall?.();
    } catch (err) {
      log(`lane ${descriptor.model_lane}: clock teardown failed (${err.message})`);
    }
  }
}

/**
 * Load the fixture + projected expectation for one vendor-corpus requirement,
 * deriving the board wildcard the same way the mock wrapper does (single-board
 * jobs judge with the wildcard, §B5).
 */
function loadCorpusTarget(projectionMod, fixtureId) {
  const fixture = projectionMod.loadFixture(REPO_ROOT, fixtureId);
  const boardCount = Array.isArray(fixture.job_state?.boards) ? fixture.job_state.boards.length : 0;
  return {
    fixtureId,
    fixture,
    expectation: projectionMod.projectFixtureExpectation(fixture),
    boardWildcard: boardCount <= 1,
  };
}

/**
 * Fixture input vs projection target: a one-to-one join and committed-vs-
 * rendered digest agreement, BEFORE any sample runs. Mirrors the mock lane's
 * own pre-guards — a corpus run that silently skipped a fixture, or measured
 * against a stale rendered manifest, would report a complete run it never did.
 */
function assertCorpusProjectionIntegrity(projectionMod, manifest) {
  const inventory = projectionMod.listCorpusIds(REPO_ROOT);
  const declared = [...projectionMod.VENDOR_LIVE_FIXTURE_IDS].sort();
  const joinOk =
    inventory.length === declared.length && declared.every((id, i) => inventory[i] === id);
  if (!joinOk) {
    throw new Error(
      'REFUSED: the corpus inventory does not join the vendor-lane fixture ids one-to-one ' +
        `(inventory ${inventory.length}, declared ${declared.length}). Nothing was allocated ` +
        'or reserved.'
    );
  }
  const rendered = projectionMod.renderExpectationManifests(REPO_ROOT);
  if (manifest.vendor_live_expectations?.sha256 !== rendered.vendor_live_sha256) {
    throw new Error(
      'REFUSED: the committed vendor_live_expectations sha256 does not match the rendered ' +
        'projection — stale manifest. Nothing was allocated or reserved.'
    );
  }
}

/**
 * Drive one lane ordinal to completion.
 *
 * The shape is the same for both lanes and the differences are entirely in
 * `spec`: which requirement keys an ordinal owns, and what fixture each key
 * names. Everything else — folding before dispatch, adopting an in-flight
 * ordinal, honouring generation N+1 only after an INVALID terminal, no-opping
 * on completed work, pacing, and the per-attempt capability mint — is common,
 * and deliberately written ONCE so the two lanes cannot drift into two
 * different exactly-once stories.
 */
async function coordinateRun(store, args, spec, overrides = {}) {
  const {
    sleep = defaultSleep,
    log = (m) => console.log(m),
    laneSession = withLiveLane,
    preconditions = assertRunPreconditions,
  } = overrides;

  const pre = await preconditions(store, args, overrides);
  const { cohortId, manifest, deploymentFingerprint, promptDigest, toolDigest, attestation } = pre;
  await spec.prepare(pre);

  // FOLD before dispatching: what is already done, in flight, or INVALID is a
  // property of the store, never of this process's memory.
  const refold = async () => deriveDispatchState(await loadCohortState(store, cohortId));

  const allocation = await allocateNextOrdinal(store, {
    cohortId,
    lane: spec.lane,
    refold,
    runRequirements: (ordinal) => spec.plan(ordinal).map((e) => e.requirementKey),
    requestNewRepetition: spec.requestNewRepetition,
  });

  if (allocation.hold) {
    throw new Error(
      `HOLD (${allocation.hold.code}): ${allocation.hold.detail ?? JSON.stringify(allocation.hold)}` +
        ' — nothing was dispatched'
    );
  }
  if (allocation.complete) {
    log(
      `${spec.lane}: ordinal ${allocation.ordinal ?? 'n/a'} is already complete — nothing to ` +
        `dispatch. Pass ${spec.newRunFlag} to start a new one.`
    );
    return {
      cohortId,
      lane: spec.lane,
      ordinal: allocation.ordinal,
      dispatched: 0,
      complete: true,
    };
  }

  const { ordinal, versionId, adopted, dispatch } = allocation;
  log(
    `${spec.lane}: ${adopted ? 'adopted' : 'allocated'} ordinal ${ordinal} ` +
      `(allocation ${versionId}); ${dispatch.length} outstanding requirement(s)`
  );
  if (dispatch.length === 0) {
    return { cohortId, lane: spec.lane, ordinal, dispatched: 0, complete: false };
  }

  // A dispatch entry outside this ordinal's own plan means the allocator and
  // the lane spec disagree about what the ordinal owns. Fail closed: guessing
  // would publish a terminal under a requirement key nothing can interpret.
  const planned = new Map(spec.plan(ordinal).map((e) => [e.requirementKey, e]));
  for (const entry of dispatch) {
    if (!planned.has(entry.requirementKey)) {
      throw new Error(
        `REFUSED: outstanding requirement ${entry.requirementKey} is not part of ${spec.lane} ` +
          `ordinal ${ordinal}'s plan — allocator/lane disagreement. Nothing was dispatched.`
      );
    }
  }

  const interSampleMs = Number.isFinite(Number(args['inter-turn-ms']))
    ? Number(args['inter-turn-ms'])
    : DEFAULT_INTER_SAMPLE_MS;

  const outcomes = [];
  await laneSession({ modelLane: spec.modelLane, repoRoot: REPO_ROOT, log }, async (lane) => {
    let index = 0;
    for (const entry of dispatch) {
      // Pace BETWEEN samples only — the turns inside one fixture are the
      // behaviour under test and must run at their natural cadence.
      if (index > 0 && interSampleMs > 0) await sleep(interSampleMs);
      index += 1;

      const target = await spec.load(planned.get(entry.requirementKey), lane);
      log(
        `${spec.lane}: ordinal ${ordinal} → ${target.fixtureId} ` +
          `(gen ${entry.generation}, ${entry.reason})`
      );

      /**
       * ONE fixture, dispatched under the sealed live capability. The executor
       * returns only `{verdict, reason, mismatch, providerCallIds}`: the report
       * digest and sample identity are the RUNNER's to compute, and the judge's
       * free-form `reason`/expected/actual detail is dropped by
       * `translateJudgeResult` so it can never reach the evidence store.
       */
      const runOneFixture = async () => {
        const laneResult = await lane.driverMod.driveFixture({
          boot: lane.boot,
          fixture: target.fixture,
          expectation: target.expectation,
          // `boardWildcard` before the spread so driveFixture's own opts
          // (turnIds) are forwarded; `windowedOpenAskFamilies` AFTER it so no
          // driver option can widen or disable the policy.
          judge: (exp, frozen, opts) =>
            lane.judgeMod.judgeFrozenEvidence(exp, frozen, {
              boardWildcard: target.boardWildcard,
              ...(opts ?? {}),
              windowedOpenAskFamilies: [...WINDOWED_OPEN_ASK_FAMILIES],
            }),
          log,
        });
        const translated = translateJudgeResult(laneResult, {
          cohortId,
          requirementKey: entry.requirementKey,
          attemptGeneration: entry.generation,
          corpusId: target.fixtureId,
        });
        return {
          verdict: translated.verdict,
          reason: translated.reason,
          mismatch: translated.mismatch,
          providerCallIds: laneResult?.provider_call_ids ?? null,
        };
      };

      const outcome = await runReservedAttempt(store, {
        cohortId,
        requirementKey: entry.requirementKey,
        generation: entry.generation,
        requirementClass: spec.requirementClass,
        model: lane.descriptor.model,
        tier: lane.descriptor.tier,
        modelLane: lane.descriptor.model_lane,
        allocationVersionId: entry.allocationVersionId ?? versionId,
        deploymentFingerprint,
        promptDigest,
        toolDigest,
        // The LANE-WIDE attested digest, never a per-fixture one: `fold.mjs`
        // rejects any other value as `terminal_expectation_digest_unattached`.
        expectationDigest: manifest.vendor_live_sha256,
        fixtureId: target.fixtureId,
        ...(spec.ordinalField === 'repetitionOrdinal'
          ? { repetitionOrdinal: ordinal }
          : { corpusRunOrdinal: ordinal }),
        // Minted per attempt, closing over exactly this fixture: a capability
        // that outlived its attempt would be an authority to dispatch anything.
        liveDispatch: mintLiveDispatchCapability({
          dispatch: runOneFixture,
          clients: lane.boot.liveProviderClients,
          attestation,
        }),
      });

      if (!outcome.dispatched) {
        // A sibling coordinator holds this requirement, or an orphan PENDING
        // blocks it. Both are correct outcomes, not failures: leave the rest of
        // the run to whoever owns it.
        log(
          `${spec.lane}: ${entry.requirementKey} not dispatched ` +
            `(${outcome.reservation?.reason ?? 'unauthorised'})`
        );
      } else {
        log(
          `${spec.lane}: ${target.fixtureId} → ${outcome.verdict}` +
            (outcome.reason ? ` (${outcome.reason})` : '')
        );
      }
      outcomes.push({
        requirementKey: entry.requirementKey,
        fixtureId: target.fixtureId,
        ...outcome,
      });
    }
  });

  return {
    cohortId,
    lane: spec.lane,
    ordinal,
    dispatched: outcomes.filter((o) => o.dispatched).length,
    complete: false,
    outcomes,
  };
}

async function cmdRunIr(args, store, overrides = {}) {
  // Refuse a redirected probe BEFORE anything else: an override that was
  // silently ignored would let an operator believe they had re-pointed the
  // daily probe, and evidence published under `pinned_ir` describing another
  // fixture is undetectable downstream (the terminal carries the ordinal, not
  // the provenance of the thing judged).
  assertNoPinnedIrOverride(args);
  let target = null;
  const spec = {
    lane: PINNED_IR_IDENTITY.lane,
    modelLane: PINNED_IR_MODEL_LANE,
    requirementClass: PINNED_IR_IDENTITY.requirement_class,
    ordinalField: 'repetitionOrdinal',
    newRunFlag: '--new-repetition',
    requestNewRepetition: args['new-repetition'] === true,
    async prepare() {
      // Proves the corpus still matches the frozen pinned identity.
      target = await loadPinnedIrTarget(REPO_ROOT);
    },
    plan(ordinal) {
      return [{ requirementKey: pinnedIrRequirementKey(ordinal), fixtureId: target.fixtureId }];
    },
    async load() {
      return target;
    },
  };
  return coordinateRun(store, args, spec, overrides);
}

async function cmdRunCorpus(args, store, overrides = {}) {
  const modelLane = args['model-lane'] ?? args.lane ?? PINNED_IR_MODEL_LANE;
  // Throws on an unknown lane — never a silent default, because the lane name
  // is what the terminal declares and what the fold measures the model against.
  resolveLaneModel(modelLane);
  let projectionMod = null;
  let fixtureIds = [];
  const spec = {
    lane: vendorCorpusLane(modelLane),
    modelLane,
    requirementClass: 'vendor_corpus',
    ordinalField: 'corpusRunOrdinal',
    newRunFlag: '--new-run',
    requestNewRepetition: args['new-run'] === true,
    async prepare(pre) {
      projectionMod = await import('../model-ab/lib/expectation-projection.mjs');
      assertCorpusProjectionIntegrity(projectionMod, pre.manifest);
      fixtureIds = [...projectionMod.VENDOR_LIVE_FIXTURE_IDS];
    },
    plan(ordinal) {
      return fixtureIds.map((fixtureId) => ({
        requirementKey: vendorCorpusRequirementKey({
          modelLane,
          corpusRunOrdinal: ordinal,
          fixtureId,
        }),
        fixtureId,
      }));
    },
    async load(entry) {
      return loadCorpusTarget(projectionMod, entry.fixtureId);
    },
  };
  return coordinateRun(store, args, spec, overrides);
}

// `cmdStatus` and `resolveCohortId` are exported for their tests: the
// supersession contract is a property of the SHARED resolver every run/decide
// command calls and of the VOID branch `status` prints, so pinning them anywhere
// other than the real functions would pin a copy.
export { cmdRunIr, cmdRunCorpus, cmdStatus, resolveCohortId };

/**
 * Report cohort state.
 *
 * Deliberately does NOT run the success-record phase gate the write commands
 * run. `status` is the diagnostic an operator reaches for precisely WHEN
 * something is wrong; a status that refused to print because the manifest had
 * drifted would leave them with no way to see what drifted. It writes nothing,
 * so there is nothing to protect.
 */
async function cmdStatus(args, store) {
  await assertBucketVersioned(store);
  const supersession = await loadCohortSupersession(store);
  const { superseded } = supersession;
  const cohortId = resolveStatusCohortId(supersession, args.cohort ?? null);

  // A superseded cohort is VOID: a source deploy re-anchored the chain, so its
  // accumulated days do not count and it will never accrue another. Reported
  // explicitly rather than folded, because folding it would print a
  // qualifying-day count that reads like progress toward a gate it can no
  // longer pass.
  if (cohortId && superseded.has(cohortId)) {
    const successor = superseded.get(cohortId);
    console.log(`State: VOID (superseded by ${successor})`);
    console.log('qualifying_days: 0');
    console.log(
      `Cohort ${cohortId} was re-anchored by a later deployment. Its accumulated evidence does ` +
        `not count toward the gate and it accrues no further days. Run status against ${successor}.`
    );
    return;
  }

  const state = await loadCohortState(store, cohortId);
  const manifest = expectationManifestContent();
  const oracle = await recomputeOracleDigest();

  // Cycle-2 — the live check compares against the stage-A event BOUND by
  // this cohort's initialization (by explicit hash), incl. the exact task
  // definition and the recomputed live config fingerprint.
  const init = latestValid(state.cohortRecords, 'cohort_initialized');
  const stageACandidates = state.stageARecords.filter(
    (r) => validateStoredEvent({ key: r.key, payload: r.payload }).length === 0
  );
  const stageA = init
    ? (stageACandidates.find(
        (r) => evidenceEventHash(r.payload) === init.payload.stage_a_event_hash
      ) ?? null)
    : latestValid(state.stageARecords, 'stage_a_deployed');
  const live = await checkLiveDeployment({
    awsRunner: awsJson,
    expected: stageA
      ? {
          task_def_arn: stageA.payload.runtime?.task_def_arn ?? null,
          image_digest: stageA.payload.runtime?.image_digest ?? null,
          commit_sha: stageA.payload.deploy_run?.head_sha ?? null,
          config_fingerprint: stageA.payload.config_fingerprint ?? null,
        }
      : null,
  });

  const fold = await computeFold(store, {
    cohortId,
    expectationManifest: manifest,
    recomputedOracleDigest: oracle,
    liveDeployment: live,
  });

  const handoffDir = args.handoff ?? DEFAULT_HANDOFF;
  const generatedAtIso = new Date().toISOString();
  const { jsonPath, mdPath } = writeProjections(handoffDir, fold, { generatedAtIso });
  console.log(`State: ${fold.state}${fold.progress ? ` — ${fold.progress}` : ''}`);
  if (superseded.size > 0) {
    console.log(
      `superseded (VOID, 0 days each): ${[...superseded.entries()]
        .map(([from, to]) => `${from} → ${to}`)
        .join(', ')}`
    );
  }
  if (fold.stale_deployment)
    console.log('STALE_DEPLOYMENT — live runtime does not match the cohort.');
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
  'run-ir': cmdRunIr,
  'run-corpus': cmdRunCorpus,
  status: cmdStatus,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
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
