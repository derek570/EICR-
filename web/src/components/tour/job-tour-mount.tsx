'use client';

import * as React from 'react';
import { TourOverlay } from './tour-overlay';
import { useTour } from '@/hooks/use-tour';
import { JOB_TOUR_STEPS } from '@/lib/tour/steps';

/**
 * Phase D — Job-detail tour mount.
 *
 * Lives inside `job/[id]/layout.tsx` so the tour activates on every
 * job-detail surface (Overview, Circuits, PDF, etc.). 8 steps mirror
 * iOS `TourManager.jobSteps`:
 *
 *   1. Overview / transcript bar intro
 *   2. CCU photo button
 *   3. How to give readings (circuit + test phrase)
 *   4. Multi-circuit shortcut
 *   5. Voice confirmations + observations
 *   6. Obs photo + always-check reminder
 *   7. Voice queries + commands
 *   8. PDF tab — preview + generate
 *
 * Persisted state is per-key (`cm-tour-job` localStorage), so the
 * dashboard's "seen" flag doesn't suppress the job tour and
 * vice-versa. iOS uses one seen flag because it presents both phases
 * back-to-back; the PWA splits them so an inspector who already
 * understands the dashboard but hasn't recorded yet still gets the
 * job-tour.
 *
 * `autoStartOnFirstRun: true` only fires the first time per device.
 * The JobHeader 3-dot menu's "Guided Tour" item resets the flag and
 * reloads, which lets this component re-fire — that's how Phase C
 * wired the menu.
 */
export function JobTourMount() {
  const tour = useTour({
    steps: JOB_TOUR_STEPS,
    stateKey: 'job',
    narrate: true,
    autoStartOnFirstRun: true,
  });
  return <TourOverlay controller={tour} />;
}
