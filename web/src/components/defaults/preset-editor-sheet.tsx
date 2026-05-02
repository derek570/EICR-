'use client';

import * as React from 'react';
import { X, SlidersHorizontal } from 'lucide-react';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';
import type { JobDetail } from '@/lib/types';

/**
 * Preset editor sheet — port of iOS `DefaultValuesView.swift`.
 *
 * The iOS sheet reuses the full job-detail tab system (Installation,
 * Supply, Board, Circuits, Observations, Inspection [+ Extent +
 * Design for EIC]) so every field on a real job is editable in
 * preset-mode. Replicating that on web means making every job tab
 * usable in "template mode" — a refactor too large to land overnight
 * without risking real-job editing.
 *
 * Phase B ships a focused editor covering the fields presets are
 * actually used for in the field:
 *
 *   - Preset metadata: name + certificate type (pinned).
 *   - Installation: premises description, agreed limitations,
 *     operational limitations, agreed-with, evidence-of-additions
 *     flag, next-inspection-years.
 *   - Supply: earthing arrangement, voltages, frequency, polarity,
 *     RCD operating current.
 *
 * The full per-tab editor (Boards/Circuits/Observations/Inspection
 * preset editing) is tracked as a Phase F polish item — for now,
 * inspectors can capture those onto a real job and then "save as
 * preset" via a future copy-to-preset flow. iOS canon is unchanged
 * in this sheet because it doesn't expose the saved-as-preset
 * affordance from a job either; the preset → job direction is the
 * primary use case.
 */

export interface PresetEditorSheetProps {
  mode: 'new' | 'edit';
  certificateType: string;
  existing: CertificateDefaultPreset | null;
  onCancel: () => void;
  onSave: (data: { name: string; default_data: Partial<JobDetail> }) => Promise<void>;
}

interface InstallationDraft {
  premises_description: string;
  agreed_limitations: string;
  operational_limitations: string;
  agreed_with: string;
  evidence_of_additions_alterations: 'Yes' | 'No' | 'None Apparent' | '';
  next_inspection_years: string;
  installation_records_available: 'Yes' | 'No' | '';
}

interface SupplyDraft {
  earthing_arrangement: 'TN-S' | 'TN-C-S' | 'TT' | 'IT' | '';
  live_conductors: string;
  number_of_supplies: string;
  nominal_voltage_u: string;
  nominal_voltage_uo: string;
  nominal_frequency: string;
  prospective_fault_current: string;
  earth_loop_impedance_ze: string;
  supply_polarity_confirmed: 'Yes' | 'No' | '';
  rcd_operating_current: string;
  rcd_time_delay: string;
  rcd_operating_time: string;
}

const DEFAULT_INSTALLATION: InstallationDraft = {
  premises_description: '',
  agreed_limitations: '',
  operational_limitations: '',
  agreed_with: '',
  evidence_of_additions_alterations: '',
  next_inspection_years: '',
  installation_records_available: '',
};

const DEFAULT_SUPPLY: SupplyDraft = {
  earthing_arrangement: '',
  live_conductors: '',
  number_of_supplies: '',
  nominal_voltage_u: '',
  nominal_voltage_uo: '',
  nominal_frequency: '',
  prospective_fault_current: '',
  earth_loop_impedance_ze: '',
  supply_polarity_confirmed: '',
  rcd_operating_current: '',
  rcd_time_delay: '',
  rcd_operating_time: '',
};

function pickInstallation(src: Record<string, unknown> | undefined): InstallationDraft {
  if (!src) return { ...DEFAULT_INSTALLATION };
  return {
    premises_description: String(src.premises_description ?? ''),
    agreed_limitations: String(src.agreed_limitations ?? ''),
    operational_limitations: String(src.operational_limitations ?? ''),
    agreed_with: String(src.agreed_with ?? ''),
    evidence_of_additions_alterations:
      (src.evidence_of_additions_alterations as InstallationDraft['evidence_of_additions_alterations']) ??
      '',
    next_inspection_years:
      src.next_inspection_years != null ? String(src.next_inspection_years) : '',
    installation_records_available:
      (src.installation_records_available as InstallationDraft['installation_records_available']) ??
      '',
  };
}

function pickSupply(src: Record<string, unknown> | undefined): SupplyDraft {
  if (!src) return { ...DEFAULT_SUPPLY };
  return {
    earthing_arrangement: (src.earthing_arrangement as SupplyDraft['earthing_arrangement']) ?? '',
    live_conductors: String(src.live_conductors ?? ''),
    number_of_supplies: String(src.number_of_supplies ?? ''),
    nominal_voltage_u: String(src.nominal_voltage_u ?? ''),
    nominal_voltage_uo: String(src.nominal_voltage_uo ?? ''),
    nominal_frequency: String(src.nominal_frequency ?? ''),
    prospective_fault_current: String(src.prospective_fault_current ?? ''),
    earth_loop_impedance_ze: String(src.earth_loop_impedance_ze ?? ''),
    supply_polarity_confirmed:
      (src.supply_polarity_confirmed as SupplyDraft['supply_polarity_confirmed']) ?? '',
    rcd_operating_current: String(src.rcd_operating_current ?? ''),
    rcd_time_delay: String(src.rcd_time_delay ?? ''),
    rcd_operating_time: String(src.rcd_operating_time ?? ''),
  };
}

function emitDraft(name: string, installation: InstallationDraft, supply: SupplyDraft) {
  const installationOut: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(installation)) {
    if (v === '' || v == null) continue;
    if (k === 'next_inspection_years') {
      const n = Number(v);
      if (!Number.isNaN(n)) installationOut[k] = n;
    } else {
      installationOut[k] = v;
    }
  }
  const supplyOut: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(supply)) {
    if (v === '' || v == null) continue;
    supplyOut[k] = v;
  }
  const default_data: Partial<JobDetail> = {};
  if (Object.keys(installationOut).length > 0) {
    (default_data as Record<string, unknown>).installation_details = installationOut;
  }
  if (Object.keys(supplyOut).length > 0) {
    (default_data as Record<string, unknown>).supply_characteristics = supplyOut;
  }
  return { name: name.trim(), default_data };
}

export function PresetEditorSheet({
  mode,
  certificateType,
  existing,
  onCancel,
  onSave,
}: PresetEditorSheetProps) {
  const [tab, setTab] = React.useState<'installation' | 'supply'>('installation');
  const [name, setName] = React.useState(existing?.name ?? '');
  const [installation, setInstallation] = React.useState<InstallationDraft>(
    pickInstallation(
      existing?.default_data?.installation_details as Record<string, unknown> | undefined
    )
  );
  const [supply, setSupply] = React.useState<SupplyDraft>(
    pickSupply(
      existing?.default_data?.supply_characteristics as Record<string, unknown> | undefined
    )
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Preset name cannot be empty');
      return;
    }
    setBusy(true);
    try {
      await onSave(emitDraft(name, installation, supply));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preset');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preset-editor-title"
    >
      <div className="flex h-full w-full max-w-3xl flex-col bg-[var(--color-surface-0)] sm:h-[min(90vh,720px)] sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--color-border-subtle)]">
        {/* Hero */}
        <div
          className="relative shrink-0 px-4 pb-4 pt-6"
          style={{
            background:
              'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="absolute right-3 top-3 cm-tap-target rounded-full bg-black/30 p-1.5 text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span
                id="preset-editor-title"
                className="text-[24px] font-extrabold leading-tight text-white"
              >
                {mode === 'edit' ? 'Edit Preset' : 'New Preset'}
              </span>
              <span className="text-[13px] text-white/75">{certificateType} default values</span>
            </div>
            <SlidersHorizontal className="h-9 w-9 text-white/30" aria-hidden />
          </div>
        </div>

        {/* Name field */}
        <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--color-text-tertiary)]">
              Preset Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Standard Domestic"
              className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px] text-[var(--color-text-primary)]"
            />
          </label>
        </div>

        {/* Tab pills */}
        <div className="flex gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-3 py-2">
          {(['installation', 'supply'] as const).map((t) => {
            const selected = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="rounded-full px-3 py-1.5 text-[12px] font-semibold transition"
                style={{
                  color: selected ? '#fff' : 'var(--color-brand-blue)',
                  background: selected
                    ? 'var(--color-brand-blue)'
                    : 'color-mix(in oklab, var(--color-brand-blue) 8%, transparent)',
                }}
              >
                {t === 'installation' ? 'Installation' : 'Supply'}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'installation' ? (
            <InstallationFields draft={installation} onChange={setInstallation} />
          ) : (
            <SupplyFields draft={supply} onChange={setSupply} />
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-4 py-3">
          {error ? (
            <div className="mb-2 text-[12px] text-[var(--color-status-failed)]">{error}</div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cm-tap-target flex-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] py-2.5 text-[14px] font-semibold text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="cm-tap-target flex-1 rounded-[var(--radius-md)] bg-[var(--color-brand-blue)] py-2.5 text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save Preset'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InstallationFields({
  draft,
  onChange,
}: {
  draft: InstallationDraft;
  onChange: (next: InstallationDraft) => void;
}) {
  const set = <K extends keyof InstallationDraft>(k: K, v: InstallationDraft[K]) =>
    onChange({ ...draft, [k]: v });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Premises Description">
        <input
          value={draft.premises_description}
          onChange={(e) => set('premises_description', e.target.value)}
          placeholder="e.g. Three-bedroom semi-detached domestic dwelling"
          className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
        />
      </Field>
      <Field label="Agreed Limitations">
        <textarea
          value={draft.agreed_limitations}
          onChange={(e) => set('agreed_limitations', e.target.value)}
          rows={2}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
        />
      </Field>
      <Field label="Operational Limitations">
        <textarea
          value={draft.operational_limitations}
          onChange={(e) => set('operational_limitations', e.target.value)}
          rows={2}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
        />
      </Field>
      <Field label="Agreed With">
        <input
          value={draft.agreed_with}
          onChange={(e) => set('agreed_with', e.target.value)}
          placeholder="e.g. Property Owner"
          className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Records Available">
          <select
            value={draft.installation_records_available}
            onChange={(e) =>
              set(
                'installation_records_available',
                e.target.value as InstallationDraft['installation_records_available']
              )
            }
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[14px]"
          >
            <option value="">—</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </Field>
        <Field label="Next Inspection (years)">
          <input
            value={draft.next_inspection_years}
            onChange={(e) => set('next_inspection_years', e.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder="5"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
      </div>
      <Field label="Evidence of Additions / Alterations">
        <select
          value={draft.evidence_of_additions_alterations}
          onChange={(e) =>
            set(
              'evidence_of_additions_alterations',
              e.target.value as InstallationDraft['evidence_of_additions_alterations']
            )
          }
          className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[14px]"
        >
          <option value="">—</option>
          <option value="None Apparent">None Apparent</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </Field>
    </div>
  );
}

function SupplyFields({
  draft,
  onChange,
}: {
  draft: SupplyDraft;
  onChange: (next: SupplyDraft) => void;
}) {
  const set = <K extends keyof SupplyDraft>(k: K, v: SupplyDraft[K]) =>
    onChange({ ...draft, [k]: v });
  return (
    <div className="flex flex-col gap-3">
      <Field label="Earthing Arrangement">
        <select
          value={draft.earthing_arrangement}
          onChange={(e) =>
            set('earthing_arrangement', e.target.value as SupplyDraft['earthing_arrangement'])
          }
          className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[14px]"
        >
          <option value="">—</option>
          <option value="TN-S">TN-S</option>
          <option value="TN-C-S">TN-C-S</option>
          <option value="TT">TT</option>
          <option value="IT">IT</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Live Conductors">
          <input
            value={draft.live_conductors}
            onChange={(e) => set('live_conductors', e.target.value)}
            placeholder="1 phase, 2 wire"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="Number of Supplies">
          <input
            value={draft.number_of_supplies}
            onChange={(e) => set('number_of_supplies', e.target.value)}
            placeholder="1"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="U (V)">
          <input
            value={draft.nominal_voltage_u}
            onChange={(e) => set('nominal_voltage_u', e.target.value)}
            placeholder="230"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="U₀ (V)">
          <input
            value={draft.nominal_voltage_uo}
            onChange={(e) => set('nominal_voltage_uo', e.target.value)}
            placeholder="230"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="Freq (Hz)">
          <input
            value={draft.nominal_frequency}
            onChange={(e) => set('nominal_frequency', e.target.value)}
            placeholder="50"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Prospective Fault Current">
          <input
            value={draft.prospective_fault_current}
            onChange={(e) => set('prospective_fault_current', e.target.value)}
            placeholder="kA"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="Ze (Ω)">
          <input
            value={draft.earth_loop_impedance_ze}
            onChange={(e) => set('earth_loop_impedance_ze', e.target.value)}
            placeholder="0.35"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
      </div>
      <Field label="Supply Polarity Confirmed">
        <select
          value={draft.supply_polarity_confirmed}
          onChange={(e) =>
            set(
              'supply_polarity_confirmed',
              e.target.value as SupplyDraft['supply_polarity_confirmed']
            )
          }
          className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[14px]"
        >
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="RCD I∆n">
          <input
            value={draft.rcd_operating_current}
            onChange={(e) => set('rcd_operating_current', e.target.value)}
            placeholder="30 mA"
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="RCD Delay">
          <input
            value={draft.rcd_time_delay}
            onChange={(e) => set('rcd_time_delay', e.target.value)}
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
        <Field label="RCD Time (ms)">
          <input
            value={draft.rcd_operating_time}
            onChange={(e) => set('rcd_operating_time', e.target.value)}
            className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[14px]"
          />
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      {children}
    </label>
  );
}
