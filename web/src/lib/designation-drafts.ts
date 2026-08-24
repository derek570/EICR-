/**
 * PLAN-B2 (B2-2, web manual edits) — module-level designation-draft
 * registry.
 *
 * Why this exists: designation typing must update ONLY a draft buffer
 * (never the model per keystroke — canonicalising mid-typing would
 * rewrite under the inspector's cursor), and the draft commits ONCE on
 * blur/focus-loss. But drafts live in component state, OUTSIDE
 * JobProvider — so a focused draft is invisible to `flushSave`, unmount
 * persistence, pagehide, preset processing, job-state sync, and PDF
 * generation. A typing pause longer than the 800 ms save debounce would
 * otherwise persist the RAW pre-blur designation.
 *
 * This registry is the web-level coordinator: every editable designation
 * surface registers its focused draft's synchronous commit function;
 * `flushDesignationDrafts()` is invoked (synchronously) before each of
 * those boundaries so the canonical value reaches the model AND the
 * durable outbox no matter how the session leaves the field.
 *
 * Module-level (not React context) deliberately: JobProvider's
 * `flushSave` and the pagehide listener need a synchronous call with no
 * hook plumbing, and there is exactly one active job screen at a time.
 * Keys are namespaced per surface+row so two surfaces editing the same
 * job never collide.
 */

export type DesignationDraftCommit = () => void;

const drafts = new Map<string, DesignationDraftCommit>();

/**
 * Register the commit function for a currently-focused designation
 * draft. Call on focus (or first keystroke); the commit function must
 * be synchronous, idempotent, and safe to call after unmount. Returns
 * an unregister function for cleanup (blur/unmount).
 */
export function registerDesignationDraft(key: string, commit: DesignationDraftCommit): () => void {
  drafts.set(key, commit);
  return () => {
    // Only delete if the registered entry is still ours — a re-focus
    // may have replaced it with a fresh commit closure.
    if (drafts.get(key) === commit) drafts.delete(key);
  };
}

/**
 * Synchronously commit every registered draft. Each commit canonicalises
 * and writes through the surface's own model-commit path, so the caller
 * (flushSave / pagehide / PDF preflight / preset processing / job-state
 * sync) sees the canonical value in the model before proceeding.
 * Commits deregister themselves via their blur-path cleanup; entries
 * are also cleared here defensively so a commit that forgets cleanup
 * cannot double-fire on the next flush.
 */
export function flushDesignationDrafts(): void {
  if (drafts.size === 0) return;
  const pending = Array.from(drafts.entries());
  drafts.clear();
  for (const [, commit] of pending) {
    try {
      commit();
    } catch {
      // A throwing commit must not stop sibling drafts from flushing —
      // losing one draft is bad; losing all of them is worse.
    }
  }
}

/** Test seam — number of currently registered drafts. */
export function _registeredDesignationDraftCount(): number {
  return drafts.size;
}

// ── Draft journal (cycle-3: durability-gated clearing) ─────────────────
// Synchronous localStorage journal for an OPEN draft — survives process
// kill where the async outbox write cannot. A committed journal is NOT
// cleared at commit time (the commit only reaches the in-memory pending
// patch; Safari can kill the page before the outbox enqueue completes,
// losing BOTH copies). Instead the commit MARKS the key, and JobProvider
// clears marked keys only after `queueSaveJob` has durably enqueued —
// on enqueue failure the journal survives for next-mount recovery.

const JOURNAL_PREFIX = 'cm-designation-draft:';
// key → committed revision awaiting durability (cycle-4: BATCH-scoped —
// a save captures its batch at drain time; a draft committing while
// that save is in flight lands in the NEXT batch and its journal
// survives a kill until ITS save durably enqueues).
const committedJournalRevisions = new Map<string, number>();
// key → current write revision (bumped per keystroke).
const journalRevisions = new Map<string, number>();
// Cycle-7 — generation/epoch of the revision space itself. `purge`
// (sign-out) RESETS every revision to 0, so a batch captured before the
// purge carries revision numbers that a post-login draft will re-issue
// from scratch: an in-flight pre-sign-out save completing afterwards
// would find an equal revision and delete the NEW user's journal (or,
// on failure, restore a mark for a value that no longer exists). Every
// batch is stamped with the generation it was captured in; clear and
// restore both ignore a batch from an older generation.
let journalGeneration = 0;

export function writeDesignationJournal(key: string, value: string): void {
  try {
    window.localStorage.setItem(JOURNAL_PREFIX + key, value);
    journalRevisions.set(key, (journalRevisions.get(key) ?? 0) + 1);
    // A fresh draft supersedes any pending-clear mark for this key.
    committedJournalRevisions.delete(key);
  } catch {
    /* best-effort */
  }
}

export function readDesignationJournal(key: string): string | null {
  try {
    return window.localStorage.getItem(JOURNAL_PREFIX + key);
  } catch {
    return null;
  }
}

/** Mark a journal as committed-to-pending at its CURRENT revision;
 *  physically cleared only once the batch that carried it is durable. */
export function markDesignationJournalCommitted(key: string): void {
  committedJournalRevisions.set(key, journalRevisions.get(key) ?? 0);
}

export type DesignationJournalBatch = {
  /** Revision-space generation this batch was captured in (cycle-7). */
  generation: number;
  entries: Array<[string, number]>;
};

/** Snapshot-and-drain the committed set at save-drain time. The save
 *  that captured this batch clears exactly these revisions on durable
 *  enqueue — nothing committed afterwards. */
export function takeCommittedDesignationJournalBatch(): DesignationJournalBatch {
  const entries = Array.from(committedJournalRevisions.entries());
  committedJournalRevisions.clear();
  return { generation: journalGeneration, entries };
}

/** Clear a durably-enqueued batch — each key only when no NEWER
 *  keystroke has re-journalled it since the batch was captured, and
 *  only while the revision space it was captured in is still current
 *  (a sign-out purge retires the generation — cycle-7). */
export function clearDesignationJournalBatch(batch: DesignationJournalBatch): void {
  if (batch.generation !== journalGeneration) return;
  for (const [key, revision] of batch.entries) {
    if ((journalRevisions.get(key) ?? 0) !== revision) continue;
    try {
      window.localStorage.removeItem(JOURNAL_PREFIX + key);
    } catch {
      /* best-effort */
    }
  }
}

/** Restore a batch whose save FAILED pre-durability (existing newer
 *  marks win). A batch from a retired generation is dropped — its
 *  journals were physically removed by the purge, so re-marking their
 *  keys could only mis-target the next user's drafts (cycle-7). */
export function restoreDesignationJournalBatch(batch: DesignationJournalBatch): void {
  if (batch.generation !== journalGeneration) return;
  for (const [key, revision] of batch.entries) {
    if (!committedJournalRevisions.has(key)) {
      committedJournalRevisions.set(key, revision);
    }
  }
}

/**
 * Cycle-6 — sign-out purge. `clearAuth` wipes the IDB job cache/outbox
 * so a shared device doesn't carry one inspector's data into the next
 * login, but the localStorage journals (and the in-memory draft/
 * recovery state) would otherwise survive and AUTO-COMMIT the previous
 * user's abandoned draft when the next user opens the same job. Remove
 * every prefixed journal entry and reset all module state.
 */
export function purgeDesignationDraftState(): void {
  drafts.clear();
  journalRevisions.clear();
  committedJournalRevisions.clear();
  // Retire the revision space (cycle-7): revisions restart at 0 for the
  // next login, so any batch still held by an in-flight pre-sign-out
  // save must be unable to clear OR restore against the new user's
  // journals.
  journalGeneration += 1;
  recoveryReady = false;
  pendingRecoveries.length = 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key != null && key.startsWith(JOURNAL_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* best-effort — sign-out proceeds regardless */
  }
}

// ── Journal-recovery gate (Codex mini-review c1, BLOCKER) ──────────────
// A localStorage draft journal recovered at MOUNT would commit into an
// un-hydrated cache doc, dirtying the provider so `safeToReplace`
// rejects the fresh network doc — the exact cache-before-hydration
// overwrite class (851ba63e). Recovery therefore queues here until the
// provider signals the doc is authoritative (accepted network doc, or
// confirmed-offline cache).

let recoveryReady = false;
const pendingRecoveries: Array<() => void> = [];

/** JobProvider calls this when (isHydrated || networkRejected) flips
 *  true — queued journal recoveries run; later registrations run
 *  immediately. Reset to false on provider unmount/doc change. */
export function setDesignationRecoveryReady(ready: boolean): void {
  recoveryReady = ready;
  if (!ready) return;
  const queued = pendingRecoveries.splice(0, pendingRecoveries.length);
  for (const fn of queued) {
    try {
      fn();
    } catch {
      /* one failed recovery must not stop siblings */
    }
  }
}

/** Run `fn` once the provider doc is authoritative (immediately if it
 *  already is). Returns a cancel function — a hook unmounting (job
 *  navigation) MUST cancel so its queued recovery cannot fire under the
 *  NEXT job's provider (cycle-2). */
export function whenDesignationRecoveryReady(fn: () => void): () => void {
  if (recoveryReady) {
    fn();
    return () => {};
  }
  pendingRecoveries.push(fn);
  return () => {
    const idx = pendingRecoveries.indexOf(fn);
    if (idx >= 0) pendingRecoveries.splice(idx, 1);
  };
}
