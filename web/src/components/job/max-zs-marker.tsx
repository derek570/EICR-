'use client';

import * as React from 'react';

import { ocpdMaxZsStatus, ocpdMaxZsWarningText } from '@certmate/shared-utils';

/**
 * PLAN-CC (feedback-2026-09-17 wave) — the max-Zs compatibility marker.
 *
 * ONE predicate (`ocpdMaxZsStatus`) drives every surface that shows it: the
 * three web Max Zs cells, the iOS `CircuitsTab` cell, and both PDF preflights.
 * A warning the inspector sees on screen is therefore the same judgement the
 * preflight makes — if they could disagree, one of them would be lying.
 *
 * Two things it flags, and both are questions rather than errors:
 *   `manual_mismatch` — a hand-entered value that does not match the lookup for
 *     the tuple the row now carries. It is NOT overwritten; the inspector may
 *     have measured it deliberately, so the app asks rather than corrects.
 *   `unverified` — a value with no recorded origin, i.e. pre-plan data. The app
 *     cannot tell whether it was derived or measured, and guessing is exactly
 *     what this plan removed.
 *
 * It never blocks a save, is never spoken, and carries the same pinned copy as
 * the preflight line so the two cannot drift.
 */
export function MaxZsMarker({
  circuitRef,
  row,
}: {
  circuitRef: string;
  row: Record<string, unknown>;
}) {
  const status = ocpdMaxZsStatus(row);
  if (status == null || status === 'ok') return null;
  const text = ocpdMaxZsWarningText(circuitRef, row);
  if (!text) return null;
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className="flex-shrink-0 text-[var(--color-amber, #f5a524)]"
    >
      ⚠
    </span>
  );
}
