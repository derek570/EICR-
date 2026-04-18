**1. Summary of the phase**

Phase 7b adds a new client component, [`IOSInstallHint`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:63), and mounts it on [`/settings`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/page.tsx:79) to give Safari/iOS users a manual “Share → Add to Home Screen → Add” install path that Safari does not expose through `beforeinstallprompt`. The banner is dismissible, persisted in `localStorage`, and self-suppresses for non-iOS and already-installed sessions.

The current working tree matches commit `1ec4e22` for the reviewed files; there is no later drift in [`ios-install-hint.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:1) or [`settings/page.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/page.tsx:1).

**2. Alignment with original plan**

The implementation matches the handoff closely on structure and intent: it adds a dismissible hint component, stores dismissal under the versioned key, checks standalone mode, and mounts the banner on `/settings` between the hero and TEAM section as described in [the handoff](/Users/derekbeckley/Developer/EICR_Automation/web/PHASE_7B_HANDOFF.md:83).

One objective is only partially met: the handoff says this phase gives “iOS users” a path to install, but the UA gate in [`ios-install-hint.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:73) misses modern iPadOS devices that present desktop-class Safari user agents. That means part of the intended audience still never sees the hint.

**3. Correctness issues**

- **P1** Modern iPads are missed by the install-hint gate in [`web/src/components/pwa/ios-install-hint.tsx:73`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:73). The regex only matches `iPad|iPhone|iPod`, but current iPadOS Safari commonly reports a desktop-style UA (`Macintosh`) and relies on touch-capability heuristics instead. Result: a real iPad user can fall through the “non-iOS” path and never get the add-to-home-screen guidance this phase was meant to provide.
- **P2** The `localStorage` read is not protected in [`web/src/components/pwa/ios-install-hint.tsx:82`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:82), even though the phase rationale explicitly calls out storage robustness. `setItem` is wrapped in `try/catch`, but `getItem` can also throw in restricted-storage contexts. In those cases the effect can fail before `setVisible(true)`, turning a best-effort hint into a runtime error path.

**4. Security issues**

- No material security issues found in this phase. The component uses static copy only, does not introduce dynamic HTML injection, and persists only a boolean-like dismissal flag in `localStorage`.

**5. Performance issues**

- No meaningful performance issues found. The component does one mount-time effect, one `matchMedia` check, and a single small conditional render on a low-traffic page.

**6. Accessibility issues**

- **P2** The region label in [`web/src/components/pwa/ios-install-hint.tsx:103`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:103) says “Install CertMate on your iPhone,” but the feature is intended for both iPhone and iPad users. For iPad users who do see the banner, that is incorrect assistive copy.
- **P2** The inline Share icon is given `aria-label="Share"` in [`web/src/components/pwa/ios-install-hint.tsx:140`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:140). Inside an already-readable sentence, that creates redundant or awkward screen-reader output. This icon is decorative support for the sentence and should be `aria-hidden`.

**7. Code quality**

- The phase is otherwise cleanly scoped: the install decision stays encapsulated in [`IOSInstallHint`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:63), and [`settings/page.tsx`](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/page.tsx:79) remains free of platform branching.
- The main code-quality weakness is that platform detection and storage access are embedded directly in the effect with no helper abstraction, which makes the already-fragile UA logic harder to test and easier to regress.

**8. Test coverage gaps**

- There are effectively no automated tests in `web/` covering this feature; I did not find any app test files for this area.
- Missing cases that should be covered:
  - iPhone Safari renders the hint on first visit.
  - Dismiss sets the storage key and suppresses subsequent renders.
  - Standalone mode suppresses the banner.
  - Modern iPadOS desktop-style UA still renders the banner.
  - Storage read/write failures do not throw and fail closed safely.
  - Screen-reader semantics for the region label and dismiss control.

**9. Suggested fixes**

1. [`web/src/components/pwa/ios-install-hint.tsx:73`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:73)  
   Extend iOS detection to cover modern iPadOS desktop-class Safari, e.g. include a branch such as `navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1` alongside the current regex. This is the highest-priority fix because it blocks a real portion of the intended iOS audience from ever seeing the hint.

2. [`web/src/components/pwa/ios-install-hint.tsx:82`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:82)  
   Wrap the `localStorage.getItem()` read in the same defensive `try/catch` approach used for `setItem`, or centralize both behind a tiny safe-storage helper. The current code handles write failures but not read failures, which does not match the stated resilience goal.

3. [`web/src/components/pwa/ios-install-hint.tsx:103`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:103)  
   Change the region label to platform-neutral copy such as “Install CertMate on your device” or “Add CertMate to your Home Screen.” That keeps assistive text correct for both phones and tablets.

4. [`web/src/components/pwa/ios-install-hint.tsx:137`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:137)  
   Mark the inline `Share` icon `aria-hidden` and let the surrounding sentence carry the meaning. This avoids redundant announcements while preserving the visual cue.

5. [`web/src/components/pwa/ios-install-hint.tsx:66`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:66)  
   Add automated coverage for the mount effect behavior in a new component test or Playwright spec, specifically for iPhone UA, modern iPad UA, standalone suppression, dismissed suppression, and storage failure paths. Right now the feature is protected only by manual testing.

**10. Overall verdict**

**Ship with fixes.** The phase is well-scoped and mostly matches the handoff, but it has one significant functional miss: modern iPads can be excluded from the hint entirely. The storage-read robustness and a11y copy issues are lower severity but worth correcting in the same pass.

Top 3 priority fixes:
1. Fix iPadOS detection in [`ios-install-hint.tsx:73`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:73).
2. Guard `localStorage.getItem()` in [`ios-install-hint.tsx:82`](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/ios-install-hint.tsx:82).
3. Add regression tests for install-hint visibility/suppression behavior.