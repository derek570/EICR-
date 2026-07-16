#!/usr/bin/env node
/**
 * accept-evidence.mjs — evidence acceptance CLI (plan Item 1). Three modes,
 * ALL using trusted-run retrieval (the flag shapes themselves cannot be
 * read as accepting a local file — there is no --log/--artifact input):
 *
 *   RED:      --manifest=<private> --run-id=<id> --artifact-name=<name> --evidence-dir=<dir>
 *   GREEN:    --fixture=<fixture> --attestation=<public> --run-id=<id> --artifact-name=<name> --evidence-dir=<dir>
 *   ADVISORY: --mode=advisory --run-id=<id> --artifact-name=<name> --evidence-dir=<dir> [--flip-lifecycle]
 *
 * The tool itself fetches the run + artifact via authenticated `gh api` /
 * `gh run download` and verifies repository, workflow blob, event, ref,
 * head SHA, conclusion, artifact digest, fixture hash, assertion ID, and
 * tested tree before reading the result tuple. Emits an immutable evidence
 * event + attestation into the append-only evidence directory (overwrites
 * rejected).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  acceptRedEvidence,
  acceptGreenEvidence,
  acceptAdvisoryEvidence,
  TRUSTED,
} from './lib/evidence-accept-core.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);

const runId = args['run-id'];
const artifactName = args['artifact-name'];
const evidenceDir = args['evidence-dir'];
if (!runId || !artifactName || !evidenceDir) {
  console.error('Usage: [--manifest=<p> | --fixture=<p> --attestation=<p> | --mode=advisory] --run-id=<id> --artifact-name=<n> --evidence-dir=<dir>');
  process.exit(2);
}

function gh(ghArgs, opts = {}) {
  return execFileSync('gh', ghArgs, { encoding: 'utf8', ...opts });
}

/** Real gh-backed fetchers (mocked in tests via the core's injection). */
const fetchers = {
  async getRun(id) {
    const run = JSON.parse(gh(['api', `repos/${TRUSTED.repository}/actions/runs/${id}`]));
    return {
      id: run.id,
      repository: run.repository?.full_name ?? null,
      workflow_path: run.path ?? null,
      workflow_blob_sha: run.head_commit ? null : null, // resolved via getAnchoredWorkflowBlobSha comparison below
      event: run.event,
      ref: run.head_branch ? `refs/heads/${run.head_branch}` : null,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
    };
  },
  async getArtifact(id, name) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-evidence-'));
    gh(['run', 'download', String(id), '--repo', TRUSTED.repository, '-n', name, '-D', tmp]);
    // The artifact contains runner-result.json (the structured output).
    const resultPath = path.join(tmp, 'runner-result.json');
    const bytes = fs.readFileSync(resultPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { bytes, digest, name };
  },
  async getAnchoredWorkflowBlobSha(workflowPath) {
    // The TARGET-BRANCH blob — never the PR checkout.
    const out = JSON.parse(
      gh(['api', `repos/${TRUSTED.repository}/contents/${workflowPath}?ref=main`]),
    );
    return out.sha ?? null;
  },
};

// Patch: run.workflow_blob_sha must be the blob of the workflow AT THE RUN's
// commit; compare it to the anchored main blob.
const origGetRun = fetchers.getRun;
fetchers.getRun = async (id) => {
  const run = await origGetRun(id);
  if (run.workflow_path) {
    try {
      const out = JSON.parse(
        gh(['api', `repos/${TRUSTED.repository}/contents/${run.workflow_path}?ref=${run.head_sha}`]),
      );
      run.workflow_blob_sha = out.sha ?? null;
    } catch {
      run.workflow_blob_sha = null;
    }
  }
  return run;
};

try {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const existing = fs.readdirSync(evidenceDir);
  let result;
  if (args.mode === 'advisory') {
    const history = existing
      .filter((n) => n.startsWith('advisory-'))
      .sort()
      .map((n) => JSON.parse(fs.readFileSync(path.join(evidenceDir, n), 'utf8')).event ?? JSON.parse(fs.readFileSync(path.join(evidenceDir, n), 'utf8')));
    result = await acceptAdvisoryEvidence({
      runId,
      artifactName,
      fetchers,
      existingEvidenceNames: existing,
      history,
      lifecycleFlipRequested: !!args['flip-lifecycle'],
    });
  } else if (args.manifest) {
    const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    result = await acceptRedEvidence({
      manifest,
      runId,
      artifactName,
      fetchers,
      existingEvidenceNames: existing,
    });
  } else if (args.fixture && args.attestation) {
    yaml.load(fs.readFileSync(args.fixture, 'utf8')); // shape check only
    const attestation = JSON.parse(fs.readFileSync(args.attestation, 'utf8'));
    result = await acceptGreenEvidence({
      attestation,
      runId,
      artifactName,
      fetchers,
      existingEvidenceNames: existing,
    });
  } else {
    console.error('one of --manifest (red), --fixture+--attestation (green), or --mode=advisory is required');
    process.exit(2);
  }

  const eventPath = path.join(evidenceDir, result.fileName);
  fs.writeFileSync(eventPath, JSON.stringify({ event: result.event, attestation: result.attestation }, null, 2) + '\n', { flag: 'wx' });
  console.log(`evidence accepted: ${eventPath}`);
  console.log(`event_hash: ${result.attestation.event_hash}`);
} catch (err) {
  console.error(`accept-evidence: ${err.message}`);
  process.exit(1);
}
