#!/usr/bin/env node
/**
 * convert-session.mjs — stage 1 of the field-replay fixture workflow.
 *
 * Usage:
 *   node scripts/field-replay/convert-session.mjs \
 *     --source=cloudwatch:primary:/path/session_full.jsonl \
 *     [--source=debug_report:supporting:/path/report.json …] \
 *     --out=.field-replay-drafts/<name>.draft.yaml \
 *     --private-dir=<restricted-archive-dir> \
 *     [--session-id=<raw session id>]
 *
 * Emits a git-ignored, sanitized, NON-runnable draft in the repo and writes
 * the PRIVATE manifest + source index DIRECTLY into the restricted archive
 * (`--private-dir` created/verified 0700, files 0600 — never a repo-adjacent
 * sidecar). Exit 0 on success; 1 on fail-closed conditions; 2 on usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  convertSession,
  parseSourceArg,
  isInsideCorpusRoot,
  DRAFT_ROOT,
} from './lib/convert-core.mjs';

const args = process.argv.slice(2);
const sourceSpecs = [];
let outPath = null;
let privateDir = null;
let sessionId = null;

for (const a of args) {
  if (a.startsWith('--source=')) sourceSpecs.push(parseSourceArg(a.slice('--source='.length)));
  else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
  else if (a.startsWith('--private-dir=')) privateDir = a.slice('--private-dir='.length);
  else if (a.startsWith('--session-id=')) sessionId = a.slice('--session-id='.length);
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

if (sourceSpecs.length === 0 || !outPath || !privateDir) {
  console.error('Usage: --source=<type>:<role>:<path> [...] --out=<draft> --private-dir=<dir>');
  process.exit(2);
}

try {
  // Drafts NEVER live inside the executable corpus root — filesystem
  // discovery ignores .gitignore, so an ignored draft named fixture.yaml
  // under the corpus root would still be discovered and fail pre-push.
  if (isInsideCorpusRoot(outPath)) {
    throw new Error(`--out ${outPath} is inside the corpus root — write drafts under ${DRAFT_ROOT}/`);
  }

  // Private dir: create/verify 0700.
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const dirMode = fs.statSync(privateDir).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    throw new Error(`--private-dir ${privateDir} is ${dirMode.toString(8)} — must be 0700`);
  }

  const { corpusId, draft, manifest, failures } = convertSession({
    sourceSpecs,
    expectedSessionId: sessionId,
  });
  manifest.created_at = new Date().toISOString();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, yaml.dump(draft, { lineWidth: 100 }));

  const manifestPath = path.join(privateDir, `${corpusId}.manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  console.log(`corpus_id: ${corpusId}`);
  console.log(`draft: ${outPath}`);
  console.log(`private manifest: ${manifestPath}`);
  if (failures.length > 0) {
    console.log(
      `NOTE: ${failures.length} chime correlation failure(s) need a human-selected mapping in the manifest before acceptance.`,
    );
  }
} catch (err) {
  console.error(`convert-session: ${err.message}`);
  process.exit(1);
}
