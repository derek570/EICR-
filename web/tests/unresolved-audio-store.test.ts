/**
 * PLAN-E-TERM test 4 (persistence) — the IDB port over `certmate-cache`
 * v6 store `unresolved-audio`, on fake-indexeddb (loaded by tests/setup.ts):
 *  - the migration follows `job-cache.ts` rules (additive store + index);
 *  - upsert merges, resolve tombstones (first terminal wins), list is
 *    scoped by user+job, certificate clear honours the active-session set;
 *  - writes are serialised (upsert-then-resolve never reorders);
 *  - `clearJobCache()` (sign-out) is the SOLE deletion.
 */
import { describe, expect, it } from 'vitest';
import {
  DB_VERSION,
  STORE_UNRESOLVED_AUDIO,
  UNRESOLVED_AUDIO_INDEX_BY_USER_JOB,
  clearJobCache,
  openDB,
} from '@/lib/pwa/job-cache';
import {
  clearUnresolvedAudioForCertificate,
  flushUnresolvedAudioWrites,
  listAllUnresolvedAudio,
  listUnresolvedAudioForJob,
  resolveUnresolvedAudio,
  subscribeUnresolvedAudioChanges,
  createUnresolvedAudioPort,
  currentUnresolvedAudioGeneration,
  purgeUnresolvedAudio,
  upsertUnresolvedAudio,
} from '@/lib/recording/unresolved-audio-store';
import {
  unresolvedAudioKey,
  type UnresolvedAudioRecord,
} from '@/lib/recording/unresolved-audio-record';

let seq = 0;
function row(over: Partial<UnresolvedAudioRecord> = {}): UnresolvedAudioRecord {
  seq += 1;
  const session = over.recordingSessionId ?? `sess-${seq}`;
  const source = over.lossSourceKey ?? 'episode:1';
  const userId = over.userId ?? 'u1';
  const jobId = over.jobId ?? 'j1';
  return {
    key: unresolvedAudioKey(userId, jobId, session, source),
    userId,
    jobId,
    recordingSessionId: session,
    lossSourceKey: source,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    voicedDurationMs: 500,
    resolvedVia: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('migration (test 4)', () => {
  it('v6 adds the `unresolved-audio` store with the by-user-job compound index', async () => {
    expect(DB_VERSION).toBe(6);
    const db = await openDB();
    expect(db.objectStoreNames.contains(STORE_UNRESOLVED_AUDIO)).toBe(true);
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readonly');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    expect(store.keyPath).toBe('key');
    expect(store.indexNames.contains(UNRESOLVED_AUDIO_INDEX_BY_USER_JOB)).toBe(true);
    expect(store.index(UNRESOLVED_AUDIO_INDEX_BY_USER_JOB).keyPath).toEqual(['userId', 'jobId']);
  });
});

describe('upsert / resolve / list', () => {
  it('upsert then resolve through the fire-and-forget port land in order (serialised chain)', async () => {
    const r = row();
    const port = createUnresolvedAudioPort();
    port.upsert(r);
    port.resolve(r.key, 'completion');
    await flushUnresolvedAudioWrites();
    const rows = await listUnresolvedAudioForJob('u1', 'j1');
    const found = rows.find((x) => x.key === r.key)!;
    expect(found.resolvedVia).toBe('completion');
  });

  it('a second upsert refreshes evidence but keeps createdAt and an existing tombstone', async () => {
    const r = row();
    await upsertUnresolvedAudio(r);
    await resolveUnresolvedAudio(r.key, 'dismissed', 50);
    await upsertUnresolvedAudio({ ...r, voicedDurationMs: 900, updatedAt: 99, createdAt: 77 });
    const found = (await listAllUnresolvedAudio()).find((x) => x.key === r.key)!;
    expect(found.voicedDurationMs).toBe(900);
    expect(found.createdAt).toBe(1);
    expect(found.resolvedVia).toBe('dismissed');
    expect(found.updatedAt).toBe(99);
  });

  it('resolve on a missing key manufactures nothing; a second resolve never overwrites (first terminal wins)', async () => {
    await resolveUnresolvedAudio(
      unresolvedAudioKey('u1', 'j1', 'ghost', 'episode:1'),
      'completion'
    );
    expect((await listAllUnresolvedAudio()).some((x) => x.recordingSessionId === 'ghost')).toBe(
      false
    );
    const r = row();
    await upsertUnresolvedAudio(r);
    await resolveUnresolvedAudio(r.key, 'retired_immaterial');
    await resolveUnresolvedAudio(r.key, 'certificate_cleared');
    const found = (await listAllUnresolvedAudio()).find((x) => x.key === r.key)!;
    expect(found.resolvedVia).toBe('retired_immaterial');
  });

  it('list is scoped by (userId, jobId) and sorted by window start', async () => {
    const a = row({ userId: 'uX', jobId: 'jX', windowStartMs: 5000 });
    const b = row({ userId: 'uX', jobId: 'jX', windowStartMs: 1000 });
    const c = row({ userId: 'uX', jobId: 'jOTHER' });
    await Promise.all([
      upsertUnresolvedAudio(a),
      upsertUnresolvedAudio(b),
      upsertUnresolvedAudio(c),
    ]);
    const rows = await listUnresolvedAudioForJob('uX', 'jX');
    expect(rows.map((x) => x.key)).toEqual([b.key, a.key]);
  });

  it('notifies same-tab subscribers on every write', async () => {
    let n = 0;
    const off = subscribeUnresolvedAudioChanges(() => {
      n += 1;
    });
    const r = row();
    await upsertUnresolvedAudio(r);
    await resolveUnresolvedAudio(r.key, 'dismissed');
    off();
    expect(n).toBe(2);
  });
});

describe('certificate clear honours the active-session set (5b)', () => {
  it('terminalizes only rows whose session is NOT active; active rows survive', async () => {
    const inactive = row({ userId: 'uP', jobId: 'jP', recordingSessionId: 'sess-done' });
    const active = row({ userId: 'uP', jobId: 'jP', recordingSessionId: 'sess-live' });
    const already = row({
      userId: 'uP',
      jobId: 'jP',
      recordingSessionId: 'sess-dismissed',
      resolvedVia: 'dismissed',
    });
    await Promise.all([
      upsertUnresolvedAudio(inactive),
      upsertUnresolvedAudio(active),
      upsertUnresolvedAudio(already),
    ]);
    const n = await clearUnresolvedAudioForCertificate('uP', 'jP', new Set(['sess-live']), 123);
    expect(n).toBe(1);
    const rows = await listUnresolvedAudioForJob('uP', 'jP');
    const by = (s: string) => rows.find((x) => x.recordingSessionId === s)!;
    expect(by('sess-done').resolvedVia).toBe('certificate_cleared');
    expect(by('sess-done').updatedAt).toBe(123);
    expect(by('sess-live').resolvedVia).toBeNull();
    expect(by('sess-dismissed').resolvedVia).toBe('dismissed');
  });
});

describe('purge fence (Codex cycle-1)', () => {
  it('a port created BEFORE the purge cannot write after it; a port created after can', async () => {
    const before = createUnresolvedAudioPort();
    const g0 = currentUnresolvedAudioGeneration();
    await purgeUnresolvedAudio();
    expect(currentUnresolvedAudioGeneration()).toBe(g0 + 1);
    const late = row({ userId: 'uF' });
    before.upsert(late); // late write from the outgoing session's binder
    await flushUnresolvedAudioWrites();
    expect((await listAllUnresolvedAudio()).some((x) => x.userId === 'uF')).toBe(false);
    const after = createUnresolvedAudioPort();
    after.upsert(row({ userId: 'uG' }));
    await flushUnresolvedAudioWrites();
    expect((await listAllUnresolvedAudio()).some((x) => x.userId === 'uG')).toBe(true);
  });

  it('a write QUEUED before the purge is fenced too (purge advances the generation synchronously)', async () => {
    const port = createUnresolvedAudioPort();
    port.upsert(row({ userId: 'uQ' }));
    const purged = purgeUnresolvedAudio(); // queued behind the upsert, generation already advanced
    await purged;
    await flushUnresolvedAudioWrites();
    expect((await listAllUnresolvedAudio()).some((x) => x.userId === 'uQ')).toBe(false);
  });
});

describe('sign-out purge is the SOLE deletion', () => {
  it('clearJobCache() empties the store', async () => {
    await upsertUnresolvedAudio(row({ userId: 'uZ' }));
    expect((await listAllUnresolvedAudio()).length).toBeGreaterThan(0);
    await clearJobCache();
    expect(await listAllUnresolvedAudio()).toEqual([]);
  });
});
