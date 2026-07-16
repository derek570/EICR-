#!/usr/bin/env node
/**
 * validate-fixture.mjs — stage 3 (CI) of the field-replay fixture workflow.
 *
 * Usage:
 *   node scripts/field-replay/validate-fixture.mjs <committed-fixture> [...]
 *   node scripts/field-replay/validate-fixture.mjs --corpus-root
 *
 * Runs against the committed fixture + public attestation ONLY — no private
 * manifest needed (the manifest is never committed, so CI could never have
 * it). Validates the document, recomputes the immutable-projection hash
 * against the attestation, and applies the generic privacy scans.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { validateCommittedFixture } from './lib/accept-core.mjs';
import { CORPUS_ROOT } from './lib/convert-core.mjs';
import { discoverFixtures } from './lib/discovery.mjs';

const args = process.argv.slice(2);
let targets = [];
if (args.includes('--corpus-root')) {
  targets = discoverFixtures(CORPUS_ROOT).map((d) => d.fixturePath);
} else {
  targets = args.filter((a) => !a.startsWith('--'));
}

if (targets.length === 0) {
  console.log('validate-fixture: 0 fixtures to validate');
  process.exit(0);
}

let failed = 0;
for (const fixturePath of targets) {
  const raw = fs.readFileSync(fixturePath);
  const doc = yaml.load(raw.toString('utf8'));
  const attPath = path.join(path.dirname(fixturePath), 'attestation.json');
  const attestation = fs.existsSync(attPath) ? JSON.parse(fs.readFileSync(attPath, 'utf8')) : null;
  const result = await validateCommittedFixture({
    fixtureDoc: doc,
    fixtureRawBytes: raw,
    attestation,
    relPath: fixturePath,
  });
  if (result.ok) {
    console.log(`✓ ${fixturePath}`);
  } else {
    failed += 1;
    console.error(`✗ ${fixturePath}`);
    for (const e of result.errors) console.error(`  - [${e.code}] ${e.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
