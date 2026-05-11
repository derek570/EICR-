/**
 * Regression test for the TTS fingerprint echo gate (Bug F, 2026-05-11).
 *
 * Pins the iOS-canon thresholds:
 *   - 15-second TTL per fingerprint
 *   - Subset match either direction for short text (≤ 2 words)
 *   - > 70 % word-Set overlap for longer text
 *
 * Tests use __registerTtsFingerprintForTests so they don't depend on the
 * speechSynthesis polyfill being present in the jsdom env — the
 * production registration path lives inside dispatch() and is exercised
 * by the broader recording-context integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __registerTtsFingerprintForTests,
  __resetTtsFingerprintsForTests,
  isTTSEcho,
} from '@/lib/recording/tts';

describe('TTS fingerprint echo gate', () => {
  beforeEach(() => {
    __resetTtsFingerprintsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetTtsFingerprintsForTests();
    vi.useRealTimers();
  });

  it('returns false when no TTS has been dispatched', () => {
    expect(isTTSEcho('any text at all')).toBe(false);
  });

  it('catches exact echo of a long TTS phrase', () => {
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    expect(isTTSEcho('what is the designation for circuit 2')).toBe(true);
  });

  it('catches partial echo above 70% word overlap', () => {
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    // transcript {the, designation, for, circuit, 2, is, what} vs
    // fp {what, is, the, designation, for, circuit, 2} — full overlap
    expect(isTTSEcho('the designation for circuit 2 is what')).toBe(true);
  });

  it('lets through a natural answer that shares little vocabulary', () => {
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    expect(isTTSEcho('downstairs lights')).toBe(false);
    expect(isTTSEcho('sockets')).toBe(false);
  });

  it('uses subset match for short fingerprints', () => {
    __registerTtsFingerprintForTests('Updated');
    expect(isTTSEcho('updated')).toBe(true);
    // transcript word-set is a superset; still subset-match via fp ⊆ transcript
    expect(isTTSEcho('updated successfully')).toBe(true);
  });

  it('uses subset match for short transcripts', () => {
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    // single-word transcript ⊆ fp
    expect(isTTSEcho('designation')).toBe(true);
  });

  it('expires fingerprints after 15 seconds', () => {
    __registerTtsFingerprintForTests('Updated');
    expect(isTTSEcho('Updated')).toBe(true);
    vi.advanceTimersByTime(15_001);
    expect(isTTSEcho('Updated')).toBe(false);
  });

  it('keeps fingerprints valid just before TTL', () => {
    __registerTtsFingerprintForTests('Updated');
    vi.advanceTimersByTime(14_999);
    expect(isTTSEcho('Updated')).toBe(true);
  });

  it('handles multiple overlapping fingerprints', () => {
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    __registerTtsFingerprintForTests('What is the Zs for circuit 3');
    expect(isTTSEcho('what is the designation for circuit 2')).toBe(true);
    expect(isTTSEcho('what is the zs for circuit 3')).toBe(true);
    expect(isTTSEcho('downstairs sockets')).toBe(false);
  });

  it('is case-insensitive', () => {
    __registerTtsFingerprintForTests('UPDATED');
    expect(isTTSEcho('updated')).toBe(true);
    __registerTtsFingerprintForTests('What is the designation for circuit 2');
    expect(isTTSEcho('WHAT IS THE DESIGNATION FOR CIRCUIT 2')).toBe(true);
  });

  it('ignores empty / whitespace-only transcripts', () => {
    __registerTtsFingerprintForTests('Updated');
    expect(isTTSEcho('')).toBe(false);
    expect(isTTSEcho('   ')).toBe(false);
  });
});
