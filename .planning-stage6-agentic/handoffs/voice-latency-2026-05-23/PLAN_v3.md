# Voice Latency Sprint — PLAN_v3.md (reconciled, second pass)

**Date:** 2026-05-23
**Supersedes:** `PLAN_v2.md` (which superseded `PLAN.md`)
**Reconciles:** `claude-review-v2.md` (1 NEW BLOCKER / 4 NEW IMPORTANT / 3 NEW NIT) + `codex-review-v2.md` (1 NEW BLOCKER / 5 NEW IMPORTANT / 2 NEW NIT) + Derek's request to add an autonomous transcript-replay test regime.
**Resume rule:** this is the executable plan. Do not start coding until Derek approves.

---

## 0. What changed vs PLAN_v2

Two independent v2 reviews each caught a fresh **BLOCKER** that v2 introduced. Both were verifiable directly against the codebase — both confirmed.

Headline:

1. **Claude v2 NB1 — `field_corrected` wire-shape mismatch (BLOCKER fixed).** PLAN_v2 §4.5 emitted camelCase `{previousValue, newValue: null}`. iOS decoder `CertMateUnified/Sources/Services/Stage6Messages.swift:147` is **explicit**: `case previousValue = "previous_value"` — snake_case wire. iOS would silently `decodeIfPresent` to `nil`. Stage 3's `previousValue` invalidation contract would fire against nil every time. Pinned the wire shape in this revision to `{"type": "field_corrected", "circuit": <int>, "field": <string>, "previous_value": <string|null>, "reason": <"clear_reading"|"same_turn_correction"|"replace_value">}`. New contract round-trip test in commit 1.6 fixture.
2. **Codex v2 NB1 — iOS Alamofire `.responseData` buffers whole MP3 (BLOCKER fixed).** `APIClient.swift:846 proxyElevenLabsTTS` uses Alamofire `.responseData` at lines 855 + 873. That accumulates the entire response body before completion. `StreamingAudioPlayer.ingest()` has nothing to receive chunks from. v3 adds **iOS commit 1.7a — replace `.responseData` with `URLSessionDataDelegate.urlSession(_:dataTask:didReceive:)`** (or Alamofire `DataStreamRequest` if we keep Alamofire) so the bytes deliver incrementally.
3. **Stage 0.G — autonomous transcript-replay test regime added per Derek's request.** New Stage 0.G builds a Node harness `scripts/voice-latency-bench/transcript-replay.js` + scenario library in `tests/fixtures/voice-latency-scenarios/*.yaml`. Backend-only changes can be E2E-tested without rebuilding iOS. iOS playback changes still need a build, but scenarios validate end-to-end behaviour deterministically.
4. **Claude v2 NI1 — MP3 decoder is not a one-commit deliverable.** `AVAudioConverter` doesn't accept raw MP3 chunks directly; needs Core Audio `AudioFileStreamOpen`/`AudioFileStreamParseBytes` callbacks OR a third-party lib. v3 STRONGLY RECOMMENDS prototyping `pcm_22050` first in Stage 0.A — sidesteps MP3 decode entirely; `AVAudioPlayerNode` accepts raw PCM natively. PCM is now the **default Stage 2 output format**; MP3 only if Stage 0.D shows PCM-over-WS quality is unacceptable.
5. **Claude v2 NI3 — §0/§5 prose contradicted §2 arithmetic.** PLAN_v2 §5 claimed Stage 2 warm = 1.2–1.5 s, which is wrong; arithmetic gives ~2.2 s. Sonnet TTFT dominates Stage 2 regardless of pool warmth. Fixed throughout. **Stage 2 is honestly framed as scaffolding for Stage 4**, not a headline latency win.
6. **Codex v2 NI1 — timing constants were guesses.** v3 marks every constant explicitly as `[stage0_tunable: X]` and Stage 0 measures the right thing for each.
7. **Codex v2 NI3 — Stage 0.F under-scoped.** Raised from half-day to **one full day**. Operational pass criteria spelled out concretely (per-context audio frame routing, two-context interleaving, close-one-context survival, audio-frame correlation tagging shape).
8. **Codex v2 NI4 — Stage 1 became a foundation mini-sprint.** Split into Stage 1a (backend protocol — flags + capability + field_corrected + telemetry-server-side) and Stage 1b (iOS — source field + streaming HTTP client + ack messaging + telemetry-iOS-side). Each has independent verification gate.
9. **Codex v2 NI5 — streaming cost accounting unspecified.** New commit 3.8 explicitly handles cost-tracker streaming semantics (charge on text-sent, not on isFinal/ack).
10. **Claude v2 NI2 — 5 AlertManager call sites not 3.** v3 enumerates exact call sites with line numbers; extends `TTSSource` enum to include `.notification` for `speakCriticalNotification`.
11. **Codex v2 PARTIAL B2 (no monotonic turnId/audioSeq lane).** Added explicit per-session `audioSeq` monotonic counter on iOS side; AlertManager queue drops audio with stale seq. Codex's residual concern about "sent_to_client can't truly cancel iOS audio already delivered" is acknowledged in §16 row 1 as honest residual — iOS will hear the first audio to completion, then drop subsequent stale audio.
12. **Codex v2 PARTIAL B3 (Sonnet future-ambiguity).** Honestly accepted as residual risk. PLAN_v3 §7.2 step 4 now explicitly documents this case: fast-path may speak before Sonnet emits ask_user. Mitigations: (a) Sonnet's later ask_user becomes a *correction-class* TTS via existing correction class path, (b) telemetry tracks `fast_then_ask_user_emerged` count. Field-test driven; broaden iOS regex confidence threshold above 0.85 if rate too high.
13. **Codex v2 N4 — `desiredCount` not in `ecs/`.** Verified: ECS task definitions don't carry desired count; that's on the service. v3 §12 cites the AWS service-config not source. Updated to honest "single-instance via AWS-console-configured service desired count" with documented note.
14. **Codex v2 NN1 — `synthesising` transition not wired in §5.2.** Fixed in §5.2 state-transition list.
15. **Codex v2 NN2 — `fast_heard` wording overloaded.** Renamed iOS outcome to `playback_completed` with source metadata; `fast_heard` retained as the aggregate metric (server outcome + iOS ack reconciled in analyser).

What did NOT change:

- Locked scope (4 in-scope items).
- Silent fallback on failure.
- Voice consistency (same voice ID + settings).
- Codex during planning AND review.
- iOS Strategy C playback architecture (StreamingAudioPlayer + AVAudioEngine + AVAudioPlayerNode).
- Stage 0 measurement-before-code discipline.

---

## 1. Locked decisions (additive vs PLAN_v2 §1)

Carry forward all 13 PLAN_v2 §1 decisions, plus:

| # | Decision | Source |
|---|---|---|
| 1.14 | **Default ElevenLabs output format is `pcm_22050`**, NOT `mp3_22050_32`. Sidesteps MP3-frame-parsing in Swift. `AVAudioPlayerNode.scheduleBuffer` accepts raw PCM natively. MP3 only if Stage 0.D shows PCM quality unacceptable. | Claude v2 NI1 |
| 1.15 | **All timing constants are Stage-0-tunable.** Every duration in this plan carries `[stage0: <gate>]` annotation showing which Stage 0 gate justifies / overrides the number. | Codex v2 NI1 |
| 1.16 | **Stage 0.G transcript-replay harness ships with the foundation.** Backend-only changes get E2E coverage without iOS rebuild for the lifetime of the sprint. | Derek 2026-05-23 |
| 1.17 | **`field_corrected` wire shape: snake_case keys, decoder-compatible.** Exact shape: `{"type": "field_corrected", "circuit": <int>, "field": <string>, "previous_value": <string\|null>, "reason": "clear_reading"\|"same_turn_correction"\|"replace_value"}`. Verified against `Stage6Messages.swift:138-165`. | Claude v2 NB1 |
| 1.18 | **iOS playback ack outcome is `playback_completed`** (with `source` metadata). `fast_heard` is the aggregate iOS-acked-server-emitted metric, computed by the analyser. | Codex v2 NN2 |
| 1.19 | **BT route change: detection only, no prevention.** iOS logs `AVAudioSession.routeChangeNotification` events as telemetry hops. Stage 4 field test covers 4 routes (built-in / AirPods / BT headset / wired). If field data shows route-change UX problems, fix in a follow-up sprint. | Derek 2026-05-23 (Q8 resolved) |
| 1.20 | **iOS regex confidence floor: 0.85 (Strategy B).** Fast-path accepts regex hits at confidence ≥ 0.85. Telemetry tracks `fast_then_ask_user_emerged` count. If field-test rate > 5%, raise floor to 0.95 in a follow-up — but DO NOT pre-tighten. Strategy A (start at 0.95) explicitly rejected. | Derek 2026-05-23 (Q9 resolved) |
| 1.21 | **Stage 4 is CONDITIONAL — assess after Stage 3 ships.** Run Stages 0 + 1 + 2 + 3 first. Field-test the Stage 2 warm/cold P50 audible latency in real cert sessions. If "good enough" (Derek's subjective judgement based on inspector use), defer Stage 4 to a future sprint OR cancel. The regex-fast path is structurally faster than the Sonnet path by ~1 s (because Sonnet's TTFT + tool_use finalisation has an irreducible ~1.5–2 s floor), but the Stage 2+3 latency may be acceptable enough that Stage 4's engineering cost (race resolution, fast-eligibility, transcript-context anchoring) isn't justified. **Decision gate: end of Stage 3, before Stage 4 commits begin.** | Derek 2026-05-23 |

---

## 2. Latency budget — honest, post-review

### Today (measured 2026-05-23)

| Step | P50 (ms) |
|---|---|
| Utterance-final → iOS regex applied | ~40 |
| Backend → Sonnet round-trip (cached, incl. tool_use finalisation) | ~1,800–2,200 |
| iOS POST → backend → ElevenLabs HTTP batch synthesis | ~700–1,300 |
| iOS receives full MP3 → `AVAudioPlayer.play()` | ~80 |
| **Total audible (today, P50)** | **~2,700–3,700 ms** |

### Stage 2 — stream confirmations only (NO fast-path; pool only if 0.F)

| Step | First-byte (ms) | First-audible (ms) |
|---|---|---|
| Utterance-final → iOS regex applied | ~40 | ~40 |
| iOS WS → backend → Sonnet round-trip (cached) | ~1,800–2,200 | ~1,800–2,200 |
| `buildConfirmationText` | ~30 | ~30 |
| iOS POST → backend opens ElevenLabs WS | ~80 | ~80 |
| ElevenLabs BOS handshake (cold) | ~800 | ~800 |
| ElevenLabs first audio frame (PCM, no encode) | ~120–200 | ~120–200 |
| iOS HTTP chunk received → StreamingAudioPlayer | ~30 | ~30 |
| iOS first PCM frame scheduled → `dataPlayedBack` | n/a | ~50 |
| **Total cold (P50)** | **~2,900–3,380** | **~2,950–3,430** |

| Step | Warm (Stage 0.F passed) |
|---|---|
| As above through Sonnet | ~1,800–2,200 |
| ElevenLabs BOS handshake | **~0 (amortised)** |
| First audio + iOS → playback | ~200–280 |
| **Total warm (P50)** | **~2,000–2,510** |

**Stage 2 alone is a marginal latency win** (3.0 s → ~2.5 s warm). Its value is to **land the streaming TTS machinery and suppression infrastructure for Stage 4 to leverage.** Headlining Stage 2 as a meaningful UX improvement is dishonest; this revision frames it accurately.

### Stage 4 — regex-fast path (the real win)

| Step | Cold (ms) | Warm (ms) |
|---|---|---|
| Utterance-final → iOS regex applied | ~40 | ~40 |
| iOS POST `/api/voice-latency/regex-fast-tts` | ~50 | ~50 |
| Backend eligibility + reservation | ~30 | ~30 |
| ElevenLabs BOS handshake | ~800 | ~0 |
| First audio frame (PCM) | ~120–200 | ~120–200 |
| Backend chunked HTTP → iOS StreamingAudioPlayer | ~30 | ~30 |
| iOS first PCM frame → `dataPlayedBack` | ~50 | ~50 |
| **Total (P50)** | **~1,120–1,200** | **~320–400** |

**Headline target `<700 ms` is achievable WARM ONLY** (Stage 0.F passes + multi-context endpoint usable). Cold-only path is ~1.2 s — still a ~60% improvement over today.

---

## 3. Stage 0 — Measurement gates (six gates, now plus 0.G the harness)

### 3.A iOS StreamingAudioPlayer feasibility (PCM-first, MP3 fallback)

**Change from PLAN_v2:** PCM is now the primary path. MP3 is the contingency.

**Method (PCM path):**
1. Branch `voice-latency-stage0-bench` on `CertMateUnified`.
2. Stage 0 throwaway endpoint `POST /api/test/elevenlabs-pcm-stream` (gated by `STAGE0_BENCH=1`, removed at end of Stage 0).
3. iOS test harness: `StreamingAudioPlayer` constructed for `AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 22050, channels: 1, interleaved: true)`. PCM chunks arriving over chunked HTTP → packed into `AVAudioPCMBuffer` → `playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack)`.
4. Measure `first_chunk_received → first_pcm_frame_scheduled → dataPlayedBack`.
5. Devices: iPhone 17 Pro + iPad Air. Networks: Wi-Fi + 4G. Routes: built-in, AirPods, BT headset, wired.

**Pass criteria (PCM):** P50 `first_chunk_received → dataPlayedBack` ≤ 100 ms (PCM has no decode step, so this should be tighter than MP3's 200 ms target).

**If PCM passes:** Lock 1.5 PCM as Stage 2+4 output format.

**If PCM fails OR Derek hears audible quality issues vs current MP3 confirmations:** Fall back to MP3 path. The MP3 path requires:
- `AudioFileStreamOpen` + `AudioFileStreamParseBytes` callbacks for chunked MP3 parsing (Core Audio C-level). Listed as a separate sub-commit (commit 2.1a — frame parser; 2.1b — playback wiring). Estimated 2–3 days vs PCM's <1 day.
- OR evaluate FreeStreamer (https://github.com/muhku/FreeStreamer) or StreamingKit (https://github.com/tumtumtum/StreamingKit) — open-source iOS libraries that handle chunked MP3 well. Single-day integration vs 2–3 day from-scratch. Adds dep risk.

**Output:** `STAGE0_RESULTS_PLAYBACK.md` with PCM verdict + (if needed) MP3 plan.

### 3.B Anthropic Sonnet 4.6 TTFT in production config

**Pass criteria:** P50 cached TTFT ≤ 900 ms `[stage0_tunable: this becomes the lower bound on Sonnet-dependent latency budgets]`.
**Also measure (Codex v2 NI1):** p99 Sonnet-completion (TTFT + finalisation) — this number becomes the `[stage0: derive from B]` suppression TTL.

### 3.C ElevenLabs `stream-input` TTFB from eu-west-2

Unchanged from PLAN_v2.

### 3.D Voice fidelity A/B (Turbo v2.5 vs Flash v2.5 — AND PCM vs MP3)

**Extended from PLAN_v2:** also compares `pcm_22050` vs `mp3_22050_32` output formats. Derek listens to ~10 representative confirmation strings × 2 models × 2 formats = 40 samples.

**Pass criteria:** Derek confirms PCM is acceptably close to MP3 OR explicitly chooses MP3 + accepts the 2–3 day MP3-parser implementation cost.

### 3.E iOS chunked-HTTP throughput

Unchanged.

### 3.F ElevenLabs `multi-stream-input` evaluation (raised to full day)

**Changes from PLAN_v2:**
- Allocated **one full day** (was half-day; Codex v2 NI3).
- Operational pass criteria spelled out concretely:

**Pass criteria:**
1. Per-context BOS amortisation: open ONE WS, initialise context A, send text, receive audio frames tagged with `context_id: A`. Synthesis succeeds.
2. Concurrent contexts: initialise context A AND context B in same WS. Send text for both. Audio frames arrive correctly tagged with their respective `context_id`. No untagged frames.
3. Per-context finality: context A reaches `isFinal` independently of context B's progress.
4. Context closure: close context A explicitly. Context B continues to synthesise. WS does not die.
5. Eviction protocol: documented (LRU? bounded? plan for it).
6. Voice continuity within a context: A's two consecutive synth requests sound identical (voice settings carry over). N/A if WS only carries one synth per context — escalate via fall-back design.
7. Failure handling: text submitted to context after `isFinal` returns documented error, doesn't close WS.

**Fail action:** Stage 4 ships with one-shot WS per synth (PLAN_v2 §7.5 fallback). Pool removed entirely. P50 stays cold ~1.2 s. Document in §13 exit criteria honestly.

**Output:** `STAGE0_RESULTS_MULTI_CONTEXT.md`.

### 3.G NEW — Transcript-replay harness (Derek's request)

**Goal:** automate end-to-end voice-latency testing without rebuilding iOS for every backend change.

**Method:**
1. New module `scripts/voice-latency-bench/transcript-replay.js`:
   - Connects to backend session WS as if it were iOS.
   - Sends `session_start` with capability handshake.
   - Replays a scenario file: a YAML/JSON list of `transcript` messages with timing offsets.
   - Captures every backend response event (extraction, ask_user, confirmations, voice_latency events).
   - Downloads any HTTP-chunked TTS audio responses (via the chunked-HTTP path Stage 2 introduces) and saves as MP3/PCM files for manual A/B listen.
   - Asserts expectations declared in the scenario file.
2. Scenario library `tests/fixtures/voice-latency-scenarios/`:
   - YAML schema documented in `SCHEMA.md`.
   - Each scenario file = one test case.
3. Initial scenario set (~15 cases):
   - `normal_number_of_points.yaml` — single regex hit, Stage 4 happy path.
   - `normal_zs.yaml`.
   - `normal_r1_r2.yaml`.
   - `normal_polarity_confirmed.yaml`.
   - `normal_iso_test.yaml` — uses `ir_live_live_mohm` / `ir_live_earth_mohm` (canonical names verified against `field_schema.json`).
   - `normal_ze_pfc.yaml` — installation-scope test.
   - **`flux_misrecognition_socket_one.yaml`** — the original Derek bug. Inspector says "circuit 1"; Flux emits BOTH `circuit 1` AND `Socket 1.` finals 1 ms apart. Assert: ONLY one TTS plays; second utterance is suppressed.
   - **`flux_misrecognition_second.yaml`** — "second 1" → "circuit 1" coercion.
   - **`flux_duplicate_finals.yaml`** — 1ms-apart duplicates (from session C082FCAB log).
   - **`multi_candidate_rejection.yaml`** — one utterance triggers regex for two fields. Assert fast-path REJECTS.
   - **`pending_ask_no_fast_confirm.yaml`** — regex hit while ask_user pending. Assert fast-path REJECTS.
   - **`correction_class_tts.yaml`** — "no, make that 17". Assert correction-class TTS plays AND prior suppression is invalidated.
   - **`chitchat_no_engagement.yaml`** — irrelevant chatter. Assert no TTS, no Sonnet calls beyond chitchat-pause threshold.
   - **`burst_dictation.yaml`** — 10 reads in 30 seconds. Assert all 10 confirmations queue + play in order.
   - **`adversarial_unicode.yaml`** — Unicode + escapes in field values (rare but possible). Assert correct canonical-value normalisation.
   - **`race_r1_sonnet_vs_fast.yaml`** — race fixture with deterministic timing. Assert deterministic resolution.
4. CI integration: every scenario runs in CI on every backend PR. Backend regressions caught before merge.
5. Field-bug capture flow: when Derek sees a bug in production, dump the session's transcript stream (already in `session-analytics/.../debug_log.jsonl`) to YAML and add as a new scenario. Bug never regresses silently.

**Implementation surface:**
- `transcript-replay.js` (~300 lines).
- YAML scenarios + JSON Schema for scenario files.
- New `npm run voice-test` script in root `package.json`.
- New CI job `voice-latency-scenarios` in `.github/workflows/`.

**Pass criteria:** harness can run all 15 initial scenarios against staging backend; reports pass/fail with per-hop latency stats; total runtime < 5 minutes.

**Output:** `STAGE0_RESULTS_TRANSCRIPT_HARNESS.md` — sample run + 15 scenario results + CI integration.

---

## 4. Stage 1 — Foundation, split into 1a (backend protocol) and 1b (iOS protocol)

Per Codex v2 NI4, Stage 1 was an unmanageable mini-sprint. Now split. Each half has its own verification gate before Stage 2 can land.

### 4.1 Telemetry framework

Unchanged from PLAN_v2 §4.1. Server-side and iOS-side modules. Hops: `utterance_final, regex_match, ios_ws_send, ios_http_post_send, backend_recv, eligibility_decision, suppression_decision, reservation_acquired, vendor_ws_open, vendor_first_audio, vendor_isFinal, ios_first_chunk_recv, ios_first_pcm_frame_scheduled, ios_dataPlayedBack, ios_playback_complete`.

Outcome enum — server: `synth_started, synth_first_byte, synth_complete, synth_failed, sent_to_client, cancelled, suppressed_before_synth, suppressed_after_synth`. iOS: `playback_completed (with source metadata), dropped_stale, dropped_by_correlation_id, dropped_by_kill_switch, playback_failed`.

Aggregate (analyser-computed): `fast_heard = server.sent_to_client + iOS.playback_completed`.

### 4.2 Feature flags

Unchanged from PLAN_v2 §4.2.

### 4.3 Capability handshake

Pinned shape from PLAN_v2 §4.3 stays. `supports` array now includes `streaming_http_audio` (was `chunked_http_audio`; renamed to reflect that we ship PCM-default or MP3-fallback over the same chunked HTTP transport).

### 4.4 `source` field on TTS POST (re-scoped per Claude v2 NI2)

Five AlertManager entry points map to four `TTSSource` cases:

| Entry point | Line | TTSSource |
|---|---|---|
| `speakResponse(_:)` (generic) | (TBD per implementation) | `.question` (when wrapping ask_user) |
| `speakBriefConfirmation(_:)` | (TBD) | `.confirmation` OR `.correction` — disambiguated at call site by `correction` marker in bundle payload |
| `speakCriticalNotification(_:)` | (TBD) | `.notification` (NEW case) |
| `askSlotCount(_:)` / `askSlotContent(_:)` | (TBD) | `.question` |
| (any future) | — | explicit param required at call site |

```swift
enum TTSSource: String {
  case confirmation, correction, question, notification
}
```

`.notification` is exempt from suppression (it's not a confirmation/correction/question of a field value).

iOS implementation note: `speakBriefConfirmation`'s caller currently passes the bundle payload; this revision threads `source` through from the bundle (correction flag → `.correction`; otherwise `.confirmation`) to AlertManager → APIClient.

Tests required:
- `AlertManagerTests.swift`: assert source value at each of the 5 call sites matches the contract.
- `APIClientTests.swift`: round-trip with all 4 enum values; missing source defaults to `confirmation`.
- Backend `keys.test.js`: parse `notification` source, validate not subject to suppression.

### 4.5 `field_corrected` backend emission (wire shape pinned per Claude v2 NB1)

**Pinned wire shape:**
```json
{
  "type": "field_corrected",
  "circuit": <int>,
  "field": <string>,
  "previous_value": <string|null>,
  "reason": "clear_reading" | "same_turn_correction" | "replace_value"
}
```

Backend emission sites:
- `src/extraction/stage6-dispatchers-circuit.js dispatchClearReading` → `reason: "clear_reading"`, `previous_value` from state before clear.
- `src/extraction/stage6-per-turn-writes.js` (same-turn correction) → `reason: "same_turn_correction"`, `previous_value` from prior value within same turn.
- (Future, if needed) replace-value path → `reason: "replace_value"`.

iOS handler `Stage6Messages.swift:138-165` already decodes `case previousValue = "previous_value"` and `case reason` — wire-shape matches as-is. No iOS changes for the decoder; just verify on first emission that the iOS handler fires with non-nil `previousValue`.

**Tests:**
- New `stage6-dispatchers-circuit.test.js`: assert emission shape from clear path.
- New `stage6-per-turn-writes.test.js`: assert emission shape from correction path.
- iOS `Stage6MessagesTests`: round-trip from JSON fixture matching backend emission. Assert `previousValue` non-nil, `reason` populated.

### 4.6 Session entry — snapshot

Unchanged from PLAN_v2 §4.6.

### 4.7 Stage 1a commits (BACKEND PROTOCOL) — verification gate before 1b

| # | Commit subject | Files |
|---|---|---|
| 1a.1 | `feat(voice-latency): telemetry module + server-side outcome enum (no-op until stages enable)` | `src/extraction/voice-latency-telemetry.js` (new) + tests |
| 1a.2 | `feat(voice-latency): backend feature flags (per-session snapshotted + live kill switch)` | `src/extraction/active-sessions.js` (modify); `src/extraction/sonnet-stream.js` (read flags on session_start); `ecs/task-def-backend.json` (add 6 env vars) |
| 1a.3 | `feat(voice-latency): backend capability handshake (defensive defaults for missing fields)` | `src/extraction/sonnet-stream.js` (modify) + tests for missing-capability edge cases |
| 1a.4 | `feat(voice-latency): startup-log of effective flags + capabilities + multi-context decision` | `src/extraction/sonnet-stream.js` |
| 1a.5 | `feat(voice-latency): source field parsing on /api/proxy/elevenlabs-tts (defaults to confirmation when missing)` | `src/routes/keys.js` (modify) + tests |
| 1a.6 | `feat(stage6): emit field_corrected with pinned wire shape from dispatchClearReading + same-turn correction` | `src/extraction/stage6-dispatchers-circuit.js`; `src/extraction/stage6-per-turn-writes.js`; `src/extraction/sonnet-stream.js` (wire emission to WS) + tests including iOS fixture round-trip |

**Stage 1a verification gate:**
- All 6 backend commits land.
- Run a session with all flags `false`, capabilities unset. Behaviour unchanged.
- Manually trigger `clear_reading` via existing UI; verify backend emits new `field_corrected` event; verify CloudWatch shows the event.
- `scripts/check-task-def-env-drift.sh` green.
- Backend tests pass (all 3,200+ existing tests + new tests for 1a).
- Backend test scenarios: 4 new scenarios in `tests/fixtures/voice-latency-scenarios/protocol/*.yaml` covering missing capabilities, missing source, unknown source, field_corrected emission. Run via `npm run voice-test --filter protocol`.

### 4.8 Stage 1b commits (iOS PROTOCOL + streaming HTTP client)

| # | Commit subject | Files |
|---|---|---|
| 1b.1 | `feat(voice-latency-ios): VoiceLatencyTelemetry — correlation IDs + hops + outcomes` | `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift` (new) + tests |
| 1b.2 | `feat(voice-latency-ios): VoiceLatencyConfig — compile-time flags` | `CertMateUnified/Sources/Configuration/VoiceLatencyConfig.swift` (new) |
| 1b.3 | `feat(voice-latency-ios): capability handshake field in session_start` | `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (modify `sendSessionStart`) + tests |
| 1b.4 | `feat(voice-latency-ios): TTSSource enum + source field on APIClient.proxyElevenLabsTTS` | `CertMateUnified/Sources/Services/APIClient.swift` (modify) + AlertManager call sites at 5 entry points (one per existing entry point) + tests |
| 1b.5 | `feat(voice-latency-ios): voice_latency_ack message from iOS on playback_completed` | `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift` (extend); `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (add `sendVoiceLatencyAck`); backend handles inbound ack (`src/extraction/sonnet-stream.js`) + tests |
| 1b.6 | **`feat(voice-latency-ios): replace Alamofire .responseData with chunked HTTP client (DataStreamRequest)`** | `CertMateUnified/Sources/Services/APIClient.swift` (modify `proxyElevenLabsTTS` at lines 846/855/873) — adds `proxyElevenLabsTTSStreaming(text:sessionId:source:onChunk:onComplete:)`. Old method retained for back-compat until Stage 2 ships. **THIS COMMIT IS THE FIX FOR CODEX V2 NB1.** + tests including chunked-delivery fixture (URLProtocol mock) |
| 1b.7 | `feat(voice-latency-ios): startup log of effective config + capability bits` | misc iOS files |

**Stage 1b verification gate:**
- All 7 iOS commits land.
- iOS Build N (with capability bits) ships to TestFlight.
- Field test: run existing recording flow against Stage 1a backend. Telemetry shows new ack messages arriving server-side for every TTS playback. Zero regressions vs Build N-1.
- Run Stage 0.G transcript-replay harness against Build N's backend. All protocol scenarios pass.
- Backend startup log shows the new capability bits arriving from iOS `session_start`.

---

## 5. Stage 2 — Stream confirmations via ElevenLabs stream-input (re-scoped)

**Goal:** confirmation TTS comes from ElevenLabs `stream-input` WS (PCM-first), arriving at iOS as chunked HTTP. Lands the streaming TTS machinery AND the suppression machinery for Stage 4 to leverage. **Latency improvement is marginal** (cold ~3.0 s → cold ~2.95 s; warm ~2.5 s if 0.F passes). The win is infrastructure, not latency.

### 5.1 StreamingAudioPlayer (PCM-first; MP3 contingency)

- New `CertMateUnified/Sources/Audio/StreamingAudioPlayer.swift`.
- Constructed for `AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 22050, channels: 1, interleaved: true)`.
- `ingest(_ data: Data)` receives PCM byte chunks. Packs into `AVAudioPCMBuffer`; calls `playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack)`.
- First-frame scheduled → records `ios_first_pcm_frame_scheduled`.
- `dataPlayedBack` callback → records `ios_dataPlayedBack` hop. Sends `voice_latency_ack` over WS via `VoiceLatencyTelemetry.sendAck()`.
- Mic pause: `pauseAudioStream()` called on first scheduled buffer (NOT on object construction — Claude v2 I8 fix). Resumed on `playback_completed`.
- Per-session monotonic `audioSeq: UInt64` counter (added per Codex v2 PARTIAL B2). AlertManager queue checks `if incoming.audioSeq < queue.lastPlayedSeq { drop_stale }`. Older Sonnet audio is dropped if a newer fast-path audio has already played for the same field/circuit.

**Contingency (only if Stage 0.A PCM path fails):** rewrite using MP3 path:
- `AudioFileStreamOpen` + `AudioFileStreamParseBytes` callbacks (Core Audio C-level).
- OR integrate FreeStreamer / StreamingKit (open-source iOS libs).
- Adds 2–3 days to sprint. Re-estimate timeline with Derek.

### 5.2 Backend `stream-input` for confirmations

`src/extraction/elevenlabs-stream-client.js`:
- One **standalone** `stream-input` WS per synth (no pool unless 0.F passed and `VOICE_LATENCY_USE_MULTI_CONTEXT=true`).
- Default output format `pcm_22050` (locked decision 1.14). MP3 fallback if Stage 0.D shows PCM unacceptable.
- BOS: `{text: ' ', voice_settings: {...pinned settings 1.4}}`.
- After BOS → synth text + flush + EOS in single batch.
- 5 s in-flight dedupe keyed `confirm:<contentHash>` (PLAN_v2 §5.2 retained).
- **NO retain-and-replay cache** (PLAN_v2 confirmed; saves memory + complexity).

`src/routes/keys.js` modifications:
1. Parse `source` (default `'confirmation'`).
2. Generate correlation ID.
3. If `source === 'confirmation' AND VOICE_LATENCY_SUPPRESSION=true AND VOICE_LATENCY_STREAM_CONFIRMATIONS=true`:
   - Acquire suppression reservation (transition `→ reserved`).
   - If race-lost or already suppressed → return 204 with `X-Voice-Latency-Decision: suppressed*`.
4. Open `ElevenLabsStreamClient`.
5. Set response headers: `Content-Type: audio/L16; rate=22050; channels=1` (PCM) OR `audio/mpeg` (MP3); `Transfer-Encoding: chunked`; `X-Voice-Latency-Correlation-Id: <id>`.
6. Pipe chunks → `res.write`. **Add reservation transition `→ synthesising` on text sent** (Codex v2 NN1 fix; was missing in v2 §5.2).
7. On vendor first audio → reservation transition `→ first_byte`.
8. On vendor isFinal → `res.end()` + reservation `→ sent_to_client`.
9. On iOS ack via WS → reservation `→ suppression_active`, TTL 12 s `[stage0_tunable: derived from B p99 Sonnet completion]`.
10. On any error after reservation acquired → reservation `→ cancelled`; remove from store immediately.

**Decision-tree wait timings** (Codex v2 NI4):
- `reserved | synthesising | first_byte` → new caller waits up to **`[stage0_tunable: max(2s, p99_synth_completion + 200ms)]`** for state to advance.
- `sent_to_client` → hold for up to **`[stage0_tunable: audio_byte_count / bitrate + 200ms]`** for iOS ack. If ack never arrives → cancel old (in-store), acquire new. New caller proceeds. This explicitly accepts the case Codex v2 NI4 raised — if ack drops, the inspector may hear two readbacks.
- All timing values logged at session start; replayable via transcript-replay harness for verification.

### 5.3 Streaming cost-tracker accounting (Codex v2 NI5 fix)

`src/extraction/cost-tracker.js` extension:
- Existing `recordElevenLabsUsageForSession(sessionId, characterCount)` charges on full-call basis.
- New `recordElevenLabsStreamingUsageForSession(sessionId, characterCount, outcome)`:
  - Called on **text-sent-to-vendor** (`synthesising` transition), NOT on `isFinal` or iOS ack.
  - `outcome` ∈ `{started, completed, cancelled, failed}`. Cost is the SAME for all outcomes (ElevenLabs bills when text is accepted, not when audio plays).
  - Tracks `chars_started` + `chars_completed` + `chars_cancelled` separately for telemetry.
- Daily reconciliation (weekly cron per Claude v2 I10) compares vendor-reported usage to our `chars_started` total.

### 5.4 Codex angles addressed in Stage 2 — refined per Codex v2

| # | Angle | Stage 2 mechanism |
|---|---|---|
| #1 | Fast-path overtakes Sonnet | iOS monotonic `audioSeq` counter; AlertManager queue drops stale (newer-than-queued audio of same field/circuit triggers drop of older). N/A in Stage 2 without Stage 4, but the machinery lands now. |
| #5 | Mic feedback during chunked TTS | `pauseAudioStream` on first-scheduled-frame (independent of AVAudioPlayer lifecycle). |
| #6 | iOS playback latency | Stage 0.A PCM target ≤100ms. |
| #7 | BT route change | Stage 0.A field test across 4 routes. Honest residual risk: route change mid-session may still affect voice timbre. Mitigation = detection (telemetry hop) + warning to user; full prevention deferred to a route-change UX sprint. |
| #9 | Double-spend | 5 s in-flight dedupe + idempotency-keyed cache. Vendor cost charged on text-sent (cost-tracker streaming accounting per §5.3). |
| #13 | Success-only telemetry | iOS ack required for `playback_completed`; analyser computes aggregate `fast_heard`. |
| #14 | Mixed clocks | Monotonic only. |
| #16 | Mid-session flag flip | Snapshotted. Kill switch live-override only. |
| #22 | Voice drift | Voice settings + model pinned. PCM-vs-MP3 evaluated in Stage 0.D. |

### 5.5 Commits (Stage 2)

| # | Commit subject | Files |
|---|---|---|
| 2.1 | `feat(voice-latency-ios): StreamingAudioPlayer (AVAudioEngine + AVAudioPlayerNode, PCM-first)` | `CertMateUnified/Sources/Audio/StreamingAudioPlayer.swift` (new) + tests with synthetic PCM fixtures + monotonic audioSeq counter |
| 2.1a | **(contingency, only if 0.A PCM fails)** `feat(voice-latency-ios): MP3 frame parser via AudioFileStream` | `CertMateUnified/Sources/Audio/MP3FrameStream.swift` (new) + tests |
| 2.1b | **(contingency)** `feat(voice-latency-ios): integrate MP3 parser into StreamingAudioPlayer` | `CertMateUnified/Sources/Audio/StreamingAudioPlayer.swift` (modify) + tests |
| 2.2 | `feat(voice-latency-ios): AlertManager swaps to StreamingAudioPlayer; mic-pause on first scheduled frame` | `CertMateUnified/Sources/Recording/AlertManager.swift` (modify) + tests |
| 2.3 | `feat(voice-latency-ios): APIClient streaming chunked-HTTP receive path (DataStreamRequest)` | `CertMateUnified/Sources/Services/APIClient.swift` (modify; new method) + chunked URLProtocol mock + tests |
| 2.4 | `feat(voice-latency): ElevenLabsStreamClient (single-shot per synth, PCM output, 5s in-flight dedupe)` | `src/extraction/elevenlabs-stream-client.js` (new) + tests |
| 2.5 | `feat(voice-latency): /api/proxy/elevenlabs-tts streams confirmations via stream-input behind flag` | `src/routes/keys.js` (modify) + tests including failure modes |
| 2.6 | `feat(voice-latency): cost-tracker streaming usage (charged on text-sent, not isFinal)` | `src/extraction/cost-tracker.js` (modify) + tests |
| 2.7 | `chore(voice-latency): VOICE_LATENCY_STREAM_CONFIRMATIONS env var default false in task-def-backend.json` | `ecs/task-def-backend.json` |

**Verification gate Stage 2 → Stage 3:**
- Real session with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` + iOS Build N.
- Telemetry: P50 audible-confirmation 2.95–3.4 s cold / ~2.0–2.5 s warm (if 0.F passed).
- iOS ack arrives for every TTS playback; analyser computes `fast_heard` correctly.
- Cost-tracker reports correct char count via streaming accounting.
- Zero regressions.
- Transcript-replay harness runs all `stage2_*` scenarios PASS.

---

## 6. Stage 3 — Server-side suppression (carried from PLAN_v2 §6, fixes applied)

Carried unchanged from PLAN_v2 §6 except:

### 6.1 Reservation state machine (Codex v2 NN1 fix)

State transition list at §5.2 step 6 updated to explicitly include `→ synthesising` on text-sent. Decision-tree wait timings now `[stage0_tunable: ...]` markers per Codex v2 NI1.

### 6.2 Canonical suppression key (unchanged)

### 6.3 TTL — explicit Stage 0 derivation (Codex v2 NI1)

TTL = `max(12 s, p99_sonnet_completion + p99_ios_playback_ack_delay + 2 s)` `[stage0_tunable: from B + A]`. Default 12 s; raise if Stage 0 measurement exceeds it. Document final value in `STAGE0_RESULTS_TUNING.md`.

### 6.4–6.6 Commits

Renumbered to add the cost-tracker integration (was 2.6 in §5.5). Otherwise unchanged from PLAN_v2 §6.6.

---

## 7. Stage 4 — iOS regex-fast path (CONDITIONAL — assess after Stage 3)

**Per locked decision 1.21**, Stage 4 work begins ONLY if Derek's post-Stage-3 assessment concludes the Stage 2+3 audible latency is insufficient. Decision gate process:

1. Stage 3 ships with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` and `VOICE_LATENCY_SUPPRESSION=true`.
2. Derek runs ~5 normal cert sessions in real field conditions.
3. Telemetry P50/P95 audible-confirmation latency captured per session.
4. Derek subjectively assesses: does the inspector experience feel acceptable? Are confirmations fast enough that you don't notice the lag?
5. Three outcomes:
   - **"Acceptable, don't pursue Stage 4"** → close sprint at Stage 5 (ask_user streaming) + Stage 6 (rollout). Save the engineering cost of Stage 4.
   - **"Borderline, but Stage 0.F also failed (multi-context unavailable)"** → defer Stage 4 to a future sprint, possibly re-prioritise after other work.
   - **"Still too slow, proceed"** → execute Stage 4 as planned below.

**Why this gate exists:** the regex-fast path is structurally faster than Sonnet (Sonnet has an irreducible ~1.5–2 s TTFT+finalisation floor that fast-path skips entirely), so Stage 4 would always be measurably faster. But measurably faster isn't always *usefully* faster. If 2.0 s feels OK and the cost of Stage 4 is the riskiest commit set in the sprint (R1–R8 race fixtures, transcript-context-anchoring, fast-eligibility), the trade-off may not be worth it. Decision is yours after seeing real numbers.

Carried from PLAN_v2 §7, with these fixes:

### 7.3 Eligibility whitelist — canonical names verified against `config/field_schema.json`

| Field (canonical from schema) | Eligible? | Notes |
|---|---|---|
| `number_of_points` | ✅ | Integer; regex reliable. |
| `measured_zs_ohm` | ✅ | Decimal Ohms. |
| **`r1_r2_ohm`** (NOT `r1_plus_r2`) | ✅ | Verified: `field_schema.json` line 203 + 976. iOS regex emits same key. |
| `polarity_confirmed` | ✅ (with stricter anchor) | Requires explicit `circuit N polarity confirmed`. |
| **`ir_live_live_mohm`, `ir_live_earth_mohm`** (NOT `iso_l_pe`/`iso_l_n`/`iso_n_pe`) | ✅ | Verified: `field_schema.json` lines 228, 236, 980. |
| `earth_loop_impedance_ze` | ✅ | Installation-level scope. |
| `prospective_fault_current` | ✅ | Installation-level scope. |
| `ring_r1_ohm`, `ring_r2_ohm`, `ring_rn_ohm` | ❌ deferred to 4.5 | Codex I6. |
| All others | ❌ | Future broadening from production telemetry. |

`src/extraction/voice-fast-eligibility.js` exports `WHITELIST` as a `Set` of these canonical names. Tests assert match against `field_schema.json` schema keys.

### 7.4 Race catalogue — R8 added per Codex v2 NI1 ack-never-arrives case

**R8 (new):** `sent_to_client` state reached; server emits chunks; iOS WS drops or backgrounded before sending `voice_latency_ack`. After `[stage0_tunable: audio_byte_count / bitrate + 200ms]` wait, server cancels suppression (transitions `cancelled`). Next caller for same key proceeds. If iOS reconnects later and re-receives a chunk-completion event AND a fresh fast-path arrives in parallel, inspector may hear two readbacks.

**Mitigation:** ack-timeout is computed from expected audio duration. After timeout, suppression cancelled → next call proceeds. Field test verifies frequency; if user reports double-readbacks > 1% of sessions, escalate.

### 7.5 Stage 0.F-gated multi-context (carried)

Unchanged from PLAN_v2 §7.5. Pool TTL 120 s `[stage0_tunable]`.

### 7.6 iOS Strategy C streaming HTTP client integration

Stage 4's fast-path POST also goes through the new `APIClient.proxyElevenLabsTTSStreaming(...)` from Stage 1b commit 1b.6. NO new streaming HTTP code in Stage 4 — reuses the Stage 1b infrastructure. Confirms why 1b.6 was promoted to Stage 1.

### 7.7 Commits (Stage 4)

Carried from PLAN_v2 §7.7 with:
- Commit 4.5 updated to use the Stage 1b streaming HTTP client (no new HTTP work).
- New commit 4.4a (between 4.4 and 4.5): `feat(voice-latency): R8 ack-timeout cancellation with audio-duration-based timeout` — to cover the ack-never-arrives race explicitly.

---

## 8. Stage 5 — ask_user streaming (carried)

Unchanged from PLAN_v2 §8. String-field extractor over `partial_json`; hold audio until `content_block_stop`; SSML parsing enabled.

Added test: split-unicode escape fixture (`\u00XX` arriving across two partial_json chunks).

---

## 9. Stage 6 — Rollout (carried)

Unchanged from PLAN_v2 §9 with:
- Kill switch verification (§9.2) explicitly tests R7 + R8 + R6 races, not just generic flip.
- §9.3 weekly cost reconciliation retained (Claude I10).

---

## 10. Testing strategy (with new §10.6 scenario library)

Carried from PLAN_v2 §10 with addition:

### 10.6 Transcript-replay scenario library (Stage 0.G)

Runtime: `npm run voice-test` from repo root.

CI integration: `.github/workflows/voice-latency-scenarios.yml` runs on every backend PR. Fails the PR if any scenario regresses.

Field-bug capture: documented in `docs/reference/voice-latency.md` post-sprint.

Scenarios list (initial 15 from §3.G plus race fixtures R1–R8 from §7.4):
- 15 functional scenarios (normal + edge + adversarial)
- 8 race fixtures (R1–R8 with deterministic timing)
- 4 protocol scenarios (capability handshake edge cases)

Total: ~27 scenarios. Runtime < 5 minutes for the full suite.

---

## 11. Documentation (carried, plus voice-latency.md)

Carried from PLAN_v2 §11. New `docs/reference/voice-latency.md` documents:
- Architecture
- Stage 0 results + tuning constants
- Scenario library usage
- Field-bug capture flow
- Telemetry hop reference

---

## 12. Open questions (consolidated)

Resolved 2026-05-23 (Derek):

1. **Stage 0.F worth a full day?** ✅ YES — confirmed.
2. **PCM vs MP3 default for ElevenLabs output:** ✅ PCM — confirmed. PCM is proper for Apple's audio stack (AVAudioPlayerNode native), ElevenLabs documents lowest TTFB, bandwidth differential negligible on 4G/iPad. Stage 0.D still A/B verifies quality. MP3 contingency only if PCM is audibly worse to Derek's ear.
3. **Sprint timeline:** ✅ 2–2.5 weeks confirmed.
4. **`async-mutex` dep:** hand-rolled (~30 lines) — confirmed approach.
5. **Single-instance backend assumption:** verified via AWS console `eicr-backend` service `desiredCount=1` (NOT in source). Document in `docs/reference/architecture.md` + add note to `ecs/task-def-backend.json` comment. (PLAN_v2 N4 fix.)
6. **Eligibility broadening (Stage 4.5):** ring values, others. Driven by production telemetry post-Stage-4. Out of sprint exit gate. (Also conditional on Stage 4 actually proceeding — see Q10 below.)
7. **iOS playback ack overhead:** confirmed acceptable.
8. **Codex angle #7 (BT route change):** ✅ DETECTION ONLY — confirmed. Full prevention deferred to a follow-up sprint if Stage 4 telemetry shows it's a real-world issue.
9. **Future-ambiguity fast-vs-ask_user (Codex v2 PARTIAL B3):** ✅ STRATEGY B — start at 0.85 confidence floor, telemetry-driven tune to 0.95 only if field-test rate > 5%. Strategy A (start strict at 0.95) explicitly rejected.
10. **Stage 4 conditional execution:** ✅ CONFIRMED — Stage 4 work begins only after Derek assesses Stage 2+3 audible latency in real cert sessions. See locked decision 1.21 + §7 intro. If Stage 2+3 feels acceptable in field use, Stage 4 deferred or cancelled.

---

## 13. Exit criteria

Two tiers, depending on the post-Stage-3 decision gate (locked decision 1.21):

### 13.1 Minimum-Viable Sprint Exit (Stages 0 + 1 + 2 + 3 + 5 + 6 — Stage 4 skipped)

If Derek's post-Stage-3 assessment says "Stage 2+3 is good enough, skip Stage 4":

- **Stage 2 P50 audible-confirmation latency** ≤ 3.0 s cold / ≤ 2.5 s warm (honest arithmetic — Sonnet TTFT dominates).
- Stage 3 suppression machinery proven against zero sources of duplication (suppression rate = 0% in steady state — validates wiring).
- Stage 5 (ask_user streaming) lands separately — useful regardless.
- Stage 0 gates A, B, C, D, E, F, G all documented with measured tunables in `STAGE0_RESULTS_TUNING.md`.
- Sprint closes at "infrastructure laid, audible latency improved ~17–33%."

### 13.2 Full Sprint Exit (Stages 0 + 1 + 2 + 3 + 4 + 5 + 6 — Stage 4 executed)

If Derek's post-Stage-3 assessment says "still too slow, proceed":

- Stage 2 targets as above.
- **Stage 4 P50 audible-latency target** ≤ 1,200 ms cold / ≤ 700 ms warm. Warm requires Stage 0.F passing.
- All Stage 0 gates documented.
- All race fixtures R1–R8 pass deterministically.
- Field-test outcome: ≥ 80% of fast-eligible turns reach `fast_heard`; suppression rate ≥ 90% of `fast_heard`.
- Sprint closes at "headline target achieved."

Either exit is a valid sprint outcome.
- **Transcript-replay scenario library** runs in CI with 100% pass rate at sprint exit.

---

## 14. Risk register (carried, plus 2 new rows)

| Risk | Likelihood | Impact | Mitigation | Stage |
|---|---|---|---|---|
| (all PLAN_v2 §14 rows carry forward) | | | | |
| **(NEW) `field_corrected` wire-shape mismatch** | Low (now pinned) | High | Stage 1a contract-test fixture; iOS handler verified | 1a |
| **(NEW) iOS Alamofire .responseData buffering breaks Strategy C** | Eliminated | High | Stage 1b commit 1b.6 replaces with chunked HTTP client | 1b |
| **(NEW) PCM output sounds different from current MP3** | Medium | Medium | Stage 0.D field A/B; fallback to MP3 path (+2-3 days) | 0 |
| **(NEW) MP3 fallback path adds 2-3 days** | Conditional on 0.D | Medium | Pre-budgeted contingency; Derek decides | 0 |
| **(NEW) Future-ambiguity (fast then Sonnet asks)** | Medium | Low–Medium | Detection telemetry; iOS confidence raise if rate high | 4+ |
| **(NEW) BT route change mid-session** | Medium | Low | Detection only this sprint | 4 |

---

## 15. References (carried)

Add: `claude-review-v2.md`, `codex-review-v2.md`, `PLAN_v2.md` (predecessor).

---

## 16. Codex angles traceability (carried, refined rows 1, 7, 13)

| # | Angle | Mechanism in PLAN_v3 | Tests | Residual risk |
|---|---|---|---|---|
| 1 | Fast-path overtakes older Sonnet MP3 | iOS monotonic `audioSeq` counter per session; AlertManager queue drops stale audio | R1 race fixture + audioSeq unit tests | None — newer audio always wins |
| 7 | BT route change | `AVAudioSession.routeChangeNotification` hop in telemetry; field test on 4 routes (built-in / AirPods / BT headset / wired). Detection-only this sprint. | Field test (Stage 4 gate) | **Acknowledged residual** — full prevention deferred. Derek confirms in §12 Q8. |
| 13 | Success-only telemetry | Server outcomes vs iOS outcomes split; `fast_heard` = aggregate (server `sent_to_client` + iOS `playback_completed`). Analyser-computed. | Telemetry contract tests + transcript-replay scenarios | **Acknowledged residual** — server emits chunks then iOS WS drops before ack → counted as `sent_to_client` only. Discrepancy visible in analyser gap. |
| (other 19 rows unchanged from PLAN_v2 §16) | | | | |

---

## 17. NITs addressed (carried, plus v2-NN1/NN2)

Carry PLAN_v2 §17 forward. Plus:

| Source | NIT | Addressed in PLAN_v3 |
|---|---|---|
| Codex v2 NN1 | `synthesising` transition not wired in §5.2 | §5.2 step 6 — explicit `→ synthesising` on text-sent |
| Codex v2 NN2 | `fast_heard` wording overloaded | iOS outcome renamed `playback_completed`; `fast_heard` retained as analyser aggregate |
| Claude v2 NN1 | Stage 0.F half-day understates risk | Raised to full day; pass criteria operational |
| Claude v2 NN2 | CLAUDE.md backend-immutability rule | Confirmed: no `web/` work; OK |
| Claude v2 NN3 | Commit-message subjects | Confirmed: each scoped; OK |

---

## 18. Approval & next steps

- [ ] Derek reads PLAN_v3.md.
- [ ] Derek answers Open Questions §12 (especially Q2 PCM/MP3, Q3 timeline, Q8 BT route, Q9 future-ambiguity).
- [ ] Derek approves OR requests revisions.
- [ ] On approval: Stage 0 begins. Stage 0.G transcript-replay harness can run BEFORE Stage 1 lands (since it tests existing backend behaviour baseline).

---

## 19. Summary of review-driven changes (consolidated)

For posterity / future-Claude / future-Derek:

| Source | Finding | Status in PLAN_v3 |
|---|---|---|
| Claude v1 (3 BLOCKER / 10 IMPORTANT / 8 NIT) | 7 of 7 BLOCKERs fixed; all IMPORTANTs fixed; all NITs fixed | Carried fixed in v2; v3 refines as needed |
| Codex v1 (4 BLOCKER / 10 IMPORTANT / 5 NIT) | 7 of 7 BLOCKERs fixed; PARTIAL findings carried as honest residual | Carried fixed in v2; v3 refines |
| Claude v2 (1 BLOCKER / 4 IMPORTANT / 3 NIT) | All addressed | PLAN_v3 §0 items 1, 2, 4, 5, 10, 13 |
| Codex v2 (1 BLOCKER / 5 IMPORTANT / 2 NIT) | All addressed | PLAN_v3 §0 items 2, 7, 8, 9, 11, 12, 14, 15 |
| Derek 2026-05-23 | Transcript-replay test regime | Stage 0.G + §10.6 + ~27 scenarios |

Total reviews so far: 2 rounds × 2 reviewers = 4 review passes. 9 BLOCKERs caught and fixed; 27 IMPORTANTs caught and fixed; 24 NITs caught and addressed. **Zero lines of implementation written.**

If a third review round identifies fresh BLOCKERs, run PLAN_v4. The cost of plan-iteration is dwarfed by the cost of debugging code that shipped with a structural flaw.
