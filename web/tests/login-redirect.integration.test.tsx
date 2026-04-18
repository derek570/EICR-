/**
 * Wave 5 D7 (E2) — login `?redirect=` end-to-end integration.
 *
 * Scope (FIX_PLAN.md §E E2 · login redirect rules):
 *   The Wave 1 P0-16 fix introduced `sanitiseRedirect` as a pure helper
 *   and `auth-redirect.test.ts` already covers the predicate's every
 *   branch (null / absolute / protocol-relative / backslash / javascript:
 *   / scheme-less). What the unit test can NOT prove is the integration
 *   — that `LoginForm` actually reads `?redirect=`, passes the raw
 *   value through `sanitiseRedirect`, and calls `router.push(sanitised)`
 *   on successful login. A refactor that, say, bypassed the sanitiser
 *   on one code path would pass every unit test and still reintroduce
 *   the open-redirect.
 *
 * What's covered here:
 *   1. Valid same-origin path → router.push receives that path.
 *   2. Protocol-relative `//evil.com` → router.push receives /dashboard.
 *   3. Missing `?redirect=` → router.push receives /dashboard.
 *
 * Why vi.mock of `next/navigation` + `@/lib/api-client`:
 *   LoginForm calls `useRouter().push()` + `api.login()`. Mocking both
 *   lets us drive the submit handler and assert exactly what router
 *   call the form issued without spinning up a Next runtime or a real
 *   HTTP server. The `api` mock returns a valid auth response so the
 *   try-branch of `onSubmit` runs through to the `router.push` line.
 *
 * Why `mountProvider`-style inline createRoot (not RTL render):
 *   Same reason as `job-context.test.tsx` + `outbox-replay.integration`
 *   — the monorepo-root-hoisted React 19.2.3 vs web's 19.2.4 mismatch
 *   blows up inside RTL's CJS bundle. Mount inline keeps the react /
 *   react-dom import graph inside Vite's transform pipeline so both
 *   resolve to web's pinned copy.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `next/navigation` BEFORE importing the login page so the hook
// lookups inside LoginForm resolve to our stubs. Vitest hoists
// `vi.mock` calls to the top of the file, so the import order below is
// purely visual — the mocks take effect regardless.
const pushSpy = vi.fn<(href: string) => void>();
const searchParamsGet = vi.fn<(key: string) => string | null>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({
    get: searchParamsGet,
  }),
}));

// Mock api-client so `api.login` resolves deterministically without
// touching MSW or the network. The form's catch-branch isn't under
// test here; the redirect branch is.
vi.mock('@/lib/api-client', () => ({
  api: {
    login: vi.fn(async () => ({
      token: 'test-token',
      user: { id: 'u1', email: 'x@y.z', role: 'inspector' },
    })),
  },
}));

// Mock setAuth so we don't touch localStorage (the setup.ts shim makes
// it work, but keeping the mock means this test doesn't interfere with
// the auth-role tests' localStorage state).
vi.mock('@/lib/auth', () => ({
  setAuth: vi.fn(),
}));

// Import AFTER the mocks so LoginPage's module graph picks them up.
import LoginPage from '@/app/login/page';

describe('Wave 5 D7 E2 · login `?redirect=` integration (P0-16 regression)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    pushSpy.mockClear();
    searchParamsGet.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  function mount(): void {
    act(() => {
      root = createRoot(container);
      root.render(<LoginPage />);
    });
  }

  async function submitForm(email: string, password: string): Promise<void> {
    const emailInput = container.querySelector<HTMLInputElement>('input#email');
    const passwordInput = container.querySelector<HTMLInputElement>('input#password');
    const form = container.querySelector<HTMLFormElement>('form');
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    expect(form).not.toBeNull();

    // React's synthetic event system requires the native input event
    // with the value set on the element first — directly calling
    // `fireEvent` would need RTL. Set value then dispatch input.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(emailInput, email);
      emailInput!.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(passwordInput, password);
      passwordInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // Let the useTransition + api.login + router.push microtasks flush.
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('(a) valid same-origin redirect → router.push receives the sanitised path', async () => {
    searchParamsGet.mockImplementation((k) => (k === 'redirect' ? '/job/123/circuits' : null));
    mount();
    await submitForm('inspector@test.co.uk', 'hunter2');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/job/123/circuits');
  });

  it('(b) protocol-relative `//evil.com` redirect → router.push receives /dashboard', async () => {
    // This is the canonical open-redirect payload; pre-P0-16 the login
    // page would have honoured it and sent the freshly-authenticated
    // inspector straight to the attacker's page. The sanitiser's job is
    // to clamp it to /dashboard; THIS test proves the form actually
    // calls the sanitiser (not just that the helper works in isolation).
    searchParamsGet.mockImplementation((k) => (k === 'redirect' ? '//evil.com/attack' : null));
    mount();
    await submitForm('inspector@test.co.uk', 'hunter2');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/dashboard');
  });

  it('(c) missing `?redirect=` → router.push defaults to /dashboard', async () => {
    searchParamsGet.mockImplementation(() => null);
    mount();
    await submitForm('inspector@test.co.uk', 'hunter2');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith('/dashboard');
  });
});
