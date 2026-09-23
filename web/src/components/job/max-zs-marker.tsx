'use client';

import * as React from 'react';

import { ocpdRowWarnings } from '@certmate/shared-utils';

/**
 * PLAN-CC (feedback-2026-09-17 wave) — the OCPD compatibility marker.
 *
 * ONE list (`ocpdRowWarnings`) drives every surface that shows it: the three
 * web Max Zs cells, the iOS `CircuitsTab` cell, and both PDF preflights.
 * A warning the inspector sees on screen is therefore the same judgement the
 * preflight makes — if they could disagree, one of them would be lying.
 *
 * Three things it flags, and all are questions rather than errors:
 *   `unreadable` standard — a value the canonicaliser could not read, kept
 *     exactly as it arrived because an import has nobody to re-ask. Reachable
 *     even when the max Zs is empty, which is why it is a separate predicate.
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
  // PLAN-CC — both compatibility questions, from one list, so this cell cannot
  // render one and silently drop the other. The standard's own line is
  // reachable when the max Zs is EMPTY, which the max-Zs status alone is not.
  const lines = ocpdRowWarnings(circuitRef, row);
  if (lines.length === 0) return null;
  const text = lines.join(' — ');
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
