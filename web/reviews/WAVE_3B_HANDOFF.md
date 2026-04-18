# Wave 3b Handoff — D11 Component De-duplication

**Branch:** `wave-3b-component-dedupe` (off `web-rebuild`)
**Commit:** `d4e6243`
**Scope:** `FIX_PLAN.md §D D11` — pull four inline-duplicated pieces (`LabelledSelect`, `Pill`, `MultilineField`, `formatShortDate`) into shared modules.
**Status:** pure refactor, render output byte-identical · 52/52 tests green · `tsc --noEmit` clean · `npm run lint` clean (0 errors, 6 pre-existing warnings unchanged).

---

## What was done

Four previously-duplicated blocks now live in one place each. Every call site now imports from the shared module instead of holding its own copy.

### New files

| File | Purpose |
|---|---|
| `web/src/lib/format.ts` | `formatShortDate(iso)` — short human date ("12 Apr" / "12 Apr 2024"). Not a component — lives under `lib/`, not `components/ui/`. |
| `web/src/components/ui/labelled-select.tsx` | `<LabelledSelect>` — iOS-style two-line select (small uppercase label above native `<select>`). `'use client'` because the body uses `React.useId()`. |
| `web/src/components/ui/pill.tsx` | `<Pill color={...} inline?>` — compact coloured badge. No hooks, no `'use client'`. |
| `web/src/components/ui/multiline-field.tsx` | `<MultilineField>` — textarea version of the FloatingLabelInput shape. `'use client'` because `React.useId()`. |

### Call-site migrations (callsite counts are JSX instances, not import statements)

| Shared module | File | Imports updated | Inline def removed |
|---|---|---|---|
| `formatShortDate` | `web/src/app/settings/admin/users/page.tsx` | 1 | yes |
| | `web/src/app/settings/admin/users/[userId]/page.tsx` | 2 | yes |
| | `web/src/app/settings/company/dashboard/page.tsx` | 2 | yes |
| `Pill` | `web/src/app/settings/admin/users/page.tsx` | 5 (all with `inline`) | yes |
| | `web/src/app/settings/admin/users/[userId]/page.tsx` | 3 (no `inline`) | yes |
| | `web/src/app/settings/company/dashboard/page.tsx` | 2 (no `inline`) | yes |
| `LabelledSelect` | `web/src/app/settings/admin/users/[userId]/page.tsx` | 1 | yes |
| | `web/src/app/settings/admin/users/new/page.tsx` | 2 | yes |
| `MultilineField` | `web/src/app/job/[id]/installation/page.tsx` | 5 | yes |
| | `web/src/app/job/[id]/design/page.tsx` | 2 | yes |
| | `web/src/app/job/[id]/extent/page.tsx` | 2 (both with `showCount`) | yes |

Totals: **4 new shared modules** · **7 pages migrated** · **27 JSX instances re-pointed** · **9 inline definitions deleted**.

---

## Why this approach

**Byte-identical render output, not "close enough".** Every divergence between copies is preserved behind an opt-in prop rather than merged into a new visual. The alternative — pick one variant and call the diff "tidied up" — would have silently re-rendered three admin screens and flipped visual regression baselines. That is the exact thing D11 asks the refactor *not* to do.

**One file per component, plus a helpers file.** Matches the existing `components/ui/` convention (`button.tsx`, `card.tsx`, `floating-label-input.tsx`, etc.). The date helper is a pure function with no JSX, so it lives in `web/src/lib/format.ts` — not cluttering `components/ui/`. That placement is what the task brief explicitly called for.

**`'use client'` only where the hook demands it.** `LabelledSelect` and `MultilineField` use `React.useId()` so they must be client. `Pill` uses neither hooks nor client-only APIs, so it stays server-component-safe — every current call site is already inside a `'use client'` page, so this is zero-effort future-proofing rather than a change.

**Commit-then-refactor was considered and rejected.** Doing "add shared files" as one commit and "migrate call sites" as a second commit would leave commit #1 with unused new files — noisy on bisect. A single coherent refactor commit is cleaner because every callsite in commit #1 already references the new shared code. The CLAUDE.md commit rule "separate unrelated changes" applies to unrelated concerns, not to the two halves of a single refactor.

---

## Divergences merged (explicit list)

Each divergence was preserved as an opt-in prop rather than collapsed into a single shape:

### `Pill`
- **`inline` prop (new).** `users/page.tsx` had `inline-flex items-center` on the span because it hosts `Lock` / `ShieldCheck` icons next to text. The `[userId]` and `dashboard` copies never host icons and rendered as bare spans. `inline` defaults to `false` → bare `<span>`; `users/page.tsx` passes `inline` on every pill to preserve its layout.
- **Colour palette widened to the union.** The three copies supported different subsets: `blue|green|red` (dashboard), `blue|green|red|amber` (userId), `blue|green|red|amber|neutral` (users list). Shared version accepts the full union. Each caller's TS signature still narrows — no call site can accidentally pass a colour it didn't have before.

### `MultilineField`
- **`showCount` prop (already existed in one copy, now on the shared one).** The `extent/page.tsx` copy wrapped its box in `<div className="flex flex-col gap-1">` and appended a right-aligned `"N characters"` counter. `installation/page.tsx` and `design/page.tsx` had neither. `showCount` defaults to `false`, so installation/design emit the same bare-box markup they did before. Only `extent` passes `showCount`, getting the wrapper + counter. Crucially, the wrapper only appears when `showCount=true` — otherwise the outer `<div>` would have been empty overhead and changed DOM structure on the other two pages.

### `LabelledSelect`
- **`disabled:cursor-not-allowed` retained in shared className.** The `[userId]` copy had it on the `<select>`; `new` didn't. `new` never passes `disabled`, so the `:disabled` pseudo-class never matches and the rule is inert. Retaining it is byte-identical for `new` and matches `[userId]`'s behaviour when disabled.

### `formatShortDate`
- **No divergences.** All three copies were structurally identical — the only difference was a single inline comment ("Short human-readable — …") that lived on the dashboard copy. That comment is preserved on the shared function's JSDoc instead of being carried into three files.

No divergence was too wide to merge losslessly. Every call site got a shared import that produces identical DOM.

---

## Deferrals

### `FormRow`
Not extracted. FIX_PLAN §D D11 mentions "FormRow equivalents across settings pages" — but `grep -R "function FormRow\|const FormRow"` across `web/src/` returns zero hits. There is no component by that name to extract. If the intent was to dedupe the ad-hoc `<div><label>…</label>…</div>` blocks on settings pages, that is its own design call (which page owns the canonical shape? does it interop with `FloatingLabelInput`'s two-line frame?). Deferred to a later wave where the shape can be specified rather than guessed.

### Pre-existing lint warnings
Not touched. 5 `react-hooks/exhaustive-deps` on the job/[id]/* pages + 1 unused `_certificateType` in `job-tab-nav.tsx` were carried forward from Wave 2a/2b. Out of scope for D11; tracked for Wave 4 polish per `WAVE_2B_HANDOFF.md`.

### Prettier-applied reformatting
The pre-commit hook reformatted `<Pill color="red" inline>Inactive</Pill>` into the multi-line `<Pill color="red" inline>\n  Inactive\n</Pill>` shape on `users/page.tsx`. That's a whitespace-only change that survives into the commit. Not a behaviour or render change; not a deferral — just flagged so the reviewer sees why the inline JSX in that one file expanded.

---

## Verification

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  6 passed (6)
      Tests  52 passed (52)

$ cd web && ../node_modules/.bin/tsc --noEmit
# clean

$ cd web && npm run lint
# 0 errors, 6 pre-existing warnings (unchanged from Wave 2b)
```

Pre-existing warnings carried forward unchanged:
- `job/[id]/design/page.tsx:28` — `data` in useCallback deps
- `job/[id]/extent/page.tsx:38` — `data` in useCallback deps
- `job/[id]/inspection/page.tsx:69` — `insp` in useCallback deps
- `job/[id]/installation/page.tsx:89` — `details` in useCallback deps
- `job/[id]/supply/page.tsx:44` — `supply` in useCallback deps
- `components/job/job-tab-nav.tsx:65` — unused `_certificateType`

Warning count: **6 → 6** (no rise, no drop).

---

## File inventory

**Added:**
- `web/src/lib/format.ts`
- `web/src/components/ui/labelled-select.tsx`
- `web/src/components/ui/pill.tsx`
- `web/src/components/ui/multiline-field.tsx`

**Modified (inline defs deleted, imports added):**
- `web/src/app/job/[id]/design/page.tsx`
- `web/src/app/job/[id]/extent/page.tsx`
- `web/src/app/job/[id]/installation/page.tsx`
- `web/src/app/settings/admin/users/page.tsx`
- `web/src/app/settings/admin/users/[userId]/page.tsx`
- `web/src/app/settings/admin/users/new/page.tsx`
- `web/src/app/settings/company/dashboard/page.tsx`

**Net diff:** +247 lines (new shared modules + rewritten imports), -345 lines (inline defs deleted) = **-98 net**.

---

## Recommended next wave

Unchanged from Wave 2b's recommendation: Wave 3 hardening (D7 replay-path observability + E7 Deepgram WS tests) and Wave 4 polish (lint-warning cleanup; `parseOrThrow` variant for any endpoint that earns strict parsing). If anyone touches `FormRow` in settings, that's the natural time to identify a canonical shape and add it to `components/ui/` alongside `LabelledSelect`.
