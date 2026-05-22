# Handoff — CCU label matcher: systematic +1 slot shift on left-half labels

**Created:** 2026-05-21
**Status:** OPEN — diagnosed but not fixed
**Severity:** medium — affects label assignment on the device-row LEFT half. MCB classifications (kind, curve, rating, RCD type) are unaffected.
**Branch:** main (HEAD `4d863e5`)
**Owner of the bug surface:** `src/extraction/ccu-single-shot.js` `matchLabelsToEntries`

---

## The bug in one paragraph

On Wylex NHRS12SL field-test extraction `1779384564405-u7dp9b` (2026-05-21 17:29 UTC, Ciaran's first board on the new matcher), the right-half labels (Cooker, Smoke Alarm, Upstairs Lighting, Lighting × 2) attached to the correct MCBs, but the four left-half sockets/boiler labels all landed one slot too far right. The matcher's pitch-derived threshold accepted the mis-attachment as a "nearest" match because it WAS the nearest device — the labels were just consistently positioned a fraction of a slot to the right of the device they actually belonged to.

---

## Evidence

### Source artefacts (already in iCloud + S3)

- iCloud: `~/Library/Mobile Documents/com~apple~CloudDocs/CertMate-ccu-latest-2026-05-21/`
  - `photo.jpg` (499 KB full-res — saved by the `833f017` no-compression change)
  - `result.json` (final analysis, post-matcher)
- S3: `s3://eicr-files-production/ccu-extractions/82b54893-220d-49f5-8c55-d677a009787b/no-session/1779384564405-u7dp9b/`
  - `original.jpg`
  - `result.json`

### CloudWatch — matcher diagnostic from the failing run

Log line at 17:29:24 UTC:

```json
{"message":"CCU single-shot label matcher",
 "enabled":true, "skipped":false, "skipReason":null,
 "labelsInput":12, "candidates":12,
 "matched":10, "droppedFarFromAnyDevice":2, "droppedDuplicateClaim":0,
 "pitchNorm":0.07, "maxDistNorm":0.035}
```

12 labels in, 10 matched. The 2 dropped-as-far were almost certainly section headers ("(RCD)" + "MAIN SWITCH") that sit between excluded-kind devices.

### Slot-by-slot — what was assigned vs what should have been

| Slot | Device kind / code | Currently assigned | Inspector says SHOULD be |
|---|---|---|---|
| 0 | NHXB16 (B16) | "Garage Door" | "Garage Door" ✓ |
| 1 | NSB16 (B16) | **null** | **"Immersion Boiler"** |
| 2 | NSB16 (B16) | "Immersion Boiler" | **"Downstairs Sockets"** |
| 3 | NSB32 (B32) | "Downstairs Sockets" | **"Kitchen Sockets"** |
| 4 | NSB32 (B32) | "Kitchen Sockets" | **"Sockets" (another sockets circuit)** |
| 5 | NSB32 (B32) | "Sockets" | unclear (likely null or its own label) |
| 6,7 | RCD pair (WRS80/2) | null | n/a — RCDs filtered |
| 8 | PSB32-C (C32) | null | unclear (no label spotted on inspector view) |
| 9 | NSB32 (B32) | "Cooker" | "Cooker" ✓ |
| 10 | NSB06 (B6) | "Smoke Alarm" | "Smoke Alarm" ✓ |
| 11 | NSB06 (B6) | "Upstairs Lighting" | "Upstairs Lighting" ✓ |
| 12 | NSB06 (B6) | "Lighting" | "Lighting" ✓ |
| 13 | NSB06 (B6) | "Lighting" | "Lighting" ✓ |

So: slots 1-5 are shifted +1 to the right. Slot 0 and slots 9-13 are correct.

### Note on shift direction

In the slots[] array, slot 0 is LEFT-most in the image and slot 13 is RIGHT-most. The main switch is on the RIGHT in this Wylex board, so the schedule scan order is reversed (right-to-left) when building circuits[]. "Shift +1 to the right" here means each label sits one column to the RIGHT of the device it belongs to.

---

## Hypotheses for root cause

Listed in descending order of likelihood. None are confirmed because the result.json doesn't preserve the raw `labels[]` array gpt-5.5 returned — that data lives only in the VLM's output, which we threw away after `matchLabelsToEntries` consumed it. **First task in the next session is to preserve it.**

### H1 — VLM systematic right-bias on left-half label positions (most likely)

The matcher diagnostic logs `pitchNorm=0.07`, `maxDistNorm=0.035`. A systematic bias of just 0.020 in the label's `position_x` is enough to flip the nearest-neighbour pick from the correct device to its right neighbour. Possible causes:
- The label strip's left edge is offset from the rail's left edge on Wylex boards — visually the labels sit a few mm right of the device they describe.
- gpt-5.5's spatial reasoning has a small leftward bias on identical-looking MCBs (it sees a row of identical NSB16/NSB32 modules and groups them, then assigns label x-positions clustered toward the right of the group).
- Image perspective: Ciaran's photo has the board photographed at a slight angle (right-leaning), so the right side of the strip-label visible area is slightly closer to the camera than the left.

### H2 — Pitch estimation distorted by the RCD pair

`pitchNorm=0.07` looks roughly right for a 14-slot rail (1/14 ≈ 0.071). But the matcher computes pitch from gaps between **matchable** entries only (MCBs/RCBOs), excluding the RCD pair at slots 6-7. The MCB sequence is 0-5 then 8-13 — gap between slot 5 and slot 8 is ~3× normal pitch, gap between 7 and 8 also large. Median gap is still robust to that outlier, but if the model's reported positions for MCBs near the RCD are slightly compressed, the threshold could be too generous on the left side.

### H3 — gpt-5.5 returns labels in a different order from physical left-to-right

Less likely given the right-half is fine. But worth checking — the matcher doesn't rely on label order, only positions, so this shouldn't cause a systematic shift unless the model emitted positions in display order rather than physical column order.

### H4 — One label gpt-5.5 missed on the FAR LEFT (slot 1's "Immersion Boiler") cascaded the rest

If gpt-5.5 reported only 10 labels for the left side instead of 11, and they were broadly correctly positioned, the matcher would assign them to the leftmost-available devices in left-to-right order — which would shift everything right by 1 starting from where the missing label was. The diagnostic shows `labelsInput=12, matched=10, droppedFarFromAnyDevice=2` — so 12 raw labels, 10 used. The dropped 2 are likely section headers, but it's possible one was a legitimate label dropped by the threshold. Worth verifying.

---

## Suggested next steps

In order. Do them as separate commits.

### Step 1 — Preserve raw VLM output for diagnostics (1 commit, ~30 min)

We have no way to verify hypotheses without the raw `labels[]` and per-entry `position_x` values from the VLM. Add them to `result.json`:

- `src/extraction/ccu-single-shot.js` `extractViaSingleShot`: add `result.entries` and `result.labelArray` to the returned object (already exposed via `runSingleShot`).
- `src/routes/extraction.js`: when building `analysis.slots`, preserve the `position_x` from `result.entries[i]` onto `slots[i].position_x_normalised` so it survives into result.json.
- Add `analysis.vlm_labels_raw = result.labelArray` (the unmodified labels array) so we can replay the matcher offline against the same input.

After this ships, the NEXT extraction Ciaran does will include the raw positions in result.json and we can diagnose this shift precisely.

### Step 2 — Re-run the diagnostic prompt against THIS photo (no deploy needed)

Use `/tmp/test_ccu_diagnostic.mjs` (still on disk) or write a fresh script. Send the photo at `~/Library/Mobile Documents/com~apple~CloudDocs/CertMate-ccu-latest-2026-05-21/photo.jpg` to gpt-5.5 with the CURRENT MODERN_PROMPT and dump:
- The raw labels[] with `text` + `position_x`
- The raw entries[] with `device_kind` + `position_x`
- Compute the matcher's assignment by hand (or in Node) and check which hypothesis matches the data

Cost: ~$0.05 per call. Run 2-3 times to confirm the shift is reproducible at the input level.

### Step 3 — Pick a fix based on what step 2 shows

**If H1 (VLM right-bias):**
- Option A: Add a tie-break to `matchLabelsToEntries` — when a label is within ~0.7× pitch of TWO adjacent devices, prefer the LEFT device. Trade-off: could regress boards where labels genuinely sit between two MCBs and belong to the right one. Need corpus test.
- Option B: Reverse-direction nearest-neighbour — for each LABEL, find the nearest DEVICE that doesn't already have a closer label claim. Current algorithm is already roughly this, but the closest-wins tie-break may favour the right device when distances are equal-ish.
- Option C: Hungarian assignment — proper bipartite matching that minimises total distance. Overkill but provably correct for the "consecutive labels in sorted order" case.

**If H2 (pitch distortion):**
- Compute pitch from MCB-only adjacent gaps EXCLUDING the long-gap outliers (any gap > 1.5× median).

**If H4 (gpt-5.5 dropped a real label):**
- Inspect the 2 dropped labels in the matcher diagnostic. If one was a circuit label, the threshold needs widening for the leftmost slot (or the prompt needs to explicitly enumerate every label including faint ones).
- May also be the iOS/inspector workflow: confirm slot 1 actually had a visible "Immersion Boiler" label on the strip. If the strip cell was blank, this isn't a model bug.

### Step 4 — Add a regression test pinning the corrected mapping

After the fix, add a unit test in `src/__tests__/ccu-single-shot-label-matcher.test.js` that mirrors the Wylex NHRS12SL device layout + the (real) label positions from step 2, asserts each label lands on the correct slot.

---

## What is ALREADY in production and working

For context — don't relitigate these:

- **`a52e0e1`** — single-shot prompt LABELS section tightened to "DIRECTLY ABOVE or BELOW, same vertical column" (kept even after the matcher rewrite — defensive in case the matcher path is ever bypassed).
- **`833f017`** — CCU training-corpus uploads are now full-res (no more 184 KB compression). This extraction is the FIRST one captured at full resolution (510 KB instead of ~180 KB).
- **`5a5d4f7`** — position-based label matcher (the code that has the bug). MODERN_PROMPT + REWIREABLE_PROMPT return two arrays (entries with `position_x`, labels with `text` + `position_x`). `matchLabelsToEntries` does pitch-derived nearest-neighbour 1-to-1 assignment with closest-wins on duplicate claims. Gated by `CCU_VLM_POSITION_MATCHER=true` (default on, can flip off for emergency rollback).
- **`91fee3b`** — `libgnutls30` upgraded in the backend Docker image to unstick Trivy on CVE-2026-33845 + CVE-2026-42010.
- **`fca8a91`** — RCD waveform reads NEVER overridden (deleted the `uniform_low_conf` trigger), `lookupMissingRcdTypes` requires both manufacturer AND board_model, scan-order-only `rcd_protected` (pre-RCD MCBs stay unprotected, no look-ahead).
- **`4d863e5`** — RCD type web search now uses per-device part codes from `slot.model` when readable. Search prompt asks for exact board OR exact device-code datasheet match. `match_kind` enum in the response with apply-step guard to refuse `not_found` answers even if rcd_type came back non-null.

iOS TestFlight 364 is the active build on the Electricians group — no iOS-side changes needed for any of the above or for this label-shift fix.

---

## Files involved

Read these first:

- `src/extraction/ccu-single-shot.js` — has `matchLabelsToEntries` (line ~430), `MODERN_PROMPT` (line ~97), `REWIREABLE_PROMPT` (line ~159), `extractViaSingleShot` (line ~672).
- `src/routes/extraction.js` — has `lookupMissingRcdTypes` (line ~488), `slotsToCircuits` (line ~1554), the route handler that calls `extractViaSingleShot` and wires its output into `analysis`.
- `src/__tests__/ccu-single-shot-label-matcher.test.js` — unit tests for the matcher (10 tests, all passing). New tests go here.

Read these for context if needed:

- `CLAUDE.md` "Current Focus / Active Work" — CCU pipeline section accurately describes the live single-shot + matcher path.
- `docs/reference/architecture.md` "CCU Photo Extraction Pipeline" — describes single-shot, says no per-slot crops in current path.

---

## Run / verify commands

```bash
# Run the matcher tests
cd /Users/derekbeckley/Developer/EICR_Automation
npm test -- --testPathPattern="ccu-single-shot-label-matcher"

# Run the full CCU suite
npm test -- --testPathPattern="ccu"

# Pull the failing extraction artefacts from S3 (if iCloud copy gone)
USERID="82b54893-220d-49f5-8c55-d677a009787b"
EXTRACTION="1779384564405-u7dp9b"
aws s3 cp "s3://eicr-files-production/ccu-extractions/$USERID/no-session/$EXTRACTION/" /tmp/ccu-shift/ --recursive

# Watch CloudWatch for the matcher diagnostic on a new extraction
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --filter-pattern "CCU single-shot label matcher" --since 1d
```

---

## Open questions for Derek

1. **Slot 5** — current assignment is "Sockets". His note "slot 4 should be another socket circuit" suggests slot 5 had its own distinct label (e.g. "Garage Sockets"?) but only 3 sockets labels reached the matcher. Or slot 5 was supposed to be null and the "Sockets" label belonged on slot 4. Quick conversational confirmation in the next session will pin this down.
2. **Slot 8** (the PSB32-C C-curve 32A) — currently null. Did the inspector's view show a label here? If yes, the matcher dropped a real label as "far from any device", which is a separate bug.
3. **Sample size** — this is one board. Before code-side changes that shift behaviour for everyone, would be worth pulling 3-5 other recent extractions and checking if the same pattern shows up.

---

## Don't do

- Don't disable the matcher and revert to per-entry labels. The pre-matcher behaviour was strictly worse (Cooker-on-B16 was the trigger for this whole architectural change).
- Don't tighten the threshold below 0.5 × pitch. That regresses the boundary-label cases the matcher was designed to handle.
- Don't ask the VLM to do the assignment itself again. That experiment is the bug we just fixed.
- Don't add per-board manufacturer-specific bias tuning (e.g. "Wylex strip is 0.015 right of rail"). One field-test photo is not enough corpus to justify a per-vendor offset; if there's a fix it should be data-driven over a larger sample.
