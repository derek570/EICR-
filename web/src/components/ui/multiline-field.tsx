'use client';

import * as React from 'react';

/**
 * MultilineField — FloatingLabelInput's two-line shape with a textarea.
 *
 * Extracted for Wave 3b (D11) from three copies in the Phase 3a recording
 * tabs:
 *   - web/src/app/job/[id]/installation/page.tsx   (no count)
 *   - web/src/app/job/[id]/design/page.tsx         (no count)
 *   - web/src/app/job/[id]/extent/page.tsx         (with count)
 *
 * Divergence preserved:
 *   - The extent copy adds an outer `flex flex-col gap-1` wrapper plus a
 *     right-aligned "N characters" counter to match the iOS extent screen.
 *     Activated via `showCount`. When `showCount` is false (default), the
 *     component emits exactly the same markup the installation/design copies
 *     did — a bare field box, no wrapping div — so their renders stay
 *     byte-identical to pre-refactor.
 *
 * PLAN-F (2026-09-14, feedback ids 135 and 137): `autoGrow` adds a bounded
 * growing variant, the web half of the iOS `CMFloatingTextEditor` fix. It is
 * OPT-IN, not a new default — nine callers use this component and only the
 * four long free-text fields (extent, comments, departures, departure details)
 * have the evidence behind them. The five Installation callers keep the fixed
 * shape and are recorded as dated divergences in `parity-ledger.md`.
 */

/** Line box of the grown variant, in px. Pinned so the 3/12-line bounds below
 *  are exact rather than dependent on an inherited line-height. */
const AUTO_GROW_LINE_HEIGHT = 24;
/** Lower bound — matches iOS `CMFloatingTextEditor`'s `minLines: 3`. */
const AUTO_GROW_MIN_LINES = 3;
/** Upper bound — matches iOS's `maxLines: 12`. Past this the control stops
 *  growing and scrolls internally, so a long extent clause cannot push the
 *  rest of the form off-screen. */
const AUTO_GROW_MAX_LINES = 12;

export function MultilineField({
  label,
  value,
  onChange,
  rows = 3,
  showCount = false,
  autoGrow = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  showCount?: boolean;
  autoGrow?: boolean;
}) {
  const id = React.useId();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Grow to fit the content, bounded by `maxHeight` below. Height is reset to
  // `auto` first so the measurement shrinks as well as grows — `scrollHeight`
  // on an already-tall box only ever reports the taller value.
  const fitToContent = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // `useLayoutEffect` so the resize lands in the same frame as the keystroke;
  // jsdom reports `scrollHeight === 0` and no layout, which is why the web
  // acceptance for the grown height is a Playwright case, not a Vitest one.
  // Clearing the height when the variant is off matters because the textarea
  // is reused across a variant flip — a stale inline height would outlive it.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!autoGrow) {
      el.style.height = '';
      return;
    }
    fitToContent();
  }, [autoGrow, value, fitToContent]);

  // Content height depends on the field's WIDTH, so a rotation or any reflow
  // that changes the width invalidates the fitted height without changing
  // `value`. Measured on a real browser before this was added: fill a
  // ~300-character extent in landscape (3 lines, 72px), rotate to portrait and
  // the same text needs 8 lines — `scrollHeight` 192 against an unchanged
  // `clientHeight` of 72, so two thirds of the clause is hidden behind an
  // internal scrollbar. That is exactly the complaint this variant exists to
  // fix (feedback id 135 named landscape specifically), so it has to re-fit.
  //
  // The observer watches the textarea but reacts only to WIDTH changes: its
  // own height writes would otherwise re-enter the callback, and ignoring them
  // keeps this free of the ResizeObserver feedback loop.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!autoGrow || !el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      fitToContent();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoGrow, fitToContent]);

  // WS5 (2026-07-02): field chrome matched to the iOS floating-field /
  // cmTextEditorStyle spec — L2 bg, 1.5px L3 border, green focus + glow,
  // radius 12, 12px medium label, 17px value.
  const box = (
    <div className="group flex flex-col rounded-[var(--radius-input)] border-[1.5px] border-[color:var(--color-surface-3)] bg-[var(--color-surface-2)] px-3 py-2 transition focus-within:border-[var(--color-green-vibrant)] focus-within:shadow-[0_0_12px_rgba(0,230,118,0.2)]">
      <label
        htmlFor={id}
        className="text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors group-focus-within:text-[var(--color-green-vibrant)]"
      >
        {label}
      </label>
      {autoGrow ? (
        // No `rows`: the height is the content's, between the two bounds.
        // `resize-y` rather than `resize-none` keeps the manual grabber as an
        // escape hatch past the 12-line cap (the next keystroke re-fits the
        // box, which is the same trade every auto-growing editor makes).
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // The three bounds are inline styles, NOT `min-h-[..]`/`max-h-[..]`
          // utilities: Tailwind v4 scans source text for complete class names,
          // so an arbitrary value built by interpolation emits no CSS at all
          // and the cap would silently not exist.
          style={{
            lineHeight: `${AUTO_GROW_LINE_HEIGHT}px`,
            minHeight: `${AUTO_GROW_MIN_LINES * AUTO_GROW_LINE_HEIGHT}px`,
            maxHeight: `${AUTO_GROW_MAX_LINES * AUTO_GROW_LINE_HEIGHT}px`,
          }}
          className="w-full resize-y overflow-y-auto bg-transparent text-[17px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
        />
      ) : (
        // Same `ref` as the grown branch on purpose. React reconciles the two
        // by element type and REUSES this DOM node across a variant flip, but
        // drops the ref with the branch that declared it — so without this the
        // clear-on-flip effect above sees a null ref and the stale inline
        // height survives on the reused node.
        <textarea
          id={id}
          ref={textareaRef}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full resize-none bg-transparent text-[17px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
        />
      )}
    </div>
  );
  if (!showCount) return box;
  return (
    <div className="flex flex-col gap-1">
      {box}
      <p className="pr-1 text-right font-mono text-[11px] text-[var(--color-text-tertiary)]">
        {value.length} characters
      </p>
    </div>
  );
}
