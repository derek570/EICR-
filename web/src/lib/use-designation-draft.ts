'use client';

import * as React from 'react';
import { registerDesignationDraft } from './designation-drafts';

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
    if (open == null) return;
    setDraft(null); // post-unmount this is a safe no-op
    commitFnRef.current(open);
  }, []);

  const onChange = React.useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      if (!unregisterRef.current) {
        unregisterRef.current = registerDesignationDraft(draftKeyRef.current, commitNow);
      }
    },
    [commitNow]
  );

  // View disappearance / unmount — a collapsed card or removed row must
  // not strand its open draft.
  React.useEffect(() => () => commitNow(), [commitNow]);

  return {
    value: draft ?? opts.modelValue,
    onChange,
    onBlur: commitNow,
  };
}
