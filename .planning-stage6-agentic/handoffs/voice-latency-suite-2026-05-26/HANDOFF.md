# Voice-Latency Suite — Session Handoff

**Date:** 2026-05-26
**Author:** Claude Opus 4.7 (1M)
**Status:** Phase 1 of test-suite work in progress (3 of 10 scenarios drafted, not yet committed)
**Resume in:** A fresh Claude conversation with full context budget

---

## Why this handoff exists

Today's session shipped 7 backend commits + 2 iOS commits, diagnosed two
substantial bugs (one iOS, one backend), and started a curated
regression test suite for the voice-latency pipeline. We ran out of
context mid-Phase 1. This document captures **every load-bearing
finding, every code location, every open question** so the next
session can resume without re-discovering anything.

The next session will be reviewed by Codex (separate AI) to verify
nothing is missed. **Codex review checklist at the bottom.**

---

## Section A — Code that landed today (verify still in place)

### Backend (`EICR_Automation`, branch `main`)

| Commit | Subject | What it does |
|---|---|---|
| `b6075e59` | fix(dialogue-engine): hand value-bearing utterances to Sonnet when entry parser misses | When a dialogue-engine trigger matches but no value harvests AND utterance has number+unit, returns `{handled: false}` so Sonnet processes the utterance. New `hasNumericValueWithUnit()` helper + `tryEnterScriptFromWrites()` post-dispatch hook re-enters the script once Sonnet writes a slot-owned value. |
| `9590cea2` | fix(dialogue-engine): resolve field aliases in tryEnterScriptFromWrites | `FIELD_CORRECTIONS` extracted to `src/extraction/field-name-corrections.js`. Hook now accepts `fieldAliases` param and resolves both Sonnet's canonical name (e.g. `rcd_time_ms`) AND the schema slot name (e.g. `rcd_trip_time`). |
| `61e43df4` | feat(voice-latency): tool_choice:{type:"any"} on round-1 to suppress Sonnet preamble | `runToolLoop` passes `tool_choice: { type: "any" }` on round-1 only, forcing Sonnet to emit tool_use first (no reasoning preamble). Loaded Barrel hit rate jumped from <20% to 71%. Flag-flippable via `VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1`. |
| `a63f1d4c` | fix: ask_user validator + raise Loaded Barrel cap | Validator coerces `undefined → null` for `context_field` / `context_circuit` so Sonnet's recovery asks don't crash. Loaded Barrel cap raised 2→12 in `ecs/task-def-backend.json` to fix bulk-apply MISSes. |
| `32659f83` | chore: trigger CI deploy of a63f1d4c | Empty commit — GitHub Actions outage swallowed the initial push trigger; this re-fired via `push` event. |

**Backend live state:** `eicr-backend:230` on ECS Fargate (eu-west-2).
Confirm with:
```
aws ecs describe-services --cluster eicr-cluster-production \
  --services eicr-backend --region eu-west-2 \
  --query "services[*].{Status:deployments[0].rolloutState,TaskDef:deployments[0].taskDefinition}" \
  --output table
```

### iOS (`CertMateUnified`, branch `main`)

| Commit | Subject | What it does |
|---|---|---|
| `182acc2` | feat(voice-latency): iOS bundler-emit playback-ack | After `audioPlayer?.play()` succeeds on ElevenLabs TTS, posts to `/api/voice-latency/playback-ack` with `source: "bundler"`. Gated on `loadedBarrelContext.turnId != nil`. Lets backend `turn_audio_summary` finalizer measure end-to-end user→audible latency. |
| `1ed186e` | feat(voice-latency): wire iOS regex-fast-tts trigger | In `DeepgramRecordingViewModel.handleFinalTranscript`, after `applyRegexMatches()`, call `TranscriptFieldMatcher.matchFastPathCandidate()`. On hit → `markFastPathPending` → `APIClient.regexFastTTS` → `playFastPathAudio` (fire-and-forget Task). |
| `07d9acf` | feat(ws): disconnect-reason telemetry | New `disconnect(reason:)` overload on `ServerWebSocketService` fires `client_diagnostic` with category `disconnect_intent` BEFORE teardown. `didCloseWith` captures closeCode+reason into instance fields, surfaced as `previous_disconnect` on the NEXT successful reconnect. |

**iOS live state:** TestFlight Build 375, attached to Electricians
group, in beta review at time of handoff. Public link:
https://testflight.apple.com/join/W2dBKTSc.

### Other notable iOS commits today (NOT mine — landed in parallel)
- `a2e02cd` feat(tts): drop address-family suppression — confirm every value
- `0aa85e4` feat(recording): remove auto Zs/R1+R2 derivation; require explicit voice command
- `5695ada` fix(normaliser): skip digit-word conversion before a circuit designation
- `294ca96` fix(ios-ui): centre CCU shutter vertically on trailing edge

### Backend follow-on commits NOT investigated this session
- `58ee9ce9` feat(dialogue-engine): port end-of-loop confirmation from legacy ring script
- `e1ae2913` feat(sonnet-prompt): confirmations now cover every value + include circuit designation
- `b588b6d1` feat(ring-continuity): end-of-loop confirmation with overwrite-on-amend

These landed AFTER my voice-latency work and may interact with the
scenarios I'm writing — **the next session should glance through their
diffs to confirm no scenario expectations break**.

---

## Section B — Open problems (priority order)

### 1. iOS silent-ask AlertManager queue stall ⚠ HIGHEST PRIORITY

**Symptom:** Session `065BDA7F` (2026-05-26 16:14–16:16 UTC). 4 asks
were enqueued (4× `question_enqueued` client_diagnostic rows), but
only 1 actually played through the speaker (1× `inflight_anchored`).
Subsequent 3 asks — including 2× "Which circuit is the Zs of 0.6 for?"
— silently never played. User had no idea the system was asking
anything and gave up at 16:16:54 ("session_stopped").

**What we know:**
- The first ask ("Should I use this address for the client too?") at
  16:14:38 played correctly (`inflight_anchored` fired,
  `userFinishedToTtsMs: 4803`).
- After that ask resolved (user said "Y" at 16:14:43), Sonnet emitted
  "Updated" + "Updated address to 14 Banana Avenue" +
  "What's the client's name?" in rapid succession.
- Backend logged `ElevenLabs TTS success` for the FIRST few but iOS
  emitted **zero `inflight_anchored`** for any of them.
- Zero `tts_playback_deferred`, zero `tts_deferred_dropped`, zero
  `tts_audioplayer_failed`, zero `previous_disconnect`. The alerts
  are stuck in iOS's queue BEFORE the TTS-fetch step.

**Hypothesis:** `AlertManager.processNextAlert` is not re-firing
after the first alert resolves. Either `isTTSSpeaking` doesn't reset
to false, `isAwaitingResponse` lingers, or a deferred-TTS replay
slot is full and blocking the queue. Cannot pin without iOS-side
instrumentation around the state machine.

**Recommended fix:** instrument first, fix second.
1. Add `client_diagnostic` emits at every AlertManager state
   transition: `alert_dequeued_for_synthesis`,
   `alert_play_started`, `alert_play_finished`, `alert_dismissed`,
   `isTTSSpeaking_flipped`, `isAwaitingResponse_cleared`,
   `defer_gate_blocked`, `queue_drained`.
2. Ship to TestFlight as Build 376.
3. Next field session will tell us exactly which gate is stuck.
4. Then fix the gate logic.

**Tracked as task #10** (carry into next session).

**Why not in current scope:** needs another TestFlight cycle to
diagnose. Also separable from the test-suite work — backend replay
won't expose this; it's an iOS-only state-machine bug.

---

### 2. Bundler `bundler_emitted_count: 0` despite `readings_count: 1`

**Symptom:** Session 065BDA7F turn-6 at 16:16:38. Sonnet wrote
`record_reading {field: measured_zs_ohm, circuit: 1, value: 0.6}`
correctly (visible in `stage6_tool_call` log). `Field corrected`
mapped to `zs`. But `voice_latency.turn_core_summary` showed
`bundler_emitted_count: 0` — meaning the confirmation TTS was
NEVER emitted by the bundler.

**Hypothesis:** Either:
- The fast-path slot state was `.fastPending` from an earlier
  attempt and the bundler confirmation got queued behind it then
  discarded on `.fastPlayed`.
- A speculator preflight skip fired (e.g.
  `loaded_barrel_skipped_fast_tts_hint`).
- The reading didn't pass the bundler's confirmation eligibility
  filter (`shouldGenerateConfirmation` requires
  `confidence >= CONFIRMATION_MIN_CONFIDENCE` and field-in-friendly-
  names).

**Action:** trace the bundler suppression for this exact turn. Code
to read:
- `src/extraction/stage6-event-bundler.js` (the bundler)
- `src/extraction/confirmation-text.js` (`shouldGenerateConfirmation`)
- `src/extraction/loaded-barrel-speculator.js:319`
  (`loaded_barrel_skipped_fast_tts_hint`)

Pull the full session 065BDA7F log slice for 16:16:35-16:16:45 and
look for skip-emit signals.

**Note:** This bug is INDEPENDENT of the iOS silent-ask. Even if iOS
had played the bundler confirmation, there was no bundler
confirmation TO play because the backend never emitted one. Two
distinct issues stacked.

---

### 3. Phase 1 test scenarios (7 remaining of 10)

**Done (drafted, NOT committed):**
- `tests/fixtures/voice-latency-scenarios/baseline/zs_without_circuit.yaml`
- `tests/fixtures/voice-latency-scenarios/baseline/value_correction.yaml`
- `tests/fixtures/voice-latency-scenarios/baseline/rcd_walkthrough_clean.yaml`

**To write (in priority order):**

4. **`rcd_garbled_trigger.yaml`** — Pins commits `b6075e59` and
   `9590cea2` from today. Transcript: `"RCD triptan for upstairs
   lighting is 25 ms."` (Deepgram garble: "trip time" → "triptan").
   Expected:
   - Engine entry-handover bail: `stage6.rcd_script_entry_handover_to_sonnet` log fires.
   - Sonnet's `record_reading` writes `rcd_trip_time=25` for circuit 2.
   - `tryEnterScriptFromWrites` enters RCD script
     (`stage6.rcd_script_entered_from_sonnet_write` log), resolving
     `rcd_time_ms → rcd_trip_time` via the FIELD_CORRECTIONS alias.
   - Subsequent turns walk BS/type/mA same as the clean variant.

5. **`ir_walkthrough.yaml`** — IR L-L, L-E, voltage all extracted.
   Transcript: "Insulation resistance for the cooker, live to live
   299 megaohms. Live to earth 250 megaohms. 500 volts." Expected:
   3 readings on circuit 1 (ir_live_live_mohm,
   ir_live_earth_mohm, ir_test_voltage_v).

6. **`ring_continuity_full.yaml`** — r1, rn, r2 → r1_plus_r2 derived.
   Multi-turn walk-through. Expected: 4 readings (3 ring values +
   r1_plus_r2 calculated server-side).

7. **`designation_disambiguation.yaml`** — CCU stamped 3 circuits
   with identical "Sockets" label. Inspector says "Zs for sockets is
   0.4". Engine emits disambiguation ask quoting all three refs.
   Inspector answers "the kitchen one" → designation match within
   the 3-candidate set resolves uniquely.

8. **`chitchat_recovery_ask.yaml`** — Pins commit `a63f1d4c` validator
   fix. Transcript: random off-topic chitchat utterance (sanitised
   version of session 1B496E8A turn-2). Expected: Sonnet emits a
   recovery `ask_user` with `context_field=null` /
   `context_circuit=null` (BOTH omitted from input). Validator must
   NOT reject — pre-fix would have returned `invalid_context_circuit`.

9. **`bulk_ir_all_circuits.yaml`** — Pins today's cap-raise (2→12).
   Transcript: "Insulation resistance live to live for all circuits
   is 299 megaohms." With 9 circuits in the schedule. Expected:
   9× `loaded_barrel_started` outcomes (NOT 2 with 7
   `loaded_barrel_cap_skipped`), and 9 readings written. Each gets
   a chance to land as `loaded_barrel_hit` rather than MISS.

10. **`out_of_range_zs.yaml`** — Inspector says "Zs is 22.8" (out of
    range — typical EICR Zs is < 1.5). Expected: auto-divide path
    kicks in (`CircuitDerivations.clampImpedance`), value coerces
    to 2.28 OR Sonnet asks for confirmation. Assert one of the two
    paths fires deterministically.

**Format anchors:**
- Match the existing scenarios in `tests/fixtures/voice-latency-scenarios/baseline/`.
- Schema: `tests/fixtures/voice-latency-scenarios/SCHEMA.md`.
- Existing variety to mimic for multi-turn: `rcd_walkthrough_clean.yaml` (mine, drafted),
  `bulk_polarity_confirm.yaml` (single-turn bulk).

---

### 4. Phase 2 — Diagnostic report mode

**Goal:** extend `scripts/voice-latency-bench/transcript-replay.mjs`
output so a single run produces:

- Per-scenario PASS/FAIL with the specific failing assertion called
  out.
- Per-scenario latency breakdown (Sonnet `stream_ms`, ElevenLabs RTT
  on `/api/proxy/elevenlabs-tts`, end-to-end user-finished →
  audible-first-byte if `fetch_tts: true`).
- Per-scenario cost ($Sonnet from `cost_update` events + ElevenLabs
  bytes × rate).
- Aggregate report card across the whole suite.
- Markdown table output to a file path so I can diff vs a baseline.

**Suggested implementation:**
1. Add `--report=md` flag to `transcript-replay.mjs`.
2. Collect timing+cost+assertion data per scenario.
3. Render a single markdown table with columns:
   `name | pass | ask_count | readings | tts_p50_ms | sonnet_ms | $ | failing_assertion`.
4. Write to `--output-report=path.md` if set.
5. Document the rendered shape in `scripts/voice-latency-bench/REPORT_SCHEMA.md`.

**Helper to add:** baseline-comparison mode. Read a prior report,
compare cell-by-cell, emit a delta table highlighting regressions
(latency up, asks count up, readings down).

**Estimated effort:** ~2-3 hours focused work.

---

### 5. Phase 3 — Stretch scenarios (5 multi-turn flows)

After Phase 1 + 2 land:

- `sub_board_creation.yaml` — `add_board` with parent + feed
  circuit + sub-main cable spec.
- `observation_with_photo.yaml` — observation captured during a
  recording, photo attached.
- `phone_call_recovery.yaml` — recording interrupted by phone call,
  resumes cleanly (today's known-good baseline; pinned by
  existing `phone_call_gap_recovery.yaml` but the multi-turn
  resume is wider).
- `doze_wake_transition.yaml` — Deepgram doze entry then SileroVAD
  wake; tests the ring-buffer replay.
- `full_cert_end_to_end.yaml` — start → address → CCU + circuits →
  readings on every circuit → 1 observation → finish. The widest
  workflow scenario.

Each of these is heavier than Phase 1 — multi-turn, more setup,
more assertions. ~30-60 min each.

---

## Section C — Things I confirmed but didn't fully fix this session

### Bulk-apply `loaded_barrel_miss` (partially mitigated)

Today's Loaded Barrel cap raise (2→12) addresses MOST of the 38
MISSes in the morning audit. The cap raise alone is a temporary
mitigation. The cleaner fix — left for future work — is
**bulk-apply summarising**: when `set_field_for_all_circuits` writes
N readings, the bundler should emit ONE summary TTS ("R1 plus R2
set to 0.5 for circuits 1 through 9") instead of N individual
confirmations. That eliminates the cap problem entirely and saves
~$0.10 per bulk-apply on ElevenLabs cost.

**Code location:** `src/extraction/stage6-event-bundler.js`
synthesises confirmations from `perTurnWrites.readings`. The
bundler can detect bulk-write shape via `result.circuit_updates`
or via inspecting whether the same field+value appears for ≥3
circuits.

### Loaded Barrel hit rate (good improvement, more possible)

Morning audit: <20% hit rate. After today's tool_choice fix:
71%. The remaining ~29% `hit_pending` cases mean ElevenLabs synth
hadn't finished when iOS asked. Two levers to push higher:

1. **Pre-warm ElevenLabs voice** at session start with a common
   confirmation phrase to populate the per-voice TTS hot cache.
2. **Prefill Sonnet's response** with the literal `<tool_use>`
   opening token to shave another 100-300ms off TTFB.

Both nice-to-have, not on the critical path.

### Disconnect telemetry needs a field-test cycle

iOS `07d9acf` ships `disconnect_intent` + `previous_disconnect`.
Next field session will produce the first telemetry — until then
we don't know the breakdown. Watch for:
- `disconnect_intent reason: "user_stop"` immediately before
  "SonnetStream connection closed" (clean exits).
- `previous_disconnect closeCode: ...` on reconnect (abnormal
  closures).
- Closures with NEITHER preceded nor followed — process death
  (app killed / crashed).

---

## Section D — Filesystem map for the next session

```
/Users/derekbeckley/Developer/EICR_Automation/
├── src/extraction/
│   ├── dialogue-engine/
│   │   ├── engine.js                      ← tryEnterScriptFromWrites, runEntry bail
│   │   ├── index.js                       ← schema registry
│   │   └── schemas/rcd.js                 ← RCD walkthrough definition
│   ├── stage6-tool-loop.js                ← runToolLoop, toolChoiceAnyOnRound1
│   ├── stage6-shadow-harness.js           ← runs runToolLoop, wires hooks
│   ├── stage6-event-bundler.js            ← bundler emits confirmations
│   ├── stage6-dispatch-validation.js      ← validateAskUser (today's fix)
│   ├── confirmation-text.js               ← shouldGenerateConfirmation
│   ├── loaded-barrel-speculator.js        ← speculator + onToolUseStreamed hook
│   ├── voice-latency-config.js            ← env flag readers
│   ├── voice-latency-turn-summary.js      ← turn_core_summary + audio_summary emitters
│   ├── field-name-corrections.js          ← FIELD_CORRECTIONS (extracted today)
│   └── sonnet-stream.js                   ← validateAndCorrectFields, runShadowHarness call site
├── src/routes/
│   ├── voice-latency-fast-tts.js          ← regex fast-tts route (capability-gated)
│   ├── voice-latency-bench.js             ← STAGE0_BENCH-gated bench surface
│   ├── voice-latency-playback-ack.js      ← Phase 0 ACK endpoint
│   └── keys.js                            ← TTS proxy with Loaded Barrel cache short-circuit
├── ecs/task-def-backend.json              ← VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN=12
├── scripts/voice-latency-bench/
│   ├── transcript-replay.mjs              ← THE REPLAY HARNESS (563 lines)
│   ├── transcript-replay-direct.mjs       ← direct-call variant
│   ├── run-harness-against-prod.sh        ← prod wrapper
│   └── *-bench.mjs                        ← ElevenLabs + Sonnet TTFB micro-benches
├── tests/fixtures/voice-latency-scenarios/
│   ├── SCHEMA.md                          ← YAML schema doc
│   ├── baseline/                          ← 22 existing baseline scenarios
│   │   ├── zs_without_circuit.yaml        ← MINE, drafted, not committed
│   │   ├── value_correction.yaml          ← MINE, drafted, not committed
│   │   ├── rcd_walkthrough_clean.yaml     ← MINE, drafted, not committed
│   │   └── … 22 existing
│   └── loaded_barrel/                     ← 7 existing speculator scenarios
└── CertMateUnified/                       ← iOS sub-repo
    └── Sources/
        ├── Recording/
        │   ├── DeepgramRecordingViewModel.swift  ← fast-tts wire, handleFinalTranscript
        │   ├── AlertManager.swift                ← THE QUEUE-STALL CULPRIT (task #10)
        │   └── TranscriptFieldMatcher.swift      ← matchFastPathCandidate (strict pattern)
        ├── Services/
        │   ├── ServerWebSocketService.swift      ← disconnect(reason:) overload
        │   ├── ServerWebSocketServiceProtocol.swift
        │   └── ServiceProtocols.swift            ← AlertManagerProtocol surface
        └── Tests/CertMateUnifiedTests/Mocks/
            └── MockServerWebSocketService.swift
```

---

## Section E — Resume protocol for the next session

1. **First message to the fresh Claude:** "Read
   `.planning-stage6-agentic/handoffs/voice-latency-suite-2026-05-26/HANDOFF.md`
   and tell me which task to start with. Codex has reviewed this
   handoff — check `CODEX_REVIEW.md` in the same directory for any
   gaps to fix before starting."

2. **Recommended start order:**
   - Glance through the `58ee9ce9`, `e1ae2913`, `b588b6d1` ring-
     continuity confirmation work (Section A bottom) — confirm my
     drafted `ring_continuity_full.yaml` plan still matches reality.
   - Commit the 3 drafted scenarios first to lock in progress.
   - Write `rcd_garbled_trigger.yaml` next — highest value (pins
     today's commits as regression guards).
   - Then Phase 1 scenarios 5-10 in order.
   - Then Phase 2 (diagnostic report mode).
   - Then Phase 3 (stretch scenarios) OR pivot to iOS silent-ask
     diagnosis (task #10) if a field session has happened since.

3. **Critical environment context:**
   - User project root: `/Users/derekbeckley/Developer/EICR_Automation`
   - iOS sub-repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
   - Backend deploy: push to `main` triggers GitHub Actions CI →
     ECS. ~30 min from push to live.
   - iOS deploy: `./deploy-testflight.sh` in
     `CertMateUnified/`. ~15-25 min to TestFlight + Apple beta
     review.
   - Don't use the local `./deploy.sh` for backend — Docker Desktop
     isn't running on the dev Mac; the script silently fails as
     exit 0 via `tee`.

4. **Active session IDs for log archaeology:**
   - `065BDA7F-9220-48F8-BDC5-786C9380BED6` — 2026-05-26 16:14-16:16,
     the silent-ask + Zs failure session
   - `1B496E8A-F62B-4754-B064-F8AED744721F` — 2026-05-26 11:44-11:47,
     the chitchat validator-disconnect session (now fixed)
   - `33E6613D-49A7-4B42-A73B-1E2C6A82174D` — 2026-05-26 10:25+,
     the 76-turn long-stable session (the cap_skipped bulk-apply
     repro)
   - `904344CD-E254-4E5E-89F6-C1CF0E4B9E4E` — 2026-05-26 09:17,
     the bundler-ACK first-look + first turn_choice trace
   - `87856B72-F920-4E12-AC09-68334CCD0ABC` — 2026-05-26 06:06,
     the original "RCD triptan… 25 ms" repro

5. **Run the harness against prod for a single scenario as a smoke
   check FIRST** before writing new ones — confirms the
   infrastructure works after the day's changes:
   ```
   cd /Users/derekbeckley/Developer/EICR_Automation
   bash scripts/voice-latency-bench/run-harness-against-prod.sh \
     --scenario=tests/fixtures/voice-latency-scenarios/baseline/normal_zs_value.yaml
   ```
   If that fails, EITHER the harness has rotted OR today's commits
   broke a primary path — investigate before writing new scenarios.

---

## Section F — Codex review checklist

The next session should run Codex over this handoff with the
following prompts:

1. **"Have I missed any commits from 2026-05-26 that touch the
   voice-latency or dialogue-engine code paths?"** Reference the
   commit table in Section A. Codex should `git log --since="2026-05-26 00:00"`
   on both repos and diff against the table.

2. **"Are the YAML scenarios I drafted in
   `tests/fixtures/voice-latency-scenarios/baseline/` (zs_without_circuit,
   value_correction, rcd_walkthrough_clean) correctly formatted
   against `SCHEMA.md`?"** Codex should validate against the
   schema and check the assertion shapes match
   `transcript-replay.mjs`'s expectations.

3. **"Is the iOS silent-ask diagnosis in Section B sufficient, or
   am I missing a code path that could explain it?"** Codex should
   read `AlertManager.swift` and inspect every place that toggles
   `isTTSSpeaking`, `isAwaitingResponse`, and `fastPathSlotStates`.
   Look for race conditions, missing reset paths, deferred-TTS
   blockers.

4. **"Is the bundler_emitted_count: 0 diagnosis in Section B
   complete?"** Codex should read `stage6-event-bundler.js` +
   `confirmation-text.js` and identify EVERY suppression path
   between `record_reading` dispatch and `confirmations[]`
   emission. Report any I missed.

5. **"Is the Phase 1 scenario list (10 items) the right
   coverage?"** Codex should compare against:
   - Recent CloudWatch sessions (last 7 days, look for repeated
     failure modes).
   - Existing scenarios in `tests/fixtures/voice-latency-scenarios/baseline/`
     (don't duplicate coverage).
   - The IET BS 7671 regulations for EICR testing — the workflows
     I picked should match real inspector dictation patterns.

6. **"Should any task be re-prioritised?"** Section B lists
   tasks in my judgment order; Codex may have different
   priorities given a broader codebase view. Specifically:
   - Is iOS silent-ask higher than backend bundler suppression?
   - Should Phase 1 scenarios go ahead of fixing the silent-ask?
   - Is the `bundler_emitted_count: 0` issue actually a regression
     from the Loaded Barrel work, in which case rolling back the
     tool_choice change should be considered (it would not be
     necessary if regex-fast-tts handles enough cases)?

7. **"Are there environmental landmines I haven't flagged?"**
   - GitHub Actions had an outage today (still in monitoring
     state at handoff). May still be flaky tomorrow.
   - CertMateUnified deploy bumps Info.plist build number
     without auto-committing — drift between source tree and
     TestFlight is expected.
   - Codex should add anything I missed.

Save the review output as
`.planning-stage6-agentic/handoffs/voice-latency-suite-2026-05-26/CODEX_REVIEW.md`.

---

## Section G — Task list for the fresh session

```
#10 [pending] Diagnose iOS silent-ask: AlertManager queue stall
#11 [in_progress] Phase 1: Write 10 curated EICR-workflow scenarios (3/10 done)
#12 [pending] Phase 2: Diagnostic report mode for transcript-replay.mjs
#13 [pending] Phase 3: Write 5 stretch scenarios (multi-turn workflows)
```

Plus the auto-discovered task to investigate:
- **#14** [pending] Investigate `bundler_emitted_count: 0` on session
  065BDA7F turn-6 — separate from #10's silent-ask defect.

---

## Section H — Don't forget

- The 3 drafted YAML scenarios in
  `tests/fixtures/voice-latency-scenarios/baseline/` ARE UNCOMMITTED.
  Commit them as soon as the next session opens to lock in progress.
- The harness already auths via JWT — the next session needs to
  arrange a token. `run-harness-against-prod.sh` handles this; check
  its top for the auth flow.
- Real harness runs against prod cost real money (Sonnet + ElevenLabs).
  Each scenario is ~$0.05-0.20. A 10-scenario run is ~$1-2. Budget
  accordingly — if the harness work spans many iterations, consider
  adding a local-backend mode that uses test API keys.
- iOS Build 375 should clear beta review within ~24h of upload
  (12:30 BST 2026-05-26). If it hasn't by next session, that's a
  separate blocker — Apple sometimes takes longer.
