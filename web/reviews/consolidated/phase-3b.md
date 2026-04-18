# Phase 3b — Circuits tab + iOS action rail (consolidated review)

**Target commit:** `983a294` — `feat(web): Phase 3b — Circuits tab with collapsible cards + iOS action rail`
**Primary file under review:** `web/src/app/job/[id]/circuits/page.tsx` (+492 / −6)
**Reviewers merged:** `reviews/claude/phase-3b.md`, `reviews/codex/phase-3b.md`
**Context:** `reviews/context/phase-3b.md`

---

## 1. Phase summary

Phase 3b replaces the `TabStub` Circuits placeholder with a full client-side editing surface:

- Board-filter pill selector above the grid (rendered only when `boards.length > 1`).
- Right-hand 7-button iOS-style action rail: Add / Delete / Defaults / Reverse / Calculate / CCU / Extract (blue / red / magenta `#ff375f` / pink `#ec4899` / green / orange `#ff9f0a` / blue).
- Collapsible `CircuitCard`s with ref badge + designation + cable/OCPD summary header; expanded card surfaces 5 `SectionCard`s (Identity, Cable, OCPD, RCD, Test readings).
- Polarity as a 3-way `SegmentedControl` (`pass` / `fail` / `na`); OCPD and RCD types as `SelectChips`; everything else as `FloatingLabelInput`.
- Data stored in `job.circuits`; edits go through `useJobContext().updateJob` with immutable array rebuilds, mirroring sibling tabs (Installation / Supply / Board). Add / Delete (per-card) / Reverse are wired; Defaults / Calculate / CCU / Extract stub out to an `actionHint` banner.

Both reviewers agree the shape is correct and parity-directionally sound, but three user-visible behavioural bugs cluster around board filtering, multi-board `reverse`, and the rail's prominent red **Delete** button being a stub despite the commit message claiming it's wired.

---

## 2. Agreed findings

| # | Severity | Area | File:line | Finding |
|---|----------|------|-----------|---------|
| A1 | P0 (Claude) / P2 (Codex) → **P0** | Correctness / UX | `page.tsx:378-383` (Claude) = `page.tsx:190-195` (Codex, pre-reflow) | Rail's red **Delete** button calls `stub('Delete all')` — does nothing. Commit message says Delete is wired; it is not. Prominent destructive affordance is a no-op. |
| A2 | P0 (Claude) / P1 (Codex) → **P0** | Correctness / data integrity | `page.tsx:98-100` (Claude) = `page.tsx:85-87` (Codex) | Board filter keeps rows where `board_id == null` visible under every board pill. In multi-board jobs, unassigned circuits appear under every board; there is no "All" pill and no way to clear `selectedBoardId` back to `null`. Cross-board circuits can become orphaned/uneditable. |
| A3 | P0 (Claude) / P2 (Codex) → **P1** | Correctness | `page.tsx:121` (Claude) = `page.tsx:108` (Codex) | `reverse()` mutates the entire `circuits` array regardless of the active board filter, reordering invisible circuits on other boards. Should be scoped to the active board and merged back with untouched rows. |
| A4 | P1 (both) | Correctness / parity | `page.tsx:110` (Claude) = `page.tsx:96-100` (Codex) | New `circuit_ref` is derived from `visible.length + 1`. Produces duplicates after deletes, renames, or board filtering. Codex adds that downstream `applyCcuAnalysisToJob` (`web/src/lib/recording/apply-ccu-analysis.ts:214-245`) matches by `circuit_ref` per board, so duplicate refs create ambiguous merges and can attach extracted data to the wrong row. Should compute `max(parseInt(ref)) + 1` over the active board. |
| A5 | P1 (both) | Code quality / types | `page.tsx:49`, `page.tsx:91,103` | Local `type Circuit = Record<string, string \| undefined> & { id: string }` + `as unknown as Circuit[]` escape hatches throw away the `CircuitRow` shape from `src/lib/types.ts:211-215`, making field-key typos undetectable. Tighten `CircuitRow` and drop the double cast. |
| A6 | P1 (both) | A11y | `page.tsx:473-478` (Claude) = `page.tsx:269-301` (Codex) | Expand toggle has `aria-expanded` but no `aria-controls` and the panel has no matching `id`. Screen readers announce state without target. |
| A7 | P1 (Claude) / P2 (Codex, implicit via no tests) → **P1** | Perf | `page.tsx:98-100,452-701` (Claude) = `page.tsx:89-94,169-178` (Codex) | `CircuitCard` is not memoised and per-row handlers (`onPatch / onToggle / onRemove`) are fresh closures every render. For ~30 circuits × ~15 inputs per expanded card, every keystroke re-renders the full list. `useCallback` + `React.memo` is the fix. Not blocking for small jobs. |
| A8 | P1 (both) | Test coverage | repo-wide | Zero tests landed with Phase 3b. Board filter semantics, add/remove/reverse, ref uniqueness, polarity and chip behaviour all untested. Minimum suite: `addCircuit` inserts with board-scoped ref; `removeCircuit` is idempotent and clears `expandedId`; `reverse` preserves other boards' order; board filter renders ≥1 card per board. |

---

## 3. Disagreements + adjudication

**D1. Severity of the Delete stub (A1).** Claude rates P0 ("silent data-loss shaped bug on a red button"); Codex rates P2 ("per-card trash already works, so misleading but not catastrophic"). **Adjudicated: P0.** The button is red, labelled Delete, sits on a primary workflow surface, and the commit message explicitly says it is wired. First-time users will tap it, see a hint banner, and either repeat-tap or lose confidence. The workaround (per-card trash) is not a substitute for the rail affordance the commit advertises.

**D2. Severity of `reverse` cross-board mutation (A3).** Claude P0; Codex P2. **Adjudicated: P1.** It is a genuine correctness bug and should be fixed before heavier multi-board data starts flowing, but by itself it only affects ordering (never field values), and a user who then saves can in principle re-reverse. P0 is overstated; P2 understates the silent-mutation angle.

**D3. Severity of `circuit_ref` collisions (A4).** Both P1. Agreed, but Codex's observation that `apply-ccu-analysis.ts:214-245` uses `circuit_ref` as a per-board merge key (verified) upgrades the downstream impact — extracted CCU/document data can land on the wrong row. Keep as **P1** but flag as a parity-risk dependency for Phase 5b.

**D4. Polarity wire format (`'pass' | 'fail' | 'na'` vs iOS `"Yes" / "No" / "N/A"`).** Claude-only P1 (§3.8). Codex does not raise it. **Adjudicated: keep as P1 pending verification.** This is exactly the parity-drift class the commit message claims to close; an iOS↔web round-trip will silently drop the field if the backend does not normalise. Listed below in Claude-unique and added to the top-3 because of its parity blast radius.

**D5. Missing iOS fields (Claude §3.10, "28 not 29": AFDD, `phases`, `Zs_limit_80pct`, notes, IR continuity chip).** Claude-only P2. **Adjudicated: P2.** Commit message's "all ~29 fields" is defensible with `polarity_confirmed` + `id`, but AFDD is a real EICR column on recent iOS builds and worth a verification pass before closing the Phase 3 parity story.

**D6. Component-level a11y (segmented-control, select-chips keyboard nav).** Codex-only (§6). Claude flags the circuit-page a11y but not the underlying components. **Adjudicated: P1, scoped as component-level work, not a 3b blocker.** These components predate 3b; however 3b is the first screen to lean on them for two roles (polarity + OCPD/RCD). Fix once in the component, not per-caller.

---

## 4. Claude-unique findings

| # | Severity | File:line | Finding |
|---|----------|-----------|---------|
| C1 | P1 | `page.tsx:64-68`, `page.tsx:691` | **Polarity domain mismatch with iOS.** Web emits `'pass' | 'fail' | 'na'`; iOS `Circuit.swift`'s `polarity_confirmed` typically serialises `"Yes" / "No" / "N/A"`. Either normalise backend-side or switch the web payload. Silent parity drift. |
| C2 | P1 | `page.tsx:472-502` | Expand toggle has no `aria-label` — announcement on an untitled empty row reads "— Untitled circuit, expanded". Prefer `aria-label={`Circuit ${ref}: ${designation}, expand details`}`. |
| C3 | P1 | `page.tsx:465`, throughout | Inputs always write `''` on clear via the `text()` helper instead of deleting the key, producing `""` in the payload rather than field absence. iOS optionals distinguish — decide + document (suggested: `onPatch({ k: v || undefined })`). |
| C4 | P1 | `page.tsx:494-501` | Trash-icon hit area is `h-8 w-8` (32×32) — below the WCAG 2.1 touch target (44×44) on a mobile-first tab. Bump to `h-10 w-10` plus padding. |
| C5 | P1 | `page.tsx:441-444` | Rail button colour contrast: white text on `#ff9f0a` (~2.5:1), `#ec4899` (~3.4:1), `#ff375f` (~3.5:1) fails WCAG AA even at the 3:1 large-text threshold (orange especially). Add a dark text shadow or switch to dark text on those three variants. |
| C6 | P1 | `page.tsx:490` | `rating_a` summary line renders `'0 A'` when `rating === '0'` (truthy string). Guard with `rating && Number(rating) > 0`. |
| C7 | P2 | `page.tsx:371` | `aside` is weak semantics for the action rail (it is primary, not tangential). Use `<div role="toolbar" aria-label="Circuit actions">` to get arrow-key toolbar semantics. |
| C8 | P2 | `page.tsx:387,390,400` | `#ff375f` and `#ec4899` are hardcoded hex; `#ff9f0a` duplicates `var(--color-status-processing)` in `globals.css:34`. Tokenise as `--color-accent-magenta` / `--color-accent-pink` and reuse the existing orange token. |
| C9 | P2 | `page.tsx:72` | `globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random()}`` — fallback is dead code in the Next 16 browser matrix and the `Math.random()` path can collide under network-synced adds. Drop it. |
| C10 | P2 | `page.tsx:123` | `stub(label)` allocates a new closure on every render for each rail button. Move the stub map module-level. |
| C11 | P2 | `page.tsx:92` | `JobProvider` resets state on every `initial` change (`job-context.tsx:51`); parent must pass a stable reference or this tab remounts. Not introduced by 3b but surfaced. |
| C12 | P2 | file size | `page.tsx` is 701 lines in the working tree. Split `CircuitCard`, `RailButton`, and option constants into `components/job/circuits/*` siblings as recording did. |
| C13 | P2 | missing fields audit | iOS fields not represented on the card: `phases` / phase type, `Zs_limit_80pct`, `notes`/`remarks`, AFDD (BS EN + rating), IR continuity pass/fail chip. Commit claim of "~29 fields" lands closer to 28. |
| C14 | Note | `page.tsx` | "No XSS, no secret exposure, client-side-only file pickers with `disabled` guards against double-submit." — explicit security clearance. |
| C15 | Note | `page.tsx` | `:focus-visible` outline may be swallowed by rail button `shadow-[0_4px_12px_rgba(0,0,0,0.35)]`; verify the keyboard focus ring remains visible. |
| C16 | Note | across | `'pass' | 'fail' | 'na'` should be a named `PolarityValue` alias colocated with `POLARITY_OPTIONS`. |
| C17 | Note | parity | Installation/Supply use `showCodeChip` on their last card; Circuits does not. Trivial inconsistency with the "match the form-card pattern" claim. |

---

## 5. Codex-unique findings

| # | Severity | File:line | Finding |
|---|----------|-----------|---------|
| X1 | P1 | `web/src/components/ui/segmented-control.tsx:47-77` | Component uses `role="radiogroup"` / `role="radio"` but does not implement arrow-key roving focus. Phase 3b's polarity control inherits the gap. |
| X2 | P1 | `web/src/components/ui/select-chips.tsx:51-121` | Component header comment claims keyboard nav but there is no `onKeyDown` for arrow / Enter / Escape. Phase 3b relies on this for OCPD and RCD type selection. |
| X3 | P1 (parity) | `web/src/lib/recording/apply-ccu-analysis.ts:214-245` | Downstream merge logic matches circuits by `circuit_ref` per board — amplifies the severity of A4 (ref collisions can attach extracted data to the wrong row). |
| X4 | Note | `page.tsx:112-219` | Expanded card content mounts only for the active circuit (good); remaining re-render cost is top-level list churn, not hidden DOM. |

---

## 6. Dropped / downgraded

- **Claude §3.1 Delete stub severity** — kept at P0 (see D1); not dropped but explicitly adjudicated over Codex's P2.
- **Claude §3.3 reverse severity** — downgraded from P0 → P1 (see D2).
- **Claude §3.14 `Math.random()` id fallback** — kept as P2 note; Claude's own review concedes it is "pure paranoia", not a security issue.
- **Claude §3.15 perf observation** — merged into agreed A7 rather than listed separately.
- **Codex §7 "commit message overstates Delete status"** — absorbed into A1 rather than listed as a separate code-quality item (it is the same bug).
- **Codex §5 "rebuilds full circuits array on every keystroke"** — merged into agreed A7.

---

## 7. Net verdict + top 3

**Verdict: Ship with fixes.** Phase 3b nails the visual language, data shape, and form-card parity pattern. All P0/P1 issues are bounded to `page.tsx` (plus two component-level a11y gaps in `segmented-control.tsx` / `select-chips.tsx`) and collectively are well under 200 LOC. Nothing here requires a rewrite, but the three board-scoped bugs will bite the moment multi-board or CCU-merge data flows through the tab in Phase 5.

**Top 3 priorities (in order):**

1. **A1 + A2 — Delete rail button + board-filter orphaning.** Wire the red Delete (confirm + clear active-board circuits) or relabel + mark stub; add an explicit **All** pill so `selectedBoardId === null` shows every circuit. Both are silent-data-shaped bugs on the flagship tab.
2. **A4 + C1 — `circuit_ref` collision on Add + polarity wire-format parity.** Compute next ref from `max(parseInt(refs)) + 1` per active board (prevents `apply-ccu-analysis.ts` misattribution); verify iOS `polarity_confirmed` serialisation and align the web payload (`'Yes' / 'No' / 'N/A'` or equivalent) before Phase 5 capture flows lock the contract.
3. **A3 + A6 + C4 + C5 — scope `reverse` to active board; a11y polish.** Merge `reverse()` with untouched-board rows; add `aria-controls` + `id` linkage and a descriptive `aria-label` on the expand toggle; bump trash to 44×44; fix rail-button contrast on orange / pink / magenta variants. These are the polish gaps that fail real-device QA.
