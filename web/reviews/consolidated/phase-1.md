# Phase 1 — Consolidated Review (auth + dashboard)

**Commit:** `21a82b9`
**Reviewers consolidated:** Claude (Opus 4) + Codex
**Scope:** `web/src/middleware.ts`, `web/src/lib/{auth,api-client,types}.ts`, `web/src/app/{login,dashboard}/*`, `web/src/components/{dashboard,layout,ui}/*`, `web/scripts/verify-visual.ts`.

---

## 1. Phase summary

Phase 1 ships the first two authenticated surfaces of the ground-up rebuild: a glass-card `/login` with triple ambient orbs and a 3-up animated-counter `/dashboard` with quick actions, recent jobs, and setup tiles. It also introduces the cross-cutting plumbing every later phase leans on — an Edge-middleware JWT route guard, a typed `api` wrapper with idempotent-only retries, a localStorage+cookie token mirror, and the Playwright visual-verify harness (`seedAuth` + fake JWT). The plumbing is sensible, but the token-storage model and the 401-detection path need hardening before Phase 2 codifies them.

---

## 2. Agreed findings

Both reviewers independently flagged these (merged line cites where they differed):

- **[P1] Correctness / Security — Dashboard 401 detection uses regex on `err.message` instead of `ApiError.status`.** `web/src/app/dashboard/page.tsx:84` (Claude) / `:38` line cite in Codex refers to same working-tree block. `/401/.test(err.message)` false-positives on any 5xx whose body string contains "401", and fails deterministically on a real 401 whose body is just `"Unauthorized"`. Both reviewers recommend `err instanceof ApiError && err.status === 401`.

- **[P1/Medium] Security — Open-redirect via `?redirect=` after login.** `web/src/app/login/page.tsx:42` + `:56`. `params.get('redirect') ?? '/dashboard'` is pushed unchecked; `//evil.example/path` or a non-`/` path is not rejected. Both recommend validating `redirect.startsWith('/') && !redirect.startsWith('//')` before `router.push`.

- **[Medium/Low] Security — Cookie missing `Secure`.** `web/src/lib/auth.ts:36`. Token cookie is `SameSite=Lax` but not `Secure`, so it can travel over plain HTTP. Both recommend appending `Secure` on HTTPS.

- **[P2] Code quality — Error classification via regex on message text is fragile.** Same root cause as the 401 finding; both reviewers call out that string-matching on error messages is an anti-pattern that will drift as backend response bodies change.

- **[P2] Accessibility — Weak/inconsistent focus treatment on dashboard tiles and app-shell links.** Setup tiles (`web/src/app/dashboard/page.tsx:~236/396`) and app-shell links (`web/src/components/layout/app-shell.tsx:~46/66`) lack consistent `focus-visible` styling. Claude documents this as A11y-4; Codex lists it under §6.

- **[Info] Test-coverage gaps are the same set.** No unit tests for middleware `isTokenExpired` / JWT decode, no tests for `api-client` retry semantics, no tests for dashboard 401/empty/error paths, no test guarding `useSearchParams` + Suspense requirement. Visual verify captures pixels, not semantics.

---

## 3. Disagreements (side-by-side + adjudication)

### 3.1 JWT middleware — severity + root cause
- **Claude:** P2 — flags `isTokenExpired` returning `false` for tokens missing `exp`; considers ad-hoc decode acceptable because backend is source of truth.
- **Codex:** P1 — flags base64url decode never restoring `=` padding before `atob()`; claims valid JWTs with unpadded payload lengths can be rejected, causing redirect loops.
- **Adjudication (verified against `web/src/middleware.ts:18–26`):** Codex is technically correct per WHATWG `atob` spec (padding required), but in practice V8/JSC tolerate unpadded base64url for most JWT payload lengths. JWTs whose payload byte-length is 1 mod 3 can genuinely throw. `decodeJwt` catches and returns `null`, which then redirects to `/login` — a silent false logout, not a redirect loop. Keep as **P2 correctness** (padding hardening) and separately note **Claude's P2** that missing-`exp` → "not expired" should flip to stricter default. Both are real; treat as two distinct P2s, not one.

### 3.2 Middleware gate as a security boundary
- **Claude:** Doesn't dispute the unsigned-decode approach; treats middleware as UX gate (per commit rationale).
- **Codex:** Medium security — calls out that middleware accepts any token-shaped cookie whose payload decodes with a future `exp`, signature never verified; forged cookies can reach protected frontend routes.
- **Adjudication:** Codex is right that the gate is not a real security boundary, but Phase 1's design explicitly delegates auth enforcement to the backend (`/api/*` calls verify the bearer). The frontend-route guard is UX only. Tag this **[Low, architectural]** with a documentation follow-up: the middleware's role must be made explicit in code comments so a future reviewer doesn't assume signature verification is happening. Not a P0/P1 blocker.

### 3.3 Token storage (JS-readable cookie)
- **Claude:** HIGH — proposes moving token to `HttpOnly; Secure; SameSite=Lax` cookie issued by backend; keeps `user` object in localStorage. Argues Phase 1 is the right moment before the pattern calcifies.
- **Codex:** Does not raise this. Only flags `Secure` omission.
- **Adjudication:** Claude's finding is a genuine architectural security concern — any XSS anywhere in the SPA can exfil the bearer. Keep as **Claude-unique [High]** (see §4). Not consensus, but not a disagreement either — Codex simply didn't raise it.

### 3.4 `useSearchParams` + Suspense build break
- **Claude:** Notes it as working-tree drift — already fixed in commit `3e902d8`.
- **Codex:** P1 — calls out as a current bug in the target commit.
- **Adjudication (verified):** Codex is strictly correct for the exact phase-1 commit `21a82b9` — at that snapshot, `useSearchParams` was called without a `Suspense` boundary and `next build` would fail. The working tree (`login/page.tsx:32`) already wraps `LoginForm` in `<Suspense>`. Because this consolidation is a phase-level review (not HEAD review), keep it **[P1, already-fixed]** — acknowledge as a genuine commit-time defect but mark resolved.

### 3.5 Dashboard recovery when `cm_user` localStorage is stale but token is valid
- **Claude:** Does not raise.
- **Codex:** P2 — dashboard forces `/login` instead of using `api.me()` to recover the session.
- **Adjudication (verified at `dashboard/page.tsx:42-46` and `api-client.ts:110-112`):** `api.me()` exists and is unused. Codex's suggestion is sound and low-cost. Keep as **Codex-unique [P2]** (see §5).

### 3.6 `AnimatedCounter` resets to 0 on every `value` change
- **Claude:** P2 — flicker when stats update.
- **Codex:** Not raised.
- **Adjudication:** Real issue in `components/dashboard/animated-counter.tsx:20-41`. Keep as **Claude-unique [P2]**.

### 3.7 `pathname.includes('.')` as static-asset heuristic
- **Claude:** P2 — brittle for future `/job/some.name` paths.
- **Codex:** Not raised.
- **Adjudication (verified at `middleware.ts:41`):** Unlikely to hit today with UUID-based job IDs, but the heuristic is load-bearing — a single `.` anywhere in the pathname bypasses auth. Keep as **Claude-unique [P2]**.

### 3.8 Setup tiles using `<a href>` instead of `next/link`
- **Claude:** Not raised directly (notes SetupTile variants in code-quality section).
- **Codex:** Performance — forces full page reload, loses prefetch.
- **Adjudication:** Valid at commit time; the post-commit rework replaced SetupTile layout entirely, so the concern may be moot at HEAD. Keep as **Codex-unique [P2, phase-1-only]**.

---

## 4. Claude-unique findings

- **[High — Security] Token in JS-readable cookie + localStorage.** `web/src/lib/auth.ts:36`. `document.cookie = token=…; SameSite=Lax` has neither `HttpOnly` nor `Secure`. Any XSS sink can read the bearer. Proposed fix: backend issues `Set-Cookie: token=…; HttpOnly; Secure; SameSite=Lax` on login; client drops `Authorization` header for REST; `user` object stays in localStorage for greeting / `user.id` keying.

- **[Medium — Security] `credentials: 'include'` sends cookies to `NEXT_PUBLIC_API_URL` without an origin allow-list.** `web/src/lib/api-client.ts:48-55`. Build-time compromise of the env var → cookies leak. Suggest validating URL origin at module load.

- **[Medium — Security] No CSRF defense with dual-auth.** Backend accepts bearer header OR cookie; any mutating `POST/PUT/PATCH/DELETE` is CSRFable while the cookie is live. Require bearer header for mutating methods, or add CSRF token round-trip.

- **[Low — Security] Password field missing `autoCapitalize="none"`.** iOS Safari skips autocap for `type=password` already, but defensive-in-depth is cheap.

- **[P2 — Correctness] `AnimatedCounter` resets to 0 on every `value` change.** `components/dashboard/animated-counter.tsx:20-41`. Visible flicker once stats start cycling.

- **[P2 — Correctness] Middleware `pathname.includes('.')` is a blunt static-asset check.** `middleware.ts:41`.

- **[P2 — Correctness] `isTokenExpired` returns `false` for tokens with no `exp`.** `middleware.ts:28-31`. Stricter default (treat missing `exp` as expired) is safer against backend drift.

- **[P2 — Code quality] 5xx `ApiError` discards response body.** `api-client.ts:59` — `new ApiError(res.status, \`Server error ${res.status}\`)` loses the body. Harder to debug prod 500s from client logs.

- **[P2 — Code quality] Duplicate sign-out paths.** Dashboard's Log Out tile calls a local `signOut` that skips `api.logout()`; AppShell's Sign out button calls `api.logout()`. Inconsistent depending on which the user taps.

- **[P2 — A11y] `AnimatedCounter` announces every frame.** `components/dashboard/animated-counter.tsx:43-47` — visible text changes each frame but `aria-label` is static. Wrap animating span in `aria-hidden`, render final value in sr-only `<span aria-live="polite">`.

- **[P2 — A11y] Login inputs missing `aria-invalid` / `aria-describedby` when error is shown.** `login/page.tsx` — screen readers can't programmatically associate the `role="alert"` with the offending field.

- **[P2 — A11y] Login submit has no `aria-busy` on the form.** Button text changes to "Signing in…" but SRs don't get a state-change announcement.

- **[P2 — A11y] JobRow status pill contrast.** `#ffb340` on `rgba(255,159,10,0.18)` may fail 4.5:1.

- **[Info] `verify-visual.ts` FAKE_JWT with exp=2099.** Fine today because the edge middleware doesn't verify signatures; becomes a required-refactor if the gate ever goes cryptographic.

---

## 5. Codex-unique findings

- **[P1 — Correctness, at-commit] `useSearchParams()` without `Suspense`.** `web/src/app/login/page.tsx` at commit `21a82b9`. Blocks `next build`. **Already fixed at HEAD** (see §3.4).

- **[P1 — Correctness] JWT base64url decode never restores padding.** `web/src/middleware.ts:18-22`. `atob()` strictly requires padding; some payload lengths throw, `decodeJwt` catches, and the user gets silently redirected to `/login`. Add `.padEnd(Math.ceil(payload.length / 4) * 4, '=')` before `atob`. (Adjudicated to P2 in §3.1 — kept here as Codex's original severity.)

- **[Medium — Security] Middleware is not real JWT validation.** `web/src/middleware.ts:13` + `verify-visual.ts:37`. Forged cookie can reach protected frontend routes. Adjudicated to **Low + doc-only** in §3.2 because the gate is explicitly UX-level by design; tag comments in middleware to make this explicit.

- **[P2 — Correctness] Dashboard hard-depends on `cm_user` localStorage.** `dashboard/page.tsx:27` — if `getUser()` is missing/corrupt but token is still valid, the app forces `/login` instead of calling `api.me()` to recover. Fix: when `getUser()` is null but `getToken()` is truthy, hit `api.me()`; only redirect on its failure.

- **[P2 — Performance] Setup tiles use `<a href>` not `next/link`.** `dashboard/page.tsx:~236`. Full page reload, no prefetch. May be moot at HEAD after iOS-parity rework.

- **[P2 — Code quality] Auth state duplicated via localStorage snapshots rather than single source of truth.** `api.me()` exists but unused in Phase 1; `getUser()` is called independently from multiple components.

---

## 6. Dropped / downgraded

- **Codex's "middleware is not real JWT validation" (Medium → Low + doc):** the Phase-1 commit message explicitly says "JWT-in-cookie middleware … lets us keep the backend unchanged while still blocking unauth'd navigation at the edge." Backend `/api/*` is the real gate. Downgrade but require a comment in `middleware.ts` making the UX-only role explicit.

- **Codex's `useSearchParams` / Suspense P1 (kept but marked resolved):** already fixed at HEAD by commit `3e902d8`. Noted for provenance; no action needed.

- **Claude's "dashboard stale-while-revalidate race" (§3 P2):** Claude itself annotates this as a post-Phase-7 introduction, not a Phase 1 regression. Drop from the Phase 1 verdict. Re-raise in the Phase 7b review if relevant.

- **Claude's A11y-5 (Log Out should be `<button>`):** Verified in code — SetupTile already renders a `<button type="button">` for the `onClick` variant. Drop — non-issue.

- **Claude's A11y-6 (AppShell back-button SVG):** Claude itself concludes "No action" after inspection. Drop.

---

## 7. Net verdict + top 3 priorities

**Verdict: Ship with fixes (Claude) / Needs rework (Codex) → Consolidated: Ship after P1 fixes land; seed test scaffolding before Phase 2.**

Phase 1 cleanly achieves its stated goals and the plumbing decisions (idempotent-only retries, typed API, reduced-motion support, visual-verify harness) are sound. However, two items are live bugs and one is an architectural security call that should not be deferred.

**Top 3 priorities:**

1. **[P1] Replace `/401/.test(err.message)` with `err instanceof ApiError && err.status === 401` in `dashboard/page.tsx:84`.** Live bug — any 5xx body containing "401" or any real 401 whose body is just "Unauthorized" is currently misclassified. Cheapest and highest-signal fix.

2. **[High — Security, architectural] Move the bearer token to a backend-issued `HttpOnly; Secure; SameSite=Lax` cookie; keep `user` in localStorage.** Phase 1 is the correct moment — every later phase codifies `credentials: 'include'` and the switch is mechanical once the backend emits `Set-Cookie`. Removes the XSS → token-exfil surface. Combine with validating `redirect` on `/login` (`startsWith('/') && !startsWith('//')`) to close the open redirect flagged by both reviewers.

3. **[P2 — Middleware hardening] Three small changes in `middleware.ts`:** (a) pad the base64url payload before `atob()` to stop silent false logouts; (b) flip missing-`exp` policy to "treat as expired"; (c) replace `pathname.includes('.')` with a known-extension regex. Plus a comment making the UX-only nature of the gate explicit so future reviewers don't assume signature verification.

**Secondary batch worth doing alongside the top 3:** seed unit tests for `middleware.isTokenExpired` + `decodeJwt` and `api-client.request` retry semantics (§8 in Claude, §8 in Codex — these are the files every later phase silently depends on); include response body in 5xx `ApiError`; fix `AnimatedCounter` to tween from previous value; add `aria-busy` / `aria-invalid` on login form; fall back to `api.me()` when `cm_user` is missing but token is valid.
