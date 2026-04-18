# Phase 1 Review — auth + dashboard with visual verification

**Commit:** `21a82b9`
**Reviewer:** Claude (Opus 4)
**Scope:** `web/src/middleware.ts`, `web/src/lib/{auth,api-client,types}.ts`, `web/src/app/{login,dashboard}/*`, `web/src/components/{dashboard,layout,ui}/*`, `web/scripts/verify-visual.ts`.

---

## 1. Summary

Phase 1 lands the first two authenticated surfaces of the rebuild: a `/login` page (glass card, triple orbs, `useTransition` submit) and a `/dashboard` page (3-up animated stats, New EICR/EIC quick actions, recent-jobs list with skeleton + empty states, setup tiles). It also introduces the cross-cutting plumbing the rest of the rebuild will lean on — an edge-middleware JWT route guard, a typed `api` wrapper with idempotent-only retries, a localStorage+cookie token mirror, and a `seedAuth` helper for the Playwright visual-verify script.

---

## 2. Alignment with original plan

Handoff objectives vs implementation:

| Objective | Status |
| --- | --- |
| `/login` glass card + triple ambient orbs + inline error + 44 px tap targets | Delivered (`login/page.tsx`) |
| `/dashboard` sticky nav + 3-up animated counters + quick actions + recent list + setup tiles | Delivered at commit time; later reworked for iOS parity (`27283fd`) — see §7. |
| Edge middleware that decodes JWT payload and checks `exp` | Delivered (`middleware.ts`) |
| `auth.ts` + `api-client.ts` + `types.ts` with Bearer + credentials dual-auth and idempotent-only retries | Delivered. |
| Playwright visual verification for phase-1 routes w/ seeded fake JWT | Delivered (`verify-visual.ts`). |

The hand-off's stated non-goals (iOS spring curve match, wiring real `/settings/*` tiles) are correctly deferred.

One small scope surprise: the commit description says "localStorage + mirrored cookie... not httpOnly... chosen deliberately". The reasoning cited (dashboard needs `user.id` client-side to key the jobs fetch) is valid, **but nothing in the commit forced the token itself to be in a JS-readable cookie** — only the `user` object requires client access. See §4 for details.

---

## 3. Correctness issues

### P1 — Dashboard 401 detection uses fragile regex on `err.message`

`web/src/app/dashboard/page.tsx:84` (also in commit as originally shipped):

```ts
if (/401/.test(err.message)) {
  clearAuth(); router.replace('/login'); return;
}
```

`api-client.ts` already throws a typed `ApiError` with `err.status`. Matching the literal substring `"401"` in the message means:

- A `500 "Database error: status 401 not allowed"` response body would be mis-classified as expired auth.
- An offline `TypeError` whose message ever mentions the string "401" (unlikely but possible) would also clear auth.

**Fix:** `if (err instanceof ApiError && err.status === 401)`.

### P1 — `api-client.ts` network-error retry loses inner error context for non-retry paths

`api-client.ts:75-86`: `lastError = err; … throw err;`. Fine. But on network `TypeError`, the caller's `err.message` will be the generic `"Failed to fetch"` / `"Load failed"`. Dashboard surfaces this raw to the user via `setError(err.message)` (line 93). Not a correctness bug per se, but it makes the offline UX bad (§5 touches it again).

### P2 — `isTokenExpired` returns `false` for tokens with no `exp` claim

`middleware.ts:28-31` (current working-tree form; commit had same behavior):

```ts
if (!payload.exp) return false;
```

This treats a token without `exp` as non-expired, letting it through forever. Defensible because the backend always sets `exp`, but a stricter default (treat missing `exp` as expired) would be safer against token-format drift. Tag P2 because the backend is the source of truth for tokens — but worth a comment explaining the intent.

### P2 — `AnimatedCounter` resets to 0 whenever `value` changes

`components/dashboard/animated-counter.tsx:20-41`: the effect always starts `from = 0`. If the dashboard later refreshes `stats` (say `active` goes from 5 → 6), the counter will flash back to 0 and re-animate up to 6. For a pre-empty-state snapshot this is invisible, but once jobs start cycling the UI it becomes a visible flicker.

**Fix:** close over previous `display` via `useRef` and tween from the last rendered value.

### P2 — Middleware `pathname.includes('.')` is a blunt static-asset check

`middleware.ts:41`: any authenticated route containing a period (e.g. `/job/some.name`) is treated as a static asset and passes auth. Unlikely to ever happen with ID-based routes, but brittle.

**Fix:** narrow to known asset extensions or rely on `matcher`'s exclusion list.

### P2 — Race in dashboard stale-while-revalidate (current working tree, introduced Phase 7b)

`dashboard/page.tsx:63-70`: `hadCache` is set from the cache resolver, but the network promise captures that variable in a closure. If the network resolves *first* and the cache resolves *second*, `hadCache` stays `false` but `jobs` has been populated by the network — and the `if (cached && jobs === null)` guard in the cache callback correctly protects against overwriting, so this one is OK. Worth noting only because the comment on line 102 hints at the same concern — the code handles it; the eslint-disable is load-bearing.

*This is not a Phase 1 regression — it's in the post-Phase-7 rework.*

---

## 4. Security issues

### HIGH — Token stored in a JS-readable cookie (XSS exfil surface)

`lib/auth.ts:36`:

```ts
document.cookie = `token=${token}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
```

No `Secure`, no `HttpOnly`. `HttpOnly` is impossible from `document.cookie` (browsers strip it), so the only way to get a protected cookie is for the backend to set it via `Set-Cookie` on the login response. The current choice means any XSS sink anywhere in the app can read the token, mint requests to `/api/*`, and exfiltrate arbitrary data.

The commit message defends this by saying "the dashboard needs `user.id` client-side". That argument applies to the **user** object (which can stay in localStorage), not to the **token**. A safer pattern:

1. Backend sets `Set-Cookie: token=…; HttpOnly; Secure; SameSite=Lax; Path=/` on login (same `token`, or a session-scoped shadow value).
2. Middleware reads that cookie (already does).
3. Client-side API calls drop the `Authorization: Bearer …` header and rely on the credentialed cookie instead (backend already accepts either).
4. `user` object keeps living in localStorage for the greeting / `user.id` keying.

This removes the XSS-token-theft vector and keeps middleware behavior identical.

**Tag:** HIGH. This is a classic JWT-in-JS-cookie mistake and Phase 1 is exactly the right time to fix it, before every later phase codifies the assumption.

### MEDIUM — Cookie missing `Secure`

Even if you stay with the JS-readable cookie, line 36 should add `Secure` in production builds. On HTTP the cookie is sent in plain text to any request. Easy fix: append `; Secure` when `location.protocol === 'https:'`.

### MEDIUM — `credentials: 'include'` on cross-origin fetch without explicit allow-list

`api-client.ts:48-55`: fetches send credentials to whatever `NEXT_PUBLIC_API_URL` resolves to. If that env var is ever compromised at build time (e.g. typo'd to a wildcard subdomain), cookies go out. Low actual likelihood given the deploy model, but a principle of least surprise would be to validate the URL's origin at module load.

### MEDIUM — No CSRF defense

Because cookie auth is live, the backend is exposed to CSRF for `POST/PUT/PATCH/DELETE` (there's no `X-Requested-With` or origin check visible from this PR's diff). If the backend continues to accept the bearer header **or** the cookie, an attacker can cross-site-POST with the cookie. The bearer header alone would be safe from CSRF; the dual-auth mode is the catch.

**Fix:** require the bearer header for mutating methods server-side, or add a CSRF token round-trip.

### LOW — Login page runs on both success + bad-redirect open redirects

`login/page.tsx:42` & :56: `redirect = params.get('redirect') ?? '/dashboard'` and `router.push(redirect)`. A crafted `?redirect=//evil.example/path` or `?redirect=javascript:…` depends on Next's `router.push` handling. Modern Next ignores absolute URLs with a different origin via `router.push`, but a path like `//evil.com/foo` can still be interpreted as protocol-relative in some routers.

**Fix:** `const safe = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/dashboard';`

### LOW — No password-field capslock or autocapitalize guards beyond the email field

Login password `Input` relies on `type="password"` alone; iOS Safari still won't autocapitalize passwords so this is OK, but adding `autoCapitalize="none"` is cheap defense against one of the most common user complaints on mobile.

### INFO — `verify-visual.ts` FAKE_JWT is a known literal

`scripts/verify-visual.ts` embeds a fake JWT with `exp=2099-01-01`. This is fine for local snapshotting because the middleware only checks shape + exp (signature isn't validated at the edge). Note for the future: if the middleware ever verifies signatures, this script has to migrate to a signed test token.

---

## 5. Performance

- **Bundle.** `lucide-react` is imported by individual names (dashboard), which tree-shakes cleanly. Good.
- **Animated counter.** Uses `requestAnimationFrame` with a single cleanup path. No leak. `typeof window === 'undefined'` guard is appropriate for SSR. However on every `value` change it creates and tears down an RAF loop; negligible cost but a comment in §3 above flags the UX.
- **Dashboard data fetch.** Single `GET /api/jobs/:userId`. No N+1. Good.
- **No memoization on `JobRow`.** Fine for ≤ 8 items.
- **Middleware runs on every HTML route** and performs a JSON-decode per request. The `atob → JSON.parse` is ~µs-scale — cheap. The `pathname.includes('.')` check is O(n) on pathname but trivial.
- **`next/font` missing.** The repo relies on `system-ui` stack in the design system; no performance cost, but just noting no web-font preload is happening for the brand wordmark.
- **Hero stats recompute only on `jobs` change.** `useMemo` correctly keyed.

---

## 6. Accessibility

Good:

- Login form uses explicit `<Label htmlFor>` with matching input `id`s. `required`, `autoComplete`, `inputMode`, `autoCapitalize`, `spellCheck` all set on email. Error element has `role="alert"`.
- Buttons are real `<button type="submit">` with `disabled` states.
- `aria-hidden` on all decorative orbs/sheen.
- `StatCard`'s `AnimatedCounter` passes `aria-label={ \`${value} ${label.toLowerCase()}\` }` so the live number is announced, not the starting 0.
- Section landmarks: `<main>`, `<section aria-labelledby>` on stats.

Issues:

### A11y-1 (P2) — AnimatedCounter announces animation frames to screen readers

`components/dashboard/animated-counter.tsx:43-47`: `<span aria-label="…">{display}</span>`. The static `aria-label` is fine, but the *visible text* changes every frame. VoiceOver (which reads both) can fire repeated announcements on some browsers. Additionally, `prefers-reduced-motion` is honored (snaps to final value) — good.

**Fix:** wrap the animating span with `aria-live="off"` and put the final-value `aria-label` on the parent container once animation settles; or render the digits inside `aria-hidden` and a separate sr-only span with the final value.

### A11y-2 (P2) — `JobRow` status pill conveys state via color only

`components/dashboard/job-row.tsx`: the status color (amber/green/red) and label are both present, so the label text saves this from being a WCAG 1.4.1 violation. BUT the pill text contrast should be audited — `#ffb340` on `rgba(255,159,10,0.18)` (light amber on light amber) may be below 4.5:1.

### A11y-3 (P2) — Login submit button has no loading announcement

`login/page.tsx:112-119`: button text toggles to `"Signing in…"` when `pending`, but there's no `aria-live` region and no `aria-busy` on the form. Screen readers won't announce the state change.

**Fix:** add `aria-busy={pending}` on the `<form>`.

### A11y-4 (P2) — Focus indicator on `SetupTile` `<a>` elements

`dashboard/page.tsx:396`: class includes `focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]` — good. But the button variant (`onClick` path) reuses the same classes without ensuring the browser default outline isn't suppressed elsewhere. Verify in snapshot with keyboard focus.

### A11y-5 (P2) — `<a>` with `onClick` in `SetupTile` pattern is correct, but `Log Out` should be `<button>`

`dashboard/page.tsx` line 241 uses `<SetupTile … onClick>` and the component correctly renders a `<button>` for the onClick variant (line 406). Good — but adding `type="button"` explicitly is already there. OK.

### A11y-6 (P1) — AppShell back button svg has no accessible name

`components/layout/app-shell.tsx:64-77`: the chevron svg is `aria-hidden`, and the wrapping `<Link>` has `aria-label="Back to dashboard"`. That's correct. No action.

### A11y-7 (P2) — Input lacks `aria-invalid` when login error is shown

`login/page.tsx` sets `error` state but doesn't set `aria-invalid` on the Email/Password inputs, nor link them via `aria-describedby`. A screen reader gets the `role="alert"` announcement but can't programmatically associate it with the offending field.

### A11y-8 (P2) — Dashboard search input is a plain `<input type="search">` without `<label>`

`dashboard/page.tsx:179-185` only uses `aria-label="Search jobs"`. Acceptable but a proper hidden `<label>` is stronger. (This was added in the later iOS-parity rework, post-commit — not Phase 1 itself.)

---

## 7. Code quality

### Convention drift (later-evolved files)

The working tree has diverged meaningfully from the Phase-1 commit:

- `dashboard/page.tsx` was reworked in commit `27283fd` ("dashboard iOS parity rework") — the 3-up StatCard + SetupTile grid seen in the original diff has been replaced by a `HeroCard` + `StartTile` + search input + pill-based `JobRow`. **The Phase-1 commit's dashboard no longer exists in HEAD.** That's by design (iOS parity) and is a legitimate follow-up rather than a review issue.
- `middleware.ts` now has an additional admin-role gate + `Cache-Control: no-cache` response header (addressing the global "Next.js App Router + Server Actions" rule). Additive — good.
- `login/page.tsx` now wraps `LoginForm` in `<Suspense>` (commit `3e902d8` fixes `next build`'s `useSearchParams` static-rendering requirement). Additive — good.
- `auth.ts` now also calls `clearJobCache()` on sign-out (Phase 7b). Additive — good.
- `api-client.ts` has grown from 114 → ~580 lines with later-phase endpoints appended (jobs CRUD, Deepgram token, CCU/document analyze, photo upload, settings, company admin, system admin). The core `request()` helper is unchanged from Phase 1.

### Duplication / dead code

- `dashboard/page.tsx` defines a local `signOut` function at line 141-144 that duplicates `handleSignOut` in `app-shell.tsx:39-47`. With the AppShell already mounted (via `dashboard/layout.tsx`), the shell's "Sign out" button is active; the dashboard's own Log Out tile is a separate entry point. They *both* work, but only the shell one calls `api.logout()` — the dashboard tile skips the server call. Inconsistent.
- `AppShell` handleSignOut swallows the logout API failure silently; the dashboard's `signOut` doesn't even try. Users on flaky networks will get mixed behavior depending on which button they tap.

### Naming / style

- `lib/types.ts` mixes snake_case (`company_name`, `created_at`, `certificate_type`) with camelCase elsewhere (`baseUrl`, `userId`). That's because the backend returns snake_case and the types mirror wire shape — fine, but it's worth a codebase-wide comment. (The commit message does explain this implicitly via "Envelope used by POST /api/auth/login".)
- `CertificateType` is exported in the types file but only used in the JSDoc for `Job['certificate_type']`. The inline union `'EICR' | 'EIC'` is re-declared in `api.createJob` signature — should use `CertificateType`.
- `JobRow`'s `STATUS_COLOR` (original commit) was replaced with `STATUS_PILL` in later rework. Keyed by status string — correct.

### Types

- `ApiError extends Error` with `public status: number`. Minimal but correct. Could carry the response body JSON for richer error display, but that's a later polish.
- `request<T>` returns `(T | undefined)` for 204s via `undefined as T`, which is a lie to the type system. Acceptable since call sites for 204-likely endpoints (`logout`, `adminUnlockUser`) declare `Promise<void>`.
- `api.logout(): Promise<void>` — but on a 204 the function does resolve with `undefined` correctly. Good.

### Error messages

- `api-client.ts:59` — `new ApiError(res.status, \`Server error ${res.status}\`)` on 5xx before reading the body. Losing the body text here means debugging prod 500s means reading server logs. Consider `body || \`Server error ${res.status}\`` like the non-5xx branch does.

### Other

- `login/page.tsx:52` uses `startTransition(async () => { … })`. React 19's `useTransition` **does** support async transitions, but any exception inside is swallowed into the transition's error boundary. The `try/catch` here handles it — good.
- The dashboard `useEffect` closes over `jobs === null` through `getCachedJobs`'s callback (working-tree version). The `eslint-disable react-hooks/exhaustive-deps` with a rationale comment is appropriate.

---

## 8. Test coverage gaps

No unit or integration tests ship with this phase. Only the Playwright visual-verify script was extended. Specific gaps:

1. **`middleware.ts`** — no test for `isTokenExpired` with: token missing, malformed base64, missing `.` separators, exp in past, exp in far future, missing `exp` claim. This function gates every page.
2. **`api-client.ts`** — no test for: 5xx triggers retry on GET, 5xx does NOT trigger retry on POST, network `TypeError` triggers retry, 204 returns `undefined`, non-JSON response returns text.
3. **`auth.ts`** — no SSR safety test (`typeof window` guard).
4. **`dashboard/page.tsx`** — no test for 401 → clear + redirect, empty-state render, error-state render, create-job success, create-job failure.
5. **`AnimatedCounter`** — no test for `prefers-reduced-motion` snap-to-value behavior.
6. **Visual verify** is valuable but captures pixels, not semantics — it would not catch a broken 401 handler.

The review file does not block shipping on these, but Phase 1 is the right place to seed the test scaffolding because every later phase will lean on these primitives.

---

## 9. Suggested fixes (numbered, concrete)

1. **`web/src/lib/auth.ts:36` — set cookie `HttpOnly` via backend `Set-Cookie`**; stop writing the token to `document.cookie` client-side. Replace with `Secure` + `HttpOnly` cookie issued by `POST /api/auth/login`. Client keeps storing only the user object in localStorage. *Why:* removes the XSS-token-exfil surface and aligns with "Authorization header stripped on HTTP→WS upgrade" rule (per global mistakes.md: "Never use `Authorization` headers for WebSocket auth on iOS. Always use URL query parameters") — the WebSocket path already uses query strings, so the bearer is only needed for REST, which the cookie covers.

2. **`web/src/app/dashboard/page.tsx:84` — replace `/401/.test(err.message)` with `err instanceof ApiError && err.status === 401`.** *Why:* the current check false-positives on any 5xx body containing the literal "401".

3. **`web/src/app/login/page.tsx:56` — validate the `redirect` param before `router.push(redirect)`.** Reject anything that doesn't start with exactly one `/`. *Why:* prevents `//evil.example/path` open-redirect via a crafted login URL.

4. **`web/src/components/dashboard/animated-counter.tsx:31` — tween from previous `display`, not always from 0.** Use a `useRef<number>(0)` that updates each tick; seed the next effect from it. *Why:* avoids back-to-zero flicker when stats update after the first render.

5. **`web/src/middleware.ts:29-31` — flip the default to "treat missing `exp` as expired".** Add a comment explaining the policy. *Why:* defensive against backend token-format drift.

6. **`web/src/middleware.ts:41` — replace `pathname.includes('.')` with a known-extension regex** (`/\.(png|jpg|svg|webp|ico|css|js|map|woff2?)$/`). *Why:* prevents future `/job/some.name` style paths from bypassing the auth gate.

7. **`web/src/lib/api-client.ts:59` — include response body in the 5xx `ApiError`** (`throw new ApiError(res.status, body || \`Server error ${res.status}\`)`). *Why:* makes production debugging possible from the client logs.

8. **`web/src/app/login/page.tsx` — add `aria-busy={pending}` on `<form>` and `aria-invalid` + `aria-describedby="login-error"` on both inputs when `error` is set.** *Why:* WCAG 2.1 AA for SR users.

9. **`web/src/components/dashboard/animated-counter.tsx` — mark the animating `<span>` as `aria-hidden` and render the final value in a sibling sr-only `<span>` with `aria-live="polite"`.** *Why:* stops per-frame SR announcements.

10. **`web/src/app/dashboard/page.tsx:141-144` — remove the local `signOut` and have the Log Out tile call through to a shared helper that also hits `api.logout()`.** *Why:* the dashboard and AppShell currently diverge on whether they call the server.

11. **Add a CSRF guard on mutating routes in the backend or require the bearer header for non-GET methods.** *Why:* `credentials: 'include'` opens classic CSRF on any future cookie-auth'd endpoint.

12. **Seed unit tests for `middleware.isTokenExpired` and `api-client.request` retry semantics.** *Why:* these are the two files every later phase depends on silently.

---

## 10. Overall verdict

**Ship with fixes.** The phase cleanly achieves its goals, the plumbing is sensibly designed (idempotent-only retries, typed API, prefers-reduced-motion support), and the visual verification harness is a genuine investment. The dashboard UI was subsequently reworked for iOS parity, which is expected and not a regression.

However, there is one architectural security item (JS-readable token cookie) that should be resolved before Phase 2 calcifies the pattern across more code paths.

### Top 3 priority fixes

1. **Move the token to an `HttpOnly; Secure; SameSite=Lax` cookie set by the backend.** (Suggestion #1.) — Security HIGH, and Phase 1 is the correct moment: every later phase already relies on `credentials: 'include'`, so the switch is mechanical (stop writing `document.cookie`, drop the bearer header, backend emits `Set-Cookie`).
2. **Fix the 401 detection in the dashboard (`err.status === 401`, not `/401/.test(err.message)`).** (Suggestion #2.) — P1 correctness; the regex check is a live bug waiting on a 5xx body that mentions "401".
3. **Harden the `redirect` query-param sanitization on `/login`.** (Suggestion #3.) — Security LOW but trivial to fix, and it's exactly the kind of thing that gets pointed out in a penetration test.

Secondary but worth batching: suggestion #6 (middleware extension allow-list) and #12 (unit tests for middleware + request retry) are cheap and pay back every subsequent phase.
