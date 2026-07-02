'use client';

import * as React from 'react';

/**
 * LabelledSelect — iOS-style select field that mirrors FloatingLabelInput's
 * two-line layout (small uppercase label above the native `<select>`).
 *
 * Extracted for Wave 3b (D11) from two copies in the Phase 6c admin pages:
 *   - web/src/app/settings/admin/users/[userId]/page.tsx
 *   - web/src/app/settings/admin/users/new/page.tsx
 *
 * The two copies were identical apart from a trailing `disabled:cursor-not-allowed`
 * on the `<select>` className — the `[userId]` copy had it, the `new` copy
 * didn't. The `new` page never passes `disabled`, so the extra class is inert
 * there. Retaining the class in the shared version is byte-identical for the
 * `new` render path (cursor rules only engage under `:disabled`) and matches
 * the `[userId]` behaviour when the prop is in use.
 */
export function LabelledSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const reactId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      {/* WS5 (2026-07-02): field chrome matched to CMFloatingTextField /
          CMFloatingPicker — L2 bg, 1.5px L3 border, green focus + glow,
          radius 12, height 52, 12px medium label, 17px value. */}
      <div
        className={`group relative flex h-[var(--h-input)] items-stretch rounded-[var(--radius-input)] border-[1.5px] bg-[var(--color-surface-2)] transition focus-within:border-[var(--color-green-vibrant)] focus-within:shadow-[0_0_12px_rgba(0,230,118,0.2)] ${
          disabled
            ? 'border-[color:var(--color-border-subtle)] opacity-60'
            : 'border-[color:var(--color-surface-3)]'
        }`}
      >
        <div className="flex flex-1 flex-col justify-center px-3">
          <label
            htmlFor={reactId}
            className="pointer-events-none text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors group-focus-within:text-[var(--color-green-vibrant)]"
          >
            {label}
          </label>
          <select
            id={reactId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="w-full bg-transparent text-[17px] text-[var(--color-text-primary)] focus:outline-none disabled:cursor-not-allowed"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
