/**
 * Unit tests for the realtime-log-sink (PLAN-backend-final.md Phase 1.3).
 *
 * Covers the buffer + flush primitives that back the `client_log_batch`
 * WS channel — not the case-arm in sonnet-stream.js (that lives in
 * sonnet-stream-* tests). Specifically:
 *
 *  - per-session buffer + bytes accounting
 *  - shouldFlush threshold (bytes vs age)
 *  - flushSession produces a collision-proof key + idempotent on
 *    retry (failed upload restores the batch to the buffer head)
 *  - flushAllSessions drains every session (SIGTERM / WS 1001
 *    shutdown contract: no entries left buffered after the call)
 *  - downsampling decision (Phase 1.4 cost-cap) keeps error/warn,
 *    samples info/debug at the right rate
 */

import { jest } from '@jest/globals';
import {
  MAX_LINES_PER_SESSION,
  FLUSH_INTERVAL_MS,
  FLUSH_BYTES_THRESHOLD,
  ensureRealtimeLogBuffer,
  appendOneToBuffer,
  shouldFlush,
  flushSession,
  flushAllSessions,
  shouldKeepInDownsampling,
} from '../extraction/realtime-log-sink.js';

function makeEntry({ userId = 'user_test', extra = {} } = {}) {
  return { userId, ...extra };
}

function makeUploadFn() {
  const calls = [];
  const fn = jest.fn(async (body, key, contentType) => {
    calls.push({ body, key, contentType });
    return true;
  });
  fn.calls = calls;
  return fn;
}

describe('realtime-log-sink — buffer accounting', () => {
  it('ensureRealtimeLogBuffer initialises fields idempotently', () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    expect(entry.realtimeLogBuffer).toEqual([]);
    expect(entry.realtimeLogBufferBytes).toBe(0);
    expect(entry.realtimeLogLineCount).toBe(0);
    expect(entry.realtimeLogDownsamplingActive).toBe(false);

    appendOneToBuffer(entry, '{"a":1}');
    const beforeBytes = entry.realtimeLogBufferBytes;
    ensureRealtimeLogBuffer(entry);
    expect(entry.realtimeLogBuffer).toEqual(['{"a":1}']);
    expect(entry.realtimeLogBufferBytes).toBe(beforeBytes);
  });

  it('appendOneToBuffer skips empty + non-string inputs', () => {
    const entry = makeEntry();
    appendOneToBuffer(entry, '');
    appendOneToBuffer(entry, null);
    appendOneToBuffer(entry, undefined);
    expect(entry.realtimeLogBuffer).toEqual([]);
    expect(entry.realtimeLogLineCount).toBe(0);
  });

  it('appendOneToBuffer increments lineCount + bytes accounting', () => {
    const entry = makeEntry();
    appendOneToBuffer(entry, '{"a":1}');
    appendOneToBuffer(entry, '{"b":22}');
    expect(entry.realtimeLogLineCount).toBe(2);
    // bytes = utf8 length per line + 1 for the join '\n'
    expect(entry.realtimeLogBufferBytes).toBe(7 + 1 + 8 + 1);
  });
});

describe('realtime-log-sink — shouldFlush trigger', () => {
  it('returns false for empty buffer', () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    expect(shouldFlush(entry)).toBe(false);
  });

  it('returns true when bytes threshold crossed', () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    entry.realtimeLogBuffer.push('x');
    entry.realtimeLogBufferBytes = FLUSH_BYTES_THRESHOLD;
    expect(shouldFlush(entry)).toBe(true);
  });

  it('returns true when age threshold crossed', () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    entry.realtimeLogBuffer.push('x');
    entry.realtimeLogBufferBytes = 1;
    entry.realtimeLogLastFlushAt = 0;
    expect(shouldFlush(entry, { now: FLUSH_INTERVAL_MS + 1 })).toBe(true);
  });

  it('returns false when both thresholds below', () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    entry.realtimeLogBuffer.push('x');
    entry.realtimeLogBufferBytes = 1;
    entry.realtimeLogLastFlushAt = 1_000;
    expect(shouldFlush(entry, { now: 2_000 })).toBe(false);
  });
});

describe('realtime-log-sink — flushSession', () => {
  it('drains the buffer and uploads as application/x-ndjson with collision-proof key', async () => {
    const entry = makeEntry({ userId: 'user_42' });
    appendOneToBuffer(entry, '{"a":1}');
    appendOneToBuffer(entry, '{"b":2}');

    const uploadFn = makeUploadFn();
    const key = await flushSession('sess_abc', entry, {
      reason: 'periodic',
      uploadFn,
      now: 1_780_582_241_174,
    });

    expect(key).toMatch(
      /^session-logs\/user_42\/sess_abc\/realtime\/1780582241174-[0-9a-f]{8}\.jsonl$/
    );
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(uploadFn.calls[0].body).toBe('{"a":1}\n{"b":2}\n');
    expect(uploadFn.calls[0].contentType).toBe('application/x-ndjson');

    expect(entry.realtimeLogBuffer).toEqual([]);
    expect(entry.realtimeLogBufferBytes).toBe(0);
    expect(entry.realtimeLogLastFlushAt).toBe(1_780_582_241_174);
  });

  it('returns null when buffer is empty (no upload)', async () => {
    const entry = makeEntry();
    ensureRealtimeLogBuffer(entry);
    const uploadFn = makeUploadFn();
    const key = await flushSession('sess_abc', entry, { uploadFn });
    expect(key).toBeNull();
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('returns null when sessionId or userId is missing', async () => {
    const uploadFn = makeUploadFn();
    const entryNoUser = { realtimeLogBuffer: ['{"a":1}'], realtimeLogBufferBytes: 8 };
    expect(await flushSession('sess', entryNoUser, { uploadFn })).toBeNull();

    const entryOk = makeEntry();
    appendOneToBuffer(entryOk, '{"a":1}');
    expect(await flushSession('', entryOk, { uploadFn })).toBeNull();
  });

  it('restores the batch to the buffer head on upload failure', async () => {
    const entry = makeEntry();
    appendOneToBuffer(entry, '{"a":1}');
    appendOneToBuffer(entry, '{"b":2}');
    const beforeBytes = entry.realtimeLogBufferBytes;

    const failingUpload = jest.fn(async () => {
      throw new Error('S3 503');
    });
    const key = await flushSession('sess', entry, { uploadFn: failingUpload });

    expect(key).toBeNull();
    expect(entry.realtimeLogBuffer).toEqual(['{"a":1}', '{"b":2}']);
    expect(entry.realtimeLogBufferBytes).toBe(beforeBytes);
  });

  it('restored batch keeps chronological order against concurrent appends', async () => {
    const entry = makeEntry();
    appendOneToBuffer(entry, 'first');
    appendOneToBuffer(entry, 'second');

    // Simulate an upload that throws AFTER a concurrent append landed
    // a third line on the (now-empty) buffer.
    const failingUpload = jest.fn(async () => {
      appendOneToBuffer(entry, 'third');
      throw new Error('S3 503');
    });
    await flushSession('sess', entry, { uploadFn: failingUpload });

    expect(entry.realtimeLogBuffer).toEqual(['first', 'second', 'third']);
  });
});

describe('realtime-log-sink — flushAllSessions (graceful shutdown contract)', () => {
  it('drains every active session in a single pass and returns keys for the ones that had buffered entries', async () => {
    const activeSessions = new Map();
    const a = makeEntry({ userId: 'u1' });
    const b = makeEntry({ userId: 'u2' });
    const c = makeEntry({ userId: 'u3' });
    appendOneToBuffer(a, '{"a":1}');
    appendOneToBuffer(b, '{"b":1}');
    appendOneToBuffer(b, '{"b":2}');
    // c stays empty — should NOT contribute a key
    activeSessions.set('s_a', a);
    activeSessions.set('s_b', b);
    activeSessions.set('s_c', c);

    const uploadFn = makeUploadFn();
    const keys = await flushAllSessions(activeSessions, { reason: 'shutdown', uploadFn });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^session-logs\/u1\/s_a\/realtime\//);
    expect(keys[1]).toMatch(/^session-logs\/u2\/s_b\/realtime\//);
    expect(a.realtimeLogBuffer).toEqual([]);
    expect(b.realtimeLogBuffer).toEqual([]);
    // c was never touched (no appendOneToBuffer call); flushAllSessions
    // short-circuits past entries with no buffer rather than initialising
    // them — so c stays exactly as the caller left it.
    expect(c.realtimeLogBuffer).toBeUndefined();
  });

  it('survives a non-Map argument without throwing (defensive)', async () => {
    await expect(flushAllSessions(null)).resolves.toEqual([]);
    await expect(flushAllSessions({})).resolves.toEqual([]);
  });

  it('continues past per-entry upload failures so a single bad session does not block the deploy drain', async () => {
    const activeSessions = new Map();
    const a = makeEntry({ userId: 'u1' });
    const b = makeEntry({ userId: 'u2' });
    appendOneToBuffer(a, '{"a":1}');
    appendOneToBuffer(b, '{"b":1}');
    activeSessions.set('s_a', a);
    activeSessions.set('s_b', b);

    let nthCall = 0;
    const flakeyUpload = jest.fn(async () => {
      nthCall += 1;
      if (nthCall === 1) throw new Error('S3 timeout');
      return true;
    });
    const keys = await flushAllSessions(activeSessions, { uploadFn: flakeyUpload });
    expect(flakeyUpload).toHaveBeenCalledTimes(2);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^session-logs\/u2\/s_b\/realtime\//);
    // failed session's batch is preserved for the next process restart
    // (post-shutdown there's no automatic retry, but the buffer state is
    // honest — caller can inspect after the drain returns).
    expect(a.realtimeLogBuffer).toEqual(['{"a":1}']);
  });
});

describe('realtime-log-sink — downsampling policy (Phase 1.4 cost-cap)', () => {
  it('always keeps error + warn lines regardless of sampling', () => {
    // 100 reps × deterministic sampler would be overkill; the policy
    // unconditionally returns true for these two levels, so a single
    // call per level proves the branch.
    for (let i = 0; i < 50; i += 1) {
      expect(shouldKeepInDownsampling({ level: 'error' })).toBe(true);
      expect(shouldKeepInDownsampling({ level: 'WARN' })).toBe(true); // case-insensitive
    }
  });

  it('samples info ~1-in-10 (statistical: 1000 reps lands well inside [40, 200])', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (shouldKeepInDownsampling({ level: 'info' })) kept += 1;
    }
    // Expected mean ~100, σ ≈ 9.5; ±6σ band is [42, 158].
    expect(kept).toBeGreaterThan(40);
    expect(kept).toBeLessThan(200);
  });

  it('samples debug ~1-in-100 (statistical: 1000 reps lands well inside [1, 40])', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (shouldKeepInDownsampling({ level: 'debug' })) kept += 1;
    }
    expect(kept).toBeGreaterThan(1);
    expect(kept).toBeLessThan(40);
  });

  it('treats unknown / missing levels as info-tier (sampling on, NOT keep-all)', () => {
    let kept = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (shouldKeepInDownsampling({})) kept += 1;
    }
    expect(kept).toBeGreaterThan(40);
    expect(kept).toBeLessThan(200);
  });
});

describe('realtime-log-sink — cost-cap constants', () => {
  it('cap is 20 000 lines (matches Phase 1.4 plan)', () => {
    expect(MAX_LINES_PER_SESSION).toBe(20_000);
  });
  it('flush thresholds match plan: 30 s tick + 100 KB byte burst', () => {
    expect(FLUSH_INTERVAL_MS).toBe(30_000);
    expect(FLUSH_BYTES_THRESHOLD).toBe(100 * 1024);
  });
});
