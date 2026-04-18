'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AtSign,
  Building2,
  ChevronRight,
  Globe,
  LayoutDashboard,
  MapPin,
  Phone,
  Receipt,
  ShieldCheck,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import { isCompanyAdmin } from '@/lib/roles';
import type { CompanySettings } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { IconButton } from '@/components/ui/icon-button';
import { SectionCard } from '@/components/ui/section-card';
import { LogoUploader } from '@/components/settings/logo-uploader';

/**
 * Company settings page. Ports iOS `CompanyDetailsView.swift`.
 *
 * Viewable by any authenticated user — inspectors can see their
 * company's stamp so they know what will be printed on the certs they
 * generate. Editable only for company admins / owners; non-admins see
 * a read-only view with a "ask your admin" hint.
 *
 * Why the whole form is read-only for non-admins (instead of hiding
 * the page): inspectors often need to *verify* the registration
 * number or logo before producing a cert for a customer. Blanking the
 * page would make that harder. Gating on mutations only keeps the
 * information surface available while removing the footgun.
 *
 * Save shape: full-blob PUT (backend doesn't merge). Logo uploads are
 * handled inline by `LogoUploader` — it hits the dedicated logo POST
 * route, we merge the returned S3 key into the in-memory form, and
 * the next Save PUT carries the new `logo_file`. Order of operations
 * matters only insofar as the upload must succeed before the PUT sees
 * the new key; if the admin uploads a logo and then navigates away
 * without saving, the logo is orphaned but the settings blob still
 * points at the old key (or no key). That's fine — orphan S3 objects
 * are cheap and admin intent is usually followed by a save.
 */
export default function CompanySettingsPage() {
  const router = useRouter();
  const { user } = useCurrentUser();

  const [settings, setSettings] = React.useState<CompanySettings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await api.companySettings(user.id);
        if (!cancelled) setSettings(s);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load company settings');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || !settings) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        {error ?? 'Loading…'}
      </div>
    );
  }

  const editable = isCompanyAdmin(user);

  function update<K extends keyof CompanySettings>(key: K, value: CompanySettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  }

  async function handleSave() {
    if (!settings || !user) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateCompanySettings(user.id, settings);
      setDirty(false);
      router.push('/settings');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 pb-32">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* D8: 44×44 back-link (was 36×36 — h-9 w-9). asChild keeps
           * Next <Link>'s prefetch behaviour while the IconButton enforces
           * the touch target. */}
          <IconButton asChild aria-label="Back to settings">
            <Link href="/settings">
              <ChevronRight className="h-4 w-4 rotate-180" aria-hidden />
            </Link>
          </IconButton>
          <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">
            Company Details
          </h1>
        </div>
        {editable ? (
          <Link
            href="/settings/company/dashboard"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-brand-blue)] hover:underline"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden />
            Dashboard
          </Link>
        ) : null}
      </div>

      {!editable ? (
        <p className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          Only company admins can edit these details. Ask your admin to update any fields that need
          to change.
        </p>
      ) : null}

      <SectionCard accent="blue" icon={Building2} title="Branding">
        <FloatingLabelInput
          label="Company Name"
          value={settings.company_name ?? ''}
          onChange={(e) => update('company_name', e.target.value)}
          disabled={!editable}
        />
        <div>
          <label className="mb-2 block text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Logo
          </label>
          <LogoUploader
            userId={user.id}
            logoFile={settings.logo_file}
            onUploaded={(key) => update('logo_file', key)}
            disabled={!editable}
          />
        </div>
      </SectionCard>

      <SectionCard accent="green" icon={MapPin} title="Address & Contact">
        <FloatingLabelInput
          label="Address"
          value={settings.company_address ?? ''}
          onChange={(e) => update('company_address', e.target.value)}
          disabled={!editable}
        />
        <FloatingLabelInput
          label="Phone"
          type="tel"
          value={settings.company_phone ?? ''}
          onChange={(e) => update('company_phone', e.target.value)}
          disabled={!editable}
          trailing={<Phone className="h-4 w-4" aria-hidden />}
        />
        <FloatingLabelInput
          label="Email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          value={settings.company_email ?? ''}
          onChange={(e) => update('company_email', e.target.value)}
          disabled={!editable}
          trailing={<AtSign className="h-4 w-4" aria-hidden />}
        />
        <FloatingLabelInput
          label="Website"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          value={settings.company_website ?? ''}
          onChange={(e) => update('company_website', e.target.value)}
          disabled={!editable}
          trailing={<Globe className="h-4 w-4" aria-hidden />}
        />
      </SectionCard>

      <SectionCard accent="amber" icon={Receipt} title="Registration">
        <FloatingLabelInput
          label="Company Registration Number"
          value={settings.company_registration ?? ''}
          onChange={(e) => update('company_registration', e.target.value)}
          disabled={!editable}
          hint="Printed in the footer of every certificate."
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

      {editable ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-end gap-2 px-4 py-3">
            <Button variant="ghost" onClick={() => router.push('/settings')} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
