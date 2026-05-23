/**
 * CostTracker streaming-accounting contract (Stage 2 commit 2.6).
 *
 * Pins PLAN_v4 §A.10:
 *   recordElevenLabsStreamingStarted is idempotent on correlationId,
 *   chars_started is billable, terminal counter is separate, and
 *   chars_completed + chars_cancelled + chars_failed = chars_started.
 */

import { jest } from '@jest/globals';

// CostTracker is exported from the cost-tracker.js module.
const { CostTracker } = await import('../extraction/cost-tracker.js');

describe('CostTracker streaming accounting', () => {
  test('started + completed: invariant holds', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(100, 'vl_conf_a');
    t.recordElevenLabsStreamingTerminal('vl_conf_a', 'completed', 100);
    expect(t.elevenLabsStreaming.charsStarted).toBe(100);
    expect(t.elevenLabsStreaming.charsCompleted).toBe(100);
    expect(t.elevenLabsStreaming.charsCancelled).toBe(0);
    expect(t.elevenLabsStreaming.charsFailed).toBe(0);
  });

  test('started + cancelled: invariant holds', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(50, 'vl_conf_b');
    t.recordElevenLabsStreamingTerminal('vl_conf_b', 'cancelled', 50);
    expect(t.elevenLabsStreaming.charsStarted).toBe(50);
    expect(t.elevenLabsStreaming.charsCompleted).toBe(0);
    expect(t.elevenLabsStreaming.charsCancelled).toBe(50);
    expect(t.elevenLabsStreaming.charsFailed).toBe(0);
  });

  test('started + failed: invariant holds', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(75, 'vl_conf_c');
    t.recordElevenLabsStreamingTerminal('vl_conf_c', 'failed', 75);
    expect(t.elevenLabsStreaming.charsStarted).toBe(75);
    expect(t.elevenLabsStreaming.charsFailed).toBe(75);
  });

  test('idempotent: duplicate started for same correlationId is no-op', () => {
    const t = new CostTracker();
    expect(t.recordElevenLabsStreamingStarted(100, 'vl_d')).toBe(true);
    expect(t.recordElevenLabsStreamingStarted(100, 'vl_d')).toBe(false);
    expect(t.elevenLabsStreaming.charsStarted).toBe(100);
  });

  test('idempotent: duplicate terminal for same correlationId is no-op', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(100, 'vl_e');
    expect(t.recordElevenLabsStreamingTerminal('vl_e', 'completed', 100)).toBe(true);
    expect(t.recordElevenLabsStreamingTerminal('vl_e', 'completed', 100)).toBe(false);
    expect(t.elevenLabsStreaming.charsCompleted).toBe(100);
  });

  test('multiple correlation IDs accumulate independently', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(100, 'vl_x');
    t.recordElevenLabsStreamingStarted(50, 'vl_y');
    t.recordElevenLabsStreamingTerminal('vl_x', 'completed', 100);
    t.recordElevenLabsStreamingTerminal('vl_y', 'cancelled', 50);
    expect(t.elevenLabsStreaming.charsStarted).toBe(150);
    expect(t.elevenLabsStreaming.charsCompleted).toBe(100);
    expect(t.elevenLabsStreaming.charsCancelled).toBe(50);
  });

  test('elevenLabsCost mirrors charsStarted (billable when text accepted)', () => {
    const t = new CostTracker();
    t.recordElevenLabsStreamingStarted(1000, 'vl_z');
    // cost mirrors via the existing elevenLabsCharacters single-counter
    expect(t.elevenLabsCharacters).toBe(1000);
    expect(t.elevenLabsCost).toBeGreaterThan(0);
  });

  test('no-op when correlationId missing or characterCount invalid', () => {
    const t = new CostTracker();
    expect(t.recordElevenLabsStreamingStarted(0, 'vl_zz')).toBe(true); // 0 chars allowed
    expect(t.recordElevenLabsStreamingStarted(100, null)).toBe(false);
    expect(t.recordElevenLabsStreamingStarted(100, undefined)).toBe(false);
    expect(t.recordElevenLabsStreamingTerminal(null, 'completed', 100)).toBe(false);
    expect(t.recordElevenLabsStreamingTerminal('vl_a', null, 100)).toBe(false);
  });

  test('legacy addElevenLabsUsage continues to work independently', () => {
    const t = new CostTracker();
    t.addElevenLabsUsage(50);
    t.recordElevenLabsStreamingStarted(75, 'vl_a');
    expect(t.elevenLabsCharacters).toBe(125);
    expect(t.elevenLabsStreaming.charsStarted).toBe(75);
  });
});
