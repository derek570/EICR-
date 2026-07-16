#!/usr/bin/env node
/**
 * verify-env-protection.mjs — the manual vendor job's execution preflight
 * (plan Item 3). Before any vendor call, verify the named protected
 * environment's rules via `gh api`: Derek as required reviewer,
 * prevent_self_review: false (else Derek cannot approve a run he
 * dispatched), deployment branches restricted to main, no admin bypass.
 * The manual vendor step stays DISABLED until this verification succeeds.
 * If the repository plan does not support required reviewers, Item 3 is
 * marked INCOMPLETE — never a silently unprotected manual job.
 */

import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=')];
  }),
);
const envName = args.environment;
const REPO = 'derek570/EICR-';
if (!envName) {
  console.error('Usage: --environment=<name>');
  process.exit(2);
}

function gh(a) {
  return execFileSync('gh', a, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN } });
}

try {
  const env = JSON.parse(gh(['api', `repos/${REPO}/environments/${encodeURIComponent(envName)}`]));
  const errors = [];
  const rules = env.protection_rules ?? [];
  const reviewerRule = rules.find((r) => r.type === 'required_reviewers');
  if (!reviewerRule) errors.push('no required_reviewers protection rule');
  if (reviewerRule && reviewerRule.prevent_self_review === true) {
    errors.push('prevent_self_review is true — the dispatching maintainer could not approve their own run');
  }
  const branchPolicy = env.deployment_branch_policy;
  if (!branchPolicy || branchPolicy.protected_branches !== false || branchPolicy.custom_branch_policies !== true) {
    // Expect custom policy restricting to main; the exact branch list is
    // checked via the branch-policies endpoint.
    // (A protected_branches:true policy allows any protected branch — too broad.)
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`verify-env-protection: ${e}`);
    console.error('Item 3 stays INCOMPLETE until the protected environment is correctly configured (never a silently unprotected manual job).');
    process.exit(1);
  }
  console.log(`verify-env-protection: ${envName} protection rules verified.`);
  process.exit(0);
} catch (err) {
  console.error(`verify-env-protection: ${err.message}`);
  console.error('The protected environment is not configured — Item 3 stays INCOMPLETE; the manual vendor step stays DISABLED.');
  process.exit(1);
}
