/**
 * Pre-recorded tour narration (iOS-parity).
 *
 * The tour plays bundled Archer-voice MP3s (`/tour-audio/tour_step_<n>.mp3`,
 * the iOS `Sources/Resources/TourAudio` files) instead of synthesising the
 * long-form narration live on every run — zero ElevenLabs runtime cost.
 * These tests pin:
 *   - the step → MP3 numbering matches iOS (dashboard 1-2, job 3-11);
 *   - `playTourAudio` requests the right asset, resolves `onEnd` on natural
 *     end, and routes to `onError` (→ Web Speech fallback) on a blocked /
 *     failed / unavailable play so no narration is ever silently lost.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_TOUR_STEPS, JOB_TOUR_STEPS } from '@/lib/tour/steps';
import { playTourAudio, __resetTourAudioForTests } from '@/lib/tour/tour-audio';

describe('tour audioStep → iOS tour_step_<n>.mp3 mapping', () => {
  it('numbers all 11 steps sequentially: dashboard 1-2, job 3-11', () => {
    const all = [...DASHBOARD_TOUR_STEPS, ...JOB_TOUR_STEPS].map((s) => s.audioStep);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('maps the chime step (job-tone) to audioStep 6 — the chime is embedded in that MP3', () => {
    const tone = JOB_TOUR_STEPS.find((s) => s.id === 'job-tone');
    expect(tone?.audioStep).toBe(6);
    // The step is still flagged `chime` so the Web Speech FALLBACK appends
    // the tone; on the bundled-MP3 path the tone is already in the audio
    // and use-tour passes chimeEmbedded=true to avoid double-playing it.
    expect(tone?.chime).toBe(true);
  });
});

describe('playTourAudio', () => {
  const instances: FakeAudio[] = [];

  class FakeAudio {
    src = '';
    currentTime = 0;
    muted = false;
    volume = 1;
    preload = '';
    onended: null | (() => void) = null;
    onerror: null | (() => void) = null;
    playResult: Promise<void> = Promise.resolve();
    constructor() {
      instances.push(this);
    }
    play(): Promise<void> {
      return this.playResult;
    }
    pause(): void {}
    removeAttribute(): void {}
    load(): void {}
  }

  afterEach(() => {
    __resetTourAudioForTests();
    instances.length = 0;
    vi.unstubAllGlobals();
  });

  it('requests the correct MP3 and resolves onEnd when the audio ends', async () => {
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
    const onEnd = vi.fn();
    const onError = vi.fn();
    playTourAudio(6, { onEnd, onError });
    await Promise.resolve();
    const a = instances[0];
    expect(a.src).toContain('/tour-audio/tour_step_6.mp3');
    a.onended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes to onError (→ Web Speech fallback) when play() rejects (autoplay blocked)', async () => {
    class Rejecting extends FakeAudio {
      play(): Promise<void> {
        return Promise.reject(new Error('NotAllowedError'));
      }
    }
    vi.stubGlobal('Audio', Rejecting as unknown as typeof Audio);
    const onEnd = vi.fn();
    const onError = vi.fn();
    playTourAudio(1, { onEnd, onError });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('routes to onError when the audio element errors', async () => {
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
    const onEnd = vi.fn();
    const onError = vi.fn();
    playTourAudio(3, { onEnd, onError });
    await Promise.resolve();
    instances[0].onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('routes to onError when HTMLAudioElement is unavailable', () => {
    vi.stubGlobal('Audio', undefined as unknown as typeof Audio);
    const onEnd = vi.fn();
    const onError = vi.fn();
    playTourAudio(1, { onEnd, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
