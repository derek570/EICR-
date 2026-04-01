// eicr-extraction-session.js
// Core multi-turn Sonnet conversation manager for EICR extraction.
// Maintains conversation history with prompt caching and sliding window.

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { CostTracker } from './cost-tracker.js';
import { lookupPostcode } from '../postcode_lookup.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Number of user+assistant exchange pairs to include in the API sliding window.
// Full conversation history is always stored internally; only the last N exchanges
// are sent to the API, preceded by a state snapshot of all extracted values.
const SLIDING_WINDOW_SIZE = 6;

// Utterance batching — buffer consecutive transcript chunks before making a Sonnet
// API call. A 72-turn session with BATCH_SIZE=2 becomes ~36 API calls, cutting
// Sonnet cost by ~50% while keeping latency under 4s for isolated readings.
// The timeout ensures buffered utterances are processed even if the speaker pauses.
const BATCH_SIZE = 2;
const BATCH_TIMEOUT_MS = 2000; // ms to wait for more utterances before flushing

// Cache keepalive — send a minimal API call after 4 minutes of silence to refresh
// the 5-minute prompt cache before it expires. Costs ~$0.003 per keepalive (cache reads only).
const CACHE_KEEPALIVE_MS = 4 * 60 * 1000; // 4 minutes

// Number of most-recently-updated circuits to include in full detail in the state snapshot.
// Older circuits are listed by number only (values stored server-side, not sent to API).
const SNAPSHOT_RECENT_CIRCUITS = 3;

// Compact field ID mapping for state snapshot — reduces per-circuit token cost ~55%.
// Only circuit-level fields that repeat across circuits are mapped.
// Supply fields (circuit 0) use full names since they appear only once.
const FIELD_ID_MAP = {
  circuit_designation: 1,
  wiring_type: 2,
  ref_method: 3,
  number_of_points: 4,
  cable_size: 5,
  cable_size_earth: 6,
  ocpd_type: 7,
  ocpd_rating: 8,
  ocpd_bs_en: 9,
  ocpd_breaking_capacity: 10,
  rcd_type: 11,
  rcd_operating_current_ma: 12,
  rcd_bs_en: 13,
  r1_plus_r2: 14,
  r2: 15,
  ring_continuity_r1: 16,
  ring_continuity_rn: 17,
  ring_continuity_r2: 18,
  ir_test_voltage: 19,
  insulation_resistance_l_l: 20,
  insulation_resistance_l_e: 21,
  zs: 22,
  rcd_trip_time: 23,
  rcd_button_confirmed: 24,
  afdd_button_confirmed: 25,
  polarity: 26,
  max_disconnect_time: 27,
};

// Load externalized system prompts at module init
// Must be >=1024 tokens for Sonnet 4.5 prompt caching
export const EICR_SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'sonnet_extraction_system.md'),
  'utf8'
);

export const EIC_SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, '..', '..', 'config', 'prompts', 'sonnet_extraction_eic_system.md'),
  'utf8'
);

export class EICRExtractionSession {
  constructor(apiKey, sessionId, certType = 'eicr') {
    this.client = new Anthropic({ apiKey });
    this.sessionId = sessionId;
    this.certType = certType; // 'eicr' or 'eic'
    this.systemPrompt = certType === 'eic' ? EIC_SYSTEM_PROMPT : EICR_SYSTEM_PROMPT;
    this.conversationHistory = []; // Array of { role, content } messages
    this.costTracker = new CostTracker();
    this.extractedReadingsCount = 0;
    this.askedQuestions = [];
    this.extractedObservationTexts = []; // Track observations already sent to iOS for dedup
    this.turnCount = 0;
    this.circuitSchedule = '';
    this.circuitScheduleIncluded = false;
    this.isActive = false;

    // Utterance batching state
    this.utteranceBuffer = []; // Buffered { transcriptText, regexResults, options }
    this.batchTimeoutHandle = null;
    this.onBatchResult = null; // Callback for async batch flush results: (result) => void

    // Cache keepalive — refreshes 5-min prompt cache during silence
    this.cacheKeepaliveHandle = null;

    // Rolling state snapshot: accumulates all extracted values across the session.
    // Used to provide context in the sliding window without sending full history.
    this.stateSnapshot = {
      circuits: {}, // { circuitNum: { field: value, ... } }
      pending_readings: [], // readings with circuit -1 (unassigned)
      observations: [], // deduped observation texts
      validation_alerts: [],
    };

    // Tracks order in which circuits were last updated, for snapshot windowing.
    // Most recently updated circuits appear at the end.
    this.recentCircuitOrder = [];
  }

  // Extract text from a message content (handles both string and content block array formats)
  static messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => b.text || '').join('');
    return '';
  }

  start(jobState) {
    this.isActive = true;
    this.costTracker.startRecording();
    if (jobState) {
      this.circuitSchedule = this.buildCircuitSchedule(jobState);
    }
    this._resetCacheKeepalive();
    logger.info(`Session ${this.sessionId} Started`);
  }

  pause() {
    this._clearCacheKeepalive();
    this.costTracker.pauseRecording();
    logger.info(`Session ${this.sessionId} Paused`);
  }

  resume() {
    this.costTracker.resumeRecording();
    this._resetCacheKeepalive();
    logger.info(`Session ${this.sessionId} Resumed`);
  }

  stop() {
    // Clear batch timeout — caller should call flushUtteranceBuffer() before stop()
    // to ensure no utterances are lost.
    if (this.batchTimeoutHandle) {
      clearTimeout(this.batchTimeoutHandle);
      this.batchTimeoutHandle = null;
    }
    this._clearCacheKeepalive();
    this.isActive = false;
    this.costTracker.stopRecording();
    const summary = this.costTracker.toSessionSummary();
    summary.extraction.readingsExtracted = this.extractedReadingsCount;
    summary.extraction.questionsAsked = this.askedQuestions.length;
    logger.info(`Session ${this.sessionId} Stopped. Cost: $${summary.totalJobCost.toFixed(4)}`);
    return summary;
  }

  /**
   * Send a minimal API call to keep the prompt cache warm during silence.
   * Only sends the system prompt + a tiny keepalive message — no conversation
   * history, no state snapshot. Costs ~$0.003 (cache reads only).
   */
  async _sendCacheKeepalive() {
    if (!this.isActive) return;
    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        system: [
          {
            type: 'text',
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
        messages: [{ role: 'user', content: [{ type: 'text', text: '[keepalive]' }] }],
      });
      this.costTracker.addSonnetUsage(response.usage);
      logger.info(`Session ${this.sessionId} Cache keepalive sent`);
    } catch (error) {
      logger.warn(`Session ${this.sessionId} Cache keepalive failed: ${error.message}`);
    }
    // Schedule next keepalive
    this._resetCacheKeepalive();
  }

  _resetCacheKeepalive() {
    this._clearCacheKeepalive();
    if (this.isActive) {
      this.cacheKeepaliveHandle = setTimeout(() => this._sendCacheKeepalive(), CACHE_KEEPALIVE_MS);
    }
  }

  _clearCacheKeepalive() {
    if (this.cacheKeepaliveHandle) {
      clearTimeout(this.cacheKeepaliveHandle);
      this.cacheKeepaliveHandle = null;
    }
  }

  updateJobState(jobState) {
    this.circuitSchedule = this.buildCircuitSchedule(jobState);
    this.circuitScheduleIncluded = false; // Force re-send on next utterance
  }

  /**
   * Public entry point for transcript chunks. Buffers utterances and batches them
   * to reduce Sonnet API calls. Returns immediately with an empty result for
   * buffered (non-full) batches; returns the real extraction result when the
   * batch fires (buffer full) or when flushed via timeout/stop.
   */
  async extractFromUtterance(transcriptText, regexResults = [], options = {}) {
    // Add to buffer
    this.utteranceBuffer.push({ transcriptText, regexResults, options });

    // Clear any existing flush timeout
    if (this.batchTimeoutHandle) {
      clearTimeout(this.batchTimeoutHandle);
      this.batchTimeoutHandle = null;
    }

    // If buffer is full, process batch immediately
    if (this.utteranceBuffer.length >= BATCH_SIZE) {
      return this._processUtteranceBatch();
    }

    // Buffer not full — set timeout to flush and return empty result.
    // The timeout ensures utterances don't sit in the buffer indefinitely
    // if the speaker pauses (e.g., waiting for feedback after a question).
    this.batchTimeoutHandle = setTimeout(() => {
      this._flushBatchAsync();
    }, BATCH_TIMEOUT_MS);

    logger.info(
      `Session ${this.sessionId} Batched utterance ${this.utteranceBuffer.length}/${BATCH_SIZE}, waiting for more`
    );

    return {
      extracted_readings: [],
      field_clears: [],
      circuit_updates: [],
      observations: [],
      validation_alerts: [],
      questions_for_user: [],
      confirmations: [],
    };
  }

  /**
   * Combine buffered utterances and process as a single Sonnet API call.
   */
  async _processUtteranceBatch() {
    const batch = this.utteranceBuffer.splice(0); // drain buffer
    if (batch.length === 0) return null;

    // Combine transcript texts with separator
    const combinedText = batch.map((b) => b.transcriptText).join(' ... ');

    // Merge all regex results
    const combinedRegex = batch.flatMap((b) => b.regexResults || []);

    // Merge options: confirmations enabled if any item had it
    const combinedOptions = {
      confirmationsEnabled: batch.some((b) => b.options?.confirmationsEnabled),
    };

    logger.info(
      `Session ${this.sessionId} Processing batch of ${batch.length} utterances as single API call`
    );

    return this._extractSingle(combinedText, combinedRegex, combinedOptions);
  }

  /**
   * Async flush triggered by batch timeout. Delivers result via onBatchResult callback.
   */
  async _flushBatchAsync() {
    this.batchTimeoutHandle = null;
    if (this.utteranceBuffer.length === 0) return;
    try {
      const result = await this._processUtteranceBatch();
      if (result && this.onBatchResult) {
        this.onBatchResult(result);
      }
    } catch (error) {
      logger.error(`Session ${this.sessionId} Batch flush error: ${error.message}`);
    }
  }

  /**
   * Explicitly flush buffered utterances. Call before stop() to ensure
   * no utterances are lost. Returns the extraction result or null if empty.
   */
  async flushUtteranceBuffer() {
    if (this.batchTimeoutHandle) {
      clearTimeout(this.batchTimeoutHandle);
      this.batchTimeoutHandle = null;
    }
    if (this.utteranceBuffer.length === 0) return null;
    return this._processUtteranceBatch();
  }

  async _extractSingle(transcriptText, regexResults = [], options = {}) {
    // Check if regex results contain a postcode — if so, look it up via postcodes.io
    let postcodeLookupResult = null;
    if (regexResults && regexResults.length > 0) {
      const postcodeEntry = regexResults.find((r) => r.field === 'install.postcode' && r.value);
      if (postcodeEntry) {
        try {
          const lookup = await lookupPostcode(postcodeEntry.value);
          if (lookup) {
            postcodeLookupResult = {
              postcode: lookup.postcode,
              town: lookup.town,
              county: lookup.county,
              valid: true,
            };
            logger.info(
              `Session ${this.sessionId} Postcode lookup: ${postcodeEntry.value} → ${lookup.town}, ${lookup.county}`
            );
          } else {
            postcodeLookupResult = {
              postcode: postcodeEntry.value,
              valid: false,
            };
            logger.info(
              `Session ${this.sessionId} Postcode lookup: ${postcodeEntry.value} → not found`
            );
          }
        } catch (err) {
          logger.warn(`Session ${this.sessionId} Postcode lookup failed: ${err.message}`);
        }
      }
    }

    // Build the windowed message history first (may reset circuitScheduleIncluded flag)
    const windowMessages = this.buildMessageWindow();

    let userMessage = this.buildUserMessage(transcriptText, regexResults, postcodeLookupResult);
    if (options.confirmationsEnabled) {
      userMessage += '\n\n[CONFIRMATIONS ENABLED]';
    }

    // Build messages array: sliding window + new user message with cache_control
    const messages = [
      ...windowMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userMessage,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      },
    ];

    // Add mid-conversation breakpoints if >20 blocks
    this.addMidConversationBreakpoints(messages);

    const response = await this.callWithRetry(messages);

    // Reset cache keepalive timer — real API call just refreshed the cache
    this._resetCacheKeepalive();

    // Extract text response
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      // Still push to conversation history to keep it in sync
      this.conversationHistory.push(
        { role: 'user', content: [{ type: 'text', text: userMessage }] },
        { role: 'assistant', content: [{ type: 'text', text: '{}' }] }
      );
      throw new Error('No text block in Sonnet response');
    }

    const rawText = textBlock.text;
    const EMPTY_RESULT = {
      extracted_readings: [],
      field_clears: [],
      circuit_updates: [],
      observations: [],
      validation_alerts: [],
      questions_for_user: [],
      confirmations: [],
    };
    let result;

    try {
      const resultJSON = this.extractJSON(rawText);
      const parsed = JSON.parse(resultJSON);
      // Validate expected array fields
      result = {
        extracted_readings: Array.isArray(parsed.extracted_readings)
          ? parsed.extracted_readings
          : [],
        field_clears: Array.isArray(parsed.field_clears) ? parsed.field_clears : [],
        circuit_updates: Array.isArray(parsed.circuit_updates) ? parsed.circuit_updates : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        validation_alerts: Array.isArray(parsed.validation_alerts) ? parsed.validation_alerts : [],
        questions_for_user: Array.isArray(parsed.questions_for_user)
          ? parsed.questions_for_user
          : [],
        confirmations: Array.isArray(parsed.confirmations) ? parsed.confirmations : [],
      };
    } catch (parseError) {
      logger.warn(`Session ${this.sessionId} Failed to parse Sonnet JSON: ${parseError.message}`);
      result = EMPTY_RESULT;
    }

    // ALWAYS push to conversation history (even on parse failure) to keep context in sync
    this.conversationHistory.push(
      { role: 'user', content: [{ type: 'text', text: userMessage }] },
      { role: 'assistant', content: [{ type: 'text', text: rawText }] }
    );

    // Track metrics
    this.turnCount++;
    this.extractedReadingsCount += result.extracted_readings.length;
    if (result.questions_for_user.length > 0) {
      const newQuestions = result.questions_for_user.map(
        (q) => `${q.field || 'unknown'}:${q.circuit || 'unknown'}`
      );
      this.askedQuestions.push(...newQuestions);
      // Cap at 30 entries
      while (this.askedQuestions.length > 30) {
        this.askedQuestions.shift();
      }
    }

    // Dedup extracted readings: suppress true duplicates (same field + circuit + value)
    // but allow corrections (same field + circuit, DIFFERENT value) to pass through.
    if (result.extracted_readings.length > 0) {
      result.extracted_readings = result.extracted_readings.filter((reading) => {
        const circuit = reading.circuit;
        const field = reading.field;
        const value = reading.value;
        // Pending (circuit -1) readings are never deduped
        if (circuit === -1) return true;
        const circuitData = this.stateSnapshot.circuits[circuit];
        if (!circuitData || !(field in circuitData)) return true; // new field, pass through
        const existingValue = circuitData[field];
        // Same value = true duplicate, suppress

        if (existingValue == value || String(existingValue) === String(value)) {
          logger.info(
            `Session ${this.sessionId} Reading deduped (same value): circuit ${circuit}, ${field}=${value}`
          );
          return false;
        }
        // Different value = correction, pass through
        logger.info(
          `Session ${this.sessionId} Reading correction allowed: circuit ${circuit}, ${field}: ${existingValue} → ${value}`
        );
        return true;
      });
    }

    // Dedup observations: filter out any that match already-sent observations
    if (result.observations.length > 0) {
      result.observations = result.observations.filter((obs) => {
        const text = (obs.observation_text || '').toLowerCase();
        if (!text) return false;
        const isDupe = this.extractedObservationTexts.some((prev) => {
          // Check word overlap: >50% shared words = duplicate
          const prevWords = new Set(prev.split(/\s+/));
          const newWords = text.split(/\s+/);
          if (newWords.length === 0) return true;
          const overlap = newWords.filter((w) => prevWords.has(w)).length;
          return overlap / newWords.length > 0.5;
        });
        if (isDupe) {
          logger.info(
            `Session ${this.sessionId} Observation deduped (server): ${text.substring(0, 60)}`
          );
        } else {
          this.extractedObservationTexts.push(text);
        }
        return !isDupe;
      });
    }

    // Update rolling state snapshot with this response
    this.updateStateSnapshot(result);

    // Track token costs
    this.costTracker.addSonnetUsage(response.usage);

    return result;
  }

  async callWithRetry(messages, maxRetries = 3, systemPrompt = null, maxTokens = 1280) {
    const system = systemPrompt
      ? systemPrompt
      : [
          {
            type: 'text',
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ];

    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system,
          messages,
        });
      } catch (error) {
        lastError = error;
        if (error.status === 429 || error.status >= 500) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          logger.warn(
            `Session ${this.sessionId} Sonnet error ${error.status}, retry ${attempt + 1}/${maxRetries} after ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error; // Client errors -- don't retry
      }
    }
    throw lastError || new Error('Max retries exceeded');
  }

  addMidConversationBreakpoints(messages) {
    const blockCount = messages.length;
    if (blockCount <= 20) return;
    // Anthropic allows max 4 cache_control blocks total.
    // 1 is on the system prompt, 1 on the latest user message,
    // so we can place at most 2 mid-conversation breakpoints.
    //
    // IMPORTANT: First strip ALL stale cache_control from conversation history
    // messages (all except the last one, which is the new user message).
    // Previous calls to this method mutate the shared message objects via
    // shallow copy, so old breakpoints accumulate and exceed the 4-block limit.
    for (let i = 0; i < blockCount - 1; i++) {
      const msg = messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.cache_control) {
            delete block.cache_control;
          }
        }
      }
    }
    // Collect all eligible positions, then keep only the last 2
    // (nearest the end) for best cache hit rates.
    const candidates = [];
    for (let i = 18; i < blockCount - 2; i += 18) {
      const msg = messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        candidates.push(i);
      }
    }
    // Keep only the last 2 candidates
    const selected = candidates.slice(-2);
    for (const idx of selected) {
      const msg = messages[idx];
      const lastBlock = msg.content[msg.content.length - 1];
      lastBlock.cache_control = { type: 'ephemeral', ttl: '1h' };
    }
  }

  buildUserMessage(transcriptText, regexResults = [], postcodeLookup = null) {
    const parts = [];
    parts.push(`NEW utterance: ${transcriptText}`);
    if (regexResults && regexResults.length > 0) {
      parts.push(`Regex pre-filled fields (confirm or correct): ${JSON.stringify(regexResults)}`);
    }
    if (postcodeLookup) {
      if (postcodeLookup.valid) {
        parts.push(
          `POSTCODE LOOKUP: "${postcodeLookup.postcode}" → ${postcodeLookup.town}, ${postcodeLookup.county} (valid)`
        );
      } else {
        parts.push(`POSTCODE LOOKUP: "${postcodeLookup.postcode}" → not found (invalid postcode)`);
      }
    }
    // Only include circuit schedule on first message and after job state updates
    if (this.circuitSchedule && !this.circuitScheduleIncluded) {
      parts.push(
        `CIRCUIT SCHEDULE (confirmed values -- do NOT question these):\n${this.circuitSchedule}`
      );
      this.circuitScheduleIncluded = true;
    }
    if (this.askedQuestions.length > 0) {
      parts.push(`Already asked (skip): ${this.askedQuestions.join('; ')}`);
    }
    if (this.extractedObservationTexts.length > 0) {
      parts.push(
        `Observations already created (do NOT re-extract): ${this.extractedObservationTexts.map((t) => t.substring(0, 60)).join('; ')}`
      );
    }
    return parts.join('\n\n');
  }

  /**
   * Build the sliding window of messages to send to the API.
   * Returns: [stateSnapshot, ack, ...lastNExchanges] or just [...lastNExchanges]
   * Full conversation history remains in this.conversationHistory for storage.
   */
  buildMessageWindow() {
    const window = [];
    const maxMessages = SLIDING_WINDOW_SIZE * 2; // each exchange = user + assistant
    const startIdx = Math.max(0, this.conversationHistory.length - maxMessages);

    // If circuit schedule was included in a message now outside the window, reset flag
    // so buildUserMessage re-includes it in the next user message
    if (this.circuitSchedule && this.circuitScheduleIncluded && startIdx > 0) {
      this.circuitScheduleIncluded = false;
    }

    // Add state snapshot if we have extracted data or circuit schedule.
    // The snapshot now includes the circuit schedule (designations, supply info)
    // so Sonnet retains full context even when older messages drop from the window.
    const snapshot = this.buildStateSnapshotMessage();
    if (snapshot) {
      window.push(
        { role: 'user', content: [{ type: 'text', text: snapshot }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"acknowledged": true}' }] }
      );
      // Mark circuit schedule as included so buildUserMessage doesn't duplicate it
      if (this.circuitSchedule) {
        this.circuitScheduleIncluded = true;
      }
    }

    // Add last N exchanges from conversation history
    window.push(...this.conversationHistory.slice(startIdx));

    logger.info(
      `Session ${this.sessionId} Window: ${window.length} msgs sent (${this.conversationHistory.length} stored, snapshot=${!!snapshot})`
    );

    return window;
  }

  /**
   * Update the rolling state snapshot with values from a Sonnet response.
   * Called after every extractFromUtterance to keep the snapshot current.
   */
  updateStateSnapshot(result) {
    if (!result) return;

    // Process extracted readings
    if (result.extracted_readings && result.extracted_readings.length > 0) {
      for (const reading of result.extracted_readings) {
        const circuit = reading.circuit;
        const field = reading.field;
        if (circuit === -1) {
          // Unassigned reading — track as pending
          this.stateSnapshot.pending_readings.push({
            field,
            value: reading.value,
            unit: reading.unit || null,
          });
        } else {
          // Circuit-level (or supply at circuit 0) reading
          if (!this.stateSnapshot.circuits[circuit]) {
            this.stateSnapshot.circuits[circuit] = {};
          }
          this.stateSnapshot.circuits[circuit][field] = reading.value;
          // Track recency for snapshot windowing (circuit 0 excluded — always shown)
          if (circuit !== 0) {
            const idx = this.recentCircuitOrder.indexOf(circuit);
            if (idx !== -1) this.recentCircuitOrder.splice(idx, 1);
            this.recentCircuitOrder.push(circuit);
          }
          // Resolve any pending readings that match this field+value
          this.stateSnapshot.pending_readings = this.stateSnapshot.pending_readings.filter(
            (p) => !(p.field === field && p.value === reading.value)
          );
        }
      }
    }

    // Process field clears
    if (result.field_clears && result.field_clears.length > 0) {
      for (const clear of result.field_clears) {
        if (clear.circuit != null && this.stateSnapshot.circuits[clear.circuit]) {
          delete this.stateSnapshot.circuits[clear.circuit][clear.field];
        }
      }
    }

    // Accumulate observations (dedup by text match)
    if (result.observations && result.observations.length > 0) {
      for (const obs of result.observations) {
        const text = (obs.observation_text || '').toLowerCase();
        if (text && !this.stateSnapshot.observations.includes(text)) {
          this.stateSnapshot.observations.push(text);
        }
      }
    }

    // Accumulate validation alerts (dedup by JSON equality)
    if (result.validation_alerts && result.validation_alerts.length > 0) {
      for (const alert of result.validation_alerts) {
        const key = JSON.stringify(alert);
        if (!this.stateSnapshot.validation_alerts.some((a) => JSON.stringify(a) === key)) {
          this.stateSnapshot.validation_alerts.push(alert);
        }
      }
    }
  }

  /**
   * Build a compact state snapshot message for the API.
   * Returns null if nothing has been extracted yet.
   *
   * Includes the circuit schedule (designations, supply info, hardware) alongside
   * extracted values so Sonnet retains full context even when older conversational
   * messages drop out of the sliding window.
   */
  buildStateSnapshotMessage() {
    const hasCircuits = Object.keys(this.stateSnapshot.circuits).length > 0;
    const hasPending = this.stateSnapshot.pending_readings.length > 0;
    const hasObs = this.stateSnapshot.observations.length > 0;
    const hasAlerts = this.stateSnapshot.validation_alerts.length > 0;
    const hasSchedule = !!this.circuitSchedule;

    if (!hasCircuits && !hasPending && !hasObs && !hasAlerts && !hasSchedule) {
      return null;
    }

    const parts = [];

    // Include circuit schedule so Sonnet knows circuit designations, supply info,
    // and hardware details even after early messages drop from the sliding window.
    // Without this, Sonnet loses context after ~6 exchanges and can't assign readings
    // to the correct circuits, producing empty extractions.
    if (hasSchedule) {
      parts.push(
        `CIRCUIT SCHEDULE (confirmed values — do NOT question these):\n${this.circuitSchedule}`
      );
    }

    // Build compact extracted readings section.
    // Circuit 0 (supply) always included with full field names (appears once).
    // Most recent N circuits included with compact numeric field IDs.
    // Older circuits listed by number only — values stored server-side.
    if (hasCircuits || hasPending) {
      const lines = [];

      // Circuit 0 — supply fields, full names (only appears once)
      const supplyData = this.stateSnapshot.circuits[0];
      if (supplyData && Object.keys(supplyData).length > 0) {
        lines.push(`0:${JSON.stringify(supplyData)}`);
      }

      // Split non-supply circuits into recent (detailed) and older (summary)
      const recentNums = this.recentCircuitOrder.slice(-SNAPSHOT_RECENT_CIRCUITS);
      const allNonSupply = Object.keys(this.stateSnapshot.circuits)
        .map(Number)
        .filter((n) => n !== 0);
      const olderNums = allNonSupply.filter((n) => !recentNums.includes(n)).sort((a, b) => a - b);

      if (olderNums.length > 0) {
        lines.push(`${olderNums.length} earlier circuits (${olderNums.join(',')}) extracted`);
      }

      // Recent circuits — compact field IDs
      for (const num of recentNums) {
        const fields = this.stateSnapshot.circuits[num];
        if (!fields) continue;
        const compact = {};
        for (const [field, value] of Object.entries(fields)) {
          const id = FIELD_ID_MAP[field];
          compact[id != null ? id : field] = value;
        }
        lines.push(`${num}:${JSON.stringify(compact)}`);
      }

      // Pending readings (unassigned to a circuit)
      if (hasPending) {
        lines.push(`pending:${JSON.stringify(this.stateSnapshot.pending_readings)}`);
      }

      if (hasAlerts) {
        lines.push(`alerts:${JSON.stringify(this.stateSnapshot.validation_alerts)}`);
      }

      parts.push(
        `EXTRACTED (field IDs per system prompt — do NOT re-emit identical values, but DO output corrections with DIFFERENT values):\n${lines.join('\n')}`
      );
    }

    // Observations as a separate, clear section
    if (hasObs) {
      parts.push(
        `OBSERVATIONS ALREADY RECORDED (do NOT re-extract):\n${this.stateSnapshot.observations.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
      );
    }

    return parts.join('\n\n');
  }

  buildCircuitSchedule(jobState) {
    if (!jobState || !jobState.circuits) return '';
    const lines = [];
    for (const circuit of jobState.circuits) {
      const num = circuit.ref || circuit.circuitNumber || circuit.number || '?';
      const desc =
        circuit.designation || circuit.description || circuit.circuit_description || 'unnamed';
      const fields = [];

      // Derive circuit type from designation
      if (circuit.circuit_type) {
        fields.push(`${circuit.circuit_type}`);
      } else {
        const d = (desc || '').toLowerCase();
        if (d.includes('socket') || d.includes('ring')) fields.push('Ring');
        else if (d.includes('light')) fields.push('Lighting');
        else if (
          d.includes('cooker') ||
          d.includes('shower') ||
          d.includes('oven') ||
          d.includes('hob')
        )
          fields.push('Radial');
      }

      // OCPD
      const ocpdType = circuit.ocpdType || circuit.ocpd_type;
      const ocpdRating = circuit.ocpdRatingA || circuit.ocpd_rating;
      if (ocpdType && ocpdRating) fields.push(`ocpd=${ocpdType}/${ocpdRating}A`);
      else if (ocpdType) fields.push(`ocpd=${ocpdType}`);
      else if (ocpdRating) fields.push(`${ocpdRating}A`);

      // Cable sizes
      const liveCsa = circuit.liveCsaMm2 || circuit.cable_size_live || circuit.cable_size;
      const earthCsa = circuit.cpcCsaMm2 || circuit.cable_size_earth;
      if (liveCsa && earthCsa) fields.push(`cable=${liveCsa}/${earthCsa}mm`);
      else if (liveCsa) fields.push(`cable=${liveCsa}mm`);

      // Wiring and ref method
      if (circuit.wiringType || circuit.wiring_type)
        fields.push(`wiring=${circuit.wiringType || circuit.wiring_type}`);
      if (circuit.refMethod || circuit.ref_method)
        fields.push(`ref=${circuit.refMethod || circuit.ref_method}`);

      // Test readings
      if (circuit.measuredZsOhm || circuit.zs)
        fields.push(`zs=${circuit.measuredZsOhm || circuit.zs}`);
      if (circuit.r1R2Ohm || circuit.r1_plus_r2)
        fields.push(`r1r2=${circuit.r1R2Ohm || circuit.r1_plus_r2}`);
      if (circuit.r2Ohm || circuit.r2) fields.push(`r2=${circuit.r2Ohm || circuit.r2}`);
      if (circuit.ringR1Ohm) fields.push(`ringR1=${circuit.ringR1Ohm}`);
      if (circuit.ringRnOhm) fields.push(`ringRn=${circuit.ringRnOhm}`);
      if (circuit.ringR2Ohm) fields.push(`ringR2=${circuit.ringR2Ohm}`);
      if (circuit.irLiveEarthMohm || circuit.insulation_resistance_l_e)
        fields.push(`irLE=${circuit.irLiveEarthMohm || circuit.insulation_resistance_l_e}`);
      if (circuit.irLiveLiveMohm || circuit.insulation_resistance_l_l)
        fields.push(`irLL=${circuit.irLiveLiveMohm || circuit.insulation_resistance_l_l}`);

      // Polarity
      if (circuit.polarityConfirmed || circuit.polarity)
        fields.push(`polarity=${circuit.polarityConfirmed || circuit.polarity}`);

      // RCD
      const rcdTime = circuit.rcdTimeMs || circuit.rcd_trip_time;
      const rcdRating = circuit.rcdRatingA || circuit.rcd_rating_a;
      if (rcdTime && rcdRating) fields.push(`rcd=${rcdTime}ms/${rcdRating}mA`);
      else if (rcdTime) fields.push(`rcd=${rcdTime}ms`);
      else if (rcdRating) fields.push(`rcd=${rcdRating}mA`);

      // RCD/AFDD buttons
      if (circuit.rcdButtonConfirmed) fields.push(`rcdBtn=OK`);
      if (circuit.afddButtonConfirmed) fields.push(`afddBtn=OK`);

      // Points
      if (circuit.numberOfPoints || circuit.number_of_points)
        fields.push(`points=${circuit.numberOfPoints || circuit.number_of_points}`);

      lines.push(`  Circuit ${num}: ${desc} [${fields.join(', ')}]`);
    }

    // Supply section
    if (jobState.supply) {
      const s = jobState.supply;
      const supplyFields = [];
      if (s.earthingArrangement || s.earthing_arrangement)
        supplyFields.push(`earthing=${s.earthingArrangement || s.earthing_arrangement}`);
      if (s.pfc || s.pfc_at_origin) supplyFields.push(`PFC=${s.pfc || s.pfc_at_origin}kA`);
      if (s.ze) supplyFields.push(`Ze=${s.ze}ohms`);
      if (s.zsAtDb || s.zs_at_db) supplyFields.push(`ZsDb=${s.zsAtDb || s.zs_at_db}`);
      if (s.earthingConductorCsa || s.main_earth_conductor_csa)
        supplyFields.push(
          `earthConductor=${s.earthingConductorCsa || s.main_earth_conductor_csa}mm2`
        );
      if (s.mainBondingCsa || s.main_bonding_conductor_csa)
        supplyFields.push(`bonding=${s.mainBondingCsa || s.main_bonding_conductor_csa}mm2`);
      if (s.bondingWater || s.bonding_water) supplyFields.push(`water=Yes`);
      if (s.bondingGas || s.bonding_gas) supplyFields.push(`gas=Yes`);
      if (s.earthElectrodeType || s.earth_electrode_type)
        supplyFields.push(`electrodeType=${s.earthElectrodeType || s.earth_electrode_type}`);
      if (s.earthElectrodeResistance || s.earth_electrode_resistance)
        supplyFields.push(
          `electrodeRA=${s.earthElectrodeResistance || s.earth_electrode_resistance}`
        );
      if (s.supplyPolarity || s.supply_polarity_confirmed) supplyFields.push(`polarity=confirmed`);
      if (s.supplyVoltage || s.supply_voltage)
        supplyFields.push(`voltage=${s.supplyVoltage || s.supply_voltage}V`);
      lines.unshift(`  Supply: [${supplyFields.join(', ')}]`);
    }
    return lines.join('\n');
  }

  /**
   * Periodic review: ask Sonnet to check for orphaned values in the conversation.
   * Returns questions_for_user array, or null if nothing found.
   */
  async reviewForOrphanedValues() {
    if (!this.isActive || this.conversationHistory.length < 4) return null;

    const reviewMessage = `REVIEW CHECK: Look back through this session. Are there any test readings (Zs, insulation resistance, R1+R2, R2, RCD trip time, ring continuity) that were spoken WITHOUT a clear circuit assignment and still haven't been resolved? If so, generate questions asking which circuit they belong to. Only include genuinely unresolved orphaned values. If everything is assigned, return empty arrays.`;

    const messages = [
      ...this.buildMessageWindow(),
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: reviewMessage,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      },
    ];

    this.addMidConversationBreakpoints(messages);

    const response = await this.callWithRetry(messages, 2, null, 512);

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) return null;

    let result;
    try {
      const json = this.extractJSON(textBlock.text);
      result = JSON.parse(json);
    } catch {
      return null;
    }

    // Do NOT push review exchange to conversationHistory — it's a meta-instruction,
    // not part of the extraction dialogue.
    // Do NOT increment turnCount — this is not an extraction turn.
    this.costTracker.addSonnetUsage(response.usage);

    return result;
  }

  extractJSON(text) {
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/```json?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();
    if (trimmed.startsWith('{')) return trimmed;
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last !== -1) return trimmed.slice(first, last + 1);
    return trimmed;
  }
}
