/**
 * PLAN-E-TERM — the IDB port for the post-session unresolved-audio record
 * (`certmate-cache` v6, store `unresolved-audio`; schema + lifecycle in
 * `unresolved-audio-record.ts`).
 *
 * Writes are SERIALISED through one promise chain: the binder fires
 * `upsert` then `resolve` synchronously from loss-event paths and must
 * never observe them reordered. Every op swallows IDB failure (a record
 * problem must never tear down a recording session) and notifies same-tab
 * subscribers + sibling tabs (BroadcastChannel), mirroring
 * `ccu/pending-extraction-queue.ts`.
 *
 * Purge: the store joins `clearJobCache()` (sign-out) — the SOLE deletion.
 */

import {
  STORE_UNRESOLVED_AUDIO,
  UNRESOLVED_AUDIO_INDEX_BY_USER_JOB,
  isSupported,
  openDB,
  wrapRequest,
  wrapTransaction,
} from '../pwa/job-cache';
import {
  mergeUnresolvedAudioRecord,
  resolveUnresolvedAudioRecord,
  selectCertificateClearable,
  type UnresolvedAudioPort,
  type UnresolvedAudioRecord,
  type UnresolvedAudioResolvedVia,
} from './unresolved-audio-record';

const CHANNEL_NAME = 'cm-unresolved-audio';
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      for (const fn of listeners) fn();
    };
  }
  return channel;
}

function notifyChanged(): void {
  for (const fn of listeners) fn();
  try {
    getChannel()?.postMessage('changed');
  } catch {
    /* non-critical */
  }
}

export function subscribeUnresolvedAudioChanges(fn: () => void): () => void {
  listeners.add(fn);
  getChannel();
  return () => listeners.delete(fn);
}

// ── Serialised write chain ─────────────────────────────────────────────

let chain: Promise<void> = Promise.resolve();

function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op).catch((err) => {
    console.warn('[unresolved-audio] op failed', err);
  });
  chain = next;
  return next;
}

/** Awaitable drain for tests / the PDF page (every queued write landed). */
export function flushUnresolvedAudioWrites(): Promise<void> {
  return chain;
}

// ── CRUD ───────────────────────────────────────────────────────────────

export async function upsertUnresolvedAudio(record: UnresolvedAudioRecord): Promise<void> {
  if (!isSupported()) return;
  return enqueue(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    const existing = (await wrapRequest(store.get(record.key))) as UnresolvedAudioRecord | null;
    store.put(mergeUnresolvedAudioRecord(existing ?? null, record));
    await wrapTransaction(tx);
    notifyChanged();
  });
}

export async function resolveUnresolvedAudio(
  key: string,
  via: UnresolvedAudioResolvedVia,
  now: number = Date.now()
): Promise<void> {
  if (!isSupported()) return;
  return enqueue(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    const existing = (await wrapRequest(store.get(key))) as UnresolvedAudioRecord | null;
    // No row: the source never went material (a completion/retirement for
    // it is not a TERM event). Never manufacture a row here.
    if (!existing) return;
    const next = resolveUnresolvedAudioRecord(existing, via, now);
    if (next === existing) return; // already terminal — first wins
    store.put(next);
    await wrapTransaction(tx);
    notifyChanged();
  });
}

export async function listUnresolvedAudioForJob(
  userId: string,
  jobId: string
): Promise<UnresolvedAudioRecord[]> {
  if (!isSupported()) return [];
  try {
    await chain; // observe every queued write
    const db = await openDB();
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readonly');
    const index = tx.objectStore(STORE_UNRESOLVED_AUDIO).index(UNRESOLVED_AUDIO_INDEX_BY_USER_JOB);
    const rows = (await wrapRequest(index.getAll([userId, jobId]))) as
      | UnresolvedAudioRecord[]
      | null;
    return (rows ?? []).sort((a, b) => a.windowStartMs - b.windowStartMs);
  } catch (err) {
    console.warn('[unresolved-audio] list failed', err);
    return [];
  }
}

/** Test/diagnostic: every row, all users/jobs. */
export async function listAllUnresolvedAudio(): Promise<UnresolvedAudioRecord[]> {
  if (!isSupported()) return [];
  await chain;
  const db = await openDB();
  const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readonly');
  const rows = (await wrapRequest(tx.objectStore(STORE_UNRESOLVED_AUDIO).getAll())) as
    | UnresolvedAudioRecord[]
    | null;
  return rows ?? [];
}

/** Certificate completion: terminalize `certificate_cleared` ONLY rows of
 *  this user+job whose recording session is NOT in `activeSessionIds` at
 *  the success instant. A still-accruing session's rows survive. Returns
 *  the number of rows terminalized. */
export async function clearUnresolvedAudioForCertificate(
  userId: string,
  jobId: string,
  activeSessionIds: ReadonlySet<string>,
  now: number = Date.now()
): Promise<number> {
  if (!isSupported()) return 0;
  const rows = await listUnresolvedAudioForJob(userId, jobId);
  const clearable = selectCertificateClearable(rows, { userId, jobId, activeSessionIds });
  for (const row of clearable) {
    await resolveUnresolvedAudio(row.key, 'certificate_cleared', now);
  }
  return clearable.length;
}

/** The binder's port over this module. */
export const unresolvedAudioIdbPort: UnresolvedAudioPort = {
  upsert: (record) => {
    void upsertUnresolvedAudio(record);
  },
  resolve: (key, via) => {
    void resolveUnresolvedAudio(key, via);
  },
};
