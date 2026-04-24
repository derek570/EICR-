/**
 * Phase 3 — AlertsBell.
 *
 * Asserts:
 *   1. Renders the bell link with no badge when there are no failed jobs.
 *   2. Renders a red badge with the failed-count when non-zero.
 *   3. Caps visible count at "99+" so the badge stays compact.
 *   4. Links to /alerts.
 *
 * The bell fetches `api.jobs(userId)` on mount; we drive that via MSW
 * so the test exercises the real fetch surface.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// Same React-dual-copy hazard as `pdf-tab.test.tsx` — lucide-react's
// internal React lookup resolves through CJS bare-require, which lands
// on the monorepo-root React copy instead of the web workspace's 19.2.4.
// Stub each icon with a plain span so mounts don't explode.
vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    Bell: makeIcon('Bell'),
  };
});

// next/link also trips the React-copy mismatch under vitest (it calls
// `useContext` against a React instance that's not the one the renderer
// bound). Replace with a plain `<a>` for tests — the link URL is what
// we're asserting anyway.
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

import { AlertsBell } from '@/components/dashboard/alerts-bell';
import { createTestServer, TEST_API_BASE } from './msw-server';
import type { Job } from '@/lib/types';

const server = createTestServer();

function mkJob(id: string, status: Job['status']): Job {
  return {
    id,
    status,
    address: `Job ${id}`,
    created_at: '2024-01-01T00:00:00Z',
  };
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
  // Seed an authenticated user so `getUser()` returns non-null —
  // this is what the AlertsBell checks before firing the fetch.
  localStorage.setItem('cm_user', JSON.stringify({ id: 'user-1', email: 'x@y', name: 'X' }));
  localStorage.setItem('cm_token', 'fake');
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
  localStorage.clear();
});

async function waitForNetwork(): Promise<void> {
  // Flush any pending promises — two microtask ticks is enough for
  // the mount-effect's `.then(...)` chain to resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AlertsBell', () => {
  it('renders without a badge when there are no failed jobs', async () => {
    server.use(
      http.get(`${TEST_API_BASE}/api/jobs/user-1`, () =>
        HttpResponse.json([mkJob('a', 'pending'), mkJob('b', 'done')])
      )
    );

    mounted = mount(<AlertsBell />);
    await waitForNetwork();

    const link = mounted.container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/alerts');
    // Badge is only rendered when count > 0 — the Bell icon stub also
    // emits an aria-hidden span, so narrow to the badge by text content.
    const badge = Array.from(mounted.container.querySelectorAll('span[aria-hidden]')).find(
      (el) => (el.textContent ?? '').length > 0
    );
    expect(badge).toBeUndefined();
  });

  it('renders a red badge with the failed-count when non-zero', async () => {
    server.use(
      http.get(`${TEST_API_BASE}/api/jobs/user-1`, () =>
        HttpResponse.json([mkJob('a', 'failed'), mkJob('b', 'failed'), mkJob('c', 'pending')])
      )
    );

    mounted = mount(<AlertsBell />);
    await waitForNetwork();

    // The Bell icon stub also renders aria-hidden, so we narrow to the
    // badge by looking for a non-empty text node among aria-hidden spans.
    const badge = Array.from(mounted.container.querySelectorAll('span[aria-hidden]')).find(
      (el) => (el.textContent ?? '').length > 0
    )!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('2');
  });

  it('caps the visible count at 99+ for huge failed lists', async () => {
    const jobs = Array.from({ length: 150 }, (_, i) => mkJob(String(i), 'failed'));
    server.use(http.get(`${TEST_API_BASE}/api/jobs/user-1`, () => HttpResponse.json(jobs)));

    mounted = mount(<AlertsBell />);
    await waitForNetwork();

    // The Bell icon stub also renders aria-hidden, so we narrow to the
    // badge by looking for a non-empty text node among aria-hidden spans.
    const badge = Array.from(mounted.container.querySelectorAll('span[aria-hidden]')).find(
      (el) => (el.textContent ?? '').length > 0
    )!;
    expect(badge.textContent).toBe('99+');
  });

  it('exposes a data-tour attribute when provided', async () => {
    server.use(http.get(`${TEST_API_BASE}/api/jobs/user-1`, () => HttpResponse.json([])));

    mounted = mount(<AlertsBell dataTour="alerts-bell" />);
    await waitForNetwork();

    const link = mounted.container.querySelector('a')!;
    expect(link.getAttribute('data-tour')).toBe('alerts-bell');
  });
});
