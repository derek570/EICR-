'use client';

import * as React from 'react';
import {
  listPendingMutations,
  listPoisonedMutations,
  subscribeOutboxChanges,
  type OutboxMutation,
} from './outbox';

/**
 * Snapshot of the offline mutation outbox for UI consumers (Phase 7d).
 *
 * Exposed fields:
 *   - `pending` — non-poisoned rows, FIFO order. Drives the "syncing"
 *     pill on the OfflineIndicator cluster and the pending list on the
 *     `/settings/system` admin page.
 *   - `poisoned` — rows that hit a permanent 4xx (or exhausted the
 *     attempt counter). Drives the red "N failed" indicator and the
 *     poisoned-row list on `/settings/system`.
 *   - `pendingJobIds` — set of every `jobId` that has any row in either
 *     bucket. Drives the per-row "Pending sync" chip on job cards.
 *     Poisoned rows are included here because their `jobId` is still
 *     carrying an un-synced edit; a chip nudges the inspector to open
 *     the admin page and resolve it.
 *   - `loading` — true only until the very first IDB read resolves.
 *     Consumers can use this to suppress chip/badge flicker on mount
 *     (0 → N → 0 as they re-render). Turns false after the first read,
 *     regardless of whether rows were found.
 *
 * Refresh triggers (all fire `refresh()`):
 *   1. Mount — one-shot read so the first paint has real data.
 *   2. `subscribeOutboxChanges` — any write anywhere in the same tab
 *      OR in another tab of the same origin via BroadcastChannel.
 *   3. `visibilitychange` → visible — covers the case where the replay
 *      worker drained rows while the tab was backgrounded (visibility-
 *      change fires when the inspector brings the tab forward; a stale
 *      snapshot would otherwise keep showing the old pending count
 *      until the next unrelated change).
 *
 * Why not `useSyncExternalStore`:
 *   - The store is async (IDB `getAll`), which `useSyncExternalStore`
 *     doesn't accommodate without a synchronous snapshot fallback.
 *     The imperative refresh + state combo is simpler and matches
 *     Phase 7b's SWR patterns.
 *
 * Cost:
 *   - Two `getAll()` calls per refresh. The outbox is expected to stay
 *     tiny (single-digit rows in normal use), so this is sub-millisecond.
 *     Subscriptions coalesce only loosely — if ten writes happen back-
 *     to-back, ten refreshes will fire, but each is cheap and IDB
 *     serialises them. If this ever shows up in a profile, an
 *     `requestIdleCallback` trailing-edge debounce is the right fix.
 */
export interface OutboxState {
  pending: OutboxMutation[];
  poisoned: OutboxMutation[];
  pendingJobIds: Set<string>;
  loading: boolean;
}

const EMPTY_STATE: OutboxState = {
  pending: [],
  poisoned: [],
  pendingJobIds: new Set<string>(),
  loading: true,
};

export function useOutboxState(): OutboxState & { refresh: () => void } {
  const [state, setState] = React.useState<OutboxState>(EMPTY_STATE);
  const cancelledRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    try {
      const [pending, poisoned] = await Promise.all([
        listPendingMutations(),
        listPoisonedMutations(),
      ]);
      if (cancelledRef.current) return;
      const pendingJobIds = new Set<string>();
      for (const m of pending) pendingJobIds.add(m.jobId);
      for (const m of poisoned) pendingJobIds.add(m.jobId);
      setState({ pending, poisoned, pendingJobIds, loading: false });
    } catch {
      // IDB reads in outbox.ts already swallow their own errors and
      // return []; this catch is belt-and-braces for unexpected bugs.
      if (cancelledRef.current) return;
      setState({ pending: [], poisoned: [], pendingJobIds: new Set(), loading: false });
    }
  }, []);

  React.useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const unsub = subscribeOutboxChanges(() => {
      void refresh();
    });
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refresh();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelledRef.current = true;
      unsub();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [refresh]);

  return { ...state, refresh: () => void refresh() };
}
