## 1. Summary of the phase
Phase 1 adds the first authenticated web surfaces: a `/login` screen, a guarded `/dashboard`, an authenticated app shell, and a thin typed API/auth layer. It also extends the Playwright visual-verification harness so login and dashboard can be snapshotted on mobile and desktop.

Note on drift: the working tree has moved since `21a82b9` in at least `web/src/app/login/page.tsx`, `web/src/app/dashboard/page.tsx`, `web/src/lib/auth.ts`, and `web/src/middleware.ts`; notably, login now wraps `useSearchParams()` in `Suspense`, which appears to address one issue below.

## 2. Alignment with original plan
The implementation broadly matches the handoff doc and commit intent: login visuals, dashboard quick actions/list/empty state, app shell, middleware gate, auth helpers, API wrapper, and visual verification are all present.

The main gap is that the “working entry” objective is undermined by a likely production-build problem in the login route and by a route guard that only checks unsigned JWT payload shape/expiry, which is weaker than “blocking unauthenticated navigation” in any security sense.

## 3. Correctness issues
- **P1** `useSearchParams()` is called directly in the page component without a `Suspense` boundary in the target commit, which is a known App Router build constraint in Next 16. See [web/src/app/login/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/login/page.tsx:21). The current tree’s later refactor strongly suggests this was already hit and fixed.
- **P1** JWT decoding in middleware does base64url character replacement but never restores padding before `atob()`. Valid JWTs with unpadded payload lengths can be rejected as “expired/invalid,” causing redirect loops for legitimate users. See [web/src/middleware.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:15).
- **P2** Dashboard auth-expiry handling keys off `/401/.test(err.message)` instead of `ApiError.status`, so a normal 401 body like `"Unauthorized"` will not clear auth or redirect. See [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:38).
- **P2** The dashboard hard-depends on the `cm_user` localStorage snapshot; if that entry is missing/corrupt but the auth cookie/token is still valid, the app forces `/login` instead of recovering via `/api/auth/me`. See [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:27) and [web/src/lib/api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:94).

## 4. Security issues
- **[Medium] Open redirect after login.** The `redirect` query param is pushed without validation, so `/login?redirect=...` can send users to attacker-controlled locations after a successful sign-in. See [web/src/app/login/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/login/page.tsx:22) and [web/src/app/login/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/login/page.tsx:36).
- **[Medium] Middleware gate is not real JWT validation.** It accepts any token-shaped cookie whose decoded payload has a future `exp`; signature is never verified. The visual harness explicitly relies on this with a fake JWT. See [web/src/middleware.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:13) and [web/scripts/verify-visual.ts](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:37). That means protected frontend routes can be reached with a forged cookie.
- **[Low] Auth cookie is not marked `Secure`.** The token cookie is set with `SameSite=Lax` but not `Secure`, so it can be transmitted over plain HTTP in non-TLS environments. See [web/src/lib/auth.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/auth.ts:35).

## 5. Performance issues
- Setup tiles use plain `<a href>` instead of `next/link`, which forces full page navigations and gives up client-side routing/prefetch for internal routes. See [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:236).

## 6. Accessibility issues
- Setup tiles have hover styling but no visible keyboard focus treatment, so tab navigation on the dashboard has weak focus affordance. See [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:236).
- The app-shell logo link/back link also lack explicit `focus-visible` styling, unlike `JobRow`, so keyboard focus treatment is inconsistent. See [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:46) and [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:66).

## 7. Code quality
- Auth state handling is brittle and duplicated around localStorage snapshots instead of using a single “current user” source of truth. `api.me()` exists but is unused in Phase 1. See [web/src/lib/api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:94), [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:27), and [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:21).
- Error classification via regex on message text is fragile and will drift as backend responses change. See [web/src/app/dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:41).

## 8. Test coverage gaps
- No automated test for the login route’s `redirect` handling or open-redirect prevention.
- No middleware tests for malformed JWTs, unpadded base64url payloads, expired tokens, or forged tokens.
- No auth-flow test covering dashboard fetch 401s and redirect/clearAuth behavior.
- No build/route test guarding against the `useSearchParams()` + `Suspense` App Router requirement.
- Visual verification exists, but it only proves screenshots render under mocked auth/data.

## 9. Suggested fixes
1. `web/src/app/login/page.tsx:21` — wrap the `useSearchParams()` consumer in `Suspense` and keep the outer shell static. This avoids the Next 16 App Router build failure and matches the current working-tree fix.
2. `web/src/middleware.ts:15` — replace ad hoc JWT parsing with a proper base64url decoder that restores padding, and preferably verify the token cryptographically or treat middleware as a UX gate only and re-check auth server-side. This prevents false logouts and forged-cookie route access.
3. `web/src/app/login/page.tsx:22` — validate `redirect` before navigation: only allow same-origin absolute paths starting with `/`, and fall back to `/dashboard` otherwise. This closes the open redirect.
4. `web/src/app/dashboard/page.tsx:38` — branch on `err instanceof ApiError && err.status === 401` instead of regexing `err.message`. This makes auth-expiry behavior deterministic.
5. `web/src/app/dashboard/page.tsx:27` — if `getUser()` is missing but a token exists, call `api.me()` to recover the session instead of forcing `/login`. This avoids false sign-outs from stale/corrupt local storage.
6. `web/src/lib/auth.ts:35` — add `Secure` to the cookie in HTTPS environments. This reduces token exposure on non-TLS requests.
7. `web/src/app/dashboard/page.tsx:236` — use `next/link` for internal setup tiles and add `focus-visible` styles. This improves both routing performance and keyboard accessibility.
8. `web/src/components/layout/app-shell.tsx:46` — add explicit `focus-visible` styling to the header links for consistency with `JobRow`.

## 10. Overall verdict
**Needs rework.**

Top 3 priority fixes:
1. Fix the login route build/runtime issue around `useSearchParams()` and `Suspense`.
2. Harden middleware token handling: padding-safe decode at minimum, real verification if this guard is meant to enforce auth.
3. Validate the post-login `redirect` target to eliminate the open redirect.