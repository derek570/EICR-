/**
 * Wave 5 D7 (E1/E2) — `JobProvider.updateJob` stale-closure regression.
 *
 * Scope (FIX_PLAN.md section E E1 rows for job-context.tsx):
 *   (a) `updateJob(fn)` merges against the latest state — proves the
 *       functional-updater contract the Wave 1 P0-2 fix introduced.
 *   (b) Rapid successive updates don't clobber — the canonical
 *       "two CCU / document-extraction / observation races back-to-
 *       back" scenario that used to lose half the merges pre-P0-2.
 *   (c) Re-providing `initial` with the same `id` does NOT reset
 *       `isDirty` — the dashboard's cache-then-hydrate pattern
 *       re-provides a fresh object identity every fetch; if
 *       JobProvider naively keyed its sync on reference equality,
 *       the inspector's in-flight edits would be clobbered every
 *       time the network round-trip lands.
 *   (d) Re-providing `initial` with a NEW `id` DOES reset
 *       `isDirty` — navigating from job A to job B must not carry
 *       job A's dirty flag into job B's provider.
 *
 * Why `mountHook` (not RTL `renderHook`):
 *   See the comment in `outbox-replay.integration.test.tsx` — the
 *   monorepo-root-hoisted React 19.2.3 vs web's 19.2.4 mismatch
 *   produces "Invalid hook call" if RTL's CJS bundle is in the
 *   import graph. Doing the mount inline here means only this test
 *   file depends on `react` / `react-dom/client`, both of which
 *   resolve via Vite to web's 19.2.4 in lockstep with the hook.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { JobProvider, useJobContext } from '@/lib/job-context';
import type { JobDetail } from '@/lib/types';

const BASE_A: JobDetail = {
  id: 'job-A',
  address: '1 Test Road',
  status: 'pending',
  created_at: '2026-04-18T00:00:00Z',
  certificate_type: 'EICR',
};

const BASE_B: JobDetail = {
  id: 'job-B',
  address: '2 Other Road',
  status: 'pending',
  created_at: '2026-04-18T00:00:00Z',
  certificate_type: 'EIC',
};

/**
 * Render a `JobProvider` with a child that captures the context value
 * via a ref. Each invocation of `render(...)` rerenders with a new
 * `initial` prop, letting us drive the "re-provide" cases.
 */
interface Harness {
  unmount: () => void;
  rerender: (initial: JobDetail) => void;
  ctxRef: React.MutableRefObject<ReturnType<typeof useJobContext> | null>;
}

function mountProvider(initial: JobDetail): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctxRef: Harness['ctxRef'] = { current: null };
  let root: Root | null = null;

  const Probe: React.FC = () => {
    // `react-hooks/immutability` (React 19.2 compiler plugin) forbids
    // mutating a variable captured from an outer scope during render.
    // The plain `ctxRef.current = useJobContext()` trips it. Writing
    // the capture inside a layout effect is semantically equivalent
    // for our purposes — the effect runs synchronously after commit,
    // so by the time `act(...)` returns control to the test the ref
    // holds the latest context value.
    const ctx = useJobContext();
    React.useLayoutEffect(() => {
      ctxRef.current = ctx;
    });
    return null;
  };

  const Host: React.FC<{ value: JobDetail }> = ({ value }) => (
    <JobProvider initial={value}>
      <Probe />
    </JobProvider>
  );

  act(() => {
    root = createRoot(container);
    root.render(<Host value={initial} />);
  });

  return {
    unmount: () => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
    rerender: (next) => {
      act(() => {
        root?.render(<Host value={next} />);
      });
    },
    ctxRef,
  };
}

describe('Wave 5 D7 E1 · JobProvider.updateJob stale-closure contract (P0-2 regression)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = mountProvider(BASE_A);
  });

  afterEach(() => {
    harness.unmount();
  });

  it('(a) updateJob(fn) merges against the freshest snapshot', () => {
    const ctx = harness.ctxRef.current;
    expect(ctx).not.toBeNull();

    act(() => {
      ctx!.updateJob({ address: 'updated once' });
    });
    expect(harness.ctxRef.current?.job.address).toBe('updated once');

    // Functional form — must see the just-written value, not the
    // stale-at-capture-time snapshot.
    act(() => {
      harness.ctxRef.current!.updateJob((prev) => ({
        address: `${prev.address} + twice`,
      }));
    });
    expect(harness.ctxRef.current?.job.address).toBe('updated once + twice');
  });

  it('(b) rapid successive functional updates compose correctly', () => {
    // The pre-P0-2 failure mode: three async handlers all capture the
    // same `job` snapshot and each write their own patch against it,
    // clobbering the two earlier writes. The functional form is the
    // fix; this test enumerates the three-updater race.
    act(() => {
      const ctx = harness.ctxRef.current!;
      ctx.updateJob((prev) => ({ address: `${prev.address}/1` }));
      ctx.updateJob((prev) => ({ address: `${prev.address}/2` }));
      ctx.updateJob((prev) => ({ address: `${prev.address}/3` }));
    });
    expect(harness.ctxRef.current?.job.address).toBe('1 Test Road/1/2/3');
    expect(harness.ctxRef.current?.isDirty).toBe(true);
  });

  it('(c) re-providing initial with the SAME id does not clobber local edits or reset isDirty', () => {
    // Dashboard's cache-then-hydrate pattern: same job, fresh object
    // identity. Wave 1 P0-2 guarded against the naive sync that would
    // overwrite the inspector's in-flight changes on every fetch.
    act(() => {
      harness.ctxRef.current!.updateJob({ address: 'inspector wrote this' });
    });
    expect(harness.ctxRef.current?.isDirty).toBe(true);

    // Rerender with a semantically-equal but identity-distinct initial.
    const refetched: JobDetail = { ...BASE_A, address: 'server fetched value' };
    harness.rerender(refetched);

    // Inspector's edit survived; dirty flag preserved.
    expect(harness.ctxRef.current?.job.address).toBe('inspector wrote this');
    expect(harness.ctxRef.current?.isDirty).toBe(true);
  });

  it('(d) re-providing initial with a NEW id resets state + clears isDirty', () => {
    // Navigating from job A to job B is the one case where we MUST
    // clobber — carrying A's dirty flag into B would be a correctness
    // bug (inspector saved nothing on B but the floating action bar
    // would say "unsaved changes").
    act(() => {
      harness.ctxRef.current!.updateJob({ address: 'edited A' });
    });
    expect(harness.ctxRef.current?.isDirty).toBe(true);

    harness.rerender(BASE_B);
    expect(harness.ctxRef.current?.job.id).toBe('job-B');
    expect(harness.ctxRef.current?.job.address).toBe(BASE_B.address);
    expect(harness.ctxRef.current?.isDirty).toBe(false);
  });
});
