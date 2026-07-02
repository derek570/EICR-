'use client';

/**
 * Pending CCU-extraction queue — web port of iOS
 * `PendingExtractionQueue.swift` (save-first model, 2026-04-28) +
 * the submit/retry branching from `CCUExtractionViewModel.processPhoto`
 * / `resubmitPendingExtraction`.
 *
 * Semantics (iOS canon, mirrored one-for-one):
 *   1. **Persist before upload.** As soon as the inspector picks a CCU
 *      photo, the Blob + metadata (job, mode, target board, idempotency
 *      key) are written to IDB. The upload then runs against the queue
 *      entry — "in flight" = "in queue", so a connection failure or a
 *      tab crash mid-upload loses neither the photo nor the mode.
 *   2. On success the entry is removed.
 *   3. On RETRYABLE failure (network, 5xx, 429) the entry stays queued;
 *      the UI shows a positive "photo saved — will retry" state, and
 *      auto-retry fires when connectivity returns (+ manual per-row /
 *      Retry-All buttons on the circuits-page banner).
 *   4. On `422 retake_required` (backend quality gate) the entry is
 *      DROPPED — re-submitting the same bytes hits the same gate — and
 *      a typed retake result is surfaced so the UI can show a friendly
 *      "retake the photo" card, never the generic error path and never
 *      an auto-retry loop (iOS `CCUExtractionViewModel.swift:464-470`).
 *   5. On any other non-retryable 4xx the entry is dropped (nothing
 *      useful to retry) and the error surfaces normally.
 *
 * Idempotency: ONE UUID per capture, minted at queue-write time and
 * persisted with the entry. Every attempt (first upload, auto-retry,
 * manual retry) sends the SAME key as `X-Idempotency-Key`, which is
 * the only way the backend's `withIdempotency('ccu')` middleware can
 * recognise retries — one capture = one paid vision call. A 409
 * `idempotency_inflight` response means the ORIGINAL request is still
 * processing server-side: honour its `Retry-After: 5` header and
 * re-poll with the same key (the retry then returns the cached result
 * via `X-Idempotency-Replay`), never mint a new key.
 *
 * CCU photos ONLY — iOS's queue does not cover document extraction
 * (`JobViewModel.analyzeDocument` uploads directly), so neither does
 * this. A doc-photo retry queue would be a non-iOS enhancement
 * needing its own decision (parent plan WS6 item 2).
 */

import { api } from '../api-client';
import { ApiError, type CCUAnalysis } from '../types';
import type { CcuApplyMode } from '../recording/apply-ccu-analysis';
import {
  PENDING_CCU_INDEX_BY_JOB,
  STORE_PENDING_CCU,
  isSupported,
  openDB,
  wrapRequest,
  wrapTransaction,
  wrapTransactionStrict,
} from '../pwa/job-cache';

export interface PendingCcuExtraction {
  /** `{jobId}_{epochMs}` — mirrors the iOS queue-entry filename. */
  id: string;
  userId: string;
  jobId: string;
  mode: CcuApplyMode;
  /** The photo bytes. IDB structured-clones Blobs, so the row survives
   *  reload/crash exactly like iOS's on-disk .jpg. */
  photo: Blob;
  originalFilename: string;
  photoSizeBytes: number;
  /** Stable key sent as X-Idempotency-Key on EVERY attempt. */
  idempotencyKey: string;
  /** Epoch ms of capture — drives the banner's relative timestamp. */
  timestamp: number;
  /** Board the analysis targets (circuits-page selection at capture
   *  time) — needed to re-run the apply path identically on replay. */
  targetBoardId: string | null;
}

// ---------------------------------------------------------------------------
// Change notifications — same-tab subscribers (banner, badge) refresh
// when the queue mutates. Cross-tab via BroadcastChannel, mirroring the
// outbox's pattern.
// ---------------------------------------------------------------------------

const CHANNEL_NAME = 'cm-pending-ccu';
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

export function subscribePendingCcuChanges(fn: () => void): () => void {
  listeners.add(fn);
  getChannel();
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Persist a capture BEFORE its first upload. Returns the queue entry
 * (with its freshly-minted idempotency key), or null when IDB is
 * unavailable — callers should still attempt the upload in that case
 * (degraded no-queue mode; same as iOS returning nil from
 * `savePendingExtraction` and uploading anyway).
 */
export async function savePendingCcuExtraction(input: {
  userId: string;
  jobId: string;
  mode: CcuApplyMode;
  photo: Blob;
  targetBoardId: string | null;
  originalFilename?: string;
}): Promise<PendingCcuExtraction | null> {
  if (!isSupported()) return null;
  const entry: PendingCcuExtraction = {
    id: `${input.jobId}_${Date.now()}`,
    userId: input.userId,
    jobId: input.jobId,
    mode: input.mode,
    photo: input.photo,
    originalFilename:
      input.originalFilename ?? (input.photo instanceof File ? input.photo.name : 'ccu.jpg'),
    photoSizeBytes: input.photo.size,
    idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    targetBoardId: input.targetBoardId,
  };
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PENDING_CCU, 'readwrite');
    tx.objectStore(STORE_PENDING_CCU).put(entry);
    // Strict — a silently-dropped queue write would report "saved, will
    // retry" for a photo that is actually gone (same rationale as the
    // outbox's strict writes).
    await wrapTransactionStrict(tx);
    notifyChanged();
    return entry;
  } catch (err) {
    console.warn('[pending-ccu] save failed', err);
    return null;
  }
}

/** All pending entries for a job, newest first (iOS sort order). */
export async function getPendingCcuExtractions(jobId: string): Promise<PendingCcuExtraction[]> {
  if (!isSupported()) return [];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PENDING_CCU, 'readonly');
    const index = tx.objectStore(STORE_PENDING_CCU).index(PENDING_CCU_INDEX_BY_JOB);
    const rows = ((await wrapRequest(index.getAll(jobId))) ?? []) as PendingCcuExtraction[];
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  } catch (err) {
    console.warn('[pending-ccu] read failed', err);
    return [];
  }
}

export async function removePendingCcuExtraction(id: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PENDING_CCU, 'readwrite');
    tx.objectStore(STORE_PENDING_CCU).delete(id);
    await wrapTransaction(tx);
    notifyChanged();
  } catch (err) {
    console.warn('[pending-ccu] remove failed', err);
  }
}

// ---------------------------------------------------------------------------
// Submit engine
// ---------------------------------------------------------------------------

export type CcuSubmitResult =
  | { kind: 'analysis'; analysis: CCUAnalysis }
  | { kind: 'retake'; reason: string; message: string }
  | { kind: 'queued'; message: string }
  | { kind: 'error'; message: string };

/** How many 409-inflight polls a single submit will sit through before
 *  giving up and leaving the entry queued for a later manual retry. */
const MAX_INFLIGHT_POLLS = 2;

/** Test seam — the 409 Retry-After wait. Overridable so tests don't
 *  sleep for real. Default honours the middleware's `Retry-After: 5`. */
export const inflightWait = {
  ms(retryAfterHeaderSeconds: number | null): number {
    return (retryAfterHeaderSeconds ?? 5) * 1000;
  },
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  },
};

function isRetryable(err: unknown): boolean {
  // Network-level failure (fetch TypeError) or server-side transient.
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429;
  return err instanceof TypeError || err instanceof Error === false;
}

function isRetakeRequired(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 422 &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { status?: string }).status === 'retake_required'
  );
}

function isIdempotencyInflight(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { error?: string }).error === 'idempotency_inflight'
  );
}

/**
 * Upload a queued capture (first attempt or retry) and resolve the
 * queue entry according to the iOS branching. The SAME persisted
 * idempotency key is sent on every call for this entry.
 */
export async function submitCcuCapture(entry: PendingCcuExtraction): Promise<CcuSubmitResult> {
  let inflightPolls = 0;
  for (;;) {
    try {
      const analysis = await api.analyzeCCU(entry.photo, {
        idempotencyKey: entry.idempotencyKey,
      });
      await removePendingCcuExtraction(entry.id);
      return { kind: 'analysis', analysis };
    } catch (err) {
      if (isIdempotencyInflight(err)) {
        // The original request is still processing server-side. Honour
        // Retry-After and re-poll with the SAME key — the middleware
        // replays the cached response once the original completes.
        if (inflightPolls >= MAX_INFLIGHT_POLLS) {
          return {
            kind: 'queued',
            message: 'Photo saved — still processing, retry in a moment.',
          };
        }
        inflightPolls += 1;
        await inflightWait.sleep(inflightWait.ms(5));
        continue;
      }
      if (isRetakeRequired(err)) {
        // Quality gate: same bytes would fail again — drop the entry,
        // never auto-retry (iOS CCUExtractionViewModel.swift:464-470).
        await removePendingCcuExtraction(entry.id);
        const body = err.body as { reason?: string; message?: string };
        return {
          kind: 'retake',
          reason: body.reason ?? 'quality_gate',
          message: body.message ?? err.message,
        };
      }
      if (isRetryable(err)) {
        // Entry stays queued; connectivity restore / manual retry
        // resubmits with the same key.
        return {
          kind: 'queued',
          message: 'Photo saved — will retry when connection returns.',
        };
      }
      // Non-retryable (auth, validation, corrupt image) — nothing
      // useful to retry against.
      await removePendingCcuExtraction(entry.id);
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : 'CCU analysis failed.',
      };
    }
  }
}
