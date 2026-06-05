// cost-tracker.js
// Tracks Deepgram and Sonnet costs per recording session

export class CostTracker {
  constructor() {
    // Deepgram Nova-3 streaming rate
    this.DEEPGRAM_RATE_PER_MIN = 0.0077;

    // Claude per-million-token rates by model family.
    // Cache write = 1.25× base input (5-minute ephemeral TTL).
    // Cache read  = 0.1×  base input.
    // SONNET_RATES preserved as the historical alias used by tests +
    // legacy callers; MODEL_RATES is the source of truth at compute time.
    this.SONNET_RATES = {
      cacheRead: 0.3,
      cacheWrite: 3.75,
      input: 3.0,
      output: 15.0,
    };
    this.HAIKU_RATES = {
      cacheRead: 0.1,
      cacheWrite: 1.25,
      input: 1.0,
      output: 5.0,
    };
    this.OPUS_RATES = {
      cacheRead: 1.5,
      cacheWrite: 18.75,
      input: 15.0,
      output: 75.0,
    };
    this.MODEL_RATES = {
      sonnet: this.SONNET_RATES,
      haiku: this.HAIKU_RATES,
      opus: this.OPUS_RATES,
    };

    // ElevenLabs pricing: $0.050 per 1,000 characters (current Scale tier
    // post-2026-04 pricing update). Was 0.00003 — bump per voice-latency
    // Loaded Barrel plan v6 §G so per-correlation cost attribution matches
    // the invoice we actually pay. Telemetry/cost reports use this rate
    // directly; downstream session-optimizer + analyse-session both read
    // CostTracker.elevenLabsCost.
    this.ELEVENLABS_RATE_PER_CHAR = 0.00005;

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

    // Per-model token accounting. Buckets are created lazily on first
    // use. Cost is computed by summing each bucket × its model's rates,
    // so a mid-session model switch (e.g. extraction on Haiku +
    // observations on Sonnet) bills each call at the right rate.
    // `this.sonnet` is preserved as the cross-model aggregate so the
    // toCostUpdate() wire shape + existing consumers don't break.
    this.modelUsage = new Map();

    this.elevenLabsCharacters = 0;
    // Stage 2 commit 2.6 — split streaming accounting per PLAN_v4 §A.10.
    // chars_started: idempotent counter incremented exactly ONCE per
    // correlationId on the `synthesising` transition (text-sent to
    // vendor). This is the BILLABLE total — ElevenLabs charges when
    // text is accepted, not when audio plays.
    // *_completed/_cancelled/_failed: counters incremented on the
    // terminal transition. invariant:
    //   chars_completed + chars_cancelled + chars_failed = chars_started.
    // Loaded Barrel Phase 1.D extra (plan v10 §C) — speculative
    // sub-ledger. Tracks chars that were billed for SPECULATIVE
    // synthesis (i.e. the speculator opened ElevenLabs WS before iOS
    // asked). Separate from streaming so the cost report can
    // distinguish "served a HIT" (canonical cost) from "wasted on
    // invalidate/TTL" (extra cost on top of today's batch).
    //
    // Per-correlationId chars are tracked so promoteSpeculativeToCanonical
    // can credit the chars without the caller having to re-pass them.
    //
    // Memory: per-session Map sized by # speculations. At 5-10 per turn,
    // 100-500 per session, ~80 bytes per entry → ~40KB worst case per
    // session. Acceptable; pruned on session_stop by the speculator's
    // session-cleanup hook.
    //
    // Invariant (asserted by Phase 5 fuzz test): for every entry in
    // _seenCorrelationIds, there is EXACTLY ONE matching entry in
    // _terminalCorrelationIds at end-of-session.
    this.elevenLabsSpeculative = {
      charsStarted: 0,
      charsCompleted: 0,
      charsCancelled: 0,
      charsFailed: 0,
      charsServed: 0, // subset of charsCompleted that HIT a cache lookup
      _seenCorrelationIds: new Set(),
      _terminalCorrelationIds: new Set(),
      _promotedCorrelationIds: new Set(),
      _charsByCorrelationId: new Map(),
    };

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

  // Resolve a model id (anthropic id, e.g. 'claude-haiku-4-5-20251001') to
  // a rates family. Callers SHOULD pass the actual response.model so
  // mixed-model sessions (e.g. Haiku extraction + Sonnet observations)
  // bill correctly. Omitting the id defaults to 'sonnet' so behaviour
  // is identical to the pre-multi-model tracker — keeps tests
  // deterministic, but any unmodified production call site will silently
  // over-bill if it's actually running on Haiku. Audit grep:
  //   `grep -n addSonnetUsage src/` — every hit should pass a 2nd arg.
  _modelFamily(modelId) {
    if (!modelId) return 'sonnet';
    const id = String(modelId).toLowerCase();
    if (id.includes('haiku')) return 'haiku';
    if (id.includes('opus')) return 'opus';
    return 'sonnet';
  }

  _bucketFor(family) {
    let b = this.modelUsage.get(family);
    if (!b) {
      b = {
        turns: 0,
        compactions: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      this.modelUsage.set(family, b);
    }
    return b;
  }

  // Sonnet/Haiku/Opus usage (from Anthropic API response.usage).
  // `modelId` should be the actual model used (e.g. response.model);
  // when omitted, falls back to the env-configured extraction model.
  addSonnetUsage(usage, modelId) {
    const b = this._bucketFor(this._modelFamily(modelId));
    b.turns++;
    b.cacheReadTokens += usage.cache_read_input_tokens || 0;
    b.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
    // Cross-model aggregate for back-compat with toCostUpdate() consumers.
    this.sonnet.turns++;
    this.sonnet.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.sonnet.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  addCompactionUsage(usage, modelId) {
    const b = this._bucketFor(this._modelFamily(modelId));
    b.compactions++;
    // Compaction calls don't use caching -- full price
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
    this.sonnet.compactions++;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // Voice command usage — single-turn calls outside the extraction conversation
  addVoiceCommandCost(usage, modelId) {
    const b = this._bucketFor(this._modelFamily(modelId));
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
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

  /**
   * Loaded Barrel Phase 1.D extra (plan v10 §C) — speculative synth
   * "started" accounting. Called by loaded-barrel-speculator.js when it
   * opens an ElevenLabs WS for a predicted confirmation, BEFORE iOS
   * has POSTed for that text. ElevenLabs bills on text-accepted,
   * which happens at BOS+EOS dispatch — the speculator pays the
   * full per-char cost regardless of whether iOS ends up consuming
   * the cached audio.
   *
   * Mirrored into `elevenLabsCharacters` so the legacy cost calc +
   * the cost_update wire shape continue to surface the spend
   * accurately. The speculator-vs-canonical split is recoverable
   * from the sub-ledger counters (charsStarted - charsServed = wasted).
   *
   * Idempotent on correlationId.
   * Returns true if recorded, false if no-op (missing id or duplicate).
   */
  recordElevenLabsSpeculativeStarted(characterCount, correlationId) {
    if (!correlationId) return false;
    if (!Number.isFinite(characterCount) || characterCount <= 0) return false;
    if (this.elevenLabsSpeculative._seenCorrelationIds.has(correlationId)) return false;
    this.elevenLabsSpeculative._seenCorrelationIds.add(correlationId);
    this.elevenLabsSpeculative._charsByCorrelationId.set(correlationId, characterCount);
    this.elevenLabsSpeculative.charsStarted += characterCount;
    // Mirror into legacy aggregate so cost-update wire shape + the
    // session-optimizer's cost summary remain accurate.
    this.elevenLabsCharacters += characterCount;
    return true;
  }

  /**
   * Loaded Barrel Phase 1.D extra — speculative synth "terminal"
   * counter. Called when the speculator's ElevenLabs WS reaches a
   * terminal state. Does NOT add billable chars (Started already
   * did).
   *
   * Reason values match the streaming sub-ledger's vocabulary so
   * downstream analysers can use the same accumulator code:
   *   'completed' — synth finished cleanly; cache entry CAS'd to ready
   *   'cancelled' — abort triggered (clear/correction/cap/session_stop)
   *   'failed'    — ElevenLabs error or network failure
   *
   * Audit invariant (asserted by Phase 5 fuzz): every Started call
   * has EXACTLY ONE matching Terminal call by end-of-session.
   *
   * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.1).
   * Accepts an optional `opts` object for diagnostic propagation —
   * `opts.reason` is the speculator's textual cancellation reason
   * (e.g. 'cancelled_by_fast_tts_hint', 'speculator_shutdown') and
   * `opts.cancelledBeforeTextSent` is preserved as a vestigial
   * post-v6 marker. Neither field affects the cost decision — that's
   * structurally enforced upstream in the speculator (Started is only
   * called once the text-sent boundary is crossed; see PLAN_v8
   * Pivot 11.4). The opts are accepted here so the speculator can
   * pass them through without dropping the information; downstream
   * consumers (cost-summary analyser, ops dashboards) can read
   * `reason` from the matching `voice_latency.speculative_terminal_reason`
   * log emission, NOT from the cost tracker itself.
   *
   * Idempotent on correlationId.
   */
  // eslint-disable-next-line no-unused-vars
  recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts = {}) {
    if (!correlationId) return false;
    if (terminal !== 'completed' && terminal !== 'cancelled' && terminal !== 'failed') {
      return false;
    }
    if (this.elevenLabsSpeculative._terminalCorrelationIds.has(correlationId)) return false;
    this.elevenLabsSpeculative._terminalCorrelationIds.add(correlationId);
    const chars = this.elevenLabsSpeculative._charsByCorrelationId.get(correlationId) ?? 0;
    if (terminal === 'completed') this.elevenLabsSpeculative.charsCompleted += chars;
    else if (terminal === 'cancelled') this.elevenLabsSpeculative.charsCancelled += chars;
    else this.elevenLabsSpeculative.charsFailed += chars;
    return true;
  }

  /**
   * Loaded Barrel Phase 1.D extra — promote a speculative correlationId
   * to "canonical served" when an iOS POST cache lookup HITs the
   * speculator's buffer. Credits the chars into `charsServed` so the
   * report can distinguish HIT (chars served a real request) from
   * WASTED (chars were billed but the live path didn't end up using
   * them — TTL expired, invalidated, lost the race, etc).
   *
   * MUST be called AFTER recordElevenLabsSpeculativeStarted for the
   * same correlationId (otherwise the chars-per-correlation map has
   * no entry to credit). Returns false in that case.
   *
   * Idempotent on correlationId.
   */
  promoteSpeculativeToCanonical(correlationId) {
    if (!correlationId) return false;
    if (this.elevenLabsSpeculative._promotedCorrelationIds.has(correlationId)) return false;
    const chars = this.elevenLabsSpeculative._charsByCorrelationId.get(correlationId);
    if (chars == null) return false; // never Started — can't promote
    this.elevenLabsSpeculative._promotedCorrelationIds.add(correlationId);
    this.elevenLabsSpeculative.charsServed += chars;
    return true;
  }

  /**
   * Diagnostic: total speculative chars that were billed but did NOT
   * serve a HIT. Useful for the rollback-criterion check (cost overhead
   * > 25% triggers a rollback) and for the field-test report.
   */
  get elevenLabsSpeculativeWastedChars() {
    return this.elevenLabsSpeculative.charsStarted - this.elevenLabsSpeculative.charsServed;
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
    // Pre-migration / no-modelId callers: fall back to applying sonnet rates
    // to the legacy aggregate so any caller that hasn't been updated still
    // produces a numerically defined cost (worst case: 3× over-bill, which
    // is what the old code did unconditionally).
    if (this.modelUsage.size === 0) {
      const { cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens } = this.sonnet;
      return (
        (cacheReadTokens * this.SONNET_RATES.cacheRead) / 1_000_000 +
        (cacheWriteTokens * this.SONNET_RATES.cacheWrite) / 1_000_000 +
        (inputTokens * this.SONNET_RATES.input) / 1_000_000 +
        (outputTokens * this.SONNET_RATES.output) / 1_000_000
      );
    }
    let cost = 0;
    for (const [family, b] of this.modelUsage) {
      const rates = this.MODEL_RATES[family] || this.SONNET_RATES;
      cost +=
        (b.cacheReadTokens * rates.cacheRead) / 1_000_000 +
        (b.cacheWriteTokens * rates.cacheWrite) / 1_000_000 +
        (b.inputTokens * rates.input) / 1_000_000 +
        (b.outputTokens * rates.output) / 1_000_000;
    }
    return cost;
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
