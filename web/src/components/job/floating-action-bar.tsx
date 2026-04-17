'use client';

import * as React from 'react';
import {
  Camera,
  FileCheck2,
  FilePlus,
  FileText,
  Mic,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import { useRecording } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Floating action bar — pinned to the bottom of every /job/[id]/… route.
 *
 * Order + colours match the iOS reference (see memory/ios_design_parity.md):
 *
 *   Defaults  (magenta) · Apply (green) · CCU (orange) · Doc (blue)
 *   · Obs (blue) · Mic (LARGE green circle, prominent)
 *
 * To the LEFT of the row of buttons, iOS shows a tiny drag-handle circle
 * plus a 5-dot indicator (`• • • • •`). Tapping it opens an overflow
 * sheet in the iOS app — we stub the handler until Phase 5 capture flows
 * + the recording overlay land, but the visual affordance is in place
 * so parity screenshots match.
 *
 * All buttons call through to console-logged stubs — the real handlers
 * (apply defaults, open CCU upload, start recording, etc.) wire in with
 * Phases 4 and 5.
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
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex items-end justify-between px-3 pb-4 md:px-6 md:pb-5"
    >
      {/* Left: 5-dot menu handle (iOS overflow trigger) */}
      <MenuHandle />

      {/* Right: action bar */}
      <div className="pointer-events-auto flex items-center gap-2.5">
        <ActionButton
          label="Defaults"
          color="#ff375f"
          Icon={SlidersHorizontal}
          onClick={() => console.log('[bar] defaults')}
        />
        <ActionButton
          label="Apply"
          color="var(--color-brand-green)"
          Icon={FileCheck2}
          onClick={() => console.log('[bar] apply')}
        />
        <ActionButton
          label="CCU"
          color="#ff9f0a"
          Icon={Camera}
          onClick={() => console.log('[bar] ccu')}
        />
        <ActionButton
          label="Doc"
          color="var(--color-brand-blue)"
          Icon={FileText}
          onClick={() => console.log('[bar] doc')}
        />
        <ActionButton
          label="Obs"
          color="var(--color-brand-blue-soft)"
          Icon={TriangleAlert}
          onClick={() => console.log('[bar] obs')}
        />
        <MicButton onClick={onMicClick} recording={recording} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function MenuHandle() {
  return (
    <button
      type="button"
      aria-label="Open menu"
      onClick={() => console.log('[bar] overflow menu')}
      className="pointer-events-auto group inline-flex items-center gap-1.5 rounded-full px-1.5 py-1.5 transition hover:bg-[var(--color-surface-2)]"
    >
      <span
        aria-hidden
        className="block h-3.5 w-3.5 rounded-full bg-[var(--color-text-tertiary)] group-hover:bg-[var(--color-text-secondary)]"
      />
      <span aria-hidden className="flex items-center gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="block h-1.5 w-1.5 rounded-full bg-[var(--color-text-tertiary)]/70 group-hover:bg-[var(--color-text-secondary)]"
          />
        ))}
      </span>
    </button>
  );
}

function ActionButton({
  label,
  color,
  Icon,
  onClick,
}: {
  label: string;
  color: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-full shadow-[0_4px_14px_rgba(0,0,0,0.4)] transition active:scale-95 focus-visible:outline-2 focus-visible:outline-white"
      style={{ background: color, color: '#ffffff' }}
    >
      <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
      <span className="text-[9px] font-bold uppercase tracking-[0.04em] leading-none">{label}</span>
    </button>
  );
}

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
