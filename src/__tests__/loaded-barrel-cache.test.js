/**
 * Tests for src/extraction/loaded-barrel-cache.js (Loaded Barrel
 * Phase 2.A). State-machine fuzz lives in a separate file (Phase 5).
 */

import { jest } from '@jest/globals';
import {
  buildCacheKey,
  set,
  peek,
  claim,
  markReady,
  markSuperseded,
  terminateByKey,
  invalidateBySlot,
  pruneSessionUnboardedEntries,
  pruneMismatchedBoardEntries,
  pruneForSession,
  _snapshot,
  _resetForTests,
  _internals,
} from '../extraction/loaded-barrel-cache.js';

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
});

// Helper to create a pending entry the way the speculator will. Returns
// {entry, resolve} so the test can simulate the synth completing.
function speculate(opts) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const controller = { abort: jest.fn() };
  const entry = set({
    cacheKey: buildCacheKey(opts),
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    boardId: opts.boardId ?? null,
    field: opts.field,
    circuit: opts.circuit ?? null,
    expandedText: opts.expandedText,
    correlationId: opts.correlationId ?? `corr-${Math.random()}`,
    promise,
    resolvePromise: resolve,
    controller,
  });
  return { entry, key: entry.cacheKey, promise, resolve, controller };
}

describe('buildCacheKey', () => {
  test('same inputs produce same key', () => {
    const a = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B',
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point five',
    });
    const b = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B',
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point five',
    });
    expect(a).toBe(b);
  });

  test('different text → different key', () => {
    const a = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const b = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 1,
      expandedText: 'Y',
    });
    expect(a).not.toBe(b);
  });

  test('different boardId → different key', () => {
    const a = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B1',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const b = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B2',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(a).not.toBe(b);
  });

  test('null boardId same as undefined same as empty string', () => {
    const a = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const b = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: undefined,
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const c = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: '',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('output is 40-char sha1 hex', () => {
    const k = buildCacheKey({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(k).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe('set / peek / state transitions', () => {
  test('set creates a pending entry', () => {
    const { entry } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(entry.state).toBe('pending');
    expect(entry.mp3Buffer).toBe(null);
    expect(entry.expiresAt - entry.createdAt).toBe(_internals.TTL_MS);
  });

  test('peek returns the entry', () => {
    const { key, entry } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(peek(key)).toBe(entry);
  });

  test('peek returns null for unknown key', () => {
    expect(peek('deadbeef')).toBe(null);
  });

  test('markReady: pending → ready', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const buf = Buffer.from([1, 2, 3]);
    expect(markReady(key, buf)).toBe(true);
    expect(peek(key).state).toBe('ready');
    expect(peek(key).mp3Buffer).toBe(buf);
  });

  test('markReady on non-pending returns false (no transition)', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    markReady(key, Buffer.from([1]));
    // Already ready — second markReady fails.
    expect(markReady(key, Buffer.from([2]))).toBe(false);
    expect(peek(key).mp3Buffer).toEqual(Buffer.from([1]));
  });

  test('claim: ready → claimed + entry removed', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const buf = Buffer.from([1, 2, 3]);
    markReady(key, buf);
    expect(claim(key)).toBe(true);
    // Claimed entries are terminal — peek returns null after.
    expect(peek(key)).toBe(null);
  });

  test('claim on pending returns false (state machine forbids)', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(claim(key)).toBe(false);
    expect(peek(key).state).toBe('pending');
  });

  test('claim on already-claimed returns false (idempotent)', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    markReady(key, Buffer.from([1]));
    expect(claim(key)).toBe(true);
    expect(claim(key)).toBe(false); // already terminal
  });

  test('markSuperseded: pending → aborted + entry removed + controller aborted + promise resolved(null)', async () => {
    const { key, promise, controller } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    expect(markSuperseded(key, 'test_reason')).toBe(true);
    expect(peek(key)).toBe(null);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    // The pending promise is resolved with null so any awaiter unblocks.
    await expect(promise).resolves.toBeNull();
  });

  test('markSuperseded on ready returns false (state machine forbids — use claim or wait for ttl)', () => {
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    markReady(key, Buffer.from([1]));
    expect(markSuperseded(key)).toBe(false);
    expect(peek(key).state).toBe('ready');
  });
});

describe('TTL expiry', () => {
  test('ready entry transitions to ttl_expired after TTL_MS', () => {
    jest.useFakeTimers();
    const { key } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    markReady(key, Buffer.from([1]));
    expect(peek(key).state).toBe('ready');
    jest.advanceTimersByTime(_internals.TTL_MS + 100);
    expect(peek(key)).toBe(null); // terminal — removed
    jest.useRealTimers();
  });

  test('pending entry transitions to aborted after TTL_MS', async () => {
    jest.useFakeTimers();
    const { key, promise, controller } = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    jest.advanceTimersByTime(_internals.TTL_MS + 100);
    expect(peek(key)).toBe(null);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    // Drain microtask after fake timers advance.
    jest.useRealTimers();
    await expect(promise).resolves.toBeNull();
  });
});

describe('LRU caps', () => {
  test('per-session cap evicts oldest (= aborts oldest pending)', () => {
    // Pre-fill session S with PER_SESSION_MAX entries.
    const keys = [];
    for (let i = 0; i < _internals.PER_SESSION_MAX; i++) {
      keys.push(
        speculate({
          sessionId: 'S',
          turnId: `t${i}`,
          field: 'F',
          circuit: i,
          expandedText: `x${i}`,
        }).key
      );
    }
    expect(_snapshot().sessions.S.count).toBe(_internals.PER_SESSION_MAX);
    // Insert one more → oldest is evicted.
    const newest = speculate({
      sessionId: 'S',
      turnId: 'tNEW',
      field: 'F',
      circuit: 999,
      expandedText: 'xNEW',
    });
    expect(_snapshot().sessions.S.count).toBe(_internals.PER_SESSION_MAX);
    expect(peek(keys[0])).toBe(null); // oldest evicted
    expect(peek(newest.key)).not.toBe(null);
  });

  test('global cap evicts oldest across sessions', () => {
    // Fill GLOBAL_MAX across multiple sessions.
    const keys = [];
    for (let i = 0; i < _internals.GLOBAL_MAX; i++) {
      keys.push(
        speculate({
          sessionId: `S${i % 50}`, // 50 sessions
          turnId: `t${i}`,
          field: 'F',
          circuit: i,
          expandedText: `x${i}`,
        }).key
      );
    }
    // Add one more — global cap kicks in, oldest evicted.
    speculate({
      sessionId: 'SNEW',
      turnId: 'tNEW',
      field: 'F',
      circuit: 0,
      expandedText: 'NEW',
    });
    expect(peek(keys[0])).toBe(null);
  });
});

describe('invalidate / prune helpers', () => {
  test('invalidateBySlot drops matching entries only', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B1',
      field: 'F',
      circuit: 1,
      expandedText: 'a',
    });
    const b = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B1',
      field: 'F',
      circuit: 2,
      expandedText: 'b',
    });
    const c = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B2',
      field: 'F',
      circuit: 1,
      expandedText: 'c',
    });

    const invalidated = invalidateBySlot('S', { boardId: 'B1', field: 'F', circuit: 1 });
    expect(invalidated).toBe(1);
    expect(peek(a.key)).toBe(null);
    expect(peek(b.key)).not.toBe(null); // different circuit
    expect(peek(c.key)).not.toBe(null); // different board
  });

  test('pruneSessionUnboardedEntries drops boardId=null entries only', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 1,
      expandedText: 'a',
    });
    const b = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B1',
      field: 'F',
      circuit: 2,
      expandedText: 'b',
    });
    expect(pruneSessionUnboardedEntries('S')).toBe(1);
    expect(peek(a.key)).toBe(null);
    expect(peek(b.key)).not.toBe(null);
  });

  test('pruneMismatchedBoardEntries drops entries where boardId != current', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B1',
      field: 'F',
      circuit: 1,
      expandedText: 'a',
    });
    const b = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: 'B2',
      field: 'F',
      circuit: 2,
      expandedText: 'b',
    });
    const c = speculate({
      sessionId: 'S',
      turnId: 'T',
      boardId: null,
      field: 'F',
      circuit: 3,
      expandedText: 'c',
    });
    expect(pruneMismatchedBoardEntries('S', 'B1')).toBe(2);
    expect(peek(a.key)).not.toBe(null);
    expect(peek(b.key)).toBe(null);
    expect(peek(c.key)).toBe(null);
  });

  test('pruneForSession drops every entry of that sessionId', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'a',
    });
    const b = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 2,
      expandedText: 'b',
    });
    const c = speculate({
      sessionId: 'OTHER',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'a',
    });
    expect(pruneForSession('S')).toBe(2);
    expect(peek(a.key)).toBe(null);
    expect(peek(b.key)).toBe(null);
    expect(peek(c.key)).not.toBe(null);
  });
});

describe('set defensive', () => {
  test('missing cacheKey throws', () => {
    expect(() => set({ cacheKey: '', sessionId: 'S', field: 'F', expandedText: 'X' })).toThrow();
  });

  test('missing sessionId throws', () => {
    expect(() => set({ cacheKey: 'k', sessionId: '', field: 'F', expandedText: 'X' })).toThrow();
  });

  test('duplicate set returns existing entry (idempotent)', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
    });
    const dup = set({
      cacheKey: a.key,
      sessionId: 'S',
      turnId: 'T',
      field: 'F',
      circuit: 1,
      expandedText: 'X',
      correlationId: 'corr-dup',
      promise: Promise.resolve(),
      resolvePromise: () => {},
      controller: { abort: () => {} },
    });
    expect(dup).toBe(a.entry);
  });
});

/**
 * A2-multiboard item 4 — the exact-key terminate door used by the
 * collapsed-replacement reconciliation.
 *
 * The two pre-existing doors are both wrong for that job (markSuperseded is
 * pending-only, invalidateBySlot is session-wide with no turn identity), so the
 * state machine around the new one is pinned here.
 */
describe('terminateByKey (A2-multiboard item 4)', () => {
  test('terminates a PENDING entry — resolves the promise with null and aborts', async () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'X',
    });
    expect(a.entry.state).toBe('pending');

    expect(terminateByKey(a.key, 'collapsed_replacement')).toBe(true);

    expect(a.entry.state).toBe('aborted');
    expect(a.entry.terminationReason).toBe('collapsed_replacement');
    expect(a.controller.abort).toHaveBeenCalled();
    await expect(a.promise).resolves.toBeNull();
    expect(peek(a.key)).toBeNull();
  });

  test('terminates a READY entry — the case markSuperseded cannot reach', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'X',
    });
    expect(markReady(a.key, Buffer.from('mp3'))).toBe(true);
    expect(peek(a.key).state).toBe('ready');

    // The pre-existing pending-only door is a no-op here — that is the whole
    // reason a new primitive exists.
    expect(markSuperseded(a.key)).toBe(false);
    expect(peek(a.key)).not.toBeNull();

    expect(terminateByKey(a.key, 'collapsed_replacement')).toBe(true);
    expect(peek(a.key)).toBeNull();
  });

  test('is a no-op on an absent key', () => {
    expect(terminateByKey('no-such-key')).toBe(false);
  });

  test('terminal states stay terminal — a claimed entry is not re-terminated', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'X',
    });
    markReady(a.key, Buffer.from('mp3'));
    expect(claim(a.key)).toBe(true);
    expect(a.entry.state).toBe('claimed');

    expect(terminateByKey(a.key)).toBe(false);
    expect(a.entry.state).toBe('claimed');
  });

  test('a second terminate of the same key returns false (idempotent)', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'X',
    });
    expect(terminateByKey(a.key)).toBe(true);
    expect(terminateByKey(a.key)).toBe(false);
  });

  test('touches ONLY the named key — a sibling sharing field/circuit/board survives', () => {
    const a = speculate({
      sessionId: 'S',
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'Circuit 3, Zs 0.4 ohms',
    });
    const b = speculate({
      sessionId: 'S',
      turnId: 'T2',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'Circuit 3, Zs 0.5 ohms',
    });
    expect(a.key).not.toBe(b.key);

    expect(terminateByKey(a.key)).toBe(true);

    expect(peek(a.key)).toBeNull();
    expect(peek(b.key)).not.toBeNull();
    // invalidateBySlot — the door the reconciliation deliberately does NOT use
    // — would have taken both.
    expect(_snapshot().totalEntries).toBe(1);
  });
});
