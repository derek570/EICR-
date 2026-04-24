'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useCurrentUser } from '@/lib/use-current-user';
import { useUserDefaults, type UserDefaults } from '@/hooks/use-user-defaults';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SelectChips } from '@/components/ui/select-chips';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Button } from '@/components/ui/button';

/**
 * Default Values editor — iOS `DefaultValuesView.swift` subset.
 *
 * iOS exposes the full `Constants.circuitFieldOrder` as editable
 * cells, but the vast majority of inspectors only preset a handful of
 * values. We ship those handful here (matching the brief): test
 * voltage, max disconnect time, polarity default, RCD operating
 * current, OCPD type, OCPD breaking capacity. Additional fields can
 * be added later without changing the persistence shape — the backend
 * stores a free-form `Record<string, string>` blob.
 *
 * Save is a full-blob PUT. We compose the payload from the editable
 * fields below; any other keys the user has previously saved (via a
 * later iOS app version or a manual API call) are preserved via the
 * `initial` spread so the web UI doesn't silently discard them.
 */

const POLARITY_OPTIONS = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
];

const OCPD_TYPES = [
  { value: 'B', label: 'Type B' },
  { value: 'C', label: 'Type C' },
  { value: 'D', label: 'Type D' },
];

const IR_VOLTAGE_OPTIONS = [
  { value: '250', label: '250 V' },
  { value: '500', label: '500 V' },
  { value: '1000', label: '1000 V' },
];

// Schema keys mirror `config/field_schema.json` circuit_fields so the
// backend can thread these straight through `applyDefaultsToCircuits`.
const FIELD_KEYS = {
  maxDisconnect: 'max_disconnect_time_s',
  irVoltage: 'ir_test_voltage_v',
  rcdOperatingCurrent: 'rcd_operating_current_ma',
  polarity: 'polarity_confirmed',
  ocpdType: 'ocpd_type',
  ocpdBreakingCapacity: 'ocpd_breaking_capacity_ka',
  wiringType: 'wiring_type',
  refMethod: 'ref_method',
} as const;

export default function DefaultValuesPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const { defaults, loading, error, save } = useUserDefaults(user?.id);

  const [form, setForm] = React.useState<UserDefaults>({});
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // Hydrate once the network load completes. We intentionally copy the
  // whole `defaults` map (not just the editable keys) so unknown keys
  // round-trip and unrelated iOS-only fields are preserved on save.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    if (loading) return;
    setForm({ ...defaults });
    hydratedRef.current = true;
  }, [loading, defaults]);

  function setField(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

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

  const get = (key: string) => form[key] ?? '';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
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
        title="Default Values"
        subtitle="Applied to empty fields on every circuit when you tap Apply Defaults."
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
          <SectionCard accent="blue" title="Test readings">
            <FloatingLabelInput
              label="Max disconnect time (s)"
              inputMode="decimal"
              placeholder="0.4"
              value={get(FIELD_KEYS.maxDisconnect)}
              onChange={(e) => setField(FIELD_KEYS.maxDisconnect, e.target.value)}
              hint="BS 7671 default is 0.4s for final circuits ≤ 32A."
            />
            <SelectChips
              label="IR test voltage"
              options={IR_VOLTAGE_OPTIONS}
              value={get(FIELD_KEYS.irVoltage) || null}
              onChange={(v) => setField(FIELD_KEYS.irVoltage, v)}
            />
            <FloatingLabelInput
              label="RCD operating current (mA)"
              inputMode="numeric"
              placeholder="30"
              value={get(FIELD_KEYS.rcdOperatingCurrent)}
              onChange={(e) => setField(FIELD_KEYS.rcdOperatingCurrent, e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                Polarity default
              </span>
              <SegmentedControl
                aria-label="Polarity default"
                options={POLARITY_OPTIONS}
                value={get(FIELD_KEYS.polarity) || 'pass'}
                onChange={(v) => setField(FIELD_KEYS.polarity, v)}
              />
            </div>
          </SectionCard>

          <SectionCard accent="green" title="Protection">
            <SelectChips
              label="OCPD type"
              options={OCPD_TYPES}
              value={get(FIELD_KEYS.ocpdType) || 'B'}
              onChange={(v) => setField(FIELD_KEYS.ocpdType, v)}
            />
            <FloatingLabelInput
              label="OCPD breaking capacity (kA)"
              inputMode="decimal"
              placeholder="6"
              value={get(FIELD_KEYS.ocpdBreakingCapacity)}
              onChange={(e) => setField(FIELD_KEYS.ocpdBreakingCapacity, e.target.value)}
            />
          </SectionCard>

          <SectionCard accent="magenta" title="Cable conventions">
            <FloatingLabelInput
              label="Wiring type (e.g. A)"
              placeholder="A"
              value={get(FIELD_KEYS.wiringType)}
              onChange={(e) => setField(FIELD_KEYS.wiringType, e.target.value)}
              hint="Leave blank to keep the schema default."
            />
            <FloatingLabelInput
              label="Reference method"
              placeholder="C"
              value={get(FIELD_KEYS.refMethod)}
              onChange={(e) => setField(FIELD_KEYS.refMethod, e.target.value)}
            />
          </SectionCard>

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
              Defaults saved. Tap Apply Defaults on the Circuits tab to fill empty fields.
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
