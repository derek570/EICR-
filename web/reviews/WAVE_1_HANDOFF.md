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

## Post-merge decisions (previously "open questions")

The three decisions flagged at the bottom of the initial handoff have been researched and landed. Summary + rationale for each below; the code lives in a follow-up commit on top of the Wave 1 stack (see `git log --oneline`).

### Q1 — Legacy company-settings S3 key migration

**Decision: Lazy read-fallback in `GET /api/settings/:userId/company`.**

Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| A — One-shot migration job | Eager, predictable end state | Needs tenant inventory + has to pick a winner when multiple users in the same company had divergent legacy copies (the exact race P0-15 exists to prevent). Cross-tenant write-heavy migration is risky to run on a live deploy. |
| B — Do nothing (natural overwrite) | Zero code, zero risk | Every post-deploy user sees blank defaults until someone fills them in. Multi-user firms race all over again because the UI doesn't distinguish "company hasn't set these" from "defaults fell back". |
| **C — Lazy read-fallback** | Zero migration cost, zero orphaned data, first admin PUT promotes the legacy copy into the company key | If two employees' legacy files differed, whichever admin opens the settings page first wins. |

Option C landed. The fallback helper `downloadCompanySettings(user)` tries the company-scoped key first; if absent, it reads the caller's legacy per-user file. Because Q2 (below) gates PUT to company admins, the "whichever admin wins" behaviour is exactly who we want to trust with the implicit merge decision. Legacy files stay in S3 for audit — once the company-scoped key exists, the fallback is never consulted again and the legacy files are dead weight only.

Logo GET already had this fallback (landed as part of P0-15); the company-settings GET fallback is symmetric.

### Q2 — Gate PUT to `company_role ∈ {owner, admin}`

**Decision: Gate immediately, at the server.**

Pre-P0-15 this was a nice-to-have: an employee's rogue PUT only rewrote their own per-user copy. Post-P0-15 it's a data-integrity regression *introduced by the fix* — an employee with a valid session could now curl the endpoint and rewrite the entire company's branding / contact details, which then propagate to every subsequent PDF for every user in the firm.

The frontend already gates the save button via `isCompanyAdmin(user)` (which allows `owner`, `admin`, and system admins), so the backend gate has zero UI impact — it just closes the server-side hole. System admins are explicitly allowed on the backend so cross-tenant repair work doesn't require owner impersonation.

New helper `canEditCompanySettings(user)` is applied to both `PUT /settings/:userId/company` *and* `POST /settings/:userId/logo` — logo upload is shared-state too because the returned S3 key gets merged into `company_settings.logo_file`.

### Q3 — Outbox `MAX_ATTEMPTS`

**Decision: Bump 10 → 15.**

Current policy: exponential backoff with a 5-min cap. With 10 attempts, total time from first failure to poisoning is ~18 min at the cap. Offline time doesn't consume attempts (the worker short-circuits when `navigator.onLine` is false), so the 18-min window only applies to *server-reachable-but-failing* scenarios (captive portal, deploy partial outage, backend rolling restart).

15 attempts gives ~45-60 min of coverage, which comfortably rides out a typical deploy window or captive-portal session without retaining rows that have genuinely been failing all day. P0-12 already routes 4xx (except 401) to immediate poisoning, so this counter only governs *transient* failure retention — which is exactly what we want to tune for real-world flakiness.

Landed now (not deferred to Wave 2) so the replay-loop tests can hard-code the final value instead of being written against 10 and then rewritten when we bump.

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

## Remaining known gaps (genuinely deferred)

Now that Q1–Q3 are closed, the only outstanding items are:

- **Logo S3 migration.** New uploads land at the company-scoped prefix; legacy per-user logo paths are still served via read-fallback. A one-shot cleanup that deletes legacy files after the company-scoped copy exists can run whenever a tenant inventory job is written, but there's no correctness pressure — the fallback is cheap and legacy files are quiescent once unreferenced.
- **Telemetry on outbox poisoning.** `MAX_ATTEMPTS = 15` is a considered guess; Wave 2 should surface a count of poisoned rows per deploy so we can tune with evidence instead of intuition.

---

Kill-list + Q1/Q2/Q3 decisions done. Ready for Wave 2 when you are.
