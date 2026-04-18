'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, Trash2, UserPlus, Wrench } from 'lucide-react';
import { api } from '@/lib/api-client';
import { useCurrentUser } from '@/lib/use-current-user';
import type { InspectorProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Staff members list. Ports iOS `InspectorListView.swift`:
 *   - Gradient hero header with stacked avatars + count
 *   - Card list of inspectors (avatar circle, name, position, default pill)
 *   - Swipe-to-delete → long-press context menu on mobile; here a
 *     trash icon with a confirm dialog matches the web idiom better.
 *   - Empty state with primary Add button
 *
 * Data: fetched once on mount via `api.inspectorProfiles`. Mutations
 * (add/edit) live on the detail page, so we reload on navigation back
 * via a `focus` listener. Matches iOS behaviour where the list re-loads
 * on sheet dismiss.
 */
export default function StaffListPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const [inspectors, setInspectors] = React.useState<InspectorProfile[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<InspectorProfile | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);

  const load = React.useCallback(async (userId: string) => {
    try {
      const list = await api.inspectorProfiles(userId);
      setInspectors(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load staff');
    }
  }, []);

  React.useEffect(() => {
    if (!user) return;
    void load(user.id);
  }, [user, load]);

  // Refresh on tab focus — cheap way to pick up edits after navigating
  // back from the detail page without wiring a full pub-sub.
  React.useEffect(() => {
    if (!user) return;
    const onFocus = () => load(user.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user, load]);

  async function confirmDelete() {
    if (!deleting || !user || !inspectors) return;
    setIsBusy(true);
    try {
      const next = inspectors.filter((i) => i.id !== deleting.id);
      await api.updateInspectorProfiles(user.id, next);
      setInspectors(next);
      setDeleting(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete staff member');
    } finally {
      setIsBusy(false);
    }
  }

  if (!user || inspectors === null) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  const defaultInspector = inspectors.find((i) => i.is_default);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">Staff</h1>
        <Button size="sm" onClick={() => router.push('/settings/staff/new')} className="gap-1">
          <Plus className="h-4 w-4" aria-hidden />
          Add
        </Button>
      </div>

      {inspectors.length === 0 ? (
        <EmptyState count={inspectors.length} onAdd={() => router.push('/settings/staff/new')} />
      ) : (
        <>
          <HeroHeader
            count={inspectors.length}
            defaultName={defaultInspector?.name}
            inspectors={inspectors}
          />
          <div className="flex flex-col gap-2">
            {inspectors.map((inspector) => (
              <InspectorRow
                key={inspector.id}
                inspector={inspector}
                onDelete={() => setDeleting(inspector)}
              />
            ))}
          </div>
        </>
      )}

      {error ? (
        <p className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/30 bg-[color-mix(in_oklab,var(--color-status-failed)_8%,transparent)] px-3 py-2 text-[13px] text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title="Delete staff member?"
        description={
          deleting ? (
            <>
              Are you sure you want to delete <strong>{deleting.name}</strong>?
              {deleting.is_default ? ' This is your default staff member.' : ''}
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        confirmLabelBusy="Deleting…"
        confirmVariant="danger"
        busy={isBusy}
        onConfirm={confirmDelete}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------

function HeroHeader({
  count,
  defaultName,
  inspectors,
}: {
  count: number;
  defaultName?: string;
  inspectors: InspectorProfile[];
}) {
  return (
    <section
      className="relative overflow-hidden rounded-[var(--radius-lg)] p-5 text-white"
      style={{
        background:
          'linear-gradient(135deg, var(--color-brand-blue), color-mix(in oklab, var(--color-brand-green) 70%, var(--color-brand-blue)))',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[18px] font-bold">Your Team</h2>
          <p className="text-[13px] text-white/75">
            {count} staff member{count === 1 ? '' : 's'}
            {defaultName ? ` · Default: ${defaultName}` : ''}
          </p>
        </div>
        <div className="relative flex">
          {inspectors.slice(0, 3).map((i, idx) => (
            <span
              key={i.id}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/15 text-[13px] font-bold text-white/70"
              style={{ marginLeft: idx === 0 ? 0 : -12 }}
            >
              {(i.name || '?').trim().charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function InspectorRow({
  inspector,
  onDelete,
}: {
  inspector: InspectorProfile;
  onDelete: () => void;
}) {
  const initial = (inspector.name || '?').trim().charAt(0).toUpperCase();
  const equipmentCount = [
    inspector.mft_serial_number,
    inspector.continuity_serial_number,
    inspector.insulation_serial_number,
    inspector.earth_fault_serial_number,
    inspector.rcd_serial_number,
  ].filter((s) => s && s.length > 0).length;

  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-3">
      <Link
        href={`/settings/staff/${encodeURIComponent(inspector.id)}`}
        className="flex flex-1 items-center gap-3 focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] rounded-[var(--radius-md)]"
      >
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
          style={{
            background:
              'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
          }}
        >
          {initial}
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
            {inspector.name || '(unnamed)'}
          </span>
          {inspector.position ? (
            <span className="text-[12px] text-[var(--color-text-secondary)]">
              {inspector.position}
            </span>
          ) : null}
          {equipmentCount > 0 ? (
            <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)]">
              <Wrench className="h-3 w-3" aria-hidden />
              {equipmentCount} instrument{equipmentCount === 1 ? '' : 's'} registered
            </span>
          ) : null}
        </div>
        {inspector.is_default ? (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.05em]"
            style={{
              color: 'var(--color-brand-green)',
              background: 'color-mix(in oklab, var(--color-brand-green) 15%, transparent)',
            }}
          >
            DEFAULT
          </span>
        ) : null}
        <ChevronRight className="h-4 w-4 text-[var(--color-text-tertiary)]" aria-hidden />
      </Link>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${inspector.name || 'staff member'}`}
        className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-tertiary)] hover:bg-[color-mix(in_oklab,var(--color-status-failed)_10%,transparent)] hover:text-[var(--color-status-failed)]"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function EmptyState({ onAdd }: { count: number; onAdd: () => void }) {
  return (
    <section className="flex flex-col items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-10 text-center">
      <span
        className="flex h-20 w-20 items-center justify-center rounded-full"
        style={{
          color: 'var(--color-brand-blue)',
          background: 'color-mix(in oklab, var(--color-brand-blue) 10%, transparent)',
        }}
      >
        <UserPlus className="h-9 w-9" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">No Staff Members</h2>
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          Add your first staff member to start assigning inspectors to certificates.
        </p>
      </div>
      <Button onClick={onAdd} className="gap-2">
        <Plus className="h-4 w-4" aria-hidden />
        Add Staff Member
      </Button>
    </section>
  );
}
