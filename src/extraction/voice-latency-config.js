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
 *   VOICE_LATENCY_LOADED_BARREL          default false (Phase 1.E — v10)
 *   VOICE_LATENCY_KILL_SWITCH            default false (live override)
 *
 * Non-flag tunables (numbers, read fresh each call — not snapshotted
 * because they're operational tuning, not feature gates):
 *   VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN  default 2  (plan v10 §C
 *                                              speculator cap)
 */

const SNAPSHOTTED_FLAGS = Object.freeze([
  'VOICE_LATENCY_STREAM_CONFIRMATIONS',
  'VOICE_LATENCY_SUPPRESSION',
  'VOICE_LATENCY_REGEX_FAST_TTS',
  'VOICE_LATENCY_STREAM_ASK_USER',
  'VOICE_LATENCY_USE_MULTI_CONTEXT',
  'VOICE_LATENCY_LOADED_BARREL',
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
    loadedBarrel: parseBool(process.env.VOICE_LATENCY_LOADED_BARREL),
  });
}

/**
 * Loaded Barrel Phase 1.E per-turn speculation cap (plan v10 §C).
 * Live override (not snapshotted) so the cap can be tuned without
 * a deploy. Returns a positive integer; defaults to 2 if the env
 * var is unset, non-numeric, or non-positive (zero would disable
 * the speculator entirely without a flag flip, which would mask
 * config errors as feature regressions).
 */
export function getLoadedBarrelMaxPerTurn() {
  const raw = process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN;
  if (raw == null || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 2;
  return n;
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

/**
 * Stage 1a commit 1a.3 — capability handshake parser.
 *
 * iOS Stage 1b (commit 1b.3) ships `session_start` with a
 * `capabilities.voice_latency = { version, supports[] }` block. Older
 * iOS builds (anything pre-1b.3) omit it entirely.
 *
 * Returns a normalised block:
 *   {
 *     version: 0 | 1,
 *     supports: Set<string>,
 *     // Convenience predicates the emitters can branch on without
 *     // re-implementing Set lookups everywhere:
 *     hasStreamingHttpAudio: boolean,
 *     hasSourceFieldInTtsPost: boolean,
 *     hasVoiceLatencyAck: boolean,
 *     hasRegexFastTts: boolean,
 *     hasKillSwitchDropQueue: boolean,
 *     // Original raw value preserved for the startup log.
 *     raw: any,
 *   }
 *
 * Defensive defaults:
 *   - missing / null / non-object capabilities → version 0, supports []
 *   - capabilities.voice_latency missing → version 0, supports []
 *   - version not 1 → supports forced to []
 *   - supports not an array → []
 *   - non-string entries inside supports → dropped (warn)
 *
 * Codex v2 I4 — pin every defensive default in the test surface.
 */
const KNOWN_SUPPORTS = Object.freeze([
  'streaming_http_audio',
  'source_field_in_tts_post',
  'regex_fast_tts',
  'voice_latency_ack',
  'kill_switch_drop_queue',
]);

export function parseVoiceLatencyCapabilities(capabilitiesObj) {
  const raw = capabilitiesObj ?? null;
  const empty = () => ({
    version: 0,
    supports: new Set(),
    hasStreamingHttpAudio: false,
    hasSourceFieldInTtsPost: false,
    hasVoiceLatencyAck: false,
    hasRegexFastTts: false,
    hasKillSwitchDropQueue: false,
    raw,
  });

  if (!raw || typeof raw !== 'object') return empty();
  const vl = raw.voice_latency;
  if (!vl || typeof vl !== 'object') return empty();

  const version = Number.isInteger(vl.version) ? vl.version : 0;
  if (version !== 1) return { ...empty(), version };

  const rawSupports = Array.isArray(vl.supports) ? vl.supports : [];
  const supports = new Set(rawSupports.filter((s) => typeof s === 'string'));

  return {
    version,
    supports,
    hasStreamingHttpAudio: supports.has('streaming_http_audio'),
    hasSourceFieldInTtsPost: supports.has('source_field_in_tts_post'),
    hasVoiceLatencyAck: supports.has('voice_latency_ack'),
    hasRegexFastTts: supports.has('regex_fast_tts'),
    hasKillSwitchDropQueue: supports.has('kill_switch_drop_queue'),
    raw,
  };
}

/** Known supports list for documentation / log enumeration. */
export const VOICE_LATENCY_KNOWN_SUPPORTS = KNOWN_SUPPORTS;
