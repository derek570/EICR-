# Phase 3b — Circuits tab (Claude review)

**Target commit:** `983a294` — `feat(web): Phase 3b — Circuits tab with collapsible cards + iOS action rail`
**File under review:** `web/src/app/job/[id]/circuits/page.tsx` (+492 / -6)
**Working-tree state:** file has grown to 701 lines since 3b (CCU picker + doc-extract picker + questions list + spinning rail buttons). Those additions belong to Phase 5a/5b and are noted where they change the analysis — the 3b-specific code is still intact.

---

## 1. Summary

Replaces the `TabStub` with a real Circuits tab. Layout is two columns: a left card list (per-circuit collapsible with 5 `SectionCard` groups — Identity, Cable, OCPD, RCD, Test readings) and a right-hand 7-button action rail (Add / Delete / Defaults / Reverse / Calculate / CCU / Extract) whose colours mirror the iOS palette. Board-filter pills appear above the grid when the job has more than one board. `Add / Delete / Reverse` are wired; the rest stub out to an `actionHint` banner. Polarity uses the existing `SegmentedControl`, OCPD / RCD type use `SelectChips`, everything else is `FloatingLabelInput`.

The build compiles against existing CSS tokens (all referenced `--color-*` / `--radius-*` tokens exist in `src/app/globals.css`), uses `useJobContext().updateJob` like its Installation/Supply/Board siblings, and decorates cards with the `accent` stripe pattern established in `section-card.tsx`.

The implementation gets the shape right but ships a small cluster of real bugs around board filtering, `circuits` re-typing, and keyboard/a11y behaviour on the expand toggle.

---

## 2. Alignment with plan

| Plan item | Status |
|---|---|
| Replace `TabStub` placeholder | Done (`page.tsx:229`) |
| Board-filter pill selector at top | Done (`page.tsx:234-252`) — **but only rendered when `boards.length > 1`**; single-board jobs silently lose the selector and `selectedBoardId` still initialises from `boards[0]?.id`, so behaviour is consistent. |
| Right-hand action rail, iOS colour palette | Done (`page.tsx:371-413`). Colour choices match the commit message: blue/red/magenta `#ff375f`/pink `#ec4899`/green/orange `#ff9f0a`/blue. |
| Collapsible `CircuitCard` with ref badge + designation + cable/OCPD summary | Done (`page.tsx:452-502`). |
| 5 `SectionCard`s covering ~29 iOS `Circuit.swift` fields | Partial — see §3 (P2). 25 fields land; several iOS fields are missing. |
| Polarity as 3-way `SegmentedControl` (pass/fail/na) | Done (`page.tsx:689-694`). |
| Add / Delete / Reverse wired; Defaults / Calculate / CCU / Extract stubbed | As advertised. |
| TypeScript clean | Verified locally via inspection; no obvious type errors in the delta. |

Plan/commit message accurately describes the commit.

---

## 3. Correctness

### P0 (must fix)

**3.1 `Delete (all)` rail button is wired to a stub, not to delete.** (`page.tsx:378-383`)
The rail's red **Delete** button calls `stub('Delete all')` — which surfaces a “wires up in Phase 5” hint and does nothing. Yet `removeCircuit` is defined (line 116) and already wired to the per-card trash icon. The commit message says “Add / Delete / Reverse are wired directly” — **Delete is not**. Either:
- wire it to a confirm-then-clear-all (“Delete all circuits?” → `persist([])`), or
- relabel the button “Delete all” and mark as stub in the commit.
Users will absolutely tap the red button expecting something to happen; silently showing a hint is a bad first impression for the flagship tab.

**3.2 Board filter hides cross-board circuits without any way to view all.** (`page.tsx:98-100`)
```ts
const visible = selectedBoardId
  ? circuits.filter((c) => c.board_id === selectedBoardId || c.board_id == null)
  : circuits;
```
If a job has circuits with `board_id === 'B2'` and `selectedBoardId === 'B1'`, those circuits are silently filtered out. There is no “All boards” pill, and `setSelectedBoardId` only ever sets a specific id (there’s no way to clear it back to `null`). Worst case: a user imports circuits under board B2 via CCU, switches to B1, and now **cannot see them** and **cannot delete them** (the trash icon on the invisible card can’t be clicked). They can still land in the saved payload. For a tab where the bullet-proof contract is “what you see is what you save”, this is P0.

Minimum fix: add an `All` pill that sets `selectedBoardId = null`, or render a muted collapsed summary (“3 circuits on other boards, switch board to edit”) so the user at least knows they exist.

**3.3 `reverse` reverses the *entire* `circuits` array regardless of board filter.** (`page.tsx:121`)
When board B1 is active, `reverse()` rewrites the order of B2’s circuits too. Combined with 3.2 that’s mutation of invisible data. The iOS rail reverses *per-board*. Fix:
```ts
const reverse = () => {
  if (!selectedBoardId) return persist([...circuits].reverse());
  const others = circuits.filter((c) => c.board_id !== selectedBoardId && c.board_id != null);
  const mine = circuits.filter((c) => c.board_id === selectedBoardId || c.board_id == null).reverse();
  persist([...others, ...mine]);
};
```

### P1 (should fix)

**3.4 `Add` assigns `circuit_ref` from `visible.length + 1`, which collides on multi-board jobs.** (`page.tsx:110`)
If B1 has refs `1,2,3` and B2 has `1,2`, adding on B2 yields `3`. Fine. But if B2 has `1,2,3` too, adding on B2 also yields `4`, which collides with a planned global ordering. More importantly, adding works off `visible.length` which was just filtered to include `board_id == null` circuits; if the only `null`-board circuit has `circuit_ref === '1'` and B1 starts at `2`, the next ref becomes the already-taken `visible.length + 1`. Compute next ref from `max(refAsNumber) + 1` of the active board.

**3.5 `CircuitCard` header button wraps the full clickable row, but the trash-icon button is rendered as a *sibling* inside that header.** (`page.tsx:472-502`)
The outer `<header>` contains the expand `<button>` AND the remove `<button>`. That is valid HTML (not nested buttons), but the expand button’s flex box is `flex-1` — on narrow screens the trash icon can overlap the designation truncation. Minor layout bug; more importantly, clicking the trash icon works because they are siblings, but screen readers announce the entire region as an item with two buttons, one labelled “Remove circuit 1” and one unlabelled (the expand button has no `aria-label` — just wraps the ref + designation). Give the expand button an `aria-label={`${designation}, expand`}` and keep it on its own row.

**3.6 Expand toggle has no `aria-controls` or `role=button`-compatible keyboard semantics for Space/Enter.** (`page.tsx:473-478`)
Native `<button>` gets Space/Enter for free, so that part’s OK. But the expanded panel has no `id` and no `aria-controls` pointing at it — screen readers announce the expanded state without the user knowing *what* was expanded. Add `aria-controls="circuit-{id}-body"` and `id="circuit-{id}-body"` on the panel.

**3.7 `FloatingLabelInput` is not forwarded a stable `value={undefined → ''}` control state, but the `text()` helper always returns `''`.** (`page.tsx:465`)
`text` coerces to `''`, so inputs are always controlled. Good. However, `value` is never `undefined`, so a *cleared* field will `onPatch({ circuit_ref: '' })` — writing an empty string into the payload, not deleting the key. On save, the backend will persist `""` which will later round-trip as an `''` instead of the missing field. The iOS app almost certainly treats absence vs empty string differently (iOS `Circuit.swift` optionals). Decide and document; suggested fix: `onPatch({ circuit_ref: e.target.value || undefined })`.

**3.8 Polarity domain mismatch with iOS.** (`page.tsx:64-68`, `page.tsx:691`)
Web uses values `'pass' | 'fail' | 'na'`. iOS `Circuit.swift`’s `polarity_confirmed` is typically `String?` carrying `"Yes" / "No" / "N/A"` (verify against Swift source). If the backend stores these exact strings, the web tab’s serialised value `'pass'` will never round-trip to iOS. Either:
- emit `'Yes' / 'No' / 'N/A'` (or whatever iOS writes), and style the segment based on the iOS palette, or
- confirm the backend normalises both.
This is exactly the class of parity drift the commit message claims parity for.

**3.9 `rating_a` summary line hardcodes unit.** (`page.tsx:490`)
`${rating ? `${rating} A` : 'no OCPD set'}` — fine, but if `rating === '0'`, truthy, so shows `0 A`. Use `rating && Number(rating) > 0`. Minor but user-visible on incomplete rows.

### P2 (nice-to-have / observations)

**3.10 Missing iOS circuit fields.** Spot-check against typical `Circuit.swift`:
- No `phases` / `phase_type` (single/three-phase).
- No `Zs_limit_80pct` or computed Zs.
- No `notes` / `remarks`.
- No `AFDD` fields (BS EN, rating).
- No insulation-resistance continuity flag (pass/fail chip).

Commit claims “all ~29 fields” — I counted 25 (`circuit_ref`, `circuit_designation`, `number_of_points`, `max_disconnect_time_s`, `wiring_type`, `ref_method`, `live_csa_mm2`, `cpc_csa_mm2`, `ocpd_bs_en`, `ocpd_type`, `ocpd_rating_a`, `ocpd_breaking_capacity_ka`, `ocpd_max_zs_ohm`, `rcd_bs_en`, `rcd_type`, `rcd_operating_current_ma`, `rcd_rating_a`, `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm`, `r1_r2_ohm`, `r2_ohm`, `measured_zs_ohm`, `ir_test_voltage_v`, `ir_live_live_mohm`, `ir_live_earth_mohm`, `rcd_time_ms`, `polarity_confirmed`) = 28. The ~29 claim is defensible if you count `polarity_confirmed` and `id`. Flag: AFDD is a common EICR column, worth confirming it’s not an iOS field before closing out.

**3.11 `aside` is not semantic for the action rail.** (`page.tsx:371`)
The action rail is *primary* — not tangential. `aside` is fine (“related to the main content”), but a `<nav aria-label="Circuit actions">` or just a plain `<div role="toolbar" aria-label="Circuit actions">` is more correct and gives the buttons a `toolbar` role for arrow-key navigation (which users on this screen will want).

**3.12 `hex #ff375f / #ec4899 / #ff9f0a` are hardcoded.** (`page.tsx:387, 390, 400`)
`#ff9f0a` = `var(--color-status-processing)` (already defined in globals.css line 34). `#ff375f` / `#ec4899` are *not* tokenised. If the design team later renames to `--color-magenta` / `--color-pink`, three inline strings need to change. Add `--color-accent-magenta` and `--color-accent-pink` to globals.css and swap.

**3.13 `Record<string, string | undefined> & { id: string }` weakens the Circuit type vs `CircuitRow` in `types.ts`.** (`page.tsx:49`)
`CircuitRow` in `src/lib/types.ts:211-215` already declares `id: string; number?: string; description?: string; [key: string]: unknown;`. The local `Circuit` re-type via `as unknown as Circuit[]` (line 91) and the inverse cast on write (line 103) is an escape hatch that future phases must also work around. Consider tightening `CircuitRow` with the actual fields used here and dropping the double-cast.

**3.14 Client-side `globalThis.crypto?.randomUUID?.()` is fine but the fallback is weak.** (`page.tsx:72`)
`c-${Date.now()}-${Math.random()}` is the kind of thing that collides under network-synced adds. `randomUUID` is supported by every browser in the Next.js 16 target matrix; the fallback is pure paranoia that costs readability. Drop the fallback and narrow the type.

**3.15 `visible` recomputed on every render.** (`page.tsx:98-100`)
Not a real perf bug at ≤30 circuits, but the whole page re-renders on every keystroke because `updateJob` replaces the `job` object. For a job with 30 circuits and a user holding down a key, this is 30 `CircuitCard`s × ~15 inputs = 450 React elements re-rendering per keypress. Works, but `CircuitCard` should be `React.memo`'d with a stable `onPatch`/`onToggle`/`onRemove` (currently they’re new fn references each render so `memo` would do nothing — wrap with `useCallback`).

---

## 4. Security

- **No XSS.** All dynamic values render via React text nodes. `dangerouslySetInnerHTML` is not used.
- **No secret/PII exposure.** The tab reads `useJobContext`; it does not `fetch` anywhere.
- **Client-side only file pickers** (the CCU / Extract inputs added post-3b) accept `image/*` and hand off to `api.analyzeCCU` / `api.analyzeDocument`. These are same-origin API calls. No file contents are serialised into URL / query. Rail buttons `disabled={...Busy}` reasonably guard against double-submit. Not a 3b concern but noted as the working-tree delta.
- **`Math.random()` id fallback** (3.14) is not a security issue here — these ids are client-side identifiers, not secrets or CSRF tokens.

Nothing flagged.

---

## 5. Performance

- **Re-render cost of CircuitCard on every keystroke** — see 3.15. Memoisation is the straightforward fix.
- **`[...circuits].reverse()`** (line 121) copies the array; O(n). Fine.
- **No useMemo for `boards` / `visible`** — both are recomputed each render but they’re O(n) and n ≤ ~30. Not worth optimising until profiling shows it.
- **`mousedown` listener in `SelectChips`** — each expanded `SelectChips` adds a document-level listener (via the component itself, not 3b). An expanded CircuitCard renders 2 `SelectChips`; opening one adds a listener, closing removes it. Fine.
- Re-mount cost on `initial` change — `JobProvider` does `setJob(initial)` on every `initial` change (`job-context.tsx:51`). Parent must pass a stable reference or this tab will remount all its state on every render.

No P0/P1 perf issues.

---

## 6. Accessibility

- **Good:** rail buttons are `<button type="button">` (not divs); `aria-expanded` on the card toggle; `aria-label` on remove button; `role="status"` on hint; `role="alert"` on errors; hidden file input is `sr-only` with `aria-hidden` (note: `sr-only` + `aria-hidden` on a *user-triggered* file input is OK because it’s programmatically `click()`ed).
- **P1 gaps:**
  - Toggle button has **no accessible label**: wrapping the ref span + designation span *is* the label, but since ref is visual (`—` as fallback) and designation can be “Untitled circuit”, the announcement reads “— Untitled circuit, expanded” — correct but awkward. Prefer `aria-label="Circuit {ref}: {designation}, expand details"`.
  - No `aria-controls` linking toggle to body — see 3.6.
  - Rail `active:scale-95` and `.transition` should respect `prefers-reduced-motion`. Cheap add.
  - Touch targets: rail button is `py-2` + an icon + a `10px` label = roughly 56 px tall × ~96 px wide on `w-24`. Meets 44×44. Trash icon on card header is `h-8 w-8` = **32×32** — below the WCAG 44×44 mobile target. Bump to `h-10 w-10` (40px) or add padding.
  - Rail button colour contrast: white text on `#ff9f0a` (orange) @ 10 px bold = `~2.5:1`. Fails WCAG AA even at the large-text threshold (orange + white is a notoriously bad pair). Same for `#ec4899` pink @ ~3.4:1 borderline. `#ff375f` magenta @ ~3.5:1. Only the green and blue pass cleanly. If the design team insists on iOS parity, add a dark text shadow or make the labels semibold black for those three colours.
- No **keyboard focus ring** style on the rail buttons. The global `:focus-visible` outline probably covers them, but with `shadow-[0_4px_12px_rgba(0,0,0,0.35)]` the ring may be swallowed by the shadow. Verify.

---

## 7. Code quality

- **File size:** 701 lines (3b brought it to 498; CCU/doc additions from later phases pushed it further). At this size the one-file-per-route pattern starts straining — pull `CircuitCard`, `RailButton`, and the option constants into `components/job/circuits/` siblings. Matches the split already done for recording (`lib/recording/*`).
- **Type-casts escape hatches:** `as unknown as Circuit[]` (line 91), `as unknown as typeof job.circuits` (line 103), `as { boards?: ... }` (line 92). These are a symptom of `CircuitRow` being too loose. Tighten the shared type (§3.13).
- **Magic strings:** `'pass' | 'fail' | 'na'` — create a `PolarityValue` type alias colocated with the `POLARITY_OPTIONS`.
- **Inconsistency with siblings:** Installation/Supply use `showCodeChip` on their last card; Circuits does not. Trivial but noted under the “match the form-card pattern” claim in the commit message.
- **`stub(label)` creates a new fn on every render** (line 123). No React state cares, but you’re allocating 4 closures per render. Move the stub map up top.
- **Comment quality:** excellent — the docstring at the top of the file explains *why* the card approach replaces the table, exactly the kind of context this codebase asks for in CLAUDE.md.
- **Dead import in working tree:** not in 3b, but now that `Loader2`/`X` are imported, ensure they’re used in all builds. ✓ used.

---

## 8. Test coverage

- **Zero tests.** `find web -name "*.test.*"` returns nothing. The repo has `npm test --workspace=web` in CLAUDE.md but the workspace ships no test files. For Phase 3b specifically, this is consistent with Phases 0–3a (the commit message references “visual-verify Phase 2 screenshots regenerated” rather than unit tests). **Not a regression, but worth calling out:** the Circuits tab is the most business-critical surface on this app — a handful of tests around `addCircuit` / `removeCircuit` / `reverse` / board-filter behaviour would catch §3.2 / §3.3 / §3.4 immediately.
- Suggested minimal coverage:
  1. `addCircuit` inserts at end with board-scoped ref.
  2. `removeCircuit` is idempotent and clears `expandedId` only if it was the expanded one.
  3. `reverse` preserves other boards’ order.
  4. Board filter renders ≥1 card per board when switching.

---

## 9. Suggested fixes (concrete, numbered)

1. `page.tsx:380-383` — wire Delete rail button to a confirm + clear-board-circuits flow, OR label the button “Delete all (soon)” and file the wiring as Phase 5. Current behaviour silently stubs a destructive-looking red button.
2. `page.tsx:98-100` — add an “All” pill to the board selector and let `selectedBoardId === null` show every circuit; without it, cross-board circuits are orphaned.
3. `page.tsx:121` — scope `reverse()` to the active board (see snippet in §3.3).
4. `page.tsx:110` — compute next `circuit_ref` from `max(parseInt(refs)) + 1` on the active board, not `visible.length + 1`.
5. `page.tsx:473-493` — add `aria-label` and `aria-controls` on the expand button; add matching `id` on the expanded panel at line 504.
6. `page.tsx:494-501` — enlarge trash icon hit-area to `h-10 w-10` (40px+) to meet WCAG touch-target.
7. `page.tsx:64-68` & `page.tsx:691` — verify iOS polarity wire format and align to `"Yes" / "No" / "N/A"` (or whatever `Circuit.swift` serialises). Otherwise iOS↔web round-trip silently drops the field.
8. `page.tsx:49` + `src/lib/types.ts:211` — tighten `CircuitRow` to carry the real field names, drop the `as unknown as Circuit[]` casts.
9. `page.tsx:387, 390, 400` — move `#ff375f`, `#ec4899`, `#ff9f0a` into `globals.css` as `--color-accent-magenta`, `--color-accent-pink`, and reuse `--color-status-processing` for orange.
10. `page.tsx:452-701` — memoise `CircuitCard` and wrap `onPatch / onToggle / onRemove` in `useCallback`. Not urgent but trivial.
11. `page.tsx:371` — switch rail wrapper to `<div role="toolbar" aria-label="Circuit actions">` for arrow-key nav.
12. `page.tsx:441-444` — audit rail button contrast; add a dark text shadow or switch to dark text on the orange/magenta/pink variants to meet WCAG 3:1 for large text.
13. `page.tsx:72` — drop the `Math.random()` fallback once `randomUUID` is confirmed as universal.
14. `page.tsx:490` — guard `rating` against `'0'` literal (`rating && Number(rating) > 0`).
15. Add `web/src/app/job/[id]/circuits/page.test.tsx` with at least the 4 cases listed in §8.

---

## 10. Overall verdict + top 3 priorities

**Verdict:** Solid Phase 3b that nails the visual language and data model but ships three user-visible behavioural bugs that bite multi-board jobs. Nothing here requires a rewrite — all P0s are bounded to `page.tsx` and under 50 LOC each. Ship with fixes 1–3 before Phase 5 capture flows push more data through the filter.

**Top 3 priorities:**
1. **Fix the `Delete` rail stub (§3.1) and the board-filter orphan-circuits bug (§3.2).** These are silent data-loss shaped bugs — users will think circuits disappeared.
2. **Scope `reverse` to the active board (§3.3) and verify polarity round-trips iOS (§3.8).** Parity with iOS is the point of the rebuild; silent drift here will come back as a PDF-doesn’t-match-app bug report.
3. **Enlarge trash touch-target + audit rail-button contrast (§A11y).** The tab is mobile-first; `32×32` trash and `2.5:1` orange-on-white buttons are the kind of polish gaps that fail real-device QA.
