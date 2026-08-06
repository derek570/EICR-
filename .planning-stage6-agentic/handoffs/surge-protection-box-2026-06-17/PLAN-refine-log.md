# Refine log — surge-protection-box

## Round 1 — 2026-06-17T09:10:05Z

**Findings:** 15 (BLOCKER: 3, IMPORTANT: 9, NIT: 3)
**Sources:** claude=7, codex=12, both=4 (after dedup: 15 unique)
**Categories:** correctness=4, missing-info=7, ambiguity=3, risk=1, ordering=0, scope=0, style=1
**Snapshot:** `PLAN-v1.md`

### Applied (auto)
- [BLOCKER] (correctness) CCU appliers write surge into supply `spd_*` — added mandatory **3a-CCU** audit block (src/routes/extraction.js:2724-2738, web apply-ccu-analysis.ts:230-247, iOS FuseboardAnalysisApplier.swift:362-370/:558-568, JobViewModel.swift:638-648) (sources: codex)
- [BLOCKER] (correctness) Plan claimed `web/src/lib/types.ts` has a supply type to extend — it doesn't (permissive SupplyShape). Rewrote §2 Item 3c types.ts bullet (sources: codex)
- [BLOCKER] (correctness) `EICR_App/CLAUDE.md` path doesn't exist → repointed to `CLAUDE.md:87-100` + `CertMateUnified/CLAUDE.md:122-135` (sources: codex)
- [IMPORTANT] (missing-info) LiveFillView.swift:612-625/:674-688 still shows "SPD" during recording → added to Item 1 (sources: codex)
- [IMPORTANT] (missing-info) Web regex matcher routes "main fuse"→main_switch, contradicts Option A → added matcher/regex-result/apply-regex repoint to Item 3c (sources: codex)
- [IMPORTANT] (missing-info) Server/web PDF needs surge → made §3d client+server explicit (src/routes/pdf.js, python/eicr_pdf_generator.py) (sources: codex)
- [IMPORTANT] (ambiguity) surge_status_indicator ↔ 4.19 sync undefined → added §1 4.19-scope rule (display-only v1, mirror deferred) (sources: codex)
- [IMPORTANT] (ambiguity) surge_spd_bs_en "select/text" not a real schema type → concretised to text + picker fallback; other 3 = select (sources: codex+claude)
- [IMPORTANT] (missing-info) /ep must run from parent repo → added Execution preflight to §3 (sources: codex)
- [IMPORTANT] (correctness) stale "PR #16 / 44 failures / 4779 baseline" counts → replaced with "run suite, treat documented baseline as truth" in 3a/3b/§4 (sources: codex)
- [IMPORTANT] (missing-info) MCB-100 extraction-quality gotcha dropped → added regression case to §4 (sources: codex)
- [IMPORTANT] (missing-info) xcodegen-generated project constraint → added to 3b + §6 (sources: claude)
- [IMPORTANT] (missing-info) deploy-via-CI-only / forbid local deploy.sh → added to 3a Deploy + §6 (sources: claude)
- [IMPORTANT] (risk) Slice A TestFlight off red suite → added green-suite gate to §3 Slice A (sources: claude)
- [IMPORTANT] (missing-info) Q5 persistence concrete sink → resolved Q5 w/ second-allowlist grep (sources: claude+codex)
- [NIT] (missing-info) Q1 "confirm before execution" could stall /ep → promoted Option A to default (sources: claude)
- [NIT] (missing-info) field_schema quote not verbatim → fixed "consumer's main switch" (sources: claude)
- [NIT] (style) Constants.swift MARK heading rename → added to Item 2 (sources: codex)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan, fresh-context): anchors all verified accurate; Option A internally consistent; main gaps were Pass-2 missing-info (xcodegen, CI-only deploy, green-gate ordering).
- Codex (gpt-5.5): captures Option A direction but misses active code paths still treating surge as supply `spd_*`, plus false anchors (types.ts, EICR_App/CLAUDE.md) and stale test counts.

## Round 2 — 2026-06-17T09:20:23Z

**Findings:** 7 (BLOCKER: 2, IMPORTANT: 4, NIT: 1)
**Sources:** claude=4, codex=4, both=1 (server-PDF BLOCKER raised by both)
**Categories:** correctness=1, missing-info=4, ambiguity=1, risk=1
**Snapshot:** `PLAN-v2.md`

### Applied (auto)
- [BLOCKER] (missing-info) Server PDF mis-traced — missing nesting layer python/generate_full_pdf.py:287-304/:299 that builds the supply dict; surge block would render blank. Rewrote §3d server-side into 3 explicit layers + web PDF regression (sources: claude+codex)
- [BLOCKER] (correctness) Web appliers: false shared-SUPPLY_KEYS anchor; only apply-document-extraction.ts has SUPPLY_KEYS, apply-regex-match.ts uses SUPPLY_FIELD_TO_KEY, apply-extraction.ts uses default supply routing. Rewrote bullet per-file (sources: codex)
- [IMPORTANT] (risk) iOS applySonnetReadings case "spd_type_supply","spd_type" folds board spd_type into supply — added to 3a-CCU audit (sources: claude)
- [IMPORTANT] (missing-info) src/utils/jobs.js:108-150 is a CONFIRMED second supply allowlist (not hypothetical) — changed grep to explicit requirement (sources: claude)
- [IMPORTANT] (ambiguity) Slice C never decided surge LiveFill display — chose: surge shown live in v1; added LiveFillView display bullet to 3b + tightened Item 1 wording (sources: codex)
- [IMPORTANT] (missing-info) surge_spd_bs_en text+custom: iOS step only said bind to picker; customValueBinding only wired for main-switch. Added explicit showCustomSurgeBsEn/onChange/CMFloatingTextField + same fallback for relabeled spdBsEn (Q3) (sources: codex)
- [NIT] (correctness) LiveFillView line ranges slightly off → tightened to :621-624 / :681-684 (sources: claude)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): all anchors verified accurate; Option A sound; one BLOCKER (server PDF nesting layer) + two iOS leak/persist precision notes.
- Codex (gpt-5.5): much stronger; server PDF data-flow omission + wrong web applier map name + two iOS UI underspecs.

## Round 3 — 2026-06-17T09:28:15Z

**Findings:** 8 (BLOCKER: 1, IMPORTANT: 5, NIT: 2)
**Sources:** claude=4, codex=4, both=0 (distinct surfaces — no overlap)
**Categories:** correctness=4, missing-info=2, ambiguity=1, risk=0, style=0
**Snapshot:** `PLAN-v3.md`

### Applied (auto)
- [BLOCKER] (correctness) src/utils/jobs.js:118-121 board.spd_type→spd_type_supply fallback pollutes Main Fuse box → added removal + transformExtractedData regression to 3a (sources: codex)
- [IMPORTANT] (correctness) iOS spd_type must be removed from BOTH applySonnetReadings case head AND Self.supplyFields together (else silent drop) + keep deprecatedSupplyAliases disjoint → updated 3a-CCU bullet (sources: claude)
- [IMPORTANT] (correctness) web matcher repoint is a live-PWA BEHAVIOUR CHANGE, not "parity" → flagged in §3c + PR-description note (sources: claude)
- [IMPORTANT] (correctness) CertificateMerger.swift:81-134 drops surge_* at merge → added to Slice C + merger test (sources: codex)
- [IMPORTANT] (correctness) pdf.js fallback pipeline-files branch (:193-210) also needs surge merge into board_details.json → updated §3d layer 1 + both-branch regression (sources: codex)
- [IMPORTANT] (missing-info) embedded prompts src/extract_chunk.js SYSTEM_PROMPT + src/ocr_certificate.js OCR_SYSTEM_PROMPT need surge_* + disambiguation → added 3a bullet (sources: codex)
- [NIT] (ambiguity) eicr_editor.py uses different session keys (spd_type/spd_capacity/spd_current) → added mapping caveat to §3d.2 (sources: claude)
- [NIT] (missing-info) name regression test suite in §4 → added stage6-agentic-prompt.test.js (sources: claude)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): ~30 anchors verified accurate; plan execution-ready; remaining items are internal-consistency (spd_type two-list move) + behaviour-change callout + 2 NITs.
- Codex (gpt-5.5): four remaining execution gaps, all tied to verified live allowlist/merge paths that can still drop/mis-route surge data (jobs.js fallback, CertificateMerger, pdf.js fallback branch, embedded prompts).

## Round 4 — 2026-06-17T09:31:00Z

**Findings:** 1 (BLOCKER: 0, IMPORTANT: 1, NIT: 0)
**Sources:** claude=0 (returned execution-ready, empty findings), codex=1
**Categories:** ordering=1
**Snapshot:** `PLAN-v4.md`

### Applied (auto)
- [IMPORTANT] (ordering) Slice A relabel could ship while CCU still pollutes spd_*; 3a-CCU spans iOS/web not just backend → gated Slice A TestFlight on 3a-CCU completion + relabeled Slice B as cross-platform CCU audit + tagged iOS/web CCU fixes into Slice C/D (sources: codex)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): execution-ready, zero findings — anchors verified, Option A consistent across §1-§4, slice ordering + disjoint-supplyFields constraint preserved.
- Codex (gpt-5.5): otherwise execution-ready; one ordering contradiction (relabel-before-CCU-cleanup).

## Round 5 — 2026-06-17T09:35:17Z

**Findings:** 1 (BLOCKER: 0, IMPORTANT: 1, NIT: 0)
**Sources:** claude=0 (execution-ready, empty), codex=1
**Categories:** correctness=1
**Snapshot:** `PLAN-v5.md`

### Applied (auto)
- [IMPORTANT] (correctness) Doc-extraction prompts ALSO route "main fuse"/"supply fuse"/"cutout" examples → main_switch_* (sonnet_extraction_system.md:131-132,219-220; eic:84-85,181-182), contradicting Option A → expanded §3a doc-prompt task to grep+repoint all main-fuse guidance → spd_* + doc-extraction regression (sources: codex)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): execution-ready, zero findings — verified §3 Slice A/B gating is internally consistent (no circular/standalone-A gate); all items concretely anchored.
- Codex (gpt-5.5): one material prompt-coverage gap (main-fuse→main_switch_* examples in doc-extraction prompts).

## Round 6 — 2026-06-17T09:40:00Z

**Findings:** 2 (BLOCKER: 0, IMPORTANT: 2, NIT: 0)
**Sources:** claude=1, codex=1, both=0 (same CLASS, different files → merged into one general fix)
**Categories:** missing-info=2
**Snapshot:** `PLAN-v6.md`

### Applied (auto)
- [IMPORTANT] (missing-info) More embedded supply-schema prompts omit surge_*/route main-fuse→main_switch_*: src/extract_session.js SESSION_PROMPT (codex) + config/prompts/sonnet_text_system.md via sonnet_extract.js/ws-recording.js (claude). Both verified LEGACY (no live iOS/web client — both use /api/sonnet-stream). → Generalised §3a embedded-prompt bullet into a single exhaustive grep-ALL naming all 4 known hits + flagging the legacy ones for verify-or-document (sources: claude+codex)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): execution-ready except one legacy prompt (sonnet_text_system.md) of the flagged class; bounded to latent risk (no shipping caller — both platforms use /api/sonnet-stream).
- Codex (gpt-5.5): one more embedded prompt (extract_session.js) outside the plan; would drop surge fields on /api/recording/extract-transcript.

**Note:** rounds 5-6 both converged on the SAME class (legacy recording-extraction prompts). The round-6 fix is a grep-ALL generalisation intended to close the class rather than chase one file per round.

## Round 7 — 2026-06-17T09:44:41Z

**Findings:** 2 (BLOCKER: 1, IMPORTANT: 1, NIT: 0)
**Sources:** claude=1, codex=1, both=0 (distinct, both genuinely new — grep-all from round 6 held; no class re-flag)
**Categories:** correctness=1, scope=1
**Snapshot:** `PLAN-v7.md`

### Applied (auto)
- [BLOCKER] (correctness) SchemaCoverageRescueTests.swift:56,82 hardcoded mustBeRescued set lists spd_type + deprecatedSupplyAliases.count==6 assertion — spd_type removal from supplyFields turns iOS suite RED; plan only named the test as invariant-to-preserve. → Added explicit "edit mustBeRescued + count assertion in same change; add surge_* to mustBeRescued" step to 3a-CCU (sources: claude)
- [IMPORTANT] (scope) Two more live SPD surfaces: web live-fill board panel (live-fill-view.tsx:140,244) + Excel export SUPPLY_HEADERS (src/export.js:127, src/routes/export.js:45) omit surge_*/mislabel spd_* → added web live-fill relabel + export header/column task to §3c (sources: codex)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): one uncovered BLOCKER (SchemaCoverageRescueTests hardcoded set); otherwise execution-ready.
- Codex (gpt-5.5): one remaining user-facing/export surface (web live-fill + Excel export) preserving the spd_* collision.

## Round 8 — 2026-06-17T09:59:02Z (exhaustive-sweep round)

**Findings:** 9 (BLOCKER: 0, IMPORTANT: 8, NIT: 1)
**Sources:** claude=5, codex=4, both=0 (disjoint surfaces — sweep prompt asked each to dump ALL remaining at once)
**Categories:** correctness=5, missing-info=3, style/scope=1
**Snapshot:** `PLAN-v8.md`

### Applied (auto)
- [IMPORTANT] (correctness) src/routes/extraction.js:3351 LIVE /api/analyze-document hardcoded supply schema has no surge_* → added to grep-all known hits (active, not legacy) + broadened grep to src/**/*.js incl src/routes/ (sources: codex)
- [IMPORTANT] (correctness) src/routes/recording.js:402 legacy supplyFillFields allowlist drops surge → added to grep-all + suggest field_schema-derived list (sources: codex)
- [IMPORTANT] (missing-info) python/eicr_editor.py confirmed-live Streamlit app: needs UI surge section (:2514-2547) + nested surge_protection_device dict (:3962-3978) or renders blank surge block → upgraded §3d.2 note from "if live" to confirmed-live action (sources: claude)
- [IMPORTANT] (missing-info) config/baseline_config.json + eic_baseline_config.json seed supply_protective_device but no surge → added surge_protection_device seed task to §3a (sources: claude)
- [IMPORTANT] (correctness) iOS CertificateDefaultsService.swift:335-338 explicit per-field list drops surge (iOS-only asymmetry vs web generic) → added to §3b (sources: claude)
- [IMPORTANT] (missing-info) iOS LiveFillState.swift:154-157 displayedLengths tracks spd_* not surge → added to §3b (the file the LiveFillView work depends on) (sources: claude)
- [IMPORTANT] (correctness) web job overview page.tsx:119 Main Fuse card reads nonexistent supply.main_fuse_* → falls back to board.main_switch_*, ignores supply.spd_* → rebind to supply.spd_* (sources: codex)
- [IMPORTANT] (correctness) web preset-editor-sheet.tsx:50 SupplyDraft hardcoded set drops preset surge_* on edit → added preserve/extend task (sources: codex)
- [NIT] (correctness) src/routes/export.js:45 spurious ref — SUPPLY_HEADERS only in src/export.js:123-137 → corrected export bullet (sources: claude)

### Skipped (ambiguous fix)
- none

### Reviewer summaries
- Claude (Plan): primary web+iOS+backend+generate_full_pdf flow solid; 4 uncovered surfaces (Streamlit editor, baseline configs, iOS defaults service, iOS LiveFillState) + 1 NIT.
- Codex (gpt-5.5): 4 uncovered active surfaces (analyze-document schema, recording finish merge, web overview Main Fuse card, web preset editor).

**Note:** the round-8 exhaustive-sweep prompt deliberately asked both reviewers to report EVERY remaining surface in one pass to break the one-per-round tail. 9 surfaces closed at once.

## Round 9 — 2026-06-17T10:02:14Z

**Findings:** 0 (BLOCKER: 0, IMPORTANT: 0, NIT: 0)
**Sources:** claude=0, codex=0 — BOTH execution-ready, empty findings
**Snapshot:** `PLAN-v9.md`

### Applied (auto)
- none

### Reviewer summaries
- Claude (Plan): independently re-verified the most contradiction-prone round-8 surfaces (SchemaCoverageRescueTests :56/:82, jobs.js:118-121 fallback, field-name-corrections.js:105-110, apply-extraction routeSupplyField default) against live code — all anchors check out, general instructions blanket residual surfaces, no uncovered risk, no round-8 contradiction. Execution-ready.
- Codex (gpt-5.5): execution-ready.

## Final — 2026-06-17T10:02:14Z

**Termination:** DONE (clean — zero BLOCKER/IMPORTANT for a full round).
**Rounds:** 9
**Final snapshot:** `PLAN-final.md`
**Entry point for /ep:** `PLAN-final.md` (see `HANDOFF.md`).
