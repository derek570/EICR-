/**
 * PLAN-E1B2 item 3 — `capture-tagging.ts`'s `tagCapturedFloat32`, the
 * single production hook that tags a captured mic block and feeds the
 * session's shared VAD. No dedicated test file existed for it before this
 * plan.
 *
 * `tagCapturedFloat32` is exercised directly (it IS the production
 * function `recording-context.tsx`'s `onSamples` calls — not a copy),
 * proving it threads a real `recordingSessionId` and a genuine
 * caller-supplied `capturedAt` through to the shared VAD, never a
 * placeholder or an internally-computed value.
 *
 * The wiring INSIDE `onSamples` itself (where `capturedAt` is stamped
 * relative to the TTS-discard guard and the resample call, and how it
 * reaches both the primary ctx-tagging branch and the fallback branch) is
 * asserted via a source-adjacency check on the real `recording-context.tsx`
 * — `RecordingProvider` is not unit-mountable with real audio sample
 * injection (`fakeMicCaptureFactory` in `tests/harness/fake-services.ts`
 * never feeds samples at all; no existing harness synthesizes audio
 * through the real mic-capture seam), so this mirrors the house
 * `source-adjacency assertion` pattern used elsewhere for the same
 * structural reason (see `ws7-haptic-call-sites.test.tsx`'s own comment).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tagCapturedFloat32 } from '@/lib/recording/capture-tagging';
import { VoicedActivityDetector } from '@/lib/recording/voiced-activity';
import { createCaptureClock } from '@/lib/recording/deepgram-service';
import { UplinkScopeAllocator } from '@/lib/recording/uplink-scope-allocator';
import type { DeepgramSessionContext } from '@/lib/recording/deepgram-service';
import type { VoicedRangeClassification } from '@/lib/recording/voiced-activity';

function makeContext(vad?: VoicedActivityDetector): DeepgramSessionContext {
  return {
    recordingSessionId: 'sess-capture-tagging-test',
    codecLatch: { get: () => null, set: () => {} } as any,
    allocator: new UplinkScopeAllocator(),
    captureClock: createCaptureClock(),
    vad,
  };
}

describe('tagCapturedFloat32', () => {
  it('tags the segment with the REAL recordingSessionId and the caller-supplied capturedAt (not a placeholder)', () => {
    const ctx = makeContext();
    const samples = new Float32Array(320).fill(0.1);
    const segment = tagCapturedFloat32(samples, ctx, null, 42_000);
    expect(segment.recordingSessionId).toBe('sess-capture-tagging-test');
    expect(segment.capturedAt).toBe(42_000);
    expect(segment.origin).toBe('captured');
  });

  it('feeds the session VAD with the SAME recordingSessionId and capturedAt it stamps onto the returned segment', () => {
    const classifications: VoicedRangeClassification[] = [];
    const vad = new VoicedActivityDetector(
      () => {},
      (c) => classifications.push(c)
    );
    const ctx = makeContext(vad);
    const samples = new Float32Array(320).fill(0.1);
    const capturedAt = 99_500;
    const segment = tagCapturedFloat32(samples, ctx, null, capturedAt);

    expect(classifications).toHaveLength(1);
    expect(classifications[0].recordingSessionId).toBe(segment.recordingSessionId);
    expect(classifications[0].capturedAt).toBe(capturedAt);
  });

  it('advances the shared capture clock across successive calls, independent of capturedAt', () => {
    const ctx = makeContext();
    const first = tagCapturedFloat32(new Float32Array(320).fill(0.1), ctx, null, 100);
    const second = tagCapturedFloat32(new Float32Array(320).fill(0.1), ctx, null, 50); // an "earlier" capturedAt, later call
    expect(first.captureSampleRange).toEqual({ start: 0, end: 320 });
    expect(second.captureSampleRange).toEqual({ start: 320, end: 640 });
    // capturedAt is whatever the caller passes — this function does not
    // validate or reorder it; that discipline lives at the true
    // capture-ingress boundary (recording-context.tsx's onSamples).
    expect(second.capturedAt).toBe(50);
  });

  it('does not feed the VAD when the session has none (VAD is optional)', () => {
    const ctx = makeContext(undefined);
    expect(() => tagCapturedFloat32(new Float32Array(320).fill(0.1), ctx, null, 1)).not.toThrow();
  });
});

describe('recording-context.tsx onSamples wiring (source-adjacency — see file header)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../src/lib/recording-context.tsx'), 'utf8');

  it('stamps capturedAt immediately after the TTS-discard guard, before resampling', () => {
    // The TTS-discard guard, THEN the capturedAt stamp, THEN the resample
    // call — in that exact order. A stamp taken after resampling would
    // record a later time than the frame's true ingress instant.
    expect(src).toMatch(
      /if \(ttsActiveRef\.current\) return;\s*\n(?:\s*\/\/[^\n]*\n)*\s*const capturedAt = performance\.now\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*const samples16k = resampleTo16k\(samples, handle\.sampleRate\);/
    );
  });

  it('threads the SAME capturedAt into both tagCapturedFloat32 (primary branch) and sendSamples (fallback branch)', () => {
    expect(src).toMatch(
      /tagCapturedFloat32\(\s*\n\s*samples16k,\s*\n\s*ctx,\s*\n\s*deepgramRef\.current\?\.liveEpoch \?\? null,\s*\n\s*capturedAt\s*\n\s*\);/
    );
    expect(src).toMatch(/deepgramRef\.current\?\.sendSamples\(samples16k, capturedAt\);/);
  });

  it("wires the VAD onset transition's OWN capturedAt into the poor-signal probe, not a freshly-read clock value", () => {
    expect(src).toMatch(/poorSignalProbeRef\.current\?\.onOnset\(transition\.capturedAt\);/);
  });
});
