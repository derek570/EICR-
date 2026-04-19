'use client';

import * as React from 'react';
import {
  Camera,
  Check,
  FileText,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Play,
  Settings2,
  Square,
  Volume2,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useRecording, formatCost, formatElapsed } from '@/lib/recording-context';
import { cn } from '@/lib/utils';

/**
 * Recording chrome — in-page indicator + control surface that renders
 * over the live tab content while a recording session is running.
 *
 * Replaces the previous Dialog-based <RecordingOverlay>. The user wanted
 * the page (Overview tab with hero boxes, circuits, observations) to
 * stay visible during recording, with a red pulsing ring around the
 * viewport instead of a separate page or modal.
 *
 * Three pieces:
 *   1. <RecordingRing>     — fixed full-viewport breathing red border
 *   2. <TranscriptBar>     — top transcript pill (lives in transcript-bar.tsx
 *                            and is mounted by job/[id]/layout.tsx)
 *   3. <RecordingActionBar> — fixed bottom bar with state pill, mic-level
 *                            VU meter, iOS-parity action buttons + Pause/End
 *
 * The chrome only renders when state !== 'idle'. The idle Mic FAB
 * (FloatingActionBar) stays visible whenever the chrome is hidden, so
 * the inspector always has a way to start a session.
 */
export function RecordingChrome() {
  const { state } = useRecording();
  if (state === 'idle') return null;
  return (
    <>
      <RecordingRing state={state} />
      <RecordingActionBar />
    </>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Pulsing border around the entire viewport. Pointer-events:none so it
 * never steals taps from the live form underneath. Z-index sits above
 * the action bar's chrome but below modal/toast layers — the inspector
 * can still open a sheet while recording without the ring obscuring it.
 *
 * Colour shifts with the recording state so paused/sleeping reads as a
 * different mode without a separate component.
 */
function RecordingRing({ state }: { state: ReturnType<typeof useRecording>['state'] }) {
  const colour =
    state === 'error'
      ? 'var(--color-status-failed)'
      : state === 'dozing'
        ? 'var(--color-status-processing)'
        : state === 'sleeping'
          ? 'var(--color-status-limitation)'
          : state === 'requesting-mic'
            ? 'var(--color-status-processing)'
            : 'var(--color-status-failed)';
  return (
    <div
      aria-hidden
      className="cm-rec-ring pointer-events-none fixed inset-0 z-40"
      style={
        {
          '--rec-ring-color': colour,
        } as React.CSSProperties
      }
    />
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Bottom action bar — fixed at the foot of the viewport while recording.
 * Layout left-to-right:
 *
 *   [state pill | timer | cost]   [VU meter]   [Voice Defaults Apply CCU Doc Obs]   [End | Pause/Resume]
 *
 * The iOS-parity button cluster maps to web handlers where they exist:
 *   • CCU  → /circuits  (CCUPhotoCard already wires GPT Vision pipeline)
 *   • Doc  → /circuits  (DocumentCard already wires /api/analyze-document)
 *   • Obs  → /observations
 * Voice / Defaults / Apply are visual-only for now (iOS-only handlers
 * per the floating-action-bar.tsx history note); rendered as disabled
 * with an explanatory aria-label rather than non-functional buttons.
 */
function RecordingActionBar() {
  const { state, micLevel, elapsedSec, costUsd, errorMessage, stop, pause, resume } =
    useRecording();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jobId = params?.id;

  const isActive = state === 'active';
  const isPaused = state === 'dozing' || state === 'sleeping';

  const goToTab = React.useCallback(
    (slug: string) => {
      if (!jobId) return;
      router.push(`/job/${jobId}${slug}`);
    },
    [router, jobId]
  );

  return (
    <div
      role="toolbar"
      aria-label="Recording controls"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3 md:pb-4"
    >
      <div className="pointer-events-auto flex w-full max-w-[1100px] flex-col gap-2 rounded-[var(--radius-xl)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)]/95 px-3 py-2.5 shadow-[0_-12px_48px_rgba(0,0,0,0.55)] backdrop-blur-md md:flex-row md:items-center md:gap-3 md:px-4">
        {/* ── Left: state pill + timer + cost ─────────────────────── */}
        <div className="flex items-center gap-2.5">
          <StatePill state={state} />
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[15px] font-semibold tabular-nums text-[var(--color-text-primary)]">
              {formatElapsed(elapsedSec)}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {formatCost(costUsd)}
            </span>
          </div>
        </div>

        {/* ── Centre: VU meter ────────────────────────────────────── */}
        <div className="hidden flex-1 md:block">
          <VuMeter level={micLevel} active={isActive} />
        </div>

        {/* ── Right: iOS-parity buttons + Pause/End ───────────────── */}
        <div className="flex items-center justify-end gap-1.5 overflow-x-auto md:gap-2">
          {/* Voice / Defaults / Apply — visual-only on web. The handlers
              live in iOS today; rendering them disabled keeps screen
              parity with the iOS reference shot without shipping
              non-functional buttons. */}
          <ParityButton
            label="Voice"
            tone="muted"
            icon={Volume2}
            disabled
            disabledReason="Voice prompts are iOS-only for now."
          />
          <ParityButton
            label="Defaults"
            tone="violet"
            icon={Settings2}
            disabled
            disabledReason="Defaults panel is iOS-only for now."
          />
          <ParityButton
            label="Apply"
            tone="green"
            icon={Check}
            disabled
            disabledReason="Apply-last-snapshot is iOS-only for now."
          />
          {/* CCU / Doc / Obs deep-link to the tab where the wired
              handler already lives, so the inspector can fire the same
              action from inside a recording session as they would from
              the tab's action rail. */}
          <ParityButton
            label="CCU"
            tone="orange"
            icon={Camera}
            onClick={() => goToTab('/circuits')}
          />
          <ParityButton
            label="Doc"
            tone="cyan"
            icon={FileText}
            onClick={() => goToTab('/circuits')}
          />
          <ParityButton
            label="Obs"
            tone="blue"
            icon={MessageSquare}
            onClick={() => goToTab('/observations')}
          />

          {/* End — equivalent to iOS's red square. Always available so
              the inspector can bail out instantly. */}
          <CircleButton
            label="End"
            icon={Square}
            onClick={stop}
            background="var(--color-status-failed)"
          />
          {/* Pause / Resume — pause is greyed during requesting-mic so
              double-tapping mid-permission doesn't race the state
              machine; resume only enables from dozing/sleeping. */}
          {isPaused ? (
            <CircleButton
              label="Resume"
              icon={Play}
              onClick={resume}
              background="var(--color-brand-green)"
            />
          ) : (
            <CircleButton
              label="Pause"
              icon={Pause}
              onClick={pause}
              background="var(--color-status-processing)"
              disabled={!isActive}
            />
          )}
        </div>

        {errorMessage ? (
          <p
            role="alert"
            className="basis-full text-[12px] font-medium text-[var(--color-status-failed)]"
          >
            {errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function StatePill({ state }: { state: ReturnType<typeof useRecording>['state'] }) {
  const { label, colour, Icon } = React.useMemo(() => {
    switch (state) {
      case 'requesting-mic':
        return { label: 'Requesting mic', colour: 'var(--color-status-processing)', Icon: Mic };
      case 'active':
        return { label: 'Listening', colour: 'var(--color-brand-green)', Icon: Mic };
      case 'dozing':
        return { label: 'Paused', colour: 'var(--color-status-processing)', Icon: MicOff };
      case 'sleeping':
        return { label: 'Sleeping', colour: 'var(--color-status-limitation)', Icon: MicOff };
      case 'error':
        return { label: 'Error', colour: 'var(--color-status-failed)', Icon: MicOff };
      default:
        return { label: 'Idle', colour: 'var(--color-text-tertiary)', Icon: Mic };
    }
  }, [state]);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-white"
      style={{ background: colour }}
    >
      <span aria-hidden className="cm-pulse-dot h-1.5 w-1.5 rounded-full bg-white" />
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Mic-level VU meter — 24 vertical bars spread across the available
 * width, lit from the centre out as `level` rises. Driven directly off
 * `micLevel` (0..1) which the recording context throttles to ~60Hz off
 * the AudioWorklet RMS — fast enough to feel live, slow enough that
 * React renders don't choke.
 *
 * Bars are pre-allocated; their height is the only thing that changes
 * frame-to-frame, which keeps the diff trivial and the GPU off the
 * critical path.
 */
function VuMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 24;
  const peak = Math.min(1, Math.max(0, level));
  return (
    <div aria-hidden className="flex h-9 w-full items-end justify-center gap-[3px] px-2 opacity-90">
      {Array.from({ length: bars }, (_, i) => {
        // Symmetric around the centre — peak at i === bars/2.
        const distFromCentre = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
        const idleHeight = 0.18 + 0.12 * (1 - distFromCentre);
        const liveHeight = active
          ? Math.max(idleHeight, peak * (1 - distFromCentre * 0.55))
          : idleHeight;
        return (
          <span
            key={i}
            className="w-[3px] rounded-full transition-[height] duration-100 ease-out"
            style={{
              height: `${Math.max(8, Math.round(liveHeight * 100))}%`,
              background: active ? 'var(--color-brand-green)' : 'var(--color-text-tertiary)',
              opacity: active ? 0.85 : 0.55,
            }}
          />
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

type ButtonTone = 'muted' | 'violet' | 'green' | 'orange' | 'cyan' | 'blue';

const TONE_BG: Record<ButtonTone, string> = {
  muted: 'rgba(255,255,255,0.10)',
  violet: '#a855f7',
  green: 'var(--color-brand-green)',
  orange: '#ff9f0a',
  cyan: '#22d3ee',
  blue: 'var(--color-brand-blue)',
};

/**
 * iOS-parity round button — small (40×40) coloured pill with an icon
 * and a label below, matching the iOS reference shot. Disabled buttons
 * still show their colour at reduced opacity so the layout stays
 * consistent between platforms; the `aria-label` is the source of truth
 * for screen readers.
 */
function ParityButton({
  label,
  tone,
  icon: Icon,
  onClick,
  disabled,
  disabledReason,
}: {
  label: string;
  tone: ButtonTone;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={disabled && disabledReason ? `${label} (${disabledReason})` : label}
      className={cn(
        'flex shrink-0 flex-col items-center gap-0.5 rounded-2xl px-2 py-1.5 text-white transition active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
        disabled && 'cursor-not-allowed opacity-45'
      )}
    >
      <span
        className="flex h-9 w-9 items-center justify-center rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
        style={{ background: TONE_BG[tone] }}
      >
        <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-secondary)]">
        {label}
      </span>
    </button>
  );
}

/**
 * Larger control button (44×44) for End / Pause / Resume — the controls
 * the inspector reaches for most often. Bigger hit area, no label
 * underneath; the icon does the work.
 */
function CircleButton({
  label,
  icon: Icon,
  onClick,
  background,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick: () => void;
  background: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_14px_rgba(0,0,0,0.45)] transition active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
        disabled && 'cursor-not-allowed opacity-45'
      )}
      style={{ background }}
    >
      <Icon className="h-4 w-4" strokeWidth={2.5} aria-hidden />
    </button>
  );
}
