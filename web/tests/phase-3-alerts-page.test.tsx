/**
 * Phase 3 — Alerts page.
 *
 * Asserts:
 *   1. Three-section render with correct titles + counts when the job
 *      list populates all three buckets.
 *   2. Empty-state "All clear" shield renders when the list is empty.
 *   3. Sections are collapsed / expanded per the iOS defaults
 *      (Needs Attention + In Progress expanded, Recently Completed
 *      collapsed).
 *
 * Mount strategy mirrors `pdf-tab.test.tsx` — inline createRoot +
 * module-level mocks for lucide-react and next/navigation so we dodge
 * the React-dual-copy hazard and don't need a real router.
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
    AlertTriangle: makeIcon('AlertTriangle'),
    Bell: makeIcon('Bell'),
    CheckCircle2: makeIcon('CheckCircle2'),
    ChevronRight: makeIcon('ChevronRight'),
    Clock: makeIcon('Clock'),
    CloudUpload: makeIcon('CloudUpload'),
    FileText: makeIcon('FileText'),
    Shield: makeIcon('Shield'),
    Trash2: makeIcon('Trash2'),
  };
});

// next/link hits the React-dual-copy hazard under vitest. Stub with a
// plain `<a>`.
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

// The alerts page calls `useRouter` to replace('/login') on 401.
const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

// Stub getUser so the page gets past the auth redirect.
vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-7', email: 't@e.st', name: 'T' }),
  clearAuth: vi.fn(),
}));

// Stub the cache read so we control what the page paints (we only
// assert on the post-network state in these tests).
vi.mock('@/lib/pwa/job-cache', () => ({
  getCachedJobs: vi.fn(async () => null),
  putCachedJobs: vi.fn(async () => undefined),
}));

// api-client mock — the only method the alerts page calls is `jobs`.
// Declared via `vi.hoisted` so the mock factory below (which is hoisted
// above the import graph) can reference the same mock instance we use
// from test bodies. Without `vi.hoisted` the `jobsMock = vi.fn()` would
// run AFTER the hoisted `vi.mock` factory closure had already captured
// `undefined`, and the first `api.jobs(...)` call would explode with
// "Cannot read properties of undefined (reading 'then')".
const { jobsMock } = vi.hoisted(() => ({ jobsMock: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  api: {
    jobs: (userId: string) => jobsMock(userId),
  },
}));

// ConfirmDialog wraps Radix Dialog which hits a React-copy mismatch
// under vitest. The alerts page renders JobRow which mounts a
// ConfirmDialog, so stub it to a no-render component.
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

// Import AFTER mocks so the page resolves to our stubs.
import AlertsPage from '@/app/alerts/page';
import type { Job } from '@/lib/types';

function mkJob(id: string, status: Job['status']): Job {
  return {
    id,
    status,
    address: `Job ${id}`,
    created_at: '2024-01-01T00:00:00Z',
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AlertsPage />);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  // The page mount fires two async chains: a `getCachedJobs` IDB read
  // and the `api.jobs(...)` fetch mock. Both resolve asynchronously;
  // the `setJobs` call lands on a subsequent microtask. A plain
  // setTimeout wait outside act() is enough — wrapping in act() was
  // observed to hang under the vitest 4 + React 19 combo in this
  // repo (deadlocks on flushPassiveEffects under some mock shapes).
  await new Promise((r) => setTimeout(r, 60));
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  jobsMock.mockReset();
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

describe('AlertsPage', () => {
  it('renders three sections with correct counts for a mixed list', async () => {
    jobsMock.mockResolvedValue([
      mkJob('f1', 'failed'),
      mkJob('f2', 'failed'),
      mkJob('p1', 'pending'),
      mkJob('pr1', 'processing'),
      mkJob('d1', 'done'),
    ]);

    harness = mount();
    await flush();

    const headings = Array.from(harness.container.querySelectorAll('h1, h2, button'));
    const allText = harness.container.textContent ?? '';

    expect(allText).toContain('Needs Attention');
    expect(allText).toContain('In Progress');
    expect(allText).toContain('Recently Completed');

    // Section with "Needs Attention" should show count 2
    const needsAttention = headings.find((el) =>
      (el.textContent ?? '').includes('Needs Attention')
    );
    expect(needsAttention).toBeTruthy();
    expect(needsAttention!.textContent).toContain('2');

    const inProgress = headings.find((el) => (el.textContent ?? '').includes('In Progress'));
    expect(inProgress!.textContent).toContain('2');

    const recentlyCompleted = headings.find((el) =>
      (el.textContent ?? '').includes('Recently Completed')
    );
    expect(recentlyCompleted!.textContent).toContain('1');
  });

  it('renders empty-state "All clear" when there are zero jobs', async () => {
    jobsMock.mockResolvedValue([]);

    harness = mount();
    await flush();

    expect(harness.container.textContent).toContain('All clear');
    // None of the section titles should appear.
    expect(harness.container.textContent).not.toContain('Needs Attention');
    expect(harness.container.textContent).not.toContain('In Progress');
    expect(harness.container.textContent).not.toContain('Recently Completed');
  });

  it('expands Needs Attention + In Progress by default but collapses Recently Completed', async () => {
    jobsMock.mockResolvedValue([
      mkJob('f1', 'failed'),
      mkJob('p1', 'pending'),
      mkJob('d1', 'done'),
    ]);

    harness = mount();
    await flush();

    // Each section's toggle button has `aria-expanded`.
    const sections = Array.from(harness.container.querySelectorAll('button[aria-expanded]'));
    const byTitle: Record<string, HTMLButtonElement> = {};
    for (const b of sections) {
      const title = (b.textContent ?? '').match(/(Needs Attention|In Progress|Recently Completed)/);
      if (title) byTitle[title[1]] = b as HTMLButtonElement;
    }

    expect(byTitle['Needs Attention']?.getAttribute('aria-expanded')).toBe('true');
    expect(byTitle['In Progress']?.getAttribute('aria-expanded')).toBe('true');
    expect(byTitle['Recently Completed']?.getAttribute('aria-expanded')).toBe('false');
  });
});
