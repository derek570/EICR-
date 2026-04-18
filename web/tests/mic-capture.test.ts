/**
 * mic-capture unit test — Wave 3f sub-item 4e.
 *
 * FIX_PLAN §C Phase 4b (P1, line 169) + `~/.claude/rules/mistakes.md`
 * both require `getUserMedia` constraints to use `{ ideal: value }`
 * wrappers for numeric fields. Bare numeric values (e.g. `sampleRate:
 * 16000`) throw `OverconstrainedError` on iOS Safari during the
 * permission prompt, which inspectors experience as a dead Record
 * button — the exception surfaces as "Microphone track ended" or a
 * silent no-op depending on the code path.
 *
 * This test asserts the constraints shape only — it does NOT drive the
 * full mic pipeline (AudioContext / AudioWorklet are non-trivial to
 * mock and out of scope for a guard of this size). The call site in
 * `mic-capture.ts` is the single source of truth for the browser-facing
 * constraints; pinning its shape keeps the iOS Safari fix from silently
 * regressing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startMicCapture } from '@/lib/recording/mic-capture';

type GetUserMediaArgs = MediaStreamConstraints;

function installGetUserMediaSpy(): {
  spy: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const originalMediaDevices = navigator.mediaDevices;
  // jsdom ships without navigator.mediaDevices; assign a fresh object so
  // the test doesn't leak a shim into sibling tests.
  // Reject before any downstream AudioContext / Worklet setup runs so
  // the test doesn't need to stand up the Web Audio stack just to
  // observe the constraints argument. The spy captures the constraints
  // via `mock.calls` — the arg name itself is not referenced.
  const spy = vi.fn(async (): Promise<MediaStream> => {
    throw new Error('STOP_AFTER_GETUSERMEDIA');
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: spy },
  });
  return {
    spy,
    restore: () => {
      if (originalMediaDevices === undefined) {
        // Clean up the shim so other tests see a pristine navigator.
        delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
      } else {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: originalMediaDevices,
        });
      }
    },
  };
}

describe('startMicCapture — getUserMedia constraints', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('wraps sampleRate and channelCount in { ideal: value } objects (iOS Safari)', async () => {
    const handle = installGetUserMediaSpy();
    restore = handle.restore;

    // Catch the sentinel error from the spy; we only care about the
    // constraints argument, not the downstream Web Audio graph.
    await expect(startMicCapture({})).rejects.toThrow('STOP_AFTER_GETUSERMEDIA');

    expect(handle.spy).toHaveBeenCalledTimes(1);
    const constraints = handle.spy.mock.calls[0][0] as GetUserMediaArgs;

    // Audio key is present and an object (not `true` / `false`).
    expect(constraints.audio).toBeTypeOf('object');
    const audio = constraints.audio as MediaTrackConstraints;

    // Key requirement: sampleRate / channelCount are `{ ideal: value }`
    // wrappers, not bare numbers. iOS Safari throws
    // `OverconstrainedError` on bare values during the permission
    // prompt; `{ ideal }` lets the UA pick the closest match without
    // rejecting.
    expect(audio.sampleRate).toEqual({ ideal: 16000 });
    expect(audio.channelCount).toEqual({ ideal: 1 });

    // Booleans are fine bare — only numeric range fields trip the iOS
    // OverconstrainedError path. Pin the feature flags too so a future
    // refactor can't silently disable them.
    expect(audio.echoCancellation).toBe(true);
    expect(audio.noiseSuppression).toBe(true);
    expect(audio.autoGainControl).toBe(true);
  });
});
