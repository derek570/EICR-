/**
 * PLAN-E1B2 item 3 — the EXECUTABLE production-wiring regression for
 * `capturedAt` (the plan's round-5/round-7 test requirement), replacing the
 * earlier source-regex-only coverage in `tests/capture-tagging.test.ts`
 * (kept as a secondary lock).
 *
 * Mounts the REAL `RecordingProvider` via the B0 harness recipe and drives
 * a REAL `start()`. The `micCaptureFactory` seam is overridden to capture
 * the production `onSamples` callback so the test can invoke it with real
 * samples; `performance.now` is stubbed as a monotonically advancing
 * counter so every clock read after callback entry is strictly later than
 * the first one. The fake mic reports 48 kHz so `resampleTo16k` genuinely
 * runs (and reads nothing from the clock, but everything downstream —
 * `lastAudioSendMs`, `sendSamples`' own default — would).
 *
 * Assertion: the tagged segment that reaches `sendTaggedAudio` carries the
 * FIRST clock value read inside the callback — i.e. stamped before the
 * resample and before any later read — never a later one.
 *
 * Fallback branch (`sessionUplinkContextRef.current === null` →
 * `sendSamples(samples16k, capturedAt)`): that branch is unreachable after
 * `start()` by construction (the ref is populated before the mic pipeline
 * begins) and the provider exposes no seam to null it, so its MECHANISM is
 * proven directly instead — `DeepgramService.sendSamples` honours a passed
 * `capturedAt` over its own later clock read (see the second test).
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
import { DeepgramService, type DeepgramCallbacks } from '@/lib/recording/deepgram-service';
import type { MicCaptureOptions } from '@/lib/recording/mic-capture';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(): JobDetail {
  return {
    id: 'job_harness_e1b2',
    job_id: 'job_harness_e1b2',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [{ id: 'row-1', circuit_ref: '1', designation: 'Lighting' }],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

/** 80 ms of a loud 440 Hz tone at 48 kHz (3,840 samples → 1,280 at 16 kHz). */
function loudTone48k(): Float32Array {
  const n = 3840;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  return out;
}

describe('PLAN-E1B2 item 3 — capturedAt is stamped at onSamples entry, before resampling (mounted RecordingProvider)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clock = 0;

  beforeEach(() => {
    resetTtsQueue();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true);
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the segment handed to sendTaggedAudio carries the FIRST clock read inside onSamples', async () => {
    const harness = buildHarnessServices();
    let capturedOnSamples: MicCaptureOptions['onSamples'] | undefined;
    harness.services.micCaptureFactory = async (opts) => {
      capturedOnSamples = opts.onSamples;
      return { sampleRate: 48000, stop: () => {} };
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
    expect(apiRef.current!.state).toBe('active');
    expect(capturedOnSamples).toBeTypeOf('function');
    const dg = harness.refs.deepgram!;
    expect(dg.sentTaggedSegments).toHaveLength(0);

    // Instrument the INPUT: the first numeric-index read of the 48 kHz
    // samples (which only resampleTo16k performs) records the clock. A stamp
    // taken before resampling is strictly EARLIER than that read; a stamp
    // moved after resampling would be strictly later. This is independent
    // of how many other clock reads act()/the pipeline make.
    let firstSampleReadAt: number | null = null;
    const raw = loudTone48k();
    const instrumented = new Proxy(raw, {
      get(target, prop) {
        if (firstSampleReadAt === null && typeof prop === 'string' && /^\d+$/.test(prop)) {
          firstSampleReadAt = performance.now();
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Float32Array;
    const clockBeforeCallback = clock;
    await act(async () => {
      capturedOnSamples!(instrumented);
    });

    expect(dg.sentTaggedSegments).toHaveLength(1);
    const seg = dg.sentTaggedSegments[0];
    // Resample really ran (48 kHz → 16 kHz) and read the input.
    expect(seg.samples.length).toBe(1280);
    expect(firstSampleReadAt).not.toBeNull();
    // The stamp precedes the first sample read (i.e. precedes resampling)...
    expect(seg.capturedAt).toBeGreaterThan(clockBeforeCallback);
    expect(seg.capturedAt).toBeLessThan(firstSampleReadAt!);
    // ...and the pipeline DID read the clock again later (lastAudioSendMs
    // etc.), proving the stamp was not simply "the latest value".
    expect(clock).toBeGreaterThan(seg.capturedAt);
  });

  it('DeepgramService.sendSamples honours a caller-supplied capturedAt over its own later clock read (fallback-branch mechanism)', () => {
    const cbs: DeepgramCallbacks = {
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onUtteranceEnd: vi.fn(),
      onSpeechStarted: vi.fn(),
      onError: vi.fn(),
    };
    const service = new DeepgramService(cbs, undefined, 'flux');
    const ingress = performance.now(); // e.g. 100
    // Several later clock reads happen before the fallback call is reached.
    performance.now();
    performance.now();
    const seg = service.sendSamples(new Float32Array(320).fill(0.1), ingress);
    expect(seg).not.toBeNull();
    expect(seg!.capturedAt).toBe(ingress);
    // And WITHOUT a caller value it falls back to its own (later) read —
    // the exact difference the production fallback branch exists to avoid.
    const seg2 = service.sendSamples(new Float32Array(320).fill(0.1));
    expect(seg2!.capturedAt).toBeGreaterThan(ingress);
  });
});
