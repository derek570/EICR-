# Phase 3a — Context

**Commit:** `25580d8`

## Commit message

```
commit 25580d8b570ad2c2e04d0e212f0802fc377749cb
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:28:07 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:28:07 2026 +0100

    feat(web): Phase 3a — Installation, Supply, Board tabs (iOS parity)
    
    Replace the three TabStub placeholders with the first real form tabs, built
    on the SectionCard / FloatingLabelInput / SelectChips / SegmentedControl /
    NumericStepper primitives landed in the previous commit.
    
    Installation tab (src/app/job/[id]/installation/page.tsx)
     · Hero banner — blue→green gradient + building glyph (iOS parity)
     · Client details  (name, address parts, phone, email)
     · Installation address  (address parts, occupier)
     · Inspection dates  (inspection date, previous date, years stepper,
       auto-computed next-due date that updates when years change)
     · Premises  (description dropdown, Yes/No segmented controls for records
       available + evidence of additions — EICR only)
     · Previous inspection, Report details, General condition, Extent &
       limitations cards (EICR only — hidden for EIC, matching iOS)
     · Staff hint card — links to /staff tab with </> code chip
    
    Supply tab (src/app/job/[id]/supply/page.tsx)
     · Hero banner, reversed gradient (green→blue) + lightning glyph
     · Eight sections 1-1 with iOS SupplyCharacteristics model: supply details,
       means of earthing (distributor/electrode segmented + electrode detail
       fields conditionally shown), main switch / fuse, RCD (design + tested
       grids), earthing conductor, main protective bonding, bonding of
       extraneous parts (with an N/A chip on the Other field), SPD
    
    Board tab (src/app/job/[id]/board/page.tsx)
     · Supports the iOS multi-board array in `job.board.boards` — defaults to a
       synthesized main DB1 when empty; pill selector + Add / Remove buttons
       switch the active board
     · Identity, Location, Supply to board, Main switch / protection, and
       (conditionally for sub-distribution / sub-main) Sub-main cable card
     · Notes card with </> code chip
    
    Save model is fully wired: every field calls `updateJob` which merges into
    `job.installation | supply | board` and flips the dirty flag. Persistence
    to the backend is deferred to Phase 4 (shared debounced save with recording).
    
    Why one commit per phase not per tab: the three tabs share the same
    primitives and save plumbing; reviewing them together proves the primitives
    work at scale before Circuits (Phase 3b) pushes them harder.
    
    Verified with `PHASE=2 npx tsx scripts/verify-visual.ts` — all 40
    screenshots (10 tabs × 2 certs × 2 viewports) render correctly on both
    mobile (iPhone 14 Pro) and desktop (1440×900).
    
    Ref: CertMateUnified/Sources/Views/JobDetail/{Installation,Supply,Board}Tab.swift
    Ref: CertMateUnified/Sources/Models/{InstallationDetails,SupplyCharacteristics,BoardInfo}.swift
```

## Files changed

```
 web/src/app/job/[id]/board/page.tsx        | 339 +++++++++++++++++++++++-
 web/src/app/job/[id]/installation/page.tsx | 400 +++++++++++++++++++++++++++-
 web/src/app/job/[id]/supply/page.tsx       | 403 ++++++++++++++++++++++++++++-
 3 files changed, 1124 insertions(+), 18 deletions(-)
```
