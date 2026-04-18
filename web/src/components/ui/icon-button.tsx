import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * IconButton — icon-only button with a guaranteed minimum touch target.
 *
 * Why this exists:
 *   Several icon-only buttons across the app rendered below WCAG 2.5.5 /
 *   Apple HIG's 44×44 minimum hit area — `h-8 w-8` close buttons,
 *   `h-9 w-9` back chevrons, `h-6 w-6` dismiss pips, etc. Tapping these
 *   on mobile is error-prone: the user's finger pad is ~9–11mm wide but
 *   a 32px target is only ~8.5mm on a modern iPhone. `<Button size="icon">`
 *   exists in `button.tsx` but (a) nobody reached for it — the 44×44
 *   default got bypassed with ad-hoc `h-8 w-8` Tailwind classes — and
 *   (b) it doesn't enforce an `aria-label`, so a screen-reader-invisible
 *   icon-only button was trivially expressible.
 *
 * Why a wrapper instead of extending Button:
 *   IconButton's contract is narrower than Button's: no variants, no
 *   children text, a REQUIRED `aria-label`, and a glyph as the (single)
 *   child. Extending Button would mean either weakening Button's type
 *   (making `aria-label` required globally is wrong) or losing the
 *   type-level enforcement. A dedicated wrapper keeps Button unchanged
 *   for the label-plus-icon cases (they already have adequate hit area
 *   via their text width) and forces `aria-label` on the icon-only
 *   cases where it's the only accessible name.
 *
 * Why `aria-label` is required (not optional):
 *   If we made it optional and defaulted to `''`, a dev could ship an
 *   icon button with no accessible name and the type-checker wouldn't
 *   catch it. WCAG 4.1.2 / WCAG 2.5.5 compliance is a floor not a
 *   ceiling — a 44×44 target for a screen-reader-invisible button isn't
 *   a11y progress. The TypeScript types reflect that.
 *
 * Sizing rationale:
 *   - `sm` (36×36) — desktop-only clusters where hover is the primary
 *     interaction. Do not use in mobile-visible chrome.
 *   - `md` (44×44, DEFAULT) — the WCAG/HIG minimum. Use this by default
 *     unless you have a specific reason not to.
 *   - `lg` (48×48) — hero actions (e.g. dashboard FAB-adjacent), where
 *     the button sits alone and a larger target reduces mis-taps while
 *     walking / on uneven ladder work (CertMate inspectors do both).
 *
 * Glyph sizing:
 *   All sizes render a 24×24 glyph (`h-6 w-6`). The hit area grows via
 *   the box size; the icon visual weight stays constant so the button
 *   reads the same across sizes — only its affordance for touch
 *   changes. Override via `iconClassName` if a specific call site wants
 *   a smaller visual icon but must keep the 44×44 tap area.
 *
 * Why Slot/asChild:
 *   Several sweep sites need a Next `<Link>` as the element (back links
 *   in settings pages). `asChild` lets the consumer pass a Link as the
 *   single child WITHOUT collapsing the Link into a bare <a> — Radix's
 *   Slot merges our className/aria onto the Link's rendered <a>.
 */
const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-full font-semibold transition active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        default:
          'bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]',
        surface:
          'bg-[var(--color-surface-2)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]',
        destructive:
          'bg-transparent text-[var(--color-status-failed)]/80 hover:bg-[color-mix(in_oklab,var(--color-status-failed)_10%,transparent)] hover:text-[var(--color-status-failed)]',
        overlay: 'bg-black/65 text-white hover:bg-black/80',
      },
      size: {
        // 36×36 — desktop-only. Fails WCAG 2.5.5 on mobile; use sparingly.
        sm: 'h-9 w-9',
        // 44×44 — WCAG 2.5.5 AA / Apple HIG minimum. Default.
        md: 'h-11 w-11',
        // 48×48 — hero icon-only actions.
        lg: 'h-12 w-12',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  }
);

/**
 * `aria-label` is required — an icon-only button MUST expose an
 * accessible name since there's no text content for AT to read.
 *
 * We intersect `ButtonHTMLAttributes` with `{ 'aria-label': string }`
 * (no optional marker) so TypeScript rejects any call site that omits
 * it or passes empty string through a widened type. This matches
 * Radix's pattern for required a11y props.
 */
type NativeButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
>;

export interface IconButtonProps
  extends NativeButtonProps, VariantProps<typeof iconButtonVariants> {
  /**
   * Required accessible name. Never empty. Static copy preferred;
   * if dynamic, ensure the formatted string is non-empty in every
   * branch (e.g. `Remove ${name ?? 'item'}` not `Remove ${name}`).
   */
  'aria-label': string;
  /** The single icon/glyph child (lucide-react icon, SVG, etc.). */
  children: React.ReactNode;
  /**
   * When true, merges our className/aria onto the single child
   * element (typically a Next `<Link>`). The child is responsible
   * for rendering the glyph.
   */
  asChild?: boolean;
  /**
   * Extra classes applied to the default glyph wrapper. Only used
   * when `asChild` is false — `asChild` consumers control their own
   * inner markup.
   */
  iconClassName?: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, asChild, iconClassName, children, type, ...props },
  ref
) {
  if (asChild) {
    // Slot merges our className onto the child root (e.g. a Link's <a>).
    // The child owns its own children (the glyph); we don't wrap.
    return (
      <Slot
        ref={ref as React.Ref<HTMLElement>}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...(props as React.HTMLAttributes<HTMLElement>)}
      >
        {children}
      </Slot>
    );
  }
  return (
    <button
      ref={ref}
      // Default to type="button" so IconButtons don't accidentally
      // submit a containing <form>. The consumer can opt back in with
      // type="submit" explicitly (rare for icon-only buttons).
      type={type ?? 'button'}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    >
      <span
        // The wrapper normalises glyph size to 24×24 regardless of
        // how the consumer's inline SVG was sized. Lucide icons
        // respond to `className="h-6 w-6"` via their internal
        // width/height prop forwarding; raw SVGs size off this box.
        aria-hidden
        className={cn('inline-flex h-6 w-6 items-center justify-center', iconClassName)}
      >
        {children}
      </span>
    </button>
  );
});

export { iconButtonVariants };
