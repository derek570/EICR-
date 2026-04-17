'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Briefcase,
  Bolt,
  ChevronDown,
  ChevronRight,
  Globe,
  IdCard,
  Link2,
  PenLine,
  ShieldCheck,
  Star,
  User as UserIcon,
  Wrench,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import type { InspectorProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { SectionCard } from '@/components/ui/section-card';
import {
  SignatureCanvas,
  type SignatureCanvasHandle,
} from '@/components/settings/signature-canvas';

/**
 * Staff member add/edit page. Ports iOS `InspectorDetailView.swift`.
 *
 * Routing: `[inspectorId]` can be the literal `new` to create a fresh
 * profile, or an existing profile id to edit. The backend has no
 * per-profile endpoints — every save is a full-array PUT to
 * `/api/inspector-profiles/:userId`. So on mount we load the whole
 * array, find our row (or start blank), and on save we splice back in
 * and PUT the whole thing.
 *
 * Signature save is two-step: if the canvas has fresh content, POST the
 * PNG first to get the S3 key, then PUT the profiles array with
 * `signature_file` set. Doing it in this order means we never persist a
 * profile pointing at a non-existent signature; if the upload fails we
 * bail before touching the profiles blob.
 *
 * `is_default` on any profile implies all other profiles MUST be
 * `is_default = false` — the toggle logic in `togglingDefault` handles
 * the mutex locally so the PUT body reflects it.
 */
export default function InspectorDetailPage() {
  const { inspectorId } = useParams<{ inspectorId: string }>();
  const isNew = inspectorId === 'new';
  const router = useRouter();
  const { user } = useCurrentUser();

  const [allProfiles, setAllProfiles] = React.useState<InspectorProfile[] | null>(null);
  const [form, setForm] = React.useState<InspectorProfile | null>(null);
  const [showEquipment, setShowEquipment] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const signatureRef = React.useRef<SignatureCanvasHandle>(null);

  // Load existing profile (or start blank for `new`). Must wait for
  // `user` so we have a userId for the signature fetch.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const profiles = await api.inspectorProfiles(user.id);
        if (cancelled) return;
        setAllProfiles(profiles);
        if (isNew) {
          setForm({
            id: crypto.randomUUID(),
            name: '',
            position: '',
            organisation: '',
            enrolment_number: '',
            is_default: profiles.length === 0, // first-ever profile defaults to default
          });
        } else {
          const found = profiles.find((p) => p.id === inspectorId);
          if (!found) {
            setError('Staff member not found');
            return;
          }
          setForm(found);
          // Auto-expand equipment if any slot has a value — matches iOS.
          const eqKeys: (keyof InspectorProfile)[] = [
            'mft_serial_number',
            'continuity_serial_number',
            'insulation_serial_number',
            'earth_fault_serial_number',
            'rcd_serial_number',
          ];
          if (eqKeys.some((k) => typeof found[k] === 'string' && (found[k] as string).length > 0)) {
            setShowEquipment(true);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, inspectorId, isNew]);

  if (!user || !form || !allProfiles) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        {error ?? 'Loading…'}
      </div>
    );
  }

  const canSave = form.name.trim().length > 0;
  const equipmentCount = [
    form.mft_serial_number,
    form.continuity_serial_number,
    form.insulation_serial_number,
    form.earth_fault_serial_number,
    form.rcd_serial_number,
  ].filter((s) => s && s.length > 0).length;

  async function handleSave() {
    if (!form || !user || !allProfiles) return;
    setSaving(true);
    setError(null);
    try {
      let signatureKey = form.signature_file;
      // If the canvas has fresh content, upload before the profile save.
      // If the user didn't touch it, keep the existing key as-is.
      const blob = await signatureRef.current?.getBlob();
      if (blob) {
        const upload = await api.uploadSignature(user.id, blob);
        signatureKey = upload.signature_file;
      } else if (!signatureRef.current?.hasContent()) {
        // User explicitly cleared — remove the key so the UI doesn't lie.
        signatureKey = undefined;
      }

      const patched: InspectorProfile = {
        ...form,
        name: form.name.trim(),
        position: (form.position ?? '').trim() || undefined,
        organisation: (form.organisation ?? '').trim() || undefined,
        enrolment_number: (form.enrolment_number ?? '').trim() || undefined,
        signature_file: signatureKey,
      };

      // If this profile is default, unset default on all others (mutex).
      const merged = patched.is_default
        ? allProfiles.map((p) => (p.id === patched.id ? patched : { ...p, is_default: false }))
        : allProfiles.map((p) => (p.id === patched.id ? patched : p));

      const next = merged.some((p) => p.id === patched.id) ? merged : [...merged, patched];

      await api.updateInspectorProfiles(user.id, next);
      router.push('/settings/staff');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof InspectorProfile>(key: K, value: InspectorProfile[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 pb-32">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/settings/staff"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            aria-label="Back to staff list"
          >
            <ChevronRight className="h-4 w-4 rotate-180" aria-hidden />
          </Link>
          <h1 className="text-[18px] font-bold text-[var(--color-text-primary)]">
            {isNew ? 'Add Staff Member' : 'Edit Staff Member'}
          </h1>
        </div>
      </div>

      {/* Profile preview header — mirrors iOS profileHeader */}
      <section className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-6">
        <div
          aria-hidden
          className="flex h-20 w-20 items-center justify-center rounded-full text-3xl font-bold text-white"
          style={{
            background:
              'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
          }}
        >
          {form.name.trim().charAt(0).toUpperCase() || <UserIcon className="h-9 w-9" aria-hidden />}
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[17px] font-bold text-[var(--color-text-primary)]">
            {form.name.trim() || (isNew ? 'New Staff Member' : 'Edit Staff')}
          </span>
          {form.position ? (
            <span className="text-[13px] text-[var(--color-text-secondary)]">{form.position}</span>
          ) : null}
        </div>
      </section>

      {/* Name */}
      <SectionCard accent="blue" icon={UserIcon} title="Name">
        <FloatingLabelInput
          label="Name *"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          autoComplete="name"
          required
        />
      </SectionCard>

      {/* Details */}
      <SectionCard accent="blue" icon={IdCard} title="Details">
        <FloatingLabelInput
          label="Position"
          value={form.position ?? ''}
          onChange={(e) => update('position', e.target.value)}
          trailing={<Briefcase className="h-4 w-4" aria-hidden />}
        />
        <FloatingLabelInput
          label="Organisation"
          value={form.organisation ?? ''}
          onChange={(e) => update('organisation', e.target.value)}
          trailing={<Globe className="h-4 w-4" aria-hidden />}
        />
        <FloatingLabelInput
          label="Enrolment Number"
          value={form.enrolment_number ?? ''}
          onChange={(e) => update('enrolment_number', e.target.value)}
          trailing={<ShieldCheck className="h-4 w-4" aria-hidden />}
        />
        <label className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-3">
          <span className="flex items-center gap-2 text-[15px] text-[var(--color-text-primary)]">
            <Star
              className="h-4 w-4"
              style={{
                color: form.is_default ? 'var(--color-brand-green)' : 'var(--color-text-tertiary)',
              }}
              aria-hidden
            />
            Default Staff Member
          </span>
          <input
            type="checkbox"
            checked={form.is_default ?? false}
            onChange={(e) => update('is_default', e.target.checked)}
            className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-[var(--color-surface-3)] transition-colors checked:bg-[var(--color-brand-green)] relative after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform checked:after:translate-x-4"
            aria-label="Default staff member"
          />
        </label>
      </SectionCard>

      {/* Signature */}
      <SectionCard accent="blue" icon={PenLine} title="Signature">
        <SignatureCanvas
          ref={signatureRef}
          userId={user.id}
          initialSignatureFile={form.signature_file ?? null}
        />
      </SectionCard>

      {/* Equipment — collapsible to match iOS */}
      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setShowEquipment((s) => !s)}
          className="flex items-center gap-2 rounded-[var(--radius-md)] px-1 py-2 text-left"
          aria-expanded={showEquipment}
        >
          <Wrench className="h-3.5 w-3.5 text-[var(--color-brand-blue)]" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
            Test Equipment
          </span>
          {equipmentCount > 0 ? (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
              style={{
                color: 'white',
                background: 'color-mix(in oklab, var(--color-brand-blue) 80%, transparent)',
              }}
            >
              {equipmentCount}
            </span>
          ) : null}
          <span className="flex-1" />
          <ChevronDown
            className={`h-4 w-4 text-[var(--color-text-tertiary)] transition-transform ${
              showEquipment ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </button>
        {showEquipment ? (
          <div className="flex flex-col gap-3">
            <EquipmentCard
              title="MFT"
              serial={form.mft_serial_number ?? ''}
              date={form.mft_calibration_date ?? ''}
              onSerial={(v) => update('mft_serial_number', v)}
              onDate={(v) => update('mft_calibration_date', v)}
            />
            <EquipmentCard
              title="Continuity"
              serial={form.continuity_serial_number ?? ''}
              date={form.continuity_calibration_date ?? ''}
              onSerial={(v) => update('continuity_serial_number', v)}
              onDate={(v) => update('continuity_calibration_date', v)}
            />
            <EquipmentCard
              title="Insulation Resistance"
              serial={form.insulation_serial_number ?? ''}
              date={form.insulation_calibration_date ?? ''}
              onSerial={(v) => update('insulation_serial_number', v)}
              onDate={(v) => update('insulation_calibration_date', v)}
            />
            <EquipmentCard
              title="Earth Fault Loop"
              serial={form.earth_fault_serial_number ?? ''}
              date={form.earth_fault_calibration_date ?? ''}
              onSerial={(v) => update('earth_fault_serial_number', v)}
              onDate={(v) => update('earth_fault_calibration_date', v)}
            />
            <EquipmentCard
              title="RCD"
              serial={form.rcd_serial_number ?? ''}
              date={form.rcd_calibration_date ?? ''}
              onSerial={(v) => update('rcd_serial_number', v)}
              onDate={(v) => update('rcd_calibration_date', v)}
            />
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}

      {/* Sticky save bar — doesn't collide with the layout footer because */}
      {/* settings is out of the recording tree. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-2 px-4 py-3">
          <Button variant="ghost" onClick={() => router.push('/settings/staff')} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : isNew ? 'Add Staff' : 'Save'}
          </Button>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function EquipmentCard({
  title,
  serial,
  date,
  onSerial,
  onDate,
}: {
  title: string;
  serial: string;
  date: string;
  onSerial: (v: string) => void;
  onDate: (v: string) => void;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{
            color: 'var(--color-brand-blue)',
            background: 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)',
          }}
        >
          <Bolt className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="text-[15px] font-bold text-[var(--color-text-primary)]">{title}</span>
        {serial ? (
          <span className="ml-auto text-[11px] font-semibold text-[var(--color-brand-green)]">
            ✓ registered
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        <FloatingLabelInput
          label="Serial Number"
          value={serial}
          onChange={(e) => onSerial(e.target.value)}
          trailing={<Link2 className="h-4 w-4" aria-hidden />}
        />
        <FloatingLabelInput
          label="Calibration Date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          placeholder="YYYY-MM-DD"
        />
      </div>
    </div>
  );
}
