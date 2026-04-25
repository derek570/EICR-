'use client';

import * as React from 'react';
import type { RecordingState } from '@/lib/recording-context';

/**
 * VAD indicator — small coloured dot + label next to the state pill.
 *
 * Mirrors iOS `VADIndicatorView` (CertMateUnified/Sources/Views/Recording/
 * VADIndicatorView.swift): green when actively listening, amber while
 * dozing, grey when the session has entered full sleep. Pulses the outer
 * ring while speech is active so the inspector can glance-verify the mic
 * is actually open.
 *
 * Why a separate component from the existing `<StatePill>`:
 *   - iOS renders two things: a state pill (compact label with icon) AND
 *     a smaller VAD dot. The parity ledger calls this out as `partial`
 *     because the web pill collapsed both. We still want the pill for
 *     the readable label, but a second dot next to it gives the
 *     inspector the same at-a-glance VAD cue iOS provides.
 *
 * Reduced motion: when `prefers-reduced-motion: reduce` is honoured the
 * outer ring fades out instead of pulsing — the dot still shows the
 * right colour so the information is preserved without animation.
 */
export function VadIndicator({ state }: { state: RecordingState }) {
  const { colour, label, pulsing } = React.useMemo(() => {
    switch (state) {
      case 'active':
        return { colour: 'var(--color-brand-green)', label: 'Active', pulsing: true };
      case 'dozing':
        return { colour: 'var(--color-status-processing)', label: 'Dozing', pulsing: false };
      case 'sleeping':
        return { colour: 'var(--color-status-limitation)', label: 'Sleeping', pulsing: false };
      case 'requesting-mic':
        return { colour: 'var(--color-status-processing)', label: 'Starting', pulsing: false };
      case 'error':
        return { colour: 'var(--color-status-failed)', label: 'Error', pulsing: false };
      default:
        return { colour: 'var(--color-text-tertiary)', label: 'Idle', pulsing: false };
    }
  }, [state]);

  return (
    <span
      role="status"
      aria-label={`VAD ${label}`}
      className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--color-text-secondary)]"
    >
      <span className="relative inline-flex h-3 w-3 items-center justify-center" aria-hidden>
        <span
          className="absolute inset-0 rounded-full opacity-40"
          style={{
            background: colour,
            animation: pulsing ? 'cm-vad-ring 1.2s ease-in-out infinite' : 'none',
          }}
        />
        <span className="relative h-[9px] w-[9px] rounded-full" style={{ background: colour }} />
      </span>
      <span>{label}</span>
    </span>
  );
}
