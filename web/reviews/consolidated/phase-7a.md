# Phase 7a — Consolidated Review

**Commit:** `eb72acc` — feat(web): Phase 7a PWA foundation
**Branch:** `web-rebuild`
**Reviewers consolidated:** Claude, Codex

---

## 1. Phase summary

Phase 7a lays the PWA foundation: typed `manifest.webmanifest`, full icon set, Serwist-authored service worker with build-ID-scoped caches and 5 priority-ordered rules, branded `/offline` page, root `error.tsx` auto-reload for stale Server Actions, Zustand-backed install-prompt flow, and a `Cache-Control: no-cache, no-store, must-revalidate` middleware guardrail. Implementation tracks the handoff doc faithfully with no scope creep; core SW design is conservative in the right places (auth-gated HTML never cached; RSC flight and `Next-Action` explicitly NetworkOnly). Main weaknesses are a middleware shortcut that is too broad, a `skipWaiting: true` contract that is only safe for the first deploy, and `/offline` + error copy that overclaims behaviour not yet shipped.

---

## 2. Agreed findings

- **[P1] [Correctness/Security] `web/src/middleware.ts:37-44`** — `pathname.includes('.')` is too broad a "static asset" check. Any dotted dynamic route (e.g. a slug containing `.`) bypasses auth/admin gating AND the new `Cache-Control` header. Replace with a narrow static-asset match and let HTML responses fall through to the header setter. (Codex flags the auth/admin bypass as severe; Claude flags the `/login`, `/legal`, `/offline` header-miss — both symptoms of the same root cause.)
- **[P1] [Correctness] `web/src/app/sw.ts:75-79`** — `skipWaiting: true` is safe only on the first deploy; the second deploy will hot-swap the SW under active inspectors mid-edit. Remove and gate activation on a client `SKIP_WAITING` postMessage + user-visible refresh prompt. (Both reviewers note 7b working tree has already moved this direction; the finding stands against 7a at `eb72acc` in isolation.)
- **[P2] [Accessibility] `web/src/app/layout.tsx:35-46`** (viewport) — `maximumScale: 1` + `userScalable: false` disables zoom, violating WCAG 2.1 SC 1.4.4 (Resize Text). Remove both; keep the `theme_color` change.
- **[P2] [Correctness] `web/src/app/offline/page.tsx:31-34`** — Copy promises "changes... will sync automatically when the network returns", but no outbox/sync exists in 7a (shipped in 7c). Replace with truthful "Reconnect to continue" per handoff. (Claude's review incorrectly asserted the shipped copy already matched the handoff; Codex caught the discrepancy. See §3.)
- **[P2] [Performance] `web/next.config.ts:24-26`** — `reloadOnOnline: true` discards in-memory edits on every connectivity flap. For a field-work app in weak-signal environments this is lossy; scope to `/offline` only, or defer until Phase 7c outbox lands.
- **[P3/Q] [Accessibility] `web/src/components/pwa/install-button.tsx:38-41`** — Visible text "Install app" vs `aria-label="Install CertMate app"`. Divergent labelling; drop the `aria-label` or align.

---

## 3. Disagreements + adjudication

### 3.1 Scope/severity of middleware `pathname.includes('.')` bug
- **Claude says:** P1 — `/login`, `/legal`, `/offline` (public prefixes) return `NextResponse.next()` without setting `Cache-Control`; these pages host Server Actions and should carry `no-store`.
- **Codex says:** P1 — `pathname.includes('.')` is the bigger bug: it bypasses auth/admin checks AND the cache header for any dotted dynamic URL.
- **Adjudication:** Codex is more correct. Reading `middleware.ts:37-44`, the `pathname.includes('.')` branch is in the same `if` as `PUBLIC_PREFIXES.some(...)`, so Codex's finding about dotted dynamic paths bypassing auth is real and strictly worse than just missing a cache header. Claude's `/login` point is also valid — public pages with Server Actions should be revalidated — but it is a sub-case of the same early-return. Consolidated fix: replace the heuristic with an explicit static-file matcher (or limit early-return to `/_next` + `/api` + known extensions) and have HTML `/login`/`/legal`/`/offline` flow through to the header setter.

### 3.2 `/offline` page copy
- **Claude says:** matches handoff ("Reconnect to continue") — no issue flagged.
- **Codex says:** P2 — shipped copy at `offline/page.tsx:31-34` includes "will sync automatically when the network returns", which contradicts the handoff's "truthful copy" promise.
- **Adjudication:** Codex is correct. Verified against `web/src/app/offline/page.tsx:31-34` — the shipped text is "Reconnect to continue. Any changes you made before losing signal are still on this device and will sync automatically when the network returns." Claude's review was wrong on this point (a reviewer error). The "Reconnect to continue" fragment is present but the full sentence overclaims.

### 3.3 "We've logged this" copy in error boundary
- **Claude says:** not flagged.
- **Codex says:** P2 — `error.tsx:96-99` says "We've logged this" but 7a only writes to `console.error`; no aggregator.
- **Adjudication:** Codex is correct. Verified `error.tsx:97` — text is "We've logged this and will take a look." No Sentry/server sink exists in 7a (handoff explicitly defers). Keep as P2.

### 3.4 `NEVER_CACHE_PATHS` regex value
- **Claude says:** P2 — `/^\/_next\/app\//` is dead weight in Next 16; can be deleted.
- **Codex says:** not mentioned.
- **Adjudication:** Claude is correct that the `Next-Action` header check is the load-bearing guard. However, leaving the regex costs nothing and guards against future regressions; "can be deleted" is a nit, not a defect. Retain as P2 for code quality only.

---

## 4. Claude-unique findings

- **[P2] [Correctness] `web/src/app/sw.ts:53-61`** — RSC detection uses only `RSC: 1` header + `?_rsc=` query param. Add `Accept: text/x-component` as a secondary probe to future-proof against Next header renames.
- **[P2] [Correctness] `web/src/app/sw.ts:121-133`** — Font matcher does not check `url.origin === self.location.origin`. Order of rules currently saves it; add explicit guard so reordering can't silently CacheFirst cross-origin fonts.
- **[P2] [Ops] `web/src/app/sw.ts:37`** — `NEXT_PUBLIC_BUILD_ID` fallback `local-${Date.now()}` is unique per build but no evidence CI threads the env var through. Verify CI sets it; otherwise rename the prefix for log clarity.
- **[P2] [Code Quality] `web/src/app/sw.ts:43`** — `NEVER_CACHE_PATHS = /^\/_next\/app\//` is dead weight in Next 16; `isServerActionRequest` carries the load.
- **[P2] [Security] `web/src/middleware.ts:18-26`** — Pre-existing: `decodeJwt` does not verify signature. Middleware leans on `payload.role` for admin redirect. If any server action trusts middleware's role decision, this is escalation-capable. Audit recommended.
- **[P2] [Performance] Icon `CacheFirst` with 1-year TTL** (`sw.ts` icons rule) — If icons ever change without a filename hash, the 1-year TTL serves stale bytes. Add content hash to icon filenames on next brand touch.
- **[P3] [Accessibility] `cm-orb` animation** — No `@media (prefers-reduced-motion: reduce)` override verified on `/offline` and error-boundary pages.
- **[P3] [A11y/UX] Toast positioning** — Sonner `bottom-right` could overlap `RecordingOverlay` mini-pill on small screens. Smoke-test with update-toast + active recording.
- **[P3] [Code Quality] `web/src/components/pwa/install-button.tsx:30-32`** — `catch {}` swallows errors silently. Prefer `console.debug('[cm:install] prompt failed', err)`.
- **[P3] [Code Quality] `web/src/app/error.tsx:58`** — Extract `30_000` to `RELOAD_GUARD_MS` named constant.
- **[P3] [Code Quality] `web/scripts/generate-pwa-icons.mjs:47`** — Output-dir routing via `out.startsWith(...)` is fragile; prefer explicit `dest` per target.
- **[P3] [Tests]** — No Playwright smoke asserting (a) `/dashboard`, `/job/*`, `/settings/*` produce no cache entries, (b) `/sw.js` returns 200, (c) `/offline` renders offline. Also no unit tests for `isRscRequest`/`isServerActionRequest` pure helpers, nor for the error-boundary 30s reload guard, nor for install-button state machine.

---

## 5. Codex-unique findings

- **[P2] [Correctness] `web/src/app/error.tsx:96-99`** — "We've logged this" overclaims; 7a has no server-side error sink (see §3.3).
- **[Q] [Code Quality] `web/src/middleware.ts:37-42`** — Middleware now carries auth, admin routing, and cache-header concerns behind a single `pathname.includes('.')` heuristic; the overloaded early-return has become higher-risk tech debt even once the narrow bug is fixed.
- **[Tests]** — Additional gap beyond Claude's list: no test for middleware cache-header behaviour on HTML responses (including dotted dynamic paths).

---

## 6. Dropped/downgraded

- **Claude's reviewer error on `/offline` copy** — Claude asserted the shipped copy matched the handoff's "Reconnect to continue". Verified against `web/src/app/offline/page.tsx:31-34` — shipped copy actually includes "will sync automatically when the network returns". Codex's finding (§3.2) wins.
- **`skipWaiting: true` risk** — Both reviewers note this is superseded by 7b work already in the working tree (`SwUpdateProvider`, `skipWaiting: true` removed). Retained as P1 against `eb72acc` in isolation since the review targets the 7a snapshot; in practice mitigated in main.
- **No IDB read-through cache / offline dashboard 404** — Out of scope for 7a per handoff, delivered in Phase 7b (IDB read-through cache commit series). Not a finding.
- **No outbox / mutation queue** — Out of scope for 7a, delivered in Phase 7c (`e64f756` — offline mutation outbox). Not a finding. Note: this supersedes the "sync automatically" copy concern once 7c ships, though the 7a copy is still an overclaim for the 7a window.
- **No "New version available" toast** — Out of scope for 7a, delivered in Phase 7b first commit per handoff. Not a finding.
- **No iOS Add-to-Home-Screen hint** — Out of scope for 7a, delivered in Phase 7b (`a2fb5db` era). Not a finding.
- **No offline indicator in AppShell** — Out of scope for 7a, delivered in Phase 7b. Not a finding.

---

## 7. Net verdict + top 3 priority fixes

**Verdict: Approve with follow-up fixes required.** Phase 7a is a well-scoped, disciplined foundation commit. SW design is correct on the load-bearing rules (NetworkOnly for RSC flight and Server Actions; auth-gated HTML never cached; build-ID-scoped caches with activate purge). Middleware `Cache-Control` guardrail is correctly applied to authenticated HTML. Error boundary's reload-guard design is sound. No P0 defects. The overall structure is sturdy enough that 7b and 7c build on it cleanly.

### Top 3 priority fixes

1. **`web/src/middleware.ts:37-44`** — Replace `pathname.includes('.')` with a narrow static-asset check (explicit extension list or regex against known asset patterns). Fixes the dotted-path auth/admin bypass AND ensures `/login`/`/legal`/`/offline` HTML gets `no-store`. Single change closes two reviewer concerns.
2. **`web/src/app/sw.ts:75-79`** — Remove `skipWaiting: true`; require client `SKIP_WAITING` postMessage + user-visible refresh prompt before activation. (Already done in working tree for 7b; confirm the 7b commit lands before any further production deploy.)
3. **`web/src/app/offline/page.tsx:31-34` + `web/src/app/error.tsx:96-99`** — Correct misleading copy. `/offline` should not promise automatic sync before 7c outbox ships; error boundary should not claim "we've logged this" without a real sink. Low-effort, closes a truthfulness gap the handoff explicitly called out.
