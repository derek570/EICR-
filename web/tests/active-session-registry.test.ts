/**
 * PLAN-E-TERM (Codex cycle-1) — the CLIENT-WIDE active recording-session
 * set: this tab's live session plus sibling tabs' fresh leases, expiring
 * on their own so a crashed tab drops out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_SESSION_LEASE_MS,
  __noteRemoteSessionForTests,
  __resetActiveSessionRegistryForTests,
  announceActiveSession,
  getActiveSessionIds,
} from '@/lib/recording/active-session-registry';

afterEach(() => __resetActiveSessionRegistryForTests());

describe('active-session registry', () => {
  it('includes the local session and fresh remote leases; expires stale ones', () => {
    const now = 1_000_000;
    __noteRemoteSessionForTests('sess-other-tab', now - 1000);
    __noteRemoteSessionForTests('sess-crashed', now - ACTIVE_SESSION_LEASE_MS - 1);
    const set = getActiveSessionIds('sess-local', now);
    expect(set.has('sess-local')).toBe(true);
    expect(set.has('sess-other-tab')).toBe(true);
    expect(set.has('sess-crashed')).toBe(false);
  });

  it('with no local session only remote leases count', () => {
    __noteRemoteSessionForTests('sess-a', 5000);
    expect([...getActiveSessionIds(null, 5000)]).toEqual(['sess-a']);
  });

  it('the disposer stops the heartbeat immediately (no further alive posts after end)', () => {
    vi.useFakeTimers();
    const posts: string[] = [];
    const orig = globalThis.BroadcastChannel;
    class FakeChannel {
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(public name: string) {}
      postMessage(m: { kind: string }) {
        posts.push(m.kind);
      }
      close() {}
    }
    (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = FakeChannel;
    try {
      const end = announceActiveSession('sess-x', () => true);
      vi.advanceTimersByTime(3500);
      const aliveBefore = posts.filter((k) => k === 'alive').length;
      expect(aliveBefore).toBeGreaterThanOrEqual(2);
      end();
      expect(posts[posts.length - 1]).toBe('ended');
      vi.advanceTimersByTime(10_000);
      expect(posts.filter((k) => k === 'alive').length).toBe(aliveBefore);
      end(); // idempotent
      expect(posts.filter((k) => k === 'ended').length).toBe(1);
    } finally {
      (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = orig;
      vi.useRealTimers();
    }
  });
});
