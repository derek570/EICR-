'use client';

import * as React from 'react';
import { isCircuitTokenField } from './circuit-focus-fields';

/**
 * CircuitKeyboardAccessory — WS7 circuit-cell keyboard accessory bar.
 *
 * A fixed toolbar pinned just above the on-screen keyboard giving the
 * hands-on inspector the iOS `LIM / N/A / prev / next / Done` affordances
 * while a circuit cell is focused (JobDetailView.swift toolbar
 * :1070-1098). It exists in three places — the circuits card view, the
 * sticky table, and the desktop schedule — all wired through the shared
 * `useCircuitAccessoryController` hook so traversal order + token rules
 * stay identical. See `circuit-focus-fields.ts` for the canonical order.
 *
 * Key behaviours (mirrored from the plan / iOS):
 *   - Positioned from `window.visualViewport`: the bar renders ONLY while
 *     a registered circuit input is focused AND the soft keyboard has
 *     actually shrunk the viewport (`keyboardInset > 32`). On a physical-
 *     keyboard desktop (inset 0) it stays hidden even though an input is
 *     focused. When `visualViewport` is unavailable it falls back to
 *     `env(safe-area-inset-bottom)` positioning but only on coarse-pointer
 *     (touch) contexts.
 *   - LIM / N/A appear ONLY for token-eligible fields
 *     (`CIRCUIT_ACCESSORY_TOKEN_FIELDS` — never on ref/designation, never
 *     on web-extra keyboard fields). prev/next always show; they wrap
 *     across circuits and are disabled only at the very first / very last
 *     field of the whole grid.
 *   - Toolbar taps must survive the input blur they'd otherwise cause on
 *     mobile: LIM/N/A/prev/next use `onPointerDown`+`preventDefault` so
 *     the focused input never blurs before the action runs. Done is the
 *     exception — it explicitly blurs/clears focus.
 */

// Token strings written into the cell. LIM mirrors the WS3 IR sentinel
// ('LIM', word-boundaried) the circuits grid already parses; N/A is the
// iOS not-applicable token. Both go through the surface's normal
// edit/save path (onPatch), exactly like a typed value.
export const CIRCUIT_TOKEN_LIM = 'LIM';
export const CIRCUIT_TOKEN_NA = 'N/A';

export interface FocusedCircuitCell {
  circuitId: string;
  fieldKey: string;
}

/**
 * Pure prev/next resolver over the flattened (circuit × field) target
 * grid. Returns the neighbouring cell in `dir` (+1 next / -1 prev), or
 * `null` at the very first (prev) / very last (next) cell — i.e. the
 * arrows are disabled only at the grid edges, and otherwise WRAP across
 * circuits at the field-list boundary. Exported for unit tests.
 */
export function computeNavTarget(
  circuitIds: readonly string[],
  fieldOrder: readonly string[],
  current: FocusedCircuitCell | null,
  dir: 1 | -1
): FocusedCircuitCell | null {
  if (!current || circuitIds.length === 0 || fieldOrder.length === 0) return null;
  const circuitIdx = circuitIds.indexOf(current.circuitId);
  const fieldIdx = fieldOrder.indexOf(current.fieldKey);
  if (circuitIdx < 0 || fieldIdx < 0) return null;
  const flatIndex = circuitIdx * fieldOrder.length + fieldIdx;
  const total = circuitIds.length * fieldOrder.length;
  const nextFlat = flatIndex + dir;
  if (nextFlat < 0 || nextFlat >= total) return null;
  const targetCircuit = circuitIds[Math.floor(nextFlat / fieldOrder.length)];
  const targetField = fieldOrder[nextFlat % fieldOrder.length];
  return { circuitId: targetCircuit, fieldKey: targetField };
}

/**
 * Track the soft-keyboard inset via `window.visualViewport`. Returns the
 * pixel height the keyboard is covering (0 when no keyboard / physical
 * keyboard) and whether a visualViewport was available at all.
 */
function useKeyboardInset(): { inset: number; hasVisualViewport: boolean } {
  const [inset, setInset] = React.useState(0);
  const [hasVisualViewport, setHasVisualViewport] = React.useState(false);

  React.useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) {
      setHasVisualViewport(false);
      return;
    }
    setHasVisualViewport(true);
    const measure = () => {
      const next = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(next);
    };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  return { inset, hasVisualViewport };
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    setCoarse(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    // addEventListener is the modern API; older Safari used addListener.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return coarse;
}

export interface CircuitAccessoryControllerOptions {
  /** Visible circuit ids in display order (card: all visible circuits, not
   *  just the expanded one; table/desktop: every row). */
  circuitIds: readonly string[];
  /** This surface's keyboard-input field keys, already ordered by the
   *  shared canonical order (`orderCircuitFocusFields`). */
  fieldOrder: readonly string[];
  /** Write a LIM / N/A token into a cell via the surface's save path. */
  applyToken: (circuitId: string, fieldKey: string, token: string) => void;
  /** Focus a target cell — the surface expands/scrolls as needed then
   *  focuses the input (card view auto-expands the collapsed circuit). */
  focusField: (circuitId: string, fieldKey: string) => void;
}

export interface CircuitAccessoryController {
  /** Spread onto each registered circuit input. */
  inputHandlers: (
    circuitId: string,
    fieldKey: string
  ) => { onFocus: () => void; onBlur: () => void };
  /** The rendered accessory bar (or null when hidden). Place once per surface. */
  accessory: React.ReactElement | null;
  /** Currently-focused cell, or null. */
  focused: FocusedCircuitCell | null;
}

/**
 * Shared controller wiring the accessory bar to a circuit surface. Owns
 * the focused-cell state, keyboard-inset visibility, blur-survival
 * deferral, and prev/next/token/Done actions.
 */
export function useCircuitAccessoryController(
  opts: CircuitAccessoryControllerOptions
): CircuitAccessoryController {
  const { circuitIds, fieldOrder, applyToken, focusField } = opts;
  const [focused, setFocused] = React.useState<FocusedCircuitCell | null>(null);
  const { inset, hasVisualViewport } = useKeyboardInset();
  const coarsePointer = useCoarsePointer();
  const blurTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingBlur = React.useCallback(() => {
    if (blurTimer.current != null) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }, []);

  const onInputFocus = React.useCallback(
    (circuitId: string, fieldKey: string) => {
      cancelPendingBlur();
      setFocused({ circuitId, fieldKey });
    },
    [cancelPendingBlur]
  );

  const onInputBlur = React.useCallback(() => {
    // Defer the hide so moving focus between inputs (blur→focus) or a
    // toolbar tap that momentarily blurs doesn't flash the bar away. A
    // subsequent onInputFocus cancels this.
    cancelPendingBlur();
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null;
      setFocused(null);
    }, 0);
  }, [cancelPendingBlur]);

  React.useEffect(() => cancelPendingBlur, [cancelPendingBlur]);

  const inputHandlers = React.useCallback(
    (circuitId: string, fieldKey: string) => ({
      onFocus: () => onInputFocus(circuitId, fieldKey),
      onBlur: () => onInputBlur(),
    }),
    [onInputFocus, onInputBlur]
  );

  const prevTarget = computeNavTarget(circuitIds, fieldOrder, focused, -1);
  const nextTarget = computeNavTarget(circuitIds, fieldOrder, focused, 1);

  const navigate = React.useCallback(
    (target: FocusedCircuitCell | null) => {
      if (!target) return;
      cancelPendingBlur();
      // Optimistically set focus state so the bar keeps rendering during
      // any expand→rAF gap in the surface's focusField.
      setFocused(target);
      focusField(target.circuitId, target.fieldKey);
    },
    [cancelPendingBlur, focusField]
  );

  const handleLim = React.useCallback(() => {
    if (focused) applyToken(focused.circuitId, focused.fieldKey, CIRCUIT_TOKEN_LIM);
  }, [focused, applyToken]);

  const handleNa = React.useCallback(() => {
    if (focused) applyToken(focused.circuitId, focused.fieldKey, CIRCUIT_TOKEN_NA);
  }, [focused, applyToken]);

  const handleDone = React.useCallback(() => {
    cancelPendingBlur();
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active instanceof HTMLElement) active.blur();
    setFocused(null);
  }, [cancelPendingBlur]);

  // Visibility rule. With a visualViewport, require the keyboard to have
  // shrunk the viewport (inset > 32) so a physical-keyboard desktop with a
  // focused input does NOT show the bar. Without visualViewport, fall back
  // to coarse-pointer (touch) only.
  const KEYBOARD_INSET_THRESHOLD = 32;
  const visible =
    focused != null && (hasVisualViewport ? inset > KEYBOARD_INSET_THRESHOLD : coarsePointer);

  const showTokens = focused != null && isCircuitTokenField(focused.fieldKey);

  const accessory = visible ? (
    <CircuitKeyboardAccessory
      bottomOffset={hasVisualViewport ? inset : null}
      showTokens={showTokens}
      canPrev={prevTarget != null}
      canNext={nextTarget != null}
      onLim={handleLim}
      onNa={handleNa}
      onPrev={() => navigate(prevTarget)}
      onNext={() => navigate(nextTarget)}
      onDone={handleDone}
    />
  ) : null;

  return { inputHandlers, accessory, focused };
}

interface CircuitKeyboardAccessoryProps {
  /** Pixel inset from the bottom (visualViewport keyboard height), or null
   *  to use the `env(safe-area-inset-bottom)` fallback. */
  bottomOffset: number | null;
  showTokens: boolean;
  canPrev: boolean;
  canNext: boolean;
  onLim: () => void;
  onNa: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
}

/** Presentational toolbar. Exported for direct testing of the token rules. */
export function CircuitKeyboardAccessory({
  bottomOffset,
  showTokens,
  canPrev,
  canNext,
  onLim,
  onNa,
  onPrev,
  onNext,
  onDone,
}: CircuitKeyboardAccessoryProps) {
  // preventDefault on pointer/mouse-down keeps the focused input from
  // blurring before the button's click handler runs (mobile browsers blur
  // on the button's mousedown otherwise) — this is what makes LIM/N/A/
  // prev/next survive on touch.
  const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return (
    <div
      data-testid="circuit-keyboard-accessory"
      role="toolbar"
      aria-label="Circuit cell actions"
      className="fixed inset-x-0 z-50 flex items-center gap-1 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-1.5 shadow-[0_-2px_10px_rgba(0,0,0,0.25)]"
      style={{
        bottom: bottomOffset != null ? bottomOffset : 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {showTokens ? (
        <>
          <button
            type="button"
            data-testid="accessory-lim"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={onLim}
            className="rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-1)]"
          >
            LIM
          </button>
          <button
            type="button"
            data-testid="accessory-na"
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={onNa}
            className="rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-1)]"
          >
            N/A
          </button>
        </>
      ) : null}
      <div className="flex-1" />
      <button
        type="button"
        data-testid="accessory-prev"
        aria-label="Previous field"
        disabled={!canPrev}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={onPrev}
        className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[15px] font-semibold text-[var(--color-brand-blue)] transition disabled:opacity-30"
      >
        ‹
      </button>
      <button
        type="button"
        data-testid="accessory-next"
        aria-label="Next field"
        disabled={!canNext}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={onNext}
        className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[15px] font-semibold text-[var(--color-brand-blue)] transition disabled:opacity-30"
      >
        ›
      </button>
      <button
        type="button"
        data-testid="accessory-done"
        onClick={onDone}
        className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-brand-blue)] transition"
      >
        Done
      </button>
    </div>
  );
}
