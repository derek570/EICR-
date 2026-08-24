/**
 * PLAN-B2 (B2-2 manual-edit machinery + B2-4 load/PDF preflight) —
 * JobProvider designation hygiene.
 *
 * Covers:
 *  - hydration-SAFE load repair: a pre-hydration cache paint is
 *    repaired for display only (never becomes a pending patch or
 *    scheduled save — the 851ba63e cache-before-hydration class);
 *  - an ACCEPTED network doc's repair persists exactly once;
 *  - confirmed-offline (networkRejected) persists via the outbox path;
 *  - the dirty-cache-vs-newer-network race: newer circuits win, are
 *    canonicalised, and NO stale pre-hydration PUT is issued;
 *  - atomic-commit contract: commitJobPatch returns the exact merged
 *    snapshot synchronously;
 *  - saveCircuitsSnapshotNow: UNCONDITIONAL full-snapshot save, synced
 *    surfaced, offline → synced:false;
 *  - the designation-draft registry: a focused draft is committed by
 *    the debounced flush, unmount, and pagehide boundaries.
 *
 * Uses the same inline-mount harness as job-context.test.tsx (RTL's CJS
 * bundle trips the React 19.2.3/19.2.4 monorepo mismatch).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobProvider, useJobContext } from '@/lib/job-context';
import { registerDesignationDraft } from '@/lib/designation-drafts';
import type { JobDetail } from '@/lib/types';

const saveCalls: Array<{ patch: Partial<JobDetail> }> = [];
let nextSynced = true;
let saveShouldThrow: Error | null = null;

vi.mock('@/lib/pwa/queue-save-job', () => ({
  queueSaveJob: vi.fn(async (_userId: string, _jobId: string, patch: Partial<JobDetail>) => {
    if (saveShouldThrow) throw saveShouldThrow;
    saveCalls.push({ patch });
    return { queued: true, synced: nextSynced, mutationId: 'm1' };
  }),
}));

vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-1', email: 'derek@example.com' }),
}));

const dirtyJob = (updatedAt = '2026-08-23T00:00:00Z'): JobDetail =>
  ({
    id: 'job-1',
    status: 'pending',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: updatedAt,
    certificate_type: 'EICR',
    circuits: [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Cooker' },
    ],
  }) as unknown as JobDetail;

interface Harness {
  unmount: () => void;
  rerender: (initial: JobDetail, hydrated: boolean, networkRejected?: boolean) => void;
  ctxRef: React.MutableRefObject<ReturnType<typeof useJobContext> | null>;
}

function mountProvider(initial: JobDetail, hydrated: boolean, networkRejected = false): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctxRef: Harness['ctxRef'] = { current: null };
  let root: Root | null = null;

  const Probe: React.FC = () => {
    const ctx = useJobContext();
    React.useLayoutEffect(() => {
      ctxRef.current = ctx;
    });
    return null;
  };

  const renderWith = (doc: JobDetail, hyd: boolean, rejected = false) => {
    act(() => {
      if (!root) root = createRoot(container);
      root.render(
        <JobProvider initial={doc} hydrated={hyd} networkRejected={rejected}>
          <Probe />
        </JobProvider>
      );
    });
  };
  renderWith(initial, hydrated, networkRejected);

  return {
    ctxRef,
    rerender: (doc, hyd, rejected = false) => renderWith(doc, hyd, rejected),
    unmount: () => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  saveCalls.length = 0;
  nextSynced = true;
  saveShouldThrow = null;
});

afterEach(() => {
  vi.useRealTimers();
});

const designationOf = (h: Harness, ref: string): unknown =>
  ((h.ctxRef.current!.job.circuits ?? []) as Array<Record<string, unknown>>).find(
    (c) => c.circuit_ref === ref
  )?.circuit_designation;

const flushDebounce = async () => {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    // allow queued microtasks (flushSave awaits) to settle
    await Promise.resolve();
  });
};

describe('B2-4 load-boundary repair — hydration safety', () => {
  it('hydrated doc: display repaired AND repair persisted exactly once', async () => {
    const h = mountProvider(dirtyJob(), true);
    expect(designationOf(h, '1')).toBe('Upstairs lighting');
    await flushDebounce();
    expect(saveCalls).toHaveLength(1);
    const circuits = saveCalls[0].patch.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].circuit_designation).toBe('Upstairs lighting');
    // Re-render same doc — no second enqueue (per-version tag).
    h.rerender(dirtyJob(), true);
    await flushDebounce();
    expect(saveCalls).toHaveLength(1);
    h.unmount();
  });

  it('pre-hydration cache paint: repaired for display, NEVER saved', async () => {
    const h = mountProvider(dirtyJob(), false);
    expect(designationOf(h, '1')).toBe('Upstairs lighting');
    await flushDebounce();
    expect(saveCalls).toHaveLength(0);
    expect(h.ctxRef.current!.isDirty).toBe(false);
    h.unmount();
  });

  it('confirmed-offline (networkRejected): cache repair persists via the outbox path', async () => {
    const h = mountProvider(dirtyJob(), false);
    await flushDebounce();
    expect(saveCalls).toHaveLength(0);
    // Network fetch fails → layout flips networkRejected.
    h.rerender(dirtyJob(), false, true);
    await flushDebounce();
    expect(saveCalls).toHaveLength(1);
    const circuits = saveCalls[0].patch.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].circuit_designation).toBe('Upstairs lighting');
    h.unmount();
  });

  it('race: dirty cache then newer network circuits — newer wins, canonicalised, no stale PUT', async () => {
    // Cache paints a doc whose circuits are BOTH dirty and stale.
    const cacheDoc = dirtyJob('2026-08-20T00:00:00Z');
    const h = mountProvider(cacheDoc, false);
    expect(designationOf(h, '1')).toBe('Upstairs lighting');
    await flushDebounce();
    expect(saveCalls).toHaveLength(0); // nothing PUT pre-hydration

    // Network lands: newer updated_at, different (still dirty) circuits.
    const networkDoc = {
      ...dirtyJob('2026-08-23T12:00:00Z'),
      circuits: [{ id: 'c9', circuit_ref: '1', circuit_designation: 'Kitchen ring circuit' }],
    } as unknown as JobDetail;
    h.rerender(networkDoc, true);
    // Newer network circuits replaced the cache — canonicalised.
    expect(designationOf(h, '1')).toBe('Kitchen ring');
    await flushDebounce();
    // Exactly ONE save — the repaired NETWORK snapshot, not the cache.
    expect(saveCalls).toHaveLength(1);
    const circuits = saveCalls[0].patch.circuits as Array<Record<string, unknown>>;
    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_designation).toBe('Kitchen ring');
    h.unmount();
  });

  it('clean hydrated doc: no repair save at all', async () => {
    const clean = {
      ...dirtyJob(),
      circuits: [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' }],
    } as unknown as JobDetail;
    const h = mountProvider(clean, true);
    await flushDebounce();
    expect(saveCalls).toHaveLength(0);
    h.unmount();
  });
});

describe('B2-2 atomic-commit contract', () => {
  it('commitJobPatch returns the exact merged snapshot synchronously', () => {
    const h = mountProvider(dirtyJob(), true);
    let snapshot: JobDetail | null = null;
    act(() => {
      snapshot = h.ctxRef.current!.commitJobPatch({
        circuits: [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Garage' }],
      } as Partial<JobDetail>);
    });
    const rows = (snapshot!.circuits ?? []) as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Garage');
    h.unmount();
  });

  it('saveCircuitsSnapshotNow is UNCONDITIONAL and surfaces synced', async () => {
    // Clean doc → no pending patch, no draft — the save must still fire
    // with the full circuits snapshot.
    const clean = {
      ...dirtyJob(),
      circuits: [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' }],
    } as unknown as JobDetail;
    const h = mountProvider(clean, true);
    let result: { synced: boolean } | null = null;
    await act(async () => {
      result = await h.ctxRef.current!.saveCircuitsSnapshotNow();
    });
    expect(result!.synced).toBe(true);
    expect(saveCalls).toHaveLength(1);
    const circuits = saveCalls[0].patch.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].circuit_designation).toBe('Cooker');
    h.unmount();
  });

  it('saveCircuitsSnapshotNow reports synced:false when the write only reached the outbox', async () => {
    nextSynced = false;
    const h = mountProvider(dirtyJob(), true);
    let result: { synced: boolean } | null = null;
    await act(async () => {
      result = await h.ctxRef.current!.saveCircuitsSnapshotNow();
    });
    expect(result!.synced).toBe(false);
    h.unmount();
  });
});

describe('B2-2 designation-draft registry boundaries', () => {
  it('a focused draft is committed by the debounced flush (typing pause > debounce)', async () => {
    const h = mountProvider(dirtyJob(), true);
    await flushDebounce(); // drain the load-repair save
    saveCalls.length = 0;

    // Simulate a surface holding a focused draft: the commit closure
    // canonicalises and commits through commitJobPatch (the atomic
    // path), exactly as the edit surfaces do.
    act(() => {
      registerDesignationDraft('test:c2', () => {
        const ctx = h.ctxRef.current!;
        const rows = (ctx.job.circuits ?? []) as Array<Record<string, unknown>>;
        ctx.commitJobPatch({
          circuits: rows.map((r) =>
            r.circuit_ref === '2' ? { ...r, circuit_designation: 'Sockets' } : r
          ),
        } as Partial<JobDetail>);
      });
      // A keystroke elsewhere schedules the debounced save.
      h.ctxRef.current!.updateJob({ status: 'in_progress' } as Partial<JobDetail>);
    });
    await flushDebounce();
    expect(saveCalls).toHaveLength(1);
    const circuits = saveCalls[0].patch.circuits as Array<Record<string, unknown>>;
    expect(circuits.find((c) => c.circuit_ref === '2')?.circuit_designation).toBe('Sockets');
    h.unmount();
  });

  it('a focused draft is committed on unmount (navigation)', async () => {
    const h = mountProvider(dirtyJob(), true);
    await flushDebounce();
    saveCalls.length = 0;
    let committed = false;
    act(() => {
      registerDesignationDraft('test:c2', () => {
        committed = true;
        const ctx = h.ctxRef.current!;
        ctx.commitJobPatch({ status: 'in_progress' } as Partial<JobDetail>);
      });
    });
    h.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(committed).toBe(true);
    expect(saveCalls).toHaveLength(1);
  });

  it('a focused draft is committed on pagehide (backgrounding)', async () => {
    const h = mountProvider(dirtyJob(), true);
    await flushDebounce();
    saveCalls.length = 0;
    let committed = false;
    act(() => {
      registerDesignationDraft('test:c1', () => {
        committed = true;
        h.ctxRef.current!.commitJobPatch({ status: 'in_progress' } as Partial<JobDetail>);
      });
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    expect(committed).toBe(true);
    expect(saveCalls).toHaveLength(1);
    h.unmount();
  });
});
