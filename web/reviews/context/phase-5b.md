# Phase 5b — Context

**Commit:** `766735f`

## Commit message

```
commit 766735f402f3021e17aafdc81764095552f23f01
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 14:42:47 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 14:42:47 2026 +0100

    feat(web): Phase 5b document extraction on Circuits tab
    
    What
    ----
    Wire the "Extract" button on the Circuits action rail (web rebuild, branch
    `web-rebuild`). One tap opens an image picker, POSTs the photo to the
    existing `/api/analyze-document` endpoint, and non-destructively merges
    the returned formData into every section of the job.
    
    Why
    ---
    Inspectors routinely arrive at a job with a prior EICR/EIC, a handwritten
    test sheet, or a typed record. The web rebuild couldn't consume any of
    that until now — the Extract rail button was a `stub('Extract doc')`.
    Without 5b, every inspector had to retype a full certificate's worth of
    data. iOS has supported this since 2026-03-04 (see `/api/analyze-document`
    changelog row).
    
    Why this approach
    -----------------
    - **Stricter 3-tier priority than iOS.** iOS `CertificateMerger.merge()`
      (Sources/Processing/CertificateMerger.swift:7-167) OVERWRITES non-empty
      extracted values on installation/supply/board. The web rebuild is
      stricter: `hasValue()` (exported from apply-extraction.ts) guards
      **every** section, so a non-empty user value always wins. This matches
      the explicit Phase 5 handoff instruction and stays consistent with 5a
      + recording extraction policy — the whole point of the Extract button
      is that it's safe to run after the inspector has started typing.
    - **Circuit merge by `circuit_ref`.** Same ref-match strategy as 5a. If
      the extracted circuit's ref matches an existing row (case-insensitive),
      fill empty fields only; otherwise append as a new row tagged with
      `board_id`. Skips iOS's Levenshtein fuzzy designation matcher (same
      call as 5a — add later only if cross-board false merges surface).
    - **Observation dedupe per iOS rules.** Duplicate if `(schedule_item +
      code)` match, OR if `(location + first-50-char lowercased text prefix)`
      match (mirrors CertificateMerger.swift:100-122). This is the only way
      to make "re-run Extract on the same photo" safe.
    - **No `capture="environment"` on the Doc picker.** Documents are
      usually photographed ahead of time; a library-first picker is more
      ergonomic for paper certs than popping the rear camera. CCU stays
      camera-first (rail buttons diverge intentionally).
    - **Extract on Circuits rail only.** iOS also has a Doc button on the
      recording overlay, but that cross-cutting overlay polish belongs in a
      later phase — same decision 5a made.
    - **Permissive types.** `DocumentExtractionCircuit` and
      `DocumentExtractionObservation` use optional fields + index signatures
      so backend prompt evolution can add keys without breaking the client.
    
    Scope exclusions (deferred, noted with TODO near the file input):
    - **PDF support** — backend hard-codes `data:image/jpeg` at
      `src/routes/extraction.js:1425`; iOS renders PDFs client-side via
      `ImageScaler.renderPDFToImage()`. Web has no pdfjs-dist dependency.
      MVP is image-only; PDF support requires either pdfjs-dist on the
      client or a backend JPEG-conversion step.
    - iOS `CertificateDefaultsService.applyCableDefaults` and
      `recalculateMaxZs` — not yet ported to web. Inspectors can trigger
      these manually if needed.
    
    Files
    -----
    - web/src/lib/recording/apply-document-extraction.ts (NEW) — merge helper
    - web/src/lib/types.ts — DocumentExtractionResponse + related types
    - web/src/lib/api-client.ts — api.analyzeDocument(photo)
    - web/src/lib/recording/apply-extraction.ts — export parseObservationCode
    - web/src/app/job/[id]/circuits/page.tsx — wire Extract button
    - CLAUDE.md — changelog row
    
    Verification
    ------------
    - `npm run typecheck` clean
    - `npm run lint` — 7 pre-existing warnings baseline (same as 5a), 0 errors
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                          |   1 +
 web/src/app/job/[id]/circuits/page.tsx             |  88 ++++-
 web/src/lib/api-client.ts                          |  23 ++
 web/src/lib/recording/apply-document-extraction.ts | 422 +++++++++++++++++++++
 web/src/lib/recording/apply-extraction.ts          |   4 +-
 web/src/lib/types.ts                               |  62 +++
 6 files changed, 596 insertions(+), 4 deletions(-)
```
