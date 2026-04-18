# Phase 3c — Consolidated Review

**Commit:** `88e7c4e` — *feat(web): Phase 3c — Extent, Design, Inspection, Staff, PDF & Observations tabs*
**Sources:** `web/reviews/claude/phase-3c.md`, `web/reviews/codex/phase-3c.md`, `web/reviews/context/phase-3c.md`
**Note:** Claude anchors to commit content but flags working-tree drift on `observations/page.tsx` (Phase 5c version). Codex also reviews commit-strict and flags HEAD divergence.

---

## 1. Phase summary

Phase 3c replaces the five remaining TabStub placeholders plus the observations route with full-surface UIs (Extent, Design, Inspection, Staff, PDF, Observations) and introduces a dedicated `lib/constants/inspection-schedule.ts` (~407 lines) mirroring iOS `Constants.swift`. Visual parity, token usage, and SectionCard accents are consistent with earlier Phase 3a/3b work. Correctness problems cluster around two themes: (a) stale-closure merge patterns on multi-writer sections (inspection chips + future Sonnet), and (b) data-shape drift between the local tab models and the shared/backend contracts (`JobDetail` / `src/routes/jobs.js` / `packages/shared-types/src/job.ts`). No security findings. Zero tests added.

---

## 2. Agreed issues

| Severity | Area | File:line | Issue |
|---|---|---|---|
| P1 | Correctness / Data contract | `web/src/app/job/[id]/staff/page.tsx:71-72,105-153` + `web/src/lib/types.ts:192-207` | Staff tab reads `job.inspectors`, but backend `GET /api/job` returns no such field and `JobDetail` doesn't declare one. Role pickers will render empty in real use. Both reviewers agree; Claude frames as "permissive cast hides drift" (§3.12), Codex frames as functional bug. Codex wins on severity framing. |
| P1 | Correctness / Data contract | `web/src/app/job/[id]/pdf/page.tsx:140-142` | `computeWarnings` reads `data.board?.boards`, but backend returns `boards` at top level (verified: `src/routes/jobs.js:585`). Real jobs will show spurious "No boards added" warning. |
| P1 | Correctness / Data contract | `web/src/app/job/[id]/inspection/page.tsx:42-52,79-111` | Local inspection shape diverges from `packages/shared-types/src/job.ts:81-91` (`items[ref] = { outcome }` + `hasMicrogeneration`/`isTTEarthing`/`markSection7NA` camelCase). Won't round-trip cleanly when save wires up. |
| P1 | Correctness / Data contract | `web/src/app/job/[id]/extent/page.tsx:24-33` | `consumer_unit_upgrade` installation-type is frontend-only; shared type allows only three values and EIC PDF generator (`python/eic_pdf_generator.py:370-380`) only knows three. Will produce invalid persisted data / bad PDF output. |
| P1/P2 | Correctness / State races | `inspection/page.tsx:72-81`, `design/page.tsx:29-33`, `extent/page.tsx:40-44` | Stale-closure nested patch pattern (`{ ...insp, ...next }`) with `updateJob` shallow merging the root. Concurrent same-tick writes (chip tap + upcoming Sonnet stream) will clobber each other. Claude marks P0 specifically for inspection because Phase 4 imminently adds a second writer; Codex marks P2 globally. Adjudicated: **P1** — dormant today, becomes P0 the moment Phase 4 ships. Fix before Phase 4. |
| P2 | Correctness | `inspection/page.tsx:54` + schedule ICONS/ACCENTS arrays | 8 icons/accents defined for a 7-section schedule. Harmless; suggests post-impl cleanup was skipped. |
| P1 | Accessibility | `inspection/page.tsx:269-286` | Toggle switches use `role="switch"` + `aria-checked` with the label as a sibling `<span>` — no accessible name via `aria-labelledby`/`aria-label`. Screen readers announce unlabeled switches. |
| P1 | Performance | `inspection/page.tsx:301-364` + `:183-247` | `ScheduleRow` not memoized; ~90 rows × 8 chips rebuilt per keystroke. Inline arrow handlers (`setOutcome`, `setTTEarthing`, etc.) re-created each render defeating memo. Noticeable on mobile Safari. |
| P2 | Code quality / Typing | `staff/page.tsx:71,75`, `pdf/page.tsx:47` | `as unknown as ...` casts bridge `JobDetail` to tab-local shapes. Both reviewers agree: extend `JobDetail` in `lib/types.ts` with `inspector_id?`, `authorised_by_id?`, `designer_id?`, `constructor_id?` and delete the casts. |
| P2 | Code quality | `staff/page.tsx:302-306` | `Record<string, unknown>` cast to force `style` prop through icon component — widen icon prop type instead. |
| P2 | Test coverage | workspace | No tests added (verified: `Verified` section cites only `tsc --noEmit` and a Playwright visual script). Missing: `computeWarnings` matrix, autofill toggle transitions, schedule-ref parity with iOS, EIC `installation_type` round-trip. |
| P2 | Observations (commit-strict) | `observations/page.tsx:86-94,100-105` (at commit) | Add button disabled with empty state telling users to "Tap Add" — usability + a11y miss. Both note HEAD has since shipped `ObservationSheet` (Phase 5c). |

---

## 3. Disagreements + adjudication

| Topic | Claude | Codex | Adjudication |
|---|---|---|---|
| Stale-closure severity on `inspection/page.tsx` | **P0** — Phase 4 (Sonnet) is the second writer about to land; ship-stopper. | **P2** — current merge pattern is suboptimal but no live second writer exists yet. | Both are correct inside their framing. Today there's no race (Codex). By next phase there is (Claude). Consolidated as **P1 "fix before Phase 4"**, matching Claude's practical risk profile without overstating today's impact. |
| Overall verdict | **Ship it with follow-ups** (issues are narrow + latent). | **Needs rework** (staff tab unusable, model drift will break persistence). | Codex is right that three P1 data-contract bugs make the phase not actually usable end-to-end (empty staff pickers, false PDF warnings, inspection won't round-trip, invalid EIC installation-type value). Claude's view underweights the persistence/contract gap because those bugs are invisible until save/read paths wire up. **Adopt Codex verdict: "Needs rework before Phase 4."** |
| Observations usability | Flags in a11y §6.4 that nested interactive regions are a screen-reader concern (working-tree Phase 5c version). | Flags (commit-strict) that disabled Add button + "Tap Add" empty state is a functional/a11y gap. | Both are valid but about different versions. Keep both, clearly labeled by version. |
| Hero eyebrow contrast (§6.1 Claude) | Claims WCAG AA fail (~2.3:1) on `text-white/75` 11px uppercase over brand gradient. | Silent. | Keep as **Claude-unique P1 a11y**. Claude's contrast math is plausible but not independently verified here; flagged for axe-core verification in the fix list. |
| `Loader2` as idle Generate-PDF icon (§3.7 Claude) | Misleading (looks "generating"). | Silent. | Keep as **Claude-unique P2 UX**. Minor. |
| `ScheduleOutcome` union includes unused `'—'` (§3.8 Claude) | Dead type surface — remove. | Silent. | Keep as **Claude-unique P2**. Verified in source. |
| `inst.address_line1` dead field (§3.6 Claude) | Dead code — schema uses `address`. | Silent. | Keep as **Claude-unique P2**. Verified. |
| Boards top-level shape (Codex) vs board sub-object | Claude cites `pdf/page.tsx:133` for the dead `address_line1` fallback but does NOT flag the `board.boards` vs top-level `boards` mismatch. | Correctly flags. | Codex is right. Verified: `src/routes/jobs.js:585` returns `boards` at top level. **Agreed P1** (already above); this is a real bug Claude missed. |
| Inspection data shape vs shared-types | Claude flags local model drift as code-quality nit (§3.12) and "two shapes of cleared" (§3.13). | Flags as P1 data-contract bug with specific line references to `packages/shared-types/src/job.ts:81-91`. | Codex is right and more precise. **Agreed P1.** |
| `consumer_unit_upgrade` extent value | Claude asserts iOS parity ("values verbatim") in §2, suggesting the extra value is correct. | Flags as P1 mismatch with shared types + PDF generator. | Codex is right about the persistence risk. Even if iOS has the value, shared types and Python PDF generator don't — the value still breaks the downstream pipeline. **Agreed P1.** Claude's iOS-parity claim should be updated to flag this asymmetry. |

---

## 4. Claude-unique findings

1. **(§3.1) Stale-closure race specifically in `inspection/page.tsx:72-81`** — framed as Phase-4-blocker. Codex touches this globally (§3/P2) but without the Phase-4 specificity.
2. **(§3.2, §3.3, §3.4) Asymmetric toggle-off semantics** across the three smart toggles (`setTTEarthing` writes inverse; `setMicrogeneration` forces N/A; `setSection7NA` deletes refs). Plus `autoControlled` at `:118-121` permanently locks TT rows after one interaction. P1.
3. **(§3.5) Hard-coded `EICR_SCHEDULE[6]` index** for Section 7 autofill — brittle to schedule reordering. P1.
4. **(§3.6) `inst.address_line1` fallback is dead** — `InstallationShape` and `JobDetail` only use `address`. P1 maintenance trap.
5. **(§3.7) `Loader2` used as idle Generate-PDF icon** — reads as "generating now". P1 UX.
6. **(§3.8) `ScheduleOutcome` union member `'—'`** never written nor offered. P1 type cleanup.
7. **(§3.9) Useless IIFE wrapping EIC single-card branch** (`inspection/page.tsx:185-196`). P2.
8. **(§3.10) `void Download;` to silence unused-import warning** in `pdf/page.tsx:197`. P2.
9. **(§3.11) Duplicate `MultilineField` component** in `design/page.tsx:115-141` and `extent/page.tsx:110-142`. P2 — extract to `components/ui/textarea-field.tsx`.
10. **(§3.13) Two shapes of "cleared" item** coexist (`undefined` value vs `delete` → missing key). P2 inconsistency.
11. **(§3.14) `key={section.title}`** in inspection render — prefer `ref` or index to avoid collision. P2.
12. **(§3.15) Trim `EICR_SECTION_ICONS`/`ACCENTS` to length 7** (only half-agreed with Codex who flagged icons only). P2.
13. **(§5.4) Lucide tree-shake budget** — 11 icons in staff, 7 in pdf; verify single-icon imports, not whole-library. P2.
14. **(§6.1) WCAG AA contrast failure** on `text-white/75` 11px eyebrow over `#00cc66`-leaning gradient, across all six pages. P1 a11y.
15. **(§6.2) Auto-controlled chip rows** — `disabled` + 60% opacity with no `aria-describedby` pointing at the "Auto" hint. P1 a11y.
16. **(§6.3) No `aria-live` region** for bulk autofill (18 outcomes written in one toggle). P1 a11y.
17. **(§6.4) Nested interactive regions** on observation card (outer `role="button"` + inner Remove button). P2 a11y.
18. **(§6.6) Pulsing status dot reduced-motion note** on `pdf/page.tsx:73-78`. P2 forward-looking.
19. **(§7) `SectionCard` hardcoded magenta hex `#ff375f`** at `section-card.tsx:33` — pre-existing, not introduced here, but flagged as token-routing inconsistency.
20. **(§7) Constants mixing `ScheduleSection[]` vs `ScheduleItem[]`** top-level exports in `inspection-schedule.ts` — add `EicrSchedule`/`EicSchedule` aliases.
21. **(§7) `observations/page.tsx:24-36` `CODE_COLOUR`/`CODE_LABEL` duplication** — lift to `lib/constants/observation-codes.ts` for symmetry with `inspection-schedule.ts`.
22. **(§8) Concrete test proposals**: `computeWarnings.test.ts`, `inspection-autofill.test.ts`, `inspection-schedule.parity.test.ts` (vs iOS fixture).

---

## 5. Codex-unique findings

1. **Staff tab sources no real inspector data** — frames the missing backend/`JobDetail` field as the *primary* functional bug (the tab is "effectively unusable"). Suggests reading from `/api/inspectors` via `web/src/lib/api-client.ts:292-309`. Claude treats this as a typing-cast nit (§3.12). P1 functional.
2. **PDF boards path mismatch** — `data.board?.boards` vs top-level `boards` from `src/routes/jobs.js:583-591` and `packages/shared-types/src/job.ts:24-32`. Verified correct. Claude missed this. P1 functional.
3. **Inspection shape vs `InspectionSchedule` contract** — explicit `items[ref] = { outcome }` + camelCase flag names per shared types. Claude handles this looser under §3.12/§3.13. P1 functional.
4. **`consumer_unit_upgrade` is frontend-only** — not in shared types nor in `python/eic_pdf_generator.py:370-380`. Claude incorrectly describes it as iOS-verbatim ✓. P1 functional.
5. **`useMemo` on `pdf/page.tsx:49-52` effectively defeated** because `data` is the whole job object. P2 perf.
6. **Commit-strict observations usability gap** — disabled Add + "Tap Add" empty state. P2 (mooted by HEAD).
7. **Explicit test-coverage gap list** anchored at persistence/round-trip boundaries (staff-tab from saved profiles, EIC installation-type → PDF, inspection-schedule serialisation). P2.

---

## 6. Dropped / downgraded

| Finding | Source | Action | Reason |
|---|---|---|---|
| P0 framing of stale-closure race (§3.1 Claude) | Claude | **Downgraded to P1** | No live second writer today. Ship-stopper only once Phase 4 lands — which is imminent, so keeping at P1 with "fix before Phase 4" tag. |
| "Ship it with follow-ups" verdict (Claude §10) | Claude | **Dropped** | Three P1 data-contract bugs (staff, pdf-boards, extent installation-type, inspection shape) make the phase not usable end-to-end. Codex's "Needs rework" adopted. |
| iOS-parity claim for `consumer_unit_upgrade` (Claude §2 alignment table) | Claude | **Dropped** | Value is iOS-sourced but breaks the shared type contract and Python PDF generator. Parity claim misleading without that asymmetry noted. |
| Observations usability flag (Codex §2, §3) | Codex | **Kept but marked commit-only** | HEAD working tree (Phase 5c) has shipped `ObservationSheet`. Reviewing the commit strictly it's a real issue; tracking in CHANGELOG only. |
| `SectionCard` magenta hardcode (Claude §2, §7) | Claude | **Downgraded to non-blocker** | Pre-existing, not introduced by this commit. Noted for future token-cleanup pass. |
| `void Download;` / useless IIFE / 8th section icon / key collisions | Claude §3.9, §3.10, §3.14, §3.15 | **Kept at P2** | Real but cosmetic. |

---

## 7. Net verdict

**Needs rework before Phase 4.**

The UI surface is complete and visually consistent, but the phase ships four P1 data-contract mismatches that will either break round-trip persistence or produce incorrect downstream output the moment save wiring lands. Combined with the imminent second-writer arrival on `inspection.items` (Phase 4 Sonnet extraction), the stale-closure merge pattern will become a live race in the next commit window. No security issues; a11y baseline is decent but has three genuine AA gaps.

### Top 3 priorities before Phase 4 lands

1. **Fix data-contract drift on four tabs in one pass:**
   - Staff: source inspectors from `/api/inspectors` via `web/src/lib/api-client.ts:292-309`; extend `JobDetail` (`web/src/lib/types.ts:192-207`) with `inspector_id?`, `authorised_by_id?`, `designer_id?`, `constructor_id?`; drop `as unknown as` casts in `staff/page.tsx:71,75` and `pdf/page.tsx:47`.
   - PDF: read boards from top-level `job.boards` (or normalize backend payload in `JobProvider`) — `pdf/page.tsx:140-142`.
   - Inspection: align local shape with `packages/shared-types/src/job.ts:81-91` (`items[ref] = { outcome }` + camelCase flags), or add an explicit boundary mapper — `inspection/page.tsx:42-52`.
   - Extent: either remove `consumer_unit_upgrade` or propagate it through `packages/shared-types/src/job.ts:93-97` and `python/eic_pdf_generator.py:370-380` — `extent/page.tsx:24-33`.

2. **Convert the stale-closure merge pattern to functional updates** on all three offending tabs (`inspection:72-81`, `design:29-33`, `extent:40-44`). Requires `updateJob` in `web/src/lib/job-context.tsx:55-58` to accept `(prev) => next`. This must land before Phase 4 wires Sonnet into `inspection.items`.

3. **Accessibility + inspection perf sweep:** name the toggle switches via `aria-labelledby` (`inspection:269-286`); memoize `ScheduleRow` with stable per-ref `onSelect` (`inspection:301-364`, `:183-247`); fix hero-eyebrow contrast across all six pages (`text-white/75` 11px → `text-white` or 14px); add `aria-describedby` to auto-controlled disabled chips and an `aria-live="polite"` summary under Schedule Options.
