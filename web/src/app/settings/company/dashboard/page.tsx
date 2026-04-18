'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Mail,
  ShieldAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import { isCompanyAdmin, isSystemAdmin } from '@/lib/roles';
import type {
  CompanyJobRow,
  CompanyMember,
  CompanyStats,
  InviteEmployeeResponse,
} from '@/lib/types';
import { ApiError } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { Pill } from '@/components/ui/pill';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatShortDate } from '@/lib/format';

/**
 * Company admin dashboard. Ports iOS `CompanyDashboardView.swift`.
 *
 * Scope: company-admin and system-admin only (the backend already
 * enforces this with `requireCompanyAdmin`, but we guard client-side
 * too so non-admins get a friendly "not authorised" instead of a 403
 * flash). Shows three tabs via the existing `SegmentedControl`
 * primitive:
 *
 *   - Jobs  — paginated list (50 / page). Rows show employee + status
 *             + cert type. No charts (handoff §"Scope exclusions").
 *   - Team  — employees in the company, with role pill + active
 *             badge + last-login hint. Invite button opens a sheet
 *             that creates a user server-side and returns a one-time
 *             plaintext password which we surface with a copy button.
 *   - Stats — 3 count cards + a status breakdown. No trend chart; the
 *             handoff explicitly defers charts to a later phase.
 *
 * The page assumes `user.company_id` is set — if it isn't (legacy
 * system-admin without a company), we show a small "not part of a
 * company" state so the page doesn't 500 on the stats call.
 */
type Tab = 'jobs' | 'team' | 'stats';

export default function CompanyDashboardPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const [tab, setTab] = React.useState<Tab>('jobs');

  // Role gate — belt-and-braces. Middleware gates /settings/admin/*;
  // /settings/company/dashboard is technically reachable but the
  // backend will 403 without company-admin, so we intercept here.
  if (user && !isCompanyAdmin(user)) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <ShieldAlert className="h-12 w-12 text-[var(--color-text-tertiary)]" aria-hidden />
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">Not authorised</h1>
        <p className="max-w-sm text-[13px] text-[var(--color-text-secondary)]">
          Only company owners and admins can view the company dashboard.
        </p>
        <Button variant="secondary" onClick={() => router.push('/settings')}>
          Back to Settings
        </Button>
      </main>
    );
  }

  if (!user) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  // System admins without a company membership can't exercise the
  // per-company endpoints — surface a helpful state rather than
  // firing requests that will 404 on lookup.
  if (!user.company_id) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <Users className="h-12 w-12 text-[var(--color-text-tertiary)]" aria-hidden />
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">
          No company linked
        </h1>
        <p className="max-w-sm text-[13px] text-[var(--color-text-secondary)]">
          Your account isn&apos;t associated with a company yet.
          {isSystemAdmin(user)
            ? ' Use the admin area to assign yourself to one.'
            : ' Ask a system administrator to assign you.'}
        </p>
        <Button variant="secondary" onClick={() => router.push('/settings')}>
          Back to Settings
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-3">
        <Link
          href="/settings"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
          aria-label="Back to settings"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Link>
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">
          Company Dashboard
        </h1>
      </div>

      <SegmentedControl<Tab>
        aria-label="Dashboard section"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'jobs', label: 'Jobs' },
          { value: 'team', label: 'Team' },
          { value: 'stats', label: 'Stats' },
        ]}
      />

      {tab === 'jobs' ? <JobsTab companyId={user.company_id} /> : null}
      {tab === 'team' ? <TeamTab companyId={user.company_id} /> : null}
      {tab === 'stats' ? <StatsTab companyId={user.company_id} /> : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Jobs tab
// ---------------------------------------------------------------------------

const JOBS_PAGE_SIZE = 50;

function JobsTab({ companyId }: { companyId: string }) {
  const [offset, setOffset] = React.useState(0);
  const [jobs, setJobs] = React.useState<CompanyJobRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setJobs(null);
    api
      .companyJobs(companyId, { limit: JOBS_PAGE_SIZE, offset })
      .then((res) => {
        if (cancelled) return;
        setJobs(res.data);
        setTotal(res.pagination.total);
        setHasMore(res.pagination.hasMore);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, offset]);

  if (error) {
    return <ErrorBanner message={error} />;
  }

  if (!jobs) {
    return <LoadingRows count={5} />;
  }

  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={<Briefcase className="h-7 w-7" aria-hidden />}
        title="No jobs yet"
        subtitle="Jobs created by any employee will appear here."
      />
    );
  }

  const page = Math.floor(offset / JOBS_PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE));

  return (
    <section className="flex flex-col gap-2">
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} />
      ))}

      <div className="mt-3 flex items-center justify-between text-[12px] text-[var(--color-text-tertiary)]">
        <span>
          Showing {offset + 1}–{offset + jobs.length} of {total}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - JOBS_PAGE_SIZE))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Prev
          </Button>
          <span className="px-2 text-[12px]">
            {page} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasMore}
            onClick={() => setOffset(offset + JOBS_PAGE_SIZE)}
          >
            Next
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}

function JobRow({ job }: { job: CompanyJobRow }) {
  const statusColor = STATUS_COLOR[job.status] ?? 'var(--color-text-tertiary)';
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: statusColor }}
      />
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {job.address ?? '(no address)'}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">
          {job.employee_name ?? 'Unassigned'} · {job.certificate_type ?? '—'} · {job.status}
        </span>
      </div>
      <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
        {formatShortDate(job.created_at)}
      </span>
    </div>
  );
}

const STATUS_COLOR: Record<CompanyJobRow['status'], string> = {
  pending: 'var(--color-text-tertiary)',
  processing: 'var(--color-status-processing)',
  done: 'var(--color-status-done)',
  failed: 'var(--color-status-failed)',
};

// ---------------------------------------------------------------------------
// Team tab
// ---------------------------------------------------------------------------

function TeamTab({ companyId }: { companyId: string }) {
  const [members, setMembers] = React.useState<CompanyMember[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setMembers(null);
    api
      .companyUsers(companyId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load team');
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, reload]);

  if (error) return <ErrorBanner message={error} />;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          {members ? `${members.length} member${members.length === 1 ? '' : 's'}` : '—'}
        </p>
        <Button size="sm" onClick={() => setInviting(true)} className="gap-1">
          <UserPlus className="h-4 w-4" aria-hidden />
          Invite
        </Button>
      </div>

      {!members ? (
        <LoadingRows count={4} />
      ) : members.length === 0 ? (
        <EmptyState
          icon={<Users className="h-7 w-7" aria-hidden />}
          title="No team members"
          subtitle="Invite employees to join your company."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {members.map((m) => (
            <TeamMemberRow key={m.id} member={m} />
          ))}
        </div>
      )}

      {inviting ? (
        <InviteEmployeeSheet
          companyId={companyId}
          onClose={() => setInviting(false)}
          onInvited={() => {
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function TeamMemberRow({ member }: { member: CompanyMember }) {
  const initial = (member.name || member.email).trim().charAt(0).toUpperCase();
  const roleLabel = member.company_role ?? 'member';
  const roleIsAdmin = member.company_role === 'owner' || member.company_role === 'admin';
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3">
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
        }}
      >
        {initial}
      </span>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {member.name || '(no name)'}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">
          {member.email}
          {member.last_login ? ` · last seen ${formatShortDate(member.last_login)}` : ''}
        </span>
      </div>
      {member.is_active === false ? (
        <Pill color="red">Inactive</Pill>
      ) : (
        <Pill color={roleIsAdmin ? 'green' : 'blue'}>{roleLabel}</Pill>
      )}
    </div>
  );
}

function InviteEmployeeSheet({
  companyId,
  onClose,
  onInvited,
}: {
  companyId: string;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InviteEmployeeResponse | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.inviteEmployee(companyId, {
        name: name.trim(),
        email: email.trim(),
      });
      setResult(res);
      onInvited();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('A user with this email already exists.');
      } else {
        setError(err instanceof Error ? err.message : 'Invite failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail on http: or when document isn't focused.
      // Password is still visible on-screen so the admin can copy manually.
    }
  }

  function handleClose() {
    // Explicit null so the temp password doesn't live past the modal.
    setResult(null);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-title"
    >
      <div className="mx-4 w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-5 shadow-lg">
        {result ? (
          <>
            <h3
              id="invite-title"
              className="text-[17px] font-bold text-[var(--color-text-primary)]"
            >
              Employee invited
            </h3>
            <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
              <strong>{result.name}</strong> has been added as an employee. Send them the temporary
              password below — it will only be shown once.
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-3 py-2">
              <code className="flex-1 font-mono text-[15px] text-[var(--color-text-primary)]">
                {result.temporaryPassword}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copyPassword}
                aria-label="Copy temporary password"
              >
                <Copy className="h-4 w-4" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-3 text-[11px] text-[var(--color-text-tertiary)]">
              For security, this password is never stored in plain text and cannot be retrieved
              again. The employee should change it on first login.
            </p>
            <div className="mt-5 flex justify-end">
              <Button onClick={handleClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <h3
              id="invite-title"
              className="text-[17px] font-bold text-[var(--color-text-primary)]"
            >
              Invite employee
            </h3>
            <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
              We&apos;ll create an account and show you a one-time temporary password to hand off.
            </p>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
              <FloatingLabelInput
                label="Full Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <FloatingLabelInput
                label="Email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                trailing={<Mail className="h-4 w-4" aria-hidden />}
              />
              {error ? (
                <p role="alert" className="text-[12px] text-[var(--color-status-failed)]">
                  {error}
                </p>
              ) : null}
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={handleClose} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !name.trim() || !email.trim()}>
                  {busy ? 'Inviting…' : 'Invite'}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats tab
// ---------------------------------------------------------------------------

function StatsTab({ companyId }: { companyId: string }) {
  const [stats, setStats] = React.useState<CompanyStats | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setStats(null);
    api
      .companyStats(companyId)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load stats');
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (error) return <ErrorBanner message={error} />;
  if (!stats) return <LoadingRows count={3} />;

  const statusEntries = Object.entries(stats.jobs_by_status ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Total Jobs"
          value={stats.total_jobs ?? 0}
          accent="blue"
          icon={<Briefcase className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Active Employees"
          value={stats.active_employees ?? 0}
          accent="green"
          icon={<Users className="h-5 w-5" aria-hidden />}
        />
        <StatCard
          label="Jobs (last 7 days)"
          value={stats.jobs_last_7_days ?? 0}
          accent="amber"
          icon={<Clock className="h-5 w-5" aria-hidden />}
        />
      </div>

      {statusEntries.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4">
          <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            Jobs by status
          </h3>
          <ul className="flex flex-col gap-1">
            {statusEntries.map(([status, count]) => (
              <li
                key={status}
                className="flex items-center justify-between text-[13px] text-[var(--color-text-secondary)]"
              >
                <span className="capitalize">{status}</span>
                <span className="font-mono text-[var(--color-text-primary)]">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function StatCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: number;
  accent: 'blue' | 'green' | 'amber';
  icon: React.ReactNode;
}) {
  const color =
    accent === 'blue'
      ? 'var(--color-brand-blue)'
      : accent === 'green'
        ? 'var(--color-brand-green)'
        : 'var(--color-status-processing)';
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4">
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{
          color,
          background: `color-mix(in oklab, ${color} 15%, transparent)`,
        }}
      >
        {icon}
      </span>
      <div className="flex flex-col">
        <span className="text-[22px] font-bold text-[var(--color-text-primary)]">{value}</span>
        <span className="text-[11px] uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
          {label}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
    >
      {message}
    </p>
  );
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div aria-busy aria-live="polite" className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
        />
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <section className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-10 text-center">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          color: 'var(--color-brand-blue)',
          background: 'color-mix(in oklab, var(--color-brand-blue) 10%, transparent)',
        }}
      >
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">{title}</h2>
        <p className="text-[12px] text-[var(--color-text-secondary)]">{subtitle}</p>
      </div>
    </section>
  );
}
