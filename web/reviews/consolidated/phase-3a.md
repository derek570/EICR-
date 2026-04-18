# Phase 3a Consolidated Review — Installation, Supply, Board tabs

**Commits reviewed:** `25580d8` (tabs), `7a1fdd7` (primitives)
**Branch:** `web-rebuild`
**Sources:** `reviews/claude/phase-3a.md`, `reviews/codex/phase-3a.md`, `reviews/context/phase-3a.md`
**Method:** cross-referenced both review files against working-tree source via Read/Grep. No source was modified. Where the two reviewers contradicted each other, the actual files were read to adjudicate.

Files in scope:
- `web/src/app/job/[id]/installation/page.tsx` (400 lines)
- `web/src/app/job/[id]/supply/page.tsx` (403 lines)
- `web/src/app/job/[id]/board/page.tsx` (339 lines)
- `web/src/components/ui/section-card.tsx`
- `web/src/components/ui/floating-label-input.tsx`
- `web/src/components/ui/segmented-control.tsx`
- `web/src/components/ui/select-chips.tsx`
- `web/src/components/ui/numeric-stepper.tsx`
- `web/src/lib/job-context.tsx`

---

## 1. Phase summary

Phase 3a replaces three stub routes (Installation, Supply, Board) with real editable form tabs and introduces five reusable form primitives. The UI surface mostly tracks the plan: iOS-parity layout and field set, hero banners with certificate-flavoured gradients, EICR-only conditional cards, a multi-board pill selector with Add/Remove, and semantic-accent `SectionCard`s.

Network persistence is explicitly deferred to Phase 4; every field calls `updateJob` to merge locally and flips `isDirty`. Visual verification (40 screenshots, 10 tabs × 2 cert types × 2 viewports) is claimed in the commit body and was not re-run here.

The two reviews converge on the same top-line conclusion — the surface looks right — but diverge sharply on what the most important defects are. Claude focuses on internal correctness (stale closure in `updateJob`/`patch`, `activeId` desync on Board, a11y contract violations in `SegmentedControl`/`SelectChips`). Codex focuses on the data-model seam: the tabs read `job.installation` / `job.supply` / `job.board`, but the backend at `src/routes/jobs.js:575` still serves `installation_details` / `supply_characteristics` / `board_info` / top-level `boards`. Both classes of defect are real and independently verifiable.

---

## 2. Agreed issues

Both reviewers flagged these. Severity is the higher of the two where they disagree.

| Sev | Area | Location | Finding |
|-----|------|----------|---------|
| P1 | Correctness / state | `installation/page.tsx:98-107` | `next_inspection_due_date` recomputes only when the years stepper changes. Editing `date_of_inspection` afterwards leaves a stale due date; clearing years leaves the stale due date too. Should derive deterministically from both inputs. |
| P1 | Data model | `supply/page.tsx:144-160` | Means-of-earthing stored as two booleans (`means_earthing_distributor`, `means_earthing_electrode`). Two booleans for one radio-group choice is fragile: can represent invalid "both true" state; no other consumer in the repo speaks these keys. Store as a single enum or map at the boundary. |
| P1 | A11y | `segmented-control.tsx:33-79` (Claude) / `:47` (Codex) | `role="radiogroup"` + `role="radio"` + `aria-checked` are wired, but **no keyboard handler** — no arrow-key traversal, no roving tabindex. Fails WCAG 2.1.1 (Keyboard). Affects every Yes/No toggle on Installation and the polarity/earthing toggles on Supply. |
| P1 | A11y / doc drift | `select-chips.tsx:3-18` | The docblock promises "Keyboard nav: arrow up/down while open, Enter to commit, Esc to close" but **no key handlers exist**. Either implement or delete the comment. |
| P2 | Primitive drift | `installation/page.tsx:370-399` and `board/page.tsx:301-307` | `MultilineField` defined locally on Installation + a separately-styled inline `<textarea>` on Board. Contradicts the commit's "every tab from the same primitives" claim. Extract `FloatingLabelTextarea`. |
| P2 | Performance | `select-chips.tsx:85,127` | Every option renders twice (dropdown list + chip row) on every render. Fine at current scale; flagged for Phase 3b (larger option lists). |
| P2 | A11y | `board/page.tsx:102-139` | Board-selector pills are plain `<button>`s with no `aria-pressed` / `role="tab"` / `aria-selected`. Screen readers see an unlabelled row of buttons. |
| P2 | Tests | repo-wide | No frontend tests exist for these tabs or primitives. Visual verification only. |

---

## 3. Disagreements and adjudication

### D-1. The P0 that got missed (or didn't) — data-shape mismatch vs. stale-closure merge

Claude's top P0 is a React stale-closure bug in `updateJob` + each tab's `patch` callback. Codex doesn't mention it, and instead raises a P1 hydration mismatch that Claude never considered.

**Adjudication: both are real; Codex's is the higher-severity one.**

- **Verified stale closure (Claude's P0-1):** `job-context.tsx:55-58` defines `updateJob` as `setJob((prev) => ({ ...prev, ...patch }))` — the *top-level* setter uses the updater form correctly. But every tab's `patch` still captures `details` / `supply` / `boards` from render scope, pre-merges, and passes the merged blob in. Two `patch` calls in the same render see the same snapshot, and the second loses the first's write. The bug is real, but localised to the page-level merge, not the context. Upgrading severity to **P0** is defensible once Phase 4 wires server broadcasts; until then it's a **P0 for burst edits / debounced save** scenarios Phase 4 will introduce.

- **Verified shape mismatch (Codex's P1 #1-2):** Confirmed via Read. `src/routes/jobs.js:585-587` returns `installation_details`, `supply_characteristics`, `board_info`, and top-level `boards`. The three pages read `job.installation`, `job.supply`, `job.board` (e.g. `installation/page.tsx:88`, `supply/page.tsx:44`, `board/page.tsx:63-65`). `Grep` confirms the backend keys appear in `apply-document-extraction.ts` (`:384`, `:389`, `:394`) and `types.ts:351-353` but are *never* mapped into `job.installation`/etc. anywhere in the client. The tabs will render blank on any real fetched job. **This should be reclassified P0.**

Net: **two independent P0s**, not one. Claude's is a write-path bug (Phase 4 will amplify); Codex's is a read-path bug that breaks the feature now.

### D-2. `activeId` + fallback-memoisation bug on Board

Claude flags as P0-2: `[newBoard()]` is a new array with a fresh `randomUUID` on every render, so once `boardState.boards` hydrates empty-but-present, `activeId` points at a UUID that no longer exists; writes then create a new synthesised row each time. Codex does not raise this at all.

**Adjudication: retain as P0.** Verified at `board/page.tsx:64-68` — the fallback is re-invoked each render, and `useState` only runs its initializer once. Claude's reading is correct. Compounded by Codex's own point that the synthesised board hides persisted data — the two bugs interact: real `boards` (if they arrive at top-level) are ignored, *and* the synthesised fallback is unstable.

### D-3. Staff hint card

Codex flags as P1 (misleading): the handoff asked for a link to `/staff`; the implementation is a decorative `SectionCard` only. Claude only mentions the `CheckCircle` icon being semantically wrong.

**Adjudication: retain Codex's finding at P2.** Confirmed at `installation/page.tsx:351-358` — the card has subtitle text but no `href` / `onClick` / `<Link>`. Gap vs. plan, not a correctness bug. Claude's icon note stands as a sub-item.

### D-4. `SupplyShape = Record<string, string | boolean | undefined>`

Claude raises as P2-2 (typing too loose, hides key typos). Codex does not flag.

**Adjudication: retain Claude's finding at P2.** Verified at `supply/page.tsx:26`. Legitimate observation; low severity in isolation.

### D-5. `NumericStepper` text-input not clamped

Claude raises as P1-7. Codex doesn't flag.

**Adjudication: retain Claude's at P1.** Verified at `numeric-stepper.tsx:54-60`: chevrons clamp via `commit`, text `onChange` calls `onValueChange(n)` directly. Real correctness bug.

### D-6. Accent colour drift (magenta hard-coded hex)

Claude raises as P1-4: `section-card.tsx:34` uses `#ff375f` instead of `--color-status-limitation: #bf5af2`. Codex doesn't flag design-token drift.

**Adjudication: retain at P1.** Raw hex in a file whose sole job is semantic theming is the strongest single predictor of future drift.

---

## 4. Claude-unique findings (retained)

Items only Claude flagged. Severity as assigned by Claude unless noted.

1. **P0-1 — stale-closure merge in each tab's `patch`** (`installation/page.tsx:90-95`, `supply/page.tsx:46-51`, `board/page.tsx:70-77`). Adjudicated above (D-1). Retained as **P0** — will bite Phase 4.
2. **P0-2 — `activeId` + fallback-memoisation bug on Board** (`board/page.tsx:64-68`). Adjudicated above (D-2). Retained as **P0**.
3. **P1-1 — shallow merge + per-tab-local snapshot loses sibling keys** (follow-on from P0-1). Mostly latent; fix for P0-1 also fixes this.
4. **P1-7 — `NumericStepper` text path doesn't clamp to `[min,max]`** (`numeric-stepper.tsx:54-60`).
5. **P1-4 — accent colour drift: `magenta` hard-coded hex + `amber` reusing `--color-status-processing`** (`section-card.tsx:29-35`).
6. **P2-1 — `NumericStepper` doesn't forward ref** — Phase 3b Circuits will need focus management on numeric fields.
7. **P2-2 — `SupplyShape` too loose** (`supply/page.tsx:26`).
8. **P2-3 — `Date.now()` id fallback** (`board/page.tsx:55`). Low-probability collision; use `Math.random().toString(36).slice(2)`.
9. **P2-4 — N/A chip on Other bonding** (`supply/page.tsx:338-351`) — iOS blanks the text when N/A; web doesn't.
10. **P2-5 — Hero banner copy-pasted three times** (Installation inline, Supply + Board each with their own `HeroBanner`). Extract to primitive.
11. **P2-6 — `FloatingLabelInput` missing `aria-invalid` / `aria-describedby`** when `state='error'` or `hint` is set.
12. **P2-7 — `MultilineField` visual drift vs `FloatingLabelInput`** (different padding, no focus-ring-width match).
13. **A11y — `SegmentedControl` pass/fail/limitation variants rely on colour alone** (WCAG 1.4.1).
14. **A11y — `SelectChips` chips at `px-2.5 py-0.5` ≈ 24×20 px touch target**, below the 44×44 minimum from global design rules.
15. **A11y — `NumericStepper` missing `role="spinbutton"` + `aria-valuenow/min/max`.**
16. **A11y — `FloatingLabelInput` focus ring is a 1px border-colour change**; design system requires 2px+ focus ring.
17. **A11y — `prefers-reduced-motion` not respected on `SegmentedControl` `active:scale-[0.98]`.**
18. **Code quality — magic `maxWidth: '960px'` inline style in all three tabs** should be a Tailwind utility or design token.
19. **Code quality — `CheckCircle` icon on Staff hint card is semantically wrong** (suggests "done"; use neutral `UsersRound`).
20. **Chip-row dual-source in `SelectChips`**: code lets chips be clicked (line 133 `onClick={() => onChange(opt.value)}`) even though the header comment says chips are decorative. Comment and code disagree.

---

## 5. Codex-unique findings (retained)

Items only Codex flagged.

1. **P1 (adjudicated to P0) — frontend/backend shape mismatch**: pages read `job.installation` / `job.supply` / `job.board`; backend returns `installation_details` / `supply_characteristics` / `board_info` + top-level `boards` (`src/routes/jobs.js:575`). On real fetched jobs, forms render blank even when data exists. **Highest-priority item of the phase.**
2. **P1 (adjudicated to P0) — Board tab hides persisted data**: `board/page.tsx:64-65` only consults `job.board.boards`; the backend's top-level `boards` and `board_info` are ignored. Couples with the shape mismatch above.
3. **P1 — Staff hint card is decorative-only** despite handoff spec calling for a link to `/staff`.
4. **A11y — Board notes `<textarea>` has no programmatic label** (`board/page.tsx:301`) — only a section heading and placeholder. Placeholder text is not a label.
5. **Code-quality — duplicate/contract-drifting shapes**: page-local `InstallationShape` / `SupplyShape` / `BoardShape` don't share a source of truth with `types.ts` or `apply-document-extraction.ts`. Central-mapping or API-boundary normalisation recommended.
6. **Performance — every keystroke rerenders the entire active page** because the context stores the full `job`. Acceptable now; realistic latency concern on low-end devices as tabs grow.

---

## 6. Dropped or downgraded

- **Claude: "`updateJob` shallow merge loses sibling keys" as an independent P1 (P1-1).** Downgraded to a note on P0-1: the root-level `setJob` updater form is correct; the bug is the per-tab `patch` pre-merge. Fixing P0-1 (pass a field-level updater) closes this.
- **Claude: `Date.now()` id fallback collision (P2-3).** Kept but noted low probability — two `newBoard()` calls within the same millisecond is the trigger, realistic only in keyboard-driven test harnesses.
- **Codex: performance concern about whole-job rerender.** Kept at P3 / informational — not currently observable; revisit in Phase 3b once Circuits scales up.
- **Claude: accent "amber" token rename.** Retained as P2 (alias-only), below the hard-coded hex issue which is P1.
- **Neither reviewer flagged:** a `package.json` / workspace change, a public API break, or a security surface. Confirmed: no new `dangerouslySetInnerHTML`, no new auth paths, no secret logging. Security section is empty by both reviewers and remains so here.

---

## 7. Net verdict + top 3

**Verdict: Needs rework before Phase 3b.**

The UI surface and primitive factoring are solid. But two independent P0 defects sit on the same code: a read-path bug that stops the tabs hydrating real jobs, and a write-path bug that will silently drop edits once Phase 4 lands shared server broadcasts. The `Board` tab compounds both — it hides persisted data behind a synthesised `DB1` *and* its `activeId` drifts from the boards array.

Claude's review is stronger on internal React correctness and WCAG detail; Codex's is stronger on the data-model seam to the backend. The consolidated picture is that Codex caught the bigger bug (hydration), and Claude caught the more-subtle-but-also-production-impacting one (stale-closure merge + `activeId` drift).

### Top 3 priorities (in order)

1. **Fix the job-shape mismatch (Codex P1 → P0).** Either normalise the API payload to `installation` / `supply` / `board` inside `JobProvider`, or change the tabs to read `installation_details` / `supply_characteristics` / `board_info` + top-level `boards`. Also fix Board hydration to honour existing `boards` / `board_info` instead of synthesising `DB1`. **Without this, the phase doesn't actually work on real data.**

2. **Fix the stale-closure merge + Board `activeId` drift (Claude P0-1, P0-2).** Expose an updater-form `updateJob((prev) => patch)` and rewrite each tab's `patch` callback to use it. Memoise the Board fallback (`useMemo(() => newBoard(), [])`) and sync `activeId` via a `useEffect` keyed on the real boards list. Phase 4's server broadcasts will surface this race; better to land the fix first.

3. **Make `SegmentedControl` keyboard-operable and either implement or delete `SelectChips`'s "keyboard nav supported" comment (both reviewers, P1).** These are the two accessibility regressions that hit a real user first and the two places where existing code disagrees with its own documentation. Arrow-Left/Right/Home/End on `SegmentedControl` with roving `tabIndex`; on `SelectChips`, either ship Arrow/Enter/Esc handling or strip the comment and accept that chips + dropdown are the full interaction surface.

Deferrable to a dedicated Phase 3b polish / a11y sweep: hero-banner extraction, `FloatingLabelTextarea` primitive, accent-token cleanup, `NumericStepper` text clamp + ref forwarding, touch-target audit, Staff-hint link, colour-only semantics on pass/fail variants, focus-ring width, test scaffolding.
