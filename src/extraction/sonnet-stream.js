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

const activeSessions = new Map(); // sessionId -> { session, questionGate, ws, ... }

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
        });
        if (result.questions_for_user && result.questions_for_user.length > 0) {
          questionGate.enqueue(result.questions_for_user);
        }
        if (result.extracted_readings && result.extracted_readings.length > 0) {
          const resolvedFields = new Set(
            result.extracted_readings.map((r) => `${r.field}:${r.circuit}`)
          );
          questionGate.resolveByFields(resolvedFields);
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
    entry.questionGate.onNewUtterance();

    // If already extracting, queue this transcript individually
    if (entry.isExtracting) {
      entry.pendingTranscripts.push({ text: msg.text, regexResults: msg.regexResults });
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
      const result = await entry.session.extractFromUtterance(transcriptText, regexResults, {
        confirmationsEnabled: msg.confirmations_enabled || false,
      });
      entry.lastRegexResults = [];

      // Validate and auto-correct field names before sending to iOS
      validateAndCorrectFields(result, sessionId);

      logger.info('Extraction result', {
        sessionId,
        readings: result.extracted_readings.length,
        questions: (result.questions_for_user || []).length,
        confirmations: (result.confirmations || []).length,
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

      // Handle questions (gated)
      if (result.questions_for_user && result.questions_for_user.length > 0) {
        entry.questionGate.enqueue(result.questions_for_user);
      }

      // Resolve any pending questions based on newly extracted readings
      if (result.extracted_readings && result.extracted_readings.length > 0) {
        const resolvedFields = new Set(
          result.extracted_readings.map((r) => `${r.field}:${r.circuit}`)
        );
        entry.questionGate.resolveByFields(resolvedFields);
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
            entry.questionGate.enqueue(reviewResult.questions_for_user);
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
    }

    // Process next queued transcript (one at a time)
    if (entry.pendingTranscripts.length > 0) {
      const next = entry.pendingTranscripts.shift();
      if (next && next.text && next.text.trim()) {
        await handleTranscript(ws, sessionId, next);
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
    activeSessions.delete(sessionId);
    logger.info('Session stopped', { sessionId });
  }

  return wss;
}

export { activeSessions };
