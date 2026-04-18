## 1. Summary of the phase

This commit correctly kicks off Phase 7b by replacing Phase 7a’s unconditional `skipWaiting: true` flow with a user-mediated service-worker handoff. It adds a root-mounted `SwUpdateProvider` that detects a waiting SW, shows a persistent Sonner toast with a `Reload` action, posts `SKIP_WAITING` to the waiting worker, and reloads on `controllerchange`; it also updates [`layout.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/layout.tsx:1), [`sw.ts`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/sw.ts:70), and [`eslint.config.mjs`](/Users/derekbeckley/Developer/EICR_Automation/web/eslint.config.mjs:1) to support that flow.

The implementation is narrowly scoped and matches the intended “kickoff before any other 7b work” shape. The reviewed files are unchanged in current `HEAD` (`e64f756`) relative to `ce8323a`.

## 2. Alignment with original plan

The implementation is strongly aligned with the handoff doc and commit intent:

- It removes automatic `skipWaiting` from [`sw.ts`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/sw.ts:75).
- It adds the explicit `message` listener for `{ type: 'SKIP_WAITING' }` in [`sw.ts`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/sw.ts:199).
- It mounts both `<SwUpdateProvider />` and `<Toaster ... />` in [`layout.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/layout.tsx:65).
- It applies the eslint ignore fix for generated Serwist output in [`eslint.config.mjs`](/Users/derekbeckley/Developer/EICR_Automation/web/eslint.config.mjs:15).

No kickoff objective from the handoff doc appears to be omitted. The main gap is not scope coverage but lifecycle correctness: one of the new guards does not actually enforce “user-initiated reload only.”

## 3. Correctness issues

- **P1** Unconditional `controllerchange` reload still reloads the page on first install, even when the user never accepted an update. In [`sw-update-provider.tsx:108-113`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:108), the listener is attached on every mount and always calls `window.location.reload()`. On a first-ever SW install, `clientsClaim: true` in [`sw.ts:86`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/sw.ts:86) can legitimately trigger `controllerchange`, so the app still performs an unsolicited reload during initial activation. That violates the stated intent of a user-mediated handoff and can interrupt a first-session login/edit flow.
- **P2** The in-session upgrade detector can miss an update that is already in `registration.installing` before the `updatefound` listener is attached. In [`sw-update-provider.tsx:80-106`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:80), `watchRegistration()` checks `registration.waiting`, then only listens for future `updatefound`. It never inspects an already-present `registration.installing`. If `getRegistration()` resolves after `updatefound` fired but before the worker reaches `waiting`, this provider misses the `statechange` path and never prompts until the user does a full reload.
- **P2** Missing error handling around SW registration lookup can surface unhandled rejections from the root layout. [`sw-update-provider.tsx:104-106`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:104) calls `navigator.serviceWorker.getRegistration().then(...)` without a `.catch(...)`. In browsers with partial SW support, transient registration failures, or privacy-mode edge cases, this can emit an unhandled promise rejection from a root-mounted effect.

## 4. Security issues

No concrete security findings in this diff.

- **None found**: I did not find new XSS, auth, CSRF, injection, secret leakage, or CORS regressions in `ce8323a`. The `SKIP_WAITING` message listener in [`sw.ts:199-203`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/sw.ts:199) accepts a simple same-origin client message, but that is not a meaningful privilege expansion beyond an already-compromised same-origin page.

## 5. Performance issues

No material performance issues found.

- The provider is small, mounts once at root, and only installs a handful of event listeners.
- The added Toaster in [`layout.tsx:82`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/layout.tsx:82) is appropriate for app-wide notifications.
- I do not see bundle-shape or re-render concerns that are significant for this phase.

## 6. Accessibility issues

No clear accessibility regressions are evident in the code diff itself.

- Sonner’s action and close button are likely acceptable, but there is no automated or documented verification that the persistent update toast is announced correctly and is fully keyboard-operable.
- The first-install unsolicited reload described above is also an accessibility concern in practice because it can disrupt focus and assistive-technology flow, but the underlying issue is already covered as a correctness bug.

## 7. Code quality

The phase is generally clean and well-scoped, with good comments and a clear lifecycle narrative.

Minor quality concerns:

- [`sw-update-provider.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:1) is comment-heavy relative to logic size; acceptable for lifecycle code, but the implementation would be safer if the state machine were encoded more explicitly.
- `toastShownRef` is a single boolean in [`sw-update-provider.tsx:53`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:53), not tied to a specific worker/version. That is fine for the simple one-update case, but it makes future multi-update/session behavior harder to reason about.

## 8. Test coverage gaps

Test coverage is the weakest part of this phase.

- There is no visible automated test coverage for the new SW handoff flow.
- The `web` package has Playwright installed in [`package.json`](/Users/derekbeckley/Developer/EICR_Automation/web/package.json:1), but I did not find phase-specific browser tests for update handoff.
- Missing scenarios:
  - first install does **not** reload and does **not** show a toast
  - a waiting worker present at page load shows exactly one toast
  - an in-session upgrade via `updatefound` shows exactly one toast
  - clicking `Reload` posts `SKIP_WAITING` and reloads exactly once on `controllerchange`
  - duplicate `controllerchange` does not double-reload
  - registration lookup failure does not produce an unhandled rejection

## 9. Suggested fixes

1. [`web/src/components/pwa/sw-update-provider.tsx:52-53, 68-76, 108-113`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:52) — add a separate `reloadRequestedRef`/`acceptedUpdateRef`, set it only inside the toast action, and make `onControllerChange()` return early unless that ref is true. This fixes the current first-install unsolicited reload and makes the flow truly user-initiated.
2. [`web/src/components/pwa/sw-update-provider.tsx:80-98, 104-106`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:80) — factor out a `watchInstalling(worker)` helper, call it both for `registration.installing` immediately and inside the `updatefound` handler, and re-check `registration.waiting` after listeners are attached. This closes the install-in-progress race and makes the “path B” detection actually robust.
3. [`web/src/components/pwa/sw-update-provider.tsx:70-71, 104-106`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/sw-update-provider.tsx:70) — wrap `waiting.postMessage(...)` and `getRegistration()` in defensive error handling. If the waiting worker is gone/redundant or registration lookup fails, either reset the toast state or show a fallback “Refresh to update” path instead of failing silently or leaving an unhandled rejection.
4. [`web/package.json:5-11`](/Users/derekbeckley/Developer/EICR_Automation/web/package.json:5) and a new browser test file under `web/` — add Playwright coverage for the SW lifecycle cases above. This phase is fundamentally about browser timing/races; unit-only confidence is not enough.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:

1. Stop reloading on `controllerchange` unless the user explicitly accepted the update.
2. Handle `registration.installing` immediately so in-session upgrades are not missed.
3. Add browser-level tests for first install, waiting-at-load, and reload-on-accept lifecycle paths.