# Wave 4 D4 Handoff — RBAC depth-of-defence

**Branch:** `wave-4-d4-rbac` (off `web-rebuild`)
**Commits (oldest → newest):**
- `4de2fcb` — `feat(auth): Wave 4 D4 — sign role + company_role into JWT`
- `ee07fda` — `fix(web): Wave 4 D4 — HMAC-verify JWT signature in middleware`
- `560f4c0` — `feat(web): Wave 4 D4 — typed getUserRole / getCompanyRole helpers`

**Scope:** `FIX_PLAN.md §D D4` items 1, 2, and 4 (signed RBAC claims, middleware admin matcher, HMAC signature verify). Item 3 (HttpOnly cookie migration) deferred to Phase 9 per `WEB_REBUILD_COMPLETION.md` §3 Q3 recommended default.
**Status:** 84/84 vitest (up from 73; +6 middleware, +5 auth getters) · 35/35 backend auth jest (up from 32; +3 mint/refresh claim set) · `tsc --noEmit` clean · `npm run lint` 0 errors / 6 pre-existing warnings / 0 new.

---

## What was done

### Commit A — backend JWT mint

`src/auth.js`:
- `authenticate()` (fresh login) and `refreshToken()` (rotation) now sign `role`, `company_id`, and `company_role` into the JWT alongside the existing `userId`, `email`, `tv`, `jti` claims.
- Defaults: `role → 'user'`, `company_role → 'employee'`, `company_id → null`. Legacy user rows without the company-tables columns still mint minimum-privilege tokens.
- `refreshToken` reads the up-to-date values from the DB row, so a mid-session promotion (`role: 'user' → 'admin'`) takes effect on next rotation without forcing logout.

`src/__tests__/auth.test.js`:
- `JWT carries signed role + company_role + company_id claims` — admin login round-trips all three claims inside the HMAC-verified payload.
- `JWT defaults role=user + company_role=employee when DB row omits them` — legacy-user regression guard.
- `refreshed JWT re-reads role/company_role from DB (promotion path)` — rotation picks up DB changes.

### Commit B — middleware signature verify + admin matcher

`web/src/middleware.ts`:
- `middleware()` is now async.
- `verifyAndDecodeJwt(token, secret)` runs HMAC-SHA256 verification via Web Crypto (`crypto.subtle.importKey('HMAC')` + `verify`). Only `alg: HS256` accepted — `alg: none` and missing `alg` fall through to null.
- `unsafeDecodeJwt(token)` retained as a **claim-only fallback** when `process.env.JWT_SECRET` is not exposed to the middleware runtime. Logs a single warning on first use; production always has the secret set via the ECS task def.
- Admin-surface matchers are unchanged in shape (the Wave 1 P0-4 static-asset allow-list + `/settings/admin/**` + `/settings/company/**` gates stay), but now they run against a verified payload rather than a base64-decoded one.
- PWA guardrail `Cache-Control: no-cache, no-store, must-revalidate` on the pass-through response remains.

`web/tests/middleware.test.ts` — rewritten to sign its test tokens (via `node:crypto.createHmac`) with `process.env.JWT_SECRET = TEST_SECRET` set per describe block:
- **Wave 4 D4** new: forged-sig admin JWT → redirect to `/login`.
- **Wave 4 D4** new: forged-sig company-admin JWT → redirect to `/login`.
- **Wave 4 D4** new: `alg: none` admin JWT → redirect to `/login`.
- **Wave 4 D4** new: correctly-signed admin JWT → 200.
- **Wave 1 P0-4** regression guard for dotted admin path (`/settings/admin/users/user.name` with no token → redirect to `/login`).
- **Wave 4 D4** escalation guard: `company_role: 'admin'` must NOT unlock `/settings/admin/**` — redirected to `/settings`.
- All Wave 1 P0-5 company-admin gate tests kept; their fixtures now use `makeSignedJwt` so they exercise the verify path.

### Commit C — client-side role getters

`web/src/lib/auth.ts`:
- `SystemRole` (`'admin' | 'user'`) and `CompanyRole` (`'owner' | 'admin' | 'employee'`) type aliases exported.
- `getUserRole(user?)` — optional explicit arg, falls back to cached `cm_user` localStorage blob. Returns one of the enum values or `null`; unknown strings are mapped to `null`.
- `getCompanyRole(user?)` — same contract for the company-level role.
- Docstring is explicit: these are **UX only**; write authorisation goes through the middleware + server. The getters exist so components can render/hide admin nav chrome without flashing the surface before a server 403.

`web/tests/auth-role-getters.test.ts` — 5 cases: explicit-arg, localStorage-fallback, signed-out null, unknown-enum null, missing-role null.

---

## Verification

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  10 passed (10)
      Tests  84 passed (84)

$ ../node_modules/.bin/tsc --noEmit
# clean

$ npm run lint
# 0 errors, 6 pre-existing warnings, 0 new

$ cd /repo-root && node --experimental-vm-modules node_modules/jest/bin/jest.js src/__tests__/auth.test.js
 Tests: 35 passed, 35 total
```

Pre-existing lint warnings (unchanged from Wave 3): 5 `react-hooks/exhaustive-deps` on `job/[id]/{design,extent,inspection,installation,supply}/page.tsx` + 1 unused `_certificateType` in `job-tab-nav.tsx`. Queued for Wave 5 lint-zero sweep.

---

## Why this approach

### Sign the claims at the backend, verify the HMAC at the middleware

The JWT is the only thing the middleware can trust at request boundary time — the client can edit every `localStorage` key the app writes. Signing `role` + `company_role` into the JWT in Commit A and verifying the HMAC in Commit B is the smallest two-sided change that makes the admin-surface gate actually mean something. Before this wave:

- The middleware's `decodeJwt` did a bare `atob` + `JSON.parse`.
- `role` + `company_role` weren't in the JWT payload at all (not signed anywhere).
- Admin gating fell back to whatever `atob` decoded — effectively the unsigned claim set, or `undefined` for the missing fields. A hand-crafted token with `role: 'admin'` would pass the `/settings/admin` gate.

After this wave, a forged token fails `crypto.subtle.verify` and the middleware redirects to `/login` before the admin-surface matcher ever runs.

### Web Crypto over adding `jose`

The middleware runs in the Edge runtime where `crypto.subtle` is built in. A hand-rolled HMAC-SHA256 verifier is 30 lines of dependency-free code. Adding `jose` would pull in RSA/EdDSA, JWKS discovery, JWE — surface we don't use and would have to audit. If we ever move to RS256, this function is the one place to swap.

### `JWT_SECRET` missing → fail-open to claim-only, not crash

Production always has the secret (ECS task def). Local dev without a `.env` or a Playwright `webServer` block that doesn't export `JWT_SECRET` would brick on strict-verify. FIX_PLAN §D D4 item 4 explicitly calls out "keep it off the critical path if secret unavailable — fail open to NextAuth-style redirect". The fallback logs once on first use so it can't mask a production misconfiguration silently (the log would flood the stack logs).

### Client-side getters are UX only, documented explicitly

The docstring on `getUserRole` / `getCompanyRole` says it in prose: "**Client-side UX only.** These values MUST NOT be used for write authorisation." Paired with the middleware signature-verify, this draws a clean line: the server (and the HMAC on the JWT) decides who can do things; the client decides only what chrome to show. Phase 9's HttpOnly cookie migration can swap the storage underneath these getters without touching any caller.

### Keep validation at the boundary

`getUserRole` / `getCompanyRole` return `null` for unknown enum values rather than the raw string. A typo or a rogue backend field can't leak through to `role === 'admin'` comparisons downstream.

---

## Cross-stack coordination concerns

### Existing iOS clients with old JWTs

The JWT claim set is additive only. Existing iOS builds only read `token` and `user` from the login response — the extra claims travel inside the token opaquely and don't change the `safeUser` shape. `verifyToken` / `requireAuth` / `requireAdmin` all continue to read `role` from the DB-rehydrated user (via `getUserById` in `verifyToken`), so a session resumed with an old JWT (no `role` claim) still works: `req.user.role` comes from the DB, not the JWT. The only consumers that read `role` directly off the JWT are:
- The Wave 4 D4 Next.js middleware — present only on fresh logins post-this-commit (because pre-commit tokens predate the signing).
- Any future stateless JWT consumer.

An old web session cookie minted pre-D4 → the middleware's `unsafeDecodeJwt` (if no `JWT_SECRET` set) or `verifyAndDecodeJwt` (if secret is set but token is HS256 with correct signature) will find `role === undefined` → fall through the admin gates (system-admin prefix → redirect to `/settings`; company-admin prefix → redirect to `/settings`; regular path → pass). Users will see reduced-chrome behaviour until next refresh, which mints the full claim set. No lockout, no crash.

### Playwright webServer

The Playwright `webServer` config does NOT export `JWT_SECRET`, so `next dev` runs the middleware in claim-only fallback mode. The existing `tests-e2e/fixtures/auth.ts` mints an unsigned JWT (placeholder "sig" segment); with no secret, `unsafeDecodeJwt` accepts it. **No Playwright spec needs to change.** If a future spec wants to exercise the HMAC-verify path, add `env: { JWT_SECRET: '...' }` to the Playwright `webServer` block and sign the token to match.

### iOS behaviour unchanged

iOS uses only the backend `requireAuth` path (via `Authorization: Bearer`). `verifyToken` pulls the full user from the DB; it doesn't depend on the JWT carrying `role` at all. iOS refresh tokens rotate the claim set on next `/api/auth/refresh`. No breaking change.

---

## Recommended next wave

Per `WEB_REBUILD_COMPLETION.md` §2.2, the other three Wave 4 sub-items are now unblocked and run in parallel:

- **D5** — Radix Dialog sweep across 6 modal sites + replace `window.confirm`. Independent of D4; tests land in Playwright (focus-trap coverage needs D5 to un-fixme the existing spec).
- **6c** — admin-user edit page with `/api/admin/users/:id` backend endpoint (Q8 answered yes). Independent of D4; now that the middleware reliably gates the surface, the editor page can assume a signed-in admin reaches it.
- **6b tail** — per-company settings key fix + D12 strict parsing on login + admin writes.

No cross-dependency with D4 commits. D4 does NOT touch the modal, editor, or settings-persistence surfaces.

---

## Remaining known gaps

- **HttpOnly cookie migration (FIX_PLAN §D D4 item 3).** Deferred to Phase 9 per Q3 recommended default. Current posture: token in localStorage + mirrored cookie. When Phase 9 lands, `lib/auth.ts` and `use-current-user.ts` are the two files that need to swap the storage layer; every caller of `getUserRole` / `getCompanyRole` stays unchanged.
- **JWT secret rotation.** No mechanism to rotate the HMAC secret without invalidating every live session. Low-urgency; revisit when a secret-rotation runbook is needed (Phase 9+).
- **Telemetry on middleware rejections.** The middleware logs once for "missing secret"; it does NOT log forged-signature rejections. Low-urgency — a forged token is a redirect, not a crash, and the server logs refuse the downstream API calls anyway. Observability sink (see Wave 2b handoff) is the right home if we want a counter.

---

## File inventory

**Modified:**
- `src/auth.js` — `role`, `company_id`, `company_role` signed into JWT at mint and refresh.
- `src/__tests__/auth.test.js` — 3 new tests on claim set at login + refresh.
- `web/src/middleware.ts` — async middleware; HMAC verify via Web Crypto; claim-only fallback when `JWT_SECRET` missing.
- `web/tests/middleware.test.ts` — rewritten for async + signed-token fixtures; 6 new Wave 4 D4 tests.
- `web/src/lib/auth.ts` — `SystemRole` + `CompanyRole` type aliases; `getUserRole` + `getCompanyRole` getters.

**Added:**
- `web/tests/auth-role-getters.test.ts` — 5 unit tests on the new getters.

---

Wave 4 D4 landed (items 1, 2, 4). HttpOnly cookie migration (item 3) deferred to Phase 9. Next: Wave 4 D5 / 6c / 6b tail in parallel.
