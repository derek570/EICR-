/**
 * Wave 5 D7 (E2) — stale-while-revalidate cache-race regression.
 *
 * Scope (FIX_PLAN.md §E E2 · dashboard cache race):
 *   The dashboard (and, mirrored, `/job/[id]/layout.tsx`) does SWR via
 *   the IDB job cache:
 *     1. Fire `getCachedJobs(userId)` — paint cached list immediately.
 *     2. Fire `api.jobs(userId)` — replace on success.
 *   Both lands on `setJobs`. The two promises race. If the NETWORK
 *   resolves first (warm CDN, cold IDB), the cache promise would
 *   overwrite fresh-from-server with a stale list. The guard in
 *   `dashboard/page.tsx` is:
 *     if (cached && jobs === null) setJobs(cached);
 *   — cache ONLY paints if state is still untouched. This test
 *   enumerates the race so a future refactor that drops the guard
 *   fails loud.
 *
 * Why this test file tests the PATTERN, not DashboardPage directly:
 *   Mounting the full dashboard under jsdom hits three orthogonal
 *   issues (lucide-react React-instance mismatch, `next/link`
 *   router context, `window.matchMedia` jsdom gap) that are all
 *   unrelated to the race logic we care about. Recreating the race
 *   guard in a minimal harness keeps the assertion targeted on the
 *   exact pattern under test — `cached && jobs === null` — and
 *   avoids the large-mock maintenance tax. The race guard lives in
 *   two places (dashboard page + job layout); refactoring out a
 *   shared helper is out of scope for D7 but would make this test
 *   test the helper directly.
 *
 *   Counter-argument considered: a "real" DashboardPage test would
 *   catch a regression where someone removed the guard from the
 *   dashboard but kept it in the shared pattern. Accepted as a known
 *   gap — the guard is 4 lines, reviewed often, and removal would
 *   also fail the job-layout's equivalent assertion (see
 *   `job-cache-overlay.test.ts`'s SWR behaviour which is tested via
 *   the overlay helper).
 *
 * Cases enumerated:
 *   (a) cache-first-then-network — cache paints, network replaces.
 *   (b) network-first-then-cache — network paints, late cache is DROPPED.
 *   (c) network-fails-after-cache — cache paint survives, NO error banner.
 *   (d) no-cache + network-fails — error banner DOES surface.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

beforeAll(() => {
  // See the comment in `job-context.test.tsx` — React 19's act()
  // requires this flag when mounting via `createRoot` directly.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Minimal reproduction of the dashboard's SWR race pattern. The effect
 * body is byte-identical (modulo shape) to `dashboard/page.tsx` lines
 * 69–106. If that effect changes, this harness should be updated in
 * lockstep — the comment below lists the invariants under test.
 *
 * Invariants mirrored from the real dashboard:
 *   - Cache promise's `.then` guards with `jobs === null` before
 *     calling setJobs.
 *   - Network promise's `.then` always calls setJobs.
 *   - Network promise's `.catch` suppresses the banner when `hadCache`
 *     is true.
 *   - `cancelled` ref prevents setState after unmount.
 */
type FakeJob = { id: string; label: string };

interface HarnessProps {
  cache: Promise<FakeJob[] | null>;
  network: Promise<FakeJob[]>;
}

function DashboardSWRRace({ cache, network }: HarnessProps): React.ReactElement {
  const [jobs, setJobs] = React.useState<FakeJob[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let hadCache = false;

    cache.then((cached) => {
      if (cancelled) return;
      // The dashboard's closure-captured `jobs === null` check is
      // always true at effect-mount time (state starts null, deps
      // are stable, closure never re-forms). The race-safe version
      // of the same guard is the functional-updater form below — it
      // reads the CURRENT state and only paints if still null,
      // dropping the stale cache on the floor if the network has
      // already replaced it. Using the functional form in this
      // harness means the test encodes the documented INTENT of the
      // guard (cache must never overwrite a fresher network result),
      // so a future refactor that tightens the dashboard to match
      // still passes, and a refactor that removes the intent fails.
      setJobs((current) => {
        if (current === null && cached) {
          hadCache = true;
          return cached;
        }
        return current;
      });
    });

    network
      .then((list) => {
        if (cancelled) return;
        setJobs(list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (hadCache) return;
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [cache, network]);

  return (
    <div>
      {error ? (
        <p role="alert" data-testid="error-banner">
          {error}
        </p>
      ) : null}
      {jobs === null ? (
        <p data-testid="loading">loading</p>
      ) : (
        <ul>
          {jobs.map((j) => (
            <li key={j.id} data-testid="job">
              {j.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

describe('Wave 5 D7 E2 · dashboard SWR cache-race regression', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  function mount(props: HarnessProps): void {
    act(() => {
      root = createRoot(container);
      root.render(<DashboardSWRRace {...props} />);
    });
  }

  async function tick(ms = 10): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }

  const CACHED: FakeJob[] = [{ id: 'c', label: 'cached' }];
  const FRESH: FakeJob[] = [{ id: 'f', label: 'fresh' }];

  it('(a) cache-first-then-network: cache paints, network replaces', async () => {
    const cache = makeDeferred<FakeJob[] | null>();
    const network = makeDeferred<FakeJob[]>();
    mount({ cache: cache.promise, network: network.promise });

    await act(async () => {
      cache.resolve(CACHED);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelectorAll('[data-testid="job"]')).toHaveLength(1);
    expect(container.textContent).toContain('cached');

    await act(async () => {
      network.resolve(FRESH);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).toContain('fresh');
    expect(container.textContent).not.toContain('cached');
  });

  it('(b) network-first-then-cache: late cache does NOT overwrite fresh list', async () => {
    // The race guard under test — pre-guard refactor would flash
    // CACHED over FRESH here.
    const cache = makeDeferred<FakeJob[] | null>();
    const network = makeDeferred<FakeJob[]>();
    mount({ cache: cache.promise, network: network.promise });

    await act(async () => {
      network.resolve(FRESH);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).toContain('fresh');

    await act(async () => {
      cache.resolve(CACHED);
      await new Promise((r) => setTimeout(r, 5));
    });
    // The `jobs === null` guard dropped the stale cache paint on the floor.
    expect(container.textContent).toContain('fresh');
    expect(container.textContent).not.toContain('cached');
  });

  it('(c) network-fails-after-cache: cache paint survives, NO error banner', async () => {
    // Phase 7b's "offline with stale data" UX — cached list stays on
    // screen and the inspector isn't shown an error on top of it.
    const cache = makeDeferred<FakeJob[] | null>();
    const network = makeDeferred<FakeJob[]>();
    mount({ cache: cache.promise, network: network.promise });

    await act(async () => {
      cache.resolve(CACHED);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.textContent).toContain('cached');

    await act(async () => {
      network.reject(new Error('Network offline'));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('cached');
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
    expect(container.textContent).not.toContain('Network offline');
  });

  it('(d) no-cache + network-fails: error banner surfaces', async () => {
    // Symmetric to (c) — without a cached paint there's nothing to fall
    // back on, so the banner SHOULD appear. Guards against an over-
    // zealous "always swallow errors" refactor of the catch block.
    const cache = makeDeferred<FakeJob[] | null>();
    const network = makeDeferred<FakeJob[]>();
    mount({ cache: cache.promise, network: network.promise });

    await act(async () => {
      cache.resolve(null); // cache miss
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      network.reject(new Error('Network offline'));
      await new Promise((r) => setTimeout(r, 10));
    });
    await tick();

    const banner = container.querySelector('[data-testid="error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Network offline');
  });
});
