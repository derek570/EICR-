/**
 * PLAN-C — the MANDATORY web pause-overlap integration test, through the
 * REAL TTS gate.
 *
 * The unit tests call `discardPendingOnset()` on a standalone probe, which
 * proves the probe honours a discard but NOT that production performs one.
 * Review caught that gap: deleting the call at the TTS-start site, or moving
 * it after `pause()`, would leave every unit test green while restoring the
 * reported bug.
 *
 * This test mounts the REAL `RecordingProvider`, drives a REAL `start()`,
 * arms a REAL probe onset by feeding a loud tone through the production
 * `onSamples` path (mic → resample → capture tagging → shared VAD → probe),
 * then fires the REAL registered TTS lifecycle observer and asserts the
 * end-to-end symptom is gone: the poor-signal advisory is never spoken.
 *
 * It is built to FAIL if the production discard is removed. Three genuinely
 * slow samples are banked first, so the pause-straddling fourth is the one
 * that would cross `minSamples` and arm — exactly the shape of the reported
 * session, where roughly every other sample was poisoned by a read-back.
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
  POOR_SIGNAL_ADVISORY_TEXT,
  setConfirmationModeEnabled,
  __ttsLifecycleObserverForTests,
} from '@/lib/recording/tts';
import type { MicCaptureOptions } from '@/lib/recording/mic-capture';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(): JobDetail {
  return {
    id: 'job_harness_planc',
    job_id: 'job_harness_planc',
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
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  apiRef.current = useRecording();
  return null;
}

/** 80 ms of a loud 440 Hz tone at 48 kHz — above the VAD's RMS threshold,
 *  so feeding it raises a real onset transition. */
function loudTone48k(): Float32Array {
  const n = 3840;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  return out;
}

/** Silence — keeps the detector's speaking state falling back between
 *  utterances so the next tone is a fresh ONSET rather than a continuation. */
function silence48k(): Float32Array {
  return new Float32Array(3840);
}

describe('PLAN-C — the TTS gate discards the pending probe onset (mounted RecordingProvider)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let clock = 0;

  beforeEach(() => {
    resetTtsQueue();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true);
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
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

  it('a read-back straddling an onset never arms the advisory, and a genuinely slow link still does', async () => {
    const harness = buildHarnessServices();
    let onSamples: MicCaptureOptions['onSamples'] | undefined;
    harness.services.micCaptureFactory = async (opts) => {
      onSamples = opts.onSamples;
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
    expect(onSamples).toBeTypeOf('function');
    const dg = harness.refs.deepgram!;

    const feedTone = async () => {
      await act(async () => {
        onSamples!(loudTone48k(), 48000);
      });
    };
    const feedSilence = async () => {
      await act(async () => {
        onSamples!(silence48k(), 48000);
      });
    };
    /** Enough silence for the VAD's 500 ms hold to actually fire its
     *  `silence` transition, so the NEXT tone is a fresh ONSET rather than a
     *  continuation of the same speaking run. Eight 80 ms frames. */
    const settleSilence = async () => {
      for (let i = 0; i < 8; i++) await feedSilence();
    };
    const emitInterim = async (text: string) => {
      await act(async () => {
        dg.emitInterim(text);
      });
    };
    // Ends the Deepgram turn, which is what clears the provider's
    // `isInspectorSpeaking` flag — one of the three terms in the FIFO's
    // last-mile deferral gate.
    const endTurn = async (text: string) => {
      await act(async () => {
        dg.emitEndOfTurn(text);
      });
    };

    // Three genuinely slow observed samples: onset, 2s of clock, interim,
    // then the turn ends. Under minSamples=4 this cannot arm on its own.
    for (let i = 0; i < 3; i++) {
      await feedTone();
      clock += 2000;
      await emitInterim(`reading ${i}`);
      clock += 500;
      await settleSilence();
      await endTurn(`reading ${i}`);
      clock += 500;
    }
    expect(spokenAdvisories()).toBe(0);

    // The fourth onset — armed just BEFORE a read-back starts. Silence
    // follows, as it does in production: the inspector stops speaking, and
    // only then does the read-back begin. (Silence does not clear the
    // pending onset — only an interim, a reset or a discard does — and it
    // lets the last-mile local-speaking gate release the clip.)
    await feedTone();
    clock += 200;
    // Enough silence, and enough elapsed time, for the last-mile
    // local-speaking gate to release the clip (the raw VAD read expires
    // 2.5 s after onset unless Deepgram confirms speech — the 2026-08-29
    // time-bounded gate). This is the ordinary production shape: the
    // inspector stops talking and the read-back follows.
    await settleSilence();
    clock += 2600;
    // No utterance-end for THIS onset: it stays pending, which is exactly
    // the shape the discard exists for. The raw-VAD half of the gate has
    // now expired (>2.5 s since onset), so the queued read-back is allowed
    // to play over it — the 2026-08-29 time-bounded gate, and the reason
    // this door is reachable at all.

    // Fire the REAL observer `RecordingProvider` registered — the same
    // function production playback calls. Only the audio backend is faked:
    // an injected harness player replaces `playConfirmationHead` wholesale,
    // which is why no harness test could reach this branch before.
    const observer = __ttsLifecycleObserverForTests();
    expect(observer, 'RecordingProvider must register a TTS lifecycle observer').toBeTypeOf(
      'function'
    );

    // ORDERING PROBE. The production branch must discard the pending onset
    // BEFORE it pauses Deepgram. Delivering an interim at the instant
    // `pause()` runs decides that: if the discard already happened there is
    // nothing to resolve, and if `pause()` ran first the pre-pause onset is
    // still pending and this interim banks it as the fourth slow sample —
    // arming the advisory and failing the assertion below.
    const realPause = dg.pause.bind(dg);
    let pauseCalls = 0;
    dg.pause = () => {
      pauseCalls += 1;
      dg.emitInterim('interim delivered exactly as the uplink pauses');
      realPause();
    };
    await act(async () => {
      observer!('start');
    });
    expect(pauseCalls, 'the TTS-start branch must pause the uplink').toBe(1);
    dg.pause = realPause;

    // A long read-back plus the inspector's think time.
    clock += 12000;
    await act(async () => {
      observer!('end');
    });
    // The provider resumes ~500ms after TTS end.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    clock += 600;

    // The interim that follows the read-back. WITHOUT the discard this
    // resolves the pre-pause onset with ~12.8s of elapsed time, making four
    // slow observed samples and arming the advisory.
    await emitInterim('and the next one');

    expect(spokenAdvisories(), 'a read-back must never be charged as network latency').toBe(0);

    // The guard against over-correcting: a genuinely slow link, with no
    // read-back anywhere near it, must still warn.
    for (let i = 0; i < 4; i++) {
      await feedTone();
      clock += 2400;
      await emitInterim(`slow ${i}`);
      clock += 500;
      await settleSilence();
      await endTurn(`slow ${i}`);
      clock += 500;
    }
    expect(spokenAdvisories(), 'a real slow link must still warn').toBeGreaterThan(0);

    function spokenAdvisories(): number {
      return harness.tts.played.filter((p) => p.text === POOR_SIGNAL_ADVISORY_TEXT).length;
    }
  });
});
