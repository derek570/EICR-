'use client';

import * as React from 'react';

import {
  OCPD_BS_INPUT_CAP,
  OCPD_BS_TIER1,
  OCPD_BS_TIER2,
} from '@/lib/recording/ocpd-bs-suggestions.generated';
import { canonicaliseOcpdStandardForImport } from '@certmate/shared-utils';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { cn } from '@/lib/utils';

/**
 * PLAN-CC (feedback-2026-09-17 wave) — the ONE OCPD-standard editing control.
 *
 * All three web surfaces use it (the mobile card, the sticky-table cell and
 * the desktop schedule popover) so they share one commit contract, the same
 * suggestion tiers and the same cap. iOS has a single picker holding the same
 * contract.
 *
 * WHY FREE TEXT WITH SUGGESTIONS, NOT A DROPDOWN
 * ----------------------------------------------
 * The standard printed on a real device is routinely outside any list worth
 * putting in a picker — `BS 3871`, `BS 88-6`, `BS EN 60947-4-1`. A closed
 * dropdown made those unselectable, so the certificate recorded the wrong
 * standard or nothing. Tier 1 is what an inspector reaches for daily; Tier 2 is
 * behind a disclosure so the common case stays one tap; anything else is typed.
 *
 * THE THREE RULES, AND WHY EACH IS WHERE IT IS
 * --------------------------------------------
 * 1. The 24-character cap lives HERE and nowhere else. The grammar bounds its
 *    own output at 16 characters (`BS EN 12345-12-3`), so no dictation or
 *    import boundary needs a length rule — only a human with a keyboard can
 *    produce an unbounded string.
 * 2. A 25th character is REFUSED without changing the stored value. Truncating
 *    instead would silently store a different standard from the one typed.
 * 3. Canonicalisation happens on COMMIT, never per keystroke: canonicalising
 *    while typing would rewrite `60898` to `BS EN 60898` under the cursor after
 *    five characters. A value the grammar cannot read is stored exactly as
 *    typed — a picker is a manual boundary and a human typed it deliberately.
 */
/**
 * The commit contract itself, extracted so the three surfaces cannot drift.
 * A table cell cannot render the suggestion tiers in a 140px column, but it
 * MUST obey the same cap, the same refuse-don't-truncate rule and the same
 * canonicalise-on-commit timing.
 */
export function useOcpdStandardDraft(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = React.useState(value);

  // Re-seed when the row's stored value changes from outside this control (a
  // dictated write, a CCU import, an undo). Guarded on the committed value so
  // a re-render mid-typing does not stamp on the draft.
  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = React.useCallback(
    (raw: string) => {
      const next = raw.trim() === '' ? '' : canonicaliseOcpdStandardForImport(raw.trim());
      setDraft(next);
      if (next !== value) onCommit(next);
    },
    [onCommit, value]
  );

  const onChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // Refuse, do not truncate: truncating would silently store a different
    // standard from the one the inspector typed.
    if (next.length > OCPD_BS_INPUT_CAP) return;
    setDraft(next);
  }, []);

  const onBlur = React.useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => commit(e.target.value),
    [commit]
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
    },
    [commit]
  );

  return { draft, commit, onChange, onBlur, onKeyDown, cap: OCPD_BS_INPUT_CAP };
}

export function OcpdStandardField({
  label = 'BS EN',
  value,
  onCommit,
  inputRef,
  onFocus,
  onBlur,
  compact = false,
}: {
  label?: string;
  value: string;
  onCommit: (next: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  /** Table cells render the bare input without the suggestion tiers, which
   *  would not fit a 140px column. The commit contract is identical. */
  compact?: boolean;
}) {
  const [showTier2, setShowTier2] = React.useState(false);
  const field = useOcpdStandardDraft(value, onCommit);

  const input = (
    <FloatingLabelInput
      label={label}
      value={field.draft}
      maxLength={field.cap}
      ref={inputRef}
      onChange={field.onChange}
      onFocus={onFocus}
      onBlur={(e) => {
        field.onBlur(e);
        onBlur?.(e);
      }}
      onKeyDown={field.onKeyDown}
    />
  );

  if (compact) return input;

  return (
    <div className="flex flex-col gap-2">
      {input}
      <div className="flex flex-wrap gap-1.5">
        {OCPD_BS_TIER1.map((option) => (
          <SuggestionChip
            key={option}
            option={option}
            selected={option === value}
            onPick={() => field.commit(option)}
          />
        ))}
        {showTier2
          ? OCPD_BS_TIER2.map((option) => (
              <SuggestionChip
                key={option}
                option={option}
                selected={option === value}
                onPick={() => field.commit(option)}
              />
            ))
          : null}
        <button
          type="button"
          onClick={() => setShowTier2((s) => !s)}
          aria-expanded={showTier2}
          className="rounded-full border border-dashed border-[var(--color-border-subtle)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
        >
          {showTier2 ? 'Fewer standards' : 'More standards'}
        </button>
      </div>
    </div>
  );
}

function SuggestionChip({
  option,
  selected,
  onPick,
}: {
  option: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
        selected
          ? 'border-transparent bg-[var(--color-brand-blue)] text-white'
          : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
      )}
    >
      {option}
    </button>
  );
}
