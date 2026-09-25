#!/usr/bin/env node
/**
 * PLAN-CD (feedback-2026-09-17 wave) — emit the compiled-in web copy of
 * `config/ask-class-lifetimes-v1.json`, the CD2 ask-class classifier and its
 * per-class lifetimes.
 *
 * WHY A GENERATED MODULE RATHER THAN AN IMPORT
 * --------------------------------------------
 * `docker/nextjs.Dockerfile`'s builder stage copies the package files,
 * `packages/` and `web/`. It never copies root `config/`, so web cannot import
 * the fixture from app source: the production build would fail to resolve it.
 * The same reasoning, and the same shape, as
 * `scripts/generate-ocpd-bs-suggestions.mjs` (PLAN-CC).
 *
 * So the bytes are compiled in. Web's classifier imports ONLY this generated
 * module, so it has no unreadable case. `web/tests/ask-class-lifetimes.test.ts`
 * reads the `config/` JSON at test time and asserts digest AND deep equality.
 * `scripts/check-ask-class-lifetimes-fixture-sync.sh` regenerates to a temp
 * path and `cmp`s the committed module, so a hand edit fails the gate.
 *
 * Usage:
 *   node scripts/generate-ask-class-lifetimes-module.mjs             # write in place
 *   node scripts/generate-ask-class-lifetimes-module.mjs --out FILE  # write elsewhere
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(REPO_ROOT, 'config', 'ask-class-lifetimes-v1.json');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  'web',
  'src',
  'lib',
  'recording',
  'ask-class-lifetimes-v1.generated.ts'
);

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag === -1 ? DEFAULT_OUT : path.resolve(process.argv[outFlag + 1]);

const bytes = readFileSync(SOURCE);
const digest = createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(bytes.toString('utf8'));

const body = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    config/ask-class-lifetimes-v1.json
 * Generator: scripts/generate-ask-class-lifetimes-module.mjs
 *
 * Regenerate with \`node scripts/generate-ask-class-lifetimes-module.mjs\` whenever
 * the fixture changes. \`scripts/check-ask-class-lifetimes-fixture-sync.sh\`
 * regenerates to a temp path and byte-compares this file, so an edit here
 * without an edit there fails the pre-TestFlight gate.
 *
 * See the generator's header for why web compiles these bytes in instead of
 * importing the JSON.
 */

/** SHA-256 of config/ask-class-lifetimes-v1.json at generation time. */
export const ASK_CLASS_LIFETIMES_DIGEST =
  '${digest}';

export const ASK_CLASS_LIFETIMES = ${JSON.stringify(fixture, null, 2)} as const;
`;

writeFileSync(OUT, body);
process.stdout.write(`generate-ask-class-lifetimes-module: wrote ${OUT} (source sha256 ${digest})\n`);
