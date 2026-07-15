/**
 * B4 — headless replay runner (pwa-replay-harness Wave 3).
 *
 * Mounts the REAL RecordingProvider (B0 recipe) with the B1 seams, feeds a
 * scenario's transcript timeline through the fake Deepgram service as
 * Flux-shaped events under vitest fake timers, emits scripted backend
 * frames (mock mode, B3) when the pipeline's sends match `mock_frames`
 * entries, and returns the collected behavioural trace + final job state.
 *
 * ENV DEFAULT: `NEXT_PUBLIC_REGEX_HINTS_ENABLED='1'` (prod parity —
 * deploy.yml sets it in all three build stages; the vitest default would
 * otherwise be the hints-OFF dev path, whose job-state diffs omit every
 * regex-tier fill and would make recorded-session replays
 * non-reproducible). A per-scenario `env.regex_hints` override allows
 * hints-OFF coverage of the A3 shadow-map path. Recorded-session replays
 * (WS-C) MUST run hints-ON.
 *
 * MOCK-FRAME PROVENANCE RULE (B3): mock frames come from the scenario's
 * `mock_frames` (hand-written or reconstructed from SERVER-ORIGIN iOS log
 * events only). Regex-category client events must NEVER become mock
 * frames — that would feed a client regex write back as fake backend
 * output and mask exactly the A3 bug class (see
 * mock-frame-provenance.test.ts).
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { vi } from 'vitest';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import {
  setConfirmationModeEnabled,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
} from '@/lib/recording/tts';
import type { JobDetail } from '@/lib/types';
import { buildHarnessServices } from './fake-services';
import { TraceCollector, type BehaviouralTrace } from './trace';
import {
  mockFramesForSentText,
  scenarioJob,
  synthesiseInterims,
  type MockFrame,
  type ReplayScenario,
} from './scenario';

export interface ReplayResult {
  trace: BehaviouralTrace;
  /** Raw sent transcripts (post-normalisation) for send-count assertions.
   *  Applied-field value assertions read `trace.utterances[].appliedFields`
   *  (the job-state observer's flattened patches) — the provider doesn't
   *  expose the JobProvider's doc through useRecording(). */
  sentTranscripts: string[];
}

export interface ReplayOptions {
  /**
   * B3 backend modes.
   * - `mock` (default): scripted frames from the scenario's `mock_frames`
   *   via the fake SonnetSession — deterministic, zero tokens; the per-PR
   *   CI lane.
   * - `live`: the REAL SonnetSession against a locally running backend
   *   (`NEXT_PUBLIC_API_URL`, default localhost:3000). Auth: set
   *   `PWA_REPLAY_TOKEN` (a JWT minted via the voice-test /
   *   harness-mint-jwt pattern) — the runner writes it to the `cm_token`
   *   localStorage slot SonnetSession reads. Real extraction is
   *   nondeterministic → loose-lane assertions only (plan §2.5); runs
   *   under REAL timers with wall-clock waits. Used by the nightly lane
   *   (`run-cheap.sh` Haiku env), never per-PR.
   */
  mode?: 'mock' | 'live';
  /** live mode: ms to wait for backend frames after each send. */
  liveTurnTimeoutMs?: number;
}

type RecordingApi = ReturnType<typeof useRecording>;

function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

/** Tail time after the last utterance so trailing timers (2s pending-ask,
 *  500ms burst, watchdogs) all fire before the trace is finalised. */
const TRAILING_MS = 6_000;
/** Burst-buffer flush margin after each EndOfTurn. */
const DISPATCH_FLUSH_MS = 700;

export async function replayScenario(
  scenario: ReplayScenario,
  options: ReplayOptions = {}
): Promise<ReplayResult> {
  const mode = options.mode ?? 'mock';
  // ── env (prod parity default, per-scenario override) ──
  const hints = scenario.env?.regex_hints ?? '1';
  vi.stubEnv('NEXT_PUBLIC_REGEX_HINTS_ENABLED', hints);
  if (mode === 'mock') {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
  } else {
    // live mode — real fetch + real WS to the local backend; auth token
    // into the slot SonnetSession's getToken() reads.
    const token = process.env.PWA_REPLAY_TOKEN;
    if (!token) throw new Error('live mode requires PWA_REPLAY_TOKEN (harness-mint-jwt)');
    window.localStorage.setItem('cm_token', token);
  }
  setConfirmationModeEnabled(true);
  resetTtsQueue();
  // Cross-scenario hygiene: echo fingerprints/window are tts.ts module
  // state with a 15s wall-clock TTL — under back-to-back replays a
  // confirmation spoken in scenario N-1 ("Circuit 1, Zs 0.35") would make
  // scenario N's dictation ("Circuit 1 Zs is 0.35.") look like TTS echo
  // and silently discard the final (found by the Wave-5 sweep).
  __resetTtsFingerprintsForTests();
  __resetTtsWindowForTests();

  const collector = new TraceCollector();
  const harness = buildHarnessServices();
  if (mode === 'live') {
    // Real SonnetSession: recording-context falls through to `new
    // SonnetSession(...)` when no factory is registered. Deepgram stays
    // FAKE in both modes (the harness feeds text frames, never audio).
    delete harness.services.sonnetSessionFactory;
  }
  // Route the seam hooks into the trace collector (B2's three sources).
  harness.services.diagnosticTap = collector.onDiagnostic;
  harness.services.jobStateObserver = collector.onJobChange;
  harness.services.chime = () => {
    collector.onChime();
  };
  const basePlayer = harness.services.ttsConfirmationPlayer!;
  harness.services.ttsConfirmationPlayer = (text, controls) => {
    basePlayer(text, {
      ...controls,
      onStart: () => {
        collector.onTtsPlayed('confirmation', text);
        controls.onStart();
      },
    });
  };
  const baseDirect = harness.services.ttsDirectSpeak!;
  harness.services.ttsDirectSpeak = (text, options) => {
    collector.onTtsPlayed('direct', text);
    baseDirect(text, options);
  };
  __setRecordingTestServices(harness.services);
  setDiagnosticTap(collector.onDiagnostic);

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  const apiRef: { current: RecordingApi | null } = { current: null };

  // mock mode runs on fake timers (deterministic, instant); live mode
  // needs the real event loop for WS I/O, so gaps are wall-clock waits
  // capped to keep the nightly lane's runtime sane (loose lanes only).
  const useFakeTimers = mode === 'mock';
  const LIVE_GAP_CAP_MS = 1_500;
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      if (useFakeTimers) {
        vi.advanceTimersByTime(ms);
      } else {
        await new Promise((r) => setTimeout(r, Math.min(ms, LIVE_GAP_CAP_MS)));
      }
    });
  };
  if (useFakeTimers) vi.useFakeTimers();
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <JobProvider initial={scenarioJob(scenario)}>
          <RecordingProvider>
            <Probe apiRef={apiRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    if (!apiRef.current) throw new Error('RecordingProvider probe did not mount');
    await act(async () => {
      await apiRef.current!.start();
    });
    if (apiRef.current.state !== 'active') {
      throw new Error(`start() did not reach active state (got ${apiRef.current.state})`);
    }
    const dg = harness.refs.deepgram!;
    const sonnet = harness.refs.sonnet; // null in live mode (real session)
    let emittedFrameCount = 0;

    const emitMockFrames = async () => {
      if (!sonnet) return; // live mode — the real backend answers
      // Emit scripted backend frames for any newly-sent transcript.
      while (emittedFrameCount < sonnet.sentTranscripts.length) {
        const sent = sonnet.sentTranscripts[emittedFrameCount];
        emittedFrameCount += 1;
        const frames = mockFramesForSentText(scenario, sent.text);
        if (!frames) continue;
        for (const frame of frames) {
          await act(async () => {
            emitFrame(sonnet, frame);
          });
        }
      }
    };

    let clock = 0;
    for (const entry of scenario.transcript) {
      const target = Math.max(entry.at_ms, clock);
      if (target > clock) {
        await advance(target - clock);
        clock = target;
      }
      await act(async () => {
        dg.emitSpeechStarted();
      });
      for (const interim of synthesiseInterims(entry.text)) {
        await act(async () => {
          dg.emitInterim(interim);
        });
        await advance(300);
        clock += 300;
      }
      await act(async () => {
        dg.emitEndOfTurn(entry.text);
      });
      await advance(DISPATCH_FLUSH_MS);
      clock += DISPATCH_FLUSH_MS;
      await emitMockFrames();
      if (mode === 'live') {
        // Wait for the backend's turn to land (extraction / question) —
        // bounded, best-effort; loose-lane assertions tolerate misses.
        const deadline = Date.now() + (options.liveTurnTimeoutMs ?? 15_000);
        const seenExtractions = () =>
          collector
            .finalize()
            .utterances.reduce(
              (n, u) => n + u.events.filter((e) => e.kind === 'onExtraction_entered').length,
              0
            );
        const before = seenExtractions();
        while (Date.now() < deadline && seenExtractions() === before) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    // Trailing window — let the 2s pending-ask (and any deferred drains)
    // fire, then collect.
    await advance(TRAILING_MS);
    await emitMockFrames();

    return {
      trace: collector.finalize(),
      sentTranscripts: sonnet
        ? sonnet.sentTranscripts.map((t) => t.text)
        : collector
            .finalize()
            .utterances.filter((u) => u.sonnetSent)
            .map((u) => u.text),
    };
  } finally {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    __resetTtsFingerprintsForTests();
    __resetTtsWindowForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
}

function emitFrame(
  sonnet: NonNullable<ReturnType<typeof buildHarnessServices>['refs']['sonnet']>,
  frame: MockFrame
): void {
  if (frame.type === 'extraction') {
    sonnet.emitExtraction({
      readings: frame.readings ?? [],
      confirmations: frame.confirmations ?? [],
      field_clears: [],
      circuit_updates: [],
      observations: [],
      validation_alerts: [],
    });
  } else if (frame.type === 'question') {
    if (frame.tool_call_id) sonnet.setInFlightToolCallId(frame.tool_call_id);
    sonnet.emitQuestion({
      question: frame.question ?? '',
      question_type: frame.question_type ?? 'clarification',
      tool_call_id: frame.tool_call_id ?? null,
    });
  } else if (frame.type === 'field_corrected') {
    // Stage 6 STI-05 clear_reading wire — A2 canonicalised-key pin.
    sonnet.emitFieldCorrected({
      circuit: frame.circuit ?? 0,
      field: frame.field ?? '',
    });
  }
}
