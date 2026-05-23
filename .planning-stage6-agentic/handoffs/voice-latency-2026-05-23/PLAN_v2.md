# Voice Latency Sprint — PLAN_v2.md (reconciled)

**Date:** 2026-05-23
**Supersedes:** `PLAN.md` (draft, pre-review)
**Reconciles:** `claude-review.md` (3 BLOCKER / 10 IMPORTANT / 8 NIT) + `codex-review.md` (4 BLOCKER / 10 IMPORTANT / 5 NIT). Every BLOCKER and IMPORTANT from both reviews is either (a) addressed concretely in this revision OR (b) explicitly deferred with rationale.
**Resume rule:** this is the executable plan. Do not start coding until Derek explicitly approves.

---

## 0. What changed vs PLAN.md

Headline:

1. **Latency budget rebuilt from honest research numbers.** Old §2 was off by ~800 ms on Stage 2 (omitted ElevenLabs 800 ms BOS handshake) and double-counted iOS hop boundaries. New §2 has separate cold/warm + first-byte/first-audible columns.
2. **iOS Strategy C playback (AVAudioEngine + AVAudioPlayerNode) promoted into Stage 2.** Strategy A (whole-blob accumulate) means iOS first-audible = full synthesis time, killing the latency win. Strategy C is mandatory; iOS work is no longer deferred.
3. **Session-pooled ElevenLabs WS removed.** Codex B4 — `stream-input` audio frames have no correlation tags, EOS closes the socket. Replaced with: one `stream-input` WS per logical audio item, plus a new **Stage 0.F gate** evaluating ElevenLabs' `multi-stream-input` endpoint (the documented multi-context primitive). Pool only if 0.F passes.
4. **Reservation-state machine for suppression.** Codex B2 — entries transition `reserved → synthesising → first_byte → sent_to_client → ack'd_by_ios → suppression_active` (TTL). Reservation acquired BEFORE the vendor call, not after `isFinal`. Shared between fast-path + confirmation paths.
5. **`field_corrected` is now emitted by the backend.** Claude B2 — new Stage 3 commit adds emission from `dispatchClearReading` and from same-turn correction in `stage6-per-turn-writes.js`.
6. **`source` field added in Stage 1.** Claude B1 — iOS POST body carries `{text, sessionId, source: confirmation|correction|question}`; backend defaults to `confirmation` when missing.
7. **Telemetry split.** Codex I8 — server outcomes are `synth_complete`/`sent_to_client`; `fast_heard` requires an iOS playback ACK.
8. **Fast-eligibility tightened.** Codex B3 + I6 — eligibility now requires *transcript-context anchoring*, not just schema validity. Multi-candidate turns rejected. Whitelist rebuilt from canonical `field_schema.json` keys.
9. **Suppression TTL down to 12 s.** Codex I2 — derived from p99 Sonnet completion. Validated in Stage 0.
10. **Kill switch is a live override.** Codex I10 — not snapshotted; explicit cancellation rules for in-flight streams.
11. **Stage 5 (ask_user streaming) reshaped.** Codex I5 — use a focused string-field extractor over accumulating `partial_json`, hold audio until `content_block_stop`. Drop the streaming-JSON-parser dep.
12. **22-row Codex angle traceability table** added (§16). Every angle has a concrete mechanism, test, and residual-risk line.

What did NOT change:

- Scope: four items in (regex-fast, stream Sonnet→TTS, suppress, telemetry+flags).
- Silent fallback on fast-TTS failure.
- Voice consistency (same model + settings on both paths).
- Codex in planning AND review (this iteration confirms the value — Codex review caught 4 BLOCKERs that would have shipped).

---

## 1. Locked decisions (consolidated)

| # | Decision | Source |
|---|---|---|
| 1.1 | All four scope items in | Derek 2026-05-23 |
| 1.2 | Silent fallback if fast TTS fails | Derek 2026-05-23 |
| 1.3 | Same voice ID + model + voice_settings on both paths | Derek 2026-05-23 |
| 1.4 | Model **`eleven_flash_v2_5`**. `eleven_turbo_v2_5` is documented by ElevenLabs as a deprecated alias for Flash v2.5; same audio behaviour. Voice settings pinned: `stability=0.5, similarity_boost=0.75, style=0.3, use_speaker_boost=true, speed=1.0`. `apply_text_normalization='on'`. | Research APIs §A.3, Codex angle #22, Stage 0.D verifies |
| 1.5 | Output format `mp3_22050_32` for both paths | Research APIs §A.6 |
| 1.6 | iOS playback **must be Strategy C** (AVAudioEngine + AVAudioPlayerNode + AVAudioConverter for MP3 → PCM frames). Strategy A makes Stage 2 a no-op for latency. | Codex B1, Claude B3 |
| 1.7 | Backend region eu-west-2; ElevenLabs global endpoint `api.elevenlabs.io`. Reassess if Stage 0.C TTFB > 250 ms | Research APIs §A.3 |
| 1.8 | Codex CLI engaged during planning + review (proven valuable this iteration) | Derek 2026-05-23 |
| 1.9 | One `stream-input` WS per logical audio item by default. Multi-context (`multi-stream-input`) only if Stage 0.F passes its evaluation gate. | Codex B4 |
| 1.10 | Suppression entry lifecycle uses reservation-states, not single TTL. Entry reserved BEFORE vendor call; transitions on synthesis events; concrete TTL on terminal state only. | Codex B2 |
| 1.11 | Fast-eligibility requires transcript-context anchoring, not just schema validity. Reject multi-candidate turns. Reject answer-to-ask unless mapped to the active ask. | Codex B3 |
| 1.12 | Kill switch is live (NOT session-snapshotted). Cancels in-flight ElevenLabs WSes; iOS drops queued fast-path audio. | Codex I10 |
| 1.13 | All iOS file paths in this plan are repo-rooted: `CertMateUnified/Sources/...` | Codex N5 |

---

## 2. Latency budget — honest, cold + warm split

### Today (measured, session `C082FCAB` 2026-05-23 10:33–10:38 UTC)

| Step | P50 (ms) |
|---|---|
| Utterance-final → iOS regex applied | ~40 |
| iOS regex → iOS WS send | ~5 |
| iOS WS → backend receive | ~30 |
| Backend → Anthropic Sonnet round-trip (cached, incl. tool_use finalisation) | ~1,800–2,200 |
| `bundleToolCallsIntoResult` + `buildConfirmationText` | ~30 |
| iOS receives `result.confirmations[]`, posts `POST /api/proxy/elevenlabs-tts` | ~80 |
| Backend → ElevenLabs HTTP batch synthesis (full MP3 returned) | ~600–1,200 |
| iOS HTTP response complete → `AVAudioPlayer(data:)` → `play()` | ~80 |
| **Total audible (today, P50)** | **~2,700–3,700 ms** |

### Stage 2 — stream confirmations only (no fast-path, no pool, Strategy C iOS)

| Step | First-byte (ms) | First-audible (ms) |
|---|---|---|
| Utterance-final → iOS regex applied | ~40 | ~40 |
| iOS WS → backend → Sonnet round-trip | ~1,800–2,200 | ~1,800–2,200 |
| `buildConfirmationText` | ~30 | ~30 |
| iOS POST → backend opens ElevenLabs `stream-input` WS | ~80 | ~80 |
| ElevenLabs BOS handshake (cold) | ~800 | ~800 |
| ElevenLabs first audio frame after BOS | ~150–250 | ~150–250 |
| iOS HTTP chunk received | ~30 | ~30 |
| iOS AVAudioPlayerNode `scheduleBuffer` + `dataPlayedBack` callback | n/a | ~50 |
| **Total (P50)** | **~2,930–3,430** | **~2,980–3,480** |

Stage 2 *alone* is **NOT a meaningful improvement** over today. This is the BLOCKER Codex B1 caught.

Where the gain comes from:
- Stage 0.F passing (multi-context endpoint usable) → keep one warm WS per session, amortise 800 ms BOS → Stage 2 audible drops to **~2,180–2,680 ms** (saves the BOS on every confirmation after the first).
- Stage 4 (regex-fast) → skip Sonnet entirely on eligible turns → audible **~640–940 ms** (cold) or **~440–740 ms** (warm WS).

### Stage 4 — regex-fast path (the real win)

| Step | Cold (ms) | Warm (ms — Stage 0.F passed) |
|---|---|---|
| Utterance-final → iOS regex applied | ~40 | ~40 |
| iOS POST `/api/voice-latency/regex-fast-tts` | ~50 | ~50 |
| Backend eligibility + reservation | ~30 | ~30 |
| ElevenLabs BOS handshake | ~800 | ~0 (warm) |
| First audio frame after text submission | ~150–250 | ~150–250 |
| Backend chunked HTTP response → iOS | ~30 | ~30 |
| iOS AVAudioPlayerNode first frame | ~50 | ~50 |
| **Total (P50)** | **~1,150–1,250** | **~350–450** |

So the **<700 ms target** is only achievable with Stage 0.F passing AND Stage 4 fast-path. Stage 2 alone is a marginal win without 0.F. Plan structure now reflects this:

- 0.F is on the critical path for any meaningful latency improvement.
- Stage 2 is only worth shipping if 0.F passes (otherwise it's machinery in service of Stages 3+4).

If 0.F fails: Stage 2 still ships (suppression machinery exists), but Stage 2's latency improvement is honestly ~5–10% not ~50%. Stage 4 cold-only path remains ~1.1–1.3 s — still a 60%+ improvement over today. Acceptable fallback.

---

## 3. Stage 0 — Measurement gates (mandatory, no code lands without)

### 3.A iOS Strategy C playback feasibility (PROMOTED FROM "discovery" TO "required")

**Why:** Locked decision 1.6. AVAudioPlayer cannot stream MP3, Strategy A makes the whole sprint a no-op. Strategy C requires `AVAudioEngine + AVAudioPlayerNode + AVAudioConverter(.pcmFormatFloat32, sampleRate: 22050)` to convert MP3 frames → PCM as they arrive.

**Method:**
1. Branch `voice-latency-stage0-bench` on `CertMateUnified`. Test harness button on Settings → Debug.
2. Backend Stage 0 throwaway endpoint `POST /api/test/elevenlabs-stream` (gated by `STAGE0_BENCH=1`, removed at Stage 0 end) streams ElevenLabs `mp3_22050_32` chunks.
3. iOS implements full Strategy C: `AVAudioEngine` + `AVAudioPlayerNode` + `AVAudioConverter` chunked decode + `scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack)`.
4. Measure `chunk_received_at` (URLSession `didReceive`), `first_pcm_frame_scheduled_at`, `dataPlayedBack_callback_at` per chunk.
5. Test on iPhone 17 Pro + iPad Air, Wi-Fi + 4G, built-in speaker + AirPods + BT headset (Codex angle #7).

**Pass criteria:** P50 from `first_chunk_received` to `dataPlayedBack` ≤ 200 ms. P95 inter-chunk audible gap < 50 ms. Zero clicks/pops detectable by ear in 5-minute test loop.

**Fail action:** Replan entire sprint. Strategy C is non-negotiable; if iOS can't decode chunked MP3 cleanly, the latency targets are unreachable with current iOS stack. Possible re-plan: use `pcm_16000` (no decode) but requires `AVAudioPlayerNode` accepting raw PCM frames (well-supported). Escalate to Derek.

**Output:** `STAGE0_RESULTS_PLAYBACK.md`.

### 3.B Anthropic Sonnet 4.6 TTFT in production config

Unchanged from PLAN.md §3.B. Pass criterion: **P50 cached TTFT ≤ 900 ms**. Fail action: Stage 2 budgets relax; Stage 4 becomes the only sub-1 s path.

### 3.C ElevenLabs `stream-input` TTFB from eu-west-2

Unchanged from PLAN.md §3.C. Pass criterion: **P50 BOS-to-first-audio ≤ 250 ms**.

### 3.D Voice fidelity A/B (Turbo v2.5 vs Flash v2.5 with our voice ID)

Unchanged from PLAN.md §3.D. Derek listens. Pass = same-voice perception.

### 3.E iOS chunked transport throughput

**Aligned with transport choice (Codex I7).** Stage 2 + Stage 4 both use **chunked HTTP responses** for audio (server pipes ElevenLabs chunks straight into the HTTP response). NOT the existing WS. Reasoning: HTTP has the right semantics for "request → response audio stream"; the WS is for bidirectional session events. The existing `/api/proxy/elevenlabs-tts` already returns audio over HTTP; keeping the transport consistent is the safe choice.

**Method:** measure `URLSession.dataTask` `didReceive` arrival cadence + jitter over 4G with ELB chunked HTTP. **Pass criterion:** P95 inter-arrival jitter < 30 ms.

**Output:** `STAGE0_RESULTS_HTTP_CHUNKING.md`.

### 3.F NEW — ElevenLabs `multi-stream-input` evaluation

**Why:** Codex B4 — single `stream-input` WS cannot identify which logical confirmation each audio frame belongs to; EOS closes the socket. Pooling is unsafe. ElevenLabs documents a `multi-stream-input` endpoint (Research APIs sources line 537) that may provide per-context audio frames. If it works for our use case, we get the pool-warming benefit (no 800 ms BOS per confirmation) safely.

**Method:**
1. Open `wss://api.elevenlabs.io/v1/text-to-speech/Fahco4VZzobUeiPqni1S/multi-stream-input?model_id=eleven_flash_v2_5&output_format=mp3_22050_32`.
2. Test:
   - Can we initialise a context? Per-context BOS shape.
   - Send text with `context_id: "abc"` → audio frames come back with matching `context_id`?
   - Two concurrent contexts: do their audio frames interleave correctly tagged?
   - Close one context — does the other survive?
   - Voice continuity vs cross-context drift.
3. Document the protocol (mostly absent from public docs as of research date).

**Pass criteria:**
- Per-context audio frame routing works deterministically.
- Two concurrent contexts produce correctly-tagged frames.
- BOS amortised across multiple synth requests (one BOS, many contexts).

**Fail action:**
- Stage 2 & Stage 4 ship with one `stream-input` WS per logical item; accept 800 ms BOS per request. Stage 4 P50 becomes ~1,150 ms cold instead of ~450 ms warm. Still a 60%+ improvement; ship.
- Stage 4's `<700 ms target` becomes `<1.2 s target`. Update §13 exit criteria.

**Output:** `STAGE0_RESULTS_MULTI_CONTEXT.md` — protocol notes + verdict.

---

## 4. Stage 1 — Foundation (rebuilt)

**Goal:** every subsequent stage can opt-in/out, can be measured, can be rolled back. Plus: the wire-format scaffolding that the rest of the plan needs (`source` field on TTS posts, `field_corrected` backend emission, capability handshake).

### 4.1 Telemetry framework

Module: `src/extraction/voice-latency-telemetry.js`.

- `mintCorrelationId(sessionId, source)` — same as PLAN.md §4.1.
- `recordSpan(correlationId, hopName, hrtimeStartNs, hrtimeEndNs, meta)` — server-side hops only. Monotonic `process.hrtime.bigint()`. Never wall-clock.
- `recordOutcome(correlationId, outcome, ackedByIos)` — terminal status.

**Renamed outcome enum (Codex I8):**
- Server-side outcomes: `synth_started`, `synth_first_byte`, `synth_complete`, `synth_failed`, `sent_to_client`, `cancelled`, `suppressed_before_synth`, `suppressed_after_synth`.
- iOS-side outcomes: `fast_heard` (= `playback_started` + `playback_completed`), `dropped_stale`, `dropped_by_correlation_id`, `playback_failed`.
- Correlation: iOS posts `voice_latency_ack` over the existing WS with `{correlationId, outcome, hrtimes}` at playback completion.

**Hop list (Codex N4):** `utterance_final` (new — explicit), `regex_match`, `ios_ws_send`, `ios_http_post_send` (fast-path), `backend_recv`, `eligibility_decision`, `suppression_decision` (Codex N4 addition), `reservation_acquired`, `vendor_ws_open`, `vendor_first_audio`, `vendor_isFinal`, `ios_first_chunk_recv`, `ios_first_pcm_frame_scheduled`, `ios_dataPlayedBack`, `ios_playback_complete`.

iOS module: `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift`. Same hop names. `DispatchTime.now().uptimeNanoseconds` only.

### 4.2 Feature flags (refined)

Flags split into **per-session-snapshotted** and **live overrides**:

**Per-session snapshotted (set at session_start, can't change mid-session):**
| Flag | Default | Effect |
|---|---|---|
| `VOICE_LATENCY_STREAM_CONFIRMATIONS` | `false` | Stage 2 — `stream-input` for confirmations. |
| `VOICE_LATENCY_SUPPRESSION` | `false` | Stage 3 — reservation machinery active. |
| `VOICE_LATENCY_REGEX_FAST_TTS` | `false` | Stage 4 — fast-path endpoint live. |
| `VOICE_LATENCY_STREAM_ASK_USER` | `false` | Stage 5 — partial ask_user streaming. |
| `VOICE_LATENCY_USE_MULTI_CONTEXT` | `false` | Stage 0.F passed → use `multi-stream-input` instead of `stream-input`. |

**Live overrides (Codex I10 — NOT snapshotted, checked at gate-time + cancellation):**
| Flag | Default | Effect |
|---|---|---|
| `VOICE_LATENCY_KILL_SWITCH` | `false` | When true: (a) reject all new TTS requests, (b) cancel all open ElevenLabs WSes within ~50 ms, (c) emit `voice_latency_kill_switch_active` to all iOS clients so they drop queued fast-path audio, (d) fall through to today's batch path on next request. |

iOS `VoiceLatencyConfig.regexFastEnabled` compile-time flag — set per-build. Default `false`. TestFlight build N+1 (Stage 6) ships with `true`.

### 4.3 Capability handshake (Codex I4 — explicit behaviour for missing fields)

iOS `session_start` adds:
```json
{
  "capabilities": {
    "voice_latency": {
      "version": 1,
      "supports": ["chunked_http_audio", "source_field_in_tts_post", "regex_fast_tts", "voice_latency_ack", "kill_switch_drop_queue"]
    }
  }
}
```

**Server behaviour when `msg.capabilities.voice_latency` is missing or `version: 0`:**
- Treat as `supports: []`.
- All capability-gated features default to `false` for the session.
- Server still parses `req.body.source` defensively; missing → default `'confirmation'`.
- Server returns chunked HTTP responses ONLY if `chunked_http_audio ∈ supports`. Otherwise accumulate-then-respond (safe for old builds).

Tests required (Codex I4):
- `capability_handshake.test.js`: missing `capabilities`, `version: 0`, unknown supports string, mismatched server-flag + client-capability, `supports` non-array.

### 4.4 `source` field on TTS POST (Claude B1 — new commit)

iOS `CertMateUnified/Sources/Services/APIClient.swift` — `proxyElevenLabsTTS(text:sessionId:source:)`:
```swift
enum TTSSource: String {
  case confirmation, correction, question
}
```

`AlertManager.swift` callers:
- Confirmation playback (called from `result.confirmations[]` handler) → `source: .confirmation`.
- Correction playback (called from same flow with `correction` marker) → `source: .correction`.
- ask_user TTS (called from `ask_user_started` handler) → `source: .question`.

Backend `src/routes/keys.js:223–290`:
```js
const { text, sessionId, source = 'confirmation' } = req.body;
```

Old iOS builds (no `source` field) → defaults to `'confirmation'`. Tests:
- `keys.test.js`: missing source → `confirmation`; `correction` bypasses suppression; `question` routed to ask_user logic when Stage 5 ships.

### 4.5 `field_corrected` backend emission (Claude B2 — new commit)

Backend currently has `src/extraction/stage6-dispatchers-circuit.js` `dispatchClearReading` + same-turn correction in `src/extraction/stage6-per-turn-writes.js`. Neither emits a WS event today; iOS handler at `Stage6Messages.swift:132` is dead code.

New emissions:
- In `dispatchClearReading`: after the write succeeds, push `{type: 'field_corrected', circuit, field, previousValue, newValue: null}` to the session's WS event queue.
- In same-turn correction path: same shape, with both values.

iOS handler already exists, so no iOS change needed (the dead consumer becomes a live consumer — verify the handler signature matches the emitted payload).

Tests:
- `stage6-dispatchers-circuit.test.js` — assert emission on clear.
- `stage6-per-turn-writes.test.js` — assert emission on overwrite.
- iOS `Stage6MessagesTests` — assert handler invoked with correct payload.

### 4.6 Session entry — snapshot + correlation registry

`active-sessions.js` extensions:
```js
session.voiceLatency = {
  flags: { /* snapshot of 5 per-session flags */ },
  capabilities: msg.capabilities?.voice_latency ?? { version: 0, supports: [] },
  startupLog: { flagSnapshot, iosBuildString, backendCommit, multiContextDecision },
  reservations: new Map(), // suppression key → reservation record
  iosAcks: new Map(), // correlationId → ack timestamp
};
```

### 4.7 Commits (Stage 1)

| # | Commit subject | Files |
|---|---|---|
| 1.1 | `feat(voice-latency): telemetry module, correlation IDs, hop list, server-side outcome enum (no-op until stages enable)` | `src/extraction/voice-latency-telemetry.js` (new) + tests; `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift` (new) + tests |
| 1.2 | `feat(voice-latency): per-session-snapshotted feature flags + live-override kill switch` | `src/extraction/active-sessions.js` (modify); `src/extraction/sonnet-stream.js` (read flags on session_start); `ecs/task-def-backend.json` (add 6 env vars all defaulted `false`); `CertMateUnified/Sources/Configuration/VoiceLatencyConfig.swift` (new) |
| 1.3 | `feat(voice-latency): protocol capability handshake (defensive defaults for missing fields)` | `src/extraction/sonnet-stream.js` (modify); `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (modify `sendSessionStart`); tests including the I4-mandated edge cases |
| 1.4 | `feat(voice-latency): startup-log of effective flags + capabilities + multi-context decision per session` | `src/extraction/sonnet-stream.js` (modify) |
| 1.5 | `feat(voice-latency): source field in TTS POST (iOS sends, backend defaults to confirmation when missing)` | `src/routes/keys.js` (modify); `CertMateUnified/Sources/Services/APIClient.swift` (modify); `CertMateUnified/Sources/Recording/AlertManager.swift` (modify caller sites); tests |
| 1.6 | `feat(stage6): emit field_corrected from dispatchClearReading + same-turn correction` | `src/extraction/stage6-dispatchers-circuit.js` (modify); `src/extraction/stage6-per-turn-writes.js` (modify); `src/extraction/sonnet-stream.js` (wire emission to WS); iOS test only (handler verification, no code change); backend tests |
| 1.7 | `feat(voice-latency): iOS playback ack message + WS roundtrip` | `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift` (extend with `sendAck`); `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (add `sendVoiceLatencyAck`); `src/extraction/sonnet-stream.js` (handle inbound `voice_latency_ack`); tests |

**Verification gate Stage 1 → Stage 2:**
- All 7 commits land on `main`.
- Run a real session with all 5 snapshot flags `false`. CloudWatch shows `voice_latency.startup_log` per session_start; no behaviour change vs baseline.
- `scripts/check-task-def-env-drift.sh` passes in CI for all 6 env vars.
- `field_corrected` event emits and is consumed on iOS (manually trigger a `clear_reading` via existing UI; verify the iOS handler logs).
- Old TestFlight build (without capability bits) still works against new backend (smoke test).

---

## 5. Stage 2 — Strategy C iOS playback + stream confirmations (re-scoped)

**Goal:**
1. iOS playback rebuilt on `AVAudioEngine + AVAudioPlayerNode` so chunked MP3 plays as it arrives (first-frame latency ~50 ms after first chunk).
2. Backend `/api/proxy/elevenlabs-tts` switches confirmation synthesis to `stream-input` (`source === 'confirmation'`).

After Stage 2: audible-confirmation latency goes from ~3 s today to ~2.0–2.5 s (cold WS) or ~1.2–1.5 s (warm, if 0.F enables multi-context). Honest target — see §2 budget.

### 5.1 iOS Strategy C playback

`CertMateUnified/Sources/Recording/AlertManager.swift` rewrites the TTS playback path:

- New `StreamingAudioPlayer` (own file: `CertMateUnified/Sources/Audio/StreamingAudioPlayer.swift`):
  - `AVAudioEngine` + `AVAudioPlayerNode` + `AVAudioMixerNode`.
  - `AVAudioConverter` configured for MP3 input (constructed via `AVAudioFormat(streamDescription: ...)` for `kAudioFormatMPEGLayer3`) → PCM Float32 output at 22.05 kHz mono.
  - `ingest(_ data: Data)` accepts MP3 byte chunks as they arrive from URLSession.
  - Internal MPEG frame parser (MP3 frame sync words `0xFF 0xFB` etc.) detects complete frames; passes complete frames to converter.
  - Converted PCM scheduled via `playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack)`.
  - First frame scheduled → records `ios_first_pcm_frame_scheduled` hop.
  - `dataPlayedBack` callback → records `ios_dataPlayedBack` hop. This is the **measurable first-audible-frame** (Claude B3 fix).
  - On all-chunks-played: records `ios_playback_complete`; AlertManager fires the `voice_latency_ack` message back to backend.
- AlertManager's existing `audioPlayer: AVAudioPlayer` is retired in favour of `StreamingAudioPlayer`. Existing queue/defer logic is preserved.
- Mic-pause coupling (Codex I8): `pauseAudioStream()` moves to be called when StreamingAudioPlayer schedules its FIRST buffer (i.e. on `ios_first_pcm_frame_scheduled`), not on object construction. `resumeAudioStream()` on `ios_playback_complete`.

iOS test surface:
- Unit: parse known MP3 frames from `tests/fixtures/elevenlabs-mp3-chunks/` (synthetic, see §10.5); assert frame boundaries, conversion success, scheduling order.
- Integration: feed StreamingAudioPlayer a synthetic chunked stream (deferred URLProtocol mock) and assert `dataPlayedBack` fires within target latency.

### 5.2 Backend `stream-input` for confirmations

Module: `src/extraction/elevenlabs-stream-client.js` (revised vs PLAN.md §5.1):

- One **standalone** `stream-input` WS per logical synth request (no pool unless 0.F passed and `VOICE_LATENCY_USE_MULTI_CONTEXT=true`).
- BOS: `{text: ' ', voice_settings: {...pinned settings 1.4}}`.
- After BOS sent → immediately follow with the synth text + flush + EOS in one batch (no inter-request keep-alive needed since the WS lives only for this synth).
- onAudio chunks piped to caller (chunked HTTP response).
- onError → reject caller promise; caller decides fallback.
- No reconnect-and-replay — too risky for single-shot synth (per Research APIs §A.5 reconnect is not documented and the failure mode is acceptable).
- **Idempotency** (Claude I5): keyed `confirm:<contentHash>` (content-derived). 5-second in-flight dedupe only (NOT 30-second cache of audio buffer — too memory-heavy, too rare to be worth the complexity). Concurrent identical requests within 5 s share the same WS; second caller waits on first's completion.

`src/routes/keys.js:223–290` modifications:
1. Read `source` from body (defaults `confirmation`).
2. Generate correlation ID.
3. **Suppression check** (Stage 3): if `source === 'confirmation' AND VOICE_LATENCY_SUPPRESSION=true AND VOICE_LATENCY_STREAM_CONFIRMATIONS=true`:
   - Attempt to acquire reservation via suppression store. If existing entry in `synthesising | first_byte | sent_to_client` state for same key, return 204 with `X-Voice-Latency-Decision: suppressed_in_flight`.
   - If existing entry in `suppression_active` (terminal), return 204 with `X-Voice-Latency-Decision: suppressed`.
   - Otherwise acquire reservation, set state to `reserved`.
4. **If `VOICE_LATENCY_STREAM_CONFIRMATIONS=false`** (or capability not advertised): fall through to existing batch HTTP path. No suppression interaction.
5. **If `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` AND capability advertised**:
   - Open `ElevenLabsStreamClient`.
   - Set HTTP response headers: `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`, `X-Voice-Latency-Correlation-Id: <id>`.
   - Pipe `onAudio → res.write`.
   - On `vendor_first_audio`: transition reservation `reserved → first_byte` (per Codex B2 reservation states).
   - On `vendor_isFinal`: `res.end()`; transition reservation → `sent_to_client`.
   - On `voice_latency_ack` arriving from iOS for this correlation ID: transition `sent_to_client → suppression_active` with 12 s TTL.
6. On any error after reservation acquired: transition reservation → `cancelled`; remove from store immediately (no terminal TTL).

### 5.3 No multi-context — yet

Stage 2 ships single-WS-per-request. Multi-context is Stage 4.X follow-on if 0.F passes. Acceptable Stage 2 latency is 2.0–2.5 s; this is honest.

### 5.4 Codex angles addressed in Stage 2

| # | Angle | Stage 2 mechanism |
|---|---|---|
| #1 | Fast-path overtakes Sonnet | N/A in Stage 2 (no fast-path yet). Single-lane queue in AlertManager is preserved. |
| #3 | Sonnet text streams obsolete content | N/A — confirmation text is post-hoc; Sonnet text isn't streamed here. |
| #5 | Mic feedback during chunked TTS | New: `pauseAudioStream` moved to first-scheduled-buffer (§5.1 final bullet). |
| #6 | iOS playback latency | Stage 0.A measures Strategy C → first-frame ~50 ms target. |
| #7 | BT route change | Telemetry hop `voice_latency.audio_session_route_changed` (iOS side, fires on `AVAudioSession.routeChangeNotification`). |
| #9 | Double spend | 5 s in-flight dedupe (NOT replay cache). Cost ceiling: identical text within 5 s = one synth. |
| #10 | Obsolete tokens | N/A in Stage 2. |
| #13 | Success-only telemetry | iOS ack required for `fast_heard` (n/a here, but `synth_complete` ≠ `client_played`). |
| #14 | Mixed clocks | Monotonic only. |
| #16 | Mid-session flag flip | Flags snapshotted at session start. |
| #22 | Voice drift | Voice settings + model pinned identically to today's path (1.4). |

### 5.5 Commits (Stage 2)

| # | Commit subject | Files |
|---|---|---|
| 2.1 | `feat(voice-latency-ios): StreamingAudioPlayer (AVAudioEngine + AVAudioPlayerNode + AVAudioConverter MP3→PCM)` | `CertMateUnified/Sources/Audio/StreamingAudioPlayer.swift` (new) + tests with synthetic MP3 fixtures |
| 2.2 | `feat(voice-latency-ios): AlertManager swaps AVAudioPlayer for StreamingAudioPlayer; mic-pause coupled to first scheduled frame` | `CertMateUnified/Sources/Recording/AlertManager.swift` (modify) + tests |
| 2.3 | `feat(voice-latency): ElevenLabsStreamClient (single-shot per synth, 5s in-flight dedupe)` | `src/extraction/elevenlabs-stream-client.js` (new) + tests |
| 2.4 | `feat(voice-latency): /api/proxy/elevenlabs-tts streams confirmations via stream-input behind flag` | `src/routes/keys.js` (modify lines 223–290) + tests including failure modes |
| 2.5 | `chore(voice-latency): VOICE_LATENCY_STREAM_CONFIRMATIONS env var default false in task-def-backend.json` | `ecs/task-def-backend.json` |

**Verification gate Stage 2 → Stage 3:**
- Real session with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` + iOS Build N (with capability bits).
- Telemetry: P50 audible-confirmation latency 2.0–2.5 s (or 1.2–1.5 s if 0.F passed and multi-context ships in Stage 4 prep).
- ElevenLabs cost-tracker reports correct character count.
- Zero `discrepancy_overwrite` regressions vs baseline.
- iOS playback ack arrives for every synthesised confirmation; no `synth_complete` without corresponding `fast_heard` in steady state.

---

## 6. Stage 3 — Server-side suppression with reservation states (Codex B2 rewrite)

**Goal:** when Stage 4 ships, Sonnet's duplicate confirmation gets swallowed correctly. Stage 3 ships BEFORE Stage 4 to prove the machinery against zero sources of duplication (suppression rate baseline = 0%).

### 6.1 Reservation-state machine

Replaces PLAN.md §6.2 single-TTL model. The store is now a state-machine per key.

**States:**
- `reserved` — acquired BEFORE vendor call. Blocks concurrent acquisition for same key (`req.body.source ∈ {confirmation, regex_fast}`). Acquired in ~10 µs (in-memory map + async-mutex per key).
- `synthesising` — vendor synth started (we sent text).
- `first_byte` — `vendor_first_audio` received from ElevenLabs.
- `sent_to_client` — `vendor_isFinal` received; chunked HTTP response complete.
- `suppression_active` — iOS sent `voice_latency_ack` confirming `fast_heard`. TTL 12 s starts here.
- `cancelled` — terminal failure or kill switch; immediate removal.
- `expired` — 12 s TTL elapsed; immediate removal.

**Suppression decision tree** (when handling new `confirmation` or `regex_fast` request for same key):
- State `reserved` | `synthesising` | `first_byte`: return `suppressed_in_flight`. New caller waits up to 3 s for state to advance; if it reaches `suppression_active`, returns `suppressed`. If it reaches `cancelled`, new caller can acquire reservation.
- State `sent_to_client`: return `suppressed_pending_ack`. Hold for up to 1.5 s for iOS ack; if ack arrives → `suppressed`; if not → cancel old, acquire new.
- State `suppression_active`: return `suppressed`.

**Correction class** (Codex B3 partial + I19): when `req.body.source === 'correction'`, ALWAYS bypass suppression check. Additionally, on entering `dispatchClearReading` / same-turn correction: invalidate (remove) all suppression entries matching prefix `sup_<sessionId>_*_<circuitRef>_<field>_*`. Codex B2 mitigation — correction is the one path that genuinely deserves a fresh audio class.

### 6.2 Canonical suppression key (Claude I4 fix)

```
sup_<sessionId>_<scopeSegment>_<circuitRef|nocircuit>_<canonicalField>_<canonicalValue>
```

Where `scopeSegment` is:
- `installation` — for installation-level fields: Ze, PFC, earthing arrangement, supply characteristics fields (sourced from `field_schema.json` `installation_details_fields`).
- `<boardId>` — for board-level fields.
- `noboard` — fallback only if no board is selected.

The `installation`/`<boardId>`/`noboard` triage runs against `field_schema.json` canonical category. New shared module `src/extraction/field-scope-classifier.js`.

### 6.3 TTL — derived from Stage 0 measurement (Codex I2)

**Default 12 s** (covers measured p99 Sonnet completion ~3 s + reasonable retest delay margin). Stage 0.B validates this number; if measured p99 > 9 s, raise to `p99 + 3 s`.

### 6.4 Suppression store implementation

`src/extraction/voice-suppression-store.js`:
- `Map<sessionId, Map<key, ReservationRecord>>`.
- `async-mutex` per key for the `reserveOrSuppress(key, correlationId, source)` call. Mutex prevents Codex B2's "mutex released before synthesis completes" race by holding the mutex through the reservation transition (`reserved → synthesising`), then releasing for parallel callers to enter the wait/suppress paths.
- TTL via `setTimeout` set on transition into `suppression_active`. Cleared on early invalidation.
- Pruning on `session_end`, `select_board`, `add_board`, `field_corrected`, kill switch.

### 6.5 Telemetry at decision point (Codex I1 + Codex N4)

Every reservation attempt emits `voice_latency.suppression_decision` with:
- `decision`: `acquired | suppressed_in_flight | suppressed_pending_ack | suppressed | acquired_after_cancel`.
- `previous_state`: the state of the matched entry.
- `matched_correlation_id`: of the entry that caused suppression (for traceability).
- `time_since_matched_entry_ms`.
- `field`, `circuit`, `canonical_value`.

### 6.6 Commits (Stage 3)

| # | Commit subject | Files |
|---|---|---|
| 3.1 | `feat(voice-latency): canonical-value normaliser (shared by suppression + fast-path)` | `src/extraction/canonical-value.js` (new) + tests |
| 3.2 | `feat(voice-latency): field-scope-classifier (installation vs board vs noboard)` | `src/extraction/field-scope-classifier.js` (new) + tests |
| 3.3 | `feat(voice-latency): voice-suppression-store with reservation-state machine + per-key async-mutex` | `src/extraction/voice-suppression-store.js` (new) + tests incl. race fixtures with deterministic timing |
| 3.4 | `feat(voice-latency): suppression decision telemetry at gate entry + state transitions` | extend `src/extraction/voice-latency-telemetry.js` + integrate into store |
| 3.5 | `feat(voice-latency): invalidation hooks (select_board, add_board, field_corrected, session_end, kill_switch)` | wire into existing stage6 dispatchers + sonnet-stream session_end + kill switch handler |
| 3.6 | `feat(voice-latency): correction-class buildConfirmationText with previousValue + bypass suppression` | `src/extraction/stage6-event-bundler.js` (extend `buildConfirmationText`) + `src/routes/keys.js` modify to skip suppression when `source === 'correction'` + tests |
| 3.7 | `chore(voice-latency): VOICE_LATENCY_SUPPRESSION default false; explicit invariant that store is never read/written when off` | `ecs/task-def-backend.json` + `src/routes/keys.js` top-of-route guard + test (Claude I1) |

**Verification gate Stage 3 → Stage 4:**
- All races in §3.3 test fixtures pass deterministically.
- Suppression rate = 0% with `VOICE_LATENCY_SUPPRESSION=true` (no source of duplication yet).
- Suppression-store invariant holds: with flag false, no entries exist (test).
- TTL expiry verified at 12 s exact (test).
- Board switch invalidates entries (test, real session).
- `field_corrected` emitted at clearance → suppression entry invalidated (test).

---

## 7. Stage 4 — iOS regex-fast path (rebuilt for context-anchoring)

**Goal:** ≤700 ms audible latency on regex-eligible turns (warm WS / multi-context if 0.F passed), or ≤1.2 s cold.

### 7.1 iOS surface

Same as PLAN.md §7.1 conceptually. Adds:

- iOS includes a `transcriptContext` field in the fast-path POST with:
  - `currentBoardId` (from selected board).
  - `pendingAskMatches` — whether the current utterance maps to an active `ask_user.context_field`.
  - `wasMultiCandidate` — true if regex matched multiple fields in this utterance (Codex B3 — multi-candidate turns get rejected by eligibility).
  - `priorCorrectionInTurn` — true if the previous `field_corrected` event within 5 s was for the same field/circuit.
- iOS sends a `correlationId` on every fast-path POST. iOS waits up to 1.5 s for the chunked HTTP response, then silent-fallback (per locked decision 1.2).

### 7.2 Backend endpoint: `POST /api/voice-latency/regex-fast-tts`

`src/routes/voice-latency.js` (new). Request body:
```json
{
  "sessionId": "...",
  "correlationId": "vl_regex_...",
  "candidates": [{
    "field": "number_of_points",
    "circuit": 7,
    "boardId": "board-1",
    "rawValue": "7",
    "canonicalValue": "7",
    "confidence": 0.95
  }],
  "transcriptContext": {
    "currentBoardId": "board-1",
    "pendingAskMatches": false,
    "wasMultiCandidate": false,
    "priorCorrectionInTurn": false
  }
}
```

Server eligibility (Codex B3 fix — context anchoring):
1. Authn (sessionId belongs to caller).
2. Reject if `candidates.length > 1` (Codex B3 — no multi-candidate turns).
3. Reject if `transcriptContext.wasMultiCandidate === true`.
4. Reject if `transcriptContext.pendingAskMatches === true` but the candidate doesn't match the active ask's `context_field`.
5. Reject if `transcriptContext.priorCorrectionInTurn === true` for the same field/circuit.
6. Field must be in eligibility whitelist (§7.3).
7. `confidence >= 0.85`.
8. Canonical-value passes `field_schema.json` validation.
9. Circuit resolves against session state OR is `currentMaxCircuit + 1`.
10. `boardId` matches `currentBoardId` OR field is installation-scoped.
11. Server-side state shows NO `pending_write` for `{field, circuit, boardId}` in Stage 6 ask resolver.
12. `filled_slots_filter` says slot isn't already filled with different canonical value.
13. **Reserve suppression entry** (state `reserved`). If race-lost (concurrent Sonnet request beat us), return 204 with `X-Voice-Latency-Decision: lost_to_sonnet`.
14. Synthesise via `ElevenLabsStreamClient` (one-shot WS or multi-context if 0.F passed).
15. State transitions per §6.1.

On synth completion + iOS ack: state → `suppression_active`, TTL 12 s.

### 7.3 Whitelist — rebuilt from `field_schema.json`

| Field (canonical from `field_schema.json`) | Eligible? | Notes |
|---|---|---|
| `number_of_points` | ✅ | Integer; iOS regex is reliable per HANDOFF.md production logs. |
| `measured_zs_ohm` | ✅ | Decimal Ohms. |
| `r1_plus_r2` (formerly `r1_r2_ohm`) | ✅ | Decimal Ohms. Use canonical key per `field_schema.json`. |
| `polarity_confirmed` | ✅ (with stricter anchor) | Eligibility requires explicit `circuit N polarity confirmed` phrasing; bare `polarity confirmed` → reject (Codex I6). |
| `iso_l_pe`, `iso_l_n`, `iso_n_pe` | ✅ | Decimal MOhms or LIM sentinel. |
| `earth_loop_impedance_ze` | ✅ | Installation-level scope. |
| `prospective_fault_current` | ✅ | Installation-level scope. |
| `ring_r1_ohm`, `ring_r2_ohm`, `ring_rn_ohm` | ❌ deferred to 4.5 | Codex I6 — common but precision in iOS regex needs validation before. |
| All others | ❌ | Future broadening based on production telemetry. |

`voice-fast-eligibility.js` exposes `isFastEligible(field, value, schemaCategory)` and `getScope(field) → 'installation' | 'board'` (from `field-scope-classifier.js`).

### 7.4 Race catalogue (rebuilt — now 7 cases, Codex I6 + Claude I9)

**R1 — Sonnet vs fast-path:** Mutex on key. First to acquire `reserved` state wins. Loser returns 204 with `lost_to_sonnet` or `lost_to_fast`.

**R2 — Two consecutive fast-path requests, different fields:** No collision (different keys). Both proceed.

**R3 — Two consecutive fast-path requests, same field/circuit/value (e.g. inspector re-states):** Second hits `reserved | synthesising | first_byte` state → `suppressed_in_flight`. Inspector hears the FIRST one only. Acceptable.

**R4 — Pending ask interrupts:** Eligibility rejects (step 4).

**R5 — Sonnet later corrects/rejects:** `field_corrected` event invalidates suppression entry. Correction-class TTS plays. Inspector audibly hears the correction.

**R6 — Pool/multi-context eviction mid-fast-path:** Only applies if 0.F passed. Reference-count contexts; eviction respects in-flight requests. Test fixture.

**R7 — Kill switch flipped mid-stream:** All open ElevenLabs WSes cancelled within ~50 ms. Server emits `voice_latency_kill_switch_active` over iOS WS → iOS `AlertManager` drops queued StreamingAudioPlayer scheduled buffers. Test fixture.

Stage 4 test surface includes one explicit deterministic test per race (Claude I9).

### 7.5 Multi-context use (Stage 0.F gate)

If `VOICE_LATENCY_USE_MULTI_CONTEXT=true` (Stage 0.F passed):
- Single `multi-stream-input` WS per session, opened on first fast-path or confirmation request.
- Each synth = new `context_id`.
- Audio frames carry `context_id` → routed to the correct correlation ID.
- Voice continuity: same WS, same voice settings, no inter-request drift (verified in Stage 0.F).
- BOS amortised once per session.
- Eviction: pool entry closed on session_end OR 120 s of no contexts (Codex N5 — extended from 60 s).

If `VOICE_LATENCY_USE_MULTI_CONTEXT=false`:
- One-shot `stream-input` WS per synth.
- 800 ms BOS on every synth.

### 7.6 Commits (Stage 4)

| # | Commit subject | Files |
|---|---|---|
| 4.1 | `feat(voice-latency): voice-fast-eligibility module — schema-driven + transcript-context-anchoring` | `src/extraction/voice-fast-eligibility.js` (new) + tests |
| 4.2 | `feat(voice-latency): POST /api/voice-latency/regex-fast-tts endpoint with full eligibility chain` | `src/routes/voice-latency.js` (new) + integration tests for races R1, R2, R3, R4 |
| 4.3 | (conditional, Stage 0.F passed) `feat(voice-latency): multi-context-stream-input pool with per-context routing` | `src/extraction/elevenlabs-multi-context-pool.js` (new) + tests for races R6 |
| 4.4 | `feat(voice-latency): kill switch cancels in-flight ElevenLabs WSes; emits voice_latency_kill_switch_active` | extend `voice-suppression-store.js` + `elevenlabs-stream-client.js` + race R7 test |
| 4.5 | `feat(voice-latency-ios): regex match → fast-path HTTP POST in parallel with WS send; 1.5s timeout silent fallback` | `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift` (modify); `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` (modify); `CertMateUnified/Sources/Services/APIClient.swift` (modify) + tests |
| 4.6 | `feat(voice-latency-ios): transcript-context anchoring fields in fast-path POST` | extend matcher + DRVM + APIClient + tests |
| 4.7 | `feat(voice-latency-ios): correlation-ID drop + kill_switch queue drop in AlertManager` | modify `CertMateUnified/Sources/Recording/AlertManager.swift` + tests |
| 4.8 | `feat(voice-latency-ios): VoiceLatencyConfig.regexFastEnabled compile-time flag default false` | `CertMateUnified/Sources/Configuration/VoiceLatencyConfig.swift` (modify) |

**Verification gate Stage 4 → Stage 5:**
- Field-test TestFlight Build N+1 with `regexFastEnabled=true` + backend `VOICE_LATENCY_REGEX_FAST_TTS=true`.
- Sample of 10 number_of_points + 10 Zs + 10 R1+R2 reads. Telemetry shows ≥80% reach `fast_heard` outcome.
- P50 audible-latency: ≤700 ms (warm/multi-context) OR ≤1,200 ms (cold/one-shot WS).
- Suppression rate (Sonnet's duplicate confirmation) ≥90% of `fast_heard` outcomes.
- Zero double-readbacks in Derek's 20-minute field session review.
- All 7 race tests pass deterministically.

---

## 8. Stage 5 — Stream ask_user.question (re-scoped per Codex I5)

**Goal:** start TTSing Sonnet's clarification question as it streams. Drops question latency from ~3 s to ~1.4 s. Optional; ship if Stages 1–4 land smoothly.

### 8.1 Implementation — string-field extractor over accumulating buffer (Codex I5)

Drop the streaming JSON parser approach. Use a focused string extractor (state machine over the `partial_json` buffer) that:
- Accumulates `input_json_delta.partial_json` strings.
- Looks for the `"question": "` marker.
- After the marker, emits string content character-by-character until the closing unescaped `"`.
- Handles escape sequences (`\"`, `\\`, `\n`, `\u00XX`).

Implementation: `src/extraction/streaming-json-string-field.js`. No external dependency.

### 8.2 Hold audio until `content_block_stop` (Codex I5)

Even with streaming extraction, we **do not flush audio to iOS until `content_block_stop` fires for the tool_use block**. Reasoning: if Sonnet aborts mid-stream, iOS would hear a half-question. The 500 ms hold-back from PLAN.md §8 was insufficient.

Concrete:
- Send text deltas to ElevenLabs `stream-input` as they arrive (so the vendor synthesises in parallel).
- Buffer ElevenLabs audio output server-side.
- On `content_block_stop` for the tool_use: flush audio buffer to iOS chunked HTTP response.
- On Sonnet abort / mid-stream error: discard buffer; iOS hears nothing; Sonnet's recovery loop generates a fresh ask_user.

Net latency: ElevenLabs synthesis happens IN PARALLEL with Sonnet generation, so when `content_block_stop` fires the audio is already ready. Net first-audible ≈ `content_block_stop` time ≈ ~1.4 s (Sonnet TTFT 0.7 s + finalisation 0.5 s + flush 0.2 s).

### 8.3 SSML for prosody (Claude N2)

Set `enable_ssml_parsing=true` on the ElevenLabs WS for ask_user questions. Sonnet won't emit SSML, but ensures punctuation prosody is properly applied.

### 8.4 Commits (Stage 5)

| # | Commit subject | Files |
|---|---|---|
| 5.1 | `feat(voice-latency): string-field extractor over accumulating partial_json buffer` | `src/extraction/streaming-json-string-field.js` (new) + tests including escape sequences, multi-block, abort mid-string |
| 5.2 | `feat(voice-latency): stream ask_user.question into ElevenLabs WS, hold audio until content_block_stop` | `src/extraction/stage6-tool-loop.js` (modify around line 197) + integration tests with mocked Anthropic stream + ElevenLabs WS |
| 5.3 | `chore(voice-latency): VOICE_LATENCY_STREAM_ASK_USER default false` | `ecs/task-def-backend.json` |

**Verification gate Stage 5 → Stage 6:**
- Replay 20 production ask_user turns. P50 question latency < 1.4 s.
- Abort fixture: Sonnet aborts mid-stream → iOS hears nothing (zero half-questions in 100 abort fixtures).

---

## 9. Stage 6 — Rollout

### 9.1 Order (revised per Claude I1)

1. **Land Stages 1–4 on `main`** with all flags `false`. CI green. iOS TestFlight Build N ships with capability bits but `regexFastEnabled=false`.
2. **Verification soak**: 24 h normal usage. Confirm zero impact (telemetry shows new paths not exercised).
3. **Flip `VOICE_LATENCY_SUPPRESSION=true`** FIRST (claim Claude I1). With no sources of duplication, suppression rate = 0%. Confirms machinery is wired correctly.
4. **24 h soak.** Verify suppression-store invariant: zero terminal entries.
5. **Flip `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`.** Stage 2 live. Telemetry shows latency drop on confirmation hops.
6. **24 h soak.** Compare P50 latency vs baseline.
7. **(Conditional)** if Stage 0.F passed: flip `VOICE_LATENCY_USE_MULTI_CONTEXT=true`. Verify pool warm-up + BOS amortisation.
8. **iOS TestFlight Build N+1** ships with `regexFastEnabled=true`. Concurrently flip `VOICE_LATENCY_REGEX_FAST_TTS=true`.
9. **Field test on Derek's iPad**: 10 reads per fast-eligible field per audio route (built-in speaker, AirPods, BT headset, wired) — Codex angle #7.
10. **(Optional)** Flip `VOICE_LATENCY_STREAM_ASK_USER=true` after Stage 5 lands.

### 9.2 Kill switch verification (Codex I10)

Mandatory before declaring sprint done:
1. Mid-session: set `VOICE_LATENCY_KILL_SWITCH=true` while a confirmation is synthesising.
2. Verify: ElevenLabs WS closes within ~50 ms.
3. Verify: iOS receives `voice_latency_kill_switch_active` over WS; drops queued StreamingAudioPlayer buffers.
4. Verify: next confirmation goes through legacy batch path.
5. Set `KILL_SWITCH=false`. Verify streaming resumes.

### 9.3 Cost monitoring (Claude I10 — threshold raised)

`scripts/voice-latency-bench/weekly_cost_check.sh` (CHANGED from daily — Claude I10):
- Fetches ElevenLabs usage from their API + our `cost-tracker.js` totals.
- Alerts only if discrepancy > 30% AND > $5/week absolute (filters noise on small daily volume).
- Cron: weekly Monday 9 AM.

### 9.4 Rollback strategy

- **Per-flag rollback**: flip individual flag to `false` via task-def commit + CI deploy. Each flag's code path falls through to pre-stage behaviour.
- **Whole-feature instant rollback**: `VOICE_LATENCY_KILL_SWITCH=true`. Live override, no deploy needed (env var reload requires container restart in current ECS setup — alternatively, hot-reload by re-deploying task def, ~5 min).
- **Code revert**: each commit independent; `git revert` works.
- **iOS rollback**: previous TestFlight build (Build N or earlier) remains valid; backend remains compatible via capability handshake.

### 9.5 Commits (Stage 6)

| # | Commit subject | Files |
|---|---|---|
| 6.1 | `chore(voice-latency): flip VOICE_LATENCY_SUPPRESSION=true` | `ecs/task-def-backend.json` |
| 6.2 | `chore(voice-latency): flip VOICE_LATENCY_STREAM_CONFIRMATIONS=true` | `ecs/task-def-backend.json` |
| 6.3 | (conditional) `chore(voice-latency): flip VOICE_LATENCY_USE_MULTI_CONTEXT=true after 0.F passed` | `ecs/task-def-backend.json` |
| 6.4 | `chore(voice-latency): flip VOICE_LATENCY_REGEX_FAST_TTS=true + iOS regexFastEnabled=true on Build N+1` | `ecs/task-def-backend.json` + `CertMateUnified/Sources/Configuration/VoiceLatencyConfig.swift` |
| 6.5 | `chore(voice-latency): weekly ElevenLabs cost reconciliation cron` | `scripts/voice-latency-bench/weekly_cost_check.sh` (new) + README |
| 6.6 | (optional) `chore(voice-latency): flip VOICE_LATENCY_STREAM_ASK_USER=true` | `ecs/task-def-backend.json` |

---

## 10. Testing strategy (refined per Claude I9 + Codex I9)

### 10.1 Unit tests

- `elevenlabs-stream-client.test.js`: BOS shape, error path, 5 s in-flight dedupe, no-replay-on-drop.
- `elevenlabs-multi-context-pool.test.js` (conditional on 0.F): context allocation, eviction with ref-counting, BOS amortisation.
- `voice-suppression-store.test.js`: reservation states + transitions, async-mutex correctness under concurrency (jest's `concurrent` tests), TTL, invalidation, no-cross-session-leak.
- `voice-fast-eligibility.test.js`: whitelist, confidence floor, multi-candidate rejection, pending_ask anchoring, prior-correction rejection, filled-slot rejection, board mismatch.
- `voice-ws-pool.test.js`: (conditional) ref-counting, in-flight protection from eviction.
- `streaming-json-string-field.test.js`: escapes, multi-block, abort mid-string.
- `canonical-value.test.js`: numeric rounding, sentinels, enum lowercasing.
- `field-scope-classifier.test.js`: installation vs board scope from schema.
- iOS `StreamingAudioPlayerTests`: MP3 frame parsing, chunked decode, `dataPlayedBack` callback timing.
- iOS `VoiceLatencyTelemetryTests`: hop ordering, correlation IDs, ack format.

### 10.2 Integration tests (deterministic timing fixtures, NOT live API)

Per Codex I9 — synthetic protocol fixtures, not live ElevenLabs traces.

- `voice-latency-r1-sonnet-vs-fast.test.js`: deterministic race, mutex correctness.
- `voice-latency-r2-two-fast-different-fields.test.js`: no collision.
- `voice-latency-r3-two-fast-same-field.test.js`: second `suppressed_in_flight`.
- `voice-latency-r4-pending-ask.test.js`: fast-path rejects.
- `voice-latency-r5-correction-class.test.js`: correction bypasses suppression; invalidates prior entry.
- `voice-latency-r6-pool-eviction.test.js`: (conditional) ref-counted protection.
- `voice-latency-r7-kill-switch-mid-stream.test.js`: cancellation propagates.
- `voice-latency-stage2-stream-confirmations.test.js`: end-to-end with mocked Anthropic + mocked ElevenLabs WS.
- `voice-latency-stage5-ask-user-streaming.test.js`: streaming JSON extraction + hold-until-stop + abort discard.
- `voice-latency-capability-handshake-edge-cases.test.js`: missing capabilities (Codex I4), missing source field, unknown supports.

### 10.3 iOS tests

- `TranscriptFieldMatcherTests`: regex confidence threshold extended for fast-eligible fields, canonical value emission.
- `AlertManagerTests`: chunked-HTTP receipt, mic-pause-on-first-frame, drop-on-correlation-id-mismatch, drop-on-kill-switch.
- `APIClientTests`: `proxyElevenLabsTTS(text:sessionId:source:)` round-trip, missing-source default.

### 10.4 Field tests (Derek's iPad + iPhone)

- Pre-Stage 2 baseline: 5 sessions × ~50 reads. Capture P50 audible-confirmation latency.
- Post-Stage 2: same protocol. Expect 2.0–2.5 s P50 (cold) or 1.2–1.5 s (warm/multi-context).
- Post-Stage 4: 10 reads × 5 fast-eligible fields × 4 audio routes (Codex #7).
- Kill switch test.

### 10.5 Test fixtures (Codex I9 — synthetic only)

Synthetic MP3 chunk fixtures in `tests/fixtures/voice-latency/`:
- `synthetic-mp3-frames/` — known-good MP3 frames built with `ffmpeg` from a 1-second sine wave. NOT real ElevenLabs traces. Tests parser and decoder behaviour.
- `mock-elevenlabs-protocol/` — JSON files describing BOS/text/audio/isFinal sequences. Asserts state-machine behaviour without vendor coupling.
- `mock-anthropic-stream/` — SSE event sequences for tool_use, text-then-tool, abort-mid-stream.

NO captured audio bytes from real inspector sessions (Codex I9 — accidentally committing paid voice data of an inspection phrase is a privacy concern too).

---

## 11. Documentation

| Doc | Update |
|---|---|
| `docs/reference/ios-pipeline.md` | New "Voice latency optimisation" section. Link to ADR-009. |
| `docs/adr/` | New `ADR-009-voice-latency-streaming-tts.md`. **Verify `docs/adr/` exists first** (Claude N6). If not, create. |
| `EICR_Automation/CLAUDE.md` Changelog | One row per stage. |
| `CertMateUnified/CLAUDE.md` | Update "Recording pipeline" with fast-path branch. |
| `docs/reference/changelog.md` | Full commit-body-level entries. |
| `docs/reference/architecture.md` | ElevenLabs streaming + suppression in AI Models / Costs section. |
| `docs/reference/voice-latency.md` | NEW — comprehensive reference doc post-sprint. |

---

## 12. Open questions deferred (consolidated)

Items the reviews flagged that should be resolved by Derek BEFORE Stage 0 execution starts:

1. **Stage 0.F (multi-context) — is the engineering investment worth it?** Multi-context unlocks the warm-WS latency benefit. If 0.F fails, sprint still delivers but Stage 4 cold P50 is ~1.2 s instead of ~450 ms. Derek decides whether to budget Stage 0.F's protocol investigation (~half day).
2. **Strategy C iOS rework — significant scope.** ~1–2 days of iOS work to build `StreamingAudioPlayer`. Confirm Derek has bandwidth, or split into a separate sprint.
3. **Capacity for the full sprint:** with 7 BLOCKERs caught in review + the additional iOS Strategy C work, the sprint is genuinely larger than initially scoped. Realistic estimate: ~1.5–2 weeks of focused work, not "one day." Derek confirms timeline tolerance.
4. **`async-mutex` dependency** — acceptable new dep (12M weekly downloads, well-maintained) or hand-rolled? Hand-rolled is ~30 lines, no dep risk. Recommendation: hand-rolled.
5. **Single-instance suppression-store assumption** — explicit reference to source-controlled `desiredCount: 1` in `ecs/task-def-backend.json` AND a CI/deploy note that scaling past one backend requires Redis (Claude N4, Codex N4).
6. **Eligibility broadening (Stage 4.5):** ring values, additional fields. Driven by production telemetry post-Stage-4. Sprint exit doesn't gate on this.
7. **iOS playback ack** — adds a small round-trip after every playback. Acceptable overhead vs telemetry value? Recommendation: yes (telemetry depends on it for `fast_heard` outcome).

---

## 13. Exit criteria

Sprint complete when ALL:

- Stage 0 gates A, B, C, D, E pass (or replan documented).
- Stage 0.F result documented (pass → Stage 4 ships warm; fail → Stage 4 ships cold).
- All commits land on `main` per CLAUDE.md auto-commit + WHY rule.
- All tests pass: unit, integration (incl. 7 deterministic race tests), iOS unit, field tests.
- `docs/reference/ios-pipeline.md` + ADR-009 land in sprint.
- Real session telemetry shows:
  - **P50 audible-confirmation latency**: ≤ 1,000 ms (Stage 4 warm) OR ≤ 1,500 ms (Stage 4 cold). Measured iOS-side from `utterance_final` hop to `ios_dataPlayedBack`.
  - **Suppression rate** ≥ 90% of `fast_heard` outcomes.
  - **Zero double-readback** complaints from Derek's field test.
  - **ElevenLabs daily spend** < 2× pre-sprint baseline.
- Kill switch verified end-to-end (§9.2).
- One full week of normal usage with no rollback.

Honest pre-commitment: if Stage 0.F fails and Stage 4 cold path can't beat 1.2 s, the sprint's headline goal (`<700 ms`) is missed. Outcome still ships as a meaningful improvement (~60% latency reduction). Treat as success.

---

## 14. Risk register (consolidated, post-review)

| Risk | Likelihood | Impact | Mitigation | Stage |
|---|---|---|---|---|
| iOS Strategy C MP3 decoder has clicks/gaps (Stage 0.A fail) | Medium | High | Measure first; fall back to `pcm_16000` raw PCM (no decode); replan timeline | 0/2 |
| Sonnet TTFT > 1.2 s in our config | Medium | Medium | Stage 0.B; Stage 4 absorbs the slack since it skips Sonnet | 0/2 |
| ElevenLabs TTFB > 250 ms from eu-west-2 | Low | Medium | Measure; escalate | 0 |
| Voice perceived as different (Flash vs Turbo) | Low | High | Derek A/B; pin to Turbo if so | 0 |
| Multi-context protocol doesn't work as needed (Stage 0.F fail) | Medium | Medium | Stage 4 ships cold; ~1.2 s vs ~450 ms. Still 60%+ improvement | 0 |
| Sonnet/fast-path race not serialised correctly | High | Medium | async-mutex + reservation states; explicit test fixtures | 4 |
| Fast confirmation contradicted by later Sonnet ask_user | Medium | High | Context-anchoring eligibility rejects ambiguous turns | 4 |
| Two regex-fast calls out of order | High | Medium | Single per-session AlertManager queue; correlation-ID dedup | 4 |
| Older Sonnet audio queued after newer fast audio | Medium | Medium | Suppression entry invalidates old-class audio; iOS queue drops by correlation ID | 4 |
| Regex false positive (e.g. STT confused) → paid TTS | High | Low (cost) / Medium (UX) | Whitelist + 0.85 confidence floor + context anchoring | 4 |
| Double-spend on late-fail | Medium | Low | 5 s in-flight dedupe (NOT 30 s replay cache) | 2 |
| Mid-session flag flip | Low | Medium | Per-session snapshot; kill switch as live override | 1 |
| iOS chunked HTTP transport stalls | Medium | Medium | Stage 0.E gate | 0 |
| Suppression cache lost on backend restart | Low | Low | Acceptable; documented; ≤12 s dual-readback risk | 3 |
| Half-question audio (Stage 5 abort) | Low | Medium | Hold-until-content_block_stop | 5 |
| Inspector dictates during fast-TTS | Medium | Low | `shouldDeferPlayback` existing + Deepgram pause | 4 |
| BT route change mid-session | Medium | Low | Route-change telemetry + field test | 4 |
| Wire-format incompatibility with old TestFlight | Medium | High | Capability handshake + defensive defaults (Codex I4) | 1 |
| ENV flag drift task-def vs source | Low | High | Existing CI guardrail + same-commit rule | 1 |
| 2 backend instances → suppression incoherent | n/a | Future | Document as Redis-required; reference task-def `desiredCount: 1` | 3 |
| Kill switch leaves in-flight WS open | Medium | High | Codex I10 — kill switch cancels in-flight + emits `kill_switch_active` to iOS | 1/4 |
| Telemetry reports `synth_complete` but iOS never played | Medium | Medium | Codex I8 — `fast_heard` requires iOS ack | 1/4 |

---

## 15. References

- `RESEARCH_PIPELINE.md` — codebase map (file:line).
- `RESEARCH_APIS.md` — ElevenLabs + Anthropic API docs.
- `CODEX_ANGLES.md` — 22 risk angles from Codex brainstorm.
- `claude-review.md` — 3 BLOCKER / 10 IMPORTANT / 8 NIT.
- `codex-review.md` — 4 BLOCKER / 10 IMPORTANT / 5 NIT.
- `HANDOFF.md` — scope lock.
- Project + iOS `CLAUDE.md` — coding rules.

---

## 16. Codex angles traceability (22-row table per Codex I1)

| # | Angle | Mechanism in PLAN_v2 | Tests | Residual risk |
|---|---|---|---|---|
| 1 | Fast-path overtakes older Sonnet MP3 | Single AlertManager queue + correlation-ID drop on iOS + reservation states server-side | R1, R3, AlertManager queue tests | Sequence-number ordering across HTTP responses — monitored, not actively prevented |
| 2 | Suppression key collisions | Canonical key includes `sessionId, scopeSegment, circuitRef, canonicalField, canonicalValue`; scope segment installation/board/noboard | `voice-suppression-store.test.js` | Cross-session collisions impossible (sessionId in key) |
| 3 | Sonnet text streams obsolete | Confirmation text is post-hoc, not Sonnet-text-streamed. Stage 5 ask_user streaming holds audio until `content_block_stop` (no obsolete tokens reach iOS) | Stage 5 abort fixture | Aborted ask_user → silent fallback (Derek-approved) |
| 4 | ask_user + pending_write interrupted by fast confirmation | Eligibility step 4 — fast-path rejects if pending ask doesn't match candidate | R4 test | Active-ask-mismatch is recoverable; covered |
| 5 | Deepgram pause hides next utterance / readback feedback | `pauseAudioStream` repositioned to first-scheduled-frame; existing transcript fingerprint check unchanged | iOS integration tests | Long readbacks (>~5 s) could clip; fast-path readbacks are <2 s |
| 6 | MP3 playback latency on iOS | Stage 0.A measures Strategy C → first-frame ~50 ms target. Strategy C now in Stage 2 scope | iOS Strategy C tests | If Stage 0.A fails, fall back to PCM (~30 ms first-frame target) |
| 7 | BT route change mid-session | `AVAudioSession.routeChangeNotification` hop in telemetry; field test on 4 routes | Field test | Route change still mechanically changes voice timbre; mitigation is detection not prevention |
| 8 | Regex false positive → paid TTS | Whitelist + 0.85 confidence + context anchoring + canonical-drift rejection | `voice-fast-eligibility.test.js` | Field-specific regex tuning is ongoing work |
| 9 | Silent fallback double spend | 5 s in-flight dedupe + idempotency-key namespacing (`fast:` vs `confirm:`) | Idempotency tests | Different-text-but-same-confirmation paying twice — narrow window, low impact |
| 10 | Streaming Sonnet obsolete tokens | Stage 5 hold-until-stop. Stage 2 confirmation text is post-hoc (not Sonnet stream) | Stage 5 abort fixture | None known |
| 11 | Wire-format strands TestFlight | Capability handshake + defensive defaults + AND-gate on every feature | Capability edge-case tests | Old build won't break; new features just don't engage |
| 12 | Multi-board suppression | Canonical key includes `scopeSegment` (board_id for board-level fields, `installation` for installation-level) | `field-scope-classifier.test.js` + integration | Board context drift between iOS regex and backend selected-board is detected via canonical-drift rejection |
| 13 | Success-only telemetry | Outcome enum split — server `synth_complete` vs iOS `fast_heard` (requires ack) | Telemetry contract tests | Network drop after `synth_complete` but before iOS ack → counted as `synth_complete` only; visible in telemetry as gap |
| 14 | Mixed clocks | Monotonic on both sides (`process.hrtime.bigint` / `DispatchTime.now`). Cross-side reconciliation only post-hoc | Telemetry framework tests | None |
| 15 | Suppression telemetry undercounts | Decision-point logging with full candidate payload + matched-correlation-id | `suppression_decision` log tests | Pruning races (entry expired while logged) → log includes state at decision moment |
| 16 | Mid-session flag flip | Per-session snapshot at session_start; only kill switch is live override | Snapshot test | Kill switch deliberately overrides snapshot for safety |
| 17 | Backend ENV drift | Same-commit rule + `check-task-def-env-drift.sh` CI guardrail + startup-log of effective flags | CI pre-deploy gate | Drift between TestFlight build and backend is caught via capability-bit mismatch in startup log |
| 18 | Fast readback collides with next dictation | `shouldDeferPlayback` existing logic + Deepgram pause integration + Stage 0 field test on rapid-fire dictation | Field test | Short audio (~500 ms readback) may still clip if inspector resumes within 300 ms |
| 19 | Corrections audio class | Correction-class confirmation text with `previousValue` + bypass suppression + invalidate prior entry | R5 test | Correction class is explicitly first-class; covered |
| 20 | iOS regex vs backend canonical drift | iOS sends `canonicalValue`; backend re-validates via shared module; mismatch rejects | Canonical-value tests | Drift surfaces as `voice_latency.canonical_drift` rejected fast-path → Sonnet readback (slower but correct) |
| 21 | Fast-TTS bypasses Stage 6 guards | Eligibility chain explicitly mirrors `pending_write`, `filled_slots_filter`, board-match, validation — server-side, NOT iOS-side | `voice-fast-eligibility.test.js` | Logic divergence between fast-eligibility and Stage 6 dispatcher → ongoing risk; mitigated by sharing canonical modules |
| 22 | Same voice ID ≠ same voice | Voice settings + model + text-normaliser pinned. Stage 0.D field A/B before Stage 1.4 final decision. Voice continuity via single-WS-per-item OR multi-context (if 0.F) | Stage 0.D output + field test | If field A/B says voices differ, fall back to current Turbo v2.5 model |

---

## 17. NITs addressed (from both reviews)

| Source | NIT | Addressed in PLAN_v2 |
|---|---|---|
| Claude N1 | Stage 1.2 commit "feat" vs "chore" | Commit subjects in §4.7 reflect honest WHAT/WHY |
| Claude N2 | SSML for ask_user prosody | §8.3 — `enable_ssml_parsing=true` on ask_user WS |
| Claude N3 | Verify voice clone compatibility with Flash | Stage 0.D explicitly covers this in success criteria |
| Claude N4 | Telemetry hop list missing `suppression_decision` | §4.1 hop list now includes `suppression_decision` |
| Claude N5 | Pool TTL 60 s vs suppression TTL 60 s coincidence | §7.5 pool TTL 120 s vs suppression 12 s — clearly distinct |
| Claude N6 | `docs/adr/` may not exist | §11 explicitly says verify-first-and-create |
| Claude N7 | Codex #8 unmitigated for supply readings (Ze) | §7.3 whitelist requires context anchoring + canonical-drift rejection covers STT confusion |
| Claude N8 | Exit criterion measurement source ambiguous | §13 explicit: "Measured iOS-side from `utterance_final` hop to `ios_dataPlayedBack`" |
| Codex N1 | §7.1 wrong xref §7.4 → §7.3/§7.2 | Fixed implicitly by section restructure |
| Codex N2 | Wrong research citation §E vs §A.5 | Eliminated by removing reconnect-and-replay (single-shot WS); no §E/§A.5 citation needed |
| Codex N3 | "N/A — only one path" misleading | §5.4 table — angles now have specific Stage 2 mechanism, not "N/A" hand-waves |
| Codex N4 | Single-backend-instance assumption not sourced | §12 + §14 + Open Q5 explicit reference to source-controlled `desiredCount: 1` |
| Codex N5 | iOS file paths inconsistent | §1.13 lock + all §4.5+ commit tables use `CertMateUnified/Sources/...` |

---

## 18. Approval & next steps

- [ ] Derek reads PLAN_v2.md.
- [ ] Derek answers Open Questions §12 (especially Q3 — timeline).
- [ ] Derek approves OR requests revisions.
- [ ] On approval: Stage 0 begins. Stage 0 has its own go/no-go gate before Stage 1 lands.
