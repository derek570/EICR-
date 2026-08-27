/**
 * PLAN-E1B2 item 4 — unit tests for `wordErrorRate`, the aligned
 * word-error-rate function that replaced `deepgram-codec-ab-bench.mjs`'s
 * prior set-membership `wordDiff` (Codex diff-review r2 IMPORTANT finding:
 * set membership ignores word order, duplicates, and insertions, so a
 * scrambled-but-lexically-complete transcript scored as a perfect match).
 *
 * The bench script lives outside `web/` (`scripts/voice-latency-bench/`)
 * and isn't part of the web build; imported directly here since it's a
 * plain ESM module with no browser/Next.js dependencies.
 */
import { describe, it, expect } from 'vitest';
import { wordErrorRate } from '../../scripts/voice-latency-bench/deepgram-codec-ab-bench.mjs';

describe('wordErrorRate', () => {
  it('exact match scores zero WER', () => {
    const result = wordErrorRate(
      'circuit three Zs point four two',
      'circuit three Zs point four two'
    );
    expect(result.editDistance).toBe(0);
    expect(result.wer).toBe(0);
  });

  it('one substitution scores 1/N', () => {
    const result = wordErrorRate(
      'circuit three Zs point four two',
      'circuit five Zs point four two'
    );
    expect(result.editDistance).toBe(1);
    expect(result.wer).toBeCloseTo(1 / 6);
  });

  it('one insertion scores 1/N', () => {
    const result = wordErrorRate('circuit three Zs', 'circuit three the Zs');
    expect(result.editDistance).toBe(1);
    expect(result.wer).toBeCloseTo(1 / 3);
  });

  it('one deletion scores 1/N', () => {
    const result = wordErrorRate('circuit three Zs point', 'circuit three point');
    expect(result.editDistance).toBe(1);
    expect(result.wer).toBeCloseTo(1 / 4);
  });

  it('word-order-only scrambling is NOT a perfect match — the exact defect set-membership missed', () => {
    // Same word SET, different order — set-membership would score this
    // 0 missing words (a perfect match); aligned WER correctly penalizes
    // the reordering.
    const result = wordErrorRate(
      'circuit three Zs point four two',
      'two four point Zs three circuit'
    );
    expect(result.wer).toBeGreaterThan(0);
  });

  it('punctuation and case are ignored', () => {
    const result = wordErrorRate('Circuit three, Zs.', 'circuit THREE zs');
    expect(result.wer).toBe(0);
  });

  it('an empty actual transcript against a non-empty expected one scores full WER', () => {
    const result = wordErrorRate('circuit three', '');
    expect(result.editDistance).toBe(2);
    expect(result.wer).toBe(1);
  });
  it('an empty reference against a punctuation-only hypothesis is a perfect match (normalizes to no tokens)', () => {
    const result = wordErrorRate('', '... !!');
    expect(result.editDistance).toBe(0);
    expect(result.wer).toBe(0);
  });

  it('an empty reference against a real hypothesis scores full WER (pure insertions)', () => {
    const result = wordErrorRate('', 'circuit three');
    expect(result.editDistance).toBe(2);
    expect(result.wer).toBe(1);
  });
});
