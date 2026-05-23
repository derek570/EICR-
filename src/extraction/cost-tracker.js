// cost-tracker.js
// Tracks Deepgram and Sonnet costs per recording session

export class CostTracker {
  constructor() {
    // Deepgram Nova-3 streaming rate
    this.DEEPGRAM_RATE_PER_MIN = 0.0077;

    // Claude Sonnet 4.6 rates (per million tokens)
    // Cache write = 1.25x base input ($3.00) for 5-minute ephemeral TTL = $3.75
    // Cache read = 0.1x base input = $0.30
    this.SONNET_RATES = {
      cacheRead: 0.3,
      cacheWrite: 3.75,
      input: 3.0,
      output: 15.0,
    };

    // ElevenLabs pricing: $0.030 per 1,000 characters (Scale plan)
    this.ELEVENLABS_RATE_PER_CHAR = 0.00003;

    // GPT Vision pricing (per token, per image)
    this.GPT_VISION_RATES = {
      inputPerToken: 0.01 / 1000, // $0.01 per 1K input tokens
      outputPerToken: 0.03 / 1000, // $0.03 per 1K output tokens
      perImage: 0.01, // $0.01 per image
    };

    this.deepgram = {
      recordingStartTime: null,
      totalRecordingMs: 0,
      isPaused: false,
      pauseStartTime: null,
    };

    this.sonnet = {
      turns: 0,
      compactions: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    this.elevenLabsCharacters = 0;
    // Stage 2 commit 2.6 — split streaming accounting per PLAN_v4 §A.10.
    // chars_started: idempotent counter incremented exactly ONCE per
    // correlationId on the `synthesising` transition (text-sent to
    // vendor). This is the BILLABLE total — ElevenLabs charges when
    // text is accepted, not when audio plays.
    // *_completed/_cancelled/_failed: counters incremented on the
    // terminal transition. invariant:
    //   chars_completed + chars_cancelled + chars_failed = chars_started.
    this.elevenLabsStreaming = {
      charsStarted: 0,
      charsCompleted: 0,
      charsCancelled: 0,
      charsFailed: 0,
      _seenCorrelationIds: new Set(), // dedupe for idempotency
      _terminalCorrelationIds: new Set(), // dedupe for terminal call
    };

    this.gptVision = {
      photos: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // Deepgram timing
  startRecording() {
    this.deepgram.recordingStartTime = Date.now();
    this.deepgram.isPaused = false;
  }

  pauseRecording() {
    if (!this.deepgram.isPaused && this.deepgram.recordingStartTime) {
      this.deepgram.totalRecordingMs += Date.now() - this.deepgram.recordingStartTime;
      this.deepgram.isPaused = true;
      this.deepgram.pauseStartTime = Date.now();
    }
  }

  resumeRecording() {
    if (this.deepgram.isPaused) {
      this.deepgram.recordingStartTime = Date.now();
      this.deepgram.isPaused = false;
      this.deepgram.pauseStartTime = null;
    }
  }

  stopRecording() {
    if (!this.deepgram.isPaused && this.deepgram.recordingStartTime) {
      this.deepgram.totalRecordingMs += Date.now() - this.deepgram.recordingStartTime;
    }
    this.deepgram.recordingStartTime = null;
    this.deepgram.isPaused = false;
  }

  // Sonnet usage (from Anthropic API response.usage)
  addSonnetUsage(usage) {
    this.sonnet.turns++;
    this.sonnet.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.sonnet.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  addCompactionUsage(usage) {
    this.sonnet.compactions++;
    // Compaction calls don't use caching -- full price
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // Voice command usage — single-turn calls outside the extraction conversation
  addVoiceCommandCost(usage) {
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // ElevenLabs TTS usage
  addElevenLabsUsage(characterCount) {
    this.elevenLabsCharacters += characterCount;
  }

  /**
   * Stage 2 commit 2.6 — streaming "started" accounting per PLAN_v4 §A.10.
   * Called once per correlationId when the streaming-confirmation route
   * (or fast-path route in Stage 4) sends the text to ElevenLabs. This
   * is the billable transition; ElevenLabs charges when text is accepted.
   *
   * Idempotent: a duplicate call with the same correlationId is a no-op,
   * so retry/cleanup paths can call it freely without double-counting.
   */
  recordElevenLabsStreamingStarted(characterCount, correlationId) {
    if (!correlationId) return false;
    if (this.elevenLabsStreaming._seenCorrelationIds.has(correlationId)) return false;
    this.elevenLabsStreaming._seenCorrelationIds.add(correlationId);
    this.elevenLabsStreaming.charsStarted += characterCount;
    // Mirror into the existing single-counter so legacy cost calc + the
    // cost_update wire shape continue to surface streaming spend
    // without any consumer changes. Stage 6 cost-reconciliation cron
    // (commit 6.5) compares this number to the vendor-reported total.
    this.elevenLabsCharacters += characterCount;
    return true;
  }

  /**
   * Stage 2 commit 2.6 — streaming "terminal" counter per PLAN_v4 §A.10.
   * Called on terminal state (synth_complete | cancelled | failed). Does
   * NOT add billable chars (recordElevenLabsStreamingStarted already did).
   * Idempotent on correlationId.
   *
   * terminal ∈ { 'completed', 'cancelled', 'failed' }
   */
  recordElevenLabsStreamingTerminal(correlationId, terminal, characterCount = 0) {
    if (!correlationId) return false;
    if (terminal !== 'completed' && terminal !== 'cancelled' && terminal !== 'failed') return false;
    if (this.elevenLabsStreaming._terminalCorrelationIds.has(correlationId)) return false;
    this.elevenLabsStreaming._terminalCorrelationIds.add(correlationId);
    if (terminal === 'completed') this.elevenLabsStreaming.charsCompleted += characterCount;
    else if (terminal === 'cancelled') this.elevenLabsStreaming.charsCancelled += characterCount;
    else if (terminal === 'failed') this.elevenLabsStreaming.charsFailed += characterCount;
    return true;
  }

  get elevenLabsCost() {
    return this.elevenLabsCharacters * this.ELEVENLABS_RATE_PER_CHAR;
  }

  // GPT Vision usage (from OpenAI response.usage in analyze-ccu)
  addGptVisionUsage(inputTokens, outputTokens, imageCount = 1) {
    this.gptVision.photos += imageCount;
    this.gptVision.inputTokens += inputTokens;
    this.gptVision.outputTokens += outputTokens;
  }

  get gptVisionCost() {
    return (
      this.gptVision.inputTokens * this.GPT_VISION_RATES.inputPerToken +
      this.gptVision.outputTokens * this.GPT_VISION_RATES.outputPerToken +
      this.gptVision.photos * this.GPT_VISION_RATES.perImage
    );
  }

  // Cost calculations
  get deepgramMinutes() {
    return this.deepgram.totalRecordingMs / 60000;
  }

  get deepgramCost() {
    return this.deepgramMinutes * this.DEEPGRAM_RATE_PER_MIN;
  }

  get sonnetCost() {
    const { cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens } = this.sonnet;
    return (
      (cacheReadTokens * this.SONNET_RATES.cacheRead) / 1_000_000 +
      (cacheWriteTokens * this.SONNET_RATES.cacheWrite) / 1_000_000 +
      (inputTokens * this.SONNET_RATES.input) / 1_000_000 +
      (outputTokens * this.SONNET_RATES.output) / 1_000_000
    );
  }

  get totalCost() {
    return this.deepgramCost + this.sonnetCost + this.elevenLabsCost + this.gptVisionCost;
  }

  // For WebSocket cost_update messages
  toCostUpdate() {
    return {
      type: 'cost_update',
      sonnet: {
        turns: this.sonnet.turns,
        cacheReads: this.sonnet.cacheReadTokens,
        cacheWrites: this.sonnet.cacheWriteTokens,
        input: this.sonnet.inputTokens,
        output: this.sonnet.outputTokens,
        compactions: this.sonnet.compactions,
        cost: parseFloat(this.sonnetCost.toFixed(6)),
      },
      deepgram: {
        minutes: parseFloat(this.deepgramMinutes.toFixed(2)),
        cost: parseFloat(this.deepgramCost.toFixed(6)),
      },
      elevenlabs: {
        characters: this.elevenLabsCharacters,
        cost: parseFloat(this.elevenLabsCost.toFixed(6)),
      },
      gptVision: {
        photos: this.gptVision.photos,
        inputTokens: this.gptVision.inputTokens,
        outputTokens: this.gptVision.outputTokens,
        cost: parseFloat(this.gptVisionCost.toFixed(6)),
      },
      totalJobCost: parseFloat(this.totalCost.toFixed(6)),
    };
  }

  // For session summary (saved to S3)
  toSessionSummary() {
    return {
      ...this.toCostUpdate(),
      type: 'session_summary',
      extraction: {
        turns: this.sonnet.turns,
        compactions: this.sonnet.compactions,
      },
    };
  }
}
