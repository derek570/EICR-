# Conversation context — surge-protection-box plan refinement

## Section 0 — Handoff folder
- Resolved handoff folder: `/Users/derekbeckley/Developer/EICR_Automation/.planning-stage6-agentic/handoffs/surge-protection-box-2026-06-17/`
- Input `PLAN-v1.md` was renamed to `PLAN.md` (canonical STEM so `/ep` picks up `PLAN-final.md`). Folder already matched `.planning-stage6-agentic/handoffs/<topic>/`, so no relocation needed.
- Invoked from CWD `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` (iOS subproject). NOTE for `/ep`: the handoff folder lives in the PARENT repo (`EICR_Automation`), not under `CertMateUnified`. `/ep` must be invoked from `/Users/derekbeckley/Developer/EICR_Automation` (the hub) for its CWD-relative `.planning-stage6-agentic/handoffs/` scan to find this folder.

## 1. Source
Substantive prior conversation exists. This session investigated a real field-test issue (session F1AC26FB, 2026-06-16), confirmed root cause via CloudWatch logs + code reads, and the user explicitly requested this plan including "a surge protection box". Sections 2-6 apply.

## 2. Decisions the user explicitly made
- **Build a surge protection box.** User: "I would like there to be a search protection box" ("search" = dictation garble of "surge"). This is the headline new feature (Item 3).
- **Plan all three items together** — (1) relabel the misleading "(SPD)" box, (2) split the conflated picker, (3) add the surge box. User: "Please write a plan for one and 2 and three."
- **Run `/rp` then (next) `/ep`** on the resulting plan — user asked to run /RP after the plan was written; the intent is an autonomous refine→execute pipeline.
- The user accepted (implicitly, by asking for the plan rather than disputing the finding) that routing "main fuse" → `spd_*` is correct backend behaviour and the problem is the UI label + the missing surge box — NOT the voice routing.

## 3. Constraints surfaced
- Must be **BS7671 18th-edition aligned** — user explicitly asked whether the UI "is in line with the BS7671 template". The supply-protective-device row and the new surge box must match the model EICR form (Appendix 6 + inspection schedule).
- Backend (`src/`, `config/prompts/`, `config/field_schema.json`, shared-types/utils) is SHARED with iOS and the live voice contract; per `EICR_App/CLAUDE.md` it's immutable during PWA-only work. Item 3 IS a deliberate cross-platform mandate (user-requested), but backend must ship FIRST and roll out on ECS before the iOS TestFlight build that depends on the new schema.
- Do not break the 2026-06-03/04 "main fuse → spd_*" voice routing (Fix B `345648b0` / iOS Fix D) — it's load-bearing and field-validated.
- iOS deploy is via `./deploy-testflight.sh`; build/test with `-derivedDataPath /tmp/certmate-dd` (DerivedData symlink points at an unmounted drive otherwise). Project is xcodegen-generated — run `xcodegen generate` after adding new source files.
- Deploy backend only via GitHub Actions (`git push` + `gh run watch`), never local `./deploy.sh` / Docker.

## 4. Alternatives considered and rejected
- **Option B — repoint `spd_*` to mean Surge Protection Device** and move the main fuse/cutout to a new `supply_pd_*` namespace. REJECTED in the plan because it breaks the live voice contract iOS depends on and would require migrating all historical `spd_*` cutout data. Plan uses Option A (keep `spd_*` = supply protective device; add additive `surge_*`). The reviewers should sanity-check Option A is genuinely lower-risk and internally consistent.
- **Renaming the existing `spd_*` keys** to something clearer (e.g. `supply_pd_*`). REJECTED — historical-data + wire-contract risk; plan keeps keys, changes display labels only.
- **Auto-migrating legacy surge values** (e.g. `61643-11 Type 2` already stored in `spd_bs_en`) into the new `surge_*` fields. Leaning NO (leave history, fix going forward) — flagged as open Q3.

## 5. Gotchas / hidden requirements (discovered this session)
- **`spd_*` is a pre-existing semantic collision in the live codebase** — this is the crux. Voice prompt (`sonnet_agentic_system.md:133-142`), field_schema, PDF, and `field-name-corrections.js:105-110` treat `spd_*` as **Supply Protective Device (DNO cutout / main fuse)**. BUT the **web supply page** (`web/src/app/job/[id]/supply/page.tsx:632`) titles the same fields **"SPD (surge protection)"**, and the **doc-extraction prompts** (`config/prompts/sonnet_extraction_system.md:243-246`, `sonnet_extraction_eic_system.md:196-199`) describe `spd_bs_en` as **"BS EN 61643-11"** (surge). The iOS picker `Constants.swift:47 spdBsEnOptions` mixes both. Any plan that just "adds a box" without reconciling these drifted surfaces is incomplete.
- The CloudWatch logs for session F1AC26FB showed turn-13 `spd_bs_en` captured a junk value ("MCB 100") while turn-14 `spd_rated_current` = 100 was correct. Minor extraction-quality aside, not the focus, but noted.
- Inspection schedule item **4.19** ("Confirmation of indication that SPD is functional (651.4)", `EICRHTMLTemplate.swift:1895`) currently has NO recordable data field — the plan's `surge_status_indicator` is meant to fill that gap.
- There is a SEPARATE per-board CCU surge surface: `web/src/app/job/[id]/board/page.tsx:480-490` (`spd_type`/`spd_status`) backed by `FuseboardAnalysis.swift`. Plan defers this (Q4) but it's another place the "SPD" label collides.
- iOS supply data model lives in `Sources/Models/SupplyCharacteristics.swift` (props ~60-63, CodingKeys ~107-110, decode ~176-179) AND `Sources/Models/ExtractionResult.swift` (~185-188 / 229-232 / 299-302) — BOTH need the new `surge_*` fields, plus `applySonnetReadings` cases (~5963-5990) and the `Self.supplyFields` set (~9538-9559, must stay disjoint from the deprecated-alias set per `SchemaCoverageRescueTests`).
- TestFlight is currently HELD on unmerged PR #16 (44 pre-existing test failures still on main per memory) — the green-suite gate matters; coordinate so adding surge tests doesn't collide.

## 6. Open questions the user deferred
- Item 3 (the bigger surge feature) was presented as a feature decision; the user said yes to building it. Sub-decisions left open in the plan: Q1 (confirm Option A namespace), Q2 (`surge_spd_location` in v1?), Q3 (legacy value migration?), Q4 (per-board CCU surge disambiguation now or defer?), Q5 (backend persistence path discovery). None were explicitly resolved by the user in conversation — they are genuine open questions for /rp to either resolve with a sensible default or restate.
