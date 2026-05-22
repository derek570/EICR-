# CCU Extraction Review + Training-Data Loop — plan

**Status**: Plan (not yet scheduled). Derek requested 2026-04-22 while the per-slot primary sprint was in-flight.

## Goal

After every `/api/analyze-ccu` extraction, surface the photo + AI output in a small review UI. Derek confirms or corrects as ground truth. Validated samples accumulate for future model fine-tuning / evaluation.

## What already exists (don't rebuild)

- **S3 training log** — `src/routes/extraction.js:logCcuTrainingData` writes on every extraction, fire-and-forget, to `s3://eicr-files-production/ccu-extractions/{userId}/{sessionId|no-session}/{extractionId}/`:
  - `original.jpg` (compressed ≤500 KB JPEG of the photo)
  - `result.json` (full analysis: circuits, slots, geometric, confidence, extraction_source, etc.)
- **Per-session ground-truth hook** — an older path writes `ccu-extractions/{userId}/{sessionId}/final.json` when the inspector confirms an iOS layout (Phase A). Coarser than per-slot; sits at session root, not extraction-scoped.
- **iOS scaffolding** — `LiveFillState.slotCrops`, `SlotCrop.swift`, a dormant "tap-to-correct grid (if geometric extraction returned crops)" hook in `LiveFillView`. Designed but never wired.
- **Auth** — `auth.requireAuth` + a global-admin gate pattern (see `admin_api.js`). Re-usable.
- **Storage helpers** — `src/storage.js` exposes `uploadBytes`, `uploadJson`, `getObjectJson`, `listObjects`. All the S3 plumbing is there.

## Recommendation — web review dashboard, backend-hosted

**Why web, not iOS**: faster to build (no TestFlight cycle), accessible from anywhere with a browser, shares prod auth, and the per-slot data we want to review includes base64 crops that are painful to scroll on a phone. iOS tap-to-correct stays in the backlog as a v2 — same underlying storage, different client.

**Why backend-hosted, not local**: runs on certomatic3000.co.uk with the existing JWT auth. A local site means a fresh Node process Derek has to start, local S3 credentials, and each work session forgets its review queue if the laptop sleeps. Backend-hosted keeps the workflow deployment-agnostic.

## Phase 1 — Review dashboard (shipped standalone)

### Backend routes (new, all under `admin.requireAdmin`)

| Route | Purpose |
|---|---|
| `GET /api/admin/ccu-reviews` | Paginated list of pending + recent extractions. Query params: `status=pending|validated|skipped|all`, `limit`, `cursor`. Returns `{items: [{extractionId, userId, sessionId, ts, status, thumbnail}], nextCursor}`. |
| `GET /api/admin/ccu-reviews/:extractionId` | Single extraction full detail. Returns `{meta, analysis, groundTruth|null, reviewStatus, slotCrops}`. |
| `POST /api/admin/ccu-reviews/:extractionId/ground-truth` | Body: corrected analysis shape (slots + circuits + main switch + board info). Writes `ground_truth.json` + `review_status.json` to S3. |
| `POST /api/admin/ccu-reviews/:extractionId/confirm` | Shortcut: "AI got it right, record a copy of the AI result as ground truth." Writes `ground_truth.json` = `result.json` verbatim, `review_status.json = {status: "validated_asis"}`. |
| `POST /api/admin/ccu-reviews/:extractionId/skip` | Mark non-reviewable (bad photo, duplicate, test shot). Does not create a training sample. |

Routes live in new file `src/routes/admin-ccu-reviews.js`. Mounted in `src/api.js` behind the existing admin-gate middleware pattern.

### S3 layout after Phase 1

```
s3://eicr-files-production/ccu-extractions/{userId}/{sessionId|no-session}/{extractionId}/
├── original.jpg          (already written — AI input)
├── result.json           (already written — AI output)
├── ground_truth.json     (NEW — inspector-confirmed source of truth)
└── review_status.json    (NEW — {status, reviewedBy, reviewedAt, notes})
```

Ground-truth shape mirrors the response shape verbatim so training samples are self-describing. Review status:

```json
{
  "status": "pending|validated_asis|validated_edited|skipped|rejected",
  "reviewedBy": "<userId>",
  "reviewedAt": "<iso8601>",
  "notes": "free-text optional — anything weird about this board"
}
```

### Review UI

Single HTML page served from the backend at `/admin/ccu-review` (behind auth). Vanilla HTML + small vanilla-JS bundle — no React/Next build cost to avoid dragging the review into the `web/` workspace's deploy cadence. Alternative: tiny Next.js page in `web/app/admin/ccu-review/` if we want reuse of the existing auth UI components — pick based on whether Derek prefers one-file vs web-app consistency.

**Layout** (single review page, one extraction at a time):

```
┌─────────────────────────────────────────────────────────────┐
│  CCU Review — Wylex Standard #1776846789810-44zw8q          │
│                                     [Prev] [Next] [Skip] [✔]│
├──────────────────────┬──────────────────────────────────────┤
│                      │  Board                               │
│   [Original Photo]   │   Manufacturer: [ Wylex      ]       │
│                      │   Model:        [              ]     │
│                      │   Technology:   ( ) Modern           │
│                      │                 (•) Rewireable       │
│                      │                 ( ) Cartridge        │
│                      │                                      │
│                      │  Main switch                         │
│                      │   Type: [Switch-Fuse]  Rating: [60A] │
│                      │   Position: ( ) L (•) R ( ) None     │
├──────────────────────┴──────────────────────────────────────┤
│  Slots                                                       │
│  ┌──┬──┬──┬──┬──┬──┐                                        │
│  │#0│#1│#2│#3│#4│#5│   ← click a slot to edit below         │
│  └──┴──┴──┴──┴──┴──┘                                        │
│                                                              │
│  Slot #2 (selected)                                          │
│  ┌───────────┐  Classification: [rewireable   ▾]            │
│  │           │  Body colour:   [white        ▾]            │
│  │ [crop]    │  Rating (A):    [ 5    ]                    │
│  │           │  Label:         [ Shower         ]          │
│  │           │  BS/EN:         [ BS 3036        ]          │
│  └───────────┘  Confidence: 0.68  [Low — was flagged]       │
│                                                              │
│  Circuits (from current slot state — auto-recomputes)       │
│   #1  Sockets Kitchen   30A Rew  BS 3036                    │
│   #2  Cooker            30A Rew  BS 3036                    │
│   #3  Shower            30A Rew  BS 3036 ← target           │
│   ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

Key UX points:
- **Inherit from AI by default** — every editable field starts pre-filled with the AI's value. Derek only types where the AI was wrong. Cuts per-review effort from "retype everything" to "tap a few dropdowns".
- **Live circuit recompute** — as Derek edits slot fields, the circuits[] preview below re-runs the `slotsToCircuits` merger client-side so he sees the effect immediately.
- **Keyboard shortcuts** — `J/K` prev/next slot, `N` next extraction, `Enter` confirm, `S` skip.
- **Diff badge** on Confirm button — shows "3 fields changed" if edited, otherwise "Confirm as-is".

### Admin auth

Re-use the existing global-admin role check. Only users with `is_admin = true` on the `users` table can hit these routes. Add a bootstrap SQL to flip Derek's user record if not already.

## Phase 2 — Training-data export (shipped after Phase 1)

A script `src/scripts/export-ccu-training.js`:
- Walks `s3://eicr-files-production/ccu-extractions/**/ground_truth.json`.
- Pairs each with its `original.jpg` and emits a JSONL file at `./training-data/ccu-YYYYMMDD.jsonl`:
  ```jsonl
  {"image_s3": "...", "image_sha256": "...", "ground_truth": {...}, "ai_result": {...}, "reviewed_at": "...", "edits": [...diffs...]}
  ```
- `edits` is a per-field diff between `ai_result` and `ground_truth` — useful for weighting training loss toward the failure modes (e.g. colour reads).
- CLI flags: `--status validated_edited` to filter, `--since 2026-01-01`, `--user <id>`.
- Writes a second file `./training-data/summary-YYYYMMDD.md` with aggregates: total samples, validated-vs-edited-vs-skipped split, top-N edit fields ("25% of validations correct the colour read", etc.) — Derek can see where the AI is weakest.

## Phase 3 — Evaluation harness (future)

A `src/scripts/eval-ccu-extraction.js` that:
- Takes a `--holdout N` split of validated samples (default last 10% by date).
- Re-runs the current pipeline against each holdout image.
- Compares output to ground_truth and prints accuracy per-field + overall.
- Catches regressions before future prompt or code changes ship.

Plugs straight into CI (optionally gated by a `CCU_EVAL=true` flag to avoid API spend on every build).

## Phase 4 — Fine-tune or prompt-tune (future, data-driven)

When the validated dataset passes ~200 samples and the eval harness shows a consistent failure mode (likely the carrier colour reads from Phase 3 summary), options:

- **Prompt-tune**: iterate the Stage 3 / Stage 4 prompts against the eval set until accuracy plateaus. Zero training cost.
- **Claude fine-tune** (when supported for vision on this model). Upload JSONL; retrain; compare eval numbers against the baseline prompt. Anthropic's fine-tune API takes `image` + `text` → `text` pairs, which matches our shape.
- **Separate classifier** (YOLO-on-device, Phase E of the original 2026-04-16 plan). Train a small detector on the accumulated slot crops — same data, different model. iOS-friendly because it runs offline.

Decision deferred until we have data.

## Effort estimate

- **Phase 1** (backend routes + review UI + S3 shape): **1–1.5 days**
- **Phase 2** (export script + summary): **0.5 days**
- **Phase 3** (eval harness): **0.5 days**
- **Phase 4** (model iteration): not an estimate yet — depends on data quality

Total for the first-real-value slice (Phases 1 + 2): **~2 days** once the per-slot primary sprint is settled.

## Open decisions for Derek

1. **Review-UI build target**: vanilla HTML-in-backend (faster) vs Next.js page in `web/` (consistency). Lean vanilla HTML unless the design-system shortcut from `web/` is a clear win.
2. **Admin role**: global-admin sufficient, or add a dedicated `ccu_reviewer` role? Global-admin is simplest.
3. **iOS tap-to-correct** (v2): build alongside the web UI or defer? Probably defer — the web UI covers the review use case for the single admin reviewer (you), and iOS tap-to-correct is more valuable when multiple inspectors self-validate during a job.
4. **Retroactive reviews**: there are already ~dozens of extractions in S3 from the rewireable sprint alone. Review them first (backlog clear-out) or start from "any new extraction after this feature lands"?
5. **Data retention**: we currently never delete `ccu-extractions/*`. Fine while volume is small; set a lifecycle rule at ~2 years if cost becomes an issue.

## Non-goals (explicit — stay focused)

- No new photo-capture path; the existing iOS CCU camera stays the sole ingest.
- No multi-user review workflow, no assignment queues.
- No ML ops / feature store / experiment tracker. When we fine-tune, we'll use whatever the current Anthropic / OpenAI vision-finetune tooling offers.

## Next step after this plan is approved

Fire the Phase 1 build as a 1-day implementation sprint — single orchestrator + one engineer agent for the routes, one for the UI, one for tests. Schedule after the per-slot primary sprint merges to `main` so the review UI can immediately start capturing corrections for the new per-slot data.
