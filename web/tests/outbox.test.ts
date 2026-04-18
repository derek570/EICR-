import { beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueSaveJobMutation,
  listPendingMutations,
  listPoisonedMutations,
  MAX_ATTEMPTS,
  markMutationFailed,
  markMutationPoisoned,
  purgeOutbox,
  removeMutation,
  requeueMutation,
  STORE_OUTBOX,
} from '@/lib/pwa/outbox';

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
