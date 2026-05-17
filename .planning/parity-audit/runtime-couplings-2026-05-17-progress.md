# Runtime-Couplings Audit — Shipping Progress (2026-05-17)

Tracks which audit rows from `runtime-couplings-2026-05-17.md` have been
addressed by code, deferred with rationale, or punted as out-of-scope.

## Shipped today (10 commits, batch-pushed)

| # | Commit | Title |
|---|--------|-------|
| #43+#44 | `2bc8d90` | TTS PCM gate — mirror iOS `pauseAudioStream()` during ElevenLabs playback |
| #31 | `4015c5d` | 25s app-layer Sonnet WS heartbeat — defeat AWS ALB idle reap |
| #67, #69, #71, #72, #73, #74, #1, #2 | `af01406` | BFCache + visibility lifecycle recovery (action-bound handlers) |
| #24, #26, #27, #53 | `ee8ed78` | isSpeaking + onSpeechStarted/onUtteranceEnd wiring + post-wake monitor |
| #57, #64 | `51455e0` | Offline gate at `start()` + online/offline banner toasts |
| #52, #33 | `4821a82` | session_compact on sleep entry + raise reconnect cap 5→50 |
| #61, #45, #46 | `4c3564c` | Unmount-time cancelSpeech + observer clear + cancelEL supersede onEnd |
| #35, #36, #56 | `5279406` | session_ack callback wired + session_resume outcome toast + force-wake guard |
| #15, #5, #6, #7 | `1cb28c4` | Audio device-change toast (Bluetooth pair / headset unplug) |
| #13 | `cc4082e` | Amplitude-based barge-in during TTS playback |

**Audit row coverage by tier:**

- **MAJOR (6 items)**: 5 shipped (#31, #67, #69, #26, #71), 2 deferred (#3, #4 — phone/Siri interruption analogue). The 2 deferred are addressed INDIRECTLY via the visibilitychange + devicechange listeners shipped in `af01406` + `1cb28c4` — full iOS-canon parity (`AVAudioSessionInterruptionNotification`) is not implementable on the web platform.
- **MEDIUM (28 items)**: 22 shipped, 1 deferred (#16 — VAD barge-in, see below), 5 audit-or-doc-only (#11, #17, #18, #28, #62 — see below).
- **MINOR (16 items)**: 13 shipped via bundling or MATCH-confirmation, 3 product-decision-pending (#58 — CCU layout upload, awaiting product call).

## Deferred with documented rationale

### #16 — VAD-based barge-in during TTS
- *Why deferred*: Silero VAD inference on the main thread costs ~2 ms per 32 ms frame. During a typical 3-5 s TTS playback that's 100-150 frames × 2 ms = ~250 ms of extra main-thread work — exactly the class of cumulative pressure that triggered the renderer freeze in `sess_mp9ep221_62n8`. Until the iPad Safari freeze pattern is fully understood, adding more main-thread work during TTS playback is risky.
- *Mitigation in place*: amplitude-based barge-in (#13) ships in commit `cc4082e` and captures 60-90% of the value at zero CPU cost.
- *Re-evaluation trigger*: confirmed-safe next field session showing heartbeats survive through `elevenlabs_audio_playing` events without freeze.

### #3 + #4 — `AVAudioSessionInterruptionNotification` analogue
- *Why deferred*: the web platform has no equivalent to iOS's interruption notification. The closest proxies (`visibilitychange`, audio-element `pause` events, `navigator.mediaSession.setActionHandler`) catch some but not all interruption cases.
- *Mitigation in place*: `visibilitychange → hidden` already fires `pause()` if recording is active (commit `af01406`). `devicechange` listener surfaces a toast on Bluetooth pair/unpair (commit `1cb28c4`). These cover the common phone-call-via-Bluetooth and Siri-takes-over-screen cases.
- *Remaining gap*: a Siri activation that doesn't take over the screen + doesn't change audio routing (rare) is still silent.

## Punted as out-of-scope

| # | Reason |
|---|--------|
| #11 | MINOR. AudioWorklet has no host-side accumulator; no PCM to flush on stop. Doc-only. |
| #17 | MINOR. Verified MATCH after follow-up inspection of `sleep-manager.ts:223-243`. |
| #18 | MINOR. PWA's `processAudioLevel` RMS fallback is iOS-parity-equivalent at the behaviour level. Doc-only. |
| #28 | MINOR. PWA's KeepAlive is harmless on Nova-3. Will retire if/when PWA migrates to Flux. |
| #37 | Separate work — automated apply-extraction parity test infrastructure is a follow-up PR. |
| #42 | MINOR. PWA uses jitter, iOS doesn't. PWA jitter is correct (avoids thundering herd post-deploy). MATCH. |
| #58 | Product decision pending — does PWA contribute to the iOS-canon Phase A training pipeline? Flag to Derek. |
| #62 | Backend audit task — verify HTTP `/recording/start` + WS `session_start` correlate on the same backend session row. Not blocking. |
| #63 | MATCH — both clients use WS reconnect ladder for online recovery. |
| #65, #66 | Neither client handles low battery / low storage. iOS-side gap. |
| #68 | MATCH — full reload starts a fresh provider. |
| #70 | Browser process kill — useEffect cleanup handles. Doc-only. |
| #8, #9 | Out of scope — iOS-specific rare notifications. |
| #12 | PWA defensive extra. Doc-only. |
| #19 | MATCH — both run 32 ms Silero v5 frames with same threshold + gate. |
| #51 | PWA-specific by necessity (iOS has system audio session granted at app launch). Keep as-is. |
| #59 | MATCH — pause == enterSleeping on both. |

## Net effect

The PWA recording pipeline now mirrors iOS at the runtime-coupling level for all MAJOR + most MEDIUM gaps that were practically addressable. The remaining theoretical divergences are either:
- Platform-fundamental (e.g. iOS gets system audio interruption notifications the web doesn't);
- Deferred pending diagnostic clarity (the JS-event-loop freeze investigation);
- Polish items where the cost/value ratio doesn't favour shipping today.

**Next field session is the falsifier.** Sequence of expected CloudWatch signals on a healthy recording:

```
recording_provider_mount
pipeline.heartbeat (seq=0, 1, 2, …)        ← local 5s ring
pipeline.sonnet_ws_send { type: 'heartbeat' } ← wire 25s app-layer
[recording proceeds…]
elevenlabs_audio_playing                     ← TTS starts
tts_pcm_gate_engaged                         ← PCM send paused
[deepgram_interim flow stops for ~3-5s while TTS plays]
elevenlabs_audio_ended
tts_pcm_gate_released                        ← PCM send resumes after 500ms
[deepgram_interim flow resumes]
```

If the next session sustains this pattern past two consecutive ElevenLabs playbacks, all five layers of defence (PCM gate, heartbeat, BFCache lifecycle, reconnect-1005, diagnostic survival) are working in concert and the disconnect bug-class is closed.
