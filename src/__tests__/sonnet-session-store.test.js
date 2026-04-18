/**
 * Tests for the Sonnet session-rehydration store (Wave 4c.5).
 * Covers TTL expiry, LRU eviction, user-boundary enforcement, and the
 * create/resume/remove/size/clear contract.
 */

import { describe, test, expect } from '@jest/globals';
import { createSessionStore } from '../extraction/sonnet-session-store.js';

/**
 * Build an isolated store with an injectable clock + minter so tests don't
 * depend on real time / UUID randomness and don't leak state between cases.
 */
function buildStore({ ttlMs = 1000, maxEntries = 3 } = {}) {
  let t = 0;
  let counter = 0;
  const store = createSessionStore({
    ttlMs,
    maxEntries,
    now: () => t,
    mintId: () => `sess-${++counter}`,
  });
  return {
    store,
    advance(ms) {
      t += ms;
    },
    setNow(ms) {
      t = ms;
    },
  };
}

describe('sonnet-session-store', () => {
  describe('create + resume basic contract', () => {
    test('create returns a fresh id per call', () => {
      const { store } = buildStore();
      const a = store.create('user-1', { turns: 0 });
      const b = store.create('user-1', { turns: 1 });
      expect(a).toBe('sess-1');
      expect(b).toBe('sess-2');
      expect(a).not.toBe(b);
    });

    test('create throws without a userId (prevents null-user entries)', () => {
      const { store } = buildStore();
      expect(() => store.create('', { turns: 0 })).toThrow(/userId required/);
      expect(() => store.create(undefined, { turns: 0 })).toThrow(/userId required/);
    });

    test('resume returns the stored payload when the user matches', () => {
      const { store } = buildStore();
      const payload = { turns: 4, certType: 'eicr' };
      const id = store.create('user-1', payload);
      expect(store.resume(id, 'user-1')).toEqual(payload);
    });

    test('resume returns null for an unknown id', () => {
      const { store } = buildStore();
      expect(store.resume('never-minted', 'user-1')).toBeNull();
    });

    test('resume returns null when sessionId or userId is missing', () => {
      const { store } = buildStore();
      const id = store.create('user-1', { turns: 0 });
      expect(store.resume(id, '')).toBeNull();
      expect(store.resume('', 'user-1')).toBeNull();
      expect(store.resume(null, 'user-1')).toBeNull();
    });
  });

  describe('TTL behaviour', () => {
    test('resume within the TTL window rehydrates', () => {
      const { store, advance } = buildStore({ ttlMs: 1000 });
      const id = store.create('user-1', { turns: 7 });
      advance(500); // half-way through TTL
      expect(store.resume(id, 'user-1')).toEqual({ turns: 7 });
    });

    test('resume exactly at TTL treats the entry as expired', () => {
      const { store, advance } = buildStore({ ttlMs: 1000 });
      const id = store.create('user-1', { turns: 7 });
      advance(1000); // exactly TTL — >= expiry boundary
      expect(store.resume(id, 'user-1')).toBeNull();
    });

    test('resume after TTL returns null and drops the entry', () => {
      const { store, advance } = buildStore({ ttlMs: 1000 });
      const id = store.create('user-1', { turns: 7 });
      advance(1500);
      expect(store.resume(id, 'user-1')).toBeNull();
      expect(store.size()).toBe(0);
    });

    test('create evicts already-expired entries lazily', () => {
      const { store, advance } = buildStore({ ttlMs: 1000, maxEntries: 100 });
      store.create('user-1', { turns: 1 });
      store.create('user-1', { turns: 2 });
      advance(1500);
      // Neither existing entry is readable any more — but size() / evictExpired
      // should clear them when we touch the store.
      store.create('user-1', { turns: 3 });
      expect(store.size()).toBe(1);
    });

    test('TTL is anchored on mint time, not on last resume (no indefinite extension)', () => {
      const { store, advance } = buildStore({ ttlMs: 1000 });
      const id = store.create('user-1', { turns: 1 });
      advance(600);
      expect(store.resume(id, 'user-1')).toEqual({ turns: 1 }); // touches entry
      advance(500); // cumulative 1100ms > TTL
      expect(store.resume(id, 'user-1')).toBeNull();
    });
  });

  describe('LRU eviction', () => {
    test('oldest entry is evicted when the cap is exceeded', () => {
      const { store } = buildStore({ maxEntries: 3 });
      const a = store.create('user-1', { turns: 1 });
      const b = store.create('user-1', { turns: 2 });
      const c = store.create('user-1', { turns: 3 });
      const d = store.create('user-1', { turns: 4 }); // forces eviction of `a`
      expect(store.resume(a, 'user-1')).toBeNull(); // evicted
      expect(store.resume(b, 'user-1')).toEqual({ turns: 2 });
      expect(store.resume(c, 'user-1')).toEqual({ turns: 3 });
      expect(store.resume(d, 'user-1')).toEqual({ turns: 4 });
    });

    test('resume counts as a touch — recently resumed entries survive eviction', () => {
      const { store } = buildStore({ maxEntries: 3 });
      const a = store.create('user-1', { turns: 1 });
      const b = store.create('user-1', { turns: 2 });
      const c = store.create('user-1', { turns: 3 });
      // Touch `a` so it is no longer the oldest.
      expect(store.resume(a, 'user-1')).toEqual({ turns: 1 });
      store.create('user-1', { turns: 4 }); // should evict `b`, not `a`
      expect(store.resume(a, 'user-1')).toEqual({ turns: 1 });
      expect(store.resume(b, 'user-1')).toBeNull();
      expect(store.resume(c, 'user-1')).toEqual({ turns: 3 });
    });

    test('size() reports the live entry count after lazy expiry', () => {
      const { store, advance } = buildStore({ ttlMs: 1000, maxEntries: 5 });
      store.create('user-1', { turns: 1 });
      store.create('user-1', { turns: 2 });
      expect(store.size()).toBe(2);
      advance(1500);
      expect(store.size()).toBe(0);
    });
  });

  describe('user-boundary enforcement', () => {
    test('resume with the wrong user returns null', () => {
      const { store } = buildStore();
      const id = store.create('user-1', { turns: 3 });
      expect(store.resume(id, 'user-2')).toBeNull();
    });

    test('a wrong-user resume invalidates the token — subsequent correct-user resume also fails', () => {
      const { store } = buildStore();
      const id = store.create('user-1', { turns: 3 });
      // Attempted takeover:
      expect(store.resume(id, 'attacker')).toBeNull();
      // Legit owner has lost the token too:
      expect(store.resume(id, 'user-1')).toBeNull();
      expect(store.size()).toBe(0);
    });
  });

  describe('explicit removal', () => {
    test('remove returns true for a live entry and false for a missing one', () => {
      const { store } = buildStore();
      const id = store.create('user-1', { turns: 1 });
      expect(store.remove(id)).toBe(true);
      expect(store.remove(id)).toBe(false);
      expect(store.resume(id, 'user-1')).toBeNull();
    });

    test('clear wipes every entry', () => {
      const { store } = buildStore();
      store.create('user-1', { turns: 1 });
      store.create('user-2', { turns: 2 });
      store.clear();
      expect(store.size()).toBe(0);
    });
  });

  describe('env-based configuration', () => {
    test('SONNET_SESSION_TTL_MS env var overrides the default when no ttlMs option is passed', () => {
      const original = process.env.SONNET_SESSION_TTL_MS;
      process.env.SONNET_SESSION_TTL_MS = '2000';
      try {
        let t = 0;
        const store = createSessionStore({
          now: () => t,
          mintId: () => 'id-a',
          maxEntries: 10,
        });
        const id = store.create('user-1', { turns: 1 });
        t = 1500;
        expect(store.resume(id, 'user-1')).toEqual({ turns: 1 });
        t = 2000;
        expect(store.resume(id, 'user-1')).toBeNull();
      } finally {
        if (original === undefined) delete process.env.SONNET_SESSION_TTL_MS;
        else process.env.SONNET_SESSION_TTL_MS = original;
      }
    });

    test('SONNET_SESSION_MAX_ENTRIES env var caps the LRU when no maxEntries option is passed', () => {
      const original = process.env.SONNET_SESSION_MAX_ENTRIES;
      process.env.SONNET_SESSION_MAX_ENTRIES = '2';
      try {
        let counter = 0;
        const store = createSessionStore({
          ttlMs: 10_000,
          now: () => 0,
          mintId: () => `id-${++counter}`,
        });
        const a = store.create('user-1', { turns: 1 });
        store.create('user-1', { turns: 2 });
        store.create('user-1', { turns: 3 }); // evicts `a`
        expect(store.resume(a, 'user-1')).toBeNull();
        expect(store.size()).toBe(2);
      } finally {
        if (original === undefined) delete process.env.SONNET_SESSION_MAX_ENTRIES;
        else process.env.SONNET_SESSION_MAX_ENTRIES = original;
      }
    });
  });
});
