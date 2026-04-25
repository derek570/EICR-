/**
 * Dashboard JobRow swipe / context-menu delete — regression coverage.
 *
 * The feature shipped in commit `9fcbeed` (Phase 3 — dashboard expiring
 * count, swipe/context-menu delete, tour tile) but had zero test
 * coverage. The Wave-A audit incorrectly flagged this as a gap (Phase 2
 * P0 #4) because the audit ran against `stage6-agentic-extraction`,
 * which had regressed it. Verifying-on-main shows the iOS parity is
 * fully there; this file locks the four behavioural branches so a
 * future stage6-style refactor can't silently regress them again.
 *
 * Branches under test:
 *   1. Touch swipe past the threshold reveals the trailing Delete
 *      action and locks it open. Mirrors iOS
 *      `swipeActions(edge: .trailing, allowsFullSwipe: false)`.
 *   2. Click the trailing Delete button opens the ConfirmDialog. The
 *      destructive copy goes through the design-token confirm pattern
 *      (matched at the dialog stub, asserted via the `confirmLabel`
 *      and `title` props).
 *   3. Right-click on a pointer-fine device opens the desktop context
 *      menu with a single Delete entry. Mirrors iOS long-press
 *      fallback to a system menu.
 *   4. Confirming the dialog calls `api.deleteJob(user.id, job.id)`
 *      and then `onDeleted(job.id)` so the parent dashboard list can
 *      drop the row without a full refetch.
 *
 * Mount strategy mirrors `pdf-tab.test.tsx` — inline `createRoot`,
 * lucide / ConfirmDialog stubbed at module boundaries.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// next/link's internal React import resolves to the monorepo-root
// react copy not web's pinned 19.2.4 (the dual-copy hazard documented
// in vitest.config.ts). Stub it to a plain anchor so the test mounts.
vi.mock('next/link', () => ({
  __esModule: true,
  default: React.forwardRef<
    HTMLAnchorElement,
    React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
  >(function MockLink({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  }),
}));

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    ChevronRight: makeIcon('ChevronRight'),
    CloudUpload: makeIcon('CloudUpload'),
    FileText: makeIcon('FileText'),
    Trash2: makeIcon('Trash2'),
  };
});

const lastConfirmProps = vi.fn<(props: Record<string, unknown>) => void>();
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: {
    open: boolean;
    onOpenChange?: (v: boolean) => void;
    onConfirm?: () => void | Promise<void>;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }) => {
    lastConfirmProps(props);
    if (!props.open) return null;
    return (
      <div role="dialog" data-testid="confirm">
        <p>{props.title}</p>
        <button type="button" onClick={() => props.onOpenChange?.(false)}>
          {props.cancelLabel ?? 'Cancel'}
        </button>
        <button type="button" onClick={() => void props.onConfirm?.()}>
          {props.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    );
  },
}));

const deleteJobMock = vi.fn<(userId: string, jobId: string) => Promise<{ success: true }>>();
vi.mock('@/lib/api-client', () => ({
  api: {
    deleteJob: (userId: string, jobId: string) => deleteJobMock(userId, jobId),
  },
}));

vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-7', email: 't@e.st', role: 'inspector' }),
}));

import { JobRow } from '@/components/dashboard/job-row';

const sampleJob = {
  id: 'job-42',
  address: '1 Test Road',
  status: 'done' as const,
  certificate_type: 'EICR' as const,
  created_at: '2026-04-25T10:00:00.000Z',
  updated_at: '2026-04-25T10:00:00.000Z',
};

function mount(props?: Partial<React.ComponentProps<typeof JobRow>>): {
  container: HTMLDivElement;
  root: Root;
  onDeleted: (jobId: string) => void;
} {
  const onDeleted = vi.fn<(jobId: string) => void>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<JobRow job={sampleJob} onDeleted={onDeleted} {...props} />);
  });
  return { container, root, onDeleted };
}

let harness: { container: HTMLDivElement; root: Root; onDeleted: ReturnType<typeof vi.fn> } | null =
  null;

beforeEach(() => {
  deleteJobMock.mockReset();
  lastConfirmProps.mockReset();
  // matchMedia for the right-click pointer-fine branch.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('pointer: fine'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
});

describe('Dashboard · JobRow swipe-delete + context-menu', () => {
  it('reveals the trailing Delete action when a touch swipe passes the threshold', async () => {
    harness = mount();
    const wrapper = harness.container.firstChild as HTMLElement;
    expect(wrapper).not.toBeNull();

    // Pointer events synthesised by hand because jsdom's PointerEvent
    // constructor lacks the `pointerType` field React reads.
    const fire = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(evt, { pointerType: 'touch', clientX: x, clientY: y });
      act(() => {
        wrapper.dispatchEvent(evt);
      });
    };

    fire('pointerdown', 200, 100);
    fire('pointermove', 130, 102); // dx -70 (over threshold), dy +2
    fire('pointerup', 130, 102);

    // After release past threshold the row locks open (-96px translate).
    const link = harness.container.querySelector('a[href="/job/job-42"]') as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.style.transform).toContain('-96px');

    // Trailing Delete button is now reachable for click + tab.
    const deleteBtn = harness.container.querySelector(
      'button[aria-label*="Delete job for"]'
    ) as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.tabIndex).toBe(0);
    expect(deleteBtn.style.pointerEvents).toBe('auto');
  });

  it('opens the destructive ConfirmDialog when the trailing Delete is clicked', async () => {
    harness = mount();
    const wrapper = harness.container.firstChild as HTMLElement;
    const fire = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(evt, { pointerType: 'touch', clientX: x, clientY: y });
      act(() => {
        wrapper.dispatchEvent(evt);
      });
    };
    fire('pointerdown', 200, 100);
    fire('pointermove', 130, 102);
    fire('pointerup', 130, 102);

    const deleteBtn = harness.container.querySelector(
      'button[aria-label*="Delete job for"]'
    ) as HTMLButtonElement;
    await act(async () => {
      deleteBtn.click();
    });

    // Dialog mounted with destructive-copy props.
    const dialogProps = lastConfirmProps.mock.calls.at(-1)?.[0] as
      | { open?: boolean; title?: string; confirmLabel?: string; destructive?: boolean }
      | undefined;
    expect(dialogProps?.open).toBe(true);
    expect(dialogProps?.title).toBe('Delete job?');
    expect(dialogProps?.confirmLabel).toBe('Delete');
    expect(dialogProps?.destructive).toBe(true);
    expect(harness.container.querySelector('[data-testid="confirm"]')).not.toBeNull();
  });

  it('opens the desktop context menu on right-click and routes to the same ConfirmDialog', async () => {
    harness = mount();
    const wrapper = harness.container.firstChild as HTMLElement;
    const ctxEvt = new Event('contextmenu', { bubbles: true, cancelable: true });
    Object.assign(ctxEvt, { clientX: 50, clientY: 60 });
    act(() => {
      wrapper.dispatchEvent(ctxEvt);
    });

    const menu = harness.container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const menuDelete = menu!.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(menuDelete.textContent).toContain('Delete job');

    await act(async () => {
      menuDelete.click();
    });

    // Same ConfirmDialog instance flips open.
    const dialogProps = lastConfirmProps.mock.calls.at(-1)?.[0] as { open?: boolean } | undefined;
    expect(dialogProps?.open).toBe(true);
  });

  it('confirming the dialog calls api.deleteJob then onDeleted', async () => {
    deleteJobMock.mockResolvedValueOnce({ success: true });
    harness = mount();
    const wrapper = harness.container.firstChild as HTMLElement;
    const fire = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(evt, { pointerType: 'touch', clientX: x, clientY: y });
      act(() => {
        wrapper.dispatchEvent(evt);
      });
    };
    fire('pointerdown', 200, 100);
    fire('pointermove', 130, 102);
    fire('pointerup', 130, 102);
    const deleteBtn = harness.container.querySelector(
      'button[aria-label*="Delete job for"]'
    ) as HTMLButtonElement;
    await act(async () => {
      deleteBtn.click();
    });

    // Click "Delete" inside the dialog stub.
    const confirm = harness.container.querySelector('[data-testid="confirm"]') as HTMLElement;
    const confirmBtn = Array.from(confirm.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete'
    ) as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteJobMock).toHaveBeenCalledTimes(1);
    expect(deleteJobMock).toHaveBeenCalledWith('user-7', 'job-42');
    expect(harness.onDeleted).toHaveBeenCalledTimes(1);
    expect(harness.onDeleted).toHaveBeenCalledWith('job-42');
  });
});
