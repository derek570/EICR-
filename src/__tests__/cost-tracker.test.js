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
      expect(tracker.SONNET_RATES.cacheRead).toBe(0.30);
      expect(tracker.SONNET_RATES.cacheWrite).toBe(3.75);
      expect(tracker.SONNET_RATES.input).toBe(3.00);
      expect(tracker.SONNET_RATES.output).toBe(15.00);
      expect(tracker.ELEVENLABS_RATE_PER_CHAR).toBe(0.000030);
    });
  });

  describe('Deepgram cost tracking', () => {
    test('should calculate cost for recording duration', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)          // startRecording
        .mockReturnValueOnce(now + 60000); // stopRecording (1 minute)

      tracker.startRecording();
      tracker.stopRecording();

      expect(tracker.deepgramMinutes).toBeCloseTo(1.0, 1);
      expect(tracker.deepgramCost).toBeCloseTo(0.0077, 4);

      Date.now.mockRestore();
    });

    test('should handle pause and resume', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)            // startRecording
        .mockReturnValueOnce(now + 30000)    // pauseRecording (30s recorded)
        .mockReturnValueOnce(now + 30000)    // pauseStartTime
        .mockReturnValueOnce(now + 60000)    // resumeRecording
        .mockReturnValueOnce(now + 90000)    // stopRecording (another 30s)

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
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)          // startRecording
        .mockReturnValueOnce(now + 30000)  // first pauseRecording
        .mockReturnValueOnce(now + 30000)  // pauseStartTime
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
        output_tokens: 100
      });

      tracker.addSonnetUsage({
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 0,
        input_tokens: 300,
        output_tokens: 150
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
        output_tokens: 0
      });

      expect(tracker.sonnetCost).toBeCloseTo(0.30, 2);
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
        output_tokens: 200
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
      expect(tracker.elevenLabsCost).toBeCloseTo(300 * 0.000030, 6);
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
      const expectedCost = (1000 * 0.01 / 1000) + (1000 * 0.03 / 1000) + (1 * 0.01);
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
        output_tokens: 500
      });

      // Add ElevenLabs
      tracker.addElevenLabsUsage(100);

      // Add GPT Vision
      tracker.addGptVisionUsage(100, 50, 1);

      const total = tracker.totalCost;
      expect(total).toBe(tracker.deepgramCost + tracker.sonnetCost + tracker.elevenLabsCost + tracker.gptVisionCost);
    });
  });

  describe('toCostUpdate', () => {
    test('should return properly formatted cost update', () => {
      tracker.addSonnetUsage({
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        input_tokens: 300,
        output_tokens: 100
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
        output_tokens: 50
      });
      tracker.addCompactionUsage({ input_tokens: 50, output_tokens: 25 });

      const summary = tracker.toSessionSummary();

      expect(summary.type).toBe('session_summary');
      expect(summary.extraction.turns).toBe(1);
      expect(summary.extraction.compactions).toBe(1);
    });
  });
});
