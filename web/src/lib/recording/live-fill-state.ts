/**
 * LiveFillState — tracks which JobDetail fields were recently filled by
 * Sonnet (or any other live-fill producer) so <LiveFillView> + its child
 * <LiveField> primitives can flash a brand-blue highlight that fades
 * back to transparent over ~2 seconds.
 *
 * Mirrors iOS `LiveFillState.swift`:
 *   - `recentlyUpdated` — Map<fieldKey, timestamp(ms)>. A key is "recent"
 *      if (now - ts) < windowMs (default 3000).
 *   - `lastUpdatedSection` — the section that owns the most-recent update;
 *      drives the auto-scroll effect inside <LiveFillView>.
 *   - `markUpdated(keys)` — records a batch of field-key updates at a
 *      single timestamp. Also updates `lastUpdatedSection` from the last
 *      key's prefix.
 *   - `isRecent(key)` / `isFieldRecent` — O(1) lookup used by <LiveField>.
 *   - `reset()` — clears the map on recording start/stop.
 *
 * Why a module-level singleton store instead of React context:
 *   The store is mutated from inside `useCallback`s in RecordingProvider
 *   and read by many <LiveField> leaves. A context would re-render every
 *   subscriber on every update. `useSyncExternalStore` gives each leaf
 *   an independent selector subscription so re-renders stay scoped to
 *   fields that actually flipped recency, while the store itself is
 *   singletonable across the app.
 *
 * Field-key convention (locked in Phase 5d):
 *   - Scalar section field : `section.field`     e.g. "supply.ze"
 *   - Circuit cell         : `circuit.{id}.field` e.g. "circuit.c-abc.zs"
 *   - New circuit row      : `circuit.{id}`       (the whole row)
 *   - New observation      : `observation.{id}`
 */

'use client';

import * as React from 'react';

export type LiveFillSection =
  | 'installation'
  | 'supply'
  | 'board'
  | 'circuits'
  | 'observations'
  | 'extent'
  | 'design';

/** Default freshness window for `isRecent`. Matches iOS (3s). The CSS
 *  transition in <LiveField> runs 2s; the extra 1s head-room lets the
 *  highlight linger briefly at full opacity before fading. */
const DEFAULT_WINDOW_MS = 3000;

/** Derive the section bucket for auto-scroll from a dot-path field key. */
function sectionOfKey(key: string): LiveFillSection | null {
  if (key.startsWith('circuit.')) return 'circuits';
  if (key.startsWith('observation.')) return 'observations';
  const dot = key.indexOf('.');
  if (dot === -1) return null;
  const head = key.slice(0, dot);
  if (
    head === 'installation' ||
    head === 'supply' ||
    head === 'board' ||
    head === 'extent' ||
    head === 'design'
  ) {
    return head;
  }
  return null;
}

type Snapshot = {
  /** Bumped on every mutation so useSyncExternalStore can cheaply detect
   *  a change without hashing the whole map. */
  version: number;
  lastUpdatedSection: LiveFillSection | null;
  /** Millisecond timestamp of the most-recent update — used by the
   *  auto-scroll effect as a trigger (so the scroll fires again if the
   *  same section updates twice in quick succession). */
  lastUpdatedAt: number;
};

class LiveFillStore {
  private recent = new Map<string, number>();
  private snapshot: Snapshot = { version: 0, lastUpdatedSection: null, lastUpdatedAt: 0 };
  private listeners = new Set<() => void>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.snapshot;

  /** SSR — emit a stable empty snapshot. `useSyncExternalStore` requires
   *  getServerSnapshot to return referentially-stable values. */
  getServerSnapshot = (): Snapshot => EMPTY_SNAPSHOT;

  markUpdated = (keys: string[]): void => {
    if (keys.length === 0) return;
    const now = Date.now();
    for (const key of keys) this.recent.set(key, now);
    // Use the LAST key to derive the scroll target — matches iOS which
    // sets lastUpdatedSection from the most-recent `markFieldUpdated`
    // call.
    const lastSection = sectionOfKey(keys[keys.length - 1]);
    this.snapshot = {
      version: this.snapshot.version + 1,
      lastUpdatedSection: lastSection ?? this.snapshot.lastUpdatedSection,
      lastUpdatedAt: now,
    };
    this.scheduleCleanup();
    this.emit();
  };

  /** Cheap O(1) check — used by <LiveField> in render. No state change,
   *  no cleanup side-effect; the cleanup timer below handles pruning. */
  isRecent = (key: string, windowMs: number = DEFAULT_WINDOW_MS): boolean => {
    const ts = this.recent.get(key);
    if (ts == null) return false;
    return Date.now() - ts < windowMs;
  };

  reset = (): void => {
    this.recent.clear();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.snapshot = {
      version: this.snapshot.version + 1,
      lastUpdatedSection: null,
      lastUpdatedAt: 0,
    };
    this.emit();
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Prune stale entries and bump version so subscribers re-render and
   *  the flashing stops. Bundling pruning into a single delayed sweep
   *  avoids a per-key timer storm when large extractions land. */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      const now = Date.now();
      let pruned = false;
      for (const [key, ts] of this.recent) {
        if (now - ts >= DEFAULT_WINDOW_MS) {
          this.recent.delete(key);
          pruned = true;
        }
      }
      if (pruned) {
        this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 };
        this.emit();
      }
      // If there are still recent entries, schedule another sweep.
      if (this.recent.size > 0) this.scheduleCleanup();
    }, DEFAULT_WINDOW_MS + 50);
  }
}

const EMPTY_SNAPSHOT: Snapshot = { version: 0, lastUpdatedSection: null, lastUpdatedAt: 0 };

/** Module-level singleton — the whole app shares one recency map. */
const store = new LiveFillStore();

export type LiveFillStoreHandle = {
  markUpdated: (keys: string[]) => void;
  isRecent: (key: string, windowMs?: number) => boolean;
  reset: () => void;
  lastUpdatedSection: LiveFillSection | null;
  lastUpdatedAt: number;
};

/** Hook used by <LiveFillView> + RecordingProvider. Returns a stable
 *  object whose imperative methods never change identity, plus the
 *  latest `lastUpdatedSection` / `lastUpdatedAt` so the auto-scroll
 *  effect re-runs when Sonnet fills a new section. */
export function useLiveFillStore(): LiveFillStoreHandle {
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  );
  return React.useMemo(
    () => ({
      markUpdated: store.markUpdated,
      isRecent: store.isRecent,
      reset: store.reset,
      lastUpdatedSection: snapshot.lastUpdatedSection,
      lastUpdatedAt: snapshot.lastUpdatedAt,
    }),
    [snapshot.lastUpdatedSection, snapshot.lastUpdatedAt]
  );
}

/** Per-field subscription — re-renders just the <LiveField> whose
 *  recency flipped. Internally we subscribe to the store's version
 *  counter, but the return value is only the boolean, so React's bail-
 *  out on === keeps unrelated <LiveField>s static. */
export function useIsFieldRecent(key: string, windowMs: number = DEFAULT_WINDOW_MS): boolean {
  return React.useSyncExternalStore(
    store.subscribe,
    () => store.isRecent(key, windowMs),
    () => false
  );
}

/** Direct access for non-React callers (tests, dev tools). */
export const liveFillStore = store;
