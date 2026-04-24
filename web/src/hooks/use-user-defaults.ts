'use client';

import * as React from 'react';
import { api } from '@/lib/api-client';
import { openDB, isSupported, wrapRequest, wrapTransaction } from '@/lib/pwa/job-cache';

/**
 * Phase 6 — user circuit-field defaults with IDB read-through cache.
 *
 * Mirrors iOS `DefaultsService.defaults` on the settings side + the
 * offline-available local copy the Circuits tab reads when the user
 * taps "Apply Defaults" without a live connection. The schema slot
 * lives in the shared `app-settings` store (same DB as tour state) so
 * we don't bump the IDB version just for one key.
 *
 * Key invariants:
 *   1. Cached read is preferred on first paint so the settings page
 *      doesn't flash "empty defaults" while the network catches up.
 *      Network fetch still fires in parallel and overwrites the cache
 *      on success — last-writer-wins with the network as the truth.
 *   2. Saves go to the network first. On success we write-through to
 *      IDB so offline "Apply Defaults" immediately reflects the edit.
 *      If the save fails, the IDB cache is left untouched — we don't
 *      want a local edit to look persisted when it actually bounced.
 *   3. When `userId` is undefined (logged-out or still loading), the
 *      hook yields an empty map so Circuits can always thread
 *      `userDefaults` into `applyDefaultsToCircuits` without a null
 *      guard at every call site.
 *
 * Usage:
 * ```
 * const { defaults, save, loading } = useUserDefaults(user?.id);
 * applyDefaultsToCircuits(circuits, { userDefaults: defaults });
 * ```
 */

export type UserDefaults = Record<string, string>;

const STORE_APP_SETTINGS = 'app-settings';
// Per-user cache keys so shared-device installs don't collide. When
// inspector B logs in, their defaults land in a separate row and the
// next time inspector A opens Settings offline, `readCachedDefaults(A)`
// still resolves A's map instead of returning null.
const keyForUser = (userId: string) => `user-defaults:${userId}`;

interface SettingsRow {
  key: string;
  value: { userId: string; defaults: UserDefaults } | null;
}

async function readCachedDefaults(userId: string): Promise<UserDefaults | null> {
  if (!isSupported()) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_APP_SETTINGS, 'readonly');
    const store = tx.objectStore(STORE_APP_SETTINGS);
    const row = (await wrapRequest(store.get(keyForUser(userId)))) as SettingsRow | null;
    if (!row || !row.value) return null;
    return row.value.defaults;
  } catch (err) {
    console.warn('[use-user-defaults] readCachedDefaults failed', err);
    return null;
  }
}

async function writeCachedDefaults(userId: string, defaults: UserDefaults): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_APP_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_APP_SETTINGS);
    const row: SettingsRow = {
      key: keyForUser(userId),
      value: { userId, defaults },
    };
    store.put(row);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[use-user-defaults] writeCachedDefaults failed', err);
  }
}

export interface UseUserDefaultsResult {
  defaults: UserDefaults;
  loading: boolean;
  error: string | null;
  /**
   * Persist a new defaults map. Network first, IDB write-through on
   * success. Re-throws the network error so the caller can surface it
   * inline (the settings save button needs the error; Circuits never
   * calls save directly so never sees the throw).
   */
  save: (next: UserDefaults) => Promise<void>;
  /** Re-read from the network, skipping the cache. Used by settings pages on mount. */
  refresh: () => Promise<void>;
}

export function useUserDefaults(userId: string | undefined): UseUserDefaultsResult {
  const [defaults, setDefaults] = React.useState<UserDefaults>({});
  const [loading, setLoading] = React.useState<boolean>(Boolean(userId));
  const [error, setError] = React.useState<string | null>(null);

  const userIdRef = React.useRef(userId);
  React.useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const load = React.useCallback(
    async (preferNetworkOnly: boolean) => {
      if (!userId) {
        setDefaults({});
        setLoading(false);
        return;
      }
      setError(null);
      setLoading(true);

      // 1. Show the cached copy first for instant paint.
      if (!preferNetworkOnly) {
        const cached = await readCachedDefaults(userId);
        if (cached && userIdRef.current === userId) {
          setDefaults(cached);
        }
      }

      // 2. Network fetch — overwrites cache if different.
      try {
        const fresh = await api.userDefaults(userId);
        const normalised: UserDefaults =
          fresh && typeof fresh === 'object' && !Array.isArray(fresh)
            ? (fresh as UserDefaults)
            : {};
        if (userIdRef.current === userId) {
          setDefaults(normalised);
        }
        await writeCachedDefaults(userId, normalised);
      } catch (err) {
        // Keep the cached copy if the network fetch failed. Surface the
        // error so the settings page can show a banner; Circuits can
        // ignore it since it still has a usable defaults map.
        if (userIdRef.current === userId) {
          setError(err instanceof Error ? err.message : 'Failed to load defaults');
        }
      } finally {
        if (userIdRef.current === userId) {
          setLoading(false);
        }
      }
    },
    [userId]
  );

  React.useEffect(() => {
    void load(false);
  }, [load]);

  const save = React.useCallback(
    async (next: UserDefaults) => {
      if (!userId) throw new Error('No signed-in user');
      setError(null);
      try {
        await api.saveUserDefaults(userId, next);
        setDefaults(next);
        await writeCachedDefaults(userId, next);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to save defaults';
        setError(message);
        throw err;
      }
    },
    [userId]
  );

  const refresh = React.useCallback(() => load(true), [load]);

  return { defaults, loading, error, save, refresh };
}
