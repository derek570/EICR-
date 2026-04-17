'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  ChevronLeft,
  KeyRound,
  Mail,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import { isSystemAdmin } from '@/lib/roles';
import { ApiError } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Create-user form. Ports iOS `AdminCreateUserView.swift`.
 *
 * Unlike company invite (`inviteEmployee` — which generates the password
 * server-side and surfaces it once), admins choose the initial password
 * here. The admin is expected to hand it off out-of-band just like the
 * 6b invite flow — there's no email sending. Passwords ≥ 8 chars; we
 * check client-side so a bad password doesn't round-trip as a 400.
 *
 * `company_id` is intentionally a free-form UUID field with a small
 * hint — the handoff explicitly defers a company picker to a later
 * phase, so it's "advanced-only" here. Leaving it blank is the normal
 * path.
 */
export default function AdminCreateUserPage() {
  const router = useRouter();
  const { user } = useCurrentUser();

  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [companyName, setCompanyName] = React.useState('');
  const [companyId, setCompanyId] = React.useState('');
  const [role, setRole] = React.useState<'admin' | 'user'>('user');
  const [companyRole, setCompanyRole] = React.useState<'owner' | 'admin' | 'employee' | ''>(
    'employee'
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Role gate (middleware handles the main path; this is belt-and-braces).
  if (user && !isSystemAdmin(user)) {
    router.replace('/settings');
    return null;
  }

  const passwordShort = password.length > 0 && password.length < 8;
  const canSubmit =
    email.trim().length > 0 && name.trim().length > 0 && password.length >= 8 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminCreateUser({
        email: email.trim(),
        name: name.trim(),
        password,
        company_name: companyName.trim() || undefined,
        role,
        company_id: companyId.trim() || undefined,
        company_role: companyRole === '' ? undefined : companyRole,
      });
      router.push('/settings/admin/users');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('A user with this email already exists.');
      } else if (err instanceof ApiError && err.status === 400) {
        // Surface the backend message verbatim; it's user-friendly.
        setError(err.message || 'Invalid input');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create user');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 pb-32">
      <div className="flex items-center gap-3">
        <Link
          href="/settings/admin/users"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
          aria-label="Back to users list"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Link>
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">New user</h1>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <SectionCard accent="blue" icon={UserIcon} title="Account">
          <FloatingLabelInput
            label="Full Name *"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
          <FloatingLabelInput
            label="Email *"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            trailing={<Mail className="h-4 w-4" aria-hidden />}
          />
          <FloatingLabelInput
            label="Password *"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            state={passwordShort ? 'error' : 'default'}
            hint={
              passwordShort
                ? 'At least 8 characters required'
                : 'Hand this off to the user out-of-band — not emailed automatically.'
            }
            trailing={<KeyRound className="h-4 w-4" aria-hidden />}
          />
        </SectionCard>

        <SectionCard accent="blue" icon={ShieldCheck} title="Roles">
          <LabelledSelect
            label="System Role"
            value={role}
            onChange={(v) => setRole(v as 'admin' | 'user')}
            options={[
              { value: 'user', label: 'User' },
              { value: 'admin', label: 'Admin (system-wide)' },
            ]}
          />
          <LabelledSelect
            label="Company Role"
            value={companyRole}
            onChange={(v) => setCompanyRole(v as 'owner' | 'admin' | 'employee' | '')}
            options={[
              { value: 'employee', label: 'Employee' },
              { value: 'admin', label: 'Company Admin' },
              { value: 'owner', label: 'Owner' },
              { value: '', label: '— None —' },
            ]}
          />
        </SectionCard>

        <SectionCard accent="green" icon={Building2} title="Company (optional)">
          <FloatingLabelInput
            label="Company Name"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            hint="Displayed on the user's certificates."
          />
          <FloatingLabelInput
            label="Company ID"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            placeholder="UUID (advanced)"
            autoCapitalize="none"
            autoCorrect="off"
            hint="Leave blank unless you know the company UUID. A picker will land in a later phase."
          />
        </SectionCard>

        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
          >
            {error}
          </p>
        ) : null}

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-2 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push('/settings/admin/users')}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create user'}
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function LabelledSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const reactId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`group relative flex h-14 items-stretch rounded-[var(--radius-md)] border bg-[var(--color-surface-1)] transition focus-within:border-[var(--color-brand-blue)] ${
          disabled
            ? 'border-[var(--color-border-subtle)] opacity-60'
            : 'border-[var(--color-border-default)]'
        }`}
      >
        <div className="flex flex-1 flex-col justify-center px-3">
          <label
            htmlFor={reactId}
            className="pointer-events-none text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]"
          >
            {label}
          </label>
          <select
            id={reactId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="w-full bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] focus:outline-none"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
