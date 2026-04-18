'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, CloudUpload, RotateCcw, Trash2 } from 'lucide-react';
import { discardMutation, requeueMutation, type OutboxMutation } from '@/lib/pwa/outbox';
import { useOutboxState } from '@/lib/pwa/use-outbox-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Offline-sync admin page (Phase 7d).
 *
 * Purpose: surface the contents of the offline-mutation outbox so an
 * inspector can:
 *   - See every edit that hasn't yet reached the server (pending rows
 *     + their attempt counts + last error).
 *   - Discard a row they no longer want to ship (e.g. a typo they
 *     corrected on iOS while the web tab was offline).
 *   - Re-queue a poisoned row whose underlying server state has been
 *     fixed (e.g. a 404 caused by a temporarily-missing parent
 *     resource that's now been restored).
 *
 * Why NOT gate on `isSystemAdmin`:
 *   - Outbox rows are tied to the user who created them. The data is
 *     local-only and the actions are scoped to that device. Hiding
 *     this page behind the admin role would lock normal inspectors
 *     out of resolving their own edits, which is the exact failure
 *     mode we're trying to prevent. Any authenticated user can
 *     reach this page.
 *
 * Design notes:
 *   - No backend calls — every action goes through the local
 *     `outbox.ts` helpers. A network interruption mid-action is
 *     impossible because IDB is local-only; the page can even be
 *     used entirely offline.
 *   - Discard is two-step (routed through `<ConfirmDialog>` from Wave 4
 *     D5) — this is the only data-loss path in the rebuild and the
 *     extra tap is cheap insurance against a misplaced one. Re-queue
 *     is one-step because worst case it re-poisons without losing
 *     anything.
 *   - Field patches are shown as a JSON preview (≤ 240 chars) to help
 *     inspectors decide. Full patches are kept in the mutation but
 *     not surfaced in UI — they're always small (single field flips
 *     in the debounced save path) but we'd rather truncate than
 *     accidentally show a 2KB circuit observation blob.
 */
export default function SyncAdminPage() {
  const { pending, poisoned, loading } = useOutboxState();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = React.useState<OutboxMutation | null>(null);

  function handleDiscard(m: OutboxMutation) {
    setPendingDiscard(m);
  }

  async function performDiscard() {
    const m = pendingDiscard;
    if (!m) return;
    setPendingDiscard(null);
    setBusyId(m.id);
    try {
      await discardMutation(m.id);
    } finally {
      setBusyId((cur) => (cur === m.id ? null : cur));
    }
  }

  async function handleRequeue(m: OutboxMutation) {
    setBusyId(m.id);
    try {
      await requeueMutation(m.id);
    } finally {
      setBusyId((cur) => (cur === m.id ? null : cur));
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <Link
          href="/settings"
          aria-label="Back to settings"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Link>
        <div className="flex flex-col">
          <h1 className="text-[20px] font-bold text-[var(--color-text-primary)]">Offline Sync</h1>
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Edits saved on this device that haven&rsquo;t reached the server yet.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">
          Loading&hellip;
        </div>
      ) : pending.length === 0 && poisoned.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-8 text-center">
          <p className="text-[15px] font-semibold text-[var(--color-text-primary)]">
            All caught up
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
            No pending or failed edits.
          </p>
        </div>
      ) : null}

      {poisoned.length > 0 ? (
        <Section
          title="Failed edits"
          subtitle="Server rejected these edits. Retry once the underlying issue is fixed, or discard them."
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
          accent="failed"
        >
          {poisoned.map((m) => (
            <Row
              key={m.id}
              mutation={m}
              variant="poisoned"
              busy={busyId === m.id}
              onDiscard={() => handleDiscard(m)}
              onRequeue={() => handleRequeue(m)}
            />
          ))}
        </Section>
      ) : null}

      {pending.length > 0 ? (
        <Section
          title="Pending edits"
          subtitle={'Waiting to sync. The app retries automatically when you\u2019re online.'}
          icon={<CloudUpload className="h-4 w-4" aria-hidden />}
          accent="brand"
        >
          {pending.map((m) => (
            <Row
              key={m.id}
              mutation={m}
              variant="pending"
              busy={busyId === m.id}
              onDiscard={() => handleDiscard(m)}
            />
          ))}
        </Section>
      ) : null}

      <ConfirmDialog
        open={pendingDiscard !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDiscard(null);
        }}
        title="Discard this edit?"
        description={
          'This can\u2019t be undone. The edit will be removed from the outbox and never reach the server.'
        }
        confirmLabel="Discard"
        confirmVariant="danger"
        onConfirm={performDiscard}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------

function Section({
  title,
  subtitle,
  icon,
  accent,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accent: 'brand' | 'failed';
  children: React.ReactNode;
}) {
  const color = accent === 'failed' ? 'var(--color-status-failed)' : 'var(--color-brand-blue)';
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          style={{ color, background: `color-mix(in oklab, ${color} 15%, transparent)` }}
          aria-hidden
        >
          {icon}
        </span>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
          <p className="text-[12px] text-[var(--color-text-secondary)]">{subtitle}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function Row({
  mutation,
  variant,
  busy,
  onDiscard,
  onRequeue,
}: {
  mutation: OutboxMutation;
  variant: 'pending' | 'poisoned';
  busy: boolean;
  onDiscard: () => void;
  onRequeue?: () => void;
}) {
  const created = new Date(mutation.createdAt);
  const createdStr = created.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const patchPreview = React.useMemo(() => formatPatch(mutation.patch), [mutation.patch]);

  return (
    <li className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            Job{' '}
            <Link
              href={`/job/${mutation.jobId}`}
              className="text-[var(--color-brand-blue)] hover:underline"
            >
              {mutation.jobId.slice(0, 8)}
            </Link>
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
            Saved {createdStr}
            {mutation.attempts > 0
              ? ` \u00b7 ${mutation.attempts} attempt${mutation.attempts === 1 ? '' : 's'}`
              : ''}
          </p>
          <pre className="mt-2 max-h-24 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] p-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
            {patchPreview}
          </pre>
          {mutation.lastError ? (
            <p
              className={`mt-2 text-[12px] ${
                variant === 'poisoned'
                  ? 'text-[var(--color-status-failed)]'
                  : 'text-[var(--color-text-tertiary)]'
              }`}
            >
              <span className="font-semibold">Last error:</span> {mutation.lastError}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {variant === 'poisoned' && onRequeue ? (
            <button
              type="button"
              onClick={onRequeue}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-brand-blue)]/40 bg-[var(--color-brand-blue)]/15 px-3 py-1 text-[12px] font-semibold text-[var(--color-brand-blue)] transition hover:bg-[var(--color-brand-blue)]/25 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--color-status-failed)] transition hover:bg-[var(--color-status-failed)]/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Discard
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * Render a patch as a single-line JSON preview, truncated to keep
 * the admin list readable. Sensitive-looking keys (none today, but
 * future ops like signature uploads might carry binary blobs) would
 * need stripping here — flag for follow-up when the OutboxOp union
 * grows beyond `saveJob`.
 */
function formatPatch(patch: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(patch, null, 2);
    if (text.length <= 240) return text;
    return `${text.slice(0, 240)}\u2026`;
  } catch {
    return '[unserialisable patch]';
  }
}
