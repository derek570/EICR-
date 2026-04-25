# Phase 5: Job-Editor Staff tab & PDF tab — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction_

## Summary
Gaps found: 14  (P0: 7  P1: 5  P2: 2)
Exceptions (intentional divergence, documented): 0

Cross-reference:
- Phase 1 Gap #5 (Staff roster never fetched on PWA) — **carried forward, now P0-ified and expanded as Gap #5.1 below**.
- Mini-wave 4.5 handoff entry "InspectorProfile shape drift" — expanded below (Gap #5.10).

Canonical iOS files consulted:
- `CertMateUnified/Sources/Views/JobDetail/InspectorTab.swift` (241 lines)
- `CertMateUnified/Sources/Views/JobDetail/PDFTab.swift` (294 lines)
- `CertMateUnified/Sources/PDF/PDFGenerator.swift` (69 lines)
- `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift`
- `CertMateUnified/Sources/Models/Inspector.swift` (50 lines)
- `CertMateUnified/Sources/ViewModels/JobViewModel.swift` lines 299-300 (`fetchAllInspectors`) + 672-685 (`pdfWarnings`)

PWA files audited:
- `web/src/app/job/[id]/staff/page.tsx` (328 lines)
- `web/src/app/job/[id]/pdf/page.tsx` (201 lines)
- `web/src/lib/api-client.ts` (inspector-profile + absent PDF endpoints)
- `web/src/lib/types.ts:65-85` (InspectorProfile)
- `packages/shared-types/src/job.ts:104-111` (InspectorProfile — 6-field subset)
- `src/routes/pdf.js` (backend PDF route — Python ReportLab, not HTML)

---

## STAFF TAB — Evidence tables

### Section ordering per cert type

| Role card | iOS EICR | iOS EIC | PWA EICR | PWA EIC |
|---|---|---|---|---|
| Hero header | idx 0 | idx 0 | present | present |
| Inspected & Tested By (inspector_id) | idx 1 | — | idx 1 | — |
| Authorised By (authorised_by_id) | idx 2 | — | idx 2 | — |
| Responsible for Design (designer_id) | — | idx 1 | — | idx 1 |
| Responsible for Construction (constructor_id) | — | idx 2 | — | idx 2 |
| Inspection & Testing (inspector_id) | — | idx 3 | — | idx 3 |
| Test Equipment (conditional on inspector selected) | trailing | trailing | trailing | trailing |

Section order matches. Source: `InspectorTab.swift:19-56` vs `web/src/app/job/[id]/staff/page.tsx:105-151`.

### Field shape — Inspector record

| Field | iOS `Inspector.swift` | web `lib/types.ts:65` (`InspectorProfile`) | shared-types `job.ts:104` (`InspectorProfile`) | PWA staff page's local `Inspector` (`staff/page.tsx:39-53`) |
|---|---|---|---|---|
| id | `id: String` | `id` | `id` | `id` |
| name | `firstName` + `lastName` (computed `fullName`) | `name` | `name` | `full_name` |
| position | `position: String` | `position?` | `position?` | `position?` |
| organisation | — | `organisation?` | `organisation?` | — |
| enrolment_number | — | `enrolment_number?` | `enrolment_number?` | — |
| signature | `signatureImage: Data?` (raw PNG bytes) | `signature_file?` (S3 key) | `signature_file?` (S3 key) | — **ABSENT** |
| is_default | `isDefault: Bool` | `is_default?` | — | — |
| MFT serial / cal | `mftSerialNumber` / `mftCalibrationDate` | `mft_serial_number?` / `mft_calibration_date?` | — | `mft_serial?` / `mft_calibration_date?` |
| Continuity serial / cal | `continuitySerialNumber` / `continuityCalibrationDate` | `continuity_serial_number?` / `continuity_calibration_date?` | — | `continuity_serial?` / `continuity_calibration_date?` |
| Insulation serial / cal | `insulationSerialNumber` / `insulationCalibrationDate` | `insulation_serial_number?` / `insulation_calibration_date?` | — | `insulation_serial?` / `insulation_calibration_date?` |
| Earth-Fault serial / cal | `earthFaultSerialNumber` / `earthFaultCalibrationDate` | `earth_fault_serial_number?` / `earth_fault_calibration_date?` | — | `earth_fault_serial?` / `earth_fault_calibration_date?` |
| RCD serial / cal | `rcdSerialNumber` / `rcdCalibrationDate` | `rcd_serial_number?` / `rcd_calibration_date?` | — | `rcd_serial?` / `rcd_calibration_date?` |

**Three InspectorProfile shapes exist in this repo and they DISAGREE.** See Gaps #5.3 and #5.10.

---

## PDF TAB — Evidence tables

### Layout ordering

| Element | iOS PDFTab | PWA pdf/page |
|---|---|---|
| Hero header with status dot (pending / generated) | yes (`PDFTab.swift:69-121`) | yes (`pdf/page.tsx:61-86`) |
| Warnings card (when non-empty) | yes, `MISSING DATA` card (`PDFTab.swift:125-155`) | yes, "Missing data" card (`pdf/page.tsx:88-105`) |
| Error banner | yes (`PDFTab.swift:28-38`) | — |
| All-green success card (when ready) | **NO** — iOS just lights the status dot green and silently succeeds | yes, "All sections complete" (`pdf/page.tsx:106-113`) |
| Actions row (Generate / Preview / Share) | yes (`PDFTab.swift:159-241`) | yes (`pdf/page.tsx:115-126`) — **all disabled** |
| Generating overlay (full-screen blur + spinner) | yes (`PDFTab.swift:245-262`) | — |
| Preview sheet (`PDFPreviewController`) | yes (`PDFTab.swift:53-57`) | — |
| Share sheet (ShareLink → file URL) | yes (`PDFTab.swift:225-236`) | — |

### Warning set

| Warning | iOS `pdfWarnings()` (`JobViewModel.swift:672-685`) | PWA `computeWarnings()` (`pdf/page.tsx:133-163`) |
|---|---|---|
| Company details not configured | yes ("Company details not configured — certificate will be missing contractor information.") | — **MISSING** |
| Inspector removed (dangling id) | yes ("Assigned inspector has been removed — certificate will be missing inspector details.") | — **MISSING** |
| Inspector not selected | yes ("No inspector selected — certificate will be missing inspector details and signature.") | yes ("Inspector not assigned (Staff tab)" — EICR) / ("Inspection & testing not assigned (Staff tab)" — EIC) |
| Installation address not set | — **iOS does NOT warn** | yes ("Installation address not set") |
| Inspection date not set | — **iOS does NOT warn** | yes ("Inspection date not set") |
| No boards added | — **iOS does NOT warn** | yes ("No boards added (Board tab)") |
| No circuits added | — **iOS does NOT warn** | yes ("No circuits added (Circuits tab)") |
| Authoriser (EICR) not assigned | — **iOS does NOT warn** | yes ("Authoriser not assigned (Staff tab)") |
| Designer / Constructor (EIC) not assigned | — **iOS does NOT warn** | yes ("Designer not assigned …", "Constructor not assigned …") |

**Disjoint sets.** iOS has 3 warnings total; PWA has 7-9 depending on cert type; only 1 overlaps (inspector). See Gap #5.6 + #5.7.

### Data shape — generation endpoint

| Aspect | iOS | Backend (referenced by PWA comment) | PWA (actual) |
|---|---|---|---|
| Generator | **local on-device** HTML→PDF via WKWebView (`PDFGenerator.swift:9-68` → `EICRHTMLTemplate.build` → `HTMLPDFRenderer.render`) | `POST /api/job/:userId/:jobId/generate-pdf` runs Python ReportLab on files fetched from S3 (`src/routes/pdf.js:22,219,226`) | **No call.** `Generate/Preview/Share` buttons are `disabled` stubs (`pdf/page.tsx:117-119`) |
| Cert-type branching | `EICRHTMLTemplate.build` checks `job.certificateType` and branches pages (`EICRHTMLTemplate.swift:12-75`) | Hard-coded `eicr_certificate.pdf` output filename (`src/routes/pdf.js:248`); no EIC template branch visible in this route | N/A |
| Response mime | raw `Data` → `Data?` state | `application/pdf`, `Content-Disposition: attachment; filename="EICR_${jobId}.pdf"` (`src/routes/pdf.js:265-266`) | N/A |
| Temp file format | `CertMate-Certificate-<uuid>.pdf` in `FileManager.default.temporaryDirectory` (`PDFTab.swift:277-279`) | `EICR_${jobId}.pdf` | N/A |
| Preview | `PDFPreviewController(pdfData:)` sheet | N/A (download only) | — |
| Share | SwiftUI `ShareLink(item: url, preview:)` with `doc.richtext` icon | N/A | — |
| Cache-busting | N/A (new UUID per run) | N/A | N/A |

---

## Gaps

### Gap #5.1 — Staff roster never fetched; all role pickers always empty  [P0 — carried forward from Phase 1 Gap #5, re-graded]
**Area:** Staff tab → inspector roster
**iOS behaviour:** `InspectorTab.onAppear` (`InspectorTab.swift:68-72`) calls `viewModel.fetchAllInspectors()` (`JobViewModel.swift:299-300` → `AppDatabase.fetchAllInspectors()` at `Database/InspectorRecord.swift:21`), populating the role pickers from the local DB roster (`InspectorTab.swift:5,126`).
**PWA behaviour:** `staff/page.tsx:71-72` reads `const inspectors = (data as StaffJobShape).inspectors ?? []` — there is no `useEffect` that calls `api.inspectorProfiles(userId)` (`api-client.ts:445-451`), and `JobProvider`/`job-context.tsx` does not fetch or embed it either (grep: `inspector` matches only one comment line at `job-context.tsx:206`). Consequence: the `inspectors` array is **always `[]`** in every render path, so every role picker always falls through to the empty-state hint (`staff/page.tsx:177-193`).
**Evidence:** `staff/page.tsx:71-72`:
```
const data = job as unknown as StaffJobShape;
const inspectors = data.inspectors ?? [];
```
and `api-client.ts:445-451` — `inspectorProfiles(userId)` is plumbed but has zero call sites outside `/settings/staff` (grep).
**User impact:** On both EICR and EIC, no inspector can ever be selected. `inspector_id` / `authorised_by_id` / `designer_id` / `constructor_id` never populate, which in turn fires multiple downstream PDF warnings (Gap #5.7) and — if the PDF were wired — would render signatory-missing certs.
**Proposed fix:** Call `api.inspectorProfiles(user.id)` in a `useEffect` on mount, mapping each `InspectorProfile` to the local `Inspector` shape the picker consumes. Alternatively embed roster into `JobDetail` server-side.
**Touchpoints:** `web/src/app/job/[id]/staff/page.tsx`, possibly `web/src/lib/job-context.tsx`.

### Gap #5.2 — Selected inspector's signature is never rendered on PWA Staff tab  [P1]
**Area:** Staff tab → picker row visuals
**iOS behaviour:** iOS does NOT render the signature image on the picker itself (confirmed: `InspectorTab.swift` has zero `signatureImage` references). The signature ships to the PDF only. So strictly speaking iOS and PWA match for picker rendering.
**PWA behaviour:** Same — `staff/page.tsx` has zero `signature_file` / `signatureFile` references. However the empty-state hint at `staff/page.tsx:187-192` promises that selecting an inspector "will auto-fill name, position, enrolment number, **signature** & test-equipment serials on the final PDF" — the contract implied to the user (signature plumbed) is unverifiable today because PDF generation is stubbed (Gap #5.5).
**Evidence:** `staff/page.tsx:187-192`; `InspectorTab.swift` — no signature rendering in picker surface.
**User impact:** None at picker level today (iOS also doesn't render). Flagged as P1 because the copy implies an end-to-end signature plumb that has no test in the PWA (no generation endpoint exercises it).
**Proposed fix:** Once the PDF endpoint is wired (Gap #5.5), backfill a test that signature key round-trips through staff selection → generate-pdf → rendered PDF.
**Touchpoints:** test-only; no UI change required for parity.

### Gap #5.3 — PWA Staff page uses different equipment-field keys than the rest of web + shared-types  [P0]
**Area:** Staff tab → Test Equipment card, data access
**iOS behaviour:** iOS `Inspector.swift:17-26` owns the canonical field names: `mftSerialNumber`, `mftCalibrationDate`, `continuitySerialNumber`, `continuityCalibrationDate`, `insulationSerialNumber`, `insulationCalibrationDate`, `earthFaultSerialNumber`, `earthFaultCalibrationDate`, `rcdSerialNumber`, `rcdCalibrationDate` — i.e. serials are `*SerialNumber` not `*Serial`.
**PWA behaviour:** THREE incompatible shapes exist in the web repo:
1. `web/src/app/job/[id]/staff/page.tsx:39-53` declares a local `Inspector` with keys `mft_serial`, `continuity_serial`, `insulation_serial`, `earth_fault_serial`, `rcd_serial` (NO `_number` suffix).
2. `web/src/lib/types.ts:74-83` — the project-wide `InspectorProfile` — uses `mft_serial_number`, `continuity_serial_number`, `insulation_serial_number`, `earth_fault_serial_number`, `rcd_serial_number` (WITH `_number`, matching iOS snake_cased).
3. `packages/shared-types/src/job.ts:104-111` — the contractual wire type — has **none of the equipment fields at all**.
**Evidence:**
- `staff/page.tsx:43-51`: `mft_serial?`, `continuity_serial?`, `insulation_serial?`, `earth_fault_serial?`, `rcd_serial?`
- `staff/page.tsx:254-279`: `inspector.mft_serial`, `inspector.continuity_serial`, etc.
- `web/src/lib/types.ts:74-83`: `mft_serial_number?`, `continuity_serial_number?`, etc.
- `packages/shared-types/src/job.ts:104-111`: only `id, name, organisation, enrolment_number, signature_file, position` — no equipment.
**User impact:** Even after Gap #5.1 is fixed (roster fetched from `api.inspectorProfiles`), the Staff tab's Test-Equipment card will still render `—` for every row because the PWA keys on `mft_serial` while the backend/API returns `mft_serial_number` (per the web `InspectorProfile` type used in Settings → Staff where the forms are authored). The data will be present in memory but invisible on the Staff tab. This is a silent data-disappearance bug latent behind the Gap #5.1 wrapper.
**Proposed fix:** In `staff/page.tsx`, either (a) drop the local `Inspector` type and import `InspectorProfile` from `@/lib/types`, or (b) rename the 10 equipment keys to `*_serial_number` / `*_calibration_date` so they match the API shape.
**Touchpoints:** `web/src/app/job/[id]/staff/page.tsx`.

### Gap #5.4 — Signature UX copy promises "Add inspectors under Settings → Inspectors (Phase 6)" but the Settings path is `/settings/staff`  [P2]
**Area:** Staff tab → empty-state copy
**iOS behaviour:** No Phase-6 reference; iOS uses `"No staff profiles configured"` (`InspectorTab.swift:120`).
**PWA behaviour:** `staff/page.tsx:186-192` says "Add inspectors under **Settings → Inspectors** (Phase 6)". The actual route on web is `/settings/staff` — confirmed by import paths in `web/src/app/settings/staff/page.tsx` (found in grep). And Phase 6 shipped 2026-04-17 (per `CLAUDE.md` changelog), so the parenthetical is stale.
**Evidence:** `staff/page.tsx:187-192` literal text; `web/src/app/settings/staff/page.tsx` exists (web Phase 6a per CLAUDE.md).
**User impact:** Copy misdirects the inspector: the implied link target doesn't exist. Also self-dates the UI as in-progress when Phase 6 is closed.
**Proposed fix:** Copy: "Add inspectors under Settings → Staff" (or make it a real `<Link href="/settings/staff">`).
**Touchpoints:** `web/src/app/job/[id]/staff/page.tsx`.

### Gap #5.5 — PDF tab's Generate / Preview / Share buttons are all disabled stubs  [P0]
**Area:** PDF tab → actions
**iOS behaviour:** PDF tab has three live actions:
- Generate → `PDFGenerator.generate(from: job)` → writes a temp file, sets `pdfData` + `pdfURL` (`PDFTab.swift:178-201, 270-292`).
- Preview → opens `PDFPreviewController(pdfData:)` sheet once data exists (`PDFTab.swift:53-57, 204-222`).
- Share → `ShareLink(item: pdfURL, preview:)` (`PDFTab.swift:225-236`).
- While generating, a full-screen `generatingOverlay` blocks input and shows a spinner (`PDFTab.swift:48-52, 245-262`).
**PWA behaviour:** All three buttons are `<ActionButton … disabled>` (`pdf/page.tsx:117-119`). The tab even admits it in copy: "PDF generation isn't wired up on web yet. … until then, generate from the iOS app." (`pdf/page.tsx:121-125`). The `Download` icon is imported for a future button that doesn't exist and suppressed as unused (`pdf/page.tsx:200`).
**Evidence:** `pdf/page.tsx:117-119`:
```
<ActionButton primary disabled label="Generate PDF" icon={Loader2} />
<ActionButton disabled label="Preview" icon={Eye} />
<ActionButton disabled label="Share" icon={Share2} />
```
and `pdf/page.tsx:122-125` — the "not wired up" disclaimer.
**User impact:** **The PDF tab ships zero functionality on web.** An inspector who completes an entire job in the PWA cannot produce a cert — they must open the iOS app. This is the single biggest parity gap in the app and contradicts the Phase-8-closed claim in CLAUDE.md ("Web rebuild shipped to production 2026-04-18").
**Proposed fix:** Wire `POST /api/job/:userId/:jobId/generate-pdf` (backend route already exists per `src/routes/pdf.js:22`). Client flow: fetch, turn response blob into object URL, stash in state, enable Preview (`<iframe src>` or `<embed>`) and Share (Web Share API / `<a download>`). Download button: `<a href={objectUrl} download={filename}>`.
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`; add `generatePdf()` in `web/src/lib/api-client.ts`.

### Gap #5.6 — PWA PDF warnings never check whether company details exist  [P1]
**Area:** PDF tab → warnings
**iOS behaviour:** `JobViewModel.pdfWarnings()` (`JobViewModel.swift:672-685`) warns "Company details not configured — certificate will be missing contractor information." when `fetchCompanyDetails()` returns nil.
**PWA behaviour:** `computeWarnings()` (`pdf/page.tsx:133-163`) does not check company settings at all. Since Phase 6b ships company settings, and a blank company block renders a contract-invalid PDF, this is a real omission.
**Evidence:** `pdf/page.tsx:133-163` — no reference to `companySettings`, `company`, `logo_file`, etc.
**User impact:** Inspector might generate a PDF missing contractor letterhead / logo and only find out from a client rejection.
**Proposed fix:** Add a `companySettings` fetch to the PDF page (or surface via context) and warn when name / postcode / logo are empty.
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`; possibly hoist settings into a shared provider.

### Gap #5.7 — Warning sets are disjoint between iOS and PWA (7 warnings present on one side only)  [P1]
**Area:** PDF tab → warnings
**iOS behaviour:** 3 warnings — company missing, inspector removed (dangling ref), inspector not selected (`JobViewModel.swift:672-685`).
**PWA behaviour:** 7-9 warnings — no address, no date, no boards, no circuits, no inspector, no authoriser/designer/constructor depending on cert type (`pdf/page.tsx:133-163`) — **but** none of iOS's three. Net: exactly one warning overlaps ("no inspector" in both, with different copy).
**Evidence:** see "Warning set" table above.
**User impact:** Bidirectional — a user flipping between platforms sees different readiness states for the same job. iOS lets you generate a PDF with a missing address (produces a blank address block); PWA would block you. PWA lets you generate with no company; iOS would warn.
**Proposed fix:** Align on the **union** of warnings as the canonical set, sourced into a shared helper (since backend PDF generation actually cares about all of these fields). Document anything deliberately omitted from a given platform as an exception.
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`; consider a shared helper in `packages/shared-utils` since the rule set is platform-agnostic.

### Gap #5.8 — PWA has no EIC-specific PDF template; backend Python pipeline hard-codes `eicr_certificate.pdf`  [P0]
**Area:** PDF tab → cert-type branching (server-side)
**iOS behaviour:** `EICRHTMLTemplate.build` branches extensively on `isEICR` (`EICRHTMLTemplate.swift:12-86`): different page counts (EICR 3 portrait + 3 inspection-schedule; EIC 2 portrait + 1 inspection-schedule), different sections (`buildPage2/3` for EICR Observations + General Condition; `buildEICSections` for EIC Extent & Type + Design & Construction). iOS generates a fully cert-type-correct PDF.
**Backend behaviour:** `src/routes/pdf.js:219,248` spawns `python/generate_full_pdf.py` and, on a parse miss, defaults to `eicr_certificate.pdf` — and sets `Content-Disposition: attachment; filename="EICR_${jobId}.pdf"` (`:266`) regardless of the job's certificate type. No branch on `certificate_type` is visible in this route.
**PWA behaviour:** N/A (Gap #5.5 — stubbed).
**Evidence:** `src/routes/pdf.js:265-266`:
```
res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Disposition", `attachment; filename="EICR_${jobId}.pdf"`);
```
plus the hard-coded fallback path at `:248`.
**User impact:** Once PDF is un-stubbed (Gap #5.5), EIC jobs will be served **as an EICR-named file** and — depending on how `generate_full_pdf.py` handles cert type — may also be rendered with the wrong template. iOS has no such drift because rendering is client-side and cert-aware.
**Proposed fix:** Extend the backend route to (a) read `job.certificate_type`, (b) select the right Python template, (c) name the file `EIC_${jobId}.pdf` vs `EICR_${jobId}.pdf`. Alternatively, relocate HTML-template rendering to the server (Playwright) using iOS's `EICRHTMLTemplate` equivalents for 1:1 parity.
**Touchpoints:** `src/routes/pdf.js`, `python/generate_full_pdf.py` (out of web/ scope; flag only).

### Gap #5.9 — PWA PDF filename format diverges from iOS  [P1]
**Area:** PDF tab → filename
**iOS behaviour:** `CertMate-Certificate-<uuid>.pdf` (`PDFTab.swift:277-278`) — human-friendly, includes product brand, no job-id in the name (users often rename anyway, and the share sheet preview uses `"Certificate PDF"` with `doc.richtext` icon — `:226`).
**Backend behaviour (inherits to PWA once wired):** `EICR_${jobId}.pdf` (`src/routes/pdf.js:266`) — terse, includes job UUID, no product brand, assumes EICR.
**PWA behaviour:** N/A today (Gap #5.5), but inherits backend on wire-up.
**Evidence:** both lines above.
**User impact:** Cross-platform inconsistency: an inspector who downloads from web and iOS in the same session gets two filename conventions for the same cert. Arguably the backend format is better (deterministic, contains jobId for audit), but the divergence should be a decision, not an accident.
**Proposed fix:** Pick one convention (recommend `CertMate-<certType>-<jobId-short>.pdf`); document decision; align both sides.
**Touchpoints:** `CertMateUnified/Sources/Views/JobDetail/PDFTab.swift:277-278`, `src/routes/pdf.js:266`.

### Gap #5.10 — shared-types `InspectorProfile` ships only 6 of the 10 iOS fields (equipment block absent)  [P1 — expansion of mini-wave 4.5 flagged drift]
**Area:** Contract package — `@certmate/shared-types`
**iOS behaviour:** `Inspector.swift:17-26` — 10 equipment fields (5 instruments × serial + cal).
**shared-types behaviour:** `packages/shared-types/src/job.ts:104-111` — `id, name, organisation, enrolment_number, signature_file, position` only. Zero equipment fields.
**PWA behaviour:** Web's local `InspectorProfile` (`web/src/lib/types.ts:65-85`) carries the full 10-field block; shared-types does not. Mini-wave 4.5 handoff (`web/reviews/MINI_WAVE_4_5_HANDOFF.md:54,129`) flagged this as "Kept local + flag" deferred to Phase 9 "contract alignment."
**Evidence:** `packages/shared-types/src/job.ts:104-111` side-by-side with `web/src/lib/types.ts:65-85`.
**User impact:** Any future consumer that imports `InspectorProfile` from `@certmate/shared-types` instead of `@/lib/types` will silently drop the equipment block. This is exactly the kind of trap Gap #5.3 already fell into (the local `Inspector` shape in `staff/page.tsx` diverged from the broader web type because the shared contract didn't lock the shape).
**Proposed fix:** Back-port the 10 equipment fields to `packages/shared-types/src/job.ts:InspectorProfile`; delete the web-local duplicate in favor of the shared one.
**Touchpoints:** `packages/shared-types/src/job.ts`; `packages/shared-types/src/schemas.ts` (no InspectorProfileSchema exists today — confirmed via grep, yet `web/src/lib/api-client.ts:33` imports `InspectorProfileListSchema` — worth verifying that import resolves); `web/src/lib/types.ts`.

### Gap #5.11 — PWA PDF tab has no error banner / no error state  [P1]
**Area:** PDF tab → error UX
**iOS behaviour:** PDF generation runs inside a `do/catch` that sets `errorMessage`, which renders as a red `xmark.octagon.fill` banner (`PDFTab.swift:28-38, 288-291`).
**PWA behaviour:** No `error` state; no `try/catch` scaffolding either (tab does not call anything). Once wired (Gap #5.5), an error surface will need to be added from scratch.
**Evidence:** `pdf/page.tsx` — grep for `error` shows only the imported `computeWarnings` and `ActionButton`.
**User impact:** Pre-wire, none. Post-wire, failed generations would be silent unless this is added alongside the fix for Gap #5.5.
**Proposed fix:** Include an error banner in the Gap #5.5 fix PR (don't stage them separately).
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`.

### Gap #5.12 — PWA PDF tab has no generating overlay / no loading state  [P1]
**Area:** PDF tab → loading UX
**iOS behaviour:** Full-screen `generatingOverlay` (`PDFTab.swift:48-52, 245-262`) shows while `isGenerating == true`. User cannot tap other actions while the render is in flight.
**PWA behaviour:** No equivalent. The `Generate PDF` button's icon is `Loader2` (`pdf/page.tsx:117`) but it's a static icon on a disabled button, not an actual spinner.
**Evidence:** `pdf/page.tsx:115-126`.
**User impact:** Post-wire, hitting Generate with no visual feedback would feel broken (backend PDF takes up to 30s — `src/routes/pdf.js:222-223`).
**Proposed fix:** Add a `generating` state + overlay (or at minimum a spinning `Loader2` + disabled button) in the Gap #5.5 fix.
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`.

### Gap #5.13 — Staff tab picker lacks accessibility-pair between "Test Equipment" card and the selection source  [P2]
**Area:** Staff tab → test-equipment card
**iOS behaviour:** Equipment card is rendered inside the same `VStack`, visually adjacent to the just-selected inspector row (`InspectorTab.swift:59-62`).
**PWA behaviour:** Same placement (`staff/page.tsx:153`). However the card has no `aria-labelledby` tying it to the selected inspector; a screen-reader user sees "Test Equipment" appear without context after a picker selection.
**Evidence:** `staff/page.tsx:248-283` — `<SectionCard accent="green" icon={Wrench} title="Test Equipment">` with no dynamic label.
**User impact:** Minor — sighted users are fine; SR users lose the connection that this equipment is _this selected inspector's_ equipment.
**Proposed fix:** Add `aria-label={\`Test equipment for \${inspector.full_name}\`}` to the equipment `SectionCard`.
**Touchpoints:** `web/src/app/job/[id]/staff/page.tsx`.

### Gap #5.14 — Job-context never clears inspector IDs when a roster entry is deleted (dangling-id scenario iOS warns about)  [P2]
**Area:** PDF warnings + data integrity
**iOS behaviour:** `pdfWarnings()` explicitly handles the dangling-id case: "Assigned inspector has been removed — certificate will be missing inspector details." (`JobViewModel.swift:677-679`).
**PWA behaviour:** The web `computeWarnings()` only checks for **missing** ids (`pdf/page.tsx:154-159`), not for ids that point at a deleted profile. And `JobProvider` never re-validates `inspector_id` against the current roster.
**Evidence:** `pdf/page.tsx:154-159` checks `!data.inspector_id`; does not cross-reference against an inspector-profile list.
**User impact:** If an admin deletes an inspector profile in Settings, jobs with that inspector assigned will appear `Ready to generate` on the PWA PDF tab, but the generated cert will be missing the inspector — silent bug.
**Proposed fix:** Load the roster and add a "dangling inspector" warning parallel to iOS's.
**Touchpoints:** `web/src/app/job/[id]/pdf/page.tsx`.

---

## Highest-impact three gaps

1. **Gap #5.5 — PDF generation is disabled on the PWA.** The entire PDF tab is a stub; inspectors must open the iOS app to produce a cert. Largest functional miss in Phase 5.
2. **Gap #5.1 — Staff roster never fetched.** Every role picker is permanently empty; `inspector_id` / `authorised_by_id` / `designer_id` / `constructor_id` can never be set from the web.
3. **Gap #5.3 — Staff tab uses different equipment-field keys than the rest of web + backend.** Silent data-disappearance: even after #5.1 is fixed, the Test-Equipment card will read `—` everywhere because the keys don't match what the API returns.

---

## Exceptions / intentional divergence
None documented in `web/reviews/WEB_REBUILD_COMPLETION.md`, `web/reviews/MINI_WAVE_4_5_HANDOFF.md`, `web/PHASE_6_HANDOFF.md`, or the inline comments of `staff/page.tsx` / `pdf/page.tsx`. The closest-to-authorised divergence is the self-acknowledged "PDF generation isn't wired up on web yet" comment (`pdf/page.tsx:122-125`), but this is phrased as deferred work, not an intentional exception — and Phase 8 closed the rebuild without addressing it.

## Open questions for the user

1. **Gap #5.5 priority** — is unstubbing the PWA PDF endpoint the immediate next wave, or is "PDF from iOS, everything else from web" the accepted product reality? The CLAUDE.md "Web rebuild shipped to production" line implies feature-parity was declared; this tab is the hard counter-example.
2. **Gap #5.7 warning-set alignment** — should the union set be canonical (most permissive warnings), or should we downgrade to the iOS 3-warning minimum?
3. **Gap #5.8 cert-type in filename** — ship `EIC_${jobId}.pdf` vs `EICR_${jobId}.pdf` on backend, or move to HTML-template server-side rendering in a future wave for a 1:1 iOS parity?
