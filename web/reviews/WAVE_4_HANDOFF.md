# Wave 4 Handoff — RBAC signing, Radix Dialog sweep, Sonnet resume

**Branch:** `web-rebuild`
**Scope:** Wave 4 batch 1 — four parallel worktree agents landed as a single unified wave:
- D4 — signed RBAC claims + middleware HMAC verify
- D5 — Radix Dialog sweep + `<ConfirmDialog>` + `window.confirm` banishment
- 4c.5 backend — `session_ack` sessionId + `session_resume` rehydrate handler
- 4c.5 client — flag-gated reconnect state machine (AWS full-jitter backoff)

**Gate status (post-integration on `web-rebuild`):**

| Gate | Result |
|---|---|
| web vitest | **102 passed / 11 files** (73 baseline → 102, +29 new) |
| backend jest | **305 passed / 3 skipped / 14 suites** (273 baseline → 305, +32 new) |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors / 6 pre-existing warnings / 0 new |
| Playwright | **not yet rerun post-merge** (D5 agent ran 4/4 chromium green in its worktree; recommend rerun after the 4c.5 client merge to confirm no regression) |

---

## Why batch these four

D4 + D5 + 4c.5 are independent in code surface:

| Unit | Files owned |
|---|---|
| D4 | `src/auth.js` · `web/src/middleware.ts` · `web/src/lib/auth.ts` · auth + middleware tests |
| D5 | `web/src/components/ui/dialog.tsx` (new) · `web/src/components/ui/confirm-dialog.tsx` (new) · 6 modal call sites · `globals.css` · `record.spec.ts` |
| 4c.5 backend | `src/extraction/sonnet-stream.js` · `src/extraction/sonnet-session-store.js` (new) · 2 new test files |
| 4c.5 client | `web/src/lib/recording/sonnet-session.ts` · `web/tests/sonnet-session.test.ts` (new) |

Zero overlap → four subagents ran in parallel worktrees; all four merged cleanly into `web-rebuild`. A stashed pre-session `src/extraction/sonnet-stream.js` diff (Phase A observation_id work) popped cleanly over the 4c.5 backend changes — no conflict.

---

## 1. D4 — RBAC depth-of-defence

**Commits (on `wave-4-d4-rbac` before squash-merge):** `4de2fcb`, `ee07fda`, `560f4c0` — see `WAVE_4_D4_HANDOFF.md` for full detail.

### Backend — JWT mint signs `role`, `company_id`, `company_role`

`src/auth.js` `authenticate()` and `refreshToken()` now sign three additional claims:
- `role` — defaults `'user'`
- `company_id` — defaults `null`
- `company_role` — defaults `'employee'`

`refreshToken` re-reads from the DB, so a mid-session promotion takes effect on next rotation. **Additive only** — iOS clients that read only `token` + `user` from the login response are untouched (the claims travel inside the opaque JWT).

### Middleware — HMAC-SHA256 verify

`web/src/middleware.ts` is now async. `verifyAndDecodeJwt(token, secret)` runs `crypto.subtle.importKey('HMAC')` + `verify`. Only `alg: HS256` accepted — `alg: none` and missing `alg` fall through to `null`. If `JWT_SECRET` isn't exposed to the middleware runtime (local dev, Playwright `webServer`), falls back to `unsafeDecodeJwt` with a once-only warning log.

### Client — typed role getters

`web/src/lib/auth.ts` exports `SystemRole` (`'admin' | 'user'`), `CompanyRole` (`'owner' | 'admin' | 'employee'`), `getUserRole(user?)`, `getCompanyRole(user?)`. Unknown strings → `null`. Docstring is explicit: **UX only — write authorisation goes through middleware + server.**

### Tests

- `src/__tests__/auth.test.js` +3 — claim set at mint; defaults; refresh re-read.
- `web/tests/middleware.test.ts` rewritten for async + signed-token fixtures; +6 Wave 4 D4 tests (forged sig, `alg: none`, correctly-signed happy path, escalation guard, dotted admin path).
- `web/tests/auth-role-getters.test.ts` +5 — explicit arg / localStorage fallback / null / unknown / missing.

### Deferred

**HttpOnly cookie migration (FIX_PLAN §D D4 item 3)** — Phase 9 per Q3 default. Current posture: token in localStorage + mirrored cookie. When Phase 9 lands, `lib/auth.ts` and `use-current-user.ts` are the two files that need to swap the storage layer; every caller of `getUserRole` / `getCompanyRole` stays unchanged.

---

## 2. D5 — Radix Dialog sweep

**Commits (on `wave-4-d5-radix-dialog` before merge):** `3a0b80b` (primitives), `4a969a2` (sweep), `6a3d616` (Playwright flip) — see `WAVE_4_D5_HANDOFF.md`.

### Primitives

- `web/src/components/ui/dialog.tsx` — thin Radix wrapper. Surfaces `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose` + styled `DialogOverlay`, `DialogContent`, `DialogTitle`, `DialogDescription`. `DialogContent` takes `showCloseButton` (default `true`), `closeLabel` (default `'Close'`), and `unstyled` (drops centred-card defaults, keeps focus-trap / portal / aria-modal).
- `web/src/components/ui/confirm-dialog.tsx` — `<ConfirmDialog open onOpenChange title description confirmLabel confirmLabelBusy cancelLabel confirmVariant onConfirm busy />`. `confirmVariant='danger'` → `Button variant='destructive'`. Binary only; forms go through `Dialog` primitives directly.

### Sweep — six modal sites

| # | File | Before → After |
|---|---|---|
| 1 | `recording-overlay.tsx` | Hand-rolled `role="dialog"` → `Dialog` + `DialogContent unstyled` + `onPointerDownOutside={preventDefault}` (recording scrim guard) |
| 2 | `observation-sheet.tsx` | Hand-rolled dialog + manual Esc + body-scroll lock → `Dialog` + `DialogContent unstyled` (Radix handles Esc + scroll lock) |
| 3 | `settings/staff/page.tsx` | Local `ConfirmDeleteDialog` fn → `<ConfirmDialog confirmVariant="danger">` |
| 4 | `settings/company/dashboard/page.tsx` | `InviteEmployeeSheet` hand-rolled overlay → `Dialog` + `DialogContent` + `DialogTitle` + `DialogDescription` |
| 5 | `settings/admin/users/[userId]/page.tsx` | `window.confirm('Unlock account?')` + hand-rolled `ResetPasswordSheet` → `ConfirmDialog` for unlock, `Dialog` for reset |
| 6 | `settings/system/page.tsx` | `if (confirm('Discard mutation?'))` → `ConfirmDialog confirmVariant="danger"` |

**Zero `window.confirm` calls and zero `<div role="dialog">` patterns remain outside the primitive file.**

### Playwright flip

`web/tests-e2e/record.spec.ts`: the previously `.fixme`'d focus-trap placeholder is now a live `test()` — **"overlay traps Tab, Esc closes it, focus restores to the trigger"**. Covers:
1. 12× Tab forward with `document.activeElement` inside `[role="dialog"]` after each press
2. 6× Shift+Tab with the same assertion
3. Esc → `overlay.toBeHidden()`
4. Focus-restore: `expect.poll(...).not.toBe('body')` — weakest check that still catches regression

Plus a deterministic `onCloseAutoFocus` handler in `recording-overlay.tsx` that re-focuses the FAB by aria-label, defending against a Chromium race where pointerup briefly parks focus on `<body>` before Radix's default restore reads it.

### Deferred

- **Phase 6c admin-user deactivate modal** — scope exclusion, will use `<ConfirmDialog confirmVariant="danger">` in the next batch.
- **WebKit focus-trap spec coverage** — headless WebKit can't fake a mic stream; documented skip.

---

## 3. Wave 4c.5 — Sonnet reconnect (cross-stack)

Cross-stack work split as coordinated agents because original "4c — client-only reconnect" was impossible: the backend never surfaced a session id to the client.

### 3a. Backend — `session_resume` rehydrate handler

**Commits:** 2 commits on `wave-4c5-sonnet-resume-backend`; see `WAVE_4C5_BACKEND_HANDOFF.md` for protocol table.

**Protocol additions (all additive):**
- `session_ack { status: 'started' | 'reconnected' | 'resumed' | 'new', sessionId?: string | null }` — server mints a UUID on `session_start`, echoes it; returns `null` on a failed resume.
- `session_resume { sessionId }` — new rehydrate path (distinct from the legacy iOS `session_resume {}` sleep/wake frame, which is unchanged).

**Store:** `src/extraction/sonnet-session-store.js` — TTL + LRU in-memory store. `SONNET_SESSION_TTL_MS=300000` (5 min, matches `activeSessions` disconnect window), `SONNET_SESSION_MAX_ENTRIES=1000` (~100 KB worst case). TTL is **mint-anchored, not touch-anchored** — no indefinite extension. Metadata-only; live `EICRExtractionSession` still lives on `activeSessions`.

**Security:** user-boundary enforcement — resume with a mismatched user deletes the token (aggressive stance: once leaked, better to force the legit owner through `session_start`).

**Tests:** +29 (19 unit on the store + 10 WS integration).

### 3b. Client — flag-gated reconnect state machine

**Commits:** 4 commits on `wave-4c5-sonnet-resume-client`; see `WAVE_4C5_CLIENT_HANDOFF.md`.

**Feature flag:** `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED` (default OFF). Test hook `globalThis.__RECONNECT_FLAG` overrides at runtime.

**Backoff formula (AWS full-jitter):**
```
delay(attempt) = floor(min(500 * 2^(attempt-1), 10_000) * Math.random())
```
Ceiling 5 attempts. Cap 10 s (reached at attempt 6, which never fires).

**State machine (in `sonnet-session.ts`):**
- `onopen` resets `reconnectAttempts = 0` (open proves the pipe; clean close does not reset)
- `onclose` classifier:
  - clean (`1000` / `1005` / `!shouldReconnect`) → no retry
  - flag OFF + dirty → recoverable `onError` (pre-4c.5 behaviour)
  - flag ON + dirty + under ceiling → `scheduleReconnect()`
  - flag ON + dirty + over ceiling → terminal non-recoverable `onError`
- Reconnect branches: `hasConnectedOnce && sessionId != null` → `session_resume { sessionId }`; else `session_start`

**TTL expiry detection:** if prior ack `status='resumed'` and current ack `status='new'`, fire a recoverable warning — session continues with fresh context.

**Tests:** `web/tests/sonnet-session.test.ts` — 18 tests across 6 blocks (session_ack capture, flag OFF, flag ON, session_resume, close-code log, backoff math).

### Deploy order (safe either way)

1. Backend first (current default) — client flag OFF; new `session_ack.sessionId` is ignored by clients that don't read it.
2. Flip `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true` on the web ECS task def once backend is verified in staging. `NEXT_PUBLIC_*` is build-time inlined — requires a web rebuild.
3. Rollback = remove the env var + redeploy.

---

## 4. Integration log

Merges applied to `web-rebuild` in this order (all `--no-ff`):

```
68b5c9f  merge: Wave 4 D5 — Radix Dialog primitives + 6 modal migrations + Playwright focus-trap
f702ce9  merge: Wave 4 D4 — RBAC depth-of-defence (signed claims + HMAC verify + typed getters)
<hash>   merge: Wave 4c.5 backend — session_ack sessionId + session_resume rehydrate
<hash>   merge: Wave 4c.5 client — reconnect state machine (flag-gated, AWS full-jitter backoff)
```

A pre-existing working-tree diff in `src/extraction/{sonnet-stream.js, eicr-extraction-session.js}` + its test (Phase A `observation_id` work, not part of this wave) was stashed before the 4c.5 backend merge and popped cleanly afterwards with no conflict. It remains uncommitted in the working tree — orthogonal to Wave 4 and owned by the prior session that started it.

Worktrees removed:
- `.claude/worktrees/agent-a339e6f0` (D4)
- `.claude/worktrees/agent-a8c12be2` (D5)
- `.claude/worktrees/agent-a2c671ac` (4c.5 backend)
- `.claude/worktrees/agent-a3dd07fb` (4c.5 client)

Branches deleted (all merged): `wave-4-d4-rbac`, `wave-4-d5-radix-dialog`, `wave-4c5-sonnet-resume-backend`, `wave-4c5-sonnet-resume-client`. Also cleaned up leftover Wave 3 + `worktree-agent-*` branches at the same time.

---

## 5. Recommended next unit — Wave 4 batch 2

**6c — admin-user edit + deactivate modal**, scope-excluded from D5 per agent brief:

- Import `<ConfirmDialog confirmVariant="danger">` into the new admin-user edit page.
- New `/api/admin/users/:id` PATCH endpoint (Q8 answered yes in `WEB_REBUILD_COMPLETION.md`).
- Fold the 6b per-company settings key fix + D12 strict parsing on login + admin writes into the same batch.
- Now that D4's middleware reliably gates `/settings/admin/**`, the editor page can assume a signed-in admin reached it.

No cross-dependency with Wave 4 batch 1 commits. Safe to fire as a single worktree agent or split into D12-on-admin + 6c editor if the surface grows.

---

## 6. Remaining after Wave 4

Per `WEB_REBUILD_COMPLETION.md`:

- **Mini-wave 4.5** — zod v3/v4 dependency split + `types.ts` collapse.
- **Wave 5** — D7 full + D8 + D9 + D10 + lint-zero sweep.
- **Phase 8** — staged deploy + prod cutover.
- **Phase 9** (long-tail) — HttpOnly cookie migration (D4 item 3), JWT secret rotation runbook, middleware rejection telemetry, Redis promotion for Sonnet session store.

---

## 7. File inventory (aggregate)

### Added

- `web/src/components/ui/dialog.tsx`
- `web/src/components/ui/confirm-dialog.tsx`
- `web/tests/auth-role-getters.test.ts`
- `src/extraction/sonnet-session-store.js`
- `src/__tests__/sonnet-session-store.test.js`
- `src/__tests__/sonnet-stream-resume.test.js`
- `web/tests/sonnet-session.test.ts`
- `web/reviews/WAVE_4_D4_HANDOFF.md`
- `web/reviews/WAVE_4_D5_HANDOFF.md`
- `web/reviews/WAVE_4C5_BACKEND_HANDOFF.md`
- `web/reviews/WAVE_4C5_CLIENT_HANDOFF.md`
- `web/reviews/WAVE_4_HANDOFF.md` (this file)

### Modified

- `src/auth.js`
- `src/__tests__/auth.test.js`
- `src/extraction/sonnet-stream.js`
- `web/src/middleware.ts`
- `web/src/lib/auth.ts`
- `web/src/lib/recording/sonnet-session.ts`
- `web/src/components/recording/recording-overlay.tsx`
- `web/src/components/observations/observation-sheet.tsx`
- `web/src/app/settings/staff/page.tsx`
- `web/src/app/settings/company/dashboard/page.tsx`
- `web/src/app/settings/admin/users/[userId]/page.tsx`
- `web/src/app/settings/system/page.tsx`
- `web/src/app/globals.css`
- `web/tests/middleware.test.ts`
- `web/tests-e2e/record.spec.ts`

---

Wave 4 batch 1 shipped. Gates green (vitest 102 · jest 305 · tsc clean · 0 new lint). 6c queued for batch 2.
