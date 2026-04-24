/**
 * Phase 6 — user defaults hook.
 *
 * We exercise the hook via a tiny inline `mountHook` (same pattern as
 * `outbox-replay.integration.test.tsx`) rather than RTL's `renderHook`
 * because RTL resolves its bundled React from the monorepo-root
 * `node_modules` — that's a different module instance to web's
 * 19.2.4, and the dual-copy hazard turns every `useState` call into
 * "Cannot read properties of null (reading 'useState')".
 *
 * Contracts exercised:
 *   1. Hydrate from the backend on mount; `loading` flips to false
 *      when the network fetch resolves.
 *   2. `save()` persists to IDB on success so offline mounts still see
 *      the user's custom defaults.
 *   3. A failing save throws, leaves local state untouched, and
 *      crucially does NOT overwrite the IDB cache (so the next mount
 *      doesn't read a value that was never actually persisted
 *      server-side).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userDefaultsMock = vi.fn();
const saveUserDefaultsMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    userDefaults: (userId: string) => userDefaultsMock(userId),
    saveUserDefaults: (userId: string, defaults: Record<string, string>) =>
      saveUserDefaultsMock(userId, defaults),
  },
}));

import { useUserDefaults } from '@/hooks/use-user-defaults';
import { openDB, STORE_APP_SETTINGS } from '@/lib/pwa/job-cache';

interface HookValue {
  defaults: Record<string, string>;
  loading: boolean;
  error: string | null;
  save: (next: Record<string, string>) => Promise<void>;
}

function mountHook(userId: string | undefined): {
  current: () => HookValue;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // Ref box so the Host component can write the latest hook value
  // without reassigning a closed-over let (react-hooks lint rule).
  // Test-only escape hatch — we capture the hook's return value so
  // assertions can read it after `act()` flushes. react-hooks's
  // immutability rule flags external mutation during render; disabled
  // here because the "side effect" is purely a test probe, not real
  // application state.
  const box: { value: HookValue | null } = { value: null };
  const Host: React.FC = () => {
    // eslint-disable-next-line react-hooks/immutability
    box.value = useUserDefaults(userId);
    return null;
  };
  act(() => {
    root.render(<Host />);
  });
  return {
    current: () => {
      if (!box.value) throw new Error('hook not mounted');
      return box.value;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function waitFor<T>(
  predicate: () => T | false | null | undefined,
  label: string,
  timeoutMs = 1_500
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function resetIDB() {
  // Can't `deleteDatabase` reliably here — fake-indexeddb holds the
  // handle open across tests and the delete request hangs indefinitely.
  // Just clear the store we care about; the hook keys cached rows by
  // userId so cross-test bleed is still caught.
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_APP_SETTINGS, 'readwrite');
    tx.objectStore(STORE_APP_SETTINGS).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

async function readCachedDefaults(): Promise<Record<string, string> | null> {
  const db = await openDB();
  const tx = db.transaction(STORE_APP_SETTINGS, 'readonly');
  const store = tx.objectStore(STORE_APP_SETTINGS);
  return new Promise((resolve) => {
    const req = store.get('user-defaults');
    req.onsuccess = () => {
      const row = req.result as { value?: { defaults: Record<string, string> } } | undefined;
      resolve(row?.value?.defaults ?? null);
    };
    req.onerror = () => resolve(null);
  });
}

beforeEach(async () => {
  userDefaultsMock.mockReset();
  saveUserDefaultsMock.mockReset();
  await resetIDB();
});

afterEach(async () => {
  await resetIDB();
});

describe('Phase 6 · useUserDefaults', () => {
  it('fetches from network and exposes the defaults map', async () => {
    userDefaultsMock.mockResolvedValueOnce({ max_disconnect_time_s: '0.4' });

    const hook = mountHook('user-1');
    try {
      await waitFor(() => !hook.current().loading, 'initial load');
      expect(hook.current().defaults).toEqual({ max_disconnect_time_s: '0.4' });
      expect(userDefaultsMock).toHaveBeenCalledWith('user-1');
    } finally {
      hook.unmount();
    }
  });

  it('returns an empty map when userId is undefined (pre-auth)', async () => {
    const hook = mountHook(undefined);
    try {
      await waitFor(() => !hook.current().loading, 'unresolved loading');
      expect(hook.current().defaults).toEqual({});
      expect(userDefaultsMock).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it('writes to IDB on save so subsequent mounts hydrate offline', async () => {
    userDefaultsMock.mockResolvedValueOnce({});
    saveUserDefaultsMock.mockResolvedValueOnce({ success: true });

    const hook = mountHook('user-1');
    await waitFor(() => !hook.current().loading, 'initial load');

    await act(async () => {
      await hook.current().save({ ir_test_voltage_v: '500' });
    });
    hook.unmount();

    // Mount again with network failing — cache should feed the hook.
    userDefaultsMock.mockRejectedValueOnce(new Error('offline'));
    const second = mountHook('user-1');
    try {
      await waitFor(() => !second.current().loading, 'second load');
      expect(second.current().defaults).toEqual({ ir_test_voltage_v: '500' });
      expect(second.current().error).toBe('offline');
    } finally {
      second.unmount();
    }
  });

  it('does NOT write to IDB when the save fails (cache stays consistent)', async () => {
    userDefaultsMock.mockResolvedValueOnce({ keep: 'this' });
    saveUserDefaultsMock.mockRejectedValueOnce(new Error('500'));

    const hook = mountHook('user-1');
    try {
      await waitFor(() => !hook.current().loading, 'initial load');
      expect(hook.current().defaults).toEqual({ keep: 'this' });

      let threw = false;
      await act(async () => {
        try {
          await hook.current().save({ stomp: 'new' });
        } catch {
          threw = true;
        }
      });
      expect(threw).toBe(true);
      expect(hook.current().defaults).toEqual({ keep: 'this' });

      // IDB cache holds the post-load value (the successful fetch),
      // never the attempted-but-failed write.
      const cached = await readCachedDefaults();
      expect(cached).toEqual({ keep: 'this' });
    } finally {
      hook.unmount();
    }
  });
});
