'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import type { TourController } from '@/hooks/use-tour';
import { TourStepHighlight } from './tour-step-highlight';

/**
 * Floating tour controls + spotlight (Phase 3).
 *
 * Visual parity with iOS `TourOverlayView.swift:L13-L76`:
 *   - Capsule/pill floating at the bottom of the viewport.
 *   - Step counter (N/TOTAL).
 *   - Back / pause-resume / forward / stop.
 *
 * Renders nothing when the controller is inactive — callers can mount
 * this unconditionally (e.g. at the root of the app-shell tree) and
 * have it appear only when a tour is live.
 *
 * Composition:
 *   - `<TourStepHighlight />` draws the dim + spotlight + tip.
 *   - This component owns the transport controls; they float above the
 *     spotlight on z-index 50 (highlight renders at z-40).
 */

export interface TourOverlayProps {
  controller: TourController;
}

export function TourOverlay({ controller }: TourOverlayProps) {
  const { active, stepIndex, total, currentStep, paused, next, prev, pause, resume, stop } =
    controller;

  if (!active || !currentStep) return null;

  const atStart = stepIndex === 0;
  const atEnd = stepIndex + 1 >= total;

  return (
    <>
      <TourStepHighlight step={currentStep} />

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div
          role="toolbar"
          aria-label="Tour controls"
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]/95 px-3 py-2 shadow-lg backdrop-blur"
        >
          <span
            className="mx-1 min-w-[38px] text-center text-[12px] font-semibold tracking-wider tabular-nums text-[var(--color-text-secondary)]"
            aria-label={`Step ${stepIndex + 1} of ${total}`}
          >
            {stepIndex + 1}/{total}
          </span>

          <TourButton label="Previous step" disabled={atStart} onClick={prev}>
            <ChevronLeft className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </TourButton>

          <TourButton
            label={paused ? 'Resume tour' : 'Pause tour'}
            variant="primary"
            onClick={paused ? resume : pause}
          >
            {paused ? (
              <Play className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            ) : (
              <Pause className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            )}
          </TourButton>

          <TourButton label={atEnd ? 'Finish tour' : 'Next step'} onClick={next}>
            <ChevronRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </TourButton>

          <TourButton label="Stop tour" onClick={stop}>
            <X className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </TourButton>
        </div>
      </div>
    </>
  );
}

function TourButton({
  label,
  children,
  disabled = false,
  onClick,
  variant = 'default',
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  variant?: 'default' | 'primary';
}) {
  const bg =
    variant === 'primary'
      ? 'bg-[var(--color-brand-blue)]/12 text-[var(--color-brand-blue)]'
      : 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]';
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${bg}`}
    >
      {children}
    </button>
  );
}
