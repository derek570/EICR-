'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Bug,
  ChevronRight,
  CloudUpload,
  Compass,
  Info,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth } from '@/lib/auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { useOutboxState } from '@/lib/pwa/use-outbox-state';
import { isCompanyAdmin, isSystemAdmin } from '@/lib/roles';
import { Button } from '@/components/ui/button';
import { IOSInstallHint } from '@/components/pwa/ios-install-hint';
import { resetTourState } from '@/lib/tour/state';

/**
 * Settings hub. Ports iOS `SettingsView.swift` — hero profile header,
 * role badges, and stacked link cards into sub-sections.
 *
 * Phase 6a ships only the Staff section live. Company / Admin link
 * cards render conditionally (so the role gating is correct from day
 * one) but route to placeholders until 6b / 6c land — see the guarded
 * `href` logic below.
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

export default function SettingsHubPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  // Phase 7d — surface the "Offline Sync" card only when there's
  // something to do there. Rendering it unconditionally would clutter
  // the hub for the 99% of sessions where the outbox is empty; the
  // OfflineIndicator pills in the header still link to the page when
  // poisoned rows exist, and pending-only rows drain themselves so
  // there's no user-facing action to take.
  const { pending, poisoned, loading: outboxLoading } = useOutboxState();
  const hasOutboxWork = !outboxLoading && pending.length + poisoned.length > 0;

  // Phase 6 — debug dashboard gate. Linked from the hub only when the
  // About page toggle has set `cm-debug=1` so regular inspectors never
  // discover it by scrolling.
  const [debugEnabled, setDebugEnabled] = React.useState(false);
  React.useEffect(() => {
    setDebugEnabled(readDebugFlag());
  }, []);

  async function handleSignOut() {
    try {
      await api.logout();
    } catch {
      // Local clear is the critical bit.
    }
    clearAuth();
    router.replace('/login');
  }

  if (!user) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      {/* Hero profile header — avatar + name + role pills */}
      <section className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div
            aria-hidden
            className="flex h-20 w-20 items-center justify-center rounded-full text-3xl font-bold text-white"
            style={{
              background:
                'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
            }}
          >
            {initial}
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-[20px] font-bold text-[var(--color-text-primary)]">{user.name}</h1>
            <p className="text-[13px] text-[var(--color-text-secondary)]">{user.email}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {user.role ? (
              <RoleBadge color="blue">{user.role[0].toUpperCase() + user.role.slice(1)}</RoleBadge>
            ) : null}
            {user.company_role && user.company_role !== 'employee' ? (
              <RoleBadge color="green">
                {user.company_role[0].toUpperCase() + user.company_role.slice(1)}
              </RoleBadge>
            ) : null}
          </div>
        </div>
      </section>

      {/*
       * iOS Add-to-Home-Screen hint (Phase 7b). Self-suppresses on
       * non-iOS, already-installed, and previously-dismissed. Rendered
       * here rather than on the dashboard to avoid pushing the Recent
       * Jobs list below the fold on phones during the primary workflow.
       */}
      <IOSInstallHint />

      {/* Team (Staff members) — Phase 6a lives here */}
      <SectionGroup title="TEAM">
        <LinkCard
          href="/settings/staff"
          icon={<Users className="h-5 w-5" aria-hidden />}
          title="Staff Members"
          subtitle="Manage inspectors, signatures, and test equipment"
          accent="blue"
        />
        {isCompanyAdmin(user) ? (
          <LinkCard
            href="/settings/invite"
            icon={<UserPlus className="h-5 w-5" aria-hidden />}
            title="Invite Employee"
            subtitle="Add a team member and share a one-time password"
            accent="green"
          />
        ) : null}
      </SectionGroup>

      {/* Certificate Defaults — Phase 6. iOS `DefaultsManagerView`.
          Links to the hub which then splits into Default Values +
          Cable Size Defaults. */}
      <SectionGroup title="CERTIFICATE DEFAULTS">
        <LinkCard
          href="/settings/defaults"
          icon={<SlidersHorizontal className="h-5 w-5" aria-hidden />}
          title="Defaults Manager"
          subtitle="Preset circuit fields and per-type cable sizing"
          accent="blue"
        />
      </SectionGroup>

      {/* Account — Phase 6 (change password) */}
      <SectionGroup title="ACCOUNT">
        <LinkCard
          href="/settings/change-password"
          icon={<KeyRound className="h-5 w-5" aria-hidden />}
          title="Change Password"
          subtitle="Update the password you use to sign in"
          accent="blue"
        />
      </SectionGroup>

      {/* Guided tour — Phase 3. Re-runs the dashboard walkthrough by
          clearing the `seen`/`disabled` flags; the next time the
          dashboard mounts, the tour auto-starts again. We don't run
          it from here (settings is the wrong surface for a dashboard
          tour) — the redirect to /dashboard lets the tour hook pick
          it up on mount. */}
      <SectionGroup title="APP">
        <button
          type="button"
          onClick={async () => {
            await resetTourState();
            router.push('/dashboard');
          }}
          className="block w-full text-left focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] rounded-[var(--radius-lg)]"
        >
          <div className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 transition hover:bg-[var(--color-surface-3)]">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
              style={{
                color: 'var(--color-brand-blue)',
                background: 'color-mix(in oklab, var(--color-brand-blue) 15%, transparent)',
              }}
            >
              <Compass className="h-5 w-5" aria-hidden />
            </span>
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
                Start tour
              </span>
              <span className="text-[12px] text-[var(--color-text-secondary)]">
                Replay the guided dashboard walkthrough
              </span>
            </div>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]"
              aria-hidden
            />
          </div>
        </button>
      </SectionGroup>

      {/* Company — details page is visible to any authenticated user
          (read-only for non-admins so they can verify the branding that
          will print on their certs). Dashboard is company-admin only. */}
      <SectionGroup title="COMPANY">
        <LinkCard
          href="/settings/company"
          icon={<Building2 className="h-5 w-5" aria-hidden />}
          title="Company Details"
          subtitle={
            isCompanyAdmin(user)
              ? 'Branding, address, contact info, and logo'
              : 'Branding and contact info (view-only)'
          }
          accent="green"
        />
        {isCompanyAdmin(user) ? (
          <LinkCard
            href="/settings/company/dashboard"
            icon={<LayoutDashboard className="h-5 w-5" aria-hidden />}
            title="Company Dashboard"
            subtitle="Team, jobs, and stats at a glance"
            accent="green"
          />
        ) : null}
      </SectionGroup>

      {/* Offline Sync — Phase 7d. Any authenticated user; conditionally
          rendered only when the local outbox has pending or poisoned
          rows. Counts are live via `useOutboxState` + BroadcastChannel
          so the card disappears the moment the replay worker drains
          the queue or the user discards/retries the last failed row. */}
      {hasOutboxWork ? (
        <SectionGroup title="OFFLINE SYNC">
          <LinkCard
            href="/settings/system"
            icon={<CloudUpload className="h-5 w-5" aria-hidden />}
            title="Offline Sync"
            subtitle={
              poisoned.length > 0
                ? `${poisoned.length} failed \u00b7 ${pending.length} pending`
                : `${pending.length} pending edit${pending.length === 1 ? '' : 's'} waiting to sync`
            }
            accent={poisoned.length > 0 ? 'blue' : 'green'}
          />
        </SectionGroup>
      ) : null}

      {/* Administration — system admin only; landed in 6c */}
      {isSystemAdmin(user) ? (
        <SectionGroup title="ADMINISTRATION">
          <LinkCard
            href="/settings/admin/users"
            icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
            title="Manage Users"
            subtitle="Create, edit, reset passwords, unlock accounts"
            accent="blue"
          />
        </SectionGroup>
      ) : null}

      {/* Support — Phase 6. Diagnostics + About. Debug row only
          appears when the About-page toggle has been flipped. */}
      <SectionGroup title="SUPPORT">
        <LinkCard
          href="/settings/diagnostics"
          icon={<Wrench className="h-5 w-5" aria-hidden />}
          title="Diagnostics"
          subtitle="Export state snapshot or clear local cache"
          accent="blue"
        />
        <LinkCard
          href="/settings/about"
          icon={<Info className="h-5 w-5" aria-hidden />}
          title="About"
          subtitle="Version, acknowledgments, and developer tools"
          accent="blue"
        />
        {debugEnabled ? (
          <LinkCard
            href="/settings/debug"
            icon={<Bug className="h-5 w-5" aria-hidden />}
            title="Debug Dashboard"
            subtitle="Live state for support triage"
            accent="blue"
          />
        ) : null}
      </SectionGroup>

      <Button
        variant="ghost"
        onClick={handleSignOut}
        className="mt-2 h-12 w-full justify-center gap-2 text-[var(--color-status-failed)] hover:bg-[color-mix(in_oklab,var(--color-status-failed)_10%,transparent)]"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        Log out
      </Button>
    </main>
  );
}

// ---------------------------------------------------------------------------

function SectionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
        {title}
      </h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function LinkCard({
  href,
  icon,
  title,
  subtitle,
  accent,
  disabled = false,
  disabledLabel,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: 'blue' | 'green';
  disabled?: boolean;
  disabledLabel?: string;
}) {
  const accentColor = accent === 'blue' ? 'var(--color-brand-blue)' : 'var(--color-brand-green)';
  const inner = (
    <div className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 transition hover:bg-[var(--color-surface-3)]">
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{
          color: accentColor,
          background: `color-mix(in oklab, ${accentColor} 15%, transparent)`,
        }}
      >
        {icon}
      </span>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</span>
        <span className="text-[12px] text-[var(--color-text-secondary)]">{subtitle}</span>
        {disabled && disabledLabel ? (
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{disabledLabel}</span>
        ) : null}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
    </div>
  );
  if (disabled) {
    return (
      <div aria-disabled className="opacity-50 pointer-events-none">
        {inner}
      </div>
    );
  }
  return (
    <Link
      href={href}
      className="block focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] rounded-[var(--radius-lg)]"
    >
      {inner}
    </Link>
  );
}

function RoleBadge({ color, children }: { color: 'blue' | 'green'; children: React.ReactNode }) {
  const c = color === 'blue' ? 'var(--color-brand-blue)' : 'var(--color-brand-green)';
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-0.5 text-[11px] font-semibold tracking-[0.04em]"
      style={{
        color: c,
        background: `color-mix(in oklab, ${c} 15%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}
