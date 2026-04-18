/**
 * Wave 3a — MSW-backed integration tests for the offline replay worker.
 *
 * Scope (FIX_PLAN §D D6 + D7, §E E2 — replay-path subset):
 *   1. Happy path       — offline enqueue + online replay flushes + cache warms
 *   2. 4xx poison       — 422 → row poisoned (not retried) + rest drains
 *   3. 5xx backoff      — 503 → `nextAttemptAt` pushed forward + attempts+=1
 *   4. Sign-out drop    — unmount-cancel stops the loop at the current row
 *   5. FIFO order       — two rows for the same jobId replay in enqueue order
 *
 * Why this surface:
 *   `outbox-replay.ts` is the single point where offline edits become
 *   server writes. A regression here loses inspector data — an EICR
 *   observation toggled while offline that never replays is a silent
 *   data-loss bug. Unit tests on `outbox.ts` prove the state machine
 *   transitions; these MSW tests prove the fetch-level contract the
 *   replay worker actually runs in production.
 *
 * Why `renderHook` + real timers (mostly):
 *   The replay worker is a React hook (`useOutboxReplay`) that wires
 *   its triggers to `window.addEventListener('online')` +
 *   `document.addEventListener('visibilitychange')` + a mount-time
 *   pass. There's no headless export to drive directly. `renderHook`
 *   from RTL mounts the hook in jsdom, the mount-pass runs, and the
 *   actual fetch goes through MSW's node interceptor to return the
 *   canned JSON. We poll IDB state via the real outbox APIs (not
 *   private internals) so the tests are self-documenting regressions.
 *
 *   Fake timers aren't used globally because MSW + undici + jsdom rely
 *   on microtasks scheduled by real `queueMicrotask` / `Promise.resolve`
 *   — interposing fake timers can starve them and hang the run. Only
 *   the 5xx backoff test briefly installs fake timers and restores
 *   immediately; it asserts `nextAttemptAt` is pushed forward, not
 *   that the reschedule timer fires (which would require advancing the
 *   clock in lockstep with the hook's `setTimeout`).
 *
 * Fixtures:
 *   Responses are validated against adapter schemas (Wave 2b)
 *   — `SaveJobResponseSchema`, `JobDetailSchema` — so drift from the
 *   wire shape breaks the test rather than silently passing.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { JobDetailSchema, SaveJobResponseSchema } from '@/lib/adapters';
import { useOutboxReplay } from '@/lib/pwa/outbox-replay';
import {
  enqueueSaveJobMutation,
  listPendingMutations,
  listPoisonedMutations,
  purgeOutbox,
} from '@/lib/pwa/outbox';
import { getCachedJob, putCachedJob, clearJobCache } from '@/lib/pwa/job-cache';
import type { JobDetail } from '@/lib/types';

import { TEST_API_BASE, createTestServer } from './msw-server';

/**
 * Canonical success payload for `PUT /api/job/:userId/:jobId`. Runs
 * through the adapter schema so the fixture has to stay in lockstep
 * with the wire shape the client actually parses.
 */
const SAVE_OK = SaveJobResponseSchema.parse({ success: true });

/**
 * Minimal JobDetail fixture — permissive tab bags mean we only need
 * the required envelope fields to round-trip through `JobDetailSchema`.
 * Validated at build time so a schema change here fails loud.
 */
const BASE_JOB: JobDetail = JobDetailSchema.parse({
  id: 'job-1',
  address: '1 Test Road',
  status: 'pending',
  created_at: '2026-04-18T00:00:00Z',
  certificate_type: 'EICR',
  installation: { postcode: 'SW1A 1AA' },
}) as unknown as JobDetail;

/**
 * Tiny `renderHook` replacement. We can't use
 * `@testing-library/react`'s `renderHook` because RTL is hoisted to
 * the monorepo root's `node_modules` and its `require('react')` picks
 * up the root-hoisted React (19.2.3) rather than web's (19.2.4) —
 * `vitest.config.ts`'s alias only rewrites imports that go through
 * Vite's transform pipeline, which RTL's CJS bundle bypasses. The
 * result is two React instances and every `useRef` call blows up
 * "Invalid hook call".
 *
 * Doing the mount here means the test file itself is the only
 * consumer of `react` + `react-dom/client` — both go through Vite
 * and resolve to web's 19.2.4 in lockstep with the hook under test.
 */
function mountHook(hook: () => void): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    const Host: React.FC = () => {
      hook();
      return null;
    };
    root.render(<Host />);
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Poll the outbox until a predicate holds or a deadline is hit. The
 * replay worker is async end-to-end (IDB → fetch → IDB), so synchronous
 * assertions immediately after `mountHook()` race the worker. Poll
 * rather than waiting on a DOM event — we want to observe state in
 * our own store (IDB), not the DOM.
 *
 * 2s ceiling is comfortably above the expected sub-50ms worst case and
 * will still fail loud if the loop ever hangs.
 */
async function waitForOutbox(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitForOutbox timed out: ${label}`);
}

/**
 * Per-test cache + outbox wipe so IDB state from one case can't leak
 * into the next. Poisoned rows in particular survive `purgeOutbox`'s
 * sibling `listPendingMutations()` so we must wipe both stores.
 */
beforeEach(async () => {
  await purgeOutbox();
  await clearJobCache();
});

const server = createTestServer();

describe('Wave 3a · replay worker · MSW integration', () => {
  it('1. happy path — replays queued mutation, clears outbox, warms cache', async () => {
    // Seed the read-through cache so the write-through has something
    // to overlay the patch onto (mirrors the real navigation sequence:
    // user opens job → cache populated → goes offline → edits → online).
    await putCachedJob('u1', 'job-1', BASE_JOB);

    await enqueueSaveJobMutation('u1', 'job-1', { address: '2 New Road' });

    let received: unknown = null;
    server.use(
      http.put(`${TEST_API_BASE}/api/job/u1/job-1`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(SAVE_OK);
      })
    );

    mountHook(() => useOutboxReplay());

    await waitForOutbox(async () => (await listPendingMutations()).length === 0, 'outbox drained');

    expect(received).toEqual({ address: '2 New Road' });

    const cached = await getCachedJob('u1', 'job-1');
    expect(cached).not.toBeNull();
    // Write-through overlays the patch on the cached doc.
    expect(cached?.address).toBe('2 New Road');
    // Unrelated cached fields survive the overlay.
    expect((cached as unknown as { installation?: Record<string, unknown> })?.installation).toEqual(
      { postcode: 'SW1A 1AA' }
    );
  });

  it('2. 4xx poison — 422 row moved to poisoned, later row still replays', async () => {
    // Enqueue the doomed mutation first so it sits at the head of the
    // FIFO queue — head-of-line blocking would be the pre-P0-12
    // regression this guards against.
    const bad = await enqueueSaveJobMutation('u1', 'job-1', { address: 'invalid' });
    await new Promise((r) => setTimeout(r, 2)); // distinct createdAt
    await enqueueSaveJobMutation('u1', 'job-2', { address: 'good' });

    let goodReceived = false;
    server.use(
      http.put(`${TEST_API_BASE}/api/job/u1/job-1`, () => {
        return HttpResponse.json({ error: 'validation failed' }, { status: 422 });
      }),
      http.put(`${TEST_API_BASE}/api/job/u1/job-2`, () => {
        goodReceived = true;
        return HttpResponse.json(SAVE_OK);
      })
    );

    mountHook(() => useOutboxReplay());

    // The good row only replays once the bad row is poisoned + skipped.
    await waitForOutbox(async () => (await listPendingMutations()).length === 0, 'queue drained');

    const poisoned = await listPoisonedMutations();
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0].id).toBe(bad.id);
    expect(poisoned[0].poisoned).toBe(true);
    // Poisoning bypasses the attempt counter entirely — 4xx is
    // permanent, not a transient retry. Count must stay at 0.
    expect(poisoned[0].attempts).toBe(0);
    expect(poisoned[0].lastError).toMatch(/HTTP 422/);

    expect(goodReceived).toBe(true);
  });

  it('3. 5xx backoff — 503 increments attempts + pushes nextAttemptAt forward', async () => {
    const seed = await enqueueSaveJobMutation('u1', 'job-1', { address: 'retry me' });
    const seedRows = await listPendingMutations();
    const originalNextAttemptAt = seedRows[0].nextAttemptAt;

    let hitCount = 0;
    server.use(
      http.put(`${TEST_API_BASE}/api/job/u1/job-1`, () => {
        hitCount += 1;
        return HttpResponse.json({ error: 'upstream down' }, { status: 503 });
      })
    );

    // We considered `vi.useFakeTimers()` here (per the Wave 3a spec),
    // but the polling `waitForOutbox` helper itself depends on
    // `setTimeout`, so faking the timer base starves every async
    // helper in the test. Instead we rely on `outbox.ts`'s
    // `BASE_BACKOFF_MS = 2_000` — the hook's reschedule happens at
    // `Math.max(1_000, nextAttemptAt - now)` ≥ 1s, comfortably past
    // our assertion window (≤100ms of polling). `hitCount === 1` at
    // the end proves no second pass slipped through.
    const handle = mountHook(() => useOutboxReplay());

    await waitForOutbox(async () => {
      const rows = await listPendingMutations();
      return rows.length === 1 && rows[0].attempts === 1;
    }, '503 attempt recorded');

    const rowsAfter = await listPendingMutations();
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(seed.id);
    expect(rowsAfter[0].attempts).toBe(1);
    expect(rowsAfter[0].nextAttemptAt).toBeGreaterThan(originalNextAttemptAt);
    expect(rowsAfter[0].lastError).toMatch(/HTTP 503/);
    // Not poisoned — 5xx is transient.
    expect(rowsAfter[0].poisoned).toBeFalsy();
    // Single HTTP hit; api-client's idempotent-method retry doesn't
    // apply to PUT, so one 503 is exactly one attempt.
    expect(hitCount).toBe(1);

    // Unmount first so the hook's reschedule timer is cleared before
    // the test exits (otherwise the 1s+ reschedule would fire during
    // a later test and hit MSW with a stale handler).
    handle.unmount();
  });

  it('4. sign-out / unmount — mid-flight unmount leaves trailing rows untouched', async () => {
    // Two queued mutations; the first is deliberately slow so we can
    // unmount while it's in flight and observe the second row NOT
    // getting picked up.
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'first' });
    await new Promise((r) => setTimeout(r, 2));
    await enqueueSaveJobMutation('u1', 'job-2', { address: 'second' });

    let secondCalled = false;
    // Gate the first response on a deferred — the unmount fires while
    // the fetch is still awaiting, exercising the cancelledRef edge.
    // `deferred` is initialised synchronously inside the Promise ctor
    // so the non-null assertion on the closure capture is safe; we
    // don't use `let … | null = null` because TS's CFA then narrows
    // the outer binding to `never` even though the executor mutates
    // it before the constructor returns.
    const deferred: { resolve: () => void } = { resolve: () => {} };
    const firstInFlight = new Promise<void>((resolve) => {
      deferred.resolve = resolve;
    });

    server.use(
      http.put(`${TEST_API_BASE}/api/job/u1/job-1`, async () => {
        await firstInFlight;
        return HttpResponse.json(SAVE_OK);
      }),
      http.put(`${TEST_API_BASE}/api/job/u1/job-2`, () => {
        secondCalled = true;
        return HttpResponse.json(SAVE_OK);
      })
    );

    const handle = mountHook(() => useOutboxReplay());

    // Let the worker enter the first fetch. `runningRef` will be true
    // but the fetch is parked on `firstInFlight`.
    await new Promise((r) => setTimeout(r, 20));

    // Unmount simulates sign-out (`AppShell` goes away, hook cleanup
    // sets cancelledRef). Then release the first fetch so the in-flight
    // promise settles; the loop should observe cancelledRef and stop
    // before advancing to row 2.
    handle.unmount();
    deferred.resolve();

    // Give the settled first fetch + any trailing microtasks time to
    // finish before we assert. The cancelledRef guard in processOnce
    // will short-circuit the for-loop's next iteration.
    await new Promise((r) => setTimeout(r, 50));

    expect(secondCalled).toBe(false);
    const remaining = await listPendingMutations();
    // Row 2 is untouched. Row 1's state depends on whether the in-
    // flight promise had time to call `removeMutation` before unmount —
    // either outcome is acceptable for sign-out semantics; what we
    // guarantee is row 2 hasn't been touched.
    const row2 = remaining.find((m) => m.jobId === 'job-2');
    expect(row2).toBeDefined();
    expect(row2?.attempts).toBe(0);
  });

  it('5. FIFO order — two rows for the same jobId replay in enqueue order', async () => {
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'first' });
    await new Promise((r) => setTimeout(r, 2));
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'second' });

    const addressesSeen: string[] = [];
    server.use(
      http.put(`${TEST_API_BASE}/api/job/u1/job-1`, async ({ request }) => {
        const body = (await request.json()) as { address: string };
        addressesSeen.push(body.address);
        return HttpResponse.json(SAVE_OK);
      })
    );

    mountHook(() => useOutboxReplay());

    await waitForOutbox(async () => addressesSeen.length === 2, 'both replays landed');

    expect(addressesSeen).toEqual(['first', 'second']);

    const pending = await listPendingMutations();
    expect(pending).toHaveLength(0);
  });
});
