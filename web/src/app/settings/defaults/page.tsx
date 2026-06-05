'use client';

import * as React from 'react';
import { Plus, FileText, Trash2 } from 'lucide-react';
import { HeroHeader } from '@/components/ui/hero-header';
import { useCurrentUser } from '@/lib/use-current-user';
import { usePresets } from '@/lib/defaults/hooks';
import { CableSizesEditor } from '@/components/defaults/cable-sizes-editor';
import { PresetEditorSheet } from '@/components/defaults/preset-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { CertificateDefaultPreset } from '@/lib/defaults/types';

/**
 * Defaults Manager — iOS `DefaultsManagerView.swift` parity.
 *
 * Three tabs:
 *   - **EICR**: list of EICR presets (each = a saved JobDetail snapshot
 *     the inspector can apply to a fresh job).
 *   - **EIC**: list of EIC presets.
 *   - **Cable Sizes**: 16-row table of canonical circuit-type cable
 *     defaults (mirrors `CableSizeDefaultsView.swift`).
 *
 * Replaces the Phase 6 hub stub. iOS canon stores presets in GRDB
 * locally; the PWA persists them in the existing user-defaults JSON
 * blob under the `presets` and `cable_defaults` namespaced keys (see
 * `web/src/lib/defaults/service.ts`).
 */

type DefaultsTab = 'EICR' | 'EIC' | 'Cable Sizes';
const TABS: DefaultsTab[] = ['EICR', 'EIC', 'Cable Sizes'];

export default function DefaultsManagerPage() {
  const [tab, setTab] = React.useState<DefaultsTab>('EICR');
  const { user } = useCurrentUser();
  const userId = user?.id;

  const [editing, setEditing] = React.useState<
    | { mode: 'new'; certificate_type: 'EICR' | 'EIC' }
    | { mode: 'edit'; preset: CertificateDefaultPreset }
    | null
  >(null);
  const [pendingDelete, setPendingDelete] = React.useState<CertificateDefaultPreset | null>(null);

  const certificateType = tab === 'Cable Sizes' ? undefined : tab;
  const { presets, loading, error, create, update, remove, refresh } = usePresets(
    userId,
    certificateType
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <HeroHeader eyebrow="Defaults" title="Default Values" subtitle="Presets & cable sizes" />

      {/* iOS-canon pill picker */}
      <div
        className="flex gap-2 overflow-x-auto px-1 pb-1"
        role="tablist"
        aria-label="Defaults sections"
      >
        {TABS.map((t) => {
          const selected = tab === t;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(t)}
              className="cm-tap-target rounded-full px-4 py-2 text-[13px] font-semibold transition focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
              style={{
                color: selected ? '#fff' : 'var(--color-brand-blue)',
                background: selected
                  ? 'var(--color-brand-blue)'
                  : 'color-mix(in oklab, var(--color-brand-blue) 8%, transparent)',
                border: selected
                  ? 'none'
                  : '1px solid color-mix(in oklab, var(--color-brand-blue) 20%, transparent)',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {tab === 'Cable Sizes' ? (
        <CableSizesEditor userId={userId} />
      ) : (
        <PresetsListPanel
          tab={tab}
          presets={presets}
          loading={loading}
          error={error}
          onNew={() => setEditing({ mode: 'new', certificate_type: tab })}
          onEdit={(p) => setEditing({ mode: 'edit', preset: p })}
          onDelete={(p) => setPendingDelete(p)}
        />
      )}

      {/* Editor sheet — handles both new + edit. Saving refreshes the list. */}
      {editing ? (
        <PresetEditorSheet
          mode={editing.mode}
          certificateType={
            editing.mode === 'edit' ? editing.preset.certificate_type : editing.certificate_type
          }
          existing={editing.mode === 'edit' ? editing.preset : null}
          onCancel={() => setEditing(null)}
          onSave={async (data) => {
            if (editing.mode === 'edit') {
              await update(editing.preset.id, data);
            } else {
              await create({
                name: data.name ?? '',
                certificate_type: editing.certificate_type,
                default_data: data.default_data ?? {},
              });
            }
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Delete confirmation. */}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete preset"
        description={pendingDelete ? `Delete "${pendingDelete.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (pendingDelete) {
            await remove(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </main>
  );
}

function PresetsListPanel({
  tab,
  presets,
  loading,
  error,
  onNew,
  onEdit,
  onDelete,
}: {
  tab: 'EICR' | 'EIC';
  presets: CertificateDefaultPreset[];
  loading: boolean;
  error: string | null;
  onNew: () => void;
  onEdit: (p: CertificateDefaultPreset) => void;
  onDelete: (p: CertificateDefaultPreset) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.6px] text-[var(--color-text-tertiary)]">
          {tab} Presets
        </span>
        <button
          type="button"
          onClick={onNew}
          className="cm-tap-target inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--color-brand-blue)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New
        </button>
      </div>

      {loading ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-6 text-center text-[var(--color-text-tertiary)]">
          Loading presets…
        </div>
      ) : error ? (
        <div className="rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--color-status-failed)_30%,transparent)] bg-[color:color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] p-4 text-[13px] text-[var(--color-status-failed)]">
          {error}
        </div>
      ) : presets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-4 py-10 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{
              background: 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)',
              color: 'var(--color-brand-blue)',
            }}
          >
            <FileText className="h-7 w-7" aria-hidden />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              No Presets
            </span>
            <span className="text-[12px] text-[var(--color-text-secondary)]">
              Create a preset to save default values for new {tab} certificates.
            </span>
          </div>
          <button
            type="button"
            onClick={onNew}
            className="cm-tap-target inline-flex items-center gap-2 rounded-full bg-[var(--color-brand-blue)] px-4 py-2 text-[13px] font-semibold text-white"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create Preset
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {presets.map((p) => (
            <li key={p.id}>
              <PresetRow preset={p} onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PresetRow({
  preset,
  onEdit,
  onDelete,
}: {
  preset: CertificateDefaultPreset;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 transition hover:bg-[var(--color-surface-3)]">
      <button
        type="button"
        onClick={onEdit}
        className="flex flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
          style={{
            background: 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)',
            color: 'var(--color-brand-blue)',
          }}
        >
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
            {preset.name}
          </span>
          <span className="flex items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{
                color:
                  preset.certificate_type === 'EICR'
                    ? 'var(--color-brand-blue)'
                    : 'var(--color-brand-green)',
                background:
                  preset.certificate_type === 'EICR'
                    ? 'color-mix(in oklab, var(--color-brand-blue) 12%, transparent)'
                    : 'color-mix(in oklab, var(--color-brand-green) 12%, transparent)',
              }}
            >
              {preset.certificate_type}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="cm-tap-target -mr-1 rounded-[var(--radius-md)] p-2 text-[var(--color-text-tertiary)] opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--color-status-failed)]"
        aria-label={`Delete ${preset.name}`}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
