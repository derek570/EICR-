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
 * Purge (sign-out) is the SOLE deletion and is FENCED: it advances a purge
 * generation and runs on the SAME chain, so a write already queued behind
 * it, or a late write from a binder created before it, can never
 * resurrect the outgoing user's row (Codex E-TERM cycle-1).
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
    channel.onmessage = (event: MessageEvent<unknown>) => {
      // A sibling tab signed out: advance THIS tab's generation too, so a
      // binder created here before the remote purge is fenced as well
      // (Codex mini-review: the fence must span tabs, not just modules).
      if (event.data === 'purged') purgeGeneration += 1;
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

// ── Serialised write chain + purge fence ───────────────────────────────

let chain: Promise<void> = Promise.resolve();
/** Advanced by every purge. A write carrying an OLDER generation is a
 *  no-op at execution time — the fence a pre-purge binder cannot cross. */
let purgeGeneration = 0;

function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op).catch((err) => {
    console.warn('[unresolved-audio] op failed', err);
  });
  chain = next;
  return next;
}

/** Awaitable drain for tests / the PDF page (every queued write landed). */
export function flushUnresolvedAudioWrites(): Promise<void> {
  void drainPendingUnresolvedAudioEvidence();
  return chain;
}

export function currentUnresolvedAudioGeneration(): number {
  return purgeGeneration;
}

/** Test seam: what a sibling tab's `purged` broadcast does to THIS tab. */
export function __receiveRemotePurgeForTests(): void {
  purgeGeneration += 1;
}

/** Warm the v6 connection (runs the upgrade) BEFORE capture begins, so
 *  the first material upsert never pays — or loses to — the migration. */
export function primeUnresolvedAudioStore(): void {
  if (!isSupported()) return;
  void openDB().catch(() => {
    /* the first write will retry the open */
  });
}

// ── CRUD ───────────────────────────────────────────────────────────────

// ── Evidence coalescing ────────────────────────────────────────────────
//
// A material source republishes its evidence on EVERY later voiced frame
// (AudioWorklet blocks arrive ~100×/s). The FIRST row for a key persists
// immediately (durability at accrual); every later evidence update for a
// key keeps only the NEWEST snapshot and drains in one batched
// transaction after `EVIDENCE_DRAIN_MS`. Terminal transitions, the
// certificate clear and purge are ORDERING BARRIERS: they drain pending
// evidence first, so a resolve never overtakes the upsert it depends on
// (Codex E-TERM cycle-6).

export const EVIDENCE_DRAIN_MS = 250;
const knownKeys = new Set<string>();
const pendingEvidence = new Map<string, { record: UnresolvedAudioRecord; generation: number }>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let physicalWriteCount = 0;

/** Test seam: physical IDB write transactions so far. */
export function __physicalWriteCountForTests(): number {
  return physicalWriteCount;
}

function writeBatch(
  batch: Array<{ record: UnresolvedAudioRecord; generation: number }>
): Promise<void> {
  return enqueue(async () => {
    const live = batch.filter((b) => b.generation === purgeGeneration);
    if (live.length === 0) return;
    const db = await openDB();
    const stillLive = live.filter((b) => b.generation === purgeGeneration);
    if (stillLive.length === 0) return; // a purge landed during the open
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    for (const { record, generation } of stillLive) {
      const existing = (await wrapRequest(store.get(record.key))) as UnresolvedAudioRecord | null;
      if (generation !== purgeGeneration) {
        tx.abort(); // a sibling tab purged while the read was in flight
        return;
      }
      store.put(mergeUnresolvedAudioRecord(existing ?? null, record));
    }
    await wrapTransaction(tx);
    physicalWriteCount += 1;
    notifyChanged();
  });
}

/** Drain every pending evidence snapshot NOW (one batched transaction). */
export function drainPendingUnresolvedAudioEvidence(): Promise<void> {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  if (pendingEvidence.size === 0) return Promise.resolve();
  const batch = [...pendingEvidence.values()];
  pendingEvidence.clear();
  return writeBatch(batch);
}

function scheduleDrain(): void {
  if (drainTimer !== null) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainPendingUnresolvedAudioEvidence();
  }, EVIDENCE_DRAIN_MS);
}

export async function upsertUnresolvedAudio(
  record: UnresolvedAudioRecord,
  generation: number = purgeGeneration
): Promise<void> {
  if (!isSupported()) return;
  if (knownKeys.has(record.key)) {
    // Later evidence: keep only the newest snapshot, drain in a batch.
    pendingEvidence.set(record.key, { record, generation });
    scheduleDrain();
    return;
  }
  // First row for this key: persist immediately (durability at accrual).
  knownKeys.add(record.key);
  return writeBatch([{ record, generation }]);
}

export async function resolveUnresolvedAudio(
  key: string,
  via: UnresolvedAudioResolvedVia,
  now: number = Date.now(),
  generation: number = purgeGeneration
): Promise<void> {
  if (!isSupported()) return;
  void drainPendingUnresolvedAudioEvidence(); // barrier: evidence lands first
  return enqueue(async () => {
    if (generation !== purgeGeneration) return; // fenced by a purge
    const db = await openDB();
    if (generation !== purgeGeneration) return; // a purge landed during the open
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    const existing = (await wrapRequest(store.get(key))) as UnresolvedAudioRecord | null;
    if (generation !== purgeGeneration) {
      tx.abort(); // a sibling tab purged while the read was in flight
      return;
    }
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
    await flushUnresolvedAudioWrites(); // observe every queued write
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
  await flushUnresolvedAudioWrites();
  const db = await openDB();
  const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readonly');
  const rows = (await wrapRequest(tx.objectStore(STORE_UNRESOLVED_AUDIO).getAll())) as
    | UnresolvedAudioRecord[]
    | null;
  return rows ?? [];
}

/** Certificate completion: terminalize `certificate_cleared` ONLY rows of
 *  this user+job whose recording session is NOT in `activeSessionIds` at
 *  the success instant. ONE enqueued read-write transaction over the
 *  user/job index — the active-set snapshot is applied atomically, so a
 *  concurrent upsert cannot slip between the read and the writes. Resolves
 *  to the number of rows terminalized. */
export async function clearUnresolvedAudioForCertificate(
  userId: string,
  jobId: string,
  activeSessionIds: ReadonlySet<string>,
  now: number = Date.now()
): Promise<number> {
  if (!isSupported()) return 0;
  let cleared = 0;
  void drainPendingUnresolvedAudioEvidence(); // barrier
  await enqueue(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_UNRESOLVED_AUDIO);
    const rows = (await wrapRequest(
      store.index(UNRESOLVED_AUDIO_INDEX_BY_USER_JOB).getAll([userId, jobId])
    )) as UnresolvedAudioRecord[] | null;
    const clearable = selectCertificateClearable(rows ?? [], { userId, jobId, activeSessionIds });
    for (const row of clearable) {
      store.put(resolveUnresolvedAudioRecord(row, 'certificate_cleared', now));
    }
    await wrapTransaction(tx);
    cleared = clearable.length;
    if (cleared > 0) notifyChanged();
  });
  return cleared;
}

/** Sign-out / account switch — the SOLE deletion. Advances the purge
 *  generation SYNCHRONOUSLY (so every write queued or created before this
 *  call is fenced out at execution) and clears the store on the same
 *  chain behind any already-started write. */
export function purgeUnresolvedAudio(): Promise<void> {
  purgeGeneration += 1;
  // Pending evidence from the outgoing generation is dropped outright.
  pendingEvidence.clear();
  knownKeys.clear();
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  try {
    getChannel()?.postMessage('purged'); // sibling tabs fence immediately
  } catch {
    /* non-critical */
  }
  if (!isSupported()) return Promise.resolve();
  return enqueue(async () => {
    const db = await openDB();
    const tx = db.transaction(STORE_UNRESOLVED_AUDIO, 'readwrite');
    tx.objectStore(STORE_UNRESOLVED_AUDIO).clear();
    await wrapTransaction(tx);
    notifyChanged();
  });
}

/** Owner reconciliation at any (re-)authentication: if ANY stored row
 *  belongs to a user other than `userId` — a sign-out whose purge was
 *  interrupted, or one that never recorded the previous user — purge.
 *  Same-user relaunch rows are preserved. */
export async function reconcileUnresolvedAudioOwner(userId: string): Promise<void> {
  if (!isSupported()) return;
  const rows = await listAllUnresolvedAudio().catch(() => [] as UnresolvedAudioRecord[]);
  if (rows.some((r) => r.userId !== userId)) await purgeUnresolvedAudio();
}

/** The binder's port over this module, bound to the purge generation
 *  current at SESSION START: a purge after that fences every later write
 *  from this session's binder. */
export function createUnresolvedAudioPort(): UnresolvedAudioPort {
  const generation = purgeGeneration;
  return {
    upsert: (record) => {
      void upsertUnresolvedAudio(record, generation);
    },
    resolve: (key, via) => {
      void resolveUnresolvedAudio(key, via, Date.now(), generation);
    },
  };
}
