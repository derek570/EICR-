'use client';

import * as React from 'react';
import {
  readTourState,
  resetTourState,
  subscribeTourChanges,
  updateTourState,
  type TourState,
} from '@/lib/tour/state';
import { DASHBOARD_TOUR_STEPS, DASHBOARD_TOUR_TOTAL, type TourStep } from '@/lib/tour/steps';
import { speak as speakNarration, isTtsAvailable, cancelSpeech } from '@/lib/recording/tts';

/**
 * Inter-step delay matching iOS `TourManager.interStepDelay`. The
 * narration finishes; we wait this long; then auto-advance. Gives the
 * inspector time to look at the highlighted area before the next
 * spotlight moves.
 */
const INTER_STEP_DELAY_MS = 2_500;

/**
 * Guided-tour controller (Phase 3).
 *
 * Single hook that:
 *   - Reads persisted tour state from IDB on mount (auto-start +
 *     dismissal flags).
 *   - Exposes imperative `start()` / `stop()` / `next()` / `prev()` /
 *     `pause()` / `resume()` helpers that mirror the iOS TourManager
 *     API surface one-for-one.
 *   - Auto-starts the tour on first mount when `autoStartOnFirstRun`
 *     is true AND the user has never seen the tour AND they haven't
 *     disabled it.
 *
 * Intentionally not a React context — the floating overlay and the
 * "Start tour" button on the settings page both consume the same
 * hook instance model, but there's never a case where two instances
 * need to share a step-index state; each mounts with fresh state.
 * `subscribeTourChanges` handles cross-instance flag sync (e.g.
 * settings page flipping `disabled` while the dashboard is visible).
 *
 * Edge cases:
 *   - `seen` is flipped on the FIRST auto-start attempt (not on
 *     manual re-runs) so the dashboard never auto-starts twice.
 *   - `stop()` flips `disabled: true` so a user who hit the X
 *     doesn't get auto-started again next session. Manual re-runs
 *     via `/settings` flip it back to false.
 */
export interface UseTourOptions {
  /**
   * If true, the tour auto-starts on first mount when the persisted
   * state says the user has never seen it and hasn't disabled it.
   * Default: false — most surfaces (e.g. settings) should not auto-
   * start. The dashboard explicitly opts in.
   */
  autoStartOnFirstRun?: boolean;
  /** Override the step list. Defaults to the dashboard tour. */
  steps?: readonly TourStep[];
  /**
   * If true (Phase D), each step's `narration` text is spoken via
   * Web Speech API SpeechSynthesis when the step becomes active.
   * Auto-advance fires once the speech finishes + `INTER_STEP_DELAY_MS`.
   * Falls back gracefully when SpeechSynthesis isn't available
   * (advance is timer-driven from a body-length estimate).
   *
   * The voice-feedback toggle (shared with the recording bar's
   * Voice button) gates this — if the inspector has muted the bot,
   * narration stays silent but auto-advance still runs.
   */
  narrate?: boolean;
  /**
   * Persisted state key. Default `'dashboard'`. Job-detail tour uses
   * `'job'` so seen/disabled flags don't bleed across surfaces.
   */
  stateKey?: 'dashboard' | 'job';
}

export interface TourController {
  /** True while a tour is running. */
  active: boolean;
  /** 0-based index of the current step within `steps`. */
  stepIndex: number;
  /** Total step count for progress display. */
  total: number;
  /** The current step, or null when inactive. */
  currentStep: TourStep | null;
  /** True when paused (the UI keeps the spotlight but suppresses auto-advance / narration). */
  paused: boolean;
  /** User has previously dismissed the auto-run tour. */
  disabled: boolean;
  /** User has seen the auto-start tour at least once. */
  seen: boolean;

  start: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  pause: () => void;
  resume: () => void;
  /** Clears `seen` + `disabled` so the next mount auto-starts again (debug / "restart tour" entry). */
  reset: () => Promise<void>;
}

const DEFAULT_TOUR_STATE: TourState = {
  seen: false,
  disabled: false,
};

export function useTour(options: UseTourOptions = {}): TourController {
  const {
    autoStartOnFirstRun = false,
    steps = DASHBOARD_TOUR_STEPS,
    narrate = false,
    stateKey = 'dashboard',
  } = options;

  const [persisted, setPersisted] = React.useState<TourState>(DEFAULT_TOUR_STATE);
  const [active, setActive] = React.useState(false);
  const [stepIndex, setStepIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  /*
   * `hydrated` becomes true after the first IDB read. We gate
   * auto-start on it so we don't incorrectly launch the tour during
   * SSR / before we know whether the user has already seen it.
   */
  const [hydrated, setHydrated] = React.useState(false);

  const autoStartRef = React.useRef(autoStartOnFirstRun);
  React.useEffect(() => {
    autoStartRef.current = autoStartOnFirstRun;
  }, [autoStartOnFirstRun]);

  // For the job-detail tour, use localStorage instead of the shared
  // IDB store (the IDB store is the dashboard's single-key blob — we
  // don't want job-tour seen/disabled flags to bleed into it).
  const isJob = stateKey === 'job';
  const localKey = `cm-tour-${stateKey}`; // cm-tour-dashboard | cm-tour-job

  const readPersisted = React.useCallback(async (): Promise<TourState> => {
    if (!isJob) return readTourState();
    if (typeof window === 'undefined') return DEFAULT_TOUR_STATE;
    try {
      const raw = window.localStorage.getItem(localKey);
      if (!raw) return DEFAULT_TOUR_STATE;
      const parsed = JSON.parse(raw);
      return {
        seen: Boolean(parsed?.seen),
        disabled: Boolean(parsed?.disabled),
      };
    } catch {
      return DEFAULT_TOUR_STATE;
    }
  }, [isJob, localKey]);

  const writePersisted = React.useCallback(
    async (patch: Partial<TourState>) => {
      if (!isJob) {
        await updateTourState(patch);
        return;
      }
      if (typeof window === 'undefined') return;
      const current = await readPersisted();
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(localKey, JSON.stringify(next));
      } catch {
        // Ignore quota errors — worst case the tour offers itself again.
      }
    },
    [isJob, localKey, readPersisted]
  );

  // Hydrate from IDB + subscribe to cross-tab flag changes.
  React.useEffect(() => {
    let cancelled = false;
    void readPersisted().then((s) => {
      if (cancelled) return;
      setPersisted(s);
      setHydrated(true);
      if (autoStartRef.current && !s.seen && !s.disabled) {
        // Mark seen immediately so a rapid remount / fast-refresh
        // doesn't double-trigger. Intentional fire-and-forget: the
        // worst case on IDB failure is the tour auto-starts once
        // more next session — harmless.
        void writePersisted({ seen: true });
        setActive(true);
        setStepIndex(0);
        setPaused(false);
      }
    });
    // Only subscribe to cross-tab updates for the dashboard
    // (IDB-backed) tour. The job-tour's localStorage updates fire
    // a 'storage' event in other tabs but we don't currently care —
    // the job-tour mounts per-job so cross-tab sync isn't a feature.
    const unsub = !isJob
      ? subscribeTourChanges(() => {
          void readPersisted().then((s) => {
            if (cancelled) return;
            setPersisted(s);
          });
        })
      : () => {};
    return () => {
      cancelled = true;
      unsub();
    };
  }, [readPersisted, writePersisted, isJob]);

  const currentStep = React.useMemo<TourStep | null>(() => {
    if (!active) return null;
    return steps[stepIndex] ?? null;
  }, [active, stepIndex, steps]);

  // Phase D — TTS narration + auto-advance. Speaks the active step's
  // narration via Web Speech API, then schedules the next step
  // INTER_STEP_DELAY_MS after the speech ends. Pause cancels both.
  // Falls back to a body-length-estimate timer when SpeechSynthesis
  // isn't available (jsdom tests, embedded browsers).
  const advanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAdvance = React.useCallback(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    // Stop narration + cancel pending advance whenever the active /
    // paused / step changes. The new effect body re-arms based on the
    // current step.
    cancelSpeech();
    clearAdvance();
    if (!narrate || !active || paused || !currentStep) return;
    const text = currentStep.narration ?? currentStep.body;
    if (!text) return;

    const onSpeechDone = () => {
      // Re-check inside the timer that the tour is still on this
      // step before auto-advancing — paused / nexted / stopped during
      // speech all need to short-circuit.
      advanceTimerRef.current = setTimeout(() => {
        if (!active || paused) return;
        setStepIndex((i) => {
          if (i + 1 >= steps.length) {
            // Last step finished — auto-stop without flipping disabled.
            setActive(false);
            setPaused(false);
            void writePersisted({ disabled: false, seen: true });
            return 0;
          }
          return i + 1;
        });
      }, INTER_STEP_DELAY_MS);
    };

    if (isTtsAvailable()) {
      speakNarration(text, { force: true, onEnd: onSpeechDone });
    } else {
      // Estimate read time: ~14 chars/sec. Cap at 14s so a
      // verbose step doesn't keep the user waiting forever.
      const estMs = Math.min(14_000, Math.max(2_500, text.length * 70));
      advanceTimerRef.current = setTimeout(onSpeechDone, estMs);
    }

    return () => {
      cancelSpeech();
      clearAdvance();
    };
  }, [narrate, active, paused, currentStep, steps.length, writePersisted, clearAdvance]);

  const start = React.useCallback(() => {
    setStepIndex(0);
    setPaused(false);
    setActive(true);
    // A manual start also clears `disabled` so the same surface can
    // auto-launch next time (parity with the iOS "re-enable tour"
    // behaviour off the settings page).
    void writePersisted({ disabled: false, seen: true });
  }, [writePersisted]);

  const stop = React.useCallback(() => {
    cancelSpeech();
    clearAdvance();
    setActive(false);
    setPaused(false);
    // Flip disabled on an explicit stop; the user has opted out
    // until they manually re-enable. seen stays true — no need to
    // reset that.
    void writePersisted({ disabled: true, seen: true });
  }, [writePersisted, clearAdvance]);

  const next = React.useCallback(() => {
    cancelSpeech();
    clearAdvance();
    setStepIndex((i) => {
      if (i + 1 >= steps.length) {
        // Auto-stop on completion — NOT via `stop()` because the
        // user didn't opt out; they just finished. Keep disabled=false
        // so they can re-run from settings without manually flipping
        // the flag.
        setActive(false);
        setPaused(false);
        void writePersisted({ disabled: false, seen: true });
        return 0;
      }
      return i + 1;
    });
  }, [steps.length, writePersisted, clearAdvance]);

  const prev = React.useCallback(() => {
    cancelSpeech();
    clearAdvance();
    setStepIndex((i) => Math.max(0, i - 1));
  }, [clearAdvance]);

  const pause = React.useCallback(() => {
    cancelSpeech();
    clearAdvance();
    setPaused(true);
  }, [clearAdvance]);
  const resume = React.useCallback(() => setPaused(false), []);

  const reset = React.useCallback(async () => {
    if (!isJob) {
      await resetTourState();
    } else if (typeof window !== 'undefined') {
      window.localStorage.removeItem(localKey);
    }
    setPersisted(DEFAULT_TOUR_STATE);
  }, [isJob, localKey]);

  return {
    active,
    stepIndex,
    total: steps.length,
    currentStep,
    paused,
    disabled: persisted.disabled,
    seen: hydrated ? persisted.seen : false,
    start,
    stop,
    next,
    prev,
    pause,
    resume,
    reset,
  };
}

export const TOUR_TOTAL = DASHBOARD_TOUR_TOTAL;
