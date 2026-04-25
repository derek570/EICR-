/**
 * Terms acceptance page — UI regression locks.
 *
 * Three slices of the contract get tested here, each one a place where
 * a future refactor could regress legal compliance:
 *
 *   1. Accept button stays disabled until *all six* attestations land
 *      (3 doc-reads + 3 confirmations). iOS `TermsAcceptanceView` has
 *      the same gate — slipping any of them would let an inspector
 *      bypass a doc or a confirmation.
 *
 *   2. On Accept, the three iOS-parity localStorage keys land with the
 *      right values (delegated to `recordTermsAcceptance`, asserted at
 *      the unit level in `terms-gate.test.ts`; here we only assert the
 *      page calls it). Then `router.replace(next)` fires so the user
 *      lands back on the page they were originally heading to.
 *
 *   3. Reading a doc opens the modal AND marks the row as read on
 *      close. This is the web-equivalent of iOS's scroll-to-bottom
 *      detection. Without this branch the docs row would never tick
 *      and Accept would never enable.
 *
 * Mount strategy mirrors `pdf-tab.test.tsx` — inline `createRoot`
 * rather than RTL to dodge the React dual-copy hazard documented in
 * `vitest.config.ts`. Radix Dialog is stubbed because Radix internals
 * resolve `react` from the monorepo root rather than `web/`'s pinned
 * 19.2.4, which would crash mount with "Invalid hook call".
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
    AppWindow: makeIcon('AppWindow'),
    CheckCircle2: makeIcon('CheckCircle2'),
    CheckSquare: makeIcon('CheckSquare'),
    ChevronRight: makeIcon('ChevronRight'),
    FileText: makeIcon('FileText'),
    Lock: makeIcon('Lock'),
    ShieldCheck: makeIcon('ShieldCheck'),
    Sparkles: makeIcon('Sparkles'),
    Square: makeIcon('Square'),
    UserCheck: makeIcon('UserCheck'),
    X: makeIcon('X'),
  };
});

// Radix Dialog → minimal open/close machine that still exercises the
// `onOpenChange` callback so the page's "mark read on close" branch
// runs. Mirrors the stub used in `pdf-tab.test.tsx`.
vi.mock('@/components/ui/dialog', () => {
  const Dialog: React.FC<{
    open: boolean;
    onOpenChange?: (v: boolean) => void;
    children: React.ReactNode;
  }> = ({ open, onOpenChange, children }) => {
    if (!open) return null;
    return (
      <div role="dialog" data-testid="legal-dialog" onClick={() => onOpenChange?.(false)}>
        {children}
      </div>
    );
  };
  const DialogContent: React.FC<{
    children: React.ReactNode;
    className?: string;
    showCloseButton?: boolean;
  }> = ({ children }) => <>{children}</>;
  const DialogTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <h2>{children}</h2>
  );
  const DialogClose: React.FC<{
    children: React.ReactNode;
    asChild?: boolean;
  }> = ({ children }) => <>{children}</>;
  return { Dialog, DialogContent, DialogTitle, DialogClose };
});

const replaceMock = vi.fn<(href: string) => void>();
const searchParamsStub = new Map<string, string>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => ({
    get: (key: string) => searchParamsStub.get(key) ?? null,
  }),
}));

import TermsPage from '@/app/terms/page';
import {
  TERMS_STORAGE_KEYS,
  TERMS_VERSION,
  hasAcceptedCurrentTerms,
} from '@/app/terms/legal-texts-gate';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TermsPage />);
  });
  return { container, root };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (buttons.find((b) => b.textContent?.trim().includes(label)) ??
    null) as HTMLButtonElement | null;
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  replaceMock.mockReset();
  searchParamsStub.clear();
  window.localStorage.clear();
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('Wave B parity · /terms acceptance gate', () => {
  it('renders Accept disabled with all six attestations un-ticked', () => {
    harness = mount();
    const accept = findButton(harness.container, 'I Accept');
    expect(accept).not.toBeNull();
    expect(accept!.disabled).toBe(true);
    // Page text confirms it's the gate, not some other "Accept" button.
    expect(harness.container.textContent).toContain('Review & Accept Our Terms');
    expect(harness.container.textContent).toContain('0%');
  });

  it('keeps Accept disabled if only the docs are read (confirmations not ticked)', async () => {
    harness = mount();

    // Open & close all three doc modals — each "Read" button opens the
    // dialog stub which closes via onOpenChange on click.
    const readButtons = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button[data-doc-id]')
    );
    expect(readButtons).toHaveLength(3);
    for (const btn of readButtons) {
      await act(async () => {
        btn.click();
      });
      const dialog = harness.container.querySelector('[data-testid="legal-dialog"]');
      expect(dialog).not.toBeNull();
      await act(async () => {
        (dialog as HTMLElement).click(); // closes the stubbed dialog
      });
    }

    // Accept still disabled — confirmations remain unticked.
    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('50%');
  });

  it('keeps Accept disabled if only the confirmations are ticked (docs not read)', async () => {
    harness = mount();
    // Confirmation rows are buttons containing text from the iOS
    // confirmation copy. Match by the distinctive opening clauses.
    const confirmationStartsWith = [
      'I am a qualified',
      'I hold valid',
      'I understand that CertMate',
    ];
    for (const text of confirmationStartsWith) {
      const btn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(text)
      );
      expect(btn).toBeDefined();
      await act(async () => {
        btn!.click();
      });
    }

    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('50%');
  });

  it('enables Accept once all six attestations land, then writes the iOS-parity keys + redirects', async () => {
    searchParamsStub.set('next', '/job/abc/circuits');

    harness = mount();

    // Read all three docs.
    const readButtons = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button[data-doc-id]')
    );
    for (const btn of readButtons) {
      await act(async () => {
        btn.click();
      });
      const dialog = harness.container.querySelector('[data-testid="legal-dialog"]');
      await act(async () => {
        (dialog as HTMLElement).click();
      });
    }

    // Tick all three confirmations.
    for (const text of ['I am a qualified', 'I hold valid', 'I understand that CertMate']) {
      const btn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(text)
      );
      await act(async () => {
        btn!.click();
      });
    }

    // Accept is now enabled.
    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(false);
    expect(harness.container.textContent).toContain('100%');

    await act(async () => {
      accept!.click();
      await Promise.resolve();
    });

    // localStorage keys were set via recordTermsAcceptance.
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.accepted)).toBe('true');
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.version)).toBe(TERMS_VERSION);
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    // Gate now reports accepted.
    expect(hasAcceptedCurrentTerms()).toBe(true);

    // Router redirected back to the original target.
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/job/abc/circuits');
  });

  it('defaults the redirect target to /dashboard when no `next` param is provided', async () => {
    harness = mount();

    // Run the full enable+accept dance via the same path as above.
    const readButtons = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button[data-doc-id]')
    );
    for (const btn of readButtons) {
      await act(async () => {
        btn.click();
      });
      const dialog = harness.container.querySelector('[data-testid="legal-dialog"]');
      await act(async () => {
        (dialog as HTMLElement).click();
      });
    }
    for (const text of ['I am a qualified', 'I hold valid', 'I understand that CertMate']) {
      const btn = Array.from(harness.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(text)
      );
      await act(async () => {
        btn!.click();
      });
    }
    const accept = findButton(harness.container, 'I Accept');
    await act(async () => {
      accept!.click();
      await Promise.resolve();
    });
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
