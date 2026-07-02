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
 */
export function MultilineField({
  label,
  value,
  onChange,
  rows = 3,
  showCount = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  showCount?: boolean;
}) {
  const id = React.useId();
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
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-none bg-transparent text-[17px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
      />
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
