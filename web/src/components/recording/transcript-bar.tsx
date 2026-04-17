'use client';

import * as React from 'react';
import { Mic, ChevronUp } from 'lucide-react';
import { useRecording, formatElapsed } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Transcript bar — thin, top-docked strip that stays visible whenever a
 * recording session is running but the full overlay is minimised.
 *
 * Mirrors the iOS "minimised recording pill" that slides in under the
 * nav bar: mic icon (pulsing when active), running elapsed time, and
 * the latest final utterance truncated to a single line. Tap to expand
 * back into the full overlay.
 */
export function TranscriptBar() {
  const { state, elapsedSec, transcript, isOverlayOpen, expand } = useRecording();

  // Only render when there's a session running AND the overlay is not expanded.
  // When state is 'idle' the bar hides entirely — no empty strip on the page.
  if (state === 'idle' || isOverlayOpen) return null;

  const last = transcript[transcript.length - 1]?.text;
  const pulse = state === 'active';

  return (
    <button
      type="button"
      onClick={expand}
      aria-label="Expand recording overlay"
      className="sticky top-[56px] z-20 flex w-full items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-1)]/95 px-4 py-2 text-left backdrop-blur-md transition hover:bg-[var(--color-surface-2)]"
    >
      <span
        aria-hidden
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          pulse && 'animate-pulse'
        )}
        style={{ background: 'var(--color-brand-green)' }}
      >
        <Mic className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
      </span>
      <span className="font-mono text-[12px] tabular-nums text-[var(--color-text-secondary)]">
        {formatElapsed(elapsedSec)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">
        {last ?? (state === 'requesting-mic' ? 'Requesting microphone…' : 'Listening…')}
      </span>
      <ChevronUp
        className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]"
        strokeWidth={2.25}
        aria-hidden
      />
    </button>
  );
}
