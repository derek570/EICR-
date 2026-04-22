// sonnet-stream.js
// WebSocket handler for server-side Sonnet extraction sessions.
//
// HISTORY: This is the server-side counterpart to the iOS ServerWebSocketService.
// iOS connects via wss://backend/api/sonnet-stream, sends transcript buffers, and
// receives extraction results + cost updates + gated questions in real time.
//
// Key evolution:
// - Compaction removed — sliding window keeps context bounded, making compaction dead code.
// - Session reconnection: 5-minute timeout (300s) preserves conversation history
//   across Deepgram sleep/wake cycles. iOS disconnects the WebSocket during auto-sleep
//   (no audio for 60s) and reconnects when speech resumes.

import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { EICRExtractionSession } from './eicr-extraction-session.js';
import { QuestionGate } from './question-gate.js';
import { needsRefinement, refineObservation } from './observation-code-lookup.js';
import { sonnetSessionStore } from './sonnet-session-store.js';
import * as storage from '../storage.js';
import logger from '../logger.js';
// Stage 5 — dialog-state filledSlots pre-flight filter. Extracted to its own
// module so it can be unit-tested without loading storage.js. Docstring in
// ./filled-slots-filter.js.
import { filterQuestionsAgainstFilledSlots } from './filled-slots-filter.js';
// Stage 6 — shadow-harness wraps extractFromUtterance so SONNET_TOOL_CALLS=shadow
// drives the stream assembler from the seam on every turn (ROADMAP Phase 1 SC #2).
import { runShadowHarness } from './stage6-shadow-harness.js';
// Stage 6 Phase 3 — per-session blocking-ask plumbing. Plan 03-08 threads the
// per-session PendingAsksRegistry through every call-site of runShadowHarness
// (via `options.pendingAsks` + `options.ws`) and routes inbound iOS
// `ask_user_answered` replies to registry.resolve. The overtake classifier
// fires in handleTranscript BEFORE shadow-harness dispatch so an unrelated
// utterance drains stale asks (rejectAll 'user_moved_on') rather than
// poisoning the slot map.
import { createPendingAsksRegistry } from './stage6-pending-asks-registry.js';
import { classifyOvertake } from './stage6-overtake-classifier.js';
// Plan 03-10 Task 2 — bound + scrub user_text before it touches CloudWatch
// logs OR the Anthropic tool_result body. Pure function; throws on abusive
// sizes (>8192 chars) so the caller can send an error envelope back to iOS
// instead of smuggling the abuse downstream.
import { sanitiseUserText } from './stage6-sanitise-user-text.js';

// Lazy-initialised OpenAI client for observation refinement (gpt-5-search-api).
// Kept at module scope so repeat refinements reuse the same HTTPS pool.
let _openaiClient = null;
async function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const OpenAI = (await import('openai')).default;
    _openaiClient = new OpenAI({ apiKey });
    return _openaiClient;
  } catch (err) {
    logger.warn('OpenAI client init failed — observation refinement disabled', {
      error: err.message,
    });
    return null;
  }
}

/**
 * Fire-and-forget observation refinement. For each observation in the result
 * that needs refinement (missing code/regulation/low confidence), call
 * `gpt-5-search-api` and emit an `observation_update` message to iOS. Runs
 * AFTER the extraction result has been sent so it doesn't block the main turn.
 *
 * Phase C (#5, #8): takes `entry` instead of a bare ws so we resolve
 * `entry.ws` at send time. On reconnect the session-swap path updates
 * `entry.ws`, so refinements in flight when the socket swaps still land on
 * the live connection. Also pre-flight-checks ws state BEFORE each
 * `refineObservation` call so we don't burn search tokens on a socket we
 * already know is dead. Failed/skipped refinements remain in
 * `entry.pendingRefinements` so the reconnect flush re-kicks them.
 */
async function refineObservationsAsync(entry, sessionId, observations) {
  if (!entry || !Array.isArray(observations) || observations.length === 0) return;
  const toRefine = observations.filter(needsRefinement);
  if (toRefine.length === 0) return;

  const openai = await getOpenAIClient();
  if (!openai) return;

  // Phase C #8: mark every obs as pending BEFORE we start so a reconnect
  // that arrives during the await can see what's in flight.
  entry.pendingRefinements = entry.pendingRefinements || new Map();
  entry.recentlyRefinedIds = entry.recentlyRefinedIds || new Map();
  for (const obs of toRefine) {
    if (!obs.observation_id) continue; // no id → can't dedupe on reconnect
    // Duplicate guard: if we successfully refined this id in the last 2s
    // (short TTL), skip — the reconnect path may re-kick the same list.
    const recentExpiry = entry.recentlyRefinedIds.get(obs.observation_id);
    if (recentExpiry && recentExpiry > Date.now()) {
      // Phase F: surface the dedupe block so CloudWatch can count how often
      // the reconnect-replay path is doing redundant work (signals a
      // reconnect loop or a Sonnet re-emit storm).
      logger.info('observation_refinement_dedup_blocked', {
        sessionId,
        observationId: obs.observation_id.slice(0, 8),
        expiresInMs: recentExpiry - Date.now(),
      });
      continue;
    }
    entry.pendingRefinements.set(obs.observation_id, { obs, attemptedAt: Date.now() });
  }

  for (const obs of toRefine) {
    // Same dedupe check as above — re-read in case the previous iteration
    // of this loop already completed the same id on a parallel call.
    if (obs.observation_id) {
      const recentExpiry = entry.recentlyRefinedIds.get(obs.observation_id);
      if (recentExpiry && recentExpiry > Date.now()) continue;
    }
    try {
      // Phase C #8 pre-flight: if the session's socket is already closed AND
      // there's no reconnect window pending, leave the obs in pendingRefinements
      // so the reconnect flush handles it. Saves a 1-3s search on a dead ws.
      if (entry.ws?.readyState !== entry.ws?.OPEN && !entry.disconnectTimer) {
        logger.info('Refinement deferred — socket closed, no reconnect pending', {
          sessionId,
          observationId: (obs.observation_id || '').slice(0, 8),
        });
        continue;
      }
      const refined = await refineObservation(openai, obs);
      if (!refined) {
        // No refinement produced — treat as resolved (no update to send).
        if (obs.observation_id) entry.pendingRefinements.delete(obs.observation_id);
        continue;
      }
      // Resolve ws at SEND time, not call time — if the socket was swapped
      // during the await (doze/wake, transient drop), `entry.ws` now points
      // at the live socket.
      const currentWs = entry.ws;
      if (!currentWs || currentWs.readyState !== currentWs.OPEN) {
        // Socket not available — leave in pendingRefinements for reconnect
        // flush. We already paid for the search, so don't call it again.
        // Cache the result on the pending entry so re-kick can short-circuit.
        if (obs.observation_id) {
          entry.pendingRefinements.set(obs.observation_id, {
            obs,
            refined,
            attemptedAt: Date.now(),
          });
        }
        logger.info('Refinement result queued (socket dropped mid-refine)', {
          sessionId,
          observationId: (obs.observation_id || '').slice(0, 8),
        });
        continue;
      }
      currentWs.send(
        JSON.stringify({
          type: 'observation_update',
          // Phase A: echo the server-assigned observation_id so iOS can patch
          // the exact row even if Sonnet has since re-worded the observation
          // text (fuzzy match becomes fallback only).
          observation_id: obs.observation_id || null,
          observation_text: obs.observation_text || obs.description || '',
          code: refined.code,
          regulation: refined.regulation,
          rationale: refined.rationale,
          source: refined.source,
        })
      );
      if (obs.observation_id) {
        entry.pendingRefinements.delete(obs.observation_id);
        // Phase C #5 duplicate guard: 2s window where a reconnect re-kick
        // must not re-issue the refinement.
        entry.recentlyRefinedIds.set(obs.observation_id, Date.now() + 2000);
      }
      logger.info('observation_update sent', {
        sessionId,
        observationId: (obs.observation_id || '').slice(0, 8),
        code: refined.code,
        textPreview: (obs.observation_text || '').slice(0, 60),
      });
    } catch (err) {
      logger.warn('Observation refinement iteration failed', {
        sessionId,
        error: err.message,
      });
      // Leave in pendingRefinements — reconnect will retry.
    }
  }
}

/**
 * Phase C #5: on reconnect, re-kick any observations whose refinement
 * never reached the iOS client. If we have a cached `refined` (search
 * already ran and the result is buffered), send it directly — avoids a
 * second search call. Otherwise re-enter the normal flow.
 */
async function replayPendingRefinements(entry, sessionId) {
  if (!entry?.pendingRefinements || entry.pendingRefinements.size === 0) return;
  // Prune expired recentlyRefinedIds so the map doesn't grow without bound.
  if (entry.recentlyRefinedIds) {
    const now = Date.now();
    for (const [id, expiry] of entry.recentlyRefinedIds.entries()) {
      if (expiry <= now) entry.recentlyRefinedIds.delete(id);
    }
  }
  const toReplay = Array.from(entry.pendingRefinements.values());
  logger.info('Replaying pending refinements on reconnect', {
    sessionId,
    count: toReplay.length,
  });
  const needsFreshSearch = [];
  for (const { obs, refined } of toReplay) {
    if (refined) {
      // Cached result from a mid-refine socket drop — send directly.
      if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) return;
      try {
        entry.ws.send(
          JSON.stringify({
            type: 'observation_update',
            observation_id: obs.observation_id || null,
            observation_text: obs.observation_text || obs.description || '',
            code: refined.code,
            regulation: refined.regulation,
            rationale: refined.rationale,
            source: refined.source,
          })
        );
        if (obs.observation_id) {
          entry.pendingRefinements.delete(obs.observation_id);
          entry.recentlyRefinedIds.set(obs.observation_id, Date.now() + 2000);
        }
        logger.info('observation_update sent (replayed cached)', {
          sessionId,
          observationId: (obs.observation_id || '').slice(0, 8),
        });
      } catch (err) {
        logger.warn('Replay cached observation_update failed', {
          sessionId,
          error: err.message,
        });
      }
    } else {
      needsFreshSearch.push(obs);
    }
  }
  if (needsFreshSearch.length > 0) {
    // Clear the pending entries first — refineObservationsAsync re-adds them
    // under the dedupe guard to avoid the window where the same id is both
    // pending AND in flight.
    for (const obs of needsFreshSearch) {
      if (obs.observation_id) entry.pendingRefinements.delete(obs.observation_id);
    }
    await refineObservationsAsync(entry, sessionId, needsFreshSearch);
  }
}

/**
 * Send any server-classified observation updates (RULE 6 correction edits)
 * as `observation_update` messages. These carry the existing observation_id
 * so iOS patches the existing row in place instead of creating a duplicate.
 * This runs BEFORE the fire-and-forget BPG4 refinement so the iOS client
 * sees the code change (e.g. "make that a C2") without waiting for the web
 * search.
 */
function dispatchObservationUpdates(ws, sessionId, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return;
  if (ws.readyState !== ws.OPEN) return;
  for (const u of updates) {
    try {
      ws.send(
        JSON.stringify({
          type: 'observation_update',
          observation_id: u.observation_id || null,
          observation_text: u.observation_text || '',
          code: u.code,
          regulation: u.regulation || null,
          rationale: u.rationale || null,
          source: u.source || 'rule_6_edit',
        })
      );
      logger.info('observation_update sent (rule_6_edit)', {
        sessionId,
        observationId: (u.observation_id || '').slice(0, 8),
        code: u.code,
        rationale: u.rationale,
      });
    } catch (err) {
      logger.warn('dispatchObservationUpdates iteration failed', {
        sessionId,
        error: err.message,
      });
    }
  }
}

// --- Per-connection rate limiting for transcript messages ---
const WS_RATE_LIMIT = {
  maxTranscripts: 60, // max transcript messages per sliding window
  windowMs: 60_000, // 1-minute window
};

// Plan 03-10 Task 1 — FIFO cap on the per-session consumedAskUtterances set.
// Picked one order of magnitude above the peak utterance count observed in a
// full 120-minute EICR inspection (~100 utterances) so normal sessions NEVER
// trigger eviction; abusive / long-running sessions still bound memory.
// Exported for test overrides.
export const CONSUMED_UTTERANCE_CAP = 256;

// r16 MAJOR#1 + #2 remediation — content-matched fallback dedupe.
//
// consumedAskUtterances is the fast path: utterance_id on both the ask
// answer AND the transcript. It fails in two cases Codex flagged:
//   MAJOR#1 — legacy clients omit consumed_utterance_id on the ANSWER
//             side, so no anchor is registered.
//   MAJOR#2 — clients that stamp consumed_utterance_id on the answer but
//             OMIT utterance_id on the paired transcript frame cannot
//             match the Set lookup (which is keyed on transcript's
//             utterance_id).
//
// Shared mitigation: every RESOLVED ask_user_answered also pushes a
// content anchor — the sanitised answer text + an expiry — to
// entry.recentAskAnswers. handleTranscript consults the list AFTER the
// fast-path Set miss; if any non-expired entry's normalised text equals
// the normalised transcript text, suppress + remove that entry (one-shot
// per answer). STA-01 (one in-flight turn) and the short TTL bound list
// size; CAP provides hard belt-and-braces limit.
//
// Match rule is normalised equality, NOT substring/overlap. "move to
// three" would substring-match an ask answer of "three" but is clearly
// a DIFFERENT utterance — suppressing it would lose genuine speech.
// Normalisation: lowercase + strip non-alphanumerics + collapse
// whitespace. This tolerates trailing punctuation and casing without
// admitting unrelated utterances.
//
// TTL 1500 ms — above observed iOS→server routing skew (<400 ms p99)
// but short enough that a fresh post-ask utterance that happens to
// repeat the answer text is not falsely suppressed. CAP 8 — more than
// one active content anchor at a time implies a burst of anchorless
// answers, which shouldn't happen under STA-01.
export const RECENT_ASK_ANSWER_TTL_MS = 1500;
export const RECENT_ASK_ANSWER_CAP = 8;

/**
 * Normalise a freeform utterance for equality-based dedupe.
 * Lowercase, strip non-alphanumerics, collapse internal whitespace,
 * trim. Pure — no allocations beyond the returned string.
 */
export function normaliseForAskMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sliding-window rate limiter. Returns an object with a check() method
 * that returns true if the message is allowed, false if rate-limited.
 */
function createMessageRateLimiter(maxMessages, windowMs) {
  const timestamps = [];
  return {
    check() {
      const now = Date.now();
      // Evict timestamps outside the window
      while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= maxMessages) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}

// activeSessions lives in a small shared module so route handlers (keys.js)
// and unit tests can attribute ElevenLabs TTS cost without dragging the full
// WS-handler import graph into their context. See `active-sessions.js`.
import { activeSessions } from './active-sessions.js';

// Known valid field names that iOS can handle
const KNOWN_FIELDS = new Set([
  // Supply fields
  'ze',
  'pfc',
  'earthing_arrangement',
  'main_earth_conductor_csa',
  'main_bonding_conductor_csa',
  'bonding_water',
  'bonding_gas',
  'earth_electrode_type',
  'earth_electrode_resistance',
  'supply_voltage',
  'nominal_voltage',
  'nominal_voltage_u',
  'supply_frequency',
  'nominal_frequency',
  'supply_polarity_confirmed',
  'manufacturer',
  'zs_at_db',
  // Main switch/fuse fields
  'main_switch_bs_en',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  // Supply-level RCD fields
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  // Additional supply fields
  'live_conductors',
  'number_of_supplies',
  'nominal_voltage_uo',
  'earth_electrode_location',
  'earthing_conductor_material',
  'earthing_conductor_continuity',
  'main_bonding_material',
  'main_bonding_continuity',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
  'bonding_other',
  // SPD fields
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',
  // Installation fields
  'address',
  'postcode',
  'town',
  'county',
  'client_name',
  'client_address',
  'client_postcode',
  'client_town',
  'client_county',
  'client_phone',
  'client_email',
  'reason_for_report',
  'occupier_name',
  'date_of_inspection',
  'date_of_previous_inspection',
  'previous_certificate_number',
  'estimated_age_of_installation',
  'general_condition',
  'next_inspection_years',
  'premises_description',
  // Circuit fields
  'zs',
  'insulation_resistance_l_e',
  'insulation_resistance_l_l',
  'r1_plus_r2',
  'r1_r2',
  'r1r2',
  'r2',
  'earth_continuity',
  'ring_continuity_r1',
  'ring_continuity_rn',
  'ring_continuity_r2',
  'rcd_trip_time',
  'rcd_time',
  'rcd_rating_a',
  'rcd_rating',
  'polarity',
  'cable_size',
  'cable_size_earth',
  'cpc_csa_mm2',
  'cpc_csa',
  'ocpd_type',
  'ocpd_rating',
  'ocpd_bs_en',
  'rcd_bs_en',
  'number_of_points',
  'wiring_type',
  'ref_method',
  'rcd_type',
  'rcd_operating_current_ma',
  'max_disconnect_time',
  'ocpd_breaking_capacity',
  'ir_test_voltage',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
  'circuit_description',
  'designation',
  'ir_live_earth',
  'ir_live_live',
  'earth_fault_loop_impedance',
  'ocpd_max_zs_ohm',
  'max_zs',
  'ocpd_max_zs',
  // EIC-specific fields
  'extent_of_installation',
  'installation_type',
  'departures_from_bs7671',
  'departure_details',
  'design_comments',
]);

// Common misspellings / variants → correct field name
const FIELD_CORRECTIONS = {
  insulation_resistance_le: 'insulation_resistance_l_e',
  insulation_resistance_ll: 'insulation_resistance_l_l',
  earth_loop_impedance_ze: 'ze',
  prospective_fault_current: 'pfc',
  // r1_plus_r2 is in KNOWN_FIELDS (iOS handles both r1_plus_r2 and r1_r2)
  rcd_trip_time_ms: 'rcd_trip_time',
  rcd_rating_ma: 'rcd_rating_a',
  cable_size_live: 'cable_size',
  cable_size_cpc: 'cable_size_earth',
  cpc_size: 'cable_size_earth',
  ir_l_e: 'insulation_resistance_l_e',
  ir_l_l: 'insulation_resistance_l_l',
  ir_le: 'insulation_resistance_l_e',
  ir_ll: 'insulation_resistance_l_l',
  loop_impedance: 'zs',
  earth_loop_impedance: 'zs',
  ring_r1: 'ring_continuity_r1',
  ring_rn: 'ring_continuity_rn',
  ring_r2: 'ring_continuity_r2',
  max_zs: 'ocpd_max_zs_ohm',
  ocpd_max_zs: 'ocpd_max_zs_ohm',
  max_zs_ohm: 'ocpd_max_zs_ohm',
  mcb_type: 'ocpd_type',
  mcb_rating: 'ocpd_rating',
  breaker_type: 'ocpd_type',
  breaker_rating: 'ocpd_rating',
  bs_en: 'ocpd_bs_en',
  ocpd_standard: 'ocpd_bs_en',
  rcd_standard: 'rcd_bs_en',
  main_switch_rating: 'main_switch_current',
  main_switch_type: 'main_switch_bs_en',
  // Date field variants
  inspection_date: 'date_of_inspection',
  test_date: 'date_of_inspection',
  previous_inspection_date: 'date_of_previous_inspection',
  last_inspection_date: 'date_of_previous_inspection',
  // "Main fuse" / "supply fuse" = Supply Protective Device (DNO cutout), NOT the CU main switch
  main_fuse_rating: 'spd_rated_current',
  main_fuse_current: 'spd_rated_current',
  main_fuse_bs_en: 'spd_bs_en',
  main_fuse_type: 'spd_type_supply',
  supply_fuse_rating: 'spd_rated_current',
  supply_fuse_type: 'spd_bs_en',
};

// Map cable description strings to BS 7671 wiring type letter codes
const WIRING_TYPE_DESC_TO_CODE = {
  'TWIN & EARTH': 'A',
  'TWIN AND EARTH': 'A',
  'T&E': 'A',
  'T+E': 'A',
  SHEATHED: 'A',
  'PVC SHEATHED': 'A',
  'FLAT TWIN': 'A',
  'FLAT T&E': 'A',
  FLEX: 'A',
  FP200: 'A',
  CONDUIT: 'B',
  'IN CONDUIT': 'B',
  'SINGLE IN CONDUIT': 'B',
  TRUNKING: 'C',
  'IN TRUNKING': 'C',
  'SINGLE IN TRUNKING': 'C',
  SWA: 'D',
  ARMOURED: 'D',
  MICC: 'D',
  MINERAL: 'D',
};
const VALID_WIRING_CODES = new Set(['A', 'B', 'C', 'D']);

function normaliseWiringType(value) {
  if (!value) return value;
  const upper = value.trim().toUpperCase();
  if (upper.length === 1 && VALID_WIRING_CODES.has(upper)) return upper;
  return WIRING_TYPE_DESC_TO_CODE[upper] || upper;
}

function validateAndCorrectFields(result, sessionId) {
  if (!result.extracted_readings) return result;
  for (const reading of result.extracted_readings) {
    if (!reading.field) continue;
    if (KNOWN_FIELDS.has(reading.field)) continue;

    const corrected = FIELD_CORRECTIONS[reading.field];
    if (corrected) {
      logger.info('Field corrected', { sessionId, from: reading.field, to: corrected });
      reading.field = corrected;
    } else {
      logger.warn('Unknown field name from Sonnet', {
        sessionId,
        field: reading.field,
        circuit: reading.circuit,
        value: reading.value,
      });
    }
  }
  // Normalise wiring_type values from descriptions to letter codes
  for (const reading of result.extracted_readings) {
    if (reading.field === 'wiring_type' && reading.value) {
      const normalised = normaliseWiringType(reading.value);
      if (normalised !== reading.value) {
        logger.info('Wiring type normalised', { sessionId, from: reading.value, to: normalised });
        reading.value = normalised;
      }
    }
  }
  return result;
}

export function initSonnetStream(httpServer, getAnthropicKey, verifyToken) {
  const wss = new WebSocketServer({ noServer: true });

  // Return the WSS so api.js can route upgrades to it
  wss.on('connection', (ws, req, userId) => {
    logger.info('SonnetStream connection', { userId });
    let currentSessionId = null;
    let preSessionBuffer = []; // Buffer transcripts that arrive before session_start
    const transcriptLimiter = createMessageRateLimiter(
      WS_RATE_LIMIT.maxTranscripts,
      WS_RATE_LIMIT.windowMs
    );

    // Keepalive: respond to pings (ws library handles pong automatically)
    // and send pings every 30s to prevent ALB idle timeout
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      try {
        switch (msg.type) {
          case 'session_start':
            await handleSessionStart(ws, userId, msg, getAnthropicKey);
            currentSessionId = msg.sessionId;
            // Replay any transcripts that arrived before session_start
            if (preSessionBuffer.length > 0) {
              logger.info('Replaying pre-session transcripts', { count: preSessionBuffer.length });
              const buffered = [...preSessionBuffer];
              preSessionBuffer.length = 0;
              for (const bufferedMsg of buffered) {
                await handleTranscript(ws, currentSessionId, bufferedMsg, preSessionBuffer);
              }
            }
            break;

          case 'transcript':
            if (!transcriptLimiter.check()) {
              logger.warn('WebSocket transcript rate limit exceeded', {
                userId,
                sessionId: currentSessionId,
              });
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Rate limit exceeded — too many transcript messages',
                  recoverable: false,
                })
              );
              ws.close(1008, 'Rate limit exceeded');
              return;
            }
            await handleTranscript(ws, currentSessionId, msg, preSessionBuffer);
            break;

          case 'job_state_update':
            if (currentSessionId && activeSessions.has(currentSessionId)) {
              activeSessions.get(currentSessionId).session.updateJobState(msg);
              // Trace which StateSnapshot the next Sonnet turn will see. Critical when
              // debugging "Sonnet asked about a circuit that's already on-screen" —
              // absence of this log after a CCU extraction means the iOS side never
              // fired `notifyJobStateChanged`.
              const circuitCount = Array.isArray(msg.circuits)
                ? msg.circuits.length
                : Array.isArray(msg?.boards)
                  ? msg.boards.reduce((n, b) => n + (b.circuits?.length || 0), 0)
                  : 0;
              logger.info('StateSnapshot refreshed', {
                sessionId: currentSessionId,
                reason: msg.reason || 'unspecified',
                circuitCount,
                boardCount: Array.isArray(msg?.boards) ? msg.boards.length : 0,
              });
            }
            break;

          // Client-side diagnostic piggy-backed on the reliable WebSocket channel.
          // Used by iOS to surface conditions that the multipart analytics upload
          // can't report (because the upload itself is failing). Logged at info so
          // CloudWatch Insights can query on category/payload.
          //
          // Categories currently in use:
          //   - analytics_backlog: pendingAnalyticsUploads, lastAnalyticsError
          //   - question_enqueued: type, field, circuit, questionPreview, queueDepth, source
          //   - inflight_anchored: type, questionPreview, queueDelayMs, queueDepth
          //   - inflight_anchor_missed: alertType, alertMessagePreview, pendingCount
          case 'client_diagnostic': {
            // Strip framing fields AND any server-authoritative keys the client
            // should never be able to set. Spreading `...payload` LAST would let
            // a crafted client message override userId / sessionId in CloudWatch
            // — not a current risk (iOS always writes them correctly) but an
            // audit-integrity hazard, so drop them from the payload before
            // merging.
            const {
              type: _ignored,
              category,
              timestamp,
              userId: _clientUserId,
              sessionId: _clientSessionId,
              ...payload
            } = msg;
            logger.info('Client diagnostic', {
              ...payload,
              category: category || 'unspecified',
              timestamp,
              userId,
              sessionId: currentSessionId,
            });
            break;
          }

          case 'correction':
            await handleCorrection(ws, currentSessionId, msg);
            break;

          case 'session_pause':
            if (currentSessionId && activeSessions.has(currentSessionId)) {
              const pauseEntry = activeSessions.get(currentSessionId);
              pauseEntry.session.pause();
              pauseEntry.pauseStartTime = Date.now();
              logger.info('Session paused (sleep/dozing)', {
                sessionId: currentSessionId,
                turns: pauseEntry.session.turnCount,
              });
              ws.send(JSON.stringify({ type: 'session_ack', status: 'paused' }));
            }
            break;

          case 'session_resume':
            // Wave 4c.5 (rehydrate-on-reconnect) vs. legacy (sleep/wake) are
            // disambiguated by the presence of `msg.sessionId` on the payload:
            //
            //   { type: 'session_resume', sessionId: '<uuid>' }   → rehydrate
            //   { type: 'session_resume' }                         → legacy wake
            //
            // The legacy wake path operates on an already-open socket that's
            // been paused by `session_pause`. It cannot carry a sessionId
            // because the iOS sleep/wake protocol predates Wave 4c.5 and has
            // no server-minted identifier to quote back. Keeping both paths
            // behind the one frame name preserves backward compatibility with
            // the iOS client during the rollout window.
            if (msg.sessionId) {
              const {
                sessionId: newSessionId,
                ack,
                activeEntryKey,
              } = handleSessionResumeRehydrate(ws, userId, msg.sessionId);
              currentSessionId = activeEntryKey;
              ws.send(JSON.stringify({ type: 'session_ack', ...ack, sessionId: newSessionId }));
            } else if (currentSessionId && activeSessions.has(currentSessionId)) {
              const resumeEntry = activeSessions.get(currentSessionId);
              resumeEntry.session.resume();
              const pauseDurationMs = resumeEntry.pauseStartTime
                ? Date.now() - resumeEntry.pauseStartTime
                : null;
              resumeEntry.pauseStartTime = null;
              logger.info('Session resumed (wake from sleep)', {
                sessionId: currentSessionId,
                pauseDurationMs,
                pauseDurationSec: pauseDurationMs ? Math.round(pauseDurationMs / 1000) : null,
                turns: resumeEntry.session.turnCount,
              });
              ws.send(JSON.stringify({ type: 'session_ack', status: 'resumed' }));
            }
            break;

          // Compaction removed — sliding window keeps context at ~14K tokens, well under
          // the old 60K threshold. Respond with ack so iOS clients don't hang.
          case 'session_compact':
            ws.send(
              JSON.stringify({
                type: 'session_ack',
                status: 'compact_skipped',
                reason: 'deprecated',
              })
            );
            break;

          case 'session_stop':
            await handleSessionStop(ws, currentSessionId);
            currentSessionId = null;
            break;

          // [voice-quality-sprint Stage 4] iOS barge-in telemetry. When the
          // on-device VAD cancels TTS mid-playback (inspector interrupted a
          // question), iOS sends this as analytics so we can tune the
          // probability/frames threshold from CloudWatch. There's no
          // server-side action required — the cancellation already happened
          // locally — but we MUST accept the message, otherwise the default
          // case below returns an error that iOS surfaces as a red banner
          // (exactly the bug Stage 4 shipped to TestFlight Build 272).
          case 'tts_cancelled_by_user':
            logger.info('Client TTS cancelled by user (barge-in)', {
              sessionId: currentSessionId,
              reason: msg.reason,
              vadProbability: msg.vad_probability,
            });
            break;

          // Stage 6 Phase 3 Plan 03-08 — iOS reply to a blocking ask_user.
          // Routes straight to the per-session PendingAsksRegistry created in
          // handleSessionStart. The registry (stage6-pending-asks-registry.js)
          // enforces Codex STG #3 strict ordering inside resolve():
          //   clearTimeout(timer) → Map.delete(id) → user resolve({...})
          // so a same-millisecond timeout cannot double-resolve. An unknown
          // tool_call_id silently returns resolved:false — this is the
          // reconnect / replay race (iOS answers twice after a dropped
          // socket). Emitting an error envelope would break legitimate
          // at-least-once clients; we only error on MALFORMED payloads.
          case 'ask_user_answered': {
            if (!currentSessionId || !activeSessions.has(currentSessionId)) {
              // No session = no registry to answer against. Silent drop is
              // correct here — the registry for this session either never
              // existed (mis-sequenced client) or was swept by a termination
              // path that already rejected the ask.
              break;
            }
            const entry = activeSessions.get(currentSessionId);
            if (typeof msg.tool_call_id !== 'string' || typeof msg.user_text !== 'string') {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'ask_user_answered requires tool_call_id + user_text',
                })
              );
              break;
            }

            // Plan 03-12 r11 BLOCK remediation — late-stop race guard for
            // ask_user_answered, mirroring the handleTranscript guard at
            // STT-10a (~line 1484). handleSessionStop sets
            // `entry.isStopping=true` BEFORE its first rejectAll pass and
            // then awaits flushUtteranceBuffer + S3 uploads + session_ack
            // before finally deleting the activeSessions entry. During
            // that window an ask_user_answered frame (iOS sent its reply
            // right as the inspector tapped Stop) can still find the
            // session present and call pendingAsks.resolve() — unblocking
            // the tool loop AFTER stop began. The blocked tool loop then
            // kicks off a fresh Sonnet turn / registers fresh tool_use
            // blocks past teardown, exactly the class of race that
            // STT-10a closed on the transcript channel.
            //
            // Fix: early-return if isStopping. No error envelope — the
            // client already requested stop, and the pending ask will be
            // (or was) resolved as session_stopped by the rejectAll
            // sweep. Silent drop is the intended semantics, matching
            // the transcript-drop behaviour at STT-10a.
            if (entry.isStopping) {
              logger.info('stage6.ask_user_answered_dropped_during_stop', {
                sessionId: currentSessionId,
                tool_call_id: msg.tool_call_id,
              });
              break;
            }

            // Plan 03-12 r8 MAJOR remediation — detect the REVERSE race
            // BEFORE sanitisation. r6 added the reverse-race guard but ran
            // it AFTER sanitiseUserText. If the duplicate answer frame
            // carried oversized (>8192 chars) or otherwise malformed text,
            // sanitisation threw, the server sent a hard error envelope,
            // and the ask was left pending until timeout — even though
            // the transcript half had already been extracted by the shadow
            // harness. The inspector perceives "TTS re-asks the question
            // I already answered" because the tool loop doesn't unblock
            // until the 60s timeout fires.
            //
            // Fix: compute alreadySeenAsTranscript FIRST. If already seen,
            // resolve with {answered:false, reason:'transcript_already_extracted'}
            // immediately — skip sanitisation entirely because the text is
            // NOT going to be forwarded to Sonnet (the reason-only payload
            // omits user_text). Bypassing sanitisation is safe here: the
            // text never leaves this function, and the already-extracted
            // transcript half went through its own (different) pipeline.
            //
            // If not seen, run sanitisation as before. A throw aborts with
            // the hard-error envelope — the caller's contract violation
            // must surface, and the ask remains pending until genuine
            // answer or timeout (acceptable: no prior extraction has
            // happened, so the question is still live).
            const anchoredAsTranscript =
              typeof msg.consumed_utterance_id === 'string' &&
              entry.seenTranscriptUtterances &&
              entry.seenTranscriptUtterances.has(msg.consumed_utterance_id);

            // r18 MAJOR#2 — content-anchor reverse-race check. When the
            // answer omits consumed_utterance_id (legacy clients) or
            // sends a malformed value, the fast-path Set lookup above
            // cannot fire. A separate content ledger
            // (entry.recentTranscripts) stamps the normalised text of
            // every extracted transcript with a short TTL; if the
            // sanitisable user_text matches (normalised equality), the
            // same utterance was already extracted through the
            // transcript channel and must NOT be re-exposed to Sonnet
            // via this ask's tool_result. Evict expired entries first
            // so stale ledger rows can't produce false positives after
            // a long pause. Match rule is equality on the normaliser
            // output (lowercase / strip non-alphanumerics / collapse
            // whitespace), NOT substring — mirrors the r16 design
            // rationale (short "three" vs "move to three").
            let alreadySeenByContent = false;
            let matchedContentEntry = null;
            if (!anchoredAsTranscript && typeof msg.user_text === 'string') {
              if (Array.isArray(entry.recentTranscripts) && entry.recentTranscripts.length > 0) {
                const nowTs = Date.now();
                entry.recentTranscripts = entry.recentTranscripts.filter(
                  (t) => t.expiresAt > nowTs,
                );
                if (entry.recentTranscripts.length > 0) {
                  const normalisedAnswer = normaliseForAskMatch(msg.user_text);
                  if (normalisedAnswer.length > 0) {
                    const matchIdx = entry.recentTranscripts.findIndex(
                      (t) => t.normalisedText === normalisedAnswer,
                    );
                    if (matchIdx >= 0) {
                      matchedContentEntry = entry.recentTranscripts.splice(matchIdx, 1)[0];
                      alreadySeenByContent = true;
                    }
                  }
                }
              }
            }
            const alreadySeenAsTranscript = anchoredAsTranscript || alreadySeenByContent;

            let resolvePayload;
            let sanitised = null;

            if (alreadySeenAsTranscript) {
              resolvePayload = {
                answered: false,
                reason: 'transcript_already_extracted',
              };
              logger.warn('stage6.ask_user_answered_after_transcript', {
                sessionId: currentSessionId,
                tool_call_id: msg.tool_call_id,
                utterance_id: msg.consumed_utterance_id || null,
                match_source: anchoredAsTranscript ? 'utterance_id' : 'content_anchor',
                matched_utterance_id: matchedContentEntry
                  ? matchedContentEntry.utteranceId
                  : null,
                reason: 'transcript_already_extracted',
              });
            } else {
              // Plan 03-10 Task 2 (STG MAJOR remediation) — sanitise
              // user_text before resolve/mark-consumed. Only runs in the
              // not-seen branch; see r8 block comment above for rationale.
              try {
                sanitised = sanitiseUserText(msg.user_text);
              } catch (sanErr) {
                logger.warn('stage6.user_text_rejected', {
                  sessionId: currentSessionId,
                  tool_call_id: msg.tool_call_id,
                  code: sanErr.code || 'sanitisation_error',
                  message: sanErr.message,
                });
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: `ask_user_answered rejected: ${sanErr.message}`,
                  })
                );
                break;
              }

              // Thread sanitisation flags through the resolve payload so the
              // dispatcher's logAskUser row carries them. Only emit the
              // sanitisation sub-object when at least one flag is true —
              // the common clean-path case (100% of current inspector speech)
              // keeps the log row noise-free.
              resolvePayload = {
                answered: true,
                user_text: sanitised.text,
              };
              if (sanitised.truncated || sanitised.stripped) {
                resolvePayload.sanitisation = {
                  truncated: sanitised.truncated,
                  stripped: sanitised.stripped,
                };
              }
            }

            const resolved = entry.pendingAsks.resolve(msg.tool_call_id, resolvePayload);

            // Plan 03-10 Task 1 (STG BLOCK remediation) — utterance-consumption
            // dedupe. iOS MUST stamp the inbound ask_user_answered with the
            // Deepgram utterance id (or other stable transcript anchor) that
            // produced the answer. We remember that id in a per-session FIFO
            // set so handleTranscript can suppress the same utterance if it
            // ALSO arrives through the normal transcript channel (which
            // happens routinely — iOS's Deepgram interim/final ordering +
            // server routing are not strictly synchronised; both frames can
            // cross the socket within milliseconds of each other).
            //
            // The add() is gated on resolved===true AND !alreadySeenAsTranscript.
            // Gating on resolved: an unknown / stale / duplicate tool_call_id
            // returns resolved=false; stamping would silently suppress a later
            // legitimate transcript carrying the same id. Gating on
            // !alreadySeenAsTranscript: in that branch the seenTranscriptUtterances
            // stamp already owns the id, and a redundant stamp would waste a
            // FIFO slot and read like a clean "iOS routed as answer first" case
            // in the audit log.
            //
            // Cap at CONSUMED_UTTERANCE_CAP via FIFO eviction. 256 is an
            // order of magnitude above the peak observed in a 120-minute
            // inspection session (~100 utterances).
            //
            // Legacy compat: if iOS omits consumed_utterance_id (pre-Plan
            // 03-10 clients), the ask still resolves — we just emit a
            // warning log row. Unresolved + id present (stale frame) logs
            // a distinct row so client-side bugs surface in CloudWatch
            // without polluting the dedupe Set.
            // r17 MAJOR remediation — narrow the dedupe-path trichotomy:
            //   (a) consumed_utterance_id is a non-empty string → anchored
            //       path (fast-path Set registration).
            //   (b) consumed_utterance_id is ABSENT (undefined) → legacy
            //       path (error log + content-anchor fallback).
            //   (c) consumed_utterance_id is PRESENT but not a non-empty
            //       string (number, object, null, empty string) → PROTOCOL
            //       ERROR. Warn loudly and fall through to the legacy path
            //       rather than silently treating as "untracked" (which
            //       hides shape bugs in the client).
            const hasAnchor =
              typeof msg.consumed_utterance_id === 'string' &&
              msg.consumed_utterance_id.length > 0;
            const hasMalformedAnchor =
              !hasAnchor && msg.consumed_utterance_id !== undefined;
            if (hasMalformedAnchor) {
              logger.warn('stage6.ask_user_answered_malformed_anchor', {
                sessionId: currentSessionId,
                tool_call_id: msg.tool_call_id,
                consumed_utterance_id_type: typeof msg.consumed_utterance_id,
                reason: 'consumed_utterance_id_present_but_not_nonempty_string',
              });
            }
            if (hasAnchor) {
              if (resolved && !alreadySeenAsTranscript) {
                entry.consumedAskUtterances.add(msg.consumed_utterance_id);
                if (entry.consumedAskUtterances.size > CONSUMED_UTTERANCE_CAP) {
                  // Set preserves insertion order — first key is the oldest.
                  const oldest = entry.consumedAskUtterances.values().next().value;
                  entry.consumedAskUtterances.delete(oldest);
                }
              } else if (!resolved) {
                logger.warn('stage6.ask_user_answered_unresolved', {
                  sessionId: currentSessionId,
                  tool_call_id: msg.tool_call_id,
                  utterance_id: msg.consumed_utterance_id,
                  reason: 'unknown_or_stale_tool_call_id',
                });
              }
            } else {
              // r15 MAJOR#2 → r16 MAJOR#1 remediation — legacy compat
              // clients that omit consumed_utterance_id cannot register
              // a fast-path anchor. Error-level log (distinct event
              // name) surfaces the regression in CloudWatch. Content
              // anchor pushed below covers the dedupe itself.
              logger.error('stage6.ask_user_answered_legacy_no_anchor', {
                sessionId: currentSessionId,
                tool_call_id: msg.tool_call_id,
                resolved,
                reason: 'missing_consumed_utterance_id',
                content_anchor_ttl_ms: resolved ? RECENT_ASK_ANSWER_TTL_MS : 0,
              });
            }

            // r16 MAJOR#1 + #2 remediation — content-anchor push. Every
            // resolved ask_user_answered (anchored OR legacy) pushes
            // the sanitised answer text into entry.recentAskAnswers.
            // handleTranscript consults this list AFTER the fast-path
            // Set miss; normalised-equality match suppresses + removes
            // the entry (one-shot). This catches:
            //   - legacy clients (no consumed_utterance_id at all)
            //   - mixed-mode clients where the ask stamps an id but
            //     the paired transcript frame omits utterance_id
            // Skip when alreadySeenAsTranscript — the transcript was
            // already extracted, no race left to defend against.
            if (resolved && !alreadySeenAsTranscript) {
              const anchorText = sanitised ? sanitised.text : resolvePayload.user_text;
              const normalised = normaliseForAskMatch(anchorText);
              if (normalised.length > 0) {
                if (!entry.recentAskAnswers) entry.recentAskAnswers = [];
                entry.recentAskAnswers.push({
                  normalisedText: normalised,
                  expiresAt: Date.now() + RECENT_ASK_ANSWER_TTL_MS,
                  toolCallId: msg.tool_call_id,
                });
                // FIFO cap (hard ceiling under pathological bursts).
                while (entry.recentAskAnswers.length > RECENT_ASK_ANSWER_CAP) {
                  entry.recentAskAnswers.shift();
                }
              }
            }

            logger.info('ask_user_answered received', {
              sessionId: currentSessionId,
              tool_call_id: msg.tool_call_id,
              resolved,
              // r8: sanitised is null on the reverse-race (already-seen)
              // branch because we skip sanitisation there. Absent flags on
              // that row are correct — there was no sanitisation pass to
              // record. Collapse to false on the seen branch rather than
              // null so the CloudWatch schema stays boolean-typed.
              sanitised_truncated: sanitised ? sanitised.truncated : false,
              sanitised_stripped: sanitised ? sanitised.stripped : false,
              already_seen_as_transcript: alreadySeenAsTranscript || false,
            });
            break;
          }

          default:
            ws.send(
              JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` })
            );
        }
      } catch (error) {
        logger.error('SonnetStream message handling error', {
          type: msg.type,
          error: error.message,
        });
        ws.send(JSON.stringify({ type: 'error', message: error.message, recoverable: true }));
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      logger.info('SonnetStream connection closed', { userId });
      if (currentSessionId && activeSessions.has(currentSessionId)) {
        // Clean up after 30s timeout (allow reconnection)
        const entry = activeSessions.get(currentSessionId);
        // DELIBERATE: 5-minute timeout (300s) to preserve conversation history across
        // Deepgram sleep/wake cycles. iOS disconnects the WebSocket during auto-sleep
        // (no audio for 60s) and reconnects when speech resumes. The original 30s timeout
        // was too short — inspectors frequently pause between circuits (putting down meter
        // probes, moving to next board) and would lose their entire extraction context.
        // 5 minutes covers the vast majority of between-circuit pauses without leaking
        // memory from abandoned sessions.
        entry.disconnectTimer = setTimeout(() => {
          logger.info('Session timed out, cleaning up', { sessionId: currentSessionId });
          // Stage 6 Phase 3 Plan 03-08 (Codex STG #3): release any in-flight
          // blocking ask_user Promises BEFORE the registry becomes unreachable
          // via activeSessions.delete. A post-delete ask resolution would be
          // a leak — the awaiting dispatcher would hang for the tool-loop's
          // full timeout (20s per STA-03) even though the session is gone.
          // rejectAll('session_terminated') wakes every pending ask with
          // {answered:false, reason:'session_terminated', wait_duration_ms}
          // so Sonnet can still terminate the turn gracefully.
          entry.pendingAsks.rejectAll('session_terminated');
          entry.questionGate.destroy();
          activeSessions.delete(currentSessionId);
        }, 300000);
      }
    });
  });

  async function handleSessionStart(ws, userId, msg, getAnthropicKey) {
    const { sessionId, jobId, jobState } = msg;
    if (!sessionId) throw new Error('sessionId required');

    // Reuse existing session if reconnecting (within 30s timeout or old ws still open)
    if (activeSessions.has(sessionId)) {
      const existing = activeSessions.get(sessionId);
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
      // Stage 6 Phase 3 Plan 03-08: release stale asks BEFORE re-binding the
      // socket. Any ask registered against the OLD ws would have its reply
      // routed through that (now orphaned) socket's inbound handler — which
      // has already fired `close`. Resolving with reason:'session_reconnected'
      // lets the awaiting dispatcher return a clean "user reconnected without
      // answering" outcome so Sonnet re-asks (or abandons) on the next turn.
      existing.pendingAsks.rejectAll('session_reconnected');
      // Plan 03-10 Task 1 — reconnect resets the consumedAskUtterances set.
      // Any utterance routed through the OLD ws is irrelevant to dedupe on
      // the NEW ws (the iOS client may retransmit unfinished state or start
      // fresh). Keeping stale ids would falsely suppress legitimate new
      // transcripts whose ids happen to collide.
      if (existing.consumedAskUtterances) existing.consumedAskUtterances.clear();
      else existing.consumedAskUtterances = new Set();
      // Plan 03-11 Task 1 — reset the reverse-race ledger too. Same rationale
      // as consumedAskUtterances: stale ids from the old ws should not bleed
      // into dedupe decisions on the new ws.
      if (existing.seenTranscriptUtterances) existing.seenTranscriptUtterances.clear();
      else existing.seenTranscriptUtterances = new Set();
      // r16 MAJOR#1 + #2 — clear the content-anchor list on reconnect.
      // Stale anchors could falsely suppress the first legitimate
      // transcript on the new ws.
      existing.recentAskAnswers = [];
      // r18 MAJOR#2 — clear reverse content ledger on reconnect for
      // the same reason.
      existing.recentTranscripts = [];
      // Update the ws reference and re-bind the question gate to new ws.
      // This preserves the Anthropic conversation history across reconnects.
      existing.ws = ws;
      existing.questionGate.destroy();
      existing.questionGate = new QuestionGate((questions) => {
        for (const q of questions) {
          if (ws.readyState === ws.OPEN) {
            // Rename Sonnet's question 'type' (unclear/orphaned/out_of_range) to
            // 'question_type' so it doesn't overwrite the WS message type: 'question'
            const { type: questionType, ...rest } = q;
            ws.send(JSON.stringify({ type: 'question', question_type: questionType, ...rest }));
          }
        }
      }, sessionId);
      // Update job state if provided (iOS may have new data since last connect)
      if (jobState) {
        existing.session.updateJobState(jobState);
      }
      // Mirror the started/resumed paths: include the rehydration sessionId
      // so the client can keep using `session_resume` later. The reconnect
      // branch predates Wave 4c.5 but there's no harm in emitting the token
      // here too — clients that ignore the field behave exactly as before.
      ws.send(
        JSON.stringify({
          type: 'session_ack',
          status: 'reconnected',
          sessionId: existing.rehydrateSessionId || null,
        })
      );
      // Flush any extraction results that were buffered while the socket was disconnected
      flushPendingExtractions(ws, existing, sessionId);
      logger.info('Session reconnected', { sessionId, turns: existing.session.turnCount });
      return;
    }

    const apiKey = await getAnthropicKey();
    if (!apiKey) throw new Error('Anthropic API key not available');

    const certType = jobState?.certificateType || 'eicr';
    const session = new EICRExtractionSession(apiKey, sessionId, certType);
    logger.info('Session using prompt', { sessionId, certType });
    const questionGate = new QuestionGate((questions) => {
      // Send gated questions to iOS
      for (const q of questions) {
        if (ws.readyState === ws.OPEN) {
          // Rename Sonnet's question 'type' (unclear/orphaned/out_of_range) to
          // 'question_type' so it doesn't overwrite the WS message type: 'question'
          const { type: questionType, ...rest } = q;
          ws.send(JSON.stringify({ type: 'question', question_type: questionType, ...rest }));
        }
      }
    }, sessionId);

    // Set up batch flush callback — when the batch timeout fires asynchronously,
    // this delivers the extraction result to iOS the same way handleTranscript does.
    session.onBatchResult = (result) => {
      try {
        validateAndCorrectFields(result, sessionId);
        const entryRef = activeSessions.get(sessionId);
        const currentWs = entryRef?.ws || ws;
        if (currentWs.readyState === currentWs.OPEN) {
          const {
            questions_for_user,
            extracted_readings,
            spoken_response,
            action,
            observationUpdates,
            ...rest
          } = result;
          const resultWithoutQuestions = { readings: extracted_readings, ...rest };
          currentWs.send(JSON.stringify({ type: 'extraction', result: resultWithoutQuestions }));

          // Phase A: RULE 6 correction edits (same or similar text, new code)
          // arrive classified by EICRExtractionSession into observationUpdates.
          // Dispatch them immediately so iOS can patch the existing rows —
          // these are NOT fed into refineObservationsAsync because the code is
          // already set by the inspector; a web search would override it.
          dispatchObservationUpdates(currentWs, sessionId, observationUpdates);

          // Mirror the live-transcript path: fire BPG4 refinement for any new
          // observations so the code/regulation gets upgraded even when the
          // result came from the batch flush rather than the direct handler.
          if (Array.isArray(result.observations) && result.observations.length > 0 && entryRef) {
            refineObservationsAsync(entryRef, sessionId, result.observations).catch((err) => {
              logger.warn('refineObservationsAsync unhandled (batch)', {
                sessionId,
                error: err?.message,
              });
            });
          }

          // Forward voice command response from batch extraction (same as handleTranscript)
          if (spoken_response || action) {
            currentWs.send(
              JSON.stringify({
                type: 'voice_command_response',
                understood: true,
                spoken_response: spoken_response || '',
                action: action || null,
              })
            );
          }
          currentWs.send(JSON.stringify(session.costTracker.toCostUpdate()));
        } else if (entryRef) {
          // Buffer extraction results when WebSocket not OPEN — flushed on reconnect
          entryRef.pendingExtractions.push(result);
          logger.info('Extraction buffered (socket not open)', {
            sessionId,
            readings: (result.extracted_readings || []).length,
            buffered: entryRef.pendingExtractions.length,
          });
        }
        // Mirror the sync-path "Extraction result" log so batched turns are
        // visible in CloudWatch Insights. Without this, the only way to see a
        // batched extraction was the "Turn N cost" line, which doesn't carry
        // question/reading counts — making triage of gate-resolution bugs
        // (like the 14 Chichester postcode double-ask) much harder.
        logger.info('Extraction result', {
          sessionId,
          path: 'onBatchResult',
          readings: (result.extracted_readings || []).length,
          questions: (result.questions_for_user || []).length,
          observations: Array.isArray(result.observations) ? result.observations.length : 0,
          // Include a preview of up to the first two questions so we can trace
          // Sonnet's wording in CloudWatch without needing the iOS debug-log
          // upload (which is currently broken — see MEMORY.md). Paired with
          // the QuestionGate "Flushing questions to iOS" log + the keys.js
          // "ElevenLabs TTS success" log, this reconstructs the full
          // Sonnet-question -> TTS-text chain per session.
          questionsPreview: Array.isArray(result.questions_for_user)
            ? result.questions_for_user.slice(0, 2).map((q) => ({
                type: q.type || null,
                field: q.field || null,
                circuit: q.circuit === null || q.circuit === undefined ? null : q.circuit,
                questionPreview: typeof q.question === 'string' ? q.question.slice(0, 120) : null,
              }))
            : [],
        });
        // Order matters: resolve BEFORE enqueue.
        //
        // resolveByFields clears any PRIOR-turn pending questions whose field
        // matches a reading we extracted this turn. enqueue adds THIS turn's
        // new questions to the gate.
        //
        // If we enqueued first and then resolved, Sonnet's same-turn question
        // about a reading it just extracted (e.g. "that's only half a postcode,
        // what's the rest?" emitted alongside an extracted_readings entry for
        // postcode) would be immediately cancelled by the install-field
        // wildcard in resolveByFields. That's exactly what happened with the
        // partial "RG30" postcode in session 6C475A3F — Sonnet flagged it and
        // asked, but the gate dropped the question in the same millisecond.
        //
        // By resolving first, same-turn questions survive: Sonnet's in-turn
        // judgement is trusted across all fields (not just postcode), which
        // mirrors how extraction worked before the install-field wildcard
        // landed in 5f8a236 / 93eb9a2. Cross-turn resolution still works
        // because the next turn's readings resolve this turn's pending Qs.
        const resolvedFieldsBatch =
          result.extracted_readings && result.extracted_readings.length > 0
            ? new Set(result.extracted_readings.map((r) => `${r.field}:${r.circuit}`))
            : new Set();
        if (resolvedFieldsBatch.size > 0) {
          questionGate.resolveByFields(resolvedFieldsBatch);
        }
        if (result.questions_for_user && result.questions_for_user.length > 0) {
          // Stage 5: drop questions whose slot is already filled in the
          // session's stateSnapshot (see filterQuestionsAgainstFilledSlots
          // docstring for the F21934D4 reproducer and same-turn protection).
          const filteredBatch = filterQuestionsAgainstFilledSlots(
            result.questions_for_user,
            session.stateSnapshot,
            resolvedFieldsBatch,
            sessionId
          );
          if (filteredBatch.length > 0) {
            questionGate.enqueue(filteredBatch);
          }
        }
        // Drop pending observation_* / field-less unclear questions when Sonnet
        // has just extracted an observation — resolveByFields can't do this
        // because observations carry field=null/circuit=null.
        if (Array.isArray(result.observations) && result.observations.length > 0) {
          // Phase D: pass the observations array (not a count) so the gate can
          // keep unrelated prior-turn obs questions — it only drops questions
          // whose heard_value overlaps with one of the new observations.
          questionGate.resolveObservationQuestions(result.observations);
        }
      } catch (err) {
        logger.error('Batch flush callback error', { sessionId, error: err.message });
      }
    };

    session.start(jobState);

    // Extract job address from jobState for cost tracking
    const jobAddress =
      jobState?.address ||
      jobState?.installationDetails?.address ||
      jobState?.installation_details?.address ||
      null;

    // Wave 4c.5: mint a server-side rehydration sessionId so the client can
    // issue `session_resume { sessionId }` after a dropped WebSocket. The
    // stored payload only needs to reference the `activeSessions` entry —
    // the full multi-turn Sonnet context lives on `session.messages` inside
    // that entry and is rebound on rehydrate. Storing metadata only keeps
    // the store entries small (~100 bytes) so the LRU cap is cheap.
    const rehydrateSessionId = sonnetSessionStore.create(userId, {
      clientSessionId: sessionId,
      jobId: jobId || null,
      certType,
    });

    activeSessions.set(sessionId, {
      session,
      questionGate,
      ws,
      userId,
      jobId,
      jobAddress,
      certType,
      lastRegexResults: [],
      isExtracting: false,
      pendingTranscripts: [],
      pendingExtractions: [],
      // Phase C #8: refinements in flight when the socket drops — re-kicked
      // on reconnect via replayPendingRefinements(). Maps observation_id →
      // { obs, refined?, attemptedAt }. If `refined` is cached, the replay
      // skips the search and sends the existing result directly.
      pendingRefinements: new Map(),
      // Phase C #5 short-TTL dedupe: observation_ids whose refinement was
      // successfully sent in the last 2s. Reconnect replays must not re-fire
      // these, and refineObservationsAsync checks it before each search call.
      recentlyRefinedIds: new Map(),
      rehydrateSessionId,
      // Stage 6 Phase 3 Plan 03-08 — per-session blocking-ask registry.
      // Lifetime === activeSessions entry lifetime; NOT recreated per turn.
      // Owned exclusively by the dispatcher (creates/registers) + the
      // classifier/inbound-router (resolves) + the termination paths
      // (rejectAll). stage6-pending-asks-registry.js enforces Codex STG #3
      // strict ordering inside every resolution path.
      pendingAsks: createPendingAsksRegistry(),
      // Plan 03-10 Task 1 — FIFO set of Deepgram utterance ids that iOS has
      // already routed as ask_user_answered payloads. handleTranscript checks
      // this BEFORE invoking runShadowHarness so the same utterance doesn't
      // get extracted twice (once via ask tool_result, once via normal
      // extraction). Bounded at CONSUMED_UTTERANCE_CAP; oldest entries evict
      // FIFO so a long-running session doesn't leak the set.
      consumedAskUtterances: new Set(),
      // Plan 03-11 Task 1 (STG r3 BLOCK) — companion FIFO set for the REVERSE
      // race. The 03-10 dedupe is one-sided: it only catches the "answer
      // first, then transcript" order. If the transcript arrives FIRST (e.g.
      // iOS buffers the ask_user_answered behind the transcript, or the
      // network reorders frames during a reconnect), the speech gets fully
      // extracted as a normal turn — and then ask_user_answered arrives with
      // no dedupe signal left to flip. This set records every transcript
      // utterance_id the server has already processed, so the
      // ask_user_answered handler can detect the race and emit a
      // `stage6.ask_user_answered_after_transcript` warn log for ops.
      // Same FIFO cap as consumedAskUtterances — the two ledgers are
      // symmetric.
      seenTranscriptUtterances: new Set(),
      // r16 MAJOR#1 + #2 — content-match fallback dedupe. FIFO list of
      // {normalisedText, expiresAt, toolCallId} pushed on every
      // resolved ask_user_answered. handleTranscript evicts expired
      // and removes any entry whose normalised text equals the
      // transcript's (one-shot per answer). Covers the fast-path Set's
      // blind spots: legacy clients (no consumed_utterance_id) and
      // mixed-mode clients (answer-id set, transcript-id omitted).
      recentAskAnswers: [],
      // r18 MAJOR#2 — mirror of recentAskAnswers for the REVERSE
      // direction. Every stamped transcript (stampSeenTranscript) also
      // pushes its normalised text into this FIFO list. The
      // ask_user_answered handler consults it whenever the answer
      // arrives WITHOUT a consumed_utterance_id anchor (legacy or
      // malformed clients); a content-equality hit means the same
      // speech was already extracted through the transcript channel,
      // so the ask must resolve with {answered:false,
      // reason:'transcript_already_extracted'} rather than re-exposing
      // it to Sonnet as a tool_result. Same TTL + CAP as the forward
      // direction for symmetry.
      recentTranscripts: [],
    });

    ws.send(
      JSON.stringify({ type: 'session_ack', status: 'started', sessionId: rehydrateSessionId })
    );
    logger.info('Session started', {
      sessionId,
      rehydrateSessionId,
      jobId,
      jobAddress,
      certType,
    });
  }

  /**
   * Wave 4c.5 rehydrate path. Returns the ack payload fields for the caller
   * to wrap into the outgoing `session_ack` frame, plus the `activeSessions`
   * key the connection should track going forward. Never throws — an
   * unknown / expired / wrong-user token all degrade to a fresh session_ack
   * so the client can start over without a separate error channel.
   *
   * The caller is responsible for:
   *   - sending the frame
   *   - setting `currentSessionId` to `activeEntryKey`
   *
   * On a successful rehydrate we also rebind `entry.ws` and `entry.questionGate`
   * to the new socket, the same shape as `handleSessionStart`'s reconnection
   * branch does, so extraction callbacks target the live socket.
   */
  function handleSessionResumeRehydrate(ws, userId, requestedSessionId) {
    const stored = sonnetSessionStore.resume(requestedSessionId, userId);

    // Miss → mint a fresh rehydration token with no underlying entry. The
    // client will treat this as a brand-new session and follow up with
    // `session_start` on its next transcript. We don't pre-create the
    // runtime state here because we don't yet know the jobId / jobState
    // the client will want bound — those arrive with session_start.
    if (!stored) {
      logger.info('session_resume miss — returning fresh session_ack', {
        userId,
        requestedSessionId,
      });
      // No entry minted yet; return status=new with no sessionId so the
      // client knows rehydration failed and must send session_start.
      return { sessionId: null, ack: { status: 'new' }, activeEntryKey: null };
    }

    const { clientSessionId } = stored;
    const entry = activeSessions.get(clientSessionId);

    // TTL-valid store hit but the runtime entry is gone (e.g. the 5-min
    // disconnectTimer fired and cleaned up activeSessions, but the store
    // entry was also ~5 min old so we're on the TTL boundary). Treat as
    // a miss — no context to rehydrate.
    if (!entry) {
      logger.info('session_resume store hit but activeSessions entry missing', {
        userId,
        requestedSessionId,
        clientSessionId,
      });
      sonnetSessionStore.remove(requestedSessionId);
      return { sessionId: null, ack: { status: 'new' }, activeEntryKey: null };
    }

    // Cancel any pending disconnect timer — we're live again.
    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
    }

    // Stage 6 Phase 3 Plan 03-08 (Rule-3 extension): Wave 4c.5 rehydrate is
    // structurally the same as handleSessionStart's reconnect branch — a new
    // ws replaces an old one on an existing activeSessions entry. Applying
    // the same rejectAll('session_reconnected') here keeps the invariant
    // "any ws-rebind drains stale asks" universal across the TWO reconnect
    // surfaces (plan only enumerates handleSessionStart's; this path was
    // introduced after the plan's Research phase). Deferring to Plan 03-08's
    // decision log as a deviation (Rule 3 — keeps the Promise-lifecycle
    // invariant tight).
    entry.pendingAsks.rejectAll('session_reconnected');
    // Plan 03-10 Task 1 — mirror the handleSessionStart reconnect branch:
    // drop any stale consumed-utterance ids on socket swap.
    if (entry.consumedAskUtterances) entry.consumedAskUtterances.clear();
    else entry.consumedAskUtterances = new Set();
    // Plan 03-11 Task 1 — mirror for the reverse-race ledger.
    if (entry.seenTranscriptUtterances) entry.seenTranscriptUtterances.clear();
    else entry.seenTranscriptUtterances = new Set();
    // r16 MAJOR#1 + #2 — clear the content-anchor list on session_resume.
    entry.recentAskAnswers = [];
    // r18 MAJOR#2 — clear reverse content ledger on session_resume.
    entry.recentTranscripts = [];

    // Rebind the socket + questionGate callback to the new WS, matching the
    // handleSessionStart reconnection branch. This preserves the Anthropic
    // conversation history (lives on entry.session.messages).
    entry.ws = ws;
    entry.questionGate.destroy();
    entry.questionGate = new QuestionGate((questions) => {
      for (const q of questions) {
        if (ws.readyState === ws.OPEN) {
          const { type: questionType, ...rest } = q;
          ws.send(JSON.stringify({ type: 'question', question_type: questionType, ...rest }));
        }
      }
    }, clientSessionId);

    // Flush any extraction results that were buffered while the socket was
    // disconnected — same path as handleSessionStart's reconnect branch.
    flushPendingExtractions(ws, entry, clientSessionId);

    logger.info('session_resume rehydrated', {
      userId,
      requestedSessionId,
      clientSessionId,
      turns: entry.session.turnCount,
    });

    return {
      sessionId: requestedSessionId,
      ack: { status: 'resumed' },
      activeEntryKey: clientSessionId,
    };
  }

  function flushPendingExtractions(ws, entry, sessionId) {
    if (entry.pendingExtractions.length) {
      const buffered = [...entry.pendingExtractions];
      entry.pendingExtractions.length = 0;
      logger.info('Flushing pending extractions on reconnect', {
        sessionId,
        count: buffered.length,
      });
      for (const result of buffered) {
        try {
          const { questions_for_user, extracted_readings, observationUpdates, ...rest } = result;
          const resultWithoutQuestions = { readings: extracted_readings, ...rest };
          ws.send(JSON.stringify({ type: 'extraction', result: resultWithoutQuestions }));
          // Phase A: if the buffered extraction carried RULE 6 correction edits,
          // replay them on the restored socket so iOS doesn't miss the patch.
          dispatchObservationUpdates(ws, sessionId, observationUpdates);
        } catch (err) {
          logger.error('Failed to flush buffered extraction', { sessionId, error: err.message });
        }
      }
      // Send current cost update after flushing all buffered extractions
      try {
        ws.send(JSON.stringify(entry.session.costTracker.toCostUpdate()));
      } catch (err) {
        logger.error('Failed to send cost update after flush', { sessionId, error: err.message });
      }
    }
    // Phase C #5/#8: re-kick any in-flight observation refinements whose
    // `observation_update` never reached iOS before the socket dropped. Fire
    // and forget — cached refinements send directly, otherwise a fresh search
    // is enqueued. Runs unconditionally (independent of pendingExtractions)
    // because a refinement can be pending even with zero buffered extractions
    // (e.g. batch already flushed, refinement still awaiting BPG4).
    if (entry.pendingRefinements && entry.pendingRefinements.size > 0) {
      replayPendingRefinements(entry, sessionId).catch((err) => {
        logger.warn('replayPendingRefinements unhandled', {
          sessionId,
          error: err?.message,
        });
      });
    }
  }

  async function handleTranscript(ws, sessionId, msg) {
    if (!sessionId || !activeSessions.has(sessionId)) {
      logger.warn('Transcript received but no active session', { sessionId: sessionId || null });
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'No active session — reconnecting',
          recoverable: true,
        })
      );
      return;
    }

    const entry = activeSessions.get(sessionId);

    // Plan 03-12 STT-10a (STG r5 BLOCK remediation) — late-stop race guard.
    // handleSessionStop sets entry.isStopping=true before its first rejectAll
    // pass, then awaits flushUtteranceBuffer + S3 uploads + session_ack emit
    // before finally deleting the activeSessions entry. During that window,
    // transcript frames that slip through the pipe can still find the session
    // present (activeSessions.has === true), run the shadow harness, and
    // register fresh ask_user tool calls via the dispatcher — orphaning the
    // ask past session teardown. Early-returning here prevents that class of
    // race. We don't emit an error envelope: the iOS client has already
    // asked to stop, and a "No active session" notice would just confuse
    // the UX. Silent drop is the intended semantics.
    if (entry.isStopping) {
      logger.info('stage6.transcript_dropped_during_stop', {
        sessionId,
        hasText: typeof msg.text === 'string' && msg.text.trim().length > 0,
      });
      return;
    }

    // Plan 03-10 Task 1 (STG BLOCK remediation) — utterance-consumption
    // dedupe. If this transcript carries a utterance_id that iOS already
    // routed as an ask_user_answered payload, drop it silently. Sonnet
    // already received the answer through the ask tool_result body; running
    // extraction over the same speech would produce duplicate readings /
    // observations and double-charge the Anthropic turn. Guard placed BEFORE
    // questionGate.onNewUtterance() + isExtracting gating because those
    // side-effects (rate counter + queue slot) must not fire for a
    // suppressed utterance either.
    if (
      typeof msg.utterance_id === 'string' &&
      entry.consumedAskUtterances &&
      entry.consumedAskUtterances.has(msg.utterance_id)
    ) {
      logger.info('stage6.transcript_suppressed', {
        sessionId,
        utterance_id: msg.utterance_id,
        reason: 'answered_ask',
      });
      return;
    }

    // r16 MAJOR#1 + #2 remediation — content-anchor fallback dedupe.
    // Catches two cases the fast-path consumedAskUtterances Set cannot:
    //   MAJOR#1 — legacy client with no consumed_utterance_id on the
    //             answer side means no Set entry to match against.
    //   MAJOR#2 — mixed-mode client stamps consumed_utterance_id on the
    //             answer but omits utterance_id on the paired
    //             transcript, so the Set lookup (keyed on transcript's
    //             id) fails.
    // Both collapse into: is there a recent ASK ANSWER whose normalised
    // text equals this transcript's normalised text? If yes, this
    // transcript IS the answering utterance → suppress and remove the
    // matched anchor (one-shot). Expired anchors are evicted first.
    // Normalised equality (not substring/overlap) avoids false-positive
    // suppression of unrelated speech that happens to contain the
    // answer text as a substring (e.g. "move to three" vs ask-answer
    // "three").
    if (Array.isArray(entry.recentAskAnswers) && entry.recentAskAnswers.length > 0) {
      const nowTs = Date.now();
      // Evict expired in-place.
      entry.recentAskAnswers = entry.recentAskAnswers.filter((a) => a.expiresAt > nowTs);
      if (entry.recentAskAnswers.length > 0) {
        const normalisedMsg = normaliseForAskMatch(msg.text);
        if (normalisedMsg.length > 0) {
          const matchIdx = entry.recentAskAnswers.findIndex(
            (a) => a.normalisedText === normalisedMsg,
          );
          if (matchIdx >= 0) {
            const matched = entry.recentAskAnswers.splice(matchIdx, 1)[0];
            logger.warn('stage6.transcript_suppressed_content_anchor', {
              sessionId,
              utterance_id: typeof msg.utterance_id === 'string' ? msg.utterance_id : null,
              matched_tool_call_id: matched.toolCallId,
              ttl_remaining_ms: matched.expiresAt - nowTs,
              reason: 'content_anchor_match',
            });
            return;
          }
        }
      }
    }

    // Plan 03-11 Task 1 (STG r3 BLOCK) / Plan 03-12 r13 Codex MAJOR —
    // stamping of seenTranscriptUtterances happens at the point where this
    // transcript is ACTUALLY committed to extraction (or ask-resolution),
    // not at top-of-handler. Placing the stamp earlier meant deferred
    // paths (user_moved_on defer at ~L1848, the isExtracting queue at
    // ~L1562) would falsely tell the ask_user_answered handler
    // "transcript already extracted" for an utterance that was only
    // QUEUED. The helper below is invoked from the two commit points:
    //   (a) answers-verdict success — after registry.resolve(), before
    //       the early-return at ~L1797. The ask channel carried the
    //       transcript's text to Sonnet as tool_result; any later
    //       ask_user_answered for this utterance_id MUST downgrade.
    //   (b) the fall-through path, immediately before the runShadowHarness
    //       `await` at ~L1854. That stamp lives before the single yield
    //       point in this function, so a synchronous ask_user_answered
    //       frame interleaving across the yield still sees the stamp.
    // Bounded by CONSUMED_UTTERANCE_CAP / FIFO for the same reasons as
    // consumedAskUtterances.
    const stampSeenTranscript = () => {
      // Fast-path Set (anchored on utterance_id).
      if (typeof msg.utterance_id === 'string') {
        if (!entry.seenTranscriptUtterances) entry.seenTranscriptUtterances = new Set();
        entry.seenTranscriptUtterances.add(msg.utterance_id);
        if (entry.seenTranscriptUtterances.size > CONSUMED_UTTERANCE_CAP) {
          const oldest = entry.seenTranscriptUtterances.values().next().value;
          entry.seenTranscriptUtterances.delete(oldest);
        }
      }

      // r18 MAJOR#2 — content-anchor push. Every transcript committed to
      // extraction (answers-verdict success OR fall-through to shadow
      // harness) pushes its normalised text into entry.recentTranscripts
      // so a LEGACY ask_user_answered (no consumed_utterance_id) arriving
      // AFTER the transcript has already been extracted can detect the
      // reverse race by content equality and resolve with
      // {answered:false, reason:'transcript_already_extracted'} instead
      // of double-exposing the same speech to Sonnet. Always push —
      // unlike the Set, we don't need a valid utterance_id; the whole
      // point of this ledger is to cover utterance_id-less clients on
      // BOTH sides. TTL + CAP bound memory under STA-01.
      if (typeof msg.text === 'string') {
        const normalised = normaliseForAskMatch(msg.text);
        if (normalised.length > 0) {
          if (!Array.isArray(entry.recentTranscripts)) entry.recentTranscripts = [];
          entry.recentTranscripts.push({
            normalisedText: normalised,
            expiresAt: Date.now() + RECENT_ASK_ANSWER_TTL_MS,
            utteranceId: typeof msg.utterance_id === 'string' ? msg.utterance_id : null,
          });
          while (entry.recentTranscripts.length > RECENT_ASK_ANSWER_CAP) {
            entry.recentTranscripts.shift();
          }
        }
      }
    };

    // Plan 03-12 r13 Codex MINOR — suppress questionGate.onNewUtterance()
    // on the drained re-entry of a deferred user_moved_on transcript.
    // Without this, the same utterance ticks the gate twice (once on
    // first entry before the defer, once on drain re-entry), which
    // inflates the gate's rolling-window counters and can erroneously
    // trip rate limits. The drain sets msg._drainedRetry=true on the
    // queued payload; first-entry callers never set it.
    if (!msg._drainedRetry) {
      entry.questionGate.onNewUtterance();
    }

    // If already extracting, queue this transcript individually.
    //
    // r17 BLOCK remediation — preserve the full original message shape
    // (utterance_id, in_response_to, confirmations_enabled, regex
    // results) on the queued payload. The previous shape dropped
    // everything except text+regexResults, which meant:
    //   * drain re-entry couldn't consult consumedAskUtterances or
    //     seenTranscriptUtterances (utterance_id gone)
    //   * r16 content-anchor path still worked (uses msg.text) but
    //     the fast-path Set lookup silently missed on replay
    //   * in_response_to TTS-question context was lost on replay, so
    //     Sonnet re-interpreted "yes"/"code 2" style replies without
    //     the preceding prompt
    // Spread the full msg so the replay re-runs handleTranscript with
    // the original metadata; the regexResults || lastRegexResults
    // fallback is re-applied inside that re-entry.
    if (entry.isExtracting) {
      entry.pendingTranscripts.push({ ...msg });
      return;
    }

    entry.isExtracting = true;
    const extractionWatchdog = setTimeout(() => {
      if (entry.isExtracting) {
        console.warn('[Watchdog] isExtracting stuck for 30s, force-resetting');
        entry.isExtracting = false;
      }
    }, 30000);

    try {
      // If the iOS client tagged this transcript with `in_response_to`, prepend
      // the TTS question context so Sonnet can interpret replies like "yes",
      // "code 2", or "FI" that only make sense alongside the preceding prompt.
      // We inline this as a bracketed note — it stays in the conversation
      // history and helps future turns too.
      let transcriptText = msg.text;
      if (
        msg.in_response_to &&
        typeof msg.in_response_to === 'object' &&
        msg.in_response_to.question
      ) {
        // Escape the question via JSON.stringify to preserve quoting and neutralise
        // any stray `"` or newlines — untrusted client can otherwise close the
        // enclosing literal early or inject a new `[...]` bracketed note that
        // Sonnet would treat as another system directive. JSON.stringify returns
        // a quoted string already, so we drop our manual quotes.
        const rawQ = String(msg.in_response_to.question).slice(0, 200);
        const qJson = JSON.stringify(rawQ);
        // Whitelist `type` against the known question-type vocabulary. Unknown
        // values are dropped rather than passed through so a malicious client
        // can't smuggle e.g. `type: "x\nIGNORE PREVIOUS INSTRUCTIONS"` into the
        // Sonnet user turn. Keep the set in sync with QuestionGate and Sonnet
        // prompt's allowed `question.type` values.
        const ALLOWED_QUESTION_TYPES = new Set([
          'observation_confirmation',
          'observation_code',
          'observation_unclear',
          'unclear',
          'clarify',
          'out_of_range',
          'orphaned',
          'tt_confirmation',
          'voice_command',
        ]);
        const rawType = typeof msg.in_response_to.type === 'string' ? msg.in_response_to.type : '';
        const safeType = ALLOWED_QUESTION_TYPES.has(rawType) ? rawType : null;
        const qType = safeType ? ` type=${safeType}` : '';
        transcriptText = `[In response to TTS question${qType}: ${qJson}] ${msg.text}`;
        logger.info('Transcript annotated with in_response_to', {
          sessionId,
          qType: safeType || 'unknown',
          qTypeDropped: rawType && !safeType ? rawType.slice(0, 40) : undefined,
          qPreview: rawQ.slice(0, 60),
        });
      }

      logger.info('Extracting from transcript', {
        sessionId,
        textPreview: transcriptText.substring(0, 80),
      });
      const regexResults = msg.regexResults || entry.lastRegexResults || [];

      // Stage 6 Phase 3 Plan 03-08 — overtake detection BEFORE shadow-harness
      // dispatch. When there ARE pending blocking asks, classifyOvertake
      // (stage6-overtake-classifier.js, STA-04) reads the utterance's regex
      // hits against the registry and returns one of three verdicts:
      //
      //   'answers'       → the utterance contains a (field, circuit) that
      //                     matches a pending ask's context. We resolve that
      //                     specific ask with the new transcript as its
      //                     user_text. Plan 03-11 Task 3 (STG r4 BLOCK):
      //                     we then RETURN — skip the shadow harness —
      //                     because the tool_result flowing through the
      //                     ask dispatcher already carries the speech to
      //                     Sonnet. Running runShadowHarness on the same
      //                     utterance would double-expose: Sonnet would
      //                     see the reply once as tool_result and once as
      //                     a fresh user turn, producing duplicate writes
      //                     or spurious follow-up asks.
      //   'user_moved_on' → the utterance carries regex hits that do NOT
      //                     match any pending ask, OR has no regex hits at
      //                     all (Open Question #4 fail-safe). We rejectAll
      //                     to drain stale asks so the dispatcher returns
      //                     `{answered:false, reason:'user_moved_on'}` and
      //                     Sonnet decides whether to re-ask next turn.
      //                     We FALL THROUGH here — the new utterance IS a
      //                     fresh user message (user changed topic), so
      //                     the shadow harness should process it.
      //   'no_pending_asks' → empty registry; no-op.
      //
      // We short-circuit the classifier call when the registry is empty so
      // the hot path (most turns) pays zero cost. The classifier itself is
      // pure — safe to call every turn — but the guard keeps the CloudWatch
      // noise floor clean.
      //
      // Plan 03-11 Task 3 — MAJOR remediation: classify against the RAW
      // `msg.text`, NOT the `[In response to TTS question]`-annotated
      // `transcriptText`. The annotation is only for Sonnet's turn context;
      // the classifier's shape-aware no-regex branch compares against a
      // yes/no vocabulary (STA-04c) and against "non-empty trimmed text"
      // for free_text asks. Prefixing "[In response to ...]" would turn a
      // plain "yes" into a multi-word string that fails the yes/no match
      // and turn an empty free_text answer into a non-empty one. Using
      // raw msg.text keeps the classifier's shape branch doing what it's
      // tested to do.
      if (entry.pendingAsks.size > 0) {
        const verdict = classifyOvertake(msg.text, regexResults, entry.pendingAsks);
        if (verdict.kind === 'answers') {
          // Plan 03-11 Task 3 — MAJOR remediation: sanitise verdict.userText
          // before resolve(). Without this, a transcript-routed ask answer
          // bypasses the cap + C0/DEL strip that the ask_user_answered
          // handler applies (sonnet-stream.js:815), and the unsanitised
          // text flows verbatim into both the `stage6.ask_user` log row
          // AND the dispatcher's tool_result body — defeating the hygiene
          // guarantee Plan 03-10 Task 2 added for the explicit-answer
          // channel. Mirror that handler's structure: try → on throw log
          // `stage6.user_text_rejected` + resolve with `{answered:false,
          // reason:'validation_error'}` so the awaiting dispatcher returns
          // a normal error envelope to Sonnet.
          let sanitised = null;
          let sanitisationFailed = false;
          try {
            sanitised = sanitiseUserText(verdict.userText);
          } catch (sanErr) {
            sanitisationFailed = true;
            logger.warn('stage6.user_text_rejected', {
              sessionId,
              tool_call_id: verdict.toolCallId,
              source: 'transcript_overtake',
              code: sanErr.code || 'sanitisation_error',
              message: sanErr.message,
            });
            const resolvedValidationError = entry.pendingAsks.resolve(verdict.toolCallId, {
              answered: false,
              reason: 'validation_error',
            });
            if (!resolvedValidationError) {
              // Plan 03-12 r7 MAJOR remediation — resolve() returns false
              // when the tool_call_id is unknown (already resolved by
              // timeout, by an earlier ask_user_answered, or never
              // registered). The verdict.toolCallId came from classifier
              // iteration over the CURRENT pendingAsks snapshot, so the
              // common cause here is an interleaved timeout/answer landing
              // in the same event-loop tick. Falling through lets the
              // utterance reach runShadowHarness as a normal user turn —
              // strictly safer than silently dropping speech on a race
              // we didn't actually win. Log for the audit trail.
              //
              // NOTE: sanitisation still failed for this text, so even on
              // fall-through runShadowHarness will process the raw
              // transcriptText (which is a different code path — the
              // harness's downstream Sonnet call sanitises/normalises via
              // its own pipeline). The validation_error resolve above
              // was a no-op (tool_call_id already gone), so no channel
              // received the bad text as an ask answer.
              logger.warn('stage6.transcript_overtake_stale_resolve', {
                sessionId,
                tool_call_id: verdict.toolCallId,
                source: 'transcript_overtake_validation_error',
                reason: 'tool_call_id_already_resolved',
              });
              // Deliberately NOT clearing entry.lastRegexResults here —
              // runShadowHarness may want the regex context on this turn,
              // and the normal post-harness reset downstream handles it.
            } else {
              // Plan 03-12 STT-11 (STG r5 MAJOR remediation) — clear
              // lastRegexResults here too. The normal-path reset at line
              // 1686 is skipped on early-return; without this line, any
              // non-empty entry.lastRegexResults (future populator, test
              // seed, manual debug) would leak into the next transcript's
              // `msg.regexResults ?? entry.lastRegexResults` fallback.
              entry.lastRegexResults = [];
              // Outer try/finally (line ~1783) handles clearTimeout +
              // isExtracting=false on return — no explicit cleanup needed.
              return;
            }
          }

          if (!sanitisationFailed) {
            const resolvePayload = {
              answered: true,
              user_text: sanitised.text,
            };
            if (sanitised.truncated || sanitised.stripped) {
              resolvePayload.sanitisation = {
                truncated: sanitised.truncated,
                stripped: sanitised.stripped,
              };
            }
            const resolvedAnswer = entry.pendingAsks.resolve(verdict.toolCallId, resolvePayload);

            if (!resolvedAnswer) {
              // Plan 03-12 r7 MAJOR remediation — stale resolve on the
              // answers path. Same rationale as the validation_error
              // branch above: verdict.toolCallId was live at classifier
              // call-site but got resolved by a concurrent timeout /
              // ask_user_answered in the same event-loop tick. The
              // original r3 code unconditionally early-returned here,
              // which meant the transcript was dropped into a void —
              // no dispatcher tool_result body was sent (resolve() noop'd),
              // and runShadowHarness was skipped. Net: speech silently
              // disappeared on a race the server didn't win.
              //
              // Fix: log the race, fall through to runShadowHarness. The
              // utterance then reaches Sonnet as a normal user turn, which
              // is the strictly-safe attribution (Open Question #4: wrong
              // attribution is costlier than a second re-ask). Do NOT
              // reset lastRegexResults here — the harness is about to
              // use it; the normal post-harness reset handles cleanup.
              logger.warn('stage6.transcript_overtake_stale_resolve', {
                sessionId,
                tool_call_id: verdict.toolCallId,
                source: 'transcript_overtake_answer',
                reason: 'tool_call_id_already_resolved',
              });
            } else {
              // Plan 03-12 STT-11 (STG r5 MAJOR remediation) — clear
              // lastRegexResults on the answers early-return too. Same
              // rationale as the validation_error branch above: the normal
              // reset at line 1686 sits AFTER runShadowHarness, which this
              // return skips. Defensive against any future populator of
              // entry.lastRegexResults that would otherwise bleed stale
              // hits into the next transcript's fallback.
              entry.lastRegexResults = [];

              // Plan 03-12 r13 Codex MAJOR — stamp seenTranscriptUtterances
              // HERE, now that we've committed the transcript text to the
              // ask channel via registry.resolve(). Any subsequent
              // ask_user_answered for this utterance_id must downgrade to
              // transcript_already_extracted (handled by the dedupe guard
              // in the ask_user_answered switch case at ~L859).
              stampSeenTranscript();

              // Plan 03-11 Task 3 — BLOCK remediation: return early. The
              // dispatcher's tool_result is the sole Sonnet-visible channel
              // for this utterance; do NOT also feed it into runShadowHarness.
              // The `finally` at the outer try/finally handles watchdog cleanup
              // + isExtracting reset on return, so no cleanup needed here
              // beyond early return.
              return;
            }
          }
        } else if (verdict.kind === 'user_moved_on') {
          // Plan 03-12 r12 BLOCK remediation — serialise against the prior
          // turn.
          //
          // rejectAll('user_moved_on') wakes any dispatcher Promise(s)
          // suspended on pendingAsks.register with
          // {answered:false, reason:'user_moved_on'}. Falling straight
          // through to runShadowHarness here would kick off a SECOND
          // concurrent turn on `entry.session` while the prior turn's
          // tool loop was still unwinding the ask_user tool_result + any
          // remaining writes. STA-01 requires one in-flight turn per
          // session, and Anthropic's messages-create will reject
          // interleaved tool_use/tool_result blocks across concurrent
          // streams against the same conversation — best case the server
          // 400s the second request; worst case they race on
          // entry.session.messages and poison the transcript.
          //
          // The isExtracting gate at the top of handleTranscript would
          // normally serialise these, BUT it only holds if the prior
          // turn is still mid-await. Two paths can sneak a resolvable
          // ask into pendingAsks past isExtracting=false:
          //   (a) the 30s watchdog force-reset at line 1570 flipped
          //       isExtracting=false while the prior runToolLoop was
          //       still mid-await on its ask Promise, and
          //   (b) a reconnect/termination path left an orphan entry in
          //       pendingAsks that rejectAll must still drain.
          // In (a) the old tool loop resumes when we reject, and in (b)
          // there is no resumer but we still want strict serialisation
          // for consistency with (a) and so the analyzer sees exactly
          // one turn per transcript.
          //
          // Fix: queue the transcript and early-return. The outer
          // finally clears isExtracting=false and then drains
          // pendingTranscripts (drain sits INSIDE finally so every
          // early-return path feeds it — see the comment on the
          // finally block near L2028). Re-entry happens with this
          // transcript on the next tick, by which point any awakened
          // dispatcher has fully emitted its user_moved_on tool_result
          // and the prior turn has completed. `lastRegexResults` is
          // deliberately NOT cleared — the queued re-entry will use
          // the same regex hits that led to this user_moved_on verdict.
          entry.pendingAsks.rejectAll('user_moved_on');
          // Plan 03-12 r13 Codex MAJOR#2 — push the RESOLVED `regexResults`
          // (not raw `msg.regexResults`), so the drained retry uses the
          // exact parse context the verdict was based on. Relying on the
          // `msg.regexResults || entry.lastRegexResults || []` fallback at
          // re-entry would drift if another code path mutated
          // entry.lastRegexResults between defer and drain.
          //
          // Plan 03-12 r13 Codex MAJOR#1 — carry `utterance_id` so the
          // pre-harness stamp on the drained retry still fires; without
          // this, a late ask_user_answered targeting the re-entered
          // transcript's utterance would NOT be downgraded to
          // transcript_already_extracted even though we did run the
          // harness on it.
          //
          // Plan 03-12 r13 Codex MINOR — mark `_drainedRetry=true` so the
          // re-entry skips questionGate.onNewUtterance() (otherwise the
          // same utterance would tick the gate twice).
          //
          // r18 MAJOR#1 remediation — spread the full original `msg` so
          // the drained retry replays handleTranscript with its original
          // shape: `in_response_to`, `confirmations_enabled`, and any
          // other metadata the server added at ingress. The prior shape
          // only carried `{text, regexResults, utterance_id}`; on replay
          // the retry lost TTS-question context so Sonnet re-interpreted
          // short replies ("yes", "code 2") without the preceding prompt.
          // Mirrors the r17 BLOCK fix applied to the `isExtracting` queue
          // at line ~1758.
          entry.pendingTranscripts.push({
            ...msg,
            regexResults,
            _drainedRetry: true,
          });
          logger.info('stage6.transcript_deferred_after_user_moved_on', {
            sessionId,
            pending_transcripts_depth: entry.pendingTranscripts.length,
          });
          return;
        }
        // 'no_pending_asks' can't happen here (guarded by size>0) but the
        // classifier still returns it in defensive contexts — safe to ignore.
      }

      const result = await runShadowHarness(entry.session, transcriptText, regexResults, {
        confirmationsEnabled: msg.confirmations_enabled || false,
        // Stage 6 Phase 3 Plan 03-08: activate Plan 03-07's dispatcher
        // composition. When these are present the harness wires
        // createAskDispatcher alongside createWriteDispatcher and threads
        // createSortRecordsAsksLast() into runToolLoop so STA-02 ("writes
        // before asks") ordering fires at the dispatcher boundary.
        // Identity preservation is load-bearing: the dispatcher registers
        // into the SAME registry this routing layer resolves against.
        pendingAsks: entry.pendingAsks,
        ws,
      });

      // Plan 03-12 r14 Codex MAJOR — stamp seenTranscriptUtterances ONLY
      // AFTER runShadowHarness resolves successfully. The earlier r13
      // placement was immediately BEFORE the await, which meant a harness
      // failure (Sonnet 5xx, network drop, tool-loop timeout, any thrown
      // exception inside runShadowHarness) would leave the utterance_id
      // stamped even though extraction never completed. A later
      // ask_user_answered carrying `consumed_utterance_id = <that id>`
      // would then be downgraded to transcript_already_extracted by the
      // dedupe guard at ~L859 — the user's answer would be silently lost
      // even though no transcript was ever processed.
      //
      // The original r13 rationale ("stamp before await to cover
      // synchronous races during the yield") was incorrect: any
      // ask_user_answered arriving during the yield is for a tool_use in
      // the CURRENT tool loop that runShadowHarness is awaiting, which
      // resolves through the dispatcher's ask Promise (not through the
      // seenTranscriptUtterances dedupe path). The dedupe path only
      // fires for ASYNC-ARRIVING frames that reference a prior utterance
      // by consumed_utterance_id — a LATER arrival, not a concurrent
      // one — so post-success placement is the correct semantic.
      stampSeenTranscript();

      entry.lastRegexResults = [];

      // Validate and auto-correct field names before sending to iOS
      validateAndCorrectFields(result, sessionId);

      logger.info('Extraction result', {
        sessionId,
        readings: result.extracted_readings.length,
        questions: (result.questions_for_user || []).length,
        confirmations: (result.confirmations || []).length,
        // Sync-path parity with the onBatchResult log above: emit a preview of
        // up to the first two questions so we can see Sonnet's exact wording
        // in CloudWatch. Same rationale — iOS debug-log upload is broken, so
        // server-side logs are the only reliable forensic trail today.
        questionsPreview: Array.isArray(result.questions_for_user)
          ? result.questions_for_user.slice(0, 2).map((q) => ({
              type: q.type || null,
              field: q.field || null,
              circuit: q.circuit === null || q.circuit === undefined ? null : q.circuit,
              questionPreview: typeof q.question === 'string' ? q.question.slice(0, 120) : null,
            }))
          : [],
      });

      // Send extraction result (strip questions_for_user — they go through QuestionGate)
      // Rename extracted_readings → readings to match the web client interface
      // Strip spoken_response/action — they're sent separately as voice_command_response
      if (ws.readyState === ws.OPEN) {
        const {
          questions_for_user,
          extracted_readings,
          spoken_response,
          action,
          observationUpdates,
          ...rest
        } = result;
        const resultWithoutQuestions = { readings: extracted_readings, ...rest };
        ws.send(JSON.stringify({ type: 'extraction', result: resultWithoutQuestions }));

        // Phase A: dispatch RULE 6 correction edits (observation_id reused).
        // These must fire before the BPG4 refinement path so iOS patches the
        // code change before any web-search-based refinement considers the
        // observation.
        dispatchObservationUpdates(ws, sessionId, observationUpdates);

        // Fire-and-forget BPG4 / BS 7671 refinement for new observations. Runs
        // AFTER extraction is sent so the inspector sees the observation
        // immediately; the refined code/regulation arrives a second or two
        // later as an `observation_update` and the iOS client patches the
        // already-rendered observation in place.
        if (Array.isArray(result.observations) && result.observations.length > 0 && entry) {
          refineObservationsAsync(entry, sessionId, result.observations).catch((err) => {
            logger.warn('refineObservationsAsync unhandled', {
              sessionId,
              error: err?.message,
            });
          });
        }

        // If Sonnet returned a spoken_response or action (query/command recognised),
        // forward as a voice_command_response — iOS handles these via the existing
        // serverDidReceiveVoiceCommandResponse delegate path.
        if (spoken_response || action) {
          ws.send(
            JSON.stringify({
              type: 'voice_command_response',
              understood: true,
              spoken_response: spoken_response || '',
              action: action || null,
            })
          );
          logger.info('Voice command from extraction', {
            sessionId,
            action: action?.type || 'query',
            response: (spoken_response || '').substring(0, 80),
          });
        }

        // Send cost update
        ws.send(JSON.stringify(entry.session.costTracker.toCostUpdate()));
      } else {
        // Buffer extraction results when WebSocket not OPEN — flushed on reconnect
        entry.pendingExtractions.push(result);
        logger.info('Extraction buffered (socket not open)', {
          sessionId,
          readings: result.extracted_readings.length,
          buffered: entry.pendingExtractions.length,
        });
      }

      // Resolve prior-turn pending questions against this-turn readings FIRST,
      // then enqueue this turn's new questions. Swapping the order (enqueue
      // first) would let the install-field wildcard in resolveByFields cancel
      // Sonnet's same-turn question about the value it just extracted
      // (the "RG30 postcode" bug). See the batch-flush callback above for the
      // full explanation — both call sites must use the same ordering.
      const resolvedFieldsSync =
        result.extracted_readings && result.extracted_readings.length > 0
          ? new Set(result.extracted_readings.map((r) => `${r.field}:${r.circuit}`))
          : new Set();
      if (resolvedFieldsSync.size > 0) {
        entry.questionGate.resolveByFields(resolvedFieldsSync);
      }

      // Handle questions (gated) — Stage 5 pre-flight filter drops refills.
      if (result.questions_for_user && result.questions_for_user.length > 0) {
        const filteredSync = filterQuestionsAgainstFilledSlots(
          result.questions_for_user,
          entry.session.stateSnapshot,
          resolvedFieldsSync,
          sessionId
        );
        if (filteredSync.length > 0) {
          entry.questionGate.enqueue(filteredSync);
        }
      }

      // Resolve observation-only questions when Sonnet extracted an observation.
      // Mirrors the batch-flush callback path above.
      if (Array.isArray(result.observations) && result.observations.length > 0) {
        // Phase D: pass the observations array (not a count) so the gate can
        // keep unrelated prior-turn obs questions.
        entry.questionGate.resolveObservationQuestions(result.observations);
      }

      // Periodic orphaned value review — every 10 extraction turns
      if (entry.session.turnCount > 0 && entry.session.turnCount % 10 === 0) {
        try {
          const reviewResult = await entry.session.reviewForOrphanedValues();
          if (reviewResult?.questions_for_user?.length > 0) {
            logger.info('Orphaned review found questions', {
              sessionId,
              count: reviewResult.questions_for_user.length,
            });
            // Stage 5: orphan review runs on accumulated state — no this-turn
            // readings, so pass an empty resolvedFields set. Any question
            // targeting a slot that's already filled in stateSnapshot is dropped.
            const filteredReview = filterQuestionsAgainstFilledSlots(
              reviewResult.questions_for_user,
              entry.session.stateSnapshot,
              new Set(),
              sessionId
            );
            if (filteredReview.length > 0) {
              entry.questionGate.enqueue(filteredReview);
            }
          }
        } catch (reviewErr) {
          logger.warn('Orphaned review failed', { sessionId, error: reviewErr.message });
        }
      }
    } catch (error) {
      logger.error('Extraction error', { sessionId, error: error.message });
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Extraction failed: ${error.message}`,
            recoverable: true,
          })
        );
      }
    } finally {
      clearTimeout(extractionWatchdog);
      entry.isExtracting = false;

      // Plan 03-12 r12 BLOCK remediation — drain MUST sit inside finally.
      //
      // Earlier code placed the drain AFTER the try/catch/finally, which
      // meant every early-return from inside the try (answers-path at
      // ~L1797, validation-error early-return at ~L1740, user_moved_on
      // deferral at ~L1848) bypassed the drain: the return triggered
      // finally (isExtracting=false) and then exited the function, never
      // reaching the post-finally drain block. The user_moved_on branch
      // relies on the drain re-entering with the just-queued transcript
      // — without it, rejectAll fires, the transcript sits in
      // pendingTranscripts forever, and runShadowHarness is never invoked
      // for that utterance (silent speech loss).
      //
      // Moving the drain inside finally ensures the same post-turn
      // behaviour on every exit path: the outer turn ends, isExtracting
      // flips false, then any queued transcript re-enters. This also
      // retroactively fixes the answers-path leak (any transcript queued
      // while the prior turn was isExtracting would previously be
      // orphaned on an answers verdict since that path also early-returns).
      if (entry.pendingTranscripts.length > 0) {
        const next = entry.pendingTranscripts.shift();
        if (next && next.text && next.text.trim()) {
          await handleTranscript(ws, sessionId, next);
        }
      }
    }
  }

  async function handleCorrection(ws, sessionId, msg) {
    if (!sessionId || !activeSessions.has(sessionId)) return;
    // Send correction as a transcript so Sonnet can process it in context
    const correctionText = `CORRECTION: The value for ${msg.field} on circuit ${msg.circuit} should be ${msg.value}`;
    await handleTranscript(ws, sessionId, { text: correctionText });
  }

  async function handleSessionStop(ws, sessionId) {
    if (!sessionId || !activeSessions.has(sessionId)) return;
    const entry = activeSessions.get(sessionId);

    // Plan 03-12 STT-10a (STG r5 BLOCK remediation) — flip the isStopping
    // flag BEFORE any rejectAll / flush / S3 awaits. Combined with the
    // handleTranscript guard at its entry, this ensures any subsequent
    // transcript arriving during teardown is silently dropped (no harness,
    // no dispatcher, no register). Set synchronously so the very next
    // event-loop tick sees it — before any `await` below yields.
    entry.isStopping = true;

    // Stage 6 Phase 3 Plan 03-08 (Codex STG #3): release blocking asks BEFORE
    // the existing stop-path cleanup. Placed here (not near the
    // activeSessions.delete at the end of this function) so ANY intermediate
    // await below — flushUtteranceBuffer, storage.uploadJson, the cost_summary
    // S3 upload — runs with the asks already rejected. Otherwise a pending
    // ask could outlive an S3 network hiccup by several seconds, and a
    // now-orphaned dispatcher would keep the tool-loop alive past session_ack.
    entry.pendingAsks.rejectAll('session_stopped');

    // Flush any buffered utterances before stopping so no readings are lost
    const flushResult = await entry.session.flushUtteranceBuffer();
    if (flushResult && entry.session.onBatchResult) {
      entry.session.onBatchResult(flushResult);
    }

    const summary = entry.session.stop();
    entry.questionGate.destroy();

    // Phase F: emit `observation_update_unmatched` for any refinement that
    // never reached iOS. Paired with the iOS-side `observation_update_no_match`
    // event so the session optimizer can spot one-way failures (server sent,
    // client didn't match) vs. complete drop-off (server never sent). Fires
    // here rather than on a periodic sweep so the event always lands at a
    // deterministic point relative to session end.
    if (entry.pendingRefinements && entry.pendingRefinements.size > 0) {
      const now = Date.now();
      for (const [id, pending] of entry.pendingRefinements.entries()) {
        logger.info('observation_update_unmatched', {
          sessionId,
          observationId: id.slice(0, 8),
          ageMs: now - (pending.attemptedAt || now),
          hadRefinedCache: Boolean(pending.refined),
        });
      }
      summary.observation_refinement_unmatched = entry.pendingRefinements.size;
      entry.pendingRefinements.clear();
    }

    // Attach job identity so cost can be traced back to the job
    summary.jobId = entry.jobId || null;
    summary.jobAddress = entry.jobAddress || null;
    summary.certType = entry.certType || null;
    summary.sessionId = sessionId;

    // Save cost summary to S3
    try {
      const s3Key = `session-analytics/${entry.userId}/${sessionId}/cost_summary.json`;
      await storage.uploadJson(summary, s3Key);
      logger.info('Cost summary saved', {
        s3Key,
        jobId: entry.jobId,
        jobAddress: entry.jobAddress,
      });
    } catch (error) {
      logger.error('Failed to save cost summary to S3', { error: error.message });
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'session_ack', status: 'stopped', sessionStats: summary }));
    }
    // Invalidate the rehydration token — a cleanly-stopped session has no
    // context worth preserving and we don't want a stale token lingering in
    // the store for the full TTL.
    if (entry.rehydrateSessionId) {
      sonnetSessionStore.remove(entry.rehydrateSessionId);
    }

    // Plan 03-12 STT-10b (STG r5 BLOCK remediation) — belt-and-suspenders
    // final rejectAll pass. The entry-point rejectAll at line 1880 drains
    // every ask known at the moment stop began; the isStopping guard on
    // handleTranscript prevents NEW harness runs from registering fresh
    // asks during teardown. But a transcript handler that started BEFORE
    // stop began and is already past the isStopping check (e.g. paused
    // awaiting Anthropic API) can still resume and register into the
    // registry during the awaits above. Sweeping a second time here
    // guarantees any such late-registered ask resolves as session_stopped
    // rather than hanging as an orphan. Cheap (O(pendingAsks.size)), runs
    // while the entry is still in activeSessions — callers awaiting the
    // ask Promise receive the rejection before session_ack emit.
    entry.pendingAsks.rejectAll('session_stopped');

    activeSessions.delete(sessionId);
    logger.info('Session stopped', { sessionId });
  }

  return wss;
}

// Re-export for external readers (sonnet-stream-resume.test.js, etc.) that
// previously imported `activeSessions` from this module. The canonical
// definition now lives in `./active-sessions.js`.
export { activeSessions };
