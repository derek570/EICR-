# Phase 7c Review — Offline mutation outbox + replay worker

**Commit:** `e64f756`
**Branch:** `web-rebuild`
**Scope:** mechanism-only (no consumer wiring)
**Files under review:**
- `web/src/lib/pwa/outbox.ts` (new, 269 lines)
- `web/src/lib/pwa/queue-save-job.ts` (new, 109 lines)
- `web/src/lib/pwa/outbox-replay.ts` (new, 189 lines)
- `web/src/lib/pwa/job-cache.ts` (modified — schema v1→v2, exports)
- `web/src/components/layout/app-shell.tsx` (modified — hook mount)

---

## 1. Summary

Phase 7c adds a durable IndexedDB outbox for `saveJob` mutations and a React-hook replay worker that drains the queue on mount, `online`, `visibilitychange → visible`, and a self-reschedule to the earliest `nextAttemptAt`. The IDB schema is bumped v1→v2 additively via the `!objectStoreNames.contains()` universal-upgrade pattern, preserving existing `jobs-list` / `job-detail` data. The `queue-save-job` wrapper writes to IDB before firing the network, classifies 4xx as persistent (re-throws) and 5xx/network as transient (retains the row), and warms the read-through cache on 2xx. Mounted in `AppShell` so it only runs on auth-gated routes. `clearJobCache()` now nukes the outbox on sign-out for shared-device safety.

The implementation is careful and unusually well-commented — the "why" rationale inside the code matches the handoff doc almost line-for-line, which is the right outcome for a correctness-critical piece. There are no P0 bugs. There are two P1 correctness bugs and a handful of P2 sharp edges worth addressing before a consumer ships in Phase 7d.

**Top 3 priorities** (expanded in §10):
1. **P1 — `wrapTransaction` swallows `onerror`/`onabort` to resolve**, so `enqueueSaveJobMutation` cannot actually bubble an IDB failure. The "throws on IDB failure" durability contract in the comment at `outbox.ts:137-140` is not enforced. Fix via a dedicated strict wrapper (P1 §3).
2. **P1 — `markMutationFailed` read-modify-write is NOT atomic** against a concurrent `removeMutation` from another tab: the RMW uses the shared `wrapRequest` which resolves `null` on error, and the subsequent `store.put(updated)` happily resurrects a just-deleted row because the tx carries on after the failed read (P2/borderline P1 §4). More importantly, `errorMessage` is computed from arbitrary `err` in the replay worker and can carry a bare `TypeError` ("Failed to fetch") — fine, but a 4xx ApiError from a replay call also goes down this path and just burns attempts; there's no short-circuit-to-poison on known-unrecoverable status codes, so a deleted-FK 4xx will retry 10 times before poisoning.
3. **P2 — `processOnce()` `break`-on-cool-off while iterating a snapshot is order-preserving, but the snapshot races** sign-out. If `clearJobCache()` runs mid-pass (sign-out button during a replay), `removeMutation`/`markMutationFailed` still write to a DB that's just been cleared and the clear's tx may be preceded by the stale write, leaving a ghost row under the signed-out user until the next `clear`.

---

## 2. Alignment with Phase 7c plan

The PHASE_7C_HANDOFF.md plan doc maps cleanly to the diff:

| Plan item | Location | Verdict |
|---|---|---|
| IDB v1→v2 additive migration, preserve existing data | `job-cache.ts:86-141` | ✓ `!contains()` guards, no destructive paths |
| `outbox` store, `keyPath: id`, `by-user` index | `job-cache.ts:112-122` | ✓ |
| `OutboxMutation` shape (id, op, userId, jobId, patch, createdAt, attempts, nextAttemptAt, lastError?, poisoned?) | `outbox.ts:56-89` | ✓ |
| `enqueueSaveJobMutation` throws on IDB failure | `outbox.ts:142-166` | ✗ silently succeeds via `wrapTransaction`'s error-swallow — see P1 §3 |
| `listPendingMutations` non-poisoned, FIFO `createdAt` asc | `outbox.ts:180-193` | ✓ |
| `removeMutation` idempotent | `outbox.ts:201-211` | ✓ |
| `markMutationFailed` RMW atomic, exp backoff, poisons at MAX_ATTEMPTS | `outbox.ts:220-246` | partial — RMW is single-tx but not recovery-safe against interleaved deletes; see §4 |
| `purgeOutbox` | `outbox.ts:254-264` | ✓ |
| `queueSaveJob` enqueue-first, best-effort network, remove+cache-warm on 2xx, re-throw 4xx | `queue-save-job.ts:55-109` | ✓ with caveats on the classifier (see §3) |
| `useOutboxReplay` four triggers | `outbox-replay.ts:161-168` | ✓ |
| Stop-on-failure FIFO | `outbox-replay.ts:88-93` | ✓ |
| Self-reschedule to earliest `nextAttemptAt` | `outbox-replay.ts:127-142` | ✓ with 1s floor |
| `runningRef` serialises multi-tab | `outbox-replay.ts:60, 72-74, 96` | ✓ within a tab; cross-tab serialisation only happens implicitly via IDB locking — plan doc correctly does not claim otherwise |
| Sign-out purge everything | `job-cache.ts:273-285` | ✓ — multi-store tx, single commit |
| Mounted in AppShell, not root | `app-shell.tsx:37` | ✓ |
| No consumer wiring | n/a | ✓ confirmed — only `app-shell.tsx` imports `useOutboxReplay`; no `queueSaveJob` call-sites |

`MAX_ATTEMPTS = 10`, `BASE_BACKOFF_MS = 2_000`, `MAX_BACKOFF_MS = 5 * 60 * 1_000` match the plan. The backoff formula `backoffUntil(newAttempts, now) = now + min(2000 * 2^(newAttempts-1), 300000)` at `outbox.ts:127-132` yields 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s — matches the handoff prose.

Full commit body reference to `PHASE_7C_HANDOFF.md` lines up with the shipped code; the conflict model ("last-writer-wins per field") is honoured because replay just re-sends the original patch.

---

## 3. Correctness

### P0

None identified.

### P1

**P1-A — Durability contract for `enqueueSaveJobMutation` is not enforced.**
- `outbox.ts:137-141` documents "On IDB failure we surface the error to the caller (unlike read-cache helpers which swallow) — a missed queue write would silently drop the inspector's edit."
- But the implementation at `outbox.ts:164` does `await wrapTransaction(tx)`, and `wrapTransaction` at `job-cache.ts:163-175` explicitly resolves (not rejects) on `onerror` and `onabort`.
- Net effect: a `QuotaExceededError` on the `put` (likely on a shared-device long-offline session) aborts the tx, `wrapTransaction` resolves `void`, `enqueueSaveJobMutation` returns a `mutation` object that was never persisted. The caller in `queue-save-job.ts` then proceeds to step 2 (network), fires fine online, deletes a row that doesn't exist (no-op), and everything looks successful — but offline it silently drops the edit (plus the caller believes `synced: false` means the worker will retry, which it won't because there's nothing to retry).
- This IS the exact failure mode the handoff doc cites as load-bearing.
- **Fix:** introduce `wrapTransactionStrict(tx)` that rejects on error/abort, use it in `enqueueSaveJobMutation` only. Read paths keep the swallowing behaviour. See fix §1.

**P1-B — `attempt()` in replay worker does not short-circuit 4xx to poison.**
- `outbox-replay.ts:103-125`: every `catch` goes through `markMutationFailed`, which increments attempts and applies exp backoff.
- A 4xx ApiError (e.g. deleted-FK reference, validation error on a stale patch) will replay 10 times over ~18 minutes of wall-clock before poisoning. During each retry it burns server resources and logs noise. More importantly: the only way out is `MAX_ATTEMPTS`, which is set for network-transient sizing, not for "patch is known bad."
- The `queue-save-job.ts` inline path correctly re-throws 4xx (line 84) and leaves the row, but the replay-worker path has no symmetric escape hatch. So a mutation that was enqueued offline and first replayed online as a 4xx gets 10 retries, whereas the same mutation submitted online-first would be surfaced immediately.
- Semantic mismatch: the inline and replay paths have different rejection semantics for the same patch.
- **Fix:** in `attempt`, if `err instanceof ApiError && err.status >= 400 && err.status < 500`, immediately poison rather than going through `markMutationFailed`. A dedicated `markMutationPoisoned(id, error)` keeps the code self-documenting. See fix §2.

**P1-C — `markMutationFailed` is not safe against a concurrent `removeMutation`.**
- `outbox.ts:222-245`: opens one readwrite tx, reads the row, then writes back. Correct for same-tab serial work. But `wrapRequest` at `job-cache.ts:153-161` resolves `null` on `onerror`. If the `store.get(id)` errors (e.g. tx aborted mid-flight by another tab's purge), `current = null`, the code branches to `wrapTransaction(tx)` and returns. Fine.
- However: the `runningRef` only serialises *within* one tab. Cross-tab, IDB semantics do serialise transactions on overlapping scopes, BUT a different tab's `removeMutation(id)` can complete *between* the `get` and the `put` if the browser's tx queueing groups them oddly. The transaction model says same-store readwrite txns are serialised, so this should be safe, but the `wrapRequest` swallowing an error means if the `get` fails the code still attempts a `put(updated)` using `current = null` — except the destructuring `{ ...current, ... }` on `null` would throw `TypeError`, not crash catastrophically. So the net effect is the tx aborts in the catch with a swallowed warn. Acceptable. Downgrade to P2 on reflection — not load-bearing but brittle.

### P2

**P2-A — `queue-save-job.ts` classifier does not handle non-ApiError non-TypeError errors.**
- `queue-save-job.ts:84`: only `err instanceof ApiError && 4xx` re-throws. A programming bug inside `api.saveJob` (say, a downstream code refactor that throws a `SyntaxError` on bad JSON) falls through to `return { queued: true, synced: false }` — the outbox row stays, the caller thinks it's a transient network issue, and the replay worker will pick it up and re-throw the same bug every retry until poisoned.
- **Fix:** add `else if (err instanceof TypeError) { /* network */ }` explicit branch; for anything else, re-throw. This is defensive but protects against silent data-path bugs. See fix §4.

**P2-B — `outbox-replay.ts:80-86` break-on-cool-off is correct but subtle.**
- When the first still-cooling row is hit, the loop breaks, which is right because FIFO requires we not advance past it. The reschedule at `scheduleNext` uses `remaining` (a fresh `listPendingMutations`) so a row that was cooling during the pass will be eligible at the reschedule time. But there's an optimisation miss: if all rows are cooling and none were attempted, we fall through to `scheduleNext`, which calls `listPendingMutations` a second time. Not a bug, just two IDB reads where one would do. Pass the `mutations` local into `scheduleNext` instead.

**P2-C — `setTimeout` 1s floor at `outbox-replay.ts:134` is cautious but ignores clock skew.**
- If `nextAttemptAt` is 100ms in the future (only happens from a backoff computed under clock skew or from user clock change), the `Math.max(1_000, ...)` correctly floors it. But if `Date.now()` ever jumps backward (e.g. NTP correction mid-backoff), the delay could be much larger than intended. Extremely rare; not actionable in 7c.

**P2-D — `processOnce()` reads `listPendingMutations` once, then iterates with stale `now`.**
- `outbox-replay.ts:77-94`: `now = Date.now()` is captured once, then each `m.nextAttemptAt > now` uses that captured value. For a long replay batch (say, 30 rows, each taking 1-2s of network), the last row's cooling check uses a `now` that's 60s stale. In practice each row is either deleted (success) or breaks the loop (failure), so the stale-`now` path isn't hit materially. But worth noting — refreshing `now` inside the loop would cost nothing.

**P2-E — Sign-out race.**
- `clearJobCache()` runs fire-and-forget from `clearAuth()` (`auth.ts:51`). The replay worker's `runningRef` does not observe this. In the narrow window between "user taps sign-out" and "AppShell unmounts / worker effect cleanup fires", if a `processOnce()` is mid-flight, a successful `removeMutation` after `clearJobCache()` is a no-op (already cleared), but a `markMutationFailed` after `clearJobCache()` would `put()` a ghost row into the just-cleared store — no user to own it, no UI to surface it. Phase 7d's poisoned-row admin would need to handle orphan userIds.
- The effect cleanup at `outbox-replay.ts:170-178` sets `cancelledRef.current = true`, but the in-flight `attempt()` awaits on `api.saveJob` (not checkpointed). After it resolves, `attempt` writes to IDB regardless of `cancelledRef`. Not a durability bug, just a minor cleanup leak.
- **Fix:** check `cancelledRef.current` inside `attempt` after the network call, before `markMutationFailed`/`removeMutation`. See fix §6.

**P2-F — `visibilitychange` fires on every foreground, even during an in-flight pass.**
- `outbox-replay.ts:157-159` + `144-151`: `triggerNow()` clears the scheduled timeout and calls `processOnce()`. If `runningRef.current === true`, `processOnce` returns immediately (line 72). But the `clearTimeout` at line 147 has already cancelled the pending reschedule. If the in-flight pass completes AFTER the visibility trigger, its `scheduleNext` will reschedule, so no permanent damage. But if the in-flight pass finishes *before* the `clearTimeout` runs (race), we could end up without a reschedule. In practice the sequence is synchronous within the event loop tick, so it's fine. Mark this as "I checked and it's fine."

**P2-G — `generateId` fallback is not truly unique.**
- `outbox.ts:109-119`: fallback is `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`. Two mutations enqueued in the same ms with an unlucky Math.random collide. `crypto.randomUUID` is available in iOS 15.4+ / all evergreen browsers, so this fallback almost never runs. Acceptable.

**P2-H — `by-user` index is created but never used.**
- `job-cache.ts:114` creates the index; nothing reads from it. The commit message and plan both acknowledge this as a deliberate "cheap to add now, expensive later" decision. OK. Flag for 7d to actually use it or remove.

**P2-I — `lastError` truncation at 500 chars is one-sided.**
- `outbox.ts:237`: `error.slice(0, 500)`. If `error` is empty string, we store empty. No indicator of which attempt it came from in the admin UI (7d would need to display "attempt 7 of 10: HTTP 500: ...").

**P2-J — No UUID uniqueness check on put.**
- `outbox.ts:163`: `put(mutation)` on a uuid collision would silently overwrite. `add()` would reject. For a uuid keyed store this is astronomically unlikely, but `add` is the self-documenting choice.

### Things verified correct

- v1→v2 migration: `!objectStoreNames.contains()` is the correct universal pattern. Jobs-list/job-detail data preserved — confirmed by reading through the `onupgradeneeded` handler at `job-cache.ts:90-126`.
- FIFO replay: `listPendingMutations` sorts by `createdAt` ascending, `processOnce` iterates in array order, break on first failure. Ordering invariant holds.
- Backoff math: formula produces the stated 2,4,8,16,32,64,128,256,300,300 second sequence. Wall-clock total = 1110s ≈ 18.5 min — matches handoff.
- MAX_ATTEMPTS = 10 correctly gates poisoning (`newAttempts >= MAX_ATTEMPTS` at line 239).
- `removeMutation` idempotence — IDB `delete` on missing key is a no-op.
- 4xx vs 5xx classifier in `queue-save-job.ts:84`: correctly distinguishes persistent from transient. Paired with the `api-client.ts:57-64` behaviour where 5xx and 4xx both throw ApiError (with status), and network errors throw TypeError.
- Sign-out multi-store tx: `job-cache.ts:277` takes all three stores in one tx, so clears are atomic — either all three clear or none (tx abort).
- `runningRef` within-tab serialisation — correctly implemented as a ref (not state) so doesn't re-trigger effect.

---

## 4. Security

- **Shared-device nuke-everything purge** — correctly documented trade-off. Wiping the entire outbox on sign-out is strictly safer than per-user purge given the "wrong auth token replay" threat model. Good.
- **Auth token** — replay calls `api.saveJob` which uses `getToken()` at request time (`api-client.ts:37`). Not the token-at-enqueue-time. If a user signs out then back in as the same user, the outbox survives and retries under the new token. If they sign out → sign in as a different user, the sign-out's `clearJobCache()` fires first and the outbox is empty when the new user arrives. Safe.
- **Race window in sign-out** — see P2-E. Phase 7d admin UI should defensively check that a poisoned row's `userId` matches the current user before offering to re-queue.
- **`lastError` storage** — truncated to 500 chars, good for avoiding IDB bloat from stack traces. No PII risk since these are HTTP status strings / network error messages, not user input.
- **No CSP/CORS changes** — N/A (IDB is same-origin by spec).
- **`generateId` crypto.randomUUID fallback** — not crypto-grade entropy, but ids are never used as auth tokens, just as primary keys. Fine.
- **`by-user` index creation** — indexed on `userId`, which is a UUID; nothing sensitive leaked to IDB that wasn't already there from the read cache.

No security concerns beyond the documented trade-off.

---

## 5. Performance

- **Outbox overhead**: enqueue is one tx, one `put`, one commit — sub-ms in normal cases. IDB writes are async to the main thread, so UI is never blocked.
- **Mount-pass overhead**: `useOutboxReplay` runs on every AppShell mount; `listPendingMutations` is one `getAll()` on (expected) <10 rows. Sub-ms. Fine.
- **Self-reschedule timer**: single `setTimeout` per worker instance. Clean.
- **`listPendingMutations` called twice per pass** (once at top of `processOnce`, once in `scheduleNext`). Minor inefficiency. See P2-B.
- **`break`-on-cool-off**: correct; avoids scanning past cooling rows unnecessarily.
- **5-min backoff cap** keeps the worst-case retry rate to 2/10min = 12/hour per row. Conservative.
- **`wrapRequest` / `wrapTransaction` allocate new promises on every call** — unavoidable given the IDB event-based API. Not a concern at this scale.
- **Memory**: the worker holds no long-lived references beyond refs in the effect closure. No leak on unmount.

Nothing performance-actionable at 7c scale.

---

## 6. Accessibility

No UI surface in 7c by design (mechanism-only commit). Nothing to review. Phase 7d kickoff checklist correctly flags that pending-count badges + poisoned-row admin will need:
- `aria-live="polite"` on the pending-count indicator so screen readers hear sync state changes.
- Keyboard navigation into the admin drawer / list.
- Sufficient contrast for a "pending sync" chip on top of existing job cards.

Flag for 7d, not a 7c issue.

---

## 7. Code quality

**Strengths**
- Doc comments are exceptional — every non-trivial decision explains both the "why" and the "why not the obvious alternative." Matches the handoff doc almost 1:1.
- Consistent use of `isSupported()` SSR guard at the top of every public function.
- Shared IDB primitives (`openDB`, `wrapRequest`, `wrapTransaction`) exported rather than duplicated — correct call.
- Refs-over-state in the replay hook to avoid re-running the effect. Correct React pattern.
- Effect cleanup is thorough: clears timer, removes both listeners, flips `cancelledRef`.
- Empty dep array on the effect is correct given the design (trigger surface is DOM, not props).
- Const-ified backoff constants at module scope — easy to audit without scanning the function.

**Weaknesses**
- `wrapTransaction` swallows errors uniformly — fine for read-cache best-effort but wrong for durability writes. Need a strict variant. (P1-A)
- Error classifier in `queue-save-job.ts` treats non-ApiError non-TypeError as transient — too permissive. (P2-A)
- `attempt()` in replay worker doesn't distinguish 4xx from 5xx; all failures path through `markMutationFailed`. (P1-B)
- `listPendingMutations` double-read in a single pass. (P2-B)
- `by-user` index unused — fine as documented but worth a TODO comment pointing to Phase 7d.
- `OutboxOp` union is a single-variant string type; acceptable for mechanism-only but the replay worker's `switch` on `m.op` at `outbox-replay.ts:105` is actually an `if` — will need to be a switch or exhaustive map when a second op lands.
- `export { DB_NAME, OUTBOX_INDEX_BY_USER, STORE_OUTBOX }` at `outbox.ts:268`: re-exports from job-cache, which is fine as a convenience, but it does create two import paths for the same constants. 7d callers should pick one (recommend importing from `job-cache` since that's the schema source of truth).
- `generateId` fallback is not uuid-compliant in shape (no hyphens/version bits). Doesn't break IDB (keypath accepts any string) but makes cross-referencing logs harder.

---

## 8. Test coverage

**No unit tests added for this phase.** The handoff doc's "Verification" section is entirely manual DevTools walkthroughs (enqueue, offline enqueue, backoff, sign-out purge, FIFO). For a mechanism that owns user-data durability, this is below bar.

Missing tests, in priority order:
1. **`backoffUntil` pure-function tests** — trivial to write, protects the backoff schedule forever. Test 2s/4s/…/5-min cap.
2. **`enqueueSaveJobMutation` IDB error path** — fake-indexeddb + a quota error to verify the P1-A fix rejects.
3. **`markMutationFailed` RMW atomicity** — parallel-promise test on a shared fake-indexeddb.
4. **`processOnce` FIFO correctness** — enqueue A, B, C; stub `api.saveJob` to fail on B; assert A replayed, B left, C left.
5. **`useOutboxReplay` trigger surface** — render hook, dispatch `online`, assert `processOnce` fired.
6. **`clearJobCache` multi-store atomicity** — enqueue + cache a job, call clear, assert both stores empty.

A fake-indexeddb setup would cost ~200 LOC once and pay for itself across the whole PWA feature area. Strongly recommended before Phase 7d ships a UI consumer.

**Lint / build**
- Commit claims "0 errors, 6 pre-existing warnings (same baseline)" — not independently verified here but the diff is lint-clean on visual inspection.
- `npx tsc --noEmit` claimed clean — types line up: `OutboxMutation`, `OutboxOp` re-exports, narrow `const` types throughout.

---

## 9. Suggested fixes (numbered, file:line)

**Fix 1 — Strict tx wrapper for durability writes** (P1-A)
- `web/src/lib/pwa/job-cache.ts:163-175` — leave `wrapTransaction` as-is (best-effort, resolves on error).
- Add a sibling:
  ```
  export function wrapTransactionStrict(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    });
  }
  ```
- `web/src/lib/pwa/outbox.ts:164` — import `wrapTransactionStrict`, use it in `enqueueSaveJobMutation` only. `removeMutation`, `markMutationFailed`, `purgeOutbox` stay on `wrapTransaction` (best-effort is correct there because losing these is not a user-data-loss path).

**Fix 2 — 4xx short-circuits to poison in replay** (P1-B)
- `web/src/lib/pwa/outbox-replay.ts:103-125` — add an ApiError-4xx branch before `markMutationFailed`:
  ```
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      await markMutationPoisoned(m.id, message);
    } else {
      await markMutationFailed(m.id, message);
    }
    return 'failed';
  }
  ```
- `web/src/lib/pwa/outbox.ts` — add `markMutationPoisoned(id, error)` that sets `poisoned: true`, `lastError: error.slice(0, 500)`, leaves `attempts` as-is. Same single-tx RMW shape as `markMutationFailed`.

**Fix 3 — Read-once, pass-through in `processOnce`** (P2-B)
- `web/src/lib/pwa/outbox-replay.ts:76, 127-142` — change `scheduleNext` to accept the already-fetched `remaining: OutboxMutation[]` parameter. Call once at end of the batch. Halves the IDB reads per pass.

**Fix 4 — Explicit network-error branch in `queueSaveJob`** (P2-A)
- `web/src/lib/pwa/queue-save-job.ts:76-89` — restructure:
  ```
  try {
    await api.saveJob(userId, jobId, patch);
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err;
    if (err instanceof ApiError && err.status >= 500) return { queued: true, synced: false, mutationId: mutation.id };
    if (err instanceof TypeError) return { queued: true, synced: false, mutationId: mutation.id };
    throw err; // unknown error — don't swallow
  }
  ```

**Fix 5 — Refresh `now` inside the loop** (P2-D)
- `web/src/lib/pwa/outbox-replay.ts:77` — move `const now = Date.now()` inside the `for` loop header so long batches don't make stale cooling decisions. Negligible cost.

**Fix 6 — Respect `cancelledRef` after async network call** (P2-E)
- `web/src/lib/pwa/outbox-replay.ts:103-125` in `attempt`: after the `await api.saveJob(...)` resolves, check `if (cancelledRef.current) return 'ok'` (skip the IDB write if we're being torn down). Same in the catch before `markMutationFailed`.

**Fix 7 — Use `add` not `put` for enqueue** (P2-J)
- `web/src/lib/pwa/outbox.ts:163` — `tx.objectStore(STORE_OUTBOX).add(mutation)`. Makes uuid-collision visible rather than silent.

**Fix 8 — Unit test harness** (§8)
- Install `fake-indexeddb`, wire it into the test setup, add the six tests outlined in §8. Non-trivial in a greenfield Next.js test setup, but essential infrastructure before any `queueSaveJob` call-site lands.

**Fix 9 — TODO marker for the unused index** (§7)
- `web/src/lib/pwa/job-cache.ts:114` — add an inline `// TODO(Phase 7d): either use this index in per-user purge or drop it via v3 bump.` so the index doesn't silently rot.

**Fix 10 — Switch on `m.op` for forward-compat** (§7)
- `web/src/lib/pwa/outbox-replay.ts:105` — replace `if (m.op === 'saveJob')` with a `switch (m.op)` with exhaustive default that `markMutationPoisoned`s unknown ops (defensive against a future op being enqueued by a newer tab and replayed by an older one).

---

## 10. Verdict + top 3 priorities

**Verdict: APPROVE with P1 follow-ups tracked.**

The mechanism is sound, the design is defensible, the code is unusually well-documented, and the scope discipline (mechanism-only, no consumer wiring) is exactly right for a durability-critical commit. The FIFO+stop-on-failure invariant holds. The IDB v1→v2 migration is safe. The sign-out shared-device trade-off is correct.

However the durability contract for `enqueueSaveJobMutation` — the load-bearing promise of the whole phase — is not enforced because of the shared `wrapTransaction`'s error-swallow. This must be fixed before any consumer calls `queueSaveJob` in Phase 7d, otherwise the whole point of 7c can silently no-op under IDB quota pressure.

**Top 3 priorities for Phase 7d (or a quick 7c patch):**

1. **Fix 1 — strict tx wrapper for `enqueueSaveJobMutation`.** Without this, the "throws on IDB failure" durability contract is theoretical. Quota errors, private-mode-Firefox regressions, and corrupt-DB recoveries all go silent.
2. **Fix 2 — 4xx short-circuits to poison in replay.** Current behaviour wastes ~18 min of retries on every permanently-rejected patch and creates inline-vs-replay semantic drift. Fast 1-commit fix.
3. **Fix 8 — fake-indexeddb test harness + the six tests in §8.** A `queueSaveJob` consumer landing without unit coverage of backoff/FIFO/poison/sign-out is taking on risk disproportionate to the UI surface it's trying to unlock. Pay the test-infra cost now, amortise across 7d + 7e.

Everything else in §3-§7 is polish.
