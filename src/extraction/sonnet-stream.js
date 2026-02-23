// sonnet-stream.js
// WebSocket handler for server-side Sonnet extraction sessions

import { WebSocketServer } from 'ws';
import { EICRExtractionSession } from './eicr-extraction-session.js';
import { QuestionGate } from './question-gate.js';
import * as storage from '../storage.js';
import logger from '../logger.js';

const activeSessions = new Map(); // sessionId -> { session, questionGate, ws, ... }

// Known valid field names that iOS can handle
const KNOWN_FIELDS = new Set([
    // Supply fields
    'ze', 'pfc', 'earthing_arrangement', 'main_earth_conductor_csa', 'main_bonding_conductor_csa',
    'bonding_water', 'bonding_gas', 'earth_electrode_type', 'earth_electrode_resistance',
    'supply_voltage', 'nominal_voltage', 'nominal_voltage_u', 'supply_frequency', 'nominal_frequency',
    'supply_polarity_confirmed', 'manufacturer', 'zs_at_db',
    // Installation fields
    'address', 'client_name', 'client_phone', 'client_email', 'reason_for_report',
    'occupier_name', 'date_of_previous_inspection', 'previous_certificate_number',
    'estimated_age_of_installation', 'general_condition', 'next_inspection_years', 'premises_description',
    // Circuit fields
    'zs', 'insulation_resistance_l_e', 'insulation_resistance_l_l', 'r1_plus_r2', 'r1_r2', 'r1r2',
    'r2', 'earth_continuity', 'ring_continuity_r1', 'ring_continuity_rn', 'ring_continuity_r2',
    'rcd_trip_time', 'rcd_time', 'rcd_rating_a', 'rcd_rating',
    'polarity', 'cable_size', 'cable_size_earth', 'cpc_csa_mm2', 'cpc_csa',
    'ocpd_type', 'ocpd_rating', 'number_of_points',
    'wiring_type', 'ref_method',
    'rcd_button_confirmed', 'afdd_button_confirmed',
    'circuit_description', 'designation',
    'ir_live_earth', 'ir_live_live', 'earth_fault_loop_impedance'
]);

// Common misspellings / variants → correct field name
const FIELD_CORRECTIONS = {
    'insulation_resistance_le': 'insulation_resistance_l_e',
    'insulation_resistance_ll': 'insulation_resistance_l_l',
    'earth_loop_impedance_ze': 'ze',
    'prospective_fault_current': 'pfc',
    // r1_plus_r2 is in KNOWN_FIELDS (iOS handles both r1_plus_r2 and r1_r2)
    'rcd_trip_time_ms': 'rcd_trip_time',
    'rcd_rating_ma': 'rcd_rating_a',
    'cable_size_live': 'cable_size',
    'cable_size_cpc': 'cable_size_earth',
    'cpc_size': 'cable_size_earth',
    'ir_l_e': 'insulation_resistance_l_e',
    'ir_l_l': 'insulation_resistance_l_l',
    'ir_le': 'insulation_resistance_l_e',
    'ir_ll': 'insulation_resistance_l_l',
    'loop_impedance': 'zs',
    'earth_loop_impedance': 'zs',
    'ring_r1': 'ring_continuity_r1',
    'ring_rn': 'ring_continuity_rn',
    'ring_r2': 'ring_continuity_r2',
    'mcb_type': 'ocpd_type',
    'mcb_rating': 'ocpd_rating',
    'breaker_type': 'ocpd_type',
    'breaker_rating': 'ocpd_rating',
};

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
            logger.warn('Unknown field name from Sonnet', { sessionId, field: reading.field, circuit: reading.circuit, value: reading.value });
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

          case 'session_pause':
            if (currentSessionId && activeSessions.has(currentSessionId)) {
              activeSessions.get(currentSessionId).session.pause();
              ws.send(JSON.stringify({ type: 'session_ack', status: 'paused' }));
            }
            break;

          case 'session_resume':
            if (currentSessionId && activeSessions.has(currentSessionId)) {
              activeSessions.get(currentSessionId).session.resume();
              ws.send(JSON.stringify({ type: 'session_ack', status: 'resumed' }));
            }
            break;

          case 'session_compact':
            if (currentSessionId && activeSessions.has(currentSessionId)) {
              const entry = activeSessions.get(currentSessionId);
              const now = Date.now();
              if (now - entry.lastClientCompactTime < 120_000) {
                logger.info('Client compact rate-limited', { sessionId: currentSessionId, secondsSinceLast: Math.round((now - entry.lastClientCompactTime) / 1000) });
                ws.send(JSON.stringify({ type: 'session_ack', status: 'compact_skipped', reason: 'rate_limited' }));
                break;
              }
              entry.lastClientCompactTime = now;
              try {
                await entry.session.compact();
                ws.send(JSON.stringify({ type: 'session_ack', status: 'compacted' }));
                logger.info('Session compacted on request', { sessionId: currentSessionId });
              } catch (error) {
                logger.error('Compact failed', { sessionId: currentSessionId, error: error.message });
                ws.send(JSON.stringify({ type: 'session_ack', status: 'compact_failed' }));
              }
            }
            break;

          case 'session_stop':
            await handleSessionStop(ws, currentSessionId);
            currentSessionId = null;
            break;

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
        }
      } catch (error) {
        logger.error('SonnetStream message handling error', { type: msg.type, error: error.message });
        ws.send(JSON.stringify({ type: 'error', message: error.message, recoverable: true }));
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      logger.info('SonnetStream connection closed', { userId });
      if (currentSessionId && activeSessions.has(currentSessionId)) {
        // Clean up after 30s timeout (allow reconnection)
        const entry = activeSessions.get(currentSessionId);
        // 5-minute timeout to preserve conversation history across Deepgram sleep/wake cycles.
        // iOS may disconnect the WebSocket during auto-sleep (no audio for 60s) and reconnect
        // when speech resumes. The longer timeout keeps the Sonnet session alive in memory.
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
            ws.send(JSON.stringify({ type: 'question', ...q }));
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

    const session = new EICRExtractionSession(apiKey, sessionId);
    const questionGate = new QuestionGate((questions) => {
      // Send gated questions to iOS
      for (const q of questions) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'question', ...q }));
        }
      }
    });

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
      lastClientCompactTime: 0
    });

    ws.send(JSON.stringify({ type: 'session_ack', status: 'started' }));
    logger.info('Session started', { sessionId, jobId });
  }

  async function handleTranscript(ws, sessionId, msg) {
    if (!sessionId || !activeSessions.has(sessionId)) {
      logger.warn('Transcript received but no active session', { sessionId: sessionId || null });
      ws.send(JSON.stringify({ type: 'error', message: 'No active session — reconnecting', recoverable: true }));
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
      logger.info('Extracting from transcript', { sessionId, textPreview: msg.text.substring(0, 80) });
      const regexResults = msg.regexResults || entry.lastRegexResults || [];
      const result = await entry.session.extractFromUtterance(msg.text, regexResults, {
        confirmationsEnabled: msg.confirmations_enabled || false
      });
      entry.lastRegexResults = [];

      // Validate and auto-correct field names before sending to iOS
      validateAndCorrectFields(result, sessionId);

      logger.info('Extraction result', { sessionId, readings: result.extracted_readings.length, questions: (result.questions_for_user || []).length, confirmations: (result.confirmations || []).length });

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
          result.extracted_readings.map(r => `${r.field}:${r.circuit}`)
        );
        entry.questionGate.resolveByFields(resolvedFields);
      }

      // Periodic orphaned value review — every 5 extraction turns
      if (entry.session.turnCount > 0 && entry.session.turnCount % 5 === 0) {
        try {
          const reviewResult = await entry.session.reviewForOrphanedValues();
          if (reviewResult?.questions_for_user?.length > 0) {
            logger.info('Orphaned review found questions', { sessionId, count: reviewResult.questions_for_user.length });
            entry.questionGate.enqueue(reviewResult.questions_for_user);
          }
        } catch (reviewErr) {
          logger.warn('Orphaned review failed', { sessionId, error: reviewErr.message });
        }
      }
    } catch (error) {
      logger.error('Extraction error', { sessionId, error: error.message });
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Extraction failed: ${error.message}`, recoverable: true }));
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



  async function handleSessionStop(ws, sessionId) {
    if (!sessionId || !activeSessions.has(sessionId)) return;
    const entry = activeSessions.get(sessionId);
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
