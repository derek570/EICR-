'use client';

import * as React from 'react';
import { useRouter, notFound } from 'next/navigation';
import { ArrowLeft, Bug } from 'lucide-react';
import { collectDiagnostics, type DiagnosticsSnapshot } from '@/lib/diagnostics';
import { getToken } from '@/lib/auth';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';

/**
 * Debug dashboard — iOS `DebugDashboardView.swift` minimal web port.
 *
 * Dev-triage only. Gated behind:
 *   1. `process.env.NODE_ENV !== 'production'` — OR
 *   2. `localStorage.cm-debug === '1'` — flipped by the About page
 *      toggle. In production, inspectors can still reach this page
 *      (by design: Derek uses the prod build in the field) but only
 *      if they deliberately flip the toggle.
 *
 * Content:
 *   - Masked current auth token (first 8 + last 4 chars; length).
 *   - IDB store row counts across every store in the shared DB.
 *   - Service-worker registration list + active state.
 *   - Raw diagnostics JSON in a scrollable pre block.
 *
 * No writes here — the clear-cache + export actions live on the
 * Diagnostics page so admins don't have to enable debug mode to
 * reach them.
 */

const DEBUG_KEY = 'cm-debug';

function readDebugFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

function maskToken(token: string | null): string {
  if (!token) return '—';
  if (token.length <= 12) return '***';
  return `${token.slice(0, 8)}…${token.slice(-4)} (${token.length} chars)`;
}

export default function DebugDashboardPage() {
  const router = useRouter();
  const [snapshot, setSnapshot] = React.useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [gated, setGated] = React.useState<'checking' | 'allow' | 'deny'>('checking');

  // Gate-check runs on mount; we can't rely on SSR because the flag
  // is in localStorage. While checking we render a placeholder so the
  // allow/deny path is a single code path downstream.
  React.useEffect(() => {
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev || readDebugFlag()) {
      setGated('allow');
    } else {
      setGated('deny');
    }
  }, []);

  React.useEffect(() => {
    if (gated !== 'allow') return;
    let alive = true;
    collectDiagnostics()
      .then((snap) => {
        if (!alive) return;
        setSnapshot(snap);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Failed to collect diagnostics.');
      });
    return () => {
      alive = false;
    };
  }, [gated]);

  if (gated === 'deny') {
    notFound();
  }

  if (gated === 'checking') {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <div className="py-12 text-center text-[var(--color-text-secondary)]">Checking access…</div>
      </main>
    );
  }

  const token = typeof window !== 'undefined' ? getToken() : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="gap-1 text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Settings
        </Button>
      </div>

      <HeroHeader
        eyebrow="Developer"
        title="Debug Dashboard"
        subtitle="Live state for support triage. Not for regular use."
        icon={<Bug className="h-10 w-10" aria-hidden />}
      />

      <SectionCard accent="blue" title="Authentication">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-[var(--color-text-secondary)]">Token (masked)</dt>
          <dd className="font-mono text-[var(--color-text-primary)]">{maskToken(token)}</dd>
          <dt className="text-[var(--color-text-secondary)]">User id</dt>
          <dd className="font-mono text-[var(--color-text-primary)]">
            {snapshot?.user?.id ?? '—'}
          </dd>
          <dt className="text-[var(--color-text-secondary)]">Company role</dt>
          <dd className="font-mono text-[var(--color-text-primary)]">
            {snapshot?.user?.company_role ?? '—'}
          </dd>
        </dl>
      </SectionCard>

      <SectionCard accent="amber" title="IDB stores">
        {snapshot ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[var(--color-text-tertiary)]">
                <th className="py-1 pr-2 font-medium">Store</th>
                <th className="py-1 font-medium">Rows</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(snapshot.idb.stores).map(([name, rows]) => (
                <tr key={name} className="border-t border-[var(--color-border-subtle)]">
                  <td className="py-1 pr-2 font-mono text-[var(--color-text-primary)]">{name}</td>
                  <td className="py-1 text-[var(--color-text-secondary)]">{rows.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[var(--color-text-secondary)]">Loading…</p>
        )}
      </SectionCard>

      <SectionCard accent="blue" title="Service worker">
        {snapshot ? (
          <ul className="flex flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
            {snapshot.service_worker.registrations.length === 0 ? (
              <li>No registrations.</li>
            ) : (
              snapshot.service_worker.registrations.map((r, i) => (
                <li key={i} className="font-mono">
                  {r.scope} · {r.active_state ?? 'inactive'}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard accent="magenta" title="Raw snapshot">
        {error ? (
          <p role="alert" className="text-[var(--color-status-failed)]">
            {error}
          </p>
        ) : null}
        <pre className="max-h-96 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-1)] p-3 text-[11px] leading-snug text-[var(--color-text-secondary)]">
          {snapshot ? JSON.stringify(snapshot, null, 2) : 'Collecting…'}
        </pre>
      </SectionCard>
    </main>
  );
}
