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
import { __resetForTests as resetTtsQueue, MAX_QUEUE_DEPTH } from '@/lib/recording/tts-queue';
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
import { buildHarnessServices, type FakeDeepgramService } from './fake-services';
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

/** Single-board job with the inputs a local Calculate needs (Ze + R1+R2). */
function makeCalcJob(): JobDetail {
  const base = makeJob() as unknown as Record<string, unknown>;
  return {
    ...base,
    supply_characteristics: { ze: '0.35' },
    circuits: [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Downstairs lights' },
      { id: 'c4', circuit_ref: '4', circuit_designation: 'Cooker', r1_r2_ohm: '0.20' },
    ],
  } as unknown as JobDetail;
}

/** Two boards sharing circuit ref "4" (the fixture's two_board_same_ref job). */
function makeTwoBoardJob(): JobDetail {
  const base = makeJob() as unknown as Record<string, unknown>;
  return {
    ...base,
    boards: [
      { id: 'b_main', designation: 'main', slug: 'main' },
      { id: 'b_garage', designation: 'garage', slug: 'garage' },
    ],
    circuits: [
      { id: 'c4', circuit_ref: '4', circuit_designation: 'Cooker', board_id: 'b_main' },
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Kitchen ring', board_id: 'b_main' },
      { id: 'c4g', circuit_ref: '4', circuit_designation: 'Garage sockets', board_id: 'b_garage' },
    ],
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

    async function mount(
      initial: JobDetail = makeJob(),
      opts: { deepgram?: 'static' | 'reconnectable' } = {}
    ) {
      const harness = buildHarnessServices({ sonnet: 'real-decoder', deepgram: opts.deepgram });
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
      if (opts.deepgram === 'reconnectable') {
        // Fetcher mode opens the captive socket on a microtask.
        await act(async () => {
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        expect(harness.refs.deepgram!.connectionState).toBe('connected');
      }
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
    /** Manual edit of ONE row by stable id (two boards may share a ref). */
    async function manualEditRow(jobApi: JobApi, rowId: string, field: string, value: string) {
      await act(async () => {
        jobApi.updateJob((prev) => ({
          circuits: (prev.circuits ?? []).map((c) =>
            c.id === rowId ? { ...c, [field]: value } : c
          ),
        }));
      });
    }
    function rowValue(jobApi: JobApi, rowId: string, field: string): unknown {
      return (
        (jobApi.job.circuits ?? []).find((c) => c.id === rowId) as
          | Record<string, unknown>
          | undefined
      )?.[field];
    }
    /** Manual edit of a section field (`board_info` here). */
    async function manualEditBoardInfo(jobApi: JobApi, field: string, value: string) {
      await act(async () => {
        jobApi.updateJob((prev) => ({
          board_info: { ...(prev.board_info ?? {}), [field]: value },
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

    it('[invariant] ordinary fresh final prefills (hints ON) / passes the gate (hints OFF) and is sent once; a later unrelated final is inert', async () => {
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

    it('[invariant] manual clear then a delayed same-socket final (onset before the tap) is HELD: zero sends, zero writes, no chime, one clarification; the repeat applies and speaks once', async () => {
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

    it('[invariant] manual clear then a fresh reading whose onset follows the tap is forwarded with no clarification; equality is fresh', async () => {
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

    it('[invariant] hold ordering: a pre-cutoff LOCAL apply command runs nothing — zero writes, zero sends, no chime, one clarification; the pending ask stays pending', async () => {
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

    it('[invariant] an unrelated reading in the race window is held WHOLE naming the cleared destination; an utterance-driven server clear never holds', async () => {
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

    it('[invariant] a server replacement never lets the overlap restore the old value; a fresh identical re-dictation after a clear applies once', async () => {
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

    it('[invariant] REAL decoder: F1 opens an incomplete occurrence, F2 answers the ask and causes the server clear (echoed utterance_id decoded), the completing F3 is STALE — the cleared value is never restored', async () => {
      const m = await mount();
      const dg = m.dg();
      // Pre-existing value the server will clear (a real change).
      await manualSet(m.jobRef.current!, '3', 'r1_r2_ohm', '0.4');
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      // F1 — a length-changing reading left incomplete (no value yet).
      await dictate(dg, 'Circuit 3 R1 plus R2 is');
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.regexWrites()).toHaveLength(0);
      // The server asks (Stage 6 ask_user_started, through the REAL decoder).
      await act(async () => {
        m.sonnet().emitQuestion({
          question: 'Which circuit did you mean?',
          question_type: 'clarification',
          tool_call_id: 'tool_f2',
        });
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });
      for (let i = 0; i < 5 && m.sonnet().peekInFlightToolCallId() === null; i++) {
        await act(async () => {
          vi.advanceTimersByTime(600);
          await Promise.resolve();
        });
      }
      expect(m.sonnet().peekInFlightToolCallId()).toBe('tool_f2');
      __resetTtsWindowForTests();
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      // F2 — the answer (sequence 2). Its utterance_id is the CAUSATIVE
      // identity the server echoes on the clear it triggers.
      await dictate(dg, 'Yes, circuit 3.');
      expect(m.sonnet().sentAskAnswers).toHaveLength(1);
      const f2 = m.sonnet().sentAskAnswers[0].utteranceId;
      expect(typeof f2).toBe('string');
      // The server's standalone clear frame, as the ALB delivers it — JSON
      // through the REAL `handleMessage` decoder (a fake invoking the
      // callback with an undecoded object would hide a decoder that drops
      // the echo, which is exactly Codex cycle-1 BLOCKER 0).
      await act(async () => {
        m.sonnet().emitRaw({
          type: 'field_corrected',
          circuit: 3,
          field: 'r1_r2_ohm',
          previous_value: '0.4',
          utterance_id: f2,
        });
      });
      expect(r1r2Of(m.jobRef.current!, '3') ?? '').toBe('');
      const boundaries = m.diag('a02d_server_boundary');
      expect(boundaries.length).toBeGreaterThanOrEqual(1);
      expect(boundaries[boundaries.length - 1].payload.causativeSequence).toBe(2);
      // F3 completes F1's occurrence across the cutoff: F1 (sequence 1) is
      // at or below the causative sequence, so the union is STALE — no
      // write in either lane, and the cleared cell stays empty.
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      const sentBeforeF3 = m.sonnet().sentTranscripts.length;
      await dictate(dg, 'nought point two.');
      expect(m.sonnet().sentTranscripts).toHaveLength(sentBeforeF3 + 1);
      const last = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload.decisions as Record<
        string,
        number
      >;
      expect(last.stale_buffer).toBe(1);
      expect(last.fresh ?? 0).toBe(0);
      expect(m.regexWrites()).toHaveLength(0);
      expect(r1r2Of(m.jobRef.current!, '3') ?? '').toBe('');
      expect(m.clarifications()).toHaveLength(0);
      // The same echo on an EXTRACTION envelope (a server replacement) is
      // decoded too: the boundary names the causative sequence.
      await act(async () => {
        m.sonnet().emitRaw({
          type: 'extraction',
          result: {
            utterance_id: f2,
            readings: [{ circuit: 3, field: 'r1_r2', value: '0.5' }],
            confirmations: [{ field: 'r1_r2', circuit: 3, text: 'Circuit 3 R1 plus R2 0.5' }],
          },
        });
      });
      expect(r1r2Of(m.jobRef.current!, '3')).toBe('0.5');
      const after = m.diag('a02d_server_boundary');
      expect(after[after.length - 1].payload.source).toBe('extraction');
      expect(after[after.length - 1].payload.causativeSequence).toBe(2);
      expect(after[after.length - 1].payload.hasUtteranceId).toBe(true);
    });

    it('[invariant] two boards sharing circuit 4: the ACTIVE board picks the row for provenance, cutoff and write alike; the clarification names only the cleared board; the other board’s row is untouched', async () => {
      const m = await mount(makeTwoBoardJob());
      const dg = m.dg();
      // Default (no active board yet) = the job's first board: main.
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      let decisions = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
      expect(decisions.fresh).toEqual(['circuit.c4.measured_zs_ohm']);
      if (lane.env === '1') {
        expect(rowValue(m.jobRef.current!, 'c4', 'measured_zs_ohm')).toBe('0.35');
        expect(rowValue(m.jobRef.current!, 'c4g', 'measured_zs_ohm')).toBeUndefined();
      }
      // The server switches the active board to the garage (real decoder).
      await act(async () => {
        m.sonnet().emitRaw({
          type: 'current_board_changed',
          board_id: 'b_garage',
          source: 'select_board',
        });
        dg.advanceDispatchedStream(1);
      });
      await dictate(dg, 'Circuit 4 Zs is nought point four.');
      decisions = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
      expect(decisions.fresh).toEqual(['circuit.c4g.measured_zs_ohm']);
      if (lane.env === '1') {
        expect(rowValue(m.jobRef.current!, 'c4g', 'measured_zs_ohm')).toBe('0.4');
        expect(rowValue(m.jobRef.current!, 'c4', 'measured_zs_ohm')).toBe('0.35'); // main untouched
      } else {
        await manualEditRow(m.jobRef.current!, 'c4g', 'measured_zs_ohm', '0.4');
        await act(async () => {
          dg.advanceDispatchedStream(1);
        });
      }
      // Pre-tap onset, then the garage row is cleared by hand, then the
      // in-flight final: HELD, naming circuit 4 Zs ON THE GARAGE BOARD.
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualEditRow(m.jobRef.current!, 'c4g', 'measured_zs_ohm', '');
      const boundary = m.diag('a02d_manual_boundary').slice(-1)[0].payload;
      expect(boundary.destination).toBe('circuit.c4g.measured_zs_ohm');
      expect(boundary.label).toBe('circuit 4 Zs on the garage board');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point four.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.clarifications().map((p) => p.text)).toEqual([
        'I heard something just as you cleared circuit 4 Zs on the garage board. Say it again if it should apply.',
      ]);
      expect(rowValue(m.jobRef.current!, 'c4g', 'measured_zs_ohm')).toBe('');
      if (lane.env === '1')
        expect(rowValue(m.jobRef.current!, 'c4', 'measured_zs_ohm')).toBe('0.35');
      // The repeat (post-tap onset) applies to the GARAGE row only.
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'Circuit 4 Zs is nought point four.');
      decisions = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
      expect(decisions.fresh).toEqual(['circuit.c4g.measured_zs_ohm']);
      if (lane.env === '1') {
        expect(rowValue(m.jobRef.current!, 'c4g', 'measured_zs_ohm')).toBe('0.4');
        expect(rowValue(m.jobRef.current!, 'c4', 'measured_zs_ohm')).toBe('0.35');
      }
      expect(m.clarifications()).toHaveLength(1);
    });

    it("[invariant] alias families — the SAME patches the Installation and Supply pages make (general_condition_of_installation, earth_loop_impedance_ze, prospective_fault_current cleared to '') record manual cutoffs: a delayed pre-tap final is held naming the destination; the fresh post-tap control writes every alias", async () => {
      const m = await mount();
      const dg = m.dg();
      const cases: Array<{
        dictation: string;
        section: 'installation_details' | 'supply_characteristics';
        canonical: string;
        ui: string;
        key: string;
        label: string;
        value: string;
      }> = [
        {
          dictation: 'General condition is satisfactory.',
          section: 'installation_details',
          canonical: 'general_condition',
          ui: 'general_condition_of_installation',
          key: 'install.general_condition',
          label: 'general condition',
          // The matcher's capture keeps the copula ("is satisfactory") — a
          // pre-existing pattern quirk, irrelevant to the alias contract.
          value: 'is satisfactory',
        },
        {
          dictation: 'Ze is nought point three five.',
          section: 'supply_characteristics',
          canonical: 'ze',
          ui: 'earth_loop_impedance_ze',
          key: 'supply.ze',
          label: 'Ze',
          value: '0.35',
        },
        {
          dictation: 'PFC is 2.5 kA.',
          section: 'supply_characteristics',
          canonical: 'pfc',
          ui: 'prospective_fault_current',
          key: 'supply.pfc',
          label: 'PFC',
          value: '2.5',
        },
      ];
      const sectionOf = (name: string) =>
        (m.jobRef.current!.job as unknown as Record<string, Record<string, unknown>>)[name] ?? {};
      /** EXACTLY what the page does: `updateJob({ <section>: { ...details, <uiAlias>: v } })`. */
      const pagePatch = async (section: string, ui: string, v: string) => {
        await act(async () => {
          m.jobRef.current!.updateJob((prev) => ({
            [section]: {
              ...((prev as unknown as Record<string, Record<string, unknown>>)[section] ?? {}),
              [ui]: v,
            },
          }));
        });
      };
      for (const c of cases) {
        const heldBefore = m.diag('a02d_final_held').length;
        const clarBefore = m.clarifications().length;
        // The value on the destination: a regex write (hints ON — lands on
        // BOTH aliases) or the page's own edit (hints OFF).
        await act(async () => {
          dg.advanceDispatchedStream(1);
        });
        if (lane.env === '1') {
          await dictate(dg, c.dictation);
          expect(sectionOf(c.section)[c.canonical], `${c.key} wire alias written`).toBe(c.value);
          expect(sectionOf(c.section)[c.ui], `${c.key} UI alias written`).toBe(c.value);
        } else {
          await pagePatch(c.section, c.ui, c.value);
          await dictate(dg, 'Moving on.');
        }
        // In-flight repeat (onset BEFORE the tap), then the page clears the
        // VISIBLE alias only — the wire alias may still carry the value.
        await act(async () => {
          dg.noteLocalSpeechOnset();
          dg.advanceDispatchedStream(10);
        });
        await pagePatch(c.section, c.ui, '');
        const boundary = m.diag('a02d_manual_boundary').slice(-1)[0].payload;
        expect(boundary.destination, `${c.key} boundary`).toBe(c.key);
        expect(boundary.cleared, `${c.key} cleared`).toBe(true);
        expect(boundary.label, `${c.key} label`).toBe(c.label);
        await act(async () => {
          dg.emitSpeechStarted();
          dg.emitEndOfTurn(c.dictation);
          vi.advanceTimersByTime(700);
        });
        expect(m.diag('a02d_final_held').length, `${c.key} held`).toBe(heldBefore + 1);
        expect(
          m
            .clarifications()
            .slice(clarBefore)
            .map((p) => p.text),
          `${c.key} clarification`
        ).toEqual([
          `I heard something just as you cleared ${c.label}. Say it again if it should apply.`,
        ]);
        expect(sectionOf(c.section)[c.ui] ?? '', `${c.key} UI alias stays cleared`).toBe('');
        // Fresh identical post-tap control: writes again, on EVERY alias.
        await act(async () => {
          dg.advanceDispatchedStream(2);
        });
        await dictate(dg, c.dictation);
        expect(m.diag('a02d_final_held').length, `${c.key} control not held`).toBe(heldBefore + 1);
        const last = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
        expect(last.fresh, `${c.key} control fresh`).toEqual([c.key]);
        if (lane.env === '1') {
          expect(sectionOf(c.section)[c.ui], `${c.key} UI alias rewritten`).toBe(c.value);
          expect(sectionOf(c.section)[c.canonical], `${c.key} wire alias rewritten`).toBe(c.value);
        } else {
          const gate = m.diag('a02d_gate_only_fresh_writes').slice(-1)[0].payload.writes as Array<{
            key: string;
          }>;
          expect(
            gate.map((w) => w.key),
            `${c.key} gate-only write`
          ).toEqual([c.key]);
        }
      }
    });

    it('[invariant] the five board-routed supply fields (main_switch_* / spd_*) pass the freshness gate under their board.* keys, apply once, settle on repeat, and a manual clear of one names its board label', async () => {
      const m = await mount();
      const dg = m.dg();
      await dictate(
        dg,
        'Main switch is BS EN 60947 rated 100 amps, tails 25 mm, main fuse is BS 1361 rated 80 amps.'
      );
      const fresh = (
        m.diag('a02d_occurrence_decisions').slice(-1)[0].payload.fresh as string[]
      ).sort();
      expect(fresh).toEqual([
        'board.main_switch_bs_en',
        'board.main_switch_conductor_csa',
        'board.main_switch_current',
        'board.spd_bs_en',
        'board.spd_rated_current',
      ]);
      if (lane.env === '1') {
        const board = m.jobRef.current!.job.board_info as Record<string, unknown>;
        expect(board.main_switch_current).toBe('100');
        expect(board.main_switch_conductor_csa).toBe('25');
        expect(board.spd_rated_current).toBe('80');
        expect(typeof board.main_switch_bs_en).toBe('string');
        expect(typeof board.spd_bs_en).toBe('string');
        expect(m.regexWrites()).toHaveLength(1);
        expect(m.regexWrites()[0].changedKeys.sort()).toEqual(fresh);
      } else {
        expect(m.regexWrites()).toHaveLength(0);
      }
      // Identical repeat: the occurrences are new but every value is a
      // re-hit — the value gate writes nothing, and nothing is stale.
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      await dictate(
        dg,
        'Main switch is BS EN 60947 rated 100 amps, tails 25 mm, main fuse is BS 1361 rated 80 amps.'
      );
      expect(m.regexWrites().length).toBe(lane.env === '1' ? 1 : 0);
      expect(m.clarifications()).toHaveLength(0);
      // A manual clear of the rating (a board_info field the Supply tab
      // also renders) is diffed under `board.main_switch_current`; the
      // in-flight final is held naming its BOARD label.
      if (lane.env !== '1')
        await manualEditBoardInfo(m.jobRef.current!, 'main_switch_current', '100');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualEditBoardInfo(m.jobRef.current!, 'main_switch_current', '');
      const boundary = m.diag('a02d_manual_boundary').slice(-1)[0].payload;
      expect(boundary.destination).toBe('board.main_switch_current');
      expect(boundary.label).toBe('main switch rating');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Main switch is 100 amps.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.clarifications().map((p) => p.text)).toEqual([
        'I heard something just as you cleared main switch rating. Say it again if it should apply.',
      ]);
      // Post-tap repeat applies again (hints ON).
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'Main switch is 100 amps.');
      if (lane.env === '1') {
        expect(
          (m.jobRef.current!.job.board_info as Record<string, unknown>).main_switch_current
        ).toBe('100');
      }
      expect(m.clarifications()).toHaveLength(1);
    });

    it('[invariant] unbounded final: forwarded (no write) with no cutoff; held with one clarification once a manual cutoff applies', async () => {
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

    it('[invariant] burst/naming buffers: a manual clear during the 3 s naming hold holds the released concatenation whole (zero sends, zero writes, one clarification)', async () => {
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

    it('[invariant] text freeze: two held finals while the token is parked behind local speech merge into ONE line; a third after the freeze gets a successor', async () => {
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

    it('[invariant] a duplicate delivery of the same provider final (same turn_index) dedupes to ONE token before playback; a direct-prompt preemption re-parks and the line still plays exactly once', async () => {
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
      let state = __heldFragmentClarificationStateForTests();
      expect(state.outstanding).not.toBeNull();
      expect(state.held).toBe(1);
      // The SAME EndOfTurn frame again (same turn_index, same window end):
      // the provider recognises the provider final and DROPS the delivery
      // at admission — no second record, no second hold, no second token.
      await act(async () => {
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_window')).toHaveLength(1);
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      state = __heldFragmentClarificationStateForTests();
      expect(state.held).toBe(1);
      expect(state.outstanding?.finalKeys).toHaveLength(1);
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

    it('[invariant] duplicate delivery of an ORDINARY server-bound final, inside and after the 500 ms burst window: one fragment (never concatenated with itself), one write, one send', async () => {
      const m = await mount();
      const dg = m.dg();
      // Inside the burst window: the duplicate arrives before the release.
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(200);
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(1);
      expect(m.diag('a02d_final_window')).toHaveLength(1);
      expect(m.diag('pipeline_burst_buffer_concat')).toHaveLength(0);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.sonnet().sentTranscripts[0].text).toBe('Circuit 4 Zs is 0.35.');
      expect(m.diag('a02d_occurrence_decisions')).toHaveLength(1);
      expect(m.regexWrites().length).toBe(lane.env === '1' ? 1 : 0);
      expect(m.harness.chimes.count).toBe(1);
      // After the release: a late re-delivery of the same provider final.
      await act(async () => {
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(2);
      expect(m.diag('a02d_final_window')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.diag('a02d_occurrence_decisions')).toHaveLength(1);
      expect(m.harness.chimes.count).toBe(1);
      expect(m.regexWrites().length).toBe(lane.env === '1' ? 1 : 0);
      // A genuinely NEW final (next provider turn) still flows.
      await dictate(dg, 'Circuit 3 R1 plus R2 is nought point two.');
      expect(m.diag('a02d_final_window')).toHaveLength(2);
      expect(m.sonnet().sentTranscripts).toHaveLength(2);
    });

    it('[invariant] identity is never the transcript: two DISTINCT provider finals with identical text (different turn_index) both execute; frames with NO provider identity (no turn_index, no audio_window_end) are never deduped even when byte-identical', async () => {
      const m = await mount(makeCalcJob());
      const dg = m.dg();
      const localCount = () =>
        m.harness.jobChanges.filter((c) => c.source === 'local_command').length;
      // Distinct turns, identical text: the inspector genuinely repeats.
      await dictate(dg, 'calculate Zs for circuit 4');
      await act(async () => {
        dg.advanceDispatchedStream(1);
      });
      await dictate(dg, 'calculate Zs for circuit 4');
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(0);
      expect(m.diag('a02d_final_window')).toHaveLength(2);
      // Both EXECUTED locally: the first computes and writes, the second
      // runs too and speaks its own outcome (the value is already recorded).
      expect(localCount()).toBe(1);
      expect(m.harness.tts.played.map((p) => p.text)).toEqual([
        'Circuit 4, Zs calculated as 0.55 ohms',
        'Zs for circuit 4 is already recorded — say a new reading to replace it.',
      ]);
      // Frames carrying NO provider identity: byte-identical deliveries are
      // still two finals (null identity never dedupes) — only a provider-
      // minted identity can say "same final".
      const bare = {
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'Circuit 3 R1 plus R2 is nought point two.',
        end_of_turn_confidence: 0.9,
        words: [],
      };
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.emitSpeechStarted();
        dg.emitFrame(bare);
        vi.advanceTimersByTime(700);
      });
      await act(async () => {
        dg.emitFrame(bare);
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(0);
      expect(m.diag('a02d_final_window')).toHaveLength(4);
      expect(
        m
          .diag('a02d_final_window')
          .slice(-2)
          .every((d) => d.payload.providerFinalId === null)
      ).toBe(true);
      expect(m.sonnet().sentTranscripts).toHaveLength(2);
      // PARTIAL tuples are no identity either: a lone shared `turn_index`,
      // or a lone shared `audio_window_end`, never makes two finals collide.
      for (const partial of [{ turn_index: 7 }, { audio_window_end: 3.5 }]) {
        const windowsBefore = m.diag('a02d_final_window').length;
        const sentBefore = m.sonnet().sentTranscripts.length;
        const frame = { ...bare, transcript: 'Circuit 1 Zs is nought point four.', ...partial };
        await act(async () => {
          dg.advanceDispatchedStream(1);
          dg.noteLocalSpeechOnset();
          dg.emitSpeechStarted();
          dg.emitFrame(frame);
          vi.advanceTimersByTime(700);
        });
        await act(async () => {
          dg.emitFrame(frame);
          vi.advanceTimersByTime(700);
        });
        expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(0);
        expect(m.diag('a02d_final_window')).toHaveLength(windowsBefore + 2);
        expect(
          m
            .diag('a02d_final_window')
            .slice(-2)
            .every((d) => d.payload.providerFinalId === null)
        ).toBe(true);
        expect(m.sonnet().sentTranscripts).toHaveLength(sentBefore + 2);
      }
      // The COMPLETE pair, redelivered, is still dropped.
      await act(async () => {
        dg.advanceDispatchedStream(1);
        dg.noteLocalSpeechOnset();
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 2 Zs is nought point five.');
        vi.advanceTimersByTime(700);
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(1);
    });

    it('[invariant] duplicate delivery of a LOCALLY executed command, inside and after the burst window: one mutation, one spoken result, nothing sent', async () => {
      const m = await mount(makeCalcJob());
      const dg = m.dg();
      const localBefore = m.harness.jobChanges.filter((c) => c.source === 'local_command').length;
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('calculate Zs for circuit 4');
        vi.advanceTimersByTime(200);
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(1);
      expect(m.harness.jobChanges.filter((c) => c.source === 'local_command')).toHaveLength(
        localBefore + 1
      );
      expect(zsOf(m.jobRef.current!, '4')).toBe('0.55');
      expect(m.harness.tts.played.filter((p) => /0\.55/.test(p.text))).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      await act(async () => {
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(2);
      expect(m.harness.jobChanges.filter((c) => c.source === 'local_command')).toHaveLength(
        localBefore + 1
      );
      expect(m.harness.tts.played.filter((p) => /0\.55/.test(p.text))).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
    });

    it('[invariant] a duplicate delivery AFTER the clarification played to completion speaks nothing more (the disclosed key is remembered); a genuinely new held final still speaks', async () => {
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
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      // Instant players: the line has already played to completion.
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      expect(__heldFragmentClarificationStateForTests().outstanding).toBeNull();
      await act(async () => {
        dg.emitDuplicateOfLastEndOfTurn();
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_duplicate_dropped')).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.clarifications()).toHaveLength(1);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      expect(__heldFragmentClarificationStateForTests().held).toBe(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(zsOf(m.jobRef.current!, '4')).toBe('');
      // A NEW final (a different provider turn) that is ALSO stale under the
      // still-applying cutoff — here `unbounded` (no confirmed onset) — is
      // its own obligation and speaks once more.
      dg.autoConfirmOnset = false;
      await act(async () => {
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      // Two hold decisions (the duplicate never reached the hold); two
      // obligations; two lines.
      expect(m.diag('a02d_final_held')).toHaveLength(2);
      expect(m.clarifications()).toHaveLength(2);
      expect(__heldFragmentClarificationStateForTests().held).toBe(2);
    });

    /** Settle queued TTS and the post-playback sender gate. */
    async function settleTts(dg: FakeDeepgramService) {
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          vi.advanceTimersByTime(600);
          await Promise.resolve();
        });
        if (dg.dispatchedStreamOffset > 0) break;
      }
      __resetTtsWindowForTests();
    }

    it('[invariant] hold ordering — a pre-cutoff LOCAL Calculate runs nothing (no mutation, no read-back, no send); the post-tap repeat computes and speaks exactly once', async () => {
      const m = await mount(makeCalcJob());
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.9');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      const localBefore = m.harness.jobChanges.filter((c) => c.source === 'local_command').length;
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('calculate Zs for circuit 4');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.harness.jobChanges.filter((c) => c.source === 'local_command')).toHaveLength(
        localBefore
      );
      expect(zsOf(m.jobRef.current!, '4')).toBe('');
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.harness.tts.played.filter((p) => /0\.55/.test(p.text))).toHaveLength(0);
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      // Post-tap repeat: the local calculator runs (Ze 0.35 + R1+R2 0.20).
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'calculate Zs for circuit 4');
      expect(m.harness.jobChanges.filter((c) => c.source === 'local_command')).toHaveLength(
        localBefore + 1
      );
      expect(zsOf(m.jobRef.current!, '4')).toBe('0.55');
      expect(m.harness.tts.played.filter((p) => /0\.55/.test(p.text))).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(1);
    });

    it('[invariant] hold ordering — a pre-cutoff board-switch phrase is held (nothing forwarded, no board change); the post-tap repeat is forwarded as an ordinary transcript', async () => {
      const m = await mount(makeTwoBoardJob());
      const dg = m.dg();
      await manualEditRow(m.jobRef.current!, 'c4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualEditRow(m.jobRef.current!, 'c4', 'measured_zs_ohm', '');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Switch to the garage board.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.harness.chimes.count).toBe(0);
      expect(m.diag('current_board_changed_received')).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(1);
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'Switch to the garage board.');
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      expect(m.sonnet().sentTranscripts[0].text.toLowerCase()).toContain('garage');
    });

    it('[invariant] hold ordering — a pre-cutoff answer to a LEGACY server question is held and consumes nothing (the question stays armed); the post-tap repeat answers it with the in-response-to context', async () => {
      const m = await mount();
      const dg = m.dg();
      await act(async () => {
        m.sonnet().emitQuestion({
          question: 'Is that a code two?',
          question_type: 'clarification',
        });
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });
      await settleTts(dg);
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Yes.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(1);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(1);
      await act(async () => {
        dg.advanceDispatchedStream(2);
      });
      await dictate(dg, 'Yes.');
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      const options = m.sonnet().sentTranscripts[0].options as {
        inResponseTo?: { question: string };
      };
      expect(options.inResponseTo?.question).toBe('Is that a code two?');
    });

    it('[invariant] 500 ms burst release: a tap between two finals of one burst holds the released dispatch WHOLE (two constituents), naming only the cleared destination', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(4);
      });
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(200); // inside the 500 ms burst window
      });
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      await manualClear(m.jobRef.current!, '4');
      dg.autoConfirmOnset = false; // same run: no new onset
      await act(async () => {
        dg.emitEndOfTurn('and circuit 3 R1 plus R2 is nought point two.');
        vi.advanceTimersByTime(700);
      });
      const held = m.diag('a02d_final_held');
      expect(held).toHaveLength(1);
      expect(held[0].payload.constituents).toBe(2);
      expect(m.sonnet().sentTranscripts).toHaveLength(0);
      expect(m.regexWrites()).toHaveLength(0);
      expect(r1r2Of(m.jobRef.current!, '3')).toBeUndefined();
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
    });

    it('[invariant] FIFO overflow pressure never evicts the prepared clarification (protected): it plays exactly once after the pressure', async () => {
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
      // Overflow pressure while the clarification is prepared but deferred.
      for (let n = 0; n < MAX_QUEUE_DEPTH + 3; n++) {
        await act(async () => {
          m.sonnet().emitRaw({
            type: 'extraction',
            result: {
              readings: [{ circuit: 2, field: 'measured_zs_ohm', value: `0.4${n}` }],
              confirmations: [{ field: 'measured_zs_ohm', circuit: 2, text: `Confirmation ${n}` }],
            },
          });
        });
      }
      expect(m.diag('tts_queue_overflow').length).toBeGreaterThan(0);
      for (let i = 0; i < MAX_QUEUE_DEPTH + 6; i++) {
        await act(async () => {
          m.harness.tts.releaseAll();
          vi.advanceTimersByTime(100);
          await Promise.resolve();
        });
      }
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      expect(__heldFragmentClarificationStateForTests().outstanding).toBeNull();
    });

    it('[invariant] TTS unavailable at delivery: the token is parked and retried after 2 s, then plays exactly once', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      const player = m.harness.services.ttsConfirmationPlayer;
      m.harness.services.ttsConfirmationPlayer = undefined; // no engine at all
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_clarification_unavailable')).toHaveLength(1);
      expect(m.clarifications()).toHaveLength(0);
      expect(__heldFragmentClarificationStateForTests().outstanding?.state).toBe('pending');
      m.harness.services.ttsConfirmationPlayer = player;
      await act(async () => {
        vi.advanceTimersByTime(2100);
        await Promise.resolve();
      });
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
    });

    it('[invariant] playback failure re-parks the same token (wording kept) and replays it after 1.5 s: exactly one completed line', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      m.harness.tts.failNextPlayback = true;
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.harness.tts.failed).toEqual([CLARIFY_ONE]);
      expect(m.diag('a02d_clarification_reparked')).toHaveLength(1);
      expect(m.clarifications()).toHaveLength(0);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(1600);
        await Promise.resolve();
      });
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(1);
      expect(__heldFragmentClarificationStateForTests().held).toBe(1);
    });

    it('[invariant] prepared-but-deferred text freeze: a second held final after the wording is frozen (enqueued, not yet played) awaits a SUCCESSOR with its own wording', async () => {
      const m = await mount();
      const dg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await manualSet(m.jobRef.current!, '3', 'r1_r2_ohm', '0.2');
      // An accepted final after the seeds: their replacement cutoffs no
      // longer apply, so the first hold names circuit 4 alone.
      await dictate(dg, 'Nothing to report yet.');
      m.harness.tts.manual = true;
      await act(async () => {
        dg.advanceDispatchedStream(1);
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      // Enqueued → wording frozen; the manual player has not played it.
      const first = __heldFragmentClarificationStateForTests().outstanding;
      expect(first?.frozenText).toBe(CLARIFY_ONE);
      expect(m.clarifications()).toHaveLength(0);
      await manualClear(m.jobRef.current!, '3', 'r1_r2_ohm');
      dg.autoConfirmOnset = false;
      await act(async () => {
        dg.emitEndOfTurn('Circuit 3 R1 plus R2 is nought point two.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_clarification_awaiting')).toHaveLength(1);
      expect(__heldFragmentClarificationStateForTests().outstanding?.frozenText).toBe(CLARIFY_ONE);
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          m.harness.tts.releaseAll();
          vi.advanceTimersByTime(100);
          await Promise.resolve();
        });
      }
      expect(m.clarifications().map((p) => p.text)).toEqual([CLARIFY_ONE, CLARIFY_TWO]);
      expect(__heldFragmentClarificationStateForTests().spoken).toBe(2);
    });

    it('[invariant] UNOWNED reconnect: the socket dies under the client and reopens under a new epoch — a late old-socket final is dropped, ZERO audio is re-sent, epoch-1 cutoffs do not apply to epoch 2, settlement survives, and a fresh reading applies', async () => {
      const m = await mount(makeJob(), { deepgram: 'reconnectable' });
      const dg = m.dg();
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      const epoch1 = dg.liveEpoch;
      if (lane.env !== '1') await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.advanceDispatchedStream(4);
      });
      await manualClear(m.jobRef.current!, '4');
      // The socket dies under the client (not a close the client owns).
      await act(async () => {
        dg.emitUnownedClose();
      });
      await act(async () => {
        vi.advanceTimersByTime(1500); // past the first backoff
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(dg.connectionState).toBe('connected');
      expect(dg.sockets).toHaveLength(2);
      expect(dg.liveEpoch).not.toBe(epoch1);
      expect(dg.sentTaggedAudioBlocks).toBe(0); // replay retired: nothing re-sent
      // A late final from the DEAD socket (epoch 1): dropped at admission.
      const windowsBefore = m.diag('a02d_final_window').length;
      await act(async () => {
        dg.emitFrameOnSocket(0, {
          type: 'TurnInfo',
          event: 'EndOfTurn',
          transcript: 'Circuit 4 Zs is nought point three five.',
          end_of_turn_confidence: 0.9,
          audio_window_end: 9.0,
          turn_index: 99,
          words: [],
        });
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_window')).toHaveLength(windowsBefore);
      expect(m.diag('a02d_final_dropped_at_admission')).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.sonnet().sentTranscripts).toHaveLength(1);
      // A fresh reading on epoch 2: the epoch-1 manual cutoff does not
      // apply (its epoch is not this one), the settled epoch-1 occurrence
      // does not rewrite, and the new dictation applies once.
      await dictate(dg, 'Circuit 4 Zs is nought point four.');
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.sonnet().sentTranscripts).toHaveLength(2);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.4');
      const last = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
      expect(last.fresh).toEqual(['circuit.c4.measured_zs_ohm']);
      expect(m.clarifications()).toHaveLength(0);
      expect(
        m.harness.tts.played.filter((p) => p.text === UPLINK_LOSS_DISCLOSURE_TEXT)
      ).toHaveLength(0);
    });

    it('[invariant] rapid stop/start on the SAME job: a pre-stop cutoff never holds a post-start final, the old session’s late final is dropped, and the new session writes afresh', async () => {
      const m = await mount();
      const oldDg = m.dg();
      await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        oldDg.noteLocalSpeechOnset();
        oldDg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      await act(async () => {
        m.apiRef.current!.stop();
      });
      await act(async () => {
        await m.apiRef.current!.start();
      });
      const dg = m.dg();
      expect(dg).not.toBe(oldDg);
      // The old session's in-flight final (its onset preceded the tap).
      await act(async () => {
        oldDg.emitEndOfTurn('Circuit 4 Zs is nought point three five.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_dropped_at_admission')).toHaveLength(1);
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(0);
      // The new session: no cutoff carried over; the first reading writes.
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      if (lane.env === '1') expect(zsOf(m.jobRef.current!, '4')).toBe('0.35');
      const last = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload;
      expect(last.fresh).toEqual(['circuit.c4.measured_zs_ohm']);
    });

    it('[invariant] a DIFFERENT job mid-session resets everything: a pre-switch cutoff never holds, the previous job’s overlap never writes into the new job', async () => {
      const m = await mount();
      const dg = m.dg();
      await dictate(dg, 'Circuit 4 Zs is nought point three five.');
      if (lane.env !== '1') await manualSet(m.jobRef.current!, '4', 'measured_zs_ohm', '0.35');
      await act(async () => {
        dg.noteLocalSpeechOnset();
        dg.advanceDispatchedStream(10);
      });
      await manualClear(m.jobRef.current!, '4');
      const other = { ...makeJob(), id: 'job_other', job_id: 'job_other' } as JobDetail;
      await act(async () => {
        m.jobRef.current!.setJob(other);
      });
      expect(
        m
          .diag('conversation_admission_matcher_reset')
          .some((d) => d.payload.boundary === 'job_change')
      ).toBe(true);
      // Unrelated speech after the switch: the old overlap is gone — nothing
      // is rescanned into the new job, and the old cutoff does not hold.
      dg.autoConfirmOnset = false;
      await act(async () => {
        dg.emitEndOfTurn('Nothing to report in the hallway.');
        vi.advanceTimersByTime(700);
      });
      expect(m.diag('a02d_final_held')).toHaveLength(0);
      expect(m.clarifications()).toHaveLength(0);
      expect(zsOf(m.jobRef.current!, '4')).toBeUndefined();
      const decisions = m.diag('a02d_occurrence_decisions').slice(-1)[0].payload
        .decisions as Record<string, number>;
      expect(decisions.fresh ?? 0).toBe(0);
    });

    it('[invariant] old-service finals are dropped at the admission boundary after pause (inside the 300 ms close grace) and after stop (session replacement): zero sends, zero holds, zero clarifications', async () => {
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

    it('[invariant] session stop abandons a pending clarification token — nothing is spoken into the next session', async () => {
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

    it('[invariant] an A02B bypass boundary (a question) is forwarded directly and resets only matcher text; cutoffs are provider state, not matcher state', async () => {
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

    it('[invariant] replay retired: automatic full sleep → resume re-sends ZERO audio, charges the ring as E2 staged loss, the E2 disclosure speaks once, the cleared field stays empty, and a fresh identical dictation applies once', async () => {
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
