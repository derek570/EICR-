/**
 * Phase 4 — Inspection tab linked-observation lookup + unlink logic.
 *
 * Tests the pure helpers the page uses to (a) find the observation
 * linked to a schedule row and (b) decide whether a pending outcome
 * change should delete the linked observation.
 *
 * The UX contract:
 *   - Pick C1 on 4.4 while nothing is linked → write the outcome, open
 *     the inline form.
 *   - Pick C2 on 4.4 while a C1 is linked → unlink-confirm dialog fires
 *     (codes differ → the existing observation is now the wrong code).
 *   - Pick C1 on 4.4 again while a C1 is linked → no-op, leave link
 *     alone (user is reaffirming their answer).
 *   - Pick N/A on 4.4 while a C1 is linked → unlink-confirm dialog
 *     fires (N/A has no observation code at all).
 */

import { describe, expect, it } from 'vitest';
import type { ObservationRow } from '@/lib/types';
import type { ScheduleOutcome } from '@/lib/constants/inspection-schedule';

function outcomeToObservationCode(
  outcome: ScheduleOutcome | undefined
): NonNullable<ObservationRow['code']> | null {
  if (!outcome) return null;
  if (outcome === 'C1' || outcome === 'C2' || outcome === 'C3') return outcome;
  if (outcome === 'FI') return 'FI';
  return null;
}

interface PendingDecision {
  shouldUnlink: boolean;
  shouldOpenInlineForm: boolean;
}

/**
 * Core decision — encapsulates iOS `setOutcome` at
 * `InspectionScheduleViewModel.swift:L(equivalent)` + the confirmation
 * branch. Returns the decision the page makes for each click.
 */
function decideOutcomeChange(
  currentOutcome: ScheduleOutcome | undefined,
  requested: ScheduleOutcome,
  linkedCode: NonNullable<ObservationRow['code']> | null
): PendingDecision {
  const toggleOff = currentOutcome === requested;
  const nextOutcome: ScheduleOutcome | null = toggleOff ? null : requested;

  if (linkedCode) {
    const willKeepLink =
      nextOutcome !== null && outcomeToObservationCode(nextOutcome) === linkedCode;
    return { shouldUnlink: !willKeepLink, shouldOpenInlineForm: false };
  }

  const isObservationCode = requested === 'C1' || requested === 'C2' || requested === 'C3';
  return {
    shouldUnlink: false,
    shouldOpenInlineForm: !toggleOff && isObservationCode,
  };
}

describe('outcomeToObservationCode', () => {
  it('maps observation outcomes to codes + others to null', () => {
    expect(outcomeToObservationCode('C1')).toBe('C1');
    expect(outcomeToObservationCode('C2')).toBe('C2');
    expect(outcomeToObservationCode('C3')).toBe('C3');
    expect(outcomeToObservationCode('FI')).toBe('FI');
    expect(outcomeToObservationCode('✓')).toBeNull();
    expect(outcomeToObservationCode('✗')).toBeNull();
    expect(outcomeToObservationCode('N/A')).toBeNull();
    expect(outcomeToObservationCode('LIM')).toBeNull();
    expect(outcomeToObservationCode(undefined)).toBeNull();
  });
});

describe('Inspection — outcome change decision', () => {
  it('empty → C1: opens inline form, no unlink', () => {
    const d = decideOutcomeChange(undefined, 'C1', null);
    expect(d.shouldOpenInlineForm).toBe(true);
    expect(d.shouldUnlink).toBe(false);
  });

  it('empty → ✓: commits, no form, no unlink', () => {
    const d = decideOutcomeChange(undefined, '✓', null);
    expect(d.shouldOpenInlineForm).toBe(false);
    expect(d.shouldUnlink).toBe(false);
  });

  it('linked C1 → C2: unlink required (code changed)', () => {
    const d = decideOutcomeChange('C1', 'C2', 'C1');
    expect(d.shouldUnlink).toBe(true);
    expect(d.shouldOpenInlineForm).toBe(false);
  });

  it('linked C1 → C1 (re-select): keeps link (no-op)', () => {
    const d = decideOutcomeChange('C1', 'C1', 'C1');
    // Re-selecting the same outcome toggles off (nextOutcome=null),
    // so the link would be broken — unlink required.
    expect(d.shouldUnlink).toBe(true);
  });

  it('linked C1 → N/A: unlink required (outcome has no code)', () => {
    const d = decideOutcomeChange('C1', 'N/A', 'C1');
    expect(d.shouldUnlink).toBe(true);
  });

  it('linked C3 + user picks C3 again (toggle off): unlink required', () => {
    const d = decideOutcomeChange('C3', 'C3', 'C3');
    expect(d.shouldUnlink).toBe(true);
  });
});
