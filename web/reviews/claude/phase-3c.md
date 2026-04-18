# Phase 3c — Code Review

**Commit:** `88e7c4e` — *feat(web): Phase 3c — Extent, Design, Inspection, Staff, PDF & Observations tabs*
**Reviewer:** Claude (Opus 4)
**Files reviewed (at commit):**
- `web/src/app/job/[id]/design/page.tsx`
- `web/src/app/job/[id]/extent/page.tsx`
- `web/src/app/job/[id]/inspection/page.tsx`
- `web/src/app/job/[id]/observations/page.tsx`
- `web/src/app/job/[id]/pdf/page.tsx`
- `web/src/app/job/[id]/staff/page.tsx`
- `web/src/lib/constants/inspection-schedule.ts`

**Working-tree drift flagged:** `observations/page.tsx` in the working tree is the Phase 5c version (adds `ObservationSheet`, `ObservationPhoto`, `useParams`, `getUser`, photo thumbnails). Where relevant I have anchored findings to **commit content** and separately called out drift.

---

## 1. Summary

Phase 3c lands the remaining five tab placeholders plus a new observations route with solid visual parity to the iOS app. Structure, naming conventions, SectionCard accent usage, and colour-token routing are consistent with earlier phases. Schedule data is lifted correctly into a dedicated constants module with a clear sync contract to `iOS Constants.swift`. TypeScript typing is reasonable, though staff/pdf rely on `as unknown as` hatches to bridge the permissive `JobDetail` to tab-local shapes.

The main class of issues is **correctness around shared/stale state**: the `patch = useCallback(..., [data, updateJob])` pattern (copied from earlier phases) becomes more fragile on `inspection/page.tsx` because multiple rapid patches (manual chip taps, Sonnet extraction, auto-fill toggles) can land in the same render cycle and clobber each other. Accessibility has baseline coverage (useId labels, aria-pressed on chips, keyboard handler on the observation card) but fails AA contrast in a few gradient-text regions and lacks live-region signalling for bulk auto-fill. No security issues.

---

## 2. Alignment with stated intent

| Stated goal | Found |
|---|---|
| Five placeholders + observations replaced | Yes — all six pages emit full UIs. |
| iOS-parity snake_case shape | Yes — extent/design/staff/inspection all land snake_case keys. |
| Installation-type enum matches iOS `Constants.installationTypes` | Yes — `extent/page.tsx:24–29`. Values verbatim (`new_installation`, `addition`, `alteration`, `consumer_unit_upgrade`). |
| Three smart toggles wired correctly | Mostly — see Correctness §3 for asymmetric off-branch behaviour. |
| Colour tokens through `--color-status-*` not invented `--color-brand-red/amber/magenta` | Mostly — `section-card.tsx:33` still hardcodes `magenta: '#ff375f'` as a raw hex rather than a token (pre-existing, not introduced here). Inside the Phase 3c files the token rule is followed. |
| PDF tab readiness-only (wiring deferred to Phase 5) | Yes — three disabled action buttons. |
| Constants module single source of truth | Yes — header comment correctly states the invariant with iOS. |

No stated feature appears to be missing. The observations page at commit `88e7c4e` honestly ships the Add button **disabled** with `title="Add observation wires up in Phase 5"` (observations/page.tsx:87–92 at commit) — matches the commit message.

---

## 3. Correctness

### P0 — blocking

**3.1 Stale-closure races on `inspection/page.tsx` will lose outcomes when Sonnet streams arrive.**
`inspection/page.tsx:79–81` — `setOutcome` spreads `items` captured from render closure:
```ts
const setOutcome = (ref, outcome) => {
  patch({ items: { ...items, [ref]: outcome === items[ref] ? undefined : outcome } });
};
```
`patch` is `useCallback(..., [insp, updateJob])` at `:72–77` and merges the *closure* `insp` rather than the latest job state. `updateJob` itself is fine (`job-context.tsx:55–58` uses `setJob((prev) => ...)`), but the patch argument is already a precomputed merge of the stale `insp`. If the user taps a chip at T=0 and Sonnet pushes `items: {"5.12": "✗"}` at T=1ms (same React tick or faster than re-render), the second write reads the pre-tap `items` snapshot and drops the user's choice. This same pattern exists on every Phase 3 tab but the blast radius is largest here (90 rows × 8 chips plus three bulk toggles plus Sonnet).

Today (Phase 3c) nothing else writes to `inspection.items`, so the bug is dormant. Phase 4 wires Sonnet into the same slice — fix before Phase 4 lands.

### P1 — should fix

**3.2 Asymmetric toggle-off semantics across the three smart toggles.**
`inspection/page.tsx:85–112`:
- `setTTEarthing(false)` → `'3.1':'✓', '3.2':'N/A'` (writes the *inverse*).
- `setMicrogeneration(false)` → `['2.0','4.11','4.21','4.22']` all set to `'N/A'` (forces N/A).
- `setSection7NA(false)` → deletes refs (clears to undetermined).

These three behaviours appear chosen ad-hoc. Flipping TT off should arguably also clear (let inspector choose), or at least match Microgeneration. Document the contract explicitly or align them.

**3.3 `autoControlled` membership for TT toggles off.**
`inspection/page.tsx:118–121` gates `autoControlled` on `insp.is_tt_earthing !== undefined`. Once the user has toggled once, `3.1`/`3.2` are *permanently* auto-controlled until the toggle state itself is cleared — and there is no UI affordance to return `is_tt_earthing` to `undefined`. The chip row stays disabled forever after a single interaction.

**3.4 `mark_section_7_na` toggle uses truthy, others use `!== undefined`.**
`inspection/page.tsx:128` — `insp.mark_section_7_na` truthy vs `:118,122` using `!== undefined`. Inconsistent, probably unintentional. Means flipping "Mark Section 7 N/A" off *does* re-enable chip rows (by deleting entries) which is good; the bug is that the other two toggles don't. See 3.3.

**3.5 Hard-coded EICR_SCHEDULE[6] index for Section 7 autofill.**
`inspection/page.tsx:107,109,129` — `EICR_SCHEDULE[6].items`. If a future edit prepends or reorders sections, Section 7 moves silently. Replace with `EICR_SCHEDULE.find((s) => s.title.startsWith('7.'))` or move the "which section is Part 7" lookup into the constants file as an exported constant.

**3.6 PDF readiness checks `address_line1` which is never in the schema.**
`pdf/page.tsx:133` — `str(inst.address_line1) && str(inst.address)`. `InstallationShape` (`installation/page.tsx:42–66`) uses `address`, and `JobDetail` (`lib/types.ts:113,175`) uses `address`. `address_line1` is dead code. Not a bug, but misleading and a maintenance trap.

**3.7 `Loader2` as the "Generate PDF" idle icon is misleading.**
`pdf/page.tsx:116` — uses the spinner icon while the button is not loading; users will read this as "currently generating". Use `FileText`/`Download` when idle, swap to `Loader2` while loading in Phase 5.

**3.8 `ScheduleOutcome` union includes `'—'` that is never written nor offered.**
`inspection-schedule.ts:405`. `OUTCOME_OPTIONS` at `:407` omits it and `setOutcome` stores `undefined` not `'—'` to clear. The member adds no value and widens the type surface. Remove.

### P2 — nit

**3.9 Useless IIFE on the EIC branch.**
`inspection/page.tsx:185–196` wraps a single `<SectionCard>` in `(() => (<...>))()`. Replace with the JSX directly.

**3.10 `void Download;` to suppress unused-import warning.**
`pdf/page.tsx:197`. Either delete the import and add it back in Phase 5, or use `eslint-disable-next-line unused-imports/no-unused-imports`. `void X` is unusual enough to prompt future readers to second-guess.

**3.11 Duplicate `MultilineField` component.**
Defined in `design/page.tsx:115–141` and `extent/page.tsx:110–142` (the extent one adds `showCount`). Pull a single `MultilineField` into `components/ui/` — every future textarea tab (observations sheet, report details, etc.) will want the same visual.

**3.12 Double unknown-cast in staff tab.**
`staff/page.tsx:71` — `const data = job as unknown as StaffJobShape` and `:75` — `updateJob({ [role]: id } as Partial<typeof job>)`. If `designer_id`/`constructor_id`/`authorised_by_id` belong on `JobDetail` they should be typed there; if they are side-data, they belong on a strongly-typed nested field. The current shape hides type drift.

**3.13 Mutation-style `Map.get` on plain record.**
`inspection/page.tsx:80` — `outcome === items[ref]` OK for string key, but the `Record<string, outcome>` approach makes `Object.keys(items).length` progress-tracking unreliable if keys are ever `undefined`. `setOutcome` sets `ref: undefined` on toggle-clear (line 80) which leaves the key present. Progress `answered` filter at `:201` uses `!== undefined`, so it is *also* checking for the explicit `undefined` value — correct — but `delete next[item.ref]` (line 109) uses genuine delete. Two shapes of "cleared" (undefined vs missing) coexist; pick one.

**3.14 `section.title` as React key.**
`inspection/page.tsx:206` — keys on rendered title. If two sections ever share a title prefix the key collides. Use `ref` of the first item, or `sectionIndex`.

**3.15 `EICR_SECTION_ICONS` is length 8 for 7 sections.**
`inspection/page.tsx:54`. `% EICR_SECTION_ICONS.length` at `:203` still works; the 8th icon (`MapPin`) is never rendered. Trim to 7 so future readers don't wonder which maps where.

---

## 4. Security

No issues found in-scope.

- No `dangerouslySetInnerHTML`.
- No user input is concatenated into URLs or `href`s in these files (the working-tree observations page does render a `filename` into `<ObservationPhoto>` but that component is Phase 5c and out of scope).
- `computeWarnings` (`pdf/page.tsx:130–160`) reads values via `Record<string, unknown>` bracket access and normalises via `str()` — safe.
- Observations `crypto.randomUUID` fallback (working tree, `:42–47`) uses `Math.random` — not cryptographically strong but IDs here are client-local observation identifiers, not auth tokens, so acceptable.

---

## 5. Performance

**5.1 No `React.memo` on `ScheduleRow` — 90 rows re-render on every keystroke.**
`inspection/page.tsx:301–364`. A full EICR schedule has ~90 rows × 8 chip buttons = 720 JSX nodes rebuilt on each `setOutcome`. On mid-range iOS Safari this is noticeable (~15–25ms per commit). Memoise `ScheduleRow` with referential-stable `onSelect` (via `useCallback` keyed by ref) and `outcome` comparison.

**5.2 `setOutcome`, `setTTEarthing`, `setMicrogeneration`, `setSection7NA` are recreated every render.**
`inspection/page.tsx:79,85,97,104`. Not wrapped in `useCallback`; each `ScheduleRow.onSelect={(o) => setOutcome(...)}` inline arrow creates a fresh closure per render anyway, which defeats the memoisation win unless fixed together with 5.1.

**5.3 `observations.find` in the row render on every observation.**
`observations/page.tsx (working tree):96–101` — `observations.find((o) => o.id === editingId)` runs on every render with an open sheet. With <50 observations fine; pre-compute a `Map<id, obs>` if this ever grows.

**5.4 Default export pages are client components; tree-shake budget.**
All six pages declare `'use client'`. Not a regression — matches Phase 3a/3b — but flagged because every new `lucide-react` icon import bloats the client bundle. `pdf/page.tsx:4–12` pulls 7 icons; `staff/page.tsx:3–16` pulls 11. Verify the lucide tree-shake is still single-icon (not whole-library).

---

## 6. Accessibility

**6.1 WCAG AA contrast failures on the gradient hero subtitle/eyebrow.**
All six pages render `text-white/75` eyebrow text at 11px over `linear-gradient(135deg, #0066ff → #00cc66)`. 75% white ≈ `rgba(255,255,255,0.75)` on `#00cc66` gives ~2.3:1 contrast — fails AA 4.5:1 for small text. Examples: `extent/page.tsx:70`, `design/page.tsx:70`, `inspection/page.tsx:147`, `pdf/page.tsx:68,79`, `staff/page.tsx:96`, `observations/page.tsx:116`. Use `text-white` (not 75%) for <14px metadata text, or increase to a 14px body size.

**6.2 Auto-controlled chip rows lose keyboard affordance with no explanation.**
`inspection/page.tsx:345` — `disabled={autoControlled}` on chip buttons plus 60% opacity on the row. Screen readers will announce "dimmed, button" but never *why*. Add `aria-describedby` pointing at the hint text ("Auto — controlled by TT earthing toggle"), or switch to `aria-disabled` with a tooltip.

**6.3 No live region announces bulk auto-fill results.**
Flipping "Mark Section 7 N/A" writes 18 outcomes in one call; no screen-reader announcement follows. Add `<div aria-live="polite">` under the toggle row reading "Section 7 marked N/A (18 items)".

**6.4 Observation card is a nested interactive region.**
`observations/page.tsx (working tree):233–281` — outer `role="button"` with keyDown handler contains an inner `<button onClick={stopPropagation}>Remove</button>`. Valid per WAI-ARIA but screen readers often mis-announce nested buttons. Consider extracting Remove into a separate row outside the clickable card, or using a `<Menu>` with "Open" + "Delete".

**6.5 Toggle switches lack `aria-label`.**
`inspection/page.tsx:269–286` — `<button role="switch" aria-checked={value}>` with the visible label as a sibling `<span>`. Add `aria-labelledby` pointing at the span, or move the label into the button content.

**6.6 Equipment card icons use an any-cast style prop.**
`staff/page.tsx:304–306` — `{...({ style: { color: '...' } } as Record<string, unknown>)}`. This is both a type hole and bypasses any icon that consumes `style` properly. Extend the icon prop type instead.

**6.7 Pulsing status dot has no role/label.**
`pdf/page.tsx:73–78` is `aria-hidden` but the sibling `<span>` carries the status text, so screen readers do get the state. OK; flagged only because a "pulsing" animation on a plain `h-2 w-2 rounded-full` would need `prefers-reduced-motion` consideration if pulse class is added later.

---

## 7. Code quality

Strengths:
- Per-file doc comments match the team style set in Phase 3a (installation, board, supply, circuits).
- `snake_case` keys across all six tabs, consistent with `JobFormData` / iOS.
- Constants module doc has a clear iOS-sync contract (`inspection-schedule.ts:3–10`).
- `SectionAccent` palette is respected; no invented colour tokens inside 3c.
- `useId()` on every textarea label — good.

Weaknesses:
- Three separate definitions of a `MultilineField` pattern (design, extent, installation has its own inline textareas). Pull to `components/ui/textarea-field.tsx`.
- Permissive casts in `staff/page.tsx:71,75` and `pdf/page.tsx:47` (`job as unknown as PdfJobShape`). Types are loose because `JobDetail` doesn't declare these role-id fields. Preferable to extend `JobDetail` in `lib/types.ts`.
- `inspection/page.tsx` is 385 lines and holds two unrelated renderers (EIC single card, EICR sectioned). Splitting into `<EicScheduleList>` and `<EicrScheduleList>` child components would help readability and enable memoisation.
- `inspection-schedule.ts` mixes two top-level exports (`EICR_SCHEDULE`, `EIC_SCHEDULE`) with different shapes (`ScheduleSection[]` vs `ScheduleItem[]`). A single `type EicrSchedule` / `type EicSchedule` alias clarifies intent.
- `observations/page.tsx:24–36` duplicates code↔colour and code↔label maps that iOS keeps beside the `ObservationCode` enum. Lift to `lib/constants/observation-codes.ts` for symmetry with `inspection-schedule.ts`.

---

## 8. Test coverage

**Zero new tests in this commit.** `find web -name '*.test.*'` returns nothing in the workspace at the commit. The `Verified` section of the commit message cites `npx tsc --noEmit` and a manual Playwright visual script (`scripts/verify-visual.ts`) only.

Minimum tests that would have caught real bugs here:
- Unit test on `computeWarnings()` (`pdf/page.tsx:130–160`) covering EIC vs EICR missing-role matrix.
- Unit test on the three auto-fill toggles asserting item-map transitions (would have caught asymmetric off-branches, §3.2).
- Snapshot or typed round-trip test on `inspection-schedule.ts` confirming refs match the iOS fixture (`Sources/Utilities/Constants.swift` export).
- Accessibility test (`axe-core`) on each of the six rendered pages — would have caught §6.1 hero contrast.

---

## 9. Suggested fixes (concrete)

1. **`inspection/page.tsx:72–77`** — Switch `patch` to functional merge:
   ```ts
   const patch = React.useCallback((next: Partial<InspectionShape>) => {
     updateJob((prev) => ({ inspection: { ...(prev.inspection ?? {}), ...next } }));
   }, [updateJob]);
   ```
   This requires `job-context.tsx:55` to accept `(patch | (prev) => patch)` — extend the type. Fixes §3.1.

2. **`inspection/page.tsx:85–112`** — Unify the three toggle-off branches to **delete** refs (matching `setSection7NA`). If TT default needs to be `'✓'/'N/A'`, apply that in a separate "seed defaults" effect, not inside the toggle off-branch. Fixes §3.2, §3.3, §3.4.

3. **`inspection-schedule.ts`** — Export a named `PART_7_SECTION` constant and dereference it in `inspection/page.tsx` instead of `EICR_SCHEDULE[6]`:
   ```ts
   export const PART_7_SECTION_INDEX = 6; // or a const lookup helper
   ```
   Better: export `getSectionByRefPrefix('7.')`. Fixes §3.5.

4. **`pdf/page.tsx:133`** — Remove the `inst.address_line1` fallback; schema only uses `address`. Fixes §3.6.

5. **`pdf/page.tsx:116`** — Change the idle Generate icon from `Loader2` to `FileText` or `Download`. Fixes §3.7.

6. **`inspection-schedule.ts:405`** — Drop `'—'` from `ScheduleOutcome`. Fixes §3.8.

7. **`inspection/page.tsx:185–196`** — Remove the IIFE wrapper; render `<SectionCard>` directly. Fixes §3.9.

8. **`pdf/page.tsx:1–12,197`** — Remove unused `Download` import and the `void Download;` line. Add back when Phase 5 wires the Download button. Fixes §3.10.

9. **New file `components/ui/textarea-field.tsx`** — Extract the shared `MultilineField` used in `design/page.tsx:115–141` and `extent/page.tsx:110–142`; accept `showCount` optional. Fixes §3.11.

10. **`lib/types.ts`** — Extend `JobDetail` with `inspector_id?`, `authorised_by_id?`, `designer_id?`, `constructor_id?`. Then delete the `as unknown as StaffJobShape` cast at `staff/page.tsx:71` and the one at `pdf/page.tsx:47`. Fixes §3.12.

11. **`inspection/page.tsx:79–80, 109`** — Pick one "cleared" shape: either always `delete`, or always set `undefined`. Adjust the `answered` filter at `:201` and the typing of `items` accordingly. Fixes §3.13.

12. **`inspection/page.tsx:206`** — Change `key={section.title}` to `key={section.items[0]?.ref ?? sectionIndex}`. Fixes §3.14.

13. **`inspection/page.tsx:54`** — Trim `EICR_SECTION_ICONS` and `EICR_SECTION_ACCENTS` to length 7. Fixes §3.15.

14. **`inspection/page.tsx:301–364`** — Wrap `ScheduleRow` in `React.memo((prev, next) => prev.outcome === next.outcome && prev.autoControlled === next.autoControlled && prev.item === next.item)`, and give `onSelect` a stable reference per-ref (e.g. an `outerCallback = (ref) => (outcome) => setOutcome(ref, outcome)` memoised by `useRef`/`useMemo`). Fixes §5.1, §5.2.

15. **All six pages, hero eyebrow** — Replace `text-white/75` on 11px text (`extent:70, design:70, inspection:147, pdf:68, staff:96, observations:116`) with `text-white` (and drop opacity), or scale eyebrow to 14px. Run axe to confirm. Fixes §6.1.

16. **`inspection/page.tsx:345`** — On disabled chip buttons, add `aria-describedby={autoHintId}` pointing at the row-level "Auto" hint. Or swap `disabled` for `aria-disabled='true'` and handle the no-op in the onClick. Fixes §6.2.

17. **`inspection/page.tsx` (new)** — Add a hidden `<div aria-live="polite">` beneath the Schedule Options card; write a summary sentence when any of the three toggles fires. Fixes §6.3.

18. **`observations/page.tsx:233–281`** — Either (a) move Remove out of the card into a separate toolbar row, or (b) replace the outer `role="button"` with an explicit `<button>` surrounded by the card frame. Fixes §6.4.

19. **`inspection/page.tsx:269–286`** — Add `aria-labelledby={labelId}` on the toggle button; give the sibling label span an `id={labelId}`. Fixes §6.5.

20. **`staff/page.tsx:300–306`** — Widen the icon component prop type to accept `style?: React.CSSProperties` and pass directly; delete the `as Record<string, unknown>` cast. Fixes §6.6.

21. **`lib/constants/observation-codes.ts` (new)** — Move `CODE_COLOUR` and `CODE_LABEL` from `observations/page.tsx:24–36`; matches the convention set by `inspection-schedule.ts`. Fixes the second half of §7.

22. **Test scaffolding** — Add Vitest (or Jest) + `@testing-library/react` to the web workspace, and seed with (a) `computeWarnings.test.ts`, (b) `inspection-autofill.test.ts`, (c) `inspection-schedule.parity.test.ts` comparing refs to an iOS fixture. Fixes §8.

---

## 10. Overall verdict

**Ship it with follow-ups.** The commit is well-scoped, honest about deferred wiring (Add button disabled, Generate PDF disabled), and extends existing conventions rather than inventing new ones. No security concerns and no data-shape divergence from iOS. The bugs are real but narrow: one latent race, two accessibility gaps, and ~10 maintenance nits.

### Top 3 priorities before Phase 4 lands

1. **Fix the stale-closure merge pattern in `inspection/page.tsx:72–81`** (§3.1). Phase 4 wires Sonnet into the same `inspection.items` slice; shipping the race into Phase 4 will produce intermittent dropped chip taps that are very hard to reproduce.

2. **Unify the three auto-fill toggle off-branches** (`inspection/page.tsx:85–112`, §3.2/§3.3/§3.4). Today they silently disagree on what "off" means; a user toggling TT off will see different UX than toggling Section-7-N/A off, and `autoControlled` locks TT rows permanently.

3. **Accessibility sweep** — fix the hero eyebrow contrast on all six pages (§6.1), add `aria-describedby` on disabled chips (§6.2), and add the live region under Schedule Options (§6.3). These are cheap and are the only genuinely user-facing regressions introduced here (the rest are latent).
