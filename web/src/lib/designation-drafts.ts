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

// Cycle-8 (BLOCKER) — WRITE-TOKEN IDENTITY, not a module-local revision
// counter. The journal lives in localStorage, which is shared by every
// tab on the origin, but the bookkeeping that decided whether a batch
// may delete a key was module-local: a per-key revision integer, later
// fenced by a module generation. Both are invisible to a second tab, so
// tab A could delete a journal tab B had just written — the revision it
// compared was its OWN, and B's write never touched it. Sign-out was the
// same bug in time rather than space (the purge reset revisions, so the
// next login re-issued revision 1 and a still-in-flight pre-sign-out
// save matched it).
//
// The fix moves identity INTO the durable record: every write stamps a
// process-unique token and stores `{t, v}`; a batch captures the token
// it saw, and clearing RE-READS storage and removes the key only when
// the stored token is still that exact token. The check therefore reads
// the same shared state every tab writes, and needs no cross-tab
// signalling. This subsumes the revision counter AND the generation
// fence (a purge removes the records, so a stale batch's token matches
// nothing) — deliberately ONE fence rather than three overlapping ones.
type JournalRecord = { t: string; v: string };

const TAB_ID = (() => {
  try {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
})();
let writeSeq = 0;

// key → committed write-token awaiting durability (cycle-4: BATCH-scoped
// — a save captures its batch at drain time; a draft committing while
// that save is in flight lands in the NEXT batch and its journal
// survives a kill until ITS save durably enqueues).
const committedJournalTokens = new Map<string, string>();
// key → the token THIS tab last wrote (what `mark` records).
const journalTokens = new Map<string, string>();

/** The token currently stored for `key`, or null if no record exists.
 *  Reads shared storage, so it sees other tabs' writes. */
function storedToken(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(JOURNAL_PREFIX + key);
    if (raw == null) return null;
    return parseRecord(raw)?.t ?? null;
  } catch {
    return null;
  }
}

/** Parse a journal record. Returns null for a legacy plain-string value
 *  written by a pre-cycle-8 build — those have no token, so they can be
 *  READ (recovery still works across the upgrade) but never token-
 *  matched, which fails safe: the key is left in place until its own
 *  post-upgrade write/commit cycle clears it. */
function parseRecord(raw: string): JournalRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as JournalRecord).t === 'string' &&
      typeof (parsed as JournalRecord).v === 'string'
    ) {
      return parsed as JournalRecord;
    }
  } catch {
    /* legacy plain string */
  }
  return null;
}

export function writeDesignationJournal(key: string, value: string): void {
  try {
    const token = `${TAB_ID}:${++writeSeq}`;
    const record: JournalRecord = { t: token, v: value };
    window.localStorage.setItem(JOURNAL_PREFIX + key, JSON.stringify(record));
    journalTokens.set(key, token);
    // A fresh draft supersedes any pending-clear mark for this key.
    committedJournalTokens.delete(key);
  } catch {
    /* best-effort */
  }
}

export function readDesignationJournal(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(JOURNAL_PREFIX + key);
    if (raw == null) return null;
    return parseRecord(raw)?.v ?? raw; // legacy plain string reads verbatim
  } catch {
    return null;
  }
}

/** Mark a journal as committed-to-pending at the token THIS tab last
 *  wrote; physically cleared only once the batch carrying it is durable
 *  AND that token is still the one in storage. */
export function markDesignationJournalCommitted(key: string): void {
  const token = journalTokens.get(key);
  if (token == null) return; // nothing this tab wrote — nothing to clear
  committedJournalTokens.set(key, token);
}

export type DesignationJournalBatch = Array<[string, string]>;

/** Snapshot-and-drain the committed set at save-drain time. The save
 *  that captured this batch clears exactly these records on durable
 *  enqueue — nothing committed afterwards, and nothing another tab or a
 *  later login has since rewritten. */
export function takeCommittedDesignationJournalBatch(): DesignationJournalBatch {
  const batch = Array.from(committedJournalTokens.entries());
  committedJournalTokens.clear();
  return batch;
}

/** Clear a durably-enqueued batch — each key only when the record in
 *  SHARED storage still carries the exact token the batch captured. */
export function clearDesignationJournalBatch(batch: DesignationJournalBatch): void {
  for (const [key, token] of batch) {
    if (storedToken(key) !== token) continue;
    try {
      window.localStorage.removeItem(JOURNAL_PREFIX + key);
    } catch {
      /* best-effort */
    }
  }
}

/** Restore a batch whose save FAILED pre-durability, so the next save
 *  re-carries it. Existing newer marks win, and a key whose stored
 *  record is no longer the captured token is dropped — the value it
 *  named has been superseded, purged, or replaced by another tab, and
 *  re-marking it could only mis-target that newer record. */
export function restoreDesignationJournalBatch(batch: DesignationJournalBatch): void {
  for (const [key, token] of batch) {
    if (committedJournalTokens.has(key)) continue;
    if (storedToken(key) !== token) continue;
    committedJournalTokens.set(key, token);
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
  journalTokens.clear();
  committedJournalTokens.clear();
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
