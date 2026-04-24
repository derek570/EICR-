'use client';

import * as React from 'react';
import { ArrowLeft, ArrowRight, CircuitBoard, Plus, Star, Trash2 } from 'lucide-react';

/**
 * Horizontal board selector + toolbar — mirrors iOS `BoardTab.swift`
 * `boardSelectorBar` (L71-L118) and the secondary-action toolbar
 * (L20-L48). One scrollable pill rail of board designations, with
 * Add / Move Left / Move Right / Remove actions along the trailing
 * edge. A filled star precedes the pill for the main board.
 *
 * Props
 *   - `boards` — ordered list; pill index == order index.
 *   - `activeId` — currently selected board id. The component is
 *     purely presentational — state lives in the parent.
 *   - `onSelect` — fired when the user taps a pill.
 *   - `onAdd` — fired by the inline + pill + the toolbar Add button.
 *   - `onMoveLeft` / `onMoveRight` — reorder the active board. The
 *     component disables the buttons at the edges so parents don't
 *     have to guard.
 *   - `onRemove` — fired when the inspector taps the trash. Parent
 *     is expected to wrap in a ConfirmDialog; we don't confirm here
 *     so the primitive stays testable without Radix.
 */
export interface BoardSelectorBoard {
  id: string;
  designation?: string;
  is_main?: boolean;
}

export interface BoardSelectorBarProps {
  boards: BoardSelectorBoard[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onRemove?: () => void;
}

export function BoardSelectorBar({
  boards,
  activeId,
  onSelect,
  onAdd,
  onMoveLeft,
  onMoveRight,
  onRemove,
}: BoardSelectorBarProps) {
  const activeIndex = boards.findIndex((b) => b.id === activeId);
  const canMoveLeft = activeIndex > 0;
  const canMoveRight = activeIndex >= 0 && activeIndex < boards.length - 1;
  const canRemove = boards.length > 1;

  return (
    <div className="flex flex-col gap-2">
      {/* Scrollable pill rail — matches iOS's horizontal scroll view. */}
      <div
        className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1"
        role="tablist"
        aria-label="Boards"
      >
        {boards.map((b, idx) => {
          const isActive = b.id === activeId;
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(b.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                isActive
                  ? 'bg-[var(--color-brand-blue)] text-white shadow-sm'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {b.is_main ? (
                <Star
                  className="h-3 w-3"
                  fill="currentColor"
                  strokeWidth={0}
                  aria-label="Main board"
                />
              ) : (
                <CircuitBoard className="h-3.5 w-3.5" aria-hidden />
              )}
              <span>{b.designation || `DB-${idx + 1}`}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add board"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-brand-blue)] transition hover:bg-[var(--color-surface-2)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add
        </button>
      </div>

      {/* Toolbar — Move Left / Move Right / Remove. Only rendered
          when >1 board, matching iOS (BoardTab.swift:L25). */}
      {boards.length > 1 ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onMoveLeft}
            disabled={!canMoveLeft}
            aria-label="Move board left"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-default)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Move left
          </button>
          <button
            type="button"
            onClick={onMoveRight}
            disabled={!canMoveRight}
            aria-label="Move board right"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-default)] px-3 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move right
            <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
          <span aria-hidden className="flex-1" />
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label="Remove board"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-status-failed)]/40 px-3 py-1 text-[11px] font-semibold text-[var(--color-status-failed)] transition hover:bg-[var(--color-status-failed)]/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
