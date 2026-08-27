import { describe, it, expect, vi } from 'vitest';
import {
  VoicedActivityDetector,
  classifyPcmEnergy,
  VAD_ENERGY_RMS_THRESHOLD,
  VAD_SILENCE_HOLD_SAMPLES,
  type VoicedRangeClassification,
} from '@/lib/recording/voiced-activity';
import type { CapturedPcmSegment } from '@/lib/recording/tagged-pcm-segment';
import type { EpochScope } from '@/lib/recording/uplink-scope-allocator';

function loudFrame(n: number): Int16Array {
  const arr = new Int16Array(n);
  for (let i = 0; i < n; i++) arr[i] = i % 2 === 0 ? 8000 : -8000;
  return arr;
}
function silentFrame(n: number): Int16Array {
  return new Int16Array(n);
}

const PRE_OPEN_SCOPE: EpochScope = { kind: 'preOpen', captureAttemptId: 1 as any };

/** Builds a `CapturedPcmSegment` — the SAME tagged-frame shape production
 *  passes into `processFrame` (PLAN-E1B2 item 3's widened contract). */
function makeSegment(
  samples: Int16Array,
  start: number,
  end: number,
  opts: { epochScope?: EpochScope; recordingSessionId?: string; capturedAt?: number } = {}
): CapturedPcmSegment {
  return {
    origin: 'captured',
    samples,
    recordingSessionId: opts.recordingSessionId ?? 'sess-test',
    captureSampleRange: { start, end },
    epochScope: opts.epochScope ?? PRE_OPEN_SCOPE,
    capturedAt: opts.capturedAt ?? 0,
  };
}

describe('classifyPcmEnergy', () => {
  it('classifies a loud frame as voiced and silence as not', () => {
    expect(classifyPcmEnergy(loudFrame(320))).toBe(true);
    expect(classifyPcmEnergy(silentFrame(320))).toBe(false);
  });

  it('empty samples are never voiced', () => {
    expect(classifyPcmEnergy(new Int16Array(0))).toBe(false);
  });

  it('RMS right at the threshold classifies voiced (>= not >)', () => {
    const n = 100;
    const arr = new Int16Array(n).fill(VAD_ENERGY_RMS_THRESHOLD);
    expect(classifyPcmEnergy(arr)).toBe(true);
  });
});

describe('VoicedActivityDetector', () => {
  it('fires an onset transition on the first voiced frame', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    expect(transitions).toEqual(['onset']);
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('does not re-fire onset on consecutive voiced frames', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    vad.processFrame(makeSegment(loudFrame(320), 320, 640));
    vad.processFrame(makeSegment(loudFrame(320), 640, 960));
    expect(transitions).toEqual(['onset']);
  });

  it('debounces silence — a brief sub-threshold gap does not flip to silence', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    // A short silent gap well under VAD_SILENCE_HOLD_SAMPLES.
    vad.processFrame(makeSegment(silentFrame(320), 320, 640));
    expect(transitions).toEqual(['onset']);
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('fires silence only after continuous sub-threshold audio exceeds the hold', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    let cursor = 320;
    while (cursor - 320 < VAD_SILENCE_HOLD_SAMPLES) {
      vad.processFrame(makeSegment(silentFrame(320), cursor, cursor + 320));
      cursor += 320;
    }
    expect(transitions).toEqual(['onset', 'silence']);
    expect(vad.isLocalSpeaking).toBe(false);
  });

  it('is CONTINUOUS across an epoch rotation — reconnect does not reset speaking state', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    expect(vad.isLocalSpeaking).toBe(true);
    // Simulate a reconnect: a NEW epoch scope, but the detector itself is
    // NOT reset (only `reset()` at session boundaries clears it).
    vad.processFrame(
      makeSegment(loudFrame(320), 320, 640, { epochScope: { kind: 'epoch', id: 5 as any } })
    );
    expect(transitions).toEqual(['onset']); // no re-fire — state carried through
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('reset() clears speaking state (session-boundary only)', () => {
    const vad = new VoicedActivityDetector(() => {});
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    expect(vad.isLocalSpeaking).toBe(true);
    vad.reset();
    expect(vad.isLocalSpeaking).toBe(false);
  });

  it('classifySnapshot is stateless and does not affect debouncing', () => {
    const vad = new VoicedActivityDetector(() => {});
    expect(vad.classifySnapshot(loudFrame(320))).toBe(true);
    expect(vad.isLocalSpeaking).toBe(false); // unaffected — no processFrame call
  });

  // PLAN-E1B2 item 3 — PLAN-E1-final.md's own required "injected E2-style
  // consumer" test: no such test existed before this plan, and E2's
  // disclosure/parking gate consumes exactly this seam.
  it('onClassification fires once per processFrame call with the exact tuple, including capturedAt', () => {
    const classifications: VoicedRangeClassification[] = [];
    const vad = new VoicedActivityDetector(
      () => {},
      (c) => classifications.push(c)
    );
    const segment = makeSegment(loudFrame(320), 0, 320, {
      recordingSessionId: 'sess-abc',
      capturedAt: 12345,
    });
    const returned = vad.processFrame(segment);
    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toEqual({
      captureSampleRange: { start: 0, end: 320 },
      epochScope: PRE_OPEN_SCOPE,
      voiced: true,
      recordingSessionId: 'sess-abc',
      capturedAt: 12345,
    });
    // The returned value and the delivered classification are the SAME
    // object/shape — no separate computation path.
    expect(returned).toEqual(classifications[0]);
  });

  it('onClassification fires for EVERY frame, not just frames that produce a transition', () => {
    const classifications: VoicedRangeClassification[] = [];
    const vad = new VoicedActivityDetector(
      () => {},
      (c) => classifications.push(c)
    );
    vad.processFrame(makeSegment(loudFrame(320), 0, 320));
    vad.processFrame(makeSegment(loudFrame(320), 320, 640)); // no transition (already speaking)
    expect(classifications).toHaveLength(2);
  });

  it('a preOpen -> epoch(id) rotation on continuous speech keeps isLocalSpeaking continuous while per-range classifications reflect the changing scope', () => {
    const transitions: string[] = [];
    const classifications: VoicedRangeClassification[] = [];
    const vad = new VoicedActivityDetector(
      (t) => transitions.push(t.kind),
      (c) => classifications.push(c)
    );
    const epochScope: EpochScope = { kind: 'epoch', id: 7 as any };

    vad.processFrame(makeSegment(loudFrame(320), 0, 320, { epochScope: PRE_OPEN_SCOPE }));
    vad.processFrame(makeSegment(loudFrame(320), 320, 640, { epochScope: PRE_OPEN_SCOPE }));
    vad.processFrame(makeSegment(loudFrame(320), 640, 960, { epochScope }));
    vad.processFrame(makeSegment(loudFrame(320), 960, 1280, { epochScope }));

    // Parking primitive: continuous throughout, one onset only.
    expect(transitions).toEqual(['onset']);
    expect(vad.isLocalSpeaking).toBe(true);
    // Materiality primitive: each range's own classification correctly
    // reflects whichever scope was current when IT was captured.
    expect(classifications.map((c) => c.epochScope)).toEqual([
      PRE_OPEN_SCOPE,
      PRE_OPEN_SCOPE,
      epochScope,
      epochScope,
    ]);
    expect(classifications.every((c) => c.voiced)).toBe(true);
  });

  // PLAN-E1B2 item 3 (round-4 finding) — mirrors the finalized iOS
  // sibling's own item 3 test: a queue hop between frame ingress and
  // processFrame's execution must not change the recorded capturedAt.
  it('a delayed processFrame call does not change the recorded capturedAt (real queue hop)', async () => {
    vi.useFakeTimers();
    try {
      const classifications: VoicedRangeClassification[] = [];
      const vad = new VoicedActivityDetector(
        () => {},
        (c) => classifications.push(c)
      );
      // Stamp at ingress from the SAME clock production uses...
      const ingress = performance.now();
      const segment = makeSegment(loudFrame(320), 0, 320, { capturedAt: ingress });
      // ...then genuinely defer processing across a queue hop (a macrotask
      // 5 s later), so "now" at processFrame time is far from ingress.
      const hop = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await vi.advanceTimersByTimeAsync(5000);
      await hop;
      const processedAt = performance.now();
      vad.processFrame(segment);
      expect(processedAt - ingress).toBeGreaterThanOrEqual(5000);
      expect(classifications[0].capturedAt).toBe(ingress);
      expect(classifications[0].capturedAt).not.toBe(processedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});
