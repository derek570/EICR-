# Handoff — investigate missing device settings on CCU extraction (2026-05-05)

> Read this top to bottom. It's self-contained — every reference includes a
> file path or extraction ID, no shared session state required.

## Where production stands

Today (2026-05-05) was a heavy CCU pipeline rebuild. The current production
state is:

- **Backend `eicr-backend:119`** (ECS, eu-west-2) — green, rollout COMPLETED.
- **All today's fixes are live:**
  - RCD-type lookup table (`config/rcd-type-lookup.json`) with manufacturer
    aliases + confusable-pair model matching.
  - Quad geometry (`src/extraction/ccu-rail-quad.js`) — line-fitted rail
    edges → bilinear quadrilateral → autocorrelation pitch → bounded
    phase-lock (±12% of pitch). Default ON via `CCU_QUAD_GEOMETRY=true`,
    falls back to legacy `tightenAndChunk` then VLM `prepareModernGeometry`.
  - Main-switch label promotion
    (`promoteLabelMatchedMainSwitch` in `src/routes/extraction.js`).
  - `applyRcdTypeLookup` stamps Type A onto circuits per the table.
- **CCU geometry pipeline architecture** — full description in user memory:
  `~/.claude/projects/-Users-derekbeckley-Developer-EICR-Automation-CertMateUnified/memory/ccu_geometry_pipeline_2026-05-05.md`.
  Loads automatically into your context via `MEMORY.md`. Read it first.

## The new issue — missing device settings

User has just completed a CCU extraction. **Geometry, count, labels, and
RCD types are mostly correct** — but one or more "device settings" came
back missing/wrong. User did not say which fields specifically.

The extraction:

- **Time:** 2026-05-05 11:37:48 UTC
- **User:** `82b54893-220d-49f5-8c55-d677a009787b`
- **Container:** `74d37d8f1e9d4b53828e21e982278a85`
- **Board:** Elucian CU1SPD275 (the recurring test board)
- **Circuits:** 12, fully labelled (Ovens, Hob, Utility, Master Bed, Garage,
  Kitchen, Front RHS Bed, Front Left Bed, Bathroom UFH, Rear Bed,
  Lounge TV, Loft Socket)
- **RCD types:** `[null, "A", "A", "A", "A", "A", "A", "A", "A", "A", "A", "A"]`

**The smoking gun:** `circuitRcdTypes[0]` is `null` for Ovens (circuit #1).
Every other circuit got Type A. The RCD lookup table is set to
`confidence: "high"` for Elucian and should have stamped Type A on every
RCD-protected circuit unconditionally. So either:

1. Ovens isn't being marked `rcd_protected: true` upstream of
   `applyRcdTypeLookup` (which has a `if (!circuit.rcd_protected) continue`
   guard at `src/extraction/rcd-type-lookup.js` ~ line 220).
2. Ovens has `is_rcd_device: true` (the "skip standalone RCD/SPD slots"
   guard, same function).
3. Some other field on the Ovens circuit row is missing/wrong (rating,
   curve, BS-EN, poles) — which is what "device settings" most naturally
   means in EICR terminology.

The user noticed something visually on iOS, so the missing field(s) are
likely visible in the schedule UI — the most likely suspects are:

- `ocpd_rating_a` (the breaker amperage)
- `ocpd_curve` (B / C / D)
- `ocpd_type` (MCB / RCBO / Rew)
- `ocpd_bs_en` (BS-EN standard number)
- `ocpd_poles` (1 / 2 / 3 / 4)
- `cable_csa_phase_mm2`, `cable_csa_cpc_mm2`, `cable_designation`,
  `wiring_method` — but these are inspector-entered, not VLM-extracted

## Where to look

### 1. Pull the actual circuit objects from the latest extraction

The full result is stored in S3:

```bash
aws s3 cp \
  s3://eicr-files-production/ccu-extractions/82b54893-220d-49f5-8c55-d677a009787b/no-session/<EXTRACTION_ID>/result.json \
  /tmp/latest.json --region eu-west-2

# Find the extractionId from CloudWatch:
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h \
  | grep "CCU training sample logged" | tail -1
```

Look at `analysis.circuits[]`. For each circuit, check which fields are
populated and which are null. Compare circuit 1 (Ovens, the suspect) vs
circuit 2 (Hob, presumed correct).

### 2. Trace the missing field back through the pipeline

For each missing field, find where it gets set:

| Field | Where it's set | File |
|---|---|---|
| `rcd_type` | `applyRcdTypeLookup` from table; or per-slot waveform read | `src/extraction/rcd-type-lookup.js`, `src/routes/extraction.js` |
| `ocpd_rating_a`, `ocpd_curve`, `poles` | Stage 3 per-slot classifier output (`slot.ratingAmps`, `slot.tripCurve`, `slot.poles`) → `buildCircuitFromSlot` | `src/extraction/ccu-geometric.js` (Stage 3), `src/routes/extraction.js` (`buildCircuitFromSlot`) |
| `ocpd_type`, `ocpd_bs_en` | `slot.classification` + manufacturer-rating lookup, `applyBsEnFallback` | `src/routes/extraction.js` |
| `rcd_protected` | Cascade in `slotsToCircuits` — RCD upstream of MCBs marks them protected | `src/routes/extraction.js` ~ line 1672 |

### 3. CloudWatch query for the full per-slot trace

```
fields @timestamp, @message
| filter @message like /CCU/ or @message like /slot/
| sort @timestamp desc
| limit 60
```

Filter to the 11:37 timeframe. The Stage 3 / Stage 4 raw outputs are
included in `CCU geometric extraction attached` and `CCU stage4 label
pass complete`.

### 4. Boundary phase diagnostic

The new bounded phase-lock logs `phaseShiftPx` and `phaseOffsetSamples`
in the `CCU box-tightener used` event. The 11:37 extraction's value is
visible in the log already. If it's near 0, phase-lock isn't doing
much; if it's at the cap (~12% of pitch in samples), the line-fitter
might be partially off.

## What NOT to do

These are all settled — don't re-litigate:

- **Don't widen `cropSlot`'s 2.2× pitch factor.** Tested and tuned. Goes
  wide on purpose for 2-pole devices.
- **Don't narrow it either.** Tried 1.6× — RCD confidence collapsed.
- **Don't remove phase-lock.** Was reverted earlier today (commit
  `fc1602a`) and re-added with a ±12% cap (`7f8ec5a`). The cap is the
  point. Read the cap rationale at `src/extraction/ccu-rail-quad.js`
  near `PHASE_CAP_FRACTION`.
- **Don't propose gradient-pitch refinement as a fresh idea.** The V2
  probe pipeline (legacy `tightenAndChunk`) already does this. Quad
  replaced it for a structural reason — operating on a perspective-
  corrected signal — not because gradient probing was broken.
- **Don't add a count-rounding tweak to fix a missed end device.** That's
  what quad geometry was for. Diagnose at the geometry layer.
- **Don't deploy via local `./deploy.sh`.** Always `git push origin main`
  → `gh run watch <run-id>`. Docker isn't kept running on the dev Mac.
  See `~/.claude/.../memory/feedback_deploy_via_github.md`.

## How to deploy (when you have a fix)

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
git push origin main
gh run watch <run-id> --exit-status
```

CI takes ~30 min end-to-end. ECS deploy is automatic on `main` push.

## Today's commit chain (newest first)

```
7f8ec5a  fix(ccu): re-instate phase-lock with bounded ±12% search window
fc1602a  revert(ccu): drop phase-lock — per-slot anchoring is the right fix  ← UNDONE by 7f8ec5a
0356357  fix(ccu): phase-lock slot grid to actual device boundaries (quad geometry)
3122345  chore(scripts): add dump-quad-overlay debug visualiser
4bdd9ee  fix(ccu): promote misclassified main-switch slots from their Stage 4 label
80a17d1  feat(ccu): make perspective-aware quad geometry the default extraction path
a8cec7d  feat(ccu): perspective-aware rail geometry (line-fitted edges + bilinear quad + autocorr pitch)
e078fde  feat(ccu): wire ways override + run RCD lookup self-test at boot
a2fe6f2  feat(ccu): RCD lookup gains aliases, confusable matching, ways question, self-test
13e5a65  feat(ccu): box-tightener accepts waysOverride to bypass formula count
539fb8d  docs(ccu): rollout TODO for RCD type lookup feature
5f87b0f  feat(ccu): wire RCD type lookup into CCU extraction pipeline
444e5ea  feat(ccu): add interactive CLI to promote pending RCD lookup entries
49c7fad  feat(ccu): add S3-backed auto-grow side for RCD lookup table
d900fa2  feat(ccu): add deterministic RCD-type lookup table for UK consumer units
```

## Useful debug tool

`scripts/dump-quad-overlay.mjs <photo> <out-dir> --roi x,y,w,h`
produces an annotated PNG (rail quadrilateral + slot centres + Stage 3
orange and Stage 4 green crop rectangles) plus per-slot crops + an
`index.html` browseable view. ROI values come from the `CCU rail_roi
hint received` CloudWatch event.

User keeps overlay outputs at:
`~/Library/Mobile Documents/com~apple~CloudDocs/CertMate-debug/quad-overlay/`

## First investigation step (suggested)

1. Pull `result.json` for the 11:37 extraction from S3 (path above).
2. `jq '.analysis.circuits[0]' /tmp/latest.json` and compare to circuits[1].
3. Identify which fields are null/missing on circuit 1 vs populated on
   circuit 2.
4. Trace those fields back to where they get set (table above).
5. Report findings to user, then propose a fix.

The 11:37 extraction had Ovens at circuit 1 with `rcd_type: null`, while
every other circuit got `rcd_type: "A"` from the lookup. That's the
single most concrete clue. Start there.
