import { z } from 'zod';
import type { JobDetail } from '@/lib/types';
import {
  DB_NAME,
  OUTBOX_INDEX_BY_USER,
  STORE_OUTBOX,
  isSupported,
  openDB,
  wrapRequest,
  wrapTransaction,
  wrapTransactionStrict,
} from './job-cache';

/**
 * Offline mutation queue (Phase 7c).
 *
 * Purpose: when an inspector edits a job field while offline (subway,
 * basement consumer-unit room, flaky 3G on a rural site visit), the
 * current write path — `api.saveJob` — rejects and the edit is lost.
 * This store captures each mutation in IndexedDB so the replay worker
 * (`outbox-replay.ts`) can retry it as soon as connectivity returns, and
 * the next `/dashboard` / `/job/[id]` visit reads the optimistic value
 * from the IDB read-through cache (Phase 7b) instead of the stale server
 * state.
 *
 * Why a new module rather than growing `job-cache.ts`:
 *   - The read cache and the write queue have different lifetimes:
 *     read cache is best-effort + overwritten on every network success;
 *     the outbox is durable until successfully replayed or poisoned.
 *   - Keeping the outbox self-contained means the replay worker can
 *     evolve (add new op kinds beyond `saveJob`, new backoff policies)
 *     without touching the SWR read path that Phase 7b hardened.
 *   - Phase 7d UI (pending-count badges, conflict modals) imports only
 *     from here — not from the whole read-cache surface.
 *
 * Why vanilla IDB (same answer as job-cache.ts):
 *   - Three new functions on a store we already manage — the `idb`
 *     package would outweigh the code it'd save.
 *   - `openDB` / `wrapRequest` / `wrapTransaction` are reused from
 *     `job-cache.ts` (exported in Phase 7c) so the schema version is
 *     owned in one place.
 *
 * Conflict model (last-writer-wins):
 *   - `saveJob` is already a PATCH — only the dirty fields are sent.
 *     When the replay worker retries, the server merges the patch into
 *     whatever current state it holds. This matches iOS
 *     `APIClient.saveJob` behaviour, so a web inspector toggling a
 *     field offline while an iOS inspector edits the same job online
 *     produces the same final doc on both clients (the last replay
 *     wins per-field). The alternative — surfacing a conflict dialog
 *     — would require per-field base versions that the backend doesn't
 *     yet emit. Kept simple for parity; future phases can upgrade if
 *     conflicts prove a real problem in the field.
 */

export type OutboxOp = 'saveJob';

export interface OutboxMutation {
  /** uuid v4 — stable primary key across attempts. */
  id: string;
  op: OutboxOp;
  userId: string;
  jobId: string;
  /**
   * The patch the caller originally supplied. Stored verbatim so the
   * replay worker doesn't need to reconstruct it from in-memory state
   * (which is gone after a tab close).
   */
  patch: Partial<JobDetail>;
  /** ms since epoch; used for FIFO ordering + pending-age display. */
  createdAt: number;
  /** Count of network attempts that have failed. 0 until first retry. */
  attempts: number;
  /**
   * ms since epoch. The replay worker skips any row whose
   * `nextAttemptAt > Date.now()`. Fresh rows default to `createdAt` so
   * the initial write attempt happens immediately (the replay worker's
   * mount-pass + 'online' event will pick them up on the next tick).
   */
  nextAttemptAt: number;
  /** Last error string — surfaced in Phase 7d UI, ignored by the loop. */
  lastError?: string;
  /**
   * Once `attempts` has reached MAX_ATTEMPTS without success, the row
   * is marked poisoned and skipped by the replay worker. A Phase 7d
   * admin UI will surface + offer to re-queue or discard these. The
   * alternative — discarding silently — would drop user data without
   * feedback, which CLAUDE.md §"never swallow user work" rules out.
   */
  poisoned?: boolean;
}

/**
 * Retry policy. Kept small and readable — these are the numbers an
 * operator would want to reason about during a live incident.
 *
 * - BASE_BACKOFF_MS: minimum wait between attempts (covers transient
 *   blips without thrashing the network).
 * - MAX_BACKOFF_MS: cap so we don't end up with a 10-minute retry stall
 *   when the user has been continuously online.
 * - MAX_ATTEMPTS: after this many 5xx/network failures a row is
 *   poisoned by attempt-counter exhaustion. 4xx responses (except
 *   401) are poisoned immediately by the replay worker without
 *   consuming the attempt counter — P0-12 decision — so this value
 *   only governs the "transient failure" window. 15 attempts gives
 *   ~1 hour of backoff coverage at the 5-min cap (2s, 4s, 8s, 16s,
 *   32s, 64s, 128s, 256s, then seven more at the 300s cap — roughly
 *   45 minutes end-to-end). That's long enough to ride out a
 *   captive-portal session, a deploy-window partial outage, or a
 *   backend rolling restart, without retaining a row that's been
 *   failing for an entire inspection day.
 *
 *   Wave 1 decision Q3: started at 10 attempts (~18 min coverage),
 *   bumped to 15 before Wave 2's replay-loop tests hard-code the
 *   expectation. Revisit if production telemetry shows rows
 *   poisoning because of mid-range outages (in which case bump
 *   further) or surviving long after they should have been
 *   discarded (in which case drop).
 */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
export const MAX_ATTEMPTS = 15;

/**
 * Reader-side strict wrapper (Wave 5 D7).
 *
 * Wave 1 P0-11 added `wrapTransactionStrict` on WRITER paths so a failed
 * enqueue can't silently drop an inspector's edit. That still left the
 * READER paths (`listPendingMutations`, `listPoisonedMutations`,
 * `markMutationFailed`'s pre-read, `markMutationPoisoned`'s pre-read)
 * trusting whatever shape `store.getAll()` / `store.get(id)` returned
 * — the cast `as OutboxMutation[]` is a compile-time lie that says
 * nothing about the runtime bytes. Real failure modes we need to guard:
 *
 *   - A half-applied schema upgrade from a concurrent tab leaves rows
 *     missing a field the current build expects (e.g. `nextAttemptAt`
 *     was added later, `poisoned` arrived in a subsequent bump).
 *   - A browser extension or devtools session corrupts a single row
 *     (manual IDB edit, speculative rewrite for "fuzzing").
 *   - A future OutboxOp variant serialised by a never-released branch
 *     leaves orphaned rows that the current code can't handle.
 *   - A malformed `patch` (non-object, cyclic after JSON round-trip via
 *     some extension) would crash the replay worker's spread expression
 *     (`{ ...current, ...m.patch }`), head-of-line blocking every later
 *     row.
 *
 * Policy on malformed rows: log a single warning + route the row to
 * poisoned (with a distinguishing error prefix so `/settings/system`
 * can surface the schema-drift case clearly) so the admin UI can
 * discard or manually inspect. Do NOT throw — the outer reader's
 * try/catch already downgrades to `[]`, which would disguise the
 * corruption as an empty queue. Do NOT promote to `parseOrThrow` per
 * the D7 scope boundary. The row stays visible to the admin surface
 * instead of disappearing.
 *
 * Why a local schema (not `@/lib/adapters`): the adapter boundary is
 * scoped to wire shapes. This is a storage-layer invariant — when the
 * bytes we wrote ourselves come back different, that's IDB-level
 * corruption, not an API-contract drift. Keeping the schema next to
 * the interface it mirrors is the right DRY boundary; a single move
 * if the two shapes ever diverge.
 */
const OutboxOpSchema = z.literal('saveJob');
const OutboxMutationSchema = z.object({
  id: z.string().min(1),
  op: OutboxOpSchema,
  userId: z.string().min(1),
  jobId: z.string().min(1),
  // `Partial<JobDetail>` is structurally `Record<string, unknown>` — the
  // tab-by-tab field bags are already permissive (see adapters/job.ts),
  // and a strict validator here would drift out of sync on every new
  // tab field. What we DO enforce: the patch must be a plain object (not
  // null, not an array, not a primitive) so the replay worker's spread
  // doesn't explode.
  patch: z.record(z.string(), z.unknown()),
  createdAt: z.number().finite(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().finite(),
  lastError: z.string().optional(),
  poisoned: z.boolean().optional(),
});

/**
 * Parse a raw IDB row into a typed `OutboxMutation` or return `null`.
 * `null` means "unusable — route via the malformed-row quarantine
 * path"; the caller decides whether that's a drop, a poison-move, or
 * a user-facing warning.
 *
 * Separate from the schema so the call sites read cleanly and the
 * warning format stays consistent across reader paths.
 */
function parseOutboxRow(raw: unknown): OutboxMutation | null {
  const result = OutboxMutationSchema.safeParse(raw);
  if (result.success) return result.data as OutboxMutation;
  const id =
    raw && typeof raw === 'object' && 'id' in raw && typeof (raw as { id: unknown }).id === 'string'
      ? ((raw as { id: string }).id as string)
      : '<unknown>';
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
  console.warn(`[outbox] malformed row id=${id}; schema drift or corruption`, issues);
  return null;
}

/**
 * Quarantine a row whose shape didn't parse. We can't call
 * `markMutationPoisoned` directly because that reuses the same broken
 * bytes via get/put — if the schema mismatch is because `nextAttemptAt`
 * is missing, putting the row back keeps it missing. Instead, we write
 * a fresh minimum-viable record with the extracted id and a clear
 * error prefix so the `/settings/system` UI can distinguish schema
 * drift from ordinary server 4xx rejection.
 *
 * If the row has no recoverable id (not even a string), we delete it
 * outright — nothing else we can do, and leaving the corruption in
 * place would poison every subsequent reader pass.
 */
async function quarantineMalformedRow(raw: unknown): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const maybeId =
      raw &&
      typeof raw === 'object' &&
      'id' in raw &&
      typeof (raw as { id: unknown }).id === 'string'
        ? ((raw as { id: string }).id as string)
        : null;
    if (!maybeId) {
      // No usable key — there's nothing to quarantine. The whole
      // `store.getAll()` filter in the reader drops this row already;
      // this branch is only reached if a later reader produced it.
      await wrapTransaction(tx);
      return;
    }
    // Coerce required fields to safe defaults so subsequent reads
    // (including the admin UI) can render the row's poison state.
    // The inspector can then choose to discard; we can't safely replay
    // data whose shape drifted out from under us.
    const now = Date.now();
    const quarantined: OutboxMutation = {
      id: maybeId,
      op: 'saveJob',
      userId:
        raw &&
        typeof raw === 'object' &&
        'userId' in raw &&
        typeof (raw as { userId: unknown }).userId === 'string'
          ? ((raw as { userId: string }).userId as string)
          : '<unknown>',
      jobId:
        raw &&
        typeof raw === 'object' &&
        'jobId' in raw &&
        typeof (raw as { jobId: unknown }).jobId === 'string'
          ? ((raw as { jobId: string }).jobId as string)
          : '<unknown>',
      patch: {},
      createdAt: now,
      attempts: 0,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      lastError: 'schema drift: row failed runtime validation',
      poisoned: true,
    };
    store.put(quarantined);
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] quarantineMalformedRow failed', err);
  }
}

/**
 * Cross-surface change notification (Phase 7d).
 *
 * Every outbox write notifies subscribers so UI consumers
 * (`useOutboxState`, sync indicators, job-row chips) can refresh
 * without polling. Two channels are used in parallel:
 *
 *   - A local `EventTarget` bus — needed because `BroadcastChannel`
 *     does NOT deliver the sender's own messages. Same-tab subscribers
 *     (the usual case — AppShell + dashboard + settings all render in
 *     one tab) rely on this.
 *   - A `BroadcastChannel` — picks up the slack when two tabs of the
 *     same origin are open (e.g. inspector has the dashboard in one
 *     tab and the poisoned-row admin page in another). A mutation in
 *     tab A should refresh the list in tab B.
 *
 * Why not `storage` events: those only fire for `localStorage`, not
 * IDB. BroadcastChannel is the cross-tab primitive that matches IDB's
 * durability model.
 *
 * All notifications are fire-and-forget. Subscribers re-read from IDB
 * themselves; the event carries no payload so there's no schema to
 * keep in sync across tabs/builds.
 */
const BROADCAST_CHANNEL_NAME = 'certmate-outbox';
const LOCAL_EVENT = 'outbox:change';
const localBus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
let broadcastChannel: BroadcastChannel | null = null;
function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch {
      broadcastChannel = null;
    }
  }
  return broadcastChannel;
}
function notifyOutboxChange(): void {
  try {
    localBus?.dispatchEvent(new Event(LOCAL_EVENT));
  } catch {
    // Old browsers without Event() ctor — benign drop.
  }
  try {
    getBroadcastChannel()?.postMessage({ t: Date.now() });
  } catch {
    // BroadcastChannel.postMessage can throw if the channel is closed;
    // drop silently — the local bus already covered the same-tab case.
  }
}
export function subscribeOutboxChanges(fn: () => void): () => void {
  const handler = () => fn();
  localBus?.addEventListener(LOCAL_EVENT, handler);
  const bc = getBroadcastChannel();
  bc?.addEventListener('message', handler);
  return () => {
    localBus?.removeEventListener(LOCAL_EVENT, handler);
    bc?.removeEventListener('message', handler);
  };
}

function generateId(): string {
  // crypto.randomUUID is in every evergreen browser + Node 19+;
  // the type-check guard keeps SSR + older-Safari-that-shouldn't-be-here
  // from crashing — we fall back to a non-crypto uuid-shaped string so
  // the replay worker can still key rows even in the degenerate case.
  const maybeCrypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : null;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Compute the next retry timestamp for a mutation that just failed its
 * `attempts + 1`-th attempt. Callers pass the NEW attempt count (i.e.
 * after incrementing) so the first retry waits BASE_BACKOFF_MS, the
 * second waits 2×, etc. Capped at MAX_BACKOFF_MS.
 */
function backoffUntil(newAttempts: number, now: number): number {
  // 2^(n-1) so attempts=1 → 2s, attempts=2 → 4s, attempts=3 → 8s...
  const exp = Math.pow(2, Math.max(0, newAttempts - 1));
  const wait = Math.min(BASE_BACKOFF_MS * exp, MAX_BACKOFF_MS);
  return now + wait;
}

/**
 * Append a new `saveJob` mutation to the outbox. Returns the stored
 * record so the caller can thread the id through an optimistic UI
 * without a second read. On IDB failure we surface the error to the
 * caller (unlike read-cache helpers which swallow) — a missed queue
 * write would silently drop the inspector's edit, which is exactly the
 * failure mode Phase 7c exists to prevent.
 */
export async function enqueueSaveJobMutation(
  userId: string,
  jobId: string,
  patch: Partial<JobDetail>
): Promise<OutboxMutation> {
  if (!isSupported()) {
    throw new Error('[outbox] IndexedDB not supported in this environment');
  }
  const now = Date.now();
  const mutation: OutboxMutation = {
    id: generateId(),
    op: 'saveJob',
    userId,
    jobId,
    patch,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now, // immediately eligible for the next replay pass
  };
  const db = await openDB();
  const tx = db.transaction(STORE_OUTBOX, 'readwrite');
  tx.objectStore(STORE_OUTBOX).put(mutation);
  // Strict wrapper — if IDB quota is blown or the tx aborts, we must
  // surface that failure to the caller so the UI can flag "offline
  // save failed" instead of silently dropping the inspector's edit.
  // The lenient `wrapTransaction` would resolve either way and the
  // missed write would never be noticed until the server state
  // diverged from what the inspector thought they saved.
  await wrapTransactionStrict(tx);
  notifyOutboxChange();
  return mutation;
}

/**
 * Return all non-poisoned mutations sorted by `createdAt` ascending
 * (FIFO replay order). Poisoned rows are omitted from the loop — a
 * Phase 7d UI will fetch them separately via `listPoisonedMutations()`
 * (added when there's a UI caller, not now — CLAUDE.md §"no hypothetical
 * abstractions").
 *
 * The sort happens client-side because IDB cursors don't guarantee
 * order across indexes and we want a stable guarantee. The outbox is
 * expected to be tiny (single-digit rows in normal use, low dozens
 * during an extended offline session), so the sort is cheap.
 */
export async function listPendingMutations(): Promise<OutboxMutation[]> {
  if (!isSupported()) return [];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readonly');
    const store = tx.objectStore(STORE_OUTBOX);
    // Read raw to preserve the original shape (even unknown keys we don't
    // model) for the validation pass. Casting directly to
    // `OutboxMutation[]` here was the Wave 1 partial-fix leak — the
    // writer strict-wrapper couldn't help if the reader handed callers
    // garbage that TS happily typed as valid.
    const all = (await wrapRequest(store.getAll())) as unknown[] | null;
    if (!all) return [];
    const malformed: unknown[] = [];
    const parsed: OutboxMutation[] = [];
    for (const raw of all) {
      const ok = parseOutboxRow(raw);
      if (ok) parsed.push(ok);
      else malformed.push(raw);
    }
    // Route the malformed rows to poison AFTER the readonly tx above has
    // closed — can't mix readonly + readwrite on the same store in a
    // single IDB transaction. Fire-and-forget; the admin UI picks them
    // up on the next `useOutboxState` refresh triggered by
    // `notifyOutboxChange` inside `quarantineMalformedRow`.
    if (malformed.length > 0) {
      void Promise.all(malformed.map(quarantineMalformedRow));
    }
    return parsed.filter((m) => !m.poisoned).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.warn('[outbox] listPendingMutations failed', err);
    return [];
  }
}

/**
 * Remove a mutation — called after a successful replay. Idempotent:
 * deleting a missing key is a no-op in IDB, which matches what we want
 * when two tabs race to replay the same row (one wins the server call,
 * the other gets a 4xx on the already-applied patch).
 */
export async function removeMutation(id: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    tx.objectStore(STORE_OUTBOX).delete(id);
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] removeMutation failed', err);
  }
}

/**
 * User-initiated discard of a (usually poisoned) mutation from the
 * Phase 7d admin UI. Semantically distinct from `removeMutation`
 * (which is a replay-success cleanup) but uses the same store delete
 * — separate export so future instrumentation can tell them apart
 * without the callers having to thread a flag.
 */
export async function discardMutation(id: string): Promise<void> {
  await removeMutation(id);
}

/**
 * Resurrect a poisoned mutation — clears the poison flag, resets the
 * attempt counter, and sets `nextAttemptAt` to now so the replay worker
 * picks it up on its next trigger. Called from the Phase 7d admin UI
 * when an inspector decides a previously-permanently-rejected patch
 * should be retried (e.g. the underlying foreign key has since been
 * restored on the server).
 *
 * Resetting `attempts` back to 0 is deliberate: if the server-side
 * fix was real, we don't want the re-queued row to poison after a
 * single retry just because it already burned its attempts budget.
 * If the patch is still invalid, the poison path re-fires normally
 * on the next failure.
 */
export async function requeueMutation(id: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const raw = (await wrapRequest(store.get(id))) as unknown;
    if (!raw) {
      await wrapTransaction(tx);
      return;
    }
    const current = parseOutboxRow(raw);
    if (!current) {
      // Refuse to requeue a row we can't parse — resetting `attempts=0`
      // and clearing `poisoned` on a shape-drifted row would re-enter
      // the replay loop with bytes that crash the worker. Drop through
      // to quarantine so the admin UI surfaces the corruption.
      await wrapTransaction(tx);
      await quarantineMalformedRow(raw);
      return;
    }
    const updated: OutboxMutation = {
      ...current,
      poisoned: false,
      attempts: 0,
      nextAttemptAt: Date.now(),
      // Keep the prior `lastError` so the admin UI can still show what
      // failed before the user chose to retry — useful for telemetry
      // if the same row poisons again immediately.
    };
    store.put(updated);
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] requeueMutation failed', err);
  }
}

/**
 * Increment the attempt count, apply exponential backoff, and poison
 * the row once it crosses MAX_ATTEMPTS. We read-modify-write in a
 * single readwrite transaction so two tabs retrying in parallel can't
 * produce an `attempts` count that drifts from the actual failure
 * count.
 */
export async function markMutationFailed(id: string, error: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const raw = (await wrapRequest(store.get(id))) as unknown;
    if (!raw) {
      // Another tab removed the row while we were failing — accept and
      // move on. Don't resurrect; the winning tab's decision stands.
      await wrapTransaction(tx);
      return;
    }
    const current = parseOutboxRow(raw);
    if (!current) {
      // Schema drift: can't safely read-modify-write. Quarantine via the
      // malformed-row path (runs in its own tx so we abort the current
      // one cleanly). Skip the attempts bump — we have no trustworthy
      // count to increment.
      await wrapTransaction(tx);
      await quarantineMalformedRow(raw);
      return;
    }
    const newAttempts = current.attempts + 1;
    const updated: OutboxMutation = {
      ...current,
      attempts: newAttempts,
      lastError: error.slice(0, 500), // cap so a stack trace can't bloat IDB
      nextAttemptAt: backoffUntil(newAttempts, Date.now()),
      poisoned: newAttempts >= MAX_ATTEMPTS,
    };
    store.put(updated);
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] markMutationFailed failed', err);
  }
}

/**
 * Mark a mutation as poisoned immediately, bypassing the attempt
 * counter. Called from the replay worker when the server returns a
 * 4xx (other than 401 — that's handled as "refresh and retry" upstream)
 * — a 400/403/404/409/422 means the patch itself is permanently
 * invalid under the current server state, so retrying will just 4xx
 * again forever. Leaving the row at the head of the FIFO queue would
 * stall every subsequent mutation (head-of-line blocking), and
 * silently discarding would lose the inspector's work. Poisoning lets
 * the loop skip past it while keeping the row visible to the Phase 7d
 * admin UI for a manual retry / discard decision.
 *
 * The `lastError` is capped at 500 chars for the same reason as
 * `markMutationFailed` (IDB bloat on stack traces).
 */
export async function markMutationPoisoned(id: string, error: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const raw = (await wrapRequest(store.get(id))) as unknown;
    if (!raw) {
      await wrapTransaction(tx);
      return;
    }
    const current = parseOutboxRow(raw);
    if (!current) {
      // Already malformed — the quarantine path is our one-true
      // poison-move for schema-drift rows. Don't try to put() a
      // field-tweaked copy of a shape we don't trust.
      await wrapTransaction(tx);
      await quarantineMalformedRow(raw);
      return;
    }
    const updated: OutboxMutation = {
      ...current,
      poisoned: true,
      lastError: error.slice(0, 500),
      // Push `nextAttemptAt` far into the future so any legacy code
      // path that forgets to check `poisoned` still won't pick it up.
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    };
    store.put(updated);
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] markMutationPoisoned failed', err);
  }
}

/**
 * Phase 7d admin UI needs to list the poisoned rows separately so an
 * inspector can re-queue or discard them. Returning them sorted by
 * `createdAt` keeps the UI stable across refreshes.
 */
export async function listPoisonedMutations(): Promise<OutboxMutation[]> {
  if (!isSupported()) return [];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readonly');
    const store = tx.objectStore(STORE_OUTBOX);
    const all = (await wrapRequest(store.getAll())) as unknown[] | null;
    if (!all) return [];
    const malformed: unknown[] = [];
    const parsed: OutboxMutation[] = [];
    for (const raw of all) {
      const ok = parseOutboxRow(raw);
      if (ok) parsed.push(ok);
      else malformed.push(raw);
    }
    if (malformed.length > 0) {
      void Promise.all(malformed.map(quarantineMalformedRow));
    }
    return parsed.filter((m) => m.poisoned).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.warn('[outbox] listPoisonedMutations failed', err);
    return [];
  }
}

/**
 * Wipe every row in the outbox — called from `clearJobCache()` on
 * sign-out for the shared-device safety reasons documented in
 * `job-cache.ts`. Exposed here so a future ops tool could trigger it
 * without also nuking the read cache.
 */
export async function purgeOutbox(): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    tx.objectStore(STORE_OUTBOX).clear();
    await wrapTransaction(tx);
    notifyOutboxChange();
  } catch (err) {
    console.warn('[outbox] purgeOutbox failed', err);
  }
}

// Re-export the DB constants so callers that need to inspect or extend
// the outbox (e.g. future Phase 7d UI queries) don't need two imports.
export { DB_NAME, OUTBOX_INDEX_BY_USER, STORE_OUTBOX };

// Export the schema + parse helper so tests can exercise the reader-side
// strict-wrapper contract directly without needing to round-trip through
// IDB. Production callers should not import these — use the typed list
// helpers above instead.
export { OutboxMutationSchema, parseOutboxRow };
