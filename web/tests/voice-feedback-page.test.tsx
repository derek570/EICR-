/**
 * Phase 1.6.5 — VoiceFeedback list page regression tests.
 *
 * NOTE on test location: PLAN-web-final.md §1.6.5 specifies the test
 * path as `web/src/app/voice-feedback/__tests__/page.test.tsx`. The
 * repo's `web/vitest.config.ts` only includes `tests/**\/*.test.{ts,tsx}`
 * (line 56 of that file) — a file under `src/app/.../__tests__/` would
 * silently be skipped by the runner. This file is therefore placed at
 * `web/tests/` following the existing convention (e.g.
 * `phase-3-alerts-page.test.tsx`), which is the location that actually
 * gets picked up.
 *
 * Asserts:
 *   1. List renders rows when `api.voiceFeedbackList` resolves with
 *      items, each row showing the issue preview + status pill.
 *   2. Tapping a status filter chip re-queries with the right `status`
 *      param.
 *   3. "Mark reviewed" optimistically flips the row to 'reviewed' and
 *      calls `api.voiceFeedbackPatch` with `{status:'reviewed'}`.
 *
 * Mount strategy mirrors `phase-3-alerts-page.test.tsx` — inline
 * createRoot + module-level mocks for lucide-react / next/link /
 * next/navigation so we dodge the React-dual-copy hazard and don't
 * need a real router.
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
    MessageSquareWarning: makeIcon('MessageSquareWarning'),
    ExternalLink: makeIcon('ExternalLink'),
    ChevronLeft: makeIcon('ChevronLeft'),
  };
});

vi.mock('next/link', () => ({
  // eslint-disable-next-line react/display-name
  default: React.forwardRef<
    HTMLAnchorElement,
    React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
  >(({ href, children, ...rest }, ref) => (
    <a ref={ref} href={href} {...rest}>
      {children}
    </a>
  )),
}));

// Stable singletons so the page's data-fetch effect doesn't re-fire
// on every render due to the router / current-user object identity
// changing. The page's effect dep array includes `router` and the
// (`isAdmin`-derived-from) `user`; fresh literals here would have us
// re-running the effect indefinitely.
const replaceMock = vi.fn();
const routerSingleton = { replace: replaceMock, push: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => routerSingleton,
}));

vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-7', email: 't@e.st', name: 'T' }),
  clearAuth: vi.fn(),
  getToken: () => 'test-token',
}));

const currentUserSingleton = {
  user: { id: 'user-7', email: 't@e.st', name: 'T', role: 'user' as const },
  loading: false,
  refresh: vi.fn(),
};
vi.mock('@/lib/use-current-user', () => ({
  useCurrentUser: () => currentUserSingleton,
}));

const { listMock, patchMock, adminAllMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  patchMock: vi.fn(),
  adminAllMock: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({
  api: {
    voiceFeedbackList: (...args: unknown[]) => listMock(...args),
    voiceFeedbackPatch: (...args: unknown[]) => patchMock(...args),
    voiceFeedbackAdminAll: (...args: unknown[]) => adminAllMock(...args),
  },
}));

// Import AFTER the mocks.
import VoiceFeedbackListPage from '@/app/voice-feedback/page';
import type { VoiceFeedbackListItem } from '@/lib/types';

function mkItem(id: string, status: VoiceFeedbackListItem['status']): VoiceFeedbackListItem {
  return {
    id,
    sessionId: `sess-${id}`,
    jobId: `job-${id}`,
    address: `Address ${id}`,
    issuePreview: `Preview for ${id}`,
    createdAt: '2026-06-04T14:18:00Z',
    status,
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<VoiceFeedbackListPage />);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  // Same shape as phase-3-alerts-page.test.tsx — let the page's
  // useEffect → promise resolution → setState propagate without
  // wrapping in act() (vitest 4 + React 19 deadlocks on
  // flushPassiveEffects under some mock shapes).
  await new Promise((r) => setTimeout(r, 60));
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  listMock.mockReset();
  patchMock.mockReset();
  adminAllMock.mockReset();
  replaceMock.mockReset();
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

describe('VoiceFeedbackListPage', () => {
  it('renders rows when voiceFeedbackList resolves with items', async () => {
    listMock.mockResolvedValue({
      items: [mkItem('a', 'open'), mkItem('b', 'reviewed')],
      total: 2,
    });

    harness = mount();
    await flush();

    const text = harness.container.textContent ?? '';
    expect(text).toContain('Voice feedback');
    expect(text).toContain('Preview for a');
    expect(text).toContain('Preview for b');
    // Both status pills should render.
    expect(text).toContain('open');
    expect(text).toContain('reviewed');

    // First call from the mount-time effect should have no `status`
    // (default "All" filter).
    expect(listMock).toHaveBeenCalled();
    const firstCall = listMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstCall?.status).toBeUndefined();
    expect(firstCall?.limit).toBe(50);
    expect(firstCall?.offset).toBe(0);
  });

  it('re-queries with status=open when the Open chip is tapped', async () => {
    // Initial mount: All filter.
    listMock.mockResolvedValueOnce({ items: [mkItem('a', 'open')], total: 1 });
    // Second call after filter change: scoped to open.
    listMock.mockResolvedValueOnce({ items: [mkItem('a', 'open')], total: 1 });

    harness = mount();
    await flush();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect((listMock.mock.calls[0]?.[0] as { status?: string }).status).toBeUndefined();

    const openChip = harness.container.querySelector(
      'button[data-status-chip="open"]'
    ) as HTMLButtonElement | null;
    expect(openChip).toBeTruthy();

    act(() => {
      openChip!.click();
    });
    await flush();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect((listMock.mock.calls[1]?.[0] as { status?: string }).status).toBe('open');
  });

  it('optimistically marks a row reviewed and calls voiceFeedbackPatch', async () => {
    listMock.mockResolvedValue({
      items: [mkItem('a', 'open'), mkItem('b', 'open')],
      total: 2,
    });
    // Resolve PATCH with a fresh row body — the page doesn't use the
    // response on the list view, but we model the contract.
    patchMock.mockResolvedValue({
      id: 'a',
      status: 'reviewed',
    });

    harness = mount();
    await flush();

    // Find the row for 'a' and its mark-reviewed button.
    const row = harness.container.querySelector(
      'article[data-feedback-id="a"]'
    ) as HTMLElement | null;
    expect(row).toBeTruthy();
    const markBtn = row!.querySelector(
      'button[data-action="mark-reviewed"]'
    ) as HTMLButtonElement | null;
    expect(markBtn).toBeTruthy();

    act(() => {
      markBtn!.click();
    });
    // Optimistic flip happens synchronously inside the click handler
    // BEFORE the PATCH resolves — flush so React commits.
    await flush();

    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]?.[0]).toBe('a');
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ status: 'reviewed' });

    // After the optimistic update, the 'a' row's pill should be
    // 'reviewed' and the mark-reviewed button should be gone (it only
    // renders on `open` rows).
    const updatedRow = harness.container.querySelector(
      'article[data-feedback-id="a"]'
    ) as HTMLElement | null;
    expect(updatedRow).toBeTruthy();
    expect(updatedRow!.textContent).toContain('reviewed');
    expect(updatedRow!.querySelector('button[data-action="mark-reviewed"]')).toBeNull();
  });
});
