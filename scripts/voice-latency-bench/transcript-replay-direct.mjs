#!/usr/bin/env node
/**
 * transcript-replay-direct.mjs — THE THIN BOOTSTRAP (plan
 * replay-corpus-gate-2026-07 Item 2). The implementation lives in
 * transcript-replay-direct-runner.mjs; this file (a) parses and validates
 * `--model-lane` BEFORE any key lookup or extraction import, (b) runs the
 * task-def environment loader ONLY when a field-corpus lane is selected —
 * a legacy `--scenario`/`--scenario-dir` invocation without `--model-lane`
 * BYPASSES the loader entirely, its shell env reaching the modules exactly
 * as today (an unconditional loader would pin SNAPSHOT_FORMAT / delete
 * VOICE_* / set NODE_ENV on legacy voice-latency runs, violating the
 * byte-for-byte compatibility rule) — then (c) loads the runner via
 * dynamic import.
 *
 * ZERO extraction modules in this bootstrap's static import graph — ESM
 * static imports evaluate before ANY body code, and
 * stage6-shadow-harness.js latches SHADOW_MODEL from
 * process.env.SONNET_EXTRACT_MODEL at MODULE EVALUATION, so no code added
 * to a script body can run "before the imports". The env loader is the
 * only permissible first-position side effect.
 *
 * Lanes:
 *   (none)                    legacy voice-latency scenarios (unchanged)
 *   --model-lane=recorded     deterministic field-corpus lane (blocking)
 *   --model-lane=live         real-model field-corpus lane (advisory)
 */

const argv = process.argv.slice(2);
const laneArg = argv.find((a) => a === '--model-lane' || a.startsWith('--model-lane='));

// Test observability (subprocess regressions only): print the effective
// replay-relevant env AFTER lane dispatch decisions, then exit. Harmless
// for real invocations (nobody passes it); lets the compatibility test
// prove the loader was / was not applied without running a scenario.
const debugEnv = argv.includes('--frc-debug-env');
const printDebugEnv = () => {
  process.stdout.write(
    JSON.stringify({
      SONNET_EXTRACT_MODEL: process.env.SONNET_EXTRACT_MODEL ?? null,
      SNAPSHOT_FORMAT: process.env.SNAPSHOT_FORMAT ?? null,
      VOICE_LATENCY_LOADED_BARREL: process.env.VOICE_LATENCY_LOADED_BARREL ?? null,
      VOICE_ORPHAN_PROMPT: process.env.VOICE_ORPHAN_PROMPT ?? null,
      NODE_ENV: process.env.NODE_ENV ?? null,
      ANTHROPIC_API_KEY_PRESENT: process.env.ANTHROPIC_API_KEY != null,
      AWS_ACCESS_KEY_ID_PRESENT: process.env.AWS_ACCESS_KEY_ID != null,
    }) + '\n',
  );
};

if (laneArg == null) {
  // LEGACY invocation: no loader, no lane logic — behaviour byte-for-byte.
  if (debugEnv) {
    printDebugEnv();
    process.exit(0);
  }
  const { runLegacyCli } = await import('./transcript-replay-direct-runner.mjs');
  await runLegacyCli(argv);
} else {
  const lane = laneArg.includes('=') ? laneArg.split('=')[1] : null;
  if (lane !== 'recorded' && lane !== 'live') {
    console.error(`--model-lane must be "recorded" or "live" (got "${lane ?? ''}")`);
    process.exit(2);
  }
  // Field-corpus lane: pin the production environment BEFORE anything else.
  const { loadReplayEnvironment } = await import('../field-replay/replay-environment.mjs');
  const restore = loadReplayEnvironment({ lane });
  try {
    if (debugEnv) {
      printDebugEnv();
      process.exit(0);
    }
    const { runFieldCorpusCli } = await import('./transcript-replay-direct-runner.mjs');
    process.exitCode = await runFieldCorpusCli({ lane, argv });
  } finally {
    restore();
  }
}
