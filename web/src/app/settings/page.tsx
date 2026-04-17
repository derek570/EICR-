'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, ChevronRight, LayoutDashboard, LogOut, ShieldCheck, Users } from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth } from '@/lib/auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { isCompanyAdmin, isSystemAdmin } from '@/lib/roles';
import { Button } from '@/components/ui/button';

/**
 * Settings hub. Ports iOS `SettingsView.swift` — hero profile header,
 * role badges, and stacked link cards into sub-sections.
 *
 * Phase 6a ships only the Staff section live. Company / Admin link
 * cards render conditionally (so the role gating is correct from day
 * one) but route to placeholders until 6b / 6c land — see the guarded
 * `href` logic below.
 */
export default function SettingsHubPage() {
  const router = useRouter();
  const { user } = useCurrentUser();

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

      {/* Team (Staff members) — Phase 6a lives here */}
      <SectionGroup title="TEAM">
        <LinkCard
          href="/settings/staff"
          icon={<Users className="h-5 w-5" aria-hidden />}
          title="Staff Members"
          subtitle="Manage inspectors, signatures, and test equipment"
          accent="blue"
        />
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
