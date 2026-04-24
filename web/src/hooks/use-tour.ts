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
  const { autoStartOnFirstRun = false, steps = DASHBOARD_TOUR_STEPS } = options;

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

  // Hydrate from IDB + subscribe to cross-tab flag changes.
  React.useEffect(() => {
    let cancelled = false;
    void readTourState().then((s) => {
      if (cancelled) return;
      setPersisted(s);
      setHydrated(true);
      if (autoStartRef.current && !s.seen && !s.disabled) {
        // Mark seen immediately so a rapid remount / fast-refresh
        // doesn't double-trigger. Intentional fire-and-forget: the
        // worst case on IDB failure is the tour auto-starts once
        // more next session — harmless.
        void updateTourState({ seen: true });
        setActive(true);
        setStepIndex(0);
        setPaused(false);
      }
    });
    const unsub = subscribeTourChanges(() => {
      void readTourState().then((s) => {
        if (cancelled) return;
        setPersisted(s);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const currentStep = React.useMemo<TourStep | null>(() => {
    if (!active) return null;
    return steps[stepIndex] ?? null;
  }, [active, stepIndex, steps]);

  const start = React.useCallback(() => {
    setStepIndex(0);
    setPaused(false);
    setActive(true);
    // A manual start also clears `disabled` so the same surface can
    // auto-launch next time (parity with the iOS "re-enable tour"
    // behaviour off the settings page).
    void updateTourState({ disabled: false, seen: true });
  }, []);

  const stop = React.useCallback(() => {
    setActive(false);
    setPaused(false);
    // Flip disabled on an explicit stop; the user has opted out
    // until they manually re-enable. seen stays true — no need to
    // reset that.
    void updateTourState({ disabled: true, seen: true });
  }, []);

  const next = React.useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= steps.length) {
        // Auto-stop on completion — NOT via `stop()` because the
        // user didn't opt out; they just finished. Keep disabled=false
        // so they can re-run from settings without manually flipping
        // the flag.
        setActive(false);
        setPaused(false);
        void updateTourState({ disabled: false, seen: true });
        return 0;
      }
      return i + 1;
    });
  }, [steps.length]);

  const prev = React.useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const pause = React.useCallback(() => setPaused(true), []);
  const resume = React.useCallback(() => setPaused(false), []);

  const reset = React.useCallback(async () => {
    await resetTourState();
    setPersisted(DEFAULT_TOUR_STATE);
  }, []);

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
