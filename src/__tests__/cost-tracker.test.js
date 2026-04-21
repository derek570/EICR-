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
      expect(tracker.ELEVENLABS_RATE_PER_CHAR).toBe(0.00003);
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

  describe('ElevenLabs cost tracking', () => {
    test('should track character usage', () => {
      tracker.addElevenLabsUsage(100);
      tracker.addElevenLabsUsage(200);

      expect(tracker.elevenLabsCharacters).toBe(300);
      expect(tracker.elevenLabsCost).toBeCloseTo(300 * 0.00003, 6);
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
    expect(costTracker.elevenLabsCost).toBeCloseTo(120 * 0.00003, 6);
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
