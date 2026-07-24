# Execution log — Sonnet observation-tier routing (router chunk C1)

- Plan: `PLAN-final.md`
- Session: `20260724T084902Z-ep`
- Repo: `/Users/derekbeckley/Developer/EICR_Automation`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260724T084902Z-ep`
- Branch: `ep/PLAN-20260724T084902Z-ep`
- Base: `main` @ `b1e4d811`
- Started: 2026-07-24T08:49Z

## Pre-flight ref verification (against current main)
- `runShadowHarness` non-test callers = EXACTLY TWO: `src/extraction/sonnet-stream.js:4316` (prod ingress), `scripts/voice-latency-bench/transcript-replay-direct-runner.mjs:689` (bench runner). Field-replay runner reaches it via `scripts/field-replay/lib/replay-runner-core.mjs:410` using `built.buildTurnOptions` (session-builder.mjs). ✅ matches plan.
- `model: SHADOW_MODEL` at `stage6-shadow-harness.js:1222` (LIVE — change) and `:3408` (shadow-comparison — KEEP). ✅
- `SHADOW_MODEL` def `:170` (`process.env.SONNET_EXTRACT_MODEL || 'claude-sonnet-4-6'`). ✅
- `OBSERVATION_PATTERN` imported `:143` from `pre-llm-gate.js`. ✅
- `runLiveMode(session, transcriptText, regexResults, options, log)` `:568`; `transcriptText` enriched at `sonnet-stream.js:3758`; raw = `msg.text` (`:3714`). ✅
- `runToolLoop` model param `stage6-tool-loop.js:262`; round-1 override `:414-418`. ✅
- Cost tracking `stage6-shadow-harness.js:2900` `addSonnetUsage(toolLoopOut.usage, toolLoopOut.model)`. ✅
- `PINNED_FROM_TASK_DEF` `replay-environment.mjs:39` (already pins OBSERVATION_EXTRACT_MODEL:43, VOICE_LATENCY_ROUND1_MODEL:52). ✅
- Task-def `ecs/task-def-backend.json:54-55` SONNET/OBSERVATION models present; no OBSERVATION_TIER_ROUTING yet. ✅
- Replay routing snapshot test `src/__tests__/field-replay/replay-environment.test.js:31-34` asserts 3 values. ✅
- `[PLAN-SIZE]` single feature-group (the router) — NOT a large bundle; short Codex convergence expected.

---

## Steps (plan → tasks)

## Step 1 — runToolLoop model-lock option
- Status: applied
- Decision: rule 1 — verbatim per plan §"Round-1 override interaction".
- Files: src/extraction/stage6-tool-loop.js
- Commit: 65a184ff
- Notes: New `allowRound1ModelOverride` param (default true = byte-identical); gates the VOICE_LATENCY_ROUND1_MODEL override.

## Step 2 — selectedModel router in runLiveMode + telemetry
- Status: applied
- Decision: rule 1 — computed selectedModel once before runToolLoop; classify on raw `options.rawInspectorTranscript`; changed ONLY the LIVE call (`:1288`), left the `mode==='shadow'` call on SHADOW_MODEL; PII-safe `stage6.observation_tier_routing` event.
- Files: src/extraction/stage6-shadow-harness.js
- Commit: ca2e9660 (telemetry payload later trimmed to the plan's exact five fields in 2e9df987)
- Notes: Verified the two `model: SHADOW_MODEL` sites (1222→selectedModel at LIVE; 3477 kept).

## Step 3 — thread rawInspectorTranscript
- Status: applied
- Decision: rule 1 — both non-test callers (sonnet-stream.js:4316 = msg.text; transcript-replay-direct-runner.mjs:689 = transcriptText) + session-builder.mjs (HARNESS_OPTION_TABLE + buildTurnOptions = turn.transcript). grep confirmed EXACTLY two non-test callers; field-replay runner reaches it via buildTurnOptions.
- Files: src/extraction/sonnet-stream.js, scripts/voice-latency-bench/transcript-replay-direct-runner.mjs, scripts/field-replay/lib/session-builder.mjs
- Commit: c3e30b68

## Step 4 — env inventory pin + task-def
- Status: applied
- Decision: rule 1 — added OBSERVATION_TIER_ROUTING to PINNED_FROM_TASK_DEF (bumped inventory version 1→2), task-def value "false" (dark), extended routing snapshot test 3→4.
- Files: scripts/field-replay/replay-environment.mjs, ecs/task-def-backend.json, src/__tests__/field-replay/replay-environment.test.js
- Commit: bf2333bb
- Notes: The versioned inventory guard now classifies the new env read; all 10 replay-environment tests green.

## Step 5 — routing tests (unit + replay parity)
- Status: applied
- Decision: rule 1 — new stage6-observation-tier-routing.test.js (routing matrix) + session-builder.test.js replay-parity. Cycles 1-2 added: exact-shape telemetry assertion, enriched-context-cannot-escalate replay case, a HARDENED real ask_user suspend/resume test.
- Files: src/__tests__/stage6-observation-tier-routing.test.js (new), src/__tests__/field-replay/session-builder.test.js
- Commit: bc54d395 (+ 2e9df987, 7fd52aeb, 02df0ca8)

## Step 6 — docs + changelog + ledger + todo
- Status: applied
- Decision: rule 1 — architecture.md (models table + flag table + Stage-6 router note), deployment.md (flip/rollback subsection), changelog.md/CLAUDE.md/AGENTS.md rows, parity-ledger row annotated (status stays 'missing' — web cue is a separate wave), vault todo added (outside repo).
- Files: docs/reference/architecture.md, docs/reference/deployment.md, docs/reference/changelog.md, CLAUDE.md, AGENTS.md, web/docs/parity-ledger.md
- Commit: 59e5c9d4 (counts corrected in 02df0ca8)

## Step 7 — backend Jest green
- Status: applied
- Decision: rule 1 — full backend suite green (6042 passed / 19 skipped / 0 failed); eslint 0 errors (14 pre-existing warnings, none from C1); prettier drift on 5 files is PRE-EXISTING on main (scripts/ + field-replay tests are outside lint-staged's glob), not introduced here.
- Notes: Ran on Node v25 (dev box; the real gate is CI Node 20). Worktree node_modules symlinked from the main checkout (identical dep tree; no packages/ touched).

## Codex diff review

- **Cycle 1** (parallel multi-lens: wire-contract / silent-path / edge-interactions): 3 merged findings, ALL faithfulness/test-coverage (no production-logic bug — lens b "no silent-path/read-back regression", lens c "no runtime correctness defects"). (F1) telemetry payload trimmed to the plan's exact five fields → APPLIED. (F2) blocking-ask_user continuation test used record_observation not a real ask → APPLIED (see mini-review). (F3) replay enriched-context-cannot-escalate assertion missing → APPLIED. Re-gate green.
- **Mini-review (cycle-1 hunks):** confirmed the telemetry trim breaks no consumer + the exact-shape assertion is deterministic + routeModelFor refactor sound; correctly flagged that my "no test drives a real ask_user" NOTE was WRONG (stage6-audibility-invariants.test.js does) → APPLIED a proper fake-timer ask_user suspend/resume test.
- **Cycle 2:** 1 IMPORTANT (the ask test could false-pass via timeout-resume; "gate stack" comment inaccurate) → APPLIED (assert the answer emptied the registry + the ask_user_started frame emitted; dropped the gate-stack wording). 1 NIT (stale doc counts) → APPLIED (9→10 tests, 5940→6042). Re-gate green.
- **Mini-review (cycle-2 hunks):** ZERO defects — `unresolvedAnswers===0` is a sound proof the answer (not a timeout) won the race; askStartedFrames is a correct emission oracle; no new flakiness.
- **Cycle 3:** ZERO findings — "faithful, complete, and within the router-only C1 plan scope." **VERDICT: PASSED.**
- Convergence: 3 → 2 → 0. No sanctioned plan deviations (SANCTIONED_DEVIATIONS empty).

## Completed 2026-07-24T09:55:46Z

**Outcome header: ALL PASSED**

Backend-only, dark behind `OBSERVATION_TIER_ROUTING` (default OFF) → the live path is byte-identical to pre-C1 at merge. Every plan step applied (no assumed/skipped/blocked/failed). Codex diff review PASSED (3→2→0 across 3 cycles + 2 mini-reviews; no plan deviations).

**Commits (9 + this log):**
- 65a184ff feat(stage6): add allowRound1ModelOverride model-lock to runToolLoop
- ca2e9660 feat(stage6): route observation turns to Sonnet on the live path (dark)
- c3e30b68 feat(replay): thread rawInspectorTranscript to every runShadowHarness caller
- bf2333bb feat(replay): pin OBSERVATION_TIER_ROUTING in the env inventory + task-def
- bc54d395 test(stage6): observation-tier routing matrix (unit + replay parity)
- 59e5c9d4 docs(stage6): document the observation-tier router (C1) + flip/rollback
- 2e9df987 fix(ep): address Codex review cycle 1 — telemetry shape + replay coverage
- 7fd52aeb fix(ep): add real ask_user suspend/resume routing test (mini-review)
- 02df0ca8 fix(ep): address Codex review cycle 2 — ask test robustness + stale doc counts

**Files touched:** src/extraction/{stage6-tool-loop.js, stage6-shadow-harness.js, sonnet-stream.js}; scripts/field-replay/{lib/session-builder.mjs, replay-environment.mjs}; scripts/voice-latency-bench/transcript-replay-direct-runner.mjs; ecs/task-def-backend.json; src/__tests__/{stage6-observation-tier-routing.test.js (new), field-replay/session-builder.test.js, field-replay/replay-environment.test.js}; docs/reference/{architecture.md, deployment.md, changelog.md}; CLAUDE.md; AGENTS.md; web/docs/parity-ledger.md. Plus the vault todo (outside repo).

**Plan deviations:** none.

**Assumed decisions:** none.

**Skipped / blocked / failed steps:** none.

**Stashes left behind:** none.

**Tests run + result:** backend Jest — 6042 passed / 19 skipped / 0 failed. New: 10 routing unit tests + replay-parity (option-table thread, obs-fixture-routes-to-Sonnet, enriched-cannot-escalate) + replay-environment 3→4 snapshot. eslint 0 errors; prettier drift pre-existing on main (not introduced).

**Post-merge follow-ups (vault todos-certmate.md, dated 2026-07-24):** web observation-processing cue (flip prerequisite), the flag flip, P8 probes on the Sonnet-routed path, the C2 deterministic ask-gate spike (NOT /ep-ready).
