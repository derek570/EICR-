import { describe, it, expect } from 'vitest';
import { UplinkScopeAllocator, epochScopeEquals } from '@/lib/recording/uplink-scope-allocator';

describe('UplinkScopeAllocator (PLAN-E1)', () => {
  it('reserves a fresh CaptureAttemptId lazily, idempotently', () => {
    const alloc = new UplinkScopeAllocator();
    expect(alloc.currentCaptureAttemptId()).toBeNull();
    const a = alloc.reserveCaptureAttemptIfNeeded();
    const b = alloc.reserveCaptureAttemptIfNeeded();
    expect(a).toBe(b);
    expect(alloc.currentCaptureAttemptId()).toBe(a);
  });

  it('mintEpoch retires the live capture attempt it was parented by', () => {
    const alloc = new UplinkScopeAllocator();
    const capture = alloc.reserveCaptureAttemptIfNeeded();
    const epoch = alloc.mintEpoch(capture);
    expect(alloc.currentCaptureAttemptId()).toBeNull();
    expect(alloc.lastEpoch).toBe(epoch);
  });

  it('epochs never repeat within a session, and neither do capture attempt ids (separate identity spaces)', () => {
    const alloc = new UplinkScopeAllocator();
    const captureIds = new Set<number>();
    const epochIds = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const capture = alloc.reserveCaptureAttemptIfNeeded();
      expect(captureIds.has(capture)).toBe(false);
      captureIds.add(capture);
      const epoch = alloc.mintEpoch(capture);
      expect(epochIds.has(epoch)).toBe(false);
      epochIds.add(epoch);
    }
  });

  it('a reconnect with no live capture reservation reserves a fresh one', () => {
    const alloc = new UplinkScopeAllocator();
    const capture1 = alloc.reserveCaptureAttemptIfNeeded();
    const epoch1 = alloc.mintEpoch(capture1);
    expect(alloc.currentCaptureAttemptId()).toBeNull();
    // Simulate a reconnect's openSocket(): no live reservation, so it
    // reserves fresh rather than reusing the retired one.
    const capture2 = alloc.currentCaptureAttemptId() ?? alloc.reserveCaptureAttemptIfNeeded();
    expect(capture2).not.toBe(capture1);
    const epoch2 = alloc.mintEpoch(capture2);
    expect(epoch2).not.toBe(epoch1);
  });

  it('currentScope returns epoch(...) when a live epoch exists, else preOpen(...)', () => {
    const alloc = new UplinkScopeAllocator();
    const preOpenScope = alloc.currentScope(null);
    expect(preOpenScope.kind).toBe('preOpen');
    const capture = alloc.currentCaptureAttemptId();
    expect(capture).not.toBeNull();

    const epoch = alloc.mintEpoch(capture!);
    const epochScope = alloc.currentScope(epoch);
    expect(epochScope).toEqual({ kind: 'epoch', id: epoch });
  });

  it('reserveOpenAttempt hands out a distinct handle per connect() invocation', () => {
    const alloc = new UplinkScopeAllocator();
    const a = alloc.reserveOpenAttempt();
    const b = alloc.reserveOpenAttempt();
    expect(a.id).not.toBe(b.id);
  });

  it('epochScopeEquals compares by kind + identity, not object reference', () => {
    const alloc = new UplinkScopeAllocator();
    const capture = alloc.reserveCaptureAttemptIfNeeded();
    const epoch = alloc.mintEpoch(capture);
    const scopeA = { kind: 'epoch' as const, id: epoch };
    const scopeB = { kind: 'epoch' as const, id: epoch };
    expect(epochScopeEquals(scopeA, scopeB)).toBe(true);
    expect(epochScopeEquals(scopeA, { kind: 'preOpen', captureAttemptId: capture })).toBe(false);
  });

  it('endCaptureAttempt clears the live reservation without minting an epoch', () => {
    const alloc = new UplinkScopeAllocator();
    alloc.reserveCaptureAttemptIfNeeded();
    alloc.endCaptureAttempt();
    expect(alloc.currentCaptureAttemptId()).toBeNull();
    expect(alloc.lastEpoch).toBeNull();
  });
});
