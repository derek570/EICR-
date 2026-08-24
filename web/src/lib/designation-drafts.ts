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

/**
 * Sign-out reset. `clearAuth` wipes the IDB job cache/outbox so a shared
 * device doesn't carry one inspector's data into the next login; the
 * in-memory draft registry must go with it, or a previous user's open,
 * uncommitted draft could be flushed into the NEXT user's job by any
 * provider-level persistence boundary.
 *
 * Cycle-9: this also sweeps any `cm-designation-draft:` keys left in
 * localStorage. Nothing writes them any more (the journal was removed —
 * see `use-designation-draft.ts`), but a device that ran a pre-removal
 * build of this branch may still hold records, and sign-out is exactly
 * where another inspector's abandoned text must not survive.
 */
export function purgeDesignationDraftState(): void {
  drafts.clear();
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key != null && key.startsWith('cm-designation-draft:')) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* best-effort — sign-out proceeds regardless */
  }
}
