# Phase 4a — Claude Code Review

**Target commit:** `b0eb64c` — *feat(web): Phase 4a recording overlay + transcript bar scaffold*
**Reviewer:** Claude (Opus 4)
**Scope:** As landed in `b0eb64c`. Later-phase evolutions (4b–4e) noted where relevant but not graded as defects of 4a.

Files in this commit:
- `web/src/app/job/[id]/layout.tsx` (+11/−5)
- `web/src/components/job/floating-action-bar.tsx` (+27/−7)
- `web/src/components/recording/recording-overlay.tsx` (new, 269 lines)
- `web/src/components/recording/transcript-bar.tsx` (new, 57 lines)
- `web/src/lib/recording-context.tsx` (new, 246 lines)

---

## 1. Summary

Phase 4a introduces a `RecordingProvider` React context, a full-sheet `RecordingOverlay`, and a top-docked `TranscriptBar`, wired into the `/job/[id]` layout and the existing `FloatingActionBar` mic button. The code is self-described as a "scaffold only" — there is no real `getUserMedia`, Deepgram, or Sonnet wiring at this commit. A deterministic synth loop (rota of 8 phrases every 2.2 s, summed sines for mic level, 10 Hz ticker for cost/elapsed) drives the visual surface for iOS parity verification.

The work is clean, well-commented, strongly typed, and consistent with the existing `JobContext` pattern (`web/src/lib/job-context.tsx` lines 28, 33, 38, 72). The state machine names (`idle` / `requesting-mic` / `active` / `dozing` / `sleeping` / `error`) match the iOS `SleepManager` vocabulary as claimed, and Phase 4b–4e subsequently reuse them without renaming — a good decision validated by the working-tree `recording-context.tsx`.

There are no P0 correctness bugs. There is one P1 issue (error state cannot be exited without reload on this commit), several P2 polish items, and a handful of accessibility/a11y tweaks that are cheap to fix.

---

## 2. Alignment (with phase-4a.md context + iOS parity mandate)

Goal per context doc: "scaffold overlay + transcript bar without pending on microphone permission or WebSocket dependency".

| Goal | Achieved? | Evidence |
|------|-----------|----------|
| Full-sheet overlay with hero, mic visualiser, transcript log, controls | Yes | `recording-overlay.tsx` lines 64–229 |
| Bottom-sheet on mobile, centred card on desktop | Yes | `recording-overlay.tsx` line 69 (`items-end ... md:items-center`) and lines 72–74 (`rounded-t-... md:rounded-...`) |
| State machine names match iOS SleepManager | Yes | `recording-context.tsx` line 50 |
| Provider scoped to `/job/[id]` layout (unmount = teardown) | Yes | `layout.tsx` line 76, `RecordingProvider` wraps the job shell |
| Synth transcript loop for parity screenshots | Yes | `recording-context.tsx` lines 598–607, 644–662 |
| Mic button in `FloatingActionBar` flips red+pulse when recording | Yes | `floating-action-bar.tsx` lines 151–167 |
| `start()` simulates requesting-mic with 250 ms latency | Yes | `recording-context.tsx` line 672 |
| State/shape forward-compatible with 4b–4e | Mostly | Confirmed by working-tree evolution — the snapshot/actions shape was extended (interim, deepgramState, sonnetState, questions, dismissQuestion) rather than re-shaped. See drift notes in §7. |

Alignment verdict: strong. The scaffold delivers exactly what the context doc promised.

---

## 3. Correctness

### P0 (blocking)

None.

### P1 (should fix)

**P1-1 — `start()` guard blocks recovery from `error` after synth loop is running.**
`recording-context.tsx` line 666: `if (state !== 'idle' && state !== 'error') return;`. This correctly *allows* restart from `error`, BUT when a caller is in `error` state the cleanup that set them to `error` is not present in this commit (there is no code path in 4a that ever transitions to `'error'`; `errorMessage` is initialised to `null` and only reset, never written). So the `error` branch is dead code at this commit. Not a crash, but it means the UI has no way to reach the error-state visuals that are otherwise implemented (`StatePill` `case 'error'` line 371, transcript-log error branch lines 323–324). Either wire a deliberate synthetic error path for visual verification, or acknowledge the gap in the context doc. (This is fixed naturally in 4b+ once real `getUserMedia` can throw.)

**P1-2 — `pause()` disables `tick` timer but does not disable `utter` timer.**
`recording-context.tsx` lines 689–693: `pause` calls `clearTimers()` which nukes both timers (lines 624–628). Actually fine — re-read. No bug here. WITHDRAW.

**P1-2 (replacement) — `resume()` re-creates the synth loop starting `t` at 0.**
`beginSynthLoop` (line 632) declares `let t = 0` fresh on every call, so after pause→resume the mic-level waveform restarts from its zero phase even though `elapsedSec` continues from where it left off. Visually the VU meter "jumps" at resume. Minor, scaffold-only, but worth noting because the same function is invoked from both `start` and `resume` (line 698) and would have the same glitch in production if the real RMS source were ever briefly stalled during resume. Post-4b this is moot (real RMS replaces the synthesiser).

### P2 (nice to have)

**P2-1 — Stale-closure risk in `pause`/`resume` guards.**
`pause` (line 689) and `resume` (line 695) read `state` from the closure. In practice each re-creates via `useCallback` when `state` changes, but the `pause`/`resume` dependency arrays list `[state, ...]` correctly, so there's no actual bug. Flag only because future refactors that drop those deps would silently break the guard.

**P2-2 — `transcript` cap is on append, not on render.**
Line 660: `return next.length > 10 ? next.slice(next.length - 10) : next;` — correct. But `recording-overlay.tsx` line 59 further caps to 6 with `.slice(-6).reverse()`. Two caps in two places is fine but consider a single source of truth (context snapshot exposes only the N most recent) so the `TranscriptBar` and overlay can never disagree about what "latest" means.

**P2-3 — `formatCost` rounds to 2 dp but comment says "rounds to nearest cent".**
Line 759–763: `toFixed(2)` truncates by banker's rounding rules for floats, not strictly "nearest cent". Usually identical, but `$0.005` will show `$0.01` on most inputs and `$0.00` on some — flag if the inspector-visible readout ever misreports. Negligible for Phase 4a.

**P2-4 — `minimise` should not be exposed when `!isOverlayOpen`.**
`RecordingActions.minimise` is always exposed. Calling it while minimised is a no-op but re-renders. Harmless. Could be guarded in the callback for cleanliness.

**P2-5 — `start()` resets transcript *after* `setState('active')`.**
Lines 672–677: there is a brief render where `state === 'active'` but `transcript` still holds the previous session's data (before the `setTranscript([])` on line 676 batches). In practice React batches these, but the order is counter-intuitive; prefer resetting before flipping state.

---

## 4. Security

**S-1 — No external inputs in this commit.** The scaffold does not touch `fetch`, `getUserMedia`, `WebSocket`, `localStorage`, or any network surface. Synth phrases are hard-coded strings. No XSS surface: transcripts render via React text-children, not `dangerouslySetInnerHTML`.

**S-2 — `role="dialog"` / `aria-modal="true"` with no focus trap.** `recording-overlay.tsx` line 66–68. A real modal should trap focus or at minimum restore focus on close. Mitigating factor: this is a non-interactive overlay sitting over an already-authenticated surface. Not a security concern — purely a11y (see §6).

**S-3 — `backdrop-blur` + `bg-black/60` on the modal.** Fine. No security implications.

No secrets, tokens, or privileged APIs are introduced at this phase.

---

## 5. Performance

**Perf-1 — Two `setInterval`s at 10 Hz and ~0.45 Hz.**
Lines 635 (10 Hz timer) and 646 (every 2.2 s). Both cleared on `stop`/`pause` and on unmount (line 630). Reasonable. 10 Hz is frequent enough to feel live but not so frequent that React chokes. Note the React 19 scheduler will coalesce the `setState` calls in the 10 Hz tick (elapsedSec + cost + micLevel) into one render per tick.

**Perf-2 — `useMemo` over 14 deps (lines 704–735).**
This is the full context value with its own identity. Correct. Each action is already stable via `useCallback`, so the memo will not invalidate on every render — only when a primitive in the snapshot changes (elapsedSec ticking at 10 Hz will invalidate it ~10×/s). Every `useRecording()` consumer will therefore re-render 10 Hz while recording. For 4a that's just the overlay, transcript bar, and floating action bar (which selects `{state, start, expand}` — three primitives, but React will still re-render the FloatingActionBar at 10 Hz because the whole context value changes identity). Not a 4a problem, but flag for Phase 5: consumers that only want `state` will benefit from a `useRecording.selector` pattern or from splitting the context into {snapshot, actions} providers.

**Perf-3 — `visibleTranscript` re-allocates every render.**
`recording-overlay.tsx` line 59: `[...transcript].slice(-6).reverse()`. Cheap (≤6 items) but runs every render. Fine.

**Perf-4 — `ringScale` recomputed every render.**
Line 62. Trivial. Fine.

---

## 6. Accessibility

**A11y-1 — No focus trap / focus restoration on the dialog.** `recording-overlay.tsx` line 66. `role="dialog"` + `aria-modal="true"` tells AT this is modal, but tab focus will escape into the background content. Use Radix `<Dialog>` (already in deps, `@radix-ui/react-dialog`) or a focus-trap implementation. This is the only real a11y gap in 4a.

**A11y-2 — Interim transcript is `italic text-tertiary` only.** (Only relevant in later-phase `interim`, not in 4a.) In 4a, transcript is purely final utterances, so no issue.

**A11y-3 — Transcript region lacks `aria-live`.** `recording-overlay.tsx` line 186. New transcript lines are announced by screen readers only if the region is `aria-live="polite"`. Questions region later added this (working tree line 157), but the transcript-log region never got it. Recommend `aria-live="polite"` + `aria-atomic="false"` on the transcript container.

**A11y-4 — `TranscriptBar` is a `<button>` with truncated text.** `transcript-bar.tsx` line 30–62. Good: the whole bar is a single button with a clear `aria-label="Expand recording overlay"` (line 33). The truncated transcript line inside is decorative for AT purposes — the aria-label carries meaning. OK.

**A11y-5 — Mic button `aria-pressed={recording}` used as a toggle.** `floating-action-bar.tsx` line 150. Semantically questionable — `aria-pressed` is for true toggle buttons (pressed/unpressed state of the same action). Here the button changes *action* (start vs expand), not *state*. Prefer `aria-expanded` (when the overlay can be expanded) or a second hidden `<button>` for the two distinct actions. Minor.

**A11y-6 — `animate-pulse` should respect `prefers-reduced-motion`.** Tailwind's `animate-pulse` keyframes are not gated. Used in `recording-overlay.tsx` line 124 (mic ring) and `floating-action-bar.tsx` line 160 (mic button) and `transcript-bar.tsx` line 41. Per the global rules file, "Respect `prefers-reduced-motion`". Add a `motion-safe:` Tailwind prefix or a media-query-gated CSS variable.

**A11y-7 — Touch target for `HeroIconButton` is 36 px × 36 px.** `recording-overlay.tsx` line 281 (`h-9 w-9` = 36 px). The global rule calls for 44 × 44 px minimum on mobile. Two minimise/close buttons in the hero bar are below the rule.

**A11y-8 — `StatePill` colour of `rgba(255,255,255,0.35)` on gradient hero.** Line 239 / 249. Contrast of ~2.0:1 on the brand-blue-to-green gradient — fails WCAG AA for the small-text pill label. The `bg-black/25` pill for cost readout (line 93) is fine; only the `requesting-mic` and `idle` states of the pill have this issue because they use translucent-white.

**A11y-9 — `ControlButton` disabled state has no AT signal beyond opacity.** Line 317: `disabled && 'cursor-not-allowed opacity-50'`. React will translate `disabled` to the HTML attribute (line 316), so screen readers will announce it. OK.

---

## 7. Code quality & convention drift

**CQ-1 — File/naming conventions consistent with repo.** Matches `job-context.tsx` pattern (module + `Provider` + `useX` + throw guard). Components use kebab-case filenames, TSX extension — consistent with the rest of `web/src/components/`.

**CQ-2 — `recording-context.tsx` evolved significantly post-4a but API stayed backward-compatible.**
- Added to snapshot: `interim`, `deepgramState`, `sonnetState`, `questions`. All additive.
- Added to actions: `dismissQuestion`. Additive.
- Removed from `TranscriptUtterance`: nothing. `confidence: number` was *added* in 4c (working-tree line 59). No renames.
- This is a clean extension story — 4a didn't paint itself into a corner.

**CQ-3 — `SYNTH_PHRASES` are realistic domain content.** Good — a reviewer can eyeball the overlay and see the kind of language that will feed Sonnet. Nice touch: includes a multi-field compound phrase ("R1 plus R2 zero point eight") that'll stress-test the regex+Sonnet fallback later.

**CQ-4 — Inline `style={{ background: ... }}` for dynamic colours.** `recording-overlay.tsx` lines 79, 93, 115, 127, 135, 255, and `StatePill` line 255. Pragmatic — these are conditional gradient/var() values that Tailwind can't express cleanly. Consistent with other files in the repo.

**CQ-5 — Two timers in one ref (`{ tick, utter }`).** Line 619. Reasonable. An alternative would be a single `requestAnimationFrame` loop that also handles the utter cadence, but the double-interval is simpler and the extra timer has negligible cost.

**CQ-6 — Mixed quote styles stay single-quoted.** Matches repo Prettier config.

**CQ-7 — Good commentary on WHY.** Scores well against the CLAUDE.md commit-message rule: both the commit body and the file docstrings answer "why this approach", not just "what".

**CQ-8 — `teardownX` helpers named consistently post-4a.** In 4a there was only `clearTimers`. The working-tree now has `teardownMic`, `teardownDeepgram`, `teardownSonnet`, `teardownSleep` — a good pattern, but the 4a scaffold sets the precedent of a single `clearTimers` callback that the 4b+ pattern then diverges from. Not a 4a problem.

**CQ-9 — `layout.tsx` wraps order.** `<JobProvider>` wraps `<RecordingProvider>`. Correct — later phases' `applyExtraction` reads `jobRef.current` which comes from `useJobContext`, so the recording provider legitimately needs job context as an ancestor.

**CQ-10 — `useRecording` throw message is helpful.** Line 744–747: includes the fix instruction. Matches `useJobContext` (line 33).

---

## 8. Test coverage

No unit or integration tests land in this commit. `web/` has no vitest/jest config in `package.json`, and the repo's `web/` tests rely on `@playwright/test` (dev dep at line 43) — Playwright E2E exists elsewhere but not for this scaffold.

Reasonable for a pure-UI scaffold since the end-goal is iOS visual parity (verified via screenshots per the context doc's intent). But the state machine itself (idle → requesting-mic → active → dozing → sleeping, and the guards in `start`/`pause`/`resume`) is now non-trivial and will grow. A vitest unit test over `RecordingProvider` with React Testing Library, asserting:

1. `start()` transitions idle → requesting-mic → active within ~300 ms.
2. `pause()` from active → dozing, `resume()` from dozing → active, `resume()` from sleeping → active.
3. `stop()` from any non-idle state → idle and clears timers (check via `vi.useFakeTimers()`).
4. `useRecording()` throws outside provider.
5. `start()` is idempotent on `active`/`requesting-mic`/`dozing`/`sleeping` (no-op).

…would lock in the shape the later phases depend on, at ~60 LOC. Cheap insurance.

No Playwright smoke exists for overlay open/minimise/close either. Worth adding one smoke test as the gateway to the 4b–4e pipeline.

---

## 9. Suggested fixes (numbered, file:line)

1. **`recording-context.tsx:672`** — Reset `elapsedSec`/`costUsd`/`transcript` *before* `setState('active')` to avoid a one-frame flicker where state is active but data is stale. Move lines 674–676 above line 673.

2. **`recording-context.tsx:666`** — Either remove `'error'` from the start-guard until a real error path lands in 4b, or add a synthetic error trigger (e.g. dev-only `?recordError=1`) so the error visuals can be QA'd.

3. **`recording-overlay.tsx:186`** — Add `aria-live="polite"` and `aria-atomic="false"` to the transcript-log container so screen readers announce new utterances.

4. **`recording-overlay.tsx:281`** — Bump `HeroIconButton` from `h-9 w-9` (36 px) to at least `h-11 w-11` (44 px) to meet mobile touch-target guideline.

5. **`recording-overlay.tsx:239,249`** — Swap `rgba(255,255,255,0.35)` / `rgba(255,255,255,0.25)` on `StatePill` to an opaque brand-blue or neutral-700 background so the small-text pill clears 4.5:1 contrast on the gradient hero.

6. **`recording-overlay.tsx:124`, `transcript-bar.tsx:41`, `floating-action-bar.tsx:160`** — Prefix `animate-pulse` with `motion-safe:` (Tailwind) or wrap in a `@media (prefers-reduced-motion: no-preference)` block. Respects the global rule + WCAG 2.3.3.

7. **`floating-action-bar.tsx:150`** — Replace `aria-pressed={recording}` with `aria-expanded={recording}` (the overlay is the controlled element; mic-tap toggles its expansion) and add `aria-controls` pointing at the overlay's `id`.

8. **`recording-context.tsx:609`** — Split the context into `{snapshot}` and `{actions}` providers (or move to Zustand) before Phase 5 consumers start subscribing only to `state`. The 10 Hz ticker will otherwise re-render every consumer unnecessarily. This is speculative for 4a but cheap to do while the API is still new.

9. **`recording-context.tsx:598–607`** — Extract `SYNTH_PHRASES` behind a `process.env.NODE_ENV === 'development'` guard, or gate `beginSynthLoop` behind a `if (typeof window !== 'undefined' && SCAFFOLD)` flag, so the 2.2 s synth interval doesn't ship to production builds even for one commit between 4a and 4b. (Moot after 4b replaces it, but 4a sits on `main` briefly.)

10. **`recording-overlay.tsx:66`** — Wrap the dialog body with a focus-trap (the repo already has `@radix-ui/react-dialog` installed; a `<Dialog.Root>` + `<Dialog.Content>` swap would cover focus-trap + Esc-to-close + focus-restoration in one move).

11. **`recording-context.tsx:697–699`** — `resume` should reset `t` in the synth loop to where `elapsedSec` left off (or at minimum continue the sine phase) so the mic-level doesn't jump at resume. Scaffold-only, low priority.

12. **Add** `web/src/lib/__tests__/recording-context.test.tsx` — vitest + RTL coverage of the 5 state-machine assertions listed in §8. Aim: ~60 LOC, run in CI.

---

## 10. Verdict + top 3 priorities

**Verdict: Approve.** Clean, well-commented scaffold that delivers exactly what the context doc promised, establishes a forward-compatible API (validated against 4b–4e in the working tree), and introduces no correctness, security, or performance hazards. The gaps that exist are accessibility polish and test coverage, not architecture.

**Top 3 priorities to action:**

1. **Focus trap on the overlay dialog** (fix #10). It's the only real a11y gap that could bite a keyboard-only user in production, and Radix Dialog is already a dependency — a 5-minute swap.
2. **`aria-live` on the transcript region** (fix #3). One attribute. Makes the whole recording surface accessible to screen-reader users who can't see the transcript flowing by.
3. **Unit-test the state machine** (fix #12). Phase 4b/4c/4d/4e all hang off this scaffold's guards and transitions — locking them in with ~60 LOC of vitest now prevents silent regressions when real audio/WS code gets layered on top.
