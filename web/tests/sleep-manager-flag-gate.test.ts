/**
 * PLAN-C (feedback id 120) — the `autoSleepEnabled` flag contract on
 * `SleepManager`, per the plan's deterministic test-case list (1), (2),
 * (5). Complements `sleep-manager-vad.test.ts` (wake mechanics) and
 * `harness/c2a-lightweight-pause.test.tsx` (the explicit-pause callers,
 * flag-independent, driven through the full RecordingProvider).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SleepManager, getAutoSleepEnabled } from '@/lib/recording/sleep-manager';

describe('SleepManager — autoSleepEnabled flag gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(1) default OFF — the automatic timer never fires onEnterSleeping, even past 90s of mixed activity', () => {
    const onEnterSleeping = vi.fn();
    const mgr = new SleepManager({ onEnterSleeping });
    mgr.start();

    vi.advanceTimersByTime(90_000);
    expect(onEnterSleeping).not.toHaveBeenCalled();

    // Drive onSpeechActivity / onQuestionAsked / TTS-finish paths and
    // advance again — the automatic state machine stays Active
    // indefinitely regardless of what re-arms the (never-armed) timer.
    mgr.onSpeechActivity();
    mgr.onQuestionAsked();
    mgr.setTtsActive(true);
    mgr.setTtsActive(false);
    vi.advanceTimersByTime(90_000);

    expect(onEnterSleeping).not.toHaveBeenCalled();
    expect(mgr.currentState).toBe('active');
  });

  it('(2) flag ON with a short injected timeout — start() alone fires onEnterSleeping exactly once', () => {
    const onEnterSleeping = vi.fn();
    const mgr = new SleepManager(
      { onEnterSleeping },
      { autoSleepEnabled: true, noTranscriptTimeoutSec: 5 }
    );
    mgr.start();

    vi.advanceTimersByTime(4_999);
    expect(onEnterSleeping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEnterSleeping).toHaveBeenCalledOnce();
    expect(mgr.currentState).toBe('sleeping');
  });

  it('(5) TTS pause/resume remains exercised with the flag off — setTtsActive still suspends/re-arms bookkeeping', () => {
    // Flag OFF means armNoTranscriptTimer() always no-ops, but
    // setTtsActive's own state bookkeeping (isTtsActive) and its
    // sleeping-state defensive force-wake branch are UNCONDITIONAL —
    // they must keep working so tts_echo_pause_begin/end plumbing
    // (a different mechanism sharing this class) is unaffected by C1/C2.
    const onWake = vi.fn();
    const mgr = new SleepManager({ onWake });
    mgr.start();

    // No timer was ever armed (flag off), so suspending/resuming TTS
    // must not throw or misbehave even though there's nothing to clear.
    expect(() => mgr.setTtsActive(true)).not.toThrow();
    expect(() => mgr.setTtsActive(false)).not.toThrow();
    expect(mgr.currentState).toBe('active');
  });

  it('suspendTimer()/resumeTimer() are safe no-ops when the flag is off', () => {
    const onEnterSleeping = vi.fn();
    const mgr = new SleepManager({ onEnterSleeping });
    mgr.start();

    expect(() => mgr.suspendTimer()).not.toThrow();
    expect(() => mgr.resumeTimer()).not.toThrow();
    vi.advanceTimersByTime(120_000);
    expect(onEnterSleeping).not.toHaveBeenCalled();
  });

  it('getAutoSleepEnabled() defaults to false when unset, and reflects an explicit "true"', () => {
    window.localStorage.removeItem('autoSleepEnabled');
    expect(getAutoSleepEnabled()).toBe(false);
    window.localStorage.setItem('autoSleepEnabled', 'true');
    expect(getAutoSleepEnabled()).toBe(true);
    window.localStorage.setItem('autoSleepEnabled', 'false');
    expect(getAutoSleepEnabled()).toBe(false);
    window.localStorage.removeItem('autoSleepEnabled');
  });
});
