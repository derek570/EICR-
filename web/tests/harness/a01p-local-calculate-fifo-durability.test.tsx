/**
 * A01P (Codex EP cycle-1) — local Calculate read-backs are DURABLE in the
 * confirmation FIFO. A calculation has already mutated the job when its
 * read-back is enqueued and no server replay exists to restore local-only
 * speech, so the read-back gets the protected / re-parking treatment the
 * mode-status family gives (tts.ts `createProtectedOutcomeFamily`):
 *   - never evicted by `MAX_QUEUE_DEPTH` overflow (drop-oldest skips it);
 *   - re-parked when a preempting direct prompt destroys it before it played;
 *   - retired at playback start (latency stamp resolved) or on a terminal
 *     playback failure (stamp dropped) — never re-tried forever.
 *
 * Uses a MANUAL player: `onEnd` is held back so a head is genuinely PLAYING
 * while later items queue behind it (FakeTtsPlayers completes synchronously,
 * which never exercises queue pressure). Runs under regex hints ON, OFF and
 * UNSET.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue, MAX_QUEUE_DEPTH } from '@/lib/recording/tts-queue';
import type { QueuePlayControls } from '@/lib/recording/tts-queue';
import {
  setConfirmationModeEnabled,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  __resetModeStatusCuesForTests,
  handleLocalCommandOutcomeDiscard,
  speakLocalCommandOutcome,
  __isLocalCommandOutcomePendingForTests,
} from '@/lib/recording/tts';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const CALC_LINE = 'Circuit 1, Zs calculated as 0.55 ohms';

function makeJob(): JobDetail {
  return {
    id: 'job_fifo_1',
    job_id: 'job_fifo_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    boards: [{ id: 'main', designation: 'Main', board_type: 'main' }],
    supply_characteristics: { ze: '0.35' },
    circuits: [
      {
        id: 'row-1',
        circuit_ref: '1',
        designation: 'Cooker',
        circuit_designation: 'Cooker',
        r1_r2_ohm: '0.20',
      },
      {
        id: 'row-2',
        circuit_ref: '2',
        designation: 'Lights',
        circuit_designation: 'Lights',
        r1_r2_ohm: '0.30',
      },
    ],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

/** Manual confirmation player: real `onStart` at play, `onEnd` held until the
 *  test ends the head — so a head is genuinely PLAYING while items queue. */
class ManualPlayer {
  readonly started: string[] = [];
  readonly discarded: string[] = [];
  private readonly ends: Array<() => void> = [];
  readonly play = (text: string, controls: QueuePlayControls): void => {
    controls.ready({
      play: () => {
        this.started.push(text);
        controls.onStart();
        this.ends.push(controls.onEnd);
      },
      discard: () => {
        this.discarded.push(text);
      },
    });
  };
  /** End the oldest playing head. */
  endHead(): boolean {
    const end = this.ends.shift();
    if (!end) return false;
    end();
    return true;
  }
  drain(): void {
    for (let i = 0; i < 20 && this.endHead(); i++) {
      /* keep ending until nothing is playing */
    }
  }
  private base = 0;
  /** Everything started from now on is the scenario under test. */
  mark(): void {
    this.base = this.started.length;
  }
  get scenarioStarted(): string[] {
    return this.started.slice(this.base);
  }
}

const HINTS_MODES: Array<['1' | '0' | 'unset', string]> = [
  ['1', 'ON'],
  ['0', 'OFF'],
  ['unset', 'UNSET'],
];
const ORIGINAL_HINTS = process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED;

describe('[invariant] A01P — local Calculate read-back durability in the FIFO (manual player)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    __resetModeStatusCuesForTests();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
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
    vi.unstubAllEnvs();
    if (ORIGINAL_HINTS === undefined) delete process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED;
    else process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED = ORIGINAL_HINTS;
  });

  function setHints(mode: '1' | '0' | 'unset') {
    if (mode === 'unset') delete process.env.NEXT_PUBLIC_REGEX_HINTS_ENABLED;
    else vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', mode);
  }

  async function mountAndStart(player: ManualPlayer) {
    const harness = buildHarnessServices();
    harness.services.ttsConfirmationPlayer = player.play;
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
    // With extra prompts OFF the session-start status cue ("Extra prompts are
    // off. Readings still spoken.") is the first FIFO head; play it out so the
    // scenario below starts from an idle queue, and read `started` from here.
    await act(async () => {
      player.drain();
    });
    player.mark();
    return harness;
  }

  const confirmation = (n: number) => ({
    readings: [{ circuit: 2, field: 'measured_zs_ohm', value: `0.4${n}` }],
    confirmations: [{ field: 'measured_zs_ohm', circuit: 2, text: `Confirmation ${n}` }],
  });

  async function dictateCalculate(harness: ReturnType<typeof buildHarnessServices>) {
    await act(async () => {
      harness.refs.deepgram!.emitSpeechStarted();
      harness.refs.deepgram!.emitEndOfTurn('calculate Zs for circuit 1');
      vi.advanceTimersByTime(700);
    });
  }

  const diag = (harness: ReturnType<typeof buildHarnessServices>, category: string) =>
    harness.diagnostics.filter((d) => d.category === category);

  for (const [mode, label] of HINTS_MODES) {
    it(`hints ${label}: a PLAYING head + a QUEUED head, then Calculate, then OVERFLOW pressure — ordered starts, the calculation read-back exactly once`, async () => {
      setHints(mode);
      const player = new ManualPlayer();
      const harness = await mountAndStart(player);
      const sonnet = harness.refs.sonnet!;

      // Head A starts (manual: stays PLAYING); B queues behind it.
      await act(async () => {
        sonnet.emitExtraction(confirmation(1));
      });
      expect(player.scenarioStarted).toEqual(['Confirmation 1']);
      await act(async () => {
        sonnet.emitExtraction(confirmation(2));
      });
      expect(player.scenarioStarted).toEqual(['Confirmation 1']);

      // The local Calculate mutates the job and queues its read-back (protected).
      await dictateCalculate(harness);
      expect(harness.jobChanges.some((c) => c.source === 'local_command')).toBe(true);
      expect(harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
      expect(player.scenarioStarted).toEqual(['Confirmation 1']);

      // Overflow pressure: push well past MAX_QUEUE_DEPTH while A still plays.
      for (let n = 3; n < 3 + MAX_QUEUE_DEPTH + 2; n++) {
        await act(async () => {
          sonnet.emitExtraction(confirmation(n));
        });
      }
      expect(harness.diagnostics.some((d) => d.category === 'tts_queue_overflow')).toBe(true);
      // The calculation was never the overflow victim.
      expect(diag(harness, 'local_calculate_readback_discarded')).toEqual([]);

      // Let every head play out.
      await act(async () => {
        player.drain();
        await Promise.resolve();
      });
      await act(async () => {
        player.drain();
      });

      expect(player.scenarioStarted[0]).toBe('Confirmation 1');
      expect(player.scenarioStarted.filter((t) => t === CALC_LINE)).toHaveLength(1);
      expect(player.scenarioStarted.indexOf(CALC_LINE)).toBeGreaterThan(0);
      // Every played text exactly once (no duplicate delivery of anything).
      expect(new Set(player.scenarioStarted).size).toBe(player.scenarioStarted.length);
      // Latency resolved at the REAL playback start, exactly once.
      const latency = diag(harness, 'local_calculate_playback_started');
      expect(latency).toHaveLength(1);
      expect(typeof latency[0].payload.latencyMs).toBe('number');
    });

    it(`hints ${label}: a preempting direct prompt destroys the queued calculation read-back → re-parked, then delivered exactly once`, async () => {
      setHints(mode);
      const player = new ManualPlayer();
      const harness = await mountAndStart(player);
      const sonnet = harness.refs.sonnet!;

      await act(async () => {
        sonnet.emitExtraction(confirmation(1));
      });
      await dictateCalculate(harness);
      expect(player.scenarioStarted).toEqual(['Confirmation 1']);

      // A direct ask preempts the FIFO (preemptFlush discards every waiter).
      await act(async () => {
        sonnet.emitQuestion({
          question: 'Which board is that on?',
          question_type: 'clarification',
          tool_call_id: 'toolu_fifo',
        });
        await Promise.resolve(); // the re-park microtask
      });
      const discards = diag(harness, 'local_calculate_readback_discarded');
      expect(discards).toHaveLength(1);
      expect(discards[0].payload.outcome).toBe('reparked');
      expect(discards[0].payload.reason).toBe('preempt');

      await act(async () => {
        player.drain();
        await Promise.resolve();
      });
      await act(async () => {
        player.drain();
      });
      expect(player.scenarioStarted.filter((t) => t === CALC_LINE)).toHaveLength(1);
      expect(diag(harness, 'local_calculate_playback_started')).toHaveLength(1);
    });
  }

  it('a terminal playback failure RETIRES the read-back (no infinite retry) and its tracking entry', () => {
    const queued = speakLocalCommandOutcome(CALC_LINE);
    expect(queued.enqueued).toBe(false); // no TTS backend / no harness player here
    // Family semantics directly (the recording-context hook maps `retired`
    // to dropping the latency stamp): lifecycle discards re-park, a playback
    // error retires.
    __setRecordingTestServices(buildHarnessServices().services);
    const live = speakLocalCommandOutcome(CALC_LINE);
    expect(live.enqueued).toBe(true);
    expect(__isLocalCommandOutcomePendingForTests(live.dedupeKey!)).toBe(true);
    expect(handleLocalCommandOutcomeDiscard(live.dedupeKey!, 'playback_error')).toBe('retired');
    expect(__isLocalCommandOutcomePendingForTests(live.dedupeKey!)).toBe(false);
    expect(handleLocalCommandOutcomeDiscard(live.dedupeKey!, 'preempt')).toBe(false);
  });
});
