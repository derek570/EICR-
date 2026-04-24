'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, UserPlus } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError, type InviteEmployeeResponse } from '@/lib/types';
import { useCurrentUser } from '@/lib/use-current-user';
import { isCompanyAdmin } from '@/lib/roles';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { Button } from '@/components/ui/button';

/**
 * Invite employee page — iOS `InviteEmployeeView.swift`.
 *
 * Standalone route so the invite flow can be linked from multiple
 * entry points (Settings hub, Company dashboard, future onboarding
 * email). The Company Dashboard has a sibling invite sheet; this
 * page shares the same backend contract + the one-shot-temp-password
 * affordance, just rendered as a full page for parity with the iOS
 * dedicated surface.
 *
 * Role gate: `isCompanyAdmin` (covers system admins + company
 * owners/admins). Non-admins are redirected to /settings on mount.
 * The backend enforces the same check, so a user who manages to
 * reach this route via deep link still hits a 403 — the client gate
 * is purely UX.
 *
 * Backend contract: `POST /api/companies/:companyId/invite` accepts
 * `{name, email}` and returns `{userId, email, name, temporaryPassword}`.
 * The temp password is shown once and never persisted past a page
 * navigation — we clear it from state when the user clicks "Invite
 * another" or navigates away.
 */
export default function InviteEmployeePage() {
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();

  // Gate. We can't redirect during render (Next throws), so bounce in
  // an effect once the user hydrates.
  React.useEffect(() => {
    if (userLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!isCompanyAdmin(user)) {
      router.replace('/settings');
    }
  }, [user, userLoading, router]);

  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InviteEmployeeResponse | null>(null);
  const [copied, setCopied] = React.useState(false);

  const companyId = user?.company_id ?? null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId) {
      setError('You are not assigned to a company.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.inviteEmployee(companyId, {
        name: name.trim(),
        email: email.trim(),
      });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('A user with this email already exists.');
      } else {
        setError(err instanceof Error ? err.message : 'Invite failed');
      }
    } finally {
      setSaving(false);
    }
  }

  async function copyPassword() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — password is still visible on-screen for manual copy. */
    }
  }

  function resetForm() {
    setResult(null);
    setName('');
    setEmail('');
    setCopied(false);
  }

  const canSubmit = name.trim().length > 0 && /@/.test(email) && !saving;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
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
        eyebrow="Team"
        title="Invite employee"
        subtitle="Create an account and hand off the one-time temporary password."
        icon={<UserPlus className="h-10 w-10" aria-hidden />}
      />

      {result ? (
        <SectionCard accent="green" title="Invite sent">
          <p className="text-[14px] text-[var(--color-text-primary)]">
            <strong>{result.name}</strong> has been added as an employee. Send the temporary
            password below — it will only be shown once.
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-3 py-2">
            <code className="flex-1 font-mono text-[15px] text-[var(--color-text-primary)]">
              {result.temporaryPassword}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={copyPassword}
              aria-label="Copy temporary password"
              className="gap-1"
            >
              <Copy className="h-4 w-4" aria-hidden />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--color-text-tertiary)]">
            For security, this password is never stored in plain text and cannot be retrieved again.
          </p>
          <div className="flex gap-2">
            <Button onClick={resetForm}>Invite another</Button>
            <Button variant="ghost" onClick={() => router.push('/settings')}>
              Done
            </Button>
          </div>
        </SectionCard>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <SectionCard accent="blue" title="Employee details">
            <FloatingLabelInput
              label="Full name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <FloatingLabelInput
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </SectionCard>

          {error ? (
            <div
              role="alert"
              className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_6%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
            >
              {error}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmit}>
              {saving ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}
