import { describe, it, expect } from 'vitest';
import {
  VoicedActivityDetector,
  classifyPcmEnergy,
  VAD_ENERGY_RMS_THRESHOLD,
  VAD_SILENCE_HOLD_SAMPLES,
} from '@/lib/recording/voiced-activity';

function loudFrame(n: number): Int16Array {
  const arr = new Int16Array(n);
  for (let i = 0; i < n; i++) arr[i] = i % 2 === 0 ? 8000 : -8000;
  return arr;
}
function silentFrame(n: number): Int16Array {
  return new Int16Array(n);
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
    vad.processFrame(
      loudFrame(320),
      { start: 0, end: 320 },
      { kind: 'preOpen', captureAttemptId: 1 as any }
    );
    expect(transitions).toEqual(['onset']);
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('does not re-fire onset on consecutive voiced frames', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    const scope = { kind: 'preOpen', captureAttemptId: 1 as any } as const;
    vad.processFrame(loudFrame(320), { start: 0, end: 320 }, scope);
    vad.processFrame(loudFrame(320), { start: 320, end: 640 }, scope);
    vad.processFrame(loudFrame(320), { start: 640, end: 960 }, scope);
    expect(transitions).toEqual(['onset']);
  });

  it('debounces silence — a brief sub-threshold gap does not flip to silence', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    const scope = { kind: 'preOpen', captureAttemptId: 1 as any } as const;
    vad.processFrame(loudFrame(320), { start: 0, end: 320 }, scope);
    // A short silent gap well under VAD_SILENCE_HOLD_SAMPLES.
    vad.processFrame(silentFrame(320), { start: 320, end: 640 }, scope);
    expect(transitions).toEqual(['onset']);
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('fires silence only after continuous sub-threshold audio exceeds the hold', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    const scope = { kind: 'preOpen', captureAttemptId: 1 as any } as const;
    vad.processFrame(loudFrame(320), { start: 0, end: 320 }, scope);
    let cursor = 320;
    while (cursor - 320 < VAD_SILENCE_HOLD_SAMPLES) {
      vad.processFrame(silentFrame(320), { start: cursor, end: cursor + 320 }, scope);
      cursor += 320;
    }
    expect(transitions).toEqual(['onset', 'silence']);
    expect(vad.isLocalSpeaking).toBe(false);
  });

  it('is CONTINUOUS across an epoch rotation — reconnect does not reset speaking state', () => {
    const transitions: string[] = [];
    const vad = new VoicedActivityDetector((t) => transitions.push(t.kind));
    vad.processFrame(
      loudFrame(320),
      { start: 0, end: 320 },
      { kind: 'preOpen', captureAttemptId: 1 as any }
    );
    expect(vad.isLocalSpeaking).toBe(true);
    // Simulate a reconnect: a NEW epoch scope, but the detector itself is
    // NOT reset (only `reset()` at session boundaries clears it).
    vad.processFrame(loudFrame(320), { start: 320, end: 640 }, { kind: 'epoch', id: 5 as any });
    expect(transitions).toEqual(['onset']); // no re-fire — state carried through
    expect(vad.isLocalSpeaking).toBe(true);
  });

  it('reset() clears speaking state (session-boundary only)', () => {
    const vad = new VoicedActivityDetector(() => {});
    vad.processFrame(
      loudFrame(320),
      { start: 0, end: 320 },
      { kind: 'preOpen', captureAttemptId: 1 as any }
    );
    expect(vad.isLocalSpeaking).toBe(true);
    vad.reset();
    expect(vad.isLocalSpeaking).toBe(false);
  });

  it('classifySnapshot is stateless and does not affect debouncing', () => {
    const vad = new VoicedActivityDetector(() => {});
    expect(vad.classifySnapshot(loudFrame(320))).toBe(true);
    expect(vad.isLocalSpeaking).toBe(false); // unaffected — no processFrame call
  });
});
