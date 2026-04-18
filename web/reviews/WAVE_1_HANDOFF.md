# Wave 1 Handoff — P0 Kill-List Sweep

**Branch:** `web-rebuild`
**Scope:** `FIX_PLAN.md §F. Wave 1 — Kill-list correctness` (17 P0 defects)
**Status:** 17 / 17 complete · `tsc --noEmit` clean

---

## What was done

All 17 P0 items from the kill-list are fixed. A single-line summary per item with the file(s) touched.

| # | Defect | Fix | Files |
|---|---|---|---|
| P0-1 | `api.saveJob` was `PATCH` — backend exposes `PUT` only | Switched verb + payload shape | `web/src/lib/api-client.ts` |
| P0-2 | `JobProvider.updateJob(patch)` clobbered unrelated in-flight state | Accept functional-updater form; only reset on `initial.id` change | `web/src/lib/job-context.tsx` |
| P0-3 | `applyCcuAnalysis` stomped flat `ccu_analysis` across boards | Added `ccu_analysis_by_board` scoped map + `board_model` mapping | `web/src/lib/recording/apply-ccu-analysis.ts`, `web/src/lib/types.ts` |
| P0-4 | Middleware `pathname.includes('.')` bypass let any `*.foo` path skip auth | Replaced with `STATIC_ASSET_EXT` whitelist regex | `web/src/middleware.ts` |
| P0-5 | `/settings/company/dashboard` only checked `role === 'admin'` | Added `COMPANY_ADMIN_PREFIX` gate honouring `company_role ∈ {owner, admin}` | `web/src/middleware.ts` |
| P0-6 | Sonnet session always sent `certificateType: 'EICR'` | Thread `SessionStartOptions.certificateType` from `recording-context.tsx` | `web/src/lib/recording/sonnet-session.ts`, `web/src/lib/recording-context.tsx` |
| P0-7 | AudioWorklet resample happened at both Deepgram + ring-buffer boundaries (drift) | Moved to single ingress resample via new `resample.ts`; both consumers now see 16kHz | `web/src/lib/recording/resample.ts` (new), `web/src/lib/recording-context.tsx`, `web/src/lib/recording/deepgram-service.ts` |
| P0-8 | `onerror` + `onclose` each triggered a reconnect — double connect storm | `errorEmitted` latch + `emitError()` helper | `web/src/lib/recording/deepgram-service.ts` |
| P0-9 | Verified Deepgram subprotocol already uses `['token', apiKey]` array form | Documented in code comments | `web/src/lib/recording/deepgram-service.ts` |
| P0-10 | `/proxy/deepgram-streaming-key` silently fell back to the **master API key** on temp-token failure | Return `503` instead — master key never leaves the server | `src/routes/keys.js` |
| P0-11 | Outbox writes used `wrapTransaction` which resolves on IDB abort — silent data loss | New `wrapTransactionStrict` rejects on `onerror` / `onabort`; wired into `enqueueSaveJobMutation` | `web/src/lib/pwa/job-cache.ts`, `web/src/lib/pwa/outbox.ts` |
| P0-12 | Replay worker retried 4xx forever → head-of-line stall for every queued mutation | Route 4xx (excl. 401) to new `markMutationPoisoned`; loop `continue`s past poisoned rows | `web/src/lib/pwa/outbox.ts`, `web/src/lib/pwa/outbox-replay.ts` |
| P0-13 | Queued-offline branch never wrote through to read-cache — next page render flashed pre-edit state | `writeThroughCache()` helper called from both offline-queued + online-success branches; replay-worker success path also overlays patch onto IDB cache | `web/src/lib/pwa/queue-save-job.ts`, `web/src/lib/pwa/outbox-replay.ts` |
| P0-14 | `controllerchange` fired on first SW install → infinite reload loop on fresh visitors | Capture `hadControllerAtMount` latch; no-op the first transition | `web/src/components/pwa/sw-update-provider.tsx` |
| P0-15 | Company settings keyed by `userId` — each employee kept private copy, PDFs diverged | New `companySettingsPrefix(user)` keys by `company_id`; logo GET falls back to legacy userId path so existing uploads remain readable | `src/routes/settings.js` |
| P0-16 | Login `?redirect=` accepted `//evil.com` + absolute URLs → open-redirect | `sanitiseRedirect()` rejects protocol-relative, backslash, and absolute-URL values | `web/src/app/login/page.tsx` |
| P0-17 | Admin edit of `company_name = ''` saved empty string as company record | Trim → `null` when empty; `adminUpdateUser` signature updated | `web/src/app/settings/admin/users/[userId]/page.tsx`, `web/src/lib/api-client.ts` |

---

## What was not touched (intentional)

- **Auto-migration of legacy logo S3 keys.** The P0-15 fix keeps a read-fallback to `settings/${userId}/logos/…` but new uploads only ever hit the company-scoped path. A one-shot migration can run in Wave 2 once a tenant inventory job is written.
- **PUT company-settings company_role gate.** `settings.js` still allows any authenticated user whose path param matches their own id to PUT company settings. Restricting to `company_role ∈ {owner, admin}` was deferred — the UI needs to surface read-only affordances first. Flagged at top of `companySettingsPrefix()` docstring.
- **`MAX_ATTEMPTS` tuning.** Kept at 10 — sufficient for field observations so far. Reconsider once Wave 2 telemetry is in place.

---

## Verification

- `tsc --noEmit` from repo root: clean (after a one-line type fix in `apply-ccu-analysis.ts:371` post-P0-3).
- No tests were added — all Wave 1 items are correctness/security fixes on existing surface. Test-first coverage is Wave 2's `§G. Wave 2 — Regression harness` problem.
- Manual sanity passes were not run in this session. The sanity checklist at `FIX_PLAN.md §J` is the right QA step before merging to `main`.

---

## Why this approach

The kill-list is a sweep of latent bugs that don't share a root cause — most are single-file edits of 1-to-30 lines. Rather than bundle into architectural chunks, each P0 landed as an isolated diff so:

- A revert only unwinds one fix, not a stack.
- The PR reviewer (or a future git-blame session) can reason about each change in a self-contained scope.
- Wave 2's regression harness will have 17 individually-testable fix surfaces to seed tests around.

The one exception is the outbox cluster (P0-11 / P0-12 / P0-13) — they touch overlapping modules and landing them atomically avoids an intermediate state where the strict wrapper is in place but poison-routing isn't, which would produce *more* silent dropped mutations than the original buggy code. Kept as one logical unit.

---

## Recommended next wave

Per `FIX_PLAN.md`:

- **Wave 2 — Regression harness.** Seed vitest coverage around:
  - Outbox: strict-wrap rejection, 4xx poisoning path, 401 → transient, cache write-through on both branches.
  - Middleware: `.foo` path doesn't bypass, `/settings/company/*` accepts `company_role` owner/admin.
  - `applyCcuAnalysis`: two-board job doesn't cross-bleed.
- **Wave 3 — Deploy hygiene.** `DEPLOY_NOTES.md` still flags Serwist precache-manifest hash drift on stale prod visitors — needs a staging soak before hitting main.

---

## Open questions for Derek

1. Should the P0-15 company-scoped key be backfilled via a one-shot ECS task, or left to natural overwrite on the next inspector save? (Natural is safer but means ~N weeks of stale PDFs for multi-user firms.)
2. Do we want PUT `/settings/:userId/company` gated to `company_role ∈ {owner, admin}` before Wave 2 ships, or is that acceptable follow-up work?
3. `MAX_ATTEMPTS = 10` on the outbox — keep or bump? Needs a decision before Wave 2's replay-loop tests hard-code the expectation.

---

Kill-list done. Ready for Wave 2 when you are.
