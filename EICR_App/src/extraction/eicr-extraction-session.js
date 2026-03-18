// eicr-extraction-session.js
// Core multi-turn Sonnet conversation manager for EICR extraction.
// Maintains conversation history with prompt caching and custom compaction.
//
// HISTORY (029b91f, 2026-02-23): Compaction was causing a cost blowout in production.
// The compact() method was being called too aggressively — even on small conversations,
// after failures, and in rapid succession. This wasted Anthropic API credits on
// summaries that often failed or produced truncated JSON. Five guards were added to
// compact() to prevent this: minimum message count, minimum token estimate, no-new-turns
// check, exponential failure backoff, and a 120-second rate limit. The max_tokens for
// compaction was also increased from 2048 to 4096 to prevent JSON truncation on long
// sessions. A client-side 120s rate limit was added to the session_compact WebSocket
// handler in sonnet-stream.js to match.

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { CostTracker } from './cost-tracker.js';
import { lookupPostcode } from '../postcode_lookup.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compaction threshold -- compact when conversation exceeds this many estimated tokens.
// HISTORY (2026-02-28): Raised from 6000 to 60000 to effectively disable compaction for
// normal sessions. With Anthropic prompt caching (1h TTL, cache reads at 10% of input rate),
// full conversation history is cheap (~$0.25-0.35 per 30-turn session). The old 6000 threshold
// caused compaction to fire after ~15-20 utterances, replacing rich conversational context with
// a dry field:value summary. This destroyed Sonnet's ability to infer circuit assignment from
// recent conversational flow (e.g. "Circuit 3" said 2 utterances ago). The 60000 threshold
// keeps compaction as a safety valve for extraordinarily long sessions (~150+ turns) while
// preserving full context for all normal inspections.
const COMPACTION_THRESHOLD = 60000;

// Number of user+assistant exchange pairs to include in the API sliding window.
// Full conversation history is always stored internally; only the last N exchanges
// are sent to the API, preceded by a state snapshot of all extracted values.
const SLIDING_WINDOW_SIZE = 6;

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

const COMPACTION_PROMPT = `You are summarizing an EICR electrical inspection recording session for continued extraction.

CRITICAL: You must preserve ALL confirmed readings exactly as extracted. This summary replaces the conversation history.

Output format -- return ONLY this JSON:
{
  "confirmed_readings": [
    { "circuit": <int>, "field": "<str>", "value": <number|string>, "unit": "<str|null>" }
  ],
  "pending_readings": [
    { "circuit": -1, "field": "<str>", "value": <number|string>, "unit": "<str|null>" }
  ],
  "observations_created": [
    { "code": "<C1|C2|C3|FI>", "observation_text": "<str>", "schedule_item": "<str|null>" }
  ],
  "active_circuit": <int|null>,
  "session_context": "<1-2 sentences about what the electrician is currently doing>",
  "questions_asked": ["<field:circuit pairs already asked about>"],
  "unresolved_values": [
    { "circuit": <int|null>, "field": "<str|null>", "heard_value": "<str>", "issue": "<str>" }
  ]
}

Rules:
- Every reading from extracted_readings across ALL turns MUST appear in confirmed_readings
- Readings with circuit: -1 (unassigned) go in pending_readings
- Every observation from observations arrays across ALL turns MUST appear in observations_created -- do NOT re-extract these
- active_circuit should be null (no active circuit tracking between utterances)
- session_context should capture what part of the inspection they are on
- questions_asked prevents re-asking the same questions
- unresolved_values captures anything flagged but not yet confirmed`;

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
    this.lastCompactedAtTurn = -1;
    this.compactionFailures = 0;
    this.lastCompactTime = 0;
    this.circuitSchedule = '';
    this.circuitScheduleIncluded = false;
    this.isActive = false;

    // Rolling state snapshot: accumulates all extracted values across the session.
    // Used to provide context in the sliding window without sending full history.
    this.stateSnapshot = {
      circuits: {},         // { circuitNum: { field: value, ... } }
      pending_readings: [], // readings with circuit -1 (unassigned)
      observations: [],     // deduped observation texts
      validation_alerts: [],
    };
  }

  // Extract text from a message content (handles both string and content block array formats)
  static messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => b.text || '').join('');
    return '';
  }

  // Rough token estimate (4 chars per token)
  get conversationTokenEstimate() {
    return this.conversationHistory.reduce((sum, msg) => {
      return sum + Math.ceil(EICRExtractionSession.messageText(msg.content).length / 4);
    }, 0);
  }

  start(jobState) {
    this.isActive = true;
    this.costTracker.startRecording();
    if (jobState) {
      this.circuitSchedule = this.buildCircuitSchedule(jobState);
    }
    logger.info(`Session ${this.sessionId} Started`);
  }

  pause() {
    this.costTracker.pauseRecording();
    logger.info(`Session ${this.sessionId} Paused`);
  }

  resume() {
    this.costTracker.resumeRecording();
    logger.info(`Session ${this.sessionId} Resumed`);
  }

  stop() {
    this.isActive = false;
    this.costTracker.stopRecording();
    const summary = this.costTracker.toSessionSummary();
    summary.extraction.readingsExtracted = this.extractedReadingsCount;
    summary.extraction.questionsAsked = this.askedQuestions.length;
    logger.info(`Session ${this.sessionId} Stopped. Cost: $${summary.totalJobCost.toFixed(4)}`);
    return summary;
  }

  updateJobState(jobState) {
    this.circuitSchedule = this.buildCircuitSchedule(jobState);
    this.circuitScheduleIncluded = false; // Force re-send on next utterance
  }

  async extractFromUtterance(transcriptText, regexResults = [], options = {}) {
    // Check if compaction needed
    if (this.conversationTokenEstimate > COMPACTION_THRESHOLD) {
      await this.compact();
    }

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
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ];

    // Add mid-conversation breakpoints if >20 blocks
    this.addMidConversationBreakpoints(messages);

    const response = await this.callWithRetry(messages);

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

  // HISTORY (029b91f, 2026-02-23): compact() was the source of a production cost blowout.
  // Before these 5 guards were added, compact() would fire on almost every utterance once the
  // conversation exceeded the token threshold. Each compaction call costs ~$0.02-0.05 in API
  // credits, and failed compactions (JSON truncation at 2048 max_tokens) would just retry on
  // the next utterance — burning money with no benefit. The 5 guards below (message count,
  // token estimate, no-new-turns, failure backoff, rate limit) together reduced compaction
  // costs by ~90%. The max_tokens was also raised from 2048→4096 to prevent JSON truncation
  // which was the primary cause of compaction failures.
  async compact() {
    // Guard 1: Nothing to compact
    if (this.conversationHistory.length <= 2) {
      logger.info(
        `Session ${this.sessionId} Compact skipped: only ${this.conversationHistory.length} messages`
      );
      return;
    }

    // Guard 2: Too small to justify cost
    if (this.conversationTokenEstimate < 1500) {
      logger.info(
        `Session ${this.sessionId} Compact skipped: only ~${this.conversationTokenEstimate} tokens`
      );
      return;
    }

    // Guard 3: No new data since last compaction
    if (this.turnCount === this.lastCompactedAtTurn) {
      logger.info(`Session ${this.sessionId} Compact skipped: no new turns since last compaction`);
      return;
    }

    // Guard 4: Failure backoff — require min(10, 2^failures) new turns after a failure.
    // This is exponential backoff: after 1 failure wait 2 turns, after 2 failures wait 4
    // turns, etc., capping at 10. This prevents hammering the API when compaction keeps
    // failing (e.g. conversation structure that Sonnet can't summarise cleanly).
    if (this.compactionFailures > 0) {
      const requiredTurns = Math.min(10, Math.pow(2, this.compactionFailures));
      const turnsSinceLastCompact = this.turnCount - this.lastCompactedAtTurn;
      if (turnsSinceLastCompact < requiredTurns) {
        logger.info(
          `Session ${this.sessionId} Compact skipped: backoff (${turnsSinceLastCompact}/${requiredTurns} turns, ${this.compactionFailures} failures)`
        );
        return;
      }
    }

    // Guard 5: Rate limit — 120s minimum between compaction attempts.
    // Matches the client-side rate limit in sonnet-stream.js session_compact handler.
    const now = Date.now();
    if (now - this.lastCompactTime < 120_000) {
      logger.info(
        `Session ${this.sessionId} Compact skipped: rate limited (${Math.round((now - this.lastCompactTime) / 1000)}s since last)`
      );
      return;
    }

    this.lastCompactTime = now;

    try {
      logger.info(
        `Session ${this.sessionId} Compacting: ${this.turnCount} turns, ~${this.conversationTokenEstimate} tokens`
      );

      const compactionInput = this.conversationHistory
        .map((msg, i) => {
          const text = EICRExtractionSession.messageText(msg.content);
          return `[Turn ${Math.floor(i / 2) + 1} ${msg.role}]: ${text}`;
        })
        .join('\n\n');

      const compactionMessages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Summarize this EICR extraction conversation:\n\n${compactionInput}`,
            },
          ],
        },
      ];

      // max_tokens raised from 2048→4096 (029b91f) to prevent JSON truncation on long sessions.
      // At 2048 tokens, compaction output for sessions with >15 turns would get cut off mid-JSON,
      // causing parse failures that triggered the failure backoff path above.
      const response = await this.callWithRetry(compactionMessages, 3, COMPACTION_PROMPT, 4096);

      const summaryText = response.content[0].text;
      const summary = JSON.parse(this.extractJSON(summaryText));

      // Validate
      const readingCount = (summary.confirmed_readings || []).length;
      if (readingCount < this.extractedReadingsCount * 0.8) {
        logger.warn(
          `Session ${this.sessionId} Compaction may have lost data: expected ~${this.extractedReadingsCount}, got ${readingCount}`
        );
      }

      // Track compaction cost
      this.costTracker.addCompactionUsage(response.usage);

      // Replace conversation with compact summary
      const ackResponse = JSON.stringify({
        extracted_readings: [],
        validation_alerts: [],
        questions_for_user: [],
      });

      // Clear askedQuestions on compaction (summary already includes questions_asked)
      this.askedQuestions = [];

      this.conversationHistory = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `SESSION SUMMARY (compacted from ${this.turnCount} previous turns):\n${JSON.stringify(summary, null, 2)}\n\nContinue extracting from new transcript buffers. All readings in confirmed_readings are already saved -- do not re-extract them. All observations in observations_created are already saved -- do not re-extract them. REMINDER: There is NO active circuit. Each utterance stands alone -- if it does not contain a circuit reference, set circuit to -1.`,
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: ackResponse }],
        },
      ];

      // Reset the circuit schedule flag so it gets re-sent after compaction
      this.circuitScheduleIncluded = false;

      logger.info(
        `Session ${this.sessionId} Compacted to ~${this.conversationTokenEstimate} tokens`
      );
      this.lastCompactedAtTurn = this.turnCount;
      this.compactionFailures = 0;
    } catch (error) {
      this.compactionFailures++;
      this.lastCompactedAtTurn = this.turnCount;
      const nextRetryTurns = Math.min(10, Math.pow(2, this.compactionFailures));
      logger.error(
        `Session ${this.sessionId} Compaction failed (attempt #${this.compactionFailures}, next retry after ${nextRetryTurns} turns): ${error.message}`
      );
    }
  }

  async callWithRetry(messages, maxRetries = 3, systemPrompt = null, maxTokens = 1280) {
    const system = systemPrompt
      ? systemPrompt
      : [
          {
            type: 'text',
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral', ttl: '1h' },
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

    // Add state snapshot if we have extracted data
    const snapshot = this.buildStateSnapshotMessage();
    if (snapshot) {
      window.push(
        { role: 'user', content: [{ type: 'text', text: snapshot }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"acknowledged": true}' }] }
      );
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
   */
  buildStateSnapshotMessage() {
    const hasCircuits = Object.keys(this.stateSnapshot.circuits).length > 0;
    const hasPending = this.stateSnapshot.pending_readings.length > 0;
    const hasObs = this.stateSnapshot.observations.length > 0;
    const hasAlerts = this.stateSnapshot.validation_alerts.length > 0;

    if (!hasCircuits && !hasPending && !hasObs && !hasAlerts) {
      return null;
    }

    const snapshot = {};
    if (hasCircuits) snapshot.circuits = this.stateSnapshot.circuits;
    if (hasPending) snapshot.pending_readings = this.stateSnapshot.pending_readings;
    if (hasObs) snapshot.observations = this.stateSnapshot.observations;
    if (hasAlerts) snapshot.validation_alerts = this.stateSnapshot.validation_alerts;

    return `CONFIRMED STATE (all values extracted so far — do NOT re-extract these):\n${JSON.stringify(snapshot)}`;
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
            cache_control: { type: 'ephemeral', ttl: '1h' },
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
    // not part of the extraction dialogue. Including it would pollute compaction input.
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
