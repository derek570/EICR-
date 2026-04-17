'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Building2,
  ChevronLeft,
  KeyRound,
  Lock,
  Mail,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  User as UserIcon,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import { isSystemAdmin } from '@/lib/roles';
import type { AdminUser } from '@/lib/types';
import { ApiError } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Admin edit user page. Ports iOS `AdminEditUserView.swift`.
 *
 * Loads the row out of the paginated list (the backend has no
 * `GET /api/admin/users/:id` — the list is the source of truth, and
 * 50-per-page is plenty to scan forwards from the default page). If
 * the row isn't in the first few pages we show a "not found" state;
 * this matches the iOS behaviour of keying off the already-loaded
 * array rather than doing a separate fetch.
 *
 * Self-edit guard: the backend 400s if an admin tries to demote or
 * deactivate themselves (`admin-users.js:129-135`). We disable those
 * fields client-side so the admin doesn't have to wait for the
 * round-trip to discover the problem.
 *
 * Reset-password and Unlock are separate flows because the backend
 * modelled them as their own endpoints — bundling them into the
 * generic PUT would force the admin to type a password just to flip
 * `is_active`, which is a worse UX.
 *
 * No delete button — the backend has no delete endpoint and iOS
 * doesn't surface one either. Deactivation via `is_active: false` is
 * the soft-delete path.
 */
export default function AdminEditUserPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const { user: currentUser, refresh: refreshCurrent } = useCurrentUser();

  const [row, setRow] = React.useState<AdminUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unlocking, setUnlocking] = React.useState(false);
  const [showResetSheet, setShowResetSheet] = React.useState(false);

  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [companyName, setCompanyName] = React.useState('');
  const [role, setRole] = React.useState<'admin' | 'user'>('user');
  const [isActive, setIsActive] = React.useState(true);

  // Stable per-mount "now" — react-hooks/purity disallows Date.now() in render.
  // `load()` re-runs after unlock, so if the lockout expires naturally between
  // renders a focus/refresh will clear the badge on the next navigation.
  const [nowMs] = React.useState(() => Date.now());
  const isSelf = currentUser?.id === userId;
  const isLocked = Boolean(row?.locked_until && new Date(row.locked_until).getTime() > nowMs);

  // Load the row. Scan paginated pages until we find it — almost
  // always hits on page 1 (default order is newest first, and admins
  // typically edit users they just created or a handful of heavy
  // users). Bail at a reasonable cap so a bad URL doesn't spin.
  const load = React.useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    setError(null);
    const PAGE = 50;
    const MAX_PAGES = 20; // 1000 users — well beyond any single tenant.
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const res = await api.adminListUsers({ limit: PAGE, offset: i * PAGE });
        const found = res.data.find((u) => u.id === userId);
        if (found) {
          setRow(found);
          setName(found.name ?? '');
          setEmail(found.email ?? '');
          setCompanyName(found.company_name ?? '');
          setRole(found.role ?? 'user');
          setIsActive(found.is_active !== false);
          return;
        }
        if (!res.pagination.hasMore) break;
      }
      setNotFound(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    if (!currentUser) return;
    void load();
  }, [currentUser, load]);

  // Role gate.
  if (currentUser && !isSystemAdmin(currentUser)) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <ShieldAlert className="h-12 w-12 text-[var(--color-text-tertiary)]" aria-hidden />
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">Not authorised</h1>
        <Button variant="secondary" onClick={() => router.push('/settings')}>
          Back to Settings
        </Button>
      </main>
    );
  }

  if (!currentUser || loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  if (notFound || !row) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <UserIcon className="h-12 w-12 text-[var(--color-text-tertiary)]" aria-hidden />
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">User not found</h1>
        <Button variant="secondary" onClick={() => router.push('/settings/admin/users')}>
          Back to users
        </Button>
      </main>
    );
  }

  const canSave = name.trim().length > 0 && email.trim().length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.adminUpdateUser(userId, {
        name: name.trim(),
        email: email.trim(),
        company_name: companyName.trim(),
        // Respect the self-edit guard client-side; the backend enforces
        // it anyway but we don't want to even send a value that would
        // bounce.
        ...(isSelf ? {} : { role, is_active: isActive }),
      });
      // If the admin edited their own record (name/email/company), the
      // stashed snapshot in localStorage is now stale. Refresh so the
      // hub header re-renders with the new details.
      if (isSelf) {
        void refreshCurrent();
      }
      router.push('/settings/admin/users');
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message || 'Invalid input');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save user');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlock() {
    if (!window.confirm('Unlock this account? Failed-login count will reset.')) return;
    setUnlocking(true);
    setError(null);
    try {
      await api.adminUnlockUser(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock');
    } finally {
      setUnlocking(false);
    }
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
        <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">Edit user</h1>
      </div>

      {/* Profile preview header */}
      <section className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-6">
        <div
          aria-hidden
          className="flex h-20 w-20 items-center justify-center rounded-full text-3xl font-bold text-white"
          style={{
            background:
              'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
          }}
        >
          {(name || email).trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[17px] font-bold text-[var(--color-text-primary)]">
            {name.trim() || email.trim() || 'Untitled user'}
          </span>
          <span className="text-[13px] text-[var(--color-text-secondary)]">
            {row.created_at ? `Created ${formatShortDate(row.created_at)}` : ''}
            {row.last_login ? ` · last seen ${formatShortDate(row.last_login)}` : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {row.is_active === false ? <Pill color="red">Inactive</Pill> : null}
          {isLocked ? <Pill color="amber">Locked</Pill> : null}
          {isSelf ? <Pill color="blue">You</Pill> : null}
        </div>
      </section>

      {isSelf ? (
        <p className="rounded-[var(--radius-md)] border border-[var(--color-brand-blue)]/30 bg-[color-mix(in_oklab,var(--color-brand-blue)_8%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          You&apos;re editing your own account. Role and Active controls are disabled — you
          can&apos;t demote or deactivate yourself.
        </p>
      ) : null}

      {/* Account */}
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
      </SectionCard>

      {/* Roles */}
      <SectionCard accent="blue" icon={ShieldCheck} title="Roles">
        <LabelledSelect
          label="System Role"
          value={role}
          onChange={(v) => setRole(v as 'admin' | 'user')}
          disabled={isSelf}
          options={[
            { value: 'user', label: 'User' },
            { value: 'admin', label: 'Admin (system-wide)' },
          ]}
        />
        <label className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-3">
          <div className="flex flex-col">
            <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              Account active
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              Deactivated users cannot log in. This is the soft-delete path.
            </span>
          </div>
          <input
            type="checkbox"
            checked={isActive}
            disabled={isSelf}
            onChange={(e) => setIsActive(e.target.checked)}
            aria-label="Account active"
            className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-[var(--color-surface-3)] transition-colors checked:bg-[var(--color-brand-green)] disabled:cursor-not-allowed disabled:opacity-50 relative after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform checked:after:translate-x-4"
          />
        </label>
      </SectionCard>

      {/* Company */}
      <SectionCard accent="green" icon={Building2} title="Company">
        <FloatingLabelInput
          label="Company Name"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          hint="Displayed on the user's certificates."
        />
        <p className="text-[11px] text-[var(--color-text-tertiary)]">
          Company ID: <code className="font-mono">{row.company_id ?? '—'}</code> · Company role:{' '}
          <code className="font-mono">{row.company_role ?? '—'}</code>
        </p>
        <p className="text-[11px] text-[var(--color-text-tertiary)]">
          Company reassignment isn&apos;t editable here — use the dedicated company assignment API
          (full picker arrives in a later phase).
        </p>
      </SectionCard>

      {/* Security */}
      <SectionCard accent="amber" icon={KeyRound} title="Security">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              Reset password
            </p>
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              Sets a new password and signs the user out of every device.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => setShowResetSheet(true)}
            className="gap-2 shrink-0"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            Reset password
          </Button>
        </div>
        {isLocked ? (
          <div className="flex flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="flex items-center gap-1 text-[13px] font-semibold text-[var(--color-status-processing)]">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                Account is locked
              </p>
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                Locked until {formatFullDate(row.locked_until!)} — typically after repeated failed
                logins.
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={handleUnlock}
              disabled={unlocking}
              className="gap-2 shrink-0"
            >
              <Unlock className="h-4 w-4" aria-hidden />
              {unlocking ? 'Unlocking…' : 'Unlock account'}
            </Button>
          </div>
        ) : null}
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
            variant="ghost"
            onClick={() => router.push('/settings/admin/users')}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {showResetSheet ? (
        <ResetPasswordSheet
          userId={userId}
          userName={row.name || row.email}
          onClose={() => setShowResetSheet(false)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ResetPasswordSheet({
  userId,
  userName,
  onClose,
}: {
  userId: string;
  userName: string;
  onClose: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const passwordShort = password.length > 0 && password.length < 8;
  const canSubmit = password.length >= 8 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminResetPassword(userId, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message || 'Invalid password');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to reset password');
      }
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    // Explicit null so the password doesn't live past the modal.
    setPassword('');
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-title"
    >
      <div className="mx-4 w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-5 shadow-lg">
        {done ? (
          <>
            <h3 id="reset-title" className="text-[17px] font-bold text-[var(--color-text-primary)]">
              Password reset
            </h3>
            <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
              <strong>{userName}</strong>&apos;s password has been updated. All existing sessions
              for this user have been signed out — they&apos;ll need to log in again.
            </p>
            <div className="mt-5 flex justify-end">
              <Button onClick={handleClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <h3 id="reset-title" className="text-[17px] font-bold text-[var(--color-text-primary)]">
              Reset password
            </h3>
            <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
              Set a new password for <strong>{userName}</strong>. Hand it off out-of-band — the user
              will be logged out of every device.
            </p>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
              <FloatingLabelInput
                label="New password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                state={passwordShort ? 'error' : 'default'}
                hint={passwordShort ? 'At least 8 characters required' : undefined}
                trailing={<KeyRound className="h-4 w-4" aria-hidden />}
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
                <Button type="submit" disabled={!canSubmit}>
                  {busy ? 'Resetting…' : 'Reset password'}
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
            className="w-full bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] focus:outline-none disabled:cursor-not-allowed"
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

function Pill({
  color,
  children,
}: {
  color: 'blue' | 'green' | 'red' | 'amber';
  children: React.ReactNode;
}) {
  const c =
    color === 'blue'
      ? 'var(--color-brand-blue)'
      : color === 'green'
        ? 'var(--color-brand-green)'
        : color === 'red'
          ? 'var(--color-status-failed)'
          : 'var(--color-status-processing)';
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]"
      style={{
        color: c,
        background: `color-mix(in oklab, ${c} 15%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch {
    return iso;
  }
}

function formatFullDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
