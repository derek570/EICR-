'use client';

import * as React from 'react';
import { startMicCapture, type MicCaptureHandle } from './recording/mic-capture';

/**
 * Recording context.
 *
 * Holds the UI state that every surface needs while the inspector is
 * recording. Phase 4b wires real microphone capture via an AudioWorklet
 * → RMS pipeline so the VU meter reacts to actual audio. Deepgram
 * Nova-3 transcription (Phase 4c), Sonnet multi-turn extraction (Phase
 * 4d), and VAD sleep/wake (Phase 4e) are still to come — until then
 * the transcript stays empty and the cost ticks only with Deepgram's
 * notional rate while audio is streaming.
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
  /** `true` once Deepgram flags the utterance as final. Scaffold flips a synthetic
   *  partial to final on the next tick so the fade-out animation can be observed. */
  final: boolean;
  timestamp: number;
};

export type RecordingSnapshot = {
  state: RecordingState;
  /** 0.0 – 1.0, driven by RMS in Phase 4b. Stub oscillates between 0.15 and 0.9. */
  micLevel: number;
  elapsedSec: number;
  /** Running USD cost (Deepgram streaming + Sonnet tokens). Stub increments by
   *  $0.0077/min ≈ Nova-3 streaming rate. */
  costUsd: number;
  /** Last ~10 utterances. Newest last. */
  transcript: TranscriptUtterance[];
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
  const [state, setState] = React.useState<RecordingState>('idle');
  const [micLevel, setMicLevel] = React.useState(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const [costUsd, setCostUsd] = React.useState(0);
  const [transcript, setTranscript] = React.useState<TranscriptUtterance[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isOverlayOpen, setOverlayOpen] = React.useState(false);

  // ── Audio pipeline ──────────────────────────────────────────────────────
  // Mic capture handle + elapsed/cost ticker. The mic handle owns the
  // AudioContext and Worklet; we keep it in a ref so `stop()` can tear it
  // down without tripping React's effect dependency machinery.
  const micRef = React.useRef<MicCaptureHandle | null>(null);
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
      setCostUsd((c) => c + DEEPGRAM_USD_PER_MIN / 60 / 10);
    }, 100);
  }, []);

  const teardownMic = React.useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  // Belt-and-braces cleanup if the provider unmounts while a session is
  // live (route change, hot reload).
  React.useEffect(() => {
    return () => {
      clearTick();
      teardownMic();
    };
  }, [clearTick, teardownMic]);

  const start = React.useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;
    setErrorMessage(null);
    setState('requesting-mic');
    setOverlayOpen(true);
    setElapsedSec(0);
    setCostUsd(0);
    setTranscript([]);
    try {
      const handle = await startMicCapture({
        onLevel: (level) => {
          const now = performance.now();
          if (now - lastLevelPushRef.current < 16) return; // ~60Hz cap
          lastLevelPushRef.current = now;
          setMicLevel(level);
        },
        onError: (err) => {
          setErrorMessage(err.message);
          setState('error');
          teardownMic();
          clearTick();
        },
      });
      micRef.current = handle;
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
    }
  }, [state, beginTick, clearTick, teardownMic]);

  const stop = React.useCallback(() => {
    clearTick();
    teardownMic();
    setState('idle');
    setMicLevel(0);
    setOverlayOpen(false);
  }, [clearTick, teardownMic]);

  const pause = React.useCallback(() => {
    if (state !== 'active') return;
    // Phase 4b: pause tears down the mic to guarantee no audio leaves the
    // browser while "paused". Phase 4e will swap this for the SleepDetector
    // `pause()` which keeps the graph open + sends KeepAlive frames.
    clearTick();
    teardownMic();
    setMicLevel(0);
    setState('dozing');
  }, [state, clearTick, teardownMic]);

  const resume = React.useCallback(async () => {
    if (state !== 'dozing' && state !== 'sleeping') return;
    try {
      const handle = await startMicCapture({
        onLevel: (level) => {
          const now = performance.now();
          if (now - lastLevelPushRef.current < 16) return;
          lastLevelPushRef.current = now;
          setMicLevel(level);
        },
        onError: (err) => {
          setErrorMessage(err.message);
          setState('error');
          teardownMic();
          clearTick();
        },
      });
      micRef.current = handle;
      setState('active');
      beginTick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setState('error');
    }
  }, [state, beginTick, clearTick, teardownMic]);

  const minimise = React.useCallback(() => setOverlayOpen(false), []);
  const expand = React.useCallback(() => setOverlayOpen(true), []);

  const value = React.useMemo<RecordingCtx>(
    () => ({
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      errorMessage,
      isOverlayOpen,
      start,
      stop,
      pause,
      resume,
      minimise,
      expand,
    }),
    [
      state,
      micLevel,
      elapsedSec,
      costUsd,
      transcript,
      errorMessage,
      isOverlayOpen,
      start,
      stop,
      pause,
      resume,
      minimise,
      expand,
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
