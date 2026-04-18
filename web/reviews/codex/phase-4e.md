## 1. Summary of the phase

Phase `4e` adds a browser-side sleep/wake state machine to the recording pipeline: after 15s without a final transcript it dozes, after 30 minutes of dozing it sleeps, and speech is meant to wake it back up. It also adds a 3-second audio ring buffer so buffered pre-wake audio can be replayed into Deepgram, plus `pause()`/`resume()` support in `DeepgramService` to keep the socket alive during doze.

I reviewed the handoff in [phase-4e.md](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-4e.md:1), the commit diff for `9f1dba6`, and the current working-tree versions of the touched files. The current tree still contains the same 4e logic; later changes are mostly unrelated additions plus some stale comments.

## 2. Alignment with original plan

The broad shape matches the handoff: new `SleepManager` and `AudioRingBuffer` classes were added, `DeepgramService` gained pause/resume/replay support, and `RecordingProvider` now wires speech activity, audio levels, doze/sleep callbacks, and replay on wake.

Two objectives are only partially met:

- The “manual pause routes through the same doze handler” intent is not actually implemented. `pause()` / `resume()` mutate provider state directly instead of driving the `SleepManager`, so the provider state and the sleep-state machine can diverge ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:541), [sleep-manager.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sleep-manager.ts:105)).
- The handoff says the iOS constants were lifted “1:1”, including energy floor `0.002` ([phase-4e.md](/Users/derekbeckley/Developer/EICR_Automation/web/reviews/context/phase-4e.md:41)). The implementation uses `0.02` and feeds `SleepManager` a smoothed UI level rather than raw RMS ([sleep-manager.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sleep-manager.ts:58), [mic-capture.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/mic-capture.ts:104)).

## 3. Correctness issues

- **P1** Replay after wake-from-sleep is usually dropped. `handleWake()` and manual `resume()` call `await openDeepgram(...)` and immediately send the drained replay buffer ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:404), [recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:564)). But `openDeepgram()` only waits for token fetch; `DeepgramService.connect()` is synchronous and the socket is still `connecting` until `ws.onopen` ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:228), [deepgram-service.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/deepgram-service.ts:63), [deepgram-service.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/deepgram-service.ts:132)). `sendInt16PCM()` no-ops unless state is `connected`, so the advertised 3s replay is lost on the cold-reconnect path.
- **P1** Manual pause/resume is not synchronized with `SleepManager`, which leaves timers and internal state stale. `pause()` just pauses Deepgram/Sonnet and sets provider state to `dozing`; it never transitions `SleepManager` out of `active` ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:541)). `resume()` sets provider state back to `active` but never tells `SleepManager` to re-arm/reset ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:555)). Because `SleepManager` gates `onSpeechActivity()` and wake processing on its own internal state ([sleep-manager.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sleep-manager.ts:105), [sleep-manager.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sleep-manager.ts:112)), an active session can still be on the dozing timer, auto-sleep while the UI says “Recording”, or re-doze immediately after manual resume.
- **P1** The replay buffer assumes 16kHz even when capture is not 16kHz. `AudioRingBuffer` is hard-coded to `new AudioRingBuffer(3, 16000)` and stores raw incoming mic samples ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:347), [audio-ring-buffer.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/audio-ring-buffer.ts:21)). `MicCaptureHandle.sampleRate` is dynamic ([mic-capture.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/mic-capture.ts:134)), and `DeepgramService.sendSamples()` already resamples live audio when it is not 16kHz ([deepgram-service.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/deepgram-service.ts:112)). The replay path does not, so on browsers that ignore the requested `AudioContext({ sampleRate: 16000 })`, replay duration shrinks and PCM is sent at the wrong effective rate.
- **P2** The wake heuristic is not actually using “raw RMS” as documented. `mic-capture` maps RMS through a nonlinear curve and EMA smoothing before calling `onLevel` ([mic-capture.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/mic-capture.ts:104)), and `SleepManager.processAudioLevel()` consumes that value ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:356), [sleep-manager.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/sleep-manager.ts:112)). That means the handoff’s “energy floor 0.002” is not directly meaningful in this implementation, and wake sensitivity will not match iOS observationally as claimed.

## 4. Security issues

No phase-specific security findings in the reviewed diff.

- **None observed**: no new XSS, auth, CSRF, secret-leak, or CORS issues in the touched code paths.

## 5. Performance issues

No major new performance regressions stood out beyond the correctness problems above.

- **P2** Replay currently does an extra full copy in `sendInt16PCM()` before `ws.send()` ([deepgram-service.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/deepgram-service.ts:136)). At 3s this is probably acceptable, but it becomes more expensive if replay duration grows or if higher-than-16kHz samples are mistakenly buffered.
- **P2** `AudioRingBuffer.writeFloat32()` converts every incoming sample on the main thread ([audio-ring-buffer.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/audio-ring-buffer.ts:28)). For a 3-second buffer this is still reasonable, but if accurate cross-sample-rate replay is required, doing resampling once at write time or inside the worklet would be cleaner.

## 6. Accessibility issues

No new phase-specific accessibility regressions were introduced in the touched files.

Residual existing risk in the current tree:

- **P2** The recording overlay is marked as a modal dialog but still has no visible focus-trap / initial-focus / return-focus handling in the component itself ([recording-overlay.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/recording/recording-overlay.tsx:64)). That predates or sits outside this phase, but it remains an accessibility gap.

## 7. Code quality

- The implementation is generally readable and well-commented. Separation of concerns is good: `SleepManager` only owns timers/state, `AudioRingBuffer` owns buffering, and the provider wires side effects.
- There is comment drift in the current working tree. `RecordingProvider`’s header still says “VAD sleep/wake (Phase 4e) still to come” and shows a `60s` / `5m` state machine ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:29), [recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:36)). That is now materially wrong.
- `pause()` / `resume()` duplicate parts of the wake/doze behavior rather than sharing a single transition API, which is how the state divergence bug slipped in ([recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:443), [recording-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording-context.tsx:541)).

## 8. Test coverage gaps

There do not appear to be any `test` / `spec` files under `web/` for this area.

Missing coverage is significant for this phase:

- No unit tests for `SleepManager` timer transitions: active → dozing → sleeping, cooldown behavior, wake threshold behavior.
- No tests for `AudioRingBuffer` ordering, wraparound, drain/reset semantics, or non-16k input assumptions.
- No provider/integration tests for auto-doze, auto-wake, manual pause/resume, and wake-from-sleep replay.
- No tests for socket-readiness races on reconnect, which is where the main replay bug lives.

## 9. Suggested fixes

1. **[web/src/lib/recording-context.tsx:541](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording-context.tsx:541)**  
   Change manual `pause()` / `resume()` to drive the `SleepManager` instead of bypassing it. Add explicit public methods such as `enterDozing()` and `wake()` on `SleepManager`, or route the manual buttons through the same callback path used by `onEnterDozing` / `onWake`.  
   Why: keeps provider state, timers, cooldown, and wake logic in sync; avoids sleeping an “active” session or carrying stale timers across manual resume.

2. **[web/src/lib/recording-context.tsx:404](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording-context.tsx:404)** and **[web/src/lib/recording/deepgram-service.ts:63](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/deepgram-service.ts:63)**  
   Make `openDeepgram()` wait for `ws.onopen` before resolving, or queue replay/live PCM inside `DeepgramService` until the socket reaches `connected`. Do not drain the ring buffer until the connection is ready.  
   Why: the current reconnect path drops the replay buffer, which breaks the headline feature for wake-from-sleep.

3. **[web/src/lib/recording-context.tsx:347](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording-context.tsx:347)** and **[web/src/lib/recording/audio-ring-buffer.ts:21](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/audio-ring-buffer.ts:21)**  
   Stop assuming the ring buffer input is already 16kHz. Either buffer at the actual mic sample rate and resample on replay, or resample to 16k before writing into the ring buffer.  
   Why: otherwise replay duration and PCM timing are wrong whenever the browser does not honor the requested 16kHz audio context.

4. **[web/src/lib/recording/sleep-manager.ts:58](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/sleep-manager.ts:58)** and **[web/src/lib/recording/mic-capture.ts:104](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/mic-capture.ts:104)**  
   Decide whether `SleepManager` should consume raw RMS or the mapped/smoothed UI level, and make the docs/constants match that choice. If parity with iOS matters, feed raw RMS into the wake heuristic and keep the UI transform separate.  
   Why: current comments and thresholds are misleading, and wake sensitivity cannot be reasoned about from the stated constants.

5. **[web/src/lib/recording-context.tsx:19](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording-context.tsx:19)**  
   Update the top-level provider comments/state diagram to reflect the shipped 4e behavior and actual timeouts.  
   Why: the current comments still describe pre-4e behavior and will mislead future work.

6. **[web/src/lib/recording/sleep-manager.ts:66](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/sleep-manager.ts:66)**, **[web/src/lib/recording/audio-ring-buffer.ts:15](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording/audio-ring-buffer.ts:15)**, **[web/src/lib/recording-context.tsx:340](\/Users\/derekbeckley\/Developer\/EICR_Automation\/web\/src\/lib\/recording-context.tsx:340)**  
   Add unit tests for timer transitions, wraparound/drain ordering, manual pause/resume parity, and wake-from-sleep replay sequencing.  
   Why: this phase is timer-heavy and race-prone; the current defects are exactly the sort of issues automated tests should catch.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:

1. Synchronize manual pause/resume with `SleepManager` so the state machine cannot diverge from the UI.
2. Make wake-from-sleep replay wait for a connected Deepgram socket instead of sending into `connecting`.
3. Fix the ring-buffer sample-rate assumption so replay is actually valid on real browser capture rates.