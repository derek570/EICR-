# Codex code review — `ccu-per-slot-primary` branch

**Reviewer**: Codex gpt-5.4 (research preview), session `019db71c-dfeb-7803`. **Invocation**: `codex review --base main --title "CCU per-slot primary sprint — 8 commits, 4111 lines"`. **Raw output**: `.planning/ccu-per-slot-codex-review-raw.txt` (561 lines). Paired Claude review: `.planning/ccu-per-slot-claude-review.md`.

## Findings summary

| Priority | Area | File / line | Status |
|---|---|---|---|
| **P1** | Modern slot geometry passed to Stage 4 in wrong coordinate space | `src/routes/extraction.js:1353-1356` | **Fixed** in commit `f2e304d` |
| **P1** | `mainSwitchOffset` ignored when inline — inverts BS 7671 numbering | `src/routes/extraction.js:1425-1429` | **Fixed** in commit `f2e304d` |
| **P2** | Post-merge circuits miss `applyBsEnFallback` + `normaliseCircuitLabels` | `src/routes/extraction.js:1436-1438` | **Fixed** in commit `f2e304d` |
| **P2** | `classifyBoardTechnology` awaited before single-shot kickoff — +3s serialised latency | `src/routes/extraction.js:970-975` | **Deferred** — Agent C's parallelism refactor subsumes |

## Full finding text (verbatim from Codex)

> The new per-slot pipeline introduces at least two correctness regressions in the returned circuit list: modern-board label crops use the wrong coordinate space, and inline edge main switches can reverse circuit numbering. It also overwrites already-enriched circuits and adds a universal latency regression.

### [P1] Convert modern slot geometry to pixels before Stage-4 label crops

> When `extractCcuGeometric()` is selected, its `slotCentersX` and `moduleWidth` are still on the 0-1000 normalized scale (`ccu-geometric.js` documents them that way), but `extractSlotLabels()`/`cropSlotLabelZone()` interpret `slotCentersX` and `slotPitchPx` as pixel values. On modern boards this makes the Stage-4 crops far too narrow and shifted to the left, so labels are routinely read as `null` or from the wrong position before `slotsToCircuits()` overwrites `analysis.circuits` with those results.

### [P1] Use `mainSwitchOffset` when numbering inline switch-fuse boards

> If a rewireable board has its main switch integrated into the carrier row, Stage 1/classifier correctly report `mainSwitchSide`/`main_switch_position` as `"none"`, but Stage 2 still tells us whether that switch occupies the left or right edge via `mainSwitchOffset`. The merger ignores that edge information here, so boards with an inline switch-fuse at the right edge will be numbered left-to-right instead of starting at the device nearest the main switch.

### [P2] Re-apply circuit enrichment after replacing `analysis.circuits`

> `applyBsEnFallback()`, `normaliseCircuitLabels()`, and `lookupMissingRcdTypes()` all run before the per-slot merge, but this branch replaces `analysis.circuits` afterwards. That means merged rows never get the existing enrichment pass; for example, RCBO slots that omit `rcdWaveformType` now stay `rcd_type: null` even though `lookupMissingRcdTypes()` could previously fill them from the board metadata.

### [P2] Kick off single-shot extraction before awaiting board classification

> The new flow awaits `classifyBoardTechnology()` before the main single-shot VLM request is even started, so every `/api/analyze-ccu` call now pays the classifier latency (~3s) on top of the existing end-to-end time. The surrounding comments say these paths should run in parallel, but this ordering serializes them and regresses response time for all per-slot-enabled requests.

## Reconciliation with Claude's review

Claude flagged the P2-1 enrichment loss as a follow-up but did NOT call it a correctness bug — Codex correctly elevated it. Claude also flagged the classifier serialisation as a minor observability/clarity issue without an explicit latency number; Codex put a number on it (+3s per request).

**What Claude caught that Codex didn't**:
- 8 non-blocking follow-ups (duplicate Anthropic client, modern-board main-switch force-tag symmetry, LABEL_MAP de-duplication, route-handler integration-test gap, single-shot numbering-direction compliance, CloudWatch retry-rate metric, etc.).
- Full architecture assessment.
- Test coverage gaps.

**What Codex caught that Claude didn't**:
- **P1-1** coordinate-space mismatch (real correctness bug on modern boards).
- **P1-2** inline main-switch numbering bug (real correctness bug on switch-fuse boards).

Both caught the post-merge enrichment loss and the classifier serialisation. Codex's reviews are spikier on correctness + local coordinate-space reasoning; Claude's are broader on architecture, follow-ups, and test coverage. **Running both is strictly additive** — the three bugs Codex found are exactly the kind of cross-file coordinate-space / ordering issues that benefit from a fresh pair of eyes.

## Fix commit

`f2e304d fix(ccu): address Codex P1+P2 findings on per-slot route handler` — 54 insertions, 6 deletions in `src/routes/extraction.js`. See commit body for per-finding reasoning. Tests: 175 passing, 0 regressions.

## Remaining after fix

- Agent C parallelism refactor subsumes the deferred P2 classifier serialisation.
- Claude's 8 follow-ups remain open (see its review §"Non-blocking items").
- One Codex point Claude hadn't considered: when Stage 3 returns an RCBO with `rcd_protected: true` but null `rcdWaveformType` AND the board manufacturer is known, `lookupMissingRcdTypes()` could still fill that gap via web search. Currently skipped after the merge to avoid double-spend. Re-evaluate once field data shows how often this path matters.
