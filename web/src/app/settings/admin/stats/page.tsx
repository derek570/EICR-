'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BarChart3,
  Cpu,
  Database,
  HardDrive,
  Heart,
  MemoryStick,
  RefreshCw,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError, type AdminHealthResponse, type AdminStatsResponse } from '@/lib/types';
import { useCurrentUser } from '@/lib/use-current-user';
import { isSystemAdmin } from '@/lib/roles';
import { Button } from '@/components/ui/button';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Admin Stats — mirrors iOS `AdminStatsView.swift`.
 *
 * Calls GET /api/admin/stats and GET /api/admin/health (both exist on
 * `src/admin_api.js`). The endpoints are mounted under `requireAuth`
 * only — the page itself is the role gate. Non-system-admins see the
 * "not authorised" panel and never trigger the request.
 */
export default function AdminStatsPage() {
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();
  const [stats, setStats] = React.useState<AdminStatsResponse | null>(null);
  const [health, setHealth] = React.useState<AdminHealthResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const allowed = !!user && isSystemAdmin(user);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([api.adminGetStats(), api.adminGetHealth()]);
      setStats(s);
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
    return <ShellSkeleton />;
  }

  if (!allowed) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <BackLink onClick={() => router.push('/settings')} />
        <SectionCard accent="amber" title="Not authorised">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            System statistics are visible only to system administrators.
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
        title="System Stats"
        subtitle="Health, usage, and performance."
        icon={<BarChart3 className="h-10 w-10" aria-hidden />}
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

      {stats ? (
        <SectionCard accent="blue" title="Overview">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatTile
              icon={<Users className="h-5 w-5" aria-hidden />}
              label="Users"
              value={asInt(stats.users?.total)}
              accent="blue"
            />
            <StatTile
              icon={<BarChart3 className="h-5 w-5" aria-hidden />}
              label="Jobs"
              value={asInt(stats.jobs?.total)}
              accent="green"
            />
            <StatTile
              icon={<Database className="h-5 w-5" aria-hidden />}
              label="Companies"
              value={asInt(stats.companies?.total)}
              accent="purple"
            />
          </div>
          {stats.storage ? (
            <p className="mt-3 text-[12px] text-[var(--color-text-tertiary)]">
              Storage backend: <strong>{stats.storage.toUpperCase()}</strong>
            </p>
          ) : null}
        </SectionCard>
      ) : null}

      {health ? (
        <SectionCard accent="blue" title="Server Health">
          <dl className="flex flex-col divide-y divide-[var(--color-border-subtle)] text-[13px]">
            <Row
              icon={<Heart className="h-4 w-4" aria-hidden />}
              label="Status"
              value={health.status?.toUpperCase() ?? '—'}
              tone={health.status === 'ok' ? 'good' : 'bad'}
            />
            {health.database ? (
              <Row
                icon={<Database className="h-4 w-4" aria-hidden />}
                label="Database"
                value={titleCase(health.database)}
                tone={health.database === 'connected' ? 'good' : 'bad'}
              />
            ) : null}
            {typeof health.uptime === 'number' ? (
              <Row
                icon={<RefreshCw className="h-4 w-4" aria-hidden />}
                label="Uptime"
                value={formatUptime(health.uptime)}
              />
            ) : null}
            {health.nodeVersion ? (
              <Row
                icon={<Cpu className="h-4 w-4" aria-hidden />}
                label="Node.js"
                value={health.nodeVersion}
              />
            ) : null}
            {health.storage ? (
              <Row
                icon={<HardDrive className="h-4 w-4" aria-hidden />}
                label="Storage"
                value={health.storage.toUpperCase()}
              />
            ) : null}
          </dl>
        </SectionCard>
      ) : null}

      {health?.memory ? (
        <SectionCard accent="blue" title="Memory Usage">
          <dl className="flex flex-col divide-y divide-[var(--color-border-subtle)] text-[13px]">
            {typeof health.memory.rss === 'number' ? (
              <Row
                icon={<MemoryStick className="h-4 w-4" aria-hidden />}
                label="RSS"
                value={`${health.memory.rss} MB`}
              />
            ) : null}
            {typeof health.memory.heapUsed === 'number' ? (
              <Row
                icon={<MemoryStick className="h-4 w-4" aria-hidden />}
                label="Heap used"
                value={`${health.memory.heapUsed} MB`}
              />
            ) : null}
            {typeof health.memory.heapTotal === 'number' ? (
              <Row
                icon={<MemoryStick className="h-4 w-4" aria-hidden />}
                label="Heap total"
                value={`${health.memory.heapTotal} MB`}
              />
            ) : null}
          </dl>
        </SectionCard>
      ) : null}

      {stats?.companies?.breakdown && stats.companies.breakdown.length > 0 ? (
        <SectionCard accent="blue" title="Companies">
          <ul className="flex flex-col divide-y divide-[var(--color-border-subtle)] text-[13px]">
            {stats.companies.breakdown.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 py-2 text-[var(--color-text-primary)]"
              >
                <span className="flex flex-col">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-[11px] text-[var(--color-text-tertiary)]">
                    {c.is_active === false ? 'Inactive' : 'Active'}
                  </span>
                </span>
                <span className="text-[12px] text-[var(--color-text-secondary)]">
                  {asInt(c.user_count)} users · {asInt(c.job_count)} jobs
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </main>
  );
}

function asInt(value: number | string | undefined): string {
  if (value === undefined || value === null) return '—';
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) ? n.toLocaleString() : String(value);
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

function formatUptime(seconds: number): string {
  const totalMin = Math.floor(seconds / 60);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function ShellSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="cm-shimmer h-10 w-1/3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-32 w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-48 w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
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

function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: 'blue' | 'green' | 'purple';
}) {
  const c =
    accent === 'blue'
      ? 'var(--color-brand-blue)'
      : accent === 'green'
        ? 'var(--color-brand-green)'
        : '#a855f7';
  return (
    <div className="flex flex-col items-start gap-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3">
      <span
        className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]"
        style={{ background: `color-mix(in oklab, ${c} 18%, transparent)`, color: c }}
      >
        {icon}
      </span>
      <span className="text-[20px] font-bold text-[var(--color-text-primary)]">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
        {label}
      </span>
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  const valueColor =
    tone === 'good'
      ? 'var(--color-status-done)'
      : tone === 'bad'
        ? 'var(--color-status-failed)'
        : 'var(--color-text-secondary)';
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="flex items-center gap-2 text-[var(--color-text-secondary)]">
        <span className="text-[var(--color-brand-blue)]">{icon}</span>
        {label}
      </dt>
      <dd className="font-medium" style={{ color: valueColor }}>
        {value}
      </dd>
    </div>
  );
}
