# Wave 4 D5 Handoff — Radix Dialog Sweep + `<ConfirmDialog>` Primitive

**Branch:** `wave-4-d5-radix-dialog`
**Worktree:** `/Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/agent-a8c12be2`
**Commits:** `3a0b80b` (Part A primitives) · `4a969a2` (Part B sweep) · `6a3d616` (Part C Playwright flip)
**Scope:** `FIX_PLAN.md §D D5` — replace every ad-hoc `<div role="dialog">` and `window.confirm(...)` with Radix-backed primitives.
**Status:** 73/73 vitest green · `tsc --noEmit` clean · `eslint .` clean (0 new warnings, 6 pre-existing) · Playwright 4/4 chromium green (including the previously-`.fixme` focus-trap spec, now live).

---

## What was done

### Part A — primitives (`3a0b80b`)

Two new files in `web/src/components/ui/`:

| File | Responsibility |
|---|---|
| `dialog.tsx` | Thin wrapper over `@radix-ui/react-dialog`. Re-exports `Dialog` (Root) + `DialogTrigger` + `DialogPortal` + `DialogClose`; ships three styled composites (`DialogOverlay`, `DialogContent`, `DialogTitle`, `DialogDescription`). `DialogContent` takes `showCloseButton` (default `true`), `closeLabel` (default `'Close'`), and `unstyled` (drops the centred-card defaults but keeps the Radix focus-trap / portal / aria-modal spine). |
| `confirm-dialog.tsx` | `<ConfirmDialog open onOpenChange title description confirmLabel confirmLabelBusy cancelLabel confirmVariant onConfirm busy />` — binary confirm/cancel wrapper. `confirmVariant='danger'` maps to `Button` `variant='destructive'`. Renders `DialogContent showCloseButton={false}` + a `DialogTitle` + optional `DialogDescription`. |

Plus `web/src/app/globals.css` grew two keyed-off-`data-state` transition blocks:

```css
.cm-dialog-overlay { /* opacity 120ms */ }
.cm-dialog-content { /* opacity + scale 150ms */ }
@media (prefers-reduced-motion: reduce) {
  .cm-dialog-overlay, .cm-dialog-content { transition: none; animation: none; }
}
```

No `tailwindcss-animate` dependency — the keyframes are hand-rolled to avoid pulling an extra Tailwind plugin for four animations.

### Part B — sweep (`4a969a2`)

Six ad-hoc modal sites migrated. **Zero flow behaviour changes** — each call site is a structural 1:1 port onto the primitives.

| # | File | Before | After |
|---|---|---|---|
| 1 | `web/src/components/recording/recording-overlay.tsx` | Hand-rolled `<div role="dialog" aria-modal>` + `useEffect` Esc listener + no focus trap. | `<Dialog open={isOverlayOpen} onOpenChange={handleOpenChange}>` wrapping `<DialogContent unstyled aria-label="Recording session" aria-describedby={undefined} onPointerDownOutside={e => e.preventDefault()}>` + sr-only `<DialogTitle>`. Esc/scrim-click routes to `minimise()`. Outside-click prevented (recording is a multi-step flow; accidental dismiss via scrim would drop session state). |
| 2 | `web/src/components/observations/observation-sheet.tsx` | Hand-rolled dialog `div` + manual Esc listener + manual body-scroll lock. | `<Dialog open onOpenChange={next => next ? undefined : onCancel()}>` + `<DialogContent unstyled aria-label="Observation" aria-describedby={undefined}>` + `<DialogTitle asChild>` wrapping the existing h2. Dropped the hand-rolled Esc `useEffect` and the `document.body.style.overflow` save/restore dance — Radix does both. |
| 3 | `web/src/app/settings/staff/page.tsx` | Local `ConfirmDeleteDialog` function (hand-rolled div + hand-rolled focus handling). | `<ConfirmDialog confirmVariant="danger" confirmLabel="Delete" confirmLabelBusy="Deleting…" busy={isBusy} onConfirm={confirmDelete}>` — `ConfirmDeleteDialog` component deleted. |
| 4 | `web/src/app/settings/company/dashboard/page.tsx` | `InviteEmployeeSheet` as a hand-rolled form overlay. | `<Dialog open onOpenChange>` + `<DialogContent>` + `<DialogTitle>` + `<DialogDescription>`. Submit still owned by the form, not a `ConfirmDialog`. |
| 5 | `web/src/app/settings/admin/users/[userId]/page.tsx` | `window.confirm('Unlock account?')` + a hand-rolled `ResetPasswordSheet` overlay. | Unlock now renders `<ConfirmDialog>` gated on new `showUnlockConfirm` state; old `handleUnlock` split into `handleUnlock` (opens dialog) + `performUnlock` (does the API call on confirm). Reset-password sheet migrated to `<Dialog>` + `<DialogContent>` + `<DialogTitle>` + `<DialogDescription>`. Zero bare `window.confirm` calls remain in the file. |
| 6 | `web/src/app/settings/system/page.tsx` | `if (confirm('Discard mutation?')) discardMutation(...)` inline in the row click handler. | New `pendingDiscard: OutboxMutation \| null` state. `handleDiscard` queues the mutation; `performDiscard` runs the IDB helper on confirm. `<ConfirmDialog confirmVariant="danger" confirmLabel="Discard">` rendered at the bottom of `<main>`. |

Scope exclusion: the Phase 6c admin-user **deactivate** modal was deliberately left out per the user's scope — it will import `<ConfirmDialog confirmVariant="danger">` directly in the next batch.

### Part C — Playwright flip + FAB focus restore (`6a3d616`)

`web/tests-e2e/record.spec.ts`: the `.fixme`'d focus-trap placeholder is now a live `test()`, renamed to **`overlay traps Tab, Esc closes it, focus restores to the trigger`**. It proves all three Radix-provided guarantees end-to-end against the real recording flow:

1. **Tab-forward trap** — 12 consecutive `Tab` presses; after each, assert `document.activeElement` is inside `[role="dialog"]`. (Overlay has four interactive stops — Minimise, End, Pause, Stop — so 12 iterations cycles the trap three times.)
2. **Shift+Tab trap** — 6 consecutive `Shift+Tab` presses with the same assertion. Catches the "Shift+Tab sneaks back to the page chrome" class of FocusScope regression.
3. **Esc closes** — `page.keyboard.press('Escape')` then `await expect(overlay).toBeHidden()`. Routed through our `onOpenChange(false) → minimise()` handler.
4. **Focus restored** — `expect.poll(...).not.toBe('body')` on `document.activeElement.tagName`, 8s timeout. Weakest assertion that still catches the real failure (focus dumped to `<body>`).

The trigger is activated via `startButton.focus()` + `keyboard.press('Space')` rather than `.click()` — Chromium's synthetic MouseDown can briefly leave focus unpinned between pointerup and the React state flush, which races Radix's open cycle.

Also in this commit: a deterministic `onCloseAutoFocus` handler on the RecordingOverlay's `DialogContent` that explicitly focuses the FAB (matches either `aria-label="Start recording"` or `aria-label="Open recording overlay"`, since the label flips with the post-minimise recording state). This defends against the async-`start()` race where Radix's default restore (read `document.activeElement` at open-time) captures `<body>` as the restore target. See the "Why" section below for the full reasoning.

Two small companion fixes: `aria-describedby={undefined}` on the recording-overlay and observation-sheet `DialogContent`s to silence Radix's "Missing Description" warning — our dialog bodies are too dynamic for a single descriptive sentence (transcript / state / full form) and the Radix-sanctioned opt-out is passing `undefined` explicitly.

---

## Verification

```
$ cd web && npx vitest run
 Test Files  9 passed (9)
      Tests  73 passed (73)

$ npx tsc --noEmit
# clean

$ npx eslint .
# 0 errors, 6 pre-existing warnings (unchanged)

$ npx playwright test --project=chromium
  ✓  smoke › login page renders
  ✓  record flow (stubbed WS) › start → pause → resume → stop transitions cleanly
  ✓  record flow (stubbed WS) › overlay traps Tab, Esc closes it, focus restores to the trigger
  ✓  record flow (stubbed WS) › ATHS pulse respects prefers-reduced-motion
  4 passed
```

Pre-existing lint warnings (unchanged from Wave 2b): 5 `react-hooks/exhaustive-deps` on `job/[id]/{design,extent,inspection,installation,supply}/page.tsx` + 1 unused `_certificateType` in `job-tab-nav.tsx`. Tracked for a future polish wave.

---

## Why this approach

**Thin wrappers, not a kitchen-sink component.** Every Radix `Dialog.*` part is surfaced; each caller composes them. This keeps the sweep in Part B a structural 1:1 mapping rather than a rewrite, and keeps the primitive file under 170 lines with single-purpose exports. A future "kitchen sink" `<AppDialog>` can layer on top if it earns its keep — bottom-up is easier to evolve than top-down.

**The `unstyled` escape hatch.** `DialogContent` has a centred-card default, but the recording overlay is a full-height bottom sheet on mobile + centred card on desktop, and the observation sheet is a full-form bottom sheet. Both need the Radix focus-trap / portal / aria-modal spine but NOT the visual defaults. A `unstyled` prop lets them opt out of visual styling while keeping a11y. Rejected alternative: a separate `<UnstyledDialog>` component — two components = two imports = drift over time.

**`window.confirm` banishment.** Replaced at all three call sites (`staff delete`, `admin unlock`, `system discard`). `window.confirm` is rejected because (1) flat OS chrome against our dark surface palette is jarring, (2) on iOS Safari it can race with a pending fetch and fire the confirm handler twice, (3) it doesn't honour `prefers-reduced-motion` or our focus-visible rings.

**`ConfirmDialog` intentionally narrow.** Binary confirm/cancel only. Forms that need their own Submit button (invite employee, reset password, observation edit) go through the lower-level `Dialog` primitives directly. This stops `ConfirmDialog` growing into a kitchen-sink modal component by accretion.

**Outside-click blocked only on the recording overlay.** Form sheets (invite, reset password, observation) leave the scrim as a welcome escape hatch — forms are short and their local state is discarded on close. Recording is session-scoped and the scrim is easy to hit accidentally with a palm, so we preventDefault the pointer-down-outside handler there.

**`onCloseAutoFocus` on the recording overlay.** Radix's default focus restoration reads `document.activeElement` at dialog-open-time. Our FAB's click handler calls `start()` (async), which schedules `setOverlayOpen(true)` *before* any await — but the React state flush and Radix's open effect can race, and Chromium can briefly leave focus on `<body>` between pointerup and mount. We take over that handler and deterministically focus the FAB ourselves.

Alternative rejected: plumb a `ref` from `FloatingActionBar` through `RecordingContext` into `RecordingOverlay` so `onCloseAutoFocus` focused a known DOM node. That either leaks DOM concerns into the context (which deliberately has none) or requires a global ref registry. Selecting by `aria-label` is a touch stringly-typed but the two label strings ARE the user-facing copy in the a11y tree — and we now have a Playwright spec proving at least one of them always resolves.

**Playwright spec: `not.toBe('body')` for focus restore.** The RecordingOverlay's minimise-on-Esc keeps the session running, so after Esc the FAB's label is `"Open recording overlay"` — but the label transitions through `"Start recording"` as the state settles. Matching a regex is flaky across those transitions. `not.toBe('body')` is the weakest check that still blows up loudly if restoration ever regresses — `<body>` is the sentinel fallback when no restore target is set.

---

## File inventory

### Added (Part A)
- `web/src/components/ui/dialog.tsx`
- `web/src/components/ui/confirm-dialog.tsx`

### Modified (Part A)
- `web/src/app/globals.css` — `.cm-dialog-overlay` + `.cm-dialog-content` blocks.

### Modified (Part B — sweep)
- `web/src/components/recording/recording-overlay.tsx`
- `web/src/components/observations/observation-sheet.tsx`
- `web/src/app/settings/staff/page.tsx`
- `web/src/app/settings/company/dashboard/page.tsx`
- `web/src/app/settings/admin/users/[userId]/page.tsx`
- `web/src/app/settings/system/page.tsx`

### Modified (Part C)
- `web/src/components/recording/recording-overlay.tsx` — added `onCloseAutoFocus` + `aria-describedby={undefined}`.
- `web/src/components/observations/observation-sheet.tsx` — added `aria-describedby={undefined}`.
- `web/tests-e2e/record.spec.ts` — `.fixme` promoted to `test`; added Shift+Tab loop, Esc assertion, focus-restore assertion; activation switched to `focus()` + Space.

---

## Holdouts / deliberately out of scope

- **Phase 6c admin-user deactivate modal.** Per the user's scope exclusion — it ships with the 6c batch using `<ConfirmDialog confirmVariant="danger">` directly.
- **WebKit focus-trap spec coverage.** The whole `record.spec.ts` describe-block skips on WebKit because headless WebKit can't fake a microphone stream (no equivalent to Chromium's `--use-fake-device-for-media-stream`). Radix's focus trap works identically across engines, so the Chromium spec is representative; the skip is documented inline.
- **`tailwindcss-animate` plugin.** Not adopted — four keyframes aren't worth the bundle cost. Hand-rolled CSS in `globals.css` keyed off `data-state`.
- **Pre-existing lint warnings (6).** Unchanged; polish wave.

---

## Recommended next unit

Per `FIX_PLAN.md §F`:

- **Phase 6c admin-user deactivate modal port.** One-file change; straight `<ConfirmDialog confirmVariant="danger">` drop-in. Pairs naturally with any Wave 4 touch on that page.
- **D6 integration tests (RTL + MSW).** Now that every dialog shares a single primitive, a `<Dialog>` interaction test suite would cover all six call sites with one harness rather than six. Good candidate for the Wave 4/5 polish batch.
- **`parseOrThrow` variant of the adapter layer** (from Wave 2b's deferred list). Independent of D5; flagged only because it's the next "harden the rebuild" card still open.

---

D5 Radix Dialog sweep landed. Six call sites migrated, focus trap + Esc + restore proven E2E on chromium, zero `window.confirm` calls remaining, zero `<div role="dialog">` patterns remaining outside the primitive file. Phase 6c deactivate deferred as scoped. Worktree at `/Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/agent-a8c12be2` on branch `wave-4-d5-radix-dialog`, commits `3a0b80b` / `4a969a2` / `6a3d616`.
