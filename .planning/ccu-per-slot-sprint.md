# CCU per-slot primary sprint — 2026-04-22

## Goal
Wire the crop-per-slot VLM pipeline as the **primary source of `circuits[]`** in `/api/analyze-ccu`, for both modern (MCB/RCBO) boards and rewireable fuse boards. Single-shot prompt becomes the fallback.

## Why
Single-shot VLM extraction undercounts slots and misplaces labels on real-world boards (confirmed today against a Wylex rewireable: 5 of 6 fuses detected, "Shower" on wrong carrier). The crop-per-slot pipeline already exists (`src/extraction/ccu-geometric.js`, 720 lines, 28 tests) but is **disabled in prod** (`CCU_GEOMETRIC_V1` unset) and its Stage 3 output is dropped before response. It's also DIN-rail-locked, so a rewireable-adapted pipeline is also needed.

## Scope
- Modern path: wire existing Stage 3 slot classifications into `circuits[]`. Stages 1/2 unchanged.
- Rewireable path: new module adapted for bakelite carrier banks (no DIN rail, equal-pitched slots, colour-body classification).
- Routing: cheap initial VLM call for `board_technology`, route to the right pipeline.
- iOS: existing `SlotCrop` / `LiveFillState.slotCrops` wiring already dormant — populate via attached `slots[]` in response.
- Flag: `CCU_GEOMETRIC_V1=true` becomes the default in task-def; single-shot fallback retained.

## Out of scope (this sprint)
- Mixed boards (rewireable + retrofitted RCD) — covered only by fallback to single-shot.
- Cartridge-only boards — Stream 1 adds cartridge as a classifier type but the Stream 1 Stage 1/2 geometry targets rewireable first.
- iOS-side YOLO on-device detector (Phase A is the training-data feeder, not this sprint).

## Work streams (parallel)
1. **Rewireable pipeline** (Engineer 1 / agent, isolated worktree)
   - New file `src/extraction/ccu-geometric-rewireable.js`
   - Stage 1: carrier-bank bbox (3 parallel prompt samples, median)
   - Stage 2: carrier count + equal-pitch centre-Xs within bank (main-switch anchored)
   - Stage 3: per-slot classify — crops + VLM → `{ classification: "rewireable|cartridge|blank", bodyColour, ratingAmps, confidence }`
   - Tests: `src/__tests__/ccu-geometric-rewireable.test.js`
   - Exports: `extractCcuRewireable(imageBuffer)` with same outer shape as `extractCcuGeometric`

2. **Route handler** (orchestrator / me)
   - Add early `board_technology` classifier (small VLM call, returns just the enum + main-switch position)
   - Route: `modern` → existing `extractCcuGeometric`; `rewireable_fuse`/`cartridge_fuse` → `extractCcuRewireable`
   - Build `circuits[]` from Stage 3 slot classifications (include `confidence` gating — low-conf slots fall back per-position to single-shot)
   - Attach `slots[]` to response
   - Keep single-shot Anthropic call as fallback if geometric errors or low-confidence

3. **Integration tests** (Engineer 2 / agent, after Stream 2)
   - Route-handler tests with mocked VLM: modern, rewireable, geometric-failure fallback, per-slot-fallback, low-confidence path

4. **iOS + docs** (me)
   - Verify `LiveFillState.slotCrops` populates
   - Update `docs/reference/ios-pipeline.md`, `docs/reference/architecture.md`
   - Note ~2-3x cost per extraction

## Non-goals
Do not deploy; do not cherry-pick to main. This branch (`ccu-per-slot-primary`) is for review against real photos (Wylex + modern test board) before shipping.

## Cost reality-check
- Single-shot today: ~$0.03/extraction
- Per-slot: ~$0.06-0.08/extraction (3 rail calls + 1 module call + N/4 classify calls for N=6-12 slots)
- Margin impact at £3/cert: ~2-3% extra. Worth it for reliability.
