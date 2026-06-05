# Voice Latency Sprint — PLAN.md (draft, pre-review)

**Date:** 2026-05-23
**Status:** Draft — awaiting Claude review (`claude-review.md`) + Codex review (`codex-review.md`)
**Resume rule:** if `PLAN_v2.md` exists in this directory, that is the executable plan; this file is the pre-review draft.

---

## 0. Executive summary

Inspector-perceived audible-confirmation latency today: **~3–4 s** from utterance-final to MP3 playback. Goal: **<1 s** for Sonnet-narrated readbacks; **<700 ms** for regex-detectable readbacks (where iOS already fills the field at ~40 ms). One sprint, six staged phases. Every phase ships independently — Stage 2 alone moves the audible-latency P50 from ~3 s to ~1.2 s without touching iOS.

### What is actually happening today (corrected mental model)

1. iOS Flux STT → transcript → iOS regex matcher fills field on screen at ~40 ms.
2. iOS sends same transcript + regex hints to backend over persistent WS.
3. Backend Sonnet (Stage 6 tool loop, *already* using `messages.stream()` at `stage6-tool-loop.js:197`) emits `record_reading` tool_use; dispatcher writes.
4. Backend's **post-hoc** `stage6-event-bundler.js:66–110` `buildConfirmationText()` synthesises strings like `"Circuit 7, points 7"` and packs them into `result.confirmations[]` on the WS `extraction` message.
5. iOS receives `confirmations[]`, calls `POST /api/proxy/elevenlabs-tts` (HTTP, **batch**) with each text → backend calls ElevenLabs `eleven_turbo_v2_5` non-streaming → full MP3 buffer → returns to iOS → `AVAudioPlayer.play()`.

The 3–4 s gap is dominated by **Sonnet round-trip + post-hoc bundler + batch ElevenLabs synthesis**, in that order. Streaming Sonnet's text content blocks does *not* help confirmation latency because Sonnet does not emit the confirmation text — the bundler does. Streaming the *bundler's* text into ElevenLabs `stream-input` is what matters.

### What changes

| Phase | Change | Audible latency target | Independent ship? |
|---|---|---|---|
| **Stage 0** | Empirical measurement gates (no code) | — | n/a |
| **Stage 1** | Foundation — feature flags (source + task-def), session-snapshotted flags, protocol capability bit, telemetry correlation IDs | ~3–4 s (no change) | Yes |
| **Stage 2** | Backend swaps batch ElevenLabs for `stream-input` WS for `confirmations[]` text; chunked MP3 over existing iOS WS | **1.2–1.8 s** | Yes |
| **Stage 3** | Server-side dedup/suppression layer (session+board+circuit+field+canonical_value, idempotency keys, correction-class invalidation) | Same as Stage 2; prevents duplicates when Stage 4 ships | Yes |
| **Stage 4** | iOS `regex_fast_tts` path — iOS posts intent → backend validates via dispatcher-equivalent guards → ElevenLabs `stream-input` → iOS audio | **~700 ms** | Yes (requires Stage 3) |
| **Stage 5** | Stream `ask_user.question` text into ElevenLabs as Sonnet streams the tool_use JSON (partial-JSON extraction) | **1.0–1.4 s** for questions | Yes (optional) |
| **Stage 6** | Rollout & ramp — TestFlight build with capability bit, server-side flag default flip, kill-switch verification | — | Yes |

### Out of scope (re-stated from HANDOFF.md)

- Flux STT replacement
- On-device AVSpeechSynthesizer fallback
- The socket/second → circuit coercion in `stage6-answer-resolver.js`
- Web frontend (`web/`)
- Backend extraction-model swap (Sonnet → Haiku)
- iOS MP3 streaming via AudioQueue / AVAudioPlayerNode (kept as Stage 0 decision — see §3.A)

---

## 1. Locked decisions (cross-reference)

| # | Decision | Source |
|---|---|---|
| 1.1 | All four scope items in (regex-fast, stream Sonnet→TTS, suppress duplicates, telemetry+flags) | Derek 2026-05-23 |
| 1.2 | Silent fallback if fast TTS fails — Sonnet path catches up | Derek 2026-05-23 |
| 1.3 | Same voice / model / settings on both paths (within constraints, see 1.4) | Derek 2026-05-23 |
| 1.4 | Voice settings PINNED across both paths: `stability=0.5, similarity_boost=0.75, style=0.3, use_speaker_boost=true, speed=1.0`. Model PINNED to `eleven_flash_v2_5` (the current `eleven_turbo_v2_5` is documented by ElevenLabs as a deprecated alias for Flash v2.5 — same audio output). Text normaliser PINNED `apply_text_normalization='on'`. Pronunciation dictionary PINNED (none today, none here). | Research APIs §A.3, Codex angle #22 |
| 1.5 | Codex CLI engaged during planning (this file) AND as final reviewer (codex-review.md) | Derek 2026-05-23 |
| 1.6 | Output format PINNED `mp3_22050_32` for streaming path. Keeps iOS playback architecture (AVAudioPlayer) unchanged for Stage 0–4; iOS rework only if Stage 0 measurement shows iOS can't decode chunked frames acceptably. | Research APIs §A.6, §C.4 |
| 1.7 | Backend region: keep eu-west-2; call ElevenLabs `api.elevenlabs.io` (EU-served via global CDN per their docs — sub-region preference not exposed in WS endpoint). If Stage 0 shows >250 ms TTFB, re-evaluate. | Research APIs §A.3 |

---

## 2. Latency budget — by step, by phase

| Step | Today | Stage 2 (stream confirmations) | Stage 4 (regex-fast direct) |
|---|---|---|---|
| Utterance-final → iOS regex applied | ~40 ms | ~40 ms | ~40 ms |
| iOS regex → iOS WS send | ~5 ms | ~5 ms | ~5 ms (also fires fast path) |
| iOS WS → backend receive | ~30 ms | ~30 ms | iOS HTTP fast-path request ~50 ms |
| Backend → Anthropic (input + cache read) | ~50 ms | ~50 ms | — (skipped) |
| Anthropic TTFT (cached) | ~700–1400 ms | ~700–1400 ms | — (skipped) |
| Anthropic finalisation (tool_use complete) | +500–800 ms | +500–800 ms | — (skipped) |
| Dispatcher + bundler | ~30 ms | ~30 ms | Server-side validation ~30 ms |
| Backend → ElevenLabs HTTP batch (POST → full MP3) | **800–1500 ms** | replaced ↓ | — |
| Backend → ElevenLabs `stream-input` WS first audio | — | **150–250 ms** | **150–250 ms** |
| iOS WS chunks → AVAudioPlayer first frame | ~100 ms | ~100–200 ms (chunked MP3 buffering) | ~100–200 ms |
| **Total (audible, p50)** | **~3,200 ms** | **~1,200–1,800 ms** | **~600–700 ms** |

Two Stage 0 gates can move these numbers. Replan if either fails (§3.A).

---

## 3. Stage 0 — Measurement gates (NO CODE LANDS WITHOUT THIS)

Spend half a day measuring before writing implementation. Each gate is a script in `scripts/voice-latency-bench/`. Each script writes a JSON report into the handoff dir. All four gates must pass before Stage 1.

### 3.A iOS chunked-MP3 playback feasibility

**Why:** AVAudioPlayer does not stream MP3 — Apple docs explicit. Today AlertManager (`AlertManager.swift:1111`) instantiates `AVAudioPlayer(data: audioData)` with the *complete* MP3 blob. Stage 2 onwards delivers chunks; if AVAudioPlayer can't be coaxed into accepting growing data, we need either (a) accumulate-then-play (defeats some of the latency win), (b) AVAudioPlayerNode + AVAudioConverter (iOS rework), or (c) ATAS/AudioFileStream + AudioQueue (more iOS rework).

**Method:**
1. Branch `voice-latency-stage0-bench` on `CertMateUnified`. Add a test harness button on Settings → Debug that:
   - Connects to backend test endpoint `POST /api/test/elevenlabs-stream` (Stage 0 throwaway endpoint, gated by `STAGE0_BENCH=1` env var, removed at end of Stage 0).
   - Endpoint streams ElevenLabs `mp3_22050_32` chunks back over chunked HTTP response.
   - On iOS: try three playback strategies, time first-audible-frame and detect clicks/gaps:
     - **Strategy A:** Accumulate all chunks in `Data`, instantiate `AVAudioPlayer` when stream ends.
     - **Strategy B:** Same as A but instantiate when ≥4 frames received (~104 ms of audio).
     - **Strategy C:** `AVAudioEngine` + `AVAudioPlayerNode` + `AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 22050, channels: 1, interleaved: false)` with chunked decode via `AVAudioConverter` from MP3.
2. Test on iPhone 17 Pro + iPad Air, Wi-Fi + 4G.
3. Record TTFB (chunk arrival on iOS) and first-audible-frame for each strategy across 20 samples / device / network combo.

**Pass criteria:** at least one strategy delivers first-audible-frame ≤ 300 ms after first chunk arrival, with no clicks/gaps on iPad Air over 4G.

**Fail action:** Replan Stage 2 to use the "accumulate full MP3 server-side then send single blob" fallback (~1,800 ms target, not 1,200 ms). Stage 4 still feasible since regex-fast path is short text → short blob.

**Output:** `STAGE0_RESULTS_PLAYBACK.md` with raw timings + recommended strategy.

### 3.B Anthropic Sonnet 4.6 TTFT in our config

**Why:** Research APIs §A.3 quotes 1.42 s P50 from artificialanalysis.ai with 10k input tokens; our Stage 6 system prompt is heavier and cached. Cookbook quotes 0.71 s with caching. Until measured in *our* config we can't commit to the 1.2 s Stage 2 target.

**Method:**
1. Backend-only — node script `scripts/voice-latency-bench/measure_sonnet_ttft.js`.
2. Replay 20 production turn-1 inputs (from `session-analytics/.../debug_log.jsonl`) against the real prod prompt + cache.
3. Measure `time-to-first-content_block_delta` and `time-to-message_stop` per call.
4. Run with cache primed (call once, throwaway; then 20 timed) and cache cold (sleep 6 min between primer and run) — capture both distributions.

**Pass criteria:** P50 cached TTFT ≤ 900 ms (gives ~250 ms headroom on the 1.2 s Stage 2 target after bundler + iOS playback).

**Fail action:** if TTFT > 1.2 s P50 — Stage 2 target relaxes to 2.0 s; Stage 4 (regex-fast) becomes the only sub-1 s path and the cost-benefit of Stage 2 needs explicit reconsideration with Derek.

**Output:** `STAGE0_RESULTS_SONNET_TTFT.md`.

### 3.C ElevenLabs `stream-input` TTFB to our backend region

**Why:** Research APIs §A.3 documents 100–150 ms TTFB EU/US but doesn't measure from `ecs/eicr-cluster-production` (eu-west-2) specifically to ElevenLabs endpoints with our exact voice ID + Flash v2.5 settings.

**Method:**
1. Backend-only — node script `scripts/voice-latency-bench/measure_elevenlabs_stream.js`.
2. Open `stream-input` WS to `wss://api.elevenlabs.io/v1/text-to-speech/Fahco4VZzobUeiPqni1S/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_22050_32&auto_mode=true&inactivity_timeout=180`.
3. Send 20 typical confirmation strings (curated from prod logs — "Circuit 7, points 7", "Ze 0.13 ohms recorded", etc.).
4. Measure: WS-upgrade time, BOS-to-first-audio-frame, full synthesis time, total audio bytes.
5. Run script from a dev Mac AND from a containerised job on the ECS cluster (use `aws ecs run-task --task-definition <stage0-bench>`).

**Pass criteria:** P50 BOS-to-first-audio ≤ 250 ms from the ECS region.

**Fail action:** If >350 ms — escalate to ElevenLabs support, consider HTTP `/stream` endpoint instead (slightly higher first-audio but no WS handshake), update budget.

**Output:** `STAGE0_RESULTS_ELEVENLABS_TTFB.md`.

### 3.D Voice-fidelity A/B between current Turbo v2.5 and target Flash v2.5

**Why:** Codex angle #22 — same voice ID is not enough. Turbo v2.5 is documented as a deprecated alias for Flash v2.5; ElevenLabs claims identical audio. But the user must hear the comparison before signing off (Derek's locked decision 1.3).

**Method:**
1. Node script `scripts/voice-latency-bench/voice_ab.js` generates 10 confirmation strings × 2 models (current Turbo v2.5 + target Flash v2.5) × HTTP batch + stream-input WS. 40 MP3 files in `STAGE0_RESULTS_VOICE_AB/`.
2. Derek listens. If any sample is perceived as a different voice, Stage 1.4 decision changes.

**Pass criteria:** Derek confirms same-voice perception. If fail — pin to current Turbo v2.5 model on both paths (loses ~25 ms TTFB but preserves voice consistency); update §1.4.

**Output:** `STAGE0_RESULTS_VOICE_AB.md` with Derek's verdict.

### 3.E iOS WS chunked-MP3 transport feasibility

**Why:** Codex angle #11 — existing iOS WS path may have been tested only with whole-blob messages. Streaming MP3 chunks at 50–100/sec is a different pressure profile.

**Method:**
1. Backend-only test endpoint `POST /api/test/ws-chunk-throughput` (gated by `STAGE0_BENCH=1`, removed at Stage 0 end).
2. Sends 200 synthetic 400-byte MP3-frame-shaped chunks at 60/sec to iOS WS.
3. iOS test harness logs `chunk_received_at_us` per chunk; computes inter-arrival jitter.

**Pass criteria:** P95 inter-arrival jitter < 30 ms on iPad Air / 4G.

**Fail action:** Stage 2 falls back to whole-blob delivery (server-side accumulate) until iOS WS-flow-control work is scoped separately.

**Output:** `STAGE0_RESULTS_WS_CHUNKING.md`.

---

## 4. Stage 1 — Foundation

**Goal:** every subsequent stage can opt-in/out cleanly, can be measured, can be rolled back, and is wire-format-safe with mixed TestFlight builds.

### 4.1 Telemetry framework

New module: `src/extraction/voice-latency-telemetry.js`.

- `mintCorrelationId(sessionId, source)` → `vl_<source>_<sessionId>_<turnId>_<unique>` (UUID v4 suffix).
- `recordSpan(correlationId, hopName, startMs, endMs, meta)` — monotonic, stored in-memory per session, flushed on session close to `session-analytics/.../voice_latency.jsonl`.
- Mandatory hops (Codex angle #14): `regex_match`, `ios_ws_send`, `backend_recv`, `sonnet_ttft`, `sonnet_message_stop`, `bundler_done`, `elevenlabs_ws_open`, `elevenlabs_first_audio`, `ios_first_chunk_recv`, `ios_first_audible_frame`, `ios_playback_complete`.
- `recordOutcome(correlationId, outcome)` — terminal status. Codex angle #13 mandates explicit enum: `fast_heard`, `sonnet_fallback_heard`, `suppressed`, `dropped_stale`, `failed_before_vendor`, `failed_after_vendor`, `never_played`.

iOS side (`Sources/Services/VoiceLatencyTelemetry.swift`):
- Same correlation-ID space; iOS hops `regex_match`, `ios_ws_send`, `ios_first_chunk_recv`, `ios_first_audible_frame`, `ios_playback_complete`.
- Logged to `DebugLogger` JSONL with category `voice_latency`.
- Backend reads iOS-side hops from session analytics upload at session end; correlation across iOS + backend done post-hoc by analyzer (`scripts/analyze-session.js`).

Codex angle #14: every hop uses `process.hrtime.bigint()` server-side and `DispatchTime.now()` on iOS. No wall-clock anywhere. Cross-system reconciliation only at session-end via correlation ID, never by timestamp comparison.

### 4.2 Feature flags

ENV-var driven, sourced from `ecs/task-def-backend.json` (per the immutable-from-source rule in CLAUDE.md). All flags read once at session start and SNAPSHOTTED into the session entry — Codex angle #16 — so mid-session flips are inert.

| Flag | Default | Effect |
|---|---|---|
| `VOICE_LATENCY_STREAM_CONFIRMATIONS` | `false` | Stage 2 — backend uses ElevenLabs `stream-input` WS for `confirmations[]` instead of batch HTTP. |
| `VOICE_LATENCY_SUPPRESSION` | `false` | Stage 3 — server-side dedup gate active. |
| `VOICE_LATENCY_REGEX_FAST_TTS` | `false` | Stage 4 — backend serves the regex-fast TTS endpoint. |
| `VOICE_LATENCY_STREAM_ASK_USER` | `false` | Stage 5 — partial-JSON extraction of ask_user question. |
| `VOICE_LATENCY_KILL_SWITCH` | `false` | Hard off — disables ALL voice-latency code paths instantly, falls back to today's behaviour. Highest priority. |

iOS-side flag (Remote Config not available — use a per-build env var compiled into the bundle for now):
- `VoiceLatency.regexFastEnabled` — Bool, default `false`, set per-build in `Sources/Configuration/`. The TestFlight build with Stage 4 ready ships with `true`.

Codex angle #17: every flag added to source in the same commit that adds it to `ecs/task-def-backend.json`. The existing `scripts/check-task-def-env-drift.sh` guardrail (per CLAUDE.md MANDATORY rule) catches any drift in CI.

### 4.3 Protocol capability handshake

iOS sends, in `session_start`:
```json
{
  "capabilities": {
    "voice_latency": {
      "version": 1,
      "supports": ["stream_confirmations", "regex_fast_tts", "chunked_mp3"]
    }
  }
}
```

Backend ignores any feature in `supports` it doesn't know (future-proof). Backend's per-session SnapshotFlags AND-gates each feature flag against the matching capability. Old iOS builds without the field get current behaviour (Codex angle #11).

### 4.4 Session entry — snapshot

Augment `active-sessions.js` (already tracks per-session state) with:
```js
session.voiceLatency = {
  flags: { /* snapshot of all 5 flags */ },
  capabilities: msg.capabilities?.voice_latency || { version: 0, supports: [] },
  startupLog: {  // Codex angle #17 — log at session_start so every session can be audited
    flagSnapshot: ...,
    iosBuildString: msg.client_build,
    backendCommit: process.env.COMMIT_SHA,
  }
};
```

### 4.5 Commits (Stage 1)

| # | Commit subject | Files |
|---|---|---|
| 1.1 | `feat(voice-latency): telemetry module + correlation IDs (no-op until stages enable)` | `src/extraction/voice-latency-telemetry.js` (new), `src/extraction/voice-latency-telemetry.test.js` (new), `CertMateUnified/Sources/Services/VoiceLatencyTelemetry.swift` (new), `CertMateUnified/Tests/VoiceLatencyTelemetryTests.swift` (new) |
| 1.2 | `feat(voice-latency): feature flags in source + task-def, session snapshot` | `src/extraction/active-sessions.js` (modify), `src/extraction/sonnet-stream.js` (read flags on session_start), `ecs/task-def-backend.json` (add 5 env vars, all default `"false"`), `CertMateUnified/Sources/Configuration/VoiceLatencyConfig.swift` (new) |
| 1.3 | `feat(voice-latency): protocol capability handshake in session_start` | `src/extraction/sonnet-stream.js` (modify), `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (modify `sendSessionStart` lines 473–532 to include capabilities), tests |
| 1.4 | `feat(voice-latency): startup-log of effective flags + capabilities per session` | `src/extraction/sonnet-stream.js` (modify) |

**Verification gate Stage 1 → Stage 2:** Run a real session with all flags `false`. CloudWatch shows `voice_latency.startup_log` per session_start. No behaviour change vs baseline. `scripts/check-task-def-env-drift.sh` passes in CI.

---

## 5. Stage 2 — Stream existing confirmations via ElevenLabs `stream-input`

**Goal:** today's `confirmations[]` text is synthesised by ElevenLabs `stream-input` WS instead of batch HTTP. Audible-confirmation P50 drops from ~3 s to ~1.2–1.8 s.

**No iOS code change needed** if Stage 0.A passes Strategy A or B — backend still delivers an `audio/mpeg` HTTP response to the existing `/api/proxy/elevenlabs-tts` endpoint, but assembles it from a streaming WS source server-side. The first chunk arriving from ElevenLabs starts the HTTP response flush; iOS receives chunked HTTP rather than a single blob. If Stage 0.A required Strategy C, then iOS chunked-MP3 work goes into a separate phase (defer Stage 2 — discussed below).

### 5.1 Server-side ElevenLabs WS client wrapper

New module: `src/extraction/elevenlabs-stream-client.js`.

```
class ElevenLabsStreamClient {
  constructor({ voiceId, modelId, outputFormat, voiceSettings, apiKey })
  async open() // opens WS, sends BOS, returns when first frame received OR rejects on error
  async sendText(text) // {text: text + ' ', flush: false}
  async flush() // {text: '', flush: true}
  async eos() // {text: ''}
  onAudio(cb) // cb(Buffer) for each base64-decoded chunk
  onFinal(cb)
  onError(cb)
  keepalive() // {text: ' '} every 12s (well under 20s ElevenLabs timeout)
}
```

Implementation details (Research APIs §A.2):
- WS URL: `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_22050_32&auto_mode=true&inactivity_timeout=180`
- Auth: `xi-api-key` header on upgrade (server-side; iOS never sees the key — same as today)
- BOS: `{text: ' ', voice_settings: {...pinned settings 1.4}}` — single space literal, not empty
- Keep-alive scheduled `setInterval` 12s; cleared on `eos()` or `close()`
- Reconnect-and-replay (Codex #9, Research APIs §E): on `close` before `isFinal`, retain accumulated unsynthesised text, open new WS, replay. Hard limit: 2 reconnect attempts per logical request; after that, fail to caller. Caller's responsibility to fall back (Codex #9).
- Idempotency: every `open()` call carries an `idempotency_key` (caller-supplied UUID). Two opens with same key within 30s short-circuit to the cached audio buffer (in-memory ttl=30s) — prevents Codex angle #9 double-billing on late retries.

### 5.2 Rewire `/api/proxy/elevenlabs-tts` (in `src/routes/keys.js:223-290`)

Add a `process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS` gate at the top. When `true` (and `req.body.source` is `confirmation` — i.e., comes from a `result.confirmations[]` entry):

1. Generate correlation ID from `{sessionId, source: 'confirmation', text, timestamp}`.
2. Look up suppression cache (Stage 3) — if suppressed, return 204 with `X-Voice-Latency-Suppressed: true`. iOS skips playback.
3. Open `ElevenLabsStreamClient` with idempotency key.
4. Set response headers: `Content-Type: audio/mpeg`, `Transfer-Encoding: chunked`, `X-Voice-Latency-Correlation-Id: <id>`.
5. Pipe `onAudio(chunk) → res.write(chunk)` as chunks arrive.
6. `onFinal → res.end()`.
7. `onError → res.destroy()` and fall back to existing batch path (Codex #9 — cancel WS, charge no second call via idempotency).

iOS modifies (`AlertManager.swift:1090-1175`):
- Existing `URLSession.dataTask` for the POST already accumulates `Data` until `didCompleteWithError`. Chunked HTTP responses fill the same way — works as Strategy A (accumulate-then-play). Stage 0.A confirmed.
- If Strategy B was needed (start play at 4 frames): switch to `URLSessionDataDelegate.urlSession(_:dataTask:didReceive:)` and call a new `audioPlayer.appendData()` helper. Add to plan only if Stage 0.A demands.
- Log `ios_first_chunk_recv` on first `didReceive`, `ios_first_audible_frame` on `audioPlayerDidStart` (use KVO on AVAudioPlayer's `isPlaying`).

### 5.3 ask_user TTS unchanged in Stage 2

Stage 2 deliberately scopes to `confirmations[]` only. The `ask_user` path (`question` text) continues to use batch HTTP via the same endpoint with `req.body.source !== 'confirmation'`. Stage 5 will tackle ask_user streaming.

Rationale: confirmations are the high-volume hot path (1 per record_reading); ask_user is the lower-volume but more user-critical path (interrupts dictation). Doing them in different phases keeps the blast radius small.

### 5.4 Codex angles addressed in Stage 2

- **#1 fast-path overtakes older Sonnet MP3:** N/A — only one path in Stage 2.
- **#3 Sonnet streams obsolete text:** N/A — Sonnet's text stream isn't fed to ElevenLabs in Stage 2. Confirmation text is post-hoc from committed dispatcher writes.
- **#5 mic capture during TTS:** unchanged from today — `pauseAudioStream()` still wraps playback (DeepgramService.swift:566). Add new `tts_playing_seq` log to verify pause held through chunked playback.
- **#6 iOS playback latency:** Stage 0.A measures; this stage commits.
- **#7 BT route change:** add iOS `AVAudioSession.RouteChangeNotification` logging in Stage 1 telemetry to correlate with TTS events. No code action this stage.
- **#9 double-spend on failure:** idempotency key + 30s in-memory cache prevents double-billing of identical text within 30s.
- **#10 obsolete tokens:** N/A in Stage 2.
- **#13 success-only telemetry:** outcome enum mandatory.
- **#14 mixed clocks:** monotonic only.
- **#16 mid-session flag flip:** flag snapshotted at session start.
- **#22 voice drift:** model + settings pinned identically to today's path (Stage 0.D confirms).

### 5.5 Commits (Stage 2)

| # | Commit subject | Files |
|---|---|---|
| 2.1 | `feat(voice-latency): ElevenLabsStreamClient wrapper with reconnect-and-replay` | `src/extraction/elevenlabs-stream-client.js` (new), tests |
| 2.2 | `feat(voice-latency): stream-input path on /api/proxy/elevenlabs-tts behind flag` | `src/routes/keys.js` (modify lines 223-290), tests including failure-mode mocks (WS-drop, 20s timeout, isFinal-not-seen) |
| 2.3 | `feat(voice-latency): iOS chunked-HTTP first-chunk + first-audible telemetry` | `Sources/Services/AlertManager.swift` (modify), `Sources/Services/VoiceLatencyTelemetry.swift` (extend) |
| 2.4 | `chore(voice-latency): default flag VOICE_LATENCY_STREAM_CONFIRMATIONS=false in task-def-backend.json (Stage 6 enables)` | `ecs/task-def-backend.json` (add env var) |

**Verification gate Stage 2 → Stage 3:**
- Real session run with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` (Derek's dev backend). P50 audible-confirmation latency from telemetry: < 1,800 ms.
- ElevenLabs cost-tracker (`cost-tracker.js:107`) reports identical character count to current batch path.
- No regressions on `discrepancy_overwrite` rate (regex→Sonnet conflicts).

---

## 6. Stage 3 — Server-side suppression layer

**Goal:** when Stage 4 ships (iOS regex-fast TTS), Sonnet's duplicate confirmation gets swallowed instead of double-speaking. Stage 3 ships *before* Stage 4 so the suppression machinery is proven against the existing Sonnet path with no source of duplication yet (telemetry shows suppression_rate = 0%); when Stage 4 turns on the regex-fast source, suppression rate rises and the code is already exercised.

### 6.1 Suppression key

Codex angles #2, #12 — keys must include `board_id`. Canonical key:

```
sup_<sessionId>_<boardId|noboard>_<circuitRef|nocircuit>_<canonicalField>_<canonicalValue>
```

- `sessionId` — current session UUID (suppression cache is per-session; clears on session_end).
- `boardId` — current board UUID. `noboard` for supply-characteristic readings (Ze, PFC, etc.) and installation-detail readings.
- `circuitRef` — integer or `nocircuit`.
- `canonicalField` — `field_schema.json` canonical name (`measured_zs_ohm`, NOT `zs`).
- `canonicalValue` — normalised string. Normalisation rules (new shared module `src/extraction/canonical-value.js`, used by both fast-path and suppression):
  - Numeric values rounded to 2 decimals: `"0.13"`, not `"0.130000"`.
  - Booleans: `"true"`/`"false"`.
  - Enums (e.g. earthing): lowercased canonical form per `field_schema.json` options.
  - Sentinels `LIM`, `N/A`, `OL` uppercased.
  - Strings trimmed + collapsed whitespace + lowercased.

### 6.2 Suppression entry lifecycle (Codex #2)

- **Create** when a TTS request is *committed* (server has played out audio to iOS — terminal outcome `fast_heard` OR `sonnet_fallback_heard`). NOT on intent, only on terminal success.
- **TTL:** 60 s after creation. Long enough to cover the longest plausible Sonnet round; short enough that two genuinely-distinct reads of the same value (re-test) on the same field re-trigger TTS.
- **Invalidate** on:
  - Session end.
  - `select_board` (board change — context fully different).
  - `add_board`.
  - Correction (Codex #19): when `field_corrected` event fires for `{circuit, field}`, drop all suppression keys matching the prefix `sup_<sessionId>_*_<circuitRef>_<field>_*`. New value gets its own readback class (see §6.3).
  - Explicit `voice_latency_invalidate` admin call (kill-switch test).

### 6.3 Correction class (Codex #19)

When a Stage 6 `field_corrected` event fires:
- Old suppression entry for `{circuit, field}` is invalidated (above).
- Correction-class confirmation text differs: `"Circuit 7 points changed to 17"` (built by extended `buildConfirmationText` accepting an optional `previousValue`).
- Correction-class confirmations are NOT suppressible by regex-fast — explicit Codex angle #19 mitigation. Marked with `req.body.source = 'correction'`. The suppression gate (§5.2 step 2) checks `source` and skips suppression lookup for corrections.

### 6.4 In-memory store

`src/extraction/voice-suppression-store.js`:

```js
// In-memory Map<sessionId, Map<key, { createdAt, correlationId, source }>>
// Session-scoped, no cross-session leakage.
// Pruned on session_end. Pruned on TTL expiry via setTimeout per entry.
// O(1) lookups; max ~30 entries per session (one per confirmable field/circuit/board combo).
```

Not Redis — single backend instance, ECS task pinned at 1 replica, in-memory is sufficient. Acceptable trade: backend restart = empty suppression cache, ~60s of dual-readback risk if Stage 4 is active. Tolerable.

### 6.5 Gate placement (Codex #15 — telemetry decision point)

Suppression decisions logged at the *decision point* — i.e. inside `/api/proxy/elevenlabs-tts`. Telemetry includes:
- `decision`: `suppress` | `synthesise`.
- `candidate_text`: the text that would have been spoken.
- `matched_key`: the suppression entry's full key, if matched.
- `time_since_matched_entry_ms`.
- `correlation_id` of the matched entry.

This lets us audit "we saved 1.2s of TTS by suppressing this" and reconcile counts.

### 6.6 Commits (Stage 3)

| # | Commit subject | Files |
|---|---|---|
| 3.1 | `feat(voice-latency): canonical-value normaliser (shared with Stage 4)` | `src/extraction/canonical-value.js` (new), tests |
| 3.2 | `feat(voice-latency): in-memory voice-suppression-store with TTL + invalidation hooks` | `src/extraction/voice-suppression-store.js` (new), tests |
| 3.3 | `feat(voice-latency): suppression gate on /api/proxy/elevenlabs-tts behind flag` | `src/routes/keys.js` (modify), tests including correction-class bypass |
| 3.4 | `feat(voice-latency): wire field_corrected + select_board + session_end into suppression invalidation` | `src/extraction/sonnet-stream.js` (modify), `src/extraction/stage6-dispatchers-circuit.js` (modify if needed), tests |
| 3.5 | `feat(voice-latency): correction-class confirmation text with previousValue` | `src/extraction/stage6-event-bundler.js` (extend `buildConfirmationText`), tests |

**Verification gate Stage 3 → Stage 4:**
- All telemetry hops fire on every TTS request.
- Suppression rate = 0% in steady-state (no source of duplication until Stage 4).
- Unit tests cover: TTL expiry, board switch invalidation, correction invalidation, kill-switch invalidation, idempotency-key dedup.
- Run a real session with `VOICE_LATENCY_SUPPRESSION=true`; confirm no false suppressions of legitimate readbacks.

---

## 7. Stage 4 — iOS regex-fast TTS path

**Goal:** when iOS regex matches a confirmable value AND the value will pass dispatcher-equivalent validation, iOS hears the confirmation in ~700 ms. Sonnet path runs in parallel; its duplicate confirmation is suppressed (Stage 3).

### 7.1 New iOS surface

In `TranscriptFieldMatcher.swift` (entry point line 1166) — when `match()` returns `RegexMatchResult` with at least one *fast-eligible* field (see §7.4 eligibility), iOS:

1. Mints a correlation ID `vl_regex_<sessionId>_<turnId>_<uuid>`.
2. Sends two messages in parallel:
   - Existing path: `sendTranscript(text, regexResults, ...)` over WS — Sonnet still runs.
   - **NEW: fast-path** `POST /api/voice-latency/regex-fast-tts` (HTTPS, NOT over WS — separate connection, independent failure mode).
3. Posts `{sessionId, correlationId, idempotencyKey, candidates: [{field, circuit, boardId, rawValue, canonicalValue, confidence, source: 'ios_regex'}]}`.
4. iOS does NOT play any audio yet — waits for backend's HTTP response (chunked MP3) OR a 1.5 s timeout (then silent fallback per locked decision 1.2).
5. iOS's existing `result.confirmations[]` handler now checks `X-Voice-Latency-Correlation-Id` on each TTS response to dedupe with fast-path entries (mirrors server-side suppression for last-mile safety).

iOS audio queue rule (Codex angle #1):
- Single playback lane in `AlertManager` — preserved from today.
- When fast-path audio arrives, it is queued behind any TTS already playing.
- When a Sonnet-path confirmation for the same `correlationId.suffix(matched)` arrives, iOS drops it before queueing (it was suppressed server-side; this is belt-and-braces).

### 7.2 New backend endpoint

`POST /api/voice-latency/regex-fast-tts` in `src/routes/voice-latency.js` (new file).

Request body:
```json
{
  "sessionId": "...",
  "correlationId": "vl_regex_...",
  "idempotencyKey": "<uuid>",
  "candidates": [
    {
      "field": "number_of_points",
      "circuit": 7,
      "boardId": "board-1",
      "rawValue": "7",
      "canonicalValue": "7",
      "confidence": 0.95,
      "source": "ios_regex"
    }
  ]
}
```

Server logic (Codex angle #21 — eligibility must mirror dispatcher):

1. **Authn**: same bearer as existing endpoints; sessionId must belong to caller's userId.
2. **Per-candidate eligibility gate** (new module `src/extraction/voice-fast-eligibility.js`, shared with future server-side dispatcher), evaluated in order:
   - Field is in the **whitelist** of fast-eligible fields (§7.4).
   - `confidence >= 0.85`.
   - `canonicalValue` is non-empty, passes field-schema validation.
   - `circuit` resolves against current session state — exists in `boards[].circuits[]` or is a contiguous `currentMaxCircuit + 1`.
   - `boardId` matches current selected board OR is unset (and current selected board is the default).
   - No `pending_write` exists for `{field, circuit}` in the Stage 6 ask resolver state (Codex #4 — never speak a value that's still being clarified).
   - `filled_slots_filter` says the slot isn't already filled with a different canonical value (Codex #21 — no clobber).
   - No correction is in flight on `{field, circuit}` (within 5 s of last `field_corrected`).
3. **If all candidates rejected**: 204 No Content with `X-Voice-Latency-Decision: rejected_all`.
4. **For each accepted candidate**:
   a. Compute suppression key (§6.1).
   b. Check suppression store — if already suppressed (e.g. Sonnet already announced), 204 with `X-Voice-Latency-Decision: suppressed_by_sonnet`.
   c. Build text via `buildConfirmationText(field, canonicalValue, circuit)` (shared with bundler).
   d. Open `ElevenLabsStreamClient` (or reuse session-pooled WS — §7.6).
   e. Stream chunks to HTTP response.
   f. On `isFinal`: write suppression entry with TTL 60 s; record outcome `fast_heard`.

### 7.3 Eligibility whitelist

Codex angle #8 — regex false positives become paid TTS. Tight whitelist on Stage 4 launch; broaden over time based on field telemetry.

| Field | Reason it's eligible | Pinned for Stage 4? |
|---|---|---|
| `number_of_points` | Integer, regex hits "X points" reliably | Yes |
| `measured_zs_ohm` | Decimal Ohms, well-formed | Yes |
| `r1_r2_ohm` (a.k.a. `r1_plus_r2`) | Decimal Ohms | Yes |
| `polarity_confirmed` | Boolean | Yes |
| `iso_l_pe`, `iso_l_n`, `iso_n_pe` | Decimal MOhms or LIM sentinel | Yes (LIM-aware path) |
| Anything else | Lower regex precision | No — defer to Stage 4.5 broadening |

Whitelist lives in `voice-fast-eligibility.js` as a frozen Set; widening requires explicit commit.

### 7.4 Race conditions catalogued (Codex #1, #4, #10, #18)

**Race 1 — Sonnet finishes first:**
Sonnet's confirmation enters `/api/proxy/elevenlabs-tts` (source: `confirmation`) AT THE SAME TIME the fast-path request opens its ElevenLabs WS. Outcomes:
- If Sonnet's request is *received* first → suppression key written first → fast-path's eligibility check sees `suppressed_by_sonnet` → fast-path returns 204 with that decision. iOS hears Sonnet's audio.
- If fast-path's request is *received* first → no suppression entry yet → both go to ElevenLabs in parallel → 2 audio responses. The second to arrive (which will be Sonnet, since fast-path TTFB is ~600 ms vs Sonnet's ~1.2 s) sees the suppression entry written by the first's `isFinal` and is dropped.
- If they arrive within ~50 ms of each other on the server: locking primitive needed. Use Node's `async-mutex` per-`{sessionId, suppressionKey}` to serialise the eligibility check + suppression-write window. This is the only async-mutex in the system; well-contained.

**Race 2 — fast-path audio arrives DURING Sonnet's own confirmation:**
After Sonnet wins the race above (fast-path 204'd), what if a *correction* fast-path arrives? Correction-class bypasses suppression (Codex #19). New audio queues. iOS plays Sonnet's first audio to completion, then the correction. Acceptable.

**Race 3 — inspector keeps dictating during fast-path audio (Codex #18):**
- Existing logic: `pauseAudioStream()` on TTS start → Deepgram discards interim. New utterance during fast-path = clipped.
- Mitigation: speculative — don't start fast-path TTS until ~300 ms of silence after Deepgram's last partial. The `TranscriptFieldMatcher.match()` is already called on Deepgram FINAL transcripts only (per CertMateUnified MEMORY.md / `is_final=true` Deepgram convention). So by the time we get a match, the inspector has paused — the existing Deepgram-pause-during-TTS mechanism handles the rest.
- Additional safety: iOS exposes a `dispatchToAlertManager(audio, deferIfSpeaking: true)` (mirrors line 1100 `shouldDeferPlayback`). Already exists for Sonnet path; reuse for fast-path. Codex #18 close enough.

**Race 4 — pending ask_user (Codex #4):**
Fast-path eligibility checks `pending_write` and `pending_ask` registries in Stage 6 state. If any exists for `{field, circuit}` → fast-path rejects. Inspector won't hear a confirmation for a value Sonnet is still clarifying.

**Race 5 — Sonnet later corrects/rejects the value (Codex #10, #20):**
After fast-path speaks "Circuit 7, points 7" and Sonnet's eventual `record_reading` rejects (e.g. validation_error) or rewrites to a different value:
- The `field_corrected` event fires.
- Suppression entry invalidated for `{field, circuit}` (§6.3).
- Correction-class TTS plays: "Circuit 7 points changed to 17".
- Inspector audibly hears the correction, learns the original was wrong. UX-acceptable; Codex #19 mitigated.

### 7.5 iOS regex-vs-Sonnet divergence (Codex angle #20)

Stage 4 means iOS audibly confirms iOS-local regex value; backend later may have a different canonical value. Mitigation:

- iOS sends `canonicalValue` (already normalised) to backend; backend re-validates via shared `canonical-value.js`. Discrepancy between iOS-claimed canonical and server-derived canonical is logged as `voice_latency.canonical_drift` and rejects the fast-path. Inspector hears Sonnet's value (slower but correct).
- iOS regex confidence threshold raised from any-match to `>=0.85` for fast-eligible fields. Codex #8 #20.

### 7.6 Session-pooled ElevenLabs WS (perf)

To avoid 800 ms BOS handshake on every fast-path call (Research APIs §A.7 — "800ms BOS handshake delay"), backend keeps one `stream-input` WS open per active session and reuses it. Pool entry lifecycle:

- Opened on first fast-path OR confirmation request after session start.
- Keep-alive every 12 s (Research APIs §A.5 — 20 s inactivity timeout).
- Closed on session_end OR after 60 s of no traffic.
- Voice continuity benefit: same WS = same voice context = no inter-request voice drift (Codex #22 partially mitigated).

If a fast-path arrives mid-active-confirmation (rare — confirmations are short), open a separate transient WS for the fast-path. Lock-free using `voice_ws_pool.acquire(sessionId)` returning either the active session WS or a fresh one.

### 7.7 Commits (Stage 4)

| # | Commit subject | Files |
|---|---|---|
| 4.1 | `feat(voice-latency): shared fast-eligibility gate (server)` | `src/extraction/voice-fast-eligibility.js` (new), tests |
| 4.2 | `feat(voice-latency): session-pooled ElevenLabs stream-input WS` | `src/extraction/voice-ws-pool.js` (new), tests |
| 4.3 | `feat(voice-latency): POST /api/voice-latency/regex-fast-tts endpoint` | `src/routes/voice-latency.js` (new), tests |
| 4.4 | `feat(voice-latency): async-mutex on eligibility+suppression for race safety` | `src/extraction/voice-suppression-store.js` (modify), `src/extraction/voice-ws-pool.js` (modify), package.json (add `async-mutex` dep), tests including race fixtures |
| 4.5 | `feat(voice-latency-ios): regex match → fast-path HTTP POST in parallel with WS send` | `Sources/Recording/TranscriptFieldMatcher.swift` (modify), `Sources/Recording/DeepgramRecordingViewModel.swift` (modify), `Sources/Services/APIClient.swift` (modify), tests |
| 4.6 | `feat(voice-latency-ios): correlation-ID drop in AlertManager for last-mile dedup` | `Sources/Recording/AlertManager.swift` (modify), tests |
| 4.7 | `feat(voice-latency-ios): VoiceLatencyConfig.regexFastEnabled compile-time flag, default false` | `Sources/Configuration/VoiceLatencyConfig.swift` (modify) |

**Verification gate Stage 4 → Stage 5:**
- Field-test on TestFlight build with `regexFastEnabled=true` and backend `VOICE_LATENCY_REGEX_FAST_TTS=true`.
- Sample of 10 number_of_points + 10 Zs reads. Telemetry shows ≥80% reach outcome `fast_heard` with P50 audible-latency < 800 ms.
- Suppression rate (Sonnet's duplicate) ≥ 90% of fast_heard outcomes.
- Zero `canonical_drift` rejections in normal speech.
- Zero double-readback complaints in transcript review.

---

## 8. Stage 5 — Stream `ask_user.question` text into ElevenLabs

**Goal:** Sonnet's clarification questions ("Which lighting circuit is the Zs of 0.62 for — circuit 1, 2, or 3?") start playing while Sonnet is still emitting them. P50 question latency drops from ~3 s (today's batch path) to ~1.0–1.4 s.

This is optional and lower-impact than Stage 4. Ship if Stages 1–4 land smoothly and Derek wants it; otherwise defer to a follow-up.

### 8.1 Partial JSON extraction

Sonnet emits ask_user as a `tool_use` block with `input_json_delta` events streaming partial JSON like:
```
{"question": "Which lig
hting circuit is the Z
s of 0.62 for — circui
t 1, 2, or 3?", "rea
son": "ambiguous_circuit", ...}
```

We need to extract the `question` field as it streams. Approach:

- Use a streaming JSON parser (`@streamparser/json` or `clarinet`) wrapped in a "field of interest" extractor.
- Subscribe to incremental string events on the path `.question`.
- As string deltas arrive, forward to ElevenLabs `stream-input` via the session-pooled WS.
- On `content_block_stop` for the tool_use: send `{text: '', flush: true}` to ElevenLabs.

Risks:
- Partial JSON may end mid-escape sequence. Streaming parser handles this.
- Question text may include Unicode `—` (em-dash) and other characters. ElevenLabs handles per their text normaliser.

Codex angle #3 — pre-commit text:
- We can't be sure Sonnet won't emit `ask_user` then later abort (rare but possible — Research APIs §B.5 — SDK abort can silently truncate). If TTS has spoken half the question before abort, inspector hears half a question.
- Mitigation: hold the FIRST 0.5 s of question audio in a backend-side buffer; only flush to iOS once Sonnet emits `content_block_stop` for the tool_use. If aborted before stop, discard buffer; inspector hears nothing (silent fallback per locked decision).
- This trades 0.5 s back for safety. Net: still saves ~1.5 s vs today.

### 8.2 Commits (Stage 5)

| # | Commit subject | Files |
|---|---|---|
| 5.1 | `feat(voice-latency): streaming JSON field-extractor` | `src/extraction/streaming-json-field.js` (new), tests |
| 5.2 | `feat(voice-latency): stream ask_user.question into pooled ElevenLabs WS behind flag` | `src/extraction/stage6-tool-loop.js` (modify line 197 area), tests with mocked Anthropic stream + ElevenLabs WS |
| 5.3 | `feat(voice-latency): 500ms holdback buffer before flushing question audio to iOS` | `src/extraction/voice-ws-pool.js` (modify) |

**Verification gate Stage 5 → Stage 6:**
- Replay 20 ask_user turns from production logs through the new path.
- P50 question latency < 1.4 s.
- Zero "half-question" outcomes (i.e. partial audio played for an aborted Sonnet stream).

---

## 9. Stage 6 — Rollout & ramp

### 9.1 Order

1. Land Stages 1–4 on `main` with all flags `false`. CI smoke tests pass. iOS TestFlight Build N ships (capability bit + compile-time `regexFastEnabled=false`).
2. Verify zero impact on production (telemetry shows the new code paths are not exercised; suppression cache empty per session).
3. Server flag flip: `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`. Re-deploy via CI (source commit modifying task-def). Stage 2 live.
4. 24 h soak. Check: per-session voice_latency.jsonl, audible-confirmation P50, ElevenLabs cost/day.
5. Server flag flip: `VOICE_LATENCY_SUPPRESSION=true`. Stage 3 live (suppression rate still 0% — no fast-path source yet).
6. iOS TestFlight Build N+1 ships with `regexFastEnabled=true` AND server flag `VOICE_LATENCY_REGEX_FAST_TTS=true` flipped together.
7. Field test on Derek's iPad: 10 reads / field type / route (built-in speaker, AirPods, BT headset).
8. If Stage 5 in scope: similar ramp, server flag `VOICE_LATENCY_STREAM_ASK_USER=true`.

### 9.2 Kill switch

`VOICE_LATENCY_KILL_SWITCH=true` immediately disables every voice-latency code path. Each gate (§4.2) reads `if (process.env.VOICE_LATENCY_KILL_SWITCH === 'true') return false;` at the top.

Verification (mandatory before declaring Stage 6 done):
- Set `KILL_SWITCH=true` on live backend mid-session. Inspector hears Sonnet's batch path within next confirmation. No errors.
- Set back to `false`. Streaming resumes.

### 9.3 Cost monitoring

- ElevenLabs spend per day published to CloudWatch via existing `cost-tracker.js`.
- Codex angle #9 — verify vendor character count matches our recorded count. Daily reconciliation in `scripts/voice-latency-bench/daily_cost_check.sh` (cron weekday 9 AM) — fetches ElevenLabs usage from their API + our session-analytics. Discrepancy > 10% emits Pushover alert (Derek already wired for session-optimizer alerts).

### 9.4 Rollback strategy

- **Per-flag rollback**: flip individual flag to `false`, re-deploy via CI. Each flag's code path falls through to pre-stage behaviour.
- **Whole-feature rollback**: `VOICE_LATENCY_KILL_SWITCH=true`. Instant.
- **iOS rollback**: previous TestFlight build available for 30 days; Derek can roll back via TestFlight if needed. Backend must remain compatible with previous iOS (the capability handshake §4.3 makes this work).
- **Code revert**: `git revert <commit>` for any individual slice. Each commit is independent (no cross-stage shared state changes within commits).

### 9.5 Commits (Stage 6)

| # | Commit subject | Files |
|---|---|---|
| 6.1 | `chore(voice-latency): flip VOICE_LATENCY_STREAM_CONFIRMATIONS=true in task-def-backend.json` | `ecs/task-def-backend.json` |
| 6.2 | `chore(voice-latency): flip VOICE_LATENCY_SUPPRESSION=true` | `ecs/task-def-backend.json` |
| 6.3 | `chore(voice-latency): flip VOICE_LATENCY_REGEX_FAST_TTS=true + iOS regexFastEnabled=true on Build N+1` | `ecs/task-def-backend.json`, `Sources/Configuration/VoiceLatencyConfig.swift` |
| 6.4 | `chore(voice-latency): daily ElevenLabs cost reconciliation cron` | `scripts/voice-latency-bench/daily_cost_check.sh` (new), README update |
| 6.5 | (optional) `chore(voice-latency): flip VOICE_LATENCY_STREAM_ASK_USER=true` | `ecs/task-def-backend.json` |

---

## 10. Testing strategy

### 10.1 Unit (server)

- `elevenlabs-stream-client.test.js`: BOS shape, keepalive cadence, reconnect-and-replay, isFinal handling, error path, idempotency cache.
- `voice-suppression-store.test.js`: TTL, invalidation hooks (board switch, correction, session end, kill switch), canonical-value matching, board_id segregation, no cross-session leakage.
- `voice-fast-eligibility.test.js`: whitelist enforcement, confidence floor, pending_write rejection, filled_slot rejection, board mismatch rejection.
- `voice-ws-pool.test.js`: session pool re-use, 12s keep-alive, transient WS for concurrent fast-path, cleanup on session_end.
- `streaming-json-field.test.js` (Stage 5): partial JSON, escape sequences, multi-block tool_use.
- `canonical-value.test.js`: numeric rounding, sentinel handling, enum lowercasing, schema integration.

### 10.2 Integration (server)

- `voice-latency-integration.test.js`: end-to-end with mocked ElevenLabs WS + mocked Anthropic stream:
  - Stage 2: confirmation → stream-input → chunked HTTP response.
  - Stage 3: two confirmations same key → second suppressed.
  - Stage 4: fast-path + concurrent Sonnet confirmation → race resolved deterministically.
  - Correction class: fast-path NOT suppressed.
  - Board switch: previous board's suppression invalidated.
  - Stage 5: ask_user JSON streamed → partial flushes.

### 10.3 iOS unit

- `TranscriptFieldMatcherTests`: regex confidence threshold, canonical value emission.
- `VoiceLatencyTelemetryTests`: monotonic-clock spans, correlation ID format, outcome enum.
- `AlertManagerTests`: chunked-HTTP receipt, drop-on-suppression-header, deferred playback during speech.

### 10.4 Field (Derek's iPad + iPhone)

- Pre-Stage 2: baseline P50 audible-confirmation latency (5 sessions of ~50 reads each).
- Post-Stage 2: same protocol; expect < 1,800 ms P50.
- Post-Stage 4: 10 reads / fast-eligible field; expect > 80% reach `fast_heard` with < 800 ms P50.
- BT-route field tests (Codex #7): built-in speaker, AirPods, BT headset, wired.

### 10.5 Test data fixtures

Capture 5 representative ElevenLabs `stream-input` exchanges in `tests/fixtures/elevenlabs-stream-input/` (BOS-to-isFinal traces) for replay in unit tests. Sourced from Stage 0 measurement runs.

---

## 11. Documentation

| Doc | Update |
|---|---|
| `docs/reference/ios-pipeline.md` | Add "Voice latency optimisation" section with the staged architecture. Link to this PLAN.md (snapshot under `docs/adr/` once shipped). |
| `docs/adr/` | New `ADR-009-voice-latency-streaming-tts.md` summarising the architecture decisions (post-hoc text streaming, server-side suppression, regex-fast eligibility whitelist, session-pooled WS). |
| `EICR_Automation/CLAUDE.md` Changelog | One row per stage commit. |
| `CertMateUnified/CLAUDE.md` | Updated "Recording pipeline" section with new fast-path branch. |
| `docs/reference/changelog.md` | Full commit-body-level entries. |
| `docs/reference/architecture.md` | Add ElevenLabs streaming + suppression to AI Models / Costs sections. |

---

## 12. Open questions deferred for Codex review pass

These are items the planning agents flagged but did not resolve. Codex review should sanity-check or surface more.

1. Should fast-eligible fields include `ring_r1_ohm`, `ring_r2_ohm`, `ring_rn_ohm` for ring-final-circuit tests? Regex precision unclear — could be a Stage 4.5 broadening.
2. Should suppression entries persist across short network blips (i.e. WS reconnect) within the same session? Currently yes (in-memory, session-scoped). Confirm acceptable.
3. Stage 0.A may force iOS-side AudioQueue work. If so, does the iOS team have capacity in this sprint or do we ship Stage 2 with the "accumulate then play" Strategy A and budget the AudioQueue swap as a follow-up?
4. `voice-suppression-store` is in-memory and lost on ECS task replacement. Acceptable for current 1-task deployment. If we ever scale to ≥2 backend instances, this needs Redis. Note in architecture.md as future work.
5. Is `async-mutex` an acceptable new dependency, or does Derek prefer hand-rolled `Promise` chain serialisation? Mutex is well-tested (12M weekly downloads) but adds dep.
6. The 60 s suppression TTL is a guess. Should be tuned post-Stage-3 telemetry.
7. Stage 5 `ask_user` streaming risks half-question playback on Sonnet abort. The 500 ms holdback buffer reduces but doesn't eliminate. Alternative: only flush to iOS after `content_block_stop`. Costs ~300 ms vs streaming-from-token-1. Which? Codex review please weigh.

---

## 13. Exit criteria

Sprint is complete when ALL of:

- All Stage 0 gates pass (or replan documented).
- All commits land on `main` per CLAUDE.md auto-commit + WHY rule.
- All tests pass: unit (server + iOS), integration, field.
- `docs/reference/ios-pipeline.md` + ADR-009 land in same sprint.
- Real session telemetry shows:
  - P50 audible-confirmation latency < 1,000 ms with Stages 2+3+4 enabled.
  - Suppression rate ≥ 90% of fast_heard outcomes.
  - Zero double-readback complaints from Derek's field test.
  - ElevenLabs daily spend < 2× pre-sprint baseline.
- Kill switch verified end-to-end (mid-session flip works).
- One full week of normal usage with no rollback.

---

## 14. Risk register (consolidated)

| Risk | Likelihood | Impact | Mitigation | Stage |
|---|---|---|---|---|
| iOS can't decode chunked MP3 (Stage 0.A fail) | Medium | High | Stage 0 measurement first; fallback to whole-blob | 0/2 |
| Sonnet TTFT > 1.2 s in our config | Medium | Medium | Stage 0 measurement; relax target if needed | 0/2 |
| ElevenLabs TTFB > 250 ms from eu-west-2 | Low | Medium | Measure, escalate to ElevenLabs if so | 0 |
| Voice perceived as different (Flash vs Turbo) | Low | High (locked decision 1.3) | Derek A/B's Stage 0.D; pin to Turbo if so | 0 |
| Race condition Sonnet vs fast-path | High | Medium | async-mutex on eligibility+write window | 4 |
| Regex false positive → paid TTS | High | Low (cost) / Medium (UX) | Whitelist + confidence floor + canonical-drift rejection | 4 |
| Double-spend on late-fail fast-TTS | Medium | Low (cost) | Idempotency key + 30s cache | 2/4 |
| Mid-session flag flip | Low | Medium | Session-snapshotted flags | 1 |
| iOS WS chunked-MP3 jitter | Medium | Medium | Stage 0.E measurement | 0 |
| Suppression cache lost on backend restart | Low | Low | Acceptable; documented; ≤60s dual-readback risk | 3 |
| Half-question audio (Stage 5 abort) | Low | Medium | 500ms holdback buffer | 5 |
| Inspector dictates during fast-TTS | Medium | Low | shouldDeferPlayback existing + 300ms speech-gate | 4 |
| BT route change mid-session | Medium | Low | Route-change telemetry + field test | 4 |
| Wire-format incompatibility old TestFlight | Medium | High | Capability handshake | 1 |
| ENV flag drift task-def vs source | Low | High | Existing CI guardrail + same-commit rule | 1 |
| 2 backend instances → suppression incoherent | n/a | Future | Document as Redis-required-if-scaled | 3 |

---

## 15. References

- `RESEARCH_PIPELINE.md` (this directory) — existing codebase map.
- `RESEARCH_APIS.md` (this directory) — ElevenLabs + Anthropic streaming documentation.
- `CODEX_ANGLES.md` (this directory) — 22 risk angles from Codex CLI brainstorm.
- `HANDOFF.md` (this directory) — scope lock.
- `CLAUDE.md` (project root + iOS) — auto-commit, infra-from-source, backend-shared-with-iOS rules.
- ADR-009 (forthcoming) — formal architecture record.
