#!/usr/bin/env node
/**
 * C4 — one-command iOS-session differential (pwa-replay-harness Wave 4).
 *
 *   npm run pwa-replay:session -- --session=<sessionId>
 *        [--initial-state=<job-state.json>] [--mode=live] [--keep]
 *
 * fetch (fetch-session-analytics.sh) → convert (convert-session.mjs) →
 * replay through the web pipeline (mock mode from the reconstructed
 * frames by default; --mode=live optional) → diff (diff-traces.mjs) →
 * report. Exit non-zero on strict-lane divergence.
 *
 * WEB sessions (sess_* ids) have no debug_log.jsonl in S3 — if the
 * fetched dir lacks one, this fails with an explicit error UNLESS a
 * checked-in fixture in tests/fixtures/pwa-replay-sessions/ matches the
 * session id, in which case that fixture replays invariant-only (no iOS
 * trace to diff).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const sessionId = opt('session');
if (!sessionId) {
  console.error('pwa-replay:session — --session=<sessionId> is required');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/pwa-replay-sessions');
const run = (cmd, cmdArgs, opts = {}) =>
  spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: repoRoot, ...opts });

// ── checked-in fixture short-circuit (web sessions / permanent pins) ──
const yamlFixtures = fs.existsSync(fixturesDir)
  ? fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.yaml'))
  : [];
// Prefer a filename match (the canonical layout names fixtures after the
// session); fall back to a content match, excluding derived fixtures that
// merely REFERENCE the session id in their metadata.
const checkedIn =
  yamlFixtures.find((f) => f.toLowerCase().includes(sessionId.toLowerCase().slice(0, 12))) ??
  yamlFixtures.find((f) => {
    try {
      const doc = fs.readFileSync(path.join(fixturesDir, f), 'utf8');
      return new RegExp(`session_id:\\s*'?${sessionId}'?\\s*$`, 'm').test(doc);
    } catch {
      return false;
    }
  });

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pwa-replay-${sessionId.slice(0, 8)}-`));
const sessionDir = path.join(workDir, 'session');

if (!checkedIn) {
  // ── fetch ──
  const fetchScript = path.join(
    repoRoot,
    '.claude/skills/certmate-diagnostics-and-tooling/scripts/fetch-session-analytics.sh'
  );
  const fetched = run('bash', [fetchScript, sessionId, sessionDir]);
  if (fetched.status !== 0) {
    console.error(`pwa-replay:session — fetch failed for ${sessionId}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(sessionDir, 'debug_log.jsonl'))) {
    console.error(
      `pwa-replay:session — web sessions have no debug_log.jsonl in S3; ` +
        `use a checked-in fixture (tests/fixtures/pwa-replay-sessions/) for ${sessionId}.`
    );
    process.exit(3);
  }
}

const name = checkedIn
  ? path.basename(checkedIn, '.yaml')
  : `ios-${sessionId.slice(0, 8).toLowerCase()}`;

if (!checkedIn) {
  // ── convert ──
  const convertArgs = [
    path.join(repoRoot, 'scripts/pwa-replay/convert-session.mjs'),
    `--dir=${sessionDir}`,
    `--name=${name}`,
    `--out-dir=${fixturesDir}`,
  ];
  const initialState = opt('initial-state');
  if (initialState) convertArgs.push(`--initial-state=${initialState}`);
  if (run('node', convertArgs).status !== 0) process.exit(1);
}

// ── replay (writes the web trace) ──
const traceDir = path.join(workDir, 'traces');
const env = {
  ...process.env,
  PWA_REPLAY_SCENARIO: name,
  PWA_REPLAY_TRACE_OUT: traceDir,
};
if (opt('mode') === 'live') env.PWA_REPLAY_MODE = 'live';
const replay = spawnSync('npx', ['vitest', 'run', 'tests/harness/pwa-replay-scenarios.test.ts'], {
  cwd: path.join(repoRoot, 'web'),
  env,
  stdio: 'inherit',
});
if (replay.status !== 0) {
  console.error('pwa-replay:session — replay failed (invariants / expect.web)');
  process.exit(replay.status ?? 1);
}

// ── diff (skipped for checked-in web fixtures — no iOS trace) ──
const iosTrace = path.join(fixturesDir, `${name}.ios-trace.json`);
const webTrace = path.join(traceDir, `${name}.trace.json`);
if (!fs.existsSync(iosTrace)) {
  console.log(
    `pwa-replay:session — no iOS trace for ${name} (web-session fixture); replay ran invariant-only. Done.`
  );
  process.exit(0);
}
const reportMd = path.join(workDir, `${name}.diff.md`);
const diff = run('node', [
  path.join(repoRoot, 'scripts/pwa-replay/diff-traces.mjs'),
  `--web=${webTrace}`,
  `--ios=${iosTrace}`,
  `--out=${reportMd}`,
  `--json=${path.join(workDir, `${name}.diff.json`)}`,
]);
console.log(`pwa-replay:session — report: ${reportMd}${opt('keep') ? '' : ' (temp dir)'}`);
process.exit(diff.status ?? 1);
