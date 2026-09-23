/**
 * PLAN-D D7 — web's post-TTS holding buffer, through the REAL
 * RecordingProvider: the production `onSamples` path, the REAL registered
 * TTS lifecycle observer (fired through `__ttsLifecycleObserverForTests`,
 * the seam PLAN-C added because the harness players replace the audio
 * backend that normally fires it) and the real post-playback timer.
 *
 * Acceptance 15 (i)–(vii), and Acceptance 3's after-playback half: a resume
 * phrase beginning at actual audio-end is held, replayed and DOES resume.
 * (vi) is the whole file run twice — with and without a voice pause — since
 * D7 is not pause machinery.
 *
 * Baseline red (Acceptance 3 web half, 15(ii)): this file run against the
 * pre-D7 build fails the replay assertions — the held frames were dropped.
 * Evidence: PLAN-D-ep-evidence/web-baseline-red.md.
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
import {
  __resetModeStatusCuesForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __ttsLifecycleObserverForTests,
  setConfirmationModeEnabled,
} from '@/lib/recording/tts';
import { floatToInt16Pcm } from '@/lib/recording/capture-tagging';
import { CaptureWallClock } from '@/lib/recording/capture-wall-clock';
import { UplinkLossLedger } from '@/lib/recording/uplink-loss-ledger';
import type { MicCaptureOptions } from '@/lib/recording/mic-capture';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BLOCK = 1280; // 80 ms at 16 kHz
const GATE_DELAY_MS = 500;

function makeJob(): JobDetail {
  return {
    id: 'job_pland_d7',
    job_id: 'job_pland_d7',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Hold Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [{ id: 'row-1', circuit_ref: '1', designation: 'Sockets' }],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  apiRef.current = useRecording();
  return null;
}

/** A distinguishable voiced block: a sine whose amplitude encodes `id`. */
function block(id: number): Float32Array {
  const out = new Float32Array(BLOCK);
  const amp = 0.1 + (id % 8) * 0.05;
  for (let i = 0; i < BLOCK; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 16000);
  return out;
}

describe.each([
  ['not voice-paused', false],
  ['voice-paused (15(vi): identical)', true],
])('PLAN-D D7 — post-TTS hold (%s)', (_label, paused) => {
  let container: HTMLDivElement;
  let root: Root;
  let clock = 0;
  let onSamples: MicCaptureOptions['onSamples'] | undefined;

  beforeEach(() => {
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true);
    clock = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const harness = buildHarnessServices();
    harness.services.micCaptureFactory = async (opts) => {
      onSamples = opts.onSamples;
      return { sampleRate: 16000, stop: () => {} };
    };
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
    const api = () => apiRef.current!;
    if (paused) {
      await act(async () => {
        harness.refs.deepgram!.emitEndOfTurn('CertMate, pause.');
      });
      expect(api().voicePaused).toBe(true);
    }
    const observer = __ttsLifecycleObserverForTests();
    expect(observer).toBeTypeOf('function');
    return { harness, api, observer: observer! };
  }

  const feed = async (samples: Float32Array) => {
    await act(async () => {
      onSamples!(samples);
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };
  const fire = async (observer: (e: 'start' | 'end') => void, e: 'start' | 'end') => {
    await act(async () => {
      observer(e);
    });
  };
  const diags = (h: ReturnType<typeof buildHarnessServices>, category: string) =>
    h.diagnostics.filter((d) => d.category === category);

  it('15(i)+(iii)+(vii) — held blocks are replayed with their own stamps, in capture order', async () => {
    const markSpy = vi.spyOn(CaptureWallClock.prototype, 'markDiscontinuity');
    const observeSpy = vi.spyOn(CaptureWallClock.prototype, 'observe');
    const { harness, observer } = await mount();
    const dg = harness.refs.deepgram!;
    await fire(observer, 'start');
    expect(diags(harness, 'tts_pcm_gate_engaged').length).toBeGreaterThan(0);
    const sentBefore = dg.sentTaggedSegments.length;

    // (vii) During playback: neither held nor sent.
    clock += 40;
    await feed(block(1));
    await fire(observer, 'end');
    // Inside the post-playback window: HELD, not yet sent.
    clock += 100;
    const stampB = clock;
    const b = block(2);
    await feed(b);
    clock += 80;
    const stampC = clock;
    const c = block(3);
    await feed(c);
    expect(dg.sentTaggedSegments.length).toBe(sentBefore);

    const marksBefore = markSpy.mock.calls.length;
    await advance(GATE_DELAY_MS);
    const replayed = dg.sentTaggedSegments.slice(sentBefore);
    expect(replayed.map((s) => s.capturedAt)).toEqual([stampB, stampC]);
    expect(Array.from(replayed[0].samples)).toEqual(Array.from(floatToInt16Pcm(b)));
    expect(Array.from(replayed[1].samples)).toEqual(Array.from(floatToInt16Pcm(c)));
    // The during-playback block never reached the socket.
    const blockOneAmp = floatToInt16Pcm(block(1));
    expect(replayed.some((s) => s.samples[5] === blockOneAmp[5] && s.capturedAt === 1_040)).toBe(
      false
    );
    const released = diags(harness, 'tts_pcm_gate_released').at(-1)!;
    expect(released.payload).toEqual({ delayMs: GATE_DELAY_MS });

    // The gate is released: the next live block streams at once.
    clock += 600;
    await feed(block(4));
    const live = dg.sentTaggedSegments.at(-1)!;
    expect(live.capturedAt).toBe(clock);
    // (iii) Capture order: held ranges strictly precede the first live one.
    expect(replayed[0].captureSampleRange.end).toBeLessThanOrEqual(
      replayed[1].captureSampleRange.start
    );
    expect(replayed[1].captureSampleRange.end).toBeLessThanOrEqual(live.captureSampleRange.start);
    // markDiscontinuity ran before the first held block was observed.
    expect(markSpy.mock.calls.length).toBeGreaterThan(marksBefore);
    const markOrder = markSpy.mock.invocationCallOrder[marksBefore];
    const heldObserve = observeSpy.mock.calls.findIndex(
      (args) => args[0] === replayed[0].captureSampleRange.start
    );
    expect(heldObserve).toBeGreaterThan(-1);
    expect(observeSpy.mock.invocationCallOrder[heldObserve]).toBeGreaterThan(markOrder);
  });

  it('15(iv) — a late timer holds everything, drops nothing, arms nothing, then drains it all', async () => {
    const { harness, observer } = await mount();
    const dg = harness.refs.deepgram!;
    await fire(observer, 'start');
    await fire(observer, 'end');
    const timersAfterArm = vi.getTimerCount();
    const sentBefore = dg.sentTaggedSegments.length;
    const stamps: number[] = [];
    // Blocks keep arriving for 2.5 s of capture time while the timer has
    // not fired (a stalled event loop): all are held.
    for (let i = 0; i < 32; i++) {
      clock += 80;
      stamps.push(clock);
      await feed(block(i));
    }
    expect(clock - stamps[0]).toBeGreaterThanOrEqual(2_480);
    expect(dg.sentTaggedSegments.length).toBe(sentBefore);
    expect(vi.getTimerCount()).toBe(timersAfterArm);
    expect(diags(harness, 'voice_pause_hold_overflow')).toHaveLength(0);
    await advance(GATE_DELAY_MS);
    const drained = dg.sentTaggedSegments.slice(sentBefore);
    expect(drained.map((s) => s.capturedAt)).toEqual(stamps);
    expect(diags(harness, 'tts_pcm_gate_released').at(-1)!.payload).toEqual({
      delayMs: GATE_DELAY_MS,
    });
  });

  it('15(v) — a new playback start cancels the hold and charges every held sample to the ledger', async () => {
    const dropped = vi.spyOn(UplinkLossLedger.prototype, 'recordDropped');
    const { harness, observer } = await mount();
    const dg = harness.refs.deepgram!;
    await fire(observer, 'start');
    await fire(observer, 'end');
    const sentBefore = dg.sentTaggedSegments.length;
    const droppedBefore = dropped.mock.calls.length;
    clock += 60;
    await feed(block(5));
    clock += 80;
    await feed(block(6));
    await fire(observer, 'start');
    expect(diags(harness, 'voice_pause_hold_cancelled').at(-1)!.payload).toEqual({ blocks: 2 });
    const charged = dropped.mock.calls
      .slice(droppedBefore)
      .reduce((n, [input]) => n + input.samples.length, 0);
    expect(charged).toBe(2 * BLOCK);
    await fire(observer, 'end');
    await advance(GATE_DELAY_MS);
    expect(dg.sentTaggedSegments.length).toBe(sentBefore);
  });

  it('Acceptance 3 (web half) — a phrase over the cue is not heard; one at audio-end is held, replayed and heard', async () => {
    const { harness, api, observer } = await mount();
    const dg = harness.refs.deepgram!;
    // Enter the pause if this pass did not already (the cue is what the
    // inspector is answering).
    if (!api().voicePaused) {
      await act(async () => {
        dg.emitEndOfTurn('CertMate, pause.');
      });
    }
    expect(api().voicePaused).toBe(true);
    // The cue plays: the mic gate engages; a reply spoken OVER it never
    // reaches the socket.
    await fire(observer, 'start');
    const sentBefore = dg.sentTaggedSegments.length;
    clock += 200;
    await feed(block(7));
    expect(dg.sentTaggedSegments.length).toBe(sentBefore);
    // The reply begins at actual audio-end.
    await fire(observer, 'end');
    const phraseStamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      clock += 80;
      phraseStamps.push(clock);
      await feed(block(10 + i));
    }
    await advance(GATE_DELAY_MS);
    // Held frames are REPLAYED, not dropped — the leading syllables (the
    // brand word) reach Deepgram.
    expect(dg.sentTaggedSegments.slice(sentBefore).map((s) => s.capturedAt)).toEqual(phraseStamps);
    // Deepgram's final for that audio arrives and resumes.
    await act(async () => {
      dg.emitEndOfTurn('CertMate, carry on.');
    });
    expect(api().voicePaused).toBe(false);
    expect(diags(harness, 'voice_pause_resumed').map((d) => d.payload.via)).toEqual(['phrase']);
  });
});
