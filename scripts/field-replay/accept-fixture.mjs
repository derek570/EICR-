#!/usr/bin/env node
/**
 * accept-fixture.mjs — stage 2 of the field-replay fixture workflow.
 *
 * Usage:
 *   node scripts/field-replay/accept-fixture.mjs \
 *     --draft=<path outside the corpus root> \
 *     --manifest=<private manifest path (0600, inside the 0700 archive)> \
 *     --out=<tests/fixtures/field-replay-corpus/<corpus-id>/fixture.yaml> \
 *     --reviewer=<name>
 *
 * Verifies freshness, provenance, PII review, raw-ID remapping, and chime
 * evidence AGAINST the private manifest, then emits the committed fixture
 * PLUS the sanitized PUBLIC review attestation (attestation.json beside the
 * fixture). Fails closed on a missing/stale/fingerprint-mismatched manifest
 * or unrecognized chime provenance.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { acceptFixture } from './lib/accept-core.mjs';
import { isInsideCorpusRoot, CORPUS_ROOT } from './lib/convert-core.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=')];
  }),
);

const { draft, manifest: manifestPath, out, reviewer } = args;
if (!draft || !manifestPath || !out || !reviewer) {
  console.error('Usage: --draft=<path> --manifest=<path> --out=<committed fixture> --reviewer=<name>');
  process.exit(2);
}

try {
  // The manifest must live in a restricted location (0700 dir, 0600 file).
  const mDirMode = fs.statSync(path.dirname(manifestPath)).mode & 0o777;
  const mFileMode = fs.statSync(manifestPath).mode & 0o777;
  if ((mDirMode & 0o077) !== 0 || (mFileMode & 0o177) !== 0) {
    throw new Error(`manifest permissions too broad (dir ${mDirMode.toString(8)}, file ${mFileMode.toString(8)}) — need 0700/0600`);
  }
  if (!isInsideCorpusRoot(out)) {
    throw new Error(`--out ${out} must be inside ${CORPUS_ROOT}/<corpus-id>/`);
  }

  const draftRawBytes = fs.readFileSync(draft);
  const draftDoc = yaml.load(draftRawBytes.toString('utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const acceptedAtIso = new Date().toISOString();

  const result = await acceptFixture({
    draftDoc,
    draftRawBytes,
    manifest,
    acceptedAtIso,
    reviewer,
    draftPath: draft,
    outPath: out,
    isInsideCorpusRootFn: isInsideCorpusRoot,
  });

  if (!result.ok) {
    console.error('acceptance FAILED:');
    for (const e of result.errors) console.error(`  - [${e.code}] ${e.message}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, yaml.dump(result.fixture, { lineWidth: 100 }));
  const attPath = path.join(path.dirname(out), 'attestation.json');
  fs.writeFileSync(attPath, JSON.stringify(result.attestation, null, 2) + '\n');
  console.log(`accepted: ${out}`);
  console.log(`attestation: ${attPath}`);
  console.log(`immutable_payload_hash: ${result.attestation.immutable_payload_hash}`);
} catch (err) {
  console.error(`accept-fixture: ${err.message}`);
  process.exit(1);
}
