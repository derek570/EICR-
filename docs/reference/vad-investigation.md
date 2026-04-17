# VAD / Sleep-Wake Investigation Journal

> Historical investigation notes extracted from `CLAUDE.md` as part of the
> April 2026 doc cleanup. These are dated snapshots — the **current-state**
> description of the doze/wake pipeline lives in
> [ios-pipeline.md](ios-pipeline.md).

---

## 2026-02-26 — Sleep & Re-Wake Investigation

### What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

### Findings

#### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`.
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation.
- No simulator logs existed either — the `CertMateLogs` directory was never created in the simulator container.
- macOS unified log had zero CertMate entries for the past 48 hours.

#### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`.
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days.
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (`ServerWebSocketService`), but these had **no logging** — they were silent.

#### Git History Unrecoverable (at the time)
- Both repos (EICR_App and CertMateUnified) had broken git due to iCloud sync conflicts.
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files.
- Could not recover diffs to see what logging was removed during cleanup.

#### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac.
2. Xcode → Devices & Simulators → Download CertMateUnified container.
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files.

#### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead.
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram.
- **Wake**: VAD detects N consecutive frames above threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming.
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?".

### Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

#### Backend — `sonnet-stream.js`
- `session_pause`: Now logs sessionId, turn count when iOS enters sleep/dozing.
- `session_resume`: Now logs sessionId, pause duration (ms + sec), turn count on wake.

#### Backend — `ws-recording.js`
- `handleDeepgramMessage`: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events.
- `handleStreamAudio`: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected).

#### iOS — `SleepManager.swift`
- `start()`: Logs VAD loaded, timeout config.
- `stop()`: Logs final state.
- `enterDozing()`: Logs state transition with timeout values (AppLogger + DebugLogger JSONL).
- `enterSleeping()`: Logs state transition (AppLogger + DebugLogger JSONL).
- `wake()`: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL).
- `processChunk()`: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence.

#### iOS — `AudioRingBuffer.swift`
- `drain()`: Now logs sample count, byte count, and duration in ms.

#### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

### Session Optimizer Fixed — 2026-02-26

`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

#### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but the file lives at `../src/extraction/eicr-extraction-session.js` — fixed (2 occurrences).
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — added new section 14.

#### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations).
- Buffer replay events (ring buffer drained and sent to Deepgram on wake).
- Deepgram cost savings calculation (sleep duration × $0.0077/min).
- Stream pause/resume counts.
- Reconnect queue flushes and timeouts.
- Post-wake transcript failures (wake happened but no speech captured).

#### Optimizer Status
- LaunchAgent loaded and running (PID active).
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`.
- Logs: `~/.certmate/session_optimizer.log`.
- Polls S3 every 120 seconds.

#### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in `ChunkProcessor` forces probability to 0 below amplitude `0.0005`.

---

## 2026-03-05 — Tuning + cost-tracking fixes

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold `0.5`, 3 consecutive frames (90 ms).
- **After**: threshold `0.85`, 30 consecutive frames (900 ms).
- **Why**: False wakes from phone movement / breathing / tools. 900 ms latency is still within the 3-second ring buffer.
- Commit: `34beac4` (and subsequent) in CertMateUnified.

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep).
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states.
- Commit: `4c75ccf` in CertMateUnified.

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all `STREAM_PAUSED` / `STREAM_RESUMED` pairs.
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`).
- `deepgram_saved_usd` based on total stream pause time, not just sleep-cycle duration.
- Commit: `123b038` in EICR_App.

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (`accept`/`reject`/`rerun`) in `feedback.js`.
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401.
- Commit: `25072cf` in EICR_App.

### Question Gate Debounce Increased
- `question-gate.js` `GATE_DELAY_MS` changed from 2000 → 2500 ms.
- Tests updated to match (17 tests passing).
- Commit: `b606e21` in EICR_App.

### Deployment Notes
- All EICR_App changes deployed to AWS ECS.
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026).
- iOS changes committed — require Xcode rebuild + deploy to device.
- Manually accepted 3 outstanding optimizer reports via curl.

---

## 2026-03-06 — Hybrid VAD: Deepgram for Doze, Silero for Wake Only

- **Before**: On-device Silero VAD handled **both** doze entry (silence detection) AND wake (speech detection).
- **After**: Deepgram's server-side `UtteranceEnd` signal drives doze entry; Silero is only used for wake from doze/sleep.
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but **not** in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram `UtteranceEnd` (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → `enterDozing`. Any `SpeechStarted` or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900 ms) above `0.85` threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events.
- Removed `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from `SleepManager`.
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`.

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep-cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle.
- iOS changes require Xcode rebuild + deploy to device.
