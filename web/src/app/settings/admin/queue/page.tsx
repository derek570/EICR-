'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Server } from 'lucide-react';
import { api } from '@/lib/api-client';
import {
  ApiError,
  type AdminQueueHealthResponse,
  type AdminQueueStatusResponse,
} from '@/lib/types';
import { useCurrentUser } from '@/lib/use-current-user';
import { isSystemAdmin } from '@/lib/roles';
import { Button } from '@/components/ui/button';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Admin Task Queue — partial parity with iOS `AdminQueueView.swift`.
 *
 * iOS asks for `GET /api/tasks` and renders an "active / queued / background"
 * view of team-lead tasks. That endpoint does not exist on the backend
 * (verified 2026-04-26), so the iOS view is broken in production. The web
 * port instead surfaces the working endpoints — `/api/admin/queue/status`
 * and `/api/admin/queue/health` — which return the live job-processing
 * queue state. Same intent (admin visibility into background work), real
 * data, no replicated bug.
 *
 * Replace with a richer `team-lead tasks` view if/when the backend gains
 * an `/api/tasks` route — at that point this page is the natural home for
 * the kill / pause controls iOS exposes.
 */
export default function AdminQueuePage() {
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();
  const [status, setStatus] = React.useState<AdminQueueStatusResponse | null>(null);
  const [health, setHealth] = React.useState<AdminQueueHealthResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const allowed = !!user && isSystemAdmin(user);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([api.adminGetQueueStatus(), api.adminGetQueueHealth()]);
      setStatus(s);
      setHealth(h);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Failed to load';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void reload();
  }, [allowed, reload]);

  if (userLoading || (loading && allowed)) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <div className="cm-shimmer h-10 w-1/3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
        <div className="cm-shimmer h-32 w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <BackLink onClick={() => router.push('/settings')} />
        <SectionCard accent="amber" title="Not authorised">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            The task queue view is visible only to system administrators.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <BackLink onClick={() => router.push('/settings')} />

      <HeroHeader
        eyebrow="Administration"
        title="Task Queue"
        subtitle="Background job processing state."
        icon={<Server className="h-10 w-10" aria-hidden />}
      />

      {error ? (
        <SectionCard accent="amber" title="Error">
          <p className="text-[13px] text-[var(--color-text-secondary)]">{error}</p>
          <Button variant="ghost" size="sm" onClick={reload} className="mt-2 gap-1">
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </Button>
        </SectionCard>
      ) : null}

      <SectionCard accent="blue" title="Queue Status">
        <DetailJson
          label={status?.status ?? 'unknown'}
          payload={status?.queue ?? status?.message ?? null}
        />
      </SectionCard>

      <SectionCard accent="blue" title="Queue Health">
        <DetailJson
          label={health?.status ?? 'unknown'}
          payload={health?.health ?? health?.message ?? null}
        />
      </SectionCard>

      <Button variant="ghost" size="sm" onClick={reload} className="gap-1 self-start">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Refresh
      </Button>
    </main>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="gap-1 self-start text-[var(--color-text-secondary)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Settings
    </Button>
  );
}

function DetailJson({ label, payload }: { label: string; payload: unknown }) {
  const tone =
    label === 'ok'
      ? 'var(--color-status-done)'
      : label === 'unavailable' || label === 'error'
        ? 'var(--color-status-failed)'
        : 'var(--color-text-secondary)';
  return (
    <div className="flex flex-col gap-2">
      <span
        className="inline-flex w-fit items-center rounded-full px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: tone, background: `color-mix(in oklab, ${tone} 15%, transparent)` }}
      >
        {label}
      </span>
      {payload ? (
        <pre className="overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 text-[12px] text-[var(--color-text-primary)]">
          {typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}
        </pre>
      ) : (
        <p className="text-[12px] text-[var(--color-text-tertiary)]">No payload returned.</p>
      )}
    </div>
  );
}
