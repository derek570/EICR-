# Phase 7a — Context

**Commit:** `eb72acc`

## Commit message

```
commit eb72acc7548d1a43067c31bbae01666f6a8de35e
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 21:49:38 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 21:49:38 2026 +0100

    feat(web): Phase 7a PWA foundation
    
    Makes the web client installable, version-skew-safe, and resilient to
    mid-session network drops, without adding any offline read-through or
    outbox plumbing (those are deliberately deferred to 7b/7c/7d). Single
    focused commit matching the 6a/6b/6c cadence.
    
    What's in here:
    
    * Manifest (`/manifest.webmanifest` via Next's `MetadataRoute.Manifest`)
      with `start_url: '/dashboard'`, `scope: '/'`, `display: 'standalone'`,
      `id: '/'`, and `theme_color`/`background_color` both `#0a0a0a` so the
      iOS status bar, Android task-switcher card, and the app's top edge
      all render the exact same surface-0 shade.
    
    * Full icon set generated from geometric SVG masters via sharp (no
      `<text>`, so build hosts can't drift on font availability): 192/384/
      512 any-purpose PNGs, a 512 maskable variant with a 70% safe zone for
      Android adaptive cropping, an opaque 180 apple-icon flattened onto
      brand-blue (iOS rejects transparency), plus 32px and SVG favicons.
    
    * Authored Serwist service worker (`web/src/app/sw.ts`) with five cache
      rules in priority order:
    
        (1) NetworkOnly for `/_next/app/*`, `Next-Action` headers, and RSC
            flight payloads (detected via `RSC: 1` header OR `?_rsc=`
            query) — never cached. A stale flight payload is the #1 cause
            of mid-session "Failed to find Server Action" after a deploy.
        (2) StaleWhileRevalidate for `/_next/static/*` into
            `static-<BUILD_ID>` with `ExpirationPlugin` (200 entries / 30d).
        (3) CacheFirst for fonts.
        (4) CacheFirst for `/icons/*`, `/apple-icon*`, `/favicon*`.
        (5) NetworkFirst for public navigations ONLY (`/`, `/login`,
            `/legal*`, `/offline`) with 3s timeout and `/offline` fallback.
    
      Auth-gated pages (`/dashboard`, `/job/*`, `/settings/*`) deliberately
      fall through to default NetworkOnly — a shared device must never
      replay one user's HTML for another. Cache names are BUILD_ID-versioned
      so a fresh deploy's activate handler purges the previous build's
      runtime caches while preserving `serwist-*` metadata.
    
      `skipWaiting: true` is safe for the FIRST deploy (no prior SW in
      prod). Phase 7b MUST replace with postMessage-driven skipWaiting +
      a "New version available" toast BEFORE any other 7b work lands — see
      PHASE_7A_HANDOFF.md §"Kickoff checklist for 7b".
    
    * Branded `/offline` page reusing login's `cm-orb` + `cm-glass`
      aesthetic. Copy is truthful: "Reconnect to continue". The "your work
      will sync automatically" language is aspirational and belongs in 7c.
    
    * Root error boundary (`web/src/app/error.tsx`) that auto-reloads on
      "Failed to find Server Action" / `NEXT_SERVER_ACTION` digest, but
      guards with a 30s `sessionStorage` timestamp so a consistently-
      failing action can't pin the user in a reload loop. After 30s, the
      fallback card renders instead. Logs `error.digest` to console so
      users can quote it in bug reports.
    
    * Install flow: Zustand store for the deferred `BeforeInstallPrompt`
      event (type interface is declared locally because lib.dom doesn't
      include it), an `<InstallPromptProvider />` mounted at root layout
      (NOT AppShell — Chrome can fire `beforeinstallprompt` on `/login`
      before the user has even signed in), and an `<InstallButton />` in
      the AppShell header that returns null on Safari, once installed, or
      before the event arrives. Click handler awaits `userChoice` before
      clearing so the button doesn't flicker mid-dialog.
    
    * CLAUDE.md-mandated guardrail in middleware: every non-static page
      response now carries `Cache-Control: no-cache, no-store,
      must-revalidate`. Forces the browser's HTTP cache to always
      revalidate HTML so the client bundle can never outlive its matching
      server routes. Independent of the SW.
    
    Why a dedicated `tsconfig.sw.json`: sw.ts needs `lib: ["webworker"]`,
    which overrides `WorkerNavigator` onto `navigator` and breaks
    `mic-capture.ts` typechecking. Splitting the SW into its own tsconfig
    + excluding it from the main one isolates the worker types cleanly.
    Plus a minimal inline `declare const process` shim so webpack's
    build-time `NEXT_PUBLIC_BUILD_ID` replacement typechecks without
    pulling `@types/node` into the worker bundle.
    
    Why `next build --webpack`: Next 16 defaults to Turbopack but Serwist
    doesn't support it yet (serwist/serwist#54). Webpack is still a
    first-class Next target — zero regression, and switching back is a
    one-line change once the issue lands.
    
    Scope exclusions (see PHASE_7A_HANDOFF.md): no IDB read-through (7b),
    no outbox (7c), no offline job-edit UI (7d), no update toast (7b
    first-commit MUST land this), no iOS Add-to-Home-Screen hint (7b),
    no push/periodic-sync/share-target, no Sentry.
    
    Verified: `npm run typecheck` clean (main + SW), `npm run lint` at
    baseline (0 errors, 6 warnings — unchanged from bc11914), `npm run
    build` succeeds with Serwist bundler log confirming sw.js emission
    and all 7a routes (`/manifest.webmanifest`, `/offline` both static,
    error boundary wired).
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                          |    1 +
 package-lock.json                                  | 1497 ++++++++++++++++----
 web/.gitignore                                     |    8 +
 web/PHASE_7A_HANDOFF.md                            |  105 ++
 web/next.config.ts                                 |   28 +-
 web/package.json                                   |    8 +-
 web/public/apple-icon-180.png                      |  Bin 0 -> 2108 bytes
 web/public/favicon-32.png                          |  Bin 0 -> 659 bytes
 web/public/favicon.svg                             |   49 +
 web/public/icons/icon-192.png                      |  Bin 0 -> 3343 bytes
 web/public/icons/icon-384.png                      |  Bin 0 -> 5714 bytes
 web/public/icons/icon-512.png                      |  Bin 0 -> 7126 bytes
 web/public/icons/icon-maskable-512.png             |  Bin 0 -> 3884 bytes
 web/scripts/generate-pwa-icons.mjs                 |   78 +
 web/scripts/icons/apple-icon.svg                   |   47 +
 web/scripts/icons/favicon.svg                      |   49 +
 web/scripts/icons/icon-maskable.svg                |   50 +
 web/scripts/icons/icon.svg                         |   68 +
 web/src/app/error.tsx                              |  115 ++
 web/src/app/layout.tsx                             |   28 +-
 web/src/app/manifest.ts                            |   70 +
 web/src/app/offline/page.tsx                       |   93 ++
 web/src/app/sw.ts                                  |  199 +++
 web/src/components/layout/app-shell.tsx            |    9 +
 web/src/components/pwa/install-button.tsx          |   43 +
 web/src/components/pwa/install-prompt-provider.tsx |   42 +
 web/src/lib/pwa/install-store.ts                   |   39 +
 web/src/middleware.ts                              |   12 +-
 web/tsconfig.json                                  |    2 +-
 web/tsconfig.sw.json                               |    9 +
 30 files changed, 2335 insertions(+), 314 deletions(-)
```

## Handoff doc: PHASE_7A_HANDOFF.md

# Phase 7a — PWA Foundation (handoff)

> Web rebuild · branch `web-rebuild` · Phase 6 closed at `bc11914` (system-admin users)

## Objective

Lay the foundation for the web client to behave like a PWA: installable
from Chrome/Edge/Android (and iOS via Add-to-Home-Screen), resilient to
version-skew after deploys, and safe to open in shared devices without
leaking authenticated HTML into caches.

Phase 7a ships as a **single focused commit**. Follow-ups 7b/7c/7d
(below) are deliberately deferred.

## What shipped

### New

- `web/src/app/manifest.ts` — Next `MetadataRoute.Manifest` typed export at `/manifest.webmanifest`. `start_url: '/dashboard'`, `scope: '/'`, `display: 'standalone'`, `theme_color` + `background_color` both `#0a0a0a` (surface-0 token, aligned with iOS status bar + Android task-switcher card). `id: '/'` for stable install identity across origin tweaks.
- `web/src/app/sw.ts` — Serwist-authored service worker, build-ID-versioned caches (`static-<BUILD_ID>`, `pages-<BUILD_ID>`, plus long-lived `fonts` and `icons`). Five runtime caching rules in priority order:
  1. **NetworkOnly** — `/_next/app/*`, Next-Action header, RSC flight payloads (`RSC: 1` or `?_rsc=`). **Never cached** — the #1 cause of "Failed to find Server Action" mid-session is a stale flight payload.
  2. **StaleWhileRevalidate** — `/_next/static/*` (hash-named immutable chunks).
  3. **CacheFirst (fonts)** — `.woff2/.woff/.ttf/.otf`.
  4. **CacheFirst (icons)** — `/icons/*`, `/apple-icon*`, `/favicon*`.
  5. **NetworkFirst (public navigations only)** — `/`, `/login`, `/legal*`, `/offline`. 3s timeout, fallback to `/offline`.
  - **Auth-gated pages** (`/dashboard`, `/job/*`, `/settings/*`) deliberately fall through to default `NetworkOnly` — a shared device must never replay one user's HTML for another.
  - `skipWaiting: true`, `clientsClaim: true`, `navigationPreload: true`.
  - Activate handler purges any cache whose name doesn't end in the current `BUILD_ID`, preserving `serwist-*` metadata caches.
- `web/src/app/offline/page.tsx` — branded fallback. Reuses the login page's ambient orbs (`cm-orb`) + glass card (`cm-glass`) so the offline state visually reads as "same app, you're just disconnected". Truthful copy — "your work will sync automatically" is aspirational and belongs in 7c; for 7a we say "Reconnect to continue" and give a reload button.
- `web/src/app/error.tsx` — root error boundary. If the error looks like a stale Server Action (`message.includes('Failed to find Server Action')` OR `digest?.includes('NEXT_SERVER_ACTION')`), **auto-reload once** — but guard against a reload loop with a 30s `sessionStorage` timestamp. After 30s the fallback card renders instead of reloading again. Logs `error.digest` to console so users can quote it in bug reports.
- `web/src/lib/pwa/install-store.ts` — Zustand slice holding the deferred `BeforeInstallPromptEvent`. `canInstall` is a derived selector; `markInstalled` clears the prompt on `appinstalled`. The event type interface is declared here (not DOM-lib) because TypeScript's lib.dom doesn't include it yet.
- `web/src/components/pwa/install-prompt-provider.tsx` — renders null. Mounted at root layout so Chrome's `beforeinstallprompt` is captured even on `/login` (before the user has signed in). Calls `preventDefault()` to suppress Chrome's built-in banner — we prefer a low-key button in the header.
- `web/src/components/pwa/install-button.tsx` — ghost/sm Button in AppShell header. Returns null until the browser has fired the event. On click, awaits `deferredPrompt.prompt()` + `userChoice` so the button doesn't flicker away mid-dialog, then clears the store (browsers refuse a second `prompt()` call, so this is effectively one-shot per session).
- `web/public/icons/icon-192.png`, `icon-384.png`, `icon-512.png`, `icon-maskable-512.png` — manifest icons. Maskable uses a 70% safe zone inside the full-bleed gradient so Android's adaptive-icon crop doesn't clip the "CM" glyph.
- `web/public/apple-icon-180.png` — iOS home-screen icon. **Opaque** (flattened onto `#0066FF`) because iOS rejects transparency and fills it with black.
- `web/public/favicon.svg`, `web/public/favicon-32.png` — favicons.
- `web/scripts/icons/*.svg` + `web/scripts/generate-pwa-icons.mjs` — source SVGs + sharp-based rasterizer. Glyph is geometric paths (not `<text>`) so build hosts can't drift on font availability. Run `npm run pwa:icons` to regenerate.
- `web/tsconfig.sw.json` — dedicated TS config for the service worker. `lib: ["esnext", "webworker"]` + `types: []`. Needed because the SW's `WorkerNavigator` type would otherwise override `navigator.mediaDevices` in `mic-capture.ts`.
- `web/PHASE_7A_HANDOFF.md` — this doc.

### Modified

- `web/next.config.ts` — wrapped with `withSerwist({ swSrc: 'src/app/sw.ts', swDest: 'public/sw.js', cacheOnNavigation: false, reloadOnOnline: true, disable: process.env.NODE_ENV === 'development' })`. `cacheOnNavigation: false` because we drive navigation caching ourselves in `sw.ts` with much stricter rules than Serwist's default.
- `web/src/app/layout.tsx` — mounted `<InstallPromptProvider />` as first body child (before `{children}`). Added `metadata.icons` so Next emits `<link rel="icon">` + `<link rel="apple-touch-icon">` tags pointing at the generated PNG/SVG files. Changed `viewport.themeColor` from `#0A0A0F` → `#0a0a0a` to match the manifest and prevent a visible 1px tint mismatch between iOS status bar (viewport) and standalone chrome (manifest).
- `web/src/middleware.ts` — every non-static page response now carries `Cache-Control: no-cache, no-store, must-revalidate`. CLAUDE.md-mandated guardrail: forces the browser HTTP cache to always revalidate HTML, so the client bundle can never outlive its matching server routes after a deploy. Static files (anything with a `.`) and `/_next/*` are already early-returned, so this header only reaches HTML. Independent of the SW's own caching.
- `web/src/components/layout/app-shell.tsx` — added `<InstallButton />` to the right-cluster flex container, between the user-name span and Sign-out button. Hidden when no deferred prompt exists (Safari, already-installed, or before the event fires).
- `web/src/app/sw.ts` (via TS config exclusion) — `no-default-lib` removed; lib selection now controlled by `tsconfig.sw.json`. Added a minimal inline `declare const process` shim so webpack's build-time `process.env.NEXT_PUBLIC_BUILD_ID` replacement typechecks without pulling `@types/node` into the worker build.
- `web/tsconfig.json` — added `src/app/sw.ts` to `exclude`. Prevents the worker's `webworker` lib from polluting the main build.
- `web/package.json` — added `@serwist/next@^9.5.7`, `serwist@^9.5.7`, `sharp@^0.34.5` (dev), new `pwa:icons` script, and changed `build` to `next build --webpack`. Next 16 defaults to Turbopack; Serwist doesn't yet support it (see their GitHub #54). Webpack build is still a first-class Next target — no regression.
- `web/src/app/error.tsx` — dropped one pre-existing `eslint-disable-next-line no-console` that lint flagged as unused after the console.error stayed.
- `web/.gitignore` — `/public/sw.js`, `/public/sw.js.map`, `/public/swe-worker-*.js`, `/public/workbox-*.js` (+ .map). Serwist 9 typically only emits `sw.js`; the other patterns are defensive in case Serwist splits chunks in a future release.

## Verification

```
npm run typecheck                  # clean (main + sw via tsconfig.sw.json)
npm run lint                       # 0 errors, 6 warnings (baseline — unchanged from 6c)
npm run build                      # succeeds; public/sw.js emitted
```

Build output confirmed all Phase 7a routes:

- `○ /manifest.webmanifest` — static
- `○ /offline` — static, cached by SW as the navigation fallback
- Plus the Serwist bundler log: `✓ (serwist) Bundling the service worker script with the URL '/sw.js' and the scope '/'...`

### DevTools walkthrough (Chrome, production build served via `npm start`)

1. **Application → Manifest** — name "CertMate — EICR-oMatic", all 4 icons load 200, no warnings.
2. **Application → Service Workers** — `/sw.js` activated and running, scope `/`.
3. **Application → Cache Storage** — after visiting `/login`, `/offline`, `/`, expect `static-<BUILD_ID>`, `pages-<BUILD_ID>`, `fonts`, `icons`. Verify **no** entries for `/dashboard`, `/job/*`, `/settings/*`.
4. **Network → Offline → reload `/`** — `/offline` renders with brand chrome and Retry button.
5. **Network → Offline → navigate to `/dashboard`** — browser shows a network error; the error boundary fallback appears (manual reload works once the network returns).
6. **Lighthouse → PWA audit on `/login`** — installable criteria all pass (manifest, icons, SW, HTTPS/localhost).

### Version-skew test

In dev, throw `new Error('Failed to find Server Action: test')` from a server component. Load the page → error boundary auto-reloads once. Trigger again within 30s → fallback renders without reloading. Wait 30s → next trigger reloads again.

## Scope exclusions (deferred to 7b/7c/7d)

- **No IDB read-through cache** — offline jobs will 404 to `/offline`. That's 7b.
- **No outbox / mutation queue** — offline edits to fields are lost. That's 7c.
- **No offline job-edit UI** — that's 7d.
- **No "New version available" toast** — `skipWaiting: true` is fine for the *first* deploy (no prior SW in prod). The *second* deploy will hot-swap under active users; Phase 7b must replace skipWaiting with a postMessage-driven prompt + toast **before any other 7b work lands**.
- **No iOS "Add to Home Screen" hint** — iOS Safari doesn't fire `beforeinstallprompt`. A dismissible `/settings` banner is a 7b add-on.
- **No push notifications, periodic sync, share target, or web share target** — not in Phase 7 at all.
- **No offline indicator in AppShell** — the `navigator.onLine` + retry-on-online UX is 7b.
- **No Sentry / error aggregation** — `error.tsx` logs `error.digest` to console; Phase 7b+ wires a real aggregator.

## Kickoff checklist for 7b (first commit)

Before *any* other 7b work, replace `skipWaiting: true` with a
postMessage-driven skipWaiting + toast. The pattern:

1. Remove `skipWaiting: true` from `Serwist({...})` in `sw.ts`. Keep `clientsClaim: true`.
2. Listen for `message` events in `sw.ts`: `if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()`.
3. Add a client listener (probably in `InstallPromptProvider` or a new `SwUpdateProvider`) for `navigator.serviceWorker`'s `controllerchange` + `waiting` states. When a new SW is waiting, render a sonner toast: "New version available — Reload". On click, `registration.waiting.postMessage({ type: 'SKIP_WAITING' })` → browser fires `controllerchange` → call `window.location.reload()`.
4. Test with two sequential deploys: first deploy installs cleanly (no toast, since there's no prior SW); second deploy shows the toast on the next visit.

Only once that is green do 7b's actual features (IDB read-through, offline job list, iOS ATHS hint) land.

## Known good commit to branch from

`bc11914` → *Phase 6c* → **`<Phase 7a commit hash>`** → Phase 7b branches from here.
