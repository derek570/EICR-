'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button, type ButtonProps } from '@/components/ui/button';
import { haptic } from '@/lib/haptic';

/**
 * Controlled confirm-dialog primitive (Wave 4 D5).
 *
 * Replaces every `window.confirm(...)` call site in the app. The native
 * browser confirm is rejected on two grounds:
 *   1. It doesn't respect our design tokens at all (renders as a flat
 *      OS chrome popup — jarring against the dark surface palette).
 *   2. On iOS Safari it steals focus in a way that can race with a
 *      pending network request and fire the confirmed handler twice.
 *
 * The API is deliberately minimal — intended for binary
 * "confirm / cancel" flows only. Forms with their own Submit go through
 * the lower-level `<Dialog>` / `<DialogContent>` primitives, not this.
 *
 * Props:
 *   - `open` / `onOpenChange` — controlled open state. The parent keeps
 *     the boolean so it can also be used to avoid re-mount flicker.
 *   - `title` / `description` — the prompt copy. `description` is
 *     optional; omit for one-line confirms ("Delete this item?").
 *   - `confirmLabel` / `cancelLabel` — button copy. Defaults chosen to
 *     read well on any destructive surface.
 *   - `confirmVariant` — `'primary'` (default) or `'danger'` for
 *     destructive actions. `'danger'` maps to the Button `destructive`
 *     variant so we keep a single red-treatment source of truth.
 *   - `onConfirm` — fired on confirm click. The parent is responsible
 *     for closing via `onOpenChange(false)` after the async action
 *     finishes; this keeps the "busy" spinner visible while the
 *     request is in flight.
 *   - `busy` — disables both buttons and shows the `confirmLabelBusy`
 *     text on the confirm button. Lets the parent show progress
 *     without swapping the whole dialog out.
 *
 * Accessibility:
 *   - Title + description are wired to `aria-labelledby` /
 *     `aria-describedby` via Radix automatically.
 *   - Focus defaults to the Cancel button (Radix's first focusable in
 *     DOM order). That's deliberate for destructive confirms — Enter
 *     shouldn't trigger the dangerous path by reflex.
 *
 * Usage:
 * ```
 * <ConfirmDialog
 *   open={deleting !== null}
 *   onOpenChange={(v) => !v && setDeleting(null)}
 *   title="Delete staff member?"
 *   description={`Are you sure you want to delete ${deleting?.name}?`}
 *   confirmLabel="Delete"
 *   confirmVariant="danger"
 *   busy={isBusy}
 *   onConfirm={confirmDelete}
 * />
 * ```
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  /** Shown on the confirm button while `busy` is true. Defaults to `${confirmLabel}…`. */
  confirmLabelBusy?: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  /**
   * Phase 1 ergonomic alias — `destructive={true}` is equivalent to
   * `confirmVariant="danger"`. Explicit `confirmVariant` still wins when
   * both are set so existing callsites don't silently flip colour.
   */
  destructive?: boolean;
  /**
   * Controlled busy state. When omitted, the dialog manages its own busy
   * state internally: onConfirm returning a Promise causes the confirm
   * button to disable + show the busy label until the promise settles
   * (resolves OR rejects), preventing double-fire on destructive taps.
   */
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  confirmLabelBusy,
  cancelLabel = 'Cancel',
  confirmVariant,
  destructive,
  busy,
  onConfirm,
}: ConfirmDialogProps) {
  const [internalBusy, setInternalBusy] = React.useState(false);
  const effectiveBusy = busy ?? internalBusy;
  const resolvedVariant: 'primary' | 'danger' =
    confirmVariant ?? (destructive ? 'danger' : 'primary');
  const confirmButtonVariant: ButtonProps['variant'] =
    resolvedVariant === 'danger' ? 'destructive' : 'primary';

  const busyText = confirmLabelBusy ?? `${confirmLabel}…`;

  const handleConfirm = React.useCallback(() => {
    // Phase 9: fire a lightweight haptic pulse when the inspector
    // commits a destructive action. Best-effort — platforms without
    // the Vibration API silently no-op. See `web/src/lib/haptic.ts`.
    haptic(resolvedVariant === 'danger' ? 'medium' : 'light');
    if (busy !== undefined) {
      void onConfirm();
      return;
    }
    const result = onConfirm();
    if (result && typeof (result as Promise<void>).then === 'function') {
      setInternalBusy(true);
      (result as Promise<void>).finally(() => {
        setInternalBusy(false);
      });
    }
  }, [busy, onConfirm, resolvedVariant]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={effectiveBusy}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={confirmButtonVariant}
            disabled={effectiveBusy}
            onClick={handleConfirm}
          >
            {effectiveBusy ? busyText : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
