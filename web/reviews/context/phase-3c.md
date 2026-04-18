# Phase 3c — Context

**Commit:** `88e7c4e`

## Commit message

```
commit 88e7c4ed1357e0105159e940d8ead5e4ab038842
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:44:36 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:44:36 2026 +0100

    feat(web): Phase 3c — Extent, Design, Inspection, Staff, PDF & Observations tabs
    
    What: Replaces the five remaining TabStub placeholders plus the observations
    route with full iOS-parity forms.
    
    • Extent — two SectionCards (Extent of Work / Comments) with character
      counters. EIC-only installation-type picker (new_installation, addition,
      alteration, consumer_unit_upgrade — enum ported verbatim from iOS
      Constants.installationTypes so PDF mapping stays identical).
    
    • Design — single "Departures from BS 7671" card with an info banner and a
      green "No Departures" shortcut capsule that prefills both text areas with
      the standard N/A strings. Mirrors iOS DesignTab exactly.
    
    • Staff — role-picker list per cert type (EICR: Inspector + Authoriser; EIC:
      Designer + Constructor + Inspection & Testing). Empty-state explains the
      settings flow; selected role reveals a Test Equipment card listing MFT,
      Continuity, IR, Earth Fault, RCD serials + calibration dates.
    
    • PDF — readiness status with pulsing dot, MissingData warnings card
      (computed locally against installation address, inspection date, boards,
      circuits, and required staff roles), and a 3-button actions row
      (Generate / Preview / Share). Generation itself still lives on the
      backend — actual wiring lands in Phase 5.
    
    • Observations — hero with C1/C2/C3/FI tally badges, empty-state, and
      collapsible observation cards keyed by code colour (C1 red, C2 amber,
      C3 blue, FI magenta — colours match iOS ObservationCode enum).
    
    • Inspection — biggest piece. EICR renders 7 SectionCards (~90 items)
      with per-section progress bar; EIC renders the 14 top-level items as a
      single card. 8-option outcome chip row per item (✓ ✗ N/A LIM C1 C2 C3 FI).
      Three smart auto-fill toggles (TT earthing, microgeneration, mark
      Section 7 N/A) match iOS — these apply to >80% of UK domestic EICRs so
      bulk-filling saves ~30 taps per certificate. Auto-controlled rows render
      at 60% opacity with an "Auto" pill and disabled chip row to stop
      accidental overrides mid-save.
    
    Why: These are the last five tabs blocking a full end-to-end EICR/EIC
    draft on the web. After Phase 3c lands, every tab visible in the bottom
    tab-strip is editable; the next critical piece is the recording overlay
    (Phase 4) which wires Sonnet extraction back into this form.
    
    Why this approach (dedicated constants module): BS 7671 schedule data is
    ~180 lines; inlining it in inspection/page.tsx hurts readability and
    blocks any future reuse (PDF generator, unit tests, schedule-item linking
    from Observations). Lifting it to src/lib/constants/inspection-schedule.ts
    with a clear contract (ScheduleItem, ScheduleSection, ScheduleOutcome
    union) keeps the page focused on rendering and gives a single source of
    truth alongside iOS Constants.swift. Both files MUST change together if a
    ref moves or description changes — see header comment in the constants
    file.
    
    Colour tokens: Routed through --color-status-{failed,processing,
    limitation} rather than fictitious --color-brand-{red,amber,magenta}.
    Matches the existing supply / circuits pattern and keeps the palette
    consistent with iOS CMDesign.Colors.Status.
    
    Verified: `npx tsc --noEmit` clean. `PHASE=2 npx tsx scripts/verify-visual.ts`
    regenerated; EICR inspection/staff/pdf/extent/design mobile shots confirm
    hero banners, outcome chip rows, empty states, and coloured accent
    stripes all render correctly on iPhone 14 Pro viewport.
```

## Files changed

```
 web/src/app/job/[id]/design/page.tsx         | 143 +++++++++-
 web/src/app/job/[id]/extent/page.tsx         | 143 +++++++++-
 web/src/app/job/[id]/inspection/page.tsx     | 385 ++++++++++++++++++++++++-
 web/src/app/job/[id]/observations/page.tsx   | 199 ++++++++++++-
 web/src/app/job/[id]/pdf/page.tsx            | 198 ++++++++++++-
 web/src/app/job/[id]/staff/page.tsx          | 330 +++++++++++++++++++++-
 web/src/lib/constants/inspection-schedule.ts | 407 +++++++++++++++++++++++++++
 7 files changed, 1768 insertions(+), 37 deletions(-)
```
