'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import type { SonnetQuestion } from '@/lib/recording/sonnet-session';

/**
 * Alert card — renders a stack of queued Sonnet questions and a dismiss
 * affordance. Mirrors iOS `AlertCardView` (CertMateUnified/Sources/Views/
 * Recording/AlertCardView.swift) so the inspector sees the same surface
 * on both platforms.
 *
 * Unlike iOS, the web client doesn't (yet) route a Yes/No response back
 * through Sonnet — it routes the inspector's next utterance through
 * Sonnet as the answer, same as the iOS voice-response path. The iOS
 * tap-to-answer buttons are marked as follow-up work in the parity
 * ledger; the web card surfaces only Dismiss for now.
 *
 * The card stack displays the head question prominently with a "+N more"
 * count badge when additional questions are queued behind it — the same
 * treatment iOS uses so inspectors can see at a glance that Sonnet has
 * follow-up items pending.
 */
export function AlertCard({
  questions,
  onDismiss,
}: {
  questions: SonnetQuestion[];
  onDismiss: (index: number) => void;
}) {
  if (questions.length === 0) return null;
  const head = questions[0];
  const remaining = questions.length - 1;

  return (
    <div
      role="alertdialog"
      aria-live="polite"
      aria-label="Sonnet question"
      className="pointer-events-auto flex w-full max-w-[640px] flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-surface-2)]/95 px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent)]">
            Question
          </p>
          <p className="text-[14px] leading-snug text-[var(--color-text-primary)]">
            {head.question}
          </p>
          {head.context ? (
            <p className="text-[12px] text-[var(--color-text-secondary)]">{head.context}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss question"
          onClick={() => onDismiss(0)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
        </button>
      </div>
      {remaining > 0 ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
          +{remaining} more question{remaining === 1 ? '' : 's'} queued
        </p>
      ) : null}
    </div>
  );
}
