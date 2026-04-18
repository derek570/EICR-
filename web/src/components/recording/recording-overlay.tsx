'use client';

import * as React from 'react';
import {
  ChevronDown,
  HelpCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
  X as CloseIcon,
} from 'lucide-react';
import { useRecording, formatCost, formatElapsed } from '@/lib/recording-context';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * Recording overlay — mirrors iOS `RecordingOverlay.swift`.
 *
 * Full-height bottom-sheet (mobile) / centred modal card (desktop) that
 * surfaces while the inspector is recording. Three zones:
 *
 *   1. Hero bar — state pill, elapsed timer, cost readout, minimise / close
 *   2. Mic visualiser — central large mic with RMS-driven outer ring
 *   3. Transcript log — last ~6 utterances newest-first with fade on stale
 *   4. Controls — Pause / Resume / Stop
 *
 * Phase 4a is the visual-only scaffold (synth transcript loop). Phase 4b
 * adds AudioWorklet + RMS → mic level; Phase 4c wires Deepgram Nova-3.
 */
export function RecordingOverlay() {
  const {
    state,
    micLevel,
    elapsedSec,
    costUsd,
    transcript,
    interim,
    questions,
    errorMessage,
    isOverlayOpen,
    stop,
    pause,
    resume,
    minimise,
    dismissQuestion,
  } = useRecording();

  // Radix drives open/close through a boolean + onOpenChange; Esc, overlay
  // click, and the Close parts all route through there. Closing the
  // overlay via Esc or outside-click is treated as a "minimise" (matches
  // the old behaviour — the session keeps running; only the bottom sheet
  // hides and the top transcript bar takes over).
  const handleOpenChange = (open: boolean) => {
    if (!open) minimise();
  };

  const isActive = state === 'active';
  const isPaused = state === 'dozing' || state === 'sleeping';
  const isError = state === 'error';
  const isRequesting = state === 'requesting-mic';

  // Newest-first for display, but cap at 6 to keep the column height stable.
  const visibleTranscript = [...transcript].slice(-6).reverse();

  // VU-meter outer ring scale — 1.0 at rest, grows up to 1.35 at peak.
  const ringScale = 1 + Math.min(0.35, Math.max(0, micLevel) * 0.35);

  return (
    <Dialog open={isOverlayOpen} onOpenChange={handleOpenChange}>
      {/* `unstyled` drops the centred-card defaults so we can render the
          mobile bottom-sheet / desktop card layout below. Radix still
          gives us the focus-trap spine, Esc, focus restore, aria-modal,
          and portal mount. `aria-label` goes on DialogContent so the
          Playwright focus-trap spec can resolve it via
          `getByRole('dialog', { name: /recording session/i })`. */}
      <DialogContent
        unstyled
        aria-label="Recording session"
        className="flex items-end justify-center bg-black/60 backdrop-blur-sm md:items-center"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        {/* Radix requires a DialogTitle for a11y (and Playwright's
            `name:` filter targets the accessible name); hide it visually
            because our hero bar shows its own time + state pill. */}
        <DialogTitle className="sr-only">Recording session</DialogTitle>
        <div
          className="relative flex w-full flex-col overflow-hidden rounded-t-[var(--radius-xl)] border-t border-[var(--color-border-default)] bg-[var(--color-surface-1)] shadow-[0_-12px_48px_rgba(0,0,0,0.55)] md:rounded-[var(--radius-xl)] md:border md:shadow-[0_20px_64px_rgba(0,0,0,0.6)]"
          style={{ maxWidth: '520px', maxHeight: '88dvh' }}
        >
          {/* ── Hero bar ─────────────────────────────────────────────── */}
          <div
            className="flex items-center justify-between gap-3 px-5 py-4"
            style={{
              background:
                'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
            }}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <StatePill state={state} />
              </div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[28px] font-bold tabular-nums text-white">
                  {formatElapsed(elapsedSec)}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white"
                  style={{ background: 'rgba(0,0,0,0.25)' }}
                >
                  {formatCost(costUsd)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <HeroIconButton label="Minimise" icon={ChevronDown} onClick={minimise} />
              <HeroIconButton label="End" icon={CloseIcon} onClick={stop} />
            </div>
          </div>

          {/* ── Mic visualiser ──────────────────────────────────────── */}
          <div className="flex items-center justify-center px-6 py-8">
            <div className="relative flex h-40 w-40 items-center justify-center">
              <div
                aria-hidden
                className={cn(
                  'absolute inset-0 rounded-full transition-transform duration-100 ease-out',
                  isActive ? '' : 'opacity-40'
                )}
                style={{
                  transform: `scale(${ringScale})`,
                  background:
                    'radial-gradient(circle, rgba(0,204,102,0.35) 0%, rgba(0,204,102,0) 70%)',
                }}
              />
              <div
                aria-hidden
                className={cn(
                  'absolute inset-4 rounded-full border-2',
                  isActive ? 'animate-pulse' : ''
                )}
                style={{
                  borderColor: isError
                    ? 'var(--color-status-failed)'
                    : isPaused
                      ? 'var(--color-status-processing)'
                      : 'var(--color-brand-green)',
                }}
              />
              <div
                className="flex h-20 w-20 items-center justify-center rounded-full shadow-[0_8px_32px_rgba(0,204,102,0.55)]"
                style={{
                  background: isError
                    ? 'var(--color-status-failed)'
                    : isPaused
                      ? 'var(--color-status-processing)'
                      : 'var(--color-brand-green)',
                }}
              >
                {isError || isPaused ? (
                  <MicOff className="h-8 w-8 text-white" strokeWidth={2.25} aria-hidden />
                ) : (
                  <Mic className="h-8 w-8 text-white" strokeWidth={2.25} aria-hidden />
                )}
              </div>
            </div>
          </div>

          {/* ── Sonnet questions ─────────────────────────────────────── */}
          {questions.length > 0 ? (
            <div
              className="flex flex-col gap-2 border-t border-[var(--color-border-default)] bg-[var(--color-brand-blue)]/10 px-5 py-3"
              aria-live="polite"
            >
              {questions.map((q, i) => (
                <div
                  key={`${i}-${q.question}`}
                  className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-1)] px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                >
                  <HelpCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand-blue)]"
                    strokeWidth={2.25}
                    aria-hidden
                  />
                  <p className="flex-1 text-[13px] leading-snug text-[var(--color-text-primary)]">
                    {q.question}
                  </p>
                  <button
                    type="button"
                    onClick={() => dismissQuestion(i)}
                    aria-label="Dismiss question"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-surface-2)]"
                  >
                    <CloseIcon className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* ── Transcript log ───────────────────────────────────────── */}
          <div className="flex min-h-[180px] flex-1 flex-col gap-2 overflow-y-auto border-t border-[var(--color-border-default)] px-5 py-4">
            {errorMessage ? (
              <p className="text-[13px] text-[var(--color-status-failed)]">{errorMessage}</p>
            ) : (
              <>
                {/* Interim partial — greyed italic, always renders on top of
                   the log until Deepgram emits a final. */}
                {interim ? (
                  <p className="text-[14px] italic leading-snug text-[var(--color-text-tertiary)]">
                    {interim}
                  </p>
                ) : null}
                {visibleTranscript.length === 0 && !interim ? (
                  <p className="text-[13px] italic text-[var(--color-text-tertiary)]">
                    {isRequesting
                      ? 'Requesting microphone permission…'
                      : 'Start speaking — transcripts will appear here in real time.'}
                  </p>
                ) : (
                  visibleTranscript.map((u, i) => (
                    <p
                      key={u.id}
                      className="text-[14px] leading-snug text-[var(--color-text-primary)] transition-opacity"
                      style={{ opacity: 1 - i * 0.15 }}
                    >
                      {u.text}
                    </p>
                  ))
                )}
              </>
            )}
          </div>

          {/* ── Controls ────────────────────────────────────────────── */}
          <div className="flex items-center justify-center gap-3 border-t border-[var(--color-border-default)] bg-[var(--color-surface-0)] px-5 py-4">
            {isPaused ? (
              <ControlButton primary label="Resume" icon={Play} onClick={resume} />
            ) : (
              <ControlButton label="Pause" icon={Pause} onClick={pause} disabled={!isActive} />
            )}
            <ControlButton destructive label="Stop" icon={Square} onClick={stop} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------- */

function StatePill({ state }: { state: ReturnType<typeof useRecording>['state'] }) {
  const { label, colour } = React.useMemo(() => {
    switch (state) {
      case 'requesting-mic':
        return { label: 'Requesting mic', colour: 'rgba(255,255,255,0.35)' };
      case 'active':
        return { label: 'Recording', colour: 'var(--color-brand-green)' };
      case 'dozing':
        return { label: 'Paused', colour: 'var(--color-status-processing)' };
      case 'sleeping':
        return { label: 'Sleeping', colour: 'var(--color-status-limitation)' };
      case 'error':
        return { label: 'Error', colour: 'var(--color-status-failed)' };
      default:
        return { label: 'Idle', colour: 'rgba(255,255,255,0.25)' };
    }
  }, [state]);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-white"
      style={{ background: colour }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-white"
        style={{ boxShadow: '0 0 8px rgba(255,255,255,0.9)' }}
      />
      {label}
    </span>
  );
}

function HeroIconButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-white"
    >
      <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
    </button>
  );
}

function ControlButton({
  label,
  icon: Icon,
  onClick,
  primary,
  destructive,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick: () => void;
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const colour = destructive
    ? 'var(--color-status-failed)'
    : primary
      ? 'var(--color-brand-green)'
      : 'var(--color-surface-2)';
  const textColour = destructive || primary ? '#ffffff' : 'var(--color-text-primary)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-2 rounded-full px-5 py-2.5 text-[13.5px] font-semibold transition active:scale-95',
        disabled && 'cursor-not-allowed opacity-50'
      )}
      style={{ background: colour, color: textColour }}
    >
      <Icon className="h-4 w-4" strokeWidth={2.5} aria-hidden />
      {label}
    </button>
  );
}
