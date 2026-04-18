## 1. Summary of the phase
This commit adds an AppShell-level offline indicator for authenticated screens. It introduces a small client hook around `navigator.onLine` plus `online`/`offline` window events, then mounts an amber `Offline` pill at the start of the header’s right cluster in [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:83).

## 2. Alignment with original plan
The implementation matches the main handoff intent in [web/reviews/context/phase-7b3.md](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-7b3.md:177): it adds the hook, adds the pill, and places it first in the AppShell header cluster. One detail does not fully match the documented intent: the handoff says both `title` and `aria-label` should carry the full explanatory string, but the code only gives the full wording to `aria-label`, while `title` is shortened in [web/src/components/pwa/offline-indicator.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/offline-indicator.tsx:54).

Later working-tree drift is minimal for this phase: `offline-indicator.tsx` and `use-online-status.ts` are unchanged since `a85487f`; `app-shell.tsx` has since gained `useOutboxReplay()` for Phase 7c, but the offline-indicator integration is unchanged.

## 3. Correctness issues
- **P1** Misleading offline-write semantics for assistive users in [web/src/components/pwa/offline-indicator.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/offline-indicator.tsx:54): `aria-label` says “changes will not sync until your connection returns.” The Phase 7b handoff explicitly says offline writes are still out of scope and “offline edits still vanish” in [web/reviews/context/phase-7b3.md](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-7b3.md:123) and again in the deferred-scope section at [phase-7b3.md:249](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-7b3.md:249). That copy implies a queued/outbox model that does not exist in this phase, which can mislead users about data safety.

## 4. Security issues
- No security issues identified in this commit. The change is UI-only and does not introduce new input handling, auth flow, storage of secrets, or network surface.

## 5. Performance issues
- No material performance issues identified. `useOnlineStatus()` is a small, single-subscription hook mounted once in AppShell, and the indicator returns `null` in the common online case.

## 6. Accessibility issues
- **P2** Hover text is weaker than the documented and screen-reader text in [web/src/components/pwa/offline-indicator.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/offline-indicator.tsx:54): the handoff says `title` and `aria-label` should both expose the full explanatory message, but `title="Offline — showing cached data"` drops the write-risk warning and the full explanation promised in [web/reviews/context/phase-7b3.md](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-7b3.md:47). This is not catastrophic, but it is a real parity/accessibility miss versus the stated design.

## 7. Code quality
- Code quality is otherwise solid. The hook is SSR-safe, listeners are cleaned up correctly in [web/src/lib/pwa/use-online-status.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/use-online-status.ts:38), and AppShell placement matches the phase intent in [web/src/components/layout/app-shell.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/layout/app-shell.tsx:84).
- Conventionally, this phase is comment-heavy but coherent with the repo’s documented handoff style.

## 8. Test coverage gaps
- No automated tests were added for this phase, and I did not find any `*.test.ts(x)` / `*.spec.ts(x)` files under `web/`.
- Missing coverage areas:
  - `useOnlineStatus()` initial optimistic render, mount-time correction, and listener cleanup in [web/src/lib/pwa/use-online-status.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/use-online-status.ts:35)
  - `OfflineIndicator` null render when online and visible render when offline in [web/src/components/pwa/offline-indicator.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/pwa/offline-indicator.tsx:47)
  - Copy/a11y assertions so the status text cannot regress into promising unsupported offline sync

## 9. Suggested fixes
1. [web/src/components/pwa/offline-indicator.tsx:54] Change the `aria-label` to remove the unsupported promise that edits will sync later. Suggested direction: “You are offline. Some data may be previously loaded. Reconnect before making changes.” This matches Phase 7b’s actual contract and avoids implying a 7c-style outbox.
2. [web/src/components/pwa/offline-indicator.tsx:55] Make `title` match the same full, corrected message as `aria-label`, or remove `title` entirely if you do not want hover-only copy. The current shortened title does not match the handoff intent and omits important context.
3. [web/src/lib/pwa/use-online-status.ts:35] Add tests for the hook and indicator behavior. At minimum, cover initial `true`, mount correction from `navigator.onLine`, `online`/`offline` event transitions, and offline-indicator render/null behavior so this UX does not regress silently.

## 10. Overall verdict
**Ship with fixes.**

Top 3 priority fixes:
1. Fix the misleading `aria-label` copy that currently implies offline edits will sync later.
2. Align or remove the `title` so hover users get the same corrected message.
3. Add basic automated coverage for `useOnlineStatus()` and `OfflineIndicator`.

The phase is small and mostly well-executed. The main problem is not structural code quality; it is that the accessibility copy currently overstates offline capability relative to what Phase 7b actually ships.