'use client';

import { Mic } from 'lucide-react';
import { useRecording, formatElapsed } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Transcript bar — thin, top-docked strip that stays visible whenever a
 * recording session is running. Shows the live interim partial (grey
 * italic as Deepgram emits it) or the last final utterance when the
 * inspector pauses between sentences.
 *
 * Pre-deploy: the old behaviour hid this bar when a separate Dialog
 * overlay was "expanded". That overlay has been removed — the page now
 * stays visible under a red pulsing ring (RecordingChrome) — so the
 * transcript bar is the *only* surface showing what Deepgram is hearing
 * and must render continuously for any non-idle session.
 */
export function TranscriptBar() {
  const { state, elapsedSec, transcript, interim } = useRecording();

  if (state === 'idle') return null;

  // Prefer the live partial so the inspector sees words appearing as
  // they're spoken; fall back to the last final when idle.
  const latest = interim || transcript[transcript.length - 1]?.text;
  const pulse = state === 'active';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Live transcript"
      className="sticky top-[56px] z-20 flex w-full items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-1)]/95 px-4 py-2 backdrop-blur-md"
    >
      <span
        aria-hidden
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          pulse && 'cm-pulse-dot'
        )}
        style={{ background: 'var(--color-brand-green)' }}
      >
        <Mic className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
      </span>
      <span className="font-mono text-[12px] tabular-nums text-[var(--color-text-secondary)]">
        {formatElapsed(elapsedSec)}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px]',
          interim ? 'italic text-[var(--color-text-secondary)]' : 'text-[var(--color-text-primary)]'
        )}
      >
        {latest ?? (state === 'requesting-mic' ? 'Requesting microphone…' : 'Listening…')}
      </span>
    </div>
  );
}
