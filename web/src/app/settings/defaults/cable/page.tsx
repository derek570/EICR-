'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useCurrentUser } from '@/lib/use-current-user';
import { useUserDefaults, type UserDefaults } from '@/hooks/use-user-defaults';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { Button } from '@/components/ui/button';

/**
 * Cable Size Defaults — iOS `CableSizeDefaultsView.swift`.
 *
 * Per-circuit-type cable + OCPD defaults. iOS stores these under
 * scoped keys (`{type}.live_csa_mm2`, `{type}.cpc_csa_mm2`,
 * `{type}.ocpd_rating_a`, `{type}.ocpd_type`) in the same
 * `user_defaults.json` blob. When the Circuits tab infers a type it
 * reads the scoped key; otherwise it falls back to the generic
 * `live_csa_mm2` etc. from Default Values.
 *
 * This editor is intentionally flat — one row per circuit type, four
 * editable columns. On a narrow viewport each row collapses into a
 * stacked card so the table never overflows horizontally.
 *
 * The scope-key prefix is the only iOS detail that leaks onto the
 * wire: backend stores whatever we write, no server-side renaming.
 * See `packages/shared-utils/src/apply-defaults.ts` for the read
 * half — currently it reads generic keys only, so Phase 6 is a
 * UI-only addition (the scoped keys are persisted for iOS parity
 * and future web reads).
 */

type CircuitTypeKey = 'lighting' | 'socket' | 'cooker' | 'shower' | 'immersion';

const CIRCUIT_TYPES: { key: CircuitTypeKey; label: string; subtitle: string }[] = [
  { key: 'lighting', label: 'Lighting', subtitle: '6A circuits · 1.0mm² T&E' },
  { key: 'socket', label: 'Sockets / ring', subtitle: '32A ring final · 2.5mm² T&E' },
  { key: 'cooker', label: 'Cooker / oven', subtitle: '32A radial · 6.0mm² T&E' },
  { key: 'shower', label: 'Shower', subtitle: '40A radial · 10mm² T&E' },
  { key: 'immersion', label: 'Immersion / hot water', subtitle: '16A radial · 2.5mm² T&E' },
];

function keyFor(type: CircuitTypeKey, field: string): string {
  return `${type}.${field}`;
}

export default function CableSizeDefaultsPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const { defaults, loading, error, save } = useUserDefaults(user?.id);

  const [form, setForm] = React.useState<UserDefaults>({});
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    if (loading) return;
    setForm({ ...defaults });
    hydratedRef.current = true;
  }, [loading, defaults]);

  function setField(type: CircuitTypeKey, field: string, value: string) {
    setForm((prev) => ({ ...prev, [keyFor(type, field)]: value }));
    setSaved(false);
  }

  const get = (type: CircuitTypeKey, field: string) => form[keyFor(type, field)] ?? '';

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      await save(form);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save defaults');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings/defaults')}
          className="gap-1 text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Defaults
        </Button>
      </div>

      <HeroHeader
        eyebrow="Defaults"
        title="Cable Size Defaults"
        subtitle="Override the BS 7671 schema defaults per circuit type."
      />

      {error ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_6%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="py-8 text-center text-[var(--color-text-secondary)]">Loading defaults…</div>
      ) : (
        <>
          {CIRCUIT_TYPES.map((type) => (
            <SectionCard key={type.key} accent="blue" title={type.label} subtitle={type.subtitle}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <FloatingLabelInput
                  label="Live CSA (mm²)"
                  inputMode="decimal"
                  value={get(type.key, 'live_csa_mm2')}
                  onChange={(e) => setField(type.key, 'live_csa_mm2', e.target.value)}
                />
                <FloatingLabelInput
                  label="CPC CSA (mm²)"
                  inputMode="decimal"
                  value={get(type.key, 'cpc_csa_mm2')}
                  onChange={(e) => setField(type.key, 'cpc_csa_mm2', e.target.value)}
                />
                <FloatingLabelInput
                  label="OCPD rating (A)"
                  inputMode="numeric"
                  value={get(type.key, 'ocpd_rating_a')}
                  onChange={(e) => setField(type.key, 'ocpd_rating_a', e.target.value)}
                />
                <FloatingLabelInput
                  label="OCPD type"
                  placeholder="B / C / D"
                  value={get(type.key, 'ocpd_type')}
                  onChange={(e) => setField(type.key, 'ocpd_type', e.target.value)}
                />
              </div>
            </SectionCard>
          ))}

          {saveError ? (
            <div
              role="alert"
              className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_6%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]"
            >
              {saveError}
            </div>
          ) : null}

          {saved ? (
            <div
              role="status"
              className="rounded-[var(--radius-md)] border border-[var(--color-brand-green)]/30 bg-[color-mix(in_oklab,var(--color-brand-green)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-brand-green)]"
            >
              Cable defaults saved.
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving || !user}>
              {saving ? 'Saving…' : 'Save defaults'}
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
