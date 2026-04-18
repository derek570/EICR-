# Phase 7a Review — PWA Foundation

**Commit reviewed:** `eb72acc` (feat(web): Phase 7a PWA foundation)
**Branch:** `web-rebuild`
**Scope:** Manifest, Serwist SW, icons, `/offline` page, root `error.tsx`, `InstallButton` + provider + store, middleware `Cache-Control` guardrail, tsconfig split for worker types.

Note: the working tree already contains 7b extensions (`SwUpdateProvider`, `iosInstallHint`, `skipWaiting: true` removed from `sw.ts`). This review critiques Phase **7a at eb72acc** (read via `git show eb72acc:...`) unless explicitly flagged.

---

## 1. Summary

Phase 7a is a competent, well-scoped "foundation" commit. The PWA install/manifest/icon story is complete and cleanly separated from the runtime caching rules. The SW rules are conservative in exactly the right places: `NetworkOnly` for `/_next/app/*`, RSC flight, `Next-Action`, and cross-origin; auth-gated HTML deliberately falls through to the default handler; build-ID-scoped cache names with an explicit `activate` purge. The root error boundary correctly targets the "Failed to find Server Action" digest, auto-reloads once with a 30s loop guard, and falls back to a brand-consistent card. The middleware `Cache-Control: no-cache, no-store, must-revalidate` on HTML satisfies the CLAUDE.md rule directly.

The main weaknesses are (a) **the first-deploy `skipWaiting: true` contract is dangerous if 7b doesn't land in order** — and the commit does ship as-is to prod; (b) the RSC matcher is header-based, which means iOS Safari quirks around `Link` prefetch with `credentials: 'include'` could miss the `RSC: 1` header on some paths; (c) a few minor type/eslint smells around the SW process shim and the `disable: dev` SW behaviour impact developer experience more than runtime. Nothing is P0; one P1 and a handful of P2s.

---

## 2. Alignment with Handoff Plan

Checked against `PHASE_7A_HANDOFF.md`:

| Plan item | State at eb72acc | Match |
|---|---|---|
| `manifest.ts` typed, `start_url=/dashboard`, `scope=/`, `display=standalone`, `id=/`, theme/bg `#0a0a0a` | Implemented, `manifest.ts:29-70` | Yes |
| 5-rule Serwist SW in priority order | Implemented in `sw.ts:70-171`, priority order matches | Yes |
| Auth-gated pages fall through to NetworkOnly default | Confirmed — `PUBLIC_NAVIGATION_PATHS` regex only matches `/`, `/login`, `/legal*`, `/offline` (`sw.ts:51`) | Yes |
| `skipWaiting: true`, `clientsClaim: true`, `navigationPreload: true` | Yes — `sw.ts:76-78` at 7a (has since been removed in 7b) | Yes |
| Activate handler purges stale build-keyed caches, preserves `serwist-*` | Yes — `sw.ts:205-223` | Yes |
| Branded `/offline` page (orbs + glass + reload) | Yes — `offline/page.tsx` | Yes |
| Root `error.tsx` auto-reloads on `NEXT_SERVER_ACTION`, 30s guard, brand fallback | Yes — `error.tsx:38-62` | Yes |
| `install-store.ts` zustand slice with local `BeforeInstallPromptEvent` | Yes — `install-store.ts:13-39` | Yes |
| `InstallPromptProvider` mounted at root layout (not AppShell) | Yes — `layout.tsx:57-60` at 7a | Yes |
| `InstallButton` in AppShell header cluster, awaits `userChoice` | Yes — `install-button.tsx:16-43` | Yes |
| Full icon set (192/384/512 any, 512 maskable, 180 apple opaque, 32 favicon + SVG) | Yes — all 7 files committed under `public/` | Yes |
| `middleware.ts` adds `Cache-Control: no-cache, no-store, must-revalidate` on HTML | Yes — `middleware.ts:66-72` | Yes |
| Dedicated `tsconfig.sw.json` (webworker lib) | Yes — `tsconfig.sw.json` + `tsconfig.json` exclude | Yes |
| `next build --webpack` (Serwist + Turbopack mismatch) | Yes — `package.json:scripts.build` | Yes |
| Deliberate exclusions: no IDB read-through, no outbox, no offline job-edit, no update toast, no iOS ATHS, no Sentry | Confirmed absent at 7a | Yes |

Alignment is clean. No hallucinated features. No out-of-scope sprawl.

---

## 3. Correctness

### P0 — must fix before merge

None. The commit is internally consistent and the claimed verification (typecheck + lint + build) is plausible given the code.

### P1 — should fix before the next deploy

**P1-1. `skipWaiting: true` is a time-bomb if 7b slips.**
(`web/src/app/sw.ts:76` at eb72acc)

The commit body, the handoff doc, and the SW comment all correctly identify this: the **first** production deploy is safe (no prior SW exists), but the **second** deploy will hot-swap the SW under every active inspector mid-edit — which is exactly the failure mode Phase 7a set out to eliminate. The handoff says Phase 7b MUST land the `SKIP_WAITING` postMessage + toast "before any other 7b work lands", and the working tree confirms that was done (`SwUpdateProvider` is present, `skipWaiting: true` has been removed). However:

- If 7a had shipped to production by itself and 7b slipped for even a day, an inspector could lose an in-progress edit. That's a known, unforced risk.
- Mitigation that would have made 7a safe in isolation: keep `skipWaiting: false` from day one and do a single manual "refresh to update" banner mount that simply calls `window.location.reload()` after `controllerchange` — no backend work required. The pattern is ~20 lines in `install-prompt-provider.tsx`.

Not a defect in the code as written — but a planning risk that should be called out in any retrospective of how 7a/7b sequence.

**P1-2. Middleware `Cache-Control` only runs on matched paths; `/login`, `/legal`, `/offline` get no-store via early `NextResponse.next()` without the header.**
(`web/src/middleware.ts:37-44` at eb72acc)

Public paths (`/login`, `/legal`, `/offline`), `/_next/*`, `/api/*`, and any path with a `.` return `NextResponse.next()` **without** setting `Cache-Control`. For `/_next/*` and static files that's correct — Next's own cache headers take over. But for **`/login`** and **`/legal*`** that's a bug: they *are* HTML responses whose server-action hashes change on every deploy, and they are exactly the pages most likely to be cold-loaded by an unauthenticated (or logged-out) user. A CDN/browser that caches the `/login` HTML for even a few seconds after a deploy can still trigger the stale-action error on sign-in.

The CLAUDE.md rule reads: "Next.js App Router apps with server actions must set `Cache-Control: no-cache` on page responses." `/login` is a page with server actions (`loginAction`). It should get the header too.

Fix: move the `Cache-Control` set above the public-prefix early-return, or fall through to the end-of-function `res.headers.set(...)` with an `if (pathname.includes('.')) return early;` check only.

### P2 — nice to fix

**P2-1. RSC detection relies on `RSC: 1` header; consider `Accept: text/x-component` too.**
(`web/src/app/sw.ts:53-61`)

Next's RSC flight fetches set both `RSC: 1` **and** `Accept: text/x-component` in practice, and the header set has changed across Next 13→14→15→16. Adding a second probe (`request.headers.get('Accept')?.includes('text/x-component')`) makes the matcher resilient to future Next header renames.

**P2-2. `?_rsc=` search-param probe is not always set.**
`_rsc=` is added by `Link` prefetch for cache-busting in some configurations; direct programmatic `router.prefetch()` calls do not always append it. Combined with P2-1, the header check is the load-bearing signal, so it matters that the header match be exhaustive.

**P2-3. `NEVER_CACHE_PATHS = /^\/_next\/app\//` — the live tree in Next 16 does not use `/_next/app/*` for server-action POSTs; server actions POST to the same page URL with `Next-Action` header.**

The `Next-Action` header check at `sw.ts:63-68` is the real guard (and it's correctly in place). The `/_next/app/*` regex is largely dead weight — it matches the old Next 13/14 endpoint path that Next 16 no longer uses for actions. Keeping it costs nothing and protects against regressions, but the comment/claim "the #1 cause of mid-session 'Failed to find Server Action' after a deploy" is specifically because stale **RSC flight** payloads route to handler hashes that no longer exist — the `/_next/app/*` regex doesn't fix that. The `isRscRequest` check does, and the `NEVER_CACHE_PATHS` regex can be deleted without behaviour change.

**P2-4. `process.env.NEXT_PUBLIC_BUILD_ID` fallback to `local-${Date.now()}` at module load.**
(`sw.ts:37`)

At import time, `Date.now()` is evaluated once per SW install. Two concurrent installs on the same machine in the same session (unlikely, but possible with multiple tabs auto-registering) will still stay in sync because Serwist only ever has one waiting SW per scope. The bigger issue is that the handoff says "CI threads `NEXT_PUBLIC_BUILD_ID`" but I can find no evidence in the repo of any workflow setting that env var. If CI doesn't set it, every production build falls back to `local-${Date.now()}`, which **is** unique per build (good) but uses the misleading `local-` prefix in prod (minor confusion during CloudWatch grep). Worth verifying CI or renaming the fallback to `build-${Date.now()}`.

**P2-5. SW `fetch` matcher for fonts does not check `url.origin`.**
(`sw.ts:121-133`)

`FONT_EXTENSIONS.test(url.pathname)` fires for any cross-origin font URL (Google Fonts, etc.). The NetworkOnly cross-origin guard at rule 1 does fire first, so cross-origin fonts fall into NetworkOnly correctly — but only because matcher order matters and rule 1's OR chain short-circuits before rule 3 is tested. If someone reorders the rules for readability, cross-origin fonts would start being CacheFirst'd. Add `url.origin === self.location.origin` to the font matcher to make it robust to reordering.

**P2-6. `maximumScale: 1` + `userScalable: false` is an accessibility concern.**
(`layout.tsx:viewport:40-41`)

WCAG 2.1 SC 1.4.4 (Resize Text) requires content to be resizable to 200% without assistive tech. Disabling zoom is a common PWA pattern but it's an A11y red flag, especially for inspectors who may have vision needs. The rest of the app uses `var(--text-*)` tokens that scale with browser font-size, so blocking pinch-zoom has real cost. Not a 7a regression (pre-existing), but flagging because Phase 7a is the first time the viewport was touched and it's still wrong.

**P2-7. Error-boundary reload key `cm_sa_reload_ts` uses `sessionStorage`.**
(`error.tsx:54-61`)

`sessionStorage` is per-tab. If a user opens the same broken page in a new tab, the second tab won't see the first tab's 30s guard and will independently reload. For a "Failed to find Server Action" storm after a deploy, this means each tab gets its own 30s budget — which is **actually the right behaviour** for the common case (deploy shipped, tab A reloads once and is fine, tab B arrives later, reloads once, also fine). But if the failure is server-side (not a stale-action deploy skew), every tab reloads every 30s forever. `localStorage` would be cross-tab but would also block legitimate second-tab recovery. Current choice is correct; documenting the trade-off.

**P2-8. `deferredPrompt.userChoice` is awaited in `install-button.tsx:29` even when `outcome === 'dismissed'`.**

If the user dismisses, the button vanishes (`setDeferred(null)` in `finally`). Chrome will not fire `beforeinstallprompt` again this session, so the button is permanently hidden until next visit. That's an intentional choice documented in the comment, but there's no UX recovery — a user who misclicks has no way to re-trigger the prompt from the UI. Not a bug; worth noting for 7b's iOS ATHS hint as a pattern for "install help" that works for everyone.

**P2-9. `reloadOnOnline: true` in `next.config.ts` is noisy before the Phase 7c outbox.**

On mobile connectivity flapping (elevator, underground, thick-walled consumer-unit cupboards), the page will reload every time `online` fires even if the user is mid-edit on an authenticated page. There's no outbox yet, so a reload will discard in-memory edits. Either (a) drop `reloadOnOnline` until 7c, (b) scope it client-side to only reload when on `/offline`, or (c) accept the behaviour with a documented warning. The current choice prioritises freshness over edit preservation — debatable for a field-work app.

**P2-10. `disable: process.env.NODE_ENV === 'development'` removes the SW in dev, but `sw.ts` is still type-checked.**
(`next.config.ts:26`)

Fine — and the tsconfig split handles type isolation. However, the SW is never exercised in `npm run dev`, which means the SW cache rules are only validated manually against `npm run build && npm start`. A one-line Playwright smoke (visit `/`, fetch `/sw.js`, assert 200 + `service-worker` script) would close that gap — flagged as future test coverage, not a 7a bug.

**P2-11. `install-store.ts` has no hydration guard.**

Zustand `create(...)` runs on both server and client. On the first render, `deferredPrompt: null` is the SSR result; the client then hydrates with the same initial value. No mismatch in practice because the SSR HTML never reads `deferredPrompt`. OK as-is, but worth noting if the store's initial state ever becomes non-trivial.

---

## 4. Security

**S-1. `decodeJwt` in `middleware.ts` does not verify the signature.**

This is pre-existing, not a 7a change, but Phase 7a doubled down on the role check at `middleware.ts:58-60` (`payload.role !== 'admin'`). A client who forges a JWT with `role=admin` will pass the middleware check. The comment says "The `role` claim is signed into the JWT by the backend", implying the token was signed — but the middleware never verifies the signature. Depending on where auth is terminated, this may or may not matter. If the backend validates every API call with the signed token, the middleware redirect is only a UX nicety and a forged token just lets the user **see** admin chrome, not access admin data. But if any server action or RSC fetch trusts the middleware's `role` decision without re-verifying, this is an escalation vector. Audit recommended.

**S-2. Auth-gated HTML correctly bypasses navigation cache.**

`PUBLIC_NAVIGATION_PATHS = /^\/(?:$|login|legal|offline)/` (`sw.ts:51`) excludes `/dashboard`, `/job/*`, `/settings/*`. Default Serwist behaviour with no matching rule is a passthrough `fetch(event.request)` — no cache write. The mistake rule from CLAUDE.md is satisfied. Good.

**S-3. `/offline` precached unauthenticated, which is correct.**

The offline page has no data fetches, no API imports, no auth calls (`offline/page.tsx:1-93`). Precaching a user-agnostic static shell is correct and safe.

**S-4. `Cache-Control: no-store` on authenticated HTML.**

Correctly set in middleware for the authenticated path. Combined with the SW's NetworkOnly default for auth-gated routes, two independent layers stop auth HTML from landing in any cache.

**S-5. `install-prompt-provider.tsx` window listeners have no teardown race.**

`useEffect` cleanup removes both listeners; `setDeferred` and `markInstalled` are stable zustand selectors. No leak.

**S-6. `sw.ts` `self.skipWaiting()` (in working tree, not 7a) is gated on `event.data?.type === 'SKIP_WAITING'`.**

7b work; out of scope but noted: the message handler has no origin check. Service worker `message` events can only come from same-origin clients by the browser's own guarantee, so an untrusted origin can't fire this — but if the client ever adds `BroadcastChannel` or `postMessage` relays this should be re-audited.

---

## 5. Performance

**Perf-1. Precache list deliberately minimal.**
Good — `self.__SW_MANIFEST` holds the Serwist-computed list plus the `/offline` fallback entry. Cold-cache install on mobile data is ~small-KB, which is the right trade for a field-work PWA.

**Perf-2. Cache-Control no-store on every authenticated HTML response defeats browser HTTP cache.**
Necessary for the "no stale action" guarantee, but worth measuring: every back-button navigation now re-fetches the HTML from origin. Next's server-side render is fast, but on a flaky 3G connection inside a consumer-unit cupboard this can feel slow. The SW's `navigationPreload: true` helps: the preload request races the SW boot. Good choice.

**Perf-3. `static-<BUILD_ID>` cache keeps up to 200 entries for 30 days.**
Reasonable. A full Next 16 build typically emits <200 chunks. If the app grows past that, older chunks drop first (which is correct — hash-named chunks can never be re-requested by a post-deploy client anyway).

**Perf-4. No route-level HTTP headers differentiation.**
`/` and `/login` are static and could carry `Cache-Control: public, max-age=0, must-revalidate` + ETag rather than `no-store`, which would let the CDN serve a 304. Low priority for Phase 7a; pure optimisation.

**Perf-5. Icon CacheFirst with 1-year TTL is correct.**
Icons are versioned through filename changes when regenerated (`pwa:icons` script overwrites `public/icons/*.png`). If an icon is ever updated without a filename change, the 1-year cache will serve the old bytes. Fine for a rarely-changing brand asset, brittle if the brand refreshes. Consider appending a content hash to icon filenames when 7b/7c touches the icon set.

---

## 6. Accessibility

**A11y-1. `maximumScale: 1, userScalable: false` violates WCAG 1.4.4.** See P2-6 above.

**A11y-2. `<Button aria-label="Install CertMate app">Install app</Button>` has redundant labelling.**
(`install-button.tsx:39`)

The visible text "Install app" and `aria-label="Install CertMate app"` differ. Screen readers will announce the `aria-label`, hiding the visible text. If "Install CertMate app" is the intended SR announcement that's fine; if not, remove the aria-label and let the text content label the button naturally. Not a breaking issue, just imprecise.

**A11y-3. Error-boundary "Try again" button is the only focusable element.**
(`error.tsx:109-111`)

Good — keyboard users get focus on the single action. The orbs are `aria-hidden`, the heading is not a landmark (it's inside `<main>` which is correct).

**A11y-4. Offline page matches error-boundary pattern.**
Good parity.

**A11y-5. `<InstallButton>` returning null with no announcement is correct — the button's absence is not a state users need to be told about.**

**A11y-6. Toast positioning (`bottom-right`) could overlap the `RecordingOverlay` mini-pill on small screens.**
(`layout.tsx:82`)

Not a 7a feature but 7a is the commit that introduced the toaster. Worth smoke-testing with recording active + a 7b update toast simultaneously.

**A11y-7. No `prefers-reduced-motion` guard on `cm-orb` ambient animation.**

The orb animation runs by default on `/offline` and the root error page. Users with `prefers-reduced-motion: reduce` get the animation anyway. Check the `cm-orb` CSS rule for a `@media (prefers-reduced-motion: reduce)` override; if absent, this is an A11y issue.

---

## 7. Code Quality

**Q-1. `sw.ts` comments are excellent.** The priority-order table at the constructor is exactly the right level of detail. The `NEVER_CACHE_PATHS` / `isRscRequest` / `isServerActionRequest` helpers are named clearly.

**Q-2. `install-store.ts` uses selector pattern well.** `canInstall` as a derived boolean set alongside `deferredPrompt` keeps two states always in sync — though it's redundant (you could derive it via `state.deferredPrompt !== null` in the selector). Not worth changing.

**Q-3. `manifest.ts` returns a fresh object each call.** Next caches the manifest response, so the repeated allocation is harmless. Fine.

**Q-4. `error.tsx` hardcodes 30_000 ms.** Extract to a named `const RELOAD_GUARD_MS = 30_000` for readability; tiny.

**Q-5. `generate-pwa-icons.mjs` destination routing logic is subtle.**
(`scripts/generate-pwa-icons.mjs:47`)

`out.startsWith('favicon') || out.startsWith('apple') ? FAV_OUT : OUT` works but is fragile to filename changes. Consider an explicit `dest` field per target. Low priority.

**Q-6. `install-button.tsx:33` silently swallows errors with `catch {}`.**

Comment explains why, but a `console.debug('[cm:install] prompt failed', err)` would aid debugging without user-visible noise.

**Q-7. `install-prompt-provider.tsx` doesn't check `isInstalled` before subscribing.**

If the app is already installed (standalone display mode), `beforeinstallprompt` won't fire, so the listener is harmless. No defect; consider adding `isInstalled` check as documentation of intent.

**Q-8. Middleware matcher excludes `favicon.ico` but not the new `favicon.svg` / `favicon-32.png`.**
(`middleware.ts:76`)

These paths include `.` so they short-circuit at line 42 before the matcher even runs. OK.

**Q-9. `sw.ts` has no `clients.claim()` call alongside the `activate` handler.**

`clientsClaim: true` in the Serwist config handles this. Verified.

**Q-10. `tsconfig.sw.json` extends `./tsconfig.json` but then overrides `lib` entirely.** Since `types: []` is also set, the inherited `strict`, `noEmit`, etc., flow through. Clean.

**Q-11. No lint rule prevents `sw.ts` from importing DOM-only modules.**
If a future refactor imports `@/lib/...` from `sw.ts`, the webworker lib will silently break. Consider an eslint-disable-next-line import-only rule or a comment banner. Low priority.

---

## 8. Test Coverage

**T-1. No test file committed in 7a.** Handoff doc shows a manual DevTools walkthrough as the verification strategy. For a foundation phase this is defensible, but:

- A Playwright test that `npm run build && npm start`s the app, fetches `/sw.js`, asserts status 200 + correct Content-Type, and asserts no cache entries created for `/dashboard` after visiting it would be ~40 lines and catches regressions in the one thing Phase 7a must not break (auth-cache leak).
- A unit test (vitest) over the `isRscRequest` / `isServerActionRequest` / matcher regexes would exercise the rules in isolation — the SW runtime is hard to mock but the helpers are pure.

**T-2. `error.tsx` reload logic has clear test shape.**

A Playwright test that throws `Error('Failed to find Server Action: test')` from a server component and asserts one reload within 30s + no reload thereafter would pin the behaviour documented in the handoff doc. Currently verified only manually in dev.

**T-3. `InstallButton` has no test.**

The button's three states (no event, event present, post-click) all have clear boundaries. A React Testing Library test with a mocked store would take minutes to write.

**T-4. Existing test suites not regressed.**

I can't verify the lint/typecheck/build claims without running them, but the code as written has no obvious type errors; the SW tsconfig split is the right pattern.

---

## 9. Suggested Fixes (numbered, file:line)

1. **`web/src/middleware.ts:37-44`** — Remove `/login` and `/legal` from the `NextResponse.next()` early-return, or set `Cache-Control: no-cache, no-store, must-revalidate` before returning from that branch. Current code leaves those pages with no cache-busting header, which violates the CLAUDE.md rule for server-action-hosting pages.

2. **`web/src/app/sw.ts:53-61`** — Add `Accept: text/x-component` as a secondary RSC probe:
   ```
   return request.headers.get('RSC') === '1'
     || request.headers.get('Accept')?.includes('text/x-component')
     || url.searchParams.has('_rsc');
   ```
   Future-proofs against Next header renames.

3. **`web/src/app/sw.ts:121-133`** — Add same-origin guard to the font matcher so rule-order changes can't turn cross-origin fonts into CacheFirst.

4. **`web/src/app/sw.ts:43`** — Delete or annotate `NEVER_CACHE_PATHS` — the `/_next/app/*` path is not used by Next 16 server actions; the `Next-Action` header check is the load-bearing one.

5. **`web/src/app/layout.tsx:40-41`** — Reconsider `maximumScale: 1` + `userScalable: false` for WCAG 1.4.4 compliance. If retained, document the trade-off and ensure `var(--text-*)` tokens fully respect browser font-size.

6. **`web/src/components/pwa/install-button.tsx:39`** — Either drop the `aria-label` (let button text label itself) or align the text and aria-label. Don't have two labels saying different things.

7. **`web/src/app/sw.ts:37`** — Verify `NEXT_PUBLIC_BUILD_ID` is actually threaded through CI (ECS build action). If not, rename the fallback from `local-` to something less misleading in production logs.

8. **`web/next.config.ts:25`** — Reconsider `reloadOnOnline: true` for an authenticated field-work app. Either scope to `/offline` only, or defer until Phase 7c's outbox prevents data loss on forced reload.

9. **`web/src/components/pwa/install-button.tsx:30-32`** — Replace `catch {}` with `catch (err) { console.debug('[cm:install] prompt failed', err); }` for debuggability.

10. **`web/src/app/error.tsx:54`** — Extract `30_000` to `const RELOAD_GUARD_MS = 30_000` at module scope, or a named constant inside the component, for readability.

11. **`web/src/middleware.ts:18-26`** — Audit JWT signature verification. Pre-existing, but Phase 7a leans on middleware for role-gated redirect. Confirm the backend re-validates signed JWT on every server-action / RSC fetch.

12. **`web/public/icons/*.png` + `scripts/generate-pwa-icons.mjs`** — Add a filename hash or version suffix to PWA icons so a future brand refresh bypasses the 1-year CacheFirst TTL.

13. **(Tests)** — Add a Playwright smoke that asserts `/dashboard`, `/job/*`, `/settings/*` never produce cache entries; assert `/sw.js` returns 200; assert `/offline` renders offline. ~50 lines, catches the most dangerous 7a regressions.

---

## 10. Verdict + Top 3 Priorities

**Verdict: Approve, with follow-up work required.** Phase 7a is solid, focused, and cleanly separated from 7b/7c. The SW design is conservative in the right ways. The implementation matches the handoff doc with no scope creep. Auth-cache leakage is prevented by two independent mechanisms (middleware header + SW NetworkOnly default). The "Failed to find Server Action" recovery is well-designed with a sensible loop guard.

The P1 middleware gap is real but narrow; the `skipWaiting: true` risk is managed by 7b having landed in the working tree.

### Top 3 priorities

1. **Fix #1 (middleware Cache-Control on `/login` and `/legal`)** — small, high-value, closes a gap in the CLAUDE.md rule for server-action-hosting pages.

2. **Fix #2 (broaden RSC detection to include `Accept: text/x-component`)** — cheap insurance against Next framework evolution; the whole Phase 7a value prop rests on not caching RSC flights.

3. **Fix #13 (add a Playwright smoke for the auth-cache leak)** — the single regression 7a must not ever ship. Manual DevTools walkthrough is not enough to catch a future refactor that accidentally removes the `PUBLIC_NAVIGATION_PATHS` scoping.
