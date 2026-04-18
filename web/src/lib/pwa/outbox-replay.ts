'use client';

import * as React from 'react';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';
import { getCachedJob, putCachedJob } from './job-cache';
import {
  listPendingMutations,
  markMutationFailed,
  markMutationPoisoned,
  removeMutation,
  type OutboxMutation,
} from './outbox';

/**
 * Replay worker for the offline mutation outbox (Phase 7c).
 *
 * Lifecycle + trigger surface:
 *   1. Mount-time pass — covers "tab reopens while already online with
 *      pending mutations" (the common case after a subway commute).
 *   2. `online` window event — the browser's reconnection signal.
 *      Caveat: `navigator.onLine` returning true doesn't guarantee the
 *      backend is reachable (captive portals, DNS hijack). Real retry
 *      logic is driven by actual fetch failures, but the `online` edge
 *      is still the right moment to ATTEMPT — if it fails, the backoff
 *      policy kicks in.
 *   3. Self-reschedule — after a pass that left rows behind, we
 *      `setTimeout` to the earliest `nextAttemptAt`. Handles the
 *      extended-offline case where no 'online' event will fire
 *      (the browser already thought we were online the whole time and
 *      only individual fetches were failing).
 *   4. `visibilitychange` → visible — covers desktop tabs that were
 *      backgrounded during the offline period; iOS Safari throttles
 *      `setTimeout` in background tabs, so the reschedule above isn't
 *      reliable alone on mobile.
 *
 * Why stop the batch on first failure (rather than continue past it):
 *   - Captive portals + DNS blocks look like "the first request hangs
 *     then 4xx/5xxs, the next nine also hang". Pushing through the
 *     whole batch would 10× our backoff counter increment and poison
 *     otherwise-valid rows after a single outage.
 *   - FIFO ordering is a correctness guarantee for per-field
 *     last-writer-wins: a later mutation's patch intentionally
 *     overrides an earlier one on the same field. Out-of-order replay
 *     could invert that. Stopping the loop on failure preserves FIFO.
 *
 * Why mounted in AppShell (not root layout):
 *   - The worker only has meaning for authenticated sessions — the
 *     outbox rows are tied to `userId` and the API calls need an auth
 *     token. AppShell already guards the auth boundary (it's rendered
 *     only under auth-gated routes) so placing the hook here avoids
 *     needing a separate token-check gate inside the hook itself.
 *   - Cost is negligible: each AppShell remount kicks off one IDB
 *     `getAll()` on the outbox (typically <1ms) and no network call
 *     if the store is empty.
 */
export function useOutboxReplay(): void {
  // All state lives in refs so callbacks can read current values without
  // re-running the effect (which would cancel the in-flight timer and
  // restart the loop at every render).
  const cancelledRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const timeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    cancelledRef.current = false;

    async function processOnce(): Promise<void> {
      // Serialise: if a pass is already in flight, the trigger that
      // fired this call can safely exit — the in-flight pass will
      // observe any rows it added, and the post-pass reschedule will
      // trigger another cycle if needed.
      if (runningRef.current || cancelledRef.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      runningRef.current = true;
      try {
        const mutations = await listPendingMutations();
        const now = Date.now();
        for (const m of mutations) {
          if (cancelledRef.current) return;
          if (m.nextAttemptAt > now) {
            // Row is still cooling off after a prior failure — skip;
            // the reschedule at the end will wake us at the right
            // time. Don't `continue` past it into later rows because
            // FIFO ordering is required (see loop-level comment).
            break;
          }
          const outcome = await attempt(m);
          if (outcome === 'poisoned') {
            // The patch itself is permanently rejected by the server
            // (4xx). The row has been moved aside via
            // `markMutationPoisoned` so `listPendingMutations` no
            // longer returns it — skipping past it here is safe and
            // prevents a single bad patch from head-of-line-blocking
            // every subsequent queued edit.
            //
            // FIFO per-field correctness is only preserved for rows
            // targeting the same field; a poisoned row's field will
            // revert to whatever subsequent rows or the server think
            // is correct. If the inspector re-queues it from the
            // Phase 7d admin UI, it'll land at the tail of the queue
            // and behave as a fresh edit — matching iOS
            // last-writer-wins semantics.
            continue;
          }
          if (outcome === 'failed') {
            // Stop the batch — captive-portal / DNS hijack symmetry
            // and FIFO correctness both argue against pushing past
            // the first transient failure.
            break;
          }
        }
      } finally {
        runningRef.current = false;
      }

      // Reschedule if anything is still pending.
      await scheduleNext();
    }

    async function attempt(m: OutboxMutation): Promise<'ok' | 'failed' | 'poisoned'> {
      try {
        if (m.op === 'saveJob') {
          await api.saveJob(m.userId, m.jobId, m.patch);
          // Replay-success write-through: when the worker replays an
          // offline mutation, overlay the patch onto the cached
          // job-detail so the next dashboard / job-detail render
          // reflects the now-synced state. Without this the UI would
          // keep painting the pre-edit cached doc until the next
          // network fetch, making a successful replay look like the
          // edit was lost. Mirrors the queue-save-job.ts write-through
          // — kept here rather than in a shared helper because the
          // replay path only has `m.patch` (not a full JobDetail) so
          // the read-modify-write form is the only option.
          const current = await getCachedJob(m.userId, m.jobId);
          if (current) {
            void putCachedJob(m.userId, m.jobId, { ...current, ...m.patch });
          }
        }
        await removeMutation(m.id);
        return 'ok';
      } catch (err) {
        const message = errorMessage(err);
        // Split permanently-failing 4xx from the transient bucket. A
        // permanent 4xx means the patch is invalid under the current
        // server state — retrying would just 4xx again forever and
        // would head-of-line-block every later mutation. Poison the
        // row so the loop can skip past it while keeping the data
        // visible to the Phase 7d admin UI for a manual decision.
        //
        // Exclusions (must stay transient):
        //   - 401 (Unauthorized) — the auth middleware clears the
        //     cookie on 401, so the replay worker will stop firing
        //     until the inspector re-signs-in. Poisoning here would
        //     lose every pending edit simply because a token expired
        //     mid-commute.
        //   - 408 (Request Timeout) — server is telling us to retry
        //     the same request; transient by definition.
        //   - 429 (Too Many Requests) — rate-limit feedback. The
        //     replay worker's exponential backoff is the correct
        //     response (Wave 5 D7 flagged this explicitly — 429 was
        //     previously poisoning alongside 400/422 and silently
        //     dropping the inspector's edits during any server-side
        //     rate spike).
        //
        // 5xx / network / TypeError are transient — exponential
        // backoff is the right response. The inspector hasn't done
        // anything wrong; the server will be back.
        //
        // The structured error surface preserves `status` AND
        // `body` in the lastError string so `/settings/system` can
        // render actionable context (not just the bare message). D7
        // scope: "on 4xx, immediately call markMutationPoisoned
        // with {status, errorBody}" — the outbox API signature is
        // string-only for backwards compatibility with Wave 1's
        // MAX_ATTEMPTS path, so we encode the structured context as
        // a single line here.
        if (err instanceof ApiError && isPermanent4xx(err.status)) {
          const body = err.body !== null && err.body !== undefined ? safeJsonSummary(err.body) : '';
          const structured = body
            ? `HTTP ${err.status}: ${err.message} — ${body}`
            : `HTTP ${err.status}: ${err.message}`;
          await markMutationPoisoned(m.id, structured);
          return 'poisoned';
        }
        await markMutationFailed(m.id, message);
        return 'failed';
      }
    }

    async function scheduleNext(): Promise<void> {
      if (cancelledRef.current) return;
      const remaining = await listPendingMutations();
      if (remaining.length === 0) return;
      const soonest = Math.min(...remaining.map((m) => m.nextAttemptAt));
      // Floor the delay at 1s so we never hot-spin when the clock says
      // "run now" immediately after a failure that bumped nextAttemptAt.
      const delay = Math.max(1_000, soonest - Date.now());
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        void processOnce();
      }, delay);
    }

    function triggerNow(): void {
      // Cancel any pending reschedule — the new trigger wins.
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      void processOnce();
    }

    function handleOnline(): void {
      triggerNow();
    }

    function handleVisibility(): void {
      if (document.visibilityState === 'visible') triggerNow();
    }

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    // Mount-time pass — short-circuit if the document is backgrounded
    // at mount (rare, but possible on a pre-rendered tab). In that
    // case visibilitychange will fire when it foregrounds.
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      triggerNow();
    }

    return () => {
      cancelledRef.current = true;
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // Empty deps — the hook's trigger surface is entirely DOM events
    // and timers. Re-running on every render would cancel the inflight
    // timer + rebind listeners for no gain.
  }, []);
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Wave 5 D7 — which 4xx statuses are "permanent" enough to warrant
 * immediate poisoning. Pull the predicate out of the inline branch so
 * tests can target it and future protocol additions (e.g. 425 Too
 * Early, 451 Unavailable for Legal Reasons) land in one place.
 *
 * Transient exclusions (NOT poisoned, retry with backoff):
 *   - 401 Unauthorized     — token expired; auth flow handles it.
 *   - 408 Request Timeout  — server explicitly asked for a retry.
 *   - 429 Too Many Requests — rate limit; backoff is the correct
 *                             response per RFC 6585.
 */
function isPermanent4xx(status: number): boolean {
  if (status < 400 || status >= 500) return false;
  if (status === 401 || status === 408 || status === 429) return false;
  return true;
}

/**
 * Render an ApiError.body into a bounded single-line summary suitable
 * for surfacing in the Phase 7d admin UI's `Last error:` row. Keeps
 * the output short enough that IDB storage + wrapping in the card
 * don't blow up on a 2 kB validation response.
 *
 * Graceful fallbacks: non-serialisable bodies, cyclic objects, and
 * deliberately-opaque servers all degrade to `[unserialisable body]`
 * so the `markMutationPoisoned` call never fails because of this
 * helper.
 */
function safeJsonSummary(body: unknown): string {
  try {
    if (typeof body === 'string') {
      return body.length <= 160 ? body : `${body.slice(0, 160)}\u2026`;
    }
    const text = JSON.stringify(body);
    if (!text) return '';
    return text.length <= 160 ? text : `${text.slice(0, 160)}\u2026`;
  } catch {
    return '[unserialisable body]';
  }
}
