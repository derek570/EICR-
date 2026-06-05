'use client';

import * as React from 'react';
import { Cable, Check, Save } from 'lucide-react';
import { useCableDefaults } from '@/lib/defaults/hooks';
import { CABLE_SIZE_OPTIONS, WIRING_TYPE_OPTIONS, REF_METHOD_OPTIONS } from '@/lib/defaults/types';
import type { CableDefault } from '@/lib/defaults/types';

/**
 * Cable Sizes editor — iOS `CableSizeDefaultsView.swift` parity.
 *
 * 16-row table of canonical circuit-type defaults, each with four
 * pickers: Live mm², CPC mm², Wiring Type, Ref Method. Save is bulk
 * (one PUT writes the whole table) — mirrors iOS, which only persists
 * on the screen's onDisappear.
 */
export function CableSizesEditor({ userId }: { userId: string | undefined }) {
  const { rows, loading, error, save } = useCableDefaults(userId);
  const [draft, setDraft] = React.useState<CableDefault[] | null>(null);
  const [savedFlag, setSavedFlag] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Sync local draft from server state whenever the row count changes
  // (initial load + add-missing pass). Don't clobber user edits in
  // progress: if `draft` is already populated and matches the server
  // count, leave it alone.
  React.useEffect(() => {
    if (!draft || draft.length !== rows.length) {
      setDraft(rows);
    }
  }, [rows, draft]);

  const editable = draft ?? rows;

  const updateRow = (id: string, patch: Partial<CableDefault>) => {
    setDraft((curr) => {
      const base = curr ?? rows;
      return base.map((r) => (r.id === id ? { ...r, ...patch } : r));
    });
  };

  const onSave = async () => {
    if (!editable) return;
    setBusy(true);
    try {
      await save(editable);
      setSavedFlag(true);
      setTimeout(() => setSavedFlag(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  if (loading && editable.length === 0) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-6 text-center text-[var(--color-text-tertiary)]">
        Loading cable defaults…
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {/* Info banner — iOS canon copy. */}
      <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--color-brand-blue)_18%,transparent)] bg-[color:color-mix(in_oklab,var(--color-brand-blue)_6%,transparent)] p-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-white"
          style={{ background: 'var(--color-brand-blue)' }}
          aria-hidden
        >
          i
        </span>
        <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          These defaults are automatically applied when circuits are created. All values can be
          overwritten by speaking during testing.
        </p>
      </div>

      {/* Section header */}
      <div className="flex items-center gap-2 px-1">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-white"
          style={{ background: 'var(--color-brand-green)' }}
          aria-hidden
        >
          <Cable className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.8px] text-[var(--color-text-tertiary)]">
          Cable Sizes
        </span>
      </div>

      {error ? (
        <div className="rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--color-status-failed)_30%,transparent)] bg-[color:color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] p-3 text-[13px] text-[var(--color-status-failed)]">
          {error}
        </div>
      ) : null}

      {/* Cable default cards */}
      <ul className="flex flex-col gap-2 pb-20">
        {editable.map((row) => (
          <li key={row.id}>
            <CableRow row={row} onChange={(patch) => updateRow(row.id, patch)} />
          </li>
        ))}
      </ul>

      {/* Sticky save CTA */}
      <div className="sticky bottom-0 -mx-4 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-4 py-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="cm-tap-target inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] py-3 text-[14px] font-semibold text-white transition disabled:opacity-50"
          style={{
            background: savedFlag ? 'var(--color-brand-green)' : 'var(--color-brand-blue)',
          }}
        >
          {savedFlag ? (
            <>
              <Check className="h-4 w-4" aria-hidden />
              Saved
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden />
              {busy ? 'Saving…' : 'Save Cable Defaults'}
            </>
          )}
        </button>
      </div>
    </section>
  );
}

function CableRow({
  row,
  onChange,
}: {
  row: CableDefault;
  onChange: (patch: Partial<CableDefault>) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3">
      {/* Card header */}
      <div className="flex items-center gap-2">
        <Cable className="h-4 w-4 text-[var(--color-brand-blue)]" aria-hidden />
        <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
          {row.display_name}
        </span>
      </div>

      {/* Sizes row */}
      <div className="grid grid-cols-2 gap-3">
        <FieldSelect
          label="Live mm²"
          value={row.conductor_size}
          options={CABLE_SIZE_OPTIONS}
          onChange={(v) => onChange({ conductor_size: v })}
        />
        <FieldSelect
          label="CPC mm²"
          value={row.cpc_size}
          options={CABLE_SIZE_OPTIONS}
          onChange={(v) => onChange({ cpc_size: v })}
        />
      </div>

      {/* Type row */}
      <div className="grid grid-cols-2 gap-3">
        <FieldSelect
          label="Wiring Type"
          value={row.wiring_type}
          options={WIRING_TYPE_OPTIONS}
          onChange={(v) => onChange({ wiring_type: v })}
        />
        <FieldSelect
          label="Ref Method"
          value={row.ref_method}
          options={REF_METHOD_OPTIONS}
          onChange={(v) => onChange({ ref_method: v })}
        />
      </div>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  options: ReadonlyArray<string>;
  onChange: (next: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="cm-tap-target rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[13px] text-[var(--color-text-primary)]"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
