/**
 * replay-environment.mjs — the shared task-def environment loader (plan
 * Item 2 "Environment parity"). Config divergence is prompt divergence:
 * `ecs/task-def-backend.json` sets SNAPSHOT_FORMAT=split_blocks while
 * EICRExtractionSession DEFAULTS to single_block — an unpinned lane sends a
 * materially different system prompt.
 *
 * MUST run BEFORE any extraction import: `stage6-shadow-harness.js` latches
 * SHADOW_MODEL from process.env.SONNET_EXTRACT_MODEL at MODULE EVALUATION,
 * so no code added to an existing script body can run "before the imports".
 * The CLI bootstrap calls loadReplayEnvironment() and only THEN dynamically
 * imports the runner (which itself dynamically imports extraction modules).
 *
 * Classification (the VERSIONED inventory below): every process.env read
 * reachable from the replay path is either
 *   - PIN     — present in the task-def → set to the task-def value;
 *   - DELETE  — behaviour flag ABSENT from the task-def → deleted so module
 *               defaults apply (a stale developer-shell VOICE_ORPHAN_PROMPT
 *               would silently diverge replay from production defaults);
 *   - OVERRIDE — the SOLE deliberate override: Loaded Barrel OFF (v1
 *               fidelity exclusion; production runs it);
 *   - SECRET  — credentials, cleared in the recorded lane (the AWS-deny
 *               module owns the full credential matrix);
 *   - EXCLUDED — reachable by a naive directory scan but not by the replay
 *               import closure (CCU photo pipeline, logger file transport,
 *               storage) — left untouched, with rationale.
 * The CI guard (replay-environment.test.js) scans the replay import closure
 * for process.env reads and FAILS when a referenced variable is absent from
 * this classification.
 */

import fs from 'node:fs';
import path from 'node:path';

export const REPLAY_ENV_INVENTORY_VERSION = 1;

/** Vars PINNED from ecs/task-def-backend.json (value read live from the
 *  task-def at load time so the drift test enforces itself). */
export const PINNED_FROM_TASK_DEF = Object.freeze([
  'NODE_ENV',
  'SONNET_TOOL_CALLS',
  'SONNET_EXTRACT_MODEL',
  'OBSERVATION_EXTRACT_MODEL',
  'SNAPSHOT_FORMAT',
  'CIRCUIT_ORDER',
  'VOICE_LATENCY_STREAM_CONFIRMATIONS',
  'VOICE_LATENCY_SUPPRESSION',
  'VOICE_LATENCY_REGEX_FAST_TTS',
  'VOICE_LATENCY_STREAM_ASK_USER',
  'VOICE_LATENCY_USE_MULTI_CONTEXT',
  'VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN',
  'VOICE_LATENCY_ROUND1_MODEL', // explicitly EMPTY in the task-def
  'VOICE_LATENCY_KILL_SWITCH',
  // A1 agentic-voice (2026-07-23) — the answer-feature master flag. Pinned
  // from the task-def so the recorded lane replays at the production value
  // ('false' until the PR-2 flip): every recorded fixture predates A1 and
  // must replay byte-identical under the flag-off render. Post-flip, pre-flip
  // fixtures stay valid only if re-verified — the pin makes the lane track
  // whatever production actually runs, per the drift-enforcement contract.
  'VOICE_AGENTIC_ANSWERS',
]);

/** Behaviour flags ABSENT from the task-def → DELETED so code defaults
 *  apply (each of these has a module default that production runs on). */
export const DELETED_SO_DEFAULTS_APPLY = Object.freeze([
  'VOICE_ORPHAN_PROMPT',
  'IR_ORPHAN_APPLY_COMPLETE',
  'VOICE_MID_STREAM_FILTER',
  'VOICE_REGEX_PRE_APPLY',
  'VOICE_PRE_LLM_GATE',
  'SONNET_CACHE_TTL',
  'SONNET_SESSION_TTL_MS',
  'SONNET_SESSION_MAX_ENTRIES',
]);

/** The SOLE deliberate override: Loaded Barrel OFF in BOTH lanes (v1
 *  fidelity exclusion, documented like ingress). */
export const DELIBERATE_OVERRIDES = Object.freeze({
  VOICE_LATENCY_LOADED_BARREL: 'false',
});

/** Credentials — cleared in the recorded lane (the live lane supplies
 *  ANTHROPIC_API_KEY explicitly; the AWS deny module owns AWS_*). */
export const SECRETS = Object.freeze(['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY']);

/** Reachable by a naive src/extraction directory scan but NOT by the
 *  replay import closure — classified so the inventory guard is complete. */
export const EXCLUDED_NOT_IN_REPLAY_CLOSURE = Object.freeze({
  // CCU photo pipeline (POST /api/analyze-ccu) — separate route, never
  // imported by sonnet-stream/shadow-harness/extraction-session.
  ccu: [
    'CCU_MODEL', 'CCU_GEOMETRIC_MODEL', 'CCU_GEOMETRIC_TIMEOUT_MS', 'CCU_REWIREABLE_MODEL',
    'CCU_LABEL_MODEL', 'CCU_LABEL_TIMEOUT_MS', 'CCU_LABEL_CONFIDENCE_MIN',
    'CCU_LABEL_MATCHER_ALGORITHM', 'CCU_LABEL_MATCHER_MAX_MATCH_FACTOR',
    'CCU_LABEL_MATCHER_LABEL_SKIP_FACTOR', 'CCU_LABEL_MATCHER_DEVICE_SKIP_FACTOR',
    'CCU_SLIDING_WINDOW_TIMEOUT_MS', 'CCU_SINGLE_SHOT_TIMEOUT_MS', 'CCU_SINGLE_SHOT_MAX_TOKENS',
    'CCU_DEWARP_ENABLED', 'CCU_DEWARP_OUTPUT_WIDTH', 'CCU_DEWARP_MAX_WIDTH',
    'CCU_PROBE_V2', 'CCU_CV_PITCH', 'CCU_VLM_POSITION_MATCHER', 'CCU_USE_SINGLE_SHOT',
    'CCU_STAGE2_GROUPS', 'CCU_SLIDING_WINDOW', 'CCU_SLIDING_WINDOW_MODEL',
  ],
  // Logger transports + infra — behaviour-neutral for extraction output.
  infra: ['LOG_FILE', 'LOG_LEVEL', 'S3_BUCKET', 'STAGE0_BENCH', 'PORT', 'REDIS_URL',
    'DATABASE_TYPE', 'STORAGE_TYPE', 'USE_AWS_SECRETS', 'AWS_REGION'],
});

/** Read the task-def env table (single container definition). */
export function readTaskDefEnvironment(repoRoot = process.cwd()) {
  const td = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'ecs', 'task-def-backend.json'), 'utf8'),
  );
  const container = (td.containerDefinitions ?? [td])[0];
  const env = {};
  for (const e of container.environment ?? []) env[e.name] = e.value;
  return env;
}

/**
 * Apply the production environment snapshot. Returns a restore function —
 * call it in the OUTERMOST finally after the corpus finishes (env pinning
 * is CLI-INVOCATION state, NOT per-scenario: module-level constants latch
 * the pinned values at import, so a per-scenario restore would leave cached
 * module values production-pinned while runtime process.env reads revert to
 * the developer shell — fixture 2 onward would run a MIXED configuration).
 *
 * `lane`: 'recorded' clears SECRETS; 'live' leaves ANTHROPIC_API_KEY alone
 * (the explicit-key-only loader validates it separately).
 */
export function loadReplayEnvironment({ repoRoot = process.cwd(), lane = 'recorded' } = {}) {
  const taskDef = readTaskDefEnvironment(repoRoot);
  const touched = new Set([
    ...PINNED_FROM_TASK_DEF,
    ...DELETED_SO_DEFAULTS_APPLY,
    ...Object.keys(DELIBERATE_OVERRIDES),
    ...(lane === 'recorded' ? SECRETS : []),
  ]);
  const snapshot = {};
  for (const k of touched) snapshot[k] = process.env[k];

  for (const k of PINNED_FROM_TASK_DEF) {
    if (!(k in taskDef)) {
      throw new Error(
        `replay-environment: ${k} is classified PIN but absent from ecs/task-def-backend.json — update the classification (drift)`,
      );
    }
    process.env[k] = taskDef[k];
  }
  for (const k of DELETED_SO_DEFAULTS_APPLY) delete process.env[k];
  for (const [k, v] of Object.entries(DELIBERATE_OVERRIDES)) process.env[k] = v;
  if (lane === 'recorded') {
    for (const k of SECRETS) delete process.env[k];
  }

  return function restoreHostEnvironment() {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Every variable the classification covers (for the closure-scan guard). */
export function classifiedVariables() {
  return new Set([
    ...PINNED_FROM_TASK_DEF,
    ...DELETED_SO_DEFAULTS_APPLY,
    ...Object.keys(DELIBERATE_OVERRIDES),
    ...SECRETS,
    ...EXCLUDED_NOT_IN_REPLAY_CLOSURE.ccu,
    ...EXCLUDED_NOT_IN_REPLAY_CLOSURE.infra,
  ]);
}
