# Phase 5a — Context

**Commit:** `35b5310`

## Commit message

```
commit 35b531019f3cea2c84aa1b8a1c4b879a870063e3
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 13:58:54 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 13:58:54 2026 +0100

    feat(web): Phase 5a CCU photo capture + GPT Vision merge on Circuits tab
    
    WHAT
    Ports iOS CCU photo → fuseboard-analysis flow to the web rebuild.
    Replaces the stub CCU button on `web/src/app/job/[id]/circuits/page.tsx`
    with a working capture-first file picker that uploads to
    `/api/analyze-ccu` and merges the response into the active board.
    
    New/changed:
    - web/src/lib/recording/apply-ccu-analysis.ts (new) — merge helper
    - web/src/lib/recording/apply-extraction.ts — export hasValue
    - web/src/lib/api-client.ts — api.analyzeCCU(photo)
    - web/src/lib/types.ts — CCUAnalysis / CCUAnalysisCircuit
    - web/src/app/job/[id]/circuits/page.tsx — button wiring, question chips,
      error banner, spinner on the rail button
    - CLAUDE.md — changelog row
    
    WHY
    Phase 5 of the web rebuild (see memory/project_web_rebuild_phase5.md)
    is the non-voice capture paths. 5a is the CCU flow — inspectors
    photograph the consumer unit and the server-side GPT Vision pass
    returns board metadata + per-device circuits + inspector questions.
    Without this, the web rebuild has no way to bulk-populate circuit
    layouts from a photo, which is the most painful manual task on iOS.
    
    WHY THIS APPROACH
    1. `applyCcuAnalysisToJob` mirrors iOS `FuseboardAnalysisApplier
       .hardwareUpdate` (Sources/Processing/FuseboardAnalysisApplier.swift
       lines 71-193). That mode is the correct one for a consumer-unit
       re-photograph: it overwrites board/hardware (the board has
       physically changed) but preserves all test readings keyed to
       matched circuits (readings were taken against the live
       installation — they outlive any one board photo).
    2. Matching is by `circuit_ref` (string of `circuit_number`) only —
       iOS uses a Levenshtein designation matcher (`CircuitMatcher`) for
       cross-board moves, which we don't port yet. When CCU re-analysis
       is scoped to one board, numeric matching is correct; the fuzzy
       matcher can land later if inspectors hit false merges in the
       wild.
    3. Data-loss guard (lines 176-186 of the iOS source) is preserved:
       any existing circuit that the new analysis didn't mention AND
       that has a non-empty test reading gets appended at the end of the
       new array, so data is never silently dropped.
    4. Reuse of `hasValue` (exported from apply-extraction.ts) keeps the
       3-tier priority guard in one place — the same non-empty check
       that the recording-time Sonnet merge uses. Prevents CCU from
       clobbering a value the inspector has just typed.
    5. File input uses `capture="environment"` — the iOS Safari hint for
       the rear camera. The browser falls back to the library picker if
       capture is denied; matches the iOS UX ("camera or library?").
    6. `board.spd_*` (device fields) and `supply.spd_*` (supply-section
       fallbacks derived from the main switch, per
       routes/extraction.js:961-974) are written to different sections
       deliberately — the EICR form has both and they are edited
       independently.
    7. Auto-generates "What is the RCD type for circuit X?" prompts for
       RCD-protected circuits whose type couldn't be resolved
       (iOS parity: FuseboardAnalysisApplier.swift lines 90-98). Surfaced
       as dismissible chips so inspectors can capture them verbally
       before starting the recording.
    
    Backend endpoint is unchanged — iOS has been using it since
    2026-03-04.
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                   |   1 +
 web/src/app/job/[id]/circuits/page.tsx      | 128 +++++++++-
 web/src/lib/api-client.ts                   |  29 ++-
 web/src/lib/recording/apply-ccu-analysis.ts | 367 ++++++++++++++++++++++++++++
 web/src/lib/recording/apply-extraction.ts   |   2 +-
 web/src/lib/types.ts                        |  60 +++++
 6 files changed, 582 insertions(+), 5 deletions(-)
```
