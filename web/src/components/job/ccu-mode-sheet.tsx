'use client';

import * as React from 'react';
import { ChevronRight, Camera, ListChecks, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { CcuApplyMode } from '@/lib/recording/apply-ccu-analysis';

/**
 * CCU extraction mode sheet — mirrors iOS
 * `Views/CCUExtraction/CCUExtractionModeSheet.swift`.
 *
 * When the inspector taps "CCU Photo" on the Circuits tab, this sheet
 * opens first to pick the apply strategy BEFORE the photo is chosen.
 * The backend `/api/analyze-ccu` returns the same superset in every
 * case — the mode only changes which client-side merge runs.
 *
 * Three modes (iOS parity — same ordering, same copy, same icons
 * approximated from SF Symbols):
 *
 *   1. Circuit Names Only — read labels only. Skips OCPD / RCD /
 *      cable / test data on existing circuits. Useful for quick
 *      label-only scans where the inspector plans to dictate the
 *      rest by voice.
 *   2. Full Capture — the legacy behaviour. Replaces hardware and
 *      board info from the photo, preserves inspector-typed values
 *      via the 3-tier priority ladder. Default when no circuits yet.
 *   3. Hardware Update — for jobs that already have circuits with
 *      test readings. Fuzzy-matches analysed circuits to existing
 *      ones, opens a review screen so the inspector can confirm
 *      pairings, then applies hardware on top while preserving
 *      readings. The most complex mode.
 *
 * UX shape:
 *   - Tall mode tiles (title + subtitle + coloured icon + chevron).
 *     Matches iOS `modeButton` from `CCUExtractionModeSheet.swift:37-68`.
 *   - Last-used mode persists to `localStorage['cm-ccu-last-mode']`
 *     so the next tap can one-shot if the inspector repeats the same
 *     path.
 *   - No camera inside this sheet. The parent opens its file picker
 *     as soon as a mode is selected.
 *
 * This component is pure — it doesn't trigger the file picker itself.
 * The parent owns the two-step sequence:
 *
 *   1. user taps CCU button → show sheet.
 *   2. user picks mode → `onSelect(mode)` → parent stores mode in
 *      a ref and `click()`s the hidden `<input type=file>`.
 */

export interface CcuModeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (mode: CcuApplyMode) => void;
  /**
   * Pre-existing circuit count on the active board. Used only for the
   * subtitle copy on Hardware Update ("4 circuits on the board" vs
   * "no existing circuits to match against"). iOS doesn't vary the
   * copy, but the web layout has more room and the extra hint helps
   * a first-time user pick the right mode.
   */
  existingCircuitCount?: number;
}

const LAST_MODE_KEY = 'cm-ccu-last-mode';

function readLastMode(): CcuApplyMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(LAST_MODE_KEY);
    if (v === 'names_only' || v === 'full_capture' || v === 'hardware_update') return v;
  } catch {
    /* ignore */
  }
  return null;
}

function writeLastMode(mode: CcuApplyMode) {
  try {
    window.localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Public hook — expose last-used mode so callers can surface
 *  "Last used: X" hints or pre-select a default. */
export function useLastCcuMode(): CcuApplyMode | null {
  const [mode, setMode] = React.useState<CcuApplyMode | null>(null);
  React.useEffect(() => setMode(readLastMode()), []);
  return mode;
}

interface ModeSpec {
  value: CcuApplyMode;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Accent colour for the icon — approximates iOS semantic colours. */
  colour: string;
}

const MODES: ModeSpec[] = [
  {
    value: 'names_only',
    title: 'Circuit Names Only',
    subtitle: 'Read labels from the board',
    icon: ListChecks,
    colour: 'var(--color-brand-blue)',
  },
  {
    value: 'hardware_update',
    title: 'Update Hardware (Keep Readings)',
    subtitle: 'New board photo, keep existing test results',
    icon: RefreshCw,
    colour: 'var(--color-status-processing, #ff9f0a)',
  },
  {
    value: 'full_capture',
    title: 'Full New Consumer Unit',
    subtitle: 'Replace everything',
    icon: Camera,
    colour: 'var(--color-brand-green)',
  },
];

export function CcuModeSheet({
  open,
  onOpenChange,
  onSelect,
  existingCircuitCount,
}: CcuModeSheetProps) {
  const handlePick = (mode: CcuApplyMode) => {
    writeLastMode(mode);
    onOpenChange(false);
    // Defer the callback so the dialog close animation doesn't race
    // with the file picker popping open — on iOS Safari the two
    // modal surfaces colliding produces a visible flicker.
    window.setTimeout(() => onSelect(mode), 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel="Cancel"
        className="mx-4 w-[calc(100%-2rem)] max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-5"
      >
        <DialogTitle>CCU Extraction</DialogTitle>
        <DialogDescription>How would you like to capture the board?</DialogDescription>

        <div className="mt-4 flex flex-col gap-2" role="list" aria-label="CCU extraction modes">
          {MODES.map((m) => (
            <ModeTile
              key={m.value}
              spec={m}
              onPick={handlePick}
              hint={
                m.value === 'hardware_update' && existingCircuitCount != null
                  ? existingCircuitCount === 0
                    ? 'No existing circuits to match against — Full Capture will be faster.'
                    : `${existingCircuitCount} existing circuit${existingCircuitCount === 1 ? '' : 's'} on this board.`
                  : undefined
              }
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModeTile({
  spec,
  onPick,
  hint,
}: {
  spec: ModeSpec;
  onPick: (mode: CcuApplyMode) => void;
  hint?: string;
}) {
  const Icon = spec.icon;
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onPick(spec.value)}
      className="flex min-h-[64px] items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
    >
      <span
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: `${spec.colour}26` }} /* 15% opacity */
        aria-hidden
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
          {spec.title}
        </span>
        <span className="text-[12px] text-[var(--color-text-secondary)]">{spec.subtitle}</span>
        {hint ? (
          <span className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">{hint}</span>
        ) : null}
      </span>
      <ChevronRight
        className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]"
        aria-hidden
      />
    </button>
  );
}
