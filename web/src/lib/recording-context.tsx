'use client';

import * as React from 'react';

/**
 * Recording context (Phase 4a — scaffold only).
 *
 * Holds the UI state that every surface needs while the inspector is
 * recording. Real audio/Deepgram/Sonnet integration arrives in Phases
 * 4b–4d; this scaffold uses deterministic stubs (fake transcripts, fake
 * mic level, fake cost ticks) so the overlay, transcript bar, and mic
 * button can be visually verified against iOS reference screenshots
 * without requiring a microphone permission prompt.
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
 * The stub `start()` synthesises a sequence of partial/final transcripts
 * every ~1.5s so the transcript bar has something to render during
 * visual verification. Calling `start()` on a real device in Phase 4b
 * will replace the synth loop with AudioWorklet → Deepgram.
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

/** Synth transcript loop — a rolling rota of realistic inspector phrases so
 *  the Phase 4a overlay has motion to verify against iOS. Replaced by
 *  Deepgram Nova-3 finals in Phase 4c. */
const SYNTH_PHRASES: readonly string[] = [
  'Consumer unit is a Hager VML 16-way dual RCD',
  'Main switch rating one hundred amps double pole',
  'RCD one is thirty milliamp type AC',
  'Ze reading zero point one four ohms TN-S',
  'Circuit one ground floor sockets R1 plus R2 zero point eight',
  'Insulation resistance greater than two hundred megohms',
  'PFC six point two kiloamps',
  'Observation: no RCD protection on ground floor lighting, code C3',
];

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<RecordingState>('idle');
  const [micLevel, setMicLevel] = React.useState(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const [costUsd, setCostUsd] = React.useState(0);
  const [transcript, setTranscript] = React.useState<TranscriptUtterance[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isOverlayOpen, setOverlayOpen] = React.useState(false);

  // ── Synth loop (scaffold only) ─────────────────────────────────────────
  const timersRef = React.useRef<{
    tick: ReturnType<typeof setInterval> | null;
    utter: ReturnType<typeof setInterval> | null;
  }>({ tick: null, utter: null });

  const clearTimers = React.useCallback(() => {
    if (timersRef.current.tick) clearInterval(timersRef.current.tick);
    if (timersRef.current.utter) clearInterval(timersRef.current.utter);
    timersRef.current = { tick: null, utter: null };
  }, []);

  React.useEffect(() => clearTimers, [clearTimers]);

  const beginSynthLoop = React.useCallback(() => {
    // Drive timer + cost + mic level at 10 Hz so the VU meter feels live.
    let t = 0;
    timersRef.current.tick = setInterval(() => {
      t += 0.1;
      setElapsedSec((s) => s + 0.1);
      setCostUsd((c) => c + 0.0077 / 60 / 10); // $/min → $/100ms
      // Oscillate between 0.15 and 0.9 using two sines so it doesn't look robotic.
      const lvl = 0.52 + 0.35 * Math.sin(t * 4.1) * 0.5 + 0.2 * Math.sin(t * 1.7 + 1.2);
      setMicLevel(Math.max(0.05, Math.min(1, lvl)));
    }, 100);

    // Emit a new final utterance every 2.2s, cycling through SYNTH_PHRASES.
    let idx = 0;
    timersRef.current.utter = setInterval(() => {
      const phrase = SYNTH_PHRASES[idx % SYNTH_PHRASES.length];
      idx += 1;
      setTranscript((prev) => {
        const next: TranscriptUtterance[] = [
          ...prev,
          {
            id: `u_${Date.now()}_${idx}`,
            text: phrase,
            final: true,
            timestamp: Date.now(),
          },
        ];
        // Keep only the last 10 so memory doesn't unbound over long sessions.
        return next.length > 10 ? next.slice(next.length - 10) : next;
      });
    }, 2200);
  }, []);

  const start = React.useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return;
    setErrorMessage(null);
    setState('requesting-mic');
    setOverlayOpen(true);
    // Phase 4a: skip the real getUserMedia call — simulate a 250ms permission
    // latency so the UI has a visible "requesting-mic" state to verify.
    await new Promise((r) => setTimeout(r, 250));
    setState('active');
    setElapsedSec(0);
    setCostUsd(0);
    setTranscript([]);
    beginSynthLoop();
  }, [state, beginSynthLoop]);

  const stop = React.useCallback(() => {
    clearTimers();
    setState('idle');
    setMicLevel(0);
    setOverlayOpen(false);
    // Keep elapsedSec + transcript visible for ~400ms so the overlay can
    // animate out without the data vanishing mid-frame. Reset on next start.
  }, [clearTimers]);

  const pause = React.useCallback(() => {
    if (state !== 'active') return;
    clearTimers();
    setState('dozing');
  }, [state, clearTimers]);

  const resume = React.useCallback(() => {
    if (state !== 'dozing' && state !== 'sleeping') return;
    setState('active');
    beginSynthLoop();
  }, [state, beginSynthLoop]);

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
