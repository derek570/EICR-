'use client';

import * as React from 'react';
import {
  markDesignationJournalCommitted,
  readDesignationJournal,
  registerDesignationDraft,
  whenDesignationRecoveryReady,
  writeDesignationJournal,
} from './designation-drafts';

/**
 * PLAN-B2 (B2-2, web manual edits) — draft-buffered designation editing.
 *
 * Typing updates ONLY the local draft (the model is untouched, so the
 * per-keystroke `updateJob` path — and with it the debounced save —
 * never sees a half-typed raw designation, and no canonicaliser ever
 * rewrites under the inspector's cursor). The draft commits ONCE, on:
 *
 *   - blur / focus transfer (the input's own onBlur);
 *   - view disappearance / navigation (this hook's unmount cleanup);
 *   - any provider-level persistence boundary (`flushDesignationDrafts`
 *     — flushSave, pagehide, snapshot save, PDF preflight), via the
 *     module-level registry this hook registers with while a draft is
 *     open.
 *
 * `commit(raw)` is supplied by the page and is responsible for
 * canonicalising and writing through the SYNCHRONOUS commit path
 * (`commitJobPatch`) so a registry flush can immediately consume the
 * committed model. Commit closures are idempotent (the draft ref is
 * cleared before invoking) and unmount-safe.
 */
export function useDesignationDraft(opts: {
  /** Registry key — unique per surface+row (e.g. `desktop:<circuitId>`). */
  draftKey: string;
  /** Current committed model value for this designation. */
  modelValue: string;
  /** Canonicalise + synchronously commit the raw draft to the model. */
  commit: (raw: string) => void;
}): {
  /** Value to render: the open draft, else the model value. */
  value: string;
  /** Replace the draft (call from the input's onChange). */
  onChange: (next: string) => void;
  /** Commit the open draft, if any (call from the input's onBlur). */
  onBlur: () => void;
} {
  const [draft, setDraft] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);
  const unregisterRef = React.useRef<(() => void) | null>(null);
  const commitFnRef = React.useRef(opts.commit);
  const draftKeyRef = React.useRef(opts.draftKey);
  // Latest-ref pattern via insertion effect (react-hooks/refs forbids
  // render-time ref writes). Commits only fire from blur/flush handlers,
  // which always run after effects have stamped the latest closures.
  React.useInsertionEffect(() => {
    commitFnRef.current = opts.commit;
    draftKeyRef.current = opts.draftKey;
  });

  const commitNow = React.useCallback(() => {
    const open = draftRef.current;
    // Clear BEFORE committing so re-entrant flushes are no-ops.
    draftRef.current = null;
    unregisterRef.current?.();
    unregisterRef.current = null;
    // Cycle-3 — the journal is only MARKED here; it is physically
    // cleared by JobProvider once the outbox enqueue has durably
    // succeeded (a page kill between this commit and the enqueue would
    // otherwise lose both copies).
    markDesignationJournalCommitted(draftKeyRef.current);
    if (open == null) return;
    setDraft(null); // post-unmount this is a safe no-op
    commitFnRef.current(open);
  }, []);

  const onChange = React.useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      // Codex r1 — synchronous journal per keystroke: the pagehide flush
      // only STARTS an async IndexedDB enqueue, and the browser may kill
      // the process before it completes (tab close, PWA eviction). The
      // journal survives that; the next mount of this surface commits it.
      writeDesignationJournal(draftKeyRef.current, next);
      if (!unregisterRef.current) {
        unregisterRef.current = registerDesignationDraft(draftKeyRef.current, commitNow);
      }
    },
    [commitNow]
  );

  // Recover a journalled draft stranded by a killed session — but ONLY
  // once the provider doc is authoritative (mini-review c1: an immediate
  // commit into an un-hydrated cache doc dirties the provider, rejects
  // the fresh network doc, and can PUT stale circuits — the 851ba63e
  // class). The journal is cleared only after the guarded commit runs;
  // the commit itself is functional against the then-current job.
  React.useEffect(() => {
    const key = draftKeyRef.current;
    const cancel = whenDesignationRecoveryReady(() => {
      const stranded = readDesignationJournal(key);
      if (stranded != null && draftRef.current == null) {
        // Same durability-gated clear as a live commit.
        markDesignationJournalCommitted(key);
        commitFnRef.current(stranded);
      }
    });
    // Cycle-2 — cancel on unmount so a queued recovery from THIS job's
    // surface can never fire under the next job's provider.
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // View disappearance / unmount — a collapsed card or removed row must
  // not strand its open draft.
  React.useEffect(() => () => commitNow(), [commitNow]);

  return {
    value: draft ?? opts.modelValue,
    onChange,
    onBlur: commitNow,
  };
}
