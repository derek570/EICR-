'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SelectChips — iOS-style dropdown followed by a row of chips that show the
 * currently selected option (tapping the chip does nothing; the dropdown is
 * canonical). Used on Installation / Supply tabs for earthing arrangement,
 * supply type, tariff etc.
 *
 * Tapping the dropdown toggles a small list rendered *inline below* the
 * trigger (not a portal / sheet — iOS uses an inline wheel, web uses inline
 * list). Keyboard nav: arrow up/down while open, Enter to commit, Esc to
 * close. Closing on outside click handled by a click-outside listener on
 * the document.
 */
export type SelectOption = { value: string; label: string };

export function SelectChips({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
}: {
  label: string;
  value: string | null;
  options: SelectOption[];
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        // WS5 (2026-07-02): trigger chrome matched to CMFloatingPicker —
        // L2 bg, 1.5px L3 border, green active state + glow, radius 12,
        // height 52, 12px medium label, 17px value.
        className={cn(
          'flex h-[var(--h-input)] items-center justify-between gap-2 rounded-[var(--radius-input)] border-[1.5px] bg-[var(--color-surface-2)] px-3 text-left transition',
          open
            ? 'border-[var(--color-green-vibrant)] shadow-[0_0_12px_rgba(0,230,118,0.2)]'
            : 'border-[color:var(--color-surface-3)] hover:border-[color:var(--color-border-strong)]'
        )}
      >
        <span className="flex flex-col">
          <span
            className={cn(
              'text-[12px] font-medium transition-colors',
              open ? 'text-[var(--color-green-vibrant)]' : 'text-[var(--color-text-secondary)]'
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              'text-[17px]',
              selected ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-[var(--color-text-secondary)] transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] p-1"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[var(--radius-sm)] px-3 py-2 text-left text-[14px] transition',
                    isSelected
                      ? 'bg-[var(--color-brand-blue)]/15 text-[var(--color-brand-blue)]'
                      : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]'
                  )}
                >
                  <span>{opt.label}</span>
                  {isSelected ? (
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: 'var(--color-brand-blue)' }}
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Chip row — shows every option, selected one highlighted blue.
          Matches iOS "compact summary chips" below the field. Clicking a
          chip also updates the value (fast-path, no dropdown open). */}
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isSelected = opt.value === value;
          return (
            <button
              key={`chip-${opt.value}`}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={isSelected}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
                isSelected
                  ? 'border-transparent bg-[var(--color-brand-blue)] text-white'
                  : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
