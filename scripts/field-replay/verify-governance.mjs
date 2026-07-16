#!/usr/bin/env node
/**
 * verify-governance.mjs — CLI wrapper over governance-core (plan Item 2).
 * Verifies a signed governance-event commit via authenticated `gh api`
 * GraphQL (SshSignature.keyFingerprint / GpgSignature) against the
 * allowlist read AT THE BASE COMMIT, binds it to the exact commit OID +
 * permitted diff, and enforces rotation isolation. Also the bootstrap-step-1
 * GENESIS verifier and the bootstrap-step-2 mechanism_probe verifier.
 *
 * Usage:
 *   verify-governance.mjs --commit=<oid> --event-type=<type> --base-ref=<ref> \
 *     [--permitted=<comma paths>] [--genesis]
 */

import { execFileSync } from 'node:child_process';
import {
  verifyGovernanceCommit,
  verifyGenesis,
  GOV_EVENT_TYPES,
} from './lib/governance-core.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);

function gh(ghArgs) {
  return execFileSync('gh', ghArgs, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN } });
}
function git(a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

const REPO = 'derek570/EICR-';
const commitOid = args.commit;
if (!commitOid || (!args.genesis && !GOV_EVENT_TYPES.includes(args['event-type']))) {
  console.error('Usage: --commit=<oid> --event-type=<type> --base-ref=<ref> [--permitted=<paths>] [--genesis]');
  process.exit(2);
}

// Fetch the commit signature via GraphQL. SSH signatures expose
// keyFingerprint; GPG signatures expose keyId. `verified` means GitHub
// validated SOME key — we bind the fingerprint ourselves.
function fetchSignature(oid) {
  const query = `query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{oid signature{isValid state ... on SshSignature{keyFingerprint} ... on GpgSignature{keyId}}}}}}`;
  const out = JSON.parse(
    gh(['api', 'graphql', '-f', `query=${query}`, '-F', 'owner=derek570', '-F', 'name=EICR-', '-F', `oid=${oid}`]),
  );
  const commit = out.data?.repository?.object;
  const sig = commit?.signature ?? null;
  return {
    boundOid: commit?.oid ?? null,
    signature: sig
      ? { verified: sig.isValid === true, keyFingerprint: sig.keyFingerprint ?? null, keyId: sig.keyId ?? null }
      : { verified: false },
  };
}

try {
  const { boundOid, signature } = fetchSignature(commitOid);
  const baseRef = args['base-ref'] ?? 'main';
  const changedPaths = git(['diff', '--name-only', `${commitOid}^`, commitOid]).split('\n').filter(Boolean);

  if (args.genesis) {
    const allowlist = JSON.parse(git(['show', `${commitOid}:config/field-replay-maintainers.json`]));
    const genesisKey = allowlist.keys.find((k) => k.genesis) ?? allowlist.keys[0];
    const r = verifyGenesis({ signature, genesisKey, commitOid, boundOid });
    if (!r.ok) {
      for (const e of r.errors) console.error(`verify-governance (genesis): [${e.code}] ${e.message}`);
      process.exit(1);
    }
    console.log(`verify-governance: genesis key ${genesisKey.fingerprint} verified on ${commitOid}.`);
    process.exit(0);
  }

  // Allowlist AT THE BASE COMMIT — never the PR head.
  const allowlist = JSON.parse(git(['show', `${baseRef}:config/field-replay-maintainers.json`]));
  const permittedPaths = (args.permitted ?? '').split(',').filter(Boolean);
  const r = verifyGovernanceCommit({
    commitOid,
    boundOid,
    signature,
    allowlist,
    changedPaths,
    permittedPaths,
    eventType: args['event-type'],
  });
  if (!r.ok) {
    for (const e of r.errors) console.error(`verify-governance: [${e.code}] ${e.message}`);
    process.exit(1);
  }
  console.log(`verify-governance: ${args['event-type']} on ${commitOid} verified against the base allowlist.`);
  process.exit(0);
} catch (err) {
  console.error(`verify-governance: ${err.message}`);
  process.exit(1);
}
void REPO;
