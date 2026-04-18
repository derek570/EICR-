'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import { isSystemAdmin } from '@/lib/roles';
import type { AdminUser } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Pill } from '@/components/ui/pill';
import { formatShortDate } from '@/lib/format';

/**
 * System-admin user list. Ports iOS `AdminUsersListView.swift`.
 *
 * Route is gated by middleware (JWT `role` claim — see `middleware.ts`),
 * but we also belt-and-braces client-check with `isSystemAdmin` so a
 * tampered localStorage doesn't flash admin chrome.
 *
 * Pagination: always send `limit` + `offset` so the backend returns the
 * `Paginated<AdminUser>` envelope. Same reasoning as `companyJobs` in
 * 6b — keeps the response shape consistent.
 *
 * Row affordances are kept minimal: name/email, role pill, company-role
 * pill, and two status badges (Inactive / Locked). Edit + reset +
 * unlock all live on the detail page — no inline actions in the list
 * (iOS doesn't either, and inline actions on small rows create mis-tap
 * hazards).
 */
const PAGE_SIZE = 50;

export default function AdminUsersListPage() {
  const router = useRouter();
  const { user } = useCurrentUser();

  const [users, setUsers] = React.useState<AdminUser[] | null>(null);
  const [offset, setOffset] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setUsers(null);
    api
      .adminListUsers({ limit: PAGE_SIZE, offset })
      .then((res) => {
        if (cancelled) return;
        setUsers(res.data);
        setTotal(res.pagination.total);
        setHasMore(res.pagination.hasMore);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load users');
      });
    return () => {
      cancelled = true;
    };
  }, [offset]);

  // Refresh on tab focus so edits made in the detail page (and the
  // "back" navigation after reset / unlock) show up without reloading.
  React.useEffect(() => {
    const onFocus = () => {
      api
        .adminListUsers({ limit: PAGE_SIZE, offset })
        .then((res) => {
          setUsers(res.data);
          setTotal(res.pagination.total);
          setHasMore(res.pagination.hasMore);
        })
        .catch(() => {
          // Silent — the next explicit action will surface the error.
        });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [offset]);

  // Role gate. Middleware covers the common path; this handles any
  // client-side promotion loss mid-session.
  if (user && !isSystemAdmin(user)) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <ShieldAlert className="h-12 w-12 text-[var(--color-text-tertiary)]" aria-hidden />
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">Not authorised</h1>
        <p className="max-w-sm text-[13px] text-[var(--color-text-secondary)]">
          Only system administrators can manage users.
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

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-3">
        {/* D8: 44×44 back-link (was 36×36). */}
        <IconButton asChild aria-label="Back to settings">
          <Link href="/settings">
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Link>
        </IconButton>
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">Manage Users</h1>
        <span className="ml-auto" />
        <Button
          size="sm"
          onClick={() => router.push('/settings/admin/users/new')}
          className="gap-1"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New user
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
        >
          {error}
        </p>
      ) : null}

      {!users ? (
        <LoadingRows count={5} />
      ) : users.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-10 text-center">
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{
              color: 'var(--color-brand-blue)',
              background: 'color-mix(in oklab, var(--color-brand-blue) 10%, transparent)',
            }}
          >
            <Users className="h-7 w-7" aria-hidden />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">No users</h2>
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              Create the first user to get started.
            </p>
          </div>
        </section>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => (
            <AdminUserRow key={u.id} row={u} isSelf={u.id === user.id} />
          ))}
        </div>
      )}

      {users && users.length > 0 ? (
        <div className="mt-1 flex items-center justify-between text-[12px] text-[var(--color-text-tertiary)]">
          <span>
            Showing {offset + 1}–{offset + users.length} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
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
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------

function AdminUserRow({ row, isSelf }: { row: AdminUser; isSelf: boolean }) {
  // Stable per-mount "now" — react-hooks/purity disallows calling Date.now()
  // directly in render. The list is re-fetched on tab focus so an expired
  // lockout clears within one refresh cycle, which is plenty of freshness.
  const [nowMs] = React.useState(() => Date.now());
  const initial = (row.name || row.email).trim().charAt(0).toUpperCase();
  const isLocked = Boolean(row.locked_until && new Date(row.locked_until).getTime() > nowMs);
  return (
    <Link
      href={`/settings/admin/users/${encodeURIComponent(row.id)}`}
      className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3 transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
    >
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
        <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <span className="truncate">{row.name || '(no name)'}</span>
          {isSelf ? (
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
              you
            </span>
          ) : null}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">
          {row.email}
          {row.last_login ? ` · last seen ${formatShortDate(row.last_login)}` : ''}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {row.is_active === false ? (
          <Pill color="red" inline>
            Inactive
          </Pill>
        ) : null}
        {isLocked ? (
          <Pill color="amber" inline>
            <Lock className="mr-1 inline-block h-2.5 w-2.5" aria-hidden />
            Locked
          </Pill>
        ) : null}
        {row.role === 'admin' ? (
          <Pill color="blue" inline>
            <ShieldCheck className="mr-1 inline-block h-2.5 w-2.5" aria-hidden />
            Admin
          </Pill>
        ) : (
          <Pill color="neutral" inline>
            User
          </Pill>
        )}
        {row.company_role && row.company_role !== 'employee' ? (
          <Pill color="green" inline>
            {row.company_role}
          </Pill>
        ) : null}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
    </Link>
  );
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div aria-busy aria-live="polite" className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
        />
      ))}
    </div>
  );
}
