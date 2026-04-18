## 1. Summary of the phase

Phase 7c adds the offline-write mechanism: an IndexedDB `outbox` store, a `queueSaveJob()` wrapper that enqueues before attempting `api.saveJob()`, and a `useOutboxReplay()` worker mounted from `AppShell` to retry queued mutations when the tab comes online or becomes visible. It also bumps the shared IDB schema to v2 and clears the outbox on sign-out.

I reviewed `reviews/context/phase-7c.md`, `git show --stat e64f756`, `git show e64f756`, and the current working-tree versions of the touched files. The touched source files appear unchanged since `e64f756`.

## 2. Alignment with original plan

Broadly, the implementation matches the handoff’s intended shape: shared DB upgrade, dedicated outbox module, replay hook mounted under the auth-gated shell, and global purge on sign-out all line up with the plan in [web/PHASE_7C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_7C_HANDOFF.md:29), [web/PHASE_7C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_7C_HANDOFF.md:44), and [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:29).

The main gap is that the phase still does not wire `queueSaveJob()` into any real save path, which the handoff explicitly documents as deliberate in [web/PHASE_7C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_7C_HANDOFF.md:50) and is consistent with [web/src/lib/job-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:10). So it matches the mechanism-only plan, but it does not yet achieve the user-visible outcome implied by “offline edits no longer vanish” until a caller is added.

## 3. Correctness issues

- `P1` Durability is not actually enforced for enqueue writes. The handoff says `enqueueSaveJobMutation()` must throw on IDB failure, but it reuses `wrapTransaction()` / `wrapRequest()` from the cache layer, and those helpers resolve successfully after transaction/request errors instead of rejecting ([web/src/lib/pwa/job-cache.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:153), [web/src/lib/pwa/job-cache.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:163)). As a result, `enqueueSaveJobMutation()` can return a mutation ID even if the `put()` never committed ([web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:161)). That breaks the core contract of the phase: a failed durable write becomes indistinguishable from success.

- `P1` Queued offline edits are not reflected in the cached read model, so an offline reload can still “lose” the user’s latest edit from the UI even though it survives in the outbox. `queueSaveJob()` only refreshes the read cache after an inline 2xx success ([web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:91)); on offline/network failure it returns immediately without updating `job-detail` cache ([web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:78)). That conflicts with the handoff’s stated goal that offline edits survive tab closes and that later visits read the optimistic value from IDB ([web/PHASE_7C_HANDOFF.md](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_7C_HANDOFF.md:8), [web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:18)). The replay worker also removes successful rows without warming the read cache, so stale cached detail can persist after background replay ([web/src/lib/pwa/outbox-replay.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox-replay.ts:103)).

- `P2` A single 4xx patch can block the entire queue, including unrelated jobs, for up to the full poisoning window. `queueSaveJob()` preserves 4xx rows in the outbox ([web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:79)), and the worker stops on the first failure globally ([web/src/lib/pwa/outbox-replay.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox-replay.ts:78)). Because pending rows are processed in one global FIFO list ([web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:180)), one permanently invalid mutation for job A can stall later valid mutations for job B until it poisons. That is stricter than needed for per-job last-writer-wins and creates avoidable head-of-line blocking.

## 4. Security issues

No new security issues stood out in this phase. The code stays within existing auth patterns, does not introduce new HTML rendering paths, and does not expose new network surfaces.

## 5. Performance issues

No material performance issues found for the intended scale. `getAll()` + in-memory sort on the outbox is acceptable for the documented “single digits / low dozens” queue size in [web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:175).

## 6. Accessibility issues

No accessibility regressions found in this phase. The functional changes are mostly non-visual; the only UI touchpoint is mounting the replay hook in `AppShell`, which does not alter interaction semantics.

## 7. Code quality

The main code-quality concern is architectural: the outbox reuses cache-layer helpers whose semantics are explicitly “best effort” ([web/src/lib/pwa/job-cache.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:148)), but the outbox needs strict failure propagation. That abstraction mismatch directly caused the durability bug above.

Otherwise, the new modules are well-scoped and readable, and the phase stayed disciplined about not mixing UI polish into correctness-critical plumbing.

## 8. Test coverage gaps

There do not appear to be any tests covering this mechanism.

Missing coverage that matters here:
- enqueue should reject when the IDB transaction aborts
- offline queueing should preserve the edited value across reload/offline revisit
- replay success should update cached job detail
- 4xx handling should not stall unrelated queued mutations
- sign-out should purge `outbox` deterministically
- FIFO ordering / backoff timing should be asserted in code, not only documented in the handoff

## 9. Suggested fixes

1. [web/src/lib/pwa/job-cache.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:153), [web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:161)  
   Split the cache wrappers from the outbox wrappers. `enqueueSaveJobMutation()` needs a request/transaction helper that rejects on `onerror` / `onabort` instead of resolving `null`/`void`.  
   Why: the outbox cannot claim durability if failed IDB writes are treated as success.

2. [web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:78), [web/src/lib/pwa/outbox-replay.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox-replay.ts:103)  
   Apply the patch to the cached job detail when a mutation is queued but not yet synced, and also refresh/merge cached detail after replay success. If you do not want to mutate the base cache, overlay pending mutations during cached reads.  
   Why: without this, offline reloads still render stale data and the phase does not satisfy the “offline edits survive tab close / revisit” goal.

3. [web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:84), [web/src/lib/pwa/outbox-replay.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox-replay.ts:87), [web/src/lib/pwa/outbox.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox.ts:180)  
   Change terminal 4xx handling so it does not sit at the head of the global queue for ~18 minutes. Options: poison immediately on first 4xx, or partition replay ordering by `jobId` so unrelated jobs can continue.  
   Why: the current global stop-on-failure policy lets one bad row starve valid later work across the whole app.

4. [web/src/lib/pwa/outbox-replay.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/outbox-replay.ts:67)  
   Add automated tests around `processOnce()` covering: stop-on-first-transient-failure, successful replay/removal, 4xx terminal behavior, and timer rescheduling to `nextAttemptAt`.  
   Why: this file encodes the phase’s core semantics and currently relies on comments/handoff prose rather than executable guarantees.

5. [web/src/lib/pwa/queue-save-job.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/queue-save-job.ts:55)  
   Add tests for the three outcomes: enqueue failure, inline 2xx success, and offline/5xx queued return.  
   Why: this wrapper is the future integration point, and small behavior changes here will silently change user data guarantees.

## 10. Overall verdict

**Needs rework**

Top 3 priority fixes:
1. Make outbox enqueue/remove/update operations fail loudly on IDB transaction errors instead of reusing best-effort cache wrappers.
2. Preserve queued edits in the offline read path so reloads/offline revisits do not show stale pre-edit data.
3. Prevent one invalid 4xx row from blocking the entire global replay queue for unrelated later mutations.