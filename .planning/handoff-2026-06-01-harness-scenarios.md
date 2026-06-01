# Handoff — Harness scenario library + cost work (2026-06-01)

**Read this entire file before starting. It is self-contained — you don't need conversation history.**

## What this session does

Pick up the work from the 2026-06-01 session that already shipped backend + iOS fixes for ~11 field-test bugs and the harness cost knobs. Three concrete deliverables:

1. **Write 14 new scenarios** that codify the bugs we found today as permanent regressions guards.
2. **Self-review + Codex-review** those 14 before committing.
3. **Have Codex write the combinatorial test matrix** Derek explicitly asked for: every dialogue script × volunteered-value-count × {single, batch-of-2, batch-of-4, all} combination.

Then stop and surface results.

---

## Repos and working directories

- **Backend (mostly all your work):** `/Users/derekbeckley/Developer/EICR_Automation`
- **iOS (CertMate):** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` — has its own `.git`
- **Web (PWA, not in this scope):** `/Users/derekbeckley/Developer/EICR_Automation/web`

Both repos auto-sync to GitHub via existing hooks; `git push origin main` works normally for both.

---

## Current state — what shipped today

### Backend (live in production via CI, deployed to ECS Fargate)

| Commit | Issue |
|---|---|
| `1f53da39` | Broadcast-intent guard on Sonnet-initiated `start_dialogue_script` |
| `eff80433` | Prompt: ambiguous address → installation + ask "use same for client?" |
| `db85f825` | Postcode lookup overrides town/county Sonnet-drift (e.g. "South East" → "Berkshire") |
| `13fb179f` | Grouped multi-circuit confirmation TTS + speculator broadcast suppression |
| `2bcee8ff` | TTS for observations / deletions / clear_reading |
| `80347fa0` | `tryEnterScriptFromWrites` calls `applyDerivations` on seeded slots (RCBO double-ask fix) + prompt clarification for "circuits 2 and 3" multi-list |
| `ec9ed4da` | **`SONNET_EXTRACT_MODEL` + `SONNET_CACHE_TTL` env vars for cheap harness runs** |

All pushed to `origin/main`; CI run `26745908926` deployed the dialogue mirror + multi-circuit prompt change. The harness commit (`ec9ed4da`) doesn't need a deploy — it's behavior-equivalent in prod unless someone sets the env vars.

### iOS — TestFlight Build 392 (LIVE for Derek)

| Commit | Issue |
|---|---|
| `006832b` | Removed pre-TTS attention tone |
| `caedff2` | `saveNow()` on observation edit/delete |
| `62cd77c` | Document-processing overlay |
| `7fba275` | AFDD blank → "N/A" retroactively |
| `978b2e2` | SwiftUI binding observation pin for voice-calc cell refresh |
| `a098b40` | New chime — 960Hz, 80ms, soft attack |
| `aed1d06` | Defensive: mark Sonnet-restated pre-existing values as voice-confirmed (was the wrong-hypothesis-but-still-real fix for Ze/PFC; see open bug below) |
| `12193b6` | **Forensic logging: `confirmation_tts_decision` client_diagnostic** |

Build 392 attached to "Electricians" group, awaiting Derek's next field test to surface the forensic event.

---

## Open bugs awaiting field-test data

**Ze/PFC TTS doesn't fire (session `83885A65`).** Derek confirmed UI was empty before dictation (not the duplicate-restate path `aed1d06` covers). Backend logs prove iOS never POSTed to `/api/proxy/elevenlabs-tts` for these turns — `audio_finalizer_timeout_fired:true`, no `loaded_barrel_hit`/`miss` events. Per-circuit confirmations in the same job worked fine. Something on iOS between `handleServerExtraction` receiving the bundler envelope and AlertManager firing the proxy POST is silently dropping board-level confirmations.

Build 392's forensic logging will name the gate. CloudWatch query for next field test:
```
filter @message like /confirmation_tts_decision/ and sessionId = "<NEW_SESSION_ID>"
```
Expected values: `skipped_mode_off | skipped_preexisting | deduped | deferred_speaking | deferred_awaiting_response | spoke_inline`. Whichever appears for ze/pfc names the bug.

**Do not start chasing this in code until the field test gives a decision.**

---

## The harness — what exists, what to add

### What exists

- `scripts/voice-latency-bench/transcript-replay.mjs` — WS-based, hits real backend. End-to-end (auth, persistence, WS protocol).
- `scripts/voice-latency-bench/transcript-replay-direct.mjs` — In-process direct, no HTTP/WS. Faster, narrower.
- `tests/fixtures/voice-latency-scenarios/` — 34 scenarios in two suites (`baseline/`, `loaded_barrel/`).
- `tests/fixtures/voice-latency-scenarios/SCHEMA.md` — **READ THIS FIRST.** Documents the YAML schema + the canonical-vs-legacy field-name conversion table. Easy to get wrong.
- `scripts/voice-latency-bench/run-cheap.sh` — wrapper that sets `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001` + `SONNET_CACHE_TTL=1h`. Wraps `transcript-replay.mjs`.
- `scripts/voice-latency-bench/HARNESS_COST_NOTES.md` — cost math + usage.

### How to run cheaply (this is non-obvious — read the doc)

The backend must be started with the same env vars or the cache key splits (model is part of the cache identity, and cache misses on every turn would defeat the win). Two-shell pattern:

```bash
# Shell 1 — backend
cd /Users/derekbeckley/Developer/EICR_Automation
SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001 SONNET_CACHE_TTL=1h npm start

# Shell 2 — harness
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline
```

Target: ~$0.02 per full 34-scenario warm run vs ~$1.70 on production defaults.

---

## Deliverable 0 — Extend the harness with the predicates these scenarios need

**The WS harness (`transcript-replay.mjs`) today only evaluates `extraction_count`, `has_reading`, `ask_user_count`, `saw_event_types`, and `audible_latency_ms_p50`** (see its assertion eval block around lines 443–520). Several scenarios below need more. Add these BEFORE writing the scenarios that depend on them, in a single small commit:

- `expect.confirmation_count: { min, max }` — count of `confirmations[]` entries across all extraction envelopes received.
- `expect.confirmation_text_contains: ["text", ...]` — assert each given substring appears in at least one confirmation's `text`.
- `expect.tts_fetch_count: { min, max }` — count of TTS proxy fetches (only meaningful when `config.fetch_tts: true`).
- `expect.ask_user: [{ field?: string, text_matches?: regex_string }]` — per-ask assertions (not just total count).
- `expect.event_ordering: [ "type_a", "type_b" ]` — assert these event types appeared in this relative order. **Note:** bundler-emit and speculator-emit are BOTH `type: extraction` on the wire — distinguishing them requires the predicate to key on `result.mid_stream_preview` (false then true). Either implement that or mark scenario #10 as manual-inspect-the-JSON.
- `expect.tts_text_not_contains: ["substring", ...]` AND `expect.confirmation_text_not_contains: ["substring", ...]` — negative-control assertions for scenarios like #13 that need to verify a string did NOT appear. Without these, you fall back to manual JSON inspection.

If any feel out of scope, mark the corresponding scenario "manual inspection: read `events[]` in the JSON output" instead and skip the new predicate.

**Scenarios D11/D12 (loaded-barrel internals)** want to assert against `voice_latency.loaded_barrel_*` and `turn_core_summary`. Those events are backend log lines, not WS messages — the WS harness can't see them, AND `transcript-replay-direct.mjs` does NOT currently capture `turn_core_summary` either. Three options in increasing order of effort:
1. **Rewrite the assertions in terms of observable tool-call behaviour** — e.g. D12 becomes "scenario triggers `start_dialogue_script` in round 1; the subsequent `extraction` envelope shows N≥2 rounds completed in `turn_core_summary` if it's emitted to the WS, OR the turn ultimately produces M tool calls indicating round 2 ran". This is the lowest-effort path.
2. **Extend `transcript-replay-direct.mjs` to capture `turn_core_summary`** and add an `expect.loaded_barrel_*` matcher. Direct runner already has `expect.loaded_barrel`; the work is wiring up the new sub-shape.
3. **Add a `--tail-cloudwatch` mode to the WS harness** that scrapes backend stderr for the relevant event types. Heaviest; only worth it if Derek wants log-assertions to be a first-class harness feature.

Default to (1) unless writing the scenarios reveals it can't actually verify what we care about.

## Deliverable 1 — The 14 scenarios to write

These codify the bugs we fixed today. Each scenario should fail on the pre-fix code and pass on `origin/main` as of this handoff.

**Critical: read `SCHEMA.md` `Field names — use LEGACY wire-format names in has_reading` section first.** Sonnet emits canonical names; the bundler rewrites to legacy before the WS send. Common mistakes:
- `measured_zs_ohm` is what Sonnet emits; the harness sees `zs`
- `ir_live_live_mohm` → `insulation_resistance_l_l`
- `rcd_time_ms` → `rcd_trip_time`

**Two more author-traps Codex review surfaced:**
- `SCHEMA.md`'s YAML example shows nested `boards[].circuits` — that is WRONG. The harness expects `job_state.boards[]` PLUS a top-level `job_state.circuits[]` (every existing scenario uses this shape). Do not nest circuits under boards.
- For board-level (circuit-0) readings like Ze/PFC, copy the field-name shape from `tests/fixtures/voice-latency-scenarios/loaded_barrel/loaded_barrel_board_reading_ze.yaml` verbatim. It asserts `field: earth_loop_impedance_ze` on `circuit: 0` despite the legacy-mapping table — that's the shape the harness actually receives because the rewrite step doesn't reach those.

### A. Dialogue-script recovery path (3 scenarios) — `tests/fixtures/voice-latency-scenarios/scripts/`

1. **`rcbo_bs_via_sonnet_write.yaml`** — Pin commit `80347fa0`.
   - Inspector says "The RCD BS number is 61008" with no script active.
   - Job has circuit 3 designated "Cooker", no prior RCD/RCBO fields.
   - Expected: Sonnet emits ONE `record_reading(rcd_bs_en="BS EN 61008", circuit=3)`. Engine `tryEnterScriptFromWrites` enters RCBO. `applyDerivations` fires, mirrors to `ocpd_bs_en`. `nextMissingSlot` walks past both. Script finishes silently.
   - Asserts: `ask_user_count: { max: 0 }`, `has_reading` includes both `rcd_bs_en="BS EN 61008"` and `ocpd_bs_en="BS EN 61008"` on circuit 3.

2. **`ir_partial_via_sonnet_write.yaml`** — Symmetric for IR.
   - "IR L-to-L 200 megohms for circuit 4."
   - Engine enters IR via Sonnet write, asks remaining slots (`ir_test_voltage_v`, `ir_live_earth_mohm` — NOT `ir_live_live_mohm` again).
   - Two follow-up transcripts: "500 volts." then "Greater than 299."
   - Asserts: 2 asks, 3 readings, none re-asking L-L.

3. **`rcd_trip_via_sonnet_write.yaml`** — Symmetric for RCD.
   - "RCD trip time 25 ms for the cooker."
   - Engine enters RCD via Sonnet write; asks for `rcd_bs_en`, `rcd_type`, `rcd_operating_current_ma`.
   - Three follow-up answers; script finishes with 4 readings.

### B. Multi-circuit / broadcast-intent (4 scenarios) — `tests/fixtures/voice-latency-scenarios/bulk/`

4. **`all_circuits_ir_broadcast.yaml`** — Pin `1f53da39`.
   - Job has 4 non-spare circuits.
   - "Insulation resistance for all circuits live to live greater than 299."
   - Expected: regex `processDialogueTurn` detects broadcast → bypasses entry. Sonnet calls `start_dialogue_script` defensively → rejected with `broadcast_intent_detected`. Sonnet retries with `set_field_for_all_circuits` → 4 readings.
   - Asserts: `has_reading` for `insulation_resistance_l_l = ">299"` on circuits 1, 2, 3, 4. ONE grouped confirmation `"All circuits, IR L to L >299"`. `ask_user_count: { max: 0 }`.

5. **`circuits_2_and_3_list.yaml`** — Pin the prompt change in `80347fa0`.
   - "Insulation L-L 200 megohms for circuits 2 and 3."
   - Expected: TWO `record_reading` calls — circuit 2 AND circuit 3. NOT one. NOT a walk-through.
   - Asserts: 2 readings exactly, no ask_user.

6. **`circuits_1_through_5_range.yaml`** — Contiguous range.
   - Job has 6 circuits; "polarity confirmed for circuits 1 through 5."
   - Expected: 5 `record_reading(polarity_confirmed)` calls; ONE grouped confirmation `"Circuits 1 to 5, polarity confirmed"`.

7. **`broadcast_then_per_circuit_override.yaml`** — Layered case.
   - Turn 1: "IR L-L for all circuits is 200 megohms" → 4 fills + grouped confirm.
   - Turn 2: "Circuit 3 IR L-L is actually 50." → overwrite on circuit 3 only.
   - Asserts: circuit 3 final value `"50"`, circuits 1/2/4 stay at `"200"`.

### C. Confirmation TTS routing (3 scenarios) — `tests/fixtures/voice-latency-scenarios/confirmation/`

8. **`ze_first_time_voice_confirmed.yaml`** — The Ze/PFC bug scaffold.
   - Empty supply (`job_state.boards[0]` has no `ze`).
   - "Ze is 0.86."
   - Expected: `record_board_reading(earth_loop_impedance_ze="0.86")`, ONE confirmation `"Ze 0.86"`, ONE `/api/proxy/elevenlabs-tts` POST.
   - Asserts (uses Deliverable 0 predicates): `saw_event_types` includes `extraction`; `expect.tts_fetch_count: { min: 1, max: 1 }`; `expect.confirmation_text_contains: ["Ze"]`. Set `config.fetch_tts: true`.
   - **NOTE:** Once Build 392's forensic logging tells us which gate is dropping this in production, encode the expected `confirmation_tts_decision` value here too.

9. **`ze_restate_existing_value.yaml`** — Pin `aed1d06`.
   - **IMPORTANT:** `aed1d06` is an iOS-side fix (`fieldSources` + `originallyPreExistingKeys` are iOS state, not backend). The WS harness cannot observe iOS state. This scenario is therefore a BACKEND-side proxy: assert that the backend emits a `confirmation` for Ze given a `job_state` that already has `boards[0].ze = "0.86"`. iOS-side regression is a manual TestFlight check, not a harness assertion.
   - `job_state` has `boards[0].ze = "0.86"`.
   - Inspector says "Ze is 0.86" (same value).
   - Asserts (Deliverable 0 predicates): `expect.confirmation_text_contains: ["Ze"]`, `expect.tts_fetch_count: { min: 1, max: 1 }`. If backend behaviour here changes (it currently emits a confirmation for board-level writes regardless of pre-existing state), update this scenario.

10. **`board_reading_bundler_vs_speculator_order.yaml`** — Document the race.
    - Single Ze reading, single circuit job (so early-terminate fires).
    - **Requires Deliverable 0's `expect.event_ordering` predicate** (the harness can't see backend log lines directly; it can only assert order of WS events received). Assert that the bundler-driven `extraction` envelope arrives BEFORE the speculator's `mid_stream_preview: true` envelope.
    - One TTS fetch only.

### D. Loaded-barrel × scripts (2 scenarios) — `tests/fixtures/voice-latency-scenarios/loaded_barrel/`

11. **`script_slot_write_no_speculator.yaml`** — Architectural assertion (the answer to Derek's "does loaded barrel break scripts?" question).
    - RCD walk-through, mid-script slot write via `applyWrite`.
    - Assert: no `voice_latency.loaded_barrel_started` event for that slot. (Scripts use `applyWrite` → only mutates `stateSnapshot` + `state.values`, not `perTurnWrites`.)

12. **`early_terminate_skips_script_round.yaml`** — Pin the early-terminate predicate.
    - Inspector triggers `start_dialogue_script` in round 1.
    - Assert: `early_terminated: false` in `turn_core_summary`, round 2 actually runs.

### E. Address / postcode (2 scenarios) — `tests/fixtures/voice-latency-scenarios/address/`

13. **`postcode_lookup_overrides_south_east_drift.yaml`** — Pin `db85f825`.
    - "Address is 12 Catherine Street Reading RG1 5QA."
    - Assert via `has_reading` on circuit 0 (board-level): `town="Reading"`, `county="Berkshire"`. Negative-control on "South East" requires the `expect.tts_text_not_contains` predicate from Deliverable 0; if you didn't ship that predicate, fall back to manually grepping the JSON output for the substring (don't assert it; the snapshot-level override is what matters, not the TTS text).

14. **`installation_address_asks_for_client.yaml`** — Pin `eff80433`.
    - "The address is 12 Catherine Street Reading RG1 5QA."
    - Assert (Deliverable 0 predicate): `expect.ask_user: [{ field: "client_address", text_matches: "Use the same address for the client" }]`. (Case-insensitive matching is up to the implementation — be explicit in the predicate.)

### Process

1. Read `SCHEMA.md` thoroughly. The legacy-field-name conversion is the #1 trap; the boards/circuits nesting note above is #2.
2. Ship Deliverable 0 first (harness predicate extensions) — one commit.
3. Write the 14 in 3 batches: A (3 dialogue), then B+C (7 broadcast+TTS), then D+E (4 architectural+address).
4. There is NO `--dry-run` flag on `transcript-replay.mjs`. Validate each YAML parses with the one-liner:
   ```bash
   node -e "const yaml=require('js-yaml');const fs=require('fs');yaml.load(fs.readFileSync(process.argv[1],'utf8'));console.log('OK:',process.argv[1])" <path>
   ```
   (Or paste into a `validate-scenarios.mjs` helper if you prefer.)
5. After each batch, run the actual scenarios against the running backend on Haiku (`run-cheap.sh`) and confirm they pass.
6. Commit each batch separately with a detailed message naming the bug each scenario pins.

---

## Deliverable 2 — Codex review of the 14 scenarios

Write all 14 (uncommitted), then run Codex on the working tree BEFORE the first batch commit so the review sees everything together:

```
mcp__codex-cli__review-changes(
  uncommitted=true,
  workingDir="/Users/derekbeckley/Developer/EICR_Automation",
  title="14 new harness scenarios — review",
  reasoningEffort="high"
)
```

Apply Codex's feedback, THEN commit in batches as described in Process step 6. If you've already committed batch A before doing Deliverable 0/1 in the order above, run `review-changes` with `base="<commit-before-batch-A>"` instead so it sees all 14 + the harness predicate extensions.

If Codex disagrees with something (e.g. it thinks a scenario should be more strict / lenient), make a judgement call and explain the call in the commit message — don't blindly apply.

---

## Deliverable 3 — Hand the combinatorial test matrix to Codex

This is the big ask. Derek wants every dialogue-script flow exhaustively covered. Use `mcp__codex-cli__ask-codex` with the existing 14 scenarios as exemplars + full context, and ask it to generate the matrix.

### The matrix

For each of the 4 dialogue scripts:
- **`insulation_resistance`** — slots: `ir_test_voltage_v`, `ir_live_live_mohm`, `ir_live_earth_mohm`
- **`rcd`** — slots: `rcd_trip_time` (`rcd_time_ms`), `rcd_bs_en`, `rcd_type`, `rcd_operating_current_ma`
- **`rcbo`** — slots: `ocpd_bs_en`, `rcd_bs_en` (mirrored), `rcd_type`, `rcd_operating_current_ma`
- **`ring_continuity`** — slots: `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm`

Cross with:
- **Entry path:** regex-detected (`/\bRCD\b/` matches the trigger) vs Sonnet-write recovery (`tryEnterScriptFromWrites`)
- **Volunteered values:** 0 (bare trigger), 1, 2, all-but-one, all (script finishes immediately)
- **Circuit scope:** single circuit, batch of 2 (list), batch of 4 (contiguous range), all circuits (broadcast)

Cell count = 4 scripts × 2 entry × 5 volunteered × 4 scope = **160 scenarios.** Some cells don't apply (e.g. "all circuits" with a script walk-through is rejected by the broadcast guard — assert THAT, don't fan out).

The realistic number Codex will produce is ~80–100 after eliminating impossible combinations.

### How to ask Codex

```
mcp__codex-cli__ask-codex(
  prompt="""[paste the prompt below verbatim]""",
  workingDir="/Users/derekbeckley/Developer/EICR_Automation",
  model="gpt-5.4",  # or whatever the default is
  reasoningEffort="xhigh",
  sandboxMode="workspace-write"
)
```

**Prompt for Codex:**

> You're generating an exhaustive matrix of harness scenarios for the EICR voice-extraction backend. Read these files first:
>
> 1. `tests/fixtures/voice-latency-scenarios/SCHEMA.md` — the YAML schema. Pay attention to the canonical-vs-legacy field name table.
> 2. `tests/fixtures/voice-latency-scenarios/baseline/rcd_walkthrough_clean.yaml` — exemplar of a script walk-through scenario.
> 3. The 14 new scenarios committed in this branch (in `scripts/`, `bulk/`, `confirmation/`, `loaded_barrel/`, `address/` subdirectories) — the patterns we want extended.
> 4. `src/extraction/dialogue-engine/schemas/{insulation_resistance,rcd,rcbo,ring_continuity}.js` — the actual slot definitions and triggers.
>
> Generate scenarios that exhaustively cover the matrix: 4 scripts × 2 entry paths × 5 volunteered-value counts × 4 circuit scopes. Skip combinations that are impossible by design (e.g. "all circuits" via `start_dialogue_script` — the broadcast guard rejects it; instead write an assertion scenario for the rejection).
>
> For each cell, produce a YAML file named `<script>_<entry>_<volunteered>_<scope>.yaml` in `tests/fixtures/voice-latency-scenarios/exhaustive/`. Use realistic transcripts modelled on the existing scenarios. Assert: the exact set of `record_reading` calls expected, the exact number of `ask_user` emissions, no extra readings, and (for batch/broadcast) the correct grouped TTS confirmation.
>
> Don't write scenarios that already exist in the 14 above — those are the seeds. Extend, don't duplicate.
>
> Validate each YAML parses with `js-yaml` before writing the next. After all files are written, print a summary of the matrix cells covered + the cells deliberately skipped (with the reason).

Apply Codex's output. Spot-check ~10 of the scenarios it generates against the schema; pull-back any that mis-name legacy fields. Commit in batches of ~20 with a clear message.

---

## Architecture notes the next session should know

### Loaded barrel does NOT directly touch dialogue scripts

The speculator hooks (`onSnapshotPatch`, `onToolUseStreamed`) filter on `record_reading` / `record_board_reading`. Dialogue-engine writes go through `helpers/snapshot-write.js` `applyWrite` which mutates `session.stateSnapshot` + `state.values` directly — NOT `perTurnWrites`. So script-internal slot fills never trigger the speculator. The bugs we found today (RCBO double-ask, multi-circuit) are pre-existing dialogue-engine bugs that got more visible because `tool_choice:any` (round-1) + heavier field testing exercise the `tryEnterScriptFromWrites` recovery path more often.

### The recovery path is where the bugs live

`tryEnterScriptFromWrites` (`src/extraction/dialogue-engine/engine.js:2176`) fires when Sonnet wrote a slot value via `record_reading` for a field that belongs to a script schema's slot list. The engine then enters the matching script to harvest remaining slots. This path bypasses the normal entry trigger AND the normal slot-write path. `80347fa0` fixed the missing `applyDerivations` call in the seed loop. Look for related bugs in similar bypass paths.

### Field-name conversion gotcha

Sonnet emits CANONICAL names (`measured_zs_ohm`, `ir_live_live_mohm`, etc.). `src/extraction/sonnet-stream.js validateAndCorrectFields` rewrites them to LEGACY wire names before the WS send (`zs`, `insulation_resistance_l_l`, etc.). The harness sees LEGACY. Backend tests sometimes assert CANONICAL because they intercept before the rewrite. Easy to mix up — `SCHEMA.md` has the full table.

### CloudWatch is the source of truth for "did the backend actually do X?"

Useful queries:
```
filter @message like /stage6_tool_call/ | parse @message /"tool":"(?<tool>[^"]+)"/ | parse @message /"outcome":"(?<outcome>[^"]+)"/ | stats count() as n by tool, outcome | sort n desc
```
```
filter @message like /confirmation_tts_decision/ and sessionId = "..."
```

Log group: `/ecs/eicr/eicr-backend`, region `eu-west-2`.

---

## Things NOT to do

- **Don't touch the speculator code** unless a scenario you write explicitly fails because of it. The speculator is fragile and well-tested; randomly tweaking it will cause prod regressions.
- **Don't change Sonnet's prompt** (`config/prompts/sonnet_extraction_system.md`) unless writing a scenario reveals a missing rule. Each prompt change re-shapes model behaviour; treat as semver-major.
- **Don't push another TestFlight** until Build 392 has been field-tested and the forensic decision is read from CloudWatch. Otherwise we lose the diagnostic signal.
- **Don't run the full Sonnet 4.6 prod-default suite for iteration** — burn it once at end-of-session as a pre-commit check. Use Haiku via `run-cheap.sh` for the loop.
- **Don't `git push --force`** ever. CI fires deploys on push to main.

---

## Useful commands

```bash
# Watch backend CI after a push
cd /Users/derekbeckley/Developer/EICR_Automation
gh run list --limit 3
gh run watch <run-id> --exit-status

# Status of ECS deploys
aws ecs describe-services --cluster eicr-cluster-production --services eicr-backend --region eu-west-2 --query "services[*].deployments[0].rolloutState" --output text

# Tail backend logs
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m

# Pull last night's session debug logs (replace user-id if needed)
aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/<SESSION_ID>/ /tmp/session/ --recursive --region eu-west-2

# Local backend on Haiku + 1h cache
SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001 SONNET_CACHE_TTL=1h npm start

# Run cheap scenario suite
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline

# iOS TestFlight
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```

---

## Order of operations for the new session

1. **Read this whole file + `SCHEMA.md` + 2-3 existing scenarios as exemplars.** ~10 min.
2. **Confirm `ec9ed4da` is on `origin/main`** and run ONE existing scenario via the wrapper to verify the cheap-config plumbing works end-to-end: `./scripts/voice-latency-bench/run-cheap.sh --scenario=tests/fixtures/voice-latency-scenarios/baseline/normal_zs_value.yaml`. (No `--dry-run` flag exists.)
3. **Ship Deliverable 0** (harness predicate extensions: `confirmation_count`, `confirmation_text_contains`, `tts_fetch_count`, `ask_user[]`, `event_ordering`). One commit.
4. **Write all 14 scenarios uncommitted.** Validate each parses via the `js-yaml` one-liner.
5. **Run `mcp__codex-cli__review-changes` with `uncommitted=true`** so it sees all 14 + the harness predicates together. Apply feedback.
6. **Commit the 14 in 3 batches** (A: 3 scripts, B+C: 7 broadcast+TTS, D+E: 4 arch+address) with detailed messages.
7. **Run the new suite on Haiku via `run-cheap.sh`.** If a scenario fails: assume authoring bug first; if evidence still points at backend after careful re-check, STOP and report to Derek before changing any extraction code. A regression guard that exposes a real miss is what this work is for — but the right response is to surface it, not silently patch around it.
8. **`mcp__codex-cli__ask-codex` with the combinatorial matrix prompt** in Deliverable 3. Sanity-check ~10 of its outputs against schema, fix any legacy-field-name or boards/circuits-nesting slip-ups, commit in batches of ~20.
9. **Run the full new + matrix suite on Haiku.** Then re-run on Sonnet 4.6 as a final sanity check. Sonnet-only failures are quirks to document in the scenario's `description`, not "fixes" to chase.
10. **Push backend `main`** (CI auto-deploys). iOS doesn't need touching in this scope. Surface the final scenario count + Codex-review summary to Derek.

If Derek's next field test happens during this work, pause to read the `confirmation_tts_decision` CloudWatch event for the Ze/PFC bug and fix that based on which gate it names. Don't dig into it speculatively.

---

## Background — issues from the 2026-05-31 field test (status)

For full context on what we fixed:

| # | Issue | Status |
|---|---|---|
| 1 | IR walk-through asks voltage + circuit despite "all circuits" | Fixed (`1f53da39`) |
| 2 | Pre-TTS chime | Fixed (`006832b`) |
| 3 | Acknowledgement chime tone | Fixed (`a098b40`, 960Hz/80ms soft attack) |
| 4 | Observation C2→C3 sync lag | Fixed (`caedff2`, `saveNow()`) |
| 5 | AFDD unticked → N/A | Fixed (`7fba275`, retroactive on render) |
| 6 | Address parsing too granular | Fixed (`db85f825`, postcode-snapshot-applier) |
| 7 | Installation address copies to client without ask | Fixed (`eff80433`, prompt) |
| 8 | TTS missing for observations / deletions / clears | Fixed (`2bcee8ff`) |
| 9 | Document upload spinner | Fixed (`62cd77c`) |
| 10 | TTS picks random circuit on batch | Fixed (`13fb179f`) |
| 11 | Zs/R1+R2 calc not redrawing cell | Fixed (`978b2e2`, SwiftUI binding pin) |
| follow-up A | RCBO BS asked twice | Fixed (`80347fa0`) |
| follow-up B | Circuits 2 and 3 → only one | Fixed (`80347fa0` prompt) |
| follow-up C | Ze/PFC no TTS | **OPEN — awaiting Build 392 forensic** |

---

## Confidence notes for the next session

- The 14 scenario plan is grounded in real bugs. Codify them and they're permanent.
- The combinatorial matrix has not been spec'd in detail; Codex will need to make judgement calls. Be willing to push back on its output if cells don't make sense.
- The Ze/PFC TTS bug is the most uncertain piece of work. Don't write a "fix" scenario for it until Build 392's forensic decision is read.

Good luck.
