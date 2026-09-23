/**
 * PLAN-D (feedback wave 2026-09-17) — hands-free pause and resume by voice,
 * driven through the REAL RecordingProvider (B0 harness recipe). Only the
 * external effects are fake: the Deepgram socket (a REAL DeepgramService
 * around a captive socket, so Flux frames go through real parsing), the
 * Sonnet socket, the mic and the audio players. The pause boundary, the
 * buffers, the FIFO, the protected cue family, the loss ledger and the
 * diagnostics are production code.
 *
 * Acceptance items covered here (web): 1 (mounted half), 2, 3 (interim +
 * deferral), 4, 5, 6 (web twin), 7, 8, 9, 12 (provider state), 14 (i)–(iv).
 * The D7 audio-window items (3's after-playback half, 15) live in
 * `pland-post-tts-hold.test.tsx`.
 *
 * Every spoken string is read from `config/voice-pause-vectors.json` by key;
 * the strings the route PRODUCES are derived from each entry's `status`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  POOR_SIGNAL_ADVISORY_TEXT,
  UPLINK_LOSS_DISCLOSURE_TEXT,
  __resetModeStatusCuesForTests,
  __resetPoorSignalAdvisoryForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __resetUplinkLossDisclosureForTests,
  setConfirmationModeEnabled,
  speakPoorSignalAdvisory,
} from '@/lib/recording/tts';
import { playVoiceResumeTone } from '@/lib/recording/tones';
import type { MicCaptureOptions } from '@/lib/recording/mic-capture';
import type { QueuePlayControls } from '@/lib/recording/tts-queue';
import { buildHarnessServices } from './fake-services';

// Count resume-tone calls without changing what the tone does.
vi.mock('@/lib/recording/tones', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recording/tones')>();
  return { ...actual, playVoiceResumeTone: vi.fn(actual.playVoiceResumeTone) };
});
const toneSpy = vi.mocked(playVoiceResumeTone);
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface FixtureString {
  text: string;
  status: 'active' | 'retired' | 'approved';
}
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'voice-pause-vectors.json'), 'utf8')
) as {
  vectors: {
    accept_pause: string[];
    accept_resume: string[];
    near_miss: Array<{ text: string; kind: string }>;
  };
  strings: Record<string, FixtureString>;
  timing: { still_paused_cue_throttle_ms: number; reminder_interval_ms: number };
};
const S = (key: string): string => fixture.strings[key].text;
const RETIRED_TEXTS = Object.entries(fixture.strings)
  .filter(([k, v]) => !k.startsWith('$') && v.status === 'retired')
  .map(([, v]) => v.text);
const THROTTLE_MS = fixture.timing.still_paused_cue_throttle_ms;
const REMINDER_MS = fixture.timing.reminder_interval_ms;
/** Past the self-echo window after a phrase-bearing cue ends. */
const SETTLE_MS = 400;

function makeJob(): JobDetail {
  return {
    id: 'job_pland',
    job_id: 'job_pland',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Pause Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [
      { id: 'row-1', circuit_ref: '1', designation: 'Sockets', circuit_designation: 'Sockets' },
      { id: 'row-2', circuit_ref: '2', designation: 'Lights', circuit_designation: 'Lights' },
    ],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern
  apiRef.current = useRecording();
  return null;
}

type Bundle = ReturnType<typeof buildHarnessServices>;

describe('PLAN-D — hands-free voice pause (mounted RecordingProvider)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    __resetModeStatusCuesForTests();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    __resetPoorSignalAdvisoryForTests();
    __resetUplinkLossDisclosureForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
    toneSpy.mockClear();
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
    vi.unstubAllGlobals();
  });

  let onSamples: MicCaptureOptions['onSamples'] | undefined;

  async function mount(
    opts: { sonnet?: 'real-decoder'; deepgram?: 'static' | 'reconnectable' } = {}
  ): Promise<{ harness: Bundle; api: () => RecordingApi }> {
    const harness = buildHarnessServices(opts as { sonnet?: 'fake' }) as Bundle;
    onSamples = undefined;
    harness.services.micCaptureFactory = async (micOpts) => {
      harness.counts.micStarted += 1;
      onSamples = micOpts.onSamples;
      return {
        sampleRate: 16000,
        stop: () => {
          harness.counts.micStopped += 1;
        },
      };
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
    return { harness, api: () => apiRef.current! };
  }

  const final = async (h: Bundle, text: string) => {
    await act(async () => {
      h.refs.deepgram!.emitEndOfTurn(text);
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };
  const diags = (h: Bundle, category: string) =>
    h.diagnostics.filter((d) => d.category === category);
  const played = (h: Bundle) => h.tts.played.map((p) => p.text);
  const count = (list: string[], text: string) => list.filter((t) => t === text).length;
  /** Dispatches that reached the forward gate (sent or gate-blocked). */
  const dispatched = (h: Bundle) =>
    h.diagnostics
      .filter(
        (d) => d.category === 'pipeline_sonnet_send' || d.category === 'transcript_gate_blocked'
      )
      .map((d) => String(d.payload.textPreview));

  /** 80 ms of loud voiced audio through the REAL onSamples path. */
  const feedVoice = async () => {
    const block = new Float32Array(1280);
    for (let i = 0; i < block.length; i++)
      block[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    await act(async () => {
      onSamples?.(block);
    });
  };

  async function enterPause(h: Bundle, api: () => RecordingApi, phrase = 'CertMate, pause.') {
    await final(h, phrase);
    expect(api().voicePaused).toBe(true);
    await advance(SETTLE_MS);
  }

  // ── Acceptance 1 ──────────────────────────────────────────────────────
  describe('Acceptance 1 — commands, near misses and the still-paused cue', () => {
    it('every accepted pause phrase enters and every accepted resume phrase exits', async () => {
      const { harness, api } = await mount();
      const n = Math.min(fixture.vectors.accept_pause.length, fixture.vectors.accept_resume.length);
      for (let i = 0; i < n; i++) {
        await final(harness, fixture.vectors.accept_pause[i]);
        expect(api().voicePaused, fixture.vectors.accept_pause[i]).toBe(true);
        await advance(SETTLE_MS);
        await final(harness, fixture.vectors.accept_resume[i]);
        expect(api().voicePaused, fixture.vectors.accept_resume[i]).toBe(false);
        await advance(SETTLE_MS);
      }
      expect(diags(harness, 'voice_pause_entered')).toHaveLength(n);
      expect(diags(harness, 'voice_pause_resumed')).toHaveLength(n);
      expect(count(played(harness), S('pause_ack'))).toBe(n);
      expect(count(played(harness), S('resume_line'))).toBe(n);
      // The commands themselves are consumed, never forwarded.
      expect(harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
    });

    it('near misses pass through while recording', async () => {
      const { harness, api } = await mount();
      for (const v of fixture.vectors.near_miss) {
        await final(harness, v.text);
        await advance(600);
        expect(api().voicePaused, v.text).toBe(false);
      }
      expect(dispatched(harness)).toHaveLength(fixture.vectors.near_miss.length);
    });

    it('while paused EVERY non-command final requests the cue, throttled to one per 30 s', async () => {
      const { harness } = await mount();
      const h = harness;
      await enterPause(h, () => ({ voicePaused: true }) as RecordingApi);
      const cueCount = () => count(played(h), S('still_paused_cue'));
      // An ordinary dictated reading — first occurrence speaks.
      await final(h, 'Zs on circuit 1 is 0.44');
      expect(cueCount()).toBe(1);
      // An unbranded near miss inside 30 s of that admission — silent.
      await advance(THROTTLE_MS - SETTLE_MS - 1000);
      await final(h, 'carry on to circuit 4');
      expect(cueCount()).toBe(1);
      // A branded near miss with trailing content after 30 s — speaks.
      await advance(1500);
      await final(h, 'certmate carry on, circuit two now');
      expect(cueCount()).toBe(2);
      expect(diags(h, 'voice_pause_drop_count').map((d) => d.payload.count)).toEqual([1, 2, 3]);
      expect(diags(h, 'voice_pause_trailing_content_cue')).toHaveLength(1);
      expect(diags(h, 'voice_pause_resume_tone')).toHaveLength(0);
    });

    it('a resume phrase heard while a phrase-bearing cue plays never resumes', async () => {
      const { harness, api } = await mount();
      // A player that STARTS each clip and holds its end, so the
      // acknowledgement (which contains "CertMate, carry on") is genuinely
      // playing when the echo arrives.
      const ends: Array<() => void> = [];
      harness.services.ttsConfirmationPlayer = (text: string, controls: QueuePlayControls) => {
        controls.ready({
          play: () => {
            harness.tts.played.push({ kind: 'confirmation', text });
            controls.onStart();
            ends.push(controls.onEnd);
          },
          discard: () => {},
        });
      };
      await final(harness, 'CertMate, pause.');
      await advance(2000);
      await final(harness, 'CertMate carry on');
      expect(api().voicePaused).toBe(true);
      expect(toneSpy).not.toHaveBeenCalled();
      // End the acknowledgement and the still-paused cue the echo requested
      // (it contains the phrase too), then wait out the echo window.
      await act(async () => {
        while (ends.length) ends.shift()!();
      });
      await final(harness, 'CertMate carry on');
      expect(api().voicePaused).toBe(true);
      await act(async () => {
        while (ends.length) ends.shift()!();
      });
      await advance(SETTLE_MS);
      await final(harness, 'CertMate carry on');
      expect(api().voicePaused).toBe(false);
      expect(toneSpy).toHaveBeenCalledTimes(1);
    });

    it('no spoken string is ever admitted as a command', async () => {
      const { harness, api } = await mount();
      for (const [key, entry] of Object.entries(fixture.strings)) {
        if (key.startsWith('$')) continue;
        await final(harness, entry.text);
        await advance(600);
        expect(api().voicePaused, key).toBe(false);
      }
      expect(diags(harness, 'voice_pause_entered')).toHaveLength(0);
    });
  });

  // ── Acceptance 2 ──────────────────────────────────────────────────────
  it('Acceptance 2 — input stops at the boundary', async () => {
    const { harness, api } = await mount();
    await enterPause(harness, api);
    const chimes = harness.chimes.count;
    const jobChanges = harness.jobChanges.length;
    const namingArmed = diags(harness, 'pipeline_naming_buffer_armed').length;
    const burstArmed = diags(harness, 'pipeline_burst_buffer_armed').length;
    harness.refs.sonnet!.setInFlightToolCallId('toolu_paused_1');
    const drops = diags(harness, 'voice_pause_drop_count').length;

    for (const text of [
      'Zs on circuit 1 is 0.44',
      'Circuit 2 is',
      'yes',
      'calculate Zs for circuit 1',
    ]) {
      await final(harness, text);
    }
    await advance(10_000);

    expect(harness.chimes.count).toBe(chimes);
    expect(harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
    expect(harness.refs.sonnet!.sentAskAnswers).toHaveLength(0);
    expect(harness.jobChanges.length).toBe(jobChanges);
    expect(diags(harness, 'pipeline_regex_applied')).toHaveLength(0);
    expect(diags(harness, 'local_calculate_forwarded')).toHaveLength(0);
    expect(diags(harness, 'local_calculate_outcome')).toHaveLength(0);
    expect(diags(harness, 'pipeline_naming_buffer_armed')).toHaveLength(namingArmed);
    expect(diags(harness, 'pipeline_burst_buffer_armed')).toHaveLength(burstArmed);
    expect(dispatched(harness)).toHaveLength(0);
    expect(diags(harness, 'voice_pause_drop_count').length - drops).toBe(4);
    expect(api().voicePaused).toBe(true);
  });

  // ── Acceptance 3 (interim + deferral half) ────────────────────────────
  it('Acceptance 3 — interim handling survives; a read-back is deferred, not dropped', async () => {
    const { harness, api } = await mount();
    await enterPause(harness, api);
    await act(async () => {
      harness.refs.deepgram!.emitSpeechStarted();
      harness.refs.deepgram!.emitInterim('so the kitchen is being refitted');
    });
    expect(api().interim).toBe('');
    // Past the phantom-VAD watchdog: the interim cancelled it, so the
    // inspector still counts as speaking and a read-back defers.
    await advance(1500);
    await act(async () => {
      harness.refs.sonnet!.emitExtraction({
        readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.44' }],
        confirmations: [{ field: 'measured_zs_ohm', circuit: 1, text: 'Zs 0.44 on circuit 1' }],
      });
    });
    expect(count(played(harness), 'Zs 0.44 on circuit 1')).toBe(0);
    await final(harness, 'so the kitchen is being refitted');
    expect(count(played(harness), 'Zs 0.44 on circuit 1')).toBe(1);
  });

  // ── Acceptance 4 ──────────────────────────────────────────────────────
  describe('Acceptance 4 — speech is never suppressed by the pause', () => {
    it('every item arriving while paused is spoken once, in order, reported at playback start', async () => {
      const { harness, api } = await mount();
      await final(harness, 'Zs on circuit 1 is 0.44');
      await advance(600);
      expect(harness.chimes.count).toBe(1);
      await final(harness, 'CertMate, pause.');
      expect(api().voicePaused).toBe(true);
      // Each delivery is played and drained before the next arrives (the
      // instant player completes synchronously; the FIFO is idle between).
      await act(async () => {
        harness.refs.sonnet!.emitExtraction({
          readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.44' }],
          confirmations: [{ field: 'measured_zs_ohm', circuit: 1, text: 'Zs 0.44 on circuit 1' }],
        });
      });
      await act(async () => {
        harness.refs.sonnet!.emitVoiceCommandResponse({
          understood: true,
          spoken_response: 'Noted, the kitchen is next.',
        });
      });
      await act(async () => {
        speakPoorSignalAdvisory();
      });
      await act(async () => {
        harness.refs.sonnet!.emitQuestion({
          question: 'Which circuit was that reading for?',
          question_type: 'orphaned',
          tool_call_id: 'toolu_pland_ask',
        });
      });
      await advance(100);
      const spoken = diags(harness, 'voice_pause_speech_spoken').map((d) => [
        d.payload.kind,
        d.payload.text,
      ]);
      expect(spoken).toEqual([
        ['cue', S('pause_ack')],
        ['read_back', 'Zs 0.44 on circuit 1'],
        ['response', 'Noted, the kitchen is next.'],
        ['advisory', POOR_SIGNAL_ADVISORY_TEXT],
        ['ask', 'Which circuit was that reading for?'],
      ]);
      expect(
        diags(harness, 'tts_queue_preempt_flush').filter(
          (d) => (d.payload.discardedCount as number) > 0
        )
      ).toHaveLength(0);
      expect(diags(harness, 'tts_deferred_cleared_by_stop')).toHaveLength(0);
      expect(
        harness.diagnostics.filter((d) =>
          /^voice_pause_(gate_armed|gate_released|held_ask_cleared)$|^stale_direct_dropped$/.test(
            d.category
          )
        )
      ).toHaveLength(0);
    });

    it('an ask pre-empts an owed read-back identically paused and not paused (pre-existing limit)', async () => {
      const discardedFor = async (paused: boolean): Promise<number[]> => {
        const { harness, api } = await mount();
        if (paused) await enterPause(harness, api);
        harness.tts.manual = true;
        const before = diags(harness, 'tts_speak_preempted_confirmation').length;
        await act(async () => {
          harness.refs.sonnet!.emitExtraction({
            readings: [{ circuit: 2, field: 'measured_zs_ohm', value: '0.51' }],
            confirmations: [{ field: 'measured_zs_ohm', circuit: 2, text: 'Zs 0.51 on circuit 2' }],
          });
        });
        await act(async () => {
          harness.refs.sonnet!.emitQuestion({
            question: 'Is that circuit 2?',
            question_type: 'orphaned',
            tool_call_id: 'toolu_pland_preempt',
          });
        });
        const counts = diags(harness, 'tts_speak_preempted_confirmation')
          .slice(before)
          .map((d) => d.payload.discarded_count as number);
        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
        __setRecordingTestServices(null);
        setDiagnosticTap(null);
        resetTtsQueue();
        __resetModeStatusCuesForTests();
        // The first session's ask left a TTS window and fingerprints behind.
        __resetTtsWindowForTests();
        __resetTtsFingerprintsForTests();
        return counts;
      };
      const notPaused = await discardedFor(false);
      const paused = await discardedFor(true);
      expect(notPaused.length).toBeGreaterThan(0);
      expect(notPaused[0]).toBeGreaterThanOrEqual(1);
      expect(paused).toEqual(notPaused);
    });
  });

  // ── Acceptance 5 ──────────────────────────────────────────────────────
  describe('Acceptance 5 — pre-pause buffers are flushed, not lost', () => {
    it('(i) a burst-buffered final 200 ms before the phrase dispatches and is read back', async () => {
      const { harness, api } = await mount();
      await final(harness, 'Zs on circuit 1 is 0.44');
      await advance(200);
      expect(dispatched(harness)).toHaveLength(0);
      await final(harness, 'CertMate, pause.');
      expect(api().voicePaused).toBe(true);
      expect(dispatched(harness)).toEqual(['Zs on circuit 1 is 0.44']);
      await act(async () => {
        harness.refs.sonnet!.emitExtraction({
          readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.44' }],
          confirmations: [{ field: 'measured_zs_ohm', circuit: 1, text: 'Zs 0.44 on circuit 1' }],
        });
      });
      expect(count(played(harness), 'Zs 0.44 on circuit 1')).toBe(1);
    });

    it('(ii)+(iii) a held naming preface dispatches at entry and no timer fires while paused', async () => {
      const { harness, api } = await mount();
      await final(harness, 'Circuit 2 is');
      expect(diags(harness, 'pipeline_naming_buffer_armed')).toHaveLength(1);
      await final(harness, 'CertMate, pause.');
      expect(api().voicePaused).toBe(true);
      expect(dispatched(harness)).toEqual(['Circuit 2 is']);
      await advance(10_000);
      expect(dispatched(harness)).toEqual(['Circuit 2 is']);
      expect(diags(harness, 'pipeline_naming_buffer_timeout')).toHaveLength(0);
      expect(diags(harness, 'pipeline_burst_buffer_timeout')).toHaveLength(0);
    });

    it('(iv) both slots populated: two dispatches in capture order, never concatenated', async () => {
      const { harness, api } = await mount();
      await final(harness, 'Zs on circuit 1 is 0.44');
      await advance(100);
      await final(harness, 'Circuit 3 is');
      expect(diags(harness, 'pipeline_burst_buffer_armed')).toHaveLength(1);
      expect(diags(harness, 'pipeline_naming_buffer_armed')).toHaveLength(1);
      await final(harness, 'CertMate, pause.');
      expect(api().voicePaused).toBe(true);
      expect(dispatched(harness)).toEqual(['Zs on circuit 1 is 0.44', 'Circuit 3 is']);
      expect(diags(harness, 'pipeline_burst_buffer_concat')).toHaveLength(0);
      expect(diags(harness, 'pipeline_naming_buffer_concat')).toHaveLength(0);
      expect(diags(harness, 'pipeline_burst_buffer_armed')).toHaveLength(1);
      await advance(10_000);
      expect(dispatched(harness)).toHaveLength(2);
    });
  });

  // ── Acceptance 6 (web twin) ───────────────────────────────────────────
  it.each([
    ['paused', true],
    ['not paused', false],
  ])(
    'Acceptance 6 (web twin, %s) — no age rule: a read-back deferred 20 s plays once',
    async (_label, paused) => {
      const { harness, api } = await mount();
      if (paused) await enterPause(harness, api);
      await act(async () => {
        harness.refs.deepgram!.emitSpeechStarted();
        harness.refs.deepgram!.emitInterim('the customer is still talking');
      });
      await act(async () => {
        harness.refs.sonnet!.emitExtraction({
          readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.44' }],
          confirmations: [{ field: 'measured_zs_ohm', circuit: 1, text: 'Zs 0.44 on circuit 1' }],
        });
      });
      await advance(20_000);
      expect(count(played(harness), 'Zs 0.44 on circuit 1')).toBe(0);
      await final(harness, 'the customer is still talking');
      expect(count(played(harness), 'Zs 0.44 on circuit 1')).toBe(1);
      expect(diags(harness, 'tts_deferred_dropped')).toHaveLength(0);
    }
  );

  // ── Acceptance 7 ──────────────────────────────────────────────────────
  it('Acceptance 7 — session frames once each; no disconnect, reconnect, epoch change or mic churn', async () => {
    const { harness, api } = await mount({ sonnet: 'real-decoder' });
    const dg = harness.refs.deepgram!;
    const disconnect = vi.spyOn(dg, 'disconnect');
    const epoch = dg.liveEpoch;
    const counts = { ...harness.counts };
    await enterPause(harness, api);
    await final(harness, 'Zs on circuit 1 is 0.44');
    await advance(5_000);
    await final(harness, 'CertMate, carry on.');
    expect(api().voicePaused).toBe(false);
    const sonnet = harness.refs.sonnet as unknown as {
      wireTranscripts: unknown[];
      wireFrames: Array<{ type: string }>;
    };
    void sonnet.wireTranscripts; // the getter collects every frame written so far
    const frames = sonnet.wireFrames.map((f) => f.type);
    expect(frames.filter((t) => t === 'session_pause')).toHaveLength(1);
    expect(frames.filter((t) => t === 'session_resume')).toHaveLength(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(harness.refs.deepgram).toBe(dg);
    expect(dg.liveEpoch).toBe(epoch);
    expect(harness.counts).toEqual(counts);
  });

  it('Acceptance 7 — the button exit still reconnects; stop while paused resets for the next session', async () => {
    const { harness, api } = await mount();
    await act(async () => {
      api().pause();
    });
    const constructed = harness.counts.deepgramConstructed;
    await act(async () => {
      await api().resume();
    });
    expect(harness.counts.deepgramConstructed).toBe(constructed + 1);
    await enterPause(harness, api);
    await act(async () => {
      api().stop();
    });
    expect(api().voicePaused).toBe(false);
    await act(async () => {
      await api().start();
    });
    expect(api().voicePaused).toBe(false);
    const reminders = count(played(harness), S('reminder'));
    await advance(REMINDER_MS * 2);
    expect(count(played(harness), S('reminder'))).toBe(reminders);
    // The throttle stamp was reset too: the first cue of a new pause speaks.
    await enterPause(harness, api);
    const cues = count(played(harness), S('still_paused_cue'));
    await final(harness, 'Zs on circuit 1 is 0.44');
    expect(count(played(harness), S('still_paused_cue'))).toBe(cues + 1);
  });

  // ── Acceptance 8 ──────────────────────────────────────────────────────
  describe('Acceptance 8 — the believed-resumed inspector (ledger cut + the resume line)', () => {
    const lossDisclosed = (h: Bundle) =>
      h.diagnostics.filter(
        (d) =>
          d.category === 'uplink_loss_episode_disclosed' ||
          d.category === 'uplink_loss_episode_disclosure_completed'
      );
    const resumeLineSpoken = (h: Bundle) =>
      diags(h, 'voice_pause_speech_spoken').filter(
        (d) => d.payload.kind === 'cue' && d.payload.text === S('resume_line')
      );

    async function failSocketWhilePaused(h: Bundle, api: () => RecordingApi) {
      await enterPause(h, api);
      const speechBefore = diags(h, 'voice_pause_speech_spoken').length;
      await act(async () => {
        h.refs.deepgram!.emitUnownedClose();
      });
      // The inspector says the phrase, then a reading, into a dead uplink:
      // the tap accepts the voiced audio but no final can arrive.
      for (let i = 0; i < 25; i++) await feedVoice();
      // No final can arrive: nothing resumes, no cue, no tone.
      await advance(REMINDER_MS);
      expect(api().voicePaused).toBe(true);
      expect(diags(h, 'voice_pause_resume_tone')).toHaveLength(0);
      const during = diags(h, 'voice_pause_speech_spoken').slice(speechBefore);
      // The only speech is the reminder, on schedule.
      expect(during.map((d) => d.payload.text)).toEqual([S('reminder')]);
      expect(count(played(h), S('reminder'))).toBe(1);
    }

    function assertOneResume(h: Bundle, via: 'phrase' | 'tap') {
      expect(diags(h, 'voice_pause_resume_tone').map((d) => d.payload.via)).toEqual([via]);
      expect(resumeLineSpoken(h)).toHaveLength(1);
      for (const retired of RETIRED_TEXTS) {
        expect(
          diags(h, 'voice_pause_speech_spoken').filter((d) => d.payload.text === retired)
        ).toHaveLength(0);
        expect(count(played(h), retired)).toBe(0);
      }
      expect(lossDisclosed(h)).toHaveLength(0);
      expect(count(played(h), UPLINK_LOSS_DISCLOSURE_TEXT)).toBe(0);
    }

    it('(a) the socket reopens and the phrase resumes', async () => {
      const { harness, api } = await mount({ deepgram: 'reconnectable' });
      await failSocketWhilePaused(harness, api);
      // Let the real service's backoff reopen the socket (a new epoch).
      await advance(30_000);
      await act(async () => {
        await Promise.resolve();
      });
      // A genuinely new socket carries the phrase.
      expect(harness.refs.deepgram!.sockets.length).toBeGreaterThan(1);
      expect(harness.refs.deepgram!.connectionState).toBe('connected');
      await final(harness, 'CertMate, carry on.');
      expect(api().voicePaused).toBe(false);
      assertOneResume(harness, 'phrase');
    });

    it('(b) Resume is tapped with the socket still down', async () => {
      const { harness, api } = await mount();
      await failSocketWhilePaused(harness, api);
      await act(async () => {
        await api().resume();
      });
      expect(api().voicePaused).toBe(false);
      assertOneResume(harness, 'tap');
    });

    it.each([
      ['phrase then tap', 'phrase'],
      ['tap then phrase', 'tap'],
    ] as const)('same tick (%s): one tone and one line', async (_label, first) => {
      const { harness, api } = await mount();
      await enterPause(harness, api);
      await act(async () => {
        if (first === 'phrase') {
          harness.refs.deepgram!.emitEndOfTurn('CertMate, carry on.');
          void api().resume();
        } else {
          void api().resume();
          harness.refs.deepgram!.emitEndOfTurn('CertMate, carry on.');
        }
      });
      expect(api().voicePaused).toBe(false);
      assertOneResume(harness, first);
      expect(harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
    });
  });

  // ── Acceptance 9 ──────────────────────────────────────────────────────
  describe('Acceptance 9 — timers', () => {
    it('the reminder recurs at 15, 30 and 45 minutes of a 50-minute pause', async () => {
      const { harness, api } = await mount();
      await enterPause(harness, api);
      await advance(50 * 60 * 1000 - SETTLE_MS);
      expect(count(played(harness), S('reminder'))).toBe(3);
    });

    it.each(['phrase', 'tap', 'stop', 'start'] as const)(
      'the reminder is cancelled on %s with nothing further scheduled',
      async (how) => {
        const { harness, api } = await mount();
        await enterPause(harness, api);
        if (how === 'phrase') await final(harness, 'CertMate, carry on.');
        if (how === 'tap') {
          await act(async () => {
            await api().resume();
          });
        }
        if (how === 'stop' || how === 'start') {
          await act(async () => {
            api().stop();
          });
        }
        if (how === 'start') {
          await act(async () => {
            await api().start();
          });
        }
        await advance(REMINDER_MS * 3);
        expect(count(played(harness), S('reminder'))).toBe(0);
      }
    );

    it('server speech after an ask times out plays while paused; the state stays paused', async () => {
      const { harness, api } = await mount();
      await enterPause(harness, api);
      await act(async () => {
        harness.refs.sonnet!.emitQuestion({
          question: 'What is the Ze?',
          question_type: 'orphaned',
          tool_call_id: 'toolu_pland_timeout',
        });
      });
      await advance(45_000);
      await act(async () => {
        harness.refs.sonnet!.emitVoiceCommandResponse({
          understood: true,
          spoken_response: 'No answer heard, moving on.',
        });
      });
      expect(count(played(harness), 'No answer heard, moving on.')).toBe(1);
      expect(api().voicePaused).toBe(true);
      // The first post-resume final is forwarded normally (lazy expiry is
      // the backend's; the client just resumes forwarding).
      await final(harness, 'CertMate, carry on.');
      await advance(SETTLE_MS);
      await final(harness, 'Zs on circuit 2 is 0.51');
      await advance(600);
      expect(harness.refs.sonnet!.sentTranscripts.map((t) => t.text)).toEqual([
        'Zs on circuit 2 is 0.51',
      ]);
    });
  });

  // ── Acceptance 12 (provider half) ─────────────────────────────────────
  it('Acceptance 12 — voicePaused is exposed and the tap resumes through the same exit', async () => {
    const { harness, api } = await mount();
    await enterPause(harness, api);
    expect(api().state).toBe('active');
    await act(async () => {
      await api().resume();
    });
    expect(api().voicePaused).toBe(false);
    expect(diags(harness, 'voice_pause_resumed').map((d) => d.payload.via)).toEqual(['tap']);
  });

  // ── Acceptance 14 ─────────────────────────────────────────────────────
  describe('Acceptance 14 — the resume tone', () => {
    it.each(['phrase', 'tap'] as const)(
      '(%s) plays exactly once, BEFORE the line is enqueued, without engaging any gate',
      async (via) => {
        const { harness, api } = await mount();
        await enterPause(harness, api);
        const dg = harness.refs.deepgram!;
        const dgPause = vi.spyOn(dg, 'pause');
        const mark = harness.diagnostics.length;
        if (via === 'phrase') await final(harness, 'CertMate, carry on.');
        else
          await act(async () => {
            await api().resume();
          });
        expect(toneSpy).toHaveBeenCalledTimes(1);
        const after = harness.diagnostics.slice(mark);
        const toneAt = after.findIndex((d) => d.category === 'voice_pause_resume_tone');
        const lineEnqueuedAt = after.findIndex(
          (d) =>
            d.category === 'tts_speak_mode_status_called' &&
            d.payload.textPreview === S('resume_line').slice(0, 80)
        );
        expect(toneAt).toBeGreaterThan(-1);
        expect(lineEnqueuedAt).toBeGreaterThan(toneAt);
        expect(after[toneAt].payload.via).toBe(via);
        expect(after.filter((d) => d.category === 'tts_pcm_gate_engaged')).toHaveLength(0);
        expect(dgPause).not.toHaveBeenCalled();
      }
    );

    it('(iii) a pre-emption right after the resume displaces the line, which is heard once, late', async () => {
      const { harness, api } = await mount();
      await enterPause(harness, api);
      harness.tts.manual = true;
      await final(harness, 'CertMate, carry on.');
      await act(async () => {
        harness.refs.sonnet!.emitQuestion({
          question: 'Is that the kitchen?',
          question_type: 'orphaned',
          tool_call_id: 'toolu_pland_displace',
        });
      });
      expect(count(played(harness), S('resume_line'))).toBe(0);
      await act(async () => {
        harness.tts.releaseAll();
      });
      await act(async () => {
        harness.tts.releaseAll();
      });
      expect(count(played(harness), S('resume_line'))).toBe(1);
      expect(toneSpy).toHaveBeenCalledTimes(1);
      const order = played(harness);
      expect(order.indexOf('Is that the kitchen?')).toBeLessThan(order.indexOf(S('resume_line')));
    });

    it('(iv) a failed resume attempt never plays the tone', async () => {
      const { harness, api } = await mount();
      await enterPause(harness, api);
      await final(harness, 'certmate carry on, circuit two now');
      await advance(THROTTLE_MS + 1000);
      await final(harness, 'carry on');
      expect(api().voicePaused).toBe(true);
      expect(toneSpy).not.toHaveBeenCalled();
      expect(diags(harness, 'voice_pause_resume_tone')).toHaveLength(0);
    });
  });
});
