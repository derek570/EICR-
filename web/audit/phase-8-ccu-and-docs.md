# Phase 8: CCU Photo Capture, Fuseboard Matcher, Document Extraction — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction   Durable rule: iOS is canon._

## Summary
Gaps found: 14 (P0: 6, P1: 5, P2: 3)
Exceptions (intentional divergence, documented): 2
Scope exclusions respected: voice pipeline (Phase 6), circuits layout (Phase 3), observation photos (Phase 4).

---

## A) CCU PHOTO CAPTURE

### Side-by-side matrix

| Concern | iOS (canon) | PWA | Status |
|---|---|---|---|
| Entry point | Circuits action-rail "CCU Photo" | Circuits action-rail "CCU" | OK |
| Pre-capture mode sheet | `CCUExtractionModeSheet` (3 modes) | **Missing — no mode sheet at all** | DIVERGENT (P0) |
| Source dialog | Camera / Library picker | Single hidden `<input capture="environment">` | PARTIAL |
| Progress / retry UI | "Retrying (2/3)" badge + savedForRetry queue | Spinner only | DIVERGENT (P0) |
| Auto-retry on reconnect | `NetworkMonitor.isConnected` watcher | None | DIVERGENT (P1) |
| Pending-extractions queue | Persistent list + per-row Retry + bulk Retry All | Absent | DIVERGENT (P0) |
| Match review sheet | `CircuitMatchReviewView` | Absent | DIVERGENT (P0) |
| Three-mode semantics | Names-only / Hardware / Full | **Only full-merge semantics** | DIVERGENT (P0) |
| Questions-for-inspector | TTS routed + visual | Dismissible chips | OK (polish only) |
| Confidence warning | Alert when `poor` or `<0.5` | Not surfaced | DIVERGENT (P1) |
| Cost display (GBP) | `gptVisionCost` returned, not displayed | `gptVisionCost` in schema, not displayed | OK (mirrors iOS — see Exception #1) |
| Board targeting | `targetBoardIndex` defaults 0, CircuitsTab wires per-board | `selectedBoardId` is wired | OK |
| `onCircuitsApplied` → Sonnet `job_state_update` | 5 call sites in CCUExtractionViewModel | **`sendJobStateUpdate` defined but never called after CCU mutation** | DIVERGENT (P0) |

Evidence: iOS `CertMateUnified/Sources/ViewModels/CCUExtractionViewModel.swift:11-160`, `CertMateUnified/Sources/Views/JobDetail/CircuitsTab.swift:427-491`, `CertMateUnified/Sources/Models/CCUExtractionMode.swift:4-27`. PWA `web/src/app/job/[id]/circuits/page.tsx:132-178`, `web/src/lib/recording/apply-ccu-analysis.ts:1-388`.

---

### Gap #1 — PWA has no three-mode selection for CCU capture [P0]
**Area:** Circuits → CCU → entry
**iOS behaviour:** Tapping "CCU Photo" presents `CCUExtractionModeSheet` with three choices: Circuit Names Only, Update Hardware (Keep Readings), Full New Consumer Unit (`CCUExtractionModeSheet.swift:19-34`, `CCUExtractionMode.swift:4-27`). Each maps to a distinct branch in `FuseboardAnalysisApplier.apply(_:to:mode:boardIndex:)` — names-only leaves hardware alone, hardware-update goes through match review, full-capture replaces the board wholesale (`FuseboardAnalysisApplier.swift:33-41`).
**PWA behaviour:** `openCcuPicker()` immediately opens the hidden file input — no mode sheet, no mode parameter flows to `applyCcuAnalysisToJob` (`web/src/app/job/[id]/circuits/page.tsx:132-178`). The applier hard-codes a single semantic (merge by `circuit_ref`, always preserve readings — effectively a permissive hardware-update) and never exposes the two distinct iOS modes.
**Evidence:** `web/src/lib/recording/apply-ccu-analysis.ts:20-26` acknowledges the skip — "We don't port iOS's `CircuitMatcher` fuzzy-designation matcher yet… Web v1 matches by `circuit_ref` only." No mode enum is referenced anywhere in the web tree (`grep -r CCUExtractionMode web/src` → zero hits). `web/src/lib/api-client.ts:301` sends only `{ photo }` multipart with no `mode` field; the backend route `/api/analyze-ccu` defaults accordingly.
**User impact:** Inspector who photographs a freshly-replaced board (iOS Mode 2) cannot invoke the match-review flow. Inspector who photographs a board to correct labels only (iOS Mode 1) gets hardware fields overwritten by any newly-extracted values (mergeField semantics mean: empty stays, non-empty in the new analysis clobbers — which is correct for "update hardware" but wrong for "names only"). Inspector doing first-capture ("Full New") cannot signal "replace everything" — existing (partial) data sticks.
**Proposed fix:** Mirror iOS exactly: add a mode-select sheet before `<input>.click()`; thread the chosen mode through `applyCcuAnalysisToJob`; implement `applyCircuitNamesOnly` / `applyHardwareUpdate` / `applyFullCapture` branches matching `FuseboardAnalysisApplier.swift:46-248`.
**Touchpoints:** New `web/src/components/job/ccu-mode-sheet.tsx`; `web/src/app/job/[id]/circuits/page.tsx:132-178`; `web/src/lib/recording/apply-ccu-analysis.ts` (split into three branches).

### Gap #2 — PWA has no match-review UI for hardware-update mode [P0]
**Area:** Circuits → CCU → Mode 2 review
**iOS behaviour:** After analysis in `hardwareUpdate` mode, the flow does NOT mutate circuits; it populates `extractionVM.matches` via `CircuitMatcher.match(...)` and presents `CircuitMatchReviewView` as a sheet (`CCUExtractionViewModel.swift:132-151`, `CircuitMatchReviewView.swift:16-68`). The inspector sees per-row: new-circuit label, matched old-circuit label, confidence badge (green/amber/red), and "readings preserved" marker. They can tap any row and reassign (including "No match — will be added as new"). Only on Apply does `confirmMatches()` call `applyHardwareUpdate(...)` which rebuilds the circuit list (`CCUExtractionViewModel.swift:213-225`). Unmatched old circuits with readings are appended at end; without readings, dropped (`FuseboardAnalysisApplier.swift:176-186`).
**PWA behaviour:** `handleCcuFile` applies the patch immediately (`web/src/app/job/[id]/circuits/page.tsx:148-153`). No review sheet exists. `applyCcuAnalysisToJob` does a ref-only match and writes the result straight to `updateJob(patch)`.
**Evidence:** `web/src/app/job/[id]/circuits/page.tsx:148` → `updateJob(patch)` fires synchronously. No `CircuitMatch` / `MatchReview` component anywhere in `web/src/components` (verified via grep).
**User impact:** Silent merges. If the new board's circuit 3 was "Sockets Up" and old circuit 3 was "Shower", iOS would show `31% fuzzy match — reassign?`; PWA just writes the shower's readings onto the sockets circuit. The ref-only matcher (see Gap #3) makes this actively dangerous.
**Proposed fix:** Port `CircuitMatcher.swift` to TS; gate hardware-update behind a modal review component with per-row reassignment; only call `updateJob` after Apply.
**Touchpoints:** New `web/src/lib/recording/circuit-matcher.ts` (levenshtein + jaccard + semantic groups from `CircuitMatcher.swift:93-226`); new `web/src/components/job/circuit-match-review.tsx`; rework `web/src/app/job/[id]/circuits/page.tsx:137-178`.

### Gap #3 — PWA fuzzy matcher replaced by ref-only exact match (silent data loss risk) [P0]
**Area:** Circuits → CCU → matching
**iOS behaviour:** `CircuitMatcher` scores every (new, old) pair using (Levenshtein × 0.3 + Jaccard × 0.3 + semantic groups × 0.4), then greedy-assigns above 0.4 threshold (`CircuitMatcher.swift:38-88`). Semantic groups include `sockets ≈ ring ≈ power`, `lighting ≈ lights`, `upstairs ≈ first floor ≈ 1st floor`, plus abbreviation expansion (`ltg → lighting`, `skts → sockets`, `ff → first floor`) — `CircuitMatcher.swift:146-210`.
**PWA behaviour:** `buildCircuitsPatch` uses a plain `Map<string, CircuitRow>` keyed by `circuit_ref` (string of the circuit number) and drops fuzzy-match entirely (`web/src/lib/recording/apply-ccu-analysis.ts:222-253`). If the new board renumbers (very common: someone reordered circuits during a refit), ref-3 on the new board matches ref-3 on the old board regardless of the label meaning — readings are applied to the wrong circuit.
**Evidence:** `web/src/lib/recording/apply-ccu-analysis.ts:20-26` docstring explicitly accepts the shortcut: "Cross-board moves can be done manually; the fuzzy matcher can land later if inspectors report false merges." iOS ships the fuzzy matcher as the primary path — this is not a future enhancement, it is the canonical behaviour.
**User impact:** Silent corruption of test readings when the board is renumbered. A 6 A lighting circuit at ref-3 whose Zs = 1.4 Ω gets those readings re-attached to a 32 A shower at ref-3 on the new board. Zs validation passes (both under max Zs for B6 and B32) so the inspector may not notice at review.
**Proposed fix:** Port the full `CircuitMatcher` (function + semantic groups + abbreviation table) to TS. Use it for all three modes just like iOS does.
**Touchpoints:** New `web/src/lib/recording/circuit-matcher.ts`; consumers in `apply-ccu-analysis.ts`.

### Gap #4 — CCU does not send `job_state_update` to Sonnet session after circuit list changes [P0]
**Area:** Circuits → CCU → Sonnet integration
**iOS behaviour:** `CCUExtractionViewModel.onCircuitsApplied` fires at 5 sites whenever CCU mutates `job.circuits` (`CCUExtractionViewModel.swift:43-59, 130, 158, 224, 280, 297`). `DeepgramRecordingViewModel` subscribes on `onAppear` and pushes the new state to the backend so Sonnet's `stateSnapshot` is refreshed mid-session. Without this, dictated readings after a CCU refresh fail to map to newly-added circuits.
**PWA behaviour:** `SonnetSession.sendJobStateUpdate(jobState)` exists at `web/src/lib/recording/sonnet-session.ts:432-435` but `grep -rn sendJobStateUpdate web/src` shows **zero call sites**. The CCU flow in `circuits/page.tsx:148-153` runs `updateJob(patch)` without wiring back to the recording chrome. If the inspector is recording while they re-photograph a board (iOS flow allows this — the TTS prompt fires immediately), Sonnet never sees the new circuits.
**Evidence:** `web/src/lib/recording/sonnet-session.ts:432`:
```
sendJobStateUpdate(jobState: unknown): void {
```
Defined, typed, never invoked.
**User impact:** Parity with iOS mid-session CCU-update-then-dictate. Very common for Mode 2 flows where the inspector photographs a new board, then dictates readings against it — on PWA, Sonnet still thinks the old circuit list is active and mis-maps readings.
**Proposed fix:** Wire the recording-chrome VM to observe CCU applies (or re-emit from `JobProvider` when `circuits` change while a session is open) and call `session.sendJobStateUpdate(job)`.
**Touchpoints:** `web/src/lib/recording/apply-ccu-analysis.ts` (return a signal), `web/src/components/recording/recording-chrome.tsx`, `web/src/lib/job-context.tsx` (broadcast change).

### Gap #5 — PWA CCU has no pending-extractions queue (network-failure photo loss) [P0]
**Area:** Circuits → CCU → retry
**iOS behaviour:** On retryable error, `processPhoto` saves the photo via `PendingExtractionQueue.shared.saveFailedExtraction(...)` keyed by `jobId` + `mode` (`CCUExtractionViewModel.swift:167-181`). `CircuitsTab` renders a "N PHOTOS PENDING EXTRACTION" banner with per-row retry + bulk Retry All, and auto-retries when `NetworkMonitor.isConnected` transitions false → true (`CircuitsTab.swift:272-297, 486-491`).
**PWA behaviour:** On error, `handleCcuFile` shows `setCcuError(message)` and the user must re-pick the file. No disk persistence, no queue, no auto-retry. The parity ledger notes this was deferred ("CCU pending-extractions queue — IDB blob store + replay worker") but the iOS queue is a first-class UX.
**Evidence:** `web/src/app/job/[id]/circuits/page.tsx:166-178`. The existing offline outbox (Phase 7c) is for JobDetail mutations only — it does not accept multipart file payloads. Verified: `grep -rn PendingExtraction web/src` → zero hits.
**User impact:** On-site inspectors with flaky signal lose the photo if the POST fails — they must re-take. The iOS queue also stores enough metadata (`mode`) to resubmit with the correct semantics; the PWA has nowhere to persist this.
**Proposed fix:** Stand up an IDB blob store + replay worker for CCU photos (handoff text in `web/docs/parity-ledger.md` specifies roughly this shape). Hook `NetworkMonitor` (already available at `web/src/components/pwa/offline-indicator.tsx`) to trigger flush on reconnect.
**Touchpoints:** New `web/src/lib/offline/ccu-queue.ts`; UI in `web/src/app/job/[id]/circuits/page.tsx`; replay worker extension of `web/src/lib/offline/outbox-worker.ts` (if that file exists from Phase 7c — confirm).

### Gap #6 — PWA does not surface low-confidence warning after CCU analysis [P1]
**Area:** Circuits → CCU → post-analysis UX
**iOS behaviour:** If `analysis.confidence.imageQuality == "poor"` OR `confidence.overall < 0.5`, iOS raises a dismissible alert ("Board scan confidence is low. Please check the circuit descriptions are correct.") AND queues an informational TTS prompt (`CCUExtractionViewModel.swift:374-391`, `JobDetailView.swift:801-823`). Partially-readable quality shows an alert too (`:819-820`).
**PWA behaviour:** `CCUAnalysis.confidence` is parsed by the Zod schema (`web/src/lib/adapters/ccu.ts:58-66`) but never surfaced in the UI. `applyCcuAnalysisToJob` returns `questions` but not `confidence`. The inspector has no visual warning that the extraction is unreliable.
**Evidence:** `grep -rn "confidence\.overall\|image_quality\|Board scan confidence" web/src` → only types and schema hits, no render sites.
**User impact:** Inspectors review CCU-filled circuits without knowing the analyser flagged the photo as poor-quality. False confidence in autofilled hardware fields.
**Proposed fix:** Return `analysis.confidence` from `applyCcuAnalysisToJob`; render a dismissible amber banner when `image_quality !== 'clear'` OR `overall < 0.5`. Copy must match iOS exactly.
**Touchpoints:** `web/src/lib/recording/apply-ccu-analysis.ts:346-388`; `web/src/app/job/[id]/circuits/page.tsx:82-95, 138-178`.

### Gap #7 — PWA source picker skips "Choose from Library" UX on CCU [P1]
**Area:** Circuits → CCU → photo source choice
**iOS behaviour:** After mode selection, iOS shows a `confirmationDialog` with three buttons: Take Photo (camera), Choose from Library (photosPicker), Cancel (`CircuitsTab.swift:437-455`). Both paths are first-class.
**PWA behaviour:** Single `<input type="file" accept="image/*" capture="environment">` — the `capture` hint forces rear-camera on iOS Safari by default, and library picker access depends on the browser honouring a long-press / "more" menu. On iOS Safari 16+, `capture="environment"` opens the camera directly with only a small "Photo Library" toggle; on some Android WebViews, `capture` suppresses the library picker entirely.
**Evidence:** `web/src/app/job/[id]/circuits/page.tsx:278-286`.
**User impact:** Inspector who already photographed the board to their phone library cannot predictably get to it. On iOS the discoverability is hidden behind a system picker toggle; on Android it varies by OEM.
**Proposed fix:** Replace the single input with an action sheet mirroring iOS (Take Photo → `capture="environment"`; Choose from Library → no `capture` hint). Add a Cancel action. Keep both paths in the DOM and choose which input to click based on user selection.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:132, 278-286`.

### Gap #8 — PWA does not route RCD / illegible questions separately (TTS vs dismissible) [P2]
**Area:** Circuits → CCU → questionsForInspector
**iOS behaviour:** `routeQuestionsToTTS` classifies each question: "rcd type" keyword → interactive TTS + AlertManager queue; "cannot read / illegible" → informational TTS; anything else dropped (`CCUExtractionViewModel.swift:326-372`). RCD questions trigger `forceStartRecording()` via `hasInteractiveQuestions` (`:39-41`).
**PWA behaviour:** All questions shown as dismissible chips — no classification, no TTS. `ccuQuestions` list is treated as a flat string array (`web/src/app/job/[id]/circuits/page.tsx:331-354`).
**User impact:** Lower priority than the other gaps because the chips are at least visible. But inspectors dictating answers while driving / working hands-free miss the audio prompt for RCD type. Partial regression vs iOS workflow.
**Proposed fix:** Short-term: acceptable as-is. Longer-term: wire TTS playback to the chip list for phone-mounted-on-van-dash workflows.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:331-354`; `web/src/components/recording/recording-chrome.tsx` (TTS queue).

### Gap #9 — PWA ref-match is case-insensitive, iOS preserves casing on match but drops lowercase duplicates silently [P2]
**Area:** Circuits → CCU → ref normalisation
**iOS behaviour:** `CircuitMatcher` matches on normalised label (lowercased, abbreviations expanded). Ref comparison by `String(circuitNumber)` is exact-decimal.
**PWA behaviour:** `existingByRef.set(ref.toLowerCase(), idx)` in the doc extractor (`apply-document-extraction.ts:231`) and plain equality in CCU (`apply-ccu-analysis.ts:223-226`). CCU's `Map<string, CircuitRow>` will silently collide if two circuits share a ref (e.g. both numbered "3" across boards). The `other-board` split already handles the multi-board case, but the lookup is scoped to `boardCircuits` filter that treats `board_id == null` circuits as members of the target board (`apply-ccu-analysis.ts:215-217`) — meaning a stray null-boarded row can shadow the real one.
**Evidence:** `web/src/lib/recording/apply-ccu-analysis.ts:215-216`:
```
const boardCircuits = allCircuits.filter(
  (c) => (c.board_id as string | undefined) === boardId || c.board_id == null
);
```
**User impact:** Boardless circuits (previously-imported rows or pre-multi-board CCU entries) get absorbed into the target board's match pool. iOS has no equivalent issue because `boardCircuits` is strictly `boardId == targetBoardId` (`CCUExtractionViewModel.swift:138`: `viewModel.job.circuits.filter { $0.boardId == boardId }`).
**Proposed fix:** Tighten the filter to `board_id === boardId` only. If the PWA needs to also migrate null-boarded circuits, do so explicitly before matching.
**Touchpoints:** `web/src/lib/recording/apply-ccu-analysis.ts:215-217`.

---

## B) FUSEBOARD MATCHER DETAILS

### Gap #10 — Match-review "preserved readings" marker and confidence badge absent on PWA [P0 — covered by Gap #2]
(Not separately scoped — the per-row green "readings preserved" + confidence % badge from `CircuitMatchReviewView.swift:116-145` is part of the review UI that does not exist on the web at all. Mentioned here so the Phase 2 data-shape audit doesn't duplicate.)

### Gap #11 — Unmatched-with-readings preservation diverges on ordering [P1]
**Area:** Circuits → CCU → apply
**iOS behaviour:** Unmatched old circuits with readings are appended **after the new analysis order** with their original `circuitDesignation` (`FuseboardAnalysisApplier.swift:176-186`).
**PWA behaviour:** Same intent — appends to `next` array after loop (`web/src/lib/recording/apply-ccu-analysis.ts:245-250`), but the reading-keys list differs:
```
// iOS: measuredZsOhm, r1R2Ohm, irLiveEarthMohm, irLiveLiveMohm, rcdTimeMs,
//      ringR1Ohm, ringRnOhm, ringR2Ohm, polarityConfirmed
// PWA: measured_zs_ohm, r1_r2_ohm, r2_ohm, ir_live_earth_mohm, ir_live_live_mohm,
//      rcd_time_ms, ring_r1_ohm, ring_rn_ohm, ring_r2_ohm, polarity_confirmed
```
PWA has added `r2_ohm`; iOS list does not. Circuits with only an `r2_ohm` entry are preserved on web and dropped on iOS.
**Evidence:** `web/src/lib/recording/apply-ccu-analysis.ts:40-51` vs iOS `FuseboardAnalysisApplier.swift:177-181`.
**User impact:** Minor. PWA is the more lossless variant. Only relevant if a data-roundtrip (PWA → iOS sync → PWA) must preserve the distinction.
**Proposed fix:** Decide canonical list; if iOS is truly canon, remove `r2_ohm` from the PWA list.
**Touchpoints:** `web/src/lib/recording/apply-ccu-analysis.ts:40-51`.

### Gap #12 — "is_rcbo → rcdType = RCBO" marker on new (unmatched) circuits only [P1]
**Area:** Circuits → CCU → RCBO handling
**iOS behaviour:** `applyMatchedHardware` does NOT set `rcdType = "RCBO"` on matched circuits (`FuseboardAnalysisApplier.swift:142-144`: only sets rcdType if rawType is in validRcdTypes). On unmatched (new) circuits, falls back to `RCBO` when `isRcbo == true` and no valid type (`:163-167`). Rationale: existing circuit keeps its correctly-typed RCD value.
**PWA behaviour:** Matches the iOS rule for new circuits (`apply-ccu-analysis.ts:320-327`). For matched circuits, it too declines to set RCBO (`:284-285` only sets when `normaliseRcdType` returns a valid string) — OK.
**Evidence:** Re-reading `apply-ccu-analysis.ts:282-287` confirms parity. No action.
**User impact:** None.
**Proposed fix:** No-op — leaving logged because the RCBO-vs-RCD distinction is subtle and confusing to audit re-entrants.

---

## C) DOCUMENT EXTRACTION

### Side-by-side matrix

| Concern | iOS (canon) | PWA | Status |
|---|---|---|---|
| Entry point — Circuits tab | "Extract Doc" button in rail | "Extract" rail button | OK |
| Entry point — JobDetail root | `JobDetailView.swift:851` calls `analyzeDocument(imageData)` | **Not exposed from JobDetail root — only Circuits** | DIVERGENT (P1) |
| Source dialog | Take Photo / Library / Files (PDF supported) | Single `<input accept="image/*">` | DIVERGENT (P0) |
| PDF support | `ImageScaler.isPDF(...) → renderPDFToImage(...)` | **PDF explicitly not supported** | DIVERGENT (P0) |
| Apply policy | `onlyFillEmpty: true` (intended) but merges non-empty over existing on sections — documented drift | Fill-empty-only on all sections | DIVERGENT (P2 — PWA is safer, see Exception #2) |
| Circuit merge | `CertificateMerger` — fuzzy on designation + ref | Ref-only, case-insensitive | DIVERGENT (P1) |
| Observations merge | Dedupe by (schedule_item + code) OR (location + 50-char prefix) | Matches | OK |
| Cost display | Not displayed | Not displayed | OK (parity with iOS — Exception #1) |
| States | uploading / analysing / error | busy / error | OK |
| Post-extraction notice | Implicit via filled fields | "Document read — X circuits, Y observations merged" | PWA better; OK |

Evidence: iOS `CertMateUnified/Sources/ViewModels/JobViewModel.swift:635-660`, `CertMateUnified/Sources/Processing/CertificateMerger.swift:1-167`, `CertMateUnified/Sources/Views/JobDetail/CircuitsTab.swift:493-540`, `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:847-860`. PWA `web/src/lib/recording/apply-document-extraction.ts`, `web/src/app/job/[id]/circuits/page.tsx:184-233`.

---

### Gap #13 — PWA cannot ingest PDFs for document extraction; iOS can [P0]
**Area:** Circuits → Extract Doc
**iOS behaviour:** `analyzeDocument` detects PDF via `ImageScaler.isPDF(imageData)`, renders page 1 to a scaled JPEG, then POSTs to `/api/analyze-document` (`JobViewModel.swift:639-651`). UI exposes "Choose from Files" in the source dialog (`CircuitsTab.swift:500-503`) using `.fileImporter(allowedContentTypes: [.image, .pdf])` (`:531-533`).
**PWA behaviour:** Input restricted to `accept="image/*"` (`circuits/page.tsx:295-302`). Inline comment acknowledges: "PDF support is a separate follow-up (requires a client-side pdfjs-dist render)." The backend `/api/analyze-document` route hard-codes `image/jpeg` so even if the PWA sent a PDF, the multipart would fail validation.
**Evidence:** `web/src/app/job/[id]/circuits/page.tsx:295-302` and the inline comment at `:288-294`.
**User impact:** Inspectors cannot extract fields from a prior EICR PDF emailed to them — a real daily workflow. They must either screenshot the PDF (degrades OCR quality) or open it elsewhere and re-type.
**Proposed fix:** Add client-side PDF → JPEG render using `pdfjs-dist` (lazy-loaded from a dynamic import so the initial bundle stays small), mirroring the iOS approach. Accept `.pdf` in the input, detect by MIME, render, then submit.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:189-233`; add `web/src/lib/pdf/render-first-page.ts`.

### Gap #14 — PWA does not expose document extraction from JobDetail root; iOS does [P1]
**Area:** Navigation — document-extraction entry points
**iOS behaviour:** BOTH `CircuitsTab` (`CircuitsTab.swift:2099-2110`) AND `JobDetailView` root (`JobDetailView.swift:847-860`) can trigger `analyzeDocument`. The root-level entry lets an inspector extract a prior EICR before opening any tab — they land on the job, upload the PDF/photo, and every tab is prefilled.
**PWA behaviour:** Only reachable from Circuits tab's "Extract" rail button. No root-level FAB / overview entry.
**Evidence:** `web/src/app/job/[id]/page.tsx` (overview page) does not render any document-extraction control; `grep -rn analyzeDocument web/src/app` → only `circuits/page.tsx`.
**User impact:** Discoverability. Inspectors new to the flow don't realise they can kick off extraction before opening Circuits, or they think Circuits is the only place it ever lives.
**Proposed fix:** Add a root-level "Extract Document" entry — either as an overflow-menu item in the job header, or as part of the FAB cluster on Overview.
**Touchpoints:** `web/src/components/job/job-header.tsx`, `web/src/app/job/[id]/page.tsx`, `web/src/components/job/floating-action-bar.tsx`.

### Gap #15 — Document circuit merge uses ref-only, not iOS fuzzy matcher [P1]
**Area:** Circuits → Extract Doc → per-circuit merge
**iOS behaviour:** `CertificateMerger` uses the same `CircuitMatcher` fuzzy-designation logic (Levenshtein + Jaccard + semantic) plus ref match (iOS approach is to match by designation when refs don't align, critical for hand-written sheets where the inspector wrote "Sockets Up" not "3").
**PWA behaviour:** `mergeCircuits` matches strictly on `circuit_ref.toLowerCase()` (`apply-document-extraction.ts:228-241`). Hand-written sheets where the "ref" column is blank but the designation is present produce only new-circuit inserts.
**Evidence:** `web/src/lib/recording/apply-document-extraction.ts:228-241`. Inline comment "iOS Levenshtein fuzzy designation matcher (ref-match only)" acknowledges the drift at line 25.
**User impact:** Same class of drift as Gap #3 but for document extraction. Handwritten test sheets (which typically omit ref numbers and rely on label continuity) don't round-trip cleanly — each circuit is inserted as "new" and the inspector has to manually merge.
**Proposed fix:** Reuse the shared `circuit-matcher.ts` ported for Gap #3.
**Touchpoints:** `web/src/lib/recording/apply-document-extraction.ts:220-281`.

### Gap #16 — Document source dialog missing Take Photo / Library / Files choice [P1]
**Area:** Circuits → Extract Doc → picker UX
**iOS behaviour:** `confirmationDialog` offers three paths: Take Photo / Choose from Library / Choose from Files (`CircuitsTab.swift:493-510, 531-540`). Files path opens `.fileImporter(allowedContentTypes: [.image, .pdf])`.
**PWA behaviour:** Single `<input>` with no `capture` hint (favours library). No explicit Take-a-photo path; on iOS Safari the browser may offer both, but there is no deterministic way for the inspector to force camera.
**Evidence:** `web/src/app/job/[id]/circuits/page.tsx:295-302`.
**User impact:** An inspector who wants to photograph a handwritten sheet right now has to tap the system picker's submenu. Parity with iOS would present a dedicated camera entry.
**Proposed fix:** Action-sheet with two/three buttons; `capture="environment"` on the camera variant.
**Touchpoints:** Combined fix with Gap #7.

---

## Exceptions / intentional divergence

1. **Cost display absent on both iOS and PWA for CCU + Document.** iOS returns `gptVisionCost` from the backend (`APIClient.swift`) but does not render it anywhere in the capture UI. PWA similarly parses but does not render. This is parity with iOS, not a gap, so no P0/P1 is raised. Phase 6 owns the recording-session cost banner; CCU/document costs are outside that scope.

2. **PWA document extraction is stricter ("fill-empty-only on all sections") than iOS `CertificateMerger`.** iOS overwrites non-empty extracted values on installation / supply / board (`CertificateMerger.swift:7-167`) when `onlyFillEmpty: false`; PWA hard-codes fill-empty-only everywhere. The PHASE_5 handoff noted: "the fill-empty-only policy across all sections so a user mid-edit never has their typing clobbered" — documented intent, stricter than canon. Counted as **P2 divergence (PWA safer)**, not P0.

---

## Cross-cutting notes

- **Pending-extractions queue status:** Parity ledger flagged as deferred. Confirmed still deferred (Gap #5). `grep -rn PendingExtraction web/src` → 0 hits.
- **Board targeting parity:** PWA correctly reads `selectedBoardId` and passes through `targetBoardId` to the appliers. No gap here — both platforms scope per-board correctly (iOS: `CCUExtractionViewModel.swift:136-138`; PWA: `circuits/page.tsx:148-150`).
- **"Boardless circuits" handling:** Phase 5 caught a bug where iOS excluded boardless circuits from bulk actions. PWA's CCU applier at `apply-ccu-analysis.ts:215-217` INCLUDES `board_id == null` in the target-board filter — this is opposite of iOS (`CCUExtractionViewModel.swift:138` uses strict equality). See Gap #9.
- **Slot-crop UI (`analysis.slots` with base64 crops):** iOS has scaffolding for a tap-to-correct grid (`FuseboardAnalysis.swift:63-112`). Neither platform renders it yet — parity, not a gap.
- **Web Phase 8 is NOT the production cutover Phase 8** (`docs/reference/changelog.md` 2026-04-18 entry refers to `eicr-pwa` task definition rollout). This audit is the parity-audit Phase 8 on branch `stage6-agentic-extraction`.

---

## Open questions for the user

1. **Mode selection sheet + match review (Gaps #1, #2, #3):** ship all three together as "CCU v2", or incremental? They share the same port (CircuitMatcher TS) and UX scaffolding, so landing together is cheaper than sequential.
2. **PDF support for document extraction (Gap #13):** accept `pdfjs-dist` dependency weight (~2 MB gz) behind a dynamic import, or route PDFs through the backend (multipart with `application/pdf` → server renders)? Backend route would avoid client bundle cost but add latency + server CPU.
3. **Pending-extractions queue (Gap #5):** build on top of Phase 7c offline outbox (reuse IDB + worker), or a dedicated blob queue? Both are documented in the ledger; no prior decision.
