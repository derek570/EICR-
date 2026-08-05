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
    const image = taskDef?.taskDefinition?.containerDefinitions?.[0]?.image ?? null;

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
      imageDigest = detail?.tasks?.[0]?.containers?.[0]?.imageDigest ?? null;
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

    const live = { task_def_arn: taskDefArn, image, image_digest: imageDigest, commit_sha: commitSha };
    if (!expected) return { available: true, fingerprint_matches: true, live };
    const matches =
      (expected.task_def_arn == null || expected.task_def_arn === taskDefArn) &&
      (expected.image_digest == null || expected.image_digest === imageDigest) &&
      (expected.commit_sha == null || expected.commit_sha === commitSha);
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

function statementAllowsPrefix(statement) {
  const actions = [].concat(statement?.Action ?? []);
  const resources = [].concat(statement?.Resource ?? []);
  const hasPut = actions.some((a) => a === 's3:PutObject' || a === 's3:*' || a === '*');
  const hasGet = actions.some((a) => a === 's3:GetObject' || a === 's3:*' || a === '*');
  const covers = resources.some(
    (r) =>
      r === MANIFEST_PREFIX_ARN ||
      r === 'arn:aws:s3:::eicr-files-production/*' ||
      r === 'arn:aws:s3:::eicr-files-production*' ||
      r === '*'
  );
  return statement?.Effect === 'Allow' && covers ? { put: hasPut, get: hasGet } : { put: false, get: false };
}

/**
 * §C5 pre-stage proof, IAM mode: read-only inspection of the deployed task
 * role's inline + managed policies. Missing/denied proof BLOCKS
 * `stage_a_deployed`; the remedy is a source-committed IAM fix in a fresh
 * handoff, never a live-only edit.
 */
export async function proveTaskRolePrefixAccessViaIam({ awsRunner, taskDefArn, region = 'eu-west-2' }) {
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
    const roleName = roleArn.split('/').pop();
    let put = false;
    let get = false;
    const inline = await awsRunner(['iam', 'list-role-policies', '--role-name', roleName]);
    for (const policyName of inline?.PolicyNames ?? []) {
      const pol = await awsRunner([
        'iam',
        'get-role-policy',
        '--role-name',
        roleName,
        '--policy-name',
        policyName,
      ]);
      for (const st of [].concat(pol?.PolicyDocument?.Statement ?? [])) {
        const v = statementAllowsPrefix(st);
        put = put || v.put;
        get = get || v.get;
      }
    }
    const attached = await awsRunner(['iam', 'list-attached-role-policies', '--role-name', roleName]);
    for (const p of attached?.AttachedPolicies ?? []) {
      const meta = await awsRunner(['iam', 'get-policy', '--policy-arn', p.PolicyArn]);
      const versionId = meta?.Policy?.DefaultVersionId;
      if (!versionId) continue;
      const doc = await awsRunner([
        'iam',
        'get-policy-version',
        '--policy-arn',
        p.PolicyArn,
        '--version-id',
        versionId,
      ]);
      for (const st of [].concat(doc?.PolicyVersion?.Document?.Statement ?? [])) {
        const v = statementAllowsPrefix(st);
        put = put || v.put;
        get = get || v.get;
      }
    }
    if (put && get) return { proven: true, mode: 'iam', role: roleName };
    return { proven: false, reason: 'policy_missing_prefix_grant', role: roleName, put, get };
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
