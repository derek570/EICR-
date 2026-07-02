# /ep execution log — parity-ws9-pdf-parity-2026-07-02

- Session: `20260702T161922Z-ep`
- Plan: `PLAN-final.md` (claimed 2026-07-02T16:19:30Z)
- Repo: `/Users/derekbeckley/Developer/EICR_Automation`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260702T161922Z-ep`
- Branch: `ep/parity-ws9-pdf-parity-2026-07-02-20260702T161922Z-ep` (base `main` @ `1375dcb8`)

## Step 1 — Read iOS canon + web PDF surface
- Status: applied
- Decision: rule 1 (verbatim). Read EICRHTMLTemplate.swift (all 2131 lines), HTMLPDFRenderer.swift, PDFGenerator.swift, PDFTab.swift, PDFPreviewController.swift, web pdf/page.tsx, api-client fetchers (companySettings / inspectorProfiles / fetchLogoBlob / fetchSignatureBlob / generatePdf / updateAttestationPdfKey all exist as the plan claimed), and all iOS model CodingKeys needed for the wire-field mapping (InstallationDetails, SupplyCharacteristics, Circuit, BoardInfo, Observation, InspectionSchedule, ExtentAndType, DesignConstruction, Job/JobDetail, Inspector, CompanySettings wire model, Constants.eicScheduleItems).
- Key findings:
  - iOS pages are FIXED-SIZE divs (595×842 / 842×595 px, overflow:hidden) with pre-computed page breaks (inspection schedule chunked(28), one circuit page per board). No CSS reflow pagination is needed by any renderer — this shapes the Step 0 decision.
  - iOS `CompanyDetails` (GRDB, multi-line address) is a LOCAL model; the wire model both platforms share is `CompanySettings` (company_name, company_address single string, company_phone, company_email, company_website, company_registration, logo_file). Web template maps enrolmentNumber ← company_registration, address ← company_address.
  - Web `InspectorProfile` carries name/position/signature_file + the 5 equipment serial/cal pairs — direct mapping for the template's Tested-by + Test Equipment cells.
- Files: none (read-only)
- Commit: none

## Step 2 — Preflight: EIC fixture address GET
- Status: applied
- Decision: rule 1. Logged into production API as parity-test@certmate.uk; GET job_1782978943693 returns `address: "7 Fixture Court, Reading, RG2 2BB"` — matches the reseed exactly. Gate PASSES; no job mutation performed.
- Also fetched (read-only): EICR fixture job_1782978942222 (0 boards / 0 circuits / 0 obs), EIC has 1 board / 3 circuits / 2 obs. Company settings blob is empty and inspector-profiles list is `[]` for the parity user — logo/signature rendering therefore must be proven via synthetic unit-test fixtures (both live jobs render blank logo/sig identically on both platforms).
- Files: scratchpad only
- Commit: none

## Step 3 — Step 0 renderer spike
- Status: applied
- Decision: rule 1/2. Candidates evaluated: html2canvas+jsPDF (REJECTED — reimplements CSS layout; no `writing-mode: vertical-lr`, which the circuit-schedule headers require), @react-pdf/renderer & pdfmake (REJECTED — vector text but cannot consume HTML; would destroy the 1:1 iOS↔web template correspondence WS1 governance depends on), CHOSEN: hidden-iframe + SVG foreignObject page capture (zero-dep, browser's own layout engine — WebKit lineage on Safari, same as the iOS WKWebView canon) + pdf-lib assembly (single new runtime dep, web workspace only, dynamic-imported).
- Acceptance evidence: `web/tests-e2e/pdf-renderer-spike.spec.ts` PASSES on chromium AND webkit — real `application/pdf` Blob; portrait+landscape merged one-document in iOS order; page boxes exactly 595×842 / 842×595 pt; page PNGs visually inspected by the executor (red bars, badges, form tables, summary box, and the rotated vertical-lr circuit headers all correct at 3× ≈267dpi).
- Trade-off documented in `capture.ts` header: raster pages (text not selectable) vs iOS vector output — accepted per plan ("vector strongly preferred", not required; alternatives fail harder requirements). Interim visual reference used per plan (WS0 screenshots) — the page-by-page diff vs real iOS reference PDFs happens in Step 8.
- Files: web/src/lib/pdf/render/{capture,assemble,index}.ts, web/src/lib/pdf/template/css.ts, web/tests-e2e/pdf-renderer-spike.spec.ts, web/package.json, package-lock.json
- Commit: feat(pwa): WS9 Step 0 — client PDF renderer spike
- Notes: worktree npm ci replaced the TRACKED symlink `packages/shared-types/node_modules` with a real dir — excluded from all commits; restore before worktree removal.

## Step 4 — iOS reference PDFs (EICR + EIC)
- Status: applied (with one [ASSUMED] mechanics deviation)
- Decision: rule 2. Instead of re-creating the WS0 XCUITest UI driver, produced the reference PDFs via a TEMPORARY XCTest in the existing CertMateUnifiedTests target (`WS9ReferencePDFGenerationTests.swift`): decode the saved production fixture JSON with `APIClient.decoder`, reproduce `PDFGenerator.swift:14-25` normalization verbatim, render through the REAL `EICRHTMLTemplate.build` + `HTMLPDFRenderer.render` (WKWebView) on the iPhone 17 Pro simulator, write PDFs to the handoff folder. [ASSUMED] this is the obviously-correct interpretation of "produce the iOS reference PDF": the artifact is byte-equivalent to the PDFTab path for this account (PDFTab→PDFGenerator uses company=nil / all-nil inspectors here because the parity account has no company row and both jobs carry nil staff ids); the only skipped side effects are the two cert_attestations audit rows, which do not affect PDF content. Same pattern as the repo's existing PDFGeneratorTests.
- Evidence: `ios-reference/ios-reference-eicr.pdf` (9 pages) + `ios-reference-eic.pdf` (5 pages), both 595×842+842×595 — stored in the handoff folder next to the fixture JSONs. Temp test file deleted; pbxproj + Info.plist restored to committed state (nested repo tracked-clean).
- FIXTURE-DATA BUG (logged, NOT fixed — job data is read-only): the EICR fixture carries `installation_details.next_inspection_years: ""` (string) — iOS's strict Int decode REJECTS the whole job detail, so the real iOS app cannot open job_1782978942222 as currently seeded. Reference production coerced ""→unset in-test; the web decoder applies the same documented leniency. Surface to Derek: reseed should write an Int or omit the key.
- Also confirmed: the EICR reference includes ONE landscape circuit page despite `boards: []` — iOS's legacy `board_info`→single-board decode fallback fires (Job.swift:154); the web decoder mirrors this.
- Files: handoff `ios-reference/` (4 files); no repo changes
- Commit: none (iOS repo untouched after revert)

## Step 5 — Template + data-graph port
- Status: applied
- Decision: rule 1. Line-for-line TS port of EICRHTMLTemplate.swift into `web/src/lib/pdf/template/` (css/helpers/inspection-items/types/decode/eicr-html-template) + `generate-certificate.ts` mirroring PDFGenerator.swift:9-68 (normalization verbatim; company/inspector/authoriser/designer/constructor via existing api-client fetchers; logo/signature → data URIs). iOS quirks (totalPages estimate, EIC schedule pageNum 4) ported verbatim by design. Documented decoder leniencies: numeric-string coercion + ''-as-unset (the strict Swift decode REJECTS the fixture job — see Step 4 bug), and companyAddress reads the shared wire `company_address` single string (enrolment ← company_registration) — the wire blob is what both platforms share.
- Commit: feat(pwa): WS9 — port iOS EICRHTMLTemplate + PDFGenerator data graph to web TS

## Step 6 — pdf/page.tsx integration
- Status: applied
- Decision: rule 1. Primary Generate → client render (dynamic import); Blob into existing session pdfBlob state; `pdf_s3_key: local://<filename>` (iOS PDFTab.swift:363 scheme; filename = the handleShare File name); server generator kept visibly reachable via new "Generate on server (fallback)" action stamping route://, TODO(ws9-followup) marker for the post-field-validation debug-page flip (NOT flipped this PR, per plan). Spec §4.3 retry implemented: failed render keeps attestation_ids+engine in a ref; "Try again" re-renders directly with NO re-prompt; successful re-issuance still re-prompts (§3). Dated iOS spec-parity todo written to vault todos-certmate.md (iOS's only retry re-presents IssueCertificateSheet).
- Commit: feat(pwa): WS9 — pdf/page.tsx switches to the client renderer…

## Step 7 — Tests
- Status: applied
- Decision: rule 1. tests/pdf-tab.test.tsx rewritten to the new contract (client primary, server fallback, §4.3 no-re-prompt pinned via modal-presentation counter, §3 re-prompt pinned, local://+route:// stamping pinned). New tests/pdf-template.test.ts (logo+signatures both cert types incl. iOS ?? authoriser fallback, blank installation_details → 5-years-from-createdAt defaults, page composition incl. legacy board_info fallback, ∞ sentinel, decoder leniencies) + tests/pdf-assemble.test.ts (Node geometry twin). All green.
- Commit: test(pwa): WS9 — template data-graph…

## Step 8 — Page-by-page acceptance diff
- Status: applied
- Decision: rule 1. Re-runnable env-gated spec `tests-e2e/ws9-acceptance-render.spec.ts` renders both fixtures through the REAL web pipeline on WebKit and asserts page count + per-page boxes equal the iOS references (EICR 9/9, EIC 5/5 — PASS). Visual page-by-page eyeball (100dpi rasters + 300dpi crops via pdftoppm) caught TWO real fidelity bugs, both fixed: (a) body-font inheritance lost inside the foreignObject wrapper → serif fallback (capture.ts now copies computed body typography); (b) circuit-table group-header band white-on-white — the striping rule out-specifies .group-header and the capture engine resolves the cascade strictly where iOS WKWebView paints red → web-only higher-specificity compensation appended after the byte-identical iOS CSS block (dated comment). After fixes: all 14 page pairs MATCH (values, badges, auto-controls, footers incl. the iOS "Page 8 of 8" quirk). Accepted deltas: 3× raster vs vector text; sub-line word-wrap in two long paragraphs. Evidence: handoff ios-reference/ + web/audit/ws9-pdf-fidelity-2026-07/README.md.
- Commits: fix(pwa): WS9 acceptance-diff fixes…; docs(audit): WS9 PDF fidelity acceptance-diff evidence

## Step 9 — Docs / ledger / governance
- Status: applied
- Decision: rule 1. Ledger: pdf/pdftab-270 rewritten (client render, match, dated, §4.3 divergence note); pdf/pdf-fidelity stays partial with dated acceptance note + load-bearing iOS-template-change⇒web-companion note; pdftab-178 note updated; 8 pdf rows re-verified + stamped; pdftab-53 reviewed (preview surface unchanged — no edit). parity-ledger-files.json: 10 new module files registered (warner clean: 0 blank-dated / 0 stale / 0 dupes). INDEX-2026-07 WS9 gap updated honestly (implemented, stays open until field validation + debug flip). architecture.md + hub CLAUDE.md server-generator claims re-marked FALLBACK/DEBUG-ONLY; changelog rows added (hub + full). Parent §7 WS9 → DONE (with the stays-partial caveat spelled out). Vault todos-certmate.md: 3 new items (field-validate + flip; iOS §4.3 spec-parity; reseed undecodable EICR fixture).
- Commit: docs(parity): WS9 closeout…

## Step 10 — Gates
- Status: applied
- Web tests 1147/1147 green (105 files); typecheck 17 errors = main baseline (0 new); eslint 27 problems vs main 28 (12 errors all pre-existing; 0 new findings on WS9 files); `next build` green; spike e2e green chromium+webkit; acceptance e2e green.
- Commit: chore(pwa): WS9 lint hygiene…

## Completed 2026-07-02T20:25:52Z
- **Outcome: ALL PASSED** — every step applied (one [ASSUMED] mechanics deviation in Step 4, documented); zero skipped/blocked/failed.
- **Commits** (branch ep/parity-ws9-pdf-parity-2026-07-02-20260702T161922Z-ep, base main@1375dcb8):
  - 49e819f4 chore(pwa): WS9 lint hygiene — drop unused company destructure (parity note), type the attestation-key mock
  - e54887b9 docs(parity): WS9 closeout — ledger rows, file-map registration, INDEX honesty, stale server-generator claims re-marked fallback
  - 93025b84 docs(audit): WS9 PDF fidelity acceptance-diff evidence
  - 18d60e15 fix(pwa): WS9 acceptance-diff fixes — body font inheritance in capture; group-header band cascade compensation
  - b6b804df test(pwa): WS9 — template data-graph, normalization-defaults, page-composition + assembly-geometry tests
  - d068a937 feat(pwa): WS9 — pdf/page.tsx switches to the client renderer; spec §4.3 retry; server kept as explicit fallback
  - b2303f0b feat(pwa): WS9 — port iOS EICRHTMLTemplate + PDFGenerator data graph to web TS
  - 8d60d332 feat(pwa): WS9 Step 0 — client PDF renderer spike (foreignObject capture + pdf-lib)
- **Files touched**: web/src/lib/pdf/** (10 new modules), web/src/app/job/[id]/pdf/page.tsx, web/tests/pdf-{tab,template,assemble}.test.*, web/tests-e2e/{pdf-renderer-spike,ws9-acceptance-render}.spec.ts, web/audit/ws9-pdf-fidelity-2026-07/README.md, web/docs/parity-ledger.md, web/docs/parity-ledger-files.json, web/audit/INDEX-2026-07.md, docs/reference/{architecture,changelog}.md, CLAUDE.md, web/package.json, package-lock.json. Outside repo: parent §7 WS9→DONE, vault todos-certmate.md (3 items), handoff ios-reference/ artefacts.
- **Assumed decisions to sanity-check**:
  - [ASSUMED] Step 4 — iOS reference PDFs produced via a TEMPORARY XCTest calling the real template/WKWebView pipeline instead of re-creating the WS0 XCUITest UI driver (byte-equivalent artifact for this account; attestation audit rows not written — they don't affect PDF content). Temp file deleted, pbxproj/Info.plist restored.
  - Renderer choice (Step 0): foreignObject capture + pdf-lib; RASTER text (3×) accepted per plan ("vector strongly preferred", not required).
  - Web decoder leniencies + group-header CSS compensation — all documented in-code + ledger.
- **Skipped/blocked/failed**: none.
- **Stashes**: none. Worktree clean except the npm-ci-replaced tracked symlink packages/shared-types/node_modules (never staged; restored before worktree removal).
- **Tests**: web 1147/1147; e2e spike 2/2 (chromium+webkit); e2e acceptance 2/2 (webkit); typecheck+lint at main baseline; build green. Backend suite untouched (runs in pre-push + CI).
- **Fixture/product bugs surfaced (for Derek)**: (1) EICR fixture job_1782978942222 is UNDECODABLE on iOS (installation_details.next_inspection_years:"" string) — reseed; (2) iOS lacks the compliance-spec §4.3 no-re-prompt retry — dated todo in vault; both also in the PR body.
