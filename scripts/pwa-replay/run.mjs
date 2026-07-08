#!/usr/bin/env node
/**
 * pwa-replay runner CLI (pwa-replay-harness Wave 3, B4).
 *
 *   npm run pwa-replay -- [--scenario=<name-substring>] [--mode=mock|live]
 *                         [--trace-out=<dir>]
 *
 * Thin wrapper over the vitest scenario suite
 * (web/tests/harness/pwa-replay-scenarios.test.ts) so the harness inherits
 * the existing jsdom/setup hygiene (B0 decision: vitest, not a standalone
 * vite-node entry). Scenario YAMLs live in
 * tests/fixtures/pwa-replay-sessions/ (+ the Wave-5 generated sweep).
 *
 * live mode additionally requires:
 *   - a locally running backend (NEXT_PUBLIC_API_URL, default :3000 —
 *     use scripts/voice-latency-bench/run-cheap.sh for the Haiku env)
 *   - PWA_REPLAY_TOKEN: a JWT for the backend (harness-mint-jwt pattern)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const env = { ...process.env };
const scenario = opt('scenario');
if (scenario) env.PWA_REPLAY_SCENARIO = scenario;
const mode = opt('mode');
if (mode) {
  if (mode !== 'mock' && mode !== 'live') {
    console.error(`pwa-replay: unknown --mode=${mode} (mock|live)`);
    process.exit(2);
  }
  env.PWA_REPLAY_MODE = mode;
}
const traceOut = opt('trace-out');
if (traceOut) env.PWA_REPLAY_TRACE_OUT = path.resolve(traceOut);

if (env.PWA_REPLAY_MODE === 'live' && !env.PWA_REPLAY_TOKEN) {
  console.error('pwa-replay: live mode requires PWA_REPLAY_TOKEN (see harness docs)');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/harness/pwa-replay-scenarios.test.ts'],
  { cwd: path.join(repoRoot, 'web'), env, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
