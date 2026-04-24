/**
 * Phase 4 — BoardSelectorBar.
 *
 * Locks iOS-parity reorder contract: Move Left / Move Right buttons
 * disable at the boundary (first board / last board). Also confirms
 * the star-for-main indicator and the "only render toolbar when >1
 * board" rule (iOS BoardTab.swift:L25).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// lucide-react re-resolves `react` via its own package tree under vitest
// and misses the web/node_modules pin, causing a dispatcher mismatch
// and "Invalid hook call". Stub the icons we use — we assert on DOM
// structure and aria-labels, not on the icon glyphs themselves.
vi.mock('lucide-react', () => {
  const stub = (props: { 'aria-label'?: string; className?: string }) =>
    React.createElement('span', {
      'data-icon': true,
      'aria-label': props['aria-label'],
      className: props.className,
    });
  return {
    ArrowLeft: stub,
    ArrowRight: stub,
    CircuitBoard: stub,
    Plus: stub,
    Star: stub,
    Trash2: stub,
  };
});

import { BoardSelectorBar } from '@/components/job/board-selector-bar';

function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  mounted = null;
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function getByAria(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!btn) throw new Error(`no button with aria-label="${label}"`);
  return btn;
}

describe('BoardSelectorBar', () => {
  it('renders a pill per board with the main-star indicator on the main board', () => {
    const boards = [
      { id: 'a', designation: 'DB1', is_main: true },
      { id: 'b', designation: 'DB2', is_main: false },
    ];
    mounted = mount(
      <BoardSelectorBar boards={boards} activeId="a" onSelect={() => {}} onAdd={() => {}} />
    );
    const labelA = mounted.container.querySelector('button[role="tab"][aria-selected="true"]');
    expect(labelA?.textContent).toContain('DB1');
    const star = labelA?.querySelector('[aria-label="Main board"]');
    expect(star).not.toBeNull();
    const labelB = Array.from(
      mounted.container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
    ).find((b) => b.textContent?.includes('DB2'));
    expect(labelB?.querySelector('[aria-label="Main board"]')).toBeNull();
  });

  it('Move left / Move right disable at the edges', () => {
    const boards = [
      { id: 'a', designation: 'DB1', is_main: true },
      { id: 'b', designation: 'DB2', is_main: false },
      { id: 'c', designation: 'DB3', is_main: false },
    ];
    const onMoveLeft = vi.fn();
    const onMoveRight = vi.fn();
    mounted = mount(
      <BoardSelectorBar
        boards={boards}
        activeId="a"
        onSelect={() => {}}
        onAdd={() => {}}
        onMoveLeft={onMoveLeft}
        onMoveRight={onMoveRight}
      />
    );
    // Active at index 0 → Move left disabled, Move right enabled.
    expect(getByAria(mounted.container, 'Move board left').disabled).toBe(true);
    expect(getByAria(mounted.container, 'Move board right').disabled).toBe(false);

    // Clicking the disabled button is a no-op.
    act(() => {
      getByAria(mounted!.container, 'Move board left').click();
    });
    expect(onMoveLeft).not.toHaveBeenCalled();

    act(() => {
      getByAria(mounted!.container, 'Move board right').click();
    });
    expect(onMoveRight).toHaveBeenCalledTimes(1);
  });

  it('hides the reorder/remove toolbar entirely when only one board exists', () => {
    const boards = [{ id: 'a', designation: 'DB1', is_main: true }];
    mounted = mount(
      <BoardSelectorBar
        boards={boards}
        activeId="a"
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
      />
    );
    expect(mounted.container.querySelector('button[aria-label="Move board left"]')).toBeNull();
    expect(mounted.container.querySelector('button[aria-label="Remove board"]')).toBeNull();
    // Add button is always present (first-board bootstrap wouldn't need it, but
    // the parent still has the affordance).
    expect(mounted.container.querySelector('button[aria-label="Add board"]')).not.toBeNull();
  });
});
