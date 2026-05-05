'use client';

import * as React from 'react';
import { Check, X, ThumbsDown } from 'lucide-react';
import type { SonnetQuestion } from '@/lib/recording/sonnet-session';

/**
 * Alert card — renders a stack of queued Sonnet questions and the
 * three iOS-canon affordances: Accept ("Yes" / "Updated"), Reject
 * ("No" / "Okay, keeping it"), and Dismiss (silent close, no
 * wire-back). Mirrors iOS `AlertCardView`
 * (CertMateUnified/Sources/Views/Recording/AlertCardView.swift) and
 * `AlertManager.handleTapResponse` (line 610) so the inspector sees
 * the same surface on both platforms.
 *
 * Accept / Reject behaviour:
 *   - For Stage 6 ask_user questions (those carrying a tool_call_id),
 *     the host wires Accept to `sendAskUserAnswered(toolCallId, 'yes',
 *     utteranceId)` and Reject to `'no'` — Sonnet's tool loop then
 *     resolves with the canonical yes/no shape it can route through
 *     the same answer resolver as a spoken response.
 *   - For legacy questions without a tool_call_id, only Dismiss is
 *     active (the wire-back path doesn't exist for those — they're
 *     resolved by the next inspector utterance via the overtake
 *     classifier).
 *
 * The card stack displays the head question prominently with a "+N
 * more" count badge when additional questions are queued behind it —
 * the same treatment iOS uses so inspectors can see at a glance that
 * Sonnet has follow-up items pending.
 */
export function AlertCard({
  questions,
  onDismiss,
  onAccept,
  onReject,
}: {
  questions: SonnetQuestion[];
  onDismiss: (index: number) => void;
  onAccept?: (index: number) => void;
  onReject?: (index: number) => void;
}) {
  if (questions.length === 0) return null;
  const head = questions[0];
  const remaining = questions.length - 1;
  // Wire-back actions only make sense for Stage 6 ask_user. Hide
  // accept/reject for legacy questions so the inspector doesn't tap a
  // dead button.
  const hasWireBack = Boolean(head.tool_call_id);

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
      {hasWireBack && (onAccept || onReject) ? (
        <div className="flex items-center justify-end gap-2 pt-1">
          {onReject ? (
            <button
              type="button"
              aria-label="Reject — keep current value"
              onClick={() => onReject(0)}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-3)] px-3 text-[12px] font-semibold text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-4)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <ThumbsDown className="h-3 w-3" strokeWidth={2.5} aria-hidden />
              No
            </button>
          ) : null}
          {onAccept ? (
            <button
              type="button"
              aria-label="Accept — apply suggestion"
              onClick={() => onAccept(0)}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--color-status-passed)] px-3 text-[12px] font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden />
              Yes
            </button>
          ) : null}
        </div>
      ) : null}
      {remaining > 0 ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
          +{remaining} more question{remaining === 1 ? '' : 's'} queued
        </p>
      ) : null}
    </div>
  );
}
