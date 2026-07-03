# Execution log — parity-ws4-flux-wave-2026-07-02

**Session:** 20260703T050554Z-ep
**Started:** 2026-07-03T05:xx (see steps)
**Worktree:** /Users/derekbeckley/Developer/EICR_Automation-ep-20260703T050554Z-ep
**Branch:** ep/parity-ws4-flux-wave-20260703T050554Z-ep
**Base:** origin/main @ 27b57aac

This wave has TWO halves + a HARD Phase-0 gate:
- Half 1 (keyterm sprint): Phase 0 synthetic TTS→Flux probe (GATES everything) → Phase 1 iOS curation + web nova-3 membership/trip-time reconcile.
- Half 2 (web Flux port): buildFluxURL/Configure/EndOfTurn/batching + runtime kill-switch (DEEPGRAM_STT_MODEL) behind DEFAULT_STT_MODEL='nova3'.

Gate rules (from PLAN-final.md):
- Phase 0 inconclusive/fail → do NOT curate blind, do NOT flip web default to flux, keep PR-draft, mark WS4 PARTIAL/BLOCKED.
- iOS half requires a TestFlight build merged + VALID before flipping web to Flux default.
- So the EXPECTED first-execution outcome is: web Flux machinery built behind kill-switch, default stays nova3, WS4 PARTIAL.

---
## Step 1 (Phase 0) — synthetic TTS→Flux keyterm probe
- Status: applied (probe built + run; results captured)
- Decision: rule 1 — built net-new Node probe, ran live against flux-general-en with iOS Deepgram key + ElevenLabs Archer TTS.
- Files: phase0-flux-probe.mjs, phase0-triptime-recheck.mjs, phase0-probe-results.md (handoff folder)
- Commit: none (probe is handoff-folder tooling, not repo code)
- Outcome: PARTIAL green light. LIM = clean PASS (garble "lion" reproduced → corrected to "LIM" by equal-weight keyterm — MECHANISM VALIDATED). insulation + trip time = INCONCLUSIVE (synthetic voice too clean; documented decision-4 risk). Zero keyterm-doesn't-correct failures. Trip-time "FAIL" in pass 1 disproven as a flash-TTS "RCD"-token artifact (~11s anomalous renders).
- GATE CONSEQUENCE: per plan Phase-0 gate, an inconclusive probe is NOT a full green light. iOS curation (prune default_config.json) HELD — needs real-audio spot check + TestFlight, surfaced to Derek. Web Flux default flip HELD (DEFAULT_STT_MODEL stays nova3). Web nova-3 protections + Flux machinery-behind-kill-switch proceed ("allowed work while blocked"). WS4 → PARTIAL/BLOCKED.

## Step 2 (Phase 1 iOS curation) — HELD
- Status: skipped (blocked by Phase-0 gate; ambiguity ladder rule 3 — do not guess/curate blind)
- Decision: Phase 0 was only partially conclusive (LIM PASS; insulation+trip-time inconclusive). Plan forbids curating iOS `default_config.json` blind on inconclusive evidence; the prune also independently requires a real-audio spot check + a VALID TestFlight build, neither available autonomously.
- Files: none (iOS untouched)
- Commit: none
- Notes: SURFACED TO DEREK in phase0-probe-results.md. This is the single reason the run is PARTIAL (not ALL PASSED) → draft PR, no Flux-default flip. Follow-up: real-audio spot check → iOS prune + DeepgramServiceTests guardrails → CertMateUnified PR → TestFlight → then the web flux-default flip commit.

## Step 3 (Phase 1 web nova-3 reconcile) — applied
- Status: applied (rule 1) — ships regardless of the Flux gate (protects the nova-3 kill-switch fallback).
- Files: web/src/lib/recording/keyword-boosts.ts, web/tests/keyword-boosts.test.ts
- Commit: 02d63469
- Notes: `trip time` 1.5→2.5 (verified rank 107/120 DROPPED at 1.5 → top-~15 SURVIVES at 2.5); survival regression test; 3 stale-comment-cluster fixes.

## Step 4+5 (web Flux builder + Configure/EndOfTurn/batching) — applied
- Status: applied (rule 1)
- Files: web/src/lib/recording/deepgram-service.ts, web/src/lib/recording/keyword-boosts.ts, web/tests/deepgram-service-flux.test.ts, web/tests/keyword-boosts.test.ts
- Commit: bf83ca32
- Notes: sttModel selector (default nova3, byte-unchanged; 20/20 nova-3 tests green). buildFluxURL, TurnInfo→delegate mapping (feeds EXISTING dispatchFinal/gate/chime path — no parallel forwarder), Configure echo-validation + RTT, Error/Fatal/ConfigureFailure surfaced, 80ms batcher, KeepAlive off on Flux, equal-weight generateFluxKeyterms (PROVISIONAL curated ~40, gated off). DEFERRED (documented): full focused-answer ask_user-driven dynamic narrowing wiring in recording-context — the DeepgramService primitive (sendConfigure) exists; the lifecycle wiring is dynamic steering that only matters once Flux is live, so it moves to the flip cycle.

## Step 6 (runtime kill-switch) — applied
- Status: applied (rule 1)
- Files: web/src/lib/runtime-config.ts (new), web/src/app/runtime-config/route.ts (new), web/src/app/sw.ts, ecs/task-def-frontend.json, web/src/lib/recording-context.tsx, web/tests/{runtime-config,runtime-config-route,runtime-config-middleware}.test.ts
- Commit: fdcca905
- Notes: DEEPGRAM_STT_MODEL runtime var; /runtime-config top-level route (NOT /api/*, ALB cited); split DEFAULT vs SAFE constants; fetch once per recording session; DEFAULT stays nova3.

## Step 7 (frontend-taskdef deploy target) — applied
- Status: applied (rule 1)
- Files: .github/workflows/deploy.yml
- Commit: 391a170b
- Notes: exact single-file match (list-files:json + jq count guard); skips both builds/scans + all backend steps/migrations; registers frontend task def against existing image + rolls eicr-pwa only. YAML validated (python yaml.safe_load OK). NOT exercised live (draft PR); the plan's "one frontend-taskdef deploy-path exercise" acceptance is deferred to the real flip.

## Step 8 (gates + close-out docs) — applied
- Status: applied (rule 1)
- Files: web/audit/audio-pipeline-parity.md, web/audit/INDEX-2026-07.md, web/docs/parity-ledger.md, web/docs/parity-ledger-files.json, CLAUDE.md, docs/reference/changelog.md, parent §7 WS4 row (handoff file, not committed)
- Commit: b7afaaf9
- Gates: 1269 web tests (116 files) green; `npm run build` exit 0 (/runtime-config = Dynamic route); tsc 17 ≤ 21 baseline (zero new; CI `|| true` advisory); eslint identical baseline count 16 problems/7 errors/9 warnings — zero new (CI `|| true` advisory). Real blocking CI gates (build + tests) both green.

## Completed 2026-07-03T05:5x (autonomous /ep)

### Outcome header: PARTIAL — 1 held (iOS curation, by Phase-0 gate design) / 0 failed
This is the EXPECTED first-execution outcome the plan describes: the two hard gates (Phase-0 full-green + iOS TestFlight) are unmet, so web Flux is built behind the runtime kill-switch with DEFAULT_STT_MODEL='nova3', PR-draft, WS4 PARTIAL/BLOCKED. Nothing failed; the single non-applied step (iOS curation) is a deliberate gate-driven HOLD, surfaced to Derek.

### Commits made (branch ep/parity-ws4-flux-wave-20260703T050554Z-ep, off origin/main @27b57aac)
- 02d63469 fix(web/recording): bump nova-3 "trip time" keyterm to 2.5 + stale-comment fixes
- bf83ca32 feat(web/recording): Deepgram Flux (/v2/listen) path behind an STT-model selector
- fdcca905 feat(web/recording): runtime STT kill-switch (DEEPGRAM_STT_MODEL) + wire Flux into recording-context
- 391a170b ci(deploy): frontend-taskdef-only deploy target for the kill-switch flip
- b7afaaf9 docs(parity): WS4 close-out — Flux-behind-kill-switch + PARTIAL/BLOCKED

### Assumed decisions (sanity-check these)
- [ASSUMED] The single Secrets-Manager `DEEPGRAM_API_KEY` IS the iOS Deepgram key used for the probe (only one Deepgram key exists in `eicr/api-keys`). Single obvious interpretation.
- [ASSUMED] Deferred the ask_user-driven focused-answer dynamic keyterm narrowing wiring in recording-context to the flip cycle (the DeepgramService `sendConfigure` primitive is implemented + tested). Rationale: it is dynamic steering that only affects the live Flux path, touches the shared recording-context ask_user lifecycle heavily, and Flux is off this session. Logged as a WS4 follow-up.

### Skipped / held steps + what's needed to finish
- iOS `default_config.json` prune + `DeepgramServiceTests` guardrails — HELD on the Phase-0 gate. Needs: (1) a real-audio spot check of insulation→"insurance" and trip time→"tryptoid" through the same two-session probe; (2) the iOS prune + guardrails; (3) a CertMateUnified PR + VALID TestFlight build. THEN the web flux-default flip (one DEFAULT_STT_MODEL + task-def commit).

### Tests run + result
- Full web suite: 116 files, 1269 tests PASS. Build: exit 0. Typecheck/lint: at main baseline (zero new).

### Deploy
- DEPLOY SKIPPED — gate not ALL PASSED (iOS curation held by design). Draft PR per /ep + the plan's explicit "keep PR-draft only while blocked". No ECS/TestFlight this session. The web changes are safe to merge whenever Derek chooses (default nova3 = current live behaviour); the flux-default flip is a separate future commit after the gates clear.
