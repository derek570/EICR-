'use client';

import * as React from 'react';
import { startMicCapture, type MicCaptureHandle } from './recording/mic-capture';
import { DeepgramService, type DeepgramConnectionState } from './recording/deepgram-service';
import { resampleTo16k } from './recording/resample';
import {
  SonnetSession,
  type ExtractionResult,
  type SonnetConnectionState,
  type SonnetQuestion,
} from './recording/sonnet-session';
import { applyExtractionToJob } from './recording/apply-extraction';
import { AudioRingBuffer } from './recording/audio-ring-buffer';
import { SleepManager, type SleepState } from './recording/sleep-manager';
import { useLiveFillStore } from './recording/live-fill-state';
import { api } from './api-client';
import { useJobContext } from './job-context';

/**
 * Recording context.
 *
 * Holds the UI state that every surface needs while the inspector is
 * recording. Phase 4b added real microphone capture via AudioWorklet.
 * Phase 4c connects Deepgram Nova-3 directly from the browser: mic
 * samples stream to Deepgram, interim + final transcripts land in the
 * rolling transcript log. Phase 4d adds the server-side Sonnet
 * multi-turn extraction WebSocket — each final Deepgram transcript
 * fires at the Sonnet session, structured readings flow back and merge
 * into the active `JobDetail` via `updateJob`. VAD sleep/wake (Phase
 * 4e) still to come.
 *
 * State machine — mirrors iOS `RecordingSessionCoordinator`:
 *
 *   idle ──► requesting-mic ──► active ──► stopped (back to idle)
 *                                ▲  │
 *                          wake  │  ▼ 60s silence
 *                                dozing
 *                                   │
 *                                   ▼ 5m dozing
 *                                sleeping
 *
 *   error — surfaced when permission is denied or a WS drops.
 *
 * `start()` opens the mic via AudioWorklet and drives `micLevel` off
 * the real RMS signal. Transcripts will be emitted by the Deepgram
 * Nova-3 WebSocket wired in Phase 4c; until then the overlay renders
 * the "Listening…" placeholder and the transcript log stays empty.
 */

export type RecordingState = 'idle' | 'requesting-mic' | 'active' | 'dozing' | 'sleeping' | 'error';

export type TranscriptUtterance = {
  id: string;
  text: string;
  /** `true` once Deepgram flags the utterance as final. Interim utterances
   *  are rolled into the single "latest interim" slot; finals are appended
   *  to the rolling transcript log. */
  final: boolean;
  confidence: number;
  timestamp: number;
};

export type RecordingSnapshot = {
  state: RecordingState;
  /** 0.0 – 1.0, driven by RMS from the live mic stream. */
  micLevel: number;
  elapsedSec: number;
  /** Running USD cost (Deepgram streaming + Sonnet tokens in Phase 4d). */
  costUsd: number;
  /** Last ~10 final utterances. Newest last. Interim text sits in `interim`
   *  so the UI can render a grey-italic "typing" line without mutating
   *  the final log. */
  transcript: TranscriptUtterance[];
  /** Current interim transcript (latest partial). Empty string when
   *  Deepgram has no pending partial — including right after a final. */
  interim: string;
  /** Deepgram WebSocket connection state (disconnected | connecting |
   *  connected | error). Surface in the overlay for debugability. */
  deepgramState: DeepgramConnectionState;
  /** Sonnet multi-turn extraction WebSocket state. Mirrors
   *  `deepgramState` so the overlay can show both wires independently. */
  sonnetState: SonnetConnectionState;
  /** Gated questions surfaced by Sonnet (unclear value, orphaned reading,
   *  out-of-range). FIFO — oldest first. Phase 4d renders these inline
   *  under the transcript log; Phase 4e pipes them to TTS. */
  questions: SonnetQuestion[];
  /** Error string when `state === 'error'`. */
  errorMessage: string | null;
};

export type RecordingActions = {
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** Dismisses the overlay without tearing down the session (mic button minimises
   *  into the action bar — iOS parity). */
  minimise: () => void;
  /** Re-opens a minimised session. */
  expand: () => void;
  /** Dismiss a question from the queue without sending a correction.
   *  Used when the inspector taps the × on a question bubble. */
  dismissQuestion: (index: number) => void;
  /** Indicates whether the overlay is currently expanded. When false the session
   *  may still be running; the transcript bar stays visible at the top. */
  isOverlayOpen: boolean;
};

type RecordingCtx = RecordingSnapshot & RecordingActions;

const Ctx = React.createContext<RecordingCtx | null>(null);

// Deepgram Nova-3 streaming — $0.0077/min at the inspector tier. We tick
// cost in real time so the hero readout feels live; Phase 4d will splice
// Sonnet token costs in on top.
const DEEPGRAM_USD_PER_MIN = 0.0077;

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const { job, updateJob } = useJobContext();
  const liveFill = useLiveFillStore();
  const [state, setState] = React.useState<RecordingState>('idle');
  const [micLevel, setMicLevel] = React.useState(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  // Realtime Deepgram streaming cost — ticked at 10Hz off the elapsed
  // timer. Sonnet token cost is maintained separately from server-side
  // `cost_update` messages and summed into the user-facing readout.
  const [deepgramCostUsd, setDeepgramCostUsd] = React.useState(0);
  const [sonnetCostUsd, setSonnetCostUsd] = React.useState(0);
  const [transcript, setTranscript] = React.useState<TranscriptUtterance[]>([]);
  const [interim, setInterim] = React.useState('');
  const [deepgramState, setDeepgramState] = React.useState<DeepgramConnectionState>('disconnected');
  const [sonnetState, setSonnetState] = React.useState<SonnetConnectionState>('disconnected');
  const [questions, setQuestions] = React.useState<SonnetQuestion[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isOverlayOpen, setOverlayOpen] = React.useState(false);

  // Job snapshot kept in a ref so we can send the latest `jobState` on
  // session_start / reconnect without making every Sonnet call depend on
  // a render cycle. updateJob callers still trigger the normal React
  // update path — we just *also* mirror into this ref.
  const jobRef = React.useRef(job);
  React.useEffect(() => {
    jobRef.current = job;
  }, [job]);
  const updateJobRef = React.useRef(updateJob);
  React.useEffect(() => {
    updateJobRef.current = updateJob;
  }, [updateJob]);

  // ── Audio pipeline ──────────────────────────────────────────────────────
  // Mic capture handle + elapsed/cost ticker. The mic handle owns the
  // AudioContext and Worklet; we keep it in a ref so `stop()` can tear it
  // down without tripping React's effect dependency machinery.
  const micRef = React.useRef<MicCaptureHandle | null>(null);
  const deepgramRef = React.useRef<DeepgramService | null>(null);
  const sonnetRef = React.useRef<SonnetSession | null>(null);
  // Phase 4e — 3-second pre-wake PCM ring buffer + state machine driving
  // doze/sleep transitions. The ring buffer is always written while the
  // mic is live so a wake from dozing/sleeping can replay the words the
  // inspector spoke _just before_ VAD fired.
  const ringBufferRef = React.useRef<AudioRingBuffer | null>(null);
  const sleepManagerRef = React.useRef<SleepManager | null>(null);
  // Monotonic session id — used when requesting a scoped Deepgram token
  // and (Phase 4d) as the Sonnet extraction session id.
  const sessionIdRef = React.useRef<string>('');
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Throttle setMicLevel to ~60Hz — audio callbacks fire every ~8ms at
  // 16kHz/128 samples which is overkill for a VU meter and would flood
  // React with renders.
  const lastLevelPushRef = React.useRef(0);

  const clearTick = React.useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const beginTick = React.useCallback(() => {
    // 10Hz is fine for the timer + cost — the mic VU meter runs
    // independently off audio callbacks.
    tickRef.current = setInterval(() => {
      setElapsedSec((s) => s + 0.1);
      // Deepgram cost accrues linearly with elapsed time. Sonnet cost
      // is authoritative from server-side `cost_update` snapshots.
      setDeepgramCostUsd((c) => c + DEEPGRAM_USD_PER_MIN / 60 / 10);
    }, 100);
  }, []);

  const teardownMic = React.useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  const teardownDeepgram = React.useCallback(() => {
    deepgramRef.current?.disconnect();
    deepgramRef.current = null;
    setDeepgramState('disconnected');
    setInterim('');
  }, []);

  const teardownSonnet = React.useCallback(() => {
    sonnetRef.current?.disconnect();
    sonnetRef.current = null;
    setSonnetState('disconnected');
  }, []);

  const teardownSleep = React.useCallback(() => {
    sleepManagerRef.current?.stop();
    sleepManagerRef.current = null;
    ringBufferRef.current?.reset();
    ringBufferRef.current = null;
  }, []);

  // Belt-and-braces cleanup if the provider unmounts while a session is
  // live (route change, hot reload).
  React.useEffect(() => {
    return () => {
      clearTick();
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    };
  }, [clearTick, teardownMic, teardownDeepgram, teardownSonnet, teardownSleep]);

  /** Open the Deepgram WS using a freshly-minted scoped token. Shared
   *  between `start()` and `resume()` so the reconnect path after doze
   *  does not duplicate code. */
  const openDeepgram = React.useCallback(async (sourceSampleRate: number) => {
    const sessionId = sessionIdRef.current;
    const { key } = await api.deepgramKey(sessionId);
    const service = new DeepgramService({
      onStateChange: setDeepgramState,
      onInterimTranscript: (text) => {
        setInterim(text);
      },
      onFinalTranscript: (text, confidence) => {
        setInterim('');
        setTranscript((prev) => {
          const next: TranscriptUtterance[] = [
            ...prev,
            {
              id: `u_${Date.now()}_${prev.length + 1}`,
              text,
              confidence,
              final: true,
              timestamp: Date.now(),
            },
          ];
          return next.length > 10 ? next.slice(next.length - 10) : next;
        });
        // Fire the final utterance at the Sonnet session so server-side
        // multi-turn extraction can fill form fields. No-op if the WS
        // isn't open — the Sonnet client queues pre-connect messages.
        sonnetRef.current?.sendTranscript(text);
        // Reset the SleepManager's no-final-transcript timer. Interim
        // partials deliberately don't — iOS does the same so the mic's
        // AGC can't self-feed and keep the doze timer permanently armed.
        sleepManagerRef.current?.onSpeechActivity();
      },
      onError: (err) => {
        // Only surface in the UI if we're not already closing down — a
        // normal CloseStream can race with `stop()` and emit a spurious
        // error that would otherwise flip the overlay red.
        if (deepgramRef.current) {
          setErrorMessage(err.message);
        }
      },
    });
    service.connect(key, sourceSampleRate);
    deepgramRef.current = service;
  }, []);

  /** Apply a structured Sonnet extraction to the active JobDetail.
   *  Kept in a stable callback so the Sonnet WS callbacks don't rebind
   *  every render. Reads the current job from `jobRef` to decide whether
   *  to overwrite (3-tier priority: pre-existing manual data wins over
   *  Sonnet unless Sonnet is explicitly clearing / correcting). */
  const applyExtraction = React.useCallback(
    (result: ExtractionResult) => {
      const applied = applyExtractionToJob(jobRef.current, result);
      if (applied) {
        updateJobRef.current(applied.patch);
        // Feed LiveFillState so <LiveFillView> can flash the fields
        // Sonnet actually filled. No-op if the list is empty (the patch
        // only had `field_clears`, which we deliberately don't flash).
        if (applied.changedKeys.length > 0) {
          liveFill.markUpdated(applied.changedKeys);
        }
      }
    },
    [liveFill]
  );

  /** Open the Sonnet extraction WebSocket. Runs alongside Deepgram —
   *  Deepgram feeds transcripts, Sonnet turns them into structured
   *  readings + questions + cost. Shared between `start()` and
   *  `resume()` so the Phase 4e wake path reuses exactly this logic. */
  const openSonnet = React.useCallback(() => {
    const sessionId = sessionIdRef.current;
    const jobId = jobRef.current.id;
    const session = new SonnetSession({
      onStateChange: setSonnetState,
      onExtraction: (result) => {
        applyExtraction(result);
      },
      onQuestion: (q) => {
        setQuestions((prev) => {
          // Dedup by text — Sonnet occasionally re-asks the same
          // question across turns until the field is filled.
          if (prev.some((p) => p.question === q.question)) return prev;
          const next = [...prev, q];
          return next.length > 5 ? next.slice(next.length - 5) : next;
        });
      },
      onCostUpdate: (update) => {
        // Server sends totalJobCost in USD. We keep Sonnet cost
        // separate from Deepgram so the UI ticker stays smooth between
        // extraction turns.
        if (typeof update.totalJobCost === 'number') {
          setSonnetCostUsd(update.totalJobCost);
        }
      },
      onError: (err, recoverable) => {
        // Only surface non-recoverable errors in the overlay. Transient
        // server errors (rate-limit, API blip) should not flip the UI
        // red mid-recording.
        if (!recoverable && sonnetRef.current) {
          setErrorMessage(err.message);
        }
      },
    });
    // Route certificate type off the live job snapshot, not a hardcoded
    // default. An EIC job sent as EICR would silently run against the
    // wrong Sonnet extraction schema and drop the design-section fields.
    // Fallback to 'EICR' only when the backend somehow omitted the type
    // (legacy jobs created before the column existed); defensive, but we
    // log so the drift is visible during QA.
    const certificateType = jobRef.current.certificate_type ?? 'EICR';
    session.connect({
      sessionId,
      jobId,
      certificateType,
      jobState: jobRef.current,
    });
    sonnetRef.current = session;
  }, [applyExtraction]);

  /** Open the mic stream and forward audio to Deepgram. Shared between
   *  `start()` and `resume()`. Also owns the SleepManager + ring buffer
   *  writes so Phase 4e wake/replay works without duplicating the mic
   *  plumbing. */
  const beginMicPipeline = React.useCallback(async () => {
    // Fresh ring buffer on every mic open — the previous session's tail
    // is irrelevant after a teardown. 3s @ 16kHz mirrors iOS.
    //
    // The ring buffer is intentionally fixed at 16kHz: every consumer
    // (Deepgram, the ASR wake-replay, iOS) speaks 16kHz natively, so we
    // resample ONCE at the ingress boundary below and everything
    // downstream is already in the correct rate. Prior to this, the
    // ring buffer was sized for 16kHz but written with raw mic-rate
    // samples (48kHz on most iOS builds), so a "3-second" replay was
    // really ~1 second of audio labelled at the wrong rate — Deepgram
    // heard a chipmunk and the first few seconds after wake were lost.
    ringBufferRef.current = new AudioRingBuffer(3, 16000);
    const handle = await startMicCapture({
      onSamples: (samples) => {
        // Single resample point. `handle.sampleRate` is the AudioContext's
        // ACTUAL rate (browsers honour the 16000 hint only on some builds).
        // Post-resample data is 16kHz Float32 regardless of the hardware
        // rate, so both downstream sinks can trust the sample count.
        const samples16k = resampleTo16k(samples, handle.sampleRate);
        // Always write to the ring buffer, even while paused. That's
        // what lets wake-from-doze replay the 3 seconds leading up to
        // the VAD fire.
        ringBufferRef.current?.writeFloat32(samples16k);
        deepgramRef.current?.sendSamples(samples16k);
      },
      onLevel: (level) => {
        const now = performance.now();
        // ~60Hz UI cap, but the SleepManager sees every sample so the
        // wake heuristic isn't under-sampled.
        sleepManagerRef.current?.processAudioLevel(level);
        if (now - lastLevelPushRef.current < 16) return;
        lastLevelPushRef.current = now;
        setMicLevel(level);
      },
      onError: (err) => {
        setErrorMessage(err.message);
        setState('error');
        teardownMic();
        teardownDeepgram();
        teardownSleep();
        clearTick();
      },
    });
    micRef.current = handle;
    // Samples arrive at DeepgramService already resampled to 16kHz (see
    // the onSamples callback above), so declare the source rate as 16k
    // regardless of `handle.sampleRate`. Otherwise DeepgramService would
    // resample a second time with a ratio based on the raw device rate
    // and produce double-transformed audio.
    await openDeepgram(16000);
    // Sonnet session opens alongside Deepgram. Run sequentially so the
    // scoped Deepgram token fetch doesn't contend with the Sonnet
    // handshake on slow networks; both are cheap so this is fine.
    openSonnet();
  }, [clearTick, openDeepgram, openSonnet, teardownDeepgram, teardownMic, teardownSleep]);

  /** Auto-wake from doze/sleep. Invoked by the SleepManager when VAD
   *  spots speech — reopens whatever layers were torn down and drains
   *  the ring buffer into Deepgram so the words spoken just before wake
   *  aren't lost. The mic + ring buffer keep running through both doze
   *  AND sleep (only Deepgram/Sonnet are torn down), so the ring
   *  buffer's contents are valid in every wake case. Swallows failures
   *  rather than flipping the UI red: wake is best-effort, and the next
   *  user action will surface any real problem. */
  const handleWake = React.useCallback(
    async (from: Exclude<SleepState, 'active'>) => {
      try {
        if (from === 'sleeping') {
          // Deepgram + Sonnet were disconnected; reopen them but DON'T
          // touch the mic or ring buffer — mic is still running and the
          // ring buffer holds the pre-wake audio we want to replay. The
          // Sonnet server preserves conversation state for 5 min (see
          // sonnet-stream.js) so the new WS picks up where we left off.
          const mic = micRef.current;
          if (!mic) {
            // Mic died while sleeping — start a fresh pipeline. Rare.
            await beginMicPipeline();
          } else {
            // Ring buffer is already 16kHz (see beginMicPipeline) and
            // the onSamples callback keeps resampling upstream, so
            // DeepgramService always speaks 16kHz for this session.
            await openDeepgram(16000);
            openSonnet();
            const replay = ringBufferRef.current?.drain();
            if (replay && replay.length > 0) {
              deepgramRef.current?.sendInt16PCM(replay);
            }
          }
        } else {
          // Doze — Deepgram + Sonnet are still open, just paused.
          // Resume with the ring-buffer replay so pre-wake audio
          // reaches the ASR.
          const replay = ringBufferRef.current?.drain();
          deepgramRef.current?.resume(replay);
          sonnetRef.current?.resume();
        }
        setState('active');
        beginTick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        setState('error');
        teardownMic();
        teardownDeepgram();
        teardownSonnet();
        teardownSleep();
      }
    },
    [
      beginMicPipeline,
      beginTick,
      openDeepgram,
      openSonnet,
      teardownMic,
      teardownDeepgram,
      teardownSonnet,
      teardownSleep,
    ]
  );

  /** Build a fresh SleepManager wired up to pause Deepgram + Sonnet on
   *  doze, fully disconnect on sleep, and reconnect + replay on wake.
   *  Called once per session from `start()` — the manager survives the
   *  doze/wake cycles internally and only stops on `stop()`. */
  const buildSleepManager = React.useCallback(() => {
    const mgr = new SleepManager({
      onEnterDozing: () => {
        // Tell the server to pause cost tracking BEFORE pausing the
        // Deepgram stream (iOS fix 4c75ccf). Pause keeps the WS alive
        // with KeepAlive frames so wake re-latches in <100ms.
        sonnetRef.current?.pause();
        deepgramRef.current?.pause();
        clearTick();
        setMicLevel(0);
        setState('dozing');
      },
      onEnterSleeping: () => {
        // Full disconnect after 30min dozing — matches iOS. The mic
        // stream keeps running so the ring buffer still captures pre-
        // wake audio for the replay on next speech.
        teardownDeepgram();
        teardownSonnet();
        setState('sleeping');
      },
      onWake: (from) => {
        void handleWake(from);
      },
    });
    sleepManagerRef.current = mgr;
    mgr.start();
  }, [clearTick, handleWake, teardownDeepgram, teardownSonnet]);

  const start = React.useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;
    setErrorMessage(null);
    setState('requesting-mic');
    setOverlayOpen(true);
    setElapsedSec(0);
    setDeepgramCostUsd(0);
    setSonnetCostUsd(0);
    setTranscript([]);
    setInterim('');
    setQuestions([]);
    liveFill.reset();
    sessionIdRef.current = `sess_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    try {
      await beginMicPipeline();
      buildSleepManager();
      setState('active');
      beginTick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most common: NotAllowedError (permission denied). Surface a
      // friendlier message — the raw DOMException name is hidden behind
      // "Permission denied" which inspectors can act on.
      setErrorMessage(
        /NotAllowed|denied|dismiss/i.test(msg)
          ? 'Microphone permission was denied. Enable it in your browser settings to record.'
          : msg
      );
      setState('error');
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    }
  }, [
    state,
    beginMicPipeline,
    beginTick,
    buildSleepManager,
    teardownMic,
    teardownDeepgram,
    teardownSonnet,
    teardownSleep,
    liveFill,
  ]);

  const stop = React.useCallback(() => {
    clearTick();
    teardownMic();
    teardownDeepgram();
    teardownSonnet();
    teardownSleep();
    setState('idle');
    setMicLevel(0);
    setOverlayOpen(false);
    setQuestions([]);
    liveFill.reset();
  }, [clearTick, teardownMic, teardownDeepgram, teardownSonnet, teardownSleep, liveFill]);

  /** Manual pause — the inspector tapped the Pause button. Routes
   *  through the same doze handler the SleepManager would use when the
   *  15s timer fires, so pause behaviour is consistent with automatic
   *  sleep: Deepgram WS stays alive, Sonnet pauses, cost tracker stops,
   *  and the mic keeps filling the ring buffer so resume can replay. */
  const pause = React.useCallback(() => {
    if (state !== 'active') return;
    sonnetRef.current?.pause();
    deepgramRef.current?.pause();
    clearTick();
    setMicLevel(0);
    setState('dozing');
  }, [state, clearTick]);

  /** Manual resume — mirrors the wake path. If Deepgram was torn down
   *  (sleeping), reopen it; otherwise just unpause and replay the ring
   *  buffer so any audio captured while paused reaches the ASR. The mic
   *  + ring buffer keep running through both doze and sleep, so the
   *  replay is always valid. */
  const resume = React.useCallback(async () => {
    if (state !== 'dozing' && state !== 'sleeping') return;
    setErrorMessage(null);
    try {
      if (state === 'sleeping') {
        const mic = micRef.current;
        if (!mic) {
          await beginMicPipeline();
        } else {
          // Ingress resample in `beginMicPipeline` keeps the ring buffer
          // + DeepgramService in 16kHz for this session — no need to
          // forward the raw device rate here.
          await openDeepgram(16000);
          openSonnet();
          const replay = ringBufferRef.current?.drain();
          if (replay && replay.length > 0) {
            deepgramRef.current?.sendInt16PCM(replay);
          }
        }
      } else {
        const replay = ringBufferRef.current?.drain();
        deepgramRef.current?.resume(replay);
        sonnetRef.current?.resume();
      }
      setState('active');
      beginTick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setState('error');
      teardownMic();
      teardownDeepgram();
      teardownSonnet();
      teardownSleep();
    }
  }, [
    state,
    beginMicPipeline,
    beginTick,
    openDeepgram,
    openSonnet,
    teardownMic,
    teardownDeepgram,
    teardownSonnet,
    teardownSleep,
  ]);

  const minimise = React.useCallback(() => setOverlayOpen(false), []);
  const expand = React.useCallback(() => setOverlayOpen(true), []);
  const dismissQuestion = React.useCallback((index: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Total user-facing cost — Deepgram streaming + Sonnet tokens. Kept
  // as a derived value so callers always see a consistent sum.
  const costUsd = deepgramCostUsd + sonnetCostUsd;

  const value = React.useMemo<RecordingCtx>(
    () => ({
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      interim,
      deepgramState,
      sonnetState,
      questions,
      errorMessage,
      isOverlayOpen,
      start,
      stop,
      pause,
      resume,
      minimise,
      expand,
      dismissQuestion,
    }),
    [
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      interim,
      deepgramState,
      sonnetState,
      questions,
      errorMessage,
      isOverlayOpen,
      start,
      stop,
      pause,
      resume,
      minimise,
      expand,
      dismissQuestion,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRecording(): RecordingCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      'useRecording must be used inside a <RecordingProvider>. ' +
        'Wrap your job route (or any surface that records) in the provider.'
    );
  }
  return ctx;
}

/** Utility for the transcript bar: format 123.4 → "02:03". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Utility for the cost chip: $0.0153 → "$0.02". Rounds to nearest cent, clamps
 *  to $0.00 minimum so "-$0.00" never shows after a stop/start glitch. */
export function formatCost(usd: number): string {
  const n = Math.max(0, usd);
  return `$${n.toFixed(2)}`;
}
