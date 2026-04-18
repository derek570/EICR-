# Phase 3b — Context

**Commit:** `983a294`

## Commit message

```
commit 983a294c9f40d3d9511e304a5bffd943637b43ec
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:34:07 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:34:07 2026 +0100

    feat(web): Phase 3b — Circuits tab with collapsible cards + iOS action rail
    
    What: Full Circuits tab replacing the TabStub placeholder. Board-filter pill
    selector at top; right-hand action rail (Add/Delete/Defaults/Reverse/
    Calculate/CCU/Extract) mirroring the iOS colour palette exactly (blue / red /
    magenta #ff375f / pink #ec4899 / green / orange #ff9f0a / blue). Circuits
    render as CircuitCard collapsibles with ref badge + designation + cable/OCPD
    summary; expanded card surfaces 5 SectionCards: Identity, Cable, OCPD, RCD,
    Test readings — covering all ~29 Circuit fields from iOS Circuit.swift.
    
    Why: The Circuits tab is where inspectors spend the most time during an EICR;
    iOS exposes every circuit field. Web must reach parity so the inspector can
    finish a certificate on whichever platform they have in hand.
    
    Why this approach (collapsible cards, NOT horizontal-scroll table): iOS
    CircuitsTab uses a 29-column horizontal-scroll grid because it's optimised
    for the iPhone keyboard-down edit flow. In a web/PWA context — even on a
    phone — a horizontally-scrolling 29-column spreadsheet is painful: you lose
    column headers as you scroll, inputs get clipped, and editing a single
    reading means nudging a giant matrix. Collapsible cards with grouped
    SectionCards give the same information density, fit the 390px iPhone 14 Pro
    viewport natively, and match the form-card pattern already established on
    Installation/Supply/Board. If we ever need bulk-editing across circuits we
    can add a "table mode" toggle; for now the edit-one-circuit-at-a-time flow
    is the dominant inspector pattern.
    
    Action-rail stubs currently surface an actionHint banner ("Apply defaults
    wires up in Phase 5"). Add / Delete / Reverse are wired directly; Defaults,
    Calculate, CCU and Extract will be wired when Phase 5 capture flows land.
    
    Polarity renders as a 3-way SegmentedControl (pass/fail/na) to match iOS
    colour semantics.
    
    Verified: TypeScript clean (`npx tsc --noEmit`), visual-verify Phase 2
    screenshots regenerated; mobile shot confirms empty-state card + full action
    rail + floating action bar all render on iPhone 14 Pro viewport.
```

## Files changed

```
 web/src/app/job/[id]/circuits/page.tsx | 498 ++++++++++++++++++++++++++++++++-
 1 file changed, 492 insertions(+), 6 deletions(-)
```
