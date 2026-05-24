/**
 * Tests for Loaded Barrel Phase 1.F readiness tracker + endpoint.
 *
 * The tracker is per-process module state; tests use `_resetForTests`
 * to clear between cases.
 */

import { jest } from '@jest/globals';
import {
  recordPost,
  pruneExpired,
  getReadinessSnapshot,
  _resetForTests,
} from '../extraction/loaded-barrel-readiness.js';

beforeEach(() => {
  _resetForTests();
});

describe('loaded-barrel-readiness — recordPost', () => {
  test('empty state: snapshot returns zeros + no clients', () => {
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(0);
    expect(s.totalPosts).toBe(0);
    expect(s.postsWithTurnId).toBe(0);
    expect(s.adoptionPct).toBe(0);
    expect(s.clients).toEqual([]);
  });

  test('single POST without turnId: 0% adoption', () => {
    recordPost({ userId: 'derek', hasTurnId: false });
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(1);
    expect(s.totalPosts).toBe(1);
    expect(s.postsWithTurnId).toBe(0);
    expect(s.adoptionPct).toBe(0);
    expect(s.clients[0].userId).toBe('derek');
    expect(s.clients[0].adoptionPct).toBe(0);
  });

  test('single POST with turnId: 100% adoption', () => {
    recordPost({ userId: 'derek', hasTurnId: true });
    const s = getReadinessSnapshot();
    expect(s.totalPosts).toBe(1);
    expect(s.postsWithTurnId).toBe(1);
    expect(s.adoptionPct).toBe(100);
    expect(s.clients[0].adoptionPct).toBe(100);
  });

  test('mixed: 8 with turnId, 2 without → 80% adoption (G3 threshold)', () => {
    for (let i = 0; i < 8; i++) recordPost({ userId: 'derek', hasTurnId: true });
    for (let i = 0; i < 2; i++) recordPost({ userId: 'derek', hasTurnId: false });
    const s = getReadinessSnapshot();
    expect(s.totalPosts).toBe(10);
    expect(s.postsWithTurnId).toBe(8);
    expect(s.adoptionPct).toBe(80);
  });

  test('per-client breakdown', () => {
    recordPost({ userId: 'derek', hasTurnId: true });
    recordPost({ userId: 'derek', hasTurnId: true });
    recordPost({ userId: 'ciaran', hasTurnId: false });
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(2);
    expect(s.totalPosts).toBe(3);
    expect(s.postsWithTurnId).toBe(2);
    expect(s.adoptionPct).toBe(67); // 2/3 = 66.6... rounds to 67
    const derek = s.clients.find((c) => c.userId === 'derek');
    const ciaran = s.clients.find((c) => c.userId === 'ciaran');
    expect(derek.adoptionPct).toBe(100);
    expect(ciaran.adoptionPct).toBe(0);
  });

  test('falsy userId is silently dropped (no state mutation)', () => {
    recordPost({ userId: '', hasTurnId: true });
    recordPost({ userId: null, hasTurnId: true });
    recordPost({ userId: undefined, hasTurnId: true });
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(0);
  });

  test('expander-version adoption tracked independently', () => {
    recordPost({ userId: 'derek', hasTurnId: true, hasExpanderVersion: true });
    recordPost({ userId: 'derek', hasTurnId: true, hasExpanderVersion: false });
    const s = getReadinessSnapshot();
    expect(s.postsWithExpanderVersion).toBe(1);
    expect(s.expanderVersionAdoptionPct).toBe(50);
  });
});

describe('loaded-barrel-readiness — pruneExpired', () => {
  test('entries older than 1h are dropped', () => {
    const realNow = Date.now;
    const fakeNow = new Date('2026-05-24T10:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
    recordPost({ userId: 'derek', hasTurnId: true });
    Date.now.mockRestore();

    // Snapshot 2 hours later → derek's lastSeenAt is older than the
    // 1h window so the entry gets pruned.
    pruneExpired(fakeNow + 2 * 60 * 60 * 1000);
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(0);
  });

  test('entries within window survive', () => {
    const fakeNow = new Date('2026-05-24T10:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
    recordPost({ userId: 'derek', hasTurnId: true });
    Date.now.mockRestore();

    pruneExpired(fakeNow + 30 * 60 * 1000); // 30 minutes later
    const s = getReadinessSnapshot();
    expect(s.totalClients).toBe(1);
  });

  test('getReadinessSnapshot prunes implicitly', () => {
    const realNow = Date.now;
    const oldTime = new Date('2026-05-23T10:00:00Z').getTime(); // 24h ago
    jest.spyOn(Date, 'now').mockReturnValue(oldTime);
    recordPost({ userId: 'derek', hasTurnId: true });
    Date.now.mockRestore();

    const s = getReadinessSnapshot(); // uses real Date.now
    expect(s.totalClients).toBe(0);
  });
});

describe('loaded-barrel-readiness — windowMs surface', () => {
  test('returns window length so caller can render the window in UI', () => {
    const s = getReadinessSnapshot();
    expect(s.windowMs).toBe(60 * 60 * 1000);
  });
});
