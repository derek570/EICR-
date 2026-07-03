#!/usr/bin/env node
/**
 * Node-version preflight for the web workspace.
 *
 * WHY: CI pins Node 20 (`.github/workflows/deploy.yml` `node-version: '20'`,
 * 4 sites) but the dev machine runs a different major (v25 at the time of
 * writing) and no version manager is guaranteed to be installed. jsdom /
 * Storage / experimental-webstorage behaviour differs across Node majors,
 * which is exactly what made the WS7 "green locally / red in CI" harness
 * bug unreproducible. This preflight makes the divergence LOUD so a plain
 * `npm test --workspace=web` on the wrong Node can't quietly go green.
 *
 * BEHAVIOUR: WARN-only by design — it exits 0 on a mismatch so it never
 * blocks unrelated local work (and so the pre-push hook, where it also
 * runs, never hard-fails a push from a GUI git client with a minimal
 * PATH). A hard gate is opt-in: set CHECK_NODE_STRICT=1 to make a
 * mismatched major exit non-zero.
 *
 * The expected major is read from the repo-root `.nvmrc` so there is a
 * single source of truth (bump `.nvmrc` + `deploy.yml` together for an
 * exact-patch pin).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// web/scripts/check-node.mjs → repo root is two levels up.
const nvmrcPath = resolve(__dirname, '..', '..', '.nvmrc');

let expectedMajor = 20;
try {
  const raw = readFileSync(nvmrcPath, 'utf8').trim();
  // `.nvmrc` may hold `20`, `20.11.1`, `v20`, `lts/iron`, etc. Pull the
  // first integer; fall back to 20 if it isn't a plain version.
  const m = raw.match(/(\d+)/);
  if (m) expectedMajor = Number(m[1]);
} catch {
  // No .nvmrc readable — keep the 20 default; still worth warning on a mismatch.
}

const runningMajor = Number(process.versions.node.split('.')[0]);
const strict = process.env.CHECK_NODE_STRICT === '1';

if (runningMajor !== expectedMajor) {
  const msg =
    `\n⚠️  Node ${process.versions.node} detected, but CI runs Node ${expectedMajor} ` +
    `(see .nvmrc).\n    Other majors change jsdom/Storage behaviour — "green locally" may not ` +
    `mean "green in CI".\n    Use Node ${expectedMajor} (e.g. \`nvm use\`) before trusting a local web test run.\n`;
  if (strict) {
    console.error(msg + '    CHECK_NODE_STRICT=1 → failing.\n');
    process.exit(1);
  }
  console.warn(msg);
}

process.exit(0);
