# Loaded Barrel — overnight execution results (2026-05-24)

**Status:** All backend phases shipped + deployed to production with
flag OFF. iOS Phase 4a build uploading to TestFlight at handoff time.
Loaded Barrel is fully wired end-to-end; only Derek-gated steps
remain (TestFlight install, readiness probe verification, flag flip).

**Started:** 2026-05-23 ~23:30 UTC (Derek went to bed after `/goal`
authorising "execute full plan end-to-end regardless").
**Finished:** 2026-05-24 ~02:00 UTC.
**Plan:** `loaded-barrel-final/LOADED_BARREL_PLAN_FINAL.md` (v10, 0
BLOCKERs, both reviewers SHIP).

---

## What shipped

### Backend (`EICR_Automation`) — 13 commits on `main`, CI deploy 26347727371 GREEN

| # | Commit | Phase |
|---|---|---|
| 1 | `68c13b4` | Phase 1.A — ELEVENLABS_RATE_PER_CHAR 0.00003 → 0.00005 |
| 2 | `dab5413` | Phase 1.C — tts-text-expander.js (39 rules, EXPANDER_VERSION='2026-05-24', 85 parity tests) |
| 3 | `401e586` | Phase 1.B — confirmation-text.js leaf + bundler emits `board_id` on confirmations |
| 4 | `0928570` | Phase 1.D+E — telemetry SERVER_OUTCOMES (12 new), KNOWN_SOURCES, VOICE_LATENCY_LOADED_BARREL + MAX_PER_TURN flags + cost-tracker speculative sub-ledger |
| 5 | `88bf337` | Phase 1.F — readiness probe endpoint `/api/voice-latency/loaded-barrel-readiness` |
| 6 | `819feb8` | Phase 2.A — loaded-barrel-cache (state machine, slot-keyed, LRU=20/200, TTL=15s) |
| 7 | `9a79812` | Phase 2.C — runToolLoop onSnapshotPatch + onLoopComplete hooks + diff helpers |
| 8 | `082cb01` | Phase 2.B — loaded-barrel-speculator (diff-driven, per-turn cap=2, cost ledger) |
| 9 | `178b70c` | Phase 3 — keys.js cache short-circuit (HIT / HIT_PENDING / HIT_LATE / MISS, 200ms timer-race with re-peek) |
| 10 | `c910242` | wire-up — runLiveMode instantiates per-session speculator, threads hooks |
| 11 | `aee8577` | Phase 5 — state-machine fuzz (1000 seeds × 4 invariants) |
| 12 | `ebb8fe2` | Phase 6 — 7 harness scenarios under `tests/fixtures/voice-latency-scenarios/loaded_barrel/` |
| 13 | `8f0a487` | Phase 4a backend half — bundler emits `result.turn_id` for iOS round-trip |

**Tests:** 3740/3743 backend tests passing (3 skipped pre-existing).
**Live task-def envs (verified via `aws ecs describe-task-definition`):**
- `VOICE_LATENCY_LOADED_BARREL=false` (OFF — flag flip is Derek's call)
- `VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN=2`

### iOS (`CertMateUnified`) — 1 commit on `main`, TestFlight build 366

| # | Commit | Phase |
|---|---|---|
| 1 | `81c5a6d` | Phase 4a — turnId + boardId pass-through (ValueConfirmation decode, RollingExtractionResult.turnId, APIClient.proxyElevenLabsTTS slot tuple, AlertManager.LoadedBarrelTTSContext, ServiceProtocols overload) |

Bench-harness branch (`voice-latency-stage0-bench`) fast-forward
merged into main with this commit. `deploy-testflight.sh` running
in background at handoff write time — output at
`/tmp/testflight-deploy.log`. Last seen step: `🔨 Archiving...`.

---

## Architecture (one-pager for tomorrow)

```
Inspector dictates → Deepgram transcript → Sonnet (Stage 6 tool loop)
                                                          │
                                                          ▼
                              ┌───────────────────────────────────┐
                              │ runToolLoop dispatcher loop       │
                              │ (stage6-tool-loop.js)             │
                              │  on each tool_use:                │
                              │    1. snapshot perTurnWrites      │
                              │    2. dispatch tool               │
                              │    3. diff perTurnWrites          │
                              │    4. emit onSnapshotPatch ──────┐│
                              └──────────────────────────────────│┘
                                                                 ▼
                              ┌───────────────────────────────────┐
                              │ Speculator (loaded-barrel-spec*)  │
                              │  on patch.readings.added:         │
                              │    - buildConfirmationText (same  │
                              │      helper bundler will use)     │
                              │    - expandForTTS (mirror of iOS  │
                              │      AlertManager.expandForTTS)   │
                              │    - mint correlationId           │
                              │    - openElevenLabsStreamClient   │
                              │      (MP3, single-shot, AbortCtrl)│
                              │    - cacheSet pending entry       │
                              │    - on synth complete:           │
                              │       markReady CAS → resolve     │
                              │  on patch.cleared/removed/        │
                              │     overwritten:                   │
                              │    - invalidateBySlot             │
                              │  on patch.boardOps[add_board]:    │
                              │    - pruneSessionUnboardedEntries │
                              │  on patch.boardOps[select_board]: │
                              │    - pruneMismatchedBoardEntries  │
                              └───────────────────────────────────┘

Meanwhile iOS receives extraction envelope:
  result.turn_id        (Phase 4a backend → iOS)
  result.confirmations[]={text, field, circuit, board_id}

iOS speaks confirmation:
  AlertManager.speakBriefConfirmation(text, loadedBarrelContext={
    turnId: result.turn_id,
    boardId: conf.board_id,
    field: conf.field,
    circuit: conf.circuit
  })
  → APIClient.proxyElevenLabsTTS(text, sessionId, turnId, boardId, field, circuit)
  → POST /api/proxy/elevenlabs-tts {text, sessionId, turnId, boardId, field, circuit}
                                          │
                                          ▼
  Backend keys.js short-circuit (cache HIT path):
    cacheKey = sha1(sessionId+turnId+boardId+field+circuit+text)
    cached = peek(cacheKey)
    if cached.state === 'ready':
      claim() → CAS ready→claimed → serve MP3 + audio/mpeg
                                  + X-Voice-Latency-Source: loaded_barrel_hit
                                  + promoteSpeculativeToCanonical
    elif cached.state === 'pending':
      await Promise.race(spec.promise, 200ms timer-with-re-peek)
        → spec/spec_late winner → claim + serve
      timer wins → markSuperseded + fall through to live
    else:
      MISS → fall through to live ElevenLabs synth (existing path)
```

---

## To enable the feature

### Step 1 — wait for TestFlight install

The deploy script automatically attaches build 366 to the "Electricians"
external group. Derek's iPad will receive the auto-update notification.
After install, Derek's iOS sends turnId + boardId + field + circuit
in every confirmation POST.

### Step 2 — verify readiness adoption ≥80%

```bash
# Mint a JWT first (manual — RDS is VPC-only so I can't from local Mac).
# The harness JWT pattern is in scripts/voice-latency-bench/transcript-replay.mjs
# OR: log into the app on iOS, copy the auth token from the network log.

curl -H "Authorization: Bearer $TOKEN" \
  https://api.certmate.uk/api/voice-latency/loaded-barrel-readiness | jq

# Expected after Derek has used the new build for ~10 minutes:
# {
#   "windowMs": 3600000,
#   "totalClients": 1,
#   "totalPosts": N,
#   "postsWithTurnId": N,
#   "adoptionPct": 100,
#   "clients": [{"userId": "derek...", ...}]
# }
```

If `adoptionPct >= 80`: proceed to Step 3.
If `adoptionPct < 80`: wait for more inspector activity OR debug why
iOS isn't sending turnId. CloudWatch:
```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m \
  --filter-pattern "voice_latency.startup_log"
# Confirms session_start saw flag VOICE_LATENCY_LOADED_BARREL in
# the snapshot + capabilities (older iOS without 4a still has
# voice_latency.version=0 in the snapshot).
```

### Step 3 — flip the flag

```bash
# Edit ecs/task-def-backend.json: VOICE_LATENCY_LOADED_BARREL "false" → "true"
cd /Users/derekbeckley/Developer/EICR_Automation
sed -i '' 's/"VOICE_LATENCY_LOADED_BARREL",        "value": "false"/"VOICE_LATENCY_LOADED_BARREL",        "value": "true"/' ecs/task-def-backend.json
git commit -am "feat(voice-latency): Loaded Barrel — flip flag ON after Phase 4a adoption ≥80%"
git push origin main
gh run watch --exit-status
```

After deploy completes:
```bash
aws ecs describe-task-definition --task-definition eicr-backend --region eu-west-2 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`VOICE_LATENCY_LOADED_BARREL`]' \
  --output table
# Confirms LOADED_BARREL=true.
```

### Step 4 — observe HIT rate via CloudWatch

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h \
  --filter-pattern "loaded_barrel_hit OR loaded_barrel_miss" | head -30

# Per plan v10 §D, expected steady-state mix:
#   ~70% HIT/HIT_PENDING/HIT_LATE
#   ~20% MISS (TTL expired before iOS POSTed, or speculator didn't
#         fire due to per-turn cap=2)
#   ~5%  WASTED (invalidated by clear/overwrite)
#   ~3%  TIMEOUT_FALLTHROUGH (200ms timer fired before synth ready)
#   ~2%  TTL_EXPIRY / CAP_SKIPPED

# If HIT rate < 50% sustained over 1h: ROLLBACK per plan §D criterion.
```

### Step 5 — roll back if needed

```bash
# Live kill switch via env (5-min ECS rollout):
sed -i '' 's/"VOICE_LATENCY_LOADED_BARREL",        "value": "true"/"VOICE_LATENCY_LOADED_BARREL",        "value": "false"/' ecs/task-def-backend.json
git commit -am "fix(voice-latency): Loaded Barrel — rollback after HIT rate < 50%"
git push origin main
# OR if absolutely urgent: aws ecs update-service... env override
# (but that's against the MANDATORY infra-from-source rule)
```

---

## What's NOT done (Derek-gated or future-sprint)

1. **iOS install + readiness verification** — Derek's iPad needs to
   download build 366 via TestFlight. Walk through Step 1+2 above.
2. **Flag flip** — gated on Step 2 passing. Mechanical (Step 3).
3. **Live harness baseline run** — RDS is in a VPC and I couldn't mint
   a valid JWT (placeholder userId=1 won't pass `getUserById`). Run
   harness manually after Derek mints a real JWT — pattern in
   `scripts/voice-latency-bench/transcript-replay.mjs`.
4. **Drift detector** — Phase 5 stub in speculator's `onLoopComplete`.
   Plan v10 expects a future commit that compares speculator-predicted
   text vs bundler-final text and emits `loaded_barrel_text_drift_detected`.
   Today the speculator + bundler BOTH call `buildConfirmationText`
   from the same leaf module (`confirmation-text.js`) so drift is
   structurally impossible — the detector is defence against future
   divergence, not a live signal.
5. **Phase 4b iOS** — `x-expand-version` header +
   `Bundle.expandForTTSVersion` resource for parity-mismatch detection.
   Plan v10 §C splits 4b out specifically because 4a is enough to
   enable HIT path.
6. **Multi-round Sonnet latency** — Loaded Barrel saves ~470ms on the
   final synth step. It does NOT shrink Sonnet's 3-round agentic loop
   (~3.5s). The 2-2.5s audible target is hit on:
   - Stage 4 regex-fast-path turns (already shipped, 420ms — single-
     value regex-recognised dictations)
   - Loaded Barrel single-round turns (~1.8-2.0s — uncommon)
   It's NOT hit on multi-round Sonnet turns. Plan v10 §E explicitly
   defers that to a separate prompt-side sprint.

---

## Test surface added (for future regression coverage)

| File | Assertions | Phase |
|---|---|---|
| `src/__tests__/tts-text-expander-parity.test.js` | 85 | 1.C |
| `src/__tests__/confirmation-text.test.js` | 15 | 1.B |
| `src/__tests__/stage6-event-bundler.test.js` (extended) | 5 new | 1.B + 4a |
| `src/__tests__/loaded-barrel-readiness.test.js` | 11 | 1.F |
| `src/__tests__/cost-tracker.test.js` (extended) | 7 new | 1.D extra |
| `src/__tests__/voice-latency-config.test.js` (extended) | 5 new | 1.E |
| `src/__tests__/voice-latency-telemetry.test.js` (extended) | 1 new | 1.D |
| `src/__tests__/loaded-barrel-cache.test.js` | 26 | 2.A |
| `src/__tests__/stage6-tool-loop-loaded-barrel-hooks.test.js` | 14 | 2.C |
| `src/__tests__/loaded-barrel-speculator.test.js` | 16 | 2.B |
| `src/__tests__/loaded-barrel-keys-route.test.js` | 6 | 3 |
| `src/__tests__/loaded-barrel-state-machine-fuzz.test.js` | 4 (× 1000 seeds = 4000) | 5 |
| `tests/fixtures/voice-latency-scenarios/loaded_barrel/*.yaml` | 7 scenarios | 6 |

---

## Open questions / decisions for Derek

1. **Phase 4b iOS** — ship now (after 4a adoption) or defer until field
   testing of 4a shows a real drift issue? Plan v10 §C orders 4b after
   100% ramp; safe to defer.
2. **Per-turn cap=2** — first field test will show whether 2 is right
   or too restrictive. Adjustable via `VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN`
   env (no source commit needed — it's the only Loaded Barrel tunable
   that's not snapshotted).
3. **TTL=15s** — vs plan v9's earlier 2s. v10 §F1 bumped because iOS
   can defer TTS up to 8s. If TTL_EXPIRY rate is high in production,
   we may need to bump higher.
4. **iOS 4a adoption gate (80%)** — single-user deployment means
   Derek's iPad alone determines adoption. Effectively a binary
   "Derek's iPad is on build 366 or not." Flag flip can happen as
   soon as readiness probe confirms his iPad's POSTs include turnId.

---

## How to reproduce my work from scratch

```bash
# Backend:
cd /Users/derekbeckley/Developer/EICR_Automation
git log --oneline 09dffd2..8f0a487  # all 13 Loaded Barrel commits
npm test  # 3740 passing

# iOS:
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
git log --oneline 12bc9e2..81c5a6d  # bench commit + Phase 4a
xcodebuild -scheme CertMateUnified -destination 'generic/platform=iOS Simulator' build  # SUCCEEDS
```

---

## Author

- Backend + iOS execution: Claude Opus 4.7 overnight session.
- Plan: 9-round Claude-Plan + Codex-gpt-5.5 review chain (see
  `loaded-barrel-final/REVIEW_HISTORY.md`).
- Goal as set by Derek: "execute loaded barrel plan, deploy and
  test with Harness to simulate transcripts to test it works
  correctly" — first two delivered; harness deferred to manual
  step after JWT mint.
