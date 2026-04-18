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
      <div
        className={`group relative flex h-14 items-stretch rounded-[var(--radius-md)] border bg-[var(--color-surface-1)] transition focus-within:border-[var(--color-brand-blue)] ${
          disabled
            ? 'border-[var(--color-border-subtle)] opacity-60'
            : 'border-[var(--color-border-default)]'
        }`}
      >
        <div className="flex flex-1 flex-col justify-center px-3">
          <label
            htmlFor={reactId}
            className="pointer-events-none text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]"
          >
            {label}
          </label>
          <select
            id={reactId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="w-full bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] focus:outline-none disabled:cursor-not-allowed"
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
