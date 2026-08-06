# PLAN — Surge Protection Box + Supply-Protective-Device label disambiguation

**Date:** 2026-06-17
**Repos:** `EICR_Automation` (backend `src/`, `config/`, web `web/`) + `CertMateUnified` (iOS)
**Working dirs:** backend/web = `/Users/derekbeckley/Developer/EICR_Automation` ; iOS = `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
**Driver:** Field session `F1AC26FB` (2026-06-16). Inspector said *"the main fuse"*; it landed in the on-screen **"Supply Protective Device (SPD)"** box. Routing was correct, but the `(SPD)` label reads as *Surge Protection Device* to an electrician, and there is **no box at all for an actual surge protection device**.

---

## 0. Root cause — `spd_*` is a semantic collision (READ FIRST)

The `spd_*` field family is documented and rendered **two incompatible ways** in the live codebase:

| Surface | What it calls `spd_*` | Evidence |
|---|---|---|
| Voice/realtime prompt | **Supply Protective Device** = DNO cutout / "main fuse" | `config/prompts/sonnet_agentic_system.md:133-142` ("SUPPLY vs MAIN SWITCH DISAMBIGUATION", main fuse → `spd_*`) |
| Voice routing aliases | `main_fuse_* → spd_*` | `src/extraction/field-name-corrections.js:105-110` |
| TTS friendly names | "main fuse BS EN", "main fuse rating" | `src/extraction/confirmation-text.js:95-98` |
| `field_schema.json` | "DNO supply cutout fuse (NOT the consumer's main switch)" | `config/field_schema.json:604-627` |
| PDF | "Supply Protective Device" | `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift:821, 1153` |
| **Doc-extraction prompt** | **Surge Protection Device, "BS EN 61643-11"** | `config/prompts/sonnet_extraction_system.md:243-246`, `sonnet_extraction_eic_system.md:196-199` |
| **Web supply page** | **"SPD (surge protection)"** | `web/src/app/job/[id]/supply/page.tsx:632` (card titled surge, bound to `spd_bs_en`/`spd_type_supply`) |
| iOS picker | **both** cutout (`88`, `88-2`) and surge (`61643-11 Type 1/2`) in one list | `CertMateUnified/Sources/Utilities/Constants.swift:47` |

**Decision required (Q1):** which meaning does `spd_*` keep?

- **Option A (RECOMMENDED): `spd_*` = Supply Protective Device (main fuse / cutout).** Add a NEW `surge_*` namespace for the real Surge Protection Device. Then *fix the drifted surfaces* (web card title + binding, doc-extraction prompts, iOS picker) to stop using `spd_*` as surge.
  - *Why:* the live voice contract iOS depends on (the 2026-06-03/04 Fix B/D work) routes "main fuse" → `spd_*`. Re-pointing `spd_*` to mean surge would break that contract + all historical `spd_*` data on shipped jobs. Additive `surge_*` is far lower risk.
- **Option B (rejected): `spd_*` = Surge Protection Device**, move the cutout to a new `supply_pd_*` namespace. Matches the everyday reading of "SPD" but requires re-pointing voice routing, migrating historical cutout data, and a coordinated iOS+backend break. Not worth the risk.

**This plan adopts Option A as the default** (justified above). `/ep` should NOT block on Q1 — Option A is the executable decision. Proceed unless the user explicitly objects.

---

## 1. Field contract — new `surge_*` namespace (Option A)

New fields under `supply_characteristics_fields` (insert after `spd_*`, around `config/field_schema.json:627`). BS7671 18th-ed-aligned, minimal-but-complete:

| Key | Label (UI/PDF) | Type | Options |
|---|---|---|---|
| `surge_spd_present` | "Surge Protection Device Fitted" | select | `Yes`, `No`, `N/A`, `LIM` |
| `surge_spd_type` | "SPD Type" | select | `Type 1`, `Type 2`, `Type 1+2`, `Type 3`, `Combined`, `N/A` |
| `surge_spd_bs_en` | "SPD BS EN" | text | (iOS picker `surgeSpdBsEnOptions` suggests `61643-11`, `62305 LPS`, `Other`, `N/A` + custom-value fallback) |
| `surge_status_indicator` | "SPD Status Indicator" | select | `Satisfactory`, `Unsatisfactory`, `N/A` |

- **Field types (concrete — no hybrid):** `field_schema.json` `type` is a single value. Use `type:"select"` for `surge_spd_present`, `surge_spd_type`, `surge_status_indicator` (net-new, no historical data, supply-level so the circuit-only `ask_user` enum resolver never fires). Use `type:"text"` for `surge_spd_bs_en` (matches the existing `spd_bs_en` text convention + allows free-form standard numbers; the iOS picker supplies suggestions with custom-value fallback). Do NOT leave `select/text` in the executable schema.
- `surge_status_indicator` is the data home for inspection schedule item **4.19** ("Confirmation of indication that SPD is functional (651.4)" — `EICRHTMLTemplate.swift:1895`). Today 4.19 has no recordable field; this gives the data a home it lacked.
- **4.19 scope (resolves reviewer ambiguity):** for v1, `surge_status_indicator` is a supply/PDF display field ONLY — it does NOT mutate `inspection_schedule.items['4.19']`. Auto-mirroring `Satisfactory/Unsatisfactory/N/A` into the 4.19 schedule outcome is DEFERRED (would need iOS + web + doc-extraction apply tests). 4.19 stays a static schedule row (`web/src/lib/constants/inspection-schedule.ts:157`, `EICRHTMLTemplate.swift:1895`).
- First-appearance default: all four seed to `N/A` (mirrors existing `spd_*`/RCD/bonding seeding — `SupplyTab.swift:502-506`, `web/.../supply/page.tsx:205-208`).
- **Q2 (open):** include `surge_spd_location` (text)? Recommend NO for v1 — keep the box tight; add later if field-requested.

---

## 2. Work items

### Item 1 — Relabel the existing "Supply Protective Device (SPD)" box (iOS, low-risk, no contract change)
- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift:413` — header `"Supply Protective Device (SPD)"` → **`"Supply Protective Device (Main Fuse)"`**.
- `:416,421` — field labels `"SPD BS/EN"` → `"Main Fuse BS/EN"`, `"SPD Type"` → `"Main Fuse Type"` (keep `\.spdBsEn` bindings; **labels only**).
- `CertMateUnified/Sources/Views/Recording/LiveFillView.swift:612-625` (`Earthing & SPD` / `SPD BS/EN` rows) and `:674-688` (SPD summary rows) ALSO render the supply `spd_*` values as "SPD" DURING recording — relabel these to "Main Fuse" / "Supply Protective Device" too, or the inspector still sees the confusing label live. (Surge `surge_*` live-fill display is added in Slice C, or explicitly deferred.)
- **No backend / wire change.** Pure display.

### Item 2 — Split the conflated picker (iOS)
- `CertMateUnified/Sources/Utilities/Constants.swift:47` `spdBsEnOptions` currently = `["88","88-2","88-3","61643-11 Type 1","61643-11 Type 2","61643-11 Type 1+2","61643-11 Type 3","62305 LPS",...]`.
  - New `spdBsEnOptions` (main fuse / cutout) → keep `88`, `88-2`, `88-3`, add `1361`, `1361 type 1`, `88 type gG`; **remove all `61643-11` + `62305` entries**.
  - New `surgeSpdBsEnOptions` → `["Select...","61643-11","62305 LPS","Other","N/A"]`.
  - Add `surgeSpdTypeOptions`, `surgeSpdPresentOptions`, `surgeStatusIndicatorOptions`.
  - Rename the `Constants.swift` section comment `// MARK: - SPD Options` → `// MARK: - Supply Protective Device / Main Fuse Options`, and put the new surge arrays under a separate `// MARK: - Surge Protection Device Options` heading (the old heading is part of the same semantic collision).
- **Migration note (Q3):** existing jobs may have `61643-11 Type 2` stored in `spd_bs_en`. Removing it from the picker means the custom-value fallback (`customValueBinding`, `SupplyTab.swift:130` pattern) must still render it without data loss. Verify the custom-value path handles out-of-list values (it does for `mainSwitchBsEn`); do NOT hard-drop.

### Item 3 — New Surge Protection Device box (cross-platform, additive)

**3a. Backend schema + prompts + voice (ship FIRST)**
- `config/field_schema.json` — add the 4 `surge_*` fields (§1) inside `supply_characteristics_fields`.
- `src/extraction/known-fields.js:~87` — add the 4 keys to the known-field allowlist.
- `src/extraction/eicr-extraction-session.js:~759` — add the 4 keys to the supply field list.
- `config/prompts/sonnet_agentic_system.md` — add a **SURGE vs SUPPLY-FUSE disambiguation** clause after line 142: "surge protection" / "surge protective device" / "surge protector" / "Type N surge" → `surge_*`; keep "main fuse"/"cutout" → `spd_*`. Map value kinds (present→`surge_spd_present`, type→`surge_spd_type`, 61643→`surge_spd_bs_en`, "indicator OK/functional"→`surge_status_indicator`).
- `src/extraction/field-name-corrections.js` — add aliases: `surge_protection_*`, `surge_*` → `surge_*` canonical.
- `src/extraction/confirmation-text.js` — friendly names: `surge_spd_present:'surge protection fitted'`, `surge_spd_type:'surge protection type'`, etc.
- **Reconcile drifted doc-extraction prompts** — `config/prompts/sonnet_extraction_system.md:243-246` + `sonnet_extraction_eic_system.md:196-199` currently describe `spd_bs_en` as "BS EN 61643-11" (surge). Repoint those to the cutout meaning AND add the new `surge_*` keys so GPT-Vision document extraction populates the right family. (Also `config/prompts/extraction_system.md:29-32` already says cutout — keep.)
- Backend apply/persist (resolves Q5): `surge_*` must be in BOTH `known-fields.js` AND the `eicr-extraction-session.js:759` supply list (both above). Before execution, grep `src/routes/extraction.js` + `src/utils/jobs.js` for any SECOND hardcoded supply allowlist that would silently drop unknown keys at persist time — if found, add `surge_*` there too. Verify end-to-end that a `record_board_reading{field:"surge_spd_present"}` survives to job state (not dropped).
- **Tests:** extend `src/__tests__/stage6-agentic-prompt.test.js` (routing contract), `confirmation-text.test.js`, known-fields. Run `npm test` and treat the count it reports on current `main` as the baseline — do NOT hardcode a number (repo docs cite both 4459 and 4779 at different dates; the suite is the source of truth). Suite must stay green.
- **Deploy:** push backend to `main` + GitHub Actions ONLY (`gh run watch`); NEVER run local `./deploy.sh` or a local Docker build. Confirm ECS rollout COMPLETE **before** iOS TestFlight (schema-coordination rule at repo-root `CLAUDE.md:87-100`; TestFlight rule at `CertMateUnified/CLAUDE.md:122-135`).

**3a-CCU. Audit & fix CCU/photo-analysis writes into `spd_*` (MANDATORY — part of Slice B, before any UI relabel ships)**
The CCU (consumer-unit photo) pipeline currently auto-writes surge/main-switch data INTO the supply `spd_*` fields. Under Option A these paths must be corrected so `spd_*` only ever holds DNO-cutout/main-fuse values; real surge findings go to `surge_*` (or stay board-scoped). Otherwise the relabel lands but CCU keeps polluting the main-fuse box:
- `src/routes/extraction.js:2724-2738` — copies main-switch values into supply `spd_*`. Remove/gate so main-switch is NOT auto-copied into the DNO cutout fields.
- `web/src/lib/recording/apply-ccu-analysis.ts:230-247` — maps `analysis.spd_present/spd_type/spd_bs_en` into supply `spd_*`. Route real surge findings to `surge_*`, or keep board-scoped; do NOT write surge into supply `spd_*`.
- iOS `CertMateUnified/Sources/Processing/FuseboardAnalysisApplier.swift:362-370` and `:558-568`, plus `CertMateUnified/Sources/ViewModels/JobViewModel.swift:638-648` — same CCU→supply-`spd_*` copy. Fix to match.
- **Tests:** update iOS `FuseboardAnalysisApplierTests`, web `phase-7-apply-ccu-modes` / ccu adapter tests.
- This SUPERSEDES the earlier "don't touch apply-ccu-analysis.ts" assumption — these CCU writes ARE in scope because they land in the supply `spd_*` fields, not (only) the board-scoped surface.

**3b. iOS (ship AFTER backend live)**
- `CertMateUnified/Sources/Models/SupplyCharacteristics.swift` — add `surgeSpdPresent/Type/BsEn/StatusIndicator: String?` (props ~60-63, CodingKeys ~107-110 with snake_case raw values, decode ~176-179).
- `CertMateUnified/Sources/Models/ExtractionResult.swift` — same 4 props/keys/decode (~185-188 / 229-232 / 299-302).
- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift` — new `CertMateHeader(title:"Surge Protection Device", icon:"bolt.shield")` section (after the relabeled main-fuse section ~432) with 4 controls bound to the new picker constants; add N/A seeding (~502-506).
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` — add `case "surge_spd_present"`/etc. in `applySonnetReadings` (~5963-5990) and add the 4 keys to `Self.supplyFields` (~9538-9559) so confirmations aren't dropped. Keep `supplyFields` disjoint from the deprecated-alias set (`SchemaCoverageRescueTests`).
- **Tests:** `xcodebuild test -derivedDataPath /tmp/certmate-dd` GREEN. New applier cases + decode round-trip. Treat the documented main-branch status as the baseline (`CertMateUnified/CLAUDE.md:96-98` — suite was 1406/1406 green on 2026-06-12, with ~8 known-stale `TranscriptFieldMatcherTests`); RUN the suite to confirm current state rather than asserting a fixed failure count.
- **xcodegen:** the iOS project is xcodegen-generated. All Slice C edits target EXISTING files, so xcodegen is not required — BUT if any new `.swift` file is split out (e.g. a separate Surge section view), run `xcodegen generate` before building or the project won't compile it.
- TestFlight via `./deploy-testflight.sh` once green + backend live.

**3c. Web (parity)**
- `web/src/app/job/[id]/supply/page.tsx:632` — **relabel** the `spd_*`-bound card from `"SPD (surge protection)"` → `"Supply Protective Device (Main Fuse)"` (fixes the mislabel), and **add a new** `"Surge Protection Device"` card bound to the 4 `surge_*` keys.
- `web/src/lib/types.ts` — NOTE: the supply form uses a permissive `SupplyShape = Record<string, string|boolean|undefined>` (`web/src/app/job/[id]/supply/page.tsx:41`) and `JobDetail.supply_characteristics` is `Record<string, unknown>` (`types.ts:304`) — there is NO typed supply interface to extend (the typed `spd_*` at `types.ts:503-510` belong to `CCUAnalysis`, not the supply form). So DON'T add keys to `types.ts` for the supply form; just use the new keys in the page + defaults + appliers. Only touch `types.ts` if you deliberately introduce a supply interface.
- `web/src/app/job/[id]/supply/page.tsx:205-208` — add `surge_*` to first-appearance N/A defaults.
- `web/src/lib/recording/apply-extraction.ts` / `apply-regex-match.ts` / `apply-document-extraction.ts` (`SUPPLY_KEYS`) — map the new `surge_*` keys.
- **Web regex matcher (Option A parity):** `web/src/lib/recording/transcript-field-matcher.ts:1296-1314` currently routes "main fuse" → `main_switch_bs_en`/`main_switch_current` — this CONTRADICTS Option A and the iOS/backend routing, so PWA voice fills the wrong box before/without Sonnet correction. Repoint main-fuse/cutout/supply-fuse regex hits → `spd_bs_en`/`spd_rated_current` (update `web/src/lib/recording/regex-match-result.ts:20-37` + `apply-regex-match.ts:35-52`); add any `surge_*` regex deliberately. Add web matcher/apply tests mirroring iOS `TranscriptFieldMatcherTests` main-fuse cases.
- Do NOT touch `web/src/lib/recording/apply-ccu-analysis.ts` HERE — its `spd_*` writes are handled in the 3a-CCU audit block (Slice B).
- `web/src/app/job/[id]/board/page.tsx:480-490` — the per-board `spd_type`/`spd_status` "SPD" card is board-scoped CCU surge data (`FuseboardAnalysis`); the board-display label is **out of scope** for v1 (Q4), but the CCU WRITES feeding it are fixed in 3a-CCU.
- **Tests:** `npm test --workspace=web`.

**3d. PDF (client + server)**
- iOS (client-side, used by the app): `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift` — add a "Surge Protection Device" block in **both** render paths (single-board ~831 after the supply-PD rows; second layout ~1163) with the 4 `surge_*` values. Note `:1895` (item 4.19) STAYS a static schedule row — do NOT auto-fill it from `surge_status_indicator` (per §1 4.19-scope rule).
- Server-side (used by the web frontend, NOT the iOS app — `CertMateUnified/CLAUDE.md:28-30`): pass `surge_*` through `src/routes/pdf.js:101-104` and render a separate Surge Protection Device block in `python/eicr_pdf_generator.py` (supply section ~936-944; the board SPD row ~1438-1448 is board-scoped — leave it). Check whether `src/generate_pdf.js` is still on any live web path before editing; if dead, document as legacy and skip.

---

## 3. Sequencing & ship order

**Execution preflight:** invoke `/ep` from `/Users/derekbeckley/Developer/EICR_Automation` (the hub repo), NOT from `CertMateUnified` — the handoff folder is parent-repo-relative (`.planning-stage6-agentic/handoffs/...`), so a CWD inside `CertMateUnified` makes `/ep`'s scan miss it.

1. **Slice A (Items 1+2, iOS-only, no contract):** relabel box (incl. `LiveFillView`) + split picker. **TestFlight is gated on a GREEN iOS suite** — do NOT cut a build off a red suite. If pre-existing failures remain on `main`, fix/rebase onto the fixing branch first, or ship Slice A together with Slice C.
2. **Slice B (3a + 3a-CCU, backend):** schema + prompts + voice + doc-prompt reconcile + CCU-write audit + tests → deploy via CI, confirm ECS live.
3. **Slice C (3b, iOS):** model + UI + applier + iOS PDF + tests → TestFlight after B is live AND suite green.
4. **Slice D (3c + server PDF, web):** parity + `src/routes/pdf.js`/`python` surge rows → push.

Backend (Slice B) MUST land + roll out before iOS (Slice C) hits TestFlight.

## 4. Test gates
- Backend: `npm test` green — baseline = whatever the count is on current `main` (don't hardcode; repo docs cite 4459 and 4779 at different dates). Add new routing/known-field/confirmation tests.
- iOS: `xcodebuild test -derivedDataPath /tmp/certmate-dd` green; new applier + decode tests.
- Web: `npm test --workspace=web` green.
- **Regression (from session F1AC26FB):** a "main fuse" utterance must SPLIT value-kinds — BS/standard-only → `spd_bs_en`, amps/current → `spd_rated_current`. Turn-13 wrongly dumped `spd_bs_en="MCB 100"`; add a case asserting no `MCB`/type/current text leaks into `spd_bs_en`.
- Manual: voice "the main fuse is BS 1361, 100 amp" → main-fuse box; "Type 2 surge protection fitted, indicator OK" → surge box.

## 5. Open questions
- **Q1 — RESOLVED:** Option A is the default (`spd_*` stays = supply protective device; new `surge_*` = surge). Execute on it.
- **Q2 (open, low-stakes):** include `surge_spd_location` (text) in v1? Default NO — keep the box tight; add later if field-requested.
- **Q3 — RESOLVED:** out-of-list `spd_bs_en` values (e.g. legacy `61643-11 Type 2`) survive the picker split via the custom-value fallback (do NOT hard-drop). NO auto-migration of legacy surge values from `spd_bs_en` → `surge_spd_bs_en` — leave historical data, fix going forward only.
- **Q4 — RESOLVED (defer the board LABEL only):** the per-board CCU `spd_type`/`spd_status` board-display label (`web/.../board/page.tsx`, `FuseboardAnalysis.swift` board-scoped) keeps its name for v1. NOTE: the CCU→SUPPLY `spd_*` WRITES are NOT deferred — they're fixed in 3a-CCU.
- **Q5 — RESOLVED:** backend persistence handled in 3a/3a-CCU (known-fields + supply list + second-allowlist grep).

## 6. Constraints / risks
- Backend `src/`, `config/prompts/`, `field_schema.json` are SHARED with iOS — this is an explicit cross-platform mandate (user-requested). Ship backend first, iOS after rollout. Coordination rule: repo-root `CLAUDE.md:87-100`; TestFlight rule: `CertMateUnified/CLAUDE.md:122-135`.
- Deploy backend ONLY via `git push` to `main` + GitHub Actions (`gh run watch`). NEVER local `./deploy.sh` / Docker (Docker Desktop isn't kept running; the script masks failures as exit 0). The onnxruntime patch runs inside CI, not locally.
- iOS project is xcodegen-generated — run `xcodegen generate` if any NEW `.swift` file is added (Slice C currently edits existing files only).
- Do NOT rename existing `spd_*` keys (historical-data + contract risk). Additive only.
- Keep `supplyFields` ⟂ deprecated-alias set on iOS (`SchemaCoverageRescueTests`).
- onnxruntime patch handled by the CI deploy script; iOS build via `-derivedDataPath /tmp/certmate-dd` (DerivedData symlink gotcha).
