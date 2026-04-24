# Phase 6: Recording Pipeline UI — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction_

## Summary
Gaps found: 22  (P0: 7   P1: 10   P2: 5)
Exceptions (intentional divergence, documented): 0
Phase-1 gaps carried forward: 2 (Gap #1 Observations-tab + Gap #2 FAB Obs button — re-manifest in recording chrome context, noted below)

Audit covers: FAB / mic entry point, recording chrome & action bar, transcript bar, LiveFillView, VAD sleep/wake state machine, cost ticker, Deepgram config, Sonnet WS protocol, state machine, actions, 3-tier field priority, and copy. Excludes: CCU photo / Document extraction (Phase 8) and backend Deepgram credential minting (out of scope).

Durable rule: **iOS is canon** (user directive 2026-04-24). All claims below cite iOS source; the `web/docs/parity-ledger.md` and `web/reviews/WEB_REBUILD_COMPLETION.md` (§6 footgun #6) both state Deepgram config and recording-UI must stay in sync with iOS.

---

## Highest-impact gaps (summary)

1. **Gap #1  LiveFillView is never mounted anywhere in the PWA**  [P0] — the whole live dashboard (5 sections, auto-scroll, field flash) is dead code.
2. **Gap #2  Deepgram `utterance_end_ms` drift: iOS 1500 vs PWA 2000**  [P0] — degrades transcription turn-end behaviour; directly violates the "Deepgram / Audio" rule in `~/.claude/rules/mistakes.md` and Footgun #6 of `WEB_REBUILD_COMPLETION.md`.
3. **Gap #3  No keyterm prompting on PWA Deepgram URL**  [P0] — iOS passes up to ~89 domain keyterms (`BS 7671`, `EICR`, circuit names from the board photo) with boost scoring; PWA passes zero, so transcription accuracy on technical vocabulary is materially worse.

Plus: missing Sonnet questions UI (P0), missing server heartbeat (P0), missing transcript buffering across disconnect (P0), simplified 2-tier priority instead of 3-tier (P0).

---

## Side-by-side matrix

### Deepgram URL parameters (iOS `DeepgramService.buildURL` vs PWA `DeepgramService.buildURL`)

| Param | iOS | PWA | Status |
|---|---|---|---|
| `model` | `nova-3` | `nova-3` | OK |
| `smart_format` | `true` | `true` | OK |
| `punctuate` | `true` | `true` | OK |
| `numerals` | `true` | `true` | OK |
| `encoding` | `linear16` | `linear16` | OK |
| `sample_rate` | `16000` | `16000` | OK |
| `channels` | `1` | `1` | OK |
| `language` | `en-GB` | `en-GB` | OK |
| `interim_results` | `true` | `true` | OK |
| `endpointing` | `300` | `300` | OK |
| `utterance_end_ms` | **`1500`** | **`2000`** | **DIVERGENT (Gap #2)** |
| `vad_events` | `true` | `true` | OK |
| `keyterm` (repeatable) | Up to ~89 per session w/ boost scores | **not sent** | **DIVERGENT (Gap #3)** |

Evidence — iOS `CertMateUnified/Sources/Services/DeepgramService.swift:586-610, 625-640`; PWA `web/src/lib/recording/deepgram-service.ts:474-490`.

### Auth / subprotocol

| Side | Scheme | Mechanism |
|---|---|---|
| iOS | `Authorization: Bearer <JWT>` header | `DeepgramService.swift:314` — URLSession WS task |
| PWA | Subprotocol `['bearer', <JWT>]` | `deepgram-service.ts:266` — browser can't set upgrade headers |

Status: OK — each platform uses the only form it can, both consuming the same `/v1/auth/grant` JWT from `src/routes/keys.js`. The 2026-04-19 prod hotfix referenced in the hub CLAUDE.md changelog lands here.

### KeepAlive

| Field | iOS | PWA | Status |
|---|---|---|---|
| Interval during live recording | KeepAlive during paused-only (`scheduleNextPausedKeepAlive`, 5.0 s cadence) | 10 s cadence while connected, skipped if `bufferedAmount > 0` or idle < 8 s | **DIVERGENT** — different strategies (Gap #4) |
| KeepAlive body | Text frame `{"type":"KeepAlive"}` + 500 ms silent PCM binary frame (both together) | Text frame `{"type":"KeepAlive"}` + 500 ms silent PCM | OK shape, DIFFERENT cadence |
| Paused cadence | 5.0 s fixed (`DeepgramService.swift:547`) | Same 10 s gated-on-idle loop | **DIVERGENT** — PWA has no separate paused keep-alive |

Evidence — iOS `DeepgramService.swift:225-235, 517-548`; PWA `deepgram-service.ts:506-543`.

### Sonnet WebSocket protocol (outbound from client)

| Message | iOS sent? | PWA sent? | Notes |
|---|---|---|---|
| `session_start` | Yes | Yes | OK |
| `session_resume` | N/A (iOS uses auto-reconnect `_connect` path) | Yes (post-4c.5 reconnect) | PWA >= iOS on rehydrate |
| `transcript` | Yes — with optional `regexResults`, `timestamp`, `confirmations_enabled`, `in_response_to` | Yes — `confirmations_enabled` only, no regexResults, no timestamp, no in_response_to | **DIVERGENT (Gap #5)** |
| `correction` | Yes — `field, circuit, value` | Yes — same shape | OK |
| `session_pause` | Yes | Yes | OK |
| `session_resume` (pause-resume) | Yes | Yes | OK |
| `session_stop` | Yes | Yes | OK |
| `session_compact` | Yes (`sendCompactRequest`) | **No** | **DIVERGENT (Gap #6)** |
| `heartbeat` | Yes (25 s timer, server-required to defeat ALB idle_timeout 88 s) | **No** | **DIVERGENT (Gap #7) — P0** |
| `client_diagnostic` | Yes | **No** | DIVERGENT — P2 (ops-only) |

Evidence — iOS `CertMateUnified/Sources/Services/ServerWebSocketService.swift:245-353, 501-524` (`pingInterval = 25.0`, `sendHeartbeat` docblock: "AWS ALB … closes the WS after ~88s of doze silence"); PWA `web/src/lib/recording/sonnet-session.ts:405-485` — no ping timer exists.

### Sonnet WebSocket protocol (inbound to client)

| Message | iOS handled? | PWA handled? | Notes |
|---|---|---|---|
| `session_ack` | Yes | Yes | OK (PWA also captures server `sessionId` + tracks TTL status, marginally more than iOS) |
| `extraction` | Yes | Yes | OK |
| `question` | Yes | Yes (state only) | **PWA stores, never renders — Gap #8** |
| `voice_command_response` | Yes | Parsed, callback exists, **never wired** in `recording-context.tsx:338-368` | **DIVERGENT (Gap #9)** |
| `cost_update` | Yes | Yes | OK |
| `error` | Yes | Yes | OK |
| `observation_update` | Yes (second-pass BPG4 refinement) | **No handler** | **DIVERGENT (Gap #10) — P0** |

Evidence — iOS `ServerWebSocketService.swift:449-454, 15-52` (`ObservationUpdate` decoder); PWA `sonnet-session.ts:513-605` — `observation_update` is not in the switch.

### Recording state machine

| iOS state | PWA state | Notes |
|---|---|---|
| `active` | `active` | OK |
| `dozing` | `dozing` | Semantics differ — iOS keeps WS open w/ KeepAlive+silent-PCM; PWA calls `deepgramRef.pause()` (drops new samples, continues 10 s KeepAlive). Observable parity roughly OK. |
| `sleeping` | `sleeping` | OK |
| `isInterruptionPaused` | — | iOS-only (phone call interruption). N/A for browser. |
| — | `requesting-mic` | Web-only, necessary for permission flow. |
| — | `error` | Web-only transitional state; iOS surfaces errors via `recordingError` string. |

PWA no-speech timer: **15 s** (`sleep-manager.ts:59` `noTranscriptTimeoutSec`) — matches iOS `noTranscriptTimeout = 15.0` (`SleepManager.swift:51`). OK.
PWA dozing→sleeping: **1800 s / 30 min** (`sleep-manager.ts:60`) — matches iOS `dozingTimeout = 1800.0` (`SleepManager.swift:26`). OK.
PWA post-doze cooldown: **2000 ms / ~63 frames** — matches iOS `vadCooldownFrames: 63` @ 32 ms/frame = 2016 ms (`SleepManager.swift:98`). OK.

### 3-tier field priority

| iOS | PWA |
|---|---|
| `fieldSources[key]: .preExisting / .sonnet / .regex` + `originallyPreExistingKeys: Set<String>` fallback (`DeepgramRecordingViewModel.swift:94-100, 271-297`) | Single test: `if (hasValue(existing[reading.field])) continue` (`apply-extraction.ts:146, 214`) |
| Three tiers tracked; regex fills can be overwritten by Sonnet; CCU/manual (preExisting) never overwritten | Two tiers: existing-wins (any source). No per-key source tracking. |

Status: **DIVERGENT (Gap #11)** — Sonnet can never correct a stale regex value (which the PWA doesn't run anyway, see Gap #12) and can never overwrite a just-spoken misread. On iOS, regex fills at ~40ms then Sonnet overwrites 1-2s later (hub `CLAUDE.md` "Dual extraction"). PWA has no regex layer at all.

### Instant regex layer / NumberNormaliser

| iOS | PWA |
|---|---|
| `NumberNormaliser.normalise(text)` + `TranscriptFieldMatcher` run on every Deepgram transcript; produces `regexSummary` sent to server as `regexResults` context. Instant ~40 ms field fill. (`DeepgramRecordingViewModel.swift:37, 1489, 1560`) | Not ported. `onFinalTranscript` forwards the raw Deepgram text straight to Sonnet (`recording-context.tsx:263`). |

Status: **DIVERGENT (Gap #12)** — inspector sees Sonnet fill only, 1-2 s delay per value instead of ~40 ms regex + later Sonnet refine. Also means backend Sonnet loses the `regexResults` hint it was designed to consume.

---

## Gap #1  LiveFillView is imported nowhere — the entire live dashboard is dead code  [P0]
**Area:** Job Detail → recording surface → full-form live dashboard
**iOS behaviour:** While recording, `LiveFillView` is rendered over the job detail content in `JobDetailView.swift` (tab content switches to `LiveFillView` under `recordingVM.isRecording`); the view has 11 live sections — header, report-detail cards, client address, installation address, installation details, extent (EIC), supply, board, CCU slots, circuits (portrait / landscape layouts), observations (EICR only), listening indicator — with auto-scroll to the most recently updated section via `lastUpdatedSection` (`CertMateUnified/Sources/Views/Recording/LiveFillView.swift:20-107, 415-762`).
**PWA behaviour:** `web/src/components/live-fill/live-fill-view.tsx` exists and is fully implemented (421 lines; 5 sections: Installation / Extent EIC-only / Supply / Board / Circuits / Observations EICR-only with auto-scroll, 3-tier priority gating not included). **No route or component imports it.** `grep -rn "import.*LiveFillView\\|<LiveFillView"` returns zero results in `web/src/`. Only comments and CSS rules reference the name.
**Evidence:** `grep -rn "<LiveFillView\\|import.*LiveFillView" /Users/derekbeckley/Developer/EICR_Automation/web/src/` returns nothing; `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:137` contains only a comment referencing `<LiveFillView>` in a TODO about "the form is the … being swapped out to `<LiveFillView>`" — it is never swapped out.
**User impact:** During recording on the PWA, the inspector sees the ordinary static `job-tab-nav` page content (Overview / Circuits / etc.) with a red border and a transcript pill — but no rolling dashboard of extracted fields flashing as Sonnet fills them. The headline UX of the iOS recording experience (the "live fill" itself) is absent on web.
**Touchpoints:** `web/src/app/job/[id]/layout.tsx` (wire `{state !== 'idle' ? <LiveFillView/> : children}` — or equivalent — so recording replaces the tab content). Existing `cm-live-section` entrance styles in `globals.css:316` already exist for this.

## Gap #2  Deepgram `utterance_end_ms` drift: PWA 2000 vs iOS 1500  [P0]
**Area:** Deepgram Nova-3 stream configuration
**iOS behaviour:** `utterance_end_ms = 1500` (`CertMateUnified/Sources/Services/DeepgramService.swift:608`), with an explicit comment: "utterance_end_ms 1500 (2026-04-20, voice-quality-sprint Stage 1): Raised 1200 -> 1500 to give more headroom before UtteranceEnd closes a turn … History: 2000 -> 1200 shortened TTS latency (8-12s -> ~3s); 1200 -> 1500 trades 300ms for fewer mid-utterance truncations." (`:597-607`).
**PWA behaviour:** `utterance_end_ms: '2000'` (`web/src/lib/recording/deepgram-service.ts:486`). The comment in `deepgram-service.ts:9` describes the value as "utterance_end_ms=2000" — iOS was tuned to 1500 in sprint Stage 1, web was never updated.
**Evidence:** `web/src/lib/recording/deepgram-service.ts:486`: `utterance_end_ms: '2000',` vs iOS `DeepgramService.swift:608`: `URLQueryItem(name: "utterance_end_ms", value: "1500"),`.
**User impact:** PWA sessions wait 500 ms longer than iOS before Deepgram finalises an utterance after silence. That increases turn-end latency — Sonnet extraction + TTS question round trips start 500 ms later per turn — and causes the turn-end pattern to diverge between platforms when the same inspector tests side-by-side. Directly violates the "Deepgram / Audio" rule in `~/.claude/rules/mistakes.md` ("Keep web and iOS Deepgram configs in sync") and Footgun #6 in `web/reviews/WEB_REBUILD_COMPLETION.md:292`.
**Proposed fix:** Update `deepgram-service.ts:486` to `'1500'` and the docblock at `:9` to match.

## Gap #3  PWA Deepgram URL carries no keyterms — iOS sends up to ~89 with boost scoring  [P0]
**Area:** Deepgram Nova-3 stream configuration (keyword boosting)
**iOS behaviour:** On every `connect()`, iOS computes `keywords = KeywordBoostGenerator.generate(from: boardAnalysis)` (`DeepgramRecordingViewModel.swift:568`) and passes them into `DeepgramService.connect(apiKey:, keywords:)`. The URL builder appends up to ~89 `keyterm=...` params — boost suffix `:X.X` for high-tier keywords, plain keyterm for the rest, cap by URL length 1800 chars (iOS `DeepgramService.swift:612-640`). Config lives in `default_config.json` with base boosts + board-type boosts (RCBO, MCB, RCD, BS EN numbers, common circuit names, etc.).
**PWA behaviour:** `buildURL()` has no keyterm logic; the URL is a fixed 12-param `URLSearchParams` set (`deepgram-service.ts:474-490`). `DeepgramService.connect()` takes only `keyOrFetcher` + `sourceSampleRate` — no `keywords` parameter at all (`:171`).
**Evidence:** PWA `deepgram-service.ts:474-490` shows the complete param list, missing `keyterm`; iOS `DeepgramService.swift:612-640` iterates boosts and appends them. No `KeywordBoostGenerator` exists under `web/`.
**User impact:** Deepgram's recognition of domain vocabulary (`BS 7671`, `EICR`, `RCBO`, `B6`, `C16`, `Wylex`, `Hager`, circuit names from the CCU board photo) is materially worse on PWA. Inspectors will see more garbled transcripts → more Sonnet "did you mean…" questions → more wasted turns and token cost. This is one of the two biggest reasons iOS voice quality feels higher than web.
**Proposed fix:** Port `KeywordBoostGenerator` as `web/src/lib/recording/keyword-boost-generator.ts`, thread `keywords` through `DeepgramService.connect`, and call the generator in `beginMicPipeline` with the current `job.board.*` + `default_config.json` data.

## Gap #4  PWA has no separate "paused KeepAlive" loop — iOS sends both JSON frame AND silent PCM every 5 s while paused  [P1]
**Area:** Deepgram connection liveness during doze/pause
**iOS behaviour:** When `pauseAudioStream()` fires, iOS calls `startKeepAliveWhilePaused()` which schedules a 5 s recurring sender that transmits BOTH `{"type":"KeepAlive"}` (text) AND 500 ms of silent PCM (binary) on every tick (`DeepgramService.swift:519-548`, comment `:529-538`: "KeepAlive JSON alone is unreliable — Deepgram kills the connection after ~20s despite 5s KeepAlive interval. Binary audio data (even silence) uses a different server-side liveness check that reliably prevents disconnection.").
**PWA behaviour:** `DeepgramService.pause()` flips `this.paused = true` and `sendSamples` drops frames (`deepgram-service.ts:368-386, 411-413`); the same 10 s gated KeepAlive loop from the active state runs throughout. There is no dedicated 5 s paused-cadence, and silent-PCM is only sent when the gate fires (idle > 8 s AND bufferedAmount == 0), not every 5 s unconditionally.
**Evidence:** `deepgram-service.ts:517-535` — single `startKeepAlive` loop running at 10 s; no conditional doubling of cadence during pause.
**User impact:** Extended web pauses (>20-30 s) risk Deepgram server-side disconnect, forcing the auto-reconnect + fresh-key path and losing a small window of pre-wake audio (the ring buffer helps but only covers 3 s). iOS observed this in field testing (the comment is explicit).
**Proposed fix:** On `pause()`, swap the keep-alive timer to 5 s cadence and unconditionally send both a KeepAlive JSON frame AND 500 ms silent PCM on each tick until `resume()`.

## Gap #5  PWA `transcript` messages omit `regexResults`, `timestamp`, `in_response_to`  [P1]
**Area:** Sonnet WebSocket protocol — client→server shape
**iOS behaviour:** `sendTranscript` sends `{type, text, timestamp, regexResults?, confirmations_enabled?, in_response_to?}` (`ServerWebSocketService.swift:245-270`). `regexResults` carries the instant TranscriptFieldMatcher hints; `in_response_to` tags the transcript with the last TTS question so Sonnet can correctly interpret "yes"/"no"/"FI" replies (`:262-268`).
**PWA behaviour:** `sendTranscript` sends `{type, text, confirmations_enabled}` only (`sonnet-session.ts:407-420`). No `timestamp`, no `regexResults` (would be empty anyway, see Gap #12), no `in_response_to` (PWA has no TTS, see Gap #13).
**Evidence:** Above.
**User impact:** Sonnet server loses the disambiguation context for one-word answers and the per-turn timestamp it uses for latency attribution in cost telemetry.
**Proposed fix:** Add `timestamp: new Date().toISOString()` unconditionally; add `in_response_to` once PWA has a TTS layer; add `regexResults` once the regex extractor is ported (Gap #12).

## Gap #6  PWA has no `session_compact` sender — Sonnet context grows unboundedly on long sessions  [P1]
**Area:** Sonnet conversation-state management
**iOS behaviour:** `sendCompactRequest()` sends `{type: "session_compact"}` (`ServerWebSocketService.swift:279`). iOS triggers it once the conversation has grown past threshold (hub CLAUDE.md 2026-02-28: "Raise COMPACTION_THRESHOLD 6000→60000 — preserves Sonnet's conversational context" — the server-side threshold that also needs the client trigger to fire).
**PWA behaviour:** No `session_compact` path exists; `sonnet-session.ts` has no `compact()` method.
**Evidence:** `grep -n compact /Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sonnet-session.ts` returns nothing.
**User impact:** Long PWA recording sessions (>30 min, high Sonnet turn counts) risk the server-side context growing past the compaction threshold without a client-initiated compaction message, leading to higher token cost per turn vs iOS.
**Proposed fix:** Add `compact()` method on `SonnetSession` that sends `{type: 'session_compact'}`; expose via recording-context action; trigger automatically based on turn count per `ServerCostUpdate.sonnet.turns`.

## Gap #7  PWA sends no `heartbeat` — AWS ALB closes idle Sonnet WS after ~88 s of silence  [P0]
**Area:** Sonnet WebSocket liveness
**iOS behaviour:** `startPingTimer()` runs every 25 s while connected; on each tick it sends BOTH a JSON `{"type":"heartbeat"}` (via `sendHeartbeat`) AND a WS `ws.ping()` control frame. The docblock on `sendHeartbeat` explicitly states why: "WS PING frames … did NOT stop AWS ALB from closing the WS after ~88s of doze silence — observed in session 0952EC64 on 2026-04-24 (and 51A530BB / A02B018D on 2026-04-22). ALB's idle_timeout tracks application data-frame traffic, not control frames, so PING alone isn't enough. A lightweight JSON message over the same socket resets the idle counter and keeps the sonnet session (and its 5-min prompt cache) alive through dozing/silence without reconnect churn." (`ServerWebSocketService.swift:281-292, 501-524`).
**PWA behaviour:** No heartbeat timer exists. `sonnet-session.ts` relies entirely on WS control-frame ping (which the browser itself handles via `new WebSocket(...)`) — which iOS proved is insufficient against AWS ALB.
**Evidence:** iOS `ServerWebSocketService.swift:116` `pingInterval: TimeInterval = 25.0`; `:501-524` timer sends `sendHeartbeat()` + `ws.sendPing`. PWA `sonnet-session.ts` has no `setInterval` on the WS at all.
**User impact:** During PWA doze periods longer than ~88 s (common during Zs/loop-impedance readings), the Sonnet WS will be terminated by AWS ALB, forcing a reconnect cycle. The 4c.5 reconnect state machine absorbs this (max 5 attempts with backoff+jitter), but each reconnect drops the Sonnet 5-min prompt cache and incurs fresh input tokens for context replay — the exact cost bloat iOS landed heartbeat to avoid.
**Proposed fix:** Add a 25 s `setInterval` in `SonnetSession` once `onopen` fires that sends `{type: 'heartbeat'}`. Match the iOS interval exactly.

## Gap #8  Sonnet questions are captured into state but never rendered  [P0]
**Area:** Recording UI → question surfacing
**iOS behaviour:** Questions arrive via `serverDidReceiveQuestion`, are surfaced through the ViewModel into the `RecordingOverlay` + `TranscriptStripView`; TTS speaks them aloud (ElevenLabs via backend proxy) + the UI renders a visible question bubble.
**PWA behaviour:** The recording context allocates `questions: SonnetQuestion[]` state (capped at 5, dedup'd by text) and even exposes a `dismissQuestion(index)` action (`recording-context.tsx:137, 344-350, 736-738`). But **no component reads `useRecording().questions`.** `grep -rn "questions.map\\|SonnetQuestion" web/src/components` returns nothing.
**Evidence:** `web/src/lib/recording-context.tsx:755, 760` — `questions` is in `RecordingSnapshot` → `RecordingCtx`, but no consumer; `web/src/components/recording/recording-chrome.tsx` and `transcript-bar.tsx` never dereference `questions`.
**User impact:** When Sonnet asks for clarification ("Did you say Zs = 0.64 or 0.84?"), the PWA inspector never sees the question and never gets a chance to answer, breaking the conversational extraction loop. The question sits in state until it's auto-pruned by the rolling 5-item cap.
**Proposed fix:** Add a `<QuestionStack>` component under the transcript bar (iOS shows it as a yellow pill above the action bar) that renders each pending question with an "×" dismiss button and a Tap-to-reply affordance.

## Gap #9  `voice_command_response` handler not wired up in RecordingContext  [P1]
**Area:** Voice command loop
**iOS behaviour:** `serverDidReceiveVoiceCommandResponse` fires TTS of `spoken_response` and dispatches `action` (navigate, change tab, delete circuit, etc.) via `VoiceCommandExecutor` (`DeepgramRecordingViewModel.swift:142`).
**PWA behaviour:** `SonnetSession` decodes `voice_command_response` messages and fires `onVoiceCommandResponse` callback (`sonnet-session.ts:586-592`). But in `recording-context.tsx:338-368` where the `SonnetSession` is constructed, `onVoiceCommandResponse` is **not set** — so the message is decoded and then dropped.
**Evidence:** `recording-context.tsx:338-368` lists callbacks (`onStateChange, onExtraction, onQuestion, onCostUpdate, onError`) but no `onVoiceCommandResponse`.
**User impact:** Voice commands sent from the PWA ("End this session", "Go to Circuits tab", "Delete circuit 5") will be processed server-side, the server will return a `voice_command_response` with an action — and nothing happens on the client. The inspector hears silence; no navigation / mutation occurs.
**Proposed fix:** Wire `onVoiceCommandResponse` in recording-context and port a minimal command executor — at least Navigate / Delete-circuit / End-session.

## Gap #10  `observation_update` (second-pass BPG4 refinement) not handled on PWA  [P0]
**Area:** Sonnet WebSocket — observation refinement
**iOS behaviour:** The server emits `observation_update` a few seconds after an initial `extraction` once its BPG4 / BS 7671 web-search has resolved the observation's code + regulation. iOS updates the already-rendered row keyed by `observation_id` (or fuzzy text fallback) — `ServerWebSocketService.swift:24-52, 449-454`.
**PWA behaviour:** `sonnet-session.ts:523-605` switch statement has no case for `observation_update`; it falls through to the `default:` branch (`// session_summary / unknown — ignored for Phase 4d.`) at `:604-606`.
**Evidence:** `sonnet-session.ts:604-605` comment calls out that Phase 4d left this unimplemented.
**User impact:** When Sonnet corrects an observation's code (e.g. initially C3, refined to C2 with a specific BS 7671 regulation after web search), the iOS inspector sees the observation update in place; the PWA inspector keeps the stale initial classification. Observations on web are "first-guess only" — a regression on compliance accuracy.
**Proposed fix:** Add a case for `observation_update` in the switch and surface an `onObservationUpdate` callback; update `apply-extraction.ts` (or a sibling) to find-by-id + patch code/regulation/rationale.

## Gap #11  PWA has 2-tier priority ("existing wins"), not 3-tier (preExisting > sonnet > regex)  [P0]
**Area:** Sonnet→JobDetail merge
**iOS behaviour:** `fieldSources[key]: .regex / .sonnet / .preExisting` tracked per key + `originallyPreExistingKeys: Set<String>` fallback. Regex fills can be overwritten by Sonnet (iOS hub CLAUDE.md: "Dual extraction: Regex provides instant ~40ms field fill; Sonnet overwrites with higher accuracy 1-2s later"); manually-entered / CCU-sourced values are never overwritten by either (`DeepgramRecordingViewModel.swift:94-100, 271-297`).
**PWA behaviour:** `apply-extraction.ts:121-129, 146, 214` — single `hasValue()` check: if any value exists, Sonnet skips writing. No source tracking, no way for Sonnet to correct a previously-mis-filled field.
**Evidence:** Above.
**User impact:** Once a field has ANY value (including a bad Sonnet guess from a misheard transcript), Sonnet cannot self-correct on subsequent turns even if the inspector re-states the correct value. iOS handles this cleanly; PWA does not.
**Proposed fix:** Track `fieldSources: Map<string, 'preExisting'|'sonnet'|'regex'>` in the recording context; gate overwrites in `apply-extraction.ts` on source comparison.

## Gap #12  No instant-regex layer (`NumberNormaliser` + `TranscriptFieldMatcher`) on PWA  [P1]
**Area:** Extraction pipeline parity
**iOS behaviour:** Every Deepgram final runs through `NumberNormaliser.normalise()` (converts spoken numbers to digits) and `TranscriptFieldMatcher` (regex field extraction); results populate the form in ~40 ms while Sonnet is still thinking, and the regex summary is sent to Sonnet as `regexResults` context (`DeepgramRecordingViewModel.swift:37, 1489, 1560`).
**PWA behaviour:** `onFinalTranscript` in recording-context forwards the raw text straight to Sonnet (`recording-context.tsx:246-263`); no normalise, no match. Sonnet is the only field source.
**Evidence:** No `NumberNormaliser` or `TranscriptFieldMatcher` or `regex` extractor under `web/src/lib/recording/`.
**User impact:** Inspectors on web wait 1-2 s for every field fill (the Sonnet round trip) instead of 40 ms for the common numeric readings. For a session with 50-100 readings, this compounds into perceptible lag — and a nervous "did it hear me?" feel iOS explicitly avoids.
**Proposed fix:** Port `NumberNormaliser.swift` + `TranscriptFieldMatcher.swift` to TS, run on every final transcript in recording-context, apply as `regex` source via the 3-tier path from Gap #11; attach as `regexResults` via Gap #5.

## Gap #13  No TTS (ElevenLabs) on PWA — inspector never hears confirmations / questions  [P1]
**Area:** Voice feedback
**iOS behaviour:** ElevenLabs TTS via backend proxy speaks server-gated questions + optional confirmations of values (when `confirmationModeEnabled == true`). Recording overlay has a Voice toggle (`RecordingOverlay.swift:49-64`). Post-reconnect grace suppresses stale TTS (`DeepgramRecordingViewModel.swift:157-162`).
**PWA behaviour:** No TTS. The recording-chrome shows a "Voice" button but it is **disabled** with aria-label "Voice prompts are iOS-only for now." (`recording-chrome.tsx:152-158`). `WEB_REBUILD_COMPLETION.md` also lists this as iOS-only deferred.
**Evidence:** Above.
**User impact:** PWA inspectors must look at the screen to see clarifications; on iOS they can keep eyes on the board because the device speaks to them. This is the single biggest hands-free UX gap.
**Proposed fix:** Wire Web Speech API TTS (or the ElevenLabs `/api/tts` endpoint behind a client fetch) to speak `question.question` + `confirmations[].text`; add an on/off toggle matching the iOS `confirmationModeEnabled` UserDefault.

## Gap #14  PWA does not buffer transcripts while disconnected  [P1]
**Area:** Sonnet WS reliability
**iOS behaviour:** `send()` buffers `transcript` + `correction` messages in `pendingMessages` when `!isConnected`; `flushPendingMessages()` drains after the next `session_ack` arrives (`ServerWebSocketService.swift:212-232, 296-314`).
**PWA behaviour:** `SonnetSession.sendTranscript()` bails early when `state !== 'connected'` (`sonnet-session.ts:414`). The `preConnectQueue` only covers the initial `connecting` window, not post-reconnect dropouts (`:411`).
**Evidence:** `sonnet-session.ts:407-420`.
**User impact:** During the reconnect backoff window (500 ms to 10 s), any transcripts the user speaks are lost to Sonnet. iOS replays them after `session_ack`; web does not.
**Proposed fix:** Promote `preConnectQueue` to a general `pendingTranscripts` queue; add messages to it whenever state is not `connected`; flush after the next successful `session_ack` (with `status === 'resumed'` branch to dedupe).

## Gap #15  FAB affordance divergence: PWA Mic-only button vs iOS multi-button action bar  [P0]
(Carries forward Phase-1 Gap #2 with more context now.)
**Area:** Job Detail → floating action bar (idle state)
**iOS behaviour:** The `RecordingOverlay` (always visible, not just during recording) hosts 6 buttons in portrait/landscape: Voice (toggle), Defaults (iPad portrait only), Apply, CCU, Doc, Obs (observation photo), End (only when recording), and the Record toggle (`RecordingOverlay.swift:46-204`).
**PWA behaviour:** When idle, the only affordance is a single Mic FAB (`floating-action-bar.tsx:34-36`); when recording, `RecordingChrome` DOES render a similar cluster (Voice/Defaults/Apply disabled, CCU/Doc/Obs functional) — `recording-chrome.tsx:146-194` — so the gap is strictly in the idle state.
**Evidence:** `floating-action-bar.tsx:27-39`: `if (recording) return null;` and only a `MicButton`.
**User impact:** Before starting a session, the PWA inspector has no quick route to CCU / Doc / Obs actions — they have to click into the right tab first. iOS lets them open the observation camera or CCU sheet straight from the dashboard.
**Proposed fix:** Port the full button cluster into `FloatingActionBar` gated on idle state with the same routing the recording-chrome uses.

## Gap #16  No processing badge / status-text during recording  [P1]
**Area:** Recording chrome → active extraction indicator
**iOS behaviour:** `RecordingOverlay.geminiStatusContent` shows `ProcessingBadgeView(count: processingCount)` while Sonnet is mid-turn, or `lastExtractionStatus` text otherwise (e.g. "3 fields updated" / "Server disconnected"). Error states render in red weighted text. (`RecordingOverlay.swift:304-321`).
**PWA behaviour:** `RecordingChrome` StatePill is the only indicator; there is no per-turn processing badge and no `lastExtractionStatus` readout.
**Evidence:** `recording-chrome.tsx:240-267` — StatePill shows only `state` enum.
**User impact:** Inspector can't tell whether Sonnet is currently processing or idle; no feedback on how many fields the last turn filled; no server-disconnected affordance until an error causes a red banner.
**Proposed fix:** Expose `processingCount` + `lastExtractionStatus` on RecordingCtx (derive from Sonnet session events), render a small chip next to the StatePill.

## Gap #17  VAD indicator (listening/speaking/trailing states) missing on PWA  [P1]
**Area:** Recording chrome → VAD visual
**iOS behaviour:** `VADIndicatorView` shows a coloured dot with pulsing ring — grey (idle), yellow (listening), green (speaking), orange (trailing). Renders in the action-bar glass container (`VADIndicatorView.swift:1-26`, mounted in `RecordingOverlay.swift:273`).
**PWA behaviour:** The TranscriptBar has a single "pulse green" dot that keys off `pulse = state === 'active'` only (`transcript-bar.tsx:41, 51-60`). No listening/speaking/trailing distinction, and the dot sits on the transcript strip not the action bar.
**Evidence:** Above.
**User impact:** Hard to tell at a glance whether Deepgram is hearing anything. When the dot is green but no transcript appears for a few seconds, inspector can't distinguish "mic is working, nobody's speaking" from "mic is dead". iOS's 4-colour signal resolves this ambiguity.
**Proposed fix:** Surface Deepgram `speechStarted` + `utteranceEnd` events through recording-context (they exist on `DeepgramService` already — `onSpeechStarted`, `onUtteranceEnd`), derive a `vadState: 'idle'|'listening'|'speaking'|'trailing'`, render a 4-colour dot in the action bar.

## Gap #18  Transcript rolling cap 10 vs iOS TranscriptStripView "last line only" — divergent models  [P1]
**Area:** Transcript display
**iOS behaviour:** `TranscriptStripView` shows only `lastLine` (the last newline-separated line of the full rolling transcript held in the ViewModel), with `highlight` flashing of keyword matches as new fields confirm (`TranscriptStripView.swift:14-34, 92-111`). The full transcript remains in the ViewModel for debug + server submission; the strip is a "what you just said" summary.
**PWA behaviour:** TranscriptBar renders the last 10 finals inline horizontally with a fade (`transcript-bar.tsx:74-87`), plus the interim in italic. This is closer to a "debug log pill" than the iOS summary line.
**Evidence:** `transcript-bar.tsx:72-91`; iOS `TranscriptStripView.swift:14-34`.
**User impact:** Different visual model — PWA is more information-dense but doesn't have the keyword-highlight-on-confirm flash iOS uses (the flashing index → highlight badge at `TranscriptStripView.swift:92-111`) which is a primary user-feedback mechanism when a reading lands.
**Proposed fix:** Either (a) adopt the iOS single-line + keyword highlight model exactly, or (b) explicitly document the horizontal rolling variant as intentional divergence with user sign-off. Per durable rule "iOS is canon", default is (a).

## Gap #19  Sleep detector uses RMS-only wake, not Silero VAD (≥0.80 prob, 12/30 frames)  [P1]
**Area:** Wake-from-doze accuracy
**iOS behaviour:** Silero VAD ONNX (`SileroVAD`) with `vadWakeThreshold = 0.80`, sliding window 30 frames (960 ms), `vadWakeFramesRequired = 12` (384 ms sustained speech in any 960 ms window), with `vadEnergyFloor = 0.002` (`SleepManager.swift:29-45, 98-99`).
**PWA behaviour:** Pure RMS threshold `0.02` with 12 consecutive frames required (~200 ms @ 60 Hz) — `sleep-manager.ts:58-64`. The docblock acknowledges: "TODO: land `onnxruntime-web` + Silero v5 model and swap the RMS path for a real VAD" (`:15-19`).
**Evidence:** `sleep-manager.ts:58-64, 112-132`.
**User impact:** PWA is more prone to false wakes (tool noise, breath, footsteps all easily clear RMS 0.02) and false misses (quiet distant speech may not exceed 0.02 for 12 consecutive frames). iOS's Silero gets ~0.90+ for speech vs ~0.01-0.20 for room noise, a cleaner separation.
**Proposed fix:** Port Silero VAD via `onnxruntime-web` + the v5 model as tracked in the file's TODO.

## Gap #20  PWA has no `questionAnswerTimeout` / `postWakeGraceTimeout` extension  [P1]
**Area:** Sleep state timers
**iOS behaviour:** After a question is TTS'd, the no-transcript timer extends from 15 s → 20 s (`questionAnswerTimeout`). After waking from doze/sleep, it extends from 15 s → 25 s (`postWakeGraceTimeout`) so Deepgram's reconnect + buffer replay can land the first transcript before re-dozing (`SleepManager.swift:53-64, 149-161, 245-260`).
**PWA behaviour:** Only the base 15 s timer exists. On wake, `armNoTranscriptTimer()` re-arms with the same 15 s (`sleep-manager.ts:119-127`).
**Evidence:** Above.
**User impact:** Web sessions that wake-from-sleep on faint speech can re-doze before Deepgram's reopen + ring-buffer replay produces a final, creating a "sorry, could you repeat that" loop. No question-answer path exists on web (because there's no TTS — Gap #13) so `questionAnswerTimeout` is moot until TTS lands.
**Proposed fix:** Once TTS lands, add `questionAnswerTimeout: 20`, `postWakeGraceTimeout: 25` into `SleepManager` config; flip between them per iOS logic (`setQuestionAnswerFlow(true/false)`, `setPostWakeGrace(true/false)`).

## Gap #21  PWA recording-context state machine lacks `requesting-mic` → `active` telemetry; `isInterruptionPaused` N/A  [P2]
**Area:** State machine completeness
**iOS behaviour:** Has `isInterruptionPaused` for phone-call interruptions (AVAudioSession handlers). Logs a `CONNECTING` / `WS_RESUMED` line on transition.
**PWA behaviour:** No interruption state (browser analogue doesn't exist); console.info logs on close but no `connecting` telemetry. PWA also adds `requesting-mic` and `error` which iOS doesn't need.
**Evidence:** `recording-context.tsx:51` vs iOS `DeepgramRecordingViewModel.swift:70-87`.
**User impact:** Minor — browser has no call-interruption, so `isInterruptionPaused` is genuinely N/A. Flagged for code-review parity only.
**Proposed fix:** None needed; exception-worthy divergence once the iOS-as-canon rule permits it.

## Gap #22  PWA RecordingChrome's "End" button triggers stop() with no confirmation  [P2]
**Area:** Destructive action guards
**iOS behaviour:** End button flips `showEndSessionConfirmation = true` which surfaces a confirmation alert before actually stopping — `RecordingOverlay.swift:163-166` + `JobDetailView.swift` owns the `.alert(...)`.
**PWA behaviour:** End button directly calls `stop()` with no prompt — `recording-chrome.tsx:198-203`.
**Evidence:** Above.
**User impact:** Accidental double-tap / fat-finger on mobile ends the session immediately, losing the Sonnet-paused state (though not data — fields are already synced).
**Proposed fix:** Add a `<Dialog>` or `window.confirm('End recording session?')` gate on End.

---

## Additional observations (non-gap)

- **State pill colour coding drifts.** PWA StatePill uses `brand-green` for active, `status-processing` for dozing/requesting-mic, `status-limitation` for sleeping, `status-failed` for error (`recording-chrome.tsx:240-267`). iOS uses `CMDesign.Colors.recordingActive` for active, `recordingPaused` for paused, `recordingProcessing` for trailing. The token names don't map 1:1; a Phase 7 (if one exists) token-audit would clarify whether web's token substitutions actually visually match.
- **`hub CLAUDE.md` claims "(3-tier Active/Dozing/Sleeping) … live in production"** — that is true at the state machine level on both platforms; the divergence is in the wake heuristic (Gap #19) and the 3-tier field priority (Gap #11), not the sleep state hierarchy.
- **Cost unit:** both iOS and PWA display USD (`$`); there is no `£` / GBP conversion in iOS or web. The Phase 6 scope mentions "GBP display" — that turns out to not exist on iOS, so web matches.
- **PWA reconnect feature flag:** `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED` defaults OFF per `sonnet-session.ts:170-177`. If this flag is not set in production, the Sonnet reconnect state machine described in 4c.5 is inactive — which makes Gap #7 (heartbeat) strictly worse.

---

## Open questions for the user

1. **LiveFillView mount (Gap #1) — confirm fix scope.** The iOS pattern swaps the tab content entirely to `LiveFillView` during recording. The PWA scaffolding has a TODO comment in `layout.tsx:137` saying "the form is the … being swapped out to `<LiveFillView>`" — confirm that's the intended design (rather than, say, a sheet / drawer below the tab content).
2. **Keyterm boost (Gap #3) — config source.** iOS uses `default_config.json` for base+boardType boosts. Should PWA read the same JSON via an API endpoint, bundle a client-side copy, or fetch on session start?
3. **TTS (Gap #13) — Web Speech API vs ElevenLabs proxy.** Web Speech has no cost but a robotic voice; ElevenLabs matches iOS voice exactly but incurs the server cost per session. Which path?
4. **3-tier priority (Gap #11) — where to source-track.** iOS stores `fieldSources` on the ViewModel. On web it probably belongs on `useJobContext()` not recording-context (because manual field edits on any tab need to set source="preExisting"). Confirm.
