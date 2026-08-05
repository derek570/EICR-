/**
 * Plan 00C §C5 — trusted-deploy verification, live runtime checks and the
 * cohort fingerprint. Operator-side; every external read is injectable.
 *
 * - `verifyTrustedDeploy` reuses the field-replay `verifyTrustedRun`
 *   contract against a gh-fetched run (repository, workflow path, event,
 *   head SHA, conclusion) plus the deploy JOB conclusion — rolloutState is
 *   deliberately NOT trusted (stale-rollout lesson, vault 2026-07-18).
 * - `checkLiveDeployment` performs the fresh READ-ONLY ECS task-definition/
 *   image check every status/finalise/downstream gate must run; unavailable
 *   live state or drift returns HOLD_EVIDENCE/STALE_DEPLOYMENT upstream.
 * - `proveTaskRolePrefixAccess` implements the §C5 pre-stage proof that the
 *   deployed task role can PutObject/GetObject under the manifest prefix —
 *   read-only IAM policy inspection, or a deployed smoke-session pair that
 *   passes full collector validation.
 */

import { verifyTrustedRun } from '../../field-replay/lib/evidence-events.mjs';
import { collectSessionManifests } from './collector.mjs';
import { computeConfigFingerprint } from '../../../src/extraction/plan00-session-manifest.js';

export const DEPLOY_REPO = 'derek570/EICR-';
export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';
export const DEPLOY_JOB_NAME = 'Deploy to AWS ECS (Production)';
export const MANIFEST_PREFIX_ARN = 'arn:aws:s3:::eicr-files-production/plan00-session-manifests/*';

/**
 * Verify one GitHub deploy run as the trusted deploy for `headSha`.
 * `fetchRun(runId)` is injected and must return
 * { repository, workflow_path, event, ref, head_sha, conclusion, jobs:
 *   [{name, conclusion}] } fetched via authenticated gh.
 */
export async function verifyTrustedDeploy({ runId, headSha, fetchRun }) {
  const fetched = await fetchRun(runId);
  const verdict = verifyTrustedRun(
    {
      repository: DEPLOY_REPO,
      workflow_path: DEPLOY_WORKFLOW_PATH,
      events: ['push'],
      ref_pattern: '^refs/heads/main$',
      head_sha: headSha,
      artifact_name: fetched.artifact_name ?? null,
    },
    fetched
  );
  const errors = [...verdict.errors];
  const deployJob = (fetched.jobs ?? []).find((j) => j.name === DEPLOY_JOB_NAME);
  if (!deployJob || deployJob.conclusion !== 'success') {
    errors.push('deploy_job_not_successful');
  }
  return { ok: errors.length === 0, errors, run: fetched };
}

/**
 * Fresh read-only live check: resolve the running task's image digest and
 * task-definition revision, map the digest to its ECR ${github.sha} tag,
 * and compare against the expected deployment (from stage_a_deployed /
 * the cohort fingerprint). `awsRunner(args)` is injected (operator aws CLI)
 * and must return parsed JSON.
 */
export async function checkLiveDeployment({
  awsRunner,
  cluster = 'eicr-cluster-production',
  service = 'eicr-backend',
  region = 'eu-west-2',
  expected, // { task_def_arn?, image_digest?, commit_sha? } | null
}) {
  try {
    const services = await awsRunner([
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      service,
      '--region',
      region,
    ]);
    const svc = services?.services?.[0];
    const taskDefArn = svc?.taskDefinition ?? null;
    if (!taskDefArn) return { available: false, fingerprint_matches: false, reason: 'no_task_definition' };
    const taskDef = await awsRunner([
      'ecs',
      'describe-task-definition',
      '--task-definition',
      taskDefArn,
      '--region',
      region,
    ]);
    const containerDefs = taskDef?.taskDefinition?.containerDefinitions ?? [];
    const backendDef =
      containerDefs.find((c) => c?.name === 'eicr-backend') ??
      (containerDefs.length === 1 ? containerDefs[0] : null);
    const image = backendDef?.image ?? null;

    const tasks = await awsRunner([
      'ecs',
      'list-tasks',
      '--cluster',
      cluster,
      '--service-name',
      service,
      '--region',
      region,
    ]);
    const taskArns = tasks?.taskArns ?? [];
    let imageDigest = null;
    if (taskArns.length > 0) {
      const detail = await awsRunner([
        'ecs',
        'describe-tasks',
        '--cluster',
        cluster,
        '--tasks',
        ...taskArns,
        '--region',
        region,
      ]);
      // Codex cycle-1 — EVERY running task's backend container must agree
      // on one digest; overlap during a rollout is 'unavailable', never a
      // match against whichever task listed first.
      const digests = new Set();
      for (const task of detail?.tasks ?? []) {
        const containers = task?.containers ?? [];
        const backend =
          containers.find((c) => c?.name === 'eicr-backend') ??
          (containers.length === 1 ? containers[0] : null);
        if (backend?.imageDigest) digests.add(backend.imageDigest);
      }
      if (digests.size > 1) {
        return {
          available: false,
          fingerprint_matches: false,
          reason: 'rollout_in_progress_multiple_digests',
        };
      }
      imageDigest = digests.size === 1 ? [...digests][0] : null;
    }

    let commitSha = null;
    if (imageDigest) {
      const ecr = await awsRunner([
        'ecr',
        'describe-images',
        '--repository-name',
        'eicr-backend',
        '--image-ids',
        `imageDigest=${imageDigest}`,
        '--region',
        region,
      ]);
      const tags = ecr?.imageDetails?.[0]?.imageTags ?? [];
      commitSha = tags.find((t) => /^[0-9a-f]{40}$/.test(t)) ?? null;
    }

    // Cycle-2 — a same-image task-definition/env change must be VISIBLE:
    // recompute the config fingerprint from the LIVE task-definition
    // environment with the SAME derivation the server uses.
    const taskEnv = {};
    for (const row of backendDef?.environment ?? []) taskEnv[row.name] = row.value;
    const liveConfigFingerprint = computeConfigFingerprint(taskEnv);

    const live = {
      task_def_arn: taskDefArn,
      image,
      image_digest: imageDigest,
      commit_sha: commitSha,
      config_fingerprint: liveConfigFingerprint,
    };
    if (!expected) return { available: true, fingerprint_matches: true, live };
    const matches =
      (expected.task_def_arn == null || expected.task_def_arn === taskDefArn) &&
      (expected.image_digest == null || expected.image_digest === imageDigest) &&
      (expected.commit_sha == null || expected.commit_sha === commitSha) &&
      (expected.config_fingerprint == null || expected.config_fingerprint === liveConfigFingerprint);
    return {
      available: true,
      fingerprint_matches: matches,
      reason: matches ? null : 'deployment_drift',
      live,
    };
  } catch (err) {
    return { available: false, fingerprint_matches: false, reason: `live_check_failed:${err?.message}` };
  }
}

/**
 * §C5 pre-stage proof, IAM mode — EFFECTIVE permissions via read-only
 * `iam simulate-principal-policy` (cycle-3: an Allow-statement scan ignored
 * explicit denies, conditions and boundaries). Every evaluated action must
 * come back exactly "allowed"; anything else — implicit/explicit deny,
 * unsupported condition context, missing results — fails CLOSED.
 */
export async function proveTaskRolePrefixAccessViaIam({
  awsRunner,
  taskDefArn,
  region = 'eu-west-2',
}) {
  try {
    const taskDef = await awsRunner([
      'ecs',
      'describe-task-definition',
      '--task-definition',
      taskDefArn,
      '--region',
      region,
    ]);
    const roleArn = taskDef?.taskDefinition?.taskRoleArn ?? null;
    if (!roleArn) return { proven: false, reason: 'no_task_role' };
    const sim = await awsRunner([
      'iam',
      'simulate-principal-policy',
      '--policy-source-arn',
      roleArn,
      '--action-names',
      's3:PutObject',
      's3:GetObject',
      '--resource-arns',
      MANIFEST_PREFIX_ARN,
    ]);
    const results = sim?.EvaluationResults ?? [];
    const actions = new Set(results.map((r) => r.EvalActionName));
    const allAllowed =
      actions.has('s3:PutObject') &&
      actions.has('s3:GetObject') &&
      results.length > 0 &&
      results.every((r) => r.EvalDecision === 'allowed');
    if (allAllowed) return { proven: true, mode: 'iam', role: roleArn };
    return {
      proven: false,
      reason: 'simulation_not_allowed',
      results: results.map((r) => ({ action: r.EvalActionName, decision: r.EvalDecision })),
    };
  } catch (err) {
    return { proven: false, reason: `iam_inspection_failed:${err?.message}` };
  }
}

/** §C5 pre-stage proof, smoke mode: one deployed session whose manifest
 *  pair passes FULL collector receipt/read-back validation. */
export async function proveTaskRolePrefixAccessViaSmoke(store, { deploymentFingerprint, sessionId }) {
  const pair = await collectSessionManifests(store, { deploymentFingerprint, sessionId });
  if (pair.problems.length === 0 && pair.start && pair.completion) {
    return { proven: true, mode: 'smoke', session_id: sessionId };
  }
  return { proven: false, reason: 'smoke_session_invalid', problems: pair.problems };
}
