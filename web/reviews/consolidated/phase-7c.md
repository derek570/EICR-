# Phase 7c — Consolidated review

**Commit:** `e64f756` — feat(web): Phase 7c offline mutation outbox + replay worker
**Branch:** `web-rebuild`
**Scope:** mechanism-only. No `queueSaveJob` consumer wired yet.
**Files reviewed:** `web/src/lib/pwa/outbox.ts`, `web/src/lib/pwa/queue-save-job.ts`, `web/src/lib/pwa/outbox-replay.ts`, `web/src/lib/pwa/job-cache.ts`, `web/src/components/layout/app-shell.tsx`.

---

## 1. Phase summary

Phase 7c lands the durability mechanism for offline save mutations: an IDB v2 `outbox` store, an `enqueue → best-effort network → remove-or-retry` wrapper (`queueSaveJob`), and a `useOutboxReplay()` hook mounted in `AppShell` that drains the queue on mount / `online` / `visibilitychange` / self-reschedule, preserving FIFO and stopping on first failure. Migration v1→v2 is additive and preserves existing caches; sign-out wipes the outbox globally for shared-device safety. Both reviewers agree the design is sound and scope-disciplined, but the durability contract advertised in the handoff is not actually enforced because the outbox reuses the read-cache's error-swallowing IDB helpers.

---

## 2. Agreed findings

- **[P1] [Durability] `web/src/lib/pwa/outbox.ts:164` (+ `web/src/lib/pwa/job-cache.ts:153-175`)** — `enqueueSaveJobMutation` is documented to throw on IDB failure but `wrapTransaction` / `wrapRequest` resolve (not reject) on `onerror` / `onabort`. A quota error or aborted tx makes the mutation return "success" while nothing is persisted. Fix: introduce a strict wrapper (`wrapTransactionStrict`) that rejects on error/abort and use it in the enqueue path.
- **[P1] [Queue semantics / head-of-line blocking] `web/src/lib/pwa/outbox-replay.ts:87-93` + `queue-save-job.ts:84` + `outbox.ts:180`** — The replay worker routes every failure (including 4xx) through `markMutationFailed` and stops the global FIFO on the first failure. A permanently-rejecting 4xx row therefore stalls the entire queue (across all jobs) for the full ~18-minute backoff window before poisoning. Inline and replay paths also diverge in rejection semantics (inline re-throws 4xx, replay retries 10×). Fix: short-circuit terminal 4xx to a `markMutationPoisoned` branch in `attempt`.
- **[P2] [Test coverage] (all three new modules)** — No automated tests for backoff schedule, FIFO + stop-on-failure, 4xx terminal behaviour, enqueue-fail-loudly, sign-out purge atomicity, or replay success updating read cache. Handoff relies entirely on manual DevTools walkthroughs for a data-durability mechanism. Fix: stand up fake-indexeddb + add the listed cases before any 7d consumer ships.

---

## 3. Disagreements + adjudication

### 3.1 Stale cached `job-detail` after offline enqueue / after replay success

- **Codex says** — P1. `queueSaveJob` only refreshes the read cache on inline 2xx (`queue-save-job.ts:91-107`). On offline / 5xx the cache is untouched, so a reload before replay paints stale pre-edit data. The replay worker (`outbox-replay.ts:103-109`) also does not warm the cache after a successful replay. This contradicts the handoff goal that "offline edits survive tab close / revisit".
- **Claude says** — Does not raise this as a finding.
- **Adjudication — Uphold as P1.** Codex is correct that the mechanism as written does not make a queued edit visible on offline revisit; the user's IDB cache will show pre-edit state until network comes back and a fresh fetch happens. For inspectors working 3G/underground, this is the exact UX failure 7c was sold as solving. Even though 7c is "mechanism only", the mechanism's own write-through semantics are load-bearing and the replay worker omitting cache warming is a symmetric gap. Reason for upholding: the handoff explicitly asserts durability + revisit-visibility; Claude focused only on the IDB-error swallow (which is a separate P1) and missed this.

### 3.2 `markMutationFailed` RMW atomicity

- **Claude says** — Initially P1, then downgrades to P2 after checking the tx semantics. `wrapRequest` swallows `onerror`; the `{...current, ...}` spread on `null` would throw `TypeError`, which is caught by the outer try/catch. Brittle but not load-bearing.
- **Codex says** — Not raised.
- **Adjudication — Accept as P2** (Claude's own downgrade is correct). The single readwrite tx is sufficient for same-tab work; cross-tab is protected by IDB tx queueing on overlapping stores. Keep as an informational note.

### 3.3 `queueSaveJob` classifier treats unknown errors as transient

- **Claude says** — P2. Anything that isn't an `ApiError` 4xx falls through to `return { queued: true, synced: false }` (`queue-save-job.ts:76-89`), so a programming bug in `api.saveJob` (e.g. JSON parse `SyntaxError`) quietly queues and retries 10 times.
- **Codex says** — Not raised.
- **Adjudication — Accept as P2.** Defensive-programming concern; small blast radius but easy to fix by making the network-error branch explicit (`TypeError` / `ApiError 5xx` → queue; else → rethrow).

### 3.4 Stop-on-first-failure policy

- **Claude says** — Correct by design (captive-portal symmetry + FIFO correctness).
- **Codex says** — Problematic because a 4xx row stalls unrelated jobs; proposes either immediate-poison-on-4xx or partitioning by `jobId`.
- **Adjudication — Both are compatible.** The stop-on-failure policy is right for transient failures (P1 Claude concurs). The head-of-line blocking that Codex flags is specifically the 4xx-in-FIFO case and is resolved by the agreed P1 fix to short-circuit 4xx to poison (§2 finding 2), after which the next iteration continues. `jobId`-partitioning is not needed once 4xx no longer occupies the head slot. Logged as the 4xx fix, not as a separate disagreement.

---

## 4. Claude-unique findings

- **[P2] [Efficiency] `web/src/lib/pwa/outbox-replay.ts:76, 127-142`** — `listPendingMutations()` is called twice per pass (top of `processOnce`, then inside `scheduleNext`). Pass the list through instead.
- **[P2] [Stale `now` in loop] `web/src/lib/pwa/outbox-replay.ts:77`** — `now` captured once before the loop; refresh inside the loop header so long replay batches don't make stale cooling decisions.
- **[P2] [Sign-out race / cancellation] `web/src/lib/pwa/outbox-replay.ts:103-125, 170-178`** — `cancelledRef` is set on unmount, but in-flight `attempt()` doesn't re-check it after the `await api.saveJob(...)` returns; a late `markMutationFailed` after `clearJobCache()` can write a ghost row into the just-cleared store.
- **[P2] [`visibilitychange` trigger race] `web/src/lib/pwa/outbox-replay.ts:144-151, 157-159`** — Analysis only; Claude concludes it's safe within the microtask tick. No action.
- **[P2] [`generateId` fallback non-unique and non-uuid-shaped] `web/src/lib/pwa/outbox.ts:109-119`** — Collision possible if two mutations enqueue in the same ms with an unlucky `Math.random()`; only fires when `crypto.randomUUID` is absent. Acceptable; flag only.
- **[P2] [`by-user` index unused] `web/src/lib/pwa/job-cache.ts:114`** — Deliberate per handoff; add a TODO marker pointing to 7d so it doesn't silently rot.
- **[P2] [Use `add` not `put` for enqueue] `web/src/lib/pwa/outbox.ts:163`** — `add()` surfaces a uuid collision as an error; `put()` silently overwrites.
- **[P2] [Single-variant `OutboxOp` uses `if` not `switch`] `web/src/lib/pwa/outbox-replay.ts:105`** — Forward-compat: switch on `m.op` with exhaustive default that poisons unknown ops.
- **[P2] [`lastError` has no attempt-number context] `web/src/lib/pwa/outbox.ts:237`** — Admin UI in 7d won't be able to attribute the error to a specific attempt. Nice-to-have.
- **[P2] [Double export path for DB constants] `web/src/lib/pwa/outbox.ts:268`** — Re-exports `DB_NAME` / `STORE_OUTBOX` / `OUTBOX_INDEX_BY_USER` from `job-cache.ts`; 7d should pick one source of truth.

---

## 5. Codex-unique findings

- **[P1] [Stale offline read cache after enqueue + after replay success] `web/src/lib/pwa/queue-save-job.ts:78, 91` + `web/src/lib/pwa/outbox-replay.ts:103-109`** — See §3.1. Pending patch is not merged into the IDB `job-detail` cache on the offline / 5xx branch, and the replay worker doesn't warm the cache on replay success either. Offline revisit shows pre-edit state despite a persisted outbox row. Remedy options: apply patch to cached detail when queued-not-synced; overlay pending mutations during cached reads; or have the replay worker call `putCachedJob` after a successful replay.
- **[P2] [Head-of-line blocking by a single 4xx across unrelated jobs] `web/src/lib/pwa/queue-save-job.ts:79` + `web/src/lib/pwa/outbox-replay.ts:78` + `web/src/lib/pwa/outbox.ts:180`** — Framed at a higher level than Claude's §3.3. Solved by the same 4xx-poison fix; keep as the framing reference for why the agreed P1 matters cross-job.
- **[P2] [Abstraction mismatch: outbox reuses "best-effort" cache wrappers] `web/src/lib/pwa/job-cache.ts:148` + `web/src/lib/pwa/outbox.ts:161`** — Root cause of the P1-A durability bug. Codex frames it as an architectural concern (read helpers have different failure semantics than durability-critical writes) rather than purely a missing `reject`.

---

## 6. Dropped / downgraded

- **Claude §3 P1-C (`markMutationFailed` not safe vs concurrent remove)** — Downgraded by Claude to P2 after reading IDB tx semantics. Concur.
- **Claude §3 P2-C (`setTimeout` 1s floor vs NTP clock skew) `outbox-replay.ts:134`** — Acknowledged as not actionable; drop for 7c.
- **Claude §3 P2-F (`visibilitychange` vs in-flight pass)** — Claude self-verifies it's safe. Drop.
- **No security, performance, or a11y findings** — Both reviewers agree there are none for 7c.
- **"No consumer wired yet"** — Not a defect; handoff explicitly defers the consumer to Phase 4's debounced save flush or 7d. Keep as context only.

---

## 7. Net verdict + top 3 priority fixes

**Verdict:** Needs rework before any Phase 7d consumer lands. The mechanism is well-designed and scope-disciplined, but two load-bearing correctness guarantees (durability + offline-revisit visibility) are not actually enforced. No P0, but the P1s directly undermine the phase's stated outcome.

**Top 3 priority fixes (do these before wiring `queueSaveJob` into a save path):**

1. **Enforce durability on enqueue** — Add `wrapTransactionStrict` in `web/src/lib/pwa/job-cache.ts` that rejects on `onerror` / `onabort`; use it in `enqueueSaveJobMutation` at `web/src/lib/pwa/outbox.ts:164`. Keep the read-side helpers swallowing as they are.
2. **Make queued edits visible offline + after replay** — In `web/src/lib/pwa/queue-save-job.ts:78-89`, apply the patch to the cached `job-detail` (or overlay pending mutations at read time) on the queued-not-synced branch. In `web/src/lib/pwa/outbox-replay.ts:103-109`, warm `putCachedJob` on successful replay so a revisit sees the new state without a network round-trip.
3. **Terminal 4xx short-circuits to poison in replay** — In `web/src/lib/pwa/outbox-replay.ts:110-124`, branch on `ApiError` status: 4xx → `markMutationPoisoned` (new helper in `outbox.ts` adjacent to `markMutationFailed`), else → existing `markMutationFailed`. Removes the head-of-line blocking Codex flagged and unifies inline vs replay rejection semantics.

Test-harness work (fake-indexeddb + the six cases in §2 finding 3) should land alongside these fixes rather than after, so the durability contract is executable rather than prose.
