'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Thin wrapper around `@radix-ui/react-dialog` (Wave 4 D5).
 *
 * Radix provides the accessibility spine for free:
 *   - Focus trap inside the content, restored to the trigger on close
 *   - Esc-to-close
 *   - `aria-modal` + `role="dialog"` on Content
 *   - Portal-based mount (breaks out of positioned ancestors)
 *   - Scroll lock on <body> while open
 *
 * This wrapper intentionally stops at styling. It re-exports the Radix
 * parts 1:1 (`Root`, `Trigger`, `Portal`, `Close`, `Title`, `Description`)
 * and adds two styled composites: `<DialogOverlay>` (backdrop) and
 * `<DialogContent>` (centred card + built-in × close button).
 *
 * Animation: we rely on CSS transitions keyed off Radix's `data-state`
 * attribute. The project doesn't ship `tailwindcss-animate`, so the
 * keyframes live in `globals.css` as a small reusable block. The
 * `prefers-reduced-motion` global rule added in D9 short-circuits the
 * transitions so Radix's open/close still fires but without motion.
 *
 * Callers that need a bottom-sheet layout on mobile (`items-end` vs
 * `items-center`) pass their own `className` to override `DialogContent`
 * defaults — see `observation-sheet.tsx` for the mobile-sheet +
 * desktop-card pattern.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        // Full-viewport scrim. `z-50` matches the old ad-hoc modals so
        // the AppShell header stays covered. Backdrop blur matches the
        // iOS translucent sheet aesthetic.
        'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
        'cm-dialog-overlay',
        className
      )}
      {...props}
    />
  );
});

interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /**
   * Render a built-in close (×) button in the top-right corner. Most
   * settings modals want this; the recording overlay does not (it has
   * its own Minimise + End controls in the hero bar).
   */
  showCloseButton?: boolean;
  /** Optional override for the close button's accessible name. */
  closeLabel?: string;
  /**
   * When `true`, skip the default centred-card styling and let the
   * caller take over layout entirely. Used by the recording overlay
   * and the observation sheet which have their own full-height / bottom
   * -sheet layouts. Radix still wraps the content in its Portal +
   * focus-trap spine; only visual defaults are dropped.
   */
  unstyled?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, showCloseButton = true, closeLabel = 'Close', unstyled, ...props },
  ref
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          unstyled
            ? 'fixed inset-0 z-50 focus-visible:outline-none'
            : [
                // Centered card default — mirrors the five existing
                // settings modals. Width capped at `max-w-md` so long
                // descriptions wrap rather than spanning the viewport.
                'fixed left-1/2 top-1/2 z-50 mx-4 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
                'rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-5 shadow-lg',
                'focus-visible:outline-none',
                'cm-dialog-content',
              ],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && !unstyled ? (
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className={cn(
              'absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full',
              'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]',
              'focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]'
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-[17px] font-bold text-[var(--color-text-primary)]', className)}
      {...props}
    />
  );
});

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('mt-2 text-[13px] text-[var(--color-text-secondary)]', className)}
      {...props}
    />
  );
});

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
