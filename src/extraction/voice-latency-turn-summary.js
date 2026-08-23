/**
 * Voice-latency turn summary — split-row emitter with delayed finalizer.
 *
 * Single-round latency sprint, Phase 0 (PLAN_v8, Pivots 8 + 8.1 + 8.2 + 8.3 + 8.4).
 *
 * Per turn the backend emits TWO immutable CloudWatch rows:
 *
 *   1. `voice_latency.turn_core_summary`  — Sonnet + dispatch facts. Emitted
 *      synchronously at end of `runLiveMode` after the bundler returns the
 *      result. Carries protocol facts (rounds, stop reasons, predicate result,
 *      timings), dispatch facts (tool counts, error counts), and the
 *      server-side audible-first-byte timestamp.
 *
 *   2. `voice_latency.turn_audio_summary` — cache + iOS playback facts. Emitted
 *      by a delayed finalizer when (a) all expected playback ACKs have arrived
 *      OR (b) an 8s timeout fires. Carries `ios_playback_ack[]` array,
 *      `audio_finalizer_timeout_fired`, and the playback-correlation glue
 *      that connects the core row to which audio actually played.
 *
 * The two rows share `{sessionId, turnId}` keys; CloudWatch Insights
 * dashboards join via conditional aggregation over these scalar keys (NOT
 * SQL join — Logs Insights has no join).
 *
 * A SEPARATE late-ACK row (`voice_latency.late_playback_ack`) is emitted if
 * a playback ACK POST arrives AFTER the finalizer has already fired (i.e. the
 * row is immutable + already emitted). Dashboards correlate late-ACKs to the
 * earlier `turn_audio_summary` post-hoc.
 *
 * Rejected fast-TTS POSTs decrement the expected-ACK count via
 * `decrementExpectedAcksByCorrelation` (keyed by the client-minted
 * regex_fast_correlation_id, since the fast-TTS endpoint cannot know the
 * server-side turnId — minted later inside runLiveMode).
 *
 * All emissions go through `logger.info` with the FIRST argument as the
 * event-name string (which the project's logger serializes as the JSON
 * `message` field; CloudWatch Insights filters with `filter message = "..."`).
 * SERVER_OUTCOMES in `voice-latency-telemetry.js` is INTENTIONALLY left
 * unchanged — these are freestanding observability events, NOT outcome
 * waterfall states. See PLAN_v8 Pivot 11.10.
 */

import logger from '../logger.js';
import { getActiveSessionEntry } from './active-sessions.js';
// Voice-latency plan 2026-06-05 Phase 2.3 — pair `voice_latency.turn_audio_summary`
// with `voice_latency.utterance_end` into a single
// `voice_latency.turn_perceived_latency_ms` row. Hooks called AFTER the
// canonical logger.info emits below so a store throw cannot suppress
// the existing CloudWatch rows. NO import back from this module —
// `voice-latency-perceived-latency.js` is leaf-only by design (avoids
// ESM circular dep). All field derivation (earliestAck pick, source
// flattening) happens here in this module; the hooks receive already-
// derived fields.
import {
  recordTurnAudioSummary,
  recordLatePlaybackAck,
} from './voice-latency-perceived-latency.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PendingFinalizer
 * @property {string} sessionId
 * @property {string} turnId
 * @property {number} expected_acks   — count of ACKs we wait for
 * @property {Array<Object>} received_acks  — accumulated ACKs
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {bigint} armed_ns   — wall-time finalizer was armed
 * @property {Map<string, AckObligation>|null} obligations — PLAN-D 2026-08-23
 *   (id 127, D4): identity-matched audibility obligations. Present ONLY when
 *   the caller supplied structured descriptors; null keeps the legacy
 *   count-arithmetic path byte-identical for older call sites/tests.
 * @property {'observable'|'unobservable'|'unknown'} observability
 */

/**
 * PLAN-D 2026-08-23 (feedback id 127, D4 — telemetry-only). One audibility
 * obligation per thing the inspector should HEAR exactly once this turn.
 *
 * Built PER CORRELATION ID for fast attempts (never from the slot-keyed
 * `resolveFastAttemptSlotIdentities` map, which silently overwrites earlier
 * same-slot correlations — deriving obligations from it would omit some and
 * falsely complete), plus one per ACK-eligible bundler confirmation. A
 * canonical confirmation carrying `fast_correlation_id` COLLAPSES into its
 * matching fast attempt (they are one heard clip — counting both makes every
 * healthy fast-path turn look unacked); the collapsed twin retains BOTH slot
 * aliases, because iOS bundler ACKs carry `ValueConfirmation.boardId` (nil on
 * ordinary selected-board traffic → the wire alias) while the fast-attempt
 * ledger stores the resolved EFFECTIVE board (→ the effective alias) — a
 * strict single-slot join would falsely report a healthy fast-failure
 * fallback as unacked.
 *
 * Reconciliation: correlation id first, slot second — and a slot match is
 * only claimed when it is UNIQUE among pending obligations. When >1 pending
 * obligation shares a normalised slot (designationOps can emit same-slot
 * entries distinguished only by dedupe_token, which iOS ACKs do not carry),
 * ALL of that slot's obligations are classified AMBIGUOUS — a distinct class
 * from unacked; never exact completion, never exact loss.
 *
 * @typedef {Object} AckObligation
 * @property {'fast'|'canonical'|'twin'} kind
 * @property {string|null} correlationId
 * @property {Set<string>} slotAliases — normalised `${field}::${circuit ?? 0}::${board ?? ''}` keys
 * @property {{field: string|null, circuit: number, board: string|null}} slot — display identity
 * @property {boolean} acked
 * @property {boolean} slotAmbiguous
 */

/** Normalised obligation slot key. Circuit normalises `?? 0` (backend
 *  board-level obligations use null; iOS ACKs serialize 0 — both sides fold
 *  independently of the board alias). Board `?? ''` is the Plan-00 stable
 *  null-board sentinel: null matches null, never a different board. */
function obligationSlotKey(field, circuit, boardId) {
  const circ = Number.isInteger(circuit) ? circuit : 0;
  const board = typeof boardId === 'string' && boardId.length > 0 ? boardId : '';
  return `${field}::${circ}::${board}`;
}

/**
 * Build the obligation map from the caller-supplied descriptors. `rejectedIds`
 * (fast-TTS rejections consumed at arm time) remove their exact fast
 * obligations BEFORE twin collapse, so a rejected attempt's canonical sibling
 * — if any — stays a standalone canonical obligation.
 */
function buildAckObligations(fastAttempts, ackEligibleConfirmations, rejectedIds) {
  /** @type {Map<string, AckObligation>} */
  const obligations = new Map();
  if (Array.isArray(fastAttempts)) {
    for (const fa of fastAttempts) {
      if (typeof fa?.correlationId !== 'string' || !fa.correlationId) continue;
      if (rejectedIds?.has(fa.correlationId)) continue; // rejected before arm — no clip to hear
      obligations.set(`fast:${fa.correlationId}`, {
        kind: 'fast',
        correlationId: fa.correlationId,
        slotAliases: new Set(fa.field ? [obligationSlotKey(fa.field, fa.circuit, fa.boardId)] : []),
        slot: {
          field: fa.field ?? null,
          circuit: Number.isInteger(fa.circuit) ? fa.circuit : 0,
          board: fa.boardId ?? null,
        },
        acked: false,
        slotAmbiguous: false,
      });
    }
  }
  let canonOrdinal = 0;
  if (Array.isArray(ackEligibleConfirmations)) {
    for (const c of ackEligibleConfirmations) {
      const wireKey = c.field ? obligationSlotKey(c.field, c.circuit, c.wireBoardId) : null;
      const effKey = c.field ? obligationSlotKey(c.field, c.circuit, c.effectiveBoardId) : null;
      const twin =
        typeof c.fastCorrelationId === 'string' && c.fastCorrelationId
          ? obligations.get(`fast:${c.fastCorrelationId}`)
          : null;
      if (twin) {
        twin.kind = 'twin';
        if (wireKey) twin.slotAliases.add(wireKey);
        if (effKey) twin.slotAliases.add(effKey);
        continue;
      }
      const ob = {
        kind: 'canonical',
        correlationId: null,
        slotAliases: new Set([wireKey, effKey].filter(Boolean)),
        slot: {
          field: c.field ?? null,
          circuit: Number.isInteger(c.circuit) ? c.circuit : 0,
          board: c.effectiveBoardId ?? c.wireBoardId ?? null,
        },
        acked: false,
        slotAmbiguous: false,
      };
      obligations.set(`canon:${canonOrdinal++}`, ob);
    }
  }
  // Same-slot multiplicity → AMBIGUOUS for slot-based matching (correlation
  // matches remain exact regardless).
  const aliasOwners = new Map();
  for (const [id, ob] of obligations) {
    for (const alias of ob.slotAliases) {
      if (!aliasOwners.has(alias)) aliasOwners.set(alias, []);
      aliasOwners.get(alias).push(id);
    }
  }
  for (const owners of aliasOwners.values()) {
    if (owners.length > 1) {
      for (const id of owners) obligations.get(id).slotAmbiguous = true;
    }
  }
  return obligations;
}

/**
 * Match one ACK against the pending obligations. Correlation first; slot
 * second, and only on a UNIQUE pending candidate (an ambiguous slot never
 * claims exact attribution).
 */
function matchAckToObligations(obligations, ack) {
  if (!(obligations instanceof Map) || obligations.size === 0) return;
  if (typeof ack?.correlation_id === 'string' && ack.correlation_id) {
    for (const ob of obligations.values()) {
      if (!ob.acked && ob.correlationId === ack.correlation_id) {
        ob.acked = true;
        return;
      }
    }
  }
  const slot = ack?.slot;
  if (slot && typeof slot.field === 'string' && slot.field) {
    const key = obligationSlotKey(slot.field, slot.circuit, slot.boardId);
    const candidates = [];
    for (const ob of obligations.values()) {
      if (!ob.acked && ob.slotAliases.has(key)) candidates.push(ob);
    }
    if (candidates.length === 1) candidates[0].acked = true;
    // >1 candidates → same-slot multiplicity: no exact attribution.
  }
}

/** Every obligation either acked, or slot-ambiguous obligations block exact
 *  completion (never claim it) — completion is identity-matched, never count
 *  arithmetic. */
function obligationsComplete(obligations) {
  for (const ob of obligations.values()) {
    if (!ob.acked) return false;
  }
  return true;
}

/** Project the obligation ledger onto row fields for the audio-summary emit.
 *  UNOBSERVABLE sessions never report unacked slots — the absence of ACKs is
 *  the expected state, not evidence of silence (the same false inference that
 *  killed the audible orphan net). */
function summariseObligations(obligations, observability) {
  if (!(obligations instanceof Map)) return null;
  const unacked = [];
  const ambiguous = [];
  let acked = 0;
  for (const ob of obligations.values()) {
    if (ob.acked) {
      acked += 1;
      continue;
    }
    const identity = {
      kind: ob.kind,
      field: ob.slot.field,
      circuit: ob.slot.circuit,
      board_id: ob.slot.board,
      correlation_id: ob.correlationId,
    };
    if (ob.slotAmbiguous) ambiguous.push(identity);
    else unacked.push(identity);
  }
  return {
    ack_obligations_total: obligations.size,
    ack_obligations_acked: acked,
    unacked_confirmations: observability === 'observable' ? unacked : [],
    ambiguous_confirmations: observability === 'observable' ? ambiguous : [],
    unobservable_obligations: observability === 'observable' ? 0 : obligations.size - acked,
  };
}

/** @type {Map<string, PendingFinalizer>} key = `${sessionId}::${turnId}` */
const pendingFinalizers = new Map();

/**
 * Late-arrival decrement stash keyed by `regex_fast_correlation_id`.
 *
 * Fast-TTS endpoint rejection (409/422/etc.) calls
 * `decrementExpectedAcksByCorrelation(sessionId, correlationId)` BEFORE
 * the server-side `runLiveMode` has armed a finalizer for the matching
 * turn. The stash holds the decrement until `startAudioFinalizer` is
 * called for that turn — which then drains matching entries.
 *
 * 60s lazy expiry guards against orphans (socket drop, transcript never
 * arriving). Entries older than 60s are silently dropped on next read.
 *
 * @type {Map<string, {sessionId: string, expires_at_ms: number}>}
 */
const pendingAckDecrements = new Map();

/**
 * Voice-latency plan 2026-06-03 Tier 1.3 — durable correlation index.
 *
 * Populated when runLiveMode arms the finalizer for a turn that has a
 * non-empty `entry.fastPathCorrelationIdByTurn.get(turnId)` Set. The
 * per-turn `fastPathCorrelationIdByTurn` Map is DELETED at end of
 * runLiveMode (stage6-shadow-harness.js:1223), so any fast-path ACK
 * arriving after that point cannot resolve via the session entry —
 * this module-scope index outlives the per-turn cleanup with a 60s TTL.
 *
 * @type {Map<string, {sessionId: string, turnId: string, expires_at_ms: number}>}
 */
const correlationToTurn = new Map();

/**
 * Voice-latency plan 2026-06-03 Tier 1.3 — pre-finalizer fast-path ACK
 * stash. `recordPlaybackAck` puts a fast_tts ACK here when neither
 * `pendingFinalizers["${sessionId}::${turnId}"]` nor
 * `correlationToTurn.get(correlation_id)` resolves (race window: ACK
 * arrived before runLiveMode armed the finalizer). `startAudioFinalizer`
 * drains it at arm time.
 *
 * @type {Map<string, {ack: Object, sessionId: string, expires_at_ms: number}>}
 */
const pendingFastPathAcksByCorrelation = new Map();

/** Finalizer timeout in ms (PLAN_v8 §A Pivot 8). 8s = conservative buffer
 *  for iOS audio decode + AVAudioPlayer start + ACK POST round-trip. */
const FINALIZER_TIMEOUT_MS = 8000;

/** Stash expiry for pre-finalizer decrements. */
const ACK_DECREMENT_TTL_MS = 60_000;

/** Tier 1.3 durable correlation→turn index TTL — longer than the 8s
 *  finalizer timeout so late fast-path ACKs still resolve. */
const CORRELATION_TURN_TTL_MS = 60_000;

/** Tier 1.3 pre-finalizer fast-path ACK stash TTL. */
const FAST_PATH_ACK_STASH_TTL_MS = 30_000;

/** Tier 1.3 lazy-sweep threshold — sweep expired entries when a Map gets
 *  this big. Avoids per-set scan in the steady state. */
const LAZY_SWEEP_THRESHOLD = 10_000;

/**
 * Lazy expiry sweep for the durable correlation index + the fast-path
 * ACK stash. Called from set sites when the Map grows past
 * LAZY_SWEEP_THRESHOLD. Plain code (no agent / no async) — sweep on a
 * single pass.
 */
function lazyExpirySweep(map) {
  if (map.size < LAZY_SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [key, value] of map) {
    if (value.expires_at_ms < now) map.delete(key);
  }
}

/**
 * Voice-latency plan 2026-06-03 Tier 1.3 — pick the earliest-by-monotonic
 * ACK from the received_acks array, scoped to the process_uptime_id
 * group with the most ACKs (handles the force-kill edge case where the
 * newer process wins).
 *
 * The earliest ACK by iOS monotonic wins, NOT the first ACK to arrive
 * at the server — network jitter / fast-path vs bundler timing can
 * reorder server-side arrival relative to iOS-side actual playback.
 * Perceived latency is "first audible playback", so we want the iOS-
 * minimum monotonic stamp.
 *
 * Returns null if no ACK has a valid monotonic_at_ms.
 */
export function pickEarliestPlaybackAck(acks) {
  if (!Array.isArray(acks) || acks.length === 0) return null;
  /** @type {Map<string, Array<Object>>} */
  const byProc = new Map();
  for (const a of acks) {
    if (!a || typeof a.monotonic_at_ms !== 'number' || !(a.monotonic_at_ms > 0)) continue;
    const pid = a.process_uptime_id ?? 'unknown';
    if (!byProc.has(pid)) byProc.set(pid, []);
    byProc.get(pid).push(a);
  }
  if (byProc.size === 0) return null;
  // Pick the process_uptime_id with the most ACKs. Edge case: app
  // force-killed mid-turn — the newer process wins by count.
  let bestGroup = null;
  for (const group of byProc.values()) {
    if (!bestGroup || group.length > bestGroup.length) bestGroup = group;
  }
  return bestGroup.reduce((a, b) => (a.monotonic_at_ms <= b.monotonic_at_ms ? a : b));
}

// ---------------------------------------------------------------------------
// Phase 0 emission functions
// ---------------------------------------------------------------------------

/**
 * Emit the `voice_latency.turn_core_summary` row at end of runLiveMode.
 *
 * Called synchronously after the bundler returns. The companion
 * `turn_audio_summary` is emitted later by the finalizer (or its timeout)
 * and shares `{sessionId, turnId}` for downstream dashboard correlation.
 *
 * @param {Object} fields  All facets that are knowable at end-of-runLiveMode:
 *   sessionId, turnId, correlation_id_pre_synth, correlation_id_fast_path,
 *   rounds, stop_reasons (array), actual_stop_reasons (array),
 *   terminal_reason ('end_turn' | 'tool_use_cap_hit' | 'aborted'),
 *   tool_call_count_per_round (array),
 *   tool_error_count_per_round (array), tool_names_per_round (array of
 *   arrays),
 *   round_usage (per-round input/output/cache tokens + explicit-breakpoint evidence),
 *   turn_cost_usd, no_cache_cost_usd, cache_net_savings_usd,
 *   sonnet_round1_ms, sonnet_round2_ms, dispatch_total_ms, bundler_ms,
 *   audible_first_byte_ms (server-side, may be null), audible_first_byte_source
 *   ('server_res_write' | 'ios_playback_ack' | null), path_classification,
 *   turn_shape ('single_call' | 'multi_call' | 'multi_round' — Plan B B3),
 *   tool_call_count_total (number — Plan B B3).
 *
 *   Wrapped in try/catch — any throw logs `voice_latency.turn_summary_emit_error`
 *   and continues. Telemetry must never break the main extraction flow.
 */
export function emitTurnCoreSummary(fields) {
  try {
    if (!fields || !fields.sessionId || !fields.turnId) {
      logger.warn('voice_latency.turn_summary_emit_error', {
        reason: 'missing_required_keys',
        has_fields: !!fields,
      });
      return;
    }
    logger.info('voice_latency.turn_core_summary', fields);
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'core',
      error: err?.message || String(err),
    });
  }
}

/**
 * Arm the delayed audio finalizer for this turn.
 *
 * Called from runLiveMode AFTER `emitTurnCoreSummary` runs (so the core
 * row is in CloudWatch before any iOS ACK can correlate). The finalizer
 * waits for `expected_acks` ACK POSTs to arrive at `/api/voice-latency/playback-ack`
 * OR for an 8s timeout — whichever fires first triggers the audio-summary row.
 *
 * Pre-finalizer decrements (stashed by `decrementExpectedAcksByCorrelation`
 * when fast-TTS POSTs were rejected before runLiveMode reached this point)
 * are drained at arm time. The set of correlation ids associated with this
 * turn is read off the activeSessions entry's
 * `fastPathCorrelationIdByTurn` map — populated when the WS transcript
 * carrying `regex_fast_correlation_id` was parsed at runLiveMode entry
 * (PLAN_v8 Pivot 8.4).
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {Object} options
 * @param {number} options.bundlerEmittedCount   How many bundler confirmations were emitted.
 *                                                **Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5:**
 *                                                callers (i.e. `stage6-shadow-harness.js` and any
 *                                                other `startAudioFinalizer` site) MUST pre-filter
 *                                                this count by `expects_ios_ack !== false` so the
 *                                                finalizer only arms for bundler confirmations whose
 *                                                iOS speak site can actually fire a playback-ack.
 *                                                State-change / observation / cleared confirmations
 *                                                from the bundler set `expects_ios_ack: false` and
 *                                                must be excluded from this count.
 * @param {number} options.attemptedFastTtsCount How many fast-TTS POSTs iOS attempted this turn.
 *                                                Typically the size of
 *                                                `entry.fastPathCorrelationIdByTurn.get(turnId)`.
 *                                                The Set itself is read from the activeSessions
 *                                                entry via `getActiveSessionEntry(sessionId)`
 *                                                rather than being passed by the caller — keeps
 *                                                lifetime ownership inside this module.
 */
export function startAudioFinalizer(sessionId, turnId, options = {}) {
  if (!sessionId || !turnId) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      reason: 'start_finalizer_missing_keys',
      has_sessionId: !!sessionId,
      has_turnId: !!turnId,
    });
    return;
  }
  const bundlerEmittedCount = Number.isFinite(options.bundlerEmittedCount)
    ? options.bundlerEmittedCount
    : 0;
  const attemptedFastTtsCount = Number.isFinite(options.attemptedFastTtsCount)
    ? options.attemptedFastTtsCount
    : 0;

  // Drain pending decrements for the correlation ids attached to this turn.
  // Read the per-turn correlation Set off the activeSessions entry (the
  // Map lives on the entry, populated by runLiveMode when the WS transcript
  // carried `regex_fast_correlation_id`).
  const entry = getActiveSessionEntry(sessionId);
  const correlationIds = entry?.fastPathCorrelationIdByTurn?.get(turnId) ?? new Set();
  const { count: decrementCount, consumedIds: rejectedIds } = consumePendingDecrements(
    sessionId,
    correlationIds
  );

  const expected_acks = Math.max(0, bundlerEmittedCount + attemptedFastTtsCount - decrementCount);

  // PLAN-D 2026-08-23 (D4) — capability-conditioned observability. Gate on
  // `client_playback_telemetry` (what current iOS actually advertises; the
  // legacy voice_latency_ack flag is NOT advertised by current builds and
  // gating on it would classify real iOS sessions as unobservable). A
  // session whose parsed capabilities LACK the flag (web advertises no
  // playback telemetry at all) is UNOBSERVABLE — its missing ACKs are the
  // expected state, never evidence of unheard audio. A session with no
  // parsed capability info at all (legacy callers, partial test sessions)
  // stays 'unknown' and keeps the pre-D4 behaviour byte-identical.
  const capabilities = entry?.voiceLatency?.capabilities;
  const observability = capabilities
    ? capabilities.hasClientPlaybackTelemetry === true
      ? 'observable'
      : 'unobservable'
    : 'unknown';

  // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: a turn is
  // ACK-eligible if at least one bundler emit was expects_ios_ack-true OR
  // at least one fast-TTS POST was attempted. The §CloudWatch validation
  // query filters on this to distinguish "Tier 1.1 fix actually works" from
  // "Apple-native fallback / no-context turns legitimately don't ACK".
  // Emitted as integer 0|1 (NOT boolean) because Logs Insights `max()`
  // over a boolean field is undefined in some configurations.
  //
  // PLAN-D (D4): an UNOBSERVABLE session is never ACK-eligible — the client
  // cannot POST playback ACKs, so eligibility would manufacture a false
  // `no_audio_ack_at_ttl` diagnosis downstream on every web turn. Setting
  // it false here keeps the canonical row and the perceived-latency store's
  // derived rows in agreement (the store keys off expected_acks_eligible).
  const eligible_for_validation =
    observability !== 'unobservable' && (bundlerEmittedCount > 0 || attemptedFastTtsCount > 0);

  // PLAN-D (D4) — identity-matched obligation ledger, built ONLY when the
  // caller supplied structured descriptors (the live harness does; legacy
  // call sites/tests fall back to the count-arithmetic path unchanged).
  // Rejected-at-arm correlation ids are removed BEFORE twin collapse.
  const hasDescriptors =
    Array.isArray(options.ackEligibleConfirmations) || Array.isArray(options.fastAttempts);
  const obligations = hasDescriptors
    ? buildAckObligations(options.fastAttempts, options.ackEligibleConfirmations, rejectedIds)
    : null;

  // Voice-latency plan 2026-06-03 Tier 1.3 — populate the durable
  // correlationToTurn index BEFORE entry.fastPathCorrelationIdByTurn is
  // cleaned up by runLiveMode's finally block (stage6-shadow-harness.js
  // :1223). Also collect any fast-path ACKs that arrived BEFORE this
  // finalizer armed — they're stashed in pendingFastPathAcksByCorrelation
  // by recordPlaybackAck and need draining into received_acks here.
  /** @type {Array<Object>} */
  const drained = [];
  for (const cid of correlationIds) {
    correlationToTurn.set(cid, {
      sessionId,
      turnId,
      expires_at_ms: Date.now() + CORRELATION_TURN_TTL_MS,
    });
    const stashed = pendingFastPathAcksByCorrelation.get(cid);
    if (stashed && stashed.sessionId === sessionId && stashed.expires_at_ms > Date.now()) {
      // Stamp received_at_ms now (mirrors recordPlaybackAck below) so the
      // arrival-order ordering on the row is consistent.
      drained.push({ ...stashed.ack, received_at_ms: Date.now() });
      pendingFastPathAcksByCorrelation.delete(cid);
    } else if (stashed) {
      // Expired or wrong-session — clean up.
      pendingFastPathAcksByCorrelation.delete(cid);
    }
  }
  lazyExpirySweep(correlationToTurn);
  lazyExpirySweep(pendingFastPathAcksByCorrelation);

  const key = `${sessionId}::${turnId}`;
  // If we're somehow re-arming for the same turn, clear the prior timer.
  const existing = pendingFinalizers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pendingFinalizers.delete(key);
  }

  if (expected_acks === 0) {
    // Nothing to wait for. Emit the audio summary immediately so the
    // row exists in CloudWatch with the same join key.
    // Voice-latency Tier 1.3 edge: drained may be non-empty if iOS posted
    // a fast-path ACK that got 4xx-decremented before runLiveMode reached
    // this point (correlationId in the per-turn set, but attemptedFastTts-
    // Count already 0). Surface those ACKs honestly — downstream queries
    // that filter expected_acks > 0 won't pick them up anyway.
    emitTurnAudioSummary({
      sessionId,
      turnId,
      ios_playback_ack: drained,
      audio_finalizer_timeout_fired: false,
      expected_acks: 0,
      decrements_applied: decrementCount,
      eligible_for_validation,
      observability,
      ...(obligations ? summariseObligations(obligations, observability) : {}),
    });
    return;
  }

  const timer = setTimeout(() => {
    const pending = pendingFinalizers.get(key);
    if (!pending) return;
    pendingFinalizers.delete(key);
    emitTurnAudioSummary({
      sessionId,
      turnId,
      ios_playback_ack: pending.received_acks,
      audio_finalizer_timeout_fired: true,
      expected_acks: pending.expected_acks,
      decrements_applied: pending.decrements_applied,
      eligible_for_validation: pending.eligible_for_validation,
      // PLAN-D (D4) — the timeout row now names the exact slot identities
      // still owed (127's row said only `expected_acks:1, acks:0` — a class,
      // not a slot). Diagnosis without speech: NO recovery path exists here.
      observability: pending.observability,
      ...(pending.obligations
        ? summariseObligations(pending.obligations, pending.observability)
        : {}),
    });
  }, FINALIZER_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  pendingFinalizers.set(key, {
    sessionId,
    turnId,
    expected_acks,
    received_acks: [],
    timer,
    armed_ns: process.hrtime.bigint(),
    // Persist the decrement count so on-time ACK completion can also
    // carry it on the emit (the timeout path captures it via closure;
    // the ACK-completion path reads it off the pending entry).
    decrements_applied: decrementCount,
    // Voice-latency Tier 1.1 sub-step 5: persist eligibility so the on-time
    // ACK completion path (recordPlaybackAck) carries it onto the emit too.
    eligible_for_validation,
    // PLAN-D (D4) — identity ledger + observability class, read by
    // matchAckToObligations / maybeFlushFinalizer / the emits above.
    obligations,
    observability,
  });

  // Voice-latency Tier 1.3 — drained ACKs that arrived before this
  // finalizer was armed need to be pushed into received_acks AFTER
  // pendingFinalizers.set so maybeFlushFinalizer can find the entry.
  if (drained.length > 0) {
    const pending = pendingFinalizers.get(key);
    pending.received_acks.push(...drained);
    // PLAN-D (D4) — drained pre-arm ACKs reconcile against the obligation
    // ledger exactly like live ones.
    if (pending.obligations) {
      for (const ack of drained) matchAckToObligations(pending.obligations, ack);
    }
    maybeFlushFinalizer(key, pending, decrementCount);
  }
}

/**
 * Voice-latency plan 2026-06-03 Tier 1.3 — finalizer completion helper.
 *
 * Factored out of recordPlaybackAck so the drain-on-arm path in
 * startAudioFinalizer can also fire the on-time emit (instead of waiting
 * for the 8s timeout when the stashed ACKs already complete the count).
 */
function maybeFlushFinalizer(key, pending, decrementCountOverride) {
  // PLAN-D 2026-08-23 (D4) — when the identity ledger exists, completion is
  // determined from uniquely matched obligation identities, NEVER aggregate
  // count arithmetic (a duplicate ACK + a missing one used to net out to
  // "complete"). An un-acked slot-ambiguous obligation blocks early
  // completion (never claim exact completion for it) — the turn runs to the
  // timeout, whose row reports it AMBIGUOUS rather than unacked. Legacy
  // callers (no ledger) keep the count comparison byte-identical.
  const complete = pending.obligations
    ? obligationsComplete(pending.obligations)
    : pending.received_acks.length >= pending.expected_acks;
  if (complete) {
    clearTimeout(pending.timer);
    pendingFinalizers.delete(key);
    emitTurnAudioSummary({
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      ios_playback_ack: pending.received_acks,
      audio_finalizer_timeout_fired: false,
      expected_acks: pending.expected_acks,
      decrements_applied:
        decrementCountOverride !== undefined ? decrementCountOverride : pending.decrements_applied,
      eligible_for_validation: pending.eligible_for_validation,
      observability: pending.observability,
      ...(pending.obligations
        ? summariseObligations(pending.obligations, pending.observability)
        : {}),
    });
  }
}

/**
 * Internal: emit the `voice_latency.turn_audio_summary` row.
 *
 * Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: project
 * `expected_acks_eligible` as the integer 0|1 (NOT boolean) so CloudWatch
 * Logs Insights `max()` / `filter expected_acks_eligible = 1` works.
 *
 * Voice-latency plan 2026-06-03 Tier 1.3 backend plumbing #4: flatten the
 * earliest-monotonic ACK (within the dominant process_uptime_id group) as
 * top-level row fields named exactly `ios_playback_ack_monotonic_at_ms`,
 * `ios_playback_ack_process_uptime_id`, `ios_playback_ack_correlation_id`,
 * and `ios_playback_ack_audio_source`.
 * Without this flattening, CloudWatch Logs Insights `latest()` CANNOT read
 * inside the `ios_playback_ack[]` array — the §CloudWatch dashboard query
 * would return null for the audible-first-byte column on every row. Fires
 * at ALL THREE emitTurnAudioSummary call sites (zero-ack early-return,
 * timeout, on-time completion).
 */
function emitTurnAudioSummary(fields) {
  let enrichedForStore = null;
  let earliestAck = null;
  try {
    earliestAck = pickEarliestPlaybackAck(fields.ios_playback_ack);
    const enriched = {
      ...fields,
      expected_acks_eligible: fields.eligible_for_validation ? 1 : 0,
      ios_playback_ack_monotonic_at_ms: earliestAck?.monotonic_at_ms ?? null,
      ios_playback_ack_process_uptime_id: earliestAck?.process_uptime_id ?? null,
      ios_playback_ack_correlation_id: earliestAck?.correlation_id ?? null,
      ios_playback_ack_audio_source: earliestAck?.audio_source ?? null,
    };
    delete enriched.eligible_for_validation; // internal-only; only top-level field ships
    logger.info('voice_latency.turn_audio_summary', enriched);
    enrichedForStore = enriched;
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'audio',
      error: err?.message || String(err),
    });
    // Canonical row failed — do NOT feed the perceived-latency store
    // with half-baked fields. Returning early below keeps the store
    // free of zombie entries from the failure mode.
    return;
  }

  // Voice-latency plan 2026-06-05 Phase 2.3 — invoke the
  // perceived-latency store AFTER the canonical row has landed. Wrapped
  // in its own try/catch so a store throw cannot disturb the canonical
  // emit path (already returned 204 / already logged). All field
  // derivation happens here in this module; the hook receives derived
  // fields directly (no import back into voice-latency-turn-summary.js
  // from the leaf module — avoids ESM circular dep).
  try {
    recordTurnAudioSummary({
      sessionId: enrichedForStore.sessionId,
      turnId: enrichedForStore.turnId,
      expected_acks: enrichedForStore.expected_acks,
      expected_acks_eligible: enrichedForStore.expected_acks_eligible,
      audio_finalizer_timeout_fired: enrichedForStore.audio_finalizer_timeout_fired,
      ack_source: earliestAck?.source ?? null,
      ios_playback_ack_at_ms: earliestAck?.at_ms ?? null,
      ios_playback_ack_monotonic_at_ms: enrichedForStore.ios_playback_ack_monotonic_at_ms,
      ios_playback_ack_process_uptime_id: enrichedForStore.ios_playback_ack_process_uptime_id,
      ios_playback_ack_correlation_id: enrichedForStore.ios_playback_ack_correlation_id,
      ios_playback_ack_audio_source: enrichedForStore.ios_playback_ack_audio_source,
    });
  } catch (storeErr) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'audio_summary_hook',
      error: storeErr?.message || String(storeErr),
    });
  }
}

/**
 * Record an iOS playback ACK. Called by the `/api/voice-latency/playback-ack`
 * endpoint when iOS POSTs that an AVAudioPlayer started or finished playing.
 *
 * On-time path: ACK arrives while the finalizer is armed. Append to
 * `received_acks`; if count reaches `expected_acks`, clear the timer and
 * emit `turn_audio_summary` immediately.
 *
 * Late path: ACK arrives after the finalizer has already fired (its row
 * is immutable, can't be updated). Emit a separate
 * `voice_latency.late_playback_ack` row so dashboards can correlate post-hoc.
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {Object} ack — `{slot, source, at_ms}` per /playback-ack body schema.
 */
export function recordPlaybackAck(sessionId, turnId, ack) {
  const received_at_ms = Date.now();
  const isFastPathWithCorrelation =
    ack?.source === 'fast_tts' &&
    typeof ack?.correlation_id === 'string' &&
    ack.correlation_id.length > 0;

  // Voice-latency plan 2026-06-03 Tier 1.3 — fast-path correlation
  // resolution. Fast-path ACKs may arrive at the backend BEFORE iOS knows
  // the server-minted turnId for that turn (the regex-fast-tts contract
  // returns audio before runLiveMode mints the turn). The plan resolves
  // this via correlation_id → turnId index:
  //   1. If turnId matches a pendingFinalizers entry, use that path
  //      directly (same-turn correlation_id).
  //   2. If source==fast_tts AND correlation_id is present AND the
  //      durable correlationToTurn index has an entry → resolve to the
  //      server-minted turnId. If the finalizer has fired already, the
  //      ACK still resolves to a real turnId and lands on the late-ACK
  //      row keyed by that turn.
  //   3. If neither resolves AND we have correlation_id → stash in
  //      pendingFastPathAcksByCorrelation; startAudioFinalizer drains on
  //      arm.
  let resolvedTurnId = turnId;
  let pending = turnId ? pendingFinalizers.get(`${sessionId}::${turnId}`) : null;
  let resolvedViaCorrelation = false;
  if (!pending && isFastPathWithCorrelation) {
    const indexed = correlationToTurn.get(ack.correlation_id);
    if (indexed && indexed.sessionId === sessionId && indexed.expires_at_ms > received_at_ms) {
      resolvedTurnId = indexed.turnId;
      pending = pendingFinalizers.get(`${sessionId}::${resolvedTurnId}`);
      // Even if pending is null (finalizer already fired), we resolved a
      // real turnId — late-ACK row should use it.
      resolvedViaCorrelation = true;
    } else if (indexed) {
      // Expired — clean up.
      correlationToTurn.delete(ack.correlation_id);
    }
  }

  if (pending) {
    pending.received_acks.push({ ...ack, received_at_ms });
    // PLAN-D (D4) — reconcile against the identity ledger (correlation
    // first, unique-slot second) before evaluating completion.
    if (pending.obligations) matchAckToObligations(pending.obligations, ack);
    maybeFlushFinalizer(`${sessionId}::${resolvedTurnId}`, pending);
    return;
  }

  // Voice-latency Tier 1.3 — pre-finalizer race: fast-path ACK arrived
  // before runLiveMode armed AND we have NO durable correlationToTurn
  // entry yet (resolvedViaCorrelation === false means we never matched).
  // Stash by correlation_id; startAudioFinalizer drains on arm.
  if (isFastPathWithCorrelation && !resolvedViaCorrelation) {
    pendingFastPathAcksByCorrelation.set(ack.correlation_id, {
      ack: { ...ack },
      sessionId,
      expires_at_ms: received_at_ms + FAST_PATH_ACK_STASH_TTL_MS,
    });
    lazyExpirySweep(pendingFastPathAcksByCorrelation);
    return;
  }

  // Late-ACK path — finalizer already fired (resolvedViaCorrelation=true
  // OR original turnId attached to a turn whose finalizer already
  // emitted) OR an ACK lookup miss we can't otherwise route. Skip when
  // we have no usable turnId at all (defensive: validateBody on the
  // route guarantees we always have one for non-fast-path).
  if (!resolvedTurnId && !resolvedViaCorrelation) {
    return;
  }
  const turnIdForLog = resolvedViaCorrelation ? resolvedTurnId : turnId;
  // Voice-latency plan 2026-06-03 Tier 1.3 backend plumbing #3: include
  // the new optional fields (monotonic_at_ms, process_uptime_id,
  // correlation_id) on the late-ACK row so dashboards joining late ACKs
  // post-hoc can still compute perceived-latency.
  try {
    logger.info('voice_latency.late_playback_ack', {
      sessionId,
      turnId: turnIdForLog,
      slot_key: ack?.slot
        ? `${ack.slot.field}::${ack.slot.circuit}::${ack.slot.boardId ?? ''}`
        : null,
      source: ack?.source ?? null,
      at_ms: ack?.at_ms ?? null,
      received_at_ms,
      lag_ms: typeof ack?.at_ms === 'number' ? Math.max(0, received_at_ms - ack.at_ms) : null,
      monotonic_at_ms: ack?.monotonic_at_ms ?? null,
      process_uptime_id: ack?.process_uptime_id ?? null,
      correlation_id: ack?.correlation_id ?? null,
      audio_source: ack?.audio_source ?? null,
    });
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'late_ack',
      error: err?.message || String(err),
    });
    return; // canonical row failed — skip the store hook (keeps the
    // store free of zombie partial merges).
  }

  // Voice-latency plan 2026-06-05 Phase 2.3 — feed the late ack into
  // the perceived-latency store. Wrapped in its own try/catch so a
  // store throw cannot disturb the canonical late_playback_ack row
  // (already logged). Resolved turnId is the merge key — guaranteed
  // non-null here by the early-return at line 524-526.
  try {
    recordLatePlaybackAck({
      sessionId,
      turnId: turnIdForLog,
      ack_source: ack?.source ?? null,
      ios_playback_ack_at_ms: ack?.at_ms ?? null,
      ios_playback_ack_monotonic_at_ms: ack?.monotonic_at_ms ?? null,
      ios_playback_ack_process_uptime_id: ack?.process_uptime_id ?? null,
      ios_playback_ack_correlation_id: ack?.correlation_id ?? null,
      ios_playback_ack_audio_source: ack?.audio_source ?? null,
    });
  } catch (storeErr) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'late_ack_hook',
      error: storeErr?.message || String(storeErr),
    });
  }
}

/**
 * Decrement the expected-ACK count for the turn whose finalizer matches
 * the correlation id. If no finalizer exists yet (typical — fast-TTS
 * endpoint rejects BEFORE runLiveMode has minted a turnId), stash the
 * decrement keyed by correlation id.
 *
 * `startAudioFinalizer` drains stashed decrements at arm time.
 *
 * @param {string} sessionId
 * @param {string} correlationId  the regex_fast_correlation_id from the
 *                                rejected fast-TTS request.
 */
export function decrementExpectedAcksByCorrelation(sessionId, correlationId) {
  if (!sessionId || !correlationId) return;
  // PLAN-D 2026-08-23 (D4) — POST-ARM rejection race. The old behaviour only
  // ever stashed, and a stash is drained exclusively at arm time — so a
  // rejection arriving AFTER startAudioFinalizer had armed never updated the
  // armed finalizer and the turn timed out as a false UNACKED. The durable
  // correlationToTurn index (populated at arm, 60s TTL) locates the armed
  // finalizer; the exact rejected fast leg is removed immediately:
  //   - a collapsed twin loses ONLY its fast leg (the canonical fallback the
  //     bundler emitted is still owed a playback — it keeps both slot
  //     aliases and reverts to a plain canonical obligation);
  //   - a standalone fast obligation is removed outright;
  // then completion is re-evaluated (the rejection may have been the last
  // outstanding identity). The pre-arm stash path below stays byte-identical.
  const indexed = correlationToTurn.get(correlationId);
  if (indexed && indexed.sessionId === sessionId && indexed.expires_at_ms > Date.now()) {
    const key = `${sessionId}::${indexed.turnId}`;
    const pending = pendingFinalizers.get(key);
    if (pending) {
      pending.expected_acks = Math.max(0, pending.expected_acks - 1);
      pending.decrements_applied = (pending.decrements_applied ?? 0) + 1;
      if (pending.obligations) {
        let target = pending.obligations.get(`fast:${correlationId}`) ?? null;
        if (!target) {
          for (const ob of pending.obligations.values()) {
            if (ob.correlationId === correlationId) {
              target = ob;
              break;
            }
          }
        }
        if (target && !target.acked) {
          if (target.kind === 'twin') {
            target.kind = 'canonical';
            target.correlationId = null;
          } else if (target.kind === 'fast') {
            for (const [id, ob] of pending.obligations) {
              if (ob === target) {
                pending.obligations.delete(id);
                break;
              }
            }
          }
        }
      }
      maybeFlushFinalizer(key, pending);
      return;
    }
  }
  pendingAckDecrements.set(correlationId, {
    sessionId,
    expires_at_ms: Date.now() + ACK_DECREMENT_TTL_MS,
  });
}

/**
 * Drain pending decrements for the given correlation ids, scoped to one
 * sessionId. Stale entries (>60s) silently dropped.
 *
 * PLAN-D 2026-08-23 (D4) — returns `{count, consumedIds}` instead of the bare
 * count: the rejection path retains exact correlation IDs, and reducing them
 * to arithmetic here is what made it impossible to remove the exact rejected
 * fast obligations before twin collapse in `startAudioFinalizer`.
 *
 * Called by `startAudioFinalizer`. Not exported for general use — keep
 * the lifecycle contained.
 */
function consumePendingDecrements(sessionId, correlationIds) {
  const consumedIds = new Set();
  if (!correlationIds || correlationIds.size === 0) return { count: 0, consumedIds };
  const now = Date.now();
  for (const cid of correlationIds) {
    const entry = pendingAckDecrements.get(cid);
    if (!entry) continue;
    if (entry.sessionId !== sessionId) continue;
    if (entry.expires_at_ms < now) {
      pendingAckDecrements.delete(cid);
      continue;
    }
    consumedIds.add(cid);
    pendingAckDecrements.delete(cid);
  }
  return { count: consumedIds.size, consumedIds };
}

/**
 * Test-only: reset module state. Used by Jest `afterEach`.
 */
export function _resetForTests() {
  for (const [, p] of pendingFinalizers) clearTimeout(p.timer);
  pendingFinalizers.clear();
  pendingAckDecrements.clear();
  correlationToTurn.clear();
  pendingFastPathAcksByCorrelation.clear();
}

/**
 * Test-only: introspect module state.
 */
export function _peekStateForTests() {
  return {
    pendingFinalizers: pendingFinalizers.size,
    pendingAckDecrements: pendingAckDecrements.size,
    correlationToTurn: correlationToTurn.size,
    pendingFastPathAcksByCorrelation: pendingFastPathAcksByCorrelation.size,
  };
}
