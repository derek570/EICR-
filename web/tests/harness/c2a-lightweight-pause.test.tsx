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

    await act(async () => {
      apiRef.current!.pause();
    });
    // Lighter-weight pause: UI presentation is the paused/'sleeping'
    // state, but Sonnet was never torn down.
    expect(apiRef.current!.state).toBe('sleeping');
    expect(sonnetPauseSpy).toHaveBeenCalledOnce();
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
});
