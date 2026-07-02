/**
 * WS6 — Board tab off-peak support (`board_type='off_peak'`).
 *
 * iOS canon:
 *   - `BoardType.offPeak` ("Off-Peak Board", BoardInfo.swift:15) is a
 *     first-class option in the Board type picker.
 *   - Off-peak is a SIBLING of main, fed straight from the supply mains:
 *     BoardTab's `isSubBoard` gate (BoardTab.swift:232) excludes
 *     `.offPeak`, hiding BOTH the "Fed from" parent picker AND the
 *     Sub-Main Cable section — the plain "Supplied from" text input
 *     renders instead.
 *   - Switching a board's type to main OR off_peak clears
 *     `parent_board_id` (boardTypeBinding, BoardTab.swift:411-425).
 *
 * Mounted with `createRoot` + module-boundary stubs for lucide-react
 * and the Radix dialog — same pattern/rationale as
 * `phase-7-ccu-mode-sheet.test.tsx` (root-vs-web React instance hazard).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// The board page + its child components import a dozen-plus lucide
// icons (directly and transitively). A Proxy stub resolves ANY icon
// name so the mock doesn't need maintenance when icons change.
vi.mock('lucide-react', () => {
  const stub = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    (props, ref) => <span ref={ref} data-icon {...props} />
  );
  stub.displayName = 'LucideStub';
  return new Proxy(
    {},
    {
      // vitest validates exports with an `in` check before `get`, so
      // the Proxy needs BOTH traps to satisfy arbitrary icon names.
      has: () => true,
      get: (_target, prop) => (prop === '__esModule' ? true : stub),
    }
  );
});

// ConfirmDialog pulls the Radix dialog primitive — stub it closed-safe.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-mock="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import BoardPage from '@/app/job/[id]/board/page';
import { JobProvider } from '@/lib/job-context';
import type { JobDetail } from '@/lib/types';

function makeJob(boards: Array<Record<string, unknown>>): JobDetail {
  return {
    id: 'job-1',
    user_id: 'u1',
    certificate_type: 'EICR',
    folder_name: 'job-1',
    boards,
    circuits: [],
    observations: [],
  } as unknown as JobDetail;
}

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

function textOf(el: Element | null): string {
  return el?.textContent ?? '';
}

describe('Board tab — off_peak board_type (WS6)', () => {
  it('offers "Off-Peak Board" in the Board type picker', () => {
    const job = makeJob([{ id: 'b1', designation: 'DB1', board_type: 'main' }]);
    mounted = mount(
      <JobProvider initial={job}>
        <BoardPage />
      </JobProvider>
    );
    // Open the Board type dropdown (first listbox trigger inside the
    // Identity card — its label text is "Board type").
    const trigger = Array.from(
      mounted.container.querySelectorAll('button[aria-haspopup="listbox"]')
    ).find((b) => textOf(b).includes('Board type'))!;
    expect(trigger).toBeTruthy();
    act(() => {
      (trigger as HTMLElement).click();
    });
    const options = Array.from(mounted.container.querySelectorAll('[role="option"]')).map((o) =>
      textOf(o).trim()
    );
    expect(options).toContain('Off-Peak Board');
  });

  it('renders an off_peak board WITHOUT the Fed-from picker or Sub-main cable section (sibling of main, not a sub-board)', () => {
    const job = makeJob([
      { id: 'b1', designation: 'DB1', board_type: 'main' },
      { id: 'b2', designation: 'Off-Peak Board', board_type: 'off_peak' },
    ]);
    mounted = mount(
      <JobProvider initial={job}>
        <BoardPage />
      </JobProvider>
    );
    // Switch the selector to the off-peak board.
    const pill = Array.from(mounted.container.querySelectorAll('button')).find((b) =>
      textOf(b).includes('Off-Peak Board')
    )!;
    expect(pill).toBeTruthy();
    act(() => {
      pill.click();
    });

    const bodyText = mounted.container.textContent ?? '';
    // No parent-board UI: neither the Fed-from picker nor the sub-main
    // cable card exist for off-peak (iOS isSubBoard gate).
    expect(bodyText).not.toContain('Fed from');
    expect(bodyText).not.toContain('Sub-main cable');
    // The plain Supplied-from text input renders instead.
    expect(bodyText).toContain('Supplied from');
  });

  it('clears parent_board_id + supplied_from when a sub-board is re-typed as off_peak', () => {
    const job = makeJob([
      { id: 'b1', designation: 'DB1', board_type: 'main' },
      {
        id: 'b2',
        designation: 'DB2',
        board_type: 'sub_main',
        parent_board_id: 'b1',
        supplied_from: 'DB1',
      },
    ]);
    mounted = mount(
      <JobProvider initial={job}>
        <BoardPage />
      </JobProvider>
    );
    // Activate the sub-board.
    const pill = Array.from(mounted.container.querySelectorAll('button')).find(
      (b) => textOf(b).trim() === 'DB2'
    )!;
    act(() => {
      pill.click();
    });
    // Sanity: sub-board shows the Fed-from picker.
    expect(mounted.container.textContent).toContain('Fed from');

    // Re-type as Off-Peak via the Board type dropdown.
    const trigger = Array.from(
      mounted.container.querySelectorAll('button[aria-haspopup="listbox"]')
    ).find((b) => textOf(b).includes('Board type'))!;
    act(() => {
      (trigger as HTMLElement).click();
    });
    const offPeakOption = Array.from(mounted.container.querySelectorAll('[role="option"]')).find(
      (o) => textOf(o).trim() === 'Off-Peak Board'
    )!;
    expect(offPeakOption).toBeTruthy();
    act(() => {
      (offPeakOption as HTMLElement).click();
    });

    // Fed-from picker gone; Supplied-from input back and CLEARED (the
    // stale parent reference must not survive the type flip — iOS
    // boardTypeBinding parity).
    const bodyText = mounted.container.textContent ?? '';
    expect(bodyText).not.toContain('Fed from');
    const suppliedInput = Array.from(mounted.container.querySelectorAll('input')).find((i) =>
      textOf(i.closest('label') ?? i.parentElement).includes('Supplied from')
    ) as HTMLInputElement | undefined;
    // FloatingLabelInput structure varies; fall back to checking no
    // input still carries the stale parent designation value.
    const inputs = Array.from(mounted.container.querySelectorAll('input'));
    const staleValue = inputs.some((i) => (i as HTMLInputElement).value === 'DB1');
    expect(suppliedInput?.value ?? '').not.toBe('DB1');
    expect(staleValue).toBe(false);
  });
});
