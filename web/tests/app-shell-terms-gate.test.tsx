/**
 * AppShell T&Cs gate — redirect locks.
 *
 * Mounting the full AppShell in jsdom is heavy (it pulls Logo, Radix
 * primitives, AlertsBell, OfflineIndicator, useOutboxReplay, etc.) and
 * the existing tests in the repo don't try. The gate's behaviour,
 * though, is small and well-bounded: a single useEffect that decides
 * whether to call `router.replace('/terms?next=...')` based on the
 * current pathname and `hasAcceptedCurrentTerms()`.
 *
 * To lock the gate's contract without dragging the rest of AppShell
 * along, this file mounts a tiny shim component that uses *the same
 * imports and the same effect body* as the real AppShell. If a future
 * refactor moves the gate elsewhere, update both. The point of these
 * tests is the redirect rule, not the AppShell layout.
 *
 * Branches under test:
 *   1. No acceptance + on /dashboard → redirect to /terms (no `?next` —
 *      /dashboard is the default landing post-accept).
 *   2. No acceptance + on /job/abc → redirect to /terms?next=/job/abc.
 *   3. No acceptance + on /terms → no redirect (don't loop on yourself).
 *   4. Accepted current version → no redirect (the happy path).
 *   5. Accepted stale version → redirect (force re-acceptance).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const replaceMock = vi.fn<(href: string) => void>();
let pathnameStub = '/dashboard';
let searchStub = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameStub,
  useSearchParams: () => new URLSearchParams(searchStub),
}));

import {
  TERMS_STORAGE_KEYS,
  TERMS_VERSION,
  hasAcceptedCurrentTerms,
} from '@/app/terms/legal-texts-gate';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

/**
 * The smallest faithful reproduction of the AppShell gate effect.
 * Update in lockstep with `web/src/components/layout/app-shell.tsx`
 * when the gate logic changes.
 */
function GateShim(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  React.useEffect(() => {
    if (pathname === '/terms') return;
    if (hasAcceptedCurrentTerms()) return;
    const params = new URLSearchParams();
    if (pathname && pathname !== '/dashboard') {
      const search = searchParams ? searchParams.toString() : '';
      params.set('next', search ? `${pathname}?${search}` : pathname);
    }
    const qs = params.toString();
    router.replace(qs ? `/terms?${qs}` : '/terms');
  }, [pathname, router, searchParams]);
  return null;
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<GateShim />);
  });
  return { container, root };
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  replaceMock.mockReset();
  window.localStorage.clear();
  pathnameStub = '/dashboard';
  searchStub = '';
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
});

describe('Wave B parity · AppShell T&Cs gate', () => {
  it('redirects unaccepted user to /terms (no `next` when already on /dashboard)', () => {
    pathnameStub = '/dashboard';
    harness = mount();
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/terms');
  });

  it('redirects unaccepted user to /terms?next=<originalPath> for non-dashboard routes', () => {
    pathnameStub = '/job/abc/circuits';
    harness = mount();
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/terms?next=%2Fjob%2Fabc%2Fcircuits');
  });

  it('does NOT redirect when the user is already on /terms (no self-loop)', () => {
    pathnameStub = '/terms';
    harness = mount();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does NOT redirect when the user has accepted the current version', () => {
    window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
    window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
    pathnameStub = '/dashboard';
    harness = mount();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(hasAcceptedCurrentTerms()).toBe(true);
  });

  it('redirects when the accepted version is stale (force re-accept)', () => {
    window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
    window.localStorage.setItem(TERMS_STORAGE_KEYS.version, '0.9');
    pathnameStub = '/job/xyz';
    harness = mount();
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith('/terms?next=%2Fjob%2Fxyz');
  });

  it('preserves the original query string in `next` (codex P2 on 06caaf9)', () => {
    // Routes like /job/[id]/circuits/match-review carry resume state in
    // their query (`?nonce=...`). Pre-fix the gate stored only pathname
    // and the user returned to the page without their nonce, falling
    // back to the wrong screen post-accept.
    pathnameStub = '/job/abc/circuits/match-review';
    searchStub = 'nonce=xyz123&session=42';
    harness = mount();
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const arg = replaceMock.mock.calls[0][0];
    // URL-encoded `next` includes both pathname and the full query.
    expect(arg).toContain('next=');
    const decoded = decodeURIComponent(arg.split('next=')[1] ?? '');
    expect(decoded).toBe('/job/abc/circuits/match-review?nonce=xyz123&session=42');
  });
});
