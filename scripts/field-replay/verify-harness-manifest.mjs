#!/usr/bin/env node
/**
 * verify-harness-manifest.mjs — the trusted-harness manifest check (plan
 * Item 4). Runs inside the anchored evidence workflow BEFORE the runner is
 * invoked. A byte-identical evidence workflow is not enough — the run still
 * executes branch-controlled code:
 *   1. verify the CHECKED-OUT config/field-replay-harness-manifest.json is
 *      byte-identical to the target-branch (--anchor-ref) copy — a
 *      branch-controlled manifest could silently DROP a helper and then
 *      modify it;
 *   2. for every TARGET-manifest core file, verify the checked-out blob is
 *      byte-identical to the target-branch blob — before importing any
 *      branch code.
 *
 * The fetch is from the target-branch BLOB (git show <ref>:<path>), never
 * the PR checkout. Regressions (a removed manifest entry, an edited
 * manifest, a modified helper omitted only by the PR copy) are exercised by
 * the unit tests via the pure core.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const MANIFEST_PATH = 'config/field-replay-harness-manifest.json';

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Pure verification: compare checked-out bytes to anchor bytes. */
export function verifyManifest({ anchorManifestBytes, checkedOutManifestBytes, coreFileBytes }) {
  const errors = [];
  if (anchorManifestBytes == null) {
    return { ok: false, errors: ['manifest absent on anchor ref'] };
  }
  if (sha(checkedOutManifestBytes) !== sha(anchorManifestBytes)) {
    errors.push('checked-out harness manifest differs from the target-branch copy — a branch-controlled manifest may not drop/edit entries');
    // Still fail closed; do not proceed to per-file checks against a
    // manifest we cannot trust.
    return { ok: false, errors };
  }
  const anchorManifest = JSON.parse(anchorManifestBytes.toString('utf8'));
  for (const file of anchorManifest.core_files) {
    const { anchor, head } = coreFileBytes[file] ?? {};
    if (anchor == null) {
      errors.push(`core file missing on anchor ref: ${file}`);
      continue;
    }
    if (head == null) {
      errors.push(`core file missing in checkout: ${file}`);
      continue;
    }
    if (sha(anchor) !== sha(head)) {
      errors.push(`core file differs from the anchored target-branch blob: ${file}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.join('=')];
    }),
  );
  const anchorRef = args['anchor-ref'] ?? 'main';
  const anchorManifestBytes = gitShow(anchorRef, MANIFEST_PATH);
  const checkedOutManifestBytes = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH) : null;
  if (!checkedOutManifestBytes) {
    console.error('verify-harness-manifest: checked-out manifest missing');
    process.exit(1);
  }
  const coreFiles = anchorManifestBytes
    ? JSON.parse(anchorManifestBytes.toString('utf8')).core_files
    : [];
  const coreFileBytes = {};
  for (const file of coreFiles) {
    coreFileBytes[file] = {
      anchor: gitShow(anchorRef, file),
      head: fs.existsSync(file) ? fs.readFileSync(file) : null,
    };
  }
  const { ok, errors } = verifyManifest({ anchorManifestBytes, checkedOutManifestBytes, coreFileBytes });
  if (ok) {
    console.log(`verify-harness-manifest: ${coreFiles.length} core files verified against ${anchorRef}.`);
    process.exit(0);
  }
  for (const e of errors) console.error(`verify-harness-manifest: ${e}`);
  process.exit(1);
}
