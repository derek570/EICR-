# Phase 7a Review — PWA Foundation

## 1. Summary of the phase

Phase 7a adds the core PWA plumbing for the web rebuild: a typed manifest, generated install icons, a Serwist service worker with conservative cache rules, a branded `/offline` page, a root error boundary for stale Server Action failures, and an install-prompt flow wired through Zustand. It also adds a middleware `Cache-Control` guardrail to reduce version skew between cached HTML and the current server bundle.

Note: the working tree has already moved past `eb72acc` in a few places, notably `web/src/app/sw.ts`, `web/src/app/layout.tsx`, and `web/src/components/layout/app-shell.tsx`, where 7b follow-up work has already landed.

## 2. Alignment with original plan

The implementation is largely faithful to the handoff doc in `web/reviews/context/phase-7a.md` / `web/PHASE_7A_HANDOFF.md`: the manifest fields, icon set, service-worker rule ordering, root-mounted install listener, error boundary, worker-specific tsconfig split, and webpack build switch all match the stated intent.

The main miss is that the shipped `/offline` UX does not match the handoff’s “truthful copy” requirement. The handoff explicitly says automatic sync belongs in 7c, but the committed page promises that changes “will sync automatically” (`web/src/app/offline/page.tsx:31-34` at `eb72acc`).

## 3. Correctness issues

- `P1` `web/src/app/sw.ts:75-79` at `eb72acc`: `skipWaiting: true` makes the second production deploy hot-swap the service worker under active users. The handoff itself acknowledges this and says 7b must replace it before any further rollout. As committed, 7a is not safe in isolation beyond the first deploy.
- `P1` `web/src/middleware.ts:37-42, 62-72`: the new “every non-static page gets `Cache-Control: no-cache, no-store, must-revalidate`” guarantee is false for any route whose pathname contains a `.`. Those requests return early before the header is set. Because the same shortcut also skips auth/admin checks, dotted dynamic routes would also bypass middleware protection.
- `P2` `web/src/app/offline/page.tsx:14-18, 31-34`: the page tells users their changes “will sync automatically when the network returns,” but Phase 7a explicitly excludes outbox/sync plumbing. That is misleading product behavior for a field-work app.
- `P2` `web/src/app/error.tsx:27-29, 96-99`: the fallback copy says “We’ve logged this,” but 7a only writes to the browser console. There is no real server-side error aggregation in this phase.

## 4. Security issues

- `[P1]` `web/src/middleware.ts:37-42`: `pathname.includes('.')` is too blunt a “static file” check. Any dynamic route containing a dot skips middleware entirely, which means the new no-store guardrail and existing auth/admin gating are both bypassed for those URLs.

No other material phase-specific security defects stood out in the new PWA code. The SW is appropriately conservative about auth-gated HTML and cross-origin requests.

## 5. Performance issues

- `P2` `web/next.config.ts:24-26`: `reloadOnOnline: true` will force a reload whenever connectivity flaps back, even before any outbox exists. On mobile this can discard in-memory edits and create noisy reloads in exactly the weak-signal environments this phase is trying to support.

Otherwise the cache strategy is mostly disciplined: auth HTML is not cached by the SW, immutable chunks use SWR, and the precached offline shell is lightweight.

## 6. Accessibility issues

- `P2` `web/src/app/layout.tsx:35-46` at `eb72acc`: `maximumScale: 1` and `userScalable: false` disable zoom. That is an accessibility regression against users who need pinch-zoom or larger text.
- `P3` `web/src/components/pwa/install-button.tsx:38-41`: the visible label is “Install app” but the control is overridden with `aria-label="Install CertMate app"`. Not broken, but unnecessary divergence between spoken and visible labeling.

## 7. Code quality

- `web/src/middleware.ts:37-42`: the middleware is carrying too much meaning in a pathname heuristic. It now affects auth, admin routing, and cache headers, so the brittle dot check has become higher-risk technical debt.
- `web/src/app/offline/page.tsx` and `web/src/app/error.tsx`: comments and product copy drift from the actual shipped behavior. The docs say “truthful copy” and “console only”; the UI says sync/logging already exist.

## 8. Test coverage gaps

- No automated coverage for the SW matcher rules, especially “never cache RSC / Server Action traffic” and “never cache auth-gated navigations.”
- No test for the middleware cache header behavior on HTML responses, including dotted dynamic paths.
- No test for the root error boundary’s one-reload-per-30s guard.
- No test for the install prompt lifecycle (`beforeinstallprompt` captured at root, button clears after `userChoice`).

## 9. Suggested fixes

1. `web/src/middleware.ts:37-42, 70-71` — replace `pathname.includes('.')` with a narrower static-asset check, and ensure HTML responses still fall through to the `Cache-Control` setter. This fixes both the auth-bypass risk and the false “all non-static pages get no-store” guarantee.
2. `web/src/app/sw.ts:75-79` — remove `skipWaiting: true` and gate activation behind an explicit client message (`SKIP_WAITING`) plus a user-visible refresh prompt. This prevents the next deploy from swapping code under active editors. The working tree has already moved in this direction.
3. `web/src/app/offline/page.tsx:31-34` — change the copy to something truthful for 7a, e.g. “Reconnect to continue” without promising sync. Users should not be told offline edits will survive when no outbox exists yet.
4. `web/src/app/error.tsx:96-99` — change “We’ve logged this” to “Error details are available in the reference below” or wire actual error reporting. The current text overclaims.
5. `web/src/app/layout.tsx:35-46` — remove `maximumScale: 1` and `userScalable: false`. Keep the theme-color change, but allow zoom.
6. `web/next.config.ts:24-26` — reconsider `reloadOnOnline: true` until offline edit preservation exists, or scope the reload behavior to the offline shell/update flow rather than every reconnect.

## 10. Overall verdict

**Ship with fixes.**

The phase is well-scoped and mostly aligned with the handoff, and the SW/cache design is broadly sound. The top 3 priority fixes are:

1. Fix the middleware dotted-path shortcut so auth/admin checks and `Cache-Control` are not skipped.
2. Eliminate `skipWaiting: true` before relying on this in production past the first deploy.
3. Correct the misleading `/offline` and error-boundary copy so the UX matches actual 7a behavior.