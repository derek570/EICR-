/**
 * Tests for CostTracker — tracks Deepgram, Sonnet, ElevenLabs, and GPT Vision costs.
 */

import { jest } from '@jest/globals';
import { CostTracker } from '../extraction/cost-tracker.js';

describe('CostTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe('initial state', () => {
    test('should start with zero costs', () => {
      expect(tracker.deepgramCost).toBe(0);
      expect(tracker.sonnetCost).toBe(0);
      expect(tracker.elevenLabsCost).toBe(0);
      expect(tracker.gptVisionCost).toBe(0);
      expect(tracker.totalCost).toBe(0);
    });

    test('should have correct rate constants', () => {
      expect(tracker.DEEPGRAM_RATE_PER_MIN).toBe(0.0077);
      expect(tracker.SONNET_RATES.cacheRead).toBe(0.3);
      expect(tracker.SONNET_RATES.cacheWrite).toBe(3.75);
      expect(tracker.SONNET_RATES.input).toBe(3.0);
      expect(tracker.SONNET_RATES.output).toBe(15.0);
      expect(tracker.ELEVENLABS_RATE_PER_CHAR).toBe(0.00005);
    });

    test('should expose per-model ElevenLabs rates + default model id', () => {
      // Flash/Turbo: 0.5 credits/char = $0.05 per 1,000 chars.
      expect(tracker.ELEVENLABS_RATE_PER_CHAR_BY_MODEL.eleven_flash_v2_5).toBe(0.00005);
      expect(tracker.ELEVENLABS_RATE_PER_CHAR_BY_MODEL.eleven_turbo_v2_5).toBe(0.00005);
      // Standard models: 1 credit/char = $0.10 per 1,000 chars (double).
      expect(tracker.ELEVENLABS_RATE_PER_CHAR_BY_MODEL.eleven_multilingual_v2).toBe(0.0001);
      expect(tracker.ELEVENLABS_RATE_PER_CHAR_BY_MODEL.eleven_v3).toBe(0.0001);
      // Default live model is Flash (the consolidated proxy/streaming model).
      expect(tracker.DEFAULT_ELEVENLABS_MODEL_ID).toBe('eleven_flash_v2_5');
    });
  });

  describe('Deepgram cost tracking', () => {
    test('should calculate cost for recording duration', () => {
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // startRecording
        .mockReturnValueOnce(now + 60000); // stopRecording (1 minute)

      tracker.startRecording();
      tracker.stopRecording();

      expect(tracker.deepgramMinutes).toBeCloseTo(1.0, 1);
      expect(tracker.deepgramCost).toBeCloseTo(0.0077, 4);

      Date.now.mockRestore();
    });

    test('should handle pause and resume', () => {
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // startRecording
        .mockReturnValueOnce(now + 30000) // pauseRecording (30s recorded)
        .mockReturnValueOnce(now + 30000) // pauseStartTime
        .mockReturnValueOnce(now + 60000) // resumeRecording
        .mockReturnValueOnce(now + 90000); // stopRecording (another 30s)

      tracker.startRecording();
      tracker.pauseRecording();
      tracker.resumeRecording();
      tracker.stopRecording();

      // Total: 30s + 30s = 60s = 1 minute
      expect(tracker.deepgramMinutes).toBeCloseTo(1.0, 1);

      Date.now.mockRestore();
    });

    test('should not double-count when pausing twice', () => {
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now) // startRecording
        .mockReturnValueOnce(now + 30000) // first pauseRecording
        .mockReturnValueOnce(now + 30000) // pauseStartTime
        .mockReturnValueOnce(now + 60000); // stopRecording (still paused)

      tracker.startRecording();
      tracker.pauseRecording();
      tracker.pauseRecording(); // Double-pause should be a no-op
      tracker.stopRecording();

      expect(tracker.deepgramMinutes).toBeCloseTo(0.5, 1); // Only 30s

      Date.now.mockRestore();
    });

    test('should not resume when not paused', () => {
      tracker.resumeRecording(); // No-op — not paused
      expect(tracker.deepgram.isPaused).toBe(false);
    });
  });

  describe('Sonnet cost tracking', () => {
    test('should accumulate token usage across turns', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        input_tokens: 200,
        output_tokens: 100,
      });

      tracker.addSonnetUsage({
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 0,
        input_tokens: 300,
        output_tokens: 150,
      });

      expect(tracker.sonnet.turns).toBe(2);
      expect(tracker.sonnet.cacheReadTokens).toBe(3000);
      expect(tracker.sonnet.cacheWriteTokens).toBe(500);
      expect(tracker.sonnet.inputTokens).toBe(500);
      expect(tracker.sonnet.outputTokens).toBe(250);
    });

    test('should calculate Sonnet cost correctly', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 1000000, // $0.30
        cache_creation_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      });

      expect(tracker.sonnetCost).toBeCloseTo(0.3, 2);
    });

    test('should handle missing usage fields gracefully', () => {
      tracker.addSonnetUsage({});
      expect(tracker.sonnet.turns).toBe(1);
      expect(tracker.sonnet.cacheReadTokens).toBe(0);
      expect(tracker.sonnet.inputTokens).toBe(0);
      expect(tracker.sonnet.outputTokens).toBe(0);
    });

    test('should track compaction usage separately', () => {
      tracker.addCompactionUsage({
        input_tokens: 500,
        output_tokens: 200,
      });

      expect(tracker.sonnet.compactions).toBe(1);
      expect(tracker.sonnet.inputTokens).toBe(500);
      expect(tracker.sonnet.outputTokens).toBe(200);
      // Compaction doesn't increment turns
      expect(tracker.sonnet.turns).toBe(0);
    });
  });

  describe('Per-model rates', () => {
    test('exposes Haiku 4.5 rates ($1 / $5 / $1.25 / $0.10)', () => {
      expect(tracker.HAIKU_RATES.cacheRead).toBe(0.1);
      expect(tracker.HAIKU_RATES.cacheWrite).toBe(1.25);
      expect(tracker.HAIKU_RATES.input).toBe(1.0);
      expect(tracker.HAIKU_RATES.output).toBe(5.0);
    });

    test('exposes Opus rates ($15 / $75 / $18.75 / $1.50)', () => {
      expect(tracker.OPUS_RATES.cacheRead).toBe(1.5);
      expect(tracker.OPUS_RATES.cacheWrite).toBe(18.75);
      expect(tracker.OPUS_RATES.input).toBe(15.0);
      expect(tracker.OPUS_RATES.output).toBe(75.0);
    });

    test('Haiku model id is billed at Haiku rates (1/3 the Sonnet cost)', () => {
      tracker.addSonnetUsage(
        {
          cache_read_input_tokens: 1_000_000, // $0.10 @ haiku, $0.30 @ sonnet
          cache_creation_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
        'claude-haiku-4-5-20251001'
      );
      expect(tracker.sonnetCost).toBeCloseTo(0.1, 4);
    });

    test('Sonnet model id is billed at Sonnet rates (back-compat)', () => {
      tracker.addSonnetUsage(
        {
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
        'claude-sonnet-4-6'
      );
      expect(tracker.sonnetCost).toBeCloseTo(0.3, 4);
    });

    test('omitting model id defaults to Sonnet rates (back-compat with legacy callers)', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(tracker.sonnetCost).toBeCloseTo(0.3, 4);
    });

    test('mixed-model session sums per-family rates correctly', () => {
      // Haiku extraction turn: 1M input @ $1 = $1.00
      tracker.addSonnetUsage(
        {
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          input_tokens: 1_000_000,
          output_tokens: 0,
        },
        'claude-haiku-4-5-20251001'
      );
      // Sonnet observation turn: 1M input @ $3 = $3.00
      tracker.addSonnetUsage(
        {
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          input_tokens: 1_000_000,
          output_tokens: 0,
        },
        'claude-sonnet-4-6'
      );
      expect(tracker.sonnetCost).toBeCloseTo(4.0, 4);
      // Aggregate is preserved for toCostUpdate() back-compat
      expect(tracker.sonnet.turns).toBe(2);
      expect(tracker.sonnet.inputTokens).toBe(2_000_000);
    });

    test('compaction usage on Haiku also bills at Haiku rates', () => {
      tracker.addCompactionUsage(
        { input_tokens: 1_000_000, output_tokens: 0 },
        'claude-haiku-4-5-20251001'
      );
      expect(tracker.sonnetCost).toBeCloseTo(1.0, 4);
      expect(tracker.sonnet.compactions).toBe(1);
    });

    test('unknown model id falls back to Sonnet rates (safe default)', () => {
      tracker.addSonnetUsage(
        {
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
        'claude-something-new-9-9'
      );
      expect(tracker.sonnetCost).toBeCloseTo(0.3, 4);
    });
  });

  describe('ElevenLabs cost tracking', () => {
    test('should track character usage', () => {
      tracker.addElevenLabsUsage(100);
      tracker.addElevenLabsUsage(200);

      expect(tracker.elevenLabsCharacters).toBe(300);
      // Default model is Flash @ $0.00005/char.
      expect(tracker.elevenLabsCost).toBeCloseTo(300 * 0.00005, 6);
    });

    test('bills each model at its own rate + sums buckets for the derived total', () => {
      // Flash (default) + an explicit standard model in the same session.
      tracker.addElevenLabsUsage(100); // flash, 0.00005
      tracker.addElevenLabsUsage(200, 'eleven_multilingual_v2'); // standard, 0.0001

      // elevenLabsCharacters is the derived total across all model buckets.
      expect(tracker.elevenLabsCharacters).toBe(300);
      expect(tracker.elevenLabsCharsByModel.eleven_flash_v2_5).toBe(100);
      expect(tracker.elevenLabsCharsByModel.eleven_multilingual_v2).toBe(200);
      // Cost is per-model: 100×0.00005 (flash) + 200×0.0001 (standard).
      expect(tracker.elevenLabsCost).toBeCloseTo(100 * 0.00005 + 200 * 0.0001, 6);
    });

    test('turbo bills identically to flash (both 0.5 credits/char)', () => {
      tracker.addElevenLabsUsage(500, 'eleven_turbo_v2_5');
      expect(tracker.elevenLabsCost).toBeCloseTo(500 * 0.00005, 6);
    });

    test('unknown model id falls back to the flat ELEVENLABS_RATE_PER_CHAR', () => {
      tracker.addElevenLabsUsage(400, 'some_future_model');
      expect(tracker.elevenLabsCharsByModel.some_future_model).toBe(400);
      expect(tracker.elevenLabsCost).toBeCloseTo(400 * 0.00005, 6);
    });

    test('streaming + speculative accumulators thread modelId into buckets', () => {
      tracker.recordElevenLabsStreamingStarted(60, 'corr-stream'); // default flash
      tracker.recordElevenLabsSpeculativeStarted(40, 'corr-spec', 'eleven_multilingual_v2');

      expect(tracker.elevenLabsCharsByModel.eleven_flash_v2_5).toBe(60);
      expect(tracker.elevenLabsCharsByModel.eleven_multilingual_v2).toBe(40);
      expect(tracker.elevenLabsCharacters).toBe(100);
      expect(tracker.elevenLabsCost).toBeCloseTo(60 * 0.00005 + 40 * 0.0001, 6);
    });
  });

  describe('GPT Vision cost tracking', () => {
    test('should track photo and token usage', () => {
      tracker.addGptVisionUsage(1000, 500, 2);

      expect(tracker.gptVision.photos).toBe(2);
      expect(tracker.gptVision.inputTokens).toBe(1000);
      expect(tracker.gptVision.outputTokens).toBe(500);
    });

    test('should default to 1 image count', () => {
      tracker.addGptVisionUsage(1000, 500);
      expect(tracker.gptVision.photos).toBe(1);
    });

    test('should calculate GPT Vision cost correctly', () => {
      tracker.addGptVisionUsage(1000, 1000, 1);

      // 1000 input * $0.01/1K + 1000 output * $0.03/1K + 1 image * $0.01
      const expectedCost = (1000 * 0.01) / 1000 + (1000 * 0.03) / 1000 + 1 * 0.01;
      expect(tracker.gptVisionCost).toBeCloseTo(expectedCost, 6);
    });
  });

  describe('totalCost', () => {
    test('should sum all cost categories', () => {
      // Add some Sonnet tokens
      tracker.addSonnetUsage({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 1000,
        output_tokens: 500,
      });

      // Add ElevenLabs
      tracker.addElevenLabsUsage(100);

      // Add GPT Vision
      tracker.addGptVisionUsage(100, 50, 1);

      const total = tracker.totalCost;
      expect(total).toBe(
        tracker.deepgramCost + tracker.sonnetCost + tracker.elevenLabsCost + tracker.gptVisionCost
      );
    });
  });

  describe('toCostUpdate', () => {
    test('should return properly formatted cost update', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        input_tokens: 300,
        output_tokens: 100,
      });
      tracker.addElevenLabsUsage(50);
      tracker.addGptVisionUsage(100, 50, 1);

      const update = tracker.toCostUpdate();

      expect(update.type).toBe('cost_update');
      expect(update.sonnet.turns).toBe(1);
      expect(update.sonnet.cacheReads).toBe(1000);
      expect(update.sonnet.cacheWrites).toBe(200);
      expect(update.sonnet.input).toBe(300);
      expect(update.sonnet.output).toBe(100);
      expect(typeof update.sonnet.cost).toBe('number');
      expect(typeof update.deepgram.minutes).toBe('number');
      expect(typeof update.deepgram.cost).toBe('number');
      expect(update.elevenlabs.characters).toBe(50);
      expect(typeof update.elevenlabs.cost).toBe('number');
      expect(update.gptVision.photos).toBe(1);
      expect(typeof update.totalJobCost).toBe('number');
    });
  });

  describe('toSessionSummary', () => {
    test('should include extraction metadata', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
      });
      tracker.addCompactionUsage({ input_tokens: 50, output_tokens: 25 });

      const summary = tracker.toSessionSummary();

      expect(summary.type).toBe('session_summary');
      expect(summary.extraction.turns).toBe(1);
      expect(summary.extraction.compactions).toBe(1);
    });
  });
});

/**
 * recordElevenLabsUsageForSession — helper exported from sonnet-stream.js that
 * the `/api/proxy/elevenlabs-tts` route (keys.js) calls after a successful
 * TTS response to attribute character count to the live session's CostTracker.
 *
 * Without this glue per-session ElevenLabs cost was always zero on iOS (the
 * proxy path never populated the tracker). These tests exercise the contract
 * directly so the attribution logic is locked in without needing supertest
 * against the live route.
 */
describe('recordElevenLabsUsageForSession', () => {
  // Loaded lazily inside each test so we can clear the module's private
  // `activeSessions` Map between cases by re-importing with a cache bust.
  let recordFn;
  let activeSessions;

  beforeEach(async () => {
    // Import from the lightweight `active-sessions.js` rather than
    // sonnet-stream.js — the latter drags storage.js which blows up in
    // the Jest VM on `import.meta.dirname`.
    const mod = await import('../extraction/active-sessions.js');
    recordFn = mod.recordElevenLabsUsageForSession;
    activeSessions = mod.activeSessions;
    activeSessions.clear();
  });

  afterAll(() => {
    if (activeSessions) activeSessions.clear();
  });

  test('records character count against the session CostTracker and returns true', () => {
    const costTracker = new CostTracker();
    activeSessions.set('sess-abc', { session: { costTracker } });

    const result = recordFn('sess-abc', 120);

    expect(result).toBe(true);
    expect(costTracker.elevenLabsCharacters).toBe(120);
    expect(costTracker.elevenLabsCost).toBeCloseTo(120 * 0.00005, 6);
  });

  test('threads an explicit modelId through to the per-model bucket', () => {
    const costTracker = new CostTracker();
    activeSessions.set('sess-model', { session: { costTracker } });

    // The proxy route passes 'eleven_flash_v2_5' explicitly post-consolidation.
    expect(recordFn('sess-model', 120, 'eleven_flash_v2_5')).toBe(true);
    expect(costTracker.elevenLabsCharsByModel.eleven_flash_v2_5).toBe(120);
    expect(costTracker.elevenLabsCost).toBeCloseTo(120 * 0.00005, 6);
  });

  test('accumulates across multiple TTS proxy calls within the same session', () => {
    const costTracker = new CostTracker();
    activeSessions.set('sess-acc', { session: { costTracker } });

    recordFn('sess-acc', 50);
    recordFn('sess-acc', 70);

    expect(costTracker.elevenLabsCharacters).toBe(120);
  });

  test('returns false and does not throw when sessionId is unknown', () => {
    const result = recordFn('sess-never-existed', 100);
    expect(result).toBe(false);
  });

  test('returns false when sessionId is falsy (no attribution for null/""/undefined)', () => {
    expect(recordFn(null, 50)).toBe(false);
    expect(recordFn('', 50)).toBe(false);
    expect(recordFn(undefined, 50)).toBe(false);
  });

  test('returns false when characterCount is non-positive or non-numeric', () => {
    const costTracker = new CostTracker();
    activeSessions.set('sess-bad-count', { session: { costTracker } });

    expect(recordFn('sess-bad-count', 0)).toBe(false);
    expect(recordFn('sess-bad-count', -5)).toBe(false);
    expect(recordFn('sess-bad-count', '100')).toBe(false); // string not coerced
    expect(costTracker.elevenLabsCharacters).toBe(0);
  });

  test('returns false when the session entry is malformed (no costTracker)', () => {
    // Real failure mode: session is being torn down, costTracker cleared, but
    // a late TTS response still arrives at the proxy.
    activeSessions.set('sess-half-torn-down', { session: {} });
    expect(recordFn('sess-half-torn-down', 100)).toBe(false);
  });
});

describe('CostTracker — Loaded Barrel speculative sub-ledger (Phase 1.D extra)', () => {
  test('recordElevenLabsSpeculativeStarted increments chars + dedupes per correlationId', () => {
    const t = new CostTracker();
    expect(t.recordElevenLabsSpeculativeStarted(50, 'corr-A')).toBe(true);
    expect(t.elevenLabsSpeculative.charsStarted).toBe(50);
    // Mirrored into legacy aggregate so cost wire shape stays accurate.
    expect(t.elevenLabsCharacters).toBe(50);

    // Duplicate correlation ID is a no-op.
    expect(t.recordElevenLabsSpeculativeStarted(50, 'corr-A')).toBe(false);
    expect(t.elevenLabsSpeculative.charsStarted).toBe(50);
    expect(t.elevenLabsCharacters).toBe(50);

    // Different correlation ID accumulates.
    expect(t.recordElevenLabsSpeculativeStarted(30, 'corr-B')).toBe(true);
    expect(t.elevenLabsSpeculative.charsStarted).toBe(80);
  });

  test('recordElevenLabsSpeculativeStarted rejects missing id / invalid chars', () => {
    const t = new CostTracker();
    expect(t.recordElevenLabsSpeculativeStarted(50, null)).toBe(false);
    expect(t.recordElevenLabsSpeculativeStarted(50, '')).toBe(false);
    expect(t.recordElevenLabsSpeculativeStarted(0, 'corr-A')).toBe(false);
    expect(t.recordElevenLabsSpeculativeStarted(-1, 'corr-A')).toBe(false);
    expect(t.recordElevenLabsSpeculativeStarted(NaN, 'corr-A')).toBe(false);
    expect(t.elevenLabsSpeculative.charsStarted).toBe(0);
  });

  test('recordElevenLabsSpeculativeTerminal credits the right bucket + dedupes', () => {
    const t = new CostTracker();
    t.recordElevenLabsSpeculativeStarted(50, 'corr-completed');
    t.recordElevenLabsSpeculativeStarted(30, 'corr-cancelled');
    t.recordElevenLabsSpeculativeStarted(20, 'corr-failed');

    expect(t.recordElevenLabsSpeculativeTerminal('corr-completed', 'completed')).toBe(true);
    expect(t.recordElevenLabsSpeculativeTerminal('corr-cancelled', 'cancelled')).toBe(true);
    expect(t.recordElevenLabsSpeculativeTerminal('corr-failed', 'failed')).toBe(true);

    expect(t.elevenLabsSpeculative.charsCompleted).toBe(50);
    expect(t.elevenLabsSpeculative.charsCancelled).toBe(30);
    expect(t.elevenLabsSpeculative.charsFailed).toBe(20);

    // Duplicate terminal is no-op.
    expect(t.recordElevenLabsSpeculativeTerminal('corr-completed', 'completed')).toBe(false);
    expect(t.elevenLabsSpeculative.charsCompleted).toBe(50);
  });

  test('recordElevenLabsSpeculativeTerminal rejects invalid reason / missing id', () => {
    const t = new CostTracker();
    t.recordElevenLabsSpeculativeStarted(50, 'corr-A');
    expect(t.recordElevenLabsSpeculativeTerminal('corr-A', 'invalid')).toBe(false);
    expect(t.recordElevenLabsSpeculativeTerminal(null, 'completed')).toBe(false);
    expect(t.recordElevenLabsSpeculativeTerminal('', 'completed')).toBe(false);
  });

  // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.1).
  // The Terminal API accepts an optional opts object — the structural
  // cost-integrity fix is upstream (Pivot 11.4 moved Started after the
  // text-sent boundary). opts.reason and opts.cancelledBeforeTextSent
  // are vestigial post-v6 diagnostic markers that the speculator passes
  // through. Cost accounting MUST NOT depend on them.
  test('recordElevenLabsSpeculativeTerminal accepts opts and behaves identically to no-opts call', () => {
    const tA = new CostTracker();
    const tB = new CostTracker();
    tA.recordElevenLabsSpeculativeStarted(50, 'corr-A');
    tB.recordElevenLabsSpeculativeStarted(50, 'corr-A');

    // Call with opts.
    expect(
      tA.recordElevenLabsSpeculativeTerminal('corr-A', 'cancelled', {
        reason: 'cancelled_by_fast_tts_hint',
        cancelledBeforeTextSent: false,
      })
    ).toBe(true);
    // Call without opts (legacy shape).
    expect(tB.recordElevenLabsSpeculativeTerminal('corr-A', 'cancelled')).toBe(true);

    // Cost accounting must be byte-identical regardless of opts.
    expect(tA.elevenLabsSpeculative.charsCancelled).toBe(tB.elevenLabsSpeculative.charsCancelled);
    expect(tA.elevenLabsSpeculative.charsStarted).toBe(tB.elevenLabsSpeculative.charsStarted);
    expect(tA.elevenLabsSpeculative.charsCompleted).toBe(tB.elevenLabsSpeculative.charsCompleted);
    expect(tA.elevenLabsSpeculative.charsFailed).toBe(tB.elevenLabsSpeculative.charsFailed);
  });

  test('promoteSpeculativeToCanonical credits charsServed + dedupes', () => {
    const t = new CostTracker();
    t.recordElevenLabsSpeculativeStarted(50, 'corr-hit');
    t.recordElevenLabsSpeculativeTerminal('corr-hit', 'completed');

    expect(t.promoteSpeculativeToCanonical('corr-hit')).toBe(true);
    expect(t.elevenLabsSpeculative.charsServed).toBe(50);

    // Duplicate promote is no-op.
    expect(t.promoteSpeculativeToCanonical('corr-hit')).toBe(false);
    expect(t.elevenLabsSpeculative.charsServed).toBe(50);
  });

  test('promoteSpeculativeToCanonical fails when correlationId was never Started', () => {
    const t = new CostTracker();
    expect(t.promoteSpeculativeToCanonical('corr-unknown')).toBe(false);
    expect(t.elevenLabsSpeculative.charsServed).toBe(0);
  });

  test('elevenLabsSpeculativeWastedChars = started - served (rollback criterion)', () => {
    const t = new CostTracker();
    // Three speculations, one HIT, two WASTED.
    t.recordElevenLabsSpeculativeStarted(50, 'hit-1');
    t.recordElevenLabsSpeculativeStarted(30, 'wasted-1');
    t.recordElevenLabsSpeculativeStarted(20, 'wasted-2');
    t.recordElevenLabsSpeculativeTerminal('hit-1', 'completed');
    t.recordElevenLabsSpeculativeTerminal('wasted-1', 'cancelled');
    t.recordElevenLabsSpeculativeTerminal('wasted-2', 'completed');
    t.promoteSpeculativeToCanonical('hit-1');

    expect(t.elevenLabsSpeculative.charsStarted).toBe(100);
    expect(t.elevenLabsSpeculative.charsServed).toBe(50);
    expect(t.elevenLabsSpeculativeWastedChars).toBe(50); // 100 - 50
  });

  test('audit invariant: every Started has exactly one Terminal at session-end', () => {
    // Plan v10 §B asserted invariant. This test is a unit smoke; the
    // full 10k-seed fuzz lands in Phase 5.
    const t = new CostTracker();
    for (let i = 0; i < 20; i++) {
      const id = `corr-${i}`;
      t.recordElevenLabsSpeculativeStarted(10 + i, id);
      const reason = i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'cancelled' : 'failed';
      t.recordElevenLabsSpeculativeTerminal(id, reason);
    }
    expect(t.elevenLabsSpeculative._seenCorrelationIds.size).toBe(20);
    expect(t.elevenLabsSpeculative._terminalCorrelationIds.size).toBe(20);
    // Invariant: charsCompleted + charsCancelled + charsFailed = charsStarted.
    const spec = t.elevenLabsSpeculative;
    expect(spec.charsCompleted + spec.charsCancelled + spec.charsFailed).toBe(spec.charsStarted);
  });
});
