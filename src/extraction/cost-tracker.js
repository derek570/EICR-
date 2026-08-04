// cost-tracker.js
// Tracks Deepgram and Sonnet costs per recording session

// Plan 00B-2 C3 — evaluation-only per-round usage sink Symbol. Stamped
// non-enumerably on a tracker instance by the evaluation composition only;
// production never sets it, so the ingest-time lookup is a dormant no-op.
import { PLAN00_ROUND_USAGE_SINK } from './plan00-lifecycle-hooks.js';

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
    // OpenAI GPT-5.6 Responses-API short-context rates, effective 2026-07-30
    // and verified 2026-08-02 against:
    // https://developers.openai.com/api/docs/pricing
    // Fast is the same model at an accelerated service tier and is billed at
    // exactly 2x Standard. OpenAI's response currently reports Fast as
    // service_tier="priority", so both names map to the fast bucket below.
    this.LUNA_RATES = {
      cacheRead: 0.02,
      cacheWrite: 0.25,
      input: 0.2,
      output: 1.2,
    };
    this.LUNA_FAST_RATES = {
      cacheRead: 0.04,
      cacheWrite: 0.5,
      input: 0.4,
      output: 2.4,
    };
    this.TERRA_RATES = {
      cacheRead: 0.2,
      cacheWrite: 2.5,
      input: 2.0,
      output: 12.0,
    };
    this.TERRA_FAST_RATES = {
      cacheRead: 0.4,
      cacheWrite: 5.0,
      input: 4.0,
      output: 24.0,
    };
    this.SOL_RATES = {
      cacheRead: 0.5,
      cacheWrite: 6.25,
      input: 5.0,
      output: 30.0,
    };
    this.SOL_FAST_RATES = {
      cacheRead: 1.0,
      cacheWrite: 12.5,
      input: 10.0,
      output: 60.0,
    };
    this.MODEL_RATES = {
      sonnet: this.SONNET_RATES,
      haiku: this.HAIKU_RATES,
      opus: this.OPUS_RATES,
      luna: this.LUNA_RATES,
      luna_fast: this.LUNA_FAST_RATES,
      terra: this.TERRA_RATES,
      terra_fast: this.TERRA_FAST_RATES,
      sol: this.SOL_RATES,
      sol_fast: this.SOL_FAST_RATES,
    };

    // ElevenLabs pricing is PER MODEL, billed in credits where the USD
    // value of one character depends on the model's credit multiplier
    // (verified against ElevenLabs' published per-character API pricing,
    // 2026-06-26):
    //   - Flash v2.5 / Turbo v2.5 (and the v2 variants): 0.5 credits/char
    //     = $0.05 per 1,000 chars = $0.00005/char. (Turbo dropped to 0.5
    //     credits in ElevenLabs' Aug-2024 price cut, so Flash and Turbo are
    //     the SAME rate — the turbo→flash live-path consolidation does NOT
    //     change live session cost.)
    //   - Multilingual v2 / eleven_v3 (standard models): 1 credit/char
    //     = $0.10 per 1,000 chars = $0.0001/char.
    // The per-model map is the source of truth at compute time;
    // ELEVENLABS_RATE_PER_CHAR is retained as the named fallback for any
    // model id not in the map (matches the historical flat rate). Telemetry/
    // cost reports read CostTracker.elevenLabsCost; downstream
    // session-optimizer + analyse-session both consume it.
    this.ELEVENLABS_RATE_PER_CHAR = 0.00005;
    this.DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
    this.ELEVENLABS_RATE_PER_CHAR_BY_MODEL = {
      // Flash/Turbo — 0.5 credits/char
      eleven_flash_v2_5: 0.00005,
      eleven_flash_v2: 0.00005,
      eleven_turbo_v2_5: 0.00005,
      eleven_turbo_v2: 0.00005,
      // Standard models — 1 credit/char
      eleven_multilingual_v2: 0.0001,
      eleven_v3: 0.0001,
    };

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

    // Plan 00A accounting authority. Public inspector turns are deliberately
    // separate from billable loop invocations and completed SDK rounds.
    // These values are server-only session state; the existing cost_update
    // wire shape remains unchanged.
    this.loopInvocations = 0;
    this.completedModelRounds = 0;
    this.usageRevision = 0;
    this.inFlightBillableInvocationCount = 0;
    this._inspectorExtractionTurns = new Set();
    this._billableInvocationStates = new Map();
    this._ingestedBillableInvocations = new Set();
    this.roundUsageEvidence = [];
    this.usageValidationErrors = [];
    this.unattributedProviderUsage = [];

    // Per-model token accounting. Buckets are created lazily on first
    // use. Cost is computed by summing each bucket × its model's rates,
    // so a mid-session model switch (e.g. extraction on Haiku +
    // observations on Sonnet) bills each call at the right rate.
    // `this.sonnet` is preserved as the cross-model aggregate so the
    // toCostUpdate() wire shape + existing consumers don't break.
    this.modelUsage = new Map();

    // Per-model character buckets. Each accumulation method adds chars to
    // elevenLabsCharsByModel[modelId]; the elevenLabsCost getter sums each
    // bucket × its model's rate. `elevenLabsCharacters` is preserved as a
    // DERIVED total (getter, sum of all buckets) so the cost_update wire
    // shape + every existing reader keep working unchanged.
    this.elevenLabsCharsByModel = {};
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
  _modelFamily(modelId, serviceTier) {
    if (!modelId) return 'sonnet';
    const id = String(modelId).toLowerCase();
    if (id === 'gpt-5.6' || id.startsWith('gpt-5.6-')) {
      // Luna is the default route and may rely on the global Fast setting.
      // Terra/Sol observation routes pass their requested tier explicitly;
      // if old callers omit it, Standard is the conservative billing default.
      const configuredFallback = id.includes('gpt-5.6-luna')
        ? process.env.OPENAI_EXTRACT_SERVICE_TIER
        : 'standard';
      const tier = String(serviceTier ?? configuredFallback ?? '')
        .trim()
        .toLowerCase();
      const fast = tier === 'fast' || tier === 'priority';
      if (id.includes('gpt-5.6-luna')) return fast ? 'luna_fast' : 'luna';
      if (id.includes('gpt-5.6-terra')) return fast ? 'terra_fast' : 'terra';
      // Sol is also the unsuffixed gpt-5.6 alias and the conservative
      // highest-cost fallback for any future 5.6 suffix we do not yet know.
      return fast ? 'sol_fast' : 'sol';
    }
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

  _accumulateModelUsage(usage, modelId, serviceTier) {
    const b = this._bucketFor(this._modelFamily(modelId, serviceTier));
    b.cacheReadTokens += usage.cache_read_input_tokens || 0;
    b.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
    this.sonnet.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.sonnet.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // Sonnet/Haiku/Opus usage (from Anthropic API response.usage).
  // `modelId` should be the actual model used (e.g. response.model);
  // when omitted, falls back to the env-configured extraction model.
  addSonnetUsage(usage, modelId, serviceTier) {
    const b = this._bucketFor(this._modelFamily(modelId, serviceTier));
    b.turns++;
    this.sonnet.turns++;
    this._accumulateModelUsage(usage, modelId, serviceTier);
  }

  /** Record one accepted inspector extraction turn, idempotently across legs/generations. */
  recordInspectorExtractionTurn(sessionId, extractionTurnId) {
    if (!sessionId || !extractionTurnId) return false;
    const key = `${sessionId}:${extractionTurnId}`;
    if (this._inspectorExtractionTurns.has(key)) return false;
    this._inspectorExtractionTurns.add(key);
    this.sonnet.turns += 1;
    this.usageRevision += 1;
    return true;
  }

  /** Begin one accounting scope immediately before its first SDK dispatch. */
  beginBillableInvocation(loopInvocationId) {
    if (!loopInvocationId || this._billableInvocationStates.has(loopInvocationId)) return false;
    this._billableInvocationStates.set(loopInvocationId, 'active');
    this.inFlightBillableInvocationCount += 1;
    this.usageRevision += 1;
    return true;
  }

  /**
   * Ingest completed per-round evidence exactly once. A transport failure
   * before any response supplies no rows and therefore owns no billable
   * invocation/round counters.
   */
  ingestBillableUsage(loopInvocationId, roundUsage, kind = 'inspector_extraction') {
    if (!loopInvocationId || this._ingestedBillableInvocations.has(loopInvocationId)) return false;
    const rows = Array.isArray(roundUsage) ? roundUsage : [];
    if (rows.length === 0) return false;

    this._ingestedBillableInvocations.add(loopInvocationId);
    this.loopInvocations += 1;
    this.completedModelRounds += rows.length;
    // Plan 00B-2 C3 — evaluation-only round_usage sink (one Symbol lookup;
    // dormant in production). The call-level dedupe above is the
    // exactly-once guard: an accepted call ingests its round rows
    // atomically, one sub-record per row.
    const plan00Sink = this[PLAN00_ROUND_USAGE_SINK];
    for (const row of rows) {
      const usage = {
        input_tokens: row.fresh_input_tokens || 0,
        cache_read_input_tokens: row.cache_read_input_tokens || 0,
        cache_creation_input_tokens: row.cache_write_input_tokens || 0,
        output_tokens: row.output_tokens || 0,
      };
      this._accumulateModelUsage(usage, row.billing_model, row.billing_tier);
      const evidence = {
        ...row,
        loop_invocation_id: loopInvocationId,
        kind,
      };
      this.roundUsageEvidence.push(evidence);
      if (row.attribution_status === 'validation_error') {
        this.usageValidationErrors.push(evidence);
      } else if (row.attribution_status === 'unattributed_provider_usage') {
        this.unattributedProviderUsage.push(evidence);
      }
      if (plan00Sink) {
        try {
          plan00Sink(row, { loopInvocationId, billableKind: kind });
        } catch (_err) {
          // Evaluation-side failures never reach production accounting.
        }
      }
    }
    this.usageRevision += 1;
    return true;
  }

  /** End an accounting scope after caller-side usage ingestion. */
  endBillableInvocation(loopInvocationId) {
    if (!loopInvocationId || this._billableInvocationStates.get(loopInvocationId) !== 'active') {
      return false;
    }
    this._billableInvocationStates.set(loopInvocationId, 'ended');
    this.inFlightBillableInvocationCount -= 1;
    this.usageRevision += 1;
    return true;
  }

  addCompactionUsage(usage, modelId, serviceTier) {
    const b = this._bucketFor(this._modelFamily(modelId, serviceTier));
    b.compactions++;
    // Compaction calls don't use caching -- full price
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
    this.sonnet.compactions++;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // Voice command usage — single-turn calls outside the extraction conversation
  addVoiceCommandCost(usage, modelId, serviceTier) {
    const b = this._bucketFor(this._modelFamily(modelId, serviceTier));
    b.inputTokens += usage.input_tokens || 0;
    b.outputTokens += usage.output_tokens || 0;
    this.sonnet.inputTokens += usage.input_tokens || 0;
    this.sonnet.outputTokens += usage.output_tokens || 0;
  }

  // Add chars to the per-model bucket. Unknown/omitted modelId falls back
  // to the default live model so legacy callers don't regress.
  _addElevenLabsChars(characterCount, modelId) {
    const m = modelId || this.DEFAULT_ELEVENLABS_MODEL_ID;
    this.elevenLabsCharsByModel[m] = (this.elevenLabsCharsByModel[m] || 0) + characterCount;
  }

  // Derived total chars across all models — back-compat for the cost_update
  // wire shape (toCostUpdate) and any consumer that read the old scalar.
  get elevenLabsCharacters() {
    let total = 0;
    for (const m in this.elevenLabsCharsByModel) total += this.elevenLabsCharsByModel[m];
    return total;
  }

  // ElevenLabs TTS usage. `modelId` defaults to the live model so existing
  // callers that don't pass it bill at the Flash rate (the live proxy/stream
  // model). Pass the actual model for non-default paths (e.g. offline v3).
  addElevenLabsUsage(characterCount, modelId = this.DEFAULT_ELEVENLABS_MODEL_ID) {
    this._addElevenLabsChars(characterCount, modelId);
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
  recordElevenLabsStreamingStarted(
    characterCount,
    correlationId,
    modelId = this.DEFAULT_ELEVENLABS_MODEL_ID
  ) {
    if (!correlationId) return false;
    if (this.elevenLabsStreaming._seenCorrelationIds.has(correlationId)) return false;
    this.elevenLabsStreaming._seenCorrelationIds.add(correlationId);
    this.elevenLabsStreaming.charsStarted += characterCount;
    // Mirror into the per-model bucket so the cost getter + cost_update wire
    // shape continue to surface streaming spend without any consumer changes.
    // Stage 6 cost-reconciliation cron (commit 6.5) compares this number to
    // the vendor-reported total.
    this._addElevenLabsChars(characterCount, modelId);
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
    // Sum each per-model bucket × that model's rate; unknown models fall
    // back to the flat ELEVENLABS_RATE_PER_CHAR.
    let cost = 0;
    for (const m in this.elevenLabsCharsByModel) {
      const rate = this.ELEVENLABS_RATE_PER_CHAR_BY_MODEL[m] ?? this.ELEVENLABS_RATE_PER_CHAR;
      cost += this.elevenLabsCharsByModel[m] * rate;
    }
    return cost;
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
  recordElevenLabsSpeculativeStarted(
    characterCount,
    correlationId,
    modelId = this.DEFAULT_ELEVENLABS_MODEL_ID
  ) {
    if (!correlationId) return false;
    if (!Number.isFinite(characterCount) || characterCount <= 0) return false;
    if (this.elevenLabsSpeculative._seenCorrelationIds.has(correlationId)) return false;
    this.elevenLabsSpeculative._seenCorrelationIds.add(correlationId);
    this.elevenLabsSpeculative._charsByCorrelationId.set(correlationId, characterCount);
    this.elevenLabsSpeculative.charsStarted += characterCount;
    // Mirror into the per-model bucket so cost-update wire shape + the
    // session-optimizer's cost summary remain accurate.
    this._addElevenLabsChars(characterCount, modelId);
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

  _economicsForUsage(usage, rates) {
    const cacheReadTokens = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? 0;
    const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
    const cacheReadCost = (cacheReadTokens * rates.cacheRead) / 1_000_000;
    const cacheWriteCost = (cacheWriteTokens * rates.cacheWrite) / 1_000_000;
    const uncachedInputCost = (inputTokens * rates.input) / 1_000_000;
    const outputCost = (outputTokens * rates.output) / 1_000_000;
    const actualInputCost = cacheReadCost + cacheWriteCost + uncachedInputCost;
    const actualCost = actualInputCost + outputCost;
    const noCacheInputCost =
      ((cacheReadTokens + cacheWriteTokens + inputTokens) * rates.input) / 1_000_000;
    const noCacheCost = noCacheInputCost + outputCost;
    const netSavings = noCacheCost - actualCost;
    return {
      cacheReadCost,
      cacheWriteCost,
      uncachedInputCost,
      outputCost,
      actualInputCost,
      actualCost,
      noCacheInputCost,
      noCacheCost,
      netSavings,
      netSavingsPercent: noCacheCost > 0 ? (netSavings / noCacheCost) * 100 : 0,
    };
  }

  /** Cost evidence for one model call/loop, before it is added to the ledger. */
  estimateModelUsageEconomics(usage, modelId, serviceTier) {
    const family = this._modelFamily(modelId, serviceTier);
    const rates = this.MODEL_RATES[family] || this.SONNET_RATES;
    return { family, ...this._economicsForUsage(usage || {}, rates) };
  }

  /** Sum economics from the same per-round attribution rows used for billing. */
  estimateRoundUsageEconomics(roundUsage) {
    const totals = {
      actualCost: 0,
      noCacheCost: 0,
      netSavings: 0,
    };
    for (const row of Array.isArray(roundUsage) ? roundUsage : []) {
      const usage = {
        input_tokens: row.fresh_input_tokens || 0,
        cache_read_input_tokens: row.cache_read_input_tokens || 0,
        cache_creation_input_tokens: row.cache_write_input_tokens || 0,
        output_tokens: row.output_tokens || 0,
      };
      const economics = this.estimateModelUsageEconomics(
        usage,
        row.billing_model,
        row.billing_tier
      );
      totals.actualCost += economics.actualCost;
      totals.noCacheCost += economics.noCacheCost;
      totals.netSavings += economics.netSavings;
    }
    return totals;
  }

  /**
   * Cumulative actual-vs-no-cache counterfactual across mixed model/tier
   * buckets. Cache writes can make netSavings negative on a cold session;
   * exposing that truth is intentional.
   */
  get cacheEconomics() {
    const perModel = {};
    const totals = {
      cacheReadCost: 0,
      cacheWriteCost: 0,
      uncachedInputCost: 0,
      outputCost: 0,
      actualInputCost: 0,
      actualCost: 0,
      noCacheInputCost: 0,
      noCacheCost: 0,
      netSavings: 0,
      netSavingsPercent: 0,
    };
    const buckets = this.modelUsage.size > 0 ? this.modelUsage : new Map([['sonnet', this.sonnet]]);
    for (const [family, usage] of buckets) {
      const economics = this._economicsForUsage(
        usage,
        this.MODEL_RATES[family] || this.SONNET_RATES
      );
      perModel[family] = economics;
      for (const key of Object.keys(totals)) {
        if (key !== 'netSavingsPercent') totals[key] += economics[key];
      }
    }
    totals.netSavingsPercent =
      totals.noCacheCost > 0 ? (totals.netSavings / totals.noCacheCost) * 100 : 0;
    return { ...totals, perModel };
  }

  _serialiseCacheEconomics() {
    const economics = this.cacheEconomics;
    const round = (value, digits = 6) => parseFloat(value.toFixed(digits));
    const serialise = (value) => ({
      cacheReadCost: round(value.cacheReadCost),
      cacheWriteCost: round(value.cacheWriteCost),
      uncachedInputCost: round(value.uncachedInputCost),
      outputCost: round(value.outputCost),
      actualInputCost: round(value.actualInputCost),
      actualCost: round(value.actualCost),
      noCacheInputCost: round(value.noCacheInputCost),
      noCacheCost: round(value.noCacheCost),
      netSavings: round(value.netSavings),
      netSavingsPercent: round(value.netSavingsPercent, 2),
    });
    return {
      ...serialise(economics),
      perModel: Object.fromEntries(
        Object.entries(economics.perModel).map(([family, value]) => [family, serialise(value)])
      ),
    };
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
        cacheEconomics: this._serialiseCacheEconomics(),
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
