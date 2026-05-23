/**
 * Voice-latency feature flag config.
 *
 * Stage 1a commit 1a.2 per PLAN_v3 §4.2.
 *
 * Two classes of flag:
 *
 *   PER-SESSION SNAPSHOTTED — read at session_start, frozen for the
 *   session lifetime. A mid-session flag flip via task-def env
 *   reload only affects NEW sessions. Codex angle #16 guarantee:
 *   no flag drift inside a single inspector session.
 *
 *   LIVE OVERRIDE — read freshly on each gate check. The kill switch
 *   is the only one of these; it lets ops abort the whole streaming
 *   surface within ~50 ms (PLAN_v3 §9.2). Codex v2 I10.
 *
 * Public API:
 *   snapshotFlagsForSession() → frozen Object
 *   isKillSwitchActive() → boolean
 *
 * Env vars consumed:
 *   VOICE_LATENCY_STREAM_CONFIRMATIONS   default false
 *   VOICE_LATENCY_SUPPRESSION            default false
 *   VOICE_LATENCY_REGEX_FAST_TTS         default false
 *   VOICE_LATENCY_STREAM_ASK_USER        default false
 *   VOICE_LATENCY_USE_MULTI_CONTEXT      default false
 *   VOICE_LATENCY_KILL_SWITCH            default false (live override)
 */

const SNAPSHOTTED_FLAGS = Object.freeze([
  'VOICE_LATENCY_STREAM_CONFIRMATIONS',
  'VOICE_LATENCY_SUPPRESSION',
  'VOICE_LATENCY_REGEX_FAST_TTS',
  'VOICE_LATENCY_STREAM_ASK_USER',
  'VOICE_LATENCY_USE_MULTI_CONTEXT',
]);

function parseBool(s) {
  if (s == null) return false;
  const v = String(s).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Return an immutable per-session snapshot of every flag. Keys are
 * camelCase versions of the env-var names (drop the VOICE_LATENCY_
 * prefix, lowercase, snake→camel).
 *
 * Shape: `{streamConfirmations, suppression, regexFastTts, streamAskUser, useMultiContext}`
 */
export function snapshotFlagsForSession() {
  return Object.freeze({
    streamConfirmations: parseBool(process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS),
    suppression: parseBool(process.env.VOICE_LATENCY_SUPPRESSION),
    regexFastTts: parseBool(process.env.VOICE_LATENCY_REGEX_FAST_TTS),
    streamAskUser: parseBool(process.env.VOICE_LATENCY_STREAM_ASK_USER),
    useMultiContext: parseBool(process.env.VOICE_LATENCY_USE_MULTI_CONTEXT),
  });
}

/**
 * Kill switch is LIVE — read fresh every call. Used by:
 *   - /api/proxy/elevenlabs-tts streaming path to reject new TTS.
 *   - ElevenLabsStreamClient to abort in-flight syntheses.
 *   - WS handler to emit `voice_latency_kill_switch_active` to iOS so
 *     queued StreamingAudioPlayer buffers get dropped client-side.
 *
 * Setting `VOICE_LATENCY_KILL_SWITCH=true` in the task-def env and
 * triggering a deploy is the slow path (~5 min for ECS to roll the
 * new task). Faster: SSH into the running task and `export` it for
 * an interactive session — same effect, no deploy.
 */
export function isKillSwitchActive() {
  return parseBool(process.env.VOICE_LATENCY_KILL_SWITCH);
}

/**
 * Names of the snapshot flags, in declaration order. Exposed so the
 * startup-log emitter (1a.4) can iterate without duplicating the
 * list.
 */
export const SNAPSHOT_FLAG_ENV_NAMES = SNAPSHOTTED_FLAGS;
