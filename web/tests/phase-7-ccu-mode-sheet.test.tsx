/**
 * Phase 7 — CCU mode sheet render + interaction tests.
 *
 * Pins the three-mode contract at the UI layer:
 *   - all three modes render when the sheet is open,
 *   - picking a mode fires `onSelect` with the correct value,
 *   - picking a mode closes the sheet,
 *   - last-used mode persists to localStorage (`cm-ccu-last-mode`),
 *   - the "hardware_update" tile's hint copy reflects the existing
 *     circuit count on the active board (helps first-time users pick
 *     the right mode).
 *
 * We mount with `createRoot` directly (not `@testing-library/react`)
 * and stub Radix `<Dialog>` + `lucide-react` at module boundary to
 * avoid the root-vs-web React instance hazard documented in
 * `web/vitest.config.ts`. Mirrors the pattern used by
 * `phase-6-change-password.test.tsx` + `phase-6-clear-cache.test.tsx`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    Camera: makeIcon('Camera'),
    ChevronRight: makeIcon('ChevronRight'),
    ListChecks: makeIcon('ListChecks'),
    RefreshCw: makeIcon('RefreshCw'),
    X: makeIcon('X'),
  };
});

// Stub the Dialog primitive to avoid Radix's cross-copy React lookup.
// The real thing is exercised in integration tests via playwright.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-mock="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog" data-mock="dialog-content">
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-mock="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-mock="dialog-description">{children}</p>
  ),
}));

import { CcuModeSheet } from '@/components/job/ccu-mode-sheet';
import type { CcuApplyMode } from '@/lib/recording/apply-ccu-analysis';

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
  try {
    window.localStorage.removeItem('cm-ccu-last-mode');
  } catch {
    /* ignore */
  }
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

describe('CcuModeSheet', () => {
  it('renders all three mode tiles when open', () => {
    const onSelect = vi.fn();
    mounted = mount(
      <CcuModeSheet open onOpenChange={() => {}} onSelect={onSelect} existingCircuitCount={0} />
    );
    const tiles = mounted.container.querySelectorAll('[role="listitem"]');
    expect(tiles).toHaveLength(3);
    const titles = Array.from(tiles).map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('Circuit Names Only'))).toBe(true);
    expect(titles.some((t) => t?.includes('Update Hardware'))).toBe(true);
    expect(titles.some((t) => t?.includes('Full New Consumer Unit'))).toBe(true);
  });

  it('does not render anything when closed', () => {
    mounted = mount(<CcuModeSheet open={false} onOpenChange={() => {}} onSelect={() => {}} />);
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('fires onSelect with the correct mode when a tile is clicked', async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    mounted = mount(
      <CcuModeSheet open onOpenChange={onOpenChange} onSelect={onSelect} existingCircuitCount={4} />
    );
    const tiles = Array.from(mounted.container.querySelectorAll('[role="listitem"]'));
    const fullCapture = tiles.find((t) => t.textContent?.includes('Full New Consumer Unit'));
    expect(fullCapture).toBeTruthy();

    await act(async () => {
      (fullCapture as HTMLElement).click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // onSelect runs in a setTimeout(0) to sequence after the sheet close.
    await new Promise((r) => setTimeout(r, 10));
    expect(onSelect).toHaveBeenCalledWith('full_capture' satisfies CcuApplyMode);
  });

  it('persists the chosen mode to localStorage', async () => {
    const onSelect = vi.fn();
    mounted = mount(
      <CcuModeSheet open onOpenChange={() => {}} onSelect={onSelect} existingCircuitCount={2} />
    );
    const tiles = Array.from(mounted.container.querySelectorAll('[role="listitem"]'));
    const namesOnly = tiles.find((t) => t.textContent?.includes('Circuit Names Only'))!;
    await act(async () => {
      (namesOnly as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(window.localStorage.getItem('cm-ccu-last-mode')).toBe('names_only');
  });

  it('shows a tailored hint on hardware_update when the board has existing circuits', () => {
    mounted = mount(
      <CcuModeSheet open onOpenChange={() => {}} onSelect={() => {}} existingCircuitCount={5} />
    );
    const hwTile = Array.from(mounted.container.querySelectorAll('[role="listitem"]')).find((t) =>
      t.textContent?.includes('Update Hardware')
    )!;
    expect(hwTile.textContent).toContain('5 existing circuits');
  });

  it('suggests Full Capture when the board is empty', () => {
    mounted = mount(
      <CcuModeSheet open onOpenChange={() => {}} onSelect={() => {}} existingCircuitCount={0} />
    );
    const hwTile = Array.from(mounted.container.querySelectorAll('[role="listitem"]')).find((t) =>
      t.textContent?.includes('Update Hardware')
    )!;
    expect(hwTile.textContent).toContain('No existing circuits');
  });
});
