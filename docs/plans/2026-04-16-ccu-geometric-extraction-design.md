# CCU Geometric Extraction — Implementation Plan

**Date:** 2026-04-16
**Status:** Approved, ready to build
**Author:** Derek + Claude (architectural discussion)

---

## 1. Problem statement

The current CCU photo extraction (`src/routes/extraction.js:668-759`, single-pass Sonnet VLM) silently hallucinates on real-world EICR boards. The failure mode is **layout/mapping** — the model miscounts modules, misidentifies RCD positions, and assigns circuits to the wrong device — not device-face reading.

### Why existing approaches fail

- **Single-pass VLM** (production v2): asks the model to detect + classify + count + spatially reason in one shot. It silently compromises on whichever sub-task is hardest.
- **Detect-then-read v3 POC**: bounding-box detection was unreliable; crops landed off-device.
- **Template library** (rejected 2026-04-16): real EICR boards are heavily modified from factory spec — RCDs moved, RCBOs randomly inserted, module counts vary per house. Templates only work on factory-fresh installs.

### What we have and don't have

- ✅ Voice commands + TTS question mechanism (CertMate moat) — lets us ask the inspector when uncertain
- ✅ Manufacturer+model lookup tables (Phase 1 plan, orthogonal to this)
- ❌ Training data — TestFlight to testers starts **tomorrow (2026-04-17)**; photo corpus starts accumulating from then
- ❌ On-device ML detector (not viable in v1)

### Design constraint

Must work on arbitrary real-world configurations with no training data, no templates, no new ML models in v1. Must surface uncertainty as voice questions rather than silent errors.

---

## 2. Architecture — Geometric-first extraction

Split the single-pass prompt into four focused stages. Each stage asks the VLM a question it is demonstrably good at, then uses physics (18mm DIN pitch) and cross-validation to close gaps.

### Stage 1 — Rail geometry
**Task:** Find the DIN rail bounds only.

**Prompt (approx):**
> "This is a UK consumer unit photo. Return ONLY the pixel coordinates of: (a) top edge of the DIN rail row, (b) bottom edge of the DIN rail row, (c) leftmost device edge, (d) rightmost device edge. Use the 0–1000 normalised grid. Return JSON: `{rail_top, rail_bottom, rail_left, rail_right}`."

**Rationale:** VLMs are reliable at "where is this edge." No classification, no counting.

**Validation:** Run 3× with slight prompt wording variations. Median each coordinate. If standard deviation > 5% of image width on any coordinate, flag low confidence → TTS clarification.

### Stage 2 — Module count via pitch constraint
**Task:** Compute slot count deterministically.

**Inputs:**
- `rail_width_px = rail_right - rail_left` (from Stage 1)
- Reference module width — use the main switch, which is ~36mm = 2 modules for almost all UK CCUs. Ask VLM: *"What is the x-center and pixel width of the largest switch/isolator on the rail?"*

**Math:**
```
module_width_px = main_switch_width_px / 2
module_count = round(rail_width_px / module_width_px)
slot_centers_x = [rail_left + module_width_px * (i + 0.5) for i in 0..module_count]
```

**Cross-check:** Ask VLM separately *"How many modules/devices/blanks are visible on the rail? Count blanks and empty covers too."* If it disagrees with the geometric count by ≥1, flag for TTS question:

> "I can see either N or M modules on the rail — can you confirm the total?"

The inspector's answer becomes ground truth for this board.

### Stage 3 — Per-slot classification (crop-and-zoom)
**Task:** For each of the N slot positions from Stage 2, crop the image and classify what's in that slot.

**Cropping:** Use sharp with generous padding (20% horizontal, 30% vertical) centered on `slot_centers_x[i]` and the rail y-range.

**Prompt per crop (approx):**
> "This crop shows one slot of a UK consumer unit. Classify as exactly ONE of: (a) MCB, (b) RCBO, (c) RCD/RCCB, (d) Main Switch, (e) SPD, (f) Blank cover, (g) Empty slot. Then read the device face: amp rating, type curve (B/C/D), manufacturer text, model number, BS EN number, sensitivity (mA) if RCD, RCD waveform lines (1=AC, 2=A, 3=B). Return JSON."

**Why this works:** Single-choice classification on a zoomed crop is the VLM's easiest mode. Position is fixed by Stage 2, so the model can't hallucinate spatial claims.

**Batching:** Send up to 4–6 crops in a single message with positional labels to save API calls. (Sonnet handles multi-image well.)

### Stage 4 — Device-face gap-filling
**Inputs:** Stage 3 per-slot results with possible null fields (unreadable rating, ambiguous RCD type, etc.)

**Strategy (existing Phase 1 plan — runs in parallel, no dependency):**
1. Manufacturer+model lookup table (e.g. `Hager ADA = Type A`, `MK H79xx = AC`) fills nulls deterministically.
2. Remaining nulls → TTS questions ("What's the rating on circuit 3?")
3. Inspector voice command can override any field at any time.

---

## 3. Cross-validation & uncertainty surfacing

The whole architecture is designed so that **any disagreement becomes a voice question**, never a silent answer.

| Disagreement | Question |
|--------------|----------|
| Stage 1 runs disagree on rail bounds (>5% SD) | "I'm having trouble seeing the full rail — can you retake the photo?" |
| Stage 2 geometric count ≠ VLM count | "I can see either N or M modules — which is right?" |
| Stage 3 slot classification confidence < 0.7 | "What's in slot 5 — MCB or RCBO?" |
| Stage 4 rating unreadable and not in lookup | "What's the rating on the kitchen sockets circuit?" |

Budget: one extra Sonnet call per uncertain board (Stage 1 3× + 1× module count = ~4 calls instead of 1). Acceptable vs. silent errors.

---

## 4. Data flywheel — start 2026-04-17

Every CCU extraction session must log (to S3, `s3://eicr-session-analytics/ccu-extractions/{userId}/{sessionId}/`):

- `original.jpg` — raw photo bytes
- `stage1.json` — rail geometry VLM outputs (all 3 runs)
- `stage2.json` — computed slot count + VLM count + reconciliation
- `stage3.json` — per-slot classifications with crops (or crop offsets)
- `stage4.json` — lookup-table fills + TTS questions asked
- `final.json` — inspector's final confirmed layout after voice/UI edits

This gives auto-labelled training data (photo + confirmed layout) with zero manual labelling cost.

**Target:** ~500 sessions → enough to train a proper on-device YOLO detector (iCertifi's architecture). Weeks, not months.

---

## 5. Implementation phases

### Phase A — Logging infrastructure (SHIP FIRST, independent of extraction changes)
**Why first:** TestFlight ships tomorrow. Every day we don't log is a day of training data lost. This is small, safe, orthogonal.

**Backend changes:**
- New S3 prefix `ccu-extractions/` in existing `eicr-session-analytics` bucket
- `src/routes/extraction.js` — after analyze-ccu response, write `original.jpg` + current-format `result.json` to S3
- Add `inspector_confirmed_layout` upload endpoint (POST from iOS when inspector saves Circuits tab)

**iOS changes:**
- `CircuitsTab.swift` save handler → call new endpoint with current circuit array

**Acceptance:** Inspect one S3 session folder after TestFlight testing, verify both photo and confirmed layout present.

### Phase B — Stage 1 + 2 rail geometry (proof of concept)
**Files:**
- New: `src/extraction/ccu-geometric.js` — Stage 1 + 2 logic
- New: `test/ccu-geometric.test.js` — unit tests with fixture photos from `/tmp/ccu-ab-test/photo-{1,2,3}.jpg`
- Modified: `src/routes/extraction.js:668-759` — feature-flagged behind `CCU_GEOMETRIC_V1=true` env var

**Acceptance:**
- Module count matches ground truth on all 3 fixture photos
- Cross-validation disagreement detection fires correctly on at least one synthetic test case
- No regression in existing extraction when flag off

### Phase C — Stage 3 per-slot classification
**Files:**
- Modified: `src/extraction/ccu-geometric.js` — add slot cropping via sharp + batched VLM calls
- Crop helper: reuse `expandBbox` style from v3 POC (`/tmp/ccu-ab-test/ab-test-v3.mjs`) but with fixed slot geometry instead of VLM-predicted bboxes

**Acceptance:**
- Per-slot classification on 3 fixture photos matches manual ground-truth
- Total API cost per extraction < 2× current single-pass (Stage 1 3× + Stage 2 1× + Stage 3 batched ~3× = ~7 calls, but cheaper prompts)

### Phase D — Stage 4 + TTS integration
**Files:**
- New: `src/extraction/device-lookup-table.js` — manufacturer+model → RCD type, BS EN defaults
- Modified: `Sources/Views/Recording/LiveFillView.swift` + voice pipeline — surface Stage 1–3 uncertainty as TTS questions
- Modified: `Sources/Services/AlertManager.swift` — new question types for slot count / slot content

**Acceptance:**
- When Stage 2 detects count mismatch, TTS fires within 2s of photo analysis complete
- Inspector voice answer correctly overrides the layout
- Confirmed layout logged to S3 (Phase A)

### Phase E — Cutover
- Flip `CCU_GEOMETRIC_V1=true` in production ECS task definition
- Monitor S3 logs for 1 week
- Measure: % of extractions needing TTS clarification, % hallucination rate vs. old single-pass (need manual review of ~50 sessions)

---

## 6. File-by-file change summary

### Backend (`/Users/derekbeckley/Developer/EICR_Automation/EICR_App/` — note: may need git restore per memory)

| File | Phase | Change |
|------|-------|--------|
| `src/routes/extraction.js` | A, B, E | Add S3 logging; feature-flag new pipeline; cutover |
| `src/extraction/ccu-geometric.js` | B, C | NEW — Stage 1–3 orchestration |
| `src/extraction/device-lookup-table.js` | D | NEW — manufacturer+model lookups |
| `src/routes/session.js` (or new) | A | NEW endpoint for `inspector_confirmed_layout` upload |
| `test/ccu-geometric.test.js` | B, C | NEW unit tests |

### iOS (`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/`)

| File | Phase | Change |
|------|-------|--------|
| `Sources/Views/JobDetail/CircuitsTab.swift` | A | On save, POST confirmed layout to new endpoint |
| `Sources/Services/APIClient.swift` | A | Add `uploadConfirmedLayout()` |
| `Sources/Services/AlertManager.swift` | D | New TTS question types (`askSlotCount`, `askSlotContent`) |
| `Sources/Views/Recording/LiveFillView.swift` | D | Wire Stage 1–3 uncertainty → AlertManager |

### Infrastructure
- S3 bucket `eicr-session-analytics` — add prefix `ccu-extractions/` (no IAM change, same bucket)
- ECS task def — add `CCU_GEOMETRIC_V1` env var (default false until Phase E)

---

## 7. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Stage 1 rail detection unreliable on angled photos | Cross-validation flags it; TTS asks for retake. Also: Stage 3 crops use generous 20%/30% padding to tolerate ~10% rail misdetection. |
| Main switch assumption (2 modules wide) fails on split boards | Fallback: ask VLM directly for module count if main switch not found; flag disagreement as usual. |
| API cost increase from 1→7 calls | Sonnet crop-classification is cheaper per call (smaller images, constrained output). Target: <2× current cost. Measured in Phase C. |
| Logging bloat in S3 | Phase A photos compressed to ≤500KB JPEG. 500 sessions ≈ 250MB. Negligible. |
| TestFlight users don't confirm layouts (skip Circuits tab) | Still log Stage 1–3 outputs + final PDF-generated layout. Less clean training data but still useful. |

---

## 8. Decisions (resolved 2026-04-16 — Phase B unblocked)

1. **Cost ceiling per extraction: £0.08 max.** At £3/cert revenue this is ~2.7% COGS per extraction — acceptable. Budget allows full 4-stage geometric pipeline (Stage 1 rail + Stage 2 pitch + Stage 3 slot classify + Stage 4 cross-validation). If a stage trends over budget, prefer narrower crops / fewer validation passes before dropping stages.
2. **Confidence threshold for TTS questions: 0.7.** Single global threshold to start. Revisit per-field tuning after production data accumulates (deferred to Phase E tuning pass once we can measure false-quiet vs false-chatty rates from real inspector corrections).
3. **Stage 3 returns crops to iOS for human verification — build into Phase D.** Inspector sees each detected slot as a crop and can tap to flag/correct. Ships alongside the Stage 3 classifier. This gives us the cleanest training-data signal (per-slot labelled corrections, not just whole-board diffs from the Phase A `confirmed-layout` upload). Adds UX work to Phase D but pays back in faster flywheel convergence.

---

## 9. What this plan does NOT include

- ML detector training (comes later, after ~500 sessions logged)
- Template library (explicitly rejected)
- Device-face reading improvements beyond lookup table (existing Phase 1 plan, orthogonal)
- Changes to live-fill voice extraction pipeline (that's working; this is CCU-photo only)

---

## 10. Success criteria

**Phase B–C done when:**
- 3 fixture photos in `/tmp/ccu-ab-test/` extract with correct module count and slot classification
- Comparison table vs. current production in `docs/reference/` showing accuracy delta

**Phase E done when:**
- 1 week of production data shows <5% silent hallucination rate (measured by inspector-correction frequency on final layout)
- Cost per extraction < £0.08

**Data flywheel working when:**
- S3 has >100 (photo, confirmed_layout) pairs by 2026-04-30
- Pairs validated as usable training data by manual spot-check of 20 samples

---

## 11. Start-of-session checklist for fresh context shells

When resuming this work in a new shell:

1. Read this plan in full
2. Check `git status` in both `/Users/derekbeckley/Developer/EICR_Automation/EICR_App/` (may need restore — see memory `eicr_app_git_restore.md`) and `CertMateUnified/`
3. Check S3 bucket for accumulated training data: `aws s3 ls s3://eicr-session-analytics/ccu-extractions/ --recursive --summarize`
4. Read current `src/routes/extraction.js:668-759` to confirm production prompt unchanged
5. Check which phase (A–E) is in progress via git log or TODO file

Relevant memory files:
- `eicr_app_git_restore.md` — restore EICR_App if files missing
- This plan supersedes `2026-02-19-ccu-gemini-v3-prompt-design.md`
