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
 * P3 Fix 8 (2026-07-23) — SERVER kill-switch for LIM acceptance on the ranged
 * reading fields. Read fresh every call. When `LIM_RANGED_WRITE_DISABLED=true`
 * the backend DENIES a LIM write on a capability-gated field EVEN FOR a client
 * that advertises `lim_ranged_write_v1`. This is the real rollback boundary:
 * an already-deployed iOS build's advert cannot be remotely revoked, so
 * reverting the client advert is NOT sufficient — flipping this env on the live
 * task def (source: ecs/task-def-backend.json) forces deny for every client.
 * The effective condition is: accept LIM iff (client advertises the capability)
 * AND NOT (this switch is on).
 *
 * @returns {boolean}
 */
export function isLimRangedWriteKilled() {
  return parseBool(process.env.LIM_RANGED_WRITE_DISABLED);
}

/**
 * Plan A1a (2026-07-27, feedback id 101) — SERVER kill-switch for the
 * `clear_board_reading` tool. Read fresh every call. When
 * `BOARD_CLEAR_DISABLED=true` the backend DENIES a board/supply-scope clear
 * EVEN FOR a client that advertises `board_clear_v1`. Same rationale as
 * `isLimRangedWriteKilled`: an already-deployed client's advert cannot be
 * remotely revoked, so this env (source: ecs/task-def-backend.json) is the
 * real rollback lever. The effective condition in the dispatcher is:
 * `denyBoardClear = isBoardClearKilled() || ctx.hasBoardClearV1 !== true`.
 *
 * @returns {boolean}
 */
export function isBoardClearKilled() {
  return parseBool(process.env.BOARD_CLEAR_DISABLED);
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
  // Single-round latency sprint, Phase 1 (PLAN_v8). iOS advertises
  // `regex_fast_v2` to confirm it implements the Mode-A fast-TTS
  // contract: client-minted correlationId in the POST body,
  // `playFastPathAudio` bypasses `shouldDeferPlayback`, NO native-TTS
  // fallback on 4xx/5xx/timeout, posts `/playback-ack` after
  // AVAudioPlayer.play() succeeds. Strictly additive to the existing
  // `regex_fast_tts` capability; the v2 marker is the eligibility gate
  // for the route handler.
  'regex_fast_v2',
  // Single-round latency sprint, Phase 0. iOS sends `/playback-ack`
  // POSTs that drive the `turn_audio_summary` finalizer. Distinct from
  // `voice_latency_ack` (which referred to the legacy server-side
  // streaming ACK).
  'client_playback_telemetry',
  // readback-correction-optionb §6 (2026-06-18). iOS advertises
  // `low_conf_readback_v1` once its client has DROPPED the local
  // `reading.confidence < 0.5` filter (Phase B). It is a ROLLOUT-
  // SEQUENCING gate, NOT a behavioural confidence threshold: until the
  // client advertises it, the backend dispatcher SKIPS applying a
  // `< 0.5` reading (pre-apply, no wire) so an old client never hears a
  // value read back that it would then drop from the grid (false
  // confirmation + silent loss). Once advertised, the backend applies +
  // reads back at any confidence. NOTE: unknown support strings already
  // survive in the `supports` Set; the load-bearing change is the
  // `hasLowConfReadbackV1` ACCESSOR below (on BOTH the populated result
  // AND the empty()/v0 shape).
  'low_conf_readback_v1',
  // P3 (2026-07-23, feedback id 86). A client advertises `lim_ranged_write_v1`
  // once it carries the sentinel-safe guards (Fix 5 derivation guard, Fix 6
  // OCPD→max-Zs invalidation, Fix 9 result-status). It is a ROLLOUT-SEQUENCING
  // gate: until advertised, the backend DENIES accepting "LIM" on a RANGED
  // reading field (via record_reading / bulk / dialogue writes / speculation),
  // so a pre-guard client never silently overwrites a LIM via recomputeAll or
  // renders a false-green circuit result. Web advertises it in the same wave
  // (deploys instantly); iOS on its own TestFlight build.
  'lim_ranged_write_v1',
  // Plan A1a (2026-07-27, feedback id 101). A client advertises
  // `board_clear_v1` once it can APPLY a board/supply-scope
  // `field_corrected` frame (circuit: null + non-null board_id) — the
  // A1b client sweep. It is a ROLLOUT-SEQUENCING gate: until advertised,
  // the backend dispatcher DENIES `clear_board_reading` (soft skip +
  // spoken capability notice, NO mutation, NO frame), so a client that
  // cannot route a board-scope clear never hears "cleared" while the
  // value survives on screen (the F5 spoken-but-not-written class).
  // The tool itself is ALWAYS advertised to the model — the gate lives
  // at the DISPATCHER, never in buildSessionTools (§3.1: the prompt
  // latches before capabilities are parsed, so a capability-conditional
  // toolset would split prompt and toolset).
  'board_clear_v1',
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
    hasRegexFastV2: false,
    hasClientPlaybackTelemetry: false,
    // readback-correction-optionb §6 — MUST be present on the empty()/v0
    // shape too, else an old/absent-capabilities client reads as
    // `undefined` (falsy) which is the SAFE default (skip < 0.5 apply),
    // but accessing it must not throw / drift from the populated shape.
    hasLowConfReadbackV1: false,
    // P3 (2026-07-23) — lim_ranged_write_v1: the client carries the Fix 5/6/9
    // sentinel-safe derivation + status guards, so the backend may ACCEPT a LIM
    // on a ranged reading field. Absent/false is the SAFE default (backend
    // denies LIM acceptance) so a pre-guard client never silently overwrites a
    // LIM via recomputeAll or shows a false-green status.
    hasLimRangedWriteV1: false,
    // Plan A1a — board_clear_v1: absent/false is the SAFE default (the
    // dispatcher denies every board/supply clear), so an un-upgraded,
    // silent or malformed capabilities block can never let a client that
    // cannot apply a board-scope clear receive one.
    hasBoardClearV1: false,
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
    hasRegexFastV2: supports.has('regex_fast_v2'),
    hasClientPlaybackTelemetry: supports.has('client_playback_telemetry'),
    hasLowConfReadbackV1: supports.has('low_conf_readback_v1'),
    hasLimRangedWriteV1: supports.has('lim_ranged_write_v1'),
    hasBoardClearV1: supports.has('board_clear_v1'),
    raw,
  };
}

/** Known supports list for documentation / log enumeration. */
export const VOICE_LATENCY_KNOWN_SUPPORTS = KNOWN_SUPPORTS;

/**
 * A1b (2026-07-29) — pure diff of two parsed capability shapes, for the
 * `stage6.capability_changed_on_reparse` TRIPWIRE at the reconnect re-parse
 * site (sonnet-stream.js). Under the current wire a mid-session capability
 * change is STRUCTURALLY IMPOSSIBLE (web `session_resume` never re-parses;
 * an iOS build always re-advertises its own static set on the same
 * sessionId), so this diff is expected to return [] for every production
 * re-parse — a non-empty result in CloudWatch means that impossibility
 * argument has been broken by some future path and the live-read fence is
 * load-bearing.
 *
 * Compares `version` plus every boolean `has*` flag (union of both shapes,
 * so a flag added on one side only still diffs). Deliberately IGNORES `raw`
 * and the `supports` Set (the has* flags are the consumed projection; raw
 * echoes client bytes and would leak into logs). PII-safe by construction:
 * flag names + booleans/numbers only.
 *
 * @returns {Array<{flag: string, from: boolean|number, to: boolean|number}>}
 */
export function diffVoiceLatencyCapabilities(prev, next) {
  const changed = [];
  const p = prev ?? {};
  const n = next ?? {};
  if ((p.version ?? 0) !== (n.version ?? 0)) {
    changed.push({ flag: 'version', from: p.version ?? 0, to: n.version ?? 0 });
  }
  const flagKeys = new Set(
    [...Object.keys(p), ...Object.keys(n)].filter((k) => k.startsWith('has'))
  );
  for (const key of [...flagKeys].sort()) {
    const from = p[key] === true;
    const to = n[key] === true;
    if (from !== to) changed.push({ flag: key, from, to });
  }
  return changed;
}
