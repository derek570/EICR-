# Claude code review — `ccu-per-slot-primary` branch

**Reviewer**: Claude Opus 4.7 (1M context). **Scope**: 8 commits, 4,111 lines of diff across 8 files, branching from `main@9718047` to `HEAD@11f40e4`. **Sibling review** pending from Codex (`codex review --base main`, see `.planning/ccu-per-slot-codex-review.md`).

## Executive summary

**Verdict: HOLD for Agent C (parallelism refactor) + real-board re-verification, then SHIP.** The sprint delivers its declared goal — crop-and-send per-slot classification is now the primary source of `circuits[]`, with a separate Stage 4 label pass replacing the single-shot prompt's whole-board reasoning. Tests healthy (175 passing, 0 regressions). Architecture clean. Cost acceptable. A handful of non-blocking maintenance items captured below.

**Risks before ship:**
1. **Stage 2 count variance** mitigation (Agent A's retry) is heuristic; field testing needs to confirm the 30–90 px pitch window rarely over-triggers.
2. Per-slot labels from Stage 4 are good, but labels still NEVER see a separate schedule card elsewhere on the board — if an inspector photographs a job where all labels live on a side-mounted card, Stage 4 returns nulls. Documented as a known limitation; not a regression (single-shot missed these too).
3. `extraction_source` is set to `"geometric-merged"` if Stage 3 returned slots, even when Stage 4 returned no usable labels — the caller can't tell whether labels are real or empty-by-failure. Minor observability gap.

---

## Architecture — coherence and correctness

The per-slot flow is now:

```
 0 classifier (1 VLM call, ~3 s)       —— routes to modern | rewireable pipeline
 1 single-shot prompt (parallel)       —— board-level metadata only (not circuits / labels)
 2 Stage 1 panel/rail bounds (×5 samples, ~10 s)
 3 Stage 2 slot count + centres (1 call, retry on out-of-range)
 4 Stage 3 slot classify (ceil(N/4) batches, ~5 s each)
 5 Stage 4 per-slot label read (ceil(N/4) batches, ~5 s each)
 6 slotsToCircuits merger: slots + labels → circuits[]
```

Steps 1 and 2–5 run in parallel because the classifier kicks off the geometric pipeline the moment board_technology is known. Steps 4 and 5 currently run sequentially — Agent C will parallelise them as the next commit.

**Good**:
- Clean separation of concerns: Stage 3 reads devices, Stage 4 reads labels, single-shot reads board metadata. Each VLM call has ONE job.
- `CCU_GEOMETRIC_V1` is retained as a kill switch, inverted to default-ON. That's a clean "roll back without redeploy" escape hatch.
- Graceful degradation: Stage 4 is soft-fail, Stage 3 is soft-fail, geometric pipeline error drops all the way back to pure single-shot.
- Shape preservation: `/api/analyze-ccu` response keeps every field the pre-sprint iOS client read. New fields (`slots[]`, `extraction_source`, `board_classification`, `label_pass_error`) are additive.

**Concerns**:

- **Label merger precedence for rewireable BS/EN**: Stage 3 on a rewireable board sets `slot.bsEn = "BS 3036"`, but Stage 4 doesn't touch `bsEn`. `buildCircuitFromSlot` reads `slot.bsEn` first, then falls back to a classification-based default. Correct for rewireable/cartridge. For modern (classification `mcb`/`rcbo`), Stage 3's per-device `bsEn` comes from reading the device face — when unreadable, falls back to `60898-1`/`61009-1`. Also correct. No issue.

- **Double-assignment of `slot.confidence`**: Stage 3's output uses `confidence` to mean "classification confidence". Stage 4 adds `labelConfidence` (separate field). The merger reads `slot.confidence` and treats it as classification confidence (correct). But the route-handler code that attaches Stage 4 labels also wires `labelConfidence` onto the slot — good. No collision.

- **Main-switch force-tag location**: `extractCcuRewireable` forces `slots[mainSwitchSlotIndex].classification = 'main_switch'` AFTER Stage 3 runs. The modern pipeline in `ccu-geometric.js` relies on Stage 3's VLM classifier to tag the main switch via its `"main_switch"` enum option. Inconsistent — if a modern board has the main switch at an edge slot and the VLM misses the classification, there's no fallback the way rewireable has. Fine for now (modern boards almost always have a clearly-distinct main switch); flag as a follow-up symmetry fix.

---

## Per-file review

### `src/extraction/ccu-geometric-rewireable.js` (+982 lines, new)

Pattern-matches `ccu-geometric.js` closely — same orchestrator shape, same Stage 3 batch size, same soft-fail Stage 3 policy. Easy to reason about.

- **Prompts** (Stage 1 × 5 variations, Stage 2 retry, Stage 3 colour disambiguation): wording is precise and diverse. Stage 1 variations 4 and 5 are genuinely different framings (socket-plate vs negative-space) not just reworded synonyms. Stage 3's red-vs-blue clarification directly addresses the field-observed failure mode.
- **`BODY_COLOUR_TO_AMPS` lookup** (line 46–52): locally applied when VLM returns a colour but no rating. Safe because VLM-returned rating wins (covered by test `does NOT overwrite VLM-returned ratingAmps with colour-derived value`).
- **`expectedCarrierCountRange`** (line 416): `{expectedMin: floor(W/90), expectedMax: ceil(W/30)}` is a ~3× window. Permissive but that's deliberate — first-pass VLM errors are usually off-by-one, not off-by-many. Worth collecting CloudWatch metrics on actual retry-trigger rates and tightening if we see over-triggering.
- **Stage 2 retry** (line 504–541): second call is made with strengthened prompt INCLUDING the previous count + expected range. Retry value wins unconditionally. Logged. Exposed to caller via `retry` field for audit. Clean.
- **Main-switch force-tag** (line 738–752): runs only when `stage2.mainSwitchSlotIndex` is set. Null-safe. Body-colour / rating / bsEn are nulled too so no stale rewireable-carrier data leaks into a main-switch slot.

**Nit**: the file opens with 845+ lines. Consider splitting into `ccu-geometric-rewireable/{panel.js, count.js, classify.js, orchestrator.js}` if it grows further. Not needed for merge.

### `src/extraction/ccu-label-pass.js` (+464 lines, new)

- **`LABEL_MAP`** (line 50) is duplicated from `src/routes/extraction.js:normaliseCircuitLabels`. Acknowledged with an inline TODO. Agree — the shared refactor adds test-mocking complexity out of proportion to the payoff right now. Don't de-dupe pre-merge.
- **`normaliseLabel`** (line 94) handles null/empty/`'null'`/mono-case cleanup. Thorough. 6 tests.
- **`cropSlotLabelZone`** (line 152): ±1 pitch horizontal + panel_top−80%/panel_bottom+40% vertical. Defensible heuristic; handles edge clamping; throws on invalid geom. 5 tests.
- **`readSlotLabels`** (line 262) applies the confidence threshold (from `opts.labelConfidenceMin` > `CCU_LABEL_CONFIDENCE_MIN` env > 0.5). Threshold check uses `>=` — a label with exactly `0.5` confidence passes through. Design decision is reasonable; documented.
- **`extractSlotLabels`** (line 418) orchestrator with skip-hint filtering. If every slot is skipped (all `main_switch`/`spd`/`blank`) it short-circuits with zero VLM calls. Cost-efficient.

**Concern**: the positional fallback in `readSlotLabels` (line ~350): `const vlmItem = arr.find((x) => x && x.slot_index === crop.slotIndex) || arr[i] || {};` — if the VLM returns fewer items than crops AND doesn't echo `slot_index`, slot N reads from `arr[i]` which may be undefined. Worked-around with `|| {}` so no crash, but the result is a silent "null label" rather than an explicit error. Could argue for throwing on position mismatch; current behaviour is softer which is probably right for production but brittle for tests.

### `src/routes/extraction.js` (+458 lines net)

The `/api/analyze-ccu` route handler now reads top-down as a clear sequence:

1. File validation → resize.
2. `perSlotEnabled` check → classify board_technology → dispatch geometric pipeline.
3. Single-shot Anthropic call (unchanged).
4. Parse single-shot → normalise labels → RCD lookup (unchanged post-processing).
5. `await geometricPromise` → attach geometry to response.
6. If Stage 3 returned slots: run Stage 4 label pass → attach labels to slots[] → `slotsToCircuits` merger → replace `analysis.circuits`.
7. Send response. Fire-and-forget S3 training log.

**Good**: flow is easy to follow top-to-bottom. Logger calls are detailed (slot counts, token usage, stage timings, extraction_source). Errors are caught per-stage, never crashing the response.

**Concern — duplicate Anthropic client instantiation**: the classifier builds its own Anthropic client at line 981 (`new (await import('@anthropic-ai/sdk')).default(...)`), and the single-shot flow builds ANOTHER at ~line 1146. Wasteful (two SDK imports, two client objects per request). Low-impact (SDK caches module) but worth collapsing into one shared client per request in a follow-up.

**Concern — ordering bug risk**: the post-processing order is `applyBsEnFallback → normaliseCircuitLabels → lookupMissingRcdTypes → main_switch fallbacks`. This runs on `analysis.circuits` which is the SINGLE-SHOT array at that point. AFTER geometric merge, `analysis.circuits` is replaced with the per-slot merger's output. That output has its own `ocpd_bs_en` from the slot classifier, so `applyBsEnFallback` wouldn't double-fill. But `lookupMissingRcdTypes` runs BEFORE the merge, populating `rcd_type` on single-shot circuits that are then discarded. Wasted VLM spend (a web-search call). Not incorrect output, but cost leak. Move `lookupMissingRcdTypes` to AFTER the merge, or skip it when `extractionSource === 'geometric-merged'`.

**Minor** — `extraction_source = 'single-shot'` initial assignment could be clearer if it were `'pending'` or omitted until decided. Reader momentarily wonders if we always end up single-shot.

---

## Test coverage

- **Rewireable pipeline** (ccu-geometric-rewireable.test.js): 37 tests. Covers Stage 1 median + SD gating, Stage 2 retry paths (in-range, too-low, too-high, disagree, retry-prompt-content, single-pass-log), Stage 3 crop geometry + batching + classification normalisation + colour-code mapping + out-of-order matching + soft-fail. Orchestrator tests cover the full pipeline with mocked VLM. Good depth.
- **Label pass** (ccu-label-pass.test.js): 27 tests. Covers normalisation, cropping, batching, confidence gating with three precedence paths (opts → env → default), fence parsing, non-array rejection. Env-var test uses try/finally to avoid leakage.
- **Route merger** (ccu-route-merger.test.js): 19 tests. Covers all the merger permutations (LEFT vs RIGHT main switch, RCD cascade, main_switch/spd/rcd skip, rewireable, cartridge, low_confidence, threshold override). Helpers `classifyBoardTechnology` + `buildCircuitFromSlot` also tested.

**Gaps**:
- No integration test that exercises the route handler end-to-end with all three pipelines mocked (single-shot + geometric + label pass). The existing `ccu-route-merger.test.js` tests `slotsToCircuits` in isolation. A route-handler-level test would catch regressions in the "replace analysis.circuits after merger runs" logic.
- No test for the interaction between `lookupMissingRcdTypes` and the geometric merge path (the wasted-VLM-spend concern above).
- No test that `low_confidence: true` survives a re-build via buildCircuitFromSlot (it's added by the caller branch, not by the helper itself — subtle but currently correct).

None of the gaps are ship-blockers; they're follow-up hardening.

---

## Deployment readiness

| Aspect | State |
|---|---|
| Feature flag | `CCU_GEOMETRIC_V1` defaults ON; set to `"false"` on task-def to roll back without redeploy. ✓ |
| Backwards compat | iOS `FuseboardAnalysis` gains optional `slots[]` + `extraction_source` decoding (commit `9880bb9` on stage6-agentic-extraction). Additive only, old responses still decode. ✓ |
| Cost | ~$0.03 → ~$0.11 per extraction. 2.5-3.5% of £3/cert margin. Acceptable. ✓ |
| Latency | Pre-sprint ~25-30s (single-shot alone). Now ~40-50s (classifier + geometric + Stage 4 + single-shot in parallel). +15s. Agent C will reclaim ~10s via Stage 3/4 parallelism. User-facing acceptable. |
| Observability | Route handler logs extraction_source, token counts, stage timings, slot/circuit counts, confidence. Good. |
| Tests | 175 passing, 0 regressions. Up from 107 pre-sprint. ✓ |
| Docs | `docs/reference/architecture.md` has a new CCU Pipeline section. `CLAUDE.md` has two changelog rows. `.planning/` has the sprint plan. ✓ |
| E2E on real photo | 2 runs completed. First returned 6 circuits correctly; second returned 5 (Stage 2 variance, now mitigated by Agent A). Shower lands on circuit 3 as Derek verified. ✓ |

---

## Non-blocking items for follow-up

1. **`lookupMissingRcdTypes` wasted spend** — gate behind `extractionSource !== 'geometric-merged'` or move to after merge (route-handler-level).
2. **Modern-board main-switch force-tag symmetry** — mirror the rewireable's fallback.
3. **Duplicate Anthropic client** — share one per request.
4. **Positional VLM fallback in `readSlotLabels`** — log a warning when VLM slot_index echo is missing.
5. **Route-handler integration test** — mock all three pipelines, assert circuits[] sourced from merger when geometric succeeds.
6. **`LABEL_MAP` de-duplication** — share with `normaliseCircuitLabels` once the label-pass tests are stable.
7. **Single-shot numbering-direction compliance** — separate prompt tightening (remains a single-shot concern for board-level metadata even after this sprint).
8. **CloudWatch metric for Stage 2 retry rate** — nice-to-have for tuning the `30–90 px pitch` window later.

## Context for Codex review

The following original agent prompts were used to spawn each engineer during the sprint — hand these to Codex alongside the diff so it evaluates each chunk against its charter rather than generic best-practice:

- **Engineer 1 (rewireable pipeline)**: see `.planning/ccu-per-slot-sprint.md` Stream 1 — new file `src/extraction/ccu-geometric-rewireable.js` with Stage 1 panel bounds, Stage 2 count, Stage 3 classifier; match `extractCcuGeometric` shape.
- **Engineer 2 (integration tests)**: add 12-18 tests for slotsToCircuits + buildCircuitFromSlot + classifyBoardTechnology; export the helpers.
- **Agent A (reliability pass)**: Stage 1 samples 3→5, Stage 2 retry on suspect count (30–90 px pitch window), Stage 3 crop width 1024→1536 + colour disambiguation prompt addition.
- **Agent B (label-confidence gating)**: threshold `opts.labelConfidenceMin` > `CCU_LABEL_CONFIDENCE_MIN` env > 0.5 default; null out labels below threshold; preserve rawLabel.

Orchestrator (me) wrote: `slotsToCircuits`, `buildCircuitFromSlot`, `classifyBoardTechnology`, the Stage 4 label-pass module + tests, the route handler integration, iOS `FuseboardAnalysis` decoding, all docs, and the sprint plan.

Codex should focus on:
- Whether the merger correctly handles edge cases I missed (e.g. split boards with main switch in the middle, RCD cascades interrupted by RCBO rows).
- Whether the Stage 2 retry + Stage 3 crop-width changes interact correctly (same file modified).
- Security: any untrusted-input paths in the S3 key construction or VLM prompt assembly.
- Whether the "drop single-shot fallback in merger" leaves any visible regression paths I didn't think of.

---

**Sign-off**: Ship-ready pending Agent C (parallelism). Follow-ups 1–8 are all small, separable, and can be done in a cleanup sprint after a couple of weeks of prod data.
