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
import * as storage from '../storage.js';
import logger from '../logger.js';

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
            }
            break;

          case 'correction':
            await handleCorrection(ws, currentSessionId, msg);
            break;

          case 'voice_command':
            await handleVoiceCommand(ws, currentSessionId, msg, getAnthropicKey);
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
            if (currentSessionId && activeSessions.has(currentSessionId)) {
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
      });
      // Update job state if provided (iOS may have new data since last connect)
      if (jobState) {
        existing.session.updateJobState(jobState);
      }
      ws.send(JSON.stringify({ type: 'session_ack', status: 'reconnected' }));
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
    });

    // Set up batch flush callback — when the batch timeout fires asynchronously,
    // this delivers the extraction result to iOS the same way handleTranscript does.
    session.onBatchResult = (result) => {
      try {
        validateAndCorrectFields(result, sessionId);
        if (ws.readyState === ws.OPEN) {
          const { questions_for_user, ...resultWithoutQuestions } = result;
          ws.send(JSON.stringify({ type: 'extraction', result: resultWithoutQuestions }));
          ws.send(JSON.stringify(session.costTracker.toCostUpdate()));
        }
        if (result.questions_for_user && result.questions_for_user.length > 0) {
          questionGate.enqueue(result.questions_for_user);
        }
        if (result.extracted_readings && result.extracted_readings.length > 0) {
          const resolvedFields = new Set(
            result.extracted_readings.map((r) => `${r.field}:${r.circuit}`)
          );
          questionGate.resolveByFields(resolvedFields);
        }
      } catch (err) {
        logger.error('Batch flush callback error', { sessionId, error: err.message });
      }
    };

    session.start(jobState);

    activeSessions.set(sessionId, {
      session,
      questionGate,
      ws,
      userId,
      jobId,
      lastRegexResults: [],
      isExtracting: false,
      pendingTranscripts: [],
    });

    ws.send(JSON.stringify({ type: 'session_ack', status: 'started' }));
    logger.info('Session started', { sessionId, jobId });
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

    try {
      logger.info('Extracting from transcript', {
        sessionId,
        textPreview: msg.text.substring(0, 80),
      });
      const regexResults = msg.regexResults || entry.lastRegexResults || [];
      const result = await entry.session.extractFromUtterance(msg.text, regexResults, {
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
      if (ws.readyState === ws.OPEN) {
        const { questions_for_user, ...resultWithoutQuestions } = result;
        ws.send(JSON.stringify({ type: 'extraction', result: resultWithoutQuestions }));

        // Send cost update
        ws.send(JSON.stringify(entry.session.costTracker.toCostUpdate()));
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

  // Voice command prompt for Sonnet — interprets natural language commands into structured actions.
  // Uses a separate Sonnet call (not the extraction session) to keep the extraction conversation clean.
  const VOICE_COMMAND_SYSTEM_PROMPT = `You are CertMate, an AI assistant for UK electrical inspectors using the CertMate app to fill in EICR/EIC certificates. The inspector has spoken a voice command after saying your wake word "CertMate".

Your job is to interpret their natural language command and return a structured JSON action that the app can execute.

AVAILABLE ACTIONS:

1. reorder_circuits — Move circuits to new positions
   Example commands: "move circuits 7 and 8 to positions 2 and 3", "put circuit 5 first", "swap circuits 2 and 4"
   Response: { "action": { "type": "reorder_circuits", "params": { "circuit_moves": [{"from": 7, "to": 2}, {"from": 8, "to": 3}] } } }

2. add_circuit — Add a new circuit
   Example: "add a new circuit for the cooker", "add circuit called shower"
   Response: { "action": { "type": "add_circuit", "params": { "description": "Cooker" } } }

3. delete_circuit — Delete a circuit by its number
   Example: "delete circuit 5", "remove the last circuit"
   Response: { "action": { "type": "delete_circuit", "params": { "circuit_ref": "5" } } }

4. update_field — Update a specific field value
   Example: "set the Ze to 0.35", "change circuit 3 designation to shower"
   Response: { "action": { "type": "update_field", "params": { "field": "ze", "value": "0.35" } } }
   For circuit fields: { "action": { "type": "update_field", "params": { "field": "circuit_designation", "circuit": 3, "value": "Shower" } } }

5. query_field — Answer a question about current data (no mutation)
   Example: "what's the Zs for circuit 3?", "what's the client name?", "how many circuits do I have?"
   Response: { "action": { "type": "query_field", "params": { "field": "zs", "circuit": 3 } } }

6. query_summary — Provide a summary of the current state
   Example: "give me a summary", "what have we filled in so far?", "what's missing?"
   Response: { "action": { "type": "query_summary", "params": {} } }

7. calculate_impedance — Calculate Zs (from Ze + R1+R2) or R1+R2 (from Zs - Ze) for circuits
   The formula is: Ze + R1+R2 = Zs. The app will perform the arithmetic — just return the structured action.
   "calculate" must be "zs" or "r1_r2". Scope: "circuits": "all" for all circuits, "circuit": N for one, or "circuit_from"/"circuit_to" for a range.
   Example: "calculate Zs for all circuits", "work out R1+R2 for circuit 3", "calculate Zs for circuits 1 to 5"
   All circuits: { "action": { "type": "calculate_impedance", "params": { "calculate": "zs", "circuits": "all" } } }
   Single: { "action": { "type": "calculate_impedance", "params": { "calculate": "r1_r2", "circuit": 3 } } }
   Range: { "action": { "type": "calculate_impedance", "params": { "calculate": "zs", "circuit_from": 1, "circuit_to": 5 } } }

FIELD NAMES (use these exact names in actions):
- Supply: ze, pfc, earthing_arrangement, main_switch_rating, main_switch_bs_en
- Circuit: circuit_designation, cable_size, ocpd_rating, ocpd_type, zs, r1_r2, r2, ir_live_earth, ir_live_live, rcd_trip_time, polarity
- Installation: client_name, address, postcode, phone, email, premises_description, client_address, client_postcode, client_town, client_county
- Board: manufacturer, zs_at_db

RESPONSE FORMAT — Always respond with valid JSON:
{
  "understood": true/false,
  "spoken_response": "Brief natural speech to say back to the inspector via TTS",
  "action": { "type": "...", "params": { ... } } or null if not understood
}

GUIDELINES:
- Keep spoken_response SHORT (under 15 words). The inspector is busy working.
- For queries, include the answer in spoken_response. Example: "The Zs for circuit 3 is 0.35 ohms"
- For mutations, confirm what was done. Example: "Done, circuits 7 and 8 moved to positions 2 and 3"
- If you can't understand the command, set understood=false and spoken_response to a helpful clarification
- Use the job state context to answer queries accurately
- For "swap" commands, calculate the correct moves to achieve the swap
- For "move circuit X to position Y" with multiple circuits, process them so the final positions match what the user asked for
- Circuit refs are 1-based (circuit 1 is the first circuit)`;

  async function handleVoiceCommand(ws, sessionId, msg, getAnthropicKey) {
    const { command, jobState } = msg;
    if (!command) {
      ws.send(
        JSON.stringify({
          type: 'voice_command_response',
          understood: false,
          spoken_response: "I didn't catch that. Try again?",
          action: null,
        })
      );
      return;
    }

    logger.info('Processing voice command', {
      sessionId,
      command: command.substring(0, 120),
    });

    try {
      const apiKey = await getAnthropicKey();
      if (!apiKey) throw new Error('Anthropic API key not available');

      const client = new Anthropic({ apiKey });

      // Build context from job state
      let context = '';
      if (jobState) {
        context += '\n\nCURRENT JOB STATE:\n';
        if (jobState.circuits && Array.isArray(jobState.circuits)) {
          context += `Circuits (${jobState.circuits.length} total):\n`;
          for (const c of jobState.circuits) {
            const parts = [`Circuit ${c.circuitRef || c.circuit_ref || c.ref || '?'}`];
            if (c.circuitDesignation || c.circuit_designation || c.designation)
              parts.push(`"${c.circuitDesignation || c.circuit_designation || c.designation}"`);
            if (c.cableSize || c.cable_size || c.liveCsaMm2)
              parts.push(`cable: ${c.cableSize || c.cable_size || c.liveCsaMm2}`);
            if (c.ocpdRating || c.ocpd_rating || c.ocpdRatingA)
              parts.push(
                `OCPD: ${c.ocpdType || c.ocpd_type || ''}${c.ocpdRating || c.ocpd_rating || c.ocpdRatingA}A`
              );
            if (c.zs || c.measuredZsOhm) parts.push(`Zs: ${c.zs || c.measuredZsOhm}`);
            if (c.r1R2Ohm || c.r1_r2) parts.push(`R1+R2: ${c.r1R2Ohm || c.r1_r2}`);
            context += `  ${parts.join(', ')}\n`;
          }
        }
        if (jobState.supplyCharacteristics || jobState.supply_characteristics || jobState.supply) {
          const supply =
            jobState.supplyCharacteristics || jobState.supply_characteristics || jobState.supply;
          context += 'Supply: ';
          const parts = [];
          if (supply.earthingArrangement || supply.earthing_arrangement)
            parts.push(`Earthing: ${supply.earthingArrangement || supply.earthing_arrangement}`);
          if (supply.ze) parts.push(`Ze: ${supply.ze}`);
          if (supply.prospectiveFaultCurrent || supply.prospective_fault_current)
            parts.push(
              `PFC: ${supply.prospectiveFaultCurrent || supply.prospective_fault_current}`
            );
          context += parts.join(', ') + '\n';
        }
        if (
          jobState.installationDetails ||
          jobState.installation_details ||
          jobState.installation
        ) {
          const install =
            jobState.installationDetails || jobState.installation_details || jobState.installation;
          const parts = [];
          if (install.clientName || install.client_name)
            parts.push(`Client: ${install.clientName || install.client_name}`);
          if (install.address) parts.push(`Installation Address: ${install.address}`);
          if (install.postcode) parts.push(`Postcode: ${install.postcode}`);
          if (install.clientAddress || install.client_address)
            parts.push(`Client Address: ${install.clientAddress || install.client_address}`);
          if (install.clientPostcode || install.client_postcode)
            parts.push(`Client Postcode: ${install.clientPostcode || install.client_postcode}`);
          if (parts.length > 0) context += `Installation: ${parts.join(', ')}\n`;
        }
        if (jobState.boards && Array.isArray(jobState.boards)) {
          for (const b of jobState.boards) {
            const parts = [`Board "${b.name || b.designation || ''}"`];
            if (b.ze) parts.push(`Ze: ${b.ze}`);
            if (b.mainSwitchRating) parts.push(`Main switch: ${b.mainSwitchRating}A`);
            context += `  ${parts.join(', ')}\n`;
          }
        }
      }

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: VOICE_COMMAND_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `VOICE COMMAND: "${command}"${context}`,
          },
        ],
      });

      const text = response.content[0]?.text || '';

      // Parse JSON from response (handle markdown code blocks)
      let parsed;
      try {
        const jsonMatch =
          text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        logger.warn('Voice command response not valid JSON', {
          sessionId,
          text: text.substring(0, 200),
        });
        parsed = {
          understood: false,
          spoken_response: 'Sorry, I had trouble processing that. Try again?',
          action: null,
        };
      }

      // Track cost (voice commands are cheap — single-turn, small response)
      if (sessionId && activeSessions.has(sessionId)) {
        const entry = activeSessions.get(sessionId);
        if (response.usage) {
          entry.session.costTracker.addVoiceCommandCost(response.usage);
          // Send updated cost
          ws.send(JSON.stringify(entry.session.costTracker.toCostUpdate()));
        }
      }

      // Send response to iOS
      ws.send(
        JSON.stringify({
          type: 'voice_command_response',
          ...parsed,
        })
      );

      logger.info('Voice command processed', {
        sessionId,
        understood: parsed.understood,
        action: parsed.action?.type || 'none',
        response: (parsed.spoken_response || '').substring(0, 80),
      });
    } catch (error) {
      logger.error('Voice command error', { sessionId, error: error.message });
      ws.send(
        JSON.stringify({
          type: 'voice_command_response',
          understood: false,
          spoken_response: 'Sorry, I had trouble with that command.',
          action: null,
        })
      );
    }
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

    // Save cost summary to S3
    try {
      const s3Key = `session-analytics/${entry.userId}/${sessionId}/cost_summary.json`;
      await storage.uploadJson(summary, s3Key);
      logger.info('Cost summary saved', { s3Key });
    } catch (error) {
      logger.error('Failed to save cost summary to S3', { error: error.message });
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'session_ack', status: 'stopped', sessionStats: summary }));
    }
    activeSessions.delete(sessionId);
    logger.info('Session stopped', { sessionId });
  }

  return wss;
}

export { activeSessions };
