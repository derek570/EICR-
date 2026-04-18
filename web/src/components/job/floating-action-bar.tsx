'use client';

import * as React from 'react';
import { FilePlus, Mic } from 'lucide-react';
import { useRecording } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Floating action bar — pinned to the bottom of every /job/[id]/… route.
 *
 * Pre-deploy contraction: iOS's floating bar carries Defaults / Apply /
 * CCU / Doc / Obs shortcuts in addition to the Mic. On web we only ship
 * the Mic button here because
 *   (a) CCU + Doc already live on the Circuits tab's action rail and
 *       work end-to-end (GPT Vision pipeline) — duplicating the button
 *       here without a working handler meant the production UI offered
 *       buttons that only `console.log`'d. Lint-zero regression AND a
 *       user-visible "nothing happens when I tap this" bug.
 *   (b) Defaults / Apply / Observations don't yet have a wired handler
 *       on web. Rather than ship non-functional chrome in production we
 *       hide the affordance entirely until the handler exists. iOS
 *       parity is a Phase-5 follow-up tracked in the rebuild plan.
 *
 * Keeping the bar mounted (not conditionally unmounted) preserves the
 * Mic + recording-state affordance on every tab and avoids the
 * layout-jolt of the button appearing/disappearing per route.
 */
export function FloatingActionBar() {
  const { state, start, expand } = useRecording();
  const recording = state !== 'idle';
  const onMicClick = React.useCallback(() => {
    if (recording) {
      // Session already running — reopen the overlay (iOS parity: tap mic
      // again to expand the minimised session).
      expand();
    } else {
      void start();
    }
  }, [recording, start, expand]);
  return (
    <div
      role="toolbar"
      aria-label="Job actions"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex items-end justify-end px-3 pb-4 md:px-6 md:pb-5"
    >
      <div className="pointer-events-auto flex items-center gap-2.5">
        <MicButton onClick={onMicClick} recording={recording} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function MicButton({ onClick, recording }: { onClick: () => void; recording: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={recording ? 'Open recording overlay' : 'Start recording'}
      aria-pressed={recording}
      className={cn(
        'ml-1 flex h-14 w-14 flex-col items-center justify-center rounded-full transition active:scale-95 focus-visible:outline-2 focus-visible:outline-white',
        recording
          ? 'animate-pulse shadow-[0_6px_18px_rgba(255,69,58,0.6)]'
          : 'shadow-[0_6px_18px_rgba(0,204,102,0.55)]'
      )}
      style={{
        background: recording ? 'var(--color-status-failed)' : 'var(--color-brand-green)',
        color: '#ffffff',
      }}
    >
      <Mic className="h-6 w-6" strokeWidth={2.25} aria-hidden />
      <span className="sr-only">{recording ? 'Recording in progress' : 'Record'}</span>
      {/* Tiny file-plus affordance in corner to echo iOS "add" glyph. */}
      <FilePlus className="sr-only" aria-hidden />
    </button>
  );
}
