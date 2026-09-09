/**
 * A02D — mounted `RecordingProvider` vectors through the REAL send path:
 * FakeDeepgramService wraps the real `DeepgramService` (real TurnInfo
 * parsing, real FinalWindowV1 meta, real dispatched-stream position), the
 * real JobProvider (its `manual` mutation observer samples the tap), the
 * real TTS FIFO with the harness player, and the fake Sonnet session that
 * records every send.
 *
 * Every freshness sequence runs TWICE: `NEXT_PUBLIC_REGEX_HINTS_ENABLED=1`
 * (job writes) and unset (gate-only lane: `computeFreshRegexWrites` + the
 * shadow; zero job writes, zero regex hints, the SAME send decisions).
 *
 * Stream positions: the fake advances the real `dispatchedSampleOffset`
 * with SILENT 80 ms frames (so the session VAD never flips to "speaking"
 * and parks a clarification behind local speech); `noteLocalSpeechOnset()`
 * samples the position exactly as production's tagging boundary does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { JobProvider, useJobContext } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  __heldFragmentClarificationStateForTests,
  __resetHeldFragmentClarificationForTests,
  __resetModeStatusCuesForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __resetUplinkLossDisclosureForTests,
  setConfirmationModeEnabled,
  UPLINK_LOSS_DISCLOSURE_TEXT,
} from '@/lib/recording/tts';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type RecordingApi = ReturnType<typeof useRecording>;
type JobApi = ReturnType<typeof useJobContext>;

function RecordingProbe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern (see confirmation-mode-web-companion)
  apiRef.current = useRecording();
  return null;
}
function JobProbe({ jobRef }: { jobRef: { current: JobApi | null } }) {
  // eslint-disable-next-line react-hooks/refs -- house harness pattern (see confirmation-mode-web-companion)
  jobRef.current = useJobContext();
  return null;
}

const CLARIFY_ONE =
  'I heard something just as you cleared circuit 4 Zs. Say it again if it should apply.';
const CLARIFY_TWO =
  'I heard something just as you cleared circuit 4 Zs and circuit 3 R1 plus R2. Say it again if it should apply.';

function makeJob(): JobDetail {
  return {
    id: 'job_a02d_m',
    job_id: 'job_a02d_m',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Downstairs lights' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Upstairs sockets' },
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Kitchen ring' },
      { id: 'c4', circuit_ref: '4', circuit_designation: 'Cooker' },
    ],
    supply_characteristics: {},
    board_info: {},
    installation_details: {},
  } as unknown as JobDetail;
}

const LANES: Array<{ name: string; env: string | undefined }> = [
  { name: 'hints ON', env: '1' },
  { name: 'hints OFF (gate-only)', env: undefined },
];

for (const lane of LANES) {
  describe(`A02D mounted — ${lane.name}`, () => {
    let container: HTMLDivElement;
    let root: Root | null = null;
    let onSamples: ((samples: Float32Array) => void) | null = null;

    beforeEach(() => {
      resetTtsQueue();
      __resetTtsFingerprintsForTests();
      __resetTtsWindowForTests();
      __resetModeStatusCuesForTests();
      __resetHeldFragmentClarificationForTests();
      __resetUplinkLossDisclosureForTests();
      setConfirmationModeEnabled(true);
      if (lane.env === undefined) vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', '');
      else vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', lane.env);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('network disabled in harness'))
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(async () => {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
        root = null;
      }
      container.remove();
      __setRecordingTestServices(null);
      setDiagnosticTap(null);
      resetTtsQueue();
      __resetHeldFragmentClarificationForTests();
      __resetUplinkLossDisclosureForTests();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      window.localStorage.removeItem('autoSleepEnabled');
      onSamples = null;
    });

    async function mount(initial: JobDetail = makeJob()) {
      const harness = buildHarnessServices();
      const writes: Array<{ source: string; changedKeys: string[] }> = [];
      const baseObserver = harness.services.jobStateObserver;
      harness.services.jobStateObserver = (change) => {
        writes.push({ source: change.source, changedKeys: [...(change.changedKeys ?? [])] });
        baseObserver?.(change);
      };
      const baseMic = harness.services.micCaptureFactory!;
      harness.services.micCaptureFactory = async (opts) => {
        onSamples = opts.onSamples ?? null;
        return baseMic(opts);
      };
      __setRecordingTestServices(harness.services);
      setDiagnosticTap(harness.services.diagnosticTap!);
      const apiRef: { current: RecordingApi | null } = { current: null };
      const jobRef: { current: JobApi | null } = { current: null };
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <JobProvider initial={initial}>
            <RecordingProvider>
              <RecordingProbe apiRef={apiRef} />
              <JobProbe jobRef={jobRef} />
            </RecordingProvider>
          </JobProvider>
        );
      });
      await act(async () => {
        await apiRef.current!.start();
      });
      expect(apiRef.current!.state).toBe('active');
      const dg = () => harness.refs.deepgram!;
      const sonnet = () => harness.refs.sonnet!;
      const regexWrites = () => writes.filter((w) => w.source === 'regex');
      const clarifications = () =>
        harness.tts.played.filter(
          (p) => p.kind === 'confirmation' && p.text.startsWith('I heard something')
        );
      const diag = (category: string) => harness.diagnostics.filter((d) => d.category === category);
      return { harness, apiRef, jobRef, writes, regexWrites, clarifications, dg, sonnet, diag };
    }

    /** Emit a final with an explicit onset at the CURRENT dispatched position,
     *  then flush the 500 ms burst buffer. */
    async function dictate(
      dg: ReturnType<typeof buildHarnessServices>['refs']['deepgram'],
      text: string,
      opts: { onset?: 'now' | 'none'; flush?: boolean } = {}
    ) {
      await act(async () => {
        if (opts.onset !== 'none') dg!.noteLocalSpeechOnset();
        dg!.emitSpeechStarted();
        dg!.emitEndOfTurn(text);
        if (opts.flush !== false) vi.advanceTimersByTime(700);
      });
    }

    function zsOf(jobApi: JobApi, ref: string): unknown {
      return (jobApi.job.circuits ?? []).find((c) => c.circuit_ref === ref)?.measured_zs_ohm;
    }
    function r1r2Of(jobApi: JobApi, ref: string): unknown {
      return (jobApi.job.circuits ?? []).find((c) => c.circuit_ref === ref)?.r1_r2_ohm;
    }

    /** The inspector's MANUAL clear (the real JobProvider `updateJob`). */
    async function manualClear(jobApi: JobApi, ref: string, field = 'measured_zs_ohm') {
      await act(async () => {
        jobApi.updateJob((prev) => ({
          circuits: (prev.circuits ?? []).map((c) =>
            c.circuit_ref === ref ? { ...c, [field]: '' } : c
          ),
        }));
      });
    }
    /** Seed a value the way a manual edit does (so a clear is a real change). */
    async function manualSet(jobApi: JobApi, ref: string, field: string, value: string) {
      await act(async () => {
        jobApi.updateJob((prev) => ({
          circuits: (prev.circuits ?? []).map((c) =>
            c.circuit_ref === ref ? { ...c, [field]: value } : c
          ),
        }));
      });
    }

    it('ordinary fresh final prefills (hints ON) / passes the gate (hints OFF) and is sent once; a later unrelated final is inert', async () => {
      const m = await mount();
      await dictate(m.dg(), 'Circuit 4 Zs is nought point three five.');
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      if (lane.env === '1') {
        expect(m.regexWrites()).toHaveLength(1);
        expect(zsOf(m.jobRef.current!, '4')).toBe('0.35');
        const hints = (m.sonnet().sentTranscripts[0].options as { regexResults?: unknown[] })
          .regexResults;
        expect(hints?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(m.regexWrites()).toHaveLength(0);
        expect(zsOf(m.jobRef.current!, '4')).toBeUndefined();
        expect(
          (m.sonnet().sentTranscripts[0].options as { regexResults?: unknown[] }).regexResults
        ).toBeUndefined();
      }
      const decisions = m.diag('a02d_occurrence_decisions');
      expect(decisions).toHaveLength(1);
      expect((decisions[0].payload.decisions as Record<string, number>).fresh).toBe(1);
      // Old overlap: unrelated speech rescans the window and writes nothing
      // (the value equality gate would ALSO block here; the decision is what
      // A02D pins).
      await dictate(m.dg(), 'The weather today is mild and grey.');
      expect(m.regexWrites().length).toBe(lane.env === '1' ? 1 : 0);
      const second = m.diag('a02d_occurrence_decisions')[1].payload.decisions as Record<
        string,
        number
      >;
      expect(second.fresh ?? 0).toBe(0);
      expect(m.clarifications()).toHaveLength(0);
    });

    it('manual clear then a delayed same-socket final (onset before the tap) is HELD: zero sends, zero writes, no chime, one clarification; the repeat applies and speaks once', async () => {
      const m = await mount();
      const dg = m.dg();
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      const sendsBefore = m.sonnet().sentTranscripts.length;
      const chimesBefore = m.harness.chimes.count;
      if (lane.env !== '1') await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      // The inspector starts speaking (onset at position P), THEN taps clear
      // while the audio is still in flight (the tap samples P + 10 frames).
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      const offsetAtTap = dg.dispatchedStreamOffset;
      await manualClear(m.jobRef.current!, '4');
      const boundary = m.diag('a02d_manual_boundary');
      expect(boundary.length).toBe(lane.env === '1' ? 1 : 2); // hints OFF seeded the value manually first
      expect(boundary[boundary.length - 1].payload.dispatchedOffset).toBe(offsetAtTap);
      expect(boundary[boundary.length - 1].payload.label).toBe('circuit 4 Zs');
      expect(boundary[boundary.length - 1].payload.cleared).toBe(true);
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(sendsBefore);
      expect(m.harness.chimes.count).toBe(chimesBefore);
      expect(zsOf(m.jobRef.current!, '4')).toBe('');
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      // The repeat: onset AFTER the tap → forwarded, written (hints ON), spoken once.
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      expect(m.sonnet().sentTranscripts).toHaveLength(sendsBefore + 1);
      expect(m.harness.chimes.count).toBe(chimesBefore + 1);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.35');
      expect(m.clarifications()).toHaveLength(1);
    });

    it('manual clear then a fresh reading whose onset follows the tap is forwarded with no clarification; equality is fresh', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.advanceDispatchedStream(5);
      });
      await manualClear(m.jobRef.current!, '4');
      // Onset exactly AT the tap position (equality) → fresh.
      await dictate(dg, 'Circuit 4 Zs is nought point four.');
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.4');
      expect(m.clarifications()).toHaveLength(0);
    });

    it('hold ordering: a pre-cutoff LOCAL apply command runs nothing — zero writes, zero sends, no chime, one clarification; the pending ask stays pending', async () => {
      const m = await mount();
      const dg = m.dg();
      await act(async () => {
        m.sonnet().emitQuestion({
          question: 'Which circuit is the Zs of 0.65 for?',
          question_type: 'clarification',
          tool_call_id: 'tool_1',
        });
      });
      // The question's TTS engages the PCM gate (the sender is paused while
      // the device speaks) — wait out the 500 ms post-playback release so the
      // stream position can advance again.
      for (let i = 0; i < 5 && dg.dispatchedStreamOffset === 0; i++) {
        await act(async () => {
          vi.advanceTimersByTime(600);
          await Promise.resolve();
          dg.advanceDispatchedStream(1);
        });
      }
      expect(dg.dispatchedStreamOffset).toBeGreaterThan(0);
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      const writesBefore = m.writes.length;
      // A recognised local apply command inside the race window.
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Set polarity to pass for circuits 1 to 4.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.writes.length).toBe(writesBefore);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.sonnet().sentAskAnswers).toHaveLength(0);
      expect(m.harness.chimes.count).toBe(0);
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      // The repeat answers the ask (the ask was never consumed by the hold).
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      await dictate(dg, 'Circuit 2.');
      expect(m.sonnet().sentAskAnswers).toHaveLength(1);
      // Control: the same command with a post-tap onset RUNS locally (the
      // answered question's TTS echo window is a wall-clock guard; clear it
      // the way the other mounted suites do between steps).
      __resetTtsWindowForTests();
      await dictate(dg, 'Set polarity to pass for circuits 1 to 4.');
      expect(m.writes.some((w) => w.source === 'local_command')).toBe(true);
      expect(m.clarifications()).toHaveLength(1);
    });

    it('an unrelated reading in the race window is held WHOLE naming the cleared destination; an utterance-driven server clear never holds', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 3 R1 plus R2 is nought point two.');
        vi.advanceTimersByTime(700);
      });
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(r1r2Of(m.jobRef.current!, '3')).toBeUndefined();
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      await dictate(dg, 'Circuit 3 R1 plus R2 is nought point two.');
      if (lane.env === '1') expect(r1r2Of(m.jobRef.current!, '3')).toBe('0.2');
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      // Server clear (utterance-driven, echoing the causative utterance_id):
      // the NEXT reading is never held or falsely stale.
      const sent = m.sonnet().sentTranscripts[0].options as { utteranceId: string };
      await act(async () => {
        m.sonnet().emitFieldCorrected({
          circuit: 3,
          field: 'r1_r2_ohm',
          utterance_id: sent.utteranceId,
        } as never);
      });
      const boundaries = m.diag('a02d_server_boundary');
      expect(boundaries.length).toBeGreaterThan(0);
      expect(boundaries[boundaries.length - 1].payload.causativeSequence).toBe(2);
      await dictate(dg, 'Circuit 3 Zs is nought point four.');
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(2);
      // A02D judges the next reading's occurrence FRESH — an utterance-driven
      // clear never holds and never falsely stales what follows it.
      const last = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload.decisions as Record<
        string,
        number
      >;
      expect(last.fresh).toBe(1);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '3')).toBe('0.4');
      expect(m.clarifications()).toHaveLength(1);
    });

    it('a server replacement never lets the overlap restore the old value; a fresh identical re-dictation after a clear applies once', async () => {
      const m = await mount();
      const dg = m.dg();
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      const sent = m.sonnet().sentTranscripts[0].options as { utteranceId: string };
      // A server REPLACEMENT on web is a clear frame followed by the reading
      // (an occupied cell keeps its value against a bare reading —
      // `apply_circuit_reading_user_value_kept`); both carry the causative
      // `utterance_id`.
      await act(async () => {
        m.sonnet().emitFieldCorrected({
          circuit: 4,
          field: 'zs',
          utterance_id: sent.utteranceId,
        } as never);
        m.sonnet().emitExtraction({
          utterance_id: sent.utteranceId,
          readings: [{ circuit: 4, field: 'zs', value: '0.5' }],
          confirmations: [{ field: 'zs', circuit: 4, text: 'Circuit 4 Zs 0.5' }],
        });
      });
      expect(zsOf(m.jobRef.current!, '4')).toBe('0.5');
      const boundaries = m.diag('a02d_server_boundary');
      expect(boundaries.length).toBeGreaterThanOrEqual(1);
      expect(boundaries[0].payload.causativeSequence).toBe(1);
      await dictate(dg, 'Circuit 3 R1 plus R2 is nought point two.');
      expect(zsOf(m.jobRef.current!, '4')).toBe('0.5'); // never restored to 0.35
      await act(async () => {
        m.sonnet().emitFieldCorrected({ circuit: 4, field: 'measured_zs_ohm' } as never);
      });
      expect(zsOf(m.jobRef.current!, '4') ?? '').toBe('');
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.35');
      expect(m.sonnet().sentTranscripts).toHaveLength(3);
      expect(m.clarifications()).toHaveLength(0);
    });

    it('unbounded final: forwarded (no write) with no cutoff; held with one clarification once a manual cutoff applies', async () => {
      const m = await mount();
      const dg = m.dg();
      dg.autoConfirmOnset = false;
      await act(async () => {
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.regexWrites()).toHaveLength(0);
      const first = m.diag('a02d_final_window')[0].payload;
      expect(first.unbounded).toBe(true);
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
    });

    it('burst/naming buffers: a manual clear during the 3 s naming hold holds the released concatenation whole (zero sends, zero writes, one clarification)', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '2', 'measured_zs_ohm', '0.9');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(4);
      });
      // A bare naming preface arms the 3 s naming buffer (not dispatched yet).
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 2 is');
      });
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      await manualClear(m.jobRef.current!, '2');
      // The completion arrives (same run, onset already below the tap).
      await act(async () => {
        dg.emitEndOfTurn('upstairs sockets.');
        vi.advanceTimersByTime(700);
      });
      const held = m.diag('a02d_final_held');
      expect(held).toHaveLength(1);
      expect(held[0].payload.constituents).toBe(2);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.regexWrites()).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(1);
      expect(m.clarifications()[0].text).toContain('circuit 2 Zs');
    });

    it('text freeze: two held finals while the token is parked behind local speech merge into ONE line; a third after the freeze gets a successor', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await manualSet(m.jobRef.current!, '3', 'r1_r2_ohm', '0.2');
      // Real voiced audio through the tap: the session VAD's ONSET is
      // forwarded to the sender (speech_start at the pre-tap position) and
      // "local speaking" holds for the next 2.5 s.
      dg.autoConfirmOnset = false;
      await act(async () => {
        const voiced = new Float32Array(16000 * 0.4);
        for (let i = 0; i < voiced.length; i++) voiced[i] = i % 2 === 0 ? 0.3 : -0.3;
        onSamples!(voiced);
      });
      await manualClear(m.jobRef.current!, '4');
      await manualClear(m.jobRef.current!, '3', 'r1_r2_ohm');
      // StartOfTurn confirms the VAD onset; both finals belong to that run.
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      await act(async () => {
        dg.emitEndOfTurn('Circuit 3 R1 plus R2 is nought point two.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(2);
      expect(m.clarifications()).toHaveLength(0); // parked behind local speech, text unfrozen
      expect(__heldFragmentClarificationStateForTests().outstanding?.destinations).toEqual([
        'circuit 4 Zs',
        'circuit 3 R1 plus R2',
      ]);
      expect(__heldFragmentClarificationStateForTests().outstanding?.finalKeys).toHaveLength(2);
      // Local silence (≥ 500 ms) releases the park → ONE merged line plays.
      await act(async () => {
        onSamples!(new Float32Array(16000 * 0.6));
      });
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_TWO]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      // A third held final after the freeze/playback → its own successor
      // line (same wording here: the same two destinations still apply).
      await act(async () => {
        dg.emitEndOfTurn('Circuit 1 Zs is nought point two.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(3);
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_TWO, CLARIFY_TWO]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(2);
    });

    it('a duplicate callback of the same final dedupes to one token; a direct-prompt preemption re-parks and the line still plays exactly once', async () => {
      const m = await mount();
      const dg = m.dg();
      m.harness.tts.manual = true;
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      const state = __heldFragmentClarificationStateForTests();
      expect(state.outstanding).not.toBeNull();
      expect(state.held).toBe(1);
      // A direct prompt (server ask) preempts the prepared-but-unplayed clip.
      await act(async () => {
        m.sonnet().emitQuestion({ question: 'Which board?', question_type: 'clarification' });
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });
      await act(async () => {
        m.harness.tts.releaseAll();
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });
      await act(async () => {
        m.harness.tts.releaseAll();
        vi.advanceTimersByTime(50);
      });
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
    });

    it('old-service finals are dropped at the admission boundary after pause (inside the 300 ms close grace) and after stop (session replacement): zero sends, zero holds, zero clarifications', async () => {
      const m = await mount();
      const oldDg = m.dg();
      await dictate(oldDg, 'Circuit 4 Zs is nought point three five.');
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      await act(async () => {
        m.apiRef.current!.pause();
      });
      // Late final from the REPLACED service's own socket, still open inside
      // its CloseStream grace — dropped at A02D's admission boundary (the
      // service invalidated itself synchronously in disconnect()).
      await act(async () => {
        oldDg.emitEndOfTurn('Circuit 4 Zs is nought point four.');
      });
      expect(m.diag('a02d_final_dropped_at_admission')).toHaveLength(1);
      expect(m.diag('a02d_final_dropped_at_admission')[0].payload.serviceAdmissible).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(700);
        await m.apiRef.current!.resume();
      });
      expect(m.dg()).not.toBe(oldDg);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(0);
      expect(zsOf(m.jobRef.current!, '4')).toBe(lane.env === '1' ? '0.35' : undefined);
      // Session replacement: stop → a late final from the previous session's
      // service → start; dropped the same way, nothing spoken into the new session.
      const secondDg = m.dg();
      await act(async () => {
        m.apiRef.current!.stop();
      });
      await act(async () => {
        secondDg.emitEndOfTurn('Circuit 4 Zs is nought point four.');
      });
      await act(async () => {
        vi.advanceTimersByTime(700);
        await m.apiRef.current!.start();
      });
      expect(m.diag('a02d_final_dropped_at_admission')).toHaveLength(2);
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(0);
    });

    it('session stop abandons a pending clarification token — nothing is spoken into the next session', async () => {
      const m = await mount();
      const dg = m.dg();
      m.harness.tts.manual = true;
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(__heldFragmentClarificationStateForTests().outstanding).not.toBeNull();
      expect(m.clarifications()).toHaveLength(0); // prepared, not yet played
      await act(async () => {
        m.apiRef.current!.stop();
      });
      expect(__heldFragmentClarificationStateForTests().outstanding).toBeNull();
      await act(async () => {
        await m.apiRef.current!.start();
      });
      await act(async () => {
        m.harness.tts.releaseAll();
        vi.advanceTimersByTime(3000);
      });
      expect(m.clarifications()).toHaveLength(0);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(0);
    });

    it('an A02B bypass boundary (a question) is forwarded directly and resets only matcher text; cutoffs are provider state, not matcher state', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await manualClear(m.jobRef.current!, '4');
      await dictate(dg, 'What is the Zs for circuit 4?');
      expect(
        m
          .diag('conversation_admission_matcher_reset')
          .some((d) => d.payload.boundary === 'bypassed_final')
      ).toBe(true);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.diag('a02d_manual_boundary')).toHaveLength(2);
      expect(m.regexWrites()).toHaveLength(0);
    });

    it('replay retired: automatic full sleep → resume re-sends ZERO audio, charges the ring as E2 staged loss, the E2 disclosure speaks once, the cleared field stays empty, and a fresh identical dictation applies once', async () => {
      window.localStorage.setItem('autoSleepEnabled', 'true');
      const m = await mount();
      const dg = m.dg();
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      if (lane.env !== '1') await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await manualClear(m.jobRef.current!, '4');
      // The 60 s no-transcript timer enters automatic full sleep (Deepgram +
      // Sonnet torn down; the mic and the tagged ring keep running).
      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });
      expect(m.apiRef.current!.state).toBe('sleeping');
      const constructedBefore = m.harness.counts.deepgramConstructed;
      // Voiced audio captured while no socket could take it lands in the ring.
      await act(async () => {
        const voiced = new Float32Array(16000 * 0.5);
        for (let i = 0; i < voiced.length; i++) voiced[i] = i % 2 === 0 ? 0.3 : -0.3;
        onSamples!(voiced);
        onSamples!(new Float32Array(16000 * 0.6)); // silence → VAD silence transition
      });
      await act(async () => {
        await m.apiRef.current!.resume();
      });
      expect(m.harness.counts.deepgramConstructed).toBe(constructedBefore + 1);
      expect(m.dg().sentTaggedAudioBlocks).toBe(0);
      const charged = m.diag('a02d_ring_charged_as_staged_loss');
      expect(charged).toHaveLength(1);
      expect(charged[0].payload.reason).toBe('resume_from_full_sleep');
      expect(charged[0].payload.resentAudioBlocks).toBe(0);
      expect((charged[0].payload.voicedSources as number) > 0).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      const disclosures = m.harness.tts.played.filter(
        (p) => p.text === UPLINK_LOSS_DISCLOSURE_TEXT
      );
      expect(disclosures).toHaveLength(1);
      expect(zsOf(m.jobRef.current!, '4')).toBe('');
      const sendsBefore = m.sonnet().sentTranscripts.length;
      await dictate(m.dg(), 'Circuit 4 Zs is nought point three five.');
      expect(m.sonnet().sentTranscripts).toHaveLength(sendsBefore + 1);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.35');
      expect(m.clarifications()).toHaveLength(0);
      expect(
        m.harness.tts.played.filter((p) => p.text === UPLINK_LOSS_DISCLOSURE_TEXT)
      ).toHaveLength(1);
    });
  });
}
