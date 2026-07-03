/**
 * Terms acceptance page — UI regression locks.
 *
 * Slices of the contract tested here, each a place where a future
 * refactor could regress legal compliance:
 *
 *   1. Accept button stays disabled until *all seven* attestations land
 *      (3 doc-reads + 3 confirmations + 1 acceptance signature). iOS
 *      `TermsAcceptanceView` has the same seven-item gate (WS7 added the
 *      signature) — slipping any of them would let an inspector bypass a
 *      doc, a confirmation, or the audit signature.
 *
 *   2. On Accept, the four iOS-parity localStorage keys land (incl. the
 *      signature) via `recordTermsAcceptance` (unit-asserted in
 *      `terms-gate.test.ts`; here we assert the page calls it with the
 *      captured signature). Then `router.replace(next)` fires ONLY on a
 *      successful persist.
 *
 *   3. A storage-failure on persist must NOT redirect — the gate has to
 *      re-prompt rather than soft-bypass with no signature on file.
 *
 *   4. Reading a doc opens the modal AND marks the row read on close.
 *
 * Mount strategy mirrors `pdf-tab.test.tsx` — inline `createRoot` rather
 * than RTL. Radix Dialog is stubbed (react dual-copy hazard). The
 * `SignatureCanvas` is stubbed to a tiny sign/clear machine — its own
 * drawing internals are covered by `signature-canvas.test.tsx`; here we
 * only need to drive its `onContentChange` + imperative
 * `hasContent`/`getBlob`.
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
    Signature: makeIcon('Signature'),
    Sparkles: makeIcon('Sparkles'),
    Square: makeIcon('Square'),
    UserCheck: makeIcon('UserCheck'),
    X: makeIcon('X'),
  };
});

// Radix Dialog → minimal open/close machine that still exercises the
// `onOpenChange` callback so the page's "mark read on close" branch runs.
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

// SignatureCanvas stub — a sign/clear machine exposing the same
// imperative handle the page consumes. Clicking `sign-stub` marks it
// "signed" and fires onContentChange(true); getBlob returns a real PNG
// Blob so the page's FileReader → data URL path runs unmocked.
interface StubHandle {
  hasContent: () => boolean;
  getBlob: () => Promise<Blob | null>;
  clear: () => void;
}
vi.mock('@/components/settings/signature-canvas', () => {
  const SignatureCanvas = React.forwardRef<
    StubHandle,
    { onContentChange?: (has: boolean) => void; helperText?: string }
  >(function SignatureCanvasStub({ onContentChange }, ref) {
    const [signed, setSigned] = React.useState(false);
    React.useImperativeHandle(
      ref,
      () => ({
        hasContent: () => signed,
        getBlob: async () => (signed ? new Blob(['fake-png-bytes'], { type: 'image/png' }) : null),
        clear: () => {
          setSigned(false);
          onContentChange?.(false);
        },
      }),
      [signed, onContentChange]
    );
    return (
      <button
        type="button"
        data-testid="sign-stub"
        onClick={() => {
          setSigned(true);
          onContentChange?.(true);
        }}
      >
        sign
      </button>
    );
  });
  return { SignatureCanvas };
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

async function readAllDocs(container: HTMLElement) {
  const readButtons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[data-doc-id]')
  );
  for (const btn of readButtons) {
    await act(async () => {
      btn.click();
    });
    const dialog = container.querySelector('[data-testid="legal-dialog"]');
    await act(async () => {
      (dialog as HTMLElement).click();
    });
  }
}

async function tickAllConfirmations(container: HTMLElement) {
  for (const text of ['I am a qualified', 'I hold valid', 'I understand that CertMate']) {
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(text)
    );
    await act(async () => {
      btn!.click();
    });
  }
}

async function sign(container: HTMLElement) {
  const stub = container.querySelector<HTMLButtonElement>('[data-testid="sign-stub"]');
  expect(stub).not.toBeNull();
  await act(async () => {
    stub!.click();
  });
}

async function completeAllSeven(container: HTMLElement) {
  await readAllDocs(container);
  await tickAllConfirmations(container);
  await sign(container);
}

// accept() is async: getBlob() → FileReader.readAsDataURL (a MACROtask in
// jsdom) → recordTermsAcceptance. `await Promise.resolve()` only drains
// microtasks, so drain a couple of macrotask boundaries too or the
// persist+redirect will still be pending when assertions run (and would
// leak into the next test).
async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clickAccept(container: HTMLElement) {
  const accept = findButton(container, 'I Accept');
  await act(async () => {
    accept!.click();
  });
  await flushAsync();
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

describe('WS7 parity · /terms acceptance gate (7 attestations incl. signature)', () => {
  it('renders Accept disabled with all seven attestations un-ticked', () => {
    harness = mount();
    const accept = findButton(harness.container, 'I Accept');
    expect(accept).not.toBeNull();
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('Review & Accept Our Terms');
    expect(harness.container.textContent).toContain('0%');
    // Signature section is present.
    expect(harness.container.textContent).toContain('Acceptance Signature');
    expect(harness.container.querySelector('[data-testid="sign-stub"]')).not.toBeNull();
  });

  it('keeps Accept disabled if only the docs are read (3/7 = 43%)', async () => {
    harness = mount();
    await readAllDocs(harness.container);
    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('43%');
  });

  it('keeps Accept disabled if only the confirmations are ticked (3/7 = 43%)', async () => {
    harness = mount();
    await tickAllConfirmations(harness.container);
    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('43%');
  });

  it('keeps Accept disabled at 6/7 (docs + confirmations, NO signature) then enables at 7/7', async () => {
    harness = mount();
    await readAllDocs(harness.container);
    await tickAllConfirmations(harness.container);
    // Six of seven — signature still missing.
    let accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(true);
    expect(harness.container.textContent).toContain('86%');
    expect(harness.container.textContent).not.toContain('100%');
    // Sign → seventh attestation lands, Accept unlocks, 100%.
    await sign(harness.container);
    accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(false);
    expect(harness.container.textContent).toContain('100%');
  });

  it('enables Accept once all seven land, then writes the four iOS-parity keys (incl signature) + redirects', async () => {
    searchParamsStub.set('next', '/job/abc/circuits');
    harness = mount();
    await completeAllSeven(harness.container);

    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(false);
    expect(harness.container.textContent).toContain('100%');

    await clickAccept(harness.container);

    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.accepted)).toBe('true');
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.version)).toBe(TERMS_VERSION);
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    // The audit signature persisted as a PNG data URL.
    expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.signature)).toMatch(
      /^data:image\/png;base64,/
    );

    expect(hasAcceptedCurrentTerms()).toBe(true);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/job/abc/circuits');
  });

  it('does NOT redirect (and shows an error) when localStorage persist fails', async () => {
    harness = mount();
    await completeAllSeven(harness.container);

    // Force the persist to throw — recordTermsAcceptance returns false,
    // so the page must NOT navigate and must surface a retry.
    //
    // vi.spyOn (auto-restored by `restoreMocks` in vitest.config.ts) instead
    // of a direct `window.localStorage.setItem = fn` reassignment: a real
    // jsdom Storage can silently ignore the per-instance override (the WS7
    // CI failure mode), and the spy is honoured deterministically. It also
    // removes the macrotask race the old manual finally had to work around —
    // the spy stays active across the FULL async accept
    // (getBlob→FileReader→recordTermsAcceptance) and is only reverted in the
    // afterEach AFTER the test resolves, so nothing can restore it mid-flight.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await clickAccept(harness.container);

    expect(replaceMock).not.toHaveBeenCalled();
    expect(hasAcceptedCurrentTerms()).toBe(false);
    // Inline error surfaced + button re-enabled for a retry.
    expect(harness.container.textContent).toMatch(/couldn.t save your acceptance/i);
    const accept = findButton(harness.container, 'I Accept');
    expect(accept!.disabled).toBe(false);
  });

  it('rejects an open-redirect `next` and routes to /dashboard instead (codex P1 on 06caaf9)', async () => {
    searchParamsStub.set('next', 'https://evil.example/landing');
    harness = mount();
    await completeAllSeven(harness.container);
    await clickAccept(harness.container);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
    expect(replaceMock).not.toHaveBeenCalledWith('https://evil.example/landing');
  });

  it('defaults the redirect target to /dashboard when no `next` param is provided', async () => {
    harness = mount();
    await completeAllSeven(harness.container);
    await clickAccept(harness.container);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
