/**
 * SleepManager VAD wake gate — T20 Silero ONNX path.
 *
 * The handoff calls for a regression that pins:
 *   - 12 consecutive ≥0.80 scores while sleeping → wake fires.
 *   - 11 consecutive then a sub-threshold → counter resets, no wake.
 *   - The 2-second post-sleep cooldown suppresses wake even if every
 *     score is 1.0.
 *   - processVadFrame is a no-op while active (otherwise inference
 *     during normal recording would burn cycles for nothing).
 *
 * The RMS path (`processAudioLevel`) keeps its existing behaviour;
 * the new path mirrors it almost exactly but compares against
 * `vadWakeThreshold` (0.80, iOS canon) instead of `wakeRmsThreshold`
 * (0.02). Both share the consecutive-frame counter so they cannot
 * race — but the recording-context.tsx caller picks ONE per session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SleepManager } from '@/lib/recording/sleep-manager';

describe('SleepManager.processVadFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not wake while active', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();

    for (let i = 0; i < 50; i++) mgr.processVadFrame(1.0);

    expect(onWake).not.toHaveBeenCalled();
    expect(mgr.currentState).toBe('active');
  });

  it('wakes after exactly 12 consecutive ≥0.80 frames while sleeping', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();
    mgr.enterSleeping();
    // Burn the 2s post-sleep cooldown.
    vi.advanceTimersByTime(2_001);

    // 11 super-threshold frames — counter at 11 but no wake yet.
    for (let i = 0; i < 11; i++) mgr.processVadFrame(0.95);
    expect(onWake).not.toHaveBeenCalled();
    expect(mgr.currentState).toBe('sleeping');

    // 12th frame should fire onWake('sleeping').
    mgr.processVadFrame(0.95);
    expect(onWake).toHaveBeenCalledOnce();
    expect(onWake).toHaveBeenCalledWith('sleeping');
    expect(mgr.currentState).toBe('active');
  });

  it('resets the counter on a sub-threshold frame', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();
    mgr.enterSleeping();
    vi.advanceTimersByTime(2_001);

    // 11 above-threshold frames — counter at 11.
    for (let i = 0; i < 11; i++) mgr.processVadFrame(0.9);
    // One sub-threshold frame resets the counter to 0.
    mgr.processVadFrame(0.5);
    // Ten more above-threshold — counter at 10, still no wake.
    for (let i = 0; i < 10; i++) mgr.processVadFrame(0.9);

    expect(onWake).not.toHaveBeenCalled();
    expect(mgr.currentState).toBe('sleeping');
  });

  it('suppresses wake during the post-sleep cooldown even with score 1.0', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();
    mgr.enterSleeping();
    // Cooldown is 2s; advance only 500ms — still inside it.
    vi.advanceTimersByTime(500);

    for (let i = 0; i < 50; i++) mgr.processVadFrame(1.0);

    expect(onWake).not.toHaveBeenCalled();
    expect(mgr.currentState).toBe('sleeping');
  });

  it('honours a custom vadWakeThreshold', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake }, { vadWakeThreshold: 0.5 });
    mgr.start();
    mgr.enterSleeping();
    vi.advanceTimersByTime(2_001);

    // 0.6 ≥ custom 0.5 threshold → counts as speech.
    for (let i = 0; i < 12; i++) mgr.processVadFrame(0.6);

    expect(onWake).toHaveBeenCalledOnce();
  });

  it('honours a custom wakeFramesRequired', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake }, { wakeFramesRequired: 3 });
    mgr.start();
    mgr.enterSleeping();
    vi.advanceTimersByTime(2_001);

    mgr.processVadFrame(0.9);
    mgr.processVadFrame(0.9);
    expect(onWake).not.toHaveBeenCalled();
    mgr.processVadFrame(0.9);
    expect(onWake).toHaveBeenCalledOnce();
  });

  it('arms the post-wake-grace timer (90s) on wake', () => {
    const onWake = vi.fn();
    const onEnterSleeping = vi.fn();
    const mgr = new SleepManager({ onWake, onEnterSleeping });
    mgr.start();
    mgr.enterSleeping();
    vi.advanceTimersByTime(2_001);

    for (let i = 0; i < 12; i++) mgr.processVadFrame(0.9);
    expect(onWake).toHaveBeenCalledOnce();
    expect(mgr.currentState).toBe('active');

    // 60s — base no-transcript timeout. Post-wake grace is 90s, so we
    // should still be active here. If grace isn't honoured we'd
    // re-enter sleeping at 60s.
    onEnterSleeping.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(onEnterSleeping).not.toHaveBeenCalled();

    // Cross 90s — grace expires, sleep timer fires.
    vi.advanceTimersByTime(31_000);
    expect(onEnterSleeping).toHaveBeenCalledOnce();
  });
});

describe('SleepManager.processAudioLevel (RMS fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('still wakes via RMS path so a Silero load failure can degrade gracefully', () => {
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();
    mgr.enterSleeping();
    vi.advanceTimersByTime(2_001);

    // 12 frames above the 0.02 RMS threshold.
    for (let i = 0; i < 12; i++) mgr.processAudioLevel(0.05);

    expect(onWake).toHaveBeenCalledOnce();
  });
});
