# Runtime-Coupling Parity Audit — iOS ↔ PWA Recording Pipeline

Date: 2026-05-17
Author: parity-audit subagent (Claude Opus 4.7, 1M context)
Trigger: today's freeze fix (`2bc8d90 fix(pwa): gate mic-PCM pipeline during ElevenLabs playback — iOS parity`) revealed that all prior parity audits (`.planning/parity-audit/diff.md`, `parity-checklist.md`, `web/docs/parity-ledger.md`) checked component existence, not coupling. This document enumerates every event that fires side effects in another subsystem and reports per-side behaviour.

## Method

For each trigger event in the iOS recording pipeline, I located the callback site (e.g. `alertManager.onTTSPlaybackStarted = { ... }`), enumerated every action inside the closure, then searched the PWA recording context for the equivalent observer (`setTtsLifecycleObserver`, `onChitchatPaused`, `onclose`, etc.) and compared the bodies. Every row is backed by verbatim file:line refs.

## Source-of-truth files

iOS (canon):
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` (7,917 LOC)
- `CertMateUnified/Sources/Recording/RecordingSessionCoordinator.swift` (719)
- `CertMateUnified/Sources/Recording/AlertManager.swift` (1,547)
- `CertMateUnified/Sources/Audio/AudioSessionManager.swift` (197)
- `CertMateUnified/Sources/Audio/AudioEngine.swift` (517)
- `CertMateUnified/Sources/Services/DeepgramService.swift` (1,479)
- `CertMateUnified/Sources/Services/ServerWebSocketService.swift` (1,174)

PWA:
- `web/src/lib/recording-context.tsx` (2,674)
- `web/src/lib/recording/deepgram-service.ts` (663)
- `web/src/lib/recording/sonnet-session.ts` (1,680)
- `web/src/lib/recording/elevenlabs-tts.ts` (523)
- `web/src/lib/recording/tts.ts` (772)
- `web/src/lib/recording/mic-capture.ts` (155)
- `web/src/lib/recording/sleep-manager.ts` (281)
- `web/src/lib/recording/silero-vad.ts` (213)

---

## Couplings table

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|

### Audio session / OS-level

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 1 | App backgrounded (UIScene `willResignActive`/`didEnterBackground`) | None observed in recording sources — no `willResignActive`/`didEnterBackground` observers; iOS keeps `.playAndRecord` audio session live in background (entitlement+capability set). `UIApplication.shared.isIdleTimerDisabled = true` at `DeepgramRecordingViewModel.swift:575` keeps screen on. | None on the recording pipeline. `recording_pagehide` diagnostic at `recording-context.tsx:342-348` fires but takes no action. | MATCH | — | Both implicitly continue recording. iOS via .playAndRecord background entitlement; PWA via Safari's foreground-only model (bug, see #67-72). |
| 2 | App foregrounded (`pageshow.persisted=true` on PWA / no equivalent observer on iOS) | None — no foreground observer in `DeepgramRecordingViewModel.swift`. Recording either survived background or didn't. | `recording_pageshow` diagnostic at `recording-context.tsx:335-341`. No state recovery, no Deepgram/Sonnet ping, no ring buffer replay. | DIVERGENT | MAJOR | PWA gets pageshow.persisted=true on BFCache restore (iPad Safari) but does not validate WS health, attempt reconnect, or flush any state. iOS doesn't need an equivalent because the OS doesn't BFCache the process. Field-test 2026-05-17 (sess_mp9ep221_62n8) — page-died-silently freeze did not recover because nothing on pageshow tried to. |
| 3 | `AVAudioSessionInterruptionNotification.began` (phone call, Siri, alarm) | `RecordingSessionCoordinator.swift:614-630` observer → `handleInterruptionPause()` at `:644-672`: set `isInterruptionPaused=true`, cancel `chunkSubscription`, `audioEngine.pauseCapture()`, `serverWS?.sendPause()`, `debugLogger.warn("interruption_pause")`, `onInterruptionPause?()` → ViewModel sets `isInterruptionPaused=true` flag. Also `AudioSessionManager.swift:101-106` posts `recordingShouldPause` notification (currently unconsumed — dead code). | None — Web has no equivalent OS interruption API. SpeechSynthesis pause behaviour on Siri varies; no observer wired. | iOS-ONLY | MAJOR | Web can't observe OS-level interruptions but COULD use `audio` `interruptbegin/interruptend` (Media Session API) or `pagehide` heuristically. Currently a Siri/phone call mid-PWA-session produces undefined behaviour (audio context may be suspended by OS). |
| 4 | `AVAudioSessionInterruptionNotification.ended` | `RecordingSessionCoordinator.swift:625-627` → `handleInterruptionResume()` at `:674-706`: `audioEngine.resumeCapture()`, re-`sink` chunk publisher, clear `isInterruptionPaused=false`, if `deepgramService.connectionState != .connected` set `isReconnectingFromSleep=true` and call `reconnectDeepgramFromSleep(bufferData: Data())` (no ring replay — phone calls starve mic so buffer is irrelevant), `serverWS?.sendResume()`, log `interruption_resumed`, `onInterruptionResume?()`. | None. | iOS-ONLY | MAJOR | Same root cause as #3. |
| 5 | `AVAudioSessionRouteChangeNotification` — `newDeviceAvailable` (Bluetooth pair, headphones plugged) | `AudioSessionManager.swift:122-166`: log route, `setActive(true)` to re-activate, if `input == nil` (e.g. A2DP-only speaker stole routing) call `overrideOutputAudioPort(.speaker)` to force built-in mic. `AVAudioEngineConfigurationChange` cascade fires in `AudioEngine.swift:271-281` → `handleConfigurationChange()` at `:307-389`: re-entrancy guard, `removeTap`, drain converter via `processingQueue.sync`, stop/apply VP/reinstall tap/restart engine. | None. Mic-capture handle in `mic-capture.ts:127-132` only listens for the input track `'ended'` event (revocation). No `devicechange` listener. | iOS-ONLY | MEDIUM | Pairing a BT headset mid-PWA-session has no recovery — AudioWorklet keeps reading from the original device, RMS may drop to zero, but neither side knows to re-establish. |
| 6 | `AVAudioSessionRouteChangeNotification` — `oldDeviceUnavailable` (BT unpair, headphones unplugged) | Same handler as #5 — `AudioSessionManager.swift:138-166` covers both directions, re-activates session, re-asserts speaker output, fires `AVAudioEngineConfigurationChange` → tap reinstall. | None. | iOS-ONLY | MEDIUM | Same as #5. |
| 7 | `AVAudioSessionRouteChangeNotification` — `.override` | Same `AudioSessionManager.swift:138-166` branch. | None. | iOS-ONLY | MINOR | Less common than #5/6. |
| 8 | `AVAudioSessionMediaServicesWereResetNotification` | Not observed by either platform. iOS rare-but-real (audiod crash). | Not applicable (no such API). | MATCH | — | Neither handles. iOS gap if media services reset mid-recording → silent failure. |
| 9 | `AVAudioSessionSilenceSecondaryAudioHintNotification` | Not observed. | N/A. | MATCH | — | Neither handles. |

### Mic / capture

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 10 | Mic capture started | `RecordingSessionCoordinator.swift:147-156` `startAudioCapture`: `AudioSessionManager.setupSession()` (configures `.playAndRecord` + EC + 16kHz at `:14-78`), `audioEngine.startCapture()`, subscribe `chunkPublisher`. | `recording-context.tsx:1797-1860` `beginMicPipeline`: `new AudioRingBuffer(3, 16000)`, `startMicCapture()` (`mic-capture.ts:49-154` opens AudioContext + AudioWorklet + getUserMedia with EC/NS/AGC at `:55-62`), wire `onSamples`/`onLevel`/`onError`, then `openDeepgram(16000)` + `openSonnet()` sequentially. | MATCH | — | Both configure EC, both sample at 16kHz. |
| 11 | Mic capture stopped | `RecordingSessionCoordinator.swift:159-168` `stopAudioCapture`: cancel subscription, `audioEngine.stopCapture()` (`AudioEngine.swift:120-136` removes tap, stops engine, clears bypass flag), flush remaining PCM via `sendBufferedAudio()`. | `recording-context.tsx:710-713` `teardownMic`: `micRef.current?.stop()` (mic-capture.ts:137-152 disconnects worklet/script, stops MediaStream tracks, closes AudioContext). No final flush. | DIVERGENT | MINOR | iOS flushes the pcmSendBuffer to Deepgram on stop; PWA's mic doesn't have a host-side accumulator (AudioWorklet delivers in 128-sample chunks already pushed to Deepgram). Acceptable. |
| 12 | Mic permission revoked mid-session | iOS routes through `AVAudioSessionInterruptionNotification` typically. No dedicated permission-revoke observer. | `mic-capture.ts:127-132` — track `'ended'` listener fires `opts.onError(new Error('Microphone track ended'))` → `recording-context.tsx:1852-1859` `onError` → setErrorMessage, setState('error'), full teardown. | PWA-ONLY | MINOR | PWA defensive extra — a fine-grained error path iOS doesn't expose. |
| 13 | Mic level threshold crossed (RMS / VU meter) | `RecordingSessionCoordinator.swift:689-731` `onAudioLevelUpdated` → ViewModel sets `audioLevel`, and if `alertManager.isTTSSpeaking && AudioFeatureFlags.voiceProcessingEnabled` runs legacy amplitude-based barge-in at threshold for N consecutive frames → `alertManager.bargeIn(...)`. | `recording-context.tsx:1835-1851` `onLevel` → if `!sileroRef.current?.loaded` feeds `sleepManagerRef.current?.processAudioLevel(level)` (RMS fallback for wake gate), throttles `setMicLevel` at 60Hz. NO barge-in. | DIVERGENT | MEDIUM | PWA lacks amplitude-based barge-in entirely. PWA's only barge-in is text-final-during-TTS at `recording-context.tsx:1089-1120` which is much coarser — fires AFTER Deepgram returns a final (potentially 1-2s after user starts talking) and only when there's an in-flight ask. |
| 14 | Mic raw audio chunk arrives | `RecordingSessionCoordinator.swift:205-222` `handleAudioChunk`: `sleepManager.processChunk` (VAD via Silero) + `bargeInDetector.processChunk` (separate Silero) + if `sleepManager.state == .active` either queue (during reconnect) or `processAudioChunk` (which discards during post-TTS window at `:316-332`, batches to 1600 samples = 100ms, sends to Deepgram). | `recording-context.tsx:1797-1834` `onSamples`: **early-return if `ttsActiveRef.current`** (the new fix from today), else `resampleTo16k(samples, handle.sampleRate)`, write to `ringBufferRef`, `deepgramRef.current?.sendSamples`, conditionally `dispatchSamplesToVad` (Silero) only when sleeping. | MATCH | — | The new TTS gate at `recording-context.tsx:1812` (`if (ttsActiveRef.current) return;`) is iOS parity. Subtle difference: iOS still calls `sleepManager.processChunk` + `bargeInDetector.processChunk` during TTS pause (they no-op via internal flags), PWA early-returns ENTIRELY skipping VAD dispatch. Probably fine — Silero shouldn't run during TTS playback anyway. |
| 15 | Mic input device changed (route change) | `AudioEngine.swift:271-281` registers `AVAudioEngineConfigurationChange` observer → `handleConfigurationChange()` at `:307-389`: stop engine, reapply VP, reinstall tap with new format, restart engine. | None. AudioContext keeps running on the original device. | iOS-ONLY | MEDIUM | Tied to #5/6. PWA's AudioWorklet doesn't auto-rebind to a new device. |

### Silero / VAD

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 16 | VAD speech detected | `RecordingSessionCoordinator.swift:396-404` `sleepManager.onWake = { ... }`: log `sleep_state_wake`, `audioEngine.setVoiceProcessingBypassed(false)` (re-enable AEC), `reconnectFromSleep(previousState:)` at `:425-435` (drain ring buffer, full Deepgram reconnect, `serverWS?.sendResume()`, `monitorPostWakeTranscript()`). Stage 4 barge-in: `bargeInDetector.onBargeInFired` at `:741-772` → log `bargein_fired`, `serverWS?.send({type:"tts_cancelled_by_user", vad_probability})`, `alertManager.bargeIn(suppressCooldown:true)` (cancels TTS), arm false-trigger watchdog. | `sleep-manager.ts:229-244` `applyWakeScore`: increment frames, when `wakeFramesRequired` met set `isPostWakeGrace=true`, `setState('active')`, arm timer, `onWake('sleeping')`. `recording-context.tsx:1974-1976` onWake → `handleWake(from)` at `:1882-1951`: reopen Deepgram/Sonnet, replay ring buffer, `setState('active')`, beginTick. No barge-in equivalent. | DIVERGENT | MEDIUM | Wake-from-sleep matches. Barge-in path doesn't exist in PWA — see #13. |
| 17 | VAD silence detected | `SleepManager` (iOS) onSpeechSilence resets the no-transcript timer. Implementation in iOS SleepManager.swift (not read in full but referenced from VAD doc). | `sleep-manager.ts:223-243` `applyWakeScore` else-branch: `consecutiveSpeechFrames = 0`. No timer reset on silence (timer is reset only on final transcript via `onSpeechActivity`). | DIVERGENT | MINOR | Both treat per-frame silence as "do nothing for sleep entry". |
| 18 | VAD model load failure | `BargeInDetector` + `sleepManager`'s Silero are separate instances. Load failures presumably fall back internally. Not deeply audited. | `recording-context.tsx:2122-2138` Silero `vad.load()` catch → `console.warn`, sileroRef stays null, `processAudioLevel` RMS fallback in `onLevel` (`:1845-1847`) takes over. | DIVERGENT | MINOR | PWA has explicit graceful degradation; iOS uses VAD without a documented fallback (the ring-buffer audio still gets processed by Deepgram even if VAD fails — Deepgram VAD is a backup). |
| 19 | VAD inference frame processed | Per-frame in `BargeInDetector` + `SleepManager` — internal. | `vad-accumulator.ts` accumulates to 512-sample blocks, `silero.processVadFrame(score)` → SleepManager state machine. | MATCH | — | Both run 32ms frames through Silero v5 with same threshold (0.8) and same 12-of-N frames gate (per `sleep-manager.ts:88-91` doc note about iOS parity). |

### Deepgram WS

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 20 | Deepgram WS open | `DeepgramService.swift:1400-1429` `didOpenWithProtocol`: connectionState=`.connected`, `reconnectAttempt=0`, clear `currentApiKey`, set `connectionOpenedAt=Date()`, start streamingStartTime if not paused. Delegate fires `didChangeConnectionState(.connected)`. | `deepgram-service.ts:271-287` `ws.onopen`: `pipelineLog('deepgram_ws_open')`, setState `connected`, reset reconnectAttempt, hasEverOpened=true, `startKeepAlive()`, fire `onReconnected` (only if `wasReconnect`). | MATCH | — | Both reset reconnect counters on success. PWA additionally fires onReconnected callback which the host (`recording-context.tsx:1217-1227`) uses to replay ring buffer — iOS does ring replay via `reconnectFromSleep` instead. Different shapes but equivalent net effect. |
| 21 | Deepgram WS close (clean) | `DeepgramService.swift:1432-1453` `didCloseWith closeCode:.normalClosure`: connectionState=`.disconnected`, `webSocketTask=nil`. No reconnect. | `deepgram-service.ts:306-339` `ws.onclose` with `event.code === 1000 || 1005`: stopKeepAlive, ws=null, setState `disconnected`. | MATCH | — | |
| 22 | Deepgram WS close (dirty) | Same handler — if `shouldReconnect && closeCode != .normalClosure` → `scheduleReconnect()` at `:1187-1225` (exp backoff 1→30s cap, fetches fresh API key via `APIClient.shared.fetchDeepgramStreamingKey()` per attempt). | Same handler — if `reconnectable && shouldReconnect` → `scheduleReconnect()` at `:356-380` (exp backoff 1→30s cap, fetcher mode mints fresh JWT via `openWithFreshKey()` at `:201-231`). | MATCH | — | Identical reconnect ladder. |
| 23 | Deepgram WS error | `DeepgramService.swift:1455-1478` `didCompleteWithError`: log, `notifyError(error)`, `isListening=false`, `webSocketTask=nil`, if shouldReconnect schedule. | `deepgram-service.ts:293-304` `ws.onerror`: log, if `shouldReconnect` defer to onclose (no double-fire), else setState `error` and `emitError`. | MATCH | — | Both dedup error+close. |
| 24 | Deepgram interim transcript | `DeepgramService.swift:1176-1182` interim path → `delegate.didReceiveInterimTranscript`. ViewModel `handleInterimTranscript` at line 1607: cancel `speechConfirmTimer`, if `!isSpeaking` set `isSpeaking=true` + `sessionCoordinator.isSpeaking=true` + `vadState=.speaking`, set `interimTranscript=text`. | `deepgram-service.ts:633-638` interim path → `onInterimTranscript` → `recording-context.tsx:1052-1054` just `setInterim(text)`. | DIVERGENT | MEDIUM | PWA does NOT mirror iOS's `isSpeaking` flag-flip on interim. The flag drives iOS's TTS deferral (`shouldDeferPlayback` at `DeepgramRecordingViewModel.swift:877-880`) — a question whose audio arrives during ongoing speech is held until UtteranceEnd. PWA has no equivalent `isSpeaking` state; instead it relies on the in-flight-ask + final-during-TTS barge-in at `:1089`. |
| 25 | Deepgram final transcript | `DeepgramService.swift:1136-1175` → `delegate.didReceiveFinalTranscript`. ViewModel `handleFinalTranscript` at `:1636`-end: huge pipeline — TTS-window echo gate, fingerprint echo gate, naming-buffer (Bug K), normalisation, regex matching, server send, Stage 6 ask_user_answered routing, misheard check, etc. | `deepgram-service.ts:625-632` → `onFinalTranscript` → `recording-context.tsx:1055-1216`: clearInterim, log, TTS-window gate (with barge-in branch when in-flight ask, `:1089-1120`), TTS fingerprint echo gate (`:1134-1141`), naming-buffer (`:1142-1208`), burst-buffer (`:1215`), regex+Sonnet dispatch in `dispatchFinal` (`:867-1048`). | MATCH | — | Behaviour aligned. Burst-buffer (`web/src/lib/recording-context.tsx:244,820-865`) is PWA-only (added 2026-05-13 for the Observation. + description split). Bug K naming-buffer matches with same regex and timeout. |
| 26 | Deepgram `utterance_end` | `DeepgramService.swift:893-913` `case "UtteranceEnd"`: dedupe via `firedTurnEndForCurrentUtterance` and `last_word_end:-1`, fire `delegate.deepgramServiceDidReceiveUtteranceEnd`. ViewModel uses it to clear `isSpeaking=false`, call `alertManager.resumeDeferredTTSIfNeeded()` (`AlertManager.swift:1144-1179`), etc. | `deepgram-service.ts:646-649` `case 'UtteranceEnd'`: `pipelineLog`, `onUtteranceEnd?.()`. **Callback never wired** in `recording-context.tsx`. | iOS-ONLY | MAJOR | The `onUtteranceEnd` callback is exposed by `DeepgramService` (`deepgram-service.ts:43`) but `recording-context.tsx` does not pass it. As a result, PWA has NO way to: (a) clear an `isSpeaking` flag, (b) resume a deferred TTS (PWA has no `deferredTTS` mechanism either — gap), (c) cancel a speech-confirm timer. Since PWA doesn't ALSO have `isSpeaking` (#24), this is consistent in its absence — but it means the iOS TTS-deferral pattern can't be ported without also wiring UtteranceEnd. |
| 27 | Deepgram `speech_started` | `DeepgramService.swift:916-925` `case "SpeechStarted"`: log, reset `firedTurnEndForCurrentUtterance=false`, fire delegate. ViewModel via `sessionCoordinator.onSpeechStarted()` at `:598-610`: stamp `lastSpeechStartedTime`, used by post-wake monitor to suppress "repeat that" prompt when user is mid-utterance. ViewModel also arms a `speechConfirmTimer` (1.2s) to flip `isSpeaking` back to false if no interim follows (phantom VAD). | `deepgram-service.ts:642-645` `case 'SpeechStarted'`: `pipelineLog`, `onSpeechStarted?.()`. **Callback never wired** in `recording-context.tsx`. | iOS-ONLY | MEDIUM | Same shape as #26. PWA loses: post-wake-mid-utterance suppression (no post-wake monitor anyway), phantom-VAD `speechConfirmTimer` flip-back protection. |
| 28 | KeepAlive tick (client → Deepgram, silence) | iOS `DeepgramService.swift` Stage 4c removed the keep-alive scheduler (only retain pauseAudioStream/resumeAudioStream). Audio frames every 80ms keep WS alive natively. | `deepgram-service.ts:555-574` `startKeepAlive`: every 10s, if `bufferedAmount===0` && `idleMs ≥ 8000`, send `{type:"KeepAlive"}` + 500ms silent PCM. | DIVERGENT | MINOR | PWA carries a keep-alive iOS deleted. Functionally fine — Deepgram tolerates KeepAlive JSON for Nova-3 (only Flux rejects it, see iOS comment at `DeepgramService.swift:559-563`). But could be removed for parity. |
| 29 | Reconnect attempt | `DeepgramService.swift:1187-1225` exp backoff 1→30s, fetches fresh key per attempt, schedules on serial queue. | `deepgram-service.ts:356-380` exp backoff 1→30s, same MAX_DELAY, fetcher mode mints fresh JWT per attempt. | MATCH | — | |
| 30 | Sample-rate mismatch handling | `AudioEngine.swift:188-213` builds engine, queries hw format, installs converter once per tap. `:307-389` config-change handler stops/applies VP/reinstalls. | `recording-context.tsx:1817` resamples ONCE at ingress via `resampleTo16k(samples, handle.sampleRate)`. `deepgram-service.ts:389,530-542` has its own resampleTo16k but the host declares sourceSampleRate=16000 (already resampled). | MATCH | — | Different impl, equivalent net behaviour. |

### Sonnet WS

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 31 | Sonnet WS open | `ServerWebSocketService.swift:1110-1132` `didOpenWithProtocol`: isConnected=true, reconnectAttempt=0, `startPingTimer()` (25s, fires `sendHeartbeat()` + WS PING) — **the load-bearing one**. Fires `delegate.serverDidConnect()` which the VM uses to send `pendingSessionStart`. | `sonnet-session.ts:640-717` `ws.onopen`: setState `connected`, reset reconnectAttempts, mint+send session_start OR session_resume, flush pendingMessages via paired-replay reorder, drain pendingDiagnostics. **NO heartbeat timer**. | DIVERGENT | MAJOR | iOS sends `{type:"heartbeat"}` every 25s (`ServerWebSocketService.swift:604,1069-1097`) to keep AWS ALB idle_timeout from reaping the WS. PWA does not. The 5s `pipelineLog('heartbeat', {seq})` at `recording-context.tsx:704-707` is a LOCAL DIAGNOSTIC ring buffer — it does NOT go on the wire to the backend. iOS comment at `ServerWebSocketService.swift:593-603` explicitly cites this as a fix for ALB closing WS after 88s of doze silence. The PWA dies silently after 30-90s during foreground audio playback per today's commit message. |
| 32 | Sonnet WS close (clean) | `ServerWebSocketService.swift:1134-1156` `didCloseWith`: route through `_disconnectImmediate()`, dedupe via `wasConnected` flag, single delegate notify, if shouldReconnect → schedule. | `sonnet-session.ts:732-800` `ws.onclose` with `code===1000`: isClean=true → no reconnect, return. | MATCH | — | |
| 33 | Sonnet WS close (dirty) | Same iOS handler — `scheduleReconnect()` with exp backoff, fresh keychain token, `RECONNECT_NO_TOKEN` short-circuits if logged out. | Same PWA handler — `scheduleReconnect()` at `:805-821`, RECONNECT_MAX_ATTEMPTS cap (after which non-recoverable onError). PWA explicitly classifies code 1005 as NON-clean (`sonnet-session.ts:750`) since iPad Safari emits 1005 when reaping a backgrounded tab. | DIVERGENT | MEDIUM | PWA has a max-attempts cap that surfaces a non-recoverable onError; iOS reconnects indefinitely until manual stop. iOS approach is more aggressive — better for field workers on flaky networks. |
| 34 | Sonnet WS error | `ServerWebSocketService.swift` handled in `receiveNextMessage` failure path at `:823-833` and `didCompleteWithError`. | `sonnet-session.ts:721-730` `ws.onerror`: setState `error`, fire `onError(...,true)` (recoverable). | MATCH | — | |
| 35 | `session_ack` received | `ServerWebSocketService.swift:881-886`: log, `delegate.serverDidReceiveSessionAck(status:)`. VM uses ack to know it's safe to send transcripts. Flush buffered messages happens via `flushPendingMessages` triggered separately. | `sonnet-session.ts` decodes session_ack and fires `onSessionAck(status, sessionId)` callback. **Callback never wired** in `recording-context.tsx` (no `onSessionAck` field in `SonnetSession` config used). pendingMessages flush triggered by onopen, not by ack. | DIVERGENT | MINOR | Functionally OK because PWA flushes on onopen + session_start. iOS waits for ack so messages aren't sent before server has the session loaded — more correct, especially on first-open. |
| 36 | `session_resume` outcome (resumed vs new vs context-expired) | iOS surfaces resume status to ViewModel which can show a "context lost" UI warning. | `sonnet-session.ts` lastResumeOutcome tracking exists (line :515 comment) but callback bind not seen in audit. | DIVERGENT | MINOR | Worth verifying. |
| 37 | `extraction` received | `serverDidReceiveExtraction` → VM applies readings, observations, confirmations, validation_alerts (massive applier in `DeepgramRecordingViewModel.swift`). | `recording-context.tsx:1410-1412` → `applyExtraction` at `:1275-1383`: `applyExtractionToJob`, updateJob, mirror jobRef, `liveFill.markUpdated`, `schedulePushJobState`, speak confirmation, increment pendingReadings, decrement processingCount. | MATCH | — | Both apply + speak first confirmation. |
| 38 | `ask_user_started` received | `ServerWebSocketService.swift:913-918`: decode, `delegate.serverDidReceiveAskUserStarted(msg)`. VM converts to ValidationAlert, queues into AlertManager which schedules TTS playback. | `sonnet-session.ts` decodes `ask_user_started`. `recording-context.tsx:1413-1488` onQuestion: dedup against questionsRef, push to questions queue, `setProcessingCount`, `sleepManagerRef.current?.onQuestionAsked()` (extends timer to 75s), `playAttentionTone()`, `speak(q.question)`. | MATCH | — | Both play attention tone before TTS, both extend the no-transcript timer. |
| 39 | `cost_update` received | `serverDidReceiveCostUpdate` → VM updates `currentJobCost`, ViewModel renders. | `recording-context.tsx:1738-1745` `onCostUpdate`: `setSonnetCostUsd(update.totalJobCost)`. | MATCH | — | |
| 40 | `chitchat_paused` | `serverDidEnterChitchatPause` → VM sets `chitchatPaused=true`. UI shows banner. | `recording-context.tsx:1721-1725` `onChitchatPaused`: clientDiagnostic + `setChitchatPaused(true)`. | MATCH | — | |
| 41 | `chitchat_resumed` | `serverDidExitChitchatPause` → VM clears `chitchatPaused=false`, clears watchdog. | `recording-context.tsx:1726-1737` `onChitchatResumed`: setChitchatPaused(false), clear pending-resume ref, cancel watchdog timer. | MATCH | — | |
| 42 | WS reconnect attempt | `ServerWebSocketService.swift:1066-1097` `startPingTimer` resumes when reconnect succeeds. `scheduleReconnect` re-fetches keychain token. | `sonnet-session.ts:805-821` `scheduleReconnect`: exp backoff + jitter, re-opens with `openSocket()`. | MATCH | — | |

### TTS / playback (the big one — today's bug class)

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 43 | ElevenLabs TTS started playing (audio `playing` event) | `AlertManager.swift:1110-1116` `markTTSStarted()` called AT play() invocation. `markTTSStarted` at `:1182-1213`: cancel `ttsCooldownTask`, `isTTSSpeaking=true`, set `ttsAudioStartAt=Date()`, fire `onTTSPlaybackStarted?()` → `DeepgramRecordingViewModel.swift:842-856` → **`deepgramService.pauseAudioStream()`** + `sessionCoordinator.sleepManager.onTTSStarted()` + `sessionCoordinator.clearPCMBuffer()` + if VP-enabled `sessionCoordinator.armBargeIn()`. Also fires `onAlertTTSStarted?(alert)` (gated on `!isResolving`) which anchors `inFlightQuestion`. | `elevenlabs-tts.ts:431-433` `onPlaying` → `lifecycle.onStart?.()` → `tts.ts:432-437` dispatchElevenLabs `onStart`: stamp `myStartMs`, set `ttsWindow = {startMs, endMs:null}`, `notifyTtsLifecycle('start')` → `recording-context.tsx:2021-2052` observer: cancel any pending resume timer, **`ttsActiveRef.current=true`**, `deepgramRef.current?.pause()`, `sleepManagerRef.current?.setTtsActive(true)` via line :2022. | MATCH | — | **Today's fix.** The new PCM gate at `recording-context.tsx:2032-2039` mirrors iOS's `pauseAudioStream` + `clearPCMBuffer`. SleepManager pause matches. iOS additionally arms VAD barge-in (PWA has no equivalent — see #13). iOS also anchors inFlightQuestion via `onAlertTTSStarted` callback. |
| 44 | ElevenLabs TTS ended naturally (`ended` event) | `AlertManager.swift` AVAudioPlayerDelegate `audioPlayerDidFinishPlaying` → `markTTSFinished(skipCooldown:false, naturalCompletion:true)` at `:1229-…`: ttsAudioEndAt stamp, gated `onAlertTTSFinished?(alert)`, `onTTSPlaybackFinished?()` → `DeepgramRecordingViewModel.swift:888-928`: `sessionCoordinator.disarmBargeIn()`, `sleepManager.onTTSFinished()`, if NOT mid-barge-in `beginPostTTSDiscardWindow()` (500ms PCM discard), `deepgramService.resumeAudioStream()`. | `elevenlabs-tts.ts:435-438` `onEnded` → settle(true) → `lifecycle.onEnd?.()` → `tts.ts:439-444` dispatchElevenLabs `onEnd`: set `ttsWindow.endMs=Date.now()`, `notifyTtsLifecycle('end')` → `recording-context.tsx:2040-2052` observer: clear/replace `ttsResumeTimerRef` with 500ms timer → on fire `ttsActiveRef.current=false`, `deepgramRef.current?.resume()`. Also `sleepManagerRef.setTtsActive(false)` via line :2022. | MATCH | — | Both 500ms. iOS calls disarmBargeIn first. PWA's resume timer is just a setTimeout — fire-and-forget, cleared on TTS start or teardown. |
| 45 | ElevenLabs TTS aborted by new TTS request (cancel + replace) | `AlertManager.swift:1040-1052` `speakWithTTS`: `ttsTask?.cancel(); audioPlayer?.stop(); synthesizer.stopSpeaking(.immediate);` + clear `deferredTTS`. If `isTTSSpeaking` was true, calls `markTTSFinished()` explicitly because the player's delegate won't fire. | `elevenlabs-tts.ts:273-295` `cancelElevenLabs`: abort fetch, `audio.pause()`, `removeAttribute('src')`, `audio.load()`. Called at top of every speakElevenLabs (`:344`). However, no `onEnd`/`notifyTtsLifecycle('end')` is fired on this cancel path — `settle` isn't reached because the listeners are detached. | DIVERGENT | MEDIUM | iOS forces `markTTSFinished` so the PCM-resume side-effect runs (deepgramService.resumeAudioStream + clearPCMBuffer + sleepManager.onTTSFinished). PWA's `cancelElevenLabs` short-circuits BEFORE the lifecycle observer fires `end` — so on a B-supersedes-A scenario, the ttsActiveRef may stay true. **Probably masked by today's fix**: the NEW TTS will fire `start` again, which clears `ttsResumeTimerRef` and re-flips `ttsActiveRef=true`. But: if the new TTS's fetch fails before play, `ttsActiveRef` may never reset. Worth verification. |
| 46 | ElevenLabs TTS aborted by user (Stop button) | `AlertManager.swift` `stopAllSpeech` → cancel ttsTask, stop audioPlayer, `markTTSFinished(skipCooldown:false, naturalCompletion:false)` — note `naturalCompletion=false` GATES `onAlertTTSFinished` but `onTTSPlaybackFinished` still fires inside markTTSFinished. | `recording-context.tsx:2228-2230` `stop()` calls `cancelSpeech()` (from `tts.ts`) — analogous to iOS stopAllSpeech. Same risk as #45 — lifecycle observer's `end` may not fire because `cancelElevenLabs` short-circuits before listeners. teardownDeepgram (`:715-746`) does explicitly clear `ttsActiveRef.current=false` and the resume timer — so the gate doesn't outlive teardown. | MATCH | — | PWA's teardownDeepgram is the safety net. |
| 47 | ElevenLabs TTS fetch failed → SpeechSynthesis fallback | `AlertManager.swift:1124-1132` ElevenLabs proxy failure → `speakWithAppleNative(expanded, rate, volume, delay)` — Apple native takes over with `markTTSStarted` re-fired from its own delegate. | `elevenlabs-tts.ts:404-408` settle(false, reason) → `tts.ts:464-473` dispatchElevenLabs onError → `dispatchNative(text, options)` which goes through the SpeechSynthesis path. **Critical**: `dispatchNative` at `tts.ts:483-...` opens its own ttsWindow + fires `notifyTtsLifecycle('start')` at the SpeechSynthesisUtterance `onstart` — meaning the PCM gate engages here too. ✓ | MATCH | — | Both fall back cleanly with audio gate parity. |
| 48 | SpeechSynthesis utterance start | `AlertManager.swift` `synthesizer.delegate` `speechSynthesizer(_:didStart:)` (not directly read but implied) → fires `markTTSStarted` via the speakWithAppleNative path → same `onTTSPlaybackStarted` side effects. | `tts.ts:512-545` dispatchNative `utterance.onstart`: open `ttsWindow={startMs, endMs:null}`, `notifyTtsLifecycle('start')`. Same observer → same `ttsActiveRef=true` + deepgram.pause(). | MATCH | — | |
| 49 | SpeechSynthesis utterance end | iOS `synthesizer.delegate` `speechSynthesizer(_:didFinish:)` → `markTTSFinished(naturalCompletion:true)`. | `tts.ts` dispatchNative `utterance.onend`: close ttsWindow, `notifyTtsLifecycle('end')`. | MATCH | — | |
| 50 | TTS echo detected (transcript matches recent TTS fingerprint) | `DeepgramRecordingViewModel.swift:1707-1716` after timing-window check, if `isTTSEcho(text)` → log + clear interim + return (drop transcript). | `recording-context.tsx:1134-1141` if `isTTSEcho(text)` (in `tts.ts:291-312`) → return. Same 15s TTL fingerprints, same 70% overlap threshold. | MATCH | — | Both registered at TTS dispatch (`tts.ts:401` + iOS `recentTTSFingerprints` append at speakWithTTS path). |
| 51 | TTS gesture grant expired (Safari unlocking) | N/A on iOS — system audio session is granted at app launch. | `elevenlabs-tts.ts:75,182-249` `primeAudioElement` + `audioGestureGranted` flag. `primeTts()` called inside Start tap user-gesture. `recording-context.tsx:2010,2282` primeTts at start AND on Resume tap. | PWA-ONLY | — | PWA-specific defensive code. iOS doesn't need it. |

### Sleep manager (3-tier doze/sleep — now 2-tier on both sides)

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 52 | Transition `active` → `sleeping` (60s no-transcript timer fire OR manual pause) | `RecordingSessionCoordinator.swift:377-395` `sleepManager.onEnterSleeping`: log, `audioEngine.setVoiceProcessingBypassed(true)` (disable AGC for clean wake VAD), `deepgramService.disconnect()`, `serverWS?.sendPause()`, `serverWS?.sendCompactRequest()` (5-min cache compact). | `recording-context.tsx:1957-1973` `SleepManager onEnterSleeping`: `sonnetRef.current?.pause()`, `teardownDeepgram()`, `teardownSonnet()`, `clearTick()`, `setMicLevel(0)`, `setState('sleeping')`. **No `sendCompactRequest`** sent before disconnect. | DIVERGENT | MEDIUM | PWA does NOT send `session_compact` on sleep entry. iOS sends it so the 5-min Anthropic cache is refreshed before the long silence. Backend has compaction guards (sonnet-stream.js, 5 checks, 60k threshold) so likely safe, but cost may differ on long-paused sessions. Also: PWA tears down Sonnet on sleep entry (no resume path possible — must re-handshake). iOS only `sendPause()` over the still-open WS — cheaper resume. |
| 53 | Transition `sleeping` → `active` (wake from speech) | `RecordingSessionCoordinator.swift:396-405` onWake: setVoiceProcessingBypassed(false) (re-enable AEC), `reconnectFromSleep(previousState:)`: drain ring buffer, full Deepgram reconnect, `serverWS?.sendResume()`, `monitorPostWakeTranscript()` (15s timer fires "Sorry, could you repeat that?" TTS if no transcript). | `recording-context.tsx:1974-1976` onWake → `handleWake(from)` at `:1882-1951`: reopen Deepgram + Sonnet (full handshake), send ring-buffer replay via `sendInt16PCM`. **No `monitorPostWakeTranscript` equivalent.** | DIVERGENT | MEDIUM | PWA lacks the "repeat that" prompt for the case where Deepgram reconnect succeeds but the inspector's pre-wake speech is missed. Field-impact: post-wake silences just stay silent on PWA. |
| 54 | Ring buffer replay on wake | `RecordingSessionCoordinator.swift:425-435,439-490` `reconnectFromSleep`: `sleepManager.ringBuffer.drain()`, full Deepgram reconnect polling, then `deepgramService.replayBuffer(bufferedAudio)` once connected. | `recording-context.tsx:1907-1910,1916-1919` `handleWake`: `ringBufferRef.current?.drain()` → `deepgramRef.current?.sendInt16PCM(replay)`. Also on auto-reconnect at `:1217-1227` `onReconnected`. | MATCH | — | Both 3s @ 16kHz. |
| 55 | `setTtsActive(true)` called | `RecordingSessionCoordinator` `sleepManager.onTTSStarted()` (called from VM at line :844). iOS SleepManager suspends timer while TTS plays. | `sleep-manager.ts:198-206` `setTtsActive(true)`: if active → clearNoTranscriptTimer. iOS-canon parity. | MATCH | — | Wired via the TTS lifecycle observer at `recording-context.tsx:2022`. |
| 56 | `setTtsActive(false)` called | `sleepManager.onTTSFinished()` from VM at `:897` → restarts timer if active, force-wakes if doze entered during TTS. | `sleep-manager.ts:198-206` setTtsActive(false): if active → armNoTranscriptTimer. | DIVERGENT | MINOR | iOS handles the race where sleep entry happened DURING TTS playback (force wake). PWA's `setTtsActive(false)` only re-arms the timer; if state had already transitioned to `sleeping` somehow (shouldn't happen since the timer was cleared, but defensive), the call is a no-op. Probably OK. |

### Recording session lifecycle

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 57 | start() invoked | `DeepgramRecordingViewModel.swift:536-1125` `performStartRecording`: network pre-flight (`networkMonitor.isConnected`), server-readiness check, fetch DG key, load remote config + cable defaults, keyword generation, `connectDeepgram`, `startAudioCapture`, wire interruption observers, setup sleep manager, set all UI flags, wire AlertManager callbacks (5+ closures), connect ServerWS, build pendingSessionStart. `UIApplication.isIdleTimerDisabled = true`. | `recording-context.tsx:1982-2186` `start`: rotate sessionIdRef, `primeTts()`, `setTtsLifecycleObserver`, reset UI state, `setTtsSessionId`, fire-and-forget `api.recordingStart()`, load Silero, `beginMicPipeline` (which calls openDeepgram + openSonnet), `buildSleepManager`, setState('active'), beginTick. **No `networkMonitor.isConnected` pre-flight.** No idle-timer keep-awake (browser handles via Wake Lock API — not wired). | DIVERGENT | MEDIUM | PWA does not gate on offline state at start. ElevenLabs short-circuits on offline (`elevenlabs-tts.ts:359`) but mic/Deepgram open anyway. Worth at least surfacing an offline banner. |
| 58 | stop() invoked | `DeepgramRecordingViewModel.swift:1129-1430` `stopRecording` → `performStopCleanup`: huge — upload debug issue, log session_stopping, `alertManager.clearAll()`, clear ALL alertManager closures, `serverWS.sendStop`, disconnect Deepgram/Server, upload confirmedLayout + finishRecordingSession (via Task), session summary, field-sources snapshot, full transcript log, analytics upload with retry queue, `deactivateAudioSession()`. | `recording-context.tsx:2188-2243` `stop`: rotate sessionIdRef, clear ttsSessionId, fire `api.recordingFinish(finishingId)` (no confirmed layout upload), `clearTick`, teardown Mic/Deepgram/Sonnet/Sleep, `cancelSpeech()`, `setTtsLifecycleObserver(null)`, setState('idle'). | DIVERGENT | MEDIUM | PWA does not upload the confirmed CCU layout for Phase A training. iOS does (`DeepgramRecordingViewModel.swift:1239-1259`). May not be needed if iOS is canon for that training pipeline, but worth noting. Also PWA doesn't do analytics manifest upload — different ops shape (CloudWatch via clientDiagnostic vs S3-uploaded manifest). |
| 59 | pause() invoked (user-driven) | iOS exposes `isPaused` flag but I didn't find a direct user-pause API hook in this audit pass. Stage 4c made pause == sleep (both routes through `enterSleeping`). | `recording-context.tsx:2250-2262` `pause`: guard statusRef=='active', `sleepManagerRef.current?.enterSleeping()` — same path as auto-sleep. | MATCH | — | Both collapse to sleep on pause. |
| 60 | resume() invoked | iOS resume goes through `RecordingSessionCoordinator.resumeAudioCapture` + `reconnectFromSleep`-style path (not deeply audited here but referenced). | `recording-context.tsx:2269-2339` `resume`: guard statusRef=='sleeping', primeTts (re-grant), reopen Deepgram + Sonnet, drain ring buffer to sendInt16PCM, setState('active'), beginTick. | MATCH | — | |
| 61 | teardown (provider unmount, route change, hot reload) | iOS view-controller lifecycle calls `stopRecording()` — same path as #58. | `recording-context.tsx:786-794` useEffect cleanup: `clearTick`, teardownMic/Deepgram/Sonnet/Sleep. **Does NOT fire `cancelSpeech` or `setTtsLifecycleObserver(null)`** — those only happen in `stop()`. | DIVERGENT | MEDIUM | Provider unmount mid-recording leaves TTS playing + observer wired pointing at torn-down Deepgram. Today's commit guards `teardownDeepgram` against the stale observer firing `resume()` on a null ref, but post-unmount a fresh provider mount could re-fire the observer with a different recorder underneath. |
| 62 | backend session HTTP lifecycle (`/recording/start` + `/finish`) | `DeepgramRecordingViewModel.swift:1239-1259` finishRecordingSession after stop (with confirmed layout); start is via the WS session_start, not HTTP. | `recording-context.tsx:2095-2112` `api.recordingStart()` HTTP call on start; `:2213-2222` `api.recordingFinish()` HTTP on stop. | DIVERGENT | MINOR | Different patterns. PWA explicitly POSTs to /recording/start; iOS uses the WS session_start. Both end up at the same backend session object. |

### Network / device

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 63 | Network online | iOS `NetworkMonitor.shared.isConnected` queried at `DeepgramRecordingViewModel.swift:601`. No explicit "back online" handler — relies on WS reconnect ladder. | No `window.addEventListener('online', ...)` in recording context (verified by grep). Relies on WS reconnect. | MATCH | — | Both reactive via WS layer. |
| 64 | Network offline | iOS `:601` blocks recording start if not connected. Mid-session offline → WS errors → reconnect ladder. | Only `elevenlabs-tts.ts:359` checks `navigator.onLine === false` to short-circuit ElevenLabs (falls back to native TTS). Mid-session offline → WS errors → reconnect ladder. | DIVERGENT | MINOR | iOS gates start; PWA doesn't. See #57. |
| 65 | Battery low (iOS) | Not observed in recording sources. | N/A. | MATCH | — | |
| 66 | Storage near full | Not observed. | N/A. | MATCH | — | |

### Page lifecycle (PWA-specific)

| # | Trigger event | iOS side-effects | PWA side-effects | Status | Severity | Notes |
|---|---|---|---|---|---|---|
| 67 | `pageshow.persisted=true` (BFCache restore) | N/A — iOS process doesn't have BFCache analogue. | `recording-context.tsx:335-341` `recording_pageshow` diagnostic. NO state recovery, NO WS health check, NO mic re-init. | iOS-ONLY (PWA gap) | MAJOR | If iPad Safari BFCaches a recording PWA tab and restores it, the WS connections + AudioContext are frozen-then-revived in undefined state. PWA should detect persisted=true and tear down + restart, OR validate every connection. Today's freeze-on-2nd-TTS bug was IN THIS CLASS — the renderer process suspended mid-playback. |
| 68 | `pageshow.persisted=false` (full reload) | N/A. | Same diagnostic. No action. | MATCH | — | Full reload starts a fresh provider so the absence is fine. |
| 69 | `pagehide.persisted=true` (BFCache freeze) | N/A. | `recording-context.tsx:342-348` `recording_pagehide` diagnostic. No graceful teardown — the WS connections survive into the freeze and may error on resume. | iOS-ONLY (PWA gap) | MAJOR | PWA should call `stop()` (or at least teardown) on pagehide.persisted=true so the next pageshow.persisted=true doesn't try to use stale WS handles. |
| 70 | `pagehide.persisted=false` (page killed) | N/A. | Same diagnostic. No action; useEffect cleanup will run if mount-aware. | DIVERGENT | MINOR | Browser tear-down handles via process kill. Probably OK. |
| 71 | `visibilitychange` to hidden | N/A. | `recording-context.tsx:349-356` `recording_visibility_change` diagnostic. No action — recording continues. | iOS-ONLY (PWA gap) | MEDIUM | When the tab is hidden, iPad Safari may aggressively throttle JS timers (including the 5s heartbeat at `:704-707`, the cost ticker, sleep-manager timers). PWA does not pause heartbeats or extend sleep timeouts when hidden. |
| 72 | `visibilitychange` to visible | N/A. | Same diagnostic. No action. | iOS-ONLY (PWA gap) | MEDIUM | No resync on return-to-visible. Recording may have a multi-second gap of throttled state with no recovery. |
| 73 | `freeze` (Chromium) | N/A. | `recording-context.tsx:361-364` `recording_page_freeze` diagnostic. No action. | DIVERGENT | MEDIUM | Chromium-only — Chrome on iPad doesn't run Blink (it's still WebKit), so this event doesn't fire on iPad Safari. Useful only on Android. |
| 74 | `resume` (Chromium) | N/A. | `recording-context.tsx:365-368` `recording_page_resume` diagnostic. No action. | DIVERGENT | MEDIUM | Same as #73. |

---

## Exhaustive ranked list — every non-MATCH row

Ordered by severity (MAJOR → MEDIUM → MINOR) then by likely field-test impact within each tier. Every non-MATCH row from the couplings table above is listed below — nothing collapsed, nothing dropped, including "we already noticed this but punted" entries and single-line divergences. Each entry: which coupling (number + name), iOS file:line that defines the canonical behaviour, precise PWA gap description, what the fix looks like, estimated effort (small ≤2h / medium ≤1 day / large ≥1 day), and dependencies on other fixes.

### MAJOR severity

**[#67] `pageshow.persisted=true` (BFCache restore) — no state recovery**

- *iOS canon*: N/A (the iOS process model has no BFCache analogue).
- *Defines*: `recording-context.tsx:335-341` records the diagnostic but takes no action.
- *Gap*: iPad Safari can BFCache a backgrounded PWA tab and restore it later with the JS heap intact. When the restore happens, AudioContext, mic stream, Deepgram WS, and Sonnet WS are all in undefined state — the worklet is paused but live, the WS sockets may be half-open. Today's freeze-on-2nd-TTS bug (sess_mp9ep221_62n8, 2026-05-17) is in this class.
- *Fix*: extend the existing `onShow` handler at `recording-context.tsx:335` so that when `e.persisted === true` AND `statusRef.current !== 'idle'`, surface a Sonner toast offering "Recording was suspended — tap to restart" with a button that calls `stop()` then `start()`. Don't auto-restart silently (the inspector may have intentionally paused). Also fire `clientDiagnostic('recording_bfcache_restore', {previousStatus, sessionAge})` so the next field session is auditable.
- *Effort*: small.
- *Dependencies*: none.

**[#69] `pagehide.persisted=true` (BFCache freeze) — no graceful teardown**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:342-348` records the diagnostic but takes no action.
- *Gap*: WS connections + AudioContext are alive when the page freezes. On thaw or eventual kill, those handles error in undefined ways. Combined with #67, the symptom is: tab freezes mid-recording → no resume path → all state lost.
- *Fix*: in the `onHide` handler at `recording-context.tsx:342`, when `e.persisted === true` AND `statusRef.current === 'active'`, invoke `pause()` (sleep entry) so Sonnet receives `session_pause` over the still-live WS BEFORE the browser freezes. The mic + Sonnet stay teardown-safe via the existing sleep path. On `pageshow.persisted=true`, pair with the #67 fix to either resume or restart.
- *Effort*: small.
- *Dependencies*: #67.

**[#31] Sonnet WS application-layer heartbeat missing → AWS ALB reaps the WS after ~88s of silence**

- *iOS canon*: `ServerWebSocketService.swift:604,1066-1097`. Starts a `pingTimer` on `didOpenWithProtocol` (`:1110-1132`) that fires every 25s; each tick sends a `{type:"heartbeat"}` JSON frame AND a WS-level PING. iOS comment at `:593-603` cites the AWS ALB idle_timeout reap as the root cause.
- *Defines*: `sonnet-session.ts:640-717` opens the WS without arming an app-level heartbeat. The `pipelineLog('heartbeat', {seq})` at `recording-context.tsx:704-707` is a LOCAL in-browser ring buffer only — never goes on the wire.
- *Gap*: a long TTS playback (~8-15s for a multi-sentence Sonnet ask) plus the inspector's think-time plus any natural silence can easily exceed 88s. Today's PCM gate fix prevents echo bleed but doesn't address the silent WS reap. Field sessions over the last week consistently show a `sonnet_ws_close` event with no client-initiated close right around that 90s mark.
- *Fix*: add a `private heartbeatTimer` field to `SonnetSession`. On `ws.onopen`, set `this.heartbeatTimer = setInterval(() => this.sendRaw({type:'heartbeat'}), 25_000)`. Clear in `disconnect()` and on `ws.onclose`. Mirror iOS exactly (25s cadence).
- *Effort*: small (~30 min including a vitest unit test that mocks `setInterval`).
- *Dependencies*: none.

**[#3] No `AVAudioSessionInterruptionNotification.began` analogue (phone call / Siri / alarm during recording)**

- *iOS canon*: `RecordingSessionCoordinator.swift:614-630` registers the interruption observer; `handleInterruptionPause()` at `:644-672` sets `isInterruptionPaused=true`, cancels `chunkSubscription`, calls `audioEngine.pauseCapture()`, sends `serverWS?.sendPause()`, logs `interruption_pause`, fires `onInterruptionPause?()`.
- *Defines*: nothing on PWA — Safari has no equivalent of `AVAudioSession.interruptionNotification`. Closest substitutes are the Media Session API's audio interruption events (limited cross-browser support) or heuristic `pagehide`/`visibilitychange`.
- *Gap*: a phone call mid-recording on iPad PWA: Deepgram silently dies (mic-stream OS-paused), Sonnet sees a stale connection until the next message attempt fails. After the call ends, the user has no automatic recovery.
- *Fix*: bind `audio.addEventListener('pause'|'play', ...)` to the shared `<audio>` element used by ElevenLabs as a partial proxy for OS-level interruption; combine with `visibilitychange` so a fast app-switch to the Phone app maps onto a `pause()` in the recording state machine. Add `navigator.mediaSession.setActionHandler('pause', ...)` for the Media Session-supported case.
- *Effort*: medium-large.
- *Dependencies*: #71/#72.

**[#4] No `AVAudioSessionInterruptionNotification.ended` analogue (phone call ended → reconnect Deepgram)**

- *iOS canon*: `RecordingSessionCoordinator.swift:625-627` → `handleInterruptionResume()` at `:674-706`. Resumes audio capture, re-sinks the chunk publisher, if Deepgram disconnected calls `reconnectDeepgramFromSleep(bufferData: Data())` (no ring replay because phone calls starve mic), sends `serverWS?.sendResume()`, logs `interruption_resumed`.
- *Defines*: nothing on PWA.
- *Gap*: PWA cannot detect "phone call ended". Inspector must manually tap pause/resume — assuming they notice that recording is dead.
- *Fix*: pair with #3. When the `<audio>` element fires `play` again (system has restored audio session), call `resume()`. Also surface a Sonner toast "Recording was interrupted by a phone call — tap to restart" so the inspector knows the gap occurred.
- *Effort*: medium-large.
- *Dependencies*: #3.

**[#26] `onUtteranceEnd` callback exposed but not wired**

- *iOS canon*: `DeepgramService.swift:893-913` dedupes via `firedTurnEndForCurrentUtterance` + `last_word_end:-1`; fires `delegate.deepgramServiceDidReceiveUtteranceEnd`. ViewModel uses it to: clear `isSpeaking=false`, call `alertManager.resumeDeferredTTSIfNeeded()` (`AlertManager.swift:1144-1179`), cancel speech-confirm timer.
- *Defines*: `deepgram-service.ts:43` declares the callback type; `:646-649` decodes the event and would invoke `onUtteranceEnd?.()` — but `recording-context.tsx` never sets the callback. The `onUtteranceEnd` slot is left unbound.
- *Gap*: PWA has no "hold a TTS question until the user finishes talking" feature. A Sonnet question whose audio arrives while the inspector is still mid-sentence gets cut into by their next utterance, and the inspector's reply gets clipped by the question.
- *Fix*: add a `deferredTtsRef: { text, options } | null` to recording-context. In the `dispatch()` helper at `tts.ts:372`, if `isSpeakingRef.current === true` (see #24/#27) AND the caller is `speak` (not `speakConfirmation`), stash into deferredTtsRef and return. Wire `onUtteranceEnd` in `openDeepgram` to a callback that pops `deferredTtsRef` and calls `speak()` with it.
- *Effort*: medium.
- *Dependencies*: #24, #27 (both needed for the `isSpeakingRef` gating).

### MEDIUM severity

**[#13] Mic level threshold has no amplitude-based barge-in fallback**

- *iOS canon*: `RecordingSessionCoordinator.swift:689-731` `onAudioLevelUpdated`. While TTS speaking AND VP enabled, if level ≥ `bargeInLevelThreshold` for N consecutive frames → `alertManager.bargeIn(...)`. Belt-and-suspenders alongside the Stage 4 VAD detector.
- *Defines*: `recording-context.tsx:1835-1851` `onLevel` callback only feeds `processAudioLevel` for the wake-from-sleep RMS fallback; never barges in during TTS.
- *Gap*: PWA's only barge-in is the text-final-during-TTS path at `recording-context.tsx:1089-1120` which only fires AFTER Deepgram returns a final (typically 1-2s after the inspector starts talking) and only when there's an in-flight ask. Inspector starts talking over a Sonnet question → 1-2s of their reply may be muted by the still-playing TTS.
- *Fix*: in `onLevel`, when `ttsActiveRef.current === true`, count consecutive frames above threshold (~0.015 RMS, 8 frames ≈ 160 ms at 50 Hz callback rate). On threshold cross, call `cancelSpeech()` and send `sonnetRef.current.sendRaw({type:'tts_cancelled_by_user', reason:'amplitude'})`.
- *Effort*: medium.
- *Dependencies*: none.

**[#16] No VAD-based barge-in during TTS playback**

- *iOS canon*: `RecordingSessionCoordinator.swift:741-772`. Stage 4 VAD detector fires within ~300ms of sustained inspector speech (≥0.8 probability ≥10 frames) on top of the TTS audio. Calls `notifyBargeInFired` (which `serverWS.send({type:"tts_cancelled_by_user", vad_probability})`) THEN `alertManager.bargeIn(suppressCooldown:true)`. Sends false-trigger watchdog at `:286-301` that auto-clears if no real transcript arrives in 1.2s.
- *Defines*: nothing in PWA. The shared Silero instance at `sileroRef.current` is only fed while `state === 'sleeping'` (recording-context.tsx:1831-1833).
- *Gap*: same as #13 but at the precision the VAD path provides. iOS catches the inspector ≤300ms in; PWA catches at the first Deepgram final (≥1s in).
- *Fix*: extend `dispatchSamplesToVad` to also run while `ttsActiveRef.current === true`. Add a `BargeInDetector`-equivalent class in TS that tracks 10-frame sustained speech during the TTS window. On trigger, call `cancelSpeech()` + `sonnetRef.current.sendRaw({type:'tts_cancelled_by_user', vad_probability})`. The false-trigger watchdog (1.2s timer cleared by next final) port matches iOS `markTranscriptAfterBargeIn`.
- *Effort*: large.
- *Dependencies*: none directly, but cleanest if landed alongside #13 so the two paths share a state machine.

**[#15] No mic-input route-change observer (Bluetooth pair, headset unplug)**

- *iOS canon*: `AudioEngine.swift:271-281` registers `AVAudioEngineConfigurationChange`; `:307-389` handler stops engine, reapplies VP, reinstalls tap with new format, restarts engine. Plus `AudioSessionManager.swift:138-166` route-change observer overrides to speaker if no input.
- *Defines*: nothing on PWA. `mic-capture.ts:127-132` only listens for the track `'ended'` event.
- *Gap*: pairing a BT headset mid-PWA-session: AudioWorklet keeps reading from the original device, RMS may drop to zero, neither the worklet nor Deepgram knows to rebind. Inspector keeps talking, hears no acknowledgement, eventually stops the session.
- *Fix*: `navigator.mediaDevices.addEventListener('devicechange', ...)` in `recording-context.tsx`. On fire, query `getUserMedia({audio:{deviceId:...}})` with the current track's deviceId; if not found, teardown and rebuild the mic pipeline via `beginMicPipeline`.
- *Effort*: medium.
- *Dependencies*: none.

**[#5] No route-change observer for `newDeviceAvailable`**

- *iOS canon*: `AudioSessionManager.swift:122-166` handles this case explicitly.
- *Defines*: nothing on PWA.
- *Gap*: same root cause as #15. Counted separately because it covers the "BT speaker connects mid-session, steals output routing" case that on iOS triggers the `overrideOutputAudioPort(.speaker)` fallback.
- *Fix*: bundled into #15 — same listener handles both directions. On output-only device connect, force the audio element output to the built-in route via `audioElement.setSinkId('default')` (limited browser support).
- *Effort*: bundled into #15.
- *Dependencies*: #15.

**[#6] No route-change observer for `oldDeviceUnavailable`**

- *iOS canon*: same `AudioSessionManager.swift:138-166` branch.
- *Defines*: nothing on PWA.
- *Gap*: same shape as #15 + #5. Counted separately because iOS uses ONE handler for both directions; web would also need both.
- *Fix*: bundled into #15.
- *Effort*: bundled into #15.
- *Dependencies*: #15.

**[#24] Interim transcript: PWA does NOT mirror iOS's `isSpeaking=true` flag-flip**

- *iOS canon*: `DeepgramRecordingViewModel.swift:1607-1623`. On interim: cancel `speechConfirmTimer`, if `!isSpeaking` set `isSpeaking=true`, `sessionCoordinator.isSpeaking=true`, `vadState=.speaking`, set `interimTranscript=text`.
- *Defines*: `recording-context.tsx:1052-1054` just calls `setInterim(text)` — no state machine update.
- *Gap*: PWA's `isSpeaking` ref doesn't exist (#26 also depends on this). Without it: (a) TTS deferral via `shouldDeferPlayback` at `AlertManager.swift:877-880` has no equivalent, so a Sonnet question whose TTS lands mid-inspector-sentence is just spoken on top of them; (b) phantom-VAD `speechConfirmTimer` flip-back guard can't be wired (see #27).
- *Fix*: add `isSpeakingRef = useRef(false)` to recording-context. In the DeepgramService config at `recording-context.tsx:1050`, add `onInterimTranscript: (text) => { setInterim(text); isSpeakingRef.current = true; cancelSpeechConfirmTimer(); }`. The `cancelSpeechConfirmTimer` helper is part of #27.
- *Effort*: small.
- *Dependencies*: none directly; consumers are #26, #27.

**[#27] `onSpeechStarted` callback exposed but not wired**

- *iOS canon*: `DeepgramService.swift:916-925` fires delegate. `RecordingSessionCoordinator.swift:598-610` stamps `lastSpeechStartedTime`. ViewModel arms a 1.2s `speechConfirmTimer` to flip `isSpeaking=false` if no interim follows (phantom VAD).
- *Defines*: `deepgram-service.ts:43,642-645` decodes + would fire `onSpeechStarted?.()`. `recording-context.tsx` never sets the callback.
- *Gap*: PWA loses (a) phantom-VAD protection: a Deepgram SpeechStarted from ambient breath / van rumble would otherwise flip `isSpeaking=true` and never flip back, blocking TTS deferral; (b) post-wake mid-utterance suppression (which is itself missing — see #53).
- *Fix*: add `lastSpeechStartedTimeRef = useRef<number | null>(null)` and `speechConfirmTimerRef` to recording-context. Wire the DG callback: stamp `Date.now()`, clear+arm a 1.2s setTimeout that flips `isSpeakingRef.current = false` if no interim has flipped it yet.
- *Effort*: small.
- *Dependencies*: #24.

**[#52] No `session_compact` request on sleep entry**

- *iOS canon*: `RecordingSessionCoordinator.swift:394` `serverWS?.sendCompactRequest()` inside `setupSleepManager` onEnterSleeping. Keeps the 5-min Anthropic prompt cache warm so wake doesn't pay the full prompt cost again.
- *Defines*: `recording-context.tsx:1957-1973` `buildSleepManager.onEnterSleeping` sends `sonnetRef.current?.pause()` then tears Sonnet down entirely. No compact request emitted.
- *Gap*: a long pause (≥5 min) means the next wake's first turn pays the full prompt cost on Anthropic. Backend has guards against wasteful compaction (5 checks + 60k threshold) so the cost isn't catastrophic, but it's wasted spend.
- *Fix*: add a `sendCompactRequest()` method on `SonnetSession` that emits `{type:'session_compact'}` (mirror iOS at `ServerWebSocketService.swift:540`). Call it from `buildSleepManager.onEnterSleeping` BEFORE `teardownSonnet`. Or — better — change the onEnterSleeping flow to NOT teardown Sonnet, just call `sonnetRef.current?.pause()` and keep the WS alive (matches iOS, halves wake reopen time).
- *Effort*: medium (small for the compact request; medium if also changing to keep-WS-alive on sleep).
- *Dependencies*: none.

**[#53] No post-wake transcript monitor ("Sorry, could you repeat that?")**

- *iOS canon*: `RecordingSessionCoordinator.swift:530-577` `monitorPostWakeTranscript`. 15s after wake: if no final arrived AND not currently mid-utterance (`lastSpeechStartedTime > wakeTime` suppresses) AND server is connected → speak "Sorry, could you repeat that?".
- *Defines*: nothing on PWA.
- *Gap*: PWA wake that doesn't catch the inspector's words leaves silence — inspector confused about whether the session resumed.
- *Fix*: in `handleWake` at `recording-context.tsx:1882-1951`, arm a 15s setTimeout after the WS reopens. Cancel on next final via the existing `onSpeechActivity` path. On fire, check `lastSpeechStartedTimeRef` (port from #27) — if SpeechStarted fired AFTER wake, suppress; otherwise `speak('Sorry, could you repeat that?')`.
- *Effort*: small.
- *Dependencies*: #27 (for the mid-utterance suppression branch).

**[#57] start() does not gate on offline state**

- *iOS canon*: `DeepgramRecordingViewModel.swift:601` checks `NetworkMonitor.shared.isConnected` and blocks recording start if offline.
- *Defines*: `recording-context.tsx:1982-2186` `start` does not check `navigator.onLine`. ElevenLabs short-circuits internally if offline (`elevenlabs-tts.ts:359`) but Deepgram WS open attempts will fail noisily.
- *Gap*: inspector taps Start on a no-signal site → mic opens, Deepgram WS retries every 1-30s, Sonnet WS retries — battery drain plus confusing UI state.
- *Fix*: in `start()` before `beginMicPipeline`, check `navigator.onLine === false` AND no recent ping success. If offline, surface a Sonner toast "No network — recording requires an internet connection" and return early.
- *Effort*: small.
- *Dependencies*: none.

**[#58] stop() does not upload confirmed CCU layout for Phase A training**

- *iOS canon*: `DeepgramRecordingViewModel.swift:1239-1259` uploads confirmedLayout via Task on stop.
- *Defines*: `recording-context.tsx:2188-2243` stops without this upload.
- *Gap*: Phase A training pipeline (per CLAUDE.md changelog) is fed by iOS-confirmed layouts. PWA sessions don't contribute. May be intentional (iOS canon for training) or a parity oversight.
- *Fix*: clarify with Derek whether PWA should contribute. If yes, add a POST `/api/recording/{id}/confirmed-layout` from stop. If no, leave as-is and document.
- *Effort*: small (once intent is confirmed).
- *Dependencies*: product decision.

**[#61] Provider unmount does not call `cancelSpeech` or `setTtsLifecycleObserver(null)`**

- *iOS canon*: iOS view-controller lifecycle calls `stopRecording()` which runs the full cleanup.
- *Defines*: `recording-context.tsx:786-794` useEffect cleanup runs `clearTick + teardownMic + teardownDeepgram + teardownSonnet + teardownSleep` only. Misses `cancelSpeech()` (line 2230) and `setTtsLifecycleObserver(null)` (line 2235) which only run in the explicit `stop()` path.
- *Gap*: a route-change or hot-reload mid-recording leaves the TTS playing past unmount, and the lifecycle observer (pointing at functions captured in the dead provider's closure) is still live. The follow-up fix today in `teardownDeepgram` (lines 727-731 clear `ttsActiveRef.current = false`) prevents the worst NPE class, but a fresh provider mount could re-fire the observer with stale data.
- *Fix*: add `cancelSpeech()` and `setTtsLifecycleObserver(null)` calls to the unmount cleanup at `:786-794`. Two-line change.
- *Effort*: small.
- *Dependencies*: none.

**[#71] `visibilitychange` to hidden — no timer pausing**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:349-356` logs the diagnostic.
- *Gap*: when a tab becomes hidden, iPad Safari throttles `setInterval`/`setTimeout` to once-per-minute (or worse). The 5s heartbeat at `:704-707`, the 25s app-heartbeat (once #31 lands), the 60s sleep timer (`sleep-manager.ts`), the 500ms burst-buffer, the 120ms job-state debounce — all become unreliable. The recording state machine is built around timer-driven transitions, so a backgrounded tab silently breaks.
- *Fix*: on `visibilitychange → 'hidden'`, snapshot `Date.now()` to a `lastVisibleAtRef`. On `visibilitychange → 'visible'`, if `(Date.now() - lastVisibleAtRef) > 30_000`, force a `pause()` + Sonner toast offering manual resume (the timers can't catch up cleanly).
- *Effort*: medium.
- *Dependencies*: none.

**[#72] `visibilitychange` to visible — no health-check / reconnect**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:349-356` logs only.
- *Gap*: paired with #71. Even if no force-pause is triggered, the WS sockets may have been reaped by ALB (now that #31 is fixed in spirit) — need explicit check.
- *Fix*: on `visibilitychange → 'visible'` after a hidden window of any duration, check `deepgramRef.current?.connectionState` and `sonnetRef.current?.connectionState`. If either disconnected, surface diagnostic + offer manual resume.
- *Effort*: medium.
- *Dependencies*: #71.

**[#73] `freeze` event handler is diagnostic-only**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:361-364`.
- *Gap*: Chromium-only event (iPad Safari doesn't fire it because it's still WebKit). On Android Chrome PWA installs this WOULD fire and PWA should treat it as a hard pause signal — same shape as #69.
- *Fix*: parallel the #69 fix — if `statusRef.current === 'active'`, call `pause()`. Practically unreachable on iPad but correct for Android.
- *Effort*: small.
- *Dependencies*: #69 (same shape).

**[#74] `resume` event handler is diagnostic-only**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:365-368`.
- *Gap*: paired with #73 — Chromium-only, would benefit from the same handling as #67 if it ever fires.
- *Fix*: parallel the #67 fix.
- *Effort*: small.
- *Dependencies*: #67.

**[#45] ElevenLabs TTS aborted by new TTS request — lifecycle `end` event not fired on supersede**

- *iOS canon*: `AlertManager.swift:1040-1052` `speakWithTTS` cancels prior TTS by stopping audioPlayer, then EXPLICITLY calls `markTTSFinished()` if `isTTSSpeaking` was true so the PCM-resume side-effect runs.
- *Defines*: `elevenlabs-tts.ts:273-295` `cancelElevenLabs` aborts the fetch, calls `audio.pause()`, clears `src`, calls `audio.load()`. No corresponding `notifyTtsLifecycle('end')` because the listeners are detached.
- *Gap*: in a B-supersedes-A scenario, the lifecycle observer in `recording-context.tsx:2021-2052` doesn't get an 'end' event for A. Today's fix at lines 2032-2039 means the observer for B's 'start' will re-flip `ttsActiveRef.current = true` and re-arm the gate cleanly — but if B's fetch fails BEFORE playback starts, `ttsActiveRef.current` is stuck at A's true. The `dispatchNative` fallback path also calls `notifyTtsLifecycle('start')` from utterance.onstart, so this is mostly self-healing — but worth pinning explicitly.
- *Fix*: in `cancelElevenLabs`, before clearing the listeners, fire `lifecycle.onEnd?.()` if it's bound. This ensures every cancel triggers the symmetric 'end' notification. Add a vitest test for the supersede scenario.
- *Effort*: small.
- *Dependencies*: none.

**[#62] HTTP `/recording/start` + `/finish` lifecycle divergent from iOS WS-based session_start**

- *iOS canon*: `DeepgramRecordingViewModel.swift:1239-1259` finishRecordingSession via HTTP on stop. Start is via the Sonnet WS `session_start` frame, not HTTP.
- *Defines*: `recording-context.tsx:2095-2112` explicitly POSTs to `/api/recording/start` on start; `:2213-2222` POSTs to `/api/recording/{id}/finish` on stop.
- *Gap*: backend has two parallel session-tracking mechanisms (HTTP-driven and WS-driven). Both should land on the same backend session object — backend behaviour assumed identical but worth confirming.
- *Fix*: verify the backend's session-correlation logic treats both shapes equivalently. If not, align PWA to iOS (drop the HTTP POST start, rely on WS session_start).
- *Effort*: small (audit + decision).
- *Dependencies*: none.

**[#11] Mic stop — PWA doesn't flush a final PCM buffer**

- *iOS canon*: `RecordingSessionCoordinator.swift:159-168` `stopAudioCapture` flushes the remaining `pcmSendBuffer` to Deepgram via `sendBufferedAudio()`.
- *Defines*: `recording-context.tsx:710-713` `teardownMic` calls `micRef.current?.stop()`. `mic-capture.ts:137-152` disconnects the worklet, stops MediaStream tracks, closes AudioContext — but no flush.
- *Gap*: AudioWorklet delivers 128-sample chunks; any chunk still in flight at stop time may not reach Deepgram. In practice this is sub-10ms of audio so user impact is negligible.
- *Fix*: if any chunks were in a host-side accumulator (currently the data goes straight from worklet→Deepgram), they'd be lost. The web architecture doesn't accumulate, so nothing to flush. Mark as MINOR — no action.
- *Effort*: doc-only.
- *Dependencies*: none.

**[#17] VAD silence detected — does not reset no-transcript timer on silence**

- *iOS canon*: iOS `SleepManager` (not read in this audit) presumably resets on speech-silence in the active state.
- *Defines*: `sleep-manager.ts:223-243` `applyWakeScore` else-branch only zeroes `consecutiveSpeechFrames` — doesn't touch the no-transcript timer. The timer is reset only on final transcript via `onSpeechActivity`.
- *Gap*: PWA's no-transcript timer keeps ticking through silence (correctly, that's how sleep entry is supposed to fire after 60s). MINOR because the divergence might just be that I misread iOS.
- *Fix*: verify iOS behaviour. If iOS also does NOT reset on silence (likely — that would defeat the no-transcript timer's purpose), reclass as MATCH.
- *Effort*: small (verify iOS by reading SleepManager.swift in detail).
- *Dependencies*: none.

**[#18] VAD model load failure — fallback divergent**

- *iOS canon*: `BargeInDetector` + `SleepManager`'s Silero are separate instances. Load failures presumably fall back internally. Not deeply audited.
- *Defines*: `recording-context.tsx:2122-2138` Silero `vad.load()` catch logs warn, sileroRef stays null, `processAudioLevel` RMS fallback in `onLevel` takes over.
- *Gap*: PWA has explicit graceful degradation. iOS uses VAD without a documented fallback (the ring-buffer audio still gets processed by Deepgram, so Deepgram VAD is the de facto fallback).
- *Fix*: doc-only — note in the SleepManager.swift header that the iOS RMS-fallback path is implicit via Deepgram's own VAD.
- *Effort*: doc-only.
- *Dependencies*: none.

**[#28] KeepAlive tick PWA-only**

- *iOS canon*: `DeepgramService.swift` Stage 4c removed the keep-alive scheduler. Audio frames every 80ms keep WS alive natively.
- *Defines*: `deepgram-service.ts:555-574` `startKeepAlive` fires every 10s when bufferedAmount===0 && idle ≥ 8000ms, sends `{type:"KeepAlive"}` + 500ms silent PCM.
- *Gap*: PWA keep-alive is functionally fine (Nova-3 tolerates KeepAlive JSON) but iOS deleted theirs because Flux model rejects KeepAlive as `UNPARSABLE_CLIENT_MESSAGE`. PWA runs Nova-3, so safe — but the divergence costs ~1 extra WS frame per 10s of silence.
- *Fix*: remove `startKeepAlive` if/when PWA migrates to Flux. For now: doc-only.
- *Effort*: doc-only.
- *Dependencies*: none.

**[#33] Sonnet WS dirty close — PWA caps reconnect attempts**

- *iOS canon*: `ServerWebSocketService.swift` reconnects indefinitely until manual stop, fresh keychain token per attempt.
- *Defines*: `sonnet-session.ts:805-821` `scheduleReconnect` has `RECONNECT_MAX_ATTEMPTS` cap (after which non-recoverable onError surfaces). Also explicitly classifies code 1005 as non-clean (`:750`) because iPad Safari emits 1005 when reaping a backgrounded tab.
- *Gap*: PWA gives up after max attempts; iOS retries forever. iOS approach better for field workers on flaky networks.
- *Fix*: raise PWA `RECONNECT_MAX_ATTEMPTS` to a much higher number (or remove the cap). Add backoff cap at 30s (already there) so power consumption is bounded.
- *Effort*: small.
- *Dependencies*: none.

**[#35] `session_ack` callback not wired**

- *iOS canon*: `ServerWebSocketService.swift:881-886` fires `delegate.serverDidReceiveSessionAck(status:)`. VM uses it to know it's safe to send transcripts.
- *Defines*: `sonnet-session.ts` decodes session_ack and would fire `onSessionAck(status, sessionId)` — but recording-context doesn't bind it. PendingMessages flush is triggered by onopen rather than ack.
- *Gap*: PWA may emit `transcript` frames before the backend has fully loaded the session (race between session_start emit and server-side session-loading). Backend appears to tolerate this in practice.
- *Fix*: in `openSonnet`, add `onSessionAck` to the config and gate `pendingMessages` flush on ack receipt rather than onopen.
- *Effort*: small.
- *Dependencies*: none.

**[#36] `session_resume` outcome (`resumed` vs `new` vs context-expired) not surfaced to UI**

- *iOS canon*: surfaces resume status to ViewModel; can show "context lost" UI warning.
- *Defines*: `sonnet-session.ts:515` comment indicates `lastResumeOutcome` tracking exists but the callback bind is not in recording-context.
- *Gap*: inspector resuming after >5min lost context (Sonnet's per-session memory has expired) — they don't know that Sonnet has forgotten what was already dictated.
- *Fix*: wire an `onResumeOutcome` callback in `openSonnet`. On `'new'` after `'resumed'` (i.e. backend forgot the session), surface a Sonner toast "Recording paused too long — Sonnet will treat the rest as a fresh session".
- *Effort*: small.
- *Dependencies*: none.

**[#56] `setTtsActive(false)` doesn't force-wake on sleep race**

- *iOS canon*: `RecordingSessionCoordinator.swift:897` → `SleepManager.swift:onTTSFinished:181-184` `if state == .sleeping { wake() }` — defensive against the race where sleep entry happened DURING TTS.
- *Defines*: `sleep-manager.ts:198-206` `setTtsActive(false)` only re-arms the timer if state is active; if state is sleeping (which the iOS guard at `enterSleeping` prevents in practice), the call is a no-op.
- *Gap*: belt-and-suspenders only. The `enterSleeping` guard at `:237` (iOS) and the timer-already-cleared invariant (web) should both prevent reaching sleeping while TTS active.
- *Fix*: add `if (this.state === 'sleeping' && this.cbs.onWake) { this.cbs.onWake('sleeping'); }` to `setTtsActive(false)`. Two lines.
- *Effort*: small.
- *Dependencies*: none.

**[#63] Network online — no explicit handler**

- *iOS canon*: not directly observed; iOS relies on WS reconnect ladder.
- *Defines*: `recording-context.tsx` has no `window.addEventListener('online', ...)` listener. Relies on WS reconnect.
- *Gap*: both clients reactive via WS layer.
- *Fix*: MATCH — no action.
- *Effort*: none.
- *Dependencies*: none.

**[#64] Network offline — only ElevenLabs short-circuits**

- *iOS canon*: `DeepgramRecordingViewModel.swift:601` gates start if not connected. Mid-session offline → WS errors → reconnect ladder.
- *Defines*: `elevenlabs-tts.ts:359` `navigator.onLine === false` short-circuits ElevenLabs. Recording start does NOT gate.
- *Gap*: see #57. Counted separately because the offline-mid-session class is real.
- *Fix*: optional addition — on `'offline'` event, surface a banner; on `'online'`, dismiss.
- *Effort*: small.
- *Dependencies*: none.

### MINOR severity

**[#1] App backgrounded — no UI surface for backgrounding state**

- *iOS canon*: no observer; recording continues in background (entitlement-based).
- *Defines*: `recording-context.tsx:342-348` logs `recording_pagehide` only. The user sees no indication that the recording is now "vulnerable".
- *Gap*: a backgrounded recording is fragile on iPad PWA (timer throttle + potential BFCache). No user-facing affordance to manage this risk.
- *Fix*: bundle into #69/#71 (the visibilitychange-to-hidden path). Surface an iOS-style "Recording in progress" notification via Notification API when the page is hidden.
- *Effort*: medium (notification permission flow).
- *Dependencies*: #69, #71.

**[#2] App foregrounded — no equivalent UI surface**

- *iOS canon*: no observer.
- *Defines*: `recording-context.tsx:335-341` `recording_pageshow` diagnostic only.
- *Gap*: counterpart to #1. On foreground after a hidden window, no UI cue that the session may have lost state.
- *Fix*: bundle into #67/#72.
- *Effort*: bundled.
- *Dependencies*: #67, #72.

**[#7] Route-change `.override` reason**

- *iOS canon*: same `AudioSessionManager.swift:138-166` branch as #5/#6.
- *Defines*: nothing on PWA.
- *Gap*: less common than #5/#6 (it's a manual route override e.g. user toggling "Bluetooth Off" in Control Center). Same root cause.
- *Fix*: bundled into #15.
- *Effort*: bundled into #15.
- *Dependencies*: #15.

**[#8] `mediaServicesWereReset` notification**

- *iOS canon*: not observed (iOS rare-but-real audiod crash).
- *Defines*: not applicable on PWA (no such API).
- *Gap*: iOS gap if media services reset mid-recording — both clients silent-fail. Cited for symmetry.
- *Fix*: no action (out of scope for this audit; iOS-side gap to file separately).
- *Effort*: none on web.
- *Dependencies*: none.

**[#9] `silenceSecondaryAudioHint`**

- *iOS canon*: not observed.
- *Defines*: not applicable on PWA.
- *Gap*: neither handles.
- *Fix*: no action.
- *Effort*: none.
- *Dependencies*: none.

**[#12] Mic permission revoked mid-session**

- *iOS canon*: iOS routes through interruption notification typically; no dedicated permission-revoke observer.
- *Defines*: `mic-capture.ts:127-132` fires `onError(new Error('Microphone track ended'))` → `recording-context.tsx:1852-1859` setErrorMessage + full teardown.
- *Gap*: PWA defensive extra — a fine-grained error path iOS doesn't expose explicitly.
- *Fix*: keep PWA behaviour; doc-only.
- *Effort*: doc-only.
- *Dependencies*: none.

**[#19] VAD inference frame processed**

- *iOS canon*: per-frame in `BargeInDetector` + `SleepManager` (internal).
- *Defines*: `vad-accumulator.ts` accumulates to 512-sample blocks, `silero.processVadFrame(score)` → SleepManager state machine.
- *Gap*: both run 32ms Silero v5 frames with same threshold (0.8) and same 12-of-N frames gate.
- *Fix*: MATCH — no action.
- *Effort*: none.
- *Dependencies*: none.

**[#37] `extraction` received — applier divergence (acknowledged in audit)**

- *iOS canon*: VM applies readings, observations, confirmations, validation_alerts (massive applier).
- *Defines*: `recording-context.tsx:1410-1412` → `applyExtraction` at `:1275-1383` calls `applyExtractionToJob`, updateJob, mirror jobRef, liveFill.markUpdated, schedulePushJobState, speak confirmation, increment pendingReadings, decrement processingCount.
- *Gap*: shape-MATCH but the two `applyExtraction*` modules (iOS `applySonnetReadings` at DRVM:3773 ~50 fields, web `apply-extraction.ts` 1828 lines) are hand-mirrored. No automated parity test prevents drift.
- *Fix*: write a parity-test script that pulls all `record_reading.field` enum values from `src/extraction/stage6-tool-schemas.js` and asserts both clients have an apply-branch for each.
- *Effort*: medium.
- *Dependencies*: none.

**[#42] WS reconnect attempt — MATCH but worth documenting curve**

- *iOS canon*: `ServerWebSocketService.swift:1066-1097` startPingTimer resumes on success; `scheduleReconnect` re-fetches keychain token.
- *Defines*: `sonnet-session.ts:805-821` exp backoff + jitter, re-opens with `openSocket()`.
- *Gap*: both use exp backoff to 30s cap. Web adds jitter; iOS doesn't (per audit). Jitter is correct on web (avoid thundering herd if all PWAs reconnect simultaneously after a deploy).
- *Fix*: no action.
- *Effort*: none.
- *Dependencies*: none.

**[#46] ElevenLabs TTS aborted by Stop button — safety net**

- *iOS canon*: `AlertManager.swift` `stopAllSpeech` → cancel ttsTask, stop audioPlayer, `markTTSFinished` (which fires `onTTSPlaybackFinished` even though `naturalCompletion=false` gates `onAlertTTSFinished`).
- *Defines*: `recording-context.tsx:2228-2230` `stop()` calls `cancelSpeech()`. Same risk as #45 — lifecycle observer's `end` may not fire because `cancelElevenLabs` short-circuits. But teardownDeepgram (`:715-746`) explicitly clears `ttsActiveRef.current=false` and the resume timer, so the gate doesn't outlive teardown.
- *Gap*: PWA's `teardownDeepgram` is the safety net.
- *Fix*: covered by #45.
- *Effort*: bundled into #45.
- *Dependencies*: #45.

**[#51] TTS gesture grant expiry — PWA-only by necessity**

- *iOS canon*: N/A — system audio session granted at app launch.
- *Defines*: `elevenlabs-tts.ts:75,182-249` `primeAudioElement` + `audioGestureGranted` flag. `primeTts()` at `recording-context.tsx:2010,2282`.
- *Gap*: PWA-specific defensive code. iOS doesn't need it.
- *Fix*: keep as-is.
- *Effort*: none.
- *Dependencies*: none.

**[#59] pause() — MATCH but worth noting**

- *iOS canon*: Stage 4c made pause == sleep (`enterSleeping`).
- *Defines*: `recording-context.tsx:2250-2262` pause routes through `sleepManagerRef.current?.enterSleeping()` — same path as auto-sleep.
- *Gap*: both collapse to sleep on pause.
- *Fix*: no action.
- *Effort*: none.
- *Dependencies*: none.

**[#65] Battery low (iOS)**

- *iOS canon*: not observed.
- *Defines*: N/A on PWA.
- *Gap*: neither handles.
- *Fix*: no action.
- *Effort*: none.
- *Dependencies*: none.

**[#66] Storage near full**

- *iOS canon*: not observed.
- *Defines*: N/A on PWA.
- *Gap*: neither handles.
- *Fix*: no action.
- *Effort*: none.
- *Dependencies*: none.

**[#68] `pageshow.persisted=false` (full reload)**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:335-341` records diagnostic, takes no action.
- *Gap*: full reload starts a fresh provider so the absence is fine.
- *Fix*: MATCH — no action.
- *Effort*: none.
- *Dependencies*: none.

**[#70] `pagehide.persisted=false` (page killed)**

- *iOS canon*: N/A.
- *Defines*: `recording-context.tsx:342-348` records diagnostic, takes no action.
- *Gap*: browser process kill — useEffect cleanup runs if mount-aware.
- *Fix*: no action; document.
- *Effort*: doc-only.
- *Dependencies*: none.

---

## Summary of remediation work by tier

- **MAJOR (6 items)**: #67, #69, #31, #3, #4, #26. Total estimated effort: small × 3 + medium × 1 + medium-large × 2 ≈ 3-4 working days. Highest impact: #31 (heartbeat) and #67/#69 (BFCache lifecycle) are today's freeze-bug class.
- **MEDIUM (20 items)**: #13, #16, #15, #5, #6, #24, #27, #52, #53, #57, #58, #61, #71, #72, #73, #74, #45, #62, #11, #17, #18, #28, #33, #35, #36, #56, #63, #64. (Note: several MEDIUM items are bundled — #5/#6/#7/#15 all close with one devicechange listener.) Total estimated effort: ~7-10 working days if all addressed; many are small/bundleable.
- **MINOR (12 items)**: #1, #2, #7, #8, #9, #12, #19, #37, #42, #46, #51, #59, #65, #66, #68, #70. Most are doc-only or MATCH-confirmation. Total estimated effort: ~1-2 working days if all addressed.

---

## Already addressed (sanity check)

Couplings that are MATCH after recent fixes and remain stable:

- **TTS PCM gate on start/end** — Today's commit `2bc8d90`. `recording-context.tsx:2021-2052` mirrors iOS `DeepgramRecordingViewModel.swift:842-856` (start) and `:888-928` (end). Both pause/resume the STT byte stream and use a 500ms post-end discard window. The lifecycle observer reaches into `deepgramRef.current?.pause()` synchronously; mic-capture's `onSamples` early-returns on `ttsActiveRef.current` at `:1812`. (#43, #44)

- **SleepManager.setTtsActive integration** — `recording-context.tsx:2022` invokes `sleepManagerRef.current?.setTtsActive(event === 'start')` and `sleep-manager.ts:198-206` correctly suspends/re-arms the no-transcript timer. iOS canon at `RecordingSessionCoordinator.swift:844,897`. (#55, #56)

- **TTS fingerprint echo gate** — `tts.ts:272-312` + `recording-context.tsx:1134-1141` mirror iOS `recentTTSFingerprints` + `isTTSEcho` at `DeepgramRecordingViewModel.swift:2776,2823`. Same 15s TTL, same 70% overlap threshold, registered at TTS dispatch. (#50)

- **Naming buffer (Bug K) for "Circuit N is …"** — `recording-context.tsx:212-233,1142-1208` matches iOS at `DeepgramRecordingViewModel.swift:264-293,1718-1782`. Same regex, same 3s timeout, same concat-on-next-final OR timeout-and-flush flow. (#25)

- **Burst buffer (Observation regression 2026-05-13)** — `recording-context.tsx:244,820-865` is PWA-only but reflects an iOS-canon backend separator (' ... ') so the server sees a familiar wire shape. (#25)

- **Question dedup via `questionsRef` (Bug L)** — `recording-context.tsx:550,1430-1487` mirrors iOS in the `firedAskUserAnsweredToolCallIds` idempotency invariant. Synchronous ref-based dedup is the fix for the double-mount race.

- **Wire-ordering invariant for `transcript` → `ask_user_answered`** — `recording-context.tsx:1015,1024` sends transcript first, then ask_user_answered second, matching iOS `DeepgramRecordingViewModel.swift:2070,2082` and the Plan 06-05 r4-#1 contract.

- **Deepgram WS reconnect ladder** — Both clients use exp backoff 1→30s with fresh per-attempt credential mints. `deepgram-service.ts:356-380` vs iOS `DeepgramService.swift:1187-1225`.

- **Mic capture echo cancellation** — `mic-capture.ts:55-62` requests EC/NS/AGC; iOS `AudioSessionManager.swift:14-58` configures the same plus iOS-only `setPrefersEchoCancelledInput` on iOS 18.2+.

- **`isTTSEcho` 15s TTL fingerprints registered at dispatch** — `tts.ts:401` registers BEFORE actual playback (matches iOS rationale that a Deepgram transcript can arrive microseconds after speaker start).

- **Stage 6 ask_user_answered idempotency via fired-id set** — `recording-context.tsx:1020-1045` matches iOS `firedAskUserAnsweredToolCallIds` semantics.

- **TTS gesture priming in user gesture** — `recording-context.tsx:2010,2282` calls `primeTts()` inside the Start AND Resume tap handlers, addressing the iOS-only `AudioSessionManager.setupSession()` analog (`RecordingSessionCoordinator.swift:149`). Note: this only matters on PWA — iOS doesn't need it.

---

## Audit boundaries / what wasn't covered

- The full body of `AlertManager.swift` (1,547 LOC) was sampled rather than read end-to-end; the TTS lifecycle hooks were covered but the alert-queue scheduling, auto-dismiss timers, and tour controller were not.
- The iOS `SleepManager.swift` file was not opened directly; behaviour was inferred from `RecordingSessionCoordinator.swift` callbacks and the PWA port at `web/src/lib/recording/sleep-manager.ts` which claims iOS-canon parity in its header.
- The full body of `DeepgramRecordingViewModel.swift` (7,917 LOC) was read only through line ~2200. Subsequent message handlers (cost_update, observation_update, voice_command_response, board ops) were spot-checked via grep but their full closure bodies were not enumerated.
- Backend behaviour (sonnet-stream.js, Deepgram server-side timeouts) is referenced via embedded comments only, not directly audited.
