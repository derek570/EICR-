'use client';

import * as React from 'react';
import { Mic } from 'lucide-react';
import { useRecording, formatElapsed } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Transcript bar — thin, top-docked strip that stays visible whenever a
 * recording session is running. Shows a rolling tail of the last several
 * final utterances with the live interim partial appended in grey italic.
 *
 * Mirrors the iOS `TranscriptBarView` behaviour: uses a horizontal scroll
 * container that auto-pins to the trailing edge so the inspector always
 * sees the *most recent* words, and older words scroll off to the left.
 * This replaces the previous "latest final only" design which discarded
 * prior utterances as soon as Deepgram finalised the next one.
 *
 * The recording context caps `transcript` at 10 utterances (see
 * `recording-context.tsx` line ~257), so memory cost is bounded.
 */
export function TranscriptBar() {
  const { state, elapsedSec, transcript, interim } = useRecording();

  // Auto-scroll the ticker to the right edge whenever transcript/interim
  // changes. Mirrors iOS `.truncationMode(.head)` + horizontal scroll —
  // head scrolls off-screen, tail stays visible.
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // rAF so the scroll happens after the new text has laid out.
    const id = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
    return () => cancelAnimationFrame(id);
  }, [transcript, interim]);

  if (state === 'idle') return null;

  const pulse = state === 'active';
  const hasAnyText = transcript.length > 0 || interim.length > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Live transcript"
      data-tour="transcript-bar"
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
      <div
        ref={scrollerRef}
        // `overflow-x-auto` lets the user drag-scroll back through
        // history on desktop; on touch the inertial swipe works too.
        // `scrollbar-none` (Tailwind) / inline style fallback keeps the
        // bar flush — no visible track inside the 32px strip.
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[13px] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {hasAnyText ? (
          <span className="inline-flex items-baseline gap-2">
            {transcript.map((u, i) => (
              <span
                key={u.id}
                className={cn(
                  'text-[var(--color-text-primary)]',
                  // Fade older utterances so the eye tracks the freshest
                  // words. Only apply fading to history — the newest
                  // final stays full-opacity so it reads as "just said".
                  i < transcript.length - 2 && 'opacity-60',
                  i < transcript.length - 4 && 'opacity-40'
                )}
              >
                {u.text}
              </span>
            ))}
            {interim ? (
              <span className="italic text-[var(--color-text-secondary)]">{interim}</span>
            ) : null}
          </span>
        ) : (
          <span className="italic text-[var(--color-text-tertiary)]">
            {state === 'requesting-mic' ? 'Requesting microphone…' : 'Listening…'}
          </span>
        )}
      </div>
    </div>
  );
}
