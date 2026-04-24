/**
 * Phase 6 — diagnostics "Clear cache" confirm-then-execute flow.
 *
 * Covers:
 *   1. The destructive button opens a ConfirmDialog — no wipe fires
 *      until the user confirms.
 *   2. On confirm, the page unregisters every SW, deletes the
 *      `certmate-cache` IDB, clears local + session storage, and
 *      navigates to /login (via `location.href`).
 *
 * We stub `location.href` writes because jsdom throws on real
 * navigation; the test just asserts the target URL string was
 * assigned.
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
    ArrowLeft: makeIcon('ArrowLeft'),
    ClipboardCopy: makeIcon('ClipboardCopy'),
    Download: makeIcon('Download'),
    Trash2: makeIcon('Trash2'),
    Wrench: makeIcon('Wrench'),
  };
});

// ConfirmDialog — same stub pattern as pdf-tab.test.tsx.
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onOpenChange,
    confirmLabel = 'Confirm',
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    onOpenChange: (v: boolean) => void;
    confirmLabel?: string;
    title: string;
  }) => {
    if (!open) return null;
    return (
      <div role="dialog">
        <p>{title}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    );
  },
}));

const routerPush = vi.fn<(p: string) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/lib/diagnostics', () => ({
  collectDiagnostics: vi.fn().mockResolvedValue({}),
}));

const clearAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  clearAuth: () => clearAuthMock(),
  getUser: () => null,
  getToken: () => null,
}));

vi.mock('@certmate/shared-utils', () => ({
  downloadBlob: vi.fn(),
}));

import DiagnosticsPage from '@/app/settings/diagnostics/page';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<DiagnosticsPage />);
  });
  return { container, root };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(label)
    ) as HTMLButtonElement | undefined) ?? null
  );
}

let harness: { container: HTMLDivElement; root: Root } | null = null;
let locationHrefCalls: string[] = [];
let originalLocation: Location | undefined;

beforeEach(() => {
  clearAuthMock.mockReset();
  routerPush.mockReset();
  locationHrefCalls = [];

  // jsdom protects window.location from being redefined in place;
  // swap the whole object out for a shim that records href writes.
  // We restore in afterEach so later tests keep the real Location.
  originalLocation = window.location;
  const shim = {
    get href() {
      return 'http://localhost/';
    },
    set href(next: string) {
      locationHrefCalls.push(next);
    },
    reload: vi.fn(),
    assign: vi.fn(),
    replace: vi.fn(),
    origin: 'http://localhost',
    host: 'localhost',
    hostname: 'localhost',
    pathname: '/',
    search: '',
    hash: '',
    protocol: 'http:',
  } as unknown as Location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: shim,
  });

  // Service worker stubs.
  const unregister = vi.fn<() => Promise<boolean>>(async () => true);
  (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
    getRegistrations: vi.fn<() => Promise<Array<{ unregister: () => Promise<boolean> }>>>(
      async () => [{ unregister }]
    ),
  };
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
  if (originalLocation) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  }
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

describe('Phase 6 · clear cache flow', () => {
  it('opens a confirm dialog and does nothing if the user cancels', () => {
    harness = mount();
    const trigger = findButton(harness.container, 'Clear cache')!;
    act(() => {
      trigger.click();
    });
    // Dialog is visible.
    expect(harness.container.textContent).toContain('Clear cache?');
    act(() => {
      findButton(harness.container, 'Cancel')!.click();
    });
    expect(clearAuthMock).not.toHaveBeenCalled();
    expect(locationHrefCalls).toEqual([]);
  });

  it('wipes SW + IDB + storage and navigates to /login on confirm', async () => {
    harness = mount();
    const trigger = findButton(harness.container, 'Clear cache')!;
    act(() => {
      trigger.click();
    });

    // Dialog renders with role="dialog" — scope the confirm lookup to
    // that subtree so we don't re-click the still-present trigger.
    const dialog = harness.container.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Clear cache')
    ) as HTMLButtonElement;
    expect(confirm).toBeDefined();

    await act(async () => {
      confirm!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clearAuthMock).toHaveBeenCalledTimes(1);
    expect(locationHrefCalls).toContain('/login');
    expect(
      (navigator.serviceWorker as unknown as { getRegistrations: vi.Mock }).getRegistrations
    ).toHaveBeenCalled();
  });
});
