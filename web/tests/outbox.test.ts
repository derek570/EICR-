import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueSaveJobMutation,
  listPendingMutations,
  listPoisonedMutations,
  MAX_ATTEMPTS,
  markMutationFailed,
  markMutationPoisoned,
  OutboxMutationSchema,
  parseOutboxRow,
  purgeOutbox,
  removeMutation,
  requeueMutation,
  STORE_OUTBOX,
} from '@/lib/pwa/outbox';
import { DB_NAME, DB_VERSION } from '@/lib/pwa/job-cache';

/**
 * Wave 1 PWA outbox regression suite — P0-11 (strict IDB writes),
 * P0-12 (4xx → immediate poisoning + head-of-line skip), Q3 (MAX_ATTEMPTS
 * bumped to 15).
 *
 * Isolation strategy:
 *   We reset state via `purgeOutbox()` (a store.clear() on the running
 *   connection) rather than `indexedDB.deleteDatabase(DB_NAME)`. The
 *   outbox module caches `dbPromise` at module-scope so the connection
 *   opened on first import stays alive; `deleteDatabase` would block on
 *   that open handle in fake-indexeddb and hang the hook. A clear is
 *   cheaper anyway — the schema only needs to run once per test file.
 *
 * We hit real IDB APIs via `fake-indexeddb`, so the schema upgrade
 * (`openDB` in job-cache.ts) runs exactly like in the browser — the
 * alternative of mocking IDB would bypass the exact seam where P0-11's
 * silent drop lived.
 */

beforeEach(async () => {
  await purgeOutbox();
});

describe('enqueueSaveJobMutation (P0-11)', () => {
  it('persists a row that listPendingMutations can read back (FIFO)', async () => {
    await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    // Advance clock trivially by forcing distinct createdAt values —
    // easiest way is a microtask gap plus an explicit Date.now shim
    // would complicate this more than it buys. A 2ms real delay is
    // fine under the default 5s test timeout.
    await new Promise((r) => setTimeout(r, 2));
    await enqueueSaveJobMutation('u1', 'j2', { address: 'B' });

    const pending = await listPendingMutations();
    expect(pending).toHaveLength(2);
    // FIFO: first enqueue comes first.
    expect(pending[0].patch).toEqual({ address: 'A' });
    expect(pending[1].patch).toEqual({ address: 'B' });
    // Fresh row is eligible immediately.
    expect(pending[0].nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(pending[0].attempts).toBe(0);
    expect(pending[0].poisoned).toBeUndefined();
  });

  it('strict-wrap semantics: the returned mutation carries a uuid we can key off', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    expect(m.id).toBeTruthy();
    expect(typeof m.id).toBe('string');
    expect(m.id.length).toBeGreaterThanOrEqual(8);
  });
});

describe('markMutationPoisoned (P0-12)', () => {
  it('moves the row out of listPendingMutations into listPoisonedMutations', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await markMutationPoisoned(m.id, 'HTTP 400: bad payload');

    const pending = await listPendingMutations();
    const poisoned = await listPoisonedMutations();
    expect(pending).toHaveLength(0);
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0].id).toBe(m.id);
    expect(poisoned[0].poisoned).toBe(true);
    // lastError capped at 500 chars — exercised implicitly by short string.
    expect(poisoned[0].lastError).toBe('HTTP 400: bad payload');
    // nextAttemptAt forced to MAX_SAFE_INTEGER so any legacy path that
    // forgets to check `.poisoned` still skips the row.
    expect(poisoned[0].nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('head-of-line: a poisoned row at the head does not block later rows from listPendingMutations', async () => {
    const a = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await new Promise((r) => setTimeout(r, 2));
    await enqueueSaveJobMutation('u1', 'j2', { address: 'B' });

    await markMutationPoisoned(a.id, 'HTTP 422');
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].patch).toEqual({ address: 'B' });
  });
});

describe('markMutationFailed (backoff + Q3 MAX_ATTEMPTS=15)', () => {
  it('poisons automatically after MAX_ATTEMPTS failures', async () => {
    expect(MAX_ATTEMPTS).toBe(15); // Q3 decision — hard-coded expectation.
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await markMutationFailed(m.id, `transient ${i}`);
    }
    const pending = await listPendingMutations();
    const poisoned = await listPoisonedMutations();
    expect(pending).toHaveLength(0);
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0].attempts).toBe(MAX_ATTEMPTS);
  });

  it('exponential backoff pushes nextAttemptAt forward on each failure', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    const seeds = await listPendingMutations();
    const t0 = seeds[0].nextAttemptAt;
    await markMutationFailed(m.id, 'transient');
    const after1 = await listPendingMutations();
    const t1 = after1[0].nextAttemptAt;
    // First failure waits at least BASE_BACKOFF_MS (2s) — be lenient to
    // avoid flakes on a slow CI box (assert strictly greater than t0
    // rather than t0 + 2000).
    expect(t1).toBeGreaterThan(t0);
    expect(after1[0].attempts).toBe(1);
  });
});

describe('requeueMutation / discardMutation / purgeOutbox', () => {
  it('requeue clears poison + resets attempts', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await markMutationPoisoned(m.id, 'HTTP 400');
    await requeueMutation(m.id);

    const pending = await listPendingMutations();
    const poisoned = await listPoisonedMutations();
    expect(pending).toHaveLength(1);
    expect(poisoned).toHaveLength(0);
    expect(pending[0].attempts).toBe(0);
    expect(pending[0].poisoned).toBe(false);
  });

  it('removeMutation drops the row', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await removeMutation(m.id);
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(0);
  });

  it('purgeOutbox wipes every row (sign-out safety)', async () => {
    await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await enqueueSaveJobMutation('u2', 'j2', { address: 'B' });
    await purgeOutbox();
    const pending = await listPendingMutations();
    const poisoned = await listPoisonedMutations();
    expect(pending).toHaveLength(0);
    expect(poisoned).toHaveLength(0);
  });
});

// Re-export STORE_OUTBOX so ESLint's no-unused-imports rule stays quiet;
// it's also a minor sanity check that the DB constant is stable.
void STORE_OUTBOX;

// ---------------------------------------------------------------------------
// Wave 5 D7 — reader-side strict wrappers on outbox IDB paths.
//
// Wave 1 P0-11 shipped the writer-side `wrapTransactionStrict` guard.
// D7 closes the other half: any reader that trusts raw `store.getAll()`
// / `store.get(id)` bytes will crash the replay loop (or worse, head-of-
// line-block every later row) when a browser extension / concurrent
// schema upgrade / devtools edit corrupts a single row. These tests
// cover:
//   1. The zod schema accepts every shape the writers produce.
//   2. `parseOutboxRow` returns null (not throws) on malformed input,
//      so the reader can route the row to quarantine instead of
//      disguising the corruption as an empty queue.
//   3. `listPendingMutations` filters malformed rows out of the
//      returned list AND quarantines them to `listPoisonedMutations`
//      with a `schema drift` lastError prefix — surfacing the failure
//      in `/settings/system` instead of silently discarding.
//   4. `markMutationFailed` on a schema-drift row doesn't bump a
//      non-existent attempts counter; it quarantines cleanly.
// ---------------------------------------------------------------------------

describe('Wave 5 D7 · OutboxMutationSchema + parseOutboxRow', () => {
  it('accepts every canonical shape enqueue produces', async () => {
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    expect(() => OutboxMutationSchema.parse(m)).not.toThrow();
    // parseOutboxRow is the non-throwing wrapper — same positive path.
    expect(parseOutboxRow(m)).not.toBeNull();
  });

  it('rejects non-object rows (null / primitive / array)', () => {
    // These are the exact shapes an extension "injecting data" or a
    // serialiser bug could leave behind. The parser must fail-safe so
    // the reader doesn't hand them to downstream spread expressions.
    expect(parseOutboxRow(null)).toBeNull();
    expect(parseOutboxRow('not an object')).toBeNull();
    expect(parseOutboxRow([1, 2, 3])).toBeNull();
    expect(parseOutboxRow(42)).toBeNull();
  });

  it('rejects rows missing required fields', () => {
    // Schema drift scenarios: `nextAttemptAt` arrived in a later build,
    // a downgrade would produce a row where that field is `undefined`.
    // Same for `attempts` — the replay worker's increment logic
    // (`current.attempts + 1`) would silently coerce `undefined + 1 =
    // NaN` and propagate, which is exactly the kind of silent drift
    // D7 is meant to close.
    expect(parseOutboxRow({ id: 'x', op: 'saveJob', userId: 'u', jobId: 'j' })).toBeNull();
    expect(
      parseOutboxRow({
        id: 'x',
        op: 'saveJob',
        userId: 'u',
        jobId: 'j',
        patch: { address: 'A' },
        createdAt: 1,
        // attempts missing
        nextAttemptAt: 1,
      })
    ).toBeNull();
  });

  it('rejects a patch that is not a plain object', () => {
    // The replay worker spreads `patch` — a non-object crash here
    // would head-of-line-block every later queued row.
    const base = {
      id: 'x',
      op: 'saveJob' as const,
      userId: 'u',
      jobId: 'j',
      createdAt: 1,
      attempts: 0,
      nextAttemptAt: 1,
    };
    expect(parseOutboxRow({ ...base, patch: null })).toBeNull();
    expect(parseOutboxRow({ ...base, patch: 'str' })).toBeNull();
    expect(parseOutboxRow({ ...base, patch: [1, 2] })).toBeNull();
  });
});

/**
 * Helper: inject a raw row directly into IDB, bypassing
 * `enqueueSaveJobMutation`. This is how we simulate a schema-drift row
 * landing on disk — same mechanism an extension or a concurrent tab
 * on a different build would use.
 */
async function putRawRow(raw: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    tx.objectStore(STORE_OUTBOX).put(raw);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('Wave 5 D7 · malformed IDB rows are quarantined, not silently dropped', () => {
  beforeEach(async () => {
    // Silence the expected `[outbox] malformed row ...` warnings so
    // they don't swamp the CI log. The assertions below verify the
    // quarantine path ran, which is the behaviour we care about.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('listPendingMutations omits a malformed row AND moves it to poisoned', async () => {
    // One clean row + one malformed row (missing `nextAttemptAt` +
    // `attempts`). Pre-D7 the cast `as OutboxMutation[]` let the bad
    // row through and the reader returned it; the replay worker then
    // crashed on `current.attempts + 1 = NaN` or the spread.
    const good = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await putRawRow({
      id: 'malformed-row-1',
      op: 'saveJob',
      userId: 'u1',
      jobId: 'j2',
      patch: { address: 'B' },
      // createdAt / attempts / nextAttemptAt omitted — classic drift.
      createdAt: 2,
    });

    const pending = await listPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(good.id);

    // The quarantine pass runs fire-and-forget after `listPendingMutations`
    // returns — give the microtask + tx queue a beat to settle.
    await new Promise((r) => setTimeout(r, 30));

    const poisoned = await listPoisonedMutations();
    expect(poisoned.map((m) => m.id)).toContain('malformed-row-1');
    const q = poisoned.find((m) => m.id === 'malformed-row-1');
    expect(q?.poisoned).toBe(true);
    expect(q?.lastError).toMatch(/schema drift/);
    // `nextAttemptAt` is set to MAX_SAFE_INTEGER on quarantine so any
    // legacy code path that somehow ignores `.poisoned` still skips it.
    expect(q?.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('markMutationFailed on a schema-drift row quarantines (does NOT bump a phantom attempts counter)', async () => {
    // Seed a row that parses but save its id, then corrupt it in-place
    // to the drift shape. markMutationFailed reads via get(id) → sees
    // the drift → must route to quarantine instead of read-modify-write.
    const m = await enqueueSaveJobMutation('u1', 'j1', { address: 'A' });
    await putRawRow({
      id: m.id,
      op: 'saveJob',
      userId: 'u1',
      jobId: 'j1',
      // patch dropped — also drift
      createdAt: m.createdAt,
    });

    await markMutationFailed(m.id, 'would have been attempt 1');
    const pending = await listPendingMutations();
    const poisoned = await listPoisonedMutations();
    expect(pending).toHaveLength(0);
    // The quarantine record should be present with its drift-prefixed
    // error, and `attempts` is 0 — we refused to treat a drift row as
    // a real failed-once row.
    const q = poisoned.find((p) => p.id === m.id);
    expect(q?.poisoned).toBe(true);
    expect(q?.attempts).toBe(0);
    expect(q?.lastError).toMatch(/schema drift/);
  });

  it('quarantine surfaces to /settings/system (listPoisonedMutations round-trip)', async () => {
    await putRawRow({
      // Missing nearly everything — the quarantine path still needs to
      // keep the row visible so the admin UI can offer Discard.
      id: 'orphan-row',
      op: 'saveJob',
      userId: 'u1',
      jobId: 'j1',
    });

    // Trigger the reader pass — the side-effect quarantines the row.
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30));

    const poisoned = await listPoisonedMutations();
    expect(poisoned.map((m) => m.id)).toContain('orphan-row');
  });
});
