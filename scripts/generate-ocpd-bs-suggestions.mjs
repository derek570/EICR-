#!/usr/bin/env node
/**
 * PLAN-CC (feedback-2026-09-17 wave) — emit the compiled-in web copy of
 * `config/ocpd-bs-suggestions.json`.
 *
 * WHY A GENERATED MODULE RATHER THAN AN IMPORT
 * --------------------------------------------
 * `docker/nextjs.Dockerfile`'s builder stage copies the package files,
 * `packages/` and `web/` — it never copies root `config/`. So web CANNOT
 * import `config/ocpd-bs-suggestions.json` from app source: the production
 * build would fail, or worse, resolve to nothing. The alternative considered
 * and declined was a Dockerfile `COPY config/ ./config/`, which additionally
 * needs a `deploy.yml` frontend-filter edit and leaves turbopack's handling of
 * an out-of-`web/` import unverified.
 *
 * So the bytes are compiled in. Web imports ONLY this generated module and has
 * no unreadable case; `web/tests/ocpd-standard.test.ts` reads the `config/`
 * JSON at test time and asserts digest AND deep equality, which is the repo's
 * executed pattern (`dictated-readback-policy.test.ts`,
 * `closed-enum-guard.test.ts`). `scripts/check-ocpd-bs-fixture-sync.sh`
 * regenerates to a temp path and `cmp`s the committed module as a fourth
 * byte-identity check, so a hand-edited generated module fails the build.
 *
 * Usage:
 *   node scripts/generate-ocpd-bs-suggestions.mjs             # write in place
 *   node scripts/generate-ocpd-bs-suggestions.mjs --out FILE  # write elsewhere
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(REPO_ROOT, 'config', 'ocpd-bs-suggestions.json');
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  'web',
  'src',
  'lib',
  'recording',
  'ocpd-bs-suggestions.generated.ts'
);

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag === -1 ? DEFAULT_OUT : path.resolve(process.argv[outFlag + 1]);

const bytes = readFileSync(SOURCE);
const digest = createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(bytes.toString('utf8'));

const body = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    config/ocpd-bs-suggestions.json
 * Generator: scripts/generate-ocpd-bs-suggestions.mjs
 *
 * Regenerate with \`node scripts/generate-ocpd-bs-suggestions.mjs\` whenever the
 * manifest changes. \`scripts/check-ocpd-bs-fixture-sync.sh\` regenerates to a
 * temp path and byte-compares this file, so an edit here without an edit there
 * fails the pre-TestFlight gate.
 *
 * See the generator's header for why web compiles these bytes in instead of
 * importing the JSON.
 */

/** SHA-256 of config/ocpd-bs-suggestions.json at generation time. */
export const OCPD_BS_SUGGESTIONS_DIGEST =
  '${digest}';

export const OCPD_BS_SUGGESTIONS = ${JSON.stringify(manifest, null, 2)} as const;

/** Picker primary suggestions. */
export const OCPD_BS_TIER1: readonly string[] = OCPD_BS_SUGGESTIONS.tier1;

/** Picker secondary suggestions, behind the "More standards" disclosure. */
export const OCPD_BS_TIER2: readonly string[] = OCPD_BS_SUGGESTIONS.tier2;

/** Picker control character cap. */
export const OCPD_BS_INPUT_CAP: number = OCPD_BS_SUGGESTIONS.cap;
`;

writeFileSync(OUT, body);
process.stdout.write(`generate-ocpd-bs-suggestions: wrote ${OUT} (source sha256 ${digest})\n`);
