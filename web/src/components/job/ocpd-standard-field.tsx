'use client';

import * as React from 'react';

import {
  OCPD_BS_INPUT_CAP,
  OCPD_BS_TIER1,
  OCPD_BS_TIER2,
} from '@/lib/recording/ocpd-bs-suggestions.generated';
import { canonicaliseOcpdStandardForImport } from '@certmate/shared-utils';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
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
    //
    // The cap is enforced HERE and deliberately NOT with the native
    // `maxLength` attribute. `maxLength` truncates a PASTE before React sees
    // it, so a pasted 25-character standard would arrive at this handler
    // already 24 characters long, pass the check, and commit — silently
    // storing a different standard, which is the exact outcome the
    // refuse-don't-truncate rule exists to prevent. `length` is UTF-16 units;
    // the Swift twin counts `utf16.count` for the same reason.
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

/**
 * PLAN-CC — the TABLE form of the OCPD-standard control: a free-text input
 * with the shared commit contract, plus the suggestion tiers behind a chevron.
 *
 * Both grid surfaces use it — the desktop schedule and the sticky table. The
 * sticky table originally rendered a bare input, which left one of the three
 * web surfaces with no suggestions at all while acceptance 4 requires both
 * tiers on every one of them. Sharing the component is what makes that
 * structurally true rather than something to re-check.
 *
 * It is a combo rather than a dropdown because the closed list is what the
 * plan removes: a `BS 3871` or `BS 88-6` printed on the device has to be
 * recordable. Tier 2 sits behind a disclosure so the everyday case stays one
 * click, and the cap and canonicalise-on-commit timing come from
 * `useOcpdStandardDraft`, shared with the card too.
 */
/** Enough room for the clear row plus a few suggestions; below this the list
 *  flips above the cell rather than being clipped by the viewport edge. */
const MIN_LIST_HEIGHT = 120;

export function OcpdStandardComboCell({
  value,
  onCommit,
  ariaLabel,
  isOpen,
  onOpen,
  onClose,
  font = 'text-[13px]',
  inputRef,
  onFocus,
  onAccessoryBlur,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Tailwind text size — the sticky table runs 12px, the schedule 13px. */
  font?: string;
  /** Keyboard-accessory registration. The sticky table's bar walks focusable
   *  cells by `(circuitId, field)`; without these the OCPD standard would be
   *  the one text cell its prev/next arrows skip. */
  inputRef?: (el: HTMLInputElement | null) => void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onAccessoryBlur?: () => void;
}) {
  const [showTier2, setShowTier2] = React.useState(false);
  const field = useOcpdStandardDraft(value, onCommit);
  const suggestions = showTier2 ? [...OCPD_BS_TIER1, ...OCPD_BS_TIER2] : OCPD_BS_TIER1;

  // PLAN-CC — the list is PORTALLED, not absolutely positioned inside the
  // cell. The sticky table's scroll container is `overflow-x-auto`, which
  // clips absolutely-positioned descendants on BOTH axes: the tiers were in
  // the DOM and could not be reached, so one of the three web surfaces
  // effectively had no suggestions at all. A portal with viewport coordinates
  // escapes any container, and using it on both grid surfaces keeps them on
  // one code path rather than leaving the next narrow-column surface to
  // rediscover this.
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = React.useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  React.useEffect(() => {
    if (!isOpen) {
      setAnchor(null);
      return;
    }
    const measure = () => {
      const box = anchorRef.current?.getBoundingClientRect();
      if (!box) return;
      // A FIXED list does not extend the page's scroll area, so one placed
      // below a row near the bottom of the viewport simply falls off it and
      // its options cannot be reached. Flip above the cell when there is more
      // room there, and cap the height to whatever room the chosen side has.
      const GAP = 4;
      const below = window.innerHeight - box.bottom - GAP;
      const above = box.top - GAP;
      const flip = below < MIN_LIST_HEIGHT && above > below;
      const maxHeight = Math.max(MIN_LIST_HEIGHT, Math.min(256, flip ? above : below));
      setAnchor({
        left: box.left,
        top: flip ? box.top - GAP - maxHeight : box.bottom + GAP,
        width: box.width,
        maxHeight,
      });
    };
    measure();
    // The anchor moves when either the table or the page scrolls; `true`
    // catches scrolls on ancestor containers, not just the window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={anchorRef} onClick={(e) => e.stopPropagation()}>
      <div
        className={`flex h-10 w-full items-center gap-1 rounded-[var(--radius-sm)] border px-2 transition-all duration-150 ${
          isOpen
            ? 'border-[var(--color-brand-blue)] bg-[var(--color-surface-2)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand-blue)_25%,transparent)]'
            : 'border-transparent hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)]'
        }`}
      >
        <input
          type="text"
          inputMode="text"
          ref={inputRef}
          value={field.draft}
          onChange={field.onChange}
          onFocus={onFocus}
          onBlur={(e) => {
            field.onBlur(e);
            onAccessoryBlur?.();
          }}
          onKeyDown={field.onKeyDown}
          aria-label={ariaLabel}
          placeholder="—"
          className={cn(
            'h-full w-full min-w-0 bg-transparent font-medium placeholder:opacity-50 focus:outline-none',
            font
          )}
        />
        <button
          type="button"
          onClick={() => (isOpen ? onClose() : onOpen())}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={`${ariaLabel} suggestions`}
          className="flex-shrink-0"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform duration-150 ${
              isOpen ? 'rotate-180 text-[var(--color-brand-blue)]' : 'opacity-60'
            }`}
            aria-hidden
          />
        </button>
      </div>
      {isOpen && anchor && typeof document !== 'undefined'
        ? createPortal(
            <ul
              role="listbox"
              aria-label={ariaLabel}
              onClick={(e) => e.stopPropagation()}
              // The portal is OUTSIDE the grid's container, so a host's
              // click-outside handler would see a press on this list as an
              // outside click and close it before the button's click fired —
              // the suggestions would look selectable and never select.
              // Stopping mousedown here keeps that boundary correct without
              // every host having to know the list is portalled.
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: anchor.left,
                top: anchor.top,
                minWidth: Math.max(anchor.width, 160),
                maxHeight: anchor.maxHeight,
              }}
              className="cm-popover-in z-50 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
            >
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => {
                    field.commit('');
                    onClose();
                  }}
                  className="block w-full px-3 py-2 text-left text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)]"
                >
                  — Clear —
                </button>
              </li>
              {suggestions.map((opt) => (
                <li key={opt}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === opt}
                    onClick={() => {
                      field.commit(opt);
                      onClose();
                    }}
                    className={`block w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--color-surface-2)] ${
                      value === opt
                        ? 'bg-[var(--color-surface-2)] text-[var(--color-brand-blue)]'
                        : 'text-[var(--color-text-primary)]'
                    }`}
                  >
                    {opt}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setShowTier2((v) => !v)}
                  aria-expanded={showTier2}
                  className="block w-full px-3 py-2 text-left text-[12px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                >
                  {showTier2 ? 'Fewer standards' : 'More standards'}
                </button>
              </li>
            </ul>,
            document.body
          )
        : null}
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
