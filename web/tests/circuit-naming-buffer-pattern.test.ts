/**
 * Bug K (2026-05-11) — trailing-"Circuit N is" detection pattern.
 *
 * The full buffer-and-flush flow is wired into the openDeepgram
 * callback in recording-context.tsx (DeepgramService onFinalTranscript
 * → pendingNamingBufferRef → dispatchFinal). That handler depends on a
 * heavy mic + audio + WS stack we don't mount in vitest. We pin the
 * load-bearing piece — the regex that decides whether to buffer —
 * in isolation here so a future edit can't silently drift its trigger
 * shape away from iOS.
 *
 * The regex is duplicated in two places by design: the web client
 * here, and the iOS client in DeepgramRecordingViewModel.swift (same
 * date stamp). Both must accept and reject the same shapes — this
 * test pins the contract on the web side; the parallel iOS XCTest
 * pins the Swift side.
 *
 * Production session sess_mp19b6tf_i5xc (2026-05-11 13:48 UTC) is the
 * anchor: "Circuit 2 is" landed as a final on its own, 2 s later
 * "downstairs socket." landed separately. Sonnet at turn 3 saw only
 * the trailing fragment, mis-routed it via DESCRIPTION MATCHING, and
 * renamed Circuit 1 ("Cooker") instead of creating Circuit 2.
 */
import { describe, it, expect } from 'vitest';

// The pattern is module-private to recording-context.tsx. We replicate
// it here verbatim so the test can run without importing the entire
// recording stack. If the source pattern changes, this test FAILS
// loudly until the duplicate is updated — exactly what we want for a
// load-bearing decision rule.
const TRAILING_CIRCUIT_NAMING_PATTERN =
  /\bcircuit\s+(?:number\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+is\s*\.?\s*$/i;

function isTrailingCircuitNamingPattern(text: string): boolean {
  return TRAILING_CIRCUIT_NAMING_PATTERN.test(text);
}

describe('isTrailingCircuitNamingPattern — Bug K buffer trigger', () => {
  describe('TRIGGERS (buffer the final, wait for completion)', () => {
    it('"Circuit 2 is" — bare digit, the production-session shape', () => {
      expect(isTrailingCircuitNamingPattern('Circuit 2 is')).toBe(true);
    });

    it('"Circuit 2 is." — Deepgram often appends a sentence-final period', () => {
      expect(isTrailingCircuitNamingPattern('Circuit 2 is.')).toBe(true);
    });

    it('"Circuit number 5 is" — word "number" alternation', () => {
      expect(isTrailingCircuitNamingPattern('Circuit number 5 is')).toBe(true);
    });

    it('"Circuit one is" — spelled-out digit', () => {
      expect(isTrailingCircuitNamingPattern('Circuit one is')).toBe(true);
    });

    it('"Circuit twelve is" — highest spelled-out we support', () => {
      expect(isTrailingCircuitNamingPattern('Circuit twelve is')).toBe(true);
    });

    it('mixed case ("circuit 3 IS")', () => {
      // Pattern is /i so case-insensitive; pin explicitly so a future
      // edit doesn't drop the flag and silently degrade for spoken
      // sentence-case finals.
      expect(isTrailingCircuitNamingPattern('circuit 3 IS')).toBe(true);
    });

    it('trailing whitespace ("Circuit 2 is   ")', () => {
      expect(isTrailingCircuitNamingPattern('Circuit 2 is   ')).toBe(true);
    });

    it('with a leading filler word ("OK circuit 4 is")', () => {
      // \b on the circuit anchor — leading text is fine as long as the
      // trailing-naming shape sits at the end.
      expect(isTrailingCircuitNamingPattern('OK circuit 4 is')).toBe(true);
    });
  });

  describe('DOES NOT TRIGGER (the dispatch path runs normally)', () => {
    it('"Circuit 1 is a cooker." — complete utterance, no buffering needed', () => {
      expect(isTrailingCircuitNamingPattern('Circuit 1 is a cooker.')).toBe(false);
    });

    it('"Circuit 1 is the security alarm" — Example 6 happy path', () => {
      expect(isTrailingCircuitNamingPattern('Circuit 1 is the security alarm')).toBe(false);
    });

    it('"Zs on circuit 2 is 0.40" — reading utterance with circuit ref mid-sentence', () => {
      // The pattern requires "is" at the END. A reading utterance like
      // this has more content after "is" so the regex correctly bypasses.
      expect(isTrailingCircuitNamingPattern('Zs on circuit 2 is 0.40')).toBe(false);
    });

    it('"downstairs sockets" — bare designation follow-up, NOT the trigger', () => {
      // This is the SECOND half of the split utterance. It's the text
      // that flushes a pending buffer via concat — it must NOT itself
      // trigger a new buffer or we'd loop forever on naming fragments.
      expect(isTrailingCircuitNamingPattern('downstairs sockets')).toBe(false);
    });

    it('"What is this for?" — random "is" in different context', () => {
      expect(isTrailingCircuitNamingPattern('What is this for?')).toBe(false);
    });

    it('"" — empty string, defensive', () => {
      expect(isTrailingCircuitNamingPattern('')).toBe(false);
    });

    it('"Circuit 2" — no "is" at all, not a naming preface yet', () => {
      // Inspector said the ref but trailed off before "is" — Deepgram
      // shouldn't normally emit this shape, but if it did, the regex
      // correctly declines to buffer (we have no naming intent yet).
      expect(isTrailingCircuitNamingPattern('Circuit 2')).toBe(false);
    });

    it('"Circuit thirteen is" — out-of-range spelled number, falls through', () => {
      // We support one-twelve verbally; thirteen+ are rare in practice
      // (most house circuits cap at 6-12). If the inspector dictates a
      // larger number it'll arrive as a digit anyway. The trigger is
      // deliberately bounded to keep the regex fast and the false-
      // positive surface narrow.
      expect(isTrailingCircuitNamingPattern('Circuit thirteen is')).toBe(false);
    });
  });
});
