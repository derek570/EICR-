# Phase 3a Review — Installation, Supply, Board tabs

**Commits reviewed:** `25580d8` (tabs), `7a1fdd7` (primitives)
**Branch:** `web-rebuild`
**Files:**
- `web/src/app/job/[id]/installation/page.tsx` (400 lines)
- `web/src/app/job/[id]/supply/page.tsx` (403 lines)
- `web/src/app/job/[id]/board/page.tsx` (339 lines)
- `web/src/components/ui/section-card.tsx` (104 lines)
- `web/src/components/ui/floating-label-input.tsx` (79 lines)
- `web/src/components/ui/segmented-control.tsx` (79 lines)
- `web/src/components/ui/select-chips.tsx` (150 lines)
- `web/src/components/ui/numeric-stepper.tsx` (95 lines)

`git log 25580d8..HEAD` on these paths returned empty — the working-tree versions
match the commits, nothing was silently patched afterwards.

## 1. Summary

Phase 3a replaces three stub routes with real, editable form tabs backed by five
reusable primitives. The scaffolding lines up with the plan almost exactly —
iOS-parity layout, semantic-accent `SectionCard`, 8-section Supply,
multi-board pill switcher, EICR-only conditional cards — and the primitives have
clear single responsibilities that will extend cleanly into Phase 3b (Circuits).

The shipped code is *functional*, but there are a handful of bugs and consistency
gaps that reviewers should not let through without fixes: a stale-closure merge
bug inside every tab's `patch` callback, a `useState` initializer that desyncs
from server state, a drifting accent-colour convention, and the new
`MultilineField` / inline textarea that was introduced in the page even though a
general-purpose primitive was the stated rationale for this phase. There's no
test coverage yet, though the handoff explicitly defers Phase 4 for persistence.

Overall this is solid first-pass work that should land after the P0 stale-closure
fix, the `activeId` useState pattern, and a small cleanup pass on convention
drift.

## 2. Alignment with plan

| Plan item                                         | Delivered? | Notes |
|---------------------------------------------------|------------|-------|
| Installation, Supply, Board tabs (iOS parity)     | Yes        | Field-for-field against iOS Swift modules per commit message. |
| Five primitives: SectionCard, FloatingLabelInput, SegmentedControl, SelectChips, NumericStepper | Yes | One file each, no barrel. |
| Hero banners, gradients                           | Yes        | Installation blue→green, Supply green→blue, Board blue→green. |
| EICR-only conditional cards                       | Yes        | Previous inspection, Report details, General condition, Extent & limitations gated on `!isEIC`. |
| Multi-board support via `job.board.boards` array  | Yes        | With fallback-synthesis of `DB1` + pill selector + Add / Remove. |
| Next-due date computed from years stepper         | Yes        | Installation tab. |
| Save model: merges into `job.*`, flips `isDirty`  | Partial    | Flips dirty, but merge has a stale-closure bug (P0). |
| `PHASE=2` visual verification (40 screenshots)    | Claimed    | Not re-run as part of this review. |
| Defer network persistence to Phase 4              | Yes        | No save is wired; `isSaving` is a frozen `false`. |

**Gap vs plan:** the Installation page defines a local `MultilineField`
component on line 370-399. The stated reason in the commit body is "only the
Report Notes block on Installation/Extent actually wants multi-line input." The
Board tab (line 301-307) *also* has a free-form notes textarea, written inline
with different styling — so Phase 3a has **three** incompatible multiline
renderers (one in Installation's `MultilineField`, one inline in Board's notes
card, plus `textarea` in Extent not in scope). This is the exact primitive-drift
the commit claims to avoid. Should be a single `FloatingLabelTextarea` primitive.

## 3. Correctness

### P0

**P0-1 · Stale closure in every tab's `patch` callback**
- `installation/page.tsx:90-95`:
  ```
  const patch = React.useCallback(
    (next: Partial<InstallationShape>) => {
      updateJob({ installation: { ...details, ...next } });
    },
    [details, updateJob]
  );
  ```
- `supply/page.tsx:46-51` — same pattern.
- `board/page.tsx:70-77` — `persistBoards` + `patchActive` build off `boards` captured at render time.

All three reconstruct the merged record from the *locally-closed-over*
`details` / `supply` / `boards` snapshot, then hand the merged blob to
`updateJob`. `updateJob` is itself a setter that only applies a shallow spread
via `setJob((prev) => ({ ...prev, ...patch }))` in `job-context.tsx:55-58`.

Two consequences:

1. **Rapid successive edits drop writes.** If a user types two characters in
   the same render frame (or if two fields' `onChange`s fire synchronously
   from a controlled dropdown + focus shift), both callbacks see the same
   `details` snapshot and the second write overwrites the first's change. This
   is the classic "use the updater form" React bug.
2. **Race with server-replace.** `JobProvider` also calls `setJob(initial)` on
   every change to `initial` (`job-context.tsx:50-53`). Any inflight `patch`
   will clobber the server copy with the stale local snapshot.

The rule from the user's global `mistakes.md` is explicit about this case:
*"When dispatching multiple updates to the same object in a loop, accumulate
into a local batch first and dispatch once. Never use stale closure snapshots
as the base."*

**Fix:** either (a) expose an updater-form `updateJob((prev) => …)` in
`job-context.tsx` and call it from every `patch`, or (b) restructure tabs to
pass a field-level patcher that does the merge inside the reducer. (a) is
smaller and keeps the current API.

**P0-2 · `activeId` initializer on Board tab can reference a non-existent board**
- `board/page.tsx:65-68`:
  ```
  const boards =
    boardState.boards && boardState.boards.length > 0 ? boardState.boards : [newBoard()];
  const [activeId, setActiveId] = React.useState(boards[0].id);
  ```
  `boards` is re-derived every render. When the context re-fetches and
  `boardState.boards` becomes non-empty (first server hydrate), `boards[0].id`
  changes, but `useState`'s initializer only runs once, so `activeId` now
  points at the initial synthesized board that no longer exists. `active`
  falls back to `boards[0]` via `?? boards[0]` so the UI technically still
  renders — but `patchActive` writes to the *new* `boards[0].id` while
  `activeId` silently stays stale, which makes Add / Remove misbehave.

  Separately: because `boards` falls back to `[newBoard()]` when empty,
  `newBoard()` is called on every render and produces a new `randomUUID`
  *even if the context already has an empty `board`*. The `activeId` then
  diverges from the synthesized row's new id on every re-render where
  `boardState.boards` is empty. The effect is subtle because nothing writes
  until an input fires, but the first write creates *two* records (the one
  `newBoard` synthesized at mount, and a brand-new one synthesized on the
  render that processed the update).

  **Fix:** memoize the fallback (`useMemo(() => newBoard(), [])`) and sync
  `activeId` into state via a `useEffect` whenever the persisted board list
  changes, falling back to the first valid id.

### P1

**P1-1 · `updateJob`'s shallow merge + tab-local merge silently lose sibling keys.**
Each tab merges with `{ ...details, ...next }` but `details` is only whatever
*this* render saw. If another tab concurrently mutates `job.installation`
(Phase 4 recording can do this for live extraction), the last writer wins.
Non-blocking for Phase 3a since no other writer exists yet, but it means every
tab is on borrowed time once Phase 4 wires server → context broadcasts.
Relates to P0-1; same fix (updater form) closes this.

**P1-2 · `next_inspection_due_date` drift.**
`installation/page.tsx:98-107`: the due date auto-computes only when the user
touches the years stepper. If the user first picks a years value and *then*
changes `date_of_inspection`, the due date is left on the old anchor. Mirror
iOS does the same computation on either change. Recompute on both.

**P1-3 · Means-of-earthing radio can represent an invalid "both true" state.**
`supply/page.tsx:144-160` stores two booleans (`means_earthing_distributor`,
`means_earthing_electrode`). The UI only sets one at a time, but if the server
round-trip returns both `true` (which is a real possibility given the
permissive record schema), the segmented control renders `distributor` (short
circuits on the `bool(distributor) ? 'distributor' : …` expression) and the
"electrode detail" card below hides — even though the data says electrode is
still selected. Store a single enum (`'distributor' | 'electrode'`) or at least
normalise on read.

**P1-4 · Accent-colour drift.**
- `section-card.tsx:34`: `magenta` is hard-coded to `#ff375f` even though the
  design-system token `--color-status-limitation: #bf5af2` exists in
  `globals.css:37`. The `extent` card on Installation uses `accent="magenta"`
  and will render in a colour that doesn't match the rest of the "limitation"
  semantic.
- `section-card.tsx:32`: `amber` is mapped to `--color-status-processing`
  (`#ff9f0a`). That token's name ("processing") signals state-machine phases,
  not a warning accent. If the accent role truly is "warning" it should get
  its own `--color-accent-warning` alias to keep future token churn from
  breaking the cards.
- Hardcoded hex in a file whose whole purpose is semantic theming is the
  strongest single argument for drift; please swap to a CSS variable.

**P1-5 · `SelectChips` — chip row and dropdown are two sources of truth for the
same state, violating the header comment.**
`select-chips.tsx:3-18` comment says "tapping the chip does nothing; the
dropdown is canonical." Then line 133 binds `onClick={() => onChange(opt.value)}`
on every chip. The comment and the code disagree; the code is the more useful
behaviour (it's what users will expect) but the discrepancy will confuse the
next person who reads the comment. Either delete the comment or wire chips as
read-only.

**P1-6 · `SegmentedControl` — not keyboard-operable.**
`segmented-control.tsx:33-79`. The component uses `role="radiogroup"` +
`role="radio"` + `aria-checked` correctly, but there is **no keyboard
handler**. WAI-ARIA requires radio groups to implement Arrow-key traversal and
Space to select; a radio group with none is effectively mouse-only and fails
WCAG 2.1.1 (Keyboard). See Accessibility section.

**P1-7 · `NumericStepper` commit floor/ceiling not applied on raw-text input.**
`numeric-stepper.tsx:42-46, 54-60`: `commit` clamps to `[min, max]`, but the
text `onChange` path calls `onValueChange(n)` directly without clamping. A user
can type `999` into a `max={10}` field and the chevron buttons will happily
resume from 999. Same bug on `min`.

### P2

**P2-1 · Ref passing broken on `NumericStepper`.**
`NumericStepper` wraps `FloatingLabelInput`, which is a `forwardRef`. But
`NumericStepper` doesn't forward its own ref. Consumers that need focus
management on the numeric field (Phase 3b Circuits will) can't reach it.

**P2-2 · `supply/page.tsx:26` — `SupplyShape = Record<string, string | boolean | undefined>`**
This is basically `any`. It obscures key typos and defeats the whole reason
for the 1-1 mapping callout in the commit body. Since the commit explicitly
lists the canonical fields (eight sections × their keys), codify them as
a union or an explicit interface like Installation's.

**P2-3 · `board/page.tsx:55` — `id` fallback uses `Date.now()` which can collide.**
Unlikely in practice (two clicks in the same ms), but `crypto.randomUUID`
fallback should be `Math.random().toString(36).slice(2)` or similar at minimum.

**P2-4 · `supply/page.tsx:338-351` — N/A chip on "Other" bonding.**
The chip toggles `bonding_other_na` but never disables/clears the text input
when N/A is set. iOS blanks the field. Small UX parity issue.

**P2-5 · Hero banner is copy-pasted across three tabs with tiny variations.**
Installation inlines it; Supply and Board define a local `HeroBanner`
component. Pull it into a primitive.

**P2-6 · `FloatingLabelInput` — no `aria-invalid` when `state='error'`.**
It changes border colour but screen readers aren't told.

**P2-7 · `installation/page.tsx:381-399` `MultilineField` duplicates label
styles from `FloatingLabelInput` but inconsistently (different padding, no
focus ring width match). Users will see visual drift.

## 4. Security

- No new attack surface: everything is client-side rendering of user-entered
  strings into controlled inputs. No `dangerouslySetInnerHTML`, no raw HTML
  concatenation, no `eval`.
- `globalThis.crypto?.randomUUID?.()` at `board/page.tsx:55` is safe; the
  `Date.now()` fallback is non-sensitive (UI-only id).
- `select-chips.tsx:39-44` attaches a `mousedown` document listener but cleans
  up correctly on unmount and on `open` toggle. No memory leak.
- No secrets, tokens, or PII are logged.

Not flagged: none.

## 5. Performance

- `installation/page.tsx:90`, `supply/page.tsx:46`, `board/page.tsx:74`: every
  keystroke rebuilds the `patch` closure *and* the merged record. Given ~60
  fields on Supply, every input rerender triggers a full dependency array
  rebuild of the memoised callback. Acceptable at current scale but the
  updater-form fix (P0-1) also removes this allocation churn.
- `SectionCard` renders a fixed-size DOM tree; no concern.
- `SelectChips` renders *every option twice* (dropdown list + chip row) on
  every render. For the 4-option menus in this phase that's fine. Phase 3b
  Circuits will push much larger option lists — consider memoising.
- No lazy/code-split on the three page files; all three client components
  import Lucide icons eagerly. At ~30 icons total this is ~8 KB; fine.

## 6. Accessibility

- **Keyboard navigation on `SegmentedControl` is broken (P1-6).** All the
  yes/no toggles on Installation, the polarity / means-of-earthing toggles on
  Supply, are mouse-only. This fails WCAG 2.1.1. Fix: add `onKeyDown` with
  Arrow-Left / Arrow-Right / Home / End, and set `tabIndex` per spec (selected
  = 0, others = -1).
- **`FloatingLabelInput`** does set `htmlFor` correctly (line 50). Good.
- **`FloatingLabelInput`** has no `aria-invalid` or `aria-describedby` wiring
  for the `state='error'` / `hint` props. Screen readers will miss errors.
- **`NumericStepper`** — the up/down chevrons have `aria-label="Increase X"`
  / `"Decrease X"` (good), but no `role="spinbutton"` and no
  `aria-valuenow/min/max` — the assistive-tech user cannot perceive the
  current value without reading the input label separately.
- **`SelectChips`** — the expanded list uses `role="listbox"` and each item
  has `role="option"` + `aria-selected` (good), but there is no `tabIndex`,
  no `aria-activedescendant`, no keyboard nav despite the comment claiming
  "Keyboard nav: arrow up/down while open, Enter to commit, Esc to close" —
  **the comment describes behaviour that doesn't exist in the code.** That
  comment should be deleted or the behaviour implemented.
- **Colour-only semantics on `SegmentedControl`.** The pass/fail/lim variants
  rely purely on fill colour. Icon or text prefix would meet
  WCAG 1.4.1 (Use of Color).
- **Touch targets.** Chips in `SelectChips` are `px-2.5 py-0.5` — around
  24 × 20 px. Global rules require ≥ 44 × 44 px on mobile.
- **`board/page.tsx:106-119`** — the board-selector pills render as buttons
  but there's no `aria-pressed` / no `role="tablist"`. For the next screen
  reader user a "3 unnamed buttons" list is unhelpful.
- **Focus rings.** `FloatingLabelInput` relies on `focus-within:border-…`
  for focus indication; only a 1px border-colour change. Design-system rule
  requires a 2px+ visible focus ring. Add a `focus-visible:ring-*` to the
  input itself.
- **`prefers-reduced-motion`** is not respected on `SegmentedControl`
  `active:scale-[0.98]`. Low impact.

## 7. Code quality

**Good:**
- No `any` casts other than the single `SupplyShape` index-signature.
- `React.useId()` used correctly for label→input linkage in every primitive.
- Primitives are small, single-purpose, and free of barrels (as advertised).
- Commit messages are excellent — detailed WHY / WHY-not-amend / verification.
- iOS-parity references (`InstallationTab.swift`, `BoardInfo.swift`) are
  stamped into file headers so future maintenance has a clear cross-reference.

**Weak:**
- `MultilineField` (`installation/page.tsx:370-399`) and the inline `<textarea>`
  in `board/page.tsx:301-307` contradict the commit-body's "build every tab
  from the same primitives" claim. Extract `FloatingLabelTextarea`.
- `HeroBanner` inlined three times (P2-5).
- Accent colour map mixes tokens and raw hex (P1-4).
- `SupplyShape` is too loose (P2-2). Hard to grep for typos like
  `earthing_conductor_csa` vs `earthing_condutor_csa`.
- Magic widths: `maxWidth: '960px'` on the page container in all three tabs
  but set via inline `style`, not a Tailwind `max-w-` utility, and not a
  design token. Consider `--container-form` or `max-w-4xl`.
- Three different spellings of the same iOS "BS EN" field:
  `main_switch_bs_en` (Supply + Board) vs `spd_bs_en` (Supply). Not a bug but
  worth writing a field-key lint.
- The `CheckCircle` icon on the Staff hint card (`installation/page.tsx:354`)
  is imported from Lucide but never gets a tested checkmark semantic; at that
  location "Staff assignment lives on the Staff tab" doesn't mean "done". Use
  a neutral icon (e.g. `UsersRound`).

## 8. Test coverage

**None.** `web/tests` does not exist; no `*.test.*` files ship with the phase.
The commit defers this by noting visual verification via
`PHASE=2 npx tsx scripts/verify-visual.ts` produced 40 screenshots.

What's missing and would catch the bugs above:

- Unit test for `updateJob` updater-form semantics (P0-1).
- Unit test for `activeId` sync on Board tab against mutating `boardState.boards`
  (P0-2).
- A snapshot / DOM-query test per tab that asserts EICR-only cards are hidden
  on EIC (the whole point of the feature-flag in Phase 3a).
- Axe-core scan on each tab to catch the radiogroup and listbox accessibility
  gaps.
- A mock `patch → updateJob` integration test that types into every input in
  a tab and asserts the outgoing `job` merge has every expected key.

## 9. Suggested fixes (concrete)

1. **`web/src/lib/job-context.tsx:55-58`** — change `updateJob` signature to
   accept `Partial<JobDetail> | ((prev: JobDetail) => Partial<JobDetail>)` and
   dispatch via `setJob((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))`.
   Then in `installation/page.tsx:90-95`, `supply/page.tsx:46-51`,
   `board/page.tsx:70-77` rewrite `patch` to pass an updater:
   ```
   updateJob((prev) => ({ installation: { ...(prev.installation ?? {}), ...next } }));
   ```

2. **`web/src/app/job/[id]/board/page.tsx:64-68`** — memoize the fallback and
   sync `activeId`:
   ```
   const fallback = React.useMemo(() => newBoard(), []);
   const boards = boardState.boards?.length ? boardState.boards : [fallback];
   const [activeId, setActiveId] = React.useState(boards[0].id);
   React.useEffect(() => {
     if (!boards.some((b) => b.id === activeId)) setActiveId(boards[0].id);
   }, [boards, activeId]);
   ```

3. **`web/src/app/job/[id]/installation/page.tsx:98-107`** — recompute due date
   on *either* of `date_of_inspection` or `next_inspection_years`. Move to a
   `useEffect` keyed on both fields, or call the compute function from both
   change handlers.

4. **`web/src/components/ui/segmented-control.tsx`** — add keyboard handlers
   (Arrow-Left / Right / Home / End), set `tabIndex={isSelected ? 0 : -1}`,
   and add an icon prefix or visible-text affordance for each variant so
   meaning isn't colour-only.

5. **`web/src/components/ui/select-chips.tsx:3-18`** — either delete the
   comment that promises keyboard nav, or implement it (Arrow-Up/Down to
   move highlight, Enter to commit, Esc to close, focus trap while open).
   Also reconcile the chip-row fast-path with the "canonical" comment.

6. **`web/src/components/ui/section-card.tsx:29-35`** — replace
   `magenta: '#ff375f'` with `var(--color-status-limitation)` and consider
   renaming the accent "amber" to "warning" with its own alias token to
   decouple from `--color-status-processing`.

7. **`web/src/app/job/[id]/supply/page.tsx:144-160`** — store the means-of-
   earthing as a single `means_earthing: 'distributor' | 'electrode' | null`.
   Migrate on read to keep backward compat.

8. **`web/src/components/ui/numeric-stepper.tsx:54-60`** — clamp the
   text-input path to `[min, max]` at commit, same as the chevrons.

9. **`web/src/components/ui/floating-label-input.tsx:29-79`** — add
   `aria-invalid={state === 'error'}` and `aria-describedby={hint ? hintId : undefined}`;
   add a `focus-visible:ring-2 focus-visible:ring-[var(--color-brand-blue)]`
   so focus indication is 2px as the design-system rule requires.

10. **Extract `FloatingLabelTextarea`** primitive. Replace `MultilineField`
    in `installation/page.tsx:370-399` and the inline `<textarea>` in
    `board/page.tsx:301-307`.

11. **Extract `TabHeroBanner` primitive.** Replace the three hand-rolled
    copies in `installation/page.tsx:115-128`, `supply/page.tsx:385-402`,
    `board/page.tsx:313-338`.

12. **`web/src/app/job/[id]/supply/page.tsx:26`** — type `SupplyShape` as an
    explicit interface the way Installation does, listing all ~40 canonical
    keys. Catches key typos at compile time.

13. **`web/src/app/job/[id]/board/page.tsx:102-139`** — add `role="tablist"` to
    the pill container, `role="tab"` / `aria-selected` on each pill button,
    and a visible focus ring.

14. **Add tests** under `web/tests` or colocated `*.test.tsx`: start with a
    `job-context.test.tsx` that exercises the updater-form semantics, then a
    Vitest DOM test per tab that types into every field and asserts the
    final merged `job` shape.

## 10. Verdict and top 3 priorities

**Verdict: approve with changes.** This phase delivers exactly what the plan
describes at the layout and parity level, and the primitives are correctly
factored. The design-system hygiene is mostly good (tokens over hard-coded
colours, consistent spacing, typography from globals). The bugs that need to
land before Phase 3b are small and well-localised.

**Top 3 priorities, in order:**

1. **Fix the stale-closure merge (P0-1).** Every tab is writing off a snapshot.
   Switch `updateJob` to the updater form and refactor `patch` in all three
   pages. Without this, Phase 4's live-extraction broadcasts will race with
   user typing and silently drop data.

2. **Fix the Board-tab `activeId` + fallback-memoisation bug (P0-2).** Will
   start producing duplicate synthesised boards the moment the context
   replaces `job.board`.

3. **Make `SegmentedControl` keyboard-operable and strip the
   "keyboard nav supported" lie from `SelectChips`'s comment (P1-6, P1-5).**
   These are the two accessibility regressions that will bite a real user
   first. Everything else on the a11y list is polish.

All other issues (token drift, primitive extraction, shape typing, tests) can
be folded into Phase 3b polish or a dedicated a11y sweep.
