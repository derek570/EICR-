'use client';

import * as React from 'react';
import { FilePlus, Mic } from 'lucide-react';
import { useRecording } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Floating action bar — pinned to the bottom of every /job/[id]/… route
 * while NOT recording. Hosts the Mic FAB the inspector taps to start a
 * session.
 *
 * The active-recording controls (Voice / Defaults / Apply / CCU / Doc /
 * Obs / End / Pause) live in <RecordingChrome>'s bottom bar which takes
 * over the same screen real estate; this bar hides itself the moment a
 * session begins so the two bars never stack.
 */
export function FloatingActionBar() {
  const { state, start } = useRecording();
  const recording = state !== 'idle';
  const onMicClick = React.useCallback(() => {
    void start();
  }, [start]);
  // Hide entirely while recording — RecordingChrome owns the bottom
  // strip in that mode and renders its own End/Pause controls. Without
  // this guard, two bars stacked at the foot of the viewport.
  if (recording) return null;
  return (
    <div
      role="toolbar"
      aria-label="Job actions"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex items-end justify-end px-3 pb-4 md:px-6 md:pb-5"
    >
      <div className="pointer-events-auto flex items-center gap-2.5">
        <MicButton onClick={onMicClick} recording={false} />
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
      data-tour="ccu-button"
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
