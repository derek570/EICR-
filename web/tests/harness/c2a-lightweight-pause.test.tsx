/**
 * PLAN-C (feedback id 120) — C2a lighter-weight pause, tested through the
 * REAL RecordingProvider mounted headlessly (B0 harness recipe).
 *
 * Historically `pause()` routed through `SleepManager.enterSleeping()`,
 * which fully tore down BOTH Deepgram AND Sonnet (`teardownSonnet()`
 * nulled the ref moments after `sonnetRef.current?.pause()` ran — the
 * pause() call was a no-op) and forced every resume through the
 * race-prone ring-buffer-replay wake path. C2a replaces this with an
 * iOS-parity lighter-weight pause that keeps the Sonnet session alive.
 *
 * These tests pin the CONTRACT from PLAN-C's Decision section, test case
 * (4) and (4b):
 *   - mic stop/reopen observed (a fresh mic pipeline is requested)
 *   - ONE retained Sonnet instance receiving pause/resume (never rebuilt)
 *   - zero replay send (`sendInt16PCM` never called on lighter-weight
 *     resume, unlike the automatic-timer full-sleep wake path)
 *   - one Deepgram reopen
 *   - the SAME lighter-weight pause path fires in BOTH `autoSleepEnabled`
 *     flag states (the flag gates only the automatic 60s timer)
 *   - (4b) flag ON: pausing past the 60s timeout does not fire an
 *     automatic `enterSleeping` mid-pause (the timer is suspended, not
 *     just irrelevant); resume re-arms it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import { setConfirmationModeEnabled } from '@/lib/recording/tts';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_c2a_1',
    job_id: 'job_c2a_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 C2a Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [],
    ...over,
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;

function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

const AUTO_SLEEP_KEY = 'autoSleepEnabled';

describe('PLAN-C C2a — lighter-weight pause (full RecordingProvider)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true);
    window.localStorage.removeItem(AUTO_SLEEP_KEY);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    window.localStorage.removeItem(AUTO_SLEEP_KEY);
  });

  async function mountAndStart() {
    const harness = buildHarnessServices();
    __setRecordingTestServices(harness.services);
    setDiagnosticTap(harness.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob()}>
          <RecordingProvider>
            <Probe apiRef={apiRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    await act(async () => {
      await apiRef.current!.start();
    });
    return { harness, apiRef };
  }

  it.each([
    ['flag OFF (default)', false],
    ['flag ON', true],
  ])('%s: pause()+resume() takes the SAME lighter-weight path', async (_label, flagOn) => {
    if (flagOn) window.localStorage.setItem(AUTO_SLEEP_KEY, 'true');
    const { harness, apiRef } = await mountAndStart();
    expect(apiRef.current!.state).toBe('active');

    const sonnetBeforePause = harness.refs.sonnet!;
    const sonnetPauseSpy = vi.spyOn(sonnetBeforePause, 'pause');
    const sonnetResumeSpy = vi.spyOn(sonnetBeforePause, 'resume');
    const micStoppedBefore = harness.counts.micStopped;

    await act(async () => {
      apiRef.current!.pause();
    });
    // Lighter-weight pause: UI presentation is the paused/'sleeping'
    // state, but Sonnet was never torn down.
    expect(apiRef.current!.state).toBe('sleeping');
    expect(sonnetPauseSpy).toHaveBeenCalledOnce();
    // Mic stop/reopen observed — Codex diff-review r2: the original
    // handle's own stop() was actually invoked, not merely replaced by a
    // later fresh one (which a leaked handle would also satisfy).
    expect(harness.counts.micStopped - micStoppedBefore).toBe(1);
    // Same Sonnet instance still wired — teardownSonnet() was NOT called
    // (a rebuild would have replaced harness.refs.sonnet with a new
    // FakeSonnetSession via sonnetSessionFactory).
    expect(harness.refs.sonnet).toBe(sonnetBeforePause);

    await act(async () => {
      await apiRef.current!.resume();
    });
    expect(apiRef.current!.state).toBe('active');
    // ONE retained Sonnet instance receiving pause/resume.
    expect(harness.refs.sonnet).toBe(sonnetBeforePause);
    expect(sonnetResumeSpy).toHaveBeenCalledOnce();
    // Deepgram was reopened (a fresh instance was constructed by
    // openDeepgram() — the old one was torn down by pause()).
    expect(harness.refs.deepgram).not.toBeNull();
    // Zero replay: the lighter-weight resume path never calls
    // sendInt16PCM (only the automatic-timer full-sleep wake path does).
    expect(harness.refs.deepgram!.sentInt16PCMBlocks).toBe(0);
  });

  it('flag ON: pausing past the 60s automatic timeout does not enter sleeping mid-pause; resume re-arms the timer', async () => {
    window.localStorage.setItem(AUTO_SLEEP_KEY, 'true');
    vi.useFakeTimers();
    const { harness, apiRef } = await mountAndStart();

    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');

    // Cross the 60s automatic no-transcript timeout WHILE paused. If the
    // timer weren't suspended by the lighter-weight pause, this would
    // fire SleepManager's own `onEnterSleeping` — which tears down
    // Sonnet (teardownSonnet()) and would silently destroy the session
    // the lighter-weight pause deliberately kept alive.
    const sonnetBeforeWait = harness.refs.sonnet!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(apiRef.current!.state).toBe('sleeping'); // unchanged — no auto-wake/re-sleep churn
    expect(harness.refs.sonnet).toBe(sonnetBeforeWait); // still the same instance, never torn down

    await act(async () => {
      await apiRef.current!.resume();
    });
    expect(apiRef.current!.state).toBe('active');
    expect(harness.refs.sonnet).toBe(sonnetBeforeWait);

    // Timer re-armed on resume — advancing another 60s with no transcript
    // activity should now fire the automatic timer-driven sleep entry
    // (flag is ON), proving resume() actually re-armed it rather than
    // leaving it permanently suspended.
    const sonnetBeforeSecondWait = harness.refs.sonnet!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(apiRef.current!.state).toBe('sleeping');
    // The automatic path DOES tear down Sonnet (unlike the lighter-weight
    // pause) — this is the pre-existing flag-ON timer behaviour, left
    // unchanged by C2a. We only assert the re-arm actually fired.
    void sonnetBeforeSecondWait;
  });

  it.each([
    ['flag OFF (default)', false],
    ['flag ON', true],
  ])(
    '%s: start() emits ONE session_start_flags diagnostic with the session-latched value',
    async (_label, flagOn) => {
      if (flagOn) window.localStorage.setItem(AUTO_SLEEP_KEY, 'true');
      setConfirmationModeEnabled(true);
      const { harness } = await mountAndStart();

      const flagEvents = harness.diagnostics.filter((d) => d.category === 'session_start_flags');
      expect(flagEvents).toHaveLength(1);
      expect(flagEvents[0].payload).toEqual({
        auto_sleep_enabled: flagOn,
        confirmations_enabled: true,
      });
    }
  );

  it('Codex diff-review r1 — flag ON: a question arriving over the still-open Sonnet WS mid-pause must not re-arm the automatic timer (sticky suspendTimer regression)', async () => {
    window.localStorage.setItem(AUTO_SLEEP_KEY, 'true');
    vi.useFakeTimers();
    const { harness, apiRef } = await mountAndStart();

    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');
    const sonnetBeforeQuestion = harness.refs.sonnet!;

    // A delayed extraction response arrives over the still-connected
    // Sonnet WS WHILE paused — a question frame calls
    // sleepManagerRef.onQuestionAsked(), which (pre-fix) re-armed the
    // automatic timer even though suspendTimer() had already run.
    await act(async () => {
      harness.refs.sonnet!.emitQuestion({
        question: 'Which circuit was that?',
        question_type: 'clarification',
      });
    });

    // Cross the (now question-answer-extended, then base) timeout
    // windows entirely. If the timer were NOT sticky-suspended, this
    // would fire onEnterSleeping, which tears down Sonnet — destroying
    // the exact session the lighter-weight pause exists to keep alive.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(76_000);
    });
    expect(apiRef.current!.state).toBe('sleeping'); // still lighter-weight-paused, not auto-sleep-churned
    expect(harness.refs.sonnet).toBe(sonnetBeforeQuestion); // never torn down

    await act(async () => {
      await apiRef.current!.resume();
    });
    expect(apiRef.current!.state).toBe('active');
    expect(harness.refs.sonnet).toBe(sonnetBeforeQuestion);
  });

  it('Codex diff-review r1 — pause→stop→fresh session(flag ON)→real automatic sleep→resume takes the FULL wake branch, not a stale lighter-weight one', async () => {
    window.localStorage.setItem(AUTO_SLEEP_KEY, 'true');
    vi.useFakeTimers();
    const { apiRef } = await mountAndStart();

    // Lighter-weight pause sets the discriminator, then the session ends
    // via stop() WITHOUT a resume() ever running to clear it.
    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');
    await act(async () => {
      apiRef.current!.stop();
    });
    expect(apiRef.current!.state).toBe('idle');

    // Fresh session. If the discriminator leaked across the stop(), a
    // REAL automatic-timer sleep in THIS session would incorrectly take
    // the lighter-weight resume branch afterwards (mic-only reopen +
    // `sonnetRef.current?.resume()` on a ref automatic sleep already
    // nulled — a silent no-op leaving the inspector "active" with a dead
    // extraction pipeline).
    const harness2 = buildHarnessServices();
    __setRecordingTestServices(harness2.services);
    setDiagnosticTap(harness2.services.diagnosticTap!);
    await act(async () => {
      await apiRef.current!.start();
    });
    expect(apiRef.current!.state).toBe('active');

    // Cross the 60s automatic no-transcript timeout with no pause() —
    // this is a GENUINE automatic sleep entry (flag ON), which fully
    // tears down Deepgram AND Sonnet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(apiRef.current!.state).toBe('sleeping');

    const sonnetBeforeResume = harness2.refs.sonnet;
    await act(async () => {
      await apiRef.current!.resume();
    });
    expect(apiRef.current!.state).toBe('active');
    // The FULL wake branch rebuilds Sonnet (openSonnet() runs) — a
    // stale lighter-weight branch would instead call
    // `sonnetRef.current?.resume()` on the already-torn-down instance
    // and silently no-op, never reconstructing it.
    expect(harness2.refs.sonnet).not.toBeNull();
    expect(harness2.refs.sonnet).not.toBe(sonnetBeforeResume);
  });

  it('Codex diff-review r1 — a second resume() racing the first is a no-op, not a duplicate mic/Deepgram/Sonnet build', async () => {
    const { harness, apiRef } = await mountAndStart();
    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');

    const deepgramBefore = harness.counts.deepgramConstructed;
    const micBefore = harness.counts.micStarted;
    const sonnetBefore = harness.counts.sonnetConstructed;

    // Two resume() calls back-to-back, neither awaited before the
    // second fires — models a double-tap on the Resume button. Without
    // the resumeInFlightRef guard, both pass the `state === 'sleeping'`
    // check (nothing flips it until the end of the FIRST call) and both
    // build a mic/Deepgram pipeline concurrently.
    await act(async () => {
      const first = apiRef.current!.resume();
      const second = apiRef.current!.resume();
      await Promise.all([first, second]);
    });

    expect(apiRef.current!.state).toBe('active');
    expect(harness.counts.micStarted - micBefore).toBe(1);
    expect(harness.counts.deepgramConstructed - deepgramBefore).toBe(1);
    // Sonnet is never reconstructed on the lighter-weight path at all
    // (retained instance) — confirms neither call took the wrong branch.
    expect(harness.counts.sonnetConstructed - sonnetBefore).toBe(0);
  });

  it('per-fix mini-review — a question deferred mid-utterance is spoken (not stranded) when pause() disconnects Deepgram before onUtteranceEnd can drain it', async () => {
    const { harness, apiRef } = await mountAndStart();
    const dg = harness.refs.deepgram!;

    // Inspector mid-utterance: SpeechStarted + a real interim sets
    // isInspectorSpeakingRef true and cancels the phantom-speech
    // watchdog (the ONLY other path that would eventually drain a
    // deferred prompt on its own).
    await act(async () => {
      dg.emitSpeechStarted();
      dg.emitInterim('circuit four is');
    });

    // A question arrives while the inspector is still talking —
    // shouldDeferPlayback defers it instead of talking over them.
    await act(async () => {
      harness.refs.sonnet!.emitQuestion({
        question: 'Which circuit was that reading for?',
        question_type: 'clarification',
      });
    });
    expect(harness.tts.played).toHaveLength(0); // deferred, not spoken yet

    // The inspector taps Pause BEFORE finishing the utterance — Deepgram
    // disconnects, so the normal drain trigger (onUtteranceEnd) can
    // never arrive for this deferred item.
    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');

    // The deferred question must be spoken now, not stranded until some
    // unrelated future utterance (or forever).
    expect(harness.tts.played.filter((p) => p.kind === 'direct')).toHaveLength(1);
    expect(harness.tts.played[0].text).toContain('Which circuit');
  });

  it('cycle-3 re-review — a stale resume() whose mic-permission await outlives a stop()+fresh-start() must not touch the new session', async () => {
    const harness = buildHarnessServices();
    __setRecordingTestServices(harness.services);
    setDiagnosticTap(harness.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob()}>
          <RecordingProvider>
            <Probe apiRef={apiRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    await act(async () => {
      await apiRef.current!.start();
    });
    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');

    // Make the NEXT mic-permission request (the stale resume()'s) hang
    // indefinitely until the test releases it — models a slow/queued
    // getUserMedia prompt outliving a stop()+fresh-start() cycle.
    let releaseStaleMic: (() => void) | null = null;
    const staleMicGate = new Promise<void>((resolve) => {
      releaseStaleMic = resolve;
    });
    __setRecordingTestServices({
      ...harness.services,
      micCaptureFactory: async (opts) => {
        await staleMicGate;
        return { sampleRate: 16000, stop: () => {} };
      },
    });

    // Fire resume() WITHOUT awaiting it — it is now parked awaiting the
    // gated mic factory. Immediately stop() (legal: statusRef is
    // 'sleeping', not 'idle') and start a FRESH session.
    const staleResume = apiRef.current!.resume();
    await act(async () => {
      apiRef.current!.stop();
    });
    expect(apiRef.current!.state).toBe('idle');

    __setRecordingTestServices(harness.services); // restore the fast mic for the fresh session
    await act(async () => {
      await apiRef.current!.start();
    });
    expect(apiRef.current!.state).toBe('active');
    const freshSonnet = harness.refs.sonnet!;
    const freshDeepgram = harness.refs.deepgram!;
    const deepgramConstructedAfterFreshStart = harness.counts.deepgramConstructed;
    const sonnetConstructedAfterFreshStart = harness.counts.sonnetConstructed;

    // NOW release the stale resume()'s mic-permission await. r2's fix
    // alone stops the orphaned mic handle but still fell through into
    // openDeepgram()/sonnetRef.resume() against whatever is CURRENTLY
    // live — r3 makes beginMicOnly() report the abort so resume() bails
    // immediately instead.
    await act(async () => {
      releaseStaleMic!();
      await staleResume;
    });

    // The fresh session must be completely untouched: same Deepgram/
    // Sonnet instances, no extra constructions, still active.
    expect(apiRef.current!.state).toBe('active');
    expect(harness.refs.sonnet).toBe(freshSonnet);
    expect(harness.refs.deepgram).toBe(freshDeepgram);
    expect(harness.counts.deepgramConstructed).toBe(deepgramConstructedAfterFreshStart);
    expect(harness.counts.sonnetConstructed).toBe(sonnetConstructedAfterFreshStart);
  });

  it('cycle-4 re-review — a fresh session pause()+resume() succeeds WHILE a stale prior-session resume() is still pending (resumeInFlightRef is session-scoped, not a global lock)', async () => {
    const harness = buildHarnessServices();
    __setRecordingTestServices(harness.services);
    setDiagnosticTap(harness.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob()}>
          <RecordingProvider>
            <Probe apiRef={apiRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    await act(async () => {
      await apiRef.current!.start();
    });
    await act(async () => {
      apiRef.current!.pause();
    });

    // Gate the stale (session 1) resume()'s mic factory open indefinitely.
    let releaseStaleMic: (() => void) | null = null;
    const staleMicGate = new Promise<void>((resolve) => {
      releaseStaleMic = resolve;
    });
    __setRecordingTestServices({
      ...harness.services,
      micCaptureFactory: async (opts) => {
        await staleMicGate;
        return { sampleRate: 16000, stop: () => {} };
      },
    });
    const staleResume = apiRef.current!.resume(); // parked — claims resumeInFlightRef for session 1

    await act(async () => {
      apiRef.current!.stop();
    });

    // Session 2: restore the fast mic, start, pause, and resume. Before
    // the r4 fix, resumeInFlightRef was a bare boolean still `true` from
    // session 1's still-pending claim — session 2's resume() would see
    // it and silently no-op, leaving THIS session stuck paused forever.
    __setRecordingTestServices(harness.services);
    await act(async () => {
      await apiRef.current!.start();
    });
    await act(async () => {
      apiRef.current!.pause();
    });
    expect(apiRef.current!.state).toBe('sleeping');
    await act(async () => {
      await apiRef.current!.resume();
    });
    // The fresh session's OWN resume must actually complete — this is
    // the assertion that fails without the session-scoped token.
    expect(apiRef.current!.state).toBe('active');

    // Clean up: release the still-pending stale resume so it doesn't
    // leak into a later test via an unresolved promise.
    await act(async () => {
      releaseStaleMic!();
      await staleResume;
    });
    expect(apiRef.current!.state).toBe('active'); // stale resume's bail didn't disturb session 2
  });
});
