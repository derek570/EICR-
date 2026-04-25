'use client';

import * as React from 'react';
import type { TourStep } from '@/lib/tour/steps';

/**
 * Floating spotlight + tooltip overlay (Phase 3).
 *
 * Renders a full-viewport dim with a cutout hole over the step's
 * target selector, plus a tip card next to the cutout. When the
 * selector resolves to nothing (or the user scrolled the target out
 * of view), the tip renders centred and the dim stays full-cover
 * with no cutout — a graceful fallback rather than a broken tour.
 *
 * We draw the dim + spotlight with two absolutely-positioned boxes
 * rather than an SVG mask because:
 *   - iOS Safari has had regressions with `mask-image` on fixed
 *     overlays as recently as 17.4.
 *   - The dim is decorative; a CSS-only path keeps the SSR + bundle
 *     impact to near-zero.
 *
 * Accessibility:
 *   - The overlay uses `pointer-events: none` so taps fall through
 *     to the highlighted element (important for the "alerts bell"
 *     step — the tip mustn't block the bell's tap target).
 *   - The tip card is `role="dialog"` with `aria-labelledby` bound
 *     to the title. The overlay does NOT trap focus; this is a
 *     guided-tour companion, not a modal.
 *   - `prefers-reduced-motion` is respected — no animation-in on
 *     the fade class when the user opts out (`@media` in globals.css
 *     handles it via the `motion-safe:` utility).
 */

export interface TourStepHighlightProps {
  step: TourStep;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8; // spotlight pad around the target

export function TourStepHighlight({ step }: TourStepHighlightProps) {
  const [rect, setRect] = React.useState<TargetRect | null>(null);

  // Resolve the target selector into a DOMRect. Re-runs on window
  // resize + scroll so the spotlight tracks layout changes (e.g.
  // the page shifting when a row appears).
  React.useEffect(() => {
    if (!step.selector) {
      setRect(null);
      return;
    }

    function measure() {
      const el = step.selector ? document.querySelector(step.selector) : null;
      if (!el) {
        setRect(null);
        return;
      }
      const r = (el as HTMLElement).getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    // Scroll into view so the highlight is actually visible.
    const target = step.selector
      ? (document.querySelector(step.selector) as HTMLElement | null)
      : null;
    if (target) {
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        // Old browsers fall back to the default jump — acceptable.
        target.scrollIntoView();
      }
    }

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, { capture: true } as EventListenerOptions);
    };
  }, [step.selector]);

  // Compute a tip position near the cutout; fall back to centred.
  const tipPos = computeTipPosition(rect, step.placement);

  const titleId = `tour-step-${step.id}`;

  return (
    <div aria-hidden="false" className="fixed inset-0 z-40" style={{ pointerEvents: 'none' }}>
      {/* Dim layer. When `rect` is known, we use a box-shadow trick
          to punch a hole — the inner rect is transparent and the
          outside receives a massive spread shadow in the dim colour. */}
      {rect ? (
        <div
          aria-hidden
          className="absolute"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            transition: 'top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease',
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.55)' }} />
      )}

      {/* Accent ring around the spotlight */}
      {rect ? (
        <div
          aria-hidden
          className="absolute"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 12,
            border: '2px solid var(--color-brand-blue)',
            boxShadow: '0 0 0 4px color-mix(in srgb, var(--color-brand-blue) 30%, transparent)',
            transition: 'top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease',
          }}
        />
      ) : null}

      {/* Tip card */}
      <div
        role="dialog"
        aria-labelledby={titleId}
        className="absolute w-[min(320px,calc(100vw-32px))] rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-4 shadow-xl"
        style={{
          top: tipPos.top,
          left: tipPos.left,
          transform: tipPos.transform,
          pointerEvents: 'auto',
        }}
      >
        <p id={titleId} className="text-[14px] font-bold text-[var(--color-text-primary)]">
          {step.title}
        </p>
        <p className="mt-1 text-[13px] leading-[1.45] text-[var(--color-text-secondary)]">
          {step.body}
        </p>
      </div>
    </div>
  );
}

function computeTipPosition(
  rect: TargetRect | null,
  placement: TourStep['placement'] = 'bottom'
): { top: number; left: number; transform: string } {
  if (!rect || placement === 'center') {
    return {
      top: window.innerHeight / 2,
      left: window.innerWidth / 2,
      transform: 'translate(-50%, -50%)',
    };
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const GAP = 16;
  switch (placement) {
    case 'top':
      return {
        top: rect.top - GAP,
        left: cx,
        transform: 'translate(-50%, -100%)',
      };
    case 'left':
      return {
        top: cy,
        left: rect.left - GAP,
        transform: 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: cy,
        left: rect.left + rect.width + GAP,
        transform: 'translate(0, -50%)',
      };
    case 'bottom':
    default:
      return {
        top: rect.top + rect.height + GAP,
        left: cx,
        transform: 'translate(-50%, 0)',
      };
  }
}
