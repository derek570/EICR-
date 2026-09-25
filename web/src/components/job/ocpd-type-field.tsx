'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import {
  OCPD_TYPE_INPUT_CAP,
  OCPD_TYPE_SUGGESTIONS,
  canonicaliseOcpdType,
  ocpdTypeAdvisoryText,
  ocpdTypeDisplay,
} from '@certmate/shared-utils';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { cn } from '@/lib/utils';

/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — the ONE OCPD-type editing
 * control, the type-field sibling of PLAN-CC's `OcpdStandardField`.
 *
 * `ocpd_type` is free text with suggestions: a BS 3871 Type 2, a BS 1361 Type
 * II or a 60947-2 K curve must be recordable, and an EICR records what the
 * inspector sees. All three web surfaces (the mobile card, the sticky table,
 * the desktop schedule) use these components, so they share one commit
 * contract:
 *
 *   1. The 24-character cap lives HERE and nowhere else. A 25th character is
 *      REFUSED, never truncated (truncating stores a different value), and the
 *      check is in `onChange`, not `maxLength`, which truncates a paste.
 *   2. Canonicalisation runs on COMMIT (`canonicaliseOcpdType`: punctuation,
 *      joins, number words, Roman forms, upper-casing), never per keystroke.
 *      Any non-blank value is stored; an off-list one wears the advisory
 *      marker. A blank commit clears.
 *   3. The BS 1361 display alias: a stored `1` / `2` shows `I` / `II`. The
 *      alias is display only — a commit whose text still equals what was
 *      displayed is NOT a change, so focusing and leaving the cell never
 *      writes `II` over a stored `2`.
 */
function useOcpdTypeDraft(value: string, standard: string, onCommit: (next: string) => void) {
  const displayed = ocpdTypeDisplay(standard, value);
  const [draft, setDraft] = React.useState(displayed);

  React.useEffect(() => {
    setDraft(displayed);
  }, [displayed]);

  const commit = React.useCallback(
    (raw: string) => {
      if (raw === displayed) {
        setDraft(displayed);
        return;
      }
      const next = raw.trim() === '' ? '' : (canonicaliseOcpdType(raw) ?? '');
      setDraft(ocpdTypeDisplay(standard, next));
      if (next !== value) onCommit(next);
    },
    [displayed, onCommit, standard, value]
  );

  const onChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // Refuse, do not truncate. `length` is UTF-16 units, as on iOS.
    if (next.length > OCPD_TYPE_INPUT_CAP) return;
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

  return { draft, displayed, commit, onChange, onBlur, onKeyDown };
}

/** Pressing a suggestion must not blur the input first: the blur would commit
 *  the half-typed text before the choice (PLAN-CC round 9, same mechanism). */
const keepFocusOnPress = (e: React.MouseEvent) => e.preventDefault();

/**
 * The advisory marker beside the type cell. Never blocks a save and is never
 * spoken; the text is the same phrase the spoken advisory and the PDF
 * preflight are built from.
 */
export function OcpdTypeMarker({ standard, type }: { standard: string; type: string }) {
  const text = ocpdTypeAdvisoryText({ ocpdBsEn: standard, ocpdType: type });
  if (!text) return null;
  return (
    <span
      role="img"
      aria-label={`OCPD type: ${text}`}
      title={text}
      data-testid="ocpd-type-marker"
      className="flex-shrink-0 text-[var(--color-amber, #f5a524)]"
    >
      ⚠
    </span>
  );
}

/** Card form: the input, the suggestion chips and the marker. */
export function OcpdTypeField({
  label = 'Type',
  value,
  standard,
  onCommit,
  inputRef,
  onFocus,
  onBlur,
}: {
  label?: string;
  value: string;
  standard: string;
  onCommit: (next: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
}) {
  const field = useOcpdTypeDraft(value, standard, onCommit);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-1">
        <OcpdTypeMarker standard={standard} type={value} />
        <div className="min-w-0 flex-1">
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
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {/* Suggestions are listed RAW: aliasing them under BS 1361 would show
            `I` and `II` twice. The alias applies to the stored value only. */}
        {OCPD_TYPE_SUGGESTIONS.map((option) => {
          return (
            <button
              key={option}
              type="button"
              onMouseDown={keepFocusOnPress}
              onClick={() => field.commit(option)}
              aria-pressed={option === value}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition',
                option === value
                  ? 'border-transparent bg-[var(--color-brand-blue)] text-white'
                  : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Below this the list prefers to flip above the cell (PLAN-CC's rule). */
const MIN_LIST_HEIGHT = 120;

/** Grid form: a free-text input with the suggestions behind a chevron, the
 *  list portalled so a scrolling table cannot clip it (PLAN-CC's lesson). */
export function OcpdTypeComboCell({
  value,
  standard,
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
  standard: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  font?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onAccessoryBlur?: () => void;
}) {
  const field = useOcpdTypeDraft(value, standard, onCommit);
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
      const GAP = 4;
      const below = window.innerHeight - box.bottom - GAP;
      const above = box.top - GAP;
      const flip = below < MIN_LIST_HEIGHT && above > below;
      const maxHeight = Math.min(256, Math.max(0, flip ? above : below));
      setAnchor({
        left: box.left,
        top: flip ? box.top - GAP - maxHeight : box.bottom + GAP,
        width: box.width,
        maxHeight,
      });
    };
    measure();
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
        <OcpdTypeMarker standard={standard} type={value} />
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
          onMouseDown={keepFocusOnPress}
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
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: anchor.left,
                top: anchor.top,
                minWidth: Math.max(anchor.width, 120),
                maxHeight: anchor.maxHeight,
              }}
              className="cm-popover-in z-50 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
            >
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onMouseDown={keepFocusOnPress}
                  onClick={() => {
                    field.commit('');
                    onClose();
                  }}
                  className="block w-full px-3 py-2 text-left text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)]"
                >
                  — Clear —
                </button>
              </li>
              {OCPD_TYPE_SUGGESTIONS.map((opt) => (
                <li key={opt}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === opt}
                    onMouseDown={keepFocusOnPress}
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
            </ul>,
            document.body
          )
        : null}
    </div>
  );
}
