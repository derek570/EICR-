# Optimizer rewrite — execution handoff (2026-06-03)

Source plan: [.planning/optimizer-rewrite-plan-2026-06-03-final.md](./optimizer-rewrite-plan-2026-06-03-final.md)
Refine log: [.planning/optimizer-rewrite-plan-2026-06-03-refine-log.md](./optimizer-rewrite-plan-2026-06-03-refine-log.md)

Read this file FIRST in any resumption session. The plan is the source of truth for intent; this file is the source of truth for what's shipped vs. what's left.

---

## TL;DR for a fresh session

You're inheriting **4 open PRs** that ship the optimizer rewrite plan. They stack and are intended to merge in this order:

1. `#43 backend-optimizer-prereqs` — backend `src/` edits (no behavior change; clean refactor + one-line export). Merge first to unblock #46's `canonical_name_leak_to_ios` detector.
2. `#42 cluster-1-optimizer-prompt-fixes` — optimizer prompt + budget rewrite. Independent of #43.
3. `#45 cluster-2-architectural-awareness` — new categories + decision tree + analyzer extensions. Stacks on #42.
4. `#46 cluster-3-signatures-and-probes` — bug-class signatures + harness probe safety net. Stacks on #45.

**After each merge of a PR touching `scripts/session-optimizer.sh`** (#42, #45, #46), run:

```sh
launchctl kickstart -k gui/$(id -u)/com.certmate.session-optimizer
```

The long-running poll process does NOT auto-pick up shell-script edits.

There are **5 deferred follow-up workstreams** (sections below) — none block any of the 4 PRs from merging, but they're load-bearing for the optimizer to deliver its full intended value.

---

## What's shipped — PR-by-PR breakdown

### PR #43 — `backend-optimizer-prereqs` → main

**Branch base:** main
**Commits (2):**
- `ac88afd2 feat(stage6): export CIRCUIT_FIELD_VALUE_ENUMS for analyzer-side detectors` — one-line `export` added at `src/extraction/stage6-dispatch-validation.js:89`.
- `cb770d6a refactor(stage6): extract KNOWN_FIELDS into side-effect-free module` — moves `KNOWN_FIELDS` from `sonnet-stream.js` into new `src/extraction/known-fields.js`; also exposes `IOS_DUAL_ALIAS_ALLOWLIST` (intentionally empty — safe-to-populate criteria in the module docstring).

**Why this PR exists:** Cluster 3 Item 7's `value_out_of_enum_no_validator` and `canonical_name_leak_to_ios` detectors need to import the canonical sources without pulling in `sonnet-stream.js`'s WebSocket bootstrap side effects.

**Test status:** 4404 backend tests pass. Zero runtime behaviour change in either commit.

**Verification post-merge:** none beyond "tests pass in CI". Both changes are silent imports/exports.

**Deliberate omissions from this PR** (full rationale in PR body):
- **Backend prereq (0)** — `backend_events.jsonl` sidecar writer in `src/extraction/sonnet-stream.js`. Deferred for collision risk with `fix/observation-correctness-2026-06-03` which is actively editing the same file. See "Deferred workstream 1" below.
- **Backend prereq (3)** — `value` field on `input_summary`. INTENTIONALLY SKIPPED — see "Backend prereq (3) PII-guard decision" below.

---

### PR #42 — `cluster-1-optimizer-prompt-fixes` → main

**Branch base:** main
**Commits (4):**
- `5be55ae3 fix(optimizer): filter harness_* sessions out of the poll + audit loops` — basename-anchored skip in `scripts/session-optimizer.sh`'s poll + missed-sessions audit loops.
- `af44aa82 chore(optimizer): add cleanup-harness-state.sh for backlog purges` — companion one-shot cleanup script for `~/.certmate/optimizer_state.json`.
- `ee964916 fix(optimizer): replace Nova-3 keyterm budget with Flux semantics` — bundles Item 2 (Flux flip) + Item 4 schema-fields pull-forward (`implementation_status` field + `category` on debug prompt). Touches both prompts, session-optimizer.sh budget computation, and the HTML report cost label.
- `f9b0d533 docs(optimizer): add dialogue-engine + Flux Configure paths to prompts; soften REGEX-FIRST framing` — extends "Current code reference" + CORE PRINCIPLE softening (full decision tree lands in #45).

**Smoke-tested locally** (prompts render correctly; live config has 161 raw keyterms → 100 after iOS cap → 96 estimated through URL truncation, zero headroom under both caps — the truncation pressure that was invisible under Nova-era metrics).

**Verification post-merge:**
1. `launchctl kickstart -k gui/$(id -u)/com.certmate.session-optimizer`.
2. Re-process 2-3 recent real (non-harness) sessions via state-file edit:
   ```sh
   # Suggested sessions:
   #   D7D01509-4211-4596-90DF-4A2BA22ED47F
   #   6FB1EC91-59AD-493A-80EA-8FAB42A4BEF0
   jq 'del(.processed_sessions[] | select(. | test("D7D01509|6FB1EC91")))' \
     ~/.certmate/optimizer_state.json > ~/.certmate/optimizer_state.json.tmp \
     && mv ~/.certmate/optimizer_state.json.tmp ~/.certmate/optimizer_state.json
   ```
   Wait one poll cycle (~120s), inspect resulting `optimizer-reports/*.json`:
   - No `harness_*` queue entries (CloudWatch / log file should be quiet).
   - No `:boost` tier mentions in recommendations.
   - ≥1 recommendation references a `dialogue-engine/` file path.

---

### PR #45 — `cluster-2-architectural-awareness` → main

**Branch base:** main (cut from `cluster-1-optimizer-prompt-fixes`; stacks naturally — merge #42 first, then this rebases to a fast-forward)
**Commits (3):**
- `cf104881 feat(optimizer): 8 new categories + renderer schema split + REC_CAT mapping` — extends category enum 8→16 across three lockstep surfaces (prompt enum, `CATEGORY_COLORS`, `REC_CAT` switch); removes the `head -c 20` truncation that would mis-route long category names; introduces the schema-split renderer for advisory categories.
- `4a9b1740 docs(optimizer): EXTRACTION-PATH-AWARE decision tree replaces REGEX-FIRST` — 7-step explicit decision tree (per plan Item 5). Debug prompt gets a compact a-g variant.
- `db0cfd73 feat(optimizer): per-session focused-mode + dialogue-engine + unmapped telemetry` — adds 5 new analyzer sections (`focused_mode_timeline`, `dialogue_engine_transitions`, `stage6_tool_calls`, `unmapped_readings`, `bug_signature_hits` stub); wires template vars into both vars-builder + prompt; adds the `backend_events.jsonl` sidecar download stanza.

**Test status:** 35/35 `node --test scripts/__tests__/analyze-session.test.mjs` pass. Renderer + analyzer smoke-tested with synthetic fixtures (4-rec recommendations.json renders the 2 implementable + 1 awaiting + 1 probe correctly; 5-event session populates all new analyzer sections).

**Verification post-merge:**
1. `launchctl kickstart` as above.
2. Re-process the same 2-3 sessions; verify routing now uses the new categories (look for `dialogue_engine_schema_*`, `dispatcher_validator`, `field_name_correction_add` in reports).
3. **Verification split** (per plan): historical session `284CBBCD` will show `focused_mode_timeline.slot_field: null` for every row — that's correct, not a regression. Slot_field only populates on sessions recorded AFTER the iOS telemetry edit (Deferred workstream 2).

**Deliberate omissions from this PR:**
- **iOS telemetry edit** — see Deferred workstream 2.
- **Backend prereq (0) sidecar** — see Deferred workstream 1. Until it ships, `dialogue_engine_transitions` + `stage6_tool_calls` will be empty for most sessions (some events may still come through iOS debug_log.jsonl).
- **Item 4's per-category `auto_pr` flag UI** — Cluster 3 Item 7 carries it on every signature with `false`; not surfaced in the report renderer until the auto-PR execution plan is approved.

---

### PR #46 — `cluster-3-signatures-and-probes` → main

**Branch base:** main (cut from `cluster-2-architectural-awareness`)
**Commits (2):**
- `e4d86f2f feat(optimizer): KNOWN_BUG_SIGNATURES registry with 4 detector matchers` — registry with `ir_bare_bridge_single_digit` (works), `flux_garble_single_word` (advisory — awaiting_infrastructure), `value_out_of_enum_no_validator` (stub — PII-guard blocked), `canonical_name_leak_to_ios` (gated on PR #43).
- `92829b9d feat(optimizer): harness probe auto-generated/ skip + template scaffold` — **SAFETY-CRITICAL** walker skip in `transcript-replay.mjs` + one template + README + `NOTIFY_MODE` Pushover-batching skeleton.

**The walker skip is the must-review-carefully piece.** Per Decision 2 of the plan, auto-generated probes live under `tests/fixtures/voice-latency-scenarios/auto-generated/<suite>/` and the default harness sweep + CI must NEVER pick them up. The implementation is an **explicit walker check** (`if (!INCLUDE_AUTO_GENERATED && entry.name === 'auto-generated') continue;`), NOT a glob expansion — the walker recursively visits every subdir by default, so a glob change would only narrow scope, not exclude.

**Test status:** 35/35 analyzer tests still pass. `ir_bare_bridge_single_digit` verified locally on synthetic L-L=2 + L-E=">200" event — fires correctly with `reference_commit: 3c77b1bb`. `canonical_name_leak_to_ios` falls back to no-match gracefully when `known-fields.js` isn't on the import path (current state on main).

**Verification post-merge:**
1. `launchctl kickstart` as above.
2. Verify the auto-generated/ directory is invisible to default sweep:
   ```sh
   mkdir -p tests/fixtures/voice-latency-scenarios/auto-generated/garbles
   cp scripts/probe-templates/garbles/probe_ir_bare_bridge_single_digit.yaml \
      tests/fixtures/voice-latency-scenarios/auto-generated/garbles/probe_test.yaml
   # Default sweep (CI behavior):
   node scripts/voice-latency-bench/transcript-replay.mjs --scenario= --output=/tmp/out --user=fake --password=fake 2>&1 | grep -c "probe_test"  # → 0
   # Opt-in:
   node scripts/voice-latency-bench/transcript-replay.mjs --scenario= --include-auto-generated --user=fake --password=fake 2>&1 | grep -c "probe_test"  # → 1
   # Clean up:
   rm -rf tests/fixtures/voice-latency-scenarios/auto-generated/garbles/probe_test.yaml
   ```
3. After PR #43 also merges, `canonical_name_leak_to_ios` should auto-activate. Re-process a session with a known canonical name leak (check CloudWatch for `unmapped_field_buffered` events) and verify `bug_signature_hits` contains the matching entry.

---

## Deferred workstreams — what's left to do

These are out-of-scope for the 4 PRs above but called out in the plan and/or surfaced during execution. Each section ends with "How to start" pointing at the file/line + branch shape.

### 1. Backend prereq (0) — `backend_events.jsonl` sidecar writer

**Status:** Not started. The download stanza on the optimizer side is in place (#45 commit `db0cfd73`); only the backend writer is missing.

**Why deferred:** High collision risk — the concurrent observation-correctness sprint (now PR #44) is actively editing `src/extraction/sonnet-stream.js` territory. Premature backend writes here would force a contentious merge.

**What it does:** at session-close (next to the existing `cost_summary.json` S3 upload at `src/extraction/sonnet-stream.js` ~line 4290), serialize a per-session in-memory event buffer to `s3://eicr-session-analytics/session-analytics/{userId}/{sessionId}/backend_events.jsonl`. The buffer captures:
- `stage6.{ocpd|rcd|rcbo|ring_continuity|insulation_resistance}_script_*` events (engine state transitions)
- `stage6_tool_call` rows (dispatcher per-call telemetry)
- Sanitised — drop any user-uttered transcript not already in the engine event payload.

**Suggested implementation:** wrap the per-session `logger` (already passed into engine + dispatchers) at session-creation time so on `info(...)` it both calls the real logger AND, if the event name matches a target prefix, pushes to `entry.backendEvents = []`. At session-close, JSONL-serialize + upload via the existing `storage.uploadJson` helper. ~80-120 lines + a small test in `src/__tests__/sonnet-stream-*.test.js`.

**Order:** Land AFTER PR #44 merges to minimise rebase pain.

**How to start:** branch `backend-events-sidecar` from main (post-#44 merge). Anchor file: `src/extraction/sonnet-stream.js` around line 4290 for the upload point; `src/extraction/dialogue-engine/engine.js` line 557 area for an example of where `logger?.info?.(`...`)` is called (those are the calls that need to also append to the per-session buffer).

**Once this lands, PR #45's `dialogue_engine_transitions` + `stage6_tool_calls` sections start populating non-empty. The optimizer's signature detectors immediately get the upgraded input — no further optimizer-side changes needed.**

### 2. iOS telemetry payload extension on `DeepgramRecordingViewModel.swift`

**Status:** Not started.

**Why deferred:** Requires a TestFlight cycle (~30 min build + ~3-5 min Apple processing + user device update). Out of scope for the same-day execution window.

**What it does:** extend the payloads of four iOS-side telemetry events to include `field`, `circuit`, and `toolCallId`:
- `inflight_question_anchored` (~line 3219)
- `focused_mode_enter` (~line 3268)
- `focused_mode_enter_result` (~line 3296)
- `focused_mode_exit` (the exit_reason path nearby)

**Why all four:** without the same join keys on the exit, the analyzer cannot reliably match enter/exit pairs when entries overlap or focused-mode resets occur (Codex R4 catch in the refine log).

**Once this lands:**
- PR #45's `focused_mode_timeline.slot_field` starts populating non-null going forward (historical sessions remain null — that's correct).
- PR #46's `flux_garble_single_word` signature upgrades from unanchored substring matching to per-ask vocabulary correlation.

**How to start:** branch in the CertMateUnified repo (`~/Developer/EICR_Automation/CertMateUnified`). Search for `inflight_question_anchored` in `Sources/Recording/DeepgramRecordingViewModel.swift` — that's the anchor for all four edits. After committing, run `./deploy-testflight.sh` to ship to the Electricians group.

### 3. Backend prereq (3) PII-guard decision

**Status:** INTENTIONALLY SKIPPED. Documented here so a future session doesn't try to "complete the plan" by breaking the PII guard.

**The plan's prereq (3):** add a sanitised `value` field to `input_summary` on `record_reading` telemetry for the `value_out_of_enum_no_validator` detector.

**Why it was skipped:** Derek committed an explicit PII guard test on **2026-04-25** (`src/__tests__/stage6-dispatchers-reading.test.js:140`, commit `2bb0680f2`) that asserts "input_summary never contains `value`" for record_reading, even with structured values like `'secret-0.35'`. Breaking this test silently would violate the PII discipline rule. The plan provided a fallback ("correlate via per-turn write patches or iOS field-set events instead and rewrite the detector").

**What to do next:** design the fallback detector. Two paths:
- **(a) per-turn write patches** — the dispatchers track writes in `perTurnWrites.readings` (a `Map`). If the backend sidecar (Deferred workstream 1) also captures per-turn write summaries, the detector can read those instead of `input_summary.value`.
- **(b) iOS field_set events** — the iOS app emits `field_set` events when receiving a value. These already carry the value. Cross-reference field_set against the schema's enum to detect off-enum writes that weren't rejected.

Option (b) is lower coupling (no backend changes); option (a) gives stricter correctness (catches values rejected by iOS-side gates that never went into a field_set event).

**The Cluster 3 Item 7 stub at `analyze-session.js`'s `value_out_of_enum_no_validator.detect()` returns `false` unconditionally** until this work lands.

### 4. Probe-writer hook in `session-optimizer.sh`

**Status:** Not started. The safety-critical walker skip + one template + README all shipped in PR #46.

**What's left:** wire the writer into `session-optimizer.sh` AFTER the recommendation generation step. Pseudocode is in `scripts/probe-templates/README.md` (committed in PR #46).

**Blocker:** the writer needs each `bug_signature_hits` entry to carry a verbatim copy of the matched event's `values_snapshot` (or equivalent), so signature-specific placeholders like `{{LL_VALUE}}` + `{{LE_VALUE}}` can be substituted. Today's hit shape only carries the recommendation skeleton — extending it is a small change in `runBugSignatureDetectors()` in `analyze-session.js`.

**How to start:** branch `probe-writer-hook` from `cluster-3-signatures-and-probes` (post-merge). Two changes:
1. In `analyze-session.js`, extend the hit shape: each registry entry's `detect()` should return either `false` OR an object `{matched: true, evidence: {...}}` carrying the matched event's relevant fields. Runner spreads `evidence` into the hit.
2. In `session-optimizer.sh`, between recommendation generation and report HTML, iterate `bug_signature_hits[]`, look up each entry's `probe_template`, build a vars JSON from `evidence`, invoke `render-prompt.cjs`, write to `tests/fixtures/voice-latency-scenarios/auto-generated/<suite>/probe_<id>_<timestamp>.yaml`, and inject `generated_probe_path` back into the matching recommendation.

### 5. Pushover digest_sender + LaunchAgent

**Status:** Skeleton only. `NOTIFY_MODE` config flag committed in PR #46; default `per_session` is the only active path.

**Why not now:** explicitly dormant per Decision 3. The batched path activates "when more testers start producing sessions" — until then, the per-session notification is the better UX.

**What to build when activating:**
- `scripts/digest_sender.sh` — read-and-truncate drainer that pops everything from `~/.certmate/digest_queue.json`, formats a single Pushover message, sends, clears.
- LaunchAgent plist at `~/Library/LaunchAgents/com.certmate.digest-sender.plist` — daily/weekly cron driving `digest_sender.sh`.
- `flock` on `digest_queue.json` to prevent the session-optimizer (append-only writer) and the digest_sender (drainer) from racing on jq read-modify-write.

The atomic-swap `jq | mv .tmp` pattern is already used throughout `session-optimizer.sh` (lines ~1873, ~1906, ~1915) — same idiom.

---

## Operational notes for the next session

### Concurrent-session interference
A second Claude session was active during execution. It interrupted three times (twice stashing my WIP + switching branches, once with a stale-Read cache). The two stashes I created are now both REDUNDANT — the concurrent session has since committed equivalent changes to `fix/observation-correctness-2026-06-03` (commits `174fe21a`, `e1309936`, `703e3b41`, `b5006c37`). The `b5006c37` commit specifically captures the same files that were in both stashes (`config/prompts/sonnet_agentic_system.md`, `src/extraction/stage6-dispatcher-logger.js`, `src/extraction/stage6-dispatchers-circuit.js`).

| Stash | Branch context | Content | Action |
|---|---|---|---|
| `stash@{0}` | `cluster-2-architectural-awareness` | 2 stage6 files | Drop — superseded by `b5006c37` |
| `stash@{1}` | `fix/observation-correctness-2026-06-03` | 3 files including prompts | Drop — superseded by `b5006c37` |

```sh
git stash drop stash@{0}
git stash drop stash@{1}
```

**Belt-and-braces verification before dropping** (recommended):
```sh
# Compare each stashed file against b5006c37 + the surrounding 3 commits to
# confirm the content really did land. Should produce no surprising diffs.
git show stash@{1}:config/prompts/sonnet_agentic_system.md \
  | diff - <(git show fix/observation-correctness-2026-06-03:config/prompts/sonnet_agentic_system.md) | head
git show stash@{1}:src/extraction/stage6-dispatcher-logger.js \
  | diff - <(git show fix/observation-correctness-2026-06-03:src/extraction/stage6-dispatcher-logger.js) | head
```
Tiny differences are fine — the stash is a mid-edit snapshot, the commit is the finished version. As long as the commit's changes COVER the stashed work, dropping the stash is safe.

The rogue `d07e53be` commit I accidentally landed on the observation-correctness branch is GONE — the concurrent session reset past it before pushing. Both branches' local + remote heads match.

### Plan-doc branch (`plan/optimizer-rewrite-2026-06-03`)
The plan branch was used for the original /rp run. I committed `5e58f31a` (or similar — check `git log plan/optimizer-rewrite-2026-06-03 -3`) locking in the 15-round refinement output (refine-log, v1-v15 snapshots, conversation-context, final). The plan branch is NOT meant to merge to main — it's a reference branch for the plan doc itself.

If you ever need to update the plan, branch from `plan/optimizer-rewrite-2026-06-03` and PR back into it; never PR plan changes to main.

### Repo location reminder
The optimizer lives in `/Users/derekbeckley/Developer/EICR_Automation/` (the backend repo, NOT CertMateUnified). All four PRs target that repo's `main`. The iOS telemetry edit (Deferred workstream 2) lives in the CertMateUnified repo and ships via TestFlight, not via GitHub PR.

---

## Verification checklist for the user (post-merge)

Once all 4 PRs merge:

- [ ] `launchctl kickstart -k gui/$(id -u)/com.certmate.session-optimizer` — restart the optimizer.
- [ ] `./scripts/cleanup-harness-state.sh` — purge any harness pollution accumulated since the PR was open (no-op if state is clean).
- [ ] Force-reprocess 2-3 recent real sessions (state-file edit). Check the resulting `optimizer-reports/*.json` for:
  - [ ] No `harness_*` queue noise in the optimizer log.
  - [ ] No `:boost` tier mentions in recommendations.
  - [ ] At least one recommendation references a `dialogue-engine/` file path.
  - [ ] At least one recommendation in a new category (`dialogue_engine_schema_*`, `dispatcher_validator`, `field_name_correction_add`, `harness_probe`, etc.).
  - [ ] `bug_signature_hits` non-empty if a known shape is present (e.g. an IR session with the L-L=N + L-E=">N" pattern → `ir_bare_bridge_single_digit` should fire).
- [ ] If you want to test the walker safety net, run the smoke test from "PR #46 → Verification post-merge" above.

If any of those fail, the most likely culprit is "forgot to kickstart" — `ps aux | grep session-optimizer` to confirm the old process died.

---

## Final state — one-screen summary

| File | Status |
|---|---|
| All 4 PRs (#42, #43, #45, #46) | Pushed to GitHub, ready for review/merge |
| `cluster-1-optimizer-prompt-fixes` | Local + remote match |
| `backend-optimizer-prereqs` | Local + remote match |
| `cluster-2-architectural-awareness` | Local + remote match |
| `cluster-3-signatures-and-probes` | Local + remote match |
| `fix/observation-correctness-2026-06-03` (NOT mine) | Local + remote match; PR #44 is the concurrent session's work |
| Working tree | Clean — no uncommitted changes on any of my branches |
| Stashes | 2 mine (recoverable per the table above), 7 unrelated from prior sessions |
| Backend prereq (0) sidecar | Deferred — Deferred workstream 1 |
| Backend prereq (3) `value` field | Skipped — see PII-guard decision |
| iOS telemetry edit | Deferred — Deferred workstream 2 |
| Probe writer hook | Deferred — Deferred workstream 4 |
| Pushover digest_sender | Skeleton dormant — Deferred workstream 5 |

— End of handoff.
