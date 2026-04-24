'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';

/**
 * Change password — iOS `ChangePasswordView.swift` parity.
 *
 * Three inputs (current / new / confirm) each with a show/hide toggle.
 * Client validation mirrors iOS: new ≥ 8 chars (tightened from iOS's
 * 6 — matches the Phase 6 brief), new !== current, new === confirm.
 * The backend additionally enforces ≥6 (see `src/routes/auth.js`) so
 * the client rule is the binding one for web.
 *
 * Error surfaces:
 *   - Client-side validation: inline hint under the field.
 *   - Backend 401 "Current password is incorrect": inline banner.
 *   - Backend 400 / 500: inline banner with the server message.
 *
 * On success we show a green confirmation card and auto-redirect to
 * /settings after 2s — matches the iOS pattern of dismissing the
 * sheet with a toast. The redirect is a soft navigation via
 * `router.push`, so the settings hub re-reads fresh user context
 * (the backend invalidates other sessions on password change, but
 * the current session stays alive — no forced re-login).
 */

type FieldKey = 'current' | 'next' | 'confirm';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<FieldKey, string>>({
    current: '',
    next: '',
    confirm: '',
  });
  const [visible, setVisible] = React.useState<Record<FieldKey, boolean>>({
    current: false,
    next: false,
    confirm: false,
  });
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [success, setSuccess] = React.useState(false);

  function setField(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSubmitError(null);
  }

  const validationError = React.useMemo(() => {
    if (!values.next) return null;
    if (values.next.length < 8) return 'New password must be at least 8 characters.';
    if (values.current && values.next === values.current) {
      return 'New password must be different from current password.';
    }
    if (values.confirm && values.next !== values.confirm) {
      return 'Passwords do not match.';
    }
    return null;
  }, [values]);

  const canSubmit =
    values.current.length > 0 &&
    values.next.length >= 8 &&
    values.next === values.confirm &&
    values.next !== values.current &&
    !saving;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await api.changePassword(values.current, values.next);
      setSuccess(true);
      window.setTimeout(() => {
        router.push('/settings');
      }, 2000);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else if (err instanceof Error) {
        setSubmitError(err.message);
      } else {
        setSubmitError('Password change failed. Try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (success) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <HeroHeader
          eyebrow="Account"
          title="Password changed"
          subtitle="Your new password is active on this device."
          icon={<CheckCircle2 className="h-10 w-10" aria-hidden />}
        />
        <SectionCard accent="green">
          <p className="text-[14px] text-[var(--color-text-primary)]">
            Returning to settings in a moment…
          </p>
        </SectionCard>
      </main>
    );
  }

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
        eyebrow="Account"
        title="Change Password"
        subtitle="Keep your account secure with a strong password."
        icon={<ShieldCheck className="h-10 w-10" aria-hidden />}
      />

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <SectionCard accent="blue" title="Current password">
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            value={values.current}
            visible={visible.current}
            onToggleVisible={() => setVisible((v) => ({ ...v, current: !v.current }))}
            onChange={(v) => setField('current', v)}
          />
        </SectionCard>

        <SectionCard accent="blue" title="New password">
          <PasswordField
            label="New password"
            autoComplete="new-password"
            value={values.next}
            visible={visible.next}
            onToggleVisible={() => setVisible((v) => ({ ...v, next: !v.next }))}
            onChange={(v) => setField('next', v)}
            hint="Minimum 8 characters."
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            value={values.confirm}
            visible={visible.confirm}
            onToggleVisible={() => setVisible((v) => ({ ...v, confirm: !v.confirm }))}
            onChange={(v) => setField('confirm', v)}
            error={
              values.confirm && values.next !== values.confirm
                ? 'Passwords do not match.'
                : undefined
            }
          />
          {validationError ? (
            <p role="alert" className="text-[12px] text-[var(--color-status-processing)]">
              {validationError}
            </p>
          ) : null}
        </SectionCard>

        {submitError ? (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_6%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
          >
            {submitError}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={!canSubmit}>
            {saving ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function PasswordField({
  label,
  value,
  onChange,
  visible,
  onToggleVisible,
  autoComplete,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  autoComplete: string;
  hint?: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`group relative flex h-14 items-stretch rounded-[var(--radius-md)] border bg-[var(--color-surface-1)] transition focus-within:border-[var(--color-brand-blue)] ${
          error ? 'border-[var(--color-status-failed)]' : 'border-[var(--color-border-default)]'
        }`}
      >
        <div className="flex flex-1 flex-col justify-center px-3">
          <span className="pointer-events-none text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            {label}
          </span>
          <input
            type={visible ? 'text' : 'password'}
            autoComplete={autoComplete}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="flex w-11 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      {hint ? <p className="px-1 text-[12px] text-[var(--color-text-tertiary)]">{hint}</p> : null}
      {error ? (
        <p className="px-1 text-[12px] text-[var(--color-status-failed)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
